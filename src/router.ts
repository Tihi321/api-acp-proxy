import fs from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AcpLike, ModelEntry } from "./acp.js";
import { ApiError, type Message } from "./api.js";
import { DEFAULT_COOLDOWN_MS, MAX_RESET_MS, UsageLimitError, exhaustedUntil, usageLimitRefusal } from "./usage-limit.js";
import { silentLogger, type Logger } from "./logger.js";
import { ConcurrencyLimiter, QueueAbortedError, type LimiterStats } from "./limiter.js";
import type { PlanLimitsView } from "./shared/ipc.js";
import type { EmbeddingResult, GenerateOptions, GenerationCallbacks, GenerationResult, ImagePassthrough, ModelInfo, Provider } from "./provider.js";

export interface RouterOptions {
  providers: Provider[];
  logger?: Logger;
  /** Persisted discovered models (models-cache.json). */
  cachePath?: string;
  modelsWaitMs?: number;
  /** List unprefixed ids in listModels (default true). Unprefixed ids still resolve either way. */
  listBareAliases?: boolean;
  /** Cap on simultaneous generations per provider; extra requests wait in a FIFO queue. `perProvider` overrides `maxConcurrent` for a provider id. 0 = unlimited. Without this option nothing is limited. */
  concurrency?: { maxConcurrent: number; maxQueue?: number; perProvider?: Record<string, number | undefined> };
  /** A provider that reports its usage limit is refused until its reset time; `cooldownMs` (default 60 minutes) is used when the reset time is unknown, past or over `maxMs` (default 31 days). */
  usageLimit?: { cooldownMs: number; maxMs?: number };
  /** Called when the set of exhausted providers changes (a failure marks one, a success clears one); never from a read. */
  onExhaustedChange?: () => void;
  /** The clock, in epoch ms (tests). */
  now?: () => number;
}
export interface ListedModel extends ModelEntry { ownedBy: string; provider: string; maxPromptChars?: number; /** ISO time the provider's usage limit resets; present only while it is exhausted. */ exhaustedUntil?: string; }

/**
 * Routes model ids to providers. Every model is listed as `<provider>/<raw>`; providers with `exposeUnprefixed`
 * additionally list the raw id (the first provider wins a collision, the later one stays prefixed-only).
 */
export class ProviderRouter implements AcpLike {
  private readonly providers: Provider[];
  private readonly byId = new Map<string, Provider>();
  private readonly known = new Map<string, ModelInfo[]>();
  private readonly warned = new Set<string>();
  private readonly log: Logger;
  private readonly modelsWaitMs: number;
  private unprefixed?: Map<string, Provider>;
  private readonly limiters = new Map<string, ConcurrencyLimiter>();
  private writeQueue: Promise<void> = Promise.resolve();
  /** Providers that said their usage limit is used up: id -> epoch ms they are refused until (memory only). */
  private readonly exhausted = new Map<string, number>();

  constructor(private readonly options: RouterOptions) {
    this.providers = options.providers;
    this.log = (options.logger ?? silentLogger).child("router");
    this.modelsWaitMs = options.modelsWaitMs ?? 3000;
    const cache = this.readCache();
    const concurrency = options.concurrency;
    for (const provider of this.providers) {
      this.byId.set(provider.id, provider);
      if (concurrency) {
        const limit = concurrency.perProvider?.[provider.id] ?? concurrency.maxConcurrent;
        this.limiters.set(provider.id, new ConcurrencyLimiter({ limit, maxQueue: concurrency.maxQueue ?? 0, onWait: (position, stats) => this.log.info(`A request for '${provider.id}' waits in the queue (position ${position}; ${stats.active} running, limit ${stats.limit}).`) }));
      }
      this.known.set(provider.id, provider.staticModels ?? cache[provider.id] ?? []);
    }
  }

  private readCache(): Record<string, ModelInfo[]> {
    if (!this.options.cachePath) return {};
    try {
      const parsed = JSON.parse(fs.readFileSync(this.options.cachePath, "utf8")) as { providers?: Record<string, unknown> };
      const out: Record<string, ModelInfo[]> = {};
      for (const [id, models] of Object.entries(parsed.providers ?? {})) {
        if (Array.isArray(models)) out[id] = models.filter((m): m is ModelInfo => typeof m?.id === "string").map((m) => ({ id: m.id, ...(typeof m.name === "string" ? { name: m.name } : {}), ...(m.kind === "llm" || m.kind === "image" || m.kind === "embedding" ? { kind: m.kind } : {}), ...(typeof m.vision === "boolean" ? { vision: m.vision } : {}) }));
      }
      return out;
    } catch { return {}; }
  }

  private persist(): void {
    const file = this.options.cachePath;
    if (!file) return;
    const providers: Record<string, ModelInfo[]> = {};
    for (const provider of this.providers) if (!provider.staticModels && this.known.get(provider.id)?.length) providers[provider.id] = this.known.get(provider.id)!;
    this.writeQueue = this.writeQueue.then(async () => {
      try {
        await mkdir(path.dirname(file), { recursive: true });
        const tmp = `${file}.tmp-${process.pid}`;
        await writeFile(tmp, JSON.stringify({ version: 1, providers }, null, 2));
        await rename(tmp, file);
      } catch (error) { this.log.debug(`Could not write the models cache: ${error instanceof Error ? error.message : String(error)}`); }
    });
  }

  knownModels(providerId: string): ModelInfo[] { return this.known.get(providerId) ?? []; }

  /** Re-reads a provider's `staticModels` after it took new settings live (its profile list changed). */
  syncStaticModels(providerId: string): void {
    const provider = this.byId.get(providerId);
    if (!provider?.staticModels) return;
    this.known.set(providerId, provider.staticModels);
    this.unprefixed = undefined;
  }

  private update(provider: Provider, models: ModelInfo[]): void {
    if (provider.staticModels || !models.length) return;
    if (JSON.stringify(models) === JSON.stringify(this.known.get(provider.id))) return;
    this.known.set(provider.id, models);
    this.unprefixed = undefined;
    this.persist();
  }

  private unprefixedOwners(): Map<string, Provider> {
    if (this.unprefixed) return this.unprefixed;
    const owners = new Map<string, Provider>();
    for (const provider of this.providers) {
      if (!provider.exposeUnprefixed) continue;
      for (const model of this.known.get(provider.id) ?? []) {
        const owner = owners.get(model.id);
        if (!owner) owners.set(model.id, provider);
        else if (owner !== provider && !this.warned.has(`${provider.id}:${model.id}`)) {
          this.warned.add(`${provider.id}:${model.id}`);
          this.log.warn(`Model '${model.id}' is offered by both '${owner.id}' and '${provider.id}'; '${provider.id}' is listed as '${provider.id}/${model.id}' only.`);
        }
      }
    }
    return this.unprefixed = owners;
  }

  /** Providers that have not discovered any models yet accept any `<provider>/<id>` and let the agent decide; an unprefixed id nobody lists goes to the first unprefixed provider in that state (a first start without a models cache). */
  resolve(id: string): { provider: Provider; model: string } | undefined {
    const slash = id.indexOf("/");
    if (slash > 0) {
      const provider = this.byId.get(id.slice(0, slash));
      if (provider) {
        const model = id.slice(slash + 1);
        const models = this.known.get(provider.id) ?? [];
        if (model && (!models.length || models.some((m) => m.id === model) || provider.acceptsModel?.(model) === true)) return { provider, model };
      }
    }
    const owner = this.unprefixedOwners().get(id) ?? (slash < 0 && id ? this.providers.find((provider) => provider.exposeUnprefixed && !this.known.get(provider.id)?.length) : undefined);
    return owner ? { provider: owner, model: id } : undefined;
  }

  hasModel(id: string): boolean { return this.resolve(id) !== undefined; }

  canGenerateImages(id: string): boolean { const target = this.resolve(id); return target ? target.provider.supportsImageGeneration?.(target.model) ?? target.provider.imageGeneration === true : false; }

  canSearchWeb(id: string): boolean { return this.resolve(id)?.provider.webSearchSupport === true; }

  acceptsImages(id: string): boolean | undefined { const target = this.resolve(id); return target ? (target.provider.acceptsImages ? target.provider.acceptsImages(target.model) : target.provider.status().capabilities?.image) : undefined; }

  /** Switches/queues to a local model before the request timer starts; undefined for providers without that. */
  async prepareModel(id: string, messages: Message[] | undefined, signal: AbortSignal): Promise<{ release(): void } | undefined> {
    const target = this.resolve(id);
    return target?.provider.prepareModel?.(target.model, messages, signal);
  }

  requestTimeoutMs(id: string): number | undefined { const target = this.resolve(id); return target?.provider.requestTimeoutMs?.(target.model); }

  /** True when image requests for the model are forwarded to the provider's image server. */
  imagePassthrough(id: string): boolean { const target = this.resolve(id); return target?.provider.generateImage !== undefined && target.provider.supportsImageGeneration?.(target.model) === true; }

  async generateImage(id: string, request: ImagePassthrough, signal: AbortSignal): Promise<{ status: number; body: unknown }> {
    const target = this.resolve(id);
    if (!target?.provider.generateImage) throw new ApiError(404, "model_not_found", `The model '${id}' does not exist.`, "model");
    return target.provider.generateImage(target.model, request, signal);
  }

  /** True when the model is an embedding model its provider serves. */
  canEmbed(id: string): boolean { const target = this.resolve(id); return target?.provider.embed !== undefined && target.provider.supportsEmbeddings?.(target.model) === true; }

  async embed(id: string, input: string[], signal: AbortSignal): Promise<EmbeddingResult> {
    const target = this.resolve(id);
    if (!target?.provider.embed) throw new ApiError(404, "model_not_found", `The model '${id}' does not exist.`, "model");
    return target.provider.embed(target.model, input, signal);
  }

  canCallTools(id: string): boolean { return this.resolve(id)?.provider.toolCalling === true; }

  canUseMcp(id: string): boolean { return this.resolve(id)?.provider.mcpSupport === true; }

  providerOf(id: string): string | undefined { return this.resolve(id)?.provider.id; }

  private entries(): ListedModel[] {
    const owners = this.unprefixedOwners();
    const out: ListedModel[] = [];
    for (const provider of this.providers) {
      const until = this.exhaustedUntilMs(provider.id);
      for (const model of this.known.get(provider.id) ?? []) {
        const chars = provider.maxPromptCharsFor?.(model.id) ?? provider.maxPromptChars;
        const limit = { ...(chars ? { maxPromptChars: chars } : {}), ...(until !== undefined ? { exhaustedUntil: new Date(until).toISOString() } : {}) };
        const kind = { ...(model.kind ? { kind: model.kind } : {}), ...(model.vision !== undefined ? { vision: model.vision } : {}) };
        if (this.options.listBareAliases !== false && owners.get(model.id) === provider) out.push({ id: model.id, ownedBy: provider.ownedBy, provider: provider.id, ...kind, ...limit });
        out.push({ id: `${provider.id}/${model.id}`, ownedBy: provider.ownedBy, provider: provider.id, ...kind, ...limit });
      }
    }
    return out;
  }

  private async refreshOne(provider: Provider, waitMs: number, force: boolean): Promise<void> {
    const task = provider.listModels({ force }).then((models) => {
      this.update(provider, models);
      const known = provider.usageLimitState?.();
      if (known instanceof UsageLimitError) { if (this.exhaustedUntilMs(provider.id) === undefined) this.markExhausted(provider, known); }
      else if (known === null && this.exhausted.delete(provider.id)) this.options.onExhaustedChange?.();
    }, (error) => this.log.debug(`Listing models for '${provider.id}' failed: ${error instanceof Error ? error.message : String(error)}`));
    if (waitMs <= 0) { await task; return; }
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([task, new Promise<void>((resolve) => { timer = setTimeout(resolve, waitMs); })]);
    clearTimeout(timer);
  }

  /** Merges persisted models with fresh results; providers slower than waitMs are answered from cache. */
  async listModels(options: { waitMs?: number; force?: boolean } = {}): Promise<ListedModel[]> {
    const waitMs = options.waitMs ?? this.modelsWaitMs;
    await Promise.all(this.providers.map((provider) => this.refreshOne(provider, waitMs, options.force ?? false)));
    return this.entries();
  }

  /** Re-discovers models for one provider (or all) and waits for the result. */
  async refresh(providerId?: string): Promise<void> {
    await Promise.all(this.providers.filter((p) => !providerId || p.id === providerId).map((provider) => this.refreshOne(provider, 0, true)));
  }

  /** Throws the provider's 400 when the prompt is over its limit; an unknown model passes (`generate` answers the 404). */
  checkPrompt(model: string, messages: Message[], options?: GenerateOptions): void {
    const provider = this.resolve(model)?.provider;
    if (!provider) return;
    this.refuseIfExhausted(provider);
    provider.checkPrompt?.(messages, options, this.resolve(model)?.model);
  }

  /** Whether the model's provider forwards the output limit upstream (the server then does not cut the text). */
  forwardsOutputLimit(model: string): boolean { return this.resolve(model)?.provider.forwardsOutputLimit === true; }

  private now(): number { return this.options.now?.() ?? Date.now(); }

  /** When the provider is refused until; a passed time is forgotten here. */
  private exhaustedUntilMs(providerId: string): number | undefined {
    const until = this.exhausted.get(providerId);
    if (until === undefined) return undefined;
    if (this.now() >= until) { this.exhausted.delete(providerId); return undefined; }
    return until;
  }

  /** Throws the 429 `usage_limit_exceeded` while the provider's usage limit is used up (before the limiter: nothing queues). */
  private refuseIfExhausted(provider: Provider): void {
    const until = this.exhaustedUntilMs(provider.id);
    if (until !== undefined) throw usageLimitRefusal(provider, until, this.now(), true);
  }

  /** Runs one provider call: a usage-limit failure marks the provider exhausted and becomes the contract 429; a success clears the mark. */
  private async track<T extends GenerationResult>(provider: Provider, run: () => Promise<T>): Promise<T> {
    try {
      const result = await run();
      if (result.stopReason !== "cancelled" && this.exhausted.delete(provider.id)) this.options.onExhaustedChange?.();
      return result;
    } catch (error) {
      if (!(error instanceof UsageLimitError)) throw error;
      const now = this.now();
      throw usageLimitRefusal(provider, this.markExhausted(provider, error), now, false);
    }
  }

  /** Marks the provider exhausted until the time its error implies (or the cooldown); returns that time (ms). */
  private markExhausted(provider: Provider, error: UsageLimitError): number {
    const settings = this.options.usageLimit;
    const until = exhaustedUntil(error.resetText, this.now(), settings?.cooldownMs ?? DEFAULT_COOLDOWN_MS, settings?.maxMs ?? MAX_RESET_MS, error.resetAt);
    this.exhausted.set(provider.id, until);
    this.options.onExhaustedChange?.();
    this.log.warn(`'${provider.id}' has hit its usage limit; requests are refused until ${new Date(until).toISOString()}.`);
    return until;
  }

  /** Providers whose usage limit is used up, with the ISO time they are refused until (live entries only). */
  exhaustedProviders(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const id of [...this.exhausted.keys()]) { const until = this.exhaustedUntilMs(id); if (until !== undefined) out[id] = new Date(until).toISOString(); }
    return out;
  }

  async generate(model: string, messages: Message[], callbacks?: GenerationCallbacks, signal?: AbortSignal, options?: GenerateOptions): Promise<GenerationResult> {
    const target = this.resolve(model);
    if (!target) throw new ApiError(404, "model_not_found", `The model '${model}' does not exist.`, "model");
    this.refuseIfExhausted(target.provider);
    target.provider.checkPrompt?.(messages, options, target.model);
    const limiter = this.limiters.get(target.provider.id);
    if (!limiter) return this.track(target.provider, () => target.provider.generate(target.model, messages, callbacks, signal, options));
    let release: () => void;
    try { release = await limiter.acquire(signal); }
    catch (error) {
      // The client left (or the request timed out) while it waited: nothing ran.
      if (error instanceof QueueAbortedError) return { text: "", stopReason: "cancelled", usage: null };
      throw error;
    }
    try {
      // A request that waited may have been overtaken by one that found the limit used up.
      this.refuseIfExhausted(target.provider);
      return await this.track(target.provider, () => target.provider.generate(target.model, messages, callbacks, signal, options));
    } finally { release(); }
  }

  /** Reads one provider's account plan limits; the probe takes a slot of the provider's cap like a request does, but it is not a request (never logged or counted). */
  async probePlanLimits(providerId: string, signal: AbortSignal): Promise<PlanLimitsView> {
    const provider = this.byId.get(providerId);
    if (!provider?.planLimits) return { provider: providerId, state: "unsupported", windows: [], message: "Plan limits are not available for this provider." };
    const limiter = this.limiters.get(providerId);
    let release: (() => void) | undefined;
    if (limiter) {
      try { release = await limiter.acquire(signal); }
      catch (error) {
        if (error instanceof QueueAbortedError) return { provider: providerId, state: "error", windows: [], message: "No free slot for this provider in time; try again." };
        if (error instanceof ApiError && error.code === "provider_queue_full") return { provider: providerId, state: "error", windows: [], message: "The provider's queue is full; try again shortly." };
        throw error;
      }
    }
    try { return { ...(await provider.planLimits(signal)), provider: providerId }; }
    finally { release?.(); }
  }

  /** Running and waiting requests per provider (only providers with a cap). */
  queueStats(): Record<string, LimiterStats> {
    const own = Object.fromEntries([...this.limiters].map(([id, limiter]) => [id, limiter.stats()]));
    const extra = this.providers.reduce<Record<string, LimiterStats>>((all, provider) => ({ ...all, ...provider.extraQueueStats?.() }), {});
    return { ...own, ...extra };
  }

  /** `status().authMethod` per provider, for the providers that report one. */
  authMethods(): Record<string, string> {
    return Object.fromEntries(this.providers.flatMap((provider) => { const method = provider.status().authMethod; return method ? [[provider.id, method]] : []; }));
  }

  async close(): Promise<void> {
    await Promise.all(this.providers.map((provider) => provider.close().catch(() => undefined)));
    await this.writeQueue;
  }
}
