import { z } from "zod";
import { MODEL_IDS, type ModelId } from "./config.js";

const textPartSchema = z.object({ type: z.literal("text"), text: z.string() }).strict();
const messageContentSchema = z.union([z.string(), z.array(textPartSchema).min(1)]);
const chatMessageSchema = z.object({
  role: z.enum(["system", "developer", "user", "assistant"]),
  content: messageContentSchema,
}).strict();

const unsupportedChatFields = ["tools", "tool_choice", "functions", "function_call", "response_format", "audio", "modalities", "logprobs", "top_logprobs", "prediction", "service_tier", "n", "temperature", "top_p", "stop", "presence_penalty", "frequency_penalty", "seed", "logit_bias", "max_tokens", "max_completion_tokens", "stream_options"] as const;
const unsupportedResponseFields = ["tools", "tool_choice", "temperature", "top_p", "parallel_tool_calls", "truncation", "reasoning", "text", "include", "background", "max_output_tokens", "stream_options"] as const;

export const chatRequestSchema = z.object({
  model: z.string(),
  messages: z.array(chatMessageSchema).min(1),
  stream: z.boolean().optional().default(false),
  max_tokens: z.number().int().positive().optional(),
  max_completion_tokens: z.number().int().positive().optional(),
  user: z.string().optional(),
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
}).passthrough();

export type ChatRequest = z.infer<typeof chatRequestSchema>;
export type ResponsesRequest = z.infer<typeof responsesRequestSchema>;
export type TextMessage = { role: "system" | "developer" | "user" | "assistant"; content: string };

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

export function validateModel(model: string): asserts model is (typeof MODEL_IDS)[number] {
  if (!(MODEL_IDS as readonly string[]).includes(model)) throw new ApiError(404, "model_not_found", `The model '${model}' does not exist.`, "model");
}

function rejectUnsupported(obj: Record<string, unknown>, fields: readonly string[]): void {
  for (const field of fields) if (obj[field] !== undefined && obj[field] !== false && obj[field] !== null) throw new ApiError(400, "unsupported_parameter", `Parameter '${field}' is not supported by this proxy.`, field);
}

export function normalizeChat(raw: unknown): Omit<ChatRequest, "model"> & { model: ModelId; textMessages: TextMessage[] } {
  const parsed = chatRequestSchema.safeParse(raw);
  if (!parsed.success) throw new ApiError(400, "invalid_request", parsed.error.issues[0]?.message || "Invalid request.");
  rejectUnsupported(parsed.data, unsupportedChatFields);
  if (parsed.data.max_tokens !== undefined && parsed.data.max_completion_tokens !== undefined) throw new ApiError(400, "invalid_request", "Only one of max_tokens and max_completion_tokens may be provided.");
  validateModel(parsed.data.model);
  return { ...parsed.data, model: parsed.data.model as ModelId, textMessages: parsed.data.messages.map((message) => ({ role: message.role, content: asText(message.content) })) };
}

export function normalizeResponses(raw: unknown): Omit<ResponsesRequest, "model"> & { model: ModelId; textMessages: TextMessage[] } {
  const parsed = responsesRequestSchema.safeParse(raw);
  if (!parsed.success) throw new ApiError(400, "invalid_request", parsed.error.issues[0]?.message || "Invalid request.");
  rejectUnsupported(parsed.data, unsupportedResponseFields);
  if (parsed.data.store === true) throw new ApiError(400, "unsupported_parameter", "Stored responses are not supported.", "store");
  if (parsed.data.previous_response_id !== undefined) throw new ApiError(400, "unsupported_parameter", "Persistent conversations are not supported.", "previous_response_id");
  validateModel(parsed.data.model);
  const textMessages: TextMessage[] = [];
  if (parsed.data.instructions) textMessages.push({ role: "system", content: parsed.data.instructions });
  if (typeof parsed.data.input === "string") textMessages.push({ role: "user", content: parsed.data.input });
  else textMessages.push(...parsed.data.input.map((message) => ({ role: message.role, content: asText(message.content) })));
  return { ...parsed.data, model: parsed.data.model as ModelId, textMessages };
}

export function serializePrompt(messages: TextMessage[]): string {
  const preamble = "This is a text-only API request. Do not use tools, run commands, access files, or ask for permissions. Respond with the answer only.";
  return `${preamble}\n\n${messages.map((message) => `[${message.role}]\n${message.content}`).join("\n\n")}`;
}
