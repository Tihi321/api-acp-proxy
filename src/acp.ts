import { AcpProvider } from "./acp-provider.js";
import type { ModelId, ProxyConfig } from "./config.js";
import type { TextMessage } from "./api.js";
import { codexDescriptor } from "./providers/codex.js";
import { defaultRuntimeContext, type GenerationCallbacks, type GenerationResult, type RuntimeContext } from "./provider.js";
import { createLogger } from "./logger.js";

export { AcpUnavailableError } from "./provider.js";
export type { GenerationCallbacks, GenerationResult } from "./provider.js";

/** Compatibility wrapper: a Codex-backed AcpProvider configured from ProxyConfig. */
export class AcpBridge extends AcpProvider {
  constructor(config: ProxyConfig, ctx: RuntimeContext = defaultRuntimeContext({ logger: createLogger() })) {
    super(codexDescriptor(config), ctx, { workRoot: config.workRoot });
  }
}

export interface ModelEntry { id: string; ownedBy?: string; }
export interface AcpLike {
  generate(model: ModelId, messages: TextMessage[], callbacks?: GenerationCallbacks, signal?: AbortSignal): Promise<GenerationResult>;
  close?(): Promise<void>;
  listModels?(): Promise<ModelEntry[]>;
  hasModel?(model: string): boolean;
}
