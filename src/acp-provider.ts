import { mkdtemp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { client, methods, ndJsonStream, type ClientConnection, type ClientContext } from "@agentclientprotocol/sdk";
import type { ContentBlock, McpServer, PromptResponse, RequestPermissionRequest, SessionConfigOption, SessionUpdate, Usage } from "@agentclientprotocol/sdk";
import { createHash } from "node:crypto";
import { ApiError, buildPrompt, hasImages, messageText, type Message } from "./api.js";
import { deleteGeneratedFile } from "./generated-images.js";
import { killProcessTree } from "./process-tree.js";
import type { McpServerSpec } from "./mcp-config.js";
import { BRIDGE_SERVER_NAME, type BridgeSession, type HeldCall } from "./tool-bridge.js";
import { AcpUnavailableError, ProviderAuthRequiredError, ProviderNotInstalledError, ProviderTermsRequiredError } from "./provider.js";
import type { AuthMethodInfo, GeneratedImage, GenerateOptions, GenerationCallbacks, GenerationResult, McpAccess, McpCallResult, ModelInfo, Provider, ProviderDescriptor, ProviderState, ProviderStatus, RuntimeContext, TrackedToolCall, WebSearchResult } from "./provider.js";

type SessionHandler = (update: SessionUpdate) => void;
/** Decides for one session whether a permission request is allowed; everything not allowed is cancelled. */
type PermissionRule = (request: RequestPermissionRequest) => boolean;
interface PreparedSession { sessionId: string; cwd: string; modelOptionId?: string; readOnlyModeId?: string; }
/** A message as kept for session reuse: its text, the SHA-256 of each image (never the base64 itself), and the ids of its tool calls / the call a tool result answers. */
interface KeptMessage { role: Message["role"]; text: string; images: string[]; toolCalls?: Array<{ id: string; name: string }>; toolCallId?: string; }
function toKept(message: Message): KeptMessage { return { role: message.role, text: messageText(message), images: message.parts.flatMap((part) => part.type === "image" ? [createHash("sha256").update(part.data, "base64").digest("hex")] : []), ...(message.toolCalls?.length ? { toolCalls: message.toolCalls.map(({ id, name }) => ({ id, name })) } : {}), ...(message.toolCallId !== undefined ? { toolCallId: message.toolCallId } : {}) }; }
const sameCalls = (a: KeptMessage["toolCalls"], b: KeptMessage["toolCalls"]): boolean => (a?.length ?? 0) === (b?.length ?? 0) && (a ?? []).every((call, index) => call.id === b![index]!.id && call.name === b![index]!.name);
/** Whether the client's history matches a kept transcript: user-side messages exactly, an assistant message when its text is part of the raw answer (a tool-call message by its call ids). */
function sameTranscript(kept: KeptMessage[], sent: KeptMessage[]): boolean {
  return kept.length === sent.length && kept.every((entry, position) => {
    const other = sent[position]!;
    if (entry.role !== other.role) return false;
    if (entry.role === "tool") return entry.toolCallId === other.toolCallId && entry.text === other.text;
    if (entry.role !== "assistant") return entry.text === other.text && entry.images.length === other.images.length && entry.images.every((hash, at) => hash === other.images[at]);
    const content = other.text.trim();
    if (entry.toolCalls?.length || other.toolCalls?.length) return sameCalls(entry.toolCalls, other.toolCalls) && other.images.length === 0 && (content === "" || entry.text.includes(content));
    return content !== "" && other.images.length === 0 && entry.text.includes(content);
  });
}
type ToolCallUpdate = Extract<SessionUpdate, { sessionUpdate: "tool_call" | "tool_call_update" }>;
/** Merges a `tool_call` / `tool_call_update` into the fields kept per tool call id (the map keeps the order the calls were first seen in). */
function trackToolCall(tracked: Map<string, TrackedToolCall>, update: ToolCallUpdate): void {
  const entry: TrackedToolCall = { ...tracked.get(update.toolCallId), toolCallId: update.toolCallId };
  if (update.title != null) entry.title = update.title;
  if (update.kind != null) entry.kind = update.kind;
  if (update.status != null) entry.status = update.status;
  if (update.rawInput !== undefined) entry.rawInput = update.rawInput;
  if (update.rawOutput !== undefined) entry.rawOutput = update.rawOutput;
  if (update.content != null && update.content.length) entry.content = update.content;
  if (update._meta != null) entry._meta = mergeMeta(entry._meta ?? undefined, update._meta);
  tracked.set(update.toolCallId, entry);
}

/** The text of MCP content blocks: `{ type: "text", text }` or an ACP `{ type: "content", content: { type: "text", text } }`. */
function blockText(blocks: unknown): string | undefined {
  if (!Array.isArray(blocks)) return undefined;
  const texts = blocks.flatMap((block: { type?: unknown; text?: unknown; content?: { type?: unknown; text?: unknown } } | null) => block?.type === "text" && typeof block.text === "string" ? [block.text] : block?.type === "content" && block.content?.type === "text" && typeof block.content.text === "string" ? [block.content.text] : []);
  return texts.length ? texts.join("\n") : undefined;
}

/** What a finished MCP call returned, from the agent's `rawOutput` (a string, MCP content blocks, or Codex's `{ result: { content }, error: { message } }`) or its `content`. Antigravity's completed update holds only a placeholder such as "Call client echo tool", which is all there is to report. */
function toolOutput(call: TrackedToolCall): { output: string | null; error: string | null } {
  const raw = call.rawOutput;
  const object = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as { error?: { message?: unknown } | null; result?: unknown } : undefined;
  const errorText = typeof object?.error?.message === "string" ? object.error.message : undefined;
  const result = object ? (typeof object.result === "string" ? object.result : blockText((object.result as { content?: unknown } | null | undefined)?.content)) : undefined;
  const text = typeof raw === "string" ? raw : Array.isArray(raw) ? blockText(raw) : result ?? blockText(call.content) ?? (raw !== undefined && raw !== null && !object?.error ? JSON.stringify(raw) : undefined);
  if (call.status === "failed") return { output: null, error: errorText ?? text ?? "The tool call failed." };
  return { output: text ?? null, error: null };
}

/** A finished turn's session kept for the next request of the same conversation; `transcript` holds the client-visible messages plus each raw answer. A session that has the client's tools also keeps its bridge and the tools it was made for. */
interface KeptSession { agent: ClientContext; session: PreparedSession; model: string; transcript: KeptMessage[]; usage?: Usage; timer: NodeJS.Timeout; bridge?: BridgeSession; toolsKey?: string; }
/** The outcome of a prompt that ran on its own while its HTTP response was already over (a suspended turn). It never rejects. */
type PromptOutcome = { result?: PromptResponse; error?: unknown };
/** A prompt in flight on a session that has the client's tools. `sink` is the request being served; its callbacks change when a later request resumes the turn. */
interface ToolTurn {
  agent: ClientContext; session: PreparedSession; model: string; bridge: BridgeSession; toolsKey: string;
  /** The request's remote MCP servers (their calls are reported as `mcpCalls`); `reported` holds the tool call ids already reported by an earlier response of the turn. */
  mcp?: McpServerSpec[]; reported: Set<string>;
  sink: GenerationCallbacks;
  /** All the agent text of the prompt so far; `segment` is where the text of the current HTTP response starts. */
  text: string; segment: number;
  tracked: Map<string, TrackedToolCall>;
  /** `tools/call`s that arrived and are not yet in a returned batch. */
  pending: HeldCall[];
  batchTimer?: NodeJS.Timeout;
  /** Set while a request waits for the next batch; called when a `tools/call` arrives. */
  arm?: () => void;
  finished?: Promise<PromptOutcome>;
  /** The cumulative usage of a reused session before this turn. */
  baseUsage?: Usage;
  cancelled: boolean;
}
/** A turn waiting for the client's tool results, found by the `call_<random>` ids it returned. */
interface SuspendedTurn { turn: ToolTurn; calls: HeldCall[]; ids: string[]; transcript: KeptMessage[]; timer: NodeJS.Timeout; }
interface AuthInflight { methodId: string; agent: ClientContext; promise: Promise<void>; }
const DEFAULT_MODE_CANDIDATES = ["read-only", "readonly"] as const;
const DEFAULT_AUTH_TIMEOUT_MS = 10_000;
const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_LOGIN_OPEN_DELAY_MS = 3_000;
const DEFAULT_RETAINED_SESSIONS = 8;
const DEFAULT_RETAINED_IDLE_MS = 10 * 60_000;
/** After the last `tools/call` of a batch, wait this long for more (only Claude sends parallel calls, 24 ms apart). */
const DEFAULT_TOOL_BATCH_MS = 150;
const DEFAULT_TOOL_RESULT_TIMEOUT_MS = 10 * 60_000;
/** The proxy gives up on a suspended call this long before the agent's own limit. */
const DEFAULT_TOOL_CALL_MARGIN_MS = 30_000;
const USAGE_FIELDS = ["inputTokens", "outputTokens", "totalTokens", "thoughtTokens", "cachedReadTokens", "cachedWriteTokens"] as const;

/** `extra` merged into `base` (plain objects recursively, arrays joined without duplicates, everything else replaced). */
function mergeMeta(base: Record<string, unknown> | undefined, extra: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!extra) return base;
  const out: Record<string, unknown> = { ...(base ?? {}) };
  for (const [key, value] of Object.entries(extra)) {
    const current = out[key];
    out[key] = Array.isArray(value) && Array.isArray(current) ? [...new Set([...current, ...value])] : value && typeof value === "object" && !Array.isArray(value) && current && typeof current === "object" && !Array.isArray(current) ? mergeMeta(current as Record<string, unknown>, value as Record<string, unknown>) : value;
  }
  return out;
}

/** An authenticate call did not finish in time; the request itself is left pending. */
class AuthTimeoutError extends Error { constructor(message: string) { super(message); this.name = "AuthTimeoutError"; } }
export interface AcpProviderOptions { workRoot: string; /** Keep a session after a completed turn for the next turn of the same conversation. */ reuseSessions?: boolean; /** Most kept sessions at once, suspended ones included (default 8). */ retainedSessions?: number; /** A kept session is disposed after this idle time (default 10 minutes). */ retainedIdleMs?: number; /** How long a turn suspended on a tool call waits for the result (default 10 minutes, cut to the agent's own limit minus the margin). */ toolResultTimeoutMs?: number; /** Quiet time after a `tools/call` before its batch is returned (default 150 ms). */ toolBatchMs?: number; /** How long before the agent's own tool call limit a suspended call is given up (default 30 s). */ toolCallMarginMs?: number; }

const AUTH_REQUIRED = -32000;

function isAuthRequired(error: unknown): boolean { return typeof error === "object" && error !== null && (error as { code?: unknown }).code === AUTH_REQUIRED; }

/** This turn's usage when the agent reports cumulative session usage: current minus previous, field by field, never below 0. */
function usageDelta(current: Usage, previous: Usage | undefined): Usage {
  if (!previous) return current;
  const delta: Usage = { ...current };
  for (const key of USAGE_FIELDS) { const value = current[key]; if (typeof value === "number") (delta as Record<string, unknown>)[key] = Math.max(0, value - (previous[key] ?? 0)); }
  return delta;
}

function withTimeout<T>(promise: Promise<T>, ms: number | undefined, message: string): Promise<T> {
  if (!ms) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

/** Flattens a select option whose values may be grouped. */
export function flattenSelectOptions(option: SessionConfigOption): ModelInfo[] {
  if (option.type !== "select") return [];
  const models: ModelInfo[] = [];
  for (const entry of option.options as Array<{ value?: string; name?: string; options?: Array<{ value: string; name?: string }> }>) {
    if (entry.options) for (const inner of entry.options) models.push({ id: inner.value, ...(inner.name ? { name: inner.name } : {}) });
    else if (entry.value !== undefined) models.push({ id: entry.value, ...(entry.name ? { name: entry.name } : {}) });
  }
  return models;
}

/** A request's MCP server as the ACP `session/new` entry: http and sse carry the URL and headers, stdio a command (settings only). */
function acpServer(spec: McpServerSpec): McpServer {
  if (spec.transport === "stdio") return { name: spec.label, command: spec.command ?? "", args: spec.args, env: spec.env };
  return { type: spec.transport, name: spec.label, url: spec.url ?? "", headers: spec.headers };
}

/** Long-lived ACP v1 connection to one agent process, with disposable sessions per generation and an optional warm pool. */
export class AcpProvider implements Provider {
  readonly id: string;
  readonly displayName: string;
  readonly ownedBy: string;
  readonly exposeUnprefixed: boolean;
  readonly staticModels?: ModelInfo[];
  /** The agent can generate images (its descriptor says so). */
  readonly imageGeneration: boolean;
  /** The agent can search the web (its descriptor says so). */
  readonly webSearchSupport: boolean;
  /** The agent can be given the client's function tools: its descriptor knows its permission rule and the proxy has a tool bridge. */
  readonly toolCalling: boolean;
  /** The agent can be given the request's remote MCP servers. */
  readonly mcpSupport: boolean;
  private child?: ChildProcessWithoutNullStreams;
  private connection?: ClientConnection;
  private agent?: ClientContext;
  private startPromise?: Promise<void>;
  private modelsInflight?: Promise<ModelInfo[]>;
  private discovered?: ModelInfo[];
  private authMethods: AuthMethodInfo[] = [];
  private state: ProviderState = "stopped";
  private error?: string;
  private agentVersion?: string;
  /** `agentCapabilities.promptCapabilities.image` of the running agent (undefined until initialize). */
  private imageInput?: boolean;
  /** `agentCapabilities.mcpCapabilities` of the running agent: which remote MCP transports it accepts in `session/new`. */
  private mcpCaps?: { http: boolean; sse: boolean };
  private account?: string;
  /** `agentCapabilities.auth.logout` of the running agent: it implements ACP `logout`. */
  private logoutAdvertised = false;
  /** Counts the agent's `_auth/status_update` pushes (logout() checks whether the agent reported the new state itself). */
  private authStatusSeq = 0;
  /** The agent reported (via _auth/status_update) that nobody is signed in. */
  private loggedOut = false;
  private loginUrl?: string;
  private loginUrlAt = 0;
  private openedUrl?: string;
  private openTimer?: NodeJS.Timeout;
  private userLogins = 0;
  private authInflight?: AuthInflight;
  /** Set while the agent cannot be used because authentication timed out or was rejected; cleared by any successful authenticate. */
  private authBlock?: unknown;
  private stderrBuffer = "";
  private generation = 0;
  private warming = 0;
  private warnedNoReadOnly = false;
  private readonly warm: PreparedSession[] = [];
  private readonly kept: KeptSession[] = [];
  private readonly handlers = new Map<string, SessionHandler>();
  /** Per-session allow rules by session id: only a request that asked for something sets one (see generate()). */
  private readonly permissionRules = new Map<string, PermissionRule>();
  /** The tool bridge session of every session that has the client's tools, by session id. */
  private readonly bridges = new Map<string, BridgeSession>();
  /** Turns waiting for tool results, once per call id (an entry shows up under each of its ids). */
  private readonly suspended = new Map<string, SuspendedTurn>();
  private readonly listeners = new Set<(status: ProviderStatus) => void>();
  private readonly log;

  constructor(private readonly descriptor: ProviderDescriptor, private readonly ctx: RuntimeContext, private readonly options: AcpProviderOptions) {
    this.id = descriptor.id;
    this.displayName = descriptor.displayName;
    this.ownedBy = descriptor.ownedBy;
    this.exposeUnprefixed = descriptor.exposeUnprefixed;
    this.staticModels = descriptor.staticModels?.map((id) => ({ id }));
    this.imageGeneration = descriptor.imageGeneration !== undefined;
    this.webSearchSupport = descriptor.webSearch !== undefined;
    this.toolCalling = descriptor.allowTool !== undefined && ctx.toolBridge !== undefined;
    this.mcpSupport = descriptor.allowTool !== undefined && descriptor.mcpTarget !== undefined;
    this.log = ctx.logger.child(`${descriptor.id}-acp`);
  }

  status(): ProviderStatus {
    // Not started yet: a provider that certainly has no login (a fresh isolated Codex home) says so without a request.
    const unstarted = this.state === "stopped" ? this.descriptor.needsLogin?.(this.ctx, process.env) : undefined;
    const state = unstarted ? "needs_login" : this.state;
    const error = unstarted ?? this.error;
    const loginHome = this.descriptor.loginHome?.(this.ctx, process.env);
    return { id: this.id, name: this.displayName, state, ...(error ? { error } : {}), features: { imageGeneration: this.imageGeneration, tools: this.toolCalling, mcp: this.mcpSupport, webSearch: this.webSearchSupport }, ...(loginHome ? { loginHome } : {}), authMethods: this.authMethods, models: this.staticModels ?? this.discovered ?? [], ...(this.loginUrl ? { loginUrl: this.loginUrl } : {}), ...(this.agentVersion ? { agentVersion: this.agentVersion } : {}), ...(this.account ? { account: this.account } : {}), ...(this.imageInput !== undefined ? { capabilities: { image: this.imageInput } } : {}) };
  }

  onStatus(listener: (status: ProviderStatus) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }

  private setState(state: ProviderState, error?: string): void {
    if (this.state === state && this.error === error) return;
    this.state = state;
    this.error = error;
    const status = this.status();
    for (const listener of this.listeners) { try { listener(status); } catch { /* listener errors must not break the provider */ } }
  }

  /** Returns a connected (and, for eager providers, authenticated) agent; throws while authentication is blocked. */
  private async start(): Promise<ClientContext> {
    const agent = await this.connect();
    if (this.authBlock) throw new ProviderAuthRequiredError(`${this.displayName} requires login.`, this.authBlock);
    return agent;
  }

  /** Returns a live agent connection without insisting that authentication succeeded (used by login()). */
  private async connect(): Promise<ClientContext> {
    if (this.agent && this.connection && !this.connection.signal.aborted) return this.agent;
    if (!this.startPromise) this.startPromise = this.doStart().finally(() => { this.startPromise = undefined; });
    await this.startPromise;
    if (!this.agent) throw new AcpUnavailableError(`${this.displayName} ACP backend is unavailable.`);
    return this.agent;
  }

  private emitStatus(): void {
    const status = this.status();
    for (const listener of this.listeners) { try { listener(status); } catch { /* listener errors must not break the provider */ } }
  }

  private clearLoginUrl(): void {
    if (this.openTimer) { clearTimeout(this.openTimer); this.openTimer = undefined; }
    if (!this.loginUrl) return;
    this.loginUrl = undefined;
    this.emitStatus();
  }

  /** A user-initiated login that is still pending `loginOpenDelayMs` after the login URL appeared opens it in the browser (once per URL). */
  private scheduleOpen(): void {
    if (this.openTimer) { clearTimeout(this.openTimer); this.openTimer = undefined; }
    const url = this.loginUrl;
    if (!this.userLogins || !url || this.openedUrl === url) return;
    const wait = Math.max(0, this.loginUrlAt + (this.descriptor.loginOpenDelayMs ?? DEFAULT_LOGIN_OPEN_DELAY_MS) - Date.now());
    this.openTimer = setTimeout(() => {
      this.openTimer = undefined;
      if (!this.userLogins || this.loginUrl !== url) return;
      this.openedUrl = url;
      this.log.info("Opening the login URL in the browser.");
      try { void Promise.resolve(this.ctx.openUrl?.(url)).catch((error) => this.log.warn(`Could not open the login URL: ${error instanceof Error ? error.message : String(error)}`)); }
      catch (error) { this.log.warn(`Could not open the login URL: ${error instanceof Error ? error.message : String(error)}`); }
    }, wait);
    this.openTimer.unref?.();
  }

  private onStderr(chunk: unknown): void {
    this.stderrBuffer += String(chunk);
    const lines = this.stderrBuffer.split(/\r?\n/);
    this.stderrBuffer = (lines.pop() ?? "").slice(-65536);
    const level = this.descriptor.stderrLogLevel ?? "info";
    for (const line of lines) {
      if (!line.trim()) continue;
      this.log[level](line);
      const match = this.descriptor.loginUrlPattern?.exec(line);
      const url = match ? match[1] ?? match[0] : undefined;
      if (url && url !== this.loginUrl) {
        this.loginUrl = url; this.loginUrlAt = Date.now();
        this.log.debug("Captured the login URL.");
        this.emitStatus();
        this.scheduleOpen();
      }
    }
  }

  /** Marks authentication as unusable without touching the pending request, so a later login() can still complete it. */
  private blockAuth(error: unknown): void {
    this.authBlock = error;
    const reason = error instanceof Error ? error.message : String(error);
    if (this.loginUrl && error instanceof AuthTimeoutError) this.log.warn(`Login required. Open this URL to sign in: ${this.loginUrl}`);
    this.setState("needs_login", reason);
  }

  /** Runs authenticate once per method: concurrent callers (eager start, a user login) share the same in-flight request. */
  private runAuth(agent: ClientContext, methodId: string, user: boolean): Promise<void> {
    let inflight = this.authInflight;
    if (!inflight || inflight.methodId !== methodId || inflight.agent !== agent) {
      const created: AuthInflight = { methodId, agent, promise: agent.request(methods.agent.authenticate, { methodId }).then(() => undefined) };
      inflight = created;
      this.authInflight = created;
      created.promise.then(() => {
        if (this.authInflight === created) this.authInflight = undefined;
        if (this.agent !== agent) return;
        this.authBlock = undefined;
        this.clearLoginUrl();
        if (this.state === "needs_login") this.setState("ready");
      }, () => { if (this.authInflight === created) this.authInflight = undefined; });
    }
    const ms = user ? this.descriptor.loginTimeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS : this.descriptor.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS;
    const message = `${this.displayName} authentication did not complete within ${Math.round(ms / 1000)}s.`;
    const target = inflight.promise;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new AuthTimeoutError(message)), ms);
      target.then(() => { clearTimeout(timer); resolve(); }, (error) => { clearTimeout(timer); reject(error); });
    });
  }

  private async doStart(): Promise<void> {
    const descriptor = this.descriptor;
    this.setState("starting");
    const preflight = await descriptor.preflight?.(this.ctx);
    if (preflight) {
      this.setState(preflight.state, preflight.message);
      throw preflight.state === "terms_required" ? new ProviderTermsRequiredError(preflight.message) : new ProviderNotInstalledError(preflight.message);
    }
    await mkdir(this.options.workRoot, { recursive: true });
    if (this.child) await killProcessTree(this.child);
    try { await descriptor.beforeStart?.(this.ctx); } catch (error) { this.log.warn(`Pre-start step failed: ${error instanceof Error ? error.message : String(error)}`); }
    const spec = await descriptor.launch(this.ctx);
    const child = spawn(spec.command, spec.args, { stdio: ["pipe", "pipe", "pipe"], env: spec.env ?? process.env, cwd: spec.cwd, windowsHide: true, detached: process.platform !== "win32" });
    this.child = child;
    this.loginUrl = undefined; this.openedUrl = undefined; this.agentVersion = undefined; this.authInflight = undefined; this.authBlock = undefined; this.stderrBuffer = ""; this.account = undefined; this.loggedOut = false; this.imageInput = undefined; this.mcpCaps = undefined; this.logoutAdvertised = false;
    const childFailure = new Promise<never>((_, reject) => child.once("error", reject));
    childFailure.catch(() => undefined);
    child.stderr.on("data", (chunk) => this.onStderr(chunk));
    const stream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>);
    const agentRef: { current?: ClientContext } = {};
    const app = client({ name: "api-acp-proxy" });
    app.onRequest(methods.client.session.requestPermission, async ({ params }) => this.answerPermission(params));
    app.onNotification(methods.client.session.update, ({ params }) => { this.handlers.get(params.sessionId)?.(params.update); });
    app.onNotification("_auth/status_update", (params: unknown) => params as { authStatus?: { kind?: string; label?: string } }, ({ params }) => { if (this.agent === agentRef.current) this.onAuthStatus(params.authStatus); });
    const connection = app.connect(stream);
    this.connection = connection;
    this.agent = connection.agent;
    agentRef.current = connection.agent;
    child.once("exit", () => {
      if (this.child !== child) return;
      this.connection = undefined; this.agent = undefined; this.child = undefined;
      this.generation++;
      this.authInflight = undefined;
      this.dropWarm();
      void this.dropKept();
      void this.dropSuspended();
      if (this.state === "ready") this.setState("stopped");
    });
    let authStep = false;
    try {
      const initialized = await Promise.race([this.agent.request(methods.agent.initialize, { protocolVersion: 1, clientInfo: { name: "api-acp-proxy", version: "0.1.0" }, clientCapabilities: {} }), childFailure]);
      this.authMethods = (initialized.authMethods ?? []).map((method) => ({ id: method.id, name: method.name, ...(method.description ? { description: method.description } : {}), ...("type" in method && method.type ? { type: String(method.type) } : {}) }));
      if (!this.authMethods.length && descriptor.loginMethods) this.authMethods = descriptor.loginMethods;
      this.imageInput = initialized.agentCapabilities?.promptCapabilities?.image === true;
      this.logoutAdvertised = initialized.agentCapabilities?.auth?.logout != null;
      const mcpCaps = initialized.agentCapabilities?.mcpCapabilities;
      this.mcpCaps = { http: mcpCaps?.http === true, sse: mcpCaps?.sse === true };
      const version = initialized.agentInfo?.version;
      if (version) { this.agentVersion = version; this.emitStatus(); }
      if (descriptor.authMode === "eager") {
        const methodId = descriptor.chooseAuth(this.authMethods, process.env);
        if (methodId) {
          authStep = true;
          try { await this.runAuth(this.agent, methodId, false); } catch (error) {
            // Interactive OAuth blocks until the user finishes in a browser, and a rejected method may be replaced by another one: keep the process (and a pending request) for login().
            this.blockAuth(error);
            return;
          }
        } else {
          const required = descriptor.loginRequired?.(this.authMethods, process.env);
          if (required) { this.blockAuth(new ProviderAuthRequiredError(required)); return; }
        }
      }
      if (this.loggedOut) this.setState("needs_login", "Not logged in."); else this.setState("ready");
    } catch (error) {
      connection.close(error);
      void killProcessTree(child);
      this.connection = undefined; this.agent = undefined; this.child = undefined;
      const missing = (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
      const message = `Unable to initialize the ${this.displayName} ACP backend.`;
      this.setState(authStep ? "needs_login" : missing ? "not_installed" : "error", error instanceof Error ? error.message : String(error));
      if (authStep) throw new ProviderAuthRequiredError(message, error);
      throw missing ? new ProviderNotInstalledError(message, error) : new AcpUnavailableError(message, error);
    }
  }

  /** Cancelled, unless the session's rule allows the request and it offers an `allow_once` option: the proxy never picks allow_always or any other option. */
  private answerPermission(params: RequestPermissionRequest): { outcome: { outcome: "cancelled" } } | { outcome: { outcome: "selected"; optionId: string } } {
    let allowed = false;
    try { allowed = this.permissionRules.get(params.sessionId)?.(params) === true; } catch { /* a failing rule means cancelled */ }
    const option = allowed ? params.options.find((candidate) => candidate.kind === "allow_once") : undefined;
    this.log.debug(`Permission request (kind ${params.toolCall.kind ?? "?"}, title '${params.toolCall.title ?? "?"}'): ${option ? "allowed once" : "cancelled"}.`);
    return option ? { outcome: { outcome: "selected", optionId: option.optionId } } : { outcome: { outcome: "cancelled" } };
  }

  /** Handles the agent's _auth/status_update push: kind "none" means logged out, anything else carries the account label. */
  private onAuthStatus(status: { kind?: string; label?: string } | undefined): void {
    if (!status || typeof status.kind !== "string") return;
    this.authStatusSeq++;
    if (status.kind === "none") { this.account = undefined; this.loggedOut = true; this.setState("needs_login", "Not logged in."); return; }
    this.loggedOut = false;
    this.account = typeof status.label === "string" && status.label ? status.label : undefined;
    if (this.state === "needs_login" && !this.authInflight && !this.authBlock) this.setState("ready"); else this.emitStatus();
  }

  private dropWarm(): void {
    for (const session of this.warm.splice(0)) void rm(session.cwd, { recursive: true, force: true }).catch(() => undefined);
  }

  /** Gives up every turn that waits for tool results: its held calls get an error, the turn is cancelled and the session disposed. */
  private async dropSuspended(): Promise<void> {
    const entries = [...new Set(this.suspended.values())];
    this.suspended.clear();
    await Promise.all(entries.map((entry) => { clearTimeout(entry.timer); return this.dropTurn(entry.turn, "The proxy stopped before the tool result arrived."); }));
  }

  private async dropKept(): Promise<void> {
    await Promise.all(this.kept.splice(0).map((entry) => { clearTimeout(entry.timer); return this.disposeSession(entry.agent, entry.session); }));
  }

  /** Keeps a session after a completed turn; the oldest one is evicted over the cap and an idle one is disposed after retainedIdleMs. */
  private keep(agent: ClientContext, session: PreparedSession, model: string, transcript: KeptMessage[], usage: Usage | undefined, bridge?: BridgeSession, toolsKey?: string): void {
    const limit = Math.max(1, this.options.retainedSessions ?? DEFAULT_RETAINED_SESSIONS);
    while (this.kept.length > 0 && this.kept.length + this.suspendedCount() >= limit) { const oldest = this.kept.shift()!; clearTimeout(oldest.timer); void this.disposeSession(oldest.agent, oldest.session); }
    // Turns waiting for tool results count against the cap too, and are not given up for a finished conversation.
    if (this.kept.length + this.suspendedCount() >= limit) { void this.disposeSession(agent, session); return; }
    this.permissionRules.delete(session.sessionId);
    if (bridge) bridge.onCall = undefined;
    const entry: KeptSession = { agent, session, model, transcript, usage, ...(bridge ? { bridge, toolsKey } : {}), timer: setTimeout(() => {
      const index = this.kept.indexOf(entry);
      if (index >= 0) { this.kept.splice(index, 1); void this.disposeSession(agent, session); }
    }, this.options.retainedIdleMs ?? DEFAULT_RETAINED_IDLE_MS) };
    entry.timer.unref?.();
    this.handlers.delete(session.sessionId);
    this.kept.push(entry);
  }

  /** Removes and returns the kept session whose transcript is the request's history up to its last assistant message, with the messages after it. */
  private takeKept(agent: ClientContext, model: string, messages: Message[], toolsKey?: string): { entry: KeptSession; fresh: Message[] } | undefined {
    const last = messages.map((message) => message.role).lastIndexOf("assistant");
    if (last < 0 || last + 1 >= messages.length) return undefined;
    const sentHistory = messages.slice(0, last + 1).map(toKept);
    // A session that has the client's tools is only reused for a request with the same tools, and a plain request never takes one.
    const index = this.kept.findIndex((entry) => entry.agent === agent && entry.model === model && entry.toolsKey === toolsKey && sameTranscript(entry.transcript, sentHistory));
    if (index < 0) return undefined;
    const [entry] = this.kept.splice(index, 1);
    clearTimeout(entry!.timer);
    return { entry: entry!, fresh: messages.slice(last + 1) };
  }

  private async stop(): Promise<void> {
    const { child, connection } = this;
    this.connection = undefined; this.agent = undefined; this.child = undefined;
    this.generation++;
    this.authInflight = undefined; this.authBlock = undefined;
    if (this.openTimer) { clearTimeout(this.openTimer); this.openTimer = undefined; }
    this.dropWarm();
    await this.dropKept();
    await this.dropSuspended();
    connection?.close();
    if (child) await killProcessTree(child);
    this.loginUrl = undefined;
    if (this.state === "ready" || this.state === "starting") this.setState("stopped");
    try { await this.descriptor.afterStop?.(this.ctx); } catch (error) { this.log.warn(`Post-stop step failed: ${error instanceof Error ? error.message : String(error)}`); }
  }

  /** Runs a request; on auth_required it authenticates (when a method can be chosen without interaction) and retries once. */
  private async withAuth<T>(agent: ClientContext, run: () => Promise<T>): Promise<T> {
    try { return await run(); } catch (error) {
      if (!isAuthRequired(error)) throw error;
      const methodId = this.descriptor.chooseAuth(this.authMethods, process.env);
      if (!methodId) { this.setState("needs_login", "Login required."); throw new ProviderAuthRequiredError(`${this.displayName} requires login.`, error); }
      try { await this.runAuth(agent, methodId, false); } catch (authError) {
        this.blockAuth(authError);
        throw new ProviderAuthRequiredError(`${this.displayName} requires login.`, authError);
      }
      try { return await run(); } catch (retryError) {
        if (isAuthRequired(retryError)) { this.setState("needs_login", "Login required."); throw new ProviderAuthRequiredError(`${this.displayName} requires login.`, retryError); }
        throw retryError;
      }
    }
  }

  /** `bridge`: the session also gets the client's tools as the MCP server `client`; `mcp`: the request's remote MCP servers. The descriptor's `mcpSessionMeta` is merged into the session `_meta` for either, its `webSearch.sessionMeta` for `search`. */
  private async createSession(agent: ClientContext, bridge?: BridgeSession, mcp?: McpServerSpec[], search = false): Promise<PreparedSession> {
    const cwd = await mkdtemp(path.join(this.options.workRoot, "request-"));
    try {
      const withMcp = bridge || mcp?.length ? mergeMeta(this.descriptor.sessionMeta, this.descriptor.mcpSessionMeta?.([...(bridge ? [{ label: BRIDGE_SERVER_NAME }] : []), ...(mcp ?? []).map(({ label, allowedTools }) => ({ label, ...(allowedTools ? { tools: allowedTools } : {}) }))])) : this.descriptor.sessionMeta;
      const meta = search ? mergeMeta(withMcp, this.descriptor.webSearch?.sessionMeta) : withMcp;
      const mcpServers: McpServer[] = [...(bridge ? [{ type: "http" as const, name: BRIDGE_SERVER_NAME, url: bridge.url, headers: [] }] : []), ...(mcp ?? []).map(acpServer)];
      const session = await this.withAuth(agent, () => withTimeout(agent.request(methods.agent.session.new, { cwd, mcpServers, ...(meta ? { _meta: meta } : {}) }), this.descriptor.sessionTimeoutMs, `${this.displayName} session creation timed out.`));
      if (bridge) this.bridges.set(session.sessionId, bridge);
      if (this.state === "needs_login" && !this.loggedOut) this.setState("ready");
      this.authBlock = undefined;
      this.descriptor.onSessionCreated?.(session.sessionId);
      const modelOption = (session.configOptions || []).find((option) => option.category === "model" || option.id.toLowerCase().includes("model"));
      if (modelOption) {
        const models = flattenSelectOptions(modelOption);
        if (models.length) { this.discovered = models; this.emitModels(); }
      }
      const available = session.modes?.availableModes ?? [];
      const readOnlyModeId = (this.descriptor.modeCandidates ?? DEFAULT_MODE_CANDIDATES).find((candidate) => available.some((mode) => mode.id === candidate));
      return { sessionId: session.sessionId, cwd, modelOptionId: modelOption?.id, readOnlyModeId };
    } catch (error) {
      await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  private emitModels(): void { this.emitStatus(); }

  private async disposeSession(agent: ClientContext, session: PreparedSession): Promise<void> {
    this.handlers.delete(session.sessionId);
    this.permissionRules.delete(session.sessionId);
    this.bridges.get(session.sessionId)?.dispose();
    this.bridges.delete(session.sessionId);
    try { await agent.request(methods.agent.session.delete, { sessionId: session.sessionId }); } catch { /* best effort cleanup */ }
    await rm(session.cwd, { recursive: true, force: true }).catch(() => undefined);
    try { await this.descriptor.onSessionDisposed?.(session.cwd); } catch { /* best effort cleanup */ }
  }

  private refillWarm(): void {
    const wanted = this.descriptor.warmSessions ?? 0;
    const agent = this.agent;
    if (!wanted || !agent) return;
    while (this.warm.length + this.warming < wanted) {
      this.warming++;
      const generation = this.generation;
      void this.createSession(agent)
        .then((session) => { if (generation === this.generation && this.agent === agent) this.warm.push(session); else void this.disposeSession(agent, session); })
        .catch((error) => this.log.debug(`Warm session failed: ${error instanceof Error ? error.message : String(error)}`))
        .finally(() => { this.warming--; });
    }
  }

  async listModels(options: { force?: boolean } = {}): Promise<ModelInfo[]> {
    if (this.staticModels) return this.staticModels;
    if (this.discovered && !options.force) return this.discovered;
    if (!this.modelsInflight) {
      this.modelsInflight = (async () => {
        const agent = await this.start();
        const session = options.force ? await this.createSession(agent) : this.warm.shift() ?? await this.createSession(agent);
        if (this.warm.length + this.warming < (this.descriptor.warmSessions ?? 0)) this.warm.push(session); else await this.disposeSession(agent, session);
        return this.discovered ?? [];
      })().finally(() => { this.modelsInflight = undefined; });
    }
    return this.modelsInflight;
  }

  /** Runs descriptor.externalLogin (e.g. a console window), then restarts the agent so a fresh initialize re-probes authentication. */
  private async externalLogin(methodId: string | undefined): Promise<void> {
    const descriptor = this.descriptor;
    const chosen = methodId ?? descriptor.chooseAuth(this.authMethods, process.env) ?? descriptor.loginMethods?.[0]?.id;
    if (!chosen) throw new AcpUnavailableError(`${this.displayName} has no login method.`);
    this.userLogins++;
    try {
      await withTimeout(descriptor.externalLogin!(this.ctx, chosen), descriptor.loginTimeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS, `${this.displayName} login did not complete within ${Math.round((descriptor.loginTimeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS) / 1000)}s.`);
    } catch (error) {
      this.setState("needs_login", error instanceof Error ? error.message : String(error));
      throw new ProviderAuthRequiredError(`${this.displayName} login failed.`, error);
    } finally { this.userLogins--; }
    await this.stop();
    await this.connect();
    try { descriptor.onLoginSuccess?.(chosen); } catch (error) { this.log.warn(`Login hook failed: ${error instanceof Error ? error.message : String(error)}`); }
  }

  async login(methodId?: string): Promise<void> {
    if (this.descriptor.externalLogin) return this.externalLogin(methodId);
    const agent = await this.connect();
    const usable = this.authMethods.filter((method) => method.type !== "terminal");
    const preferred = this.descriptor.defaultLoginMethod;
    const chosen = methodId ?? this.descriptor.chooseAuth(this.authMethods, process.env) ?? (preferred && usable.some((method) => method.id === preferred) ? preferred : undefined) ?? usable[0]?.id;
    if (!chosen) throw new AcpUnavailableError(`${this.displayName} did not advertise a usable authentication method.`);
    if (this.authMethods.find((method) => method.id === chosen)?.type === "terminal") throw new AcpUnavailableError(`The '${chosen}' authentication method requires a terminal and is not supported.`);
    this.userLogins++;
    this.scheduleOpen();
    try { await this.runAuth(agent, chosen, true); } catch (error) {
      if (this.agent === agent) this.blockAuth(error);
      throw new ProviderAuthRequiredError(`${this.displayName} login failed.`, error);
    } finally {
      if (--this.userLogins === 0 && this.openTimer) { clearTimeout(this.openTimer); this.openTimer = undefined; }
    }
    this.authBlock = undefined;
    this.clearLoginUrl();
    this.setState("ready");
    try { this.descriptor.onLoginSuccess?.(chosen); } catch (error) { this.log.warn(`Login hook failed: ${error instanceof Error ? error.message : String(error)}`); }
  }

  /**
   * Signs the agent out and leaves the provider in `needs_login` with no kept or warm session. The agent's ACP `logout` is used when it advertises it;
   * otherwise the descriptor's fallback runs between a stop and a restart. `afterLogout` runs either way.
   */
  async logout(): Promise<void> {
    const descriptor = this.descriptor;
    const agent = await this.connect();
    const hand = this.logoutAdvertised ? undefined : descriptor.logoutFallback;
    if (!this.logoutAdvertised && !hand) throw new AcpUnavailableError(`${this.displayName} cannot be logged out from here.`);
    this.log.info("Logging out.");
    if (hand) {
      await this.stop();
      try { await hand(this.ctx, process.env); } finally { try { await descriptor.afterLogout?.(this.ctx, process.env); } catch (error) { this.log.warn(`Post-logout step failed: ${error instanceof Error ? error.message : String(error)}`); } }
      this.account = undefined;
      // A fresh initialize re-probes the login (a Codex home without a login is needs_login without opening a browser).
      await this.connect();
      return;
    }
    const seen = this.authStatusSeq;
    this.dropWarm();
    await this.dropKept();
    await this.dropSuspended();
    await agent.request(methods.agent.logout, {});
    try { await descriptor.afterLogout?.(this.ctx, process.env); } catch (error) { this.log.warn(`Post-logout step failed: ${error instanceof Error ? error.message : String(error)}`); }
    this.account = undefined;
    this.generation++;
    // An agent that pushes its auth status (Claude) says itself whether a login is left (an API key from the environment survives); for the others the logout is final.
    // An agent that signs in by itself on a request (eager) is blocked until the user logs in, so a request cannot start a browser login behind the user's back; an on-demand one (Claude) is asked again, so a login made elsewhere is picked up.
    if (this.authStatusSeq === seen) await new Promise((resolve) => setTimeout(resolve, 50));
    const silent = this.authStatusSeq === seen;
    if (silent || (this.loggedOut && descriptor.authMode === "eager")) this.authBlock = new ProviderAuthRequiredError(`${this.displayName} was logged out.`);
    if (silent) this.setState("needs_login", "Logged out."); else this.emitStatus();
  }

  /** An auth_required error from the agent means the user must log in: surface it as ProviderAuthRequiredError. */
  private async authGuard<T>(run: () => Promise<T>): Promise<T> {
    try { return await run(); } catch (error) {
      if (!isAuthRequired(error)) throw error;
      this.setState("needs_login", "Login required.");
      throw new ProviderAuthRequiredError(`${this.displayName} requires login.`, error);
    }
  }

  /** Selects the model and the read-only mode of a new session; false when the request was cancelled meanwhile. */
  private async configureSession(agent: ClientContext, session: PreparedSession, model: string, aborted: () => boolean): Promise<boolean> {
    if (!session.modelOptionId) throw new AcpUnavailableError(`The ${this.displayName} ACP backend did not advertise a model configuration option.`);
    await this.authGuard(() => agent.request(methods.agent.session.setConfigOption, { sessionId: session.sessionId, configId: session.modelOptionId!, value: model }));
    if (aborted()) return false;
    if (session.readOnlyModeId) await agent.request(methods.agent.session.setMode, { sessionId: session.sessionId, modeId: session.readOnlyModeId });
    else if (this.descriptor.readOnlyMode === "required") throw new AcpUnavailableError(`The ${this.displayName} ACP backend did not advertise a read-only mode.`);
    else if (!this.warnedNoReadOnly) { this.warnedNoReadOnly = true; this.log.warn("No read-only mode advertised; relying on cancelled permissions and the text-only prompt."); }
    return true;
  }

  async generate(model: string, messages: Message[], callbacks: GenerationCallbacks = {}, signal?: AbortSignal, options?: GenerateOptions): Promise<GenerationResult> {
    if (options?.tools?.length) return this.generateWithTools(model, messages, callbacks, signal, options);
    let agent: ClientContext | undefined;
    let session: PreparedSession | undefined;
    let aborted = signal?.aborted ?? false;
    let promptSent = false;
    let reused: KeptSession | undefined;
    let keepWith: { transcript: KeptMessage[]; usage?: Usage } | undefined;
    let fresh = messages;
    const cancelled = (): GenerationResult => ({ text: "", stopReason: "cancelled", usage: null });
    const abort = async () => {
      aborted = true;
      if (!session || !agent) return;
      try { await agent.notify(methods.agent.session.cancel, { sessionId: session.sessionId }); } catch { /* connection may already be gone */ }
    };
    signal?.addEventListener("abort", abort, { once: true });
    let text = "";
    const wantImages = options?.images === true;
    const imageSupport = this.descriptor.imageGeneration;
    const generated: GeneratedImage[] = [];
    const reportedFiles = new Set<string>();
    // Remote MCP servers: a fresh session of their own (never warm, never kept); the agent calls them inside its turn.
    const mcp = options?.mcpServers?.length ? options.mcpServers : undefined;
    // Web search: also a fresh session of its own (it may need session options), never kept; the agent searches inside its turn.
    const search = options?.webSearch;
    const mcpTracked = new Map<string, TrackedToolCall>();
    try {
      if (wantImages && !imageSupport) throw new ApiError(400, "model_not_capable", `${this.displayName} cannot generate images.`, "model");
      if (search && !this.descriptor.webSearch) throw new ApiError(400, "model_not_capable", `${this.displayName} cannot search the web.`, "model");
      if (search && wantImages) throw new ApiError(400, "unsupported_parameter", "Web search cannot be combined with image generation.", "tools");
      if (mcp && !this.mcpSupport) throw new ApiError(400, "model_not_capable", `${this.displayName} cannot call MCP servers through this proxy.`, "model");
      agent = await this.start();
      if (aborted) return cancelled();
      if (hasImages(messages) && !this.imageInput) throw new ApiError(400, "unsupported_content", `${this.displayName} does not accept image input.`, "messages");
      if (mcp) this.assertMcpTransports(mcp);
      const hit = this.options.reuseSessions && !wantImages && !mcp && !search ? this.takeKept(agent, model, messages) : undefined;
      if (hit) { reused = hit.entry; session = reused.session; fresh = hit.fresh; }
      else if (mcp || search) session = await this.createSession(agent, undefined, mcp, search !== undefined);
      else { session = this.warm.shift() ?? await this.createSession(agent); this.refillWarm(); }
      if (aborted) return cancelled();
      const sid = session.sessionId;
      this.handlers.set(sid, (update) => {
        if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
          text += update.content.text;
          callbacks.onText?.(update.content.text);
        } else if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
          if (mcp || search) trackToolCall(mcpTracked, update);
          if (!mcp && imageSupport && update.sessionUpdate === "tool_call_update" && update.status === "completed") this.takeImages(update, wantImages ? generated : undefined, reportedFiles);
        }
      });
      if (wantImages && imageSupport?.allow) this.permissionRules.set(sid, imageSupport.allow);
      if (mcp || search) this.permissionRules.set(sid, this.toolRule(mcp ? this.mcpAccess(mcp, false) : undefined, mcpTracked, search !== undefined));
      if (!reused && !await this.configureSession(agent, session, model, () => aborted)) return cancelled();
      if (aborted) return cancelled();
      promptSent = true;
      const prompt: ContentBlock[] = buildPrompt(fresh, options?.instructions, this.descriptor.promptPreamble, wantImages, mcp ? { client: false, mcp: mcp.map(({ label, allowedTools }) => ({ label, ...(allowedTools ? { tools: allowedTools } : {}) })) } : undefined, search);
      const result = await this.authGuard(() => agent!.request(methods.agent.session.prompt, { sessionId: sid, prompt }));
      let usage = result.usage ?? null;
      let cumulative = reused?.usage;
      if (usage && this.descriptor.usageScope === "session") { cumulative = usage; usage = usageDelta(usage, reused?.usage); }
      if (this.options.reuseSessions && !wantImages && !mcp && !search && result.stopReason === "end_turn" && !aborted) keepWith = { transcript: [...messages.map(toKept), { role: "assistant", text, images: [] }], usage: cumulative };
      const mcpCalls = mcp ? this.collectMcpCalls(mcpTracked, mcp.map((server) => server.label), undefined, true) : [];
      const searches = search ? this.collectSearches(mcpTracked, undefined, true) : [];
      return { text, stopReason: result.stopReason, usage, ...(wantImages ? { images: generated } : {}), ...(mcpCalls.length ? { mcpCalls } : {}), ...(search ? { searches } : {}) };
    } catch (error) {
      if (aborted && !promptSent) return cancelled();
      if (aborted) throw new AcpUnavailableError("The request was cancelled.", error);
      const mapped = this.descriptor.mapError?.(error, model);
      if (mapped) throw mapped;
      if (error instanceof AcpUnavailableError || error instanceof ApiError) throw error;
      throw new AcpUnavailableError(`The ${this.displayName} ACP backend failed to process the request.`, error);
    } finally {
      signal?.removeEventListener("abort", abort);
      if (session) this.permissionRules.delete(session.sessionId);
      if (imageSupport && reportedFiles.size) await this.deleteImageFiles(imageSupport, reportedFiles);
      if (session && agent) {
        if (keepWith && !aborted && this.agent === agent) this.keep(agent, session, model, keepWith.transcript, keepWith.usage);
        else await this.disposeSession(agent, session);
      }
    }
  }

  // --- remote MCP servers ------------------------------------------------------------------------------------------------

  /** A server over a transport the agent did not say it supports (`initialize` `mcpCapabilities`, for example Codex has no sse) is a 400. */
  private assertMcpTransports(servers: McpServerSpec[]): void {
    for (const server of servers) {
      if ((server.transport === "http" || server.transport === "sse") && this.mcpCaps?.[server.transport] !== true) throw new ApiError(400, "unsupported_parameter", `${this.displayName} does not support MCP servers over ${server.transport === "sse" ? "SSE" : "HTTP"} (server '${server.label}').`, "tools");
    }
  }

  /** What the session's tools may reach: the `client` bridge (all its tools) and each remote server with the tools the request allows. */
  private mcpAccess(servers: McpServerSpec[] | undefined, bridge: boolean): McpAccess {
    const filters = new Map((servers ?? []).map((server) => [server.label, server.allowedTools] as const));
    return { labels: [...(bridge ? [BRIDGE_SERVER_NAME] : []), ...filters.keys()], allows: (server, tool) => server === BRIDGE_SERVER_NAME ? bridge : filters.has(server) && (filters.get(server) === undefined || filters.get(server)!.includes(tool)) };
  }

  /** The permission rule of a session that has MCP servers: the descriptor decides for each request from the call's tracked fields. */
  private mcpRule(access: McpAccess, tracked: Map<string, TrackedToolCall>): PermissionRule {
    return (request) => this.descriptor.allowTool?.(request, tracked.get(request.toolCall.toolCallId), access) === true;
  }

  /** The rule of a session that has MCP servers (`mcp`) and/or web search: an MCP tool as `mcpRule` decides, the search tool as the descriptor's `webSearch.allow` does; anything else is cancelled. */
  private toolRule(mcp: McpAccess | undefined, tracked: Map<string, TrackedToolCall>, search: boolean): PermissionRule {
    const forMcp = mcp ? this.mcpRule(mcp, tracked) : undefined;
    const allowSearch = search ? this.descriptor.webSearch?.allow : undefined;
    return (request) => forMcp?.(request) === true || allowSearch?.(request, tracked.get(request.toolCall.toolCallId)) === true;
  }

  /** The web searches in `tracked` that were not reported yet. Only finished ones, unless `final` (the turn is over: a search that never finished counts as failed). */
  private collectSearches(tracked: Map<string, TrackedToolCall>, reported: Set<string> | undefined, final: boolean): WebSearchResult[] {
    const out: WebSearchResult[] = [];
    for (const call of tracked.values()) {
      if (reported?.has(call.toolCallId)) continue;
      const found = this.descriptor.webSearch?.search(call);
      if (!found) continue;
      const finished = call.status === "completed" || call.status === "failed";
      if (!finished && !final) continue;
      reported?.add(call.toolCallId);
      out.push({ query: found.query, status: call.status === "completed" ? "completed" : "failed", ...(found.sources?.length ? { sources: found.sources } : {}) });
    }
    return out;
  }

  /** The calls to the remote MCP servers in `tracked` that were not reported yet. Only finished calls, unless `final` (the turn is over: a call that never finished is `incomplete`). */
  private collectMcpCalls(tracked: Map<string, TrackedToolCall>, labels: readonly string[], reported: Set<string> | undefined, final: boolean): McpCallResult[] {
    const out: McpCallResult[] = [];
    for (const call of tracked.values()) {
      if (reported?.has(call.toolCallId)) continue;
      const target = this.descriptor.mcpTarget?.(call, labels);
      if (!target) continue;
      const finished = call.status === "completed" || call.status === "failed";
      if (!finished && !final) continue;
      reported?.add(call.toolCallId);
      const { output, error } = toolOutput(call);
      out.push({ server: target.server, name: target.tool, arguments: JSON.stringify(target.arguments ?? {}), output: finished ? output : null, error: finished ? error : null, status: finished ? call.status as "completed" | "failed" : "incomplete" });
    }
    return out;
  }

  // --- function calling through the MCP bridge -------------------------------------------------------------------------

  private suspendedCount(): number { return new Set(this.suspended.values()).size; }

  /** How long a suspended call waits for the client: the setting, cut to the agent's own limit minus the margin. */
  private resultTimeoutMs(): number {
    const configured = this.options.toolResultTimeoutMs ?? DEFAULT_TOOL_RESULT_TIMEOUT_MS;
    const limit = this.descriptor.toolCallLimitMs;
    return limit === undefined ? configured : Math.max(1, Math.min(configured, limit - (this.options.toolCallMarginMs ?? DEFAULT_TOOL_CALL_MARGIN_MS)));
  }

  /** The state of a prompt that has the client's tools: its update handler (text goes to the current sink, tool calls are only tracked and never forwarded), its permission rule and the bridge's call hook. */
  private newTurn(agent: ClientContext, session: PreparedSession, model: string, bridge: BridgeSession, toolsKey: string, sink: GenerationCallbacks, baseUsage: Usage | undefined, mcp?: McpServerSpec[], search = false): ToolTurn {
    const turn: ToolTurn = { agent, session, model, bridge, toolsKey, ...(mcp ? { mcp } : {}), reported: new Set(), sink, text: "", segment: 0, tracked: new Map(), pending: [], cancelled: false, baseUsage };
    this.handlers.set(session.sessionId, (update) => {
      if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") { turn.text += update.content.text; turn.sink.onText?.(update.content.text); }
      else if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") trackToolCall(turn.tracked, update);
    });
    this.permissionRules.set(session.sessionId, this.toolRule(this.mcpAccess(mcp, true), turn.tracked, search));
    bridge.onCall = (call) => { turn.pending.push(call); turn.arm?.(); };
    return turn;
  }

  /** Waits for the prompt to end or for a batch of tool calls (they are collected until `toolBatchMs` after the latest one). */
  private nextOutcome(turn: ToolTurn): Promise<{ done: PromptOutcome } | { calls: HeldCall[] }> {
    return new Promise((resolve) => {
      let over = false;
      const settle = (value: { done: PromptOutcome } | { calls: HeldCall[] }) => { if (over) return; over = true; turn.arm = undefined; clearTimeout(turn.batchTimer); resolve(value); };
      const arm = () => { clearTimeout(turn.batchTimer); turn.batchTimer = setTimeout(() => settle({ calls: turn.pending.splice(0).filter((call) => !call.closed) }), this.options.toolBatchMs ?? DEFAULT_TOOL_BATCH_MS); };
      void turn.finished!.then((done) => settle({ done }));
      turn.arm = arm;
      if (turn.pending.length) arm();
    });
  }

  /** Cancels a turn: its held calls get an error so the agent is not left waiting, and the agent is told to stop. */
  private async cancelTurn(turn: ToolTurn, reason = "The request was cancelled."): Promise<void> {
    turn.cancelled = true;
    // Cancel first, so an agent that gets the error result does not go on with the turn.
    try { await turn.agent.notify(methods.agent.session.cancel, { sessionId: turn.session.sessionId }); } catch { /* connection may already be gone */ }
    for (const call of [...turn.pending.splice(0), ...turn.bridge.openCalls()]) call.settle(reason, true);
  }

  /** Gives a turn up: cancel it, let its prompt end, dispose the session. */
  private async dropTurn(turn: ToolTurn, reason: string): Promise<void> {
    await this.cancelTurn(turn, reason);
    await turn.finished?.catch(() => undefined);
    await this.disposeSession(turn.agent, turn.session);
  }

  /** The suspended turn that this request's history answers: it ends with the assistant message that carries the turn's tool calls, followed by one tool message per call, after exactly the history the turn had. */
  private takeSuspended(agent: ClientContext, model: string, messages: Message[], toolsKey: string): { entry: SuspendedTurn; results: Map<string, string> } | undefined {
    const last = messages.map((message) => message.role).lastIndexOf("assistant");
    const calls = messages[last]?.toolCalls;
    if (last < 0 || !calls?.length) return undefined;
    const entry = this.suspended.get(calls[0]!.id);
    if (!entry || entry.turn.agent !== agent || entry.turn.model !== model || entry.turn.toolsKey !== toolsKey) return undefined;
    const answers = messages.slice(last + 1);
    if (answers.length !== entry.ids.length || answers.some((message) => message.role !== "tool")) return undefined;
    const results = new Map(answers.map((message) => [message.toolCallId ?? "", messageText(message)] as const));
    if (results.size !== entry.ids.length || !entry.ids.every((id) => results.has(id)) || calls.length !== entry.ids.length || !calls.every((call) => entry.ids.includes(call.id))) return undefined;
    if (!sameTranscript(entry.transcript, messages.slice(0, last + 1).map(toKept))) return undefined;
    for (const id of entry.ids) this.suspended.delete(id);
    clearTimeout(entry.timer);
    return { entry, results };
  }

  /** The turn's request ends with these tool calls; the turn (prompt, session, held calls) waits for the results. */
  private suspend(turn: ToolTurn, calls: HeldCall[], history: KeptMessage[]): GenerationResult {
    const text = turn.text.slice(turn.segment);
    turn.segment = turn.text.length;
    turn.sink = {};
    const limit = Math.max(1, this.options.retainedSessions ?? DEFAULT_RETAINED_SESSIONS);
    while (this.kept.length + this.suspendedCount() >= limit) {
      if (this.kept.length) { const oldest = this.kept.shift()!; clearTimeout(oldest.timer); void this.disposeSession(oldest.agent, oldest.session); continue; }
      const oldest = this.suspended.values().next().value as SuspendedTurn | undefined;
      if (!oldest) break;
      this.expire(oldest, "The proxy holds too many conversations that wait for tool results.");
    }
    const entry: SuspendedTurn = { turn, calls, ids: calls.map((call) => call.id), transcript: [...history, { role: "assistant", text, images: [], toolCalls: calls.map(({ id, name }) => ({ id, name })) }], timer: setTimeout(() => this.expire(entry, "The client did not return the tool result in time."), this.resultTimeoutMs()) };
    entry.timer.unref?.();
    for (const id of entry.ids) this.suspended.set(id, entry);
    return { text, stopReason: "tool_calls", usage: null, toolCalls: calls.map(({ id, name, arguments: args }) => ({ id, name, arguments: args })) };
  }

  /** A suspended turn ran out of time (or room): its held calls get an error result, the turn is cancelled and the session disposed. A late follow-up takes the text fallback. */
  private expire(entry: SuspendedTurn, reason: string): void {
    clearTimeout(entry.timer);
    for (const id of entry.ids) if (this.suspended.get(id) === entry) this.suspended.delete(id);
    this.log.debug(`Giving up a turn that waited for tool results: ${reason}`);
    void this.dropTurn(entry.turn, reason);
  }

  /**
   * A request with function tools. The session gets the client's tools as the MCP server `client`; when the agent calls one, the HTTP response ends with the call
   * (`stopReason: "tool_calls"`) and the turn is suspended with its prompt and the held MCP call. A later request whose history holds the results resumes it:
   * the held calls are answered and the rest of the same turn streams into that request's callbacks. Anything else starts a fresh session with the history as text.
   */
  private async generateWithTools(model: string, messages: Message[], callbacks: GenerationCallbacks, signal: AbortSignal | undefined, options: GenerateOptions): Promise<GenerationResult> {
    const hub = this.ctx.toolBridge;
    if (!this.toolCalling || !hub) throw new ApiError(400, "model_not_capable", `${this.displayName} cannot call tools through this proxy.`, "model");
    const tools = options.tools!;
    // Remote MCP servers next to the bridge: the same session, and the same tool set for reuse and resume only with the same servers.
    const mcp = options.mcpServers?.length ? options.mcpServers : undefined;
    if (mcp && !this.mcpSupport) throw new ApiError(400, "model_not_capable", `${this.displayName} cannot call MCP servers through this proxy.`, "model");
    const search = options.webSearch;
    if (search && !this.descriptor.webSearch) throw new ApiError(400, "model_not_capable", `${this.displayName} cannot search the web.`, "model");
    const toolsKey = search ? JSON.stringify({ tools, ...(mcp ? { mcp } : {}), search: true }) : mcp ? JSON.stringify({ tools, mcp }) : JSON.stringify(tools);
    const mcpLabels = (mcp ?? []).map((server) => server.label);
    let agent: ClientContext | undefined;
    let session: PreparedSession | undefined;
    let turn: ToolTurn | undefined;
    let suspended = false;
    let aborted = signal?.aborted ?? false;
    let promptSent = false;
    let keepWith: { transcript: KeptMessage[]; usage?: Usage } | undefined;
    const cancelled = (): GenerationResult => ({ text: "", stopReason: "cancelled", usage: null });
    const abort = async () => { aborted = true; if (turn) await this.cancelTurn(turn); };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      agent = await this.start();
      if (aborted) return cancelled();
      if (hasImages(messages) && !this.imageInput) throw new ApiError(400, "unsupported_content", `${this.displayName} does not accept image input.`, "messages");
      if (mcp) this.assertMcpTransports(mcp);
      const resumed = this.takeSuspended(agent, model, messages, toolsKey);
      if (resumed) {
        turn = resumed.entry.turn; session = turn.session; promptSent = true;
        turn.sink = callbacks;
        for (const call of resumed.entry.calls) call.settle(resumed.results.get(call.id) ?? "");
      } else {
        const hit = this.options.reuseSessions ? this.takeKept(agent, model, messages, toolsKey) : undefined;
        let fresh = messages;
        if (hit) {
          session = hit.entry.session; fresh = hit.fresh;
          turn = this.newTurn(agent, session, model, hit.entry.bridge!, toolsKey, callbacks, hit.entry.usage, mcp, search !== undefined);
        } else {
          const bridge = hub.create(tools.map((tool) => ({ name: tool.name, ...(tool.description ? { description: tool.description } : {}), ...(tool.parameters ? { inputSchema: tool.parameters } : {}) })));
          try { session = await this.createSession(agent, bridge, mcp, search !== undefined); } catch (error) { bridge.dispose(); throw error; }
          turn = this.newTurn(agent, session, model, bridge, toolsKey, callbacks, undefined, mcp, search !== undefined);
          if (!await this.configureSession(agent, session, model, () => aborted)) return cancelled();
        }
        if (aborted) return cancelled();
        const prompt: ContentBlock[] = buildPrompt(fresh, options.instructions, undefined, false, { choice: options.toolChoice, parallel: options.parallelToolCalls, ...(mcp ? { mcp: mcp.map(({ label, allowedTools }) => ({ label, ...(allowedTools ? { tools: allowedTools } : {}) })) } : {}) }, search);
        promptSent = true;
        turn.finished = this.authGuard(() => agent!.request(methods.agent.session.prompt, { sessionId: session!.sessionId, prompt })).then((result): PromptOutcome => ({ result }), (error): PromptOutcome => ({ error }));
      }
      if (aborted) await this.cancelTurn(turn);
      for (;;) {
        const outcome = await this.nextOutcome(turn);
        if ("calls" in outcome) {
          let calls = outcome.calls;
          if (!calls.length) continue;
          // parallel_tool_calls: false: the first call goes to the client, the others are told to wait their turn.
          if (options.parallelToolCalls === false && calls.length > 1) {
            for (const extra of calls.slice(1)) extra.settle("Call one tool at a time. This call was not run: call it again after the result of the previous tool call.", true);
            calls = calls.slice(0, 1);
          }
          const result = this.suspend(turn, calls, messages.map(toKept));
          suspended = true;
          const mcpCalls = this.collectMcpCalls(turn.tracked, mcpLabels, turn.reported, false);
          const searches = search ? this.collectSearches(turn.tracked, turn.reported, false) : [];
          return { ...result, ...(mcpCalls.length ? { mcpCalls } : {}), ...(searches.length ? { searches } : {}) };
        }
        for (const call of turn.pending.splice(0)) call.settle("The turn ended before this tool call was answered.", true);
        if (outcome.done.error !== undefined) throw outcome.done.error;
        const result = outcome.done.result!;
        let usage = result.usage ?? null;
        let cumulative = turn.baseUsage;
        if (usage && this.descriptor.usageScope === "session") { cumulative = usage; usage = usageDelta(usage, turn.baseUsage); }
        const text = turn.text.slice(turn.segment);
        if (this.options.reuseSessions && result.stopReason === "end_turn" && !aborted && !turn.cancelled) keepWith = { transcript: [...messages.map(toKept), { role: "assistant", text, images: [] }], usage: cumulative };
        const mcpCalls = this.collectMcpCalls(turn.tracked, mcpLabels, turn.reported, true);
        const searches = search ? this.collectSearches(turn.tracked, turn.reported, true) : [];
        return { text, stopReason: result.stopReason, usage, ...(mcpCalls.length ? { mcpCalls } : {}), ...(search ? { searches } : {}) };
      }
    } catch (error) {
      if (aborted && !promptSent) return cancelled();
      if (aborted) throw new AcpUnavailableError("The request was cancelled.", error);
      const mapped = this.descriptor.mapError?.(error, model);
      if (mapped) throw mapped;
      if (error instanceof AcpUnavailableError || error instanceof ApiError) throw error;
      throw new AcpUnavailableError(`The ${this.displayName} ACP backend failed to process the request.`, error);
    } finally {
      signal?.removeEventListener("abort", abort);
      if (!suspended && session && agent) {
        if (keepWith && !aborted && this.agent === agent && turn) this.keep(agent, session, model, keepWith.transcript, keepWith.usage, turn.bridge, toolsKey);
        else await this.disposeSession(agent, session);
      }
    }
  }

  /** Takes the image blocks (and the "Revised prompt:" text) of a completed tool call; `into` is undefined when the request did not ask for images, so they are dropped. Also notes the files the agent wrote, for deletion. Never logs the update body (it can hold megabytes of base64). */
  private takeImages(update: Extract<SessionUpdate, { sessionUpdate: "tool_call_update" }>, into: GeneratedImage[] | undefined, files: Set<string>): void {
    const blocks = update.content ?? [];
    const inner = blocks.flatMap((block) => block.type === "content" ? [block.content] : []);
    const revisedPrompt = inner.flatMap((content) => content.type === "text" ? [/^Revised prompt:\s*([\s\S]*)$/.exec(content.text)?.[1]?.trim()] : []).find(Boolean);
    for (const content of inner) {
      if (content.type !== "image") continue;
      this.log.debug(`Image update: ${content.mimeType}, ${content.data.length} base64 characters.`);
      if (content.uri) files.add(content.uri);
      into?.push({ mimeType: content.mimeType, data: content.data, ...(revisedPrompt ? { revisedPrompt } : {}) });
    }
    const output = update.rawOutput as { imagePath?: unknown; savedPath?: unknown } | null | undefined;
    for (const reported of [output?.imagePath, output?.savedPath]) if (typeof reported === "string" && reported) files.add(reported);
  }

  /** Deletes the files the agent wrote, only those inside its image folder. */
  private async deleteImageFiles(support: NonNullable<ProviderDescriptor["imageGeneration"]>, files: Set<string>): Promise<void> {
    const folder = support.imageFolder(this.ctx);
    for (const file of files) {
      const deleted = await deleteGeneratedFile(file, folder, { pruneEmptyParent: support.pruneEmptyParent });
      this.log.debug(deleted ? "Deleted a generated image file." : "Left a reported image file alone (missing, or not inside the agent's image folder).");
    }
  }

  async close(): Promise<void> { await this.stop(); }
}
