import { afterAll, afterEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import path from "node:path";
import OpenAI from "openai";
import { createLogger } from "../src/logger.js";
import type { ModelInfo, Provider } from "../src/provider.js";
import { ProviderRouter } from "../src/router.js";
import { UsageLimitError } from "../src/usage-limit.js";
import { createProxyServer } from "../src/server.js";
import type { ProxyConfig } from "../src/config.js";
import { tempRoot } from "./helpers/temp-root.js";

const tmp = tempRoot("router");
const config: ProxyConfig = { host: "127.0.0.1", port: 0, maxBodyBytes: 1024, timeoutMs: 5000, workRoot: tmp, acpArgs: [] };
afterAll(() => { rmSync(tmp, { recursive: true, force: true }); });

interface FakeOptions { unprefixed?: boolean; ownedBy?: string; delayMs?: number; static?: boolean; }
function fake(id: string, models: string[], options: FakeOptions = {}): Provider {
  const list: ModelInfo[] = models.map((model) => ({ id: model }));
  return {
    id, displayName: id, ownedBy: options.ownedBy ?? id, exposeUnprefixed: options.unprefixed ?? false,
    ...(options.static ? { staticModels: list } : {}),
    async generate(model, _messages, callbacks) { callbacks?.onText?.(`${id}:${model}`); return { text: `${id}:${model}`, stopReason: "end_turn", usage: null }; },
    async listModels() { if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs)); return list; },
    status: () => ({ id, name: id, state: "ready", authMethods: [], models: list }),
    async login() { /* not needed */ },
    onStatus: () => () => undefined,
    async close() { /* nothing to release */ },
  };
}

const servers: ReturnType<typeof createProxyServer>[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))); });

async function serve(router: ProviderRouter): Promise<string> {
  const server = createProxyServer(config, router); servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, config.host, resolve));
  return `http://${config.host}:${(server.address() as AddressInfo).port}/v1`;
}
const ids = (models: Array<{ id: string }>) => models.map((model) => model.id);

describe("ProviderRouter", () => {
  it("listBareAliases false lists only prefixed ids and still routes bare ids", async () => {
    const router = new ProviderRouter({ providers: [fake("codex", ["gpt-a"], { unprefixed: true, static: true }), fake("agy", ["gem-1"])], listBareAliases: false });
    expect(ids(await router.listModels())).toEqual(["codex/gpt-a", "agy/gem-1"]);
    expect((await router.generate("gpt-a", [])).text).toBe("codex:gpt-a");
    expect(router.hasModel("gpt-a")).toBe(true);
    const base = await serve(router);
    const res = await fetch(`${base}/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "gpt-a", messages: [{ role: "user", content: "hi" }] }) });
    expect(res.status).toBe(200);
  });

  it("routes prefixed and unprefixed ids", async () => {
    const router = new ProviderRouter({ providers: [fake("codex", ["gpt-a"], { unprefixed: true, static: true }), fake("agy", ["gem-1", "gem-2"])] });
    await router.listModels();
    expect(ids(await router.listModels())).toEqual(["gpt-a", "codex/gpt-a", "agy/gem-1", "agy/gem-2"]);
    expect((await router.generate("gpt-a", [])).text).toBe("codex:gpt-a");
    expect((await router.generate("codex/gpt-a", [])).text).toBe("codex:gpt-a");
    expect((await router.generate("agy/gem-2", [])).text).toBe("agy:gem-2");
    expect(router.hasModel("gem-1")).toBe(false);
  });

  it("keeps the first unprefixed owner on collisions and warns", async () => {
    const logger = createLogger({ console: false });
    const router = new ProviderRouter({ providers: [fake("one", ["shared", "only-one"], { unprefixed: true }), fake("two", ["shared"], { unprefixed: true })], logger });
    expect(ids(await router.listModels())).toEqual(["shared", "one/shared", "only-one", "one/only-one", "two/shared"]);
    expect((await router.generate("shared", [])).text).toBe("one:shared");
    expect((await router.generate("two/shared", [])).text).toBe("two:shared");
    expect(logger.recent().filter((entry) => entry.level === "warn" && entry.message.includes("shared"))).toHaveLength(1);
  });

  it("does not know models of providers that are not registered (disabled)", async () => {
    const router = new ProviderRouter({ providers: [fake("codex", ["gpt-a"], { unprefixed: true })] });
    await router.listModels();
    expect(router.hasModel("agy/gem-1")).toBe(false);
    await expect(router.generate("agy/gem-1", [])).rejects.toMatchObject({ status: 404 });
  });

  it("accepts any id for a provider whose models are not discovered yet, but rejects ids once they are", async () => {
    const empty = fake("agy", []);
    const router = new ProviderRouter({ providers: [empty] });
    expect(router.hasModel("agy/whatever")).toBe(true);
    const router2 = new ProviderRouter({ providers: [fake("agy", ["a"])] });
    await router2.listModels();
    expect(router2.hasModel("agy/whatever")).toBe(false);
  });

  it("omits a slow provider after waitMs and includes it once discovered", async () => {
    const router = new ProviderRouter({ providers: [fake("fast", ["f"]), fake("slow", ["s"], { delayMs: 300 })] });
    expect(ids(await router.listModels({ waitMs: 30 }))).toEqual(["fast/f"]);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(ids(await router.listModels({ waitMs: 30 }))).toEqual(["fast/f", "slow/s"]);
  });

  it("persists discovered models and serves them from cache before discovery", async () => {
    mkdirSync(tmp, { recursive: true });
    const cachePath = path.join(tmp, `models-cache-${process.pid}.json`);
    rmSync(cachePath, { force: true });
    const first = new ProviderRouter({ providers: [fake("agy", ["g1", "g2"])], cachePath });
    await first.refresh();
    await first.close();
    expect(JSON.parse(readFileSync(cachePath, "utf8")).providers.agy.map((model: ModelInfo) => model.id)).toEqual(["g1", "g2"]);
    const second = new ProviderRouter({ providers: [fake("agy", ["g1", "g2"], { delayMs: 500 })], cachePath });
    expect(ids(await second.listModels({ waitMs: 10 }))).toEqual(["agy/g1", "agy/g2"]);
    writeFileSync(cachePath, "not json");
    expect(new ProviderRouter({ providers: [fake("agy", [])], cachePath }).knownModels("agy")).toEqual([]);
  });

  it("serves the OpenAI SDK across two providers with owned_by and echoed ids", async () => {
    const router = new ProviderRouter({ providers: [fake("codex", ["gpt-a"], { unprefixed: true, ownedBy: "openai", static: true }), fake("agy", ["gem-1"], { ownedBy: "google" })] });
    const openai = new OpenAI({ apiKey: "x", baseURL: await serve(router) });
    const models = await openai.models.list();
    expect(models.data.map((model) => [model.id, model.owned_by])).toEqual([["gpt-a", "openai"], ["codex/gpt-a", "openai"], ["agy/gem-1", "google"]]);
    const chat = await openai.chat.completions.create({ model: "agy/gem-1", messages: [{ role: "user", content: "hi" }] });
    expect(chat.model).toBe("agy/gem-1"); expect(chat.choices[0]?.message.content).toBe("agy:gem-1");
    const response = await openai.responses.create({ model: "gpt-a", input: "hi" });
    expect(response.model).toBe("gpt-a"); expect(response.output_text).toBe("codex:gpt-a");
    const stream = await openai.chat.completions.create({ model: "codex/gpt-a", messages: [{ role: "user", content: "hi" }], stream: true });
    let text = ""; for await (const chunk of stream) text += chunk.choices[0]?.delta.content ?? "";
    expect(text).toBe("codex:gpt-a");
    await expect(openai.chat.completions.create({ model: "agy/nope", messages: [{ role: "user", content: "hi" }] })).rejects.toThrow(/does not exist/);
  });
});

describe("ProviderRouter.acceptsImages", () => {
  it("answers the provider's own image capability: true, false, or undefined before it has started", async () => {
    const withImage = (id: string, image: boolean | undefined): Provider => { const base = fake(id, ["m"], { static: true }); return { ...base, status: () => ({ ...base.status(), ...(image === undefined ? {} : { capabilities: { image } }) }) }; };
    const router = new ProviderRouter({ providers: [withImage("yes", true), withImage("no", false), withImage("cold", undefined)] });
    expect(router.acceptsImages("yes/m")).toBe(true);
    expect(router.acceptsImages("no/m")).toBe(false);
    expect(router.acceptsImages("cold/m")).toBeUndefined();
    expect(router.acceptsImages("nobody/m")).toBeUndefined();
  });
});

describe("ProviderRouter usage limit", () => {
  const limited = (id: string, calls: { n: number }, fail: { on: boolean }): Provider => ({
    ...fake(id, ["m"]),
    async generate() { calls.n++; if (fail.on) throw new UsageLimitError("limit", "try again at Nov 29th, 2026 11:07 AM."); return { text: "ok", stopReason: "end_turn", usage: null }; },
  });
  const msgs = [{ role: "user" as const, parts: [{ type: "text" as const, text: "hi" }] }];

  it("refuses without calling the provider until the time passes, clears on a success, never touches another provider", async () => {
    let now = new Date(2026, 10, 26, 12, 0).getTime();
    const calls = { n: 0 }, fail = { on: true };
    let changes = 0;
    const router = new ProviderRouter({ providers: [limited("a", calls, fail), fake("b", ["m"])], logger: createLogger({ console: false }), now: () => now, onExhaustedChange: () => { changes++; } });
    await expect(router.generate("a/m", msgs)).rejects.toMatchObject({ status: 429, code: "usage_limit_exceeded" });
    expect(calls.n).toBe(1);
    expect(changes).toBe(1);
    expect(() => router.checkPrompt("a/m", msgs)).toThrow(UsageLimitError);
    await expect(router.generate("a/m", msgs)).rejects.toMatchObject({ code: "usage_limit_exceeded", retryAfterSeconds: expect.any(Number) });
    expect(calls.n).toBe(1);
    await expect(router.generate("b/m", msgs)).resolves.toMatchObject({ text: "b:m" });
    expect(Object.keys(router.exhaustedProviders())).toEqual(["a"]);
    expect(changes).toBe(1);

    now = new Date(2026, 10, 29, 11, 7).getTime();
    fail.on = false;
    expect(router.exhaustedProviders()).toEqual({});
    await expect(router.generate("a/m", msgs)).resolves.toMatchObject({ text: "ok" });
    expect(calls.n).toBe(2);
    expect(changes).toBe(1);
  });

  it("uses the cooldown when the reset time is unknown", async () => {
    const now = new Date(2026, 10, 26, 12, 0).getTime();
    const failing: Provider = { ...fake("a", ["m"]), async generate() { throw new UsageLimitError("limit"); } };
    const router = new ProviderRouter({ providers: [failing], logger: createLogger({ console: false }), now: () => now, usageLimit: { cooldownMs: 5 * 60_000 } });
    await expect(router.generate("a/m", msgs)).rejects.toMatchObject({ retryAfterSeconds: 300 });
    expect(router.exhaustedProviders()).toEqual({ a: new Date(now + 300_000).toISOString() });
  });

  it("keeps the usage-limit state across a restart", async () => {
    let now = new Date(2026, 10, 26, 12, 0).getTime();
    const exhaustedPath = path.join(tmp, "exhausted-restart", "exhausted.json");
    const make = (providers: Provider[]): ProviderRouter => new ProviderRouter({ providers, logger: createLogger({ console: false }), now: () => now, exhaustedPath, usageLimit: { cooldownMs: 5 * 60_000 } });
    const first = make([{ ...fake("a", ["m"]), async generate() { throw new UsageLimitError("limit"); } }]);
    await expect(first.generate("a/m", msgs)).rejects.toMatchObject({ code: "usage_limit_exceeded" });
    await first.close();
    const until = new Date(now + 300_000).toISOString();
    expect(JSON.parse(readFileSync(exhaustedPath, "utf8"))).toEqual({ version: 1, providers: { a: { until } } });

    // Router B: a passed entry is dropped, an entry of a provider that is not in this run is kept.
    const other = new Date(now + 600_000).toISOString();
    writeFileSync(exhaustedPath, JSON.stringify({ version: 1, providers: { a: { until }, gone: { until: new Date(now - 60_000).toISOString() }, off: { until: other } } }));
    const calls = { n: 0 }, fail = { on: false };
    const probe = { available: false };
    const second = make([{ ...limited("a", calls, fail), usageLimitState: () => (probe.available ? null : undefined) }]);
    expect(second.exhaustedProviders()).toEqual({ a: until });
    await expect(second.generate("a/m", msgs)).rejects.toMatchObject({ status: 429, code: "usage_limit_exceeded" });
    expect(calls.n).toBe(0);
    // A probe that reports the limit is not used up any more clears the mark and rewrites the file (a passed time alone does not write).
    probe.available = true;
    await second.listModels({ force: true });
    expect(second.exhaustedProviders()).toEqual({});
    await second.close();
    expect(JSON.parse(readFileSync(exhaustedPath, "utf8"))).toEqual({ version: 1, providers: { off: { until: other } } });
  });
});
