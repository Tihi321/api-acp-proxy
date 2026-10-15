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

function make(patch: SettingsPatch = {}, extra: { registry?: ProviderRegistration[]; drainMs?: number } = {}): ProxyController {
  const dir = path.join(root, `case-${counter++}`);
  mkdirSync(dir, { recursive: true });
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
  it("starts, serves requests and stops", async () => {
    const controller = make();
    const events: string[] = [];
    controller.on("status", (status) => events.push(status.server.state));
    const status = await controller.start();
    expect(status.server.state).toBe("running");
    expect(status.server.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    expect(status.providers.map((provider) => [provider.id, provider.state])).toEqual([["codex", "stopped"], ["antigravity", "disabled"], ["claude", "disabled"]]);
    expect(((await get(`${status.server.baseUrl}/models`)).data ?? []).map((model) => model.id)).toContain("gpt-5.6-sol");
    const chat = await fetch(`${status.server.baseUrl}/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "gpt-5.6-sol", messages: [{ role: "user", content: "hi" }] }) });
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
    expect(status.providers.map((provider) => [provider.id, provider.state])).toEqual([["codex", "stopped"], ["antigravity", "disabled"]]);
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
