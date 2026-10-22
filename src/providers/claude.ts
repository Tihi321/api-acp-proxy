import { createRequire } from "node:module";
import { spawn } from "node:child_process";
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

/** Runs `claude auth login` in a visible console window and resolves when it exits successfully. The console-subsystem claude binary is started directly (the packaged app exe is a GUI program and would give it no console); falls back to the adapter's --cli. */
function consoleLogin(ctx: RuntimeContext, settings: ClaudeSettings, env: NodeJS.ProcessEnv, methodId: string): Promise<void> {
  const flag = LOGIN_FLAGS[methodId];
  if (!flag) return Promise.reject(new AcpUnavailableError(`Unknown Claude login method '${methodId}'.`));
  const binary = resolveClaudeBinary(ctx, settings);
  const childEnv = claudeEnv(ctx, settings, env);
  const [program, args] = binary ? [binary, ["auth", "login", flag]] : [ctx.nodeRuntime.command, [adapterEntry(ctx), "--cli", "auth", "login", flag]];
  if (binary) delete childEnv.ELECTRON_RUN_AS_NODE;
  if (process.platform !== "win32") return Promise.reject(new AcpUnavailableError(`Run this in a terminal, then retry: "${program}" ${args.map((arg) => /\s/.test(arg) ? `"${arg}"` : arg).join(" ")}`));
  // cmd /s strips the first and last quote of the command string, so the whole line is wrapped in one extra pair; arguments are passed verbatim.
  const line = `"start "Claude login" /wait "${program}" ${args.map((arg) => `"${arg}"`).join(" ")}"`;
  return new Promise<void>((resolve, reject) => {
    const child = spawn("cmd.exe", ["/d", "/s", "/c", line], { env: childEnv, stdio: "ignore", windowsVerbatimArguments: true, windowsHide: false });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`The Claude login exited with code ${code ?? "unknown"}.`)));
  });
}

/** Even with persistSession off the CLI leaves an empty `<config>/projects/<cwd>/memory` directory per session; remove it (never a directory holding anything else). */
async function removeProjectLeftovers(settings: ClaudeSettings, env: NodeJS.ProcessEnv, cwd: string): Promise<void> {
  const dir = path.join(settings.configDir || env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  await fsp.rmdir(path.join(dir, "memory")).catch(() => undefined);
  await fsp.rmdir(dir).catch(() => undefined);
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
    externalLogin: (ctx, methodId) => consoleLogin(ctx, settings, env, methodId),
  };
  return { ...descriptor, ...overrides };
}

export const claudeRegistration: ProviderRegistration = {
  id: "claude",
  displayName: "Claude",
  create: ({ providerSettings, ctx, env, config }) => new AcpProvider(claudeDescriptor(providerSettings as ClaudeSettings, env), ctx, { workRoot: config.workRoot, reuseSessions: config.reuseSessions }),
};
