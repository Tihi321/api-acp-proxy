import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { ProxyConfig } from "./config.js";
import { silentLogger, type Logger } from "./logger.js";
import { HEADER_NAME, MCP_LABEL, plainValue } from "./mcp-config.js";
import { BRIDGE_SERVER_NAME } from "./tool-bridge.js";

const nonNegative = (fallback: number) => z.number().int().min(0).default(fallback);
const positive = (fallback: number) => z.number().int().positive().default(fallback);

const mcpLabel = z.string().regex(MCP_LABEL, "An MCP server label is 1 to 64 letters, digits, '_' or '-'.").refine((label) => label !== BRIDGE_SERVER_NAME, `The MCP server label '${BRIDGE_SERVER_NAME}' is reserved for the proxy's own tool bridge.`);
const mcpHttpUrl = z.string().url().refine((value) => /^https?:\/\//i.test(value), "An MCP server url must be http or https.");
const mcpHeaders = z.record(z.string().regex(HEADER_NAME, "Not a valid header name."), z.string().refine(plainValue, "A header value cannot contain line breaks."));
/** A remote server (`url`, http unless `transport` says sse) or a local command (stdio). Stdio servers can only be configured here, never by a request. */
const mcpServerSchema = z.union([
  z.object({ url: mcpHttpUrl, headers: mcpHeaders.optional(), transport: z.enum(["http", "sse"]).optional() }).strict(),
  z.object({ command: z.string().min(1), args: z.array(z.string()).optional(), env: z.record(z.string().min(1), z.string()).optional() }).strict(),
]);
export type McpServerSetting = z.infer<typeof mcpServerSchema>;
const mcpEntryIssue = (error: z.ZodError): string => { const issue = error.issues[0]; return issue ? `${issue.path.length ? `${issue.path.join(".")}: ` : ""}${issue.message}` : "invalid entry"; };

/** The valid entries of a hand-written `mcpServers` value. An invalid entry (or a value that is not an object) is dropped with a warning naming the label and the first issue; it never invalidates the rest of the settings. */
export function sanitizeMcpServers(raw: unknown, logger: Logger = silentLogger): Settings["mcpServers"] {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) { logger.warn("Ignoring 'mcpServers' in the settings file: it must be an object of label to server."); return {}; }
  const kept: Settings["mcpServers"] = {};
  for (const [label, entry] of Object.entries(raw)) {
    const checkedLabel = mcpLabel.safeParse(label);
    if (!checkedLabel.success) { logger.warn(`Ignoring the MCP server '${label}' in the settings file: ${mcpEntryIssue(checkedLabel.error)}`); continue; }
    const checked = mcpServerSchema.safeParse(entry);
    if (checked.success) kept[label] = checked.data;
    else logger.warn(`Ignoring the MCP server '${label}' in the settings file: ${mcpEntryIssue(checked.error)}`);
  }
  return kept;
}

export const settingsSchema = z.object({
  version: z.literal(1).default(1),
  server: z.object({
    host: z.string().min(1).default("127.0.0.1"),
    port: z.number().int().min(0).max(65535).default(8787),
    apiKey: z.string().optional(),
    maxBodyBytes: positive(20 * 1024 * 1024),
    timeoutMs: positive(5 * 60 * 1000),
    modelsWaitMs: positive(3000),
    workRoot: z.string().optional(),
    launchAtLogin: z.boolean().default(false),
    /** Drop sampling fields (temperature, top_p, penalties, seed) instead of answering 400, for clients that always send them. */
    ignoreSampling: z.boolean().default(false),
    /** Keep agent sessions across the turns of a conversation. */
    reuseSessions: z.boolean().default(false),
    /** List the unprefixed ids (`gpt-x` next to `codex/gpt-x`) in /v1/models. Requests with an unprefixed id are routed either way. */
    listBareAliases: z.boolean().default(true),
    /** How long a turn that called a client tool waits for the tool result before the agent turn is cancelled (the agents' own limits can be shorter). */
    toolResultTimeoutMs: positive(10 * 60 * 1000),
    /** Requests that run at once per provider; more wait in a FIFO queue. 0 = unlimited. */
    maxConcurrent: nonNegative(4),
    /** Requests that may wait per provider; a full queue answers 429. 0 = unlimited. */
    maxQueue: nonNegative(0),
  }).default({}),
  providers: z.object({
    codex: z.object({
      enabled: z.boolean().default(true),
      authMethodId: z.string().optional(),
      acpCommand: z.string().optional(),
      acpArgs: z.array(z.string()).default([]),
      /** Run Codex with its own CODEX_HOME (`<dataDir>/codex-home`: no user skills, plugins or MCP servers; needs its own login). Off keeps ~/.codex. */
      isolatedHome: z.boolean().default(true),
      /** Overrides `server.maxConcurrent` for this provider (0 = unlimited; absent = the global value). */
      maxConcurrent: z.number().int().min(0).optional(),
    }).default({}),
    antigravity: z.object({
      enabled: z.boolean().default(false),
      executablePath: z.string().optional(),
      geminiHome: z.string().optional(),
      apiKey: z.string().optional(),
      authMethodId: z.string().optional(),
      termsAcknowledgedAt: z.string().optional(),
      /** Delete the conversation files of proxy-created sessions after the agent stops. */
      purgeSessions: z.boolean().default(true),
      /** Auth method of the last successful login (written by the provider, not the UI). */
      lastAuthMethodId: z.string().optional(),
      maxConcurrent: z.number().int().min(0).optional(),
    }).default({}),
    claude: z.object({
      enabled: z.boolean().default(false),
      apiKey: z.string().optional(),
      oauthToken: z.string().optional(),
      configDir: z.string().optional(),
      executablePath: z.string().optional(),
      authMethodId: z.string().optional(),
      termsAcknowledgedAt: z.string().optional(),
      maxConcurrent: z.number().int().min(0).optional(),
    }).default({}),
  }).default({}),
  /** MCP servers a Responses request may name by `server_label` (JSON only, no settings-window editor). Headers and env are stored as written. */
  mcpServers: z.record(mcpLabel, mcpServerSchema).default({}),
});

export type Settings = z.infer<typeof settingsSchema>;
/** Deep partial; `null` clears an optional field. */
export type SettingsPatch = { [K in keyof Settings]?: Settings[K] extends object ? { [P in keyof Settings[K]]?: Settings[K][P] extends object ? { [Q in keyof Settings[K][P]]?: Settings[K][P][Q] | null } : Settings[K][P] | null } : Settings[K] };
/** Settings for one provider, keyed by provider id in `Settings.providers`. */
export type ProviderSettings = { enabled: boolean } & Record<string, unknown>;

export interface SecretCodec { encode(plain: string): string; decode(stored: string): string; }
const SECRET_PREFIX = "enc:";

export function defaultSettings(): Settings { return settingsSchema.parse({}); }

export function defaultSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PROXY_SETTINGS_FILE) return path.resolve(env.PROXY_SETTINGS_FILE);
  const base = process.platform === "win32" ? env.APPDATA || path.join(os.homedir(), "AppData", "Roaming")
    : process.platform === "darwin" ? path.join(os.homedir(), "Library", "Application Support")
    : env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "api-acp-proxy", "settings.json");
}

function isPlain(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

export function mergeSettings(current: Settings, patch: SettingsPatch): Settings {
  const merge = (base: Record<string, unknown>, change: Record<string, unknown>): Record<string, unknown> => {
    const out = { ...base };
    for (const [key, value] of Object.entries(change)) {
      if (value === undefined) continue;
      if (value === null) delete out[key];
      else if (isPlain(value) && isPlain(out[key])) out[key] = merge(out[key] as Record<string, unknown>, value);
      else out[key] = value;
    }
    return out;
  };
  return settingsSchema.parse(merge(current as unknown as Record<string, unknown>, patch as Record<string, unknown>));
}

function mapSecrets(settings: Settings, map: (value: string) => string | undefined): Settings {
  const copy = structuredClone(settings);
  const holders: Array<[Record<string, unknown>, string]> = [[copy.server, "apiKey"], [copy.providers.antigravity, "apiKey"], [copy.providers.claude, "apiKey"], [copy.providers.claude, "oauthToken"]];
  for (const [holder, key] of holders) {
    const value = holder[key];
    if (typeof value !== "string") continue;
    const mapped = map(value);
    if (mapped === undefined) delete holder[key]; else holder[key] = mapped;
  }
  return copy;
}

/** JSON settings file: created with defaults when missing, corrupt files are moved to `.bak-<ts>`, writes are atomic. */
export class SettingsStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(readonly file: string, private readonly codec?: SecretCodec, private readonly logger: Logger = silentLogger) {}

  async load(): Promise<Settings> {
    let raw: string;
    try { raw = await fs.readFile(this.file, "utf8"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const settings = defaultSettings();
      await this.save(settings);
      return settings;
    }
    try {
      const json: unknown = JSON.parse(raw.replace(/^﻿/, ""));
      // `mcpServers` is hand-edited: its entries are checked one by one below, so a typo there does not reset the file.
      const loose = isPlain(json) ? json : undefined;
      const parsed = settingsSchema.parse(loose ? { ...loose, mcpServers: undefined } : json);
      if (loose) parsed.mcpServers = sanitizeMcpServers(loose.mcpServers, this.logger);
      return mapSecrets(parsed, (value) => {
        if (!value.startsWith(SECRET_PREFIX)) return value;
        try { return this.codec ? this.codec.decode(value.slice(SECRET_PREFIX.length)) : undefined; } catch { this.logger.warn("A stored secret could not be decrypted and was dropped."); return undefined; }
      });
    } catch (error) {
      const backup = `${this.file}.bak-${Date.now()}`;
      await fs.rename(this.file, backup).catch(() => undefined);
      this.logger.warn(`Settings file is invalid (${error instanceof Error ? error.message.split("\n")[0] : String(error)}); moved to ${backup} and defaults were restored.`);
      const settings = defaultSettings();
      await this.save(settings);
      return settings;
    }
  }

  save(settings: Settings): Promise<void> {
    const run = async () => {
      const parsed = settingsSchema.parse(settings);
      const encoded = mapSecrets(parsed, (value) => this.codec && !value.startsWith(SECRET_PREFIX) ? SECRET_PREFIX + this.codec.encode(value) : value);
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp-${process.pid}-${Date.now()}`;
      await fs.writeFile(tmp, JSON.stringify(encoded, null, 2) + "\n", "utf8");
      for (let attempt = 0; ; attempt++) {
        try { await fs.rename(tmp, this.file); return; } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (attempt >= 4 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) { await fs.rm(tmp, { force: true }).catch(() => undefined); throw error; }
          await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
        }
      }
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }
}

export interface ResolvedConfig {
  config: ProxyConfig;
  /** Settings with environment overrides applied. */
  settings: Settings;
  providers: Record<string, ProviderSettings>;
  /** Dotted setting paths currently forced by environment variables, e.g. "server.port". */
  overridden: string[];
}

function parseInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}
function parseNonNegative(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}
function parseBool(value: string | undefined): boolean | undefined {
  if (value === undefined || value === "") return undefined;
  const lower = value.toLowerCase();
  if (["1", "true", "yes", "on"].includes(lower)) return true;
  if (["0", "false", "no", "off"].includes(lower)) return false;
  return undefined;
}

/** Precedence: environment variable, then settings file, then defaults. */
export function resolveConfig(settings: Settings, env: NodeJS.ProcessEnv = process.env): ResolvedConfig {
  const effective = structuredClone(settings);
  const overridden: string[] = [];
  const apply = <T>(key: string, value: T | undefined, set: (value: T) => void) => { if (value !== undefined) { set(value); overridden.push(key); } };
  const { server, providers } = effective;
  apply("server.host", env.PROXY_HOST || undefined, (v) => { server.host = v; });
  apply("server.port", parseInt(env.PROXY_PORT), (v) => { server.port = v; });
  apply("server.apiKey", env.PROXY_API_KEY || undefined, (v) => { server.apiKey = v; });
  apply("server.maxBodyBytes", parseInt(env.PROXY_MAX_BODY_BYTES), (v) => { server.maxBodyBytes = v; });
  apply("server.timeoutMs", parseInt(env.PROXY_TIMEOUT_MS), (v) => { server.timeoutMs = v; });
  apply("server.modelsWaitMs", parseInt(env.PROXY_MODELS_WAIT_MS), (v) => { server.modelsWaitMs = v; });
  apply("server.workRoot", env.PROXY_WORK_ROOT || undefined, (v) => { server.workRoot = v; });
  apply("server.ignoreSampling", parseBool(env.PROXY_IGNORE_SAMPLING), (v) => { server.ignoreSampling = v; });
  apply("server.reuseSessions", parseBool(env.PROXY_REUSE_SESSIONS), (v) => { server.reuseSessions = v; });
  apply("server.listBareAliases", parseBool(env.PROXY_LIST_BARE_ALIASES), (v) => { server.listBareAliases = v; });
  apply("server.toolResultTimeoutMs", parseInt(env.PROXY_TOOL_RESULT_TIMEOUT_MS), (v) => { server.toolResultTimeoutMs = v; });
  apply("server.maxConcurrent", parseNonNegative(env.PROXY_MAX_CONCURRENT), (v) => { server.maxConcurrent = v; });
  apply("server.maxQueue", parseNonNegative(env.PROXY_MAX_QUEUE), (v) => { server.maxQueue = v; });
  apply("providers.codex.maxConcurrent", parseNonNegative(env.PROXY_CODEX_MAX_CONCURRENT), (v) => { providers.codex.maxConcurrent = v; });
  apply("providers.antigravity.maxConcurrent", parseNonNegative(env.PROXY_ANTIGRAVITY_MAX_CONCURRENT), (v) => { providers.antigravity.maxConcurrent = v; });
  apply("providers.claude.maxConcurrent", parseNonNegative(env.PROXY_CLAUDE_MAX_CONCURRENT), (v) => { providers.claude.maxConcurrent = v; });
  apply("providers.codex.enabled", parseBool(env.PROXY_CODEX_ENABLED), (v) => { providers.codex.enabled = v; });
  apply("providers.codex.isolatedHome", parseBool(env.PROXY_CODEX_ISOLATED_HOME), (v) => { providers.codex.isolatedHome = v; });
  apply("providers.codex.acpCommand", env.PROXY_ACP_COMMAND || undefined, (v) => { providers.codex.acpCommand = v; });
  apply("providers.codex.acpArgs", env.PROXY_ACP_ARGS ? env.PROXY_ACP_ARGS.split(" ").filter(Boolean) : undefined, (v) => { providers.codex.acpArgs = v; });
  apply("providers.antigravity.enabled", parseBool(env.PROXY_ANTIGRAVITY_ENABLED), (v) => { providers.antigravity.enabled = v; });
  apply("providers.antigravity.executablePath", env.PROXY_ANTIGRAVITY_COMMAND || undefined, (v) => { providers.antigravity.executablePath = v; });
  apply("providers.antigravity.termsAcknowledgedAt", parseBool(env.PROXY_ANTIGRAVITY_ACCEPT_TERMS) ? providers.antigravity.termsAcknowledgedAt ?? new Date().toISOString() : undefined, (v) => { providers.antigravity.termsAcknowledgedAt = v; });
  apply("providers.claude.enabled", parseBool(env.PROXY_CLAUDE_ENABLED), (v) => { providers.claude.enabled = v; });
  apply("providers.claude.executablePath", env.PROXY_CLAUDE_EXECUTABLE || undefined, (v) => { providers.claude.executablePath = v; });
  apply("providers.claude.termsAcknowledgedAt", parseBool(env.PROXY_CLAUDE_ACCEPT_TERMS) ? providers.claude.termsAcknowledgedAt ?? new Date().toISOString() : undefined, (v) => { providers.claude.termsAcknowledgedAt = v; });
  const config: ProxyConfig = {
    host: server.host,
    port: server.port,
    apiKey: server.apiKey || undefined,
    maxBodyBytes: server.maxBodyBytes,
    timeoutMs: server.timeoutMs,
    modelsWaitMs: server.modelsWaitMs,
    ignoreSampling: server.ignoreSampling,
    reuseSessions: server.reuseSessions,
    listBareAliases: server.listBareAliases,
    toolResultTimeoutMs: server.toolResultTimeoutMs,
    maxConcurrent: server.maxConcurrent,
    maxQueue: server.maxQueue,
    mcpServers: effective.mcpServers,
    workRoot: server.workRoot || path.join(os.tmpdir(), "codex-subscription-proxy"),
    acpCommand: providers.codex.acpCommand || undefined,
    acpArgs: providers.codex.acpArgs,
  };
  return { config, settings: effective, providers: providers as unknown as Record<string, ProviderSettings>, overridden };
}
