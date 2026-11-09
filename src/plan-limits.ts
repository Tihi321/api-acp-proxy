import type { PlanLimitWindowView, PlanLimitsView, RateLimitHintView } from "./shared/ipc.js";
import type { Provider } from "./provider.js";

export type PlanLimits = PlanLimitsView;
export interface ParsedPlanLimits { windows: PlanLimitWindowView[]; plan?: string; credits?: string; }

const lines = (text: string): string[] => text.split(/\r?\n/).map((line) => line.trim());
const round1 = (value: number): number => Math.round(value * 10) / 10;
const clampPercent = (value: number): number => Math.min(100, Math.max(0, round1(value)));

const CODEX_WINDOW = /^\*\*(.+?):\*\*\s*(\d+(?:\.\d+)?)% left\b(?:\s*\((.*)\))?/;
const CODEX_CREDITS = /^\*\*(?:.*\s)?Credits:\*\*\s*(.+)$/i;
const CODEX_RESETS = /(?:^|;\s*)resets\s+(.+)$/i;

/** Codex `/status` markdown (codex-acp 2.3.0). undefined when the text is not a status message. */
export function parseCodexStatus(text: string): ParsedPlanLimits | undefined {
  const windows: PlanLimitWindowView[] = [];
  let recognised = false;
  let plan: string | undefined;
  let credits: string | undefined;
  for (const line of lines(text)) {
    if (line.startsWith("**Model:**") || line.startsWith("**Limits:**")) recognised = true;
    const window = CODEX_WINDOW.exec(line);
    if (window && /limit$/i.test(window[1]!.trim())) {
      recognised = true;
      const reset = window[3] !== undefined ? CODEX_RESETS.exec(window[3])?.[1]?.trim() : undefined;
      windows.push({ label: window[1]!.trim(), usedPercent: clampPercent(100 - Number(window[2])), ...(reset ? { resetText: reset } : {}) });
      continue;
    }
    const account = /^\*\*Account:\*\*\s*(.*)$/.exec(line)?.[1]?.trim();
    if (account !== undefined) {
      if (/^API key/i.test(account)) plan = "API key";
      else if (/^ChatGPT\b/i.test(account)) plan = account.replace(/\s*\(.*\)\s*$/, "").trim();
      continue;
    }
    const credit = CODEX_CREDITS.exec(line)?.[1]?.trim();
    if (credit) credits = credit;
  }
  if (!recognised) return undefined;
  return { windows, ...(plan ? { plan } : {}), ...(credits ? { credits } : {}) };
}

const CLAUDE_WINDOW = /^\*\*(.+?)\*\*\s*—\s*\*\*(\d+(?:\.\d+)?)%\*\*(?:\s*·\s*Resets\s+(.+))?$/;

/** Claude `/usage` markdown (claude-agent-acp 0.91.0). undefined when the text is not a usage message. */
export function parseClaudeUsage(text: string): ParsedPlanLimits | undefined {
  const windows: PlanLimitWindowView[] = [];
  let recognised = false;
  let plan: string | undefined;
  for (const line of lines(text)) {
    if (line === "---" && windows.length) break;
    if (line === "## Usage") recognised = true;
    const window = CLAUDE_WINDOW.exec(line);
    if (window) {
      recognised = true;
      const reset = window[3]?.trim();
      windows.push({ label: window[1]!.replace(/\\(.)/g, "$1"), usedPercent: clampPercent(Number(window[2])), ...(reset ? { resetText: reset } : {}) });
      continue;
    }
    const type = /^>\s*Claude\s+(\S+)\s+subscription usage/i.exec(line)?.[1];
    if (type) plan = `Claude ${type}`;
  }
  if (!recognised) return undefined;
  return { windows, ...(plan ? { plan } : {}) };
}

/** Removes e-mail addresses, lines with a "$" amount, "**Account:**", "**Directory:**", "**Session:**" lines and everything from "### This session" on; trims to 4000 characters. */
export function redactLimitsText(text: string): string {
  const cut = /^#{1,6}\s*This session\b/im.exec(text);
  const head = cut ? text.slice(0, cut.index) : text;
  const kept = head.split(/\r?\n/).filter((line) => !/\$\s?\d/.test(line) && !/^\s*\*\*(?:Account|Directory|Session):\*\*/i.test(line));
  return kept.join("\n").replace(/[^\s@()<>"']+@[^\s@()<>"']+\.[^\s@()<>"']+/g, "").trim().slice(0, 4000);
}

/** Reads `_meta["_claude/rateLimit"]` of a usage_update; undefined when absent or invalid. */
export function readRateLimitHint(meta: unknown, now: number): RateLimitHintView | undefined {
  const raw = meta && typeof meta === "object" ? (meta as Record<string, unknown>)["_claude/rateLimit"] : undefined;
  if (!raw || typeof raw !== "object") return undefined;
  const info = raw as { status?: unknown; rateLimitType?: unknown; utilization?: unknown; resetsAt?: unknown };
  if (info.status !== "allowed" && info.status !== "allowed_warning" && info.status !== "rejected") return undefined;
  const utilization = typeof info.utilization === "number" && Number.isFinite(info.utilization) ? round1(info.utilization <= 1 ? info.utilization * 100 : info.utilization) : undefined;
  const resetsAt = typeof info.resetsAt === "number" && Number.isFinite(info.resetsAt) ? (info.resetsAt < 1e12 ? info.resetsAt * 1000 : info.resetsAt) : undefined;
  return { status: info.status, ...(typeof info.rateLimitType === "string" ? { rateLimitType: info.rateLimitType } : {}), ...(utilization !== undefined ? { utilization } : {}), ...(resetsAt !== undefined ? { resetsAt } : {}), at: now };
}

export interface PlanLimitsCacheDeps {
  providerIds(): string[];
  supported(id: string): boolean;
  /** The running provider and a probe that goes through the router's limiter; undefined when the server is stopped or the provider is off. */
  live(id: string): { provider: Provider; probe(signal: AbortSignal): Promise<PlanLimits> } | undefined;
  now?: () => number;
}

const UNSUPPORTED = "Plan limits are not available for this provider.";
const PROBE_TIMEOUT_MS = 45_000;

/** Plan limits per provider, fetched on demand and kept for `maxAgeMs`. Never probes on its own. */
export class PlanLimitsCache {
  private readonly cache = new Map<string, { view: PlanLimits; at: number }>();
  private readonly inflight = new Map<string, Promise<PlanLimits>>();

  constructor(private readonly deps: PlanLimitsCacheDeps, private readonly maxAgeMs = 60_000) {}

  private now(): number { return (this.deps.now ?? Date.now)(); }

  private withHint(id: string, view: PlanLimits): PlanLimits {
    const hint = this.deps.live(id)?.provider.rateLimitHint?.();
    return hint ? { ...view, hint } : view;
  }

  private fresh(id: string): PlanLimits | undefined {
    const entry = this.cache.get(id);
    if (!entry || !["ok", "no_data", "unparsed"].includes(entry.view.state) || this.now() - entry.at >= this.maxAgeMs) return undefined;
    return entry.view;
  }

  /** One entry per provider id, from the cache only (never probes): unsupported / unavailable / idle when nothing is cached; `hint` merged from the live provider. */
  list(): PlanLimits[] {
    return this.deps.providerIds().map((id) => {
      const cached = this.cache.get(id)?.view;
      const view: PlanLimits = !this.deps.supported(id) ? { provider: id, state: "unsupported", windows: [], message: UNSUPPORTED }
        : cached ?? (this.deps.live(id) ? { provider: id, state: "idle", windows: [] } : { provider: id, state: "unavailable", windows: [], message: "Turn the provider on and start the server first." });
      return this.withHint(id, view);
    });
  }

  /** Probes unless `force` is false and a cached `ok` / `no_data` / `unparsed` value is younger than maxAgeMs; concurrent calls for one id share one probe. */
  async get(id: string, force = false): Promise<PlanLimits> {
    if (!this.deps.supported(id)) return { provider: id, state: "unsupported", windows: [], message: UNSUPPORTED };
    const live = this.deps.live(id);
    if (!live) return { provider: id, state: "unavailable", windows: [], message: "Turn the provider on and start the server first." };
    if (live.provider.status().state === "needs_login") return this.withHint(id, { provider: id, state: "needs_login", windows: [], message: `Log in to ${live.provider.displayName} to see its plan limits.` });
    const cached = force ? undefined : this.fresh(id);
    if (cached) return this.withHint(id, cached);
    let pending = this.inflight.get(id);
    if (!pending) {
      const mine: { promise?: Promise<PlanLimits> } = {};
      pending = mine.promise = (async (): Promise<PlanLimits> => {
        let view: PlanLimits;
        try { view = { ...(await live.probe(AbortSignal.timeout(PROBE_TIMEOUT_MS))), provider: id }; }
        catch (error) { view = { provider: id, state: "error", windows: [], message: error instanceof Error ? error.message : String(error) }; }
        view = { ...view, windows: view.windows ?? [] };
        if (this.inflight.get(id) === mine.promise) this.cache.set(id, { view, at: this.now() });
        return view;
      })().finally(() => { if (this.inflight.get(id) === mine.promise) this.inflight.delete(id); });
      this.inflight.set(id, pending);
    }
    return this.withHint(id, await pending);
  }

  /** Drops the cached value of one provider (after a logout). */
  forget(id: string): void {
    this.cache.delete(id);
    this.inflight.delete(id);
  }
}
