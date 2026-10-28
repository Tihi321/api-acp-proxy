import { z } from "zod";
import { ImageError, loadImage } from "./images.js";
import { HEADER_NAME, MCP_LABEL, plainValue, TOOL_FILTER_NAME } from "./mcp-config.js";
import { BRIDGE_SERVER_NAME } from "./tool-bridge.js";

// Content parts are checked one by one in `convertContent`, so an unknown part type answers `unsupported_content` instead of a schema error.
const messageContentSchema = z.union([z.string(), z.array(z.object({ type: z.string() }).passthrough()).min(1)]);
const chatToolCallSchema = z.object({ id: z.string().min(1), type: z.literal("function"), function: z.object({ name: z.string().min(1), arguments: z.string() }) });
const chatMessageSchema = z.object({
  role: z.enum(["system", "developer", "user", "assistant", "tool"]),
  /** Null or absent only on an assistant message that carries tool calls (checked in `convertChatMessage`). */
  content: messageContentSchema.nullish(),
  tool_calls: z.array(chatToolCallSchema).optional(),
  tool_call_id: z.string().min(1).optional(),
  name: z.string().optional(),
}).strict();
const textPartSchema = z.object({ text: z.string() });
const chatImagePartSchema = z.object({ image_url: z.object({ url: z.string().min(1), detail: z.string().nullish() }).passthrough() });
const responsesImagePartSchema = z.object({ image_url: z.string().min(1), detail: z.string().nullish() });

const unsupportedChatFields = ["functions", "function_call", "audio", "logprobs", "top_logprobs", "prediction", "service_tier", "n", "temperature", "top_p", "stop", "presence_penalty", "frequency_penalty", "seed", "logit_bias"] as const;
const unsupportedResponseFields = ["temperature", "top_p", "truncation", "reasoning", "include", "background", "stream_options"] as const;

// Fields that only tune sampling. The agents behind the proxy cannot honour them, so by default they are
// rejected; with `ignoreSampling` they are dropped instead, for clients that send them on every request.
const ignorableChatFields = ["temperature", "top_p", "presence_penalty", "frequency_penalty", "seed"] as const;
const ignorableResponseFields = ["temperature", "top_p", "stream_options"] as const;
export interface NormalizeOptions { ignoreSampling?: boolean; /** Used to download http(s) image URLs (default: the global fetch). */ fetch?: typeof fetch }

function withoutFields(raw: unknown, fields: readonly string[], on: boolean | undefined): unknown {
  if (!on || !raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const copy: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  for (const field of fields) delete copy[field];
  return copy;
}

const jsonSchemaSpec = z.object({ name: z.string(), schema: z.unknown().optional(), strict: z.boolean().nullish(), description: z.string().optional() });
const chatResponseFormatSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text") }),
  z.object({ type: z.literal("json_object") }),
  z.object({ type: z.literal("json_schema"), json_schema: jsonSchemaSpec }),
]);
const responsesTextSchema = z.object({
  format: z.discriminatedUnion("type", [
    z.object({ type: z.literal("text") }),
    z.object({ type: z.literal("json_object") }),
    jsonSchemaSpec.extend({ type: z.literal("json_schema") }),
  ]).optional(),
}).strict();

export const chatRequestSchema = z.object({
  model: z.string(),
  messages: z.array(chatMessageSchema).min(1),
  stream: z.boolean().optional().default(false),
  max_tokens: z.number().int().positive().optional(),
  max_completion_tokens: z.number().int().positive().optional(),
  user: z.string().optional(),
  stream_options: z.object({ include_usage: z.boolean().optional() }).passthrough().nullable().optional(),
  response_format: chatResponseFormatSchema.nullish(),
}).passthrough();

// `type`, `id` and `status` are there because clients send our own output items back as input.
const responseMessageSchema = z.object({
  type: z.literal("message").optional(),
  id: z.string().optional(),
  status: z.string().optional(),
  role: z.enum(["system", "developer", "user", "assistant"]),
  content: messageContentSchema,
}).strict();
const responseFunctionCallSchema = z.object({ type: z.literal("function_call"), call_id: z.string().min(1), name: z.string().min(1), arguments: z.string(), id: z.string().optional(), status: z.string().optional() }).strict();
const responseFunctionOutputSchema = z.object({ type: z.literal("function_call_output"), call_id: z.string().min(1), output: z.union([z.string(), z.array(z.object({ type: z.string() }).passthrough())]), id: z.string().optional(), status: z.string().optional() }).strict();

// A client may send our own `mcp_call` / `mcp_list_tools` output items back as input; they are history the agent already lived through, so they are accepted and left out.
const responseSkippedSchema = z.object({ type: z.enum(["mcp_call", "mcp_list_tools"]) }).passthrough();

export const responsesRequestSchema = z.object({
  model: z.string(),
  input: z.union([z.string(), z.array(z.union([responseMessageSchema, responseFunctionCallSchema, responseFunctionOutputSchema, responseSkippedSchema])).min(1)]),
  instructions: z.string().optional(),
  stream: z.boolean().optional().default(false),
  store: z.boolean().optional().default(false),
  previous_response_id: z.string().optional(),
  max_output_tokens: z.number().int().positive().optional(),
  text: responsesTextSchema.nullish(),
}).passthrough();

export type ChatRequest = z.infer<typeof chatRequestSchema>;
export type ResponsesRequest = z.infer<typeof responsesRequestSchema>;
export type Role = "system" | "developer" | "user" | "assistant";
/** A tool call of an assistant message: `id` is the proxy's `call_<random>`, `arguments` the JSON text. */
export type ToolCall = { id: string; name: string; arguments: string };
/** A Responses `mcp` tool: `url` is its `server_url` (absent: the label names a server of the settings); `allowedTools` is `allowed_tools` and `neverTools` the `never.tool_names` of `require_approval` (absent: all tools). */
export interface McpToolRequest { label: string; url?: string; headers?: Record<string, string>; allowedTools?: string[]; neverTools?: string[] }
/** What a request that asks for web search says: the approximate location and the allowed domains become hint lines of the prompt (the agents cannot enforce either); `required` is a `tool_choice` that asks for a search. `search_context_size` is accepted and ignored. */
export interface WebSearchRequest { location?: { city?: string; region?: string; country?: string; timezone?: string }; domains?: string[]; required?: boolean }
/** A function tool of the client's request. */
export interface ToolDef { name: string; description?: string; parameters?: unknown }
/** `tool_choice`: `none` leaves the tools out altogether; `required` and a named function are only an instruction to the agent. */
export type ToolChoice = "none" | "auto" | "required" | { name: string };
/** A piece of a message; images are always base64 `data` (never a URI) because the agents reject or hang on a `uri`. */
export type Part = { type: "text"; text: string } | { type: "image"; mimeType: string; data: string };
/** `role: "tool"` is a tool result (`toolCallId`); an assistant message may carry `toolCalls` (and no text). */
export type Message = { role: Role | "tool"; parts: Part[]; toolCalls?: ToolCall[]; toolCallId?: string };
export const textMessage = (role: Role, text: string): Message => ({ role, parts: [{ type: "text", text }] });
/** The text parts of a message joined; images are left out. */
export const messageText = (message: Message): string => message.parts.map((part) => part.type === "text" ? part.text : "").join("");
export const hasImages = (messages: Message[]): boolean => messages.some((message) => message.parts.some((part) => part.type === "image"));

export type OutputFormat = { type: "text" } | { type: "json"; name?: string; schema?: unknown; description?: string };
const textFormat: OutputFormat = { type: "text" };

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string, public readonly param?: string) {
    super(message);
    this.name = "ApiError";
  }
}

export function errorEnvelope(error: ApiError | Error): { error: Record<string, unknown> } {
  if (error instanceof ApiError) return { error: { message: error.message, type: error.status === 429 ? "rate_limit_error" : "invalid_request_error", param: error.param ?? null, code: error.code } };
  return { error: { message: error.message || "Internal server error", type: "server_error", param: null, code: "internal_error" } };
}

export function asText(content: string | Array<{ type: string; text?: string }>): string {
  return typeof content === "string" ? content : content.map((part) => part.text ?? "").join("");
}

export type ModelCheck = (model: string) => boolean;

/** Without a check (a bridge that does not know its models) every id is accepted and the agent decides. */
export function validateModel(model: string, isKnownModel?: ModelCheck): void {
  if (isKnownModel && !isKnownModel(model)) throw new ApiError(404, "model_not_found", `The model '${model}' does not exist.`, "model");
}

function issueParam(issue: z.ZodIssue | undefined): string | undefined {
  const head = issue?.path[0];
  return head === "response_format" || head === "text" ? head : undefined;
}

function jsonFormat(spec: { type: "json_object" } | { type: "json_schema"; name: string; schema?: unknown; description?: string }): OutputFormat {
  if (spec.type === "json_object") return { type: "json" };
  return { type: "json", name: spec.name, ...(spec.schema !== undefined ? { schema: spec.schema } : {}), ...(spec.description ? { description: spec.description } : {}) };
}

function rejectUnsupported(obj: Record<string, unknown>, fields: readonly string[]): void {
  for (const field of fields) if (obj[field] !== undefined && obj[field] !== false && obj[field] !== null) throw new ApiError(400, "unsupported_parameter", `Parameter '${field}' is not supported by this proxy.`, field);
}

/** `generateImages`: the request asked the agent for images (chat `modalities` with "image", Responses `image_generation` tool). */
type NormalizedRequest = { model: string; conversation: Message[]; format: OutputFormat; maxOutputTokens?: number; generateImages: boolean; /** Set when the request asked for web search (chat `web_search_options`, a Responses `web_search` tool). */ webSearch?: WebSearchRequest; /** The function tools to hand the agent (absent without tools or with `tool_choice: "none"`). */ functionTools?: ToolDef[]; toolChoice?: ToolChoice; parallelToolCalls?: boolean; /** The Responses `mcp` tools (matched with the settings by `resolveMcpServers`). */ mcpTools?: McpToolRequest[] };

function unsupportedContent(message: string, param: string): ApiError { return new ApiError(400, "unsupported_content", message, param); }

/** Turns message content into parts: text stays text, an image URL is decoded or downloaded to base64 (user messages only). Anything else is `unsupported_content`. */
async function convertContent(content: z.infer<typeof messageContentSchema>, role: Role | "tool", api: "chat" | "responses", param: string, options: NormalizeOptions): Promise<Part[]> {
  if (typeof content === "string") return [{ type: "text", text: content }];
  const textTypes = api === "chat" ? ["text"] : ["text", "input_text", "output_text"];
  const imageType = api === "chat" ? "image_url" : "input_image";
  return await Promise.all(content.map(async (raw): Promise<Part> => {
    if (textTypes.includes(raw.type)) {
      const text = textPartSchema.safeParse(raw);
      if (!text.success) throw new ApiError(400, "invalid_request", `A '${raw.type}' content part needs a string 'text'.`, param);
      return { type: "text", text: text.data.text };
    }
    if (raw.type !== imageType) throw unsupportedContent(`Content part type '${raw.type}' is not supported; only text and image parts are.`, param);
    if (role !== "user") throw unsupportedContent("Images are only supported in user messages.", param);
    if ((raw as Record<string, unknown>).file_id != null) throw unsupportedContent("Uploaded files (file_id) are not supported; send the image as a URL or a base64 data URL.", param);
    const image = api === "chat" ? chatImagePartSchema.safeParse(raw) : responsesImagePartSchema.safeParse(raw);
    if (!image.success) throw new ApiError(400, "invalid_request", `An '${imageType}' content part needs ${api === "chat" ? "an image_url.url" : "an image_url"} string.`, param);
    const url = typeof image.data.image_url === "string" ? image.data.image_url : image.data.image_url.url;
    try { return { type: "image", ...(await loadImage(url, options.fetch)) }; }
    catch (error) { if (error instanceof ImageError) throw new ApiError(400, error.code, error.message, param); throw error; }
  }));
}

/** Chat `modalities`: only "text" and "image" are accepted; true when "image" is among them. */
function chatModalities(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (!Array.isArray(value) || value.some((entry) => entry !== "text" && entry !== "image")) throw new ApiError(400, "unsupported_parameter", "Parameter 'modalities' only supports \"text\" and \"image\" in this proxy.", "modalities");
  return value.includes("image");
}

const SEARCH_TOOL_TYPES = ["web_search", "web_search_preview"];
const SEARCH_CONTEXT_SIZES = ["low", "medium", "high"];
const LOCATION_FIELDS = ["city", "region", "country", "timezone"] as const;
const DOMAIN = /^[A-Za-z0-9*][A-Za-z0-9.*_\-/:]{0,199}$/;
const plainObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
function searchError(message: string, param: string, code = "invalid_request"): ApiError { return new ApiError(400, code, message, param); }

/** `user_location`: `{ type: "approximate", approximate: { city, ... } }` in chat, the same fields next to `type` in Responses (both are accepted in either). Single-line strings only: they go into the prompt. */
function parseSearchLocation(value: unknown, param: string): WebSearchRequest["location"] {
  if (value === undefined || value === null) return undefined;
  if (!plainObject(value)) throw searchError("user_location must be an object.", param);
  if (value.type !== undefined && value.type !== "approximate") throw searchError("user_location.type must be 'approximate'.", param);
  const source = plainObject(value.approximate) ? value.approximate : value;
  const location: NonNullable<WebSearchRequest["location"]> = {};
  for (const field of LOCATION_FIELDS) {
    const entry = source[field];
    if (entry === undefined || entry === null) continue;
    if (typeof entry !== "string" || entry.length > 100 || /[\u0000-\u001f\u007f]/.test(entry)) throw searchError(`user_location.${field} must be a single-line string of at most 100 characters.`, param);
    if (entry.trim()) location[field] = entry.trim();
  }
  return Object.keys(location).length ? location : undefined;
}

/** The web search options shared by both APIs: `search_context_size` is checked and ignored, `user_location` and `filters.allowed_domains` become hints. */
function parseWebSearch(raw: Record<string, unknown>, param: string, filters: boolean): WebSearchRequest {
  const size = raw.search_context_size;
  if (size !== undefined && size !== null && (typeof size !== "string" || !SEARCH_CONTEXT_SIZES.includes(size))) throw searchError("search_context_size must be 'low', 'medium' or 'high'.", param);
  const location = parseSearchLocation(raw.user_location, param);
  let domains: string[] | undefined;
  if (filters && raw.filters !== undefined && raw.filters !== null) {
    if (!plainObject(raw.filters)) throw searchError("filters must be an object.", param);
    const allowed = raw.filters.allowed_domains;
    if (allowed !== undefined && allowed !== null) {
      if (!Array.isArray(allowed) || allowed.length > 100 || allowed.some((domain) => typeof domain !== "string" || !DOMAIN.test(domain))) throw searchError("filters.allowed_domains must be an array of at most 100 domain names.", param);
      if (allowed.length) domains = [...new Set(allowed as string[])];
    }
  }
  return { ...(location ? { location } : {}), ...(domains ? { domains } : {}) };
}

/** Chat `web_search_options` (an object, possibly empty): the request asks for web search. */
function chatWebSearch(data: Record<string, unknown>): WebSearchRequest | undefined {
  const options = data.web_search_options;
  if (options === undefined || options === null) return undefined;
  if (!plainObject(options)) throw searchError("Parameter 'web_search_options' must be an object.", "web_search_options");
  return parseWebSearch(options, "web_search_options", false);
}

/** A `tool_choice` that agrees with web search being the only kind of tool: it is then an instruction only (`required`, or the web search tool by name). */
function searchToolChoice(choice: unknown): boolean { return choice === "auto" || choice === "required" || (plainObject(choice) && typeof choice.type === "string" && SEARCH_TOOL_TYPES.includes(choice.type)); }

/** Responses `tools`: `image_generation` tools, or function tools and `mcp` tools (the image tool cannot be combined with the others); anything else, or an empty list, is a 400. `partial_images` is a 400. */
function responsesTools(data: Record<string, unknown>): { image: boolean; functions: ToolDef[]; mcp: McpToolRequest[]; search?: WebSearchRequest } {
  const tools = data.tools;
  if (tools === undefined || tools === null) return { image: false, functions: [], mcp: [] };
  if (!Array.isArray(tools) || !tools.length) throw toolsError("Parameter 'tools' is not supported by this proxy.");
  let image = false;
  const functions: ToolDef[] = [];
  const mcp: McpToolRequest[] = [];
  let search: WebSearchRequest | undefined;
  for (const tool of tools) {
    const type = tool && typeof tool === "object" ? (tool as { type?: unknown }).type : undefined;
    if (type === "image_generation") {
      if ((tool as { partial_images?: unknown }).partial_images != null && (tool as { partial_images?: unknown }).partial_images !== 0) throw toolsError("Partial images are not supported; the image is returned whole.");
      image = true;
    } else if (typeof type === "string" && SEARCH_TOOL_TYPES.includes(type)) {
      if (search) throw toolsError("Only one web search tool is allowed per request.", "invalid_request");
      search = parseWebSearch(tool as Record<string, unknown>, "tools", true);
    } else if (type === "mcp") mcp.push(parseMcpTool(tool as Record<string, unknown>));
    else functions.push(parseFunctionTool(tool, "responses"));
  }
  if (image && functions.length) throw toolsError("Function tools cannot be combined with the image_generation tool in one request.");
  if (image && mcp.length) throw toolsError("MCP tools cannot be combined with the image_generation tool in one request.");
  if (image && search) throw toolsError("Web search cannot be combined with the image_generation tool in one request.");
  if (new Set(functions.map((tool) => tool.name)).size !== functions.length) throw toolsError("Tool names must be unique.", "invalid_request");
  if (new Set(mcp.map((tool) => tool.label)).size !== mcp.length) throw toolsError("MCP server labels must be unique within a request.", "invalid_request");
  return { image, functions, mcp, ...(search ? { search } : {}) };
}

const APPROVAL_HELP = "The approval flow for MCP tools is not supported by this proxy: send require_approval: \"never\" (or { never: { tool_names: [...] } }) on every mcp tool.";
/** `require_approval`: only "never" and `{ never: { tool_names? } }` are accepted (the OpenAI default is "always", so a missing value is a 400 too). Returns the tools that need no approval (undefined: all). */
function parseApproval(value: unknown): string[] | undefined {
  if (value === "never") return undefined;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const { never, always } = value as { never?: unknown; always?: unknown };
    if (never && typeof never === "object" && !Array.isArray(never) && (always === undefined || always === null)) {
      const names = (never as { tool_names?: unknown }).tool_names;
      return names === undefined || names === null ? undefined : toolNames(names, "require_approval.never.tool_names");
    }
  }
  throw toolsError(APPROVAL_HELP);
}

function toolNames(value: unknown, what: string): string[] {
  if (!Array.isArray(value) || !value.length || value.some((name) => typeof name !== "string" || !TOOL_FILTER_NAME.test(name))) throw toolsError(`${what} must be a non-empty array of tool names (no spaces, '*' or parentheses).`, "invalid_request");
  return [...new Set(value as string[])];
}

/** One `mcp` tool of a Responses request. Stdio servers, connectors and `authorization` are 400s; `server_description` is accepted and ignored. */
function parseMcpTool(raw: Record<string, unknown>): McpToolRequest {
  const label = raw.server_label;
  if (typeof label !== "string" || !MCP_LABEL.test(label)) throw toolsError("An mcp tool needs a server_label of 1 to 64 letters, digits, '_' or '-'.", "invalid_request");
  if (label === BRIDGE_SERVER_NAME) throw toolsError(`The server_label '${BRIDGE_SERVER_NAME}' is reserved for the proxy's own tool bridge.`, "invalid_request");
  for (const field of ["command", "args", "env"]) if (raw[field] !== undefined) throw toolsError("Stdio MCP servers can only be configured in the proxy's settings (mcpServers), never in a request.");
  if (raw.connector_id != null) throw toolsError("MCP connectors (connector_id) are not supported; send a server_url.");
  if (raw.authorization != null) throw toolsError("The mcp tool 'authorization' field is not supported; send the credential in headers.");
  let url: string | undefined;
  if (raw.server_url !== undefined && raw.server_url !== null) {
    if (typeof raw.server_url !== "string") throw toolsError("server_url must be a string.", "invalid_request");
    let parsed: URL;
    try { parsed = new URL(raw.server_url); } catch { throw toolsError("server_url is not a valid URL.", "invalid_request"); }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw toolsError("server_url must be an http or https URL.");
    url = raw.server_url;
  }
  let headers: Record<string, string> | undefined;
  if (raw.headers !== undefined && raw.headers !== null) {
    const entries = raw.headers && typeof raw.headers === "object" && !Array.isArray(raw.headers) ? Object.entries(raw.headers) : undefined;
    if (!entries || entries.some(([name, value]) => !HEADER_NAME.test(name) || typeof value !== "string" || !plainValue(value))) throw toolsError("headers must be an object of header names to string values without line breaks.", "invalid_request");
    headers = Object.fromEntries(entries as Array<[string, string]>);
  }
  let allowedTools: string[] | undefined;
  const allowed = raw.allowed_tools;
  if (allowed !== undefined && allowed !== null) {
    const names = Array.isArray(allowed) ? allowed : allowed && typeof allowed === "object" ? (allowed as { tool_names?: unknown }).tool_names : undefined;
    if (names !== undefined && names !== null) allowedTools = toolNames(names, "allowed_tools");
  }
  const neverTools = parseApproval(raw.require_approval);
  return { label, ...(url ? { url } : {}), ...(headers ? { headers } : {}), ...(allowedTools ? { allowedTools } : {}), ...(neverTools ? { neverTools } : {}) };
}
/** A `tool_choice` that agrees with the image tool being the only tool. */
function imageToolChoice(choice: unknown): boolean { return choice === "auto" || choice === "required" || (typeof choice === "object" && choice !== null && (choice as { type?: unknown }).type === "image_generation"); }

const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
function toolsError(message: string, code = "unsupported_parameter", param = "tools"): ApiError { return new ApiError(400, code, message, param); }

/** One function tool: chat nests it under `function`, Responses puts the fields next to `type`. */
function parseFunctionTool(raw: unknown, api: "chat" | "responses"): ToolDef {
  const type = raw && typeof raw === "object" ? (raw as { type?: unknown }).type : undefined;
  if (type !== "function") throw toolsError(api === "chat" ? "Only tools of type 'function' are supported." : "Only tools of type 'function', 'mcp', 'web_search' and 'image_generation' are supported.");
  const spec = (api === "chat" ? (raw as { function?: unknown }).function : raw) as Record<string, unknown> | undefined;
  if (!spec || typeof spec !== "object" || typeof spec.name !== "string") throw toolsError("A function tool needs a name.", "invalid_request");
  if (!TOOL_NAME.test(spec.name)) throw toolsError(`The tool name '${spec.name}' must be 1 to 64 letters, digits, '_' or '-'.`, "invalid_request");
  if (spec.description !== undefined && spec.description !== null && typeof spec.description !== "string") throw toolsError("A tool description must be a string.", "invalid_request");
  return { name: spec.name, ...(typeof spec.description === "string" && spec.description ? { description: spec.description } : {}), ...(spec.parameters && typeof spec.parameters === "object" ? { parameters: spec.parameters } : {}) };
}

/** `tool_choice` against the tools list: a string, or a named function (chat `{ type, function: { name } }`, Responses `{ type, name }`). */
function parseToolChoice(choice: unknown, tools: ToolDef[], api: "chat" | "responses"): ToolChoice {
  if (choice === undefined || choice === null) return "auto";
  if (choice === "none" || choice === "auto" || choice === "required") return choice;
  const named = choice && typeof choice === "object" && (choice as { type?: unknown }).type === "function" ? (api === "chat" ? (choice as { function?: { name?: unknown } }).function?.name : (choice as { name?: unknown }).name) : undefined;
  if (typeof named !== "string") throw toolsError("tool_choice must be 'none', 'auto', 'required' or a named function.", "unsupported_parameter", "tool_choice");
  if (!tools.some((tool) => tool.name === named)) throw toolsError(`tool_choice names '${named}', which is not in tools.`, "invalid_request", "tool_choice");
  return { name: named };
}

/** The shared tail of both APIs: tools, `tool_choice` and `parallel_tool_calls` into the normalized fields (nothing for `none`: the agent gets no tools). */
function toolFields(tools: ToolDef[], choice: unknown, parallel: unknown, api: "chat" | "responses"): Pick<NormalizedRequest, "functionTools" | "toolChoice" | "parallelToolCalls"> {
  if (parallel !== undefined && parallel !== null && typeof parallel !== "boolean") throw toolsError("parallel_tool_calls must be a boolean.", "invalid_request", "parallel_tool_calls");
  const parsedChoice = parseToolChoice(choice, tools, api);
  if (parsedChoice === "none") return {};
  return { functionTools: tools, toolChoice: parsedChoice, ...(typeof parallel === "boolean" ? { parallelToolCalls: parallel } : {}) };
}

/** Chat `tools`: only function tools; `tool_choice` without tools is rejected as before. */
function chatTools(data: Record<string, unknown>): Pick<NormalizedRequest, "functionTools" | "toolChoice" | "parallelToolCalls"> {
  const raw = data.tools;
  if (raw === undefined || raw === null) {
    if (data.tool_choice !== undefined && data.tool_choice !== null) throw toolsError("Parameter 'tool_choice' needs tools.", "unsupported_parameter", "tool_choice");
    return {};
  }
  if (!Array.isArray(raw) || !raw.length) throw toolsError("Parameter 'tools' must be a non-empty array of function tools.");
  const tools = raw.map((tool) => parseFunctionTool(tool, "chat"));
  if (new Set(tools.map((tool) => tool.name)).size !== tools.length) throw toolsError("Tool names must be unique.", "invalid_request");
  return toolFields(tools, data.tool_choice, data.parallel_tool_calls, "chat");
}

/** An assistant tool-call message, a tool result or a plain message of a chat request. */
async function convertChatMessage(message: z.infer<typeof chatMessageSchema>, options: NormalizeOptions): Promise<Message> {
  const bad = (text: string) => new ApiError(400, "invalid_request", text, "messages");
  if (message.name !== undefined && message.role !== "tool") throw bad("Unrecognized key 'name' in a message.");
  if (message.tool_calls && message.role !== "assistant") throw bad("Only assistant messages carry tool_calls.");
  if (message.role === "tool") {
    if (!message.tool_call_id) throw bad("A tool message needs a tool_call_id.");
    if (message.content === undefined || message.content === null) throw bad("A tool message needs content.");
    return { role: "tool", toolCallId: message.tool_call_id, parts: await convertContent(message.content, "tool", "chat", "messages", options) };
  }
  if (message.tool_call_id !== undefined) throw bad("Only tool messages carry a tool_call_id.");
  const calls = message.tool_calls?.map((call) => ({ id: call.id, name: call.function.name, arguments: call.function.arguments }));
  if (message.content === undefined || message.content === null) {
    if (!calls?.length) throw bad("A message needs content.");
    return { role: message.role, parts: [], toolCalls: calls };
  }
  return { role: message.role, parts: await convertContent(message.content, message.role, "chat", "messages", options), ...(calls?.length ? { toolCalls: calls } : {}) };
}

export async function normalizeChat(raw: unknown, isKnownModel?: ModelCheck, options: NormalizeOptions = {}): Promise<Omit<ChatRequest, "model"> & NormalizedRequest> {
  const parsed = chatRequestSchema.safeParse(withoutFields(raw, ignorableChatFields, options.ignoreSampling));
  if (!parsed.success) throw new ApiError(400, "invalid_request", parsed.error.issues[0]?.message || "Invalid request.", issueParam(parsed.error.issues[0]));
  rejectUnsupported(parsed.data, unsupportedChatFields);
  const generateImages = chatModalities(parsed.data.modalities);
  const toolSpec = chatTools(parsed.data);
  if (generateImages && toolSpec.functionTools) throw toolsError("Function tools cannot be combined with image output (modalities).");
  const webSearch = chatWebSearch(parsed.data);
  if (generateImages && webSearch) throw new ApiError(400, "unsupported_parameter", "Web search cannot be combined with image output (modalities).", "web_search_options");
  if (parsed.data.max_tokens !== undefined && parsed.data.max_completion_tokens !== undefined) throw new ApiError(400, "invalid_request", "Only one of max_tokens and max_completion_tokens may be provided.");
  validateModel(parsed.data.model, isKnownModel);
  const rf = parsed.data.response_format;
  const format = !rf || rf.type === "text" ? textFormat : jsonFormat(rf.type === "json_object" ? rf : { type: "json_schema", ...rf.json_schema });
  const maxOutputTokens = parsed.data.max_completion_tokens ?? parsed.data.max_tokens;
  const conversation = await Promise.all(parsed.data.messages.map((message) => convertChatMessage(message, options)));
  return { ...parsed.data, model: parsed.data.model, conversation, format, generateImages, ...toolSpec, ...(webSearch && !(parsed.data.tools != null && toolSpec.functionTools === undefined) ? { webSearch } : {}), ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}) };
}

/** Responses input items: messages, and `function_call` / `function_call_output` items. A `function_call` joins the assistant message right before it (its text, in the same response), else it is an assistant message of its own. */
async function convertResponsesInput(input: Array<z.infer<typeof responseMessageSchema> | z.infer<typeof responseFunctionCallSchema> | z.infer<typeof responseFunctionOutputSchema> | z.infer<typeof responseSkippedSchema>>, options: NormalizeOptions): Promise<Message[]> {
  const kept = input.filter((item): item is Exclude<typeof item, z.infer<typeof responseSkippedSchema>> => !("type" in item && (item.type === "mcp_call" || item.type === "mcp_list_tools")));
  const items = await Promise.all(kept.map(async (item): Promise<{ message: Message } | { call: ToolCall }> => {
    if ("role" in item) return { message: { role: item.role, parts: await convertContent(item.content, item.role, "responses", "input", options) } };
    if (item.type === "function_call") return { call: { id: item.call_id, name: item.name, arguments: item.arguments } };
    return { message: { role: "tool", toolCallId: item.call_id, parts: await convertContent(item.output, "tool", "responses", "input", options) } };
  }));
  const out: Message[] = [];
  for (const entry of items) {
    if ("message" in entry) { out.push(entry.message); continue; }
    const last = out[out.length - 1];
    if (last?.role === "assistant") (last.toolCalls ??= []).push(entry.call);
    else out.push({ role: "assistant", parts: [], toolCalls: [entry.call] });
  }
  return out;
}

export async function normalizeResponses(raw: unknown, isKnownModel?: ModelCheck, options: NormalizeOptions = {}): Promise<Omit<ResponsesRequest, "model"> & NormalizedRequest> {
  const parsed = responsesRequestSchema.safeParse(withoutFields(raw, ignorableResponseFields, options.ignoreSampling));
  if (!parsed.success) throw new ApiError(400, "invalid_request", parsed.error.issues[0]?.message || "Invalid request.", issueParam(parsed.error.issues[0]));
  const { image: generateImages, functions, mcp, search } = responsesTools(parsed.data);
  // `include: ["web_search_call.action.sources"]` asks for what the web_search_call items carry anyway.
  const include = parsed.data.include;
  const sourcesOnly = search !== undefined && Array.isArray(include) && include.every((entry) => entry === "web_search_call.action.sources");
  rejectUnsupported(sourcesOnly ? { ...parsed.data, include: undefined } : parsed.data, unsupportedResponseFields);
  if (generateImages) { if (parsed.data.tool_choice != null && !imageToolChoice(parsed.data.tool_choice)) rejectUnsupported(parsed.data, ["tool_choice"]); rejectUnsupported(parsed.data, ["parallel_tool_calls"]); }
  else if (!functions.length && search) { if (parsed.data.tool_choice != null && !searchToolChoice(parsed.data.tool_choice)) rejectUnsupported(parsed.data, ["tool_choice"]); rejectUnsupported(parsed.data, ["parallel_tool_calls"]); }
  else if (!functions.length) rejectUnsupported(parsed.data, ["tool_choice", "parallel_tool_calls"]);
  // `tool_choice: "none"` leaves every tool out, the MCP tools too.
  const toolSpec = functions.length ? toolFields(functions, parsed.data.tool_choice, parsed.data.parallel_tool_calls, "responses") : {};
  if (parsed.data.store === true) throw new ApiError(400, "unsupported_parameter", "Stored responses are not supported.", "store");
  if (parsed.data.previous_response_id !== undefined) throw new ApiError(400, "unsupported_parameter", "Persistent conversations are not supported.", "previous_response_id");
  validateModel(parsed.data.model, isKnownModel);
  const conversation: Message[] = [];
  if (parsed.data.instructions) conversation.push(textMessage("system", parsed.data.instructions));
  if (typeof parsed.data.input === "string") conversation.push(textMessage("user", parsed.data.input));
  else conversation.push(...await convertResponsesInput(parsed.data.input, options));
  const tf = parsed.data.text?.format;
  return { ...parsed.data, model: parsed.data.model, conversation, format: !tf || tf.type === "text" ? textFormat : jsonFormat(tf), generateImages, ...toolSpec, ...(mcp.length && !(functions.length && !toolSpec.functionTools) ? { mcpTools: mcp } : {}), ...(search && !(functions.length && !toolSpec.functionTools) ? { webSearch: { ...search, ...(!functions.length && (parsed.data.tool_choice === "required" || (plainObject(parsed.data.tool_choice) && parsed.data.tool_choice.type !== "function")) ? { required: true } : {}) } } : {}), ...(parsed.data.max_output_tokens !== undefined ? { maxOutputTokens: parsed.data.max_output_tokens } : {}) };
}

const imageRequestSchema = z.object({
  model: z.string(),
  prompt: z.string().min(1),
  n: z.number().int().nullish(),
  size: z.string().nullish(),
  quality: z.string().nullish(),
  background: z.string().nullish(),
  response_format: z.string().nullish(),
  output_format: z.enum(["png", "jpeg", "webp"]).nullish(),
  stream: z.boolean().nullish(),
  partial_images: z.number().nullish(),
}).passthrough();

export interface ImageGenerationRequest { model: string; conversation: Message[]; outputFormat?: string }

const gcd = (a: number, b: number): number => b ? gcd(b, a % b) : a;

/** The hint lines of an image request: size as an aspect ratio (the agents take a ratio, not pixels), quality and background as given. */
function imageHints(size: string | null | undefined, quality: string | null | undefined, background: string | null | undefined): string[] {
  const hints: string[] = [];
  if (size && size !== "auto") {
    const match = /^(\d{2,5})x(\d{2,5})$/i.exec(size);
    if (!match) throw new ApiError(400, "invalid_request", "Parameter 'size' must be 'auto' or WIDTHxHEIGHT, for example 1024x1024.", "size");
    const width = Number(match[1]), height = Number(match[2]), divisor = gcd(width, height);
    hints.push(`Aspect ratio: ${width / divisor}:${height / divisor} (requested size ${width}x${height}).`);
  }
  if (quality && quality !== "auto") hints.push(`Quality: ${quality}.`);
  if (background && background !== "auto") hints.push(`Background: ${background}.`);
  return hints;
}

/** The user message text of an image request: the prompt and the hint lines (size as an aspect ratio, quality, background). A malformed size is a 400 `invalid_request`. */
export function imageGenerationText(prompt: string, size?: string | null, quality?: string | null, background?: string | null): string {
  return [`Generate an image: ${prompt}`, ...imageHints(size, quality, background)].join("\n");
}

/** `POST /v1/images/generations`: one image from a prompt. Edits (`image`, `mask`), `n` above 1, URL answers and streaming are 400s. */
export function normalizeImageGeneration(raw: unknown, isKnownModel?: ModelCheck): ImageGenerationRequest {
  const parsed = imageRequestSchema.safeParse(raw);
  if (!parsed.success) throw new ApiError(400, "invalid_request", parsed.error.issues[0]?.message || "Invalid request.", typeof parsed.error.issues[0]?.path[0] === "string" ? parsed.error.issues[0].path[0] : undefined);
  const data = parsed.data as Record<string, unknown> & z.infer<typeof imageRequestSchema>;
  const reject = (param: string, message: string): never => { throw new ApiError(400, "unsupported_parameter", message, param); };
  if (data.n != null && data.n !== 1) reject("n", "Only n = 1 is supported: the agents generate one image per request.");
  if (data.response_format != null && data.response_format !== "b64_json") reject("response_format", "Only response_format 'b64_json' is supported; the proxy has no place to host image URLs.");
  for (const field of ["mask", "image", "images"]) if (data[field] != null) reject(field, "Image edits are not supported; only generations from a prompt are.");
  if (data.stream === true) reject("stream", "Streaming image generation is not supported.");
  if (data.partial_images != null && data.partial_images !== 0) reject("partial_images", "Partial images are not supported; the image is returned whole.");
  validateModel(data.model, isKnownModel);
  const text = imageGenerationText(data.prompt, data.size, data.quality, data.background);
  return { model: data.model, conversation: [textMessage("user", text)], ...(data.output_format ? { outputFormat: data.output_format } : {}) };
}

/** The `output_format` name of a generated image's MIME type. */
export const imageFormatName = (mimeType: string): string => mimeType.split("/")[1]?.replace("jpg", "jpeg") || "png";

export function formatInstructions(format: OutputFormat): string | undefined {
  if (format.type === "text") return undefined;
  const base = "Respond with a single valid JSON value only: no prose, no explanations, no Markdown code fences.";
  if (format.schema === undefined) return base;
  return `${base} It must conform to this JSON Schema${format.name ? ` (${format.name})` : ""}${format.description ? `: ${format.description}` : ""}\n${JSON.stringify(format.schema)}`;
}

/** What a request with tools tells the agent about them (see `buildPrompt`). `client`: the session has the client's function tools as the MCP server `client` (default true); `mcp`: its remote MCP servers, with the tools the agent may call (all when absent). */
export interface ToolPrompt { choice?: ToolChoice; parallel?: boolean; client?: boolean; mcp?: Array<{ label: string; tools?: string[] }> }

/** The preamble of a prompt whose session has MCP servers (the `client` bridge and/or the request's remote servers): use only those servers' tools, nothing else. `tool_choice` and `parallel_tool_calls` are instructions only. */
function toolsPreamble(tools: ToolPrompt, search?: WebSearchRequest): string {
  const labels = [...(tools.client === false ? [] : [BRIDGE_SERVER_NAME]), ...(tools.mcp ?? []).map((server) => server.label)];
  const named = labels.map((label) => `"${label}"`).join(", ");
  const lines = [`This is an API request with tools. When a tool is needed, call it from the MCP server${labels.length === 1 ? "" : "s"} named ${named} and use only those tools. Never run commands, access files, use the web or call any other tool. Respond with the answer only.`];
  if (search) lines[0] = `This is an API request with tools and web search. When a tool is needed, call it from the MCP server${labels.length === 1 ? "" : "s"} named ${named}, and use web search only through your web search tool. Use no other tools: never read URLs or web pages, run commands, access files or ask for other permissions. Respond with the answer only.`;
  for (const server of tools.mcp ?? []) if (server.tools) lines.push(`From the MCP server "${server.label}" use only these tools: ${server.tools.join(", ")}.`);
  if (tools.choice === "required") lines.push("You must call one of the client tools before you answer.");
  else if (typeof tools.choice === "object") lines.push(`You must call the client tool "${tools.choice.name}" before you answer.`);
  if (tools.parallel === false) lines.push("Call one tool at a time.");
  return lines.join("\n");
}

/** The lines of a prompt for a request with web search: the location and the allowed domains as hints (the agents cannot enforce them), and an instruction to search when the request required it. */
function searchHints(search: WebSearchRequest): string[] {
  const lines: string[] = [];
  const place = [search.location?.city, search.location?.region, search.location?.country].filter(Boolean).join(", ");
  if (place || search.location?.timezone) lines.push(`The user's approximate location: ${[place, search.location?.timezone ? `timezone ${search.location.timezone}` : ""].filter(Boolean).join("; ")}.`);
  if (search.domains?.length) lines.push(`When you search the web, prefer results from these domains: ${search.domains.join(", ")}.`);
  if (search.required) lines.push("You must search the web before you answer.");
  return lines;
}

/** One message of the prompt: `[role]` and its text, then its tool calls; a tool result is `[tool result <id>]`. A message without tool calls is exactly `[role]\n<text>`. */
function messageBlock(message: Message): string {
  const text = messageText(message);
  const lines = [message.role === "tool" ? `[tool result ${message.toolCallId ?? ""}]` : `[${message.role}]`];
  if (text !== "" || !message.toolCalls?.length) lines.push(text);
  for (const call of message.toolCalls ?? []) lines.push(`[tool call ${call.id}] ${call.name} ${call.arguments}`);
  return lines.join("\n");
}

/** One block of the prompt sent to the agent: text, or an image as base64 `data`. */
export type PromptBlock = { type: "text"; text: string } | { type: "image"; mimeType: string; data: string };

/**
 * The prompt as content blocks. The text is the preamble, a `[role]` block per message and the output format, joined by blank lines.
 * Each image follows the text of its message and ends the text block there, so a request without images is exactly one text block.
 * `generateImage` replaces the preamble with one that allows the agent's image tool; `tools` replaces it with one that allows the `client` MCP tools (and drops the provider's no-tools line); `search` replaces it with one that allows web search and nothing else on the web (also without the provider's no-tools line), or adds that to the tools preamble.
 */
export function buildPrompt(messages: Message[], instructions?: string, extraPreamble?: string, generateImage = false, tools?: ToolPrompt, search?: WebSearchRequest): PromptBlock[] {
  const blocks: PromptBlock[] = [];
  const kind = hasImages(messages) ? "an API request with text and images" : "a text-only API request";
  const plainKind = hasImages(messages) ? kind : "an API request";
  // A request that allows an image is told to use only that tool (the agent-specific no-tools line would forbid it).
  const searchPreamble = `This is ${kind} that allows web search. If the request needs current information, use your web search tool. Do not read URLs or web pages, run commands, access files, use any other tool, or ask for other permissions. Respond with the answer only, and cite the pages you used as Markdown links [title](url).`;
  let texts = [tools ? toolsPreamble(tools, search) : search ? searchPreamble : generateImage ? "This is an API request that allows one generated image. If the request asks for an image, use your image generation tool once. Do not use any other tool, run commands, access files, or ask for other permissions. Respond with a short text answer only." : `This is ${plainKind}. Do not use your own environment: no shell commands, no file access, no web access, no permission requests. If the conversation describes actions, functions or a JSON format for you to produce, produce them as text exactly as asked: the calling application executes them. Respond with the answer only.${extraPreamble ? `\n${extraPreamble}` : ""}`];
  if (search) texts[0] += `${searchHints(search).map((line) => `\n${line}`).join("")}`;
  const flush = () => { if (texts.length) blocks.push({ type: "text", text: texts.join("\n\n") }); texts = []; };
  for (const message of messages) {
    texts.push(messageBlock(message));
    for (const part of message.parts) if (part.type === "image") { flush(); blocks.push({ type: "image", mimeType: part.mimeType, data: part.data }); }
  }
  if (instructions) texts.push(`[output format]\n${instructions}`);
  flush();
  return blocks;
}

/** The prompt text alone (images left out), e.g. for token estimates. */
export function serializePrompt(messages: Message[], instructions?: string, extraPreamble?: string): string {
  return buildPrompt(messages, instructions, extraPreamble).map((block) => block.type === "text" ? block.text : "").filter(Boolean).join("\n\n");
}

function parsesAsJson(text: string): boolean {
  try { JSON.parse(text); return true; } catch { return false; }
}

/** Strips Markdown fences or prose around a JSON answer; text that holds no JSON is returned trimmed. */
export function extractJson(text: string): string {
  const trimmed = text.trim();
  const fence = /^```[A-Za-z0-9_-]*[ \t]*\r?\n?([\s\S]*?)\r?\n?[ \t]*```$/.exec(trimmed);
  const inner = (fence ? fence[1]! : trimmed).trim();
  if (parsesAsJson(inner)) return inner;
  const starts = [inner.indexOf("{"), inner.indexOf("[")].filter((index) => index >= 0);
  if (starts.length) {
    const start = Math.min(...starts);
    const end = Math.max(inner.lastIndexOf("}"), inner.lastIndexOf("]"));
    if (end > start) { const slice = inner.slice(start, end + 1); if (parsesAsJson(slice)) return slice; }
  }
  return trimmed;
}
