import { EventEmitter } from "node:events";
import path from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createLogger, type Logger } from "./logger.js";
import { ProviderRouter } from "./router.js";
import { createProxyServer } from "./server.js";
import { codexRegistration } from "./providers/codex.js";
import { antigravityRegistration } from "./providers/antigravity.js";
import { defaultRuntimeContext } from "./provider.js";
import type { ModelInfo, Provider, ProviderStatus, RuntimeContext } from "./provider.js";
import { defaultSettingsPath, mergeSettings, resolveConfig, SettingsStore } from "./settings.js";
import type { ProviderSettings, ResolvedConfig, SecretCodec, Settings, SettingsPatch } from "./settings.js";
import type { ProxyConfig } from "./config.js";

export interface ProviderFactoryArgs {
  /** Effective settings (env overrides applied). */
  settings: Settings;
  /** `settings.providers[id]`. */
  providerSettings: ProviderSettings;
  config: ProxyConfig;
  ctx: RuntimeContext;
  env: NodeJS.ProcessEnv;
  /** Persists a settings patch without restarting anything (e.g. lastAuthMethodId after a login). */
  saveSettings(patch: SettingsPatch): Promise<void>;
}
/** Adds a backend to the controller; `id` must match a key in `Settings.providers` (it is enabled by `providers[id].enabled`). */
export interface ProviderRegistration {
  id: string;
  displayName: string;
  create(args: ProviderFactoryArgs): Provider;
}

export interface ControllerOptions {
  settingsPath?: string;
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
  secretCodec?: SecretCodec;
  /** Overrides for the runtime context (nodeRuntime, resolveUnpacked, fetch, dataDir). */
  ctx?: Partial<RuntimeContext>;
  registry?: ProviderRegistration[];
  /** Grace period for in-flight requests before connections are force-closed. Default 5000. */
  drainMs?: number;
}

export type ServerState = "stopped" | "starting" | "running" | "error";
export interface ServerStatus { state: ServerState; host: string; port: number; baseUrl?: string; error?: { code?: string; message: string }; }
export interface ControllerStatus { server: ServerStatus; providers: ProviderStatus[]; overridden: string[]; settingsPath: string; }
export interface SettingsSnapshot { settings: Settings; effective: Settings; overridden: string[]; path: string; }

interface Running { server: Server; router: ProviderRouter; providers: Provider[]; unsubscribe: Array<() => void>; }

/** Owns settings, router and HTTP server. Emits "status" (ControllerStatus) on every change. */
export class ProxyController extends EventEmitter {
  private readonly env: NodeJS.ProcessEnv;
  private readonly logger: Logger;
  private readonly store: SettingsStore;
  private readonly registry: ProviderRegistration[];
  private readonly drainMs: number;
  private readonly dataDir: string;
  private readonly ctx: RuntimeContext;
  private settings?: Settings;
  private resolved?: ResolvedConfig;
  private running?: Running;
  private serverStatus: ServerStatus = { state: "stopped", host: "127.0.0.1", port: 0 };
  private wanted = false;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: ControllerOptions = {}) {
    super();
    this.env = options.env ?? process.env;
    this.logger = options.logger ?? createLogger();
    const settingsPath = options.settingsPath ?? defaultSettingsPath(this.env);
    this.store = new SettingsStore(settingsPath, options.secretCodec, this.logger);
    this.registry = [...(options.registry ?? [codexRegistration, antigravityRegistration])];
    this.drainMs = options.drainMs ?? 5000;
    this.dataDir = options.ctx?.dataDir ?? path.dirname(settingsPath);
    this.ctx = defaultRuntimeContext({ ...options.ctx, logger: this.logger, dataDir: this.dataDir });
  }

  /** Registers (or replaces) a provider factory. Takes effect on the next start. */
  registerProvider(registration: ProviderRegistration): void {
    const index = this.registry.findIndex((entry) => entry.id === registration.id);
    if (index >= 0) this.registry[index] = registration; else this.registry.push(registration);
  }

  get settingsPath(): string { return this.store.file; }

  private exclusive<T>(run: () => Promise<T>): Promise<T> {
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async load(): Promise<ResolvedConfig> {
    this.settings ??= await this.store.load();
    this.resolved = resolveConfig(this.settings, this.env);
    return this.resolved;
  }

  async getSettings(): Promise<SettingsSnapshot> {
    const resolved = await this.load();
    return { settings: this.settings!, effective: resolved.settings, overridden: resolved.overridden, path: this.store.file };
  }

  status(): ControllerStatus {
    const providers: ProviderStatus[] = this.registry.map((entry) => {
      const live = this.running?.providers.find((provider) => provider.id === entry.id);
      if (live) return { ...live.status(), models: this.running!.router.knownModels(entry.id) as ModelInfo[] };
      const enabled = this.resolved?.providers[entry.id]?.enabled ?? false;
      return { id: entry.id, name: entry.displayName, state: enabled ? "stopped" : "disabled", authMethods: [], models: [] };
    });
    return { server: { ...this.serverStatus }, providers, overridden: this.resolved?.overridden ?? [], settingsPath: this.store.file };
  }

  private publish(): ControllerStatus {
    const status = this.status();
    this.emit("status", status);
    return status;
  }

  start(): Promise<ControllerStatus> {
    this.wanted = true;
    return this.exclusive(() => this.startServer());
  }

  stop(): Promise<ControllerStatus> {
    this.wanted = false;
    return this.exclusive(async () => { await this.stopServer(); return this.publish(); });
  }

  /** Persists a settings patch and restarts the server (drain, then new server and bridges) when it is meant to be running. */
  applySettings(patch: SettingsPatch): Promise<ControllerStatus> {
    return this.exclusive(async () => {
      await this.load();
      const merged = mergeSettings(this.settings!, patch);
      await this.store.save(merged);
      this.settings = merged;
      await this.stopServer();
      if (this.wanted) return this.startServer();
      const { config } = await this.load();
      this.serverStatus = { state: "stopped", host: config.host, port: config.port };
      return this.publish();
    });
  }

  /** Persists a patch without a restart; serialized with the other lifecycle operations. */
  private saveSettings(patch: SettingsPatch): Promise<void> {
    return this.exclusive(async () => {
      await this.load();
      const merged = mergeSettings(this.settings!, patch);
      await this.store.save(merged);
      this.settings = merged;
    });
  }

  private async startServer(): Promise<ControllerStatus> {
    if (this.running) return this.status();
    const { config, settings, providers: providerSettings } = await this.load();
    this.serverStatus = { state: "starting", host: config.host, port: config.port };
    this.publish();
    const ctx = { ...this.ctx, dataDir: this.dataDir };
    const providers: Provider[] = [];
    for (const entry of this.registry) {
      if (!providerSettings[entry.id]?.enabled) continue;
      try { providers.push(entry.create({ settings, providerSettings: providerSettings[entry.id]!, config, ctx, env: this.env, saveSettings: (patch) => this.saveSettings(patch) })); }
      catch (error) { this.logger.error(`Could not create provider '${entry.id}': ${error instanceof Error ? error.message : String(error)}`); }
    }
    const router = new ProviderRouter({ providers, logger: this.logger, cachePath: path.join(this.dataDir, "models-cache.json"), modelsWaitMs: config.modelsWaitMs });
    const server = createProxyServer(config, router);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.port, config.host, () => { server.off("error", reject); resolve(); });
      });
    } catch (error) {
      const failure = error as NodeJS.ErrnoException;
      this.logger.error(`Cannot listen on ${config.host}:${config.port}: ${failure.code ?? ""} ${failure.message}`.replace("  ", " "));
      await router.close();
      this.serverStatus = { state: "error", host: config.host, port: config.port, error: { ...(failure.code ? { code: failure.code } : {}), message: failure.message } };
      return this.publish();
    }
    server.on("error", (error) => this.logger.error(`Server error: ${error.message}`));
    const port = (server.address() as AddressInfo).port;
    const unsubscribe = providers.map((provider) => provider.onStatus(() => this.publish()));
    this.running = { server, router, providers, unsubscribe };
    const visibleHost = config.host === "0.0.0.0" || config.host === "::" ? "127.0.0.1" : config.host.includes(":") ? `[${config.host}]` : config.host;
    this.serverStatus = { state: "running", host: config.host, port, baseUrl: `http://${visibleHost}:${port}/v1` };
    this.logger.info(`Codex subscription proxy listening on http://${config.host}:${port}`);
    void router.refresh().then(() => { if (this.running?.router === router) this.publish(); }, () => undefined);
    return this.publish();
  }

  private async stopServer(): Promise<void> {
    const running = this.running;
    this.running = undefined;
    if (running) {
      for (const off of running.unsubscribe) off();
      const closed = new Promise<void>((resolve) => running.server.close(() => resolve()));
      running.server.closeIdleConnections?.();
      const timer = setTimeout(() => running.server.closeAllConnections?.(), this.drainMs);
      await closed;
      clearTimeout(timer);
      await running.router.close();
    }
    this.serverStatus = { state: "stopped", host: this.serverStatus.host, port: this.serverStatus.port };
  }

  /** Interactive login through ACP `authenticate`. Not queued behind lifecycle operations because it may wait for a browser flow. */
  async login(providerId: string, methodId?: string): Promise<ControllerStatus> {
    const provider = this.running?.providers.find((entry) => entry.id === providerId);
    if (!provider) throw new Error(`Provider '${providerId}' is not running; enable it and start the proxy first.`);
    const method = methodId ?? (this.resolved?.providers[providerId]?.authMethodId as string | undefined);
    try { await provider.login(method); } finally { this.publish(); }
    void this.running?.router.refresh(providerId).then(() => this.publish(), () => undefined);
    return this.status();
  }

  async refreshModels(providerId?: string): Promise<ControllerStatus> {
    const router = this.running?.router;
    if (router) await router.refresh(providerId);
    return this.publish();
  }
}
