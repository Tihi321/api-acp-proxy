import fsp from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AcpProvider } from "../acp-provider.js";
import { ApiError } from "../api.js";
import type { ProviderRegistration } from "../controller.js";
import { silentLogger, type Logger } from "../logger.js";
import { sweepOrphans } from "../process-tree.js";
import type { AuthMethodInfo, ProviderDescriptor, RuntimeContext } from "../provider.js";
import type { SettingsPatch } from "../settings.js";
import { agentsDir, readInstallInfo } from "./antigravity-installer.js";

export interface AntigravityOptions {
  /** `settings.providers.antigravity`. */
  settings: { executablePath?: string; geminiHome?: string; apiKey?: string; authMethodId?: string; termsAcknowledgedAt?: string; purgeSessions?: boolean; lastAuthMethodId?: string };
  env?: NodeJS.ProcessEnv;
  /** Persists a settings patch without restarting the provider. */
  saveSettings?(patch: SettingsPatch): Promise<void> | void;
  /** Overrides for tests. */
  timeouts?: { authTimeoutMs?: number; loginTimeoutMs?: number; loginOpenDelayMs?: number };
  /** Descriptor fields to override (tests). */
  overrides?: Partial<ProviderDescriptor>;
}

/** The server prints "Open the following link to authenticate the ACP server: <url>". Other accounts.google.com links in its logs (account chooser notices) must not match. */
const LOGIN_URL = /Open the following link to authenticate[^\r\n:]*:\s*(https:\/\/accounts\.google\.com\/\S+)/i;
const SESSIONS_FILE = "antigravity-sessions.json";
/** Windows releases sqlite/WAL handles a moment after the process tree dies. */
const RM_RETRY = { force: true, maxRetries: 8, retryDelay: 250 } as const;
const IMAGE_NAMES = ["agy_acp_server.exe", "localharness_external.exe"];

const truthy = (value: string | undefined): boolean => value !== undefined && ["1", "true", "yes", "on"].includes(value.toLowerCase());
const exists = (file: string): Promise<boolean> => fsp.access(file).then(() => true, () => false);

/** `<GEMINI_HOME>` as the agent sees it: the geminiHome setting, then the GEMINI_HOME env var, then ~/.gemini. */
export function resolveGeminiHome(settings: { geminiHome?: string }, env: NodeJS.ProcessEnv = process.env): string {
  return settings.geminiHome || env.GEMINI_HOME || path.join(os.homedir(), ".gemini");
}

/** Executable resolution order: executablePath setting, then <dataDir>/agents/antigravity-acp/install.json, then PROXY_ANTIGRAVITY_COMMAND. */
export async function resolveAntigravityExecutable(ctx: Pick<RuntimeContext, "dataDir">, settings: { executablePath?: string }, env: NodeJS.ProcessEnv = process.env): Promise<{ command: string; args: string[] } | undefined> {
  if (settings.executablePath && await exists(settings.executablePath)) return { command: settings.executablePath, args: [] };
  const info = await readInstallInfo(ctx.dataDir).catch(() => undefined);
  if (info && await exists(info.command)) return { command: info.command, args: info.args };
  if (env.PROXY_ANTIGRAVITY_COMMAND && await exists(env.PROXY_ANTIGRAVITY_COMMAND)) return { command: env.PROXY_ANTIGRAVITY_COMMAND, args: [] };
  return undefined;
}

// --- session purge -----------------------------------------------------------------------------------------------

const queues = new Map<string, Promise<unknown>>();
function serialized<T>(key: string, run: () => Promise<T>): Promise<T> {
  const next = (queues.get(key) ?? Promise.resolve()).then(run, run);
  queues.set(key, next.catch(() => undefined));
  return next;
}

const safeId = (id: unknown): id is string => typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id);

async function readRecorded(file: string): Promise<string[]> {
  try {
    const parsed = JSON.parse(await fsp.readFile(file, "utf8")) as { sessionIds?: unknown };
    return Array.isArray(parsed.sessionIds) ? parsed.sessionIds.filter(safeId) : [];
  } catch { return []; }
}

async function writeRecorded(file: string, ids: string[]): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await fsp.writeFile(tmp, JSON.stringify({ version: 1, sessionIds: ids }, null, 2));
  await fsp.rename(tmp, file);
}

/** Remembers a session id the proxy created so its on-disk conversation can be deleted later. */
export function recordSession(dataDir: string, sessionId: string): Promise<void> {
  if (!safeId(sessionId)) return Promise.resolve();
  const file = path.join(dataDir, SESSIONS_FILE);
  return serialized(file, async () => {
    const ids = await readRecorded(file);
    if (!ids.includes(sessionId)) await writeRecorded(file, [...ids, sessionId]);
  });
}

/**
 * Deletes `<geminiHome>/antigravity-acp/conversations/<id>.*` (.db, .db-wal, .db-shm, .meta) and `brain/<id>` for the recorded ids only, then prunes the record.
 * Ids whose files could not be removed (still locked) stay recorded for the next attempt. Never touches ids the proxy did not create.
 */
export function purgeRecordedSessions(options: { dataDir: string; geminiHome: string; logger?: Logger }): Promise<number> {
  const file = path.join(options.dataDir, SESSIONS_FILE);
  const log = options.logger ?? silentLogger;
  return serialized(file, async () => {
    const ids = await readRecorded(file);
    if (!ids.length) return 0;
    const root = path.join(options.geminiHome, "antigravity-acp");
    const conversations = path.join(root, "conversations");
    let names: string[] = [];
    try { names = await fsp.readdir(conversations); } catch { /* no conversations directory */ }
    const remaining: string[] = [];
    let purged = 0;
    for (const id of ids) {
      try {
        for (const name of names) if (name.startsWith(`${id}.`)) await fsp.rm(path.join(conversations, name), RM_RETRY);
        await fsp.rm(path.join(root, "brain", id), { ...RM_RETRY, recursive: true });
        purged++;
      } catch (error) {
        remaining.push(id);
        log.debug(`Could not delete session ${id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await writeRecorded(file, remaining);
    if (purged) log.debug(`Deleted ${purged} recorded Antigravity session(s).`);
    return purged;
  });
}

// --- descriptor ----------------------------------------------------------------------------------------------------

/** Google Antigravity through the official ACP server (agy_acp_server). */
export function antigravityDescriptor(ctxForHooks: RuntimeContext, options: AntigravityOptions): ProviderDescriptor {
  const settings = options.settings;
  const env = options.env ?? process.env;
  const purge = settings.purgeSessions !== false;
  let lastAuthMethodId = settings.lastAuthMethodId;
  const home = () => resolveGeminiHome(settings, env);
  const log = ctxForHooks.logger.child("antigravity");

  /** The method recorded by the server's own settings.json (`auth.type`), written after a successful interactive login. */
  const serverAuthType = (): string | undefined => {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(home(), "antigravity-acp", "settings.json"), "utf8")) as { auth?: { type?: unknown } };
      return typeof parsed.auth?.type === "string" ? parsed.auth.type : undefined;
    } catch { return undefined; }
  };

  const descriptor: ProviderDescriptor = {
    id: "antigravity",
    displayName: "Google Antigravity",
    ownedBy: "google",
    exposeUnprefixed: false,
    authMode: "eager",
    // The server has no read-only mode: "default" sends every tool permission to the client, and the client always cancels. Never auto_edit/yolo.
    readOnlyMode: "required",
    modeCandidates: ["read-only", "readonly", "default"],
    sessionTimeoutMs: 180_000,
    warmSessions: 1,
    stderrLogLevel: "debug",
    loginUrlPattern: LOGIN_URL,
    promptPreamble: "Do not call any tool, even if one seems useful: no web search, no reading URLs, no commands, no file access. Answer from your own knowledge.",
    async preflight(ctx) {
      if (!settings.termsAcknowledgedAt && !truthy(env.PROXY_ANTIGRAVITY_ACCEPT_TERMS)) {
        return { state: "terms_required", message: "Acknowledge the Google Antigravity terms before enabling this provider." };
      }
      if (!await resolveAntigravityExecutable(ctx, settings, env)) {
        return { state: "not_installed", message: "The Antigravity ACP server is not installed. Download it from the registry or set the executable path." };
      }
      return undefined;
    },
    async launch(ctx) {
      const executable = await resolveAntigravityExecutable(ctx, settings, env);
      if (!executable) throw new Error("The Antigravity ACP server executable was not found.");
      const childEnv: NodeJS.ProcessEnv = { ...process.env };
      delete childEnv.ELECTRON_RUN_AS_NODE;
      delete childEnv.NODE_OPTIONS;
      if (settings.apiKey) childEnv.GEMINI_API_KEY = settings.apiKey;
      if (settings.geminiHome) childEnv.GEMINI_HOME = settings.geminiHome;
      return { command: executable.command, args: executable.args, env: childEnv };
    },
    chooseAuth(methods: AuthMethodInfo[], processEnv) {
      const advertised = (id: string | undefined): string | undefined => id && methods.some((method) => method.id === id) ? id : undefined;
      if (settings.authMethodId) return settings.authMethodId;
      if (settings.apiKey || processEnv.GEMINI_API_KEY) { const key = advertised("gemini-api-key"); if (key) return key; }
      return advertised(lastAuthMethodId) ?? advertised(serverAuthType());
    },
    onLoginSuccess(methodId) {
      if (lastAuthMethodId === methodId) return;
      lastAuthMethodId = methodId;
      void Promise.resolve(options.saveSettings?.({ providers: { antigravity: { lastAuthMethodId: methodId } } })).catch((error) => log.warn(`Could not remember the login method: ${error instanceof Error ? error.message : String(error)}`));
    },
    onSessionCreated(sessionId) {
      if (purge) void recordSession(ctxForHooks.dataDir, sessionId).catch(() => undefined);
    },
    async beforeStart(ctx) {
      const executable = await resolveAntigravityExecutable(ctx, settings, env);
      const dirs = [agentsDir(ctx.dataDir), ...(executable ? [path.dirname(executable.command)] : [])];
      const images = [...IMAGE_NAMES, ...(executable ? [path.basename(executable.command)] : [])];
      await sweepOrphans({ dirs, imageNames: images, log: (message) => log.warn(message) }).catch(() => 0);
      if (purge) await purgeRecordedSessions({ dataDir: ctx.dataDir, geminiHome: home(), logger: log });
    },
    async afterStop(ctx) {
      if (purge) await purgeRecordedSessions({ dataDir: ctx.dataDir, geminiHome: home(), logger: log });
    },
    // Its image tool asks permission ("Run generate_image?"); a request for images allows that one, nothing else. The tool writes the file under <GEMINI_HOME>/antigravity-acp/brain/<sessionId>/.
    imageGeneration: {
      allow: (permission) => permission.toolCall.title === "Run generate_image?" && permission.toolCall.kind === "other",
      imageFolder: () => path.join(home(), "antigravity-acp", "brain"),
    },
    mapError(error, model) {
      const text = [error instanceof Error ? error.message : String(error), JSON.stringify((error as { data?: unknown } | null)?.data ?? "")].join(" ");
      if (/requested entity was not found/i.test(text)) {
        return new ApiError(403, "model_not_available", `The model '${model}' is not available for this Antigravity account.`, "model");
      }
      return undefined;
    },
  };
  return { ...descriptor, ...options.timeouts, ...options.overrides };
}

export const antigravityRegistration: ProviderRegistration = {
  id: "antigravity",
  displayName: "Google Antigravity",
  create: ({ providerSettings, ctx, env, config, saveSettings }) => new AcpProvider(antigravityDescriptor(ctx, { settings: providerSettings as AntigravityOptions["settings"], env, saveSettings }), ctx, { workRoot: config.workRoot, reuseSessions: config.reuseSessions }),
};
