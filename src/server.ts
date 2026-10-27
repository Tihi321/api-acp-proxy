import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { timingSafeEqual } from "node:crypto";
import type { AcpLike, GenerateOptions, GenerationResult } from "./acp.js";
import type { GeneratedImage } from "./provider.js";
import { AcpUnavailableError } from "./acp.js";
import type { ProxyConfig } from "./config.js";
import { ApiError, errorEnvelope, extractJson, formatInstructions, hasImages, imageFormatName, normalizeChat, normalizeImageGeneration, normalizeResponses, serializePrompt, type ModelCheck, type Message, type OutputFormat, type ToolChoice, type ToolDef } from "./api.js";
import { beginSse, endSse, writeSse } from "./sse.js";
import { extractCitations } from "./citations.js";
import { resolveMcpServers } from "./mcp-servers.js";
import { ToolBridgeHub } from "./tool-bridge.js";
import { servePlayground } from "./playground-files.js";
import { CHARS_PER_TOKEN, chatUsage, openAiUsage, responsesUsage } from "./usage.js";
import type { ActivityEntry, ActivityFeature, ActivityLog } from "./activity.js";

const startedAt = Date.now();

/** What a request tells the activity log (metadata only: the prompt, the answer and the headers never get here). */
interface Trace { model?: string; stream: boolean; features: Set<ActivityFeature>; error?: string; inputTokens?: number; outputTokens?: number; }

/** The proxy's error code of a failure (what the client sees as `error.code`). */
function errorCode(error: unknown): string {
  if (error instanceof ApiError) return error.code;
  if (error instanceof AcpUnavailableError) return error.code ?? "backend_unavailable";
  return "internal_error";
}

/** Notes what a parsed request asks for. */
function traceRequest(trace: Trace, parsed: { model: string; stream?: unknown; conversation: Message[]; generateImages: boolean; functionTools?: ToolDef[]; webSearch?: unknown }, mcp = false): void {
  trace.model = parsed.model;
  trace.stream = parsed.stream === true;
  if (hasImages(parsed.conversation)) trace.features.add("images");
  if (parsed.generateImages) trace.features.add("imageGeneration");
  if (parsed.functionTools) trace.features.add("tools");
  if (mcp) trace.features.add("mcp");
  if (parsed.webSearch) trace.features.add("search");
}

/** Notes the token counts the client is told (the agent's own, or the estimate). */
function traceUsage(trace: Trace, result: GenerationResult, promptText: string): void {
  const usage = openAiUsage(result, promptText);
  trace.inputTokens = usage.prompt;
  trace.outputTokens = usage.completion;
}

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

/** A request with function tools goes only to a model whose provider can be given them (a bridge that cannot tell lets the provider answer the 400). */
function requireToolCalling(bridge: AcpLike, model: string): void {
  if (bridge.canCallTools && !bridge.canCallTools(model)) throw new ApiError(400, "model_not_capable", `The model '${model}' cannot call tools.`, "model");
}

/** A request with `mcp` tools goes only to a model whose provider can be given remote MCP servers (a bridge that cannot tell lets the provider answer the 400). */
function requireMcp(bridge: AcpLike, model: string): void {
  if (bridge.canUseMcp && !bridge.canUseMcp(model)) throw new ApiError(400, "model_not_capable", `The model '${model}' cannot call MCP servers.`, "model");
}

/** A request with web search goes only to a model whose provider can search (a bridge that cannot tell lets the provider answer the 400). */
function requireWebSearch(bridge: AcpLike, model: string): void {
  if (bridge.canSearchWeb && !bridge.canSearchWeb(model)) throw new ApiError(400, "model_not_capable", `The model '${model}' cannot search the web.`, "model");
}

/** The generation options of a request's function tools (none for a request without them). */
function toolOptions(parsed: { functionTools?: ToolDef[]; toolChoice?: ToolChoice; parallelToolCalls?: boolean }): GenerateOptions {
  return parsed.functionTools ? { tools: parsed.functionTools, ...(parsed.toolChoice ? { toolChoice: parsed.toolChoice } : {}), ...(parsed.parallelToolCalls !== undefined ? { parallelToolCalls: parsed.parallelToolCalls } : {}) } : {};
}

const imageDataUrl = (image: GeneratedImage): string => `data:${image.mimeType};base64,${image.data}`;

export function mapStopReason(stopReason: GenerationResult["stopReason"]): { chat: string | null; responseStatus: string } {
  switch (stopReason) {
    case "max_tokens": case "max_turn_requests": return { chat: "length", responseStatus: "incomplete" };
    case "refusal": return { chat: "content_filter", responseStatus: "incomplete" };
    case "tool_calls": return { chat: "tool_calls", responseStatus: "completed" };
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

/** The answer text; a result that ends with tool calls is not a JSON answer, so it is left as it is. */
function finalText(format: OutputFormat, result: GenerationResult): string { return format.type === "json" && !result.toolCalls?.length ? extractJson(result.text) : result.text; }

async function handleChat(request: IncomingMessage, response: ServerResponse, config: ProxyConfig, bridge: AcpLike, trace: Trace, fetchImpl?: typeof fetch): Promise<void> {
  const parsed = await normalizeChat(await readBody(request, config.maxBodyBytes), modelCheck(bridge), { ignoreSampling: config.ignoreSampling, fetch: fetchImpl });
  traceRequest(trace, parsed);
  if (parsed.generateImages) requireImageGeneration(bridge, parsed.model);
  if (parsed.functionTools) requireToolCalling(bridge, parsed.model);
  if (parsed.webSearch) requireWebSearch(bridge, parsed.model);
  const chatId = id("chatcmpl");
  const created = Math.floor(Date.now() / 1000);
  const abortController = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; abortController.abort(); }, config.timeoutMs);
  request.once("aborted", () => abortController.abort());
  request.once("close", () => { if (!request.complete) abortController.abort(); });
  response.once("close", () => { if (!response.writableEnded) abortController.abort(); });
  const options: GenerateOptions = { instructions: formatInstructions(parsed.format), ...(parsed.generateImages ? { images: true } : {}), ...toolOptions(parsed), ...(parsed.webSearch ? { webSearch: parsed.webSearch } : {}) };
  const asJson = parsed.format.type === "json";
  const promptText = serializePrompt(parsed.conversation, options.instructions);
  /** `url_citation` annotations of the answer (only for a request with web search; none otherwise). */
  const chatAnnotations = (result: GenerationResult) => parsed.webSearch ? extractCitations(finalText(parsed.format, result)).map(({ url, title, start_index, end_index }) => ({ type: "url_citation", url_citation: { start_index, end_index, url, title } })) : undefined;
  const chatToolCalls = (result: GenerationResult) => (result.toolCalls ?? []).map((call, index) => ({ index, id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } }));
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
      traceUsage(trace, result, promptText);
      if (asJson && (result.text || !result.toolCalls?.length)) delta(finalText(parsed.format, result));
      const images = chatImages(result);
      if (images.length) chunk([{ index: 0, delta: { images }, finish_reason: null }]);
      // The annotations come in one delta after the text (their indices refer to the whole answer).
      const annotations = chatAnnotations(result);
      if (annotations?.length) chunk([{ index: 0, delta: { annotations }, finish_reason: null }]);
      const toolCalls = chatToolCalls(result);
      if (toolCalls.length) chunk([{ index: 0, delta: { tool_calls: toolCalls }, finish_reason: null }]);
      const reason = mapStopReason(result.stopReason).chat;
      chunk([{ index: 0, delta: {}, finish_reason: reason }]);
      if (includeUsage) chunk([], { usage: usageFor(result) });
      endSse(response);
    } catch (error) {
      trace.error = errorCode(error);
      writeSse(response, errorEnvelope(error instanceof Error ? error : new Error(String(error))));
      endSse(response);
    } finally { clearTimeout(timer); }
    return;
  }
  try {
    const result = await runGeneration(bridge, parsed.model, parsed.conversation, options, parsed.maxOutputTokens, undefined, abortController.signal);
    if (timedOut) throw new ApiError(504, "request_timeout", "The request exceeded the configured timeout.");
    traceUsage(trace, result, promptText);
    const reason = mapStopReason(result.stopReason).chat;
    const images = chatImages(result);
    const toolCalls = chatToolCalls(result);
    const content = finalText(parsed.format, result);
    const annotations = chatAnnotations(result);
    json(response, 200, { id: chatId, object: "chat.completion", created, model: parsed.model, choices: [{ index: 0, message: { role: "assistant", content: toolCalls.length && !content ? null : content, ...(annotations ? { annotations } : {}), ...(images.length ? { images } : {}), ...(toolCalls.length ? { tool_calls: toolCalls.map(({ index: _index, ...call }) => call) } : {}) }, finish_reason: reason }], usage: usageFor(result) });
  } finally { clearTimeout(timer); }
}

/** The provider names the `messages` parameter; a Responses request calls it `input`. */
function forResponses(error: unknown): unknown { return error instanceof ApiError && error.param === "messages" ? new ApiError(error.status, error.code, error.message, "input") : error; }

async function handleResponses(request: IncomingMessage, response: ServerResponse, config: ProxyConfig, bridge: AcpLike, trace: Trace, fetchImpl?: typeof fetch): Promise<void> {
  const parsed = await normalizeResponses(await readBody(request, config.maxBodyBytes), modelCheck(bridge), { ignoreSampling: config.ignoreSampling, fetch: fetchImpl });
  traceRequest(trace, parsed, parsed.mcpTools !== undefined);
  if (parsed.generateImages) requireImageGeneration(bridge, parsed.model);
  if (parsed.functionTools) requireToolCalling(bridge, parsed.model);
  if (parsed.webSearch) requireWebSearch(bridge, parsed.model);
  // The `mcp` tools are matched with the settings before anything starts, so a bad label or URL is a real 400 even when streaming.
  const mcpServers = parsed.mcpTools ? resolveMcpServers(parsed.mcpTools, config.mcpServers) : undefined;
  if (mcpServers) requireMcp(bridge, parsed.model);
  const responseId = id("resp");
  const messageId = id("msg");
  const created = Math.floor(Date.now() / 1000);
  const abortController = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; abortController.abort(); }, config.timeoutMs);
  request.once("aborted", () => abortController.abort());
  request.once("close", () => { if (!request.complete) abortController.abort(); });
  response.once("close", () => { if (!response.writableEnded) abortController.abort(); });
  const options: GenerateOptions = { instructions: formatInstructions(parsed.format), ...(parsed.generateImages ? { images: true } : {}), ...toolOptions(parsed), ...(mcpServers ? { mcpServers } : {}), ...(parsed.webSearch ? { webSearch: parsed.webSearch } : {}) };
  const asJson = parsed.format.type === "json";
  const withTools = parsed.functionTools !== undefined;
  // The message item comes after the generated images, the web searches and the MCP calls, so its text is not streamed live (it is only known when the turn is over).
  const deferred = parsed.generateImages || mcpServers !== undefined || parsed.webSearch !== undefined;
  const promptText = serializePrompt(parsed.conversation, options.instructions);
  /** A `function_call` output item per tool call the agent made; they come after the message. */
  const callItems = (result: GenerationResult) => (result.toolCalls ?? []).map((call) => ({ id: id("fc"), type: "function_call", status: "completed", call_id: call.id, name: call.name, arguments: call.arguments }));
  /** An `image_generation_call` item per generated image; they come before the message. */
  const imageItems = (result: GenerationResult) => (result.images ?? []).map((image) => ({ id: id("ig"), type: "image_generation_call", status: "completed", result: image.data, ...(image.revisedPrompt ? { revised_prompt: image.revisedPrompt } : {}), output_format: imageFormatName(image.mimeType) }));
  /** An `mcp_call` output item per call the agent made to a remote MCP server; they come before the message. */
  const mcpItems = (result: GenerationResult) => (result.mcpCalls ?? []).map((call) => ({ id: id("mcp"), type: "mcp_call", server_label: call.server, name: call.name, arguments: call.arguments, output: call.output, error: call.error, status: call.status }));
  /** A `web_search_call` output item per search the agent ran; they come before the message. `sources` are the pages the agent reported (Claude). */
  const searchItems = (result: GenerationResult) => (result.searches ?? []).map((search) => ({ id: id("ws"), type: "web_search_call", status: search.status, action: { type: "search", query: search.query, ...(search.sources?.length ? { sources: search.sources.map(({ url }) => ({ type: "url", url })) } : {}) } }));
  /** `url_citation` annotations of the answer text (only for a request with web search; none otherwise). */
  const annotationsOf = (text: string) => parsed.webSearch ? extractCitations(text).map((citation) => ({ type: "url_citation", ...citation })) : [];
  const messageItem = (result: GenerationResult, status: string) => ({ id: messageId, type: "message", status, role: "assistant", content: [{ type: "output_text", text: finalText(parsed.format, result), annotations: annotationsOf(finalText(parsed.format, result)) }] });
  // A response that ends with tool calls has no message item when the agent said nothing before them.
  const base = (result: GenerationResult, status: string, items: unknown[] = [], calls: unknown[] = []) => ({ id: responseId, object: "response", created_at: created, status, model: parsed.model, output: [...items, ...(calls.length && !result.text ? [] : [messageItem(result, status)]), ...calls], incomplete_details: result.stopReason === "max_tokens" ? { reason: "max_output_tokens" } : null, usage: responsesUsage({ ...result, text: finalText(parsed.format, result) }, promptText), store: false });
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
    // With function tools the message item opens with the first text, since a response that goes straight to tool calls has none.
    let messageOpen = false;
    if (!deferred && !withTools) openMessage(0);
    try {
      const delta = (text: string, index = 0) => {
        if (withTools && !deferred && !messageOpen) { messageOpen = true; openMessage(0); }
        event("response.output_text.delta", { item_id: messageId, output_index: index, content_index: 0, delta: text });
      };
      const result = await runGeneration(bridge, parsed.model, parsed.conversation, options, parsed.maxOutputTokens, asJson || deferred ? undefined : delta, abortController.signal);
      if (timedOut) throw new ApiError(504, "request_timeout", "The request exceeded the configured timeout.");
      traceUsage(trace, result, promptText);
      const status = mapStopReason(result.stopReason).responseStatus;
      const text = finalText(parsed.format, result);
      const items = [...imageItems(result), ...searchItems(result), ...mcpItems(result)];
      items.forEach((item, index) => {
        if (item.type === "web_search_call") {
          event("response.output_item.added", { output_index: index, item: { ...item, status: "in_progress", action: { type: "search", query: (item as { action: { query: string } }).action.query } } });
          event("response.web_search_call.in_progress", { item_id: item.id, output_index: index });
          event("response.web_search_call.searching", { item_id: item.id, output_index: index });
          if (item.status === "completed") event("response.web_search_call.completed", { item_id: item.id, output_index: index });
        } else if (item.type === "mcp_call") {
          event("response.output_item.added", { output_index: index, item: { ...item, status: "in_progress", output: null, error: null } });
          event("response.mcp_call.in_progress", { item_id: item.id, output_index: index });
          event(item.status === "completed" ? "response.mcp_call.completed" : "response.mcp_call.failed", { item_id: item.id, output_index: index });
        } else event("response.output_item.added", { output_index: index, item: { ...item, status: "in_progress", result: null } });
        event("response.output_item.done", { output_index: index, item });
      });
      const calls = callItems(result);
      const at = items.length;
      if (deferred) { if (!withTools || text || !calls.length) { messageOpen = true; openMessage(at); delta(text, at); } }
      else if (withTools) { if (asJson && text) delta(text); if (!messageOpen && !calls.length) { messageOpen = true; openMessage(0); } }
      else if (asJson) delta(text, at);
      if (!withTools || messageOpen) {
        const annotations = annotationsOf(text);
        annotations.forEach((annotation, annotationIndex) => event("response.output_text.annotation.added", { item_id: messageId, output_index: at, content_index: 0, annotation_index: annotationIndex, annotation }));
        event("response.output_text.done", { item_id: messageId, output_index: at, content_index: 0, text });
        event("response.content_part.done", { item_id: messageId, output_index: at, content_index: 0, part: { type: "output_text", text, annotations } });
        event("response.output_item.done", { output_index: at, item: messageItem(result, status) });
      }
      calls.forEach((call, position) => {
        const index = at + (!withTools || messageOpen ? 1 : 0) + position;
        event("response.output_item.added", { output_index: index, item: { ...call, status: "in_progress", arguments: "" } });
        event("response.function_call_arguments.delta", { item_id: call.id, output_index: index, delta: call.arguments });
        event("response.function_call_arguments.done", { item_id: call.id, output_index: index, name: call.name, arguments: call.arguments });
        event("response.output_item.done", { output_index: index, item: call });
      });
      const terminalEvent = status === "completed" ? "response.completed" : "response.incomplete";
      event(terminalEvent, { response: base(result, status, items, calls) });
      endSse(response);
    } catch (error) { trace.error = errorCode(error); const mapped = forResponses(error); writeSse(response, errorEnvelope(mapped instanceof Error ? mapped : new Error(String(mapped)))); endSse(response); }
    finally { clearTimeout(timer); }
    return;
  }
  try {
    const result = await runGeneration(bridge, parsed.model, parsed.conversation, options, parsed.maxOutputTokens, undefined, abortController.signal);
    if (timedOut) throw new ApiError(504, "request_timeout", "The request exceeded the configured timeout.");
    traceUsage(trace, result, promptText);
    json(response, 200, base(result, mapStopReason(result.stopReason).responseStatus, [...imageItems(result), ...searchItems(result), ...mcpItems(result)], callItems(result)));
  } catch (error) { throw forResponses(error); }
  finally { clearTimeout(timer); }
}

async function handleImageGeneration(request: IncomingMessage, response: ServerResponse, config: ProxyConfig, bridge: AcpLike, trace: Trace): Promise<void> {
  const parsed = normalizeImageGeneration(await readBody(request, config.maxBodyBytes), modelCheck(bridge));
  trace.model = parsed.model;
  trace.features.add("imageGeneration");
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
    traceUsage(trace, result, serializePrompt(parsed.conversation));
    const image = result.images?.[0];
    if (!image) { const said = result.text.trim().slice(0, 500); throw new ApiError(502, "no_image_generated", `The agent did not generate an image.${said ? ` It said: ${said}` : ""}`); }
    json(response, 200, { created, data: [{ b64_json: image.data, ...(image.revisedPrompt ? { revised_prompt: image.revisedPrompt } : {}) }], output_format: imageFormatName(image.mimeType) });
  } finally { clearTimeout(timer); }
}

const ENDPOINTS = new Set(["GET /v1/models", "POST /v1/chat/completions", "POST /v1/images/generations", "POST /v1/responses"]);

/** Records the request in the activity log when its response is over (a closed connection counts too). Only the fields of `ActivityEntry`. */
function track(activity: ActivityLog, bridge: AcpLike, response: ServerResponse, endpoint: string, trace: Trace): void {
  const time = Date.now();
  response.once("close", () => {
    const error = trace.error ?? (response.statusCode >= 400 ? undefined : response.writableFinished ? undefined : "client_closed");
    const entry: ActivityEntry = {
      time, endpoint, stream: trace.stream, features: [...trace.features], durationMs: Date.now() - time, status: response.statusCode,
      ...(trace.model ? { model: trace.model } : {}), ...(error ? { error } : {}),
      ...(trace.inputTokens !== undefined ? { inputTokens: trace.inputTokens } : {}), ...(trace.outputTokens !== undefined ? { outputTokens: trace.outputTokens } : {}),
    };
    const provider = trace.model ? bridge.providerOf?.(trace.model) : undefined;
    try { activity.record(provider ? { ...entry, provider } : entry); } catch { /* a listener of the log must not break the response */ }
  });
}

/** `options.fetch` downloads http(s) image URLs (default: the global fetch). `options.toolBridge` is the MCP endpoint `/mcp/<token>` for function tools; the server tells it where it listens. `options.activity` gets one entry per API request (not for /healthz and not for the tool bridge). */
export function createProxyServer(config: ProxyConfig, bridge: AcpLike, options: { fetch?: typeof fetch; toolBridge?: ToolBridgeHub; activity?: ActivityLog } = {}): Server {
  const toolBridge = options.toolBridge ?? new ToolBridgeHub();
  const server = createServer(async (request, response) => {
    const trace: Trace = { stream: false, features: new Set() };
    try {
      const method = request.method || "GET";
      const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
      if (method === "GET" && url.pathname === "/healthz") { json(response, 200, { status: "ok", uptime_seconds: Math.floor((Date.now() - startedAt) / 1000) }); return; }
      // The agents reach the tool bridge here; its token is the credential, so it is routed before the API key check.
      if (await toolBridge.handle(request, response, url.pathname)) return;
      // The playground page holds no data (its API calls carry the key), so it is served before the key check and is not logged as activity.
      if (await servePlayground(method, url.pathname, response)) return;
      const route = `${method} ${url.pathname}`;
      if (options.activity) track(options.activity, bridge, response, ENDPOINTS.has(route) ? route : "other", trace);
      if (!authenticated(request, config)) { trace.error = "invalid_api_key"; json(response, 401, { error: { message: "Invalid or missing bearer token.", type: "invalid_request_error", code: "invalid_api_key", param: null } }); return; }
      if (method === "GET" && url.pathname === "/v1/models") { const models = bridge.listModels ? await bridge.listModels() : []; json(response, 200, { object: "list", data: models.map((model) => ({ id: model.id, object: "model", created: 0, owned_by: model.ownedBy ?? "openai" })) }); return; }
      if (method === "POST" && url.pathname === "/v1/chat/completions") { await handleChat(request, response, config, bridge, trace, options.fetch); return; }
      if (method === "POST" && url.pathname === "/v1/images/generations") { await handleImageGeneration(request, response, config, bridge, trace); return; }
      if (method === "POST" && url.pathname === "/v1/responses") { await handleResponses(request, response, config, bridge, trace, options.fetch); return; }
      trace.error = "not_found";
      json(response, 404, { error: { message: "Not found.", type: "invalid_request_error", code: "not_found", param: null } });
    } catch (error) {
      trace.error = errorCode(error);
      if (response.headersSent) { response.end(); return; }
      if (error instanceof ApiError) { json(response, error.status, errorEnvelope(error)); return; }
      if (error instanceof AcpUnavailableError) { if (error.retryAfterSeconds) response.setHeader("Retry-After", String(error.retryAfterSeconds)); json(response, 503, { error: { message: error.message, type: "server_error", code: error.code ?? "backend_unavailable", param: null } }); return; }
      json(response, 500, errorEnvelope(error instanceof Error ? error : new Error(String(error))));
    }
  });
  server.on("listening", () => { const address = server.address(); if (address && typeof address === "object") toolBridge.setAddress(address.address, address.port); });
  server.on("close", () => toolBridge.closeAll());
  return server;
}
