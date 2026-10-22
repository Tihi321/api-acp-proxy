import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AcpProvider, type AcpProviderOptions } from "../src/acp-provider.js";
import { AcpUnavailableError, ProviderAuthRequiredError, defaultRuntimeContext, type ProviderDescriptor } from "../src/provider.js";

const fixture = fileURLToPath(new URL("./fixtures/fake-acp.mjs", import.meta.url));
const workRoot = path.resolve(".claude/temp/acp-provider-tests");
const user = [{ role: "user" as const, content: "hello" }];
const providers: AcpProvider[] = [];

function descriptor(overrides: Partial<ProviderDescriptor> = {}): ProviderDescriptor {
  return { id: "fake", displayName: "Fake", ownedBy: "fake-co", exposeUnprefixed: false, authMode: "on-demand", readOnlyMode: "optional", launch: () => ({ command: process.execPath, args: [fixture], env: { ...process.env } }), chooseAuth: () => undefined, ...overrides };
}
function make(overrides: Partial<ProviderDescriptor> = {}, options: Partial<AcpProviderOptions> = {}): AcpProvider {
  const provider = new AcpProvider(descriptor(overrides), defaultRuntimeContext(), { workRoot, ...options });
  providers.push(provider);
  return provider;
}
const fakeKeys = () => Object.keys(process.env).filter((key) => key.startsWith("FAKE_ACP_"));
beforeEach(() => { mkdirSync(workRoot, { recursive: true }); });
afterEach(async () => {
  await Promise.all(providers.splice(0).map((provider) => provider.close()));
  for (const key of fakeKeys()) delete process.env[key];
});

describe("AcpProvider", () => {
  it("discovers grouped models and reuses the listing session for the next request", async () => {
    process.env.FAKE_ACP_ECHO = "1";
    process.env.FAKE_ACP_MODELS = JSON.stringify([{ group: "g1", name: "One", options: [{ value: "a", name: "A" }, { value: "b" }] }, { group: "g2", name: "Two", options: [{ value: "c" }] }]);
    const provider = make({ warmSessions: 1 });
    expect((await provider.listModels()).map((model) => model.id)).toEqual(["a", "b", "c"]);
    expect(provider.status().models).toHaveLength(3);
    const result = await provider.generate("b", user);
    expect(result.text).toBe("echo:b:fake-session:-");
  });

  it("lists static models without starting a process", async () => {
    const provider = make({ staticModels: ["x", "y"] });
    expect((await provider.listModels()).map((model) => model.id)).toEqual(["x", "y"]);
    expect(provider.status().state).toBe("stopped");
  });

  it("tolerates a missing read-only mode only when it is not required", async () => {
    process.env.FAKE_ACP_NO_READONLY = "1";
    await expect(make({ readOnlyMode: "optional" }).generate("gpt-5.6-sol", user)).resolves.toMatchObject({ text: "fake response" });
    await expect(make({ readOnlyMode: "required" }).generate("gpt-5.6-sol", user)).rejects.toBeInstanceOf(AcpUnavailableError);
  });

  it("maps auth_required to needs_login and recovers after an explicit login", async () => {
    process.env.FAKE_ACP_REQUIRE_AUTH = "1";
    process.env.FAKE_ACP_ECHO = "1";
    process.env.FAKE_ACP_AUTH_METHODS = JSON.stringify([{ id: "oauth", name: "Google login" }]);
    const provider = make();
    await expect(provider.generate("m", user)).rejects.toBeInstanceOf(ProviderAuthRequiredError);
    expect(provider.status().state).toBe("needs_login");
    expect(provider.status().authMethods).toEqual([{ id: "oauth", name: "Google login" }]);
    await provider.login("oauth");
    expect(provider.status().state).toBe("ready");
    expect((await provider.generate("m", user)).text).toBe("echo:m:fake-session:oauth");
  });

  it("chooses the API-key method and retries session creation", async () => {
    process.env.FAKE_ACP_REQUIRE_AUTH = "1";
    process.env.FAKE_ACP_ECHO = "1";
    process.env.FAKE_ACP_AUTH_METHODS = JSON.stringify([{ id: "oauth", name: "Login" }, { id: "api-key", name: "API key" }]);
    const provider = make({ chooseAuth: (methods) => methods.find((method) => method.id === "api-key")?.id });
    expect((await provider.generate("m", user)).text).toMatch(/:api-key$/);
    expect(provider.status().state).toBe("ready");
  });

  it("applies descriptor error mapping", async () => {
    process.env.FAKE_ACP_ENTITY_NOT_FOUND = "1";
    const provider = make({ mapError: (error) => /not found/.test(String((error as Error).message)) ? new Error("mapped") : undefined });
    await expect(provider.generate("m", user)).rejects.toThrow("mapped");
  });

  it("kills grandchild processes when closed", async () => {
    const pidFile = path.join(workRoot, `grandchild-${process.pid}.pid`);
    process.env.FAKE_ACP_GRANDCHILD = pidFile;
    const provider = make();
    await provider.generate("gpt-5.6-sol", user);
    let pid = 0;
    for (let i = 0; i < 50 && !pid; i++) { try { pid = Number(readFileSync(pidFile, "utf8")); } catch { await new Promise((resolve) => setTimeout(resolve, 20)); } }
    expect(pid).toBeGreaterThan(0);
    const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
    expect(alive()).toBe(true);
    await provider.close();
    for (let i = 0; i < 50 && alive(); i++) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(alive()).toBe(false);
  });
});

describe("AcpProvider session reuse", () => {
  const model = "gpt-5.6-sol";
  const logFile = () => { const file = path.join(workRoot, `reuse-${process.pid}-${Math.random().toString(36).slice(2)}.log`); rmSync(file, { force: true }); process.env.FAKE_ACP_LOG = file; return file; };
  const readLog = (file: string) => readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { method: string; params: Record<string, any> });
  const methodCount = (file: string, method: string) => readLog(file).filter((entry) => entry.method === method).length;
  const promptTexts = (file: string) => readLog(file).filter((entry) => entry.method === "session/prompt").map((entry) => entry.params.prompt[0].text as string);
  const keptCount = (provider: AcpProvider) => (provider as unknown as { kept: unknown[] }).kept.length;
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const turn = (answer: string, next: string) => [...user, { role: "assistant" as const, content: answer }, { role: "user" as const, content: next }];

  it("creates a session per request when reuse is off", async () => {
    process.env.FAKE_ACP_ECHO = "1";
    const log = logFile();
    const provider = make();
    const first = await provider.generate(model, user);
    const second = await provider.generate(model, turn(first.text, "next"));
    expect(first.text).not.toBe(second.text);
    expect(methodCount(log, "session/new")).toBe(2);
    expect(methodCount(log, "session/delete")).toBe(2);
  });

  it("continues the kept session with only the new messages", async () => {
    process.env.FAKE_ACP_ECHO = "1";
    const log = logFile();
    const provider = make({}, { reuseSessions: true });
    const first = await provider.generate(model, user);
    expect(keptCount(provider)).toBe(1);
    expect(methodCount(log, "session/delete")).toBe(0);
    const second = await provider.generate(model, turn(first.text, "next question"), {}, undefined, { instructions: "be brief" });
    expect(second.text).toBe(first.text);
    expect(methodCount(log, "session/new")).toBe(1);
    expect(methodCount(log, "session/set_config_option")).toBe(1);
    const prompts = promptTexts(log);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("[user]\nnext question");
    expect(prompts[1]).toContain("[output format]\nbe brief");
    expect(prompts[1]).not.toContain("hello");
    expect(readLog(log).filter((entry) => entry.method === "session/prompt").map((entry) => entry.params.sessionId)).toEqual(["fake-session", "fake-session"]);
  });

  it("starts a new session for a changed history, another model, or no new message", async () => {
    process.env.FAKE_ACP_ECHO = "1";
    const log = logFile();
    const provider = make({}, { reuseSessions: true });
    const first = await provider.generate(model, user);
    const edited = await provider.generate(model, [{ role: "user", content: "edited" }, { role: "assistant", content: first.text }, { role: "user", content: "next" }]);
    expect(edited.text).not.toBe(first.text);
    const other = await provider.generate("gpt-5.6-luna", turn(first.text, "next"));
    expect(other.text).not.toBe(first.text);
    const unchanged = await provider.generate(model, [...user, { role: "assistant", content: first.text }]);
    expect(unchanged.text).not.toBe(first.text);
    expect(methodCount(log, "session/new")).toBe(4);
  });

  it("matches an assistant message that is a substring of the raw answer", async () => {
    process.env.FAKE_ACP_ECHO = "1";
    const log = logFile();
    const provider = make({}, { reuseSessions: true });
    const first = await provider.generate(model, user);
    await provider.generate(model, turn(first.text.slice(5, 25), "next"));
    expect(methodCount(log, "session/new")).toBe(1);
    expect(methodCount(log, "session/prompt")).toBe(2);
    await provider.generate(model, turn("not in the answer", "next"));
    expect(methodCount(log, "session/new")).toBe(2);
  });

  it("does not hand a kept session to two concurrent requests", async () => {
    process.env.FAKE_ACP_ECHO = "1";
    process.env.FAKE_ACP_DELAY = "1";
    const log = logFile();
    const provider = make({}, { reuseSessions: true });
    const first = await provider.generate(model, user);
    const [a, b] = await Promise.all([provider.generate(model, turn(first.text, "next")), provider.generate(model, turn(first.text, "next"))]);
    expect(a.text).not.toBe(b.text);
    expect(methodCount(log, "session/new")).toBe(2);
  });

  it("does not keep a cancelled turn", async () => {
    process.env.FAKE_ACP_DELAY = "1";
    const log = logFile();
    const provider = make({}, { reuseSessions: true });
    const controller = new AbortController();
    const pending = provider.generate(model, user, {}, controller.signal);
    await sleep(250);
    controller.abort();
    expect((await pending).stopReason).toBe("cancelled");
    expect(keptCount(provider)).toBe(0);
    expect(methodCount(log, "session/delete")).toBe(1);
  });

  it("disposes an idle kept session after retainedIdleMs", async () => {
    const log = logFile();
    const provider = make({}, { reuseSessions: true, retainedIdleMs: 100 });
    await provider.generate(model, user);
    expect(keptCount(provider)).toBe(1);
    await sleep(400);
    expect(keptCount(provider)).toBe(0);
    expect(methodCount(log, "session/delete")).toBe(1);
  });

  it("evicts the oldest kept session over the cap", async () => {
    process.env.FAKE_ACP_ECHO = "1";
    const log = logFile();
    const provider = make({}, { reuseSessions: true, retainedSessions: 1 });
    const first = await provider.generate(model, user);
    await provider.generate(model, [{ role: "user", content: "other" }]);
    expect(keptCount(provider)).toBe(1);
    await sleep(100);
    expect(methodCount(log, "session/delete")).toBe(1);
    await provider.generate(model, turn(first.text, "next"));
    expect(methodCount(log, "session/new")).toBe(3);
  });

  it("disposes the kept sessions on close", async () => {
    const log = logFile();
    const provider = make({}, { reuseSessions: true });
    await provider.generate(model, user);
    await provider.generate(model, [{ role: "user", content: "other" }]);
    expect(keptCount(provider)).toBe(2);
    await provider.close();
    expect(keptCount(provider)).toBe(0);
    expect(methodCount(log, "session/delete")).toBe(2);
  });

  it("reports the per-turn usage delta for a session-scoped agent", async () => {
    process.env.FAKE_ACP_ECHO = "1";
    process.env.FAKE_ACP_CUMULATIVE = "1";
    const provider = make({ usageScope: "session" }, { reuseSessions: true });
    const first = await provider.generate(model, user);
    const second = await provider.generate(model, turn(first.text, "next"));
    const third = await provider.generate(model, [...turn(first.text, "next"), { role: "assistant", content: second.text }, { role: "user", content: "again" }]);
    for (const result of [first, second, third]) expect(result.usage).toMatchObject({ inputTokens: 2, outputTokens: 1, totalTokens: 3 });
    const plain = make({}, { reuseSessions: true });
    const one = await plain.generate(model, user);
    expect((await plain.generate(model, turn(one.text, "next"))).usage).toMatchObject({ inputTokens: 4, outputTokens: 2 });
  });
});
