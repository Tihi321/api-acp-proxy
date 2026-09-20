import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { timingSafeEqual } from "node:crypto";
import type { AcpLike, GenerationResult } from "./acp.js";
import { AcpUnavailableError } from "./acp.js";
import { MODEL_IDS, type ProxyConfig } from "./config.js";
import { ApiError, errorEnvelope, normalizeChat, normalizeResponses } from "./api.js";
import { beginSse, endSse, writeSse } from "./sse.js";

const startedAt = Date.now();

function json(response: ServerResponse, status: number, payload: unknown): void {
  if (!response.headersSent) response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(JSON.stringify(payload));
}

function authenticated(request: IncomingMessage, config: ProxyConfig): boolean {
  if (!config.apiKey) return true;
  const value = request.headers.authorization;
  if (!value?.startsWith("Bearer ")) return false;
  const provided = Buffer.from(value.slice(7));
  const expected = Buffer.from(config.apiKey);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

async function readBody(request: IncomingMessage, limit: number): Promise<unknown> {
  const contentLength = Number(request.headers["content-length"] || 0);
  if (contentLength > limit) throw new ApiError(413, "request_too_large", "Request body exceeds the configured limit.");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += Buffer.byteLength(chunk);
    if (size > limit) throw new ApiError(413, "request_too_large", "Request body exceeds the configured limit.");
    chunks.push(Buffer.from(chunk));
  }
  if (!chunks.length) throw new ApiError(400, "invalid_request", "Request body is required.");
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new ApiError(400, "invalid_request", "Request body must be valid JSON."); }
}

function id(prefix: string): string { return `${prefix}-${randomUUID().replaceAll("-", "")}`; }

export function mapStopReason(stopReason: GenerationResult["stopReason"]): { chat: string | null; responseStatus: string } {
  switch (stopReason) {
    case "max_tokens": case "max_turn_requests": return { chat: "length", responseStatus: "incomplete" };
    case "refusal": return { chat: "content_filter", responseStatus: "incomplete" };
    case "cancelled": return { chat: "stop", responseStatus: "incomplete" };
    default: return { chat: "stop", responseStatus: "completed" };
  }
}

function responsesUsage(result: GenerationResult): Record<string, number> | null {
  if (!result.usage) return null;
  return { input_tokens: result.usage.inputTokens, output_tokens: result.usage.outputTokens, total_tokens: result.usage.totalTokens };
}

function chatUsage(result: GenerationResult): Record<string, number> | undefined {
  if (!result.usage) return undefined;
  return { prompt_tokens: result.usage.inputTokens, completion_tokens: result.usage.outputTokens, total_tokens: result.usage.totalTokens };
}

async function handleChat(request: IncomingMessage, response: ServerResponse, config: ProxyConfig, bridge: AcpLike): Promise<void> {
  const parsed = normalizeChat(await readBody(request, config.maxBodyBytes));
  const chatId = id("chatcmpl");
  const created = Math.floor(Date.now() / 1000);
  const abortController = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; abortController.abort(); }, config.timeoutMs);
  request.once("aborted", () => abortController.abort());
  request.once("close", () => { if (!request.complete) abortController.abort(); });
  response.once("close", () => { if (!response.writableEnded) abortController.abort(); });
  if (parsed.stream) {
    beginSse(response);
    writeSse(response, { id: chatId, object: "chat.completion.chunk", created, model: parsed.model, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
    try {
      const result = await bridge.generate(parsed.model, parsed.textMessages, { onText: (text) => writeSse(response, { id: chatId, object: "chat.completion.chunk", created, model: parsed.model, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }) }, abortController.signal);
      if (timedOut) throw new ApiError(504, "request_timeout", "The request exceeded the configured timeout.");
      const reason = mapStopReason(result.stopReason).chat;
      writeSse(response, { id: chatId, object: "chat.completion.chunk", created, model: parsed.model, choices: [{ index: 0, delta: {}, finish_reason: reason }] });
      endSse(response);
    } catch (error) {
      writeSse(response, errorEnvelope(error instanceof Error ? error : new Error(String(error))));
      endSse(response);
    } finally { clearTimeout(timer); }
    return;
  }
  try {
    const result = await bridge.generate(parsed.model, parsed.textMessages, {}, abortController.signal);
    if (timedOut) throw new ApiError(504, "request_timeout", "The request exceeded the configured timeout.");
    const reason = mapStopReason(result.stopReason).chat;
    const usage = chatUsage(result);
    json(response, 200, { id: chatId, object: "chat.completion", created, model: parsed.model, choices: [{ index: 0, message: { role: "assistant", content: result.text }, finish_reason: reason }], ...(usage ? { usage } : {}) });
  } finally { clearTimeout(timer); }
}

async function handleResponses(request: IncomingMessage, response: ServerResponse, config: ProxyConfig, bridge: AcpLike): Promise<void> {
  const parsed = normalizeResponses(await readBody(request, config.maxBodyBytes));
  const responseId = id("resp");
  const messageId = id("msg");
  const created = Math.floor(Date.now() / 1000);
  const abortController = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; abortController.abort(); }, config.timeoutMs);
  request.once("aborted", () => abortController.abort());
  request.once("close", () => { if (!request.complete) abortController.abort(); });
  response.once("close", () => { if (!response.writableEnded) abortController.abort(); });
  const base = (result: GenerationResult, status: string) => ({ id: responseId, object: "response", created_at: created, status, model: parsed.model, output: [{ id: messageId, type: "message", status, role: "assistant", content: [{ type: "output_text", text: result.text, annotations: [] }] }], usage: responsesUsage(result), store: false });
  if (parsed.stream) {
    let sequenceNumber = 0;
    const event = (type: string, payload: Record<string, unknown>) => writeSse(response, { type, sequence_number: sequenceNumber++, ...payload }, type);
    beginSse(response);
    event("response.created", { response: { id: responseId, object: "response", created_at: created, status: "in_progress", model: parsed.model, output: [], usage: null, store: false } });
    event("response.output_item.added", { output_index: 0, item: { id: messageId, type: "message", status: "in_progress", role: "assistant", content: [] } });
    event("response.content_part.added", { item_id: messageId, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
    try {
      const result = await bridge.generate(parsed.model, parsed.textMessages, { onText: (delta) => event("response.output_text.delta", { item_id: messageId, output_index: 0, content_index: 0, delta }) }, abortController.signal);
      if (timedOut) throw new ApiError(504, "request_timeout", "The request exceeded the configured timeout.");
      const status = mapStopReason(result.stopReason).responseStatus;
      event("response.output_text.done", { item_id: messageId, output_index: 0, content_index: 0, text: result.text });
      event("response.content_part.done", { item_id: messageId, output_index: 0, content_index: 0, part: { type: "output_text", text: result.text, annotations: [] } });
      event("response.output_item.done", { output_index: 0, item: base(result, status).output[0] });
      const terminalEvent = status === "completed" ? "response.completed" : "response.incomplete";
      event(terminalEvent, { response: base(result, status) });
      endSse(response);
    } catch (error) { writeSse(response, errorEnvelope(error instanceof Error ? error : new Error(String(error)))); endSse(response); }
    finally { clearTimeout(timer); }
    return;
  }
  try {
    const result = await bridge.generate(parsed.model, parsed.textMessages, {}, abortController.signal);
    if (timedOut) throw new ApiError(504, "request_timeout", "The request exceeded the configured timeout.");
    json(response, 200, base(result, mapStopReason(result.stopReason).responseStatus));
  } finally { clearTimeout(timer); }
}

export function createProxyServer(config: ProxyConfig, bridge: AcpLike): Server {
  return createServer(async (request, response) => {
    try {
      const method = request.method || "GET";
      const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
      if (method === "GET" && url.pathname === "/healthz") { json(response, 200, { status: "ok", uptime_seconds: Math.floor((Date.now() - startedAt) / 1000) }); return; }
      if (!authenticated(request, config)) { json(response, 401, { error: { message: "Invalid or missing bearer token.", type: "invalid_request_error", code: "invalid_api_key", param: null } }); return; }
      if (method === "GET" && url.pathname === "/v1/models") { json(response, 200, { object: "list", data: MODEL_IDS.map((model) => ({ id: model, object: "model", created: 0, owned_by: "openai" })) }); return; }
      if (method === "POST" && url.pathname === "/v1/chat/completions") { await handleChat(request, response, config, bridge); return; }
      if (method === "POST" && url.pathname === "/v1/responses") { await handleResponses(request, response, config, bridge); return; }
      json(response, 404, { error: { message: "Not found.", type: "invalid_request_error", code: "not_found", param: null } });
    } catch (error) {
      if (response.headersSent) { response.end(); return; }
      if (error instanceof ApiError) { json(response, error.status, errorEnvelope(error)); return; }
      if (error instanceof AcpUnavailableError) { json(response, 503, { error: { message: error.message, type: "server_error", code: "backend_unavailable", param: null } }); return; }
      json(response, 500, errorEnvelope(error instanceof Error ? error : new Error(String(error))));
    }
  });
}
