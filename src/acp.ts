import { AcpProvider } from "./acp-provider.js";
import type { ModelId, ProxyConfig } from "./config.js";
import type { Message } from "./api.js";
import { codexDescriptor } from "./providers/codex.js";
import { defaultRuntimeContext, type EmbeddingResult, type GenerateOptions, type GenerationCallbacks, type GenerationResult, type ImagePassthrough, type RuntimeContext } from "./provider.js";
import { createLogger } from "./logger.js";

export { AcpUnavailableError } from "./provider.js";
export type { GenerateOptions, GenerationCallbacks, GenerationResult, ImagePassthrough } from "./provider.js";

/** Compatibility wrapper: a Codex-backed AcpProvider configured from ProxyConfig. */
export class AcpBridge extends AcpProvider {
  constructor(config: ProxyConfig, ctx: RuntimeContext = defaultRuntimeContext({ logger: createLogger() })) {
    super(codexDescriptor(config), ctx, { workRoot: config.workRoot });
  }
}

export interface ModelEntry { id: string; ownedBy?: string; /** Limit on the prompt text in characters, when the provider has one. */ maxPromptChars?: number; /** ISO time the provider's usage limit resets; present only while it is exhausted. */ exhaustedUntil?: string; /** Gufo profile models: what the model is and whether it accepts image input. */ kind?: "llm" | "image" | "embedding"; vision?: boolean; }
export interface AcpLike {
  generate(model: ModelId, messages: Message[], callbacks?: GenerationCallbacks, signal?: AbortSignal, options?: GenerateOptions): Promise<GenerationResult>;
  close?(): Promise<void>;
  listModels?(): Promise<ModelEntry[]>;
  hasModel?(model: string): boolean;
  /** Whether the model's provider can generate images (a bridge without this method is asked and answers 400 itself). */
  canGenerateImages?(model: string): boolean;
  /** Throws a 400 `context_length_exceeded` before anything starts when the prompt is over the model's provider limit. */
  checkPrompt?(model: string, messages: Message[], options?: GenerateOptions): void;
  /** Whether the model's provider can search the web (a bridge without this method is asked and answers 400 itself). */
  canSearchWeb?(model: string): boolean;
  /** Whether the model's provider accepts image input: `undefined` until the provider has started and said so (a bridge without this method never knows). */
  acceptsImages?(model: string): boolean | undefined;
  /** Whether the model's provider can be given function tools (a bridge without this method is asked and answers 400 itself). */
  canCallTools?(model: string): boolean;
  /** Whether the model's provider can be given remote MCP servers (a bridge without this method is asked and answers 400 itself). */
  canUseMcp?(model: string): boolean;
  /** Before the request timer starts: switches/queues to a local model (rejects with ApiError 400/503); `messages` is undefined for an image request. The lease is released when the request ends. */
  prepareModel?(model: string, messages: Message[] | undefined, signal: AbortSignal): Promise<{ release(): void } | undefined>;
  /** The request timeout of the model (undefined: the server default). */
  requestTimeoutMs?(model: string): number | undefined;
  /** Whether image requests for the model are forwarded to an image server (Gufo) instead of going through an agent. */
  imagePassthrough?(model: string): boolean;
  generateImage?(model: string, request: ImagePassthrough, signal: AbortSignal): Promise<{ status: number; body: unknown }>;
  /** Whether the model is an embedding model (a bridge without this method has none: the route answers 400 `model_not_capable`). */
  canEmbed?(model: string): boolean;
  embed?(model: string, input: string[], signal: AbortSignal): Promise<EmbeddingResult>;
  /** The id of the provider the model routes to (for the activity log). */
  providerOf?(model: string): string | undefined;
  /** Running and waiting requests per provider id (for /healthz). */
  queueStats?(): Record<string, { active: number; queued: number; limit: number; maxQueue: number }>;
  /** How each provider that knows it authenticates (for /healthz). */
  authMethods?(): Record<string, string>;
  /** Providers whose usage limit is used up: id -> ISO time they are refused until (for /healthz). */
  exhaustedProviders?(): Record<string, string>;
}
