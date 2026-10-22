import { z } from "zod";
import { MODEL_IDS } from "./config.js";

const textPartSchema = z.object({ type: z.literal("text"), text: z.string() }).strict();
const messageContentSchema = z.union([z.string(), z.array(textPartSchema).min(1)]);
const chatMessageSchema = z.object({
  role: z.enum(["system", "developer", "user", "assistant"]),
  content: messageContentSchema,
}).strict();

const unsupportedChatFields = ["tools", "tool_choice", "functions", "function_call", "audio", "modalities", "logprobs", "top_logprobs", "prediction", "service_tier", "n", "temperature", "top_p", "stop", "presence_penalty", "frequency_penalty", "seed", "logit_bias", "max_tokens", "max_completion_tokens", "stream_options"] as const;
const unsupportedResponseFields = ["tools", "tool_choice", "temperature", "top_p", "parallel_tool_calls", "truncation", "reasoning", "include", "background", "max_output_tokens", "stream_options"] as const;

// Fields that only tune sampling or length. The agents behind the proxy cannot honour them, so by default they are
// rejected; with `ignoreSampling` they are dropped instead, for clients that send them on every request.
const ignorableChatFields = ["temperature", "top_p", "presence_penalty", "frequency_penalty", "seed", "max_tokens", "max_completion_tokens", "stream_options"] as const;
const ignorableResponseFields = ["temperature", "top_p", "max_output_tokens", "stream_options"] as const;
export interface NormalizeOptions { ignoreSampling?: boolean }

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
export type TextMessage = { role: "system" | "developer" | "user" | "assistant"; content: string };

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

export function asText(content: string | Array<{ type: "text"; text: string }>): string {
  return typeof content === "string" ? content : content.map((part) => part.text).join("");
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

export function normalizeChat(raw: unknown, isKnownModel?: ModelCheck, options: NormalizeOptions = {}): Omit<ChatRequest, "model"> & { model: string; textMessages: TextMessage[]; format: OutputFormat } {
  const parsed = chatRequestSchema.safeParse(withoutFields(raw, ignorableChatFields, options.ignoreSampling));
  if (!parsed.success) throw new ApiError(400, "invalid_request", parsed.error.issues[0]?.message || "Invalid request.", issueParam(parsed.error.issues[0]));
  rejectUnsupported(parsed.data, unsupportedChatFields);
  if (parsed.data.max_tokens !== undefined && parsed.data.max_completion_tokens !== undefined) throw new ApiError(400, "invalid_request", "Only one of max_tokens and max_completion_tokens may be provided.");
  validateModel(parsed.data.model, isKnownModel);
  const rf = parsed.data.response_format;
  const format = !rf || rf.type === "text" ? textFormat : jsonFormat(rf.type === "json_object" ? rf : { type: "json_schema", ...rf.json_schema });
  return { ...parsed.data, model: parsed.data.model, textMessages: parsed.data.messages.map((message) => ({ role: message.role, content: asText(message.content) })), format };
}

export function normalizeResponses(raw: unknown, isKnownModel?: ModelCheck, options: NormalizeOptions = {}): Omit<ResponsesRequest, "model"> & { model: string; textMessages: TextMessage[]; format: OutputFormat } {
  const parsed = responsesRequestSchema.safeParse(withoutFields(raw, ignorableResponseFields, options.ignoreSampling));
  if (!parsed.success) throw new ApiError(400, "invalid_request", parsed.error.issues[0]?.message || "Invalid request.", issueParam(parsed.error.issues[0]));
  rejectUnsupported(parsed.data, unsupportedResponseFields);
  if (parsed.data.store === true) throw new ApiError(400, "unsupported_parameter", "Stored responses are not supported.", "store");
  if (parsed.data.previous_response_id !== undefined) throw new ApiError(400, "unsupported_parameter", "Persistent conversations are not supported.", "previous_response_id");
  validateModel(parsed.data.model, isKnownModel);
  const textMessages: TextMessage[] = [];
  if (parsed.data.instructions) textMessages.push({ role: "system", content: parsed.data.instructions });
  if (typeof parsed.data.input === "string") textMessages.push({ role: "user", content: parsed.data.input });
  else textMessages.push(...parsed.data.input.map((message) => ({ role: message.role, content: asText(message.content) })));
  const tf = parsed.data.text?.format;
  return { ...parsed.data, model: parsed.data.model, textMessages, format: !tf || tf.type === "text" ? textFormat : jsonFormat(tf) };
}

export function formatInstructions(format: OutputFormat): string | undefined {
  if (format.type === "text") return undefined;
  const base = "Respond with a single valid JSON value only: no prose, no explanations, no Markdown code fences.";
  if (format.schema === undefined) return base;
  return `${base} It must conform to this JSON Schema${format.name ? ` (${format.name})` : ""}${format.description ? `: ${format.description}` : ""}\n${JSON.stringify(format.schema)}`;
}

export function serializePrompt(messages: TextMessage[], instructions?: string): string {
  const preamble = "This is a text-only API request. Do not use tools, run commands, access files, or ask for permissions. Respond with the answer only.";
  const blocks = messages.map((message) => `[${message.role}]\n${message.content}`);
  if (instructions) blocks.push(`[output format]\n${instructions}`);
  return `${preamble}\n\n${blocks.join("\n\n")}`;
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
