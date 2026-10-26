import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProxyConfig } from "../config.js";
import { MODEL_IDS } from "../config.js";
import { AcpProvider } from "../acp-provider.js";
import type { ProviderRegistration } from "../controller.js";
import type { ProviderDescriptor } from "../provider.js";
import { BRIDGE_SERVER_NAME } from "../tool-bridge.js";

export interface CodexOptions { authMethodId?: string; /** Run Codex with its own `<dataDir>/codex-home` instead of the user's ~/.codex (default true). */ isolatedHome?: boolean; }

/** The `CODEX_CONFIG` the proxy runs Codex with: the user's value first, then the safety keys on top so it cannot weaken them. The shell tools are removed (read-only `exec_command` reads ran without a permission request); web search, the image tool and MCP approvals stay as Codex has them. */
export function hardenedCodexConfig(configured: Record<string, unknown> = {}): Record<string, unknown> {
  const section = (key: string) => configured[key] && typeof configured[key] === "object" && !Array.isArray(configured[key]) ? configured[key] as Record<string, unknown> : {};
  return { ...configured, approval_policy: "never", sandbox_mode: "read-only", skills: { ...section("skills"), include_instructions: false }, features: { ...section("features"), multi_agent: false, shell_tool: false, unified_exec: false, plugins: false } };
}

/** The Codex ACP agent: read-only, never prompts for approval, no shell tool, own CODEX_HOME by default, models are the fixed MODEL_IDS contract. */
export function codexDescriptor(config: Pick<ProxyConfig, "acpCommand" | "acpArgs">, options: CodexOptions = {}): ProviderDescriptor {
  let isolatedHome: string | undefined;
  const hasKey = (env: NodeJS.ProcessEnv) => Boolean(env.CODEX_API_KEY || env.OPENAI_API_KEY);
  /** A fresh isolated home with no API key: `authenticate chat-gpt` would open the browser on its own at every start, so it only runs from the Log in button. The file is only checked for existence, never read. */
  const firstLogin = (env: NodeJS.ProcessEnv) => isolatedHome !== undefined && !hasKey(env) && !existsSync(path.join(isolatedHome, "auth.json"));
  return {
    id: "codex",
    displayName: "Codex",
    ownedBy: "openai",
    exposeUnprefixed: true,
    staticModels: MODEL_IDS,
    authMode: "eager",
    readOnlyMode: "required",
    async launch(ctx) {
      const entry = ctx.resolveUnpacked(createRequire(import.meta.url).resolve("@agentclientprotocol/codex-acp/dist/index.js"));
      const custom = config.acpCommand;
      const command = custom || ctx.nodeRuntime.command;
      const args = custom ? config.acpArgs : [...ctx.nodeRuntime.argsPrefix, entry, ...config.acpArgs];
      let configuredCodex: Record<string, unknown> = {};
      try { configuredCodex = process.env.CODEX_CONFIG ? JSON.parse(process.env.CODEX_CONFIG) as Record<string, unknown> : {}; } catch { /* invalid user config is ignored in favor of safe defaults */ }
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        ...(custom ? {} : ctx.nodeRuntime.env),
        INITIAL_AGENT_MODE: "read-only",
        CODEX_CONFIG: JSON.stringify(hardenedCodexConfig(configuredCodex)),
      };
      if (options.isolatedHome !== false) { env.CODEX_HOME = isolatedHome = path.join(ctx.dataDir, "codex-home"); await fsp.mkdir(env.CODEX_HOME, { recursive: true }); } else isolatedHome = undefined;
      return { command, args, env };
    },
    // Its image tool asks no permission (it cannot be gated); the file lands in <CODEX_HOME>/generated_images/<threadId>/.
    imageGeneration: { imageFolder: (ctx) => path.join(options.isolatedHome !== false ? path.join(ctx.dataDir, "codex-home") : process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "generated_images"), pruneEmptyParent: true },
    // Its MCP approval request names only the tool call id and `is_mcp_tool_approval`: the server comes from the `tool_call` with that id. Codex gives up on a call after 300 s (fixed).
    allowTool: (permission, tracked) => (permission._meta as { is_mcp_tool_approval?: unknown } | null | undefined)?.is_mcp_tool_approval === true && (tracked?.rawInput as { server?: unknown } | null | undefined)?.server === BRIDGE_SERVER_NAME,
    toolCallLimitMs: 300_000,
    loginRequired: (methods, env) => (options.authMethodId || "chat-gpt") === "chat-gpt" && methods.some((method) => method.id === "chat-gpt") && firstLogin(env) ? "Log in to Codex for the proxy: its own Codex home has no login yet." : undefined,
    defaultLoginMethod: options.authMethodId || "chat-gpt",
    chooseAuth(methods, env) {
      const preferred = options.authMethodId || (hasKey(env) ? "api-key" : "chat-gpt");
      if (preferred === "chat-gpt" && firstLogin(env)) return undefined;
      return methods.some((method) => method.id === preferred) ? preferred : undefined;
    },
  };
}

/** Registration for the controller: settings.providers.codex drives auth choice, the isolated home and the launch overrides. */
export const codexRegistration: ProviderRegistration = {
  id: "codex",
  displayName: "Codex",
  create: ({ config, providerSettings, ctx }) => new AcpProvider(codexDescriptor(config, { authMethodId: providerSettings.authMethodId as string | undefined, isolatedHome: providerSettings.isolatedHome !== false }), ctx, { workRoot: config.workRoot, reuseSessions: config.reuseSessions, toolResultTimeoutMs: config.toolResultTimeoutMs }),
};
