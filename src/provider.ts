import os from "node:os";
import path from "node:path";
import type { Usage, StopReason } from "@agentclientprotocol/sdk";
import type { TextMessage } from "./api.js";
import { silentLogger, type Logger } from "./logger.js";

export interface GenerationResult { text: string; stopReason: StopReason; usage: Usage | null; }
export interface GenerationCallbacks { onText?: (text: string) => void; onUsage?: (usage: Usage) => void; }

export class AcpUnavailableError extends Error {
  constructor(message: string, public readonly backendCause?: unknown, public readonly code?: string) { super(message); this.name = "AcpUnavailableError"; }
}
export class ProviderNotInstalledError extends AcpUnavailableError {
  constructor(message: string, cause?: unknown) { super(message, cause, "provider_not_installed"); this.name = "ProviderNotInstalledError"; }
}
export class ProviderAuthRequiredError extends AcpUnavailableError {
  constructor(message: string, cause?: unknown) { super(message, cause, "provider_auth_required"); this.name = "ProviderAuthRequiredError"; }
}
export class ProviderTermsRequiredError extends AcpUnavailableError {
  constructor(message: string) { super(message, undefined, "provider_terms_required"); this.name = "ProviderTermsRequiredError"; }
}

export interface ModelInfo { id: string; name?: string; }
/** "terminal" methods cannot be passed to authenticate. */
export interface AuthMethodInfo { id: string; name: string; description?: string; type?: string; }
export type ProviderState = "disabled" | "stopped" | "starting" | "ready" | "needs_login" | "not_installed" | "terms_required" | "error";
export interface ProviderStatus { id: string; name: string; state: ProviderState; error?: string; authMethods: AuthMethodInfo[]; models: ModelInfo[]; /** Browser URL printed by the agent for an interactive login (present while a login may be pending). */ loginUrl?: string; /** Version reported by the agent in initialize.agentInfo. */ agentVersion?: string; /** Signed-in account label pushed by the agent (e.g. via _auth/status_update). */ account?: string; }

/** How to run an agent process. Under Electron this is process.execPath + ELECTRON_RUN_AS_NODE=1. */
export interface NodeRuntime { command: string; argsPrefix: string[]; env: Record<string, string>; }
export interface RuntimeContext {
  logger: Logger;
  /** Per-user writable directory (settings, model cache, installed agents). */
  dataDir: string;
  nodeRuntime: NodeRuntime;
  /** Maps a path inside app.asar to app.asar.unpacked so it can be executed. Identity when headless. */
  resolveUnpacked(file: string): string;
  fetch?: typeof fetch;
  /** Opens a URL in the user's browser (used for interactive logins). Undefined when headless. */
  openUrl?: (url: string) => void | Promise<void>;
}
export function defaultRuntimeContext(overrides: Partial<RuntimeContext> = {}): RuntimeContext {
  return { logger: silentLogger, dataDir: path.join(os.tmpdir(), "api-acp-proxy"), nodeRuntime: { command: process.execPath, argsPrefix: [], env: {} }, resolveUnpacked: (file) => file, ...overrides };
}

export interface LaunchSpec { command: string; args: string[]; env?: NodeJS.ProcessEnv; cwd?: string; }
export interface PreflightResult { state: "not_installed" | "terms_required"; message: string; }

export interface ProviderDescriptor {
  id: string;
  displayName: string;
  ownedBy: string;
  /** Also expose raw model ids without the `<id>/` prefix. */
  exposeUnprefixed: boolean;
  /** Fixed model list; when set no session is needed to list models. */
  staticModels?: readonly string[];
  /** "eager" authenticates right after initialize; "on-demand" only after an auth_required error or an explicit login. */
  authMode: "eager" | "on-demand";
  readOnlyMode: "required" | "optional";
  /** Timeout for session/new (cold starts can be slow). */
  sessionTimeoutMs?: number;
  /** Number of pre-created sessions kept ready. */
  warmSessions?: number;
  preflight?(ctx: RuntimeContext): Promise<PreflightResult | undefined> | PreflightResult | undefined;
  launch(ctx: RuntimeContext): LaunchSpec | Promise<LaunchSpec>;
  /** Returns the auth method id to use without user interaction, or undefined when interactive login is needed. */
  chooseAuth(methods: AuthMethodInfo[], env: NodeJS.ProcessEnv): string | undefined;
  /** Mode ids that count as the safe/read-only mode, in order of preference. Default ["read-only", "readonly"]. */
  modeCandidates?: readonly string[];
  /** stderr lines of the agent are logged at this level (default info). */
  stderrLogLevel?: "debug" | "info";
  /** Matches the interactive login URL in an agent stderr line (the URL is capture group 1, or the whole match). */
  loginUrlPattern?: RegExp;
  /** Timeout for an automatic authenticate (eager or retry). On timeout the provider becomes needs_login and leaves the request pending. Default 10000. */
  authTimeoutMs?: number;
  /** Timeout for a user-initiated login(). Default 300000. */
  loginTimeoutMs?: number;
  /** Delay before a pending user login opens the login URL in the browser. Default 3000. */
  loginOpenDelayMs?: number;
  /** Runs before each agent process is spawned (after preflight): orphan sweeps, pending cleanups. */
  beforeStart?(ctx: RuntimeContext): Promise<void> | void;
  /** Runs after the agent process tree has been killed by close(). */
  afterStop?(ctx: RuntimeContext): Promise<void> | void;
  /** Called with the id of every session the provider creates. */
  onSessionCreated?(sessionId: string): void;
  /** Called after a session was disposed, with its working directory (cleanup of agent-side leftovers). */
  onSessionDisposed?(cwd: string): Promise<void> | void;
  /** Called after a successful user-initiated login with the method that was used. */
  onLoginSuccess?(methodId: string): void;
  /** Sent as `_meta` on session/new (agent-specific session options). */
  sessionMeta?: Record<string, unknown>;
  /** Login methods shown in status().authMethods when the agent advertises none. */
  loginMethods?: AuthMethodInfo[];
  /** When present, login() runs this (e.g. a console window) instead of ACP authenticate; on success the agent is restarted. */
  externalLogin?(ctx: RuntimeContext, methodId: string): Promise<void>;
  /** Translates a backend error into a proxy error (e.g. an ApiError 403). */
  mapError?(error: unknown, model: string): Error | undefined;
}

export interface Provider {
  readonly id: string;
  readonly displayName: string;
  readonly ownedBy: string;
  readonly exposeUnprefixed: boolean;
  readonly staticModels?: ModelInfo[];
  generate(model: string, messages: TextMessage[], callbacks?: GenerationCallbacks, signal?: AbortSignal): Promise<GenerationResult>;
  listModels(options?: { force?: boolean }): Promise<ModelInfo[]>;
  status(): ProviderStatus;
  login(methodId?: string): Promise<void>;
  onStatus(listener: (status: ProviderStatus) => void): () => void;
  close(): Promise<void>;
}
