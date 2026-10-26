import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { timingSafeEqual } from "node:crypto";
import type { AcpLike, GenerateOptions, GenerationResult } from "./acp.js";
import type { GeneratedImage } from "./provider.js";
import { AcpUnavailableError } from "./acp.js";
import { MODEL_IDS, type ProxyConfig } from "./config.js";
import { ApiError, errorEnvelope, extractJson, formatInstructions, imageFormatName, normalizeChat, normalizeImageGeneration, normalizeResponses, serializePrompt, type ModelCheck, type Message, type OutputFormat } from "./api.js";
import { beginSse, endSse, writeSse } from "./sse.js";
import { CHARS_PER_TOKEN, chatUsage, responsesUsage } from "./usage.js";

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

function modelCheck(bridge: AcpLike): ModelCheck | undefined { return bridge.hasModel ? (model) => bridge.hasModel!(model) : undefined; }

function id(prefix: string): string { return `${prefix}-${randomUUID().replaceAll("-", "")}`; }

/** A request for images goes only to a model whose provider can generate them (a bridge that cannot tell lets the provider answer the 400). */
function requireImageGeneration(bridge: AcpLike, model: string): void {
  if (bridge.canGenerateImages && !bridge.canGenerateImages(model)) throw new ApiError(400, "model_not_capable", `The model '${model}' cannot generate images.`, "model");
}

const imageDataUrl = (image: GeneratedImage): string => `data:${image.mimeType};base64,${image.data}`;

export function mapStopReason(stopReason: GenerationResult["stopReason"]): { chat: string | null; responseStatus: string } {
  switch (stopReason) {
    case "max_tokens": case "max_turn_requests": return { chat: "length", responseStatus: "incomplete" };
    case "refusal": return { chat: "content_filter", responseStatus: "incomplete" };
    case "cancelled": return { chat: "stop", responseStatus: "incomplete" };
    default: return { chat: "stop", responseStatus: "completed" };
  }
}

/** Runs one generation and enforces the client's output limit on the raw text: the part that fits is emitted, the agent turn is cancelled and the result is a "max_tokens" stop with usage left to the estimate. */
async function runGeneration(bridge: AcpLike, model: string, messages: Message[], options: GenerateOptions, limit: number | undefined, emit: ((text: string) => void) | undefined, signal: AbortSignal): Promise<GenerationResult> {
  if (limit === undefined && !emit) return await bridge.generate(model, messages, {}, signal, options);
  const controller = new AbortController();
  const link = () => controller.abort();
  if (signal.aborted) link(); else signal.addEventListener("abort", link, { once: true });
  const budget = limit === undefined ? Infinity : limit * CHARS_PER_TOKEN;
  let emitted = "";
  let truncated = false;
  const onText = (text: string) => {
    if (truncated) return;
    const fit = text.length > budget - emitted.length ? text.slice(0, Math.max(0, budget - emitted.length)) : text;
    if (fit) { emitted += fit; emit?.(fit); }
    if (fit.length < text.length) { truncated = true; controller.abort(); }
  };
  try {
    const result = await bridge.generate(model, messages, { onText }, controller.signal, options);
    return truncated ? { text: emitted, stopReason: "max_tokens", usage: null } : result;
  } catch (error) {
    if (truncated) return { text: emitted, stopReason: "max_tokens", usage: null };
    throw error;
  } finally { signal.removeEventListener("abort", link); }
}

function finalText(format: OutputFormat, result: GenerationResult): string { return format.type === "json" ? extractJson(result.text) : result.text; }

async function handleChat(request: IncomingMessage, response: ServerResponse, config: ProxyConfig, bridge: AcpLike, fetchImpl?: typeof fetch): Promise<void> {
  const parsed = await normalizeChat(await readBody(request, config.maxBodyBytes), modelCheck(bridge), { ignoreSampling: config.ignoreSampling, fetch: fetchImpl });
  if (parsed.generateImages) requireImageGeneration(bridge, parsed.model);
  const chatId = id("chatcmpl");
  const created = Math.floor(Date.now() / 1000);
  const abortController = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; abortController.abort(); }, config.timeoutMs);
  request.once("aborted", () => abortController.abort());
  request.once("close", () => { if (!request.complete) abortController.abort(); });
  response.once("close", () => { if (!response.writableEnded) abortController.abort(); });
  const options: GenerateOptions = { instructions: formatInstructions(parsed.format), ...(parsed.generateImages ? { images: true } : {}) };
  const asJson = parsed.format.type === "json";
  const promptText = serializePrompt(parsed.conversation, options.instructions);
  const chatImages = (result: GenerationResult) => (result.images ?? []).map((image, index) => ({ index, type: "image_url", image_url: { url: imageDataUrl(image) } }));
  const usageFor = (result: GenerationResult) => chatUsage({ ...result, text: finalText(parsed.format, result) }, promptText);
  if (parsed.stream) {
    const includeUsage = (parsed.stream_options as { include_usage?: boolean } | null | undefined)?.include_usage === true;
    const chunk = (choices: unknown[], extra: Record<string, unknown> = {}) => writeSse(response, { id: chatId, object: "chat.completion.chunk", created, model: parsed.model, choices, ...(includeUsage ? { usage: null } : {}), ...extra });
    beginSse(response);
    chunk([{ index: 0, delta: { role: "assistant" }, finish_reason: null }]);
    try {
      const delta = (text: string) => chunk([{ index: 0, delta: { content: text }, finish_reason: null }]);
      const result = await runGeneration(bridge, parsed.model, parsed.conversation, options, parsed.maxOutputTokens, asJson ? undefined : delta, abortController.signal);
      if (timedOut) throw new ApiError(504, "request_timeout", "The request exceeded the configured timeout.");
      if (asJson) delta(finalText(parsed.format, result));
      const images = chatImages(result);
      if (images.length) chunk([{ index: 0, delta: { images }, finish_reason: null }]);
      const reason = mapStopReason(result.stopReason).chat;
      chunk([{ index: 0, delta: {}, finish_reason: reason }]);
      if (includeUsage) chunk([], { usage: usageFor(result) });
      endSse(response);
    } catch (error) {
      writeSse(response, errorEnvelope(error instanceof Error ? error : new Error(String(error))));
      endSse(response);
    } finally { clearTimeout(timer); }
    return;
  }
  try {
    const result = await runGeneration(bridge, parsed.model, parsed.conversation, options, parsed.maxOutputTokens, undefined, abortController.signal);
    if (timedOut) throw new ApiError(504, "request_timeout", "The request exceeded the configured timeout.");
    const reason = mapStopReason(result.stopReason).chat;
    const images = chatImages(result);
    json(response, 200, { id: chatId, object: "chat.completion", created, model: parsed.model, choices: [{ index: 0, message: { role: "assistant", content: finalText(parsed.format, result), ...(images.length ? { images } : {}) }, finish_reason: reason }], usage: usageFor(result) });
  } finally { clearTimeout(timer); }
}

/** The provider names the `messages` parameter; a Responses request calls it `input`. */
function forResponses(error: unknown): unknown { return error instanceof ApiError && error.param === "messages" ? new ApiError(error.status, error.code, error.message, "input") : error; }

async function handleResponses(request: IncomingMessage, response: ServerResponse, config: ProxyConfig, bridge: AcpLike, fetchImpl?: typeof fetch): Promise<void> {
  const parsed = await normalizeResponses(await readBody(request, config.maxBodyBytes), modelCheck(bridge), { ignoreSampling: config.ignoreSampling, fetch: fetchImpl });
  if (parsed.generateImages) requireImageGeneration(bridge, parsed.model);
  const responseId = id("resp");
  const messageId = id("msg");
  const created = Math.floor(Date.now() / 1000);
  const abortController = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; abortController.abort(); }, config.timeoutMs);
  request.once("aborted", () => abortController.abort());
  request.once("close", () => { if (!request.complete) abortController.abort(); });
  response.once("close", () => { if (!response.writableEnded) abortController.abort(); });
  const options: GenerateOptions = { instructions: formatInstructions(parsed.format), ...(parsed.generateImages ? { images: true } : {}) };
  const asJson = parsed.format.type === "json";
  const promptText = serializePrompt(parsed.conversation, options.instructions);
  /** An `image_generation_call` item per generated image; they come before the message. */
  const imageItems = (result: GenerationResult) => (result.images ?? []).map((image) => ({ id: id("ig"), type: "image_generation_call", status: "completed", result: image.data, ...(image.revisedPrompt ? { revised_prompt: image.revisedPrompt } : {}), output_format: imageFormatName(image.mimeType) }));
  const base = (result: GenerationResult, status: string, items: unknown[] = []) => ({ id: responseId, object: "response", created_at: created, status, model: parsed.model, output: [...items, { id: messageId, type: "message", status, role: "assistant", content: [{ type: "output_text", text: finalText(parsed.format, result), annotations: [] }] }], incomplete_details: result.stopReason === "max_tokens" ? { reason: "max_output_tokens" } : null, usage: responsesUsage({ ...result, text: finalText(parsed.format, result) }, promptText), store: false });
  if (parsed.stream) {
    let sequenceNumber = 0;
    const event = (type: string, payload: Record<string, unknown>) => writeSse(response, { type, sequence_number: sequenceNumber++, ...payload }, type);
    beginSse(response);
    event("response.created", { response: { id: responseId, object: "response", created_at: created, status: "in_progress", model: parsed.model, output: [], usage: null, store: false } });
    // With images the message comes after them, so its events (and its text) wait until the generation is over; otherwise it is item 0 and streams live.
    const openMessage = (index: number) => {
      event("response.output_item.added", { output_index: index, item: { id: messageId, type: "message", status: "in_progress", role: "assistant", content: [] } });
      event("response.content_part.added", { item_id: messageId, output_index: index, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
    };
    if (!parsed.generateImages) openMessage(0);
    try {
      const delta = (text: string, index = 0) => event("response.output_text.delta", { item_id: messageId, output_index: index, content_index: 0, delta: text });
      const result = await runGeneration(bridge, parsed.model, parsed.conversation, options, parsed.maxOutputTokens, asJson || parsed.generateImages ? undefined : delta, abortController.signal);
      if (timedOut) throw new ApiError(504, "request_timeout", "The request exceeded the configured timeout.");
      const status = mapStopReason(result.stopReason).responseStatus;
      const text = finalText(parsed.format, result);
      const items = imageItems(result);
      items.forEach((item, index) => { event("response.output_item.added", { output_index: index, item: { ...item, status: "in_progress", result: null } }); event("response.output_item.done", { output_index: index, item }); });
      const at = items.length;
      if (parsed.generateImages) openMessage(at);
      if (asJson || parsed.generateImages) delta(text, at);
      event("response.output_text.done", { item_id: messageId, output_index: at, content_index: 0, text });
      event("response.content_part.done", { item_id: messageId, output_index: at, content_index: 0, part: { type: "output_text", text, annotations: [] } });
      event("response.output_item.done", { output_index: at, item: base(result, status).output[0] });
      const terminalEvent = status === "completed" ? "response.completed" : "response.incomplete";
      event(terminalEvent, { response: base(result, status, items) });
      endSse(response);
    } catch (error) { const mapped = forResponses(error); writeSse(response, errorEnvelope(mapped instanceof Error ? mapped : new Error(String(mapped)))); endSse(response); }
    finally { clearTimeout(timer); }
    return;
  }
  try {
    const result = await runGeneration(bridge, parsed.model, parsed.conversation, options, parsed.maxOutputTokens, undefined, abortController.signal);
    if (timedOut) throw new ApiError(504, "request_timeout", "The request exceeded the configured timeout.");
    json(response, 200, base(result, mapStopReason(result.stopReason).responseStatus, imageItems(result)));
  } catch (error) { throw forResponses(error); }
  finally { clearTimeout(timer); }
}

async function handleImageGeneration(request: IncomingMessage, response: ServerResponse, config: ProxyConfig, bridge: AcpLike): Promise<void> {
  const parsed = normalizeImageGeneration(await readBody(request, config.maxBodyBytes), modelCheck(bridge));
  requireImageGeneration(bridge, parsed.model);
  const created = Math.floor(Date.now() / 1000);
  const abortController = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; abortController.abort(); }, config.timeoutMs);
  request.once("aborted", () => abortController.abort());
  request.once("close", () => { if (!request.complete) abortController.abort(); });
  response.once("close", () => { if (!response.writableEnded) abortController.abort(); });
  try {
    const result = await runGeneration(bridge, parsed.model, parsed.conversation, { images: true }, undefined, undefined, abortController.signal);
    if (timedOut) throw new ApiError(504, "request_timeout", "The request exceeded the configured timeout.");
    const image = result.images?.[0];
    if (!image) { const said = result.text.trim().slice(0, 500); throw new ApiError(502, "no_image_generated", `The agent did not generate an image.${said ? ` It said: ${said}` : ""}`); }
    json(response, 200, { created, data: [{ b64_json: image.data, ...(image.revisedPrompt ? { revised_prompt: image.revisedPrompt } : {}) }], output_format: imageFormatName(image.mimeType) });
  } finally { clearTimeout(timer); }
}

/** `options.fetch` downloads http(s) image URLs (default: the global fetch). */
export function createProxyServer(config: ProxyConfig, bridge: AcpLike, options: { fetch?: typeof fetch } = {}): Server {
  return createServer(async (request, response) => {
    try {
      const method = request.method || "GET";
      const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
      if (method === "GET" && url.pathname === "/healthz") { json(response, 200, { status: "ok", uptime_seconds: Math.floor((Date.now() - startedAt) / 1000) }); return; }
      if (!authenticated(request, config)) { json(response, 401, { error: { message: "Invalid or missing bearer token.", type: "invalid_request_error", code: "invalid_api_key", param: null } }); return; }
      if (method === "GET" && url.pathname === "/v1/models") { const models = bridge.listModels ? await bridge.listModels() : MODEL_IDS.map((model) => ({ id: model, ownedBy: "openai" })); json(response, 200, { object: "list", data: models.map((model) => ({ id: model.id, object: "model", created: 0, owned_by: model.ownedBy ?? "openai" })) }); return; }
      if (method === "POST" && url.pathname === "/v1/chat/completions") { await handleChat(request, response, config, bridge, options.fetch); return; }
      if (method === "POST" && url.pathname === "/v1/images/generations") { await handleImageGeneration(request, response, config, bridge); return; }
      if (method === "POST" && url.pathname === "/v1/responses") { await handleResponses(request, response, config, bridge, options.fetch); return; }
      json(response, 404, { error: { message: "Not found.", type: "invalid_request_error", code: "not_found", param: null } });
    } catch (error) {
      if (response.headersSent) { response.end(); return; }
      if (error instanceof ApiError) { json(response, error.status, errorEnvelope(error)); return; }
      if (error instanceof AcpUnavailableError) { if (error.retryAfterSeconds) response.setHeader("Retry-After", String(error.retryAfterSeconds)); json(response, 503, { error: { message: error.message, type: "server_error", code: error.code ?? "backend_unavailable", param: null } }); return; }
      json(response, 500, errorEnvelope(error instanceof Error ? error : new Error(String(error))));
    }
  });
}
