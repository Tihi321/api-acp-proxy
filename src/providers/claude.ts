import { createRequire } from "node:module";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AcpProvider } from "../acp-provider.js";
import type { ProviderRegistration } from "../controller.js";
import { AcpUnavailableError } from "../provider.js";
import type { AuthMethodInfo, ProviderDescriptor, RuntimeContext } from "../provider.js";

/** `settings.providers.claude`. */
export interface ClaudeSettings { apiKey?: string; oauthToken?: string; configDir?: string; executablePath?: string; authMethodId?: string; termsAcknowledgedAt?: string; }

/** `Retry-After` of the 503 sent while another Claude Code process holds the OAuth refresh lock (it cleared after about a minute in the spike). */
const BUSY_RETRY_SECONDS = 30;
const truthy = (value: string | undefined): boolean => value !== undefined && ["1", "true", "yes", "on"].includes(value.toLowerCase());
const LOGIN_FLAGS: Record<string, string> = { "claude-ai-login": "--claudeai", "console-login": "--console" };
const LOGIN_METHODS: AuthMethodInfo[] = [{ id: "claude-ai-login", name: "Claude subscription" }, { id: "console-login", name: "Anthropic Console (API billing)" }];

function adapterEntry(ctx: RuntimeContext): string { return ctx.resolveUnpacked(createRequire(import.meta.url).resolve("@agentclientprotocol/claude-agent-acp/dist/index.js")); }

/** Environment for the adapter and its bundled claude CLI: settings become credentials; nested-session guards are removed so it also starts from inside Claude Code. */
function claudeEnv(ctx: RuntimeContext, settings: ClaudeSettings, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = { ...env, ...ctx.nodeRuntime.env };
  if (settings.apiKey) childEnv.ANTHROPIC_API_KEY = settings.apiKey;
  if (settings.oauthToken) childEnv.CLAUDE_CODE_OAUTH_TOKEN = settings.oauthToken;
  if (settings.configDir) childEnv.CLAUDE_CONFIG_DIR = settings.configDir;
  if (settings.executablePath) childEnv.CLAUDE_CODE_EXECUTABLE = settings.executablePath;
  // A tool call held for the client's result must not hit the CLI's 300 s silence limit (the proxy answers its calls as SSE, which also avoids the 60 s limit of a JSON reply).
  childEnv.CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT = "0";
  delete childEnv.CLAUDECODE;
  delete childEnv.CLAUDE_CODE_ENTRYPOINT;
  delete childEnv.NODE_OPTIONS;
  return childEnv;
}

/** The native claude CLI: the executablePath setting, else the platform package of the Agent SDK as the adapter finds it. Undefined when it cannot be resolved. */
export function resolveClaudeBinary(ctx: RuntimeContext, settings: ClaudeSettings): string | undefined {
  if (settings.executablePath) return settings.executablePath;
  try {
    const requireFromAdapter = createRequire(adapterEntry(ctx));
    const requireFromSdk = createRequire(requireFromAdapter.resolve("@anthropic-ai/claude-agent-sdk"));
    const pkg = requireFromSdk.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`);
    const binary = path.join(path.dirname(pkg), process.platform === "win32" ? "claude.exe" : "claude");
    return existsSync(binary) ? ctx.resolveUnpacked(binary) : undefined;
  } catch { return undefined; }
}

/** Runs `claude auth <authArgs>` and resolves when it exits successfully: in a visible console window for a login (`visible`), hidden for a non-interactive command (logout). The console-subsystem claude binary is started directly (the packaged app exe is a GUI program and would give it no console); falls back to the adapter's --cli. */
function consoleAuth(ctx: RuntimeContext, settings: ClaudeSettings, env: NodeJS.ProcessEnv, authArgs: string[], visible: boolean): Promise<void> {
  const binary = resolveClaudeBinary(ctx, settings);
  const childEnv = claudeEnv(ctx, settings, env);
  const [program, args] = binary ? [binary, ["auth", ...authArgs]] : [ctx.nodeRuntime.command, [adapterEntry(ctx), "--cli", "auth", ...authArgs]];
  if (binary) delete childEnv.ELECTRON_RUN_AS_NODE;
  const what = authArgs[0] === "logout" ? "logout" : "login";
  if (process.platform !== "win32") return Promise.reject(new AcpUnavailableError(`Run this in a terminal, then retry: "${program}" ${args.map((arg) => /\s/.test(arg) ? `"${arg}"` : arg).join(" ")}`));
  const done = (child: ChildProcess) => new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`The Claude ${what} exited with code ${code ?? "unknown"}.`)));
  });
  if (!visible) return done(spawn(program, args, { env: childEnv, stdio: "ignore", windowsHide: true }));
  // cmd /s strips the first and last quote of the command string, so the whole line is wrapped in one extra pair; arguments are passed verbatim.
  const line = `"start "Claude ${what}" /wait "${program}" ${args.map((arg) => `"${arg}"`).join(" ")}"`;
  return done(spawn("cmd.exe", ["/d", "/s", "/c", line], { env: childEnv, stdio: "ignore", windowsVerbatimArguments: true, windowsHide: false }));
}

/** `claude auth login --claudeai|--console` in a console window. */
function consoleLogin(ctx: RuntimeContext, settings: ClaudeSettings, env: NodeJS.ProcessEnv, methodId: string): Promise<void> {
  const flag = LOGIN_FLAGS[methodId];
  return flag ? consoleAuth(ctx, settings, env, ["login", flag], true) : Promise.reject(new AcpUnavailableError(`Unknown Claude login method '${methodId}'.`));
}

/** Even with persistSession off the CLI leaves an empty `<config>/projects/<cwd>/memory` directory per session; remove it (never a directory holding anything else). */
async function removeProjectLeftovers(settings: ClaudeSettings, env: NodeJS.ProcessEnv, cwd: string): Promise<void> {
  const dir = path.join(settings.configDir || env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  await fsp.rmdir(path.join(dir, "memory")).catch(() => undefined);
  await fsp.rmdir(dir).catch(() => undefined);
}

/** The tool name of a Claude `tool_call` / permission request (`_meta.claudeCode.toolName`, else the `name` of a permission's tool call). */
function claudeToolName(call: { _meta?: Record<string, unknown> | null; name?: unknown }): string | undefined {
  const name = (call._meta as { claudeCode?: { toolName?: unknown } } | null | undefined)?.claudeCode?.toolName ?? call.name;
  return typeof name === "string" ? name : undefined;
}

/** The pages a WebSearch reported: `_meta.claudeCode.toolResponse.results` holds `{ content: [{ title, url }] }` objects (next to the answer text of the tool). */
function searchSources(call: { _meta?: Record<string, unknown> | null }): Array<{ title?: string; url: string }> {
  const results = (call._meta as { claudeCode?: { toolResponse?: { results?: unknown } } } | null | undefined)?.claudeCode?.toolResponse?.results;
  const found = new Map<string, { title?: string; url: string }>();
  for (const result of Array.isArray(results) ? results : []) {
    const content = result && typeof result === "object" ? (result as { content?: unknown }).content : undefined;
    for (const page of Array.isArray(content) ? content : []) {
      const { title, url } = (page ?? {}) as { title?: unknown; url?: unknown };
      if (typeof url === "string" && url && !found.has(url)) found.set(url, { ...(typeof title === "string" && title ? { title } : {}), url });
    }
  }
  return [...found.values()];
}

/** The Claude Agent ACP adapter: text-only (built-in tools off, nothing persisted), credentials from ~/.claude, an API key or an OAuth token. */
export function claudeDescriptor(settings: ClaudeSettings, env: NodeJS.ProcessEnv = process.env, overrides: Partial<ProviderDescriptor> = {}): ProviderDescriptor {
  const descriptor: ProviderDescriptor = {
    id: "claude",
    displayName: "Claude",
    ownedBy: "anthropic",
    exposeUnprefixed: false,
    authMode: "on-demand",
    chooseAuth: () => undefined,
    readOnlyMode: "required",
    modeCandidates: ["default"],
    sessionTimeoutMs: 120_000,
    warmSessions: 1,
    usageScope: "session",
    stderrLogLevel: "debug",
    sessionMeta: { disableBuiltInTools: true, claudeCode: { options: { tools: [], persistSession: false, settingSources: [] } } },
    loginMethods: LOGIN_METHODS,
    preflight() {
      if (!settings.termsAcknowledgedAt && !truthy(env.PROXY_CLAUDE_ACCEPT_TERMS)) return { state: "terms_required", message: "Acknowledge the Claude terms before enabling this provider." };
      return undefined;
    },
    launch(ctx) {
      return { command: ctx.nodeRuntime.command, args: [...ctx.nodeRuntime.argsPrefix, adapterEntry(ctx)], env: claudeEnv(ctx, settings, env) };
    },
    onSessionDisposed: (cwd) => removeProjectLeftovers(settings, env, cwd),
    // With `allowedTools` Claude asks no permission for the MCP tools of the session (the client bridge, the request's remote servers); the rule below is the fallback. No call limit (see claudeEnv).
    mcpSessionMeta: (servers) => ({ claudeCode: { options: { allowedTools: servers.flatMap(({ label, tools }) => tools ? tools.map((tool) => `mcp__${label}__${tool}`) : [`mcp__${label}__*`]) } } }),
    // Search: the session's built-in tools become only WebSearch (never WebFetch), allowed up front; the permission rule is the fallback.
    webSearch: {
      sessionMeta: { claudeCode: { options: { tools: ["WebSearch"], allowedTools: ["WebSearch"] } } },
      allow: (permission, tracked) => claudeToolName(permission.toolCall as { _meta?: Record<string, unknown> | null; name?: unknown }) === "WebSearch" || (tracked !== undefined && claudeToolName(tracked) === "WebSearch"),
      search: (call) => {
        if (claudeToolName(call) !== "WebSearch") return undefined;
        const query = (call.rawInput as { query?: unknown } | null | undefined)?.query;
        const sources = searchSources(call);
        return { query: typeof query === "string" ? query : "", ...(sources.length ? { sources } : {}) };
      },
    },
    // The permission names the server (`mcpServer.name`) and the tool (`toolName`, `mcp__<server>__<tool>`).
    allowTool: (permission, _tracked, mcp) => {
      const meta = (permission.toolCall._meta as { claudeCode?: { toolName?: unknown; mcpServer?: { name?: unknown } } } | null | undefined)?.claudeCode;
      const server = meta?.mcpServer?.name;
      const name = typeof meta?.toolName === "string" ? meta.toolName : permission.toolCall.title;
      return typeof server === "string" && mcp.labels.includes(server) && typeof name === "string" && name.startsWith(`mcp__${server}__`) && mcp.allows(server, name.slice(`mcp__${server}__`.length));
    },
    // The call's name is `mcp__<server>__<tool>` (`_meta.claudeCode.toolName`); its arguments are the `rawInput`.
    mcpTarget: (call, labels) => {
      const name = (call._meta as { claudeCode?: { toolName?: unknown } } | null | undefined)?.claudeCode?.toolName ?? call.title;
      const server = typeof name === "string" ? [...labels].sort((a, b) => b.length - a.length).find((label) => name.startsWith(`mcp__${label}__`)) : undefined;
      return server && typeof name === "string" ? { server, tool: name.slice(`mcp__${server}__`.length), arguments: call.rawInput } : undefined;
    },
    mapError(error) {
      const text = [error instanceof Error ? error.message : String(error), JSON.stringify((error as { data?: unknown } | null)?.data ?? "")].join(" ");
      if (/Failed to refresh OAuth token/i.test(text) && /another Claude Code process is refreshing/i.test(text)) return new AcpUnavailableError("Claude is refreshing its login in another process. Retry in a few seconds.", error, "provider_busy", BUSY_RETRY_SECONDS);
      return undefined;
    },
    externalLogin: (ctx, methodId) => consoleLogin(ctx, settings, env, methodId),
    // The adapter advertises ACP `logout` (it runs `claude auth logout` itself); this is the same command run by hand for an adapter that does not.
    logoutFallback: (ctx) => consoleAuth(ctx, settings, env, ["logout"], false),
    // The login lives in the Claude config dir: the user's own ~/.claude unless the setting names another one.
    loginHome: (_ctx, processEnv) => ({ path: settings.configDir || processEnv.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), shared: !settings.configDir }),
  };
  return { ...descriptor, ...overrides };
}

export const claudeRegistration: ProviderRegistration = {
  id: "claude",
  displayName: "Claude",
  create: ({ providerSettings, ctx, env, config }) => new AcpProvider(claudeDescriptor(providerSettings as ClaudeSettings, env), ctx, { workRoot: config.workRoot, reuseSessions: config.reuseSessions, toolResultTimeoutMs: config.toolResultTimeoutMs }),
};
