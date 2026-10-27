import { afterAll, afterEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ProxyController, type ProviderRegistration } from "../src/controller.js";
import { createLogger } from "../src/logger.js";
import type { Provider } from "../src/provider.js";
import { codexRegistration } from "../src/providers/codex.js";
import { defaultSettings, mergeSettings, type SettingsPatch } from "../src/settings.js";

const fixture = fileURLToPath(new URL("./fixtures/fake-acp.mjs", import.meta.url));
const root = path.resolve(".claude/temp/controller-tests", String(process.pid));
mkdirSync(root, { recursive: true });
let counter = 0;
const controllers: ProxyController[] = [];
const blockers: Server[] = [];
afterEach(async () => {
  await Promise.all(controllers.splice(0).map((controller) => controller.stop()));
  await Promise.all(blockers.splice(0).map((blocker) => new Promise<void>((resolve) => blocker.close(() => resolve()))));
  for (const key of Object.keys(process.env)) if (key.startsWith("FAKE_ACP_")) delete process.env[key];
});
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

/** `signedIn`: Codex's own home gets an `auth.json`, as after a login (the fake agent does not read it). */
function make(patch: SettingsPatch = {}, extra: { registry?: ProviderRegistration[]; drainMs?: number; signedIn?: boolean } = {}): ProxyController {
  const dir = path.join(root, `case-${counter++}`);
  mkdirSync(dir, { recursive: true });
  if (extra.signedIn) { mkdirSync(path.join(dir, "codex-home"), { recursive: true }); writeFileSync(path.join(dir, "codex-home", "auth.json"), "{}"); }
  const file = path.join(dir, "settings.json");
  const base = mergeSettings(defaultSettings(), { server: { port: 0, workRoot: path.join(dir, "work") }, providers: { codex: { acpCommand: process.execPath, acpArgs: [fixture] } } });
  writeFileSync(file, JSON.stringify(mergeSettings(base, patch)));
  const controller = new ProxyController({ settingsPath: file, env: {}, logger: createLogger({ console: false }), ...extra });
  controllers.push(controller);
  return controller;
}
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}
async function block(port: number): Promise<void> {
  const blocker = createServer();
  blockers.push(blocker);
  await new Promise<void>((resolve) => blocker.listen(port, "127.0.0.1", resolve));
}
const get = async (url: string) => (await fetch(url)).json() as Promise<{ data?: Array<{ id: string }>; status?: string }>;

describe("ProxyController", () => {
  // Codex runs in its own home: with a login it starts with the proxy to list its models; without one it is needs_login and nothing is started.
  it("starts, serves requests and stops", async () => {
    const controller = make({}, { signedIn: true });
    const events: string[] = [];
    controller.on("status", (status) => events.push(status.server.state));
    const status = await controller.start();
    expect(status.server.state).toBe("running");
    expect(status.server.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    expect(status.providers.map((provider) => [provider.id, provider.state])).toEqual([["codex", expect.stringMatching(/^(starting|ready)$/)], ["antigravity", "disabled"], ["claude", "disabled"]]); // Codex lists its models through the agent, which starts with the proxy.
    expect(((await get(`${status.server.baseUrl}/models`)).data ?? []).map((model) => model.id)).toContain("gpt-6-luna");
    const chat = await fetch(`${status.server.baseUrl}/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "gpt-6-luna", messages: [{ role: "user", content: "hi" }] }) });
    expect(((await chat.json()) as { choices: Array<{ message: { content: string } }> }).choices[0]?.message.content).toBe("fake response");
    expect((await controller.stop()).server.state).toBe("stopped");
    expect(events).toContain("starting");
    expect(events).toContain("running");
    expect(events.at(-1)).toBe("stopped");
  });

  it("reports EADDRINUSE as a status instead of throwing, and retries", async () => {
    const port = await freePort();
    await block(port);
    const controller = make({ server: { port } });
    const status = await controller.start();
    expect(status.server.state).toBe("error");
    expect(status.server.error?.code).toBe("EADDRINUSE");
    await Promise.all(blockers.splice(0).map((blocker) => new Promise<void>((resolve) => blocker.close(() => resolve()))));
    expect((await controller.start()).server).toMatchObject({ state: "running", port });
  });

  it("moves the server to a new port when settings are applied and persists them", async () => {
    const [first, second] = [await freePort(), await freePort()];
    const controller = make({ server: { port: first } });
    await controller.start();
    expect((await get(`http://127.0.0.1:${first}/healthz`)).status).toBe("ok");
    const status = await controller.applySettings({ server: { port: second } });
    expect(status.server).toMatchObject({ state: "running", port: second });
    expect((await get(`http://127.0.0.1:${second}/healthz`)).status).toBe("ok");
    await expect(fetch(`http://127.0.0.1:${first}/healthz`)).rejects.toThrow();
    expect(JSON.parse(readFileSync(controller.settingsPath, "utf8")).server.port).toBe(second);
  });

  it("recovers from a port conflict by applying a new port", async () => {
    const [busy, free] = [await freePort(), await freePort()];
    await block(busy);
    const controller = make({ server: { port: busy } });
    expect((await controller.start()).server.state).toBe("error");
    expect((await controller.applySettings({ server: { port: free } })).server).toMatchObject({ state: "running", port: free });
  });

  it("does not start when applying settings to a stopped controller, and rejects invalid patches", async () => {
    const controller = make();
    expect((await controller.applySettings({ server: { timeoutMs: 1234 } })).server.state).toBe("stopped");
    await expect(controller.applySettings({ server: { port: 70000 } })).rejects.toThrow();
    expect((await controller.getSettings()).settings.server.timeoutMs).toBe(1234);
  });

  it("logs in through ACP authenticate and lists auth methods", async () => {
    process.env.FAKE_ACP_AUTH_METHODS = JSON.stringify([{ id: "chat-gpt", name: "ChatGPT" }]);
    const controller = make();
    await controller.start();
    const status = await controller.login("codex");
    expect(status.providers[0]).toMatchObject({ state: "ready", authMethods: [{ id: "chat-gpt", name: "ChatGPT" }] });
    await expect(controller.login("nope")).rejects.toThrow(/not running/);
  });

  it("builds providers from registered factories only when enabled", async () => {
    const created: string[] = [];
    const extra: ProviderRegistration = {
      id: "antigravity", displayName: "Antigravity",
      create: ({ providerSettings }) => {
        created.push(String(providerSettings.enabled));
        const models = [{ id: "gem-1" }];
        const provider: Provider = {
          id: "antigravity", displayName: "Antigravity", ownedBy: "google", exposeUnprefixed: false,
          generate: async (model) => ({ text: `agy:${model}`, stopReason: "end_turn", usage: null }),
          listModels: async () => models,
          status: () => ({ id: "antigravity", name: "Antigravity", state: "ready", authMethods: [], models }),
          login: async () => undefined, onStatus: () => () => undefined, close: async () => undefined,
        };
        return provider;
      },
    };
    const controller = make({}, { registry: [codexRegistration, extra] });
    let status = await controller.start();
    expect(created).toEqual([]);
    expect(status.providers.map((provider) => [provider.id, provider.state])).toEqual([["codex", "needs_login"], ["antigravity", "disabled"]]);
    status = await controller.applySettings({ providers: { antigravity: { enabled: true } } });
    expect(created).toEqual(["true"]);
    status = await controller.refreshModels();
    expect(status.providers[1]).toMatchObject({ state: "ready", models: [{ id: "gem-1" }] });
    expect(((await get(`${status.server.baseUrl}/models`)).data ?? []).map((model) => model.id)).toContain("antigravity/gem-1");
  });

  it("force-closes in-flight requests after the drain period", async () => {
    const hanging: ProviderRegistration = {
      id: "codex", displayName: "Hang",
      create: () => ({
        id: "codex", displayName: "Hang", ownedBy: "x", exposeUnprefixed: true, staticModels: [{ id: "slow" }],
        generate: (_model, _messages, _callbacks, signal) => new Promise((_resolve, reject) => { signal?.addEventListener("abort", () => reject(new Error("aborted"))); }),
        listModels: async () => [{ id: "slow" }],
        status: () => ({ id: "codex", name: "Hang", state: "ready", authMethods: [], models: [] }),
        login: async () => undefined, onStatus: () => () => undefined, close: async () => undefined,
      }),
    };
    const controller = make({}, { registry: [hanging], drainMs: 100 });
    const status = await controller.start();
    const pending = fetch(`${status.server.baseUrl}/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "slow", messages: [{ role: "user", content: "hi" }] }) }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const started = Date.now();
    await controller.stop();
    expect(Date.now() - started).toBeLessThan(3000);
    await pending;
  });
});

describe("ProxyController status, log out and activity", () => {
  const chatBody = { model: "gpt-6-luna", messages: [{ role: "user", content: "SECRET-PROMPT" }] };
  const post = (baseUrl: string, body: unknown = chatBody) => fetch(`${baseUrl}/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const logged = (file: string): string[] => { try { return readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => (JSON.parse(line) as { method: string }).method); } catch { return []; } };

  it("shows needs_login for the own Codex home without a request, and stopped once auth.json exists", async () => {
    const logFile = path.join(root, "status-fake.log");
    rmSync(logFile, { force: true });
    process.env.FAKE_ACP_LOG = logFile;
    const controller = make();
    const status = await controller.start();
    expect(status.providers[0]).toMatchObject({ id: "codex", state: "needs_login", features: { imageGeneration: true, webSearch: true }, loginHome: { shared: false } });
    expect(status.providers[0]?.loginHome?.path).toMatch(/codex-home$/);
    expect(logged(logFile)).toEqual([]); // no agent process was started for this
    const dir = path.dirname(controller.settingsPath);
    mkdirSync(path.join(dir, "codex-home"), { recursive: true });
    writeFileSync(path.join(dir, "codex-home", "auth.json"), "{}");
    expect(controller.status().providers[0]?.state).toBe("stopped");
  });

  it("logs out through the provider: ACP logout, state needs_login, the call reaches the agent", async () => {
    const logFile = path.join(root, "logout-fake.log");
    rmSync(logFile, { force: true });
    Object.assign(process.env, { FAKE_ACP_LOG: logFile, FAKE_ACP_LOGOUT: "1", FAKE_ACP_AUTH_METHODS: JSON.stringify([{ id: "chat-gpt", name: "ChatGPT" }]) });
    const controller = make();
    const states: string[] = [];
    controller.on("status", (status) => states.push(status.providers[0]?.state ?? ""));
    const started = await controller.start();
    await controller.login("codex");
    expect(controller.status().providers[0]?.state).toBe("ready");
    expect((await post(started.server.baseUrl!)).status).toBe(200);
    const after = await controller.logout("codex");
    expect(after.providers[0]).toMatchObject({ state: "needs_login" });
    expect(logged(logFile)).toContain("logout");
    expect(states.at(-1)).toBe("needs_login");
    // A request now fails with the login error (and the activity log says so).
    const refused = await post(started.server.baseUrl!);
    expect(refused.status).toBe(503);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("provider_auth_required");
    await expect(controller.logout("nope")).rejects.toThrow(/not running/);
    await expect(controller.logout("antigravity")).rejects.toThrow(/not running/);
  });

  it("refuses a log out for a provider that has none", async () => {
    const bare: ProviderRegistration = { id: "codex", displayName: "Bare", create: () => ({
      id: "codex", displayName: "Bare", ownedBy: "x", exposeUnprefixed: true, staticModels: [{ id: "m" }], generate: async () => ({ text: "", stopReason: "end_turn", usage: null }),
      listModels: async () => [{ id: "m" }], status: () => ({ id: "codex", name: "Bare", state: "ready", authMethods: [], models: [] }), login: async () => undefined, onStatus: () => () => undefined, close: async () => undefined,
    }) };
    const controller = make({}, { registry: [bare] });
    await controller.start();
    await expect(controller.logout("codex")).rejects.toThrow(/cannot be logged out/);
  });

  it("keeps the activity of the requests, across a restart, with no text, and emits events", async () => {
    const controller = make();
    const events: string[] = [];
    controller.on("activity", () => events.push("activity"));
    const started = await controller.start();
    await get(`${started.server.baseUrl}/models`);
    expect((await post(started.server.baseUrl!)).status).toBe(200);
    for (let n = 0; n < 100 && controller.activity.list().length < 2; n++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(controller.activity.list().map((entry) => [entry.endpoint, entry.status])).toEqual([["POST /v1/chat/completions", 200], ["GET /v1/models", 200]]);
    expect(controller.activity.list()[0]).toMatchObject({ model: "gpt-6-luna", provider: "codex", stream: false, outputTokens: expect.any(Number) });
    expect(JSON.stringify(controller.activity.list())).not.toContain("SECRET-PROMPT");
    expect(events.length).toBeGreaterThanOrEqual(2);
    await controller.applySettings({ server: { timeoutMs: 4321 } });
    expect(controller.activity.list()).toHaveLength(2);
    controller.activity.clear();
    expect(controller.activity.list()).toEqual([]);
  });

  it("announces a provider that needs login when a request hits it", async () => {
    process.env.FAKE_ACP_AUTH_METHODS = JSON.stringify([{ id: "chat-gpt", name: "ChatGPT" }, { id: "api-key", name: "API key" }]);
    const controller = make();
    const needed: Array<[string, string]> = [];
    controller.on("loginNeeded", (id: string, name: string) => needed.push([id, name]));
    const started = await controller.start();
    expect((await post(started.server.baseUrl!)).status).toBe(503);
    for (let n = 0; n < 100 && !needed.length; n++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(needed).toEqual([["codex", "Codex"]]);
    expect(controller.activity.list()[0]).toMatchObject({ status: 503, error: "provider_auth_required", provider: "codex" });
  });
});
