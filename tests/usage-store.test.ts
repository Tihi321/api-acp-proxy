import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ActivityEntry } from "../src/activity.js";
import { localDayKey, UsageStore, type UsageFile } from "../src/usage-store.js";

const root = path.resolve(".claude/temp/usage-store-tests", String(process.pid));
mkdirSync(root, { recursive: true });
let counter = 0;
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

const NOW = new Date(2026, 10, 8, 14, 30).getTime();
const daysAgo = (days: number): number => { const date = new Date(NOW); date.setDate(date.getDate() - days); return date.getTime(); };
function entry(provider: string | undefined, daysBack: number, extra: Partial<ActivityEntry> = {}): ActivityEntry {
  return { time: daysAgo(daysBack), endpoint: "POST /v1/chat/completions", stream: false, features: [], durationMs: 5, status: 200, ...(provider ? { provider } : {}), ...extra };
}
const file = (): string => path.join(root, `case-${counter++}`, "usage.json");

describe("UsageStore", () => {
  it("counts requests, errors, tokens and estimates per provider and local day", () => {
    const store = new UsageStore({ now: () => NOW });
    store.add(entry("codex", 0, { inputTokens: 10, outputTokens: 5 }));
    store.add(entry("codex", 0, { status: 503, error: "provider_unavailable" }));
    store.add(entry("codex", 0, { inputTokens: 4, outputTokens: 2, estimated: true }));
    store.add(entry("claude", 3, { inputTokens: 7, outputTokens: 1 }));
    store.add(entry("codex", 10, { inputTokens: 1, outputTokens: 1 }));
    store.add(entry("codex", 40, { inputTokens: 2, outputTokens: 2 }));
    store.add(entry(undefined, 0, { inputTokens: 99, outputTokens: 99 }));
    const view = store.summary(["codex", "claude", "antigravity"]);

    expect(view.today).toBe(localDayKey(NOW));
    expect(view.providers.map((provider) => provider.id)).toEqual(["codex", "claude", "antigravity"]);
    const [codex, claude, antigravity] = view.providers;
    expect(codex!.today).toEqual({ requests: 3, errors: 1, inputTokens: 14, outputTokens: 7, estimated: 1 });
    expect(codex!.last7).toEqual(codex!.today);
    expect(codex!.last30).toEqual({ requests: 4, errors: 1, inputTokens: 15, outputTokens: 8, estimated: 1 });
    expect(codex!.allTime).toEqual({ requests: 5, errors: 1, inputTokens: 17, outputTokens: 10, estimated: 1 });
    expect(claude!.today.requests).toBe(0);
    expect(claude!.last7).toEqual({ requests: 1, errors: 0, inputTokens: 7, outputTokens: 1, estimated: 0 });
    expect(antigravity!.allTime.requests).toBe(0);
    expect(view.total.today.requests).toBe(3);
    expect(view.total.last7.requests).toBe(4);
    expect(view.total.last30.requests).toBe(5);
    expect(view.total.allTime).toEqual({ requests: 6, errors: 1, inputTokens: 24, outputTokens: 11, estimated: 1 });

    expect(view.days).toHaveLength(30);
    expect(view.days[29]!.day).toBe(view.today);
    expect(view.days[26]!.day).toBe(localDayKey(daysAgo(3)));
    expect(view.days[26]!.byProvider.claude!.requests).toBe(1);
    expect(view.days[25]!.byProvider.claude!.requests).toBe(0);
    expect(Object.keys(view.days[0]!.byProvider)).toEqual(["codex", "claude", "antigravity"]);
    expect(view.since).toBe(localDayKey(daysAgo(0)));
  });

  it("persists to usage.json, prunes old days, keeps all-time totals, and survives a broken file", async () => {
    const target = file();
    const store = new UsageStore({ file: target, now: () => NOW, retainDays: 5 });
    store.add(entry("codex", 0, { inputTokens: 3, outputTokens: 4 }));
    store.add(entry("codex", 8, { inputTokens: 1, outputTokens: 1 }));
    await store.flush();

    const saved = JSON.parse(readFileSync(target, "utf8")) as UsageFile;
    expect(Object.keys(saved.days)).toEqual([localDayKey(NOW)]);
    expect(saved.totals.codex!.requests).toBe(2);
    const reloaded = new UsageStore({ file: target, now: () => NOW, retainDays: 5 });
    await reloaded.ready;
    expect(reloaded.summary(["codex"]).providers).toEqual(store.summary(["codex"]).providers);
    expect(reloaded.summary(["codex"]).total.allTime.requests).toBe(2);
    expect(reloaded.summary(["codex"]).total.last30.requests).toBe(1);

    const broken = file();
    mkdirSync(path.dirname(broken), { recursive: true });
    writeFileSync(broken, "{not json");
    const empty = new UsageStore({ file: broken, now: () => NOW });
    await expect(empty.ready).resolves.toBeUndefined();
    expect(empty.summary(["codex"]).total.allTime.requests).toBe(0);
  });

  it("resets the totals and the file", async () => {
    const target = file();
    const store = new UsageStore({ file: target, now: () => NOW });
    store.add(entry("codex", 2, { inputTokens: 3 }));
    await store.flush();
    await store.reset();
    expect(store.summary(["codex"]).total.allTime).toEqual({ requests: 0, errors: 0, inputTokens: 0, outputTokens: 0, estimated: 0 });
    expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({ version: 1, since: localDayKey(NOW), totals: {}, days: {} });
    store.add(entry("codex", 0));
    expect(store.summary(["codex"]).total.today.requests).toBe(1);
    await expect(new UsageStore({ file: root, now: () => NOW }).reset()).rejects.toThrow();
  });
});
