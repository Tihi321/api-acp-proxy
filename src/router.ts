import fs from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AcpLike, ModelEntry } from "./acp.js";
import { ApiError, type Message } from "./api.js";
import { silentLogger, type Logger } from "./logger.js";
import type { GenerateOptions, GenerationCallbacks, GenerationResult, ModelInfo, Provider } from "./provider.js";

export interface RouterOptions {
  providers: Provider[];
  logger?: Logger;
  /** Persisted discovered models (models-cache.json). */
  cachePath?: string;
  modelsWaitMs?: number;
}
export interface ListedModel extends ModelEntry { ownedBy: string; provider: string; }

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
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly options: RouterOptions) {
    this.providers = options.providers;
    this.log = (options.logger ?? silentLogger).child("router");
    this.modelsWaitMs = options.modelsWaitMs ?? 3000;
    const cache = this.readCache();
    for (const provider of this.providers) {
      this.byId.set(provider.id, provider);
      this.known.set(provider.id, provider.staticModels ?? cache[provider.id] ?? []);
    }
  }

  private readCache(): Record<string, ModelInfo[]> {
    if (!this.options.cachePath) return {};
    try {
      const parsed = JSON.parse(fs.readFileSync(this.options.cachePath, "utf8")) as { providers?: Record<string, unknown> };
      const out: Record<string, ModelInfo[]> = {};
      for (const [id, models] of Object.entries(parsed.providers ?? {})) {
        if (Array.isArray(models)) out[id] = models.filter((m): m is ModelInfo => typeof m?.id === "string").map((m) => ({ id: m.id, ...(typeof m.name === "string" ? { name: m.name } : {}) }));
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

  /** Providers that have not discovered any models yet accept any `<provider>/<id>` and let the agent decide. */
  resolve(id: string): { provider: Provider; model: string } | undefined {
    const slash = id.indexOf("/");
    if (slash > 0) {
      const provider = this.byId.get(id.slice(0, slash));
      if (provider) {
        const model = id.slice(slash + 1);
        const models = this.known.get(provider.id) ?? [];
        if (model && (!models.length || models.some((m) => m.id === model))) return { provider, model };
      }
    }
    const owner = this.unprefixedOwners().get(id);
    return owner ? { provider: owner, model: id } : undefined;
  }

  hasModel(id: string): boolean { return this.resolve(id) !== undefined; }

  canGenerateImages(id: string): boolean { return this.resolve(id)?.provider.imageGeneration === true; }

  canCallTools(id: string): boolean { return this.resolve(id)?.provider.toolCalling === true; }

  canUseMcp(id: string): boolean { return this.resolve(id)?.provider.mcpSupport === true; }

  private entries(): ListedModel[] {
    const owners = this.unprefixedOwners();
    const out: ListedModel[] = [];
    for (const provider of this.providers) {
      for (const model of this.known.get(provider.id) ?? []) {
        if (owners.get(model.id) === provider) out.push({ id: model.id, ownedBy: provider.ownedBy, provider: provider.id });
        out.push({ id: `${provider.id}/${model.id}`, ownedBy: provider.ownedBy, provider: provider.id });
      }
    }
    return out;
  }

  private async refreshOne(provider: Provider, waitMs: number, force: boolean): Promise<void> {
    const task = provider.listModels({ force }).then((models) => this.update(provider, models), (error) => this.log.debug(`Listing models for '${provider.id}' failed: ${error instanceof Error ? error.message : String(error)}`));
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

  async generate(model: string, messages: Message[], callbacks?: GenerationCallbacks, signal?: AbortSignal, options?: GenerateOptions): Promise<GenerationResult> {
    const target = this.resolve(model);
    if (!target) throw new ApiError(404, "model_not_found", `The model '${model}' does not exist.`, "model");
    return target.provider.generate(target.model, messages, callbacks, signal, options);
  }

  async close(): Promise<void> {
    await Promise.all(this.providers.map((provider) => provider.close().catch(() => undefined)));
    await this.writeQueue;
  }
}
