import { mkdtemp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { client, methods, ndJsonStream, type ClientConnection, type ClientContext } from "@agentclientprotocol/sdk";
import type { SessionConfigOption, SessionUpdate } from "@agentclientprotocol/sdk";
import { serializePrompt, type TextMessage } from "./api.js";
import { killProcessTree } from "./process-tree.js";
import { AcpUnavailableError, ProviderAuthRequiredError, ProviderNotInstalledError, ProviderTermsRequiredError } from "./provider.js";
import type { AuthMethodInfo, GenerationCallbacks, GenerationResult, ModelInfo, Provider, ProviderDescriptor, ProviderState, ProviderStatus, RuntimeContext } from "./provider.js";

type SessionHandler = (update: SessionUpdate) => void;
interface PreparedSession { sessionId: string; cwd: string; modelOptionId?: string; readOnlyModeId?: string; }
interface AuthInflight { methodId: string; agent: ClientContext; promise: Promise<void>; }
const DEFAULT_MODE_CANDIDATES = ["read-only", "readonly"] as const;
const DEFAULT_AUTH_TIMEOUT_MS = 10_000;
const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_LOGIN_OPEN_DELAY_MS = 3_000;

/** An authenticate call did not finish in time; the request itself is left pending. */
class AuthTimeoutError extends Error { constructor(message: string) { super(message); this.name = "AuthTimeoutError"; } }
export interface AcpProviderOptions { workRoot: string; }

const AUTH_REQUIRED = -32000;

function isAuthRequired(error: unknown): boolean { return typeof error === "object" && error !== null && (error as { code?: unknown }).code === AUTH_REQUIRED; }

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

/** Long-lived ACP v1 connection to one agent process, with disposable sessions per generation and an optional warm pool. */
export class AcpProvider implements Provider {
  readonly id: string;
  readonly displayName: string;
  readonly ownedBy: string;
  readonly exposeUnprefixed: boolean;
  readonly staticModels?: ModelInfo[];
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
  private account?: string;
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
  private readonly handlers = new Map<string, SessionHandler>();
  private readonly listeners = new Set<(status: ProviderStatus) => void>();
  private readonly log;

  constructor(private readonly descriptor: ProviderDescriptor, private readonly ctx: RuntimeContext, private readonly options: AcpProviderOptions) {
    this.id = descriptor.id;
    this.displayName = descriptor.displayName;
    this.ownedBy = descriptor.ownedBy;
    this.exposeUnprefixed = descriptor.exposeUnprefixed;
    this.staticModels = descriptor.staticModels?.map((id) => ({ id }));
    this.log = ctx.logger.child(`${descriptor.id}-acp`);
  }

  status(): ProviderStatus {
    return { id: this.id, name: this.displayName, state: this.state, ...(this.error ? { error: this.error } : {}), authMethods: this.authMethods, models: this.staticModels ?? this.discovered ?? [], ...(this.loginUrl ? { loginUrl: this.loginUrl } : {}), ...(this.agentVersion ? { agentVersion: this.agentVersion } : {}), ...(this.account ? { account: this.account } : {}) };
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
    this.loginUrl = undefined; this.openedUrl = undefined; this.agentVersion = undefined; this.authInflight = undefined; this.authBlock = undefined; this.stderrBuffer = ""; this.account = undefined; this.loggedOut = false;
    const childFailure = new Promise<never>((_, reject) => child.once("error", reject));
    childFailure.catch(() => undefined);
    child.stderr.on("data", (chunk) => this.onStderr(chunk));
    const stream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>);
    const agentRef: { current?: ClientContext } = {};
    const app = client({ name: "api-acp-proxy" });
    app.onRequest(methods.client.session.requestPermission, async () => ({ outcome: { outcome: "cancelled" } }));
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
      if (this.state === "ready") this.setState("stopped");
    });
    let authStep = false;
    try {
      const initialized = await Promise.race([this.agent.request(methods.agent.initialize, { protocolVersion: 1, clientInfo: { name: "api-acp-proxy", version: "0.1.0" }, clientCapabilities: {} }), childFailure]);
      this.authMethods = (initialized.authMethods ?? []).map((method) => ({ id: method.id, name: method.name, ...(method.description ? { description: method.description } : {}), ...("type" in method && method.type ? { type: String(method.type) } : {}) }));
      if (!this.authMethods.length && descriptor.loginMethods) this.authMethods = descriptor.loginMethods;
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

  /** Handles the agent's _auth/status_update push: kind "none" means logged out, anything else carries the account label. */
  private onAuthStatus(status: { kind?: string; label?: string } | undefined): void {
    if (!status || typeof status.kind !== "string") return;
    if (status.kind === "none") { this.account = undefined; this.loggedOut = true; this.setState("needs_login", "Not logged in."); return; }
    this.loggedOut = false;
    this.account = typeof status.label === "string" && status.label ? status.label : undefined;
    if (this.state === "needs_login" && !this.authInflight && !this.authBlock) this.setState("ready"); else this.emitStatus();
  }

  private dropWarm(): void {
    for (const session of this.warm.splice(0)) void rm(session.cwd, { recursive: true, force: true }).catch(() => undefined);
  }

  private async stop(): Promise<void> {
    const { child, connection } = this;
    this.connection = undefined; this.agent = undefined; this.child = undefined;
    this.generation++;
    this.authInflight = undefined; this.authBlock = undefined;
    if (this.openTimer) { clearTimeout(this.openTimer); this.openTimer = undefined; }
    this.dropWarm();
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

  private async createSession(agent: ClientContext): Promise<PreparedSession> {
    const cwd = await mkdtemp(path.join(this.options.workRoot, "request-"));
    try {
      const session = await this.withAuth(agent, () => withTimeout(agent.request(methods.agent.session.new, { cwd, mcpServers: [], ...(this.descriptor.sessionMeta ? { _meta: this.descriptor.sessionMeta } : {}) }), this.descriptor.sessionTimeoutMs, `${this.displayName} session creation timed out.`));
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
    const chosen = methodId ?? this.descriptor.chooseAuth(this.authMethods, process.env) ?? usable[0]?.id;
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

  /** An auth_required error from the agent means the user must log in: surface it as ProviderAuthRequiredError. */
  private async authGuard<T>(run: () => Promise<T>): Promise<T> {
    try { return await run(); } catch (error) {
      if (!isAuthRequired(error)) throw error;
      this.setState("needs_login", "Login required.");
      throw new ProviderAuthRequiredError(`${this.displayName} requires login.`, error);
    }
  }

  async generate(model: string, messages: TextMessage[], callbacks: GenerationCallbacks = {}, signal?: AbortSignal): Promise<GenerationResult> {
    let agent: ClientContext | undefined;
    let session: PreparedSession | undefined;
    let aborted = signal?.aborted ?? false;
    let promptSent = false;
    const cancelled = (): GenerationResult => ({ text: "", stopReason: "cancelled", usage: null });
    const abort = async () => {
      aborted = true;
      if (!session || !agent) return;
      try { await agent.notify(methods.agent.session.cancel, { sessionId: session.sessionId }); } catch { /* connection may already be gone */ }
    };
    signal?.addEventListener("abort", abort, { once: true });
    let text = "";
    try {
      agent = await this.start();
      if (aborted) return cancelled();
      session = this.warm.shift() ?? await this.createSession(agent);
      this.refillWarm();
      if (aborted) return cancelled();
      const sid = session.sessionId;
      this.handlers.set(sid, (update) => {
        if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
          text += update.content.text;
          callbacks.onText?.(update.content.text);
        }
      });
      if (!session.modelOptionId) throw new AcpUnavailableError(`The ${this.displayName} ACP backend did not advertise a model configuration option.`);
      await this.authGuard(() => agent!.request(methods.agent.session.setConfigOption, { sessionId: sid, configId: session!.modelOptionId!, value: model }));
      if (aborted) return cancelled();
      if (session.readOnlyModeId) await agent.request(methods.agent.session.setMode, { sessionId: sid, modeId: session.readOnlyModeId });
      else if (this.descriptor.readOnlyMode === "required") throw new AcpUnavailableError(`The ${this.displayName} ACP backend did not advertise a read-only mode.`);
      else if (!this.warnedNoReadOnly) { this.warnedNoReadOnly = true; this.log.warn("No read-only mode advertised; relying on cancelled permissions and the text-only prompt."); }
      if (aborted) return cancelled();
      promptSent = true;
      const result = await this.authGuard(() => agent!.request(methods.agent.session.prompt, { sessionId: sid, prompt: [{ type: "text", text: serializePrompt(messages) }] }));
      return { text, stopReason: result.stopReason, usage: result.usage ?? null };
    } catch (error) {
      if (aborted && !promptSent) return cancelled();
      if (aborted) throw new AcpUnavailableError("The request was cancelled.", error);
      const mapped = this.descriptor.mapError?.(error, model);
      if (mapped) throw mapped;
      if (error instanceof AcpUnavailableError) throw error;
      throw new AcpUnavailableError(`The ${this.displayName} ACP backend failed to process the request.`, error);
    } finally {
      signal?.removeEventListener("abort", abort);
      if (session && agent) await this.disposeSession(agent, session);
    }
  }

  async close(): Promise<void> { await this.stop(); }
}
