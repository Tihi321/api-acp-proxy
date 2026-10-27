import { AcpProvider } from "./acp-provider.js";
import type { ModelId, ProxyConfig } from "./config.js";
import type { Message } from "./api.js";
import { codexDescriptor } from "./providers/codex.js";
import { defaultRuntimeContext, type GenerateOptions, type GenerationCallbacks, type GenerationResult, type RuntimeContext } from "./provider.js";
import { createLogger } from "./logger.js";

export { AcpUnavailableError } from "./provider.js";
export type { GenerateOptions, GenerationCallbacks, GenerationResult } from "./provider.js";

/** Compatibility wrapper: a Codex-backed AcpProvider configured from ProxyConfig. */
export class AcpBridge extends AcpProvider {
  constructor(config: ProxyConfig, ctx: RuntimeContext = defaultRuntimeContext({ logger: createLogger() })) {
    super(codexDescriptor(config), ctx, { workRoot: config.workRoot });
  }
}

export interface ModelEntry { id: string; ownedBy?: string; }
export interface AcpLike {
  generate(model: ModelId, messages: Message[], callbacks?: GenerationCallbacks, signal?: AbortSignal, options?: GenerateOptions): Promise<GenerationResult>;
  close?(): Promise<void>;
  listModels?(): Promise<ModelEntry[]>;
  hasModel?(model: string): boolean;
  /** Whether the model's provider can generate images (a bridge without this method is asked and answers 400 itself). */
  canGenerateImages?(model: string): boolean;
  /** Whether the model's provider can search the web (a bridge without this method is asked and answers 400 itself). */
  canSearchWeb?(model: string): boolean;
  /** Whether the model's provider accepts image input: `undefined` until the provider has started and said so (a bridge without this method never knows). */
  acceptsImages?(model: string): boolean | undefined;
  /** Whether the model's provider can be given function tools (a bridge without this method is asked and answers 400 itself). */
  canCallTools?(model: string): boolean;
  /** Whether the model's provider can be given remote MCP servers (a bridge without this method is asked and answers 400 itself). */
  canUseMcp?(model: string): boolean;
  /** The id of the provider the model routes to (for the activity log). */
  providerOf?(model: string): string | undefined;
  /** Running and waiting requests per provider id (for /healthz). */
  queueStats?(): Record<string, { active: number; queued: number; limit: number; maxQueue: number }>;
}
