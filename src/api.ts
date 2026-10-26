import { z } from "zod";
import { MODEL_IDS } from "./config.js";
import { ImageError, loadImage } from "./images.js";

// Content parts are checked one by one in `convertContent`, so an unknown part type answers `unsupported_content` instead of a schema error.
const messageContentSchema = z.union([z.string(), z.array(z.object({ type: z.string() }).passthrough()).min(1)]);
const chatMessageSchema = z.object({
  role: z.enum(["system", "developer", "user", "assistant"]),
  content: messageContentSchema,
}).strict();
const textPartSchema = z.object({ text: z.string() });
const chatImagePartSchema = z.object({ image_url: z.object({ url: z.string().min(1), detail: z.string().nullish() }).passthrough() });
const responsesImagePartSchema = z.object({ image_url: z.string().min(1), detail: z.string().nullish() });

const unsupportedChatFields = ["tools", "tool_choice", "functions", "function_call", "audio", "modalities", "logprobs", "top_logprobs", "prediction", "service_tier", "n", "temperature", "top_p", "stop", "presence_penalty", "frequency_penalty", "seed", "logit_bias"] as const;
const unsupportedResponseFields = ["tools", "tool_choice", "temperature", "top_p", "parallel_tool_calls", "truncation", "reasoning", "include", "background", "stream_options"] as const;

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

const responseMessageSchema = z.object({
  role: z.enum(["system", "developer", "user", "assistant"]),
  content: messageContentSchema,
}).strict();

export const responsesRequestSchema = z.object({
  model: z.string(),
  input: z.union([z.string(), z.array(responseMessageSchema).min(1)]),
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
/** A piece of a message; images are always base64 `data` (never a URI) because the agents reject or hang on a `uri`. */
export type Part = { type: "text"; text: string } | { type: "image"; mimeType: string; data: string };
export type Message = { role: Role; parts: Part[] };
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
  if (error instanceof ApiError) return { error: { message: error.message, type: "invalid_request_error", param: error.param ?? null, code: error.code } };
  return { error: { message: error.message || "Internal server error", type: "server_error", param: null, code: "internal_error" } };
}

export function asText(content: string | Array<{ type: string; text?: string }>): string {
  return typeof content === "string" ? content : content.map((part) => part.text ?? "").join("");
}

export type ModelCheck = (model: string) => boolean;
const defaultIsKnownModel: ModelCheck = (model) => (MODEL_IDS as readonly string[]).includes(model);

export function validateModel(model: string, isKnownModel: ModelCheck = defaultIsKnownModel): void {
  if (!isKnownModel(model)) throw new ApiError(404, "model_not_found", `The model '${model}' does not exist.`, "model");
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

type NormalizedRequest = { model: string; conversation: Message[]; format: OutputFormat; maxOutputTokens?: number };

function unsupportedContent(message: string, param: string): ApiError { return new ApiError(400, "unsupported_content", message, param); }

/** Turns message content into parts: text stays text, an image URL is decoded or downloaded to base64 (user messages only). Anything else is `unsupported_content`. */
async function convertContent(content: z.infer<typeof messageContentSchema>, role: Role, api: "chat" | "responses", param: string, options: NormalizeOptions): Promise<Part[]> {
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

export async function normalizeChat(raw: unknown, isKnownModel?: ModelCheck, options: NormalizeOptions = {}): Promise<Omit<ChatRequest, "model"> & NormalizedRequest> {
  const parsed = chatRequestSchema.safeParse(withoutFields(raw, ignorableChatFields, options.ignoreSampling));
  if (!parsed.success) throw new ApiError(400, "invalid_request", parsed.error.issues[0]?.message || "Invalid request.", issueParam(parsed.error.issues[0]));
  rejectUnsupported(parsed.data, unsupportedChatFields);
  if (parsed.data.max_tokens !== undefined && parsed.data.max_completion_tokens !== undefined) throw new ApiError(400, "invalid_request", "Only one of max_tokens and max_completion_tokens may be provided.");
  validateModel(parsed.data.model, isKnownModel);
  const rf = parsed.data.response_format;
  const format = !rf || rf.type === "text" ? textFormat : jsonFormat(rf.type === "json_object" ? rf : { type: "json_schema", ...rf.json_schema });
  const maxOutputTokens = parsed.data.max_completion_tokens ?? parsed.data.max_tokens;
  const conversation = await Promise.all(parsed.data.messages.map(async (message): Promise<Message> => ({ role: message.role, parts: await convertContent(message.content, message.role, "chat", "messages", options) })));
  return { ...parsed.data, model: parsed.data.model, conversation, format, ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}) };
}

export async function normalizeResponses(raw: unknown, isKnownModel?: ModelCheck, options: NormalizeOptions = {}): Promise<Omit<ResponsesRequest, "model"> & NormalizedRequest> {
  const parsed = responsesRequestSchema.safeParse(withoutFields(raw, ignorableResponseFields, options.ignoreSampling));
  if (!parsed.success) throw new ApiError(400, "invalid_request", parsed.error.issues[0]?.message || "Invalid request.", issueParam(parsed.error.issues[0]));
  rejectUnsupported(parsed.data, unsupportedResponseFields);
  if (parsed.data.store === true) throw new ApiError(400, "unsupported_parameter", "Stored responses are not supported.", "store");
  if (parsed.data.previous_response_id !== undefined) throw new ApiError(400, "unsupported_parameter", "Persistent conversations are not supported.", "previous_response_id");
  validateModel(parsed.data.model, isKnownModel);
  const conversation: Message[] = [];
  if (parsed.data.instructions) conversation.push(textMessage("system", parsed.data.instructions));
  if (typeof parsed.data.input === "string") conversation.push(textMessage("user", parsed.data.input));
  else conversation.push(...await Promise.all(parsed.data.input.map(async (message): Promise<Message> => ({ role: message.role, parts: await convertContent(message.content, message.role, "responses", "input", options) }))));
  const tf = parsed.data.text?.format;
  return { ...parsed.data, model: parsed.data.model, conversation, format: !tf || tf.type === "text" ? textFormat : jsonFormat(tf), ...(parsed.data.max_output_tokens !== undefined ? { maxOutputTokens: parsed.data.max_output_tokens } : {}) };
}

export function formatInstructions(format: OutputFormat): string | undefined {
  if (format.type === "text") return undefined;
  const base = "Respond with a single valid JSON value only: no prose, no explanations, no Markdown code fences.";
  if (format.schema === undefined) return base;
  return `${base} It must conform to this JSON Schema${format.name ? ` (${format.name})` : ""}${format.description ? `: ${format.description}` : ""}\n${JSON.stringify(format.schema)}`;
}

/** One block of the prompt sent to the agent: text, or an image as base64 `data`. */
export type PromptBlock = { type: "text"; text: string } | { type: "image"; mimeType: string; data: string };

/**
 * The prompt as content blocks. The text is the preamble, a `[role]` block per message and the output format, joined by blank lines.
 * Each image follows the text of its message and ends the text block there, so a request without images is exactly one text block.
 */
export function buildPrompt(messages: Message[], instructions?: string, extraPreamble?: string): PromptBlock[] {
  const blocks: PromptBlock[] = [];
  const kind = hasImages(messages) ? "an API request with text and images" : "a text-only API request";
  let texts = [`This is ${kind}. Do not use tools, run commands, access files, or ask for permissions. Respond with the answer only.${extraPreamble ? `\n${extraPreamble}` : ""}`];
  const flush = () => { if (texts.length) blocks.push({ type: "text", text: texts.join("\n\n") }); texts = []; };
  for (const message of messages) {
    texts.push(`[${message.role}]\n${messageText(message)}`);
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
