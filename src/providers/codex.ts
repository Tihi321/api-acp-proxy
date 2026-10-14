import { createRequire } from "node:module";
import type { ProxyConfig } from "../config.js";
import { MODEL_IDS } from "../config.js";
import { AcpProvider } from "../acp-provider.js";
import type { ProviderRegistration } from "../controller.js";
import type { ProviderDescriptor } from "../provider.js";

export interface CodexOptions { authMethodId?: string; }

/** The Codex ACP agent: read-only, never prompts for approval, models are the fixed MODEL_IDS contract. */
export function codexDescriptor(config: Pick<ProxyConfig, "acpCommand" | "acpArgs">, options: CodexOptions = {}): ProviderDescriptor {
  return {
    id: "codex",
    displayName: "Codex",
    ownedBy: "openai",
    exposeUnprefixed: true,
    staticModels: MODEL_IDS,
    authMode: "eager",
    readOnlyMode: "required",
    launch(ctx) {
      const entry = ctx.resolveUnpacked(createRequire(import.meta.url).resolve("@agentclientprotocol/codex-acp/dist/index.js"));
      const custom = config.acpCommand;
      const command = custom || ctx.nodeRuntime.command;
      const args = custom ? config.acpArgs : [...ctx.nodeRuntime.argsPrefix, entry, ...config.acpArgs];
      let configuredCodex: Record<string, unknown> = {};
      try { configuredCodex = process.env.CODEX_CONFIG ? JSON.parse(process.env.CODEX_CONFIG) as Record<string, unknown> : {}; } catch { /* invalid user config is ignored in favor of safe defaults */ }
      const env = {
        ...process.env,
        ...(custom ? {} : ctx.nodeRuntime.env),
        INITIAL_AGENT_MODE: "read-only",
        CODEX_CONFIG: JSON.stringify({ ...configuredCodex, approval_policy: "never", sandbox_mode: "read-only", features: { ...(configuredCodex.features as Record<string, unknown> || {}), multi_agent: false } }),
      };
      return { command, args, env };
    },
    chooseAuth(methods, env) {
      const preferred = options.authMethodId || (env.CODEX_API_KEY || env.OPENAI_API_KEY ? "api-key" : "chat-gpt");
      return methods.some((method) => method.id === preferred) ? preferred : undefined;
    },
  };
}

/** Registration for the controller: settings.providers.codex drives auth choice and the launch overrides. */
export const codexRegistration: ProviderRegistration = {
  id: "codex",
  displayName: "Codex",
  create: ({ config, providerSettings, ctx }) => new AcpProvider(codexDescriptor(config, { authMethodId: providerSettings.authMethodId as string | undefined }), ctx, { workRoot: config.workRoot }),
};
