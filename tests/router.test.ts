import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import path from "node:path";
import OpenAI from "openai";
import { createLogger } from "../src/logger.js";
import type { ModelInfo, Provider } from "../src/provider.js";
import { ProviderRouter } from "../src/router.js";
import { createProxyServer } from "../src/server.js";
import type { ProxyConfig } from "../src/config.js";

const config: ProxyConfig = { host: "127.0.0.1", port: 0, maxBodyBytes: 1024, timeoutMs: 5000, workRoot: ".claude/temp/router-tests", acpArgs: [] };
const tmp = path.resolve(".claude/temp/router-tests");

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
