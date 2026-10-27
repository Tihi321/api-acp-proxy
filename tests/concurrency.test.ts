import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { createLogger } from "../src/logger.js";
import type { ModelInfo, Provider } from "../src/provider.js";
import { ProviderRouter } from "../src/router.js";
import { createProxyServer } from "../src/server.js";
import type { ProxyConfig } from "../src/config.js";
import { defaultSettings, resolveConfig } from "../src/settings.js";

const config: ProxyConfig = { host: "127.0.0.1", port: 0, maxBodyBytes: 1024 * 1024, timeoutMs: 5000, workRoot: ".claude/temp/concurrency-tests", acpArgs: [] };

/** A provider whose turn takes `delayMs` (or ends when aborted), counting how many run at once. */
function slow(id: string, delayMs = 40) {
  const models: ModelInfo[] = [{ id: "m" }];
  const state = { active: 0, peak: 0, started: 0, failNext: false };
  const provider: Provider = {
    id, displayName: id, ownedBy: id, exposeUnprefixed: false, staticModels: models,
    async generate(_model, _messages, _callbacks, signal) {
      state.active++; state.started++; state.peak = Math.max(state.peak, state.active);
      try {
        await new Promise<void>((resolve) => { const timer = setTimeout(resolve, delayMs); signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true }); });
        if (state.failNext) { state.failNext = false; throw new Error("boom"); }
        return { text: "ok", stopReason: "end_turn", usage: null };
      } finally { state.active--; }
    },
    async listModels() { return models; },
    status: () => ({ id, name: id, state: "ready", authMethods: [], models }),
    async login() { /* not needed */ },
    onStatus: () => () => undefined,
    async close() { /* nothing */ },
  };
  return { provider, state };
}

const servers: ReturnType<typeof createProxyServer>[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections?.(); }))); });

async function serve(router: ProviderRouter, cfg: ProxyConfig = config): Promise<string> {
  const server = createProxyServer(cfg, router); servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, cfg.host, resolve));
  return `http://${cfg.host}:${(server.address() as AddressInfo).port}`;
}
const chat = (base: string, stream = false, signal?: AbortSignal) => fetch(`${base}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "p/m", stream, messages: [{ role: "user", content: "hi" }] }), signal });
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("provider concurrency cap", () => {
  it("runs at most N of N+k concurrent requests at once (non-stream and stream), then all finish", async () => {
    const { provider, state } = slow("p");
    const router = new ProviderRouter({ providers: [provider], logger: createLogger({ console: false }), concurrency: { maxConcurrent: 3 } });
    const base = await serve(router);
    const replies = await Promise.all(Array.from({ length: 10 }, (_, i) => chat(base, i % 2 === 0)));
    expect(replies.every((reply) => reply.status === 200)).toBe(true);
    await Promise.all(replies.map((reply) => reply.text()));
    expect(state.started).toBe(10);
    expect(state.peak).toBe(3);
    expect(router.queueStats().p).toMatchObject({ active: 0, queued: 0, limit: 3 });
  });

  it("shows active and queued counts in /healthz and logs the wait", async () => {
    const { provider } = slow("p", 150);
    const logger = createLogger({ console: false });
    const router = new ProviderRouter({ providers: [provider], logger, concurrency: { maxConcurrent: 1 } });
    const base = await serve(router);
    const pending = [chat(base), chat(base), chat(base)];
    await wait(60);
    const health = await (await fetch(`${base}/healthz`)).json() as { providers: Record<string, unknown> };
    expect(health.providers.p).toEqual({ active: 1, queued: 2, max_concurrent: 1, max_queue: 0 });
    expect(logger.recent().some((entry) => entry.message.includes("waits in the queue"))).toBe(true);
    await Promise.all(pending.map(async (reply) => (await reply).text()));
  });

  it("answers 429 rate_limit_error when the queue is full", async () => {
    const { provider } = slow("p", 150);
    const router = new ProviderRouter({ providers: [provider], concurrency: { maxConcurrent: 1, maxQueue: 1 } });
    const base = await serve(router);
    const replies = await Promise.all([chat(base), chat(base), chat(base)]);
    expect(replies.map((reply) => reply.status).sort()).toEqual([200, 200, 429]);
    const rejected = replies.find((reply) => reply.status === 429)!;
    expect(await rejected.json()).toMatchObject({ error: { code: "provider_queue_full", type: "rate_limit_error" } });
  });

  it("frees the slot after a failed turn and drops a queued request whose client left", async () => {
    const { provider, state } = slow("p", 100);
    state.failNext = true;
    const router = new ProviderRouter({ providers: [provider], concurrency: { maxConcurrent: 1 } });
    const base = await serve(router);
    const first = chat(base);
    await wait(20);
    const leaving = new AbortController();
    const abandoned = chat(base, false, leaving.signal).catch(() => undefined);
    await wait(20);
    expect(router.queueStats().p).toMatchObject({ active: 1, queued: 1 });
    leaving.abort(); await abandoned;
    await wait(20);
    expect(router.queueStats().p?.queued).toBe(0);
    expect((await first).status).toBe(500);
    const next = await chat(base);
    expect(next.status).toBe(200);
    expect(state.started).toBe(2);
    expect(router.queueStats().p?.active).toBe(0);
  });

  it("counts the wait toward the request timeout", async () => {
    const { provider } = slow("p", 400);
    const router = new ProviderRouter({ providers: [provider], concurrency: { maxConcurrent: 1 } });
    const base = await serve(router, { ...config, timeoutMs: 150 });
    const [first, second] = await Promise.all([chat(base), chat(base)]);
    expect(first.status).toBe(504);
    expect(second.status).toBe(504);
  });

  it("limits each provider on its own, and a per-provider 0 is unlimited", async () => {
    const a = slow("a"); const b = slow("b");
    const router = new ProviderRouter({ providers: [a.provider, b.provider], concurrency: { maxConcurrent: 1, perProvider: { b: 0 } } });
    await Promise.all([...Array.from({ length: 4 }, () => router.generate("a/m", [])), ...Array.from({ length: 4 }, () => router.generate("b/m", []))]);
    expect(a.state.peak).toBe(1);
    expect(b.state.peak).toBe(4);
  });
});

describe("concurrency settings", () => {
  it("defaults to 4 per provider with no queue cap", () => {
    const { config: resolved, providers } = resolveConfig(defaultSettings(), {});
    expect(resolved.maxConcurrent).toBe(4);
    expect(resolved.maxQueue).toBe(0);
    expect(providers.codex?.maxConcurrent).toBeUndefined();
  });
  it("reads the environment, including 0, and marks the fields as overridden", () => {
    const resolved = resolveConfig(defaultSettings(), { PROXY_MAX_CONCURRENT: "0", PROXY_MAX_QUEUE: "7", PROXY_CODEX_MAX_CONCURRENT: "2", PROXY_CLAUDE_MAX_CONCURRENT: "0" });
    expect(resolved.config).toMatchObject({ maxConcurrent: 0, maxQueue: 7 });
    expect(resolved.providers.codex?.maxConcurrent).toBe(2);
    expect(resolved.providers.claude?.maxConcurrent).toBe(0);
    expect(resolved.overridden).toEqual(expect.arrayContaining(["server.maxConcurrent", "server.maxQueue", "providers.codex.maxConcurrent", "providers.claude.maxConcurrent"]));
  });
  it("ignores an invalid value", () => {
    expect(resolveConfig(defaultSettings(), { PROXY_MAX_CONCURRENT: "-1" }).config.maxConcurrent).toBe(4);
    expect(resolveConfig(defaultSettings(), { PROXY_MAX_CONCURRENT: "abc" }).config.maxConcurrent).toBe(4);
  });
});
