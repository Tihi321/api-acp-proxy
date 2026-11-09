import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import type { ActivityEntry } from "./activity.js";
import type { Logger } from "./logger.js";
import type { UsageCountsView, UsageDayView, UsageProviderView, UsageRangeKey, UsageView } from "./shared/ipc.js";

export type UsageCounts = UsageCountsView;
/** The file: `since` = first counted day after creation or the last reset; `totals` = all time, never pruned; `days[YYYY-MM-DD][providerId]`. */
export interface UsageFile { version: 1; since?: string; totals: Record<string, UsageCounts>; days: Record<string, Record<string, UsageCounts>>; }
export interface UsageStoreOptions {
  /** Absent: in memory only (nothing is read or written). */
  file?: string;
  now?: () => number;
  /** Day buckets kept, today included. Default 400. */
  retainDays?: number;
  /** Delay between the first unsaved change and the write. Default 2000. */
  flushMs?: number;
  logger?: Logger;
}

const DEFAULT_RETAIN_DAYS = 400;
const DEFAULT_FLUSH_MS = 2000;
const CHART_DAYS = 30;

/** Local calendar day, zero-padded: "2026-11-08". */
export function localDayKey(time: number): string {
  const date = new Date(time);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

const zero = (): UsageCounts => ({ requests: 0, errors: 0, inputTokens: 0, outputTokens: 0, estimated: 0 });
function addInto(target: UsageCounts, source: UsageCounts): void {
  target.requests += source.requests; target.errors += source.errors;
  target.inputTokens += source.inputTokens; target.outputTokens += source.outputTokens; target.estimated += source.estimated;
}
const count = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
function sanitize(value: unknown): UsageCounts {
  const raw = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  return { requests: count(raw.requests), errors: count(raw.errors), inputTokens: count(raw.inputTokens), outputTokens: count(raw.outputTokens), estimated: count(raw.estimated) };
}
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** Persisted request and token totals per provider and local day. Emits "change" after every add and reset. */
export class UsageStore extends EventEmitter {
  /** Resolves once the file was read (missing, unreadable, invalid JSON or version !== 1: start empty, log a warning except for a missing file). */
  readonly ready: Promise<void>;
  private totals: Record<string, UsageCounts> = {};
  private days: Record<string, Record<string, UsageCounts>> = {};
  private since?: string;
  private dirty = false;
  private timer?: NodeJS.Timeout;
  private chain: Promise<void> = Promise.resolve();
  private readonly file?: string;
  private readonly now: () => number;
  private readonly retainDays: number;
  private readonly flushMs: number;
  private readonly logger?: Logger;

  constructor(options: UsageStoreOptions = {}) {
    super();
    this.file = options.file;
    this.now = options.now ?? Date.now;
    this.retainDays = Math.max(1, options.retainDays ?? DEFAULT_RETAIN_DAYS);
    this.flushMs = options.flushMs ?? DEFAULT_FLUSH_MS;
    this.logger = options.logger;
    this.ready = this.load();
  }

  /** Counts one activity entry; ignores entries without `provider`. Day = localDayKey(entry.time). */
  add(entry: ActivityEntry): void {
    if (!entry.provider) return;
    const day = localDayKey(entry.time);
    const delta: UsageCounts = {
      requests: 1, errors: entry.status >= 400 || entry.error !== undefined ? 1 : 0,
      inputTokens: count(entry.inputTokens), outputTokens: count(entry.outputTokens), estimated: entry.estimated ? 1 : 0,
    };
    addInto((this.days[day] ??= {})[entry.provider] ??= zero(), delta);
    addInto(this.totals[entry.provider] ??= zero(), delta);
    this.since ??= day;
    this.prune();
    this.markDirty();
    this.emit("change");
  }

  summary(providerIds: readonly string[]): UsageView {
    const dayKeys = this.lastDayKeys(CHART_DAYS);
    const found = new Set<string>(Object.keys(this.totals));
    for (const bucket of Object.values(this.days)) for (const id of Object.keys(bucket)) found.add(id);
    const ids = [...new Set(providerIds)];
    for (const id of [...found].sort()) if (!ids.includes(id)) ids.push(id);
    const sum = (id: string, keys: string[]): UsageCounts => {
      const result = zero();
      for (const key of keys) { const counts = this.days[key]?.[id]; if (counts) addInto(result, counts); }
      return result;
    };
    const today = dayKeys[dayKeys.length - 1]!;
    const providers: UsageProviderView[] = ids.map((id) => ({
      id, today: sum(id, [today]), last7: sum(id, dayKeys.slice(-7)), last30: sum(id, dayKeys), allTime: { ...zero(), ...(this.totals[id] ?? {}) },
    }));
    const total = Object.fromEntries((["today", "last7", "last30", "allTime"] as const).map((range: UsageRangeKey) => {
      const counts = zero();
      for (const provider of providers) addInto(counts, provider[range]);
      return [range, counts];
    })) as Record<UsageRangeKey, UsageCounts>;
    const days: UsageDayView[] = dayKeys.map((day) => ({ day, byProvider: Object.fromEntries(ids.map((id) => [id, sum(id, [day])])) }));
    return { generatedAt: this.now(), today, ...(this.since ? { since: this.since } : {}), providers, total, days };
  }

  /** Zeroes everything, sets `since` to today, writes the file at once (awaited), emits "change". Rejects when the write ultimately fails. */
  async reset(): Promise<void> {
    await this.ready;
    this.totals = {}; this.days = {}; this.since = localDayKey(this.now());
    this.markDirty(false);
    this.emit("change");
    await this.write(true);
  }

  /** Writes pending changes now (awaits `ready` first); resolves when the write is done. No-op without a file or without changes. */
  async flush(): Promise<void> {
    await this.ready;
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    if (!this.file || !this.dirty) return this.chain;
    await this.write();
  }

  /** The last `n` local day keys, oldest first, today last. Stepping a local Date with setDate is DST-safe. */
  private lastDayKeys(n: number): string[] {
    const date = new Date(this.now());
    const keys: string[] = [];
    for (let index = 0; index < n; index++) { keys.unshift(localDayKey(date.getTime())); date.setDate(date.getDate() - 1); }
    return keys;
  }

  private prune(): void {
    const oldestKept = this.lastDayKeys(this.retainDays)[0]!;
    for (const key of Object.keys(this.days)) if (key < oldestKept) delete this.days[key];
  }

  private markDirty(schedule = true): void {
    this.dirty = true;
    if (!schedule || !this.file || this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.write(); }, this.flushMs);
    this.timer.unref();
  }

  private async load(): Promise<void> {
    if (!this.file) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(await fs.readFile(this.file, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.logger?.warn(`Usage file could not be read (${error instanceof Error ? error.message.split("\n")[0] : String(error)}); starting empty.`);
      return;
    }
    if (!isRecord(parsed) || parsed.version !== 1) { this.logger?.warn("Usage file has an unknown format; starting empty."); return; }
    if (isRecord(parsed.totals)) for (const [id, value] of Object.entries(parsed.totals)) addInto(this.totals[id] ??= zero(), sanitize(value));
    if (isRecord(parsed.days)) {
      for (const [day, bucket] of Object.entries(parsed.days)) {
        if (!DAY_KEY.test(day) || !isRecord(bucket)) continue;
        for (const [id, value] of Object.entries(bucket)) addInto((this.days[day] ??= {})[id] ??= zero(), sanitize(value));
      }
    }
    if (typeof parsed.since === "string" && DAY_KEY.test(parsed.since) && (!this.since || parsed.since < this.since)) this.since = parsed.since;
    this.prune();
  }

  /** Serializes the current state now and queues the write; resolves when it is on disk. */
  private write(strict = false): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    const file = this.file;
    if (!file) { this.dirty = false; return Promise.resolve(); }
    const run = async (): Promise<void> => {
      await this.ready;
      this.dirty = false;
      const data: UsageFile = { version: 1, ...(this.since ? { since: this.since } : {}), totals: this.totals, days: this.days };
      const text = JSON.stringify(data, null, 2) + "\n";
      try {
        await fs.mkdir(path.dirname(file), { recursive: true });
        const tmp = `${file}.tmp-${process.pid}`;
        await fs.writeFile(tmp, text, "utf8");
        for (let attempt = 0; ; attempt++) {
          try { await fs.rename(tmp, file); return; } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (attempt >= 4 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) { await fs.rm(tmp, { force: true }).catch(() => undefined); throw error; }
            await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
          }
        }
      } catch (error) {
        this.dirty = true;
        this.logger?.warn(`Usage file could not be written: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
        if (strict) throw error;
      }
    };
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => undefined);
    return next;
  }
}
