import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProxyConfig } from "../config.js";
import { AcpProvider } from "../acp-provider.js";
import type { ProviderRegistration } from "../controller.js";
import type { ProviderDescriptor, RuntimeContext } from "../provider.js";

export interface CodexOptions { authMethodId?: string; /** Run Codex with its own `<dataDir>/codex-home` instead of the user's ~/.codex (default true). */ isolatedHome?: boolean; }

/** The `CODEX_CONFIG` the proxy runs Codex with: the user's value first, then the safety keys on top so it cannot weaken them. The shell tools are removed (read-only `exec_command` reads ran without a permission request); web search, the image tool and MCP approvals stay as Codex has them. */
export function hardenedCodexConfig(configured: Record<string, unknown> = {}): Record<string, unknown> {
  const section = (key: string) => configured[key] && typeof configured[key] === "object" && !Array.isArray(configured[key]) ? configured[key] as Record<string, unknown> : {};
  return { ...configured, approval_policy: "never", sandbox_mode: "read-only", skills: { ...section("skills"), include_instructions: false }, features: { ...section("features"), multi_agent: false, shell_tool: false, unified_exec: false, plugins: false } };
}

/** A Codex MCP tool call: `rawInput` is `{ server, tool, arguments }`. */
function codexTarget(call: { rawInput?: unknown }, labels: readonly string[]): { server: string; tool: string; arguments?: unknown } | undefined {
  const input = call.rawInput as { server?: unknown; tool?: unknown; arguments?: unknown } | null | undefined;
  return typeof input?.server === "string" && typeof input.tool === "string" && labels.includes(input.server) ? { server: input.server, tool: input.tool, arguments: input.arguments } : undefined;
}

/** The Codex ACP agent: read-only, never prompts for approval, no shell tool, own CODEX_HOME by default. Its models come from the agent (the `model` option of session/new), as for Claude and Antigravity; they are listed unprefixed too. */
export function codexDescriptor(config: Pick<ProxyConfig, "acpCommand" | "acpArgs">, options: CodexOptions = {}): ProviderDescriptor {
  let isolatedHome: string | undefined;
  const hasKey = (env: NodeJS.ProcessEnv) => Boolean(env.CODEX_API_KEY || env.OPENAI_API_KEY);
  /** A fresh isolated home with no API key: `authenticate chat-gpt` would open the browser on its own at every start, so it only runs from the Log in button. The file is only checked for existence, never read. */
  const firstLogin = (env: NodeJS.ProcessEnv) => isolatedHome !== undefined && !hasKey(env) && !existsSync(path.join(isolatedHome, "auth.json"));
  /** `<dataDir>/codex-home` when the proxy runs Codex in its own home (the setting), whether or not the agent was launched yet. */
  const ownHome = (ctx: RuntimeContext): string | undefined => options.isolatedHome !== false ? path.join(ctx.dataDir, "codex-home") : undefined;
  /** The only file the proxy ever deletes for a log-out, and only in its own home: the login Codex keeps there. */
  const removeAuthFile = async (ctx: RuntimeContext): Promise<void> => { const home = ownHome(ctx); if (home) await fsp.rm(path.join(home, "auth.json"), { force: true }); };
  return {
    id: "codex",
    displayName: "Codex",
    ownedBy: "openai",
    exposeUnprefixed: true,
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
    // Its web search is always on (per process, no permission request): nothing to enable or allow; a request without search cannot turn it off. A search is a `tool_call` of kind "search" whose final update carries the query.
    webSearch: {
      search: (call) => {
        if (call.kind !== "search") return undefined;
        const input = call.rawInput as { query?: unknown; action?: { query?: unknown } | null } | null | undefined;
        const query = [input?.action?.query, input?.query, call.title?.replace(/^Web search:\s*/, "")].find((candidate) => typeof candidate === "string" && candidate !== "" && candidate !== "Web search");
        return { query: typeof query === "string" ? query : "" };
      },
    },
    // Its MCP approval request names only the tool call id and `is_mcp_tool_approval`: the server and tool come from the `tool_call` with that id (`rawInput.server` / `.tool`). Codex gives up on a call after 300 s (fixed).
    allowTool: (permission, tracked, mcp) => {
      const target = tracked ? codexTarget(tracked, mcp.labels) : undefined;
      return (permission._meta as { is_mcp_tool_approval?: unknown } | null | undefined)?.is_mcp_tool_approval === true && target !== undefined && mcp.allows(target.server, target.tool);
    },
    mcpTarget: codexTarget,
    toolCallLimitMs: 300_000,
    // Status without a request: an own home with no auth.json and no API key is "needs login" (nothing is started, nothing is opened or read).
    needsLogin: (ctx, env) => {
      const home = ownHome(ctx);
      return home !== undefined && (options.authMethodId || "chat-gpt") === "chat-gpt" && !hasKey(env) && !existsSync(path.join(home, "auth.json")) ? "Log in to Codex for the proxy: its own Codex home has no login yet." : undefined;
    },
    loginHome: (ctx, env) => { const home = ownHome(ctx); return home !== undefined ? { path: home, shared: false } : { path: env.CODEX_HOME || path.join(os.homedir(), ".codex"), shared: true }; },
    // Codex advertises ACP `logout` (account/logout); in the own home the login file is removed afterwards in any case, and by hand when the agent does not advertise it. The user's ~/.codex is only ever logged out through the agent (no fallback there).
    ...(options.isolatedHome !== false ? { logoutFallback: removeAuthFile } : {}),
    afterLogout: removeAuthFile,
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
