import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AcpProvider } from "../src/acp-provider.js";
import { textMessage } from "../src/api.js";
import { codexDescriptor } from "../src/providers/codex.js";
import { claudeDescriptor } from "../src/providers/claude.js";
import { ProviderAuthRequiredError, defaultRuntimeContext, type ProviderDescriptor, type ProviderStatus } from "../src/provider.js";

// Log out and sign-in status with the fake agent. The real agents are never logged out here: nothing in these tests reads or touches ~/.codex, ~/.claude, ~/.gemini or ~/.agents.
const fixture = fileURLToPath(new URL("./fixtures/fake-acp.mjs", import.meta.url));
const root = path.resolve(".claude/temp/logout-tests", String(process.pid));
const user = [textMessage("user", "hello")];
const providers: AcpProvider[] = [];
let counter = 0;
let saved: Record<string, string | undefined> = {};
let dir = "";
let logFile = "";

const requests = (): string[] => existsSync(logFile) ? readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((line) => (JSON.parse(line) as { method: string }).method) : [];
const authMethods = (...ids: string[]) => JSON.stringify(ids.map((id) => ({ id, name: id })));

beforeEach(() => {
  dir = path.join(root, `t${++counter}`);
  logFile = path.join(dir, "fake.log");
  mkdirSync(dir, { recursive: true });
  saved = { CODEX_HOME: process.env.CODEX_HOME, CODEX_CONFIG: process.env.CODEX_CONFIG, CODEX_API_KEY: process.env.CODEX_API_KEY, OPENAI_API_KEY: process.env.OPENAI_API_KEY };
  for (const key of Object.keys(saved)) delete process.env[key];
  process.env.FAKE_ACP_LOG = logFile;
});
afterEach(async () => {
  await Promise.all(providers.splice(0).map((provider) => provider.close()));
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  for (const key of Object.keys(process.env)) if (key.startsWith("FAKE_ACP_")) delete process.env[key];
});

function make(overrides: Partial<ProviderDescriptor> = {}): AcpProvider {
  const descriptor: ProviderDescriptor = { id: "fake", displayName: "Fake", ownedBy: "fake-co", exposeUnprefixed: false, authMode: "eager", readOnlyMode: "optional", warmSessions: 1, launch: () => ({ command: process.execPath, args: [fixture], env: { ...process.env } }), chooseAuth: () => "oauth", ...overrides };
  const provider = new AcpProvider(descriptor, defaultRuntimeContext({ dataDir: dir }), { workRoot: path.join(dir, "work"), reuseSessions: true });
  providers.push(provider);
  return provider;
}
const codexAgent = (options: Parameters<typeof codexDescriptor>[1] = {}, acpArgs: string[] = [fixture]) => {
  const provider = new AcpProvider(codexDescriptor({ acpCommand: process.execPath, acpArgs }, options), defaultRuntimeContext({ dataDir: dir }), { workRoot: path.join(dir, "work") });
  providers.push(provider);
  return provider;
};
const ownHome = () => path.join(dir, "codex-home");
const writeLogin = (home: string) => { mkdirSync(home, { recursive: true }); writeFileSync(path.join(home, "auth.json"), "{\"tokens\":\"fake\"}"); writeFileSync(path.join(home, "config.toml"), "model = \"x\"\n"); };

describe("logout through the agent's ACP logout", () => {
  it("calls logout, ends in needs_login, drops the sessions and refuses requests until a login", async () => {
    Object.assign(process.env, { FAKE_ACP_LOGOUT: "1", FAKE_ACP_AUTH_METHODS: authMethods("oauth") });
    const provider = make();
    const states: string[] = [];
    provider.onStatus((status: ProviderStatus) => states.push(status.state));
    await expect(provider.generate("m", user)).resolves.toMatchObject({ text: "fake response" });
    expect(provider.status().state).toBe("ready");
    // The finished turn left a kept session (deleted by the logout) and a warm one (its folder is removed): nothing is left in the work folder.
    const work = path.join(dir, "work");
    expect(readdirSync(work).length).toBeGreaterThanOrEqual(1);
    await provider.logout();
    const sent = requests();
    expect(sent).toContain("logout");
    expect(sent.filter((method) => method === "session/delete")).toHaveLength(1);
    await vi.waitFor(() => expect(readdirSync(work)).toEqual([]));
    expect(sent.indexOf("session/delete")).toBeLessThan(sent.indexOf("logout"));
    expect(provider.status()).toMatchObject({ state: "needs_login", error: "Logged out." });
    expect(states.at(-1)).toBe("needs_login");
    // No second agent process: the agent is left running and logged out.
    expect(sent.filter((method) => method === "initialize")).toHaveLength(1);
    await expect(provider.generate("m", user)).rejects.toBeInstanceOf(ProviderAuthRequiredError);
    // A login brings it back.
    await provider.login("oauth");
    expect(provider.status().state).toBe("ready");
    await expect(provider.generate("m", user)).resolves.toMatchObject({ text: "fake response" });
  });

  it("lets an agent that pushes its auth status decide (Claude): the account goes, the state follows the push", async () => {
    Object.assign(process.env, { FAKE_ACP_LOGOUT: "1", FAKE_ACP_CLAUDE: "1", FAKE_ACP_AUTH_STATUS: "claudeai" });
    const provider = make({ authMode: "on-demand", chooseAuth: () => undefined, modeCandidates: ["default"], readOnlyMode: "required" });
    await provider.listModels({ force: true });
    expect(provider.status()).toMatchObject({ state: "ready", account: "Fake account" });
    await provider.logout();
    expect(requests()).toContain("logout");
    expect(provider.status().state).toBe("needs_login");
    expect(provider.status().account).toBeUndefined();
  });

  it("blocks an eager provider whose agent reported the logout, so a request cannot start a login by itself", async () => {
    Object.assign(process.env, { FAKE_ACP_LOGOUT: "1", FAKE_ACP_AUTH_STATUS: "chatgpt", FAKE_ACP_AUTH_METHODS: authMethods("oauth") });
    const provider = make();
    await provider.generate("m", user);
    await provider.logout();
    expect(provider.status().state).toBe("needs_login");
    await expect(provider.generate("m", user)).rejects.toBeInstanceOf(ProviderAuthRequiredError);
    expect(requests().filter((method) => method === "authenticate")).toHaveLength(1); // only the one before the logout
  });

  it("runs from a stopped provider too (it starts the agent just to log out)", async () => {
    Object.assign(process.env, { FAKE_ACP_LOGOUT: "1", FAKE_ACP_AUTH_METHODS: authMethods("oauth") });
    const provider = make();
    expect(provider.status().state).toBe("stopped");
    await provider.logout();
    expect(requests()).toContain("logout");
    expect(provider.status().state).toBe("needs_login");
  });

  it("runs afterLogout and never the fallback when the agent advertises logout", async () => {
    Object.assign(process.env, { FAKE_ACP_LOGOUT: "1", FAKE_ACP_AUTH_METHODS: authMethods("oauth") });
    const calls: string[] = [];
    const provider = make({ logoutFallback: async () => { calls.push("fallback"); }, afterLogout: async () => { calls.push("after"); } });
    await provider.logout();
    expect(calls).toEqual(["after"]);
  });
});

describe("logout without ACP logout", () => {
  it("refuses an agent that has neither logout nor a fallback, and sends nothing", async () => {
    Object.assign(process.env, { FAKE_ACP_AUTH_METHODS: authMethods("oauth") });
    const provider = make();
    await expect(provider.logout()).rejects.toThrow(/cannot be logged out/);
    expect(requests()).not.toContain("logout");
    expect(provider.status().state).not.toBe("needs_login");
  });

  it("runs the fallback between a stop and a restart, then afterLogout", async () => {
    Object.assign(process.env, { FAKE_ACP_AUTH_METHODS: authMethods("oauth") });
    const calls: string[] = [];
    const provider = make({
      logoutFallback: async () => { calls.push(`fallback after ${requests().filter((method) => method === "initialize").length} initialize`); },
      afterLogout: async () => { calls.push("after"); },
      // After the fallback the restarted agent finds no login.
      loginRequired: () => calls.length ? "Not logged in." : undefined,
      chooseAuth: () => calls.length ? undefined : "oauth",
    });
    await provider.generate("m", user);
    await provider.logout();
    expect(calls).toEqual(["fallback after 1 initialize", "after"]);
    expect(requests().filter((method) => method === "initialize")).toHaveLength(2);
    expect(requests()).not.toContain("logout");
    expect(provider.status()).toMatchObject({ state: "needs_login" });
  });
});

describe("Codex logout", () => {
  beforeEach(() => { Object.assign(process.env, { FAKE_ACP_AUTH_METHODS: authMethods("chat-gpt", "api-key") }); });

  it("via ACP logout deletes only auth.json of its own home and ends in needs_login", async () => {
    process.env.FAKE_ACP_LOGOUT = "1";
    writeLogin(ownHome());
    const provider = codexAgent();
    await provider.listModels();
    await provider.generate("gpt-6-luna", user);
    expect(provider.status().state).toBe("ready");
    await provider.logout();
    expect(requests()).toContain("logout");
    expect(existsSync(path.join(ownHome(), "auth.json"))).toBe(false);
    expect(readFileSync(path.join(ownHome(), "config.toml"), "utf8")).toContain("model");
    expect(provider.status().state).toBe("needs_login");
  });

  it("without ACP logout stops the agent, deletes only auth.json and restarts into needs_login with no authenticate", async () => {
    writeLogin(ownHome());
    const provider = codexAgent();
    await provider.generate("gpt-6-luna", user);
    expect(requests()).toContain("authenticate");
    const before = requests().filter((method) => method === "authenticate").length;
    await provider.logout();
    expect(requests()).not.toContain("logout");
    expect(existsSync(path.join(ownHome(), "auth.json"))).toBe(false);
    expect(existsSync(path.join(ownHome(), "config.toml"))).toBe(true);
    expect(requests().filter((method) => method === "initialize")).toHaveLength(2);
    // The restarted agent did not authenticate (that would open a browser): it waits for the Log in button.
    expect(requests().filter((method) => method === "authenticate")).toHaveLength(before);
    expect(provider.status().state).toBe("needs_login");
  });

  it("with its own home off and no ACP logout does nothing (the user's CODEX_HOME is never touched)", async () => {
    const shared = path.join(dir, "users-own-codex");
    writeLogin(shared);
    process.env.CODEX_HOME = shared;
    const provider = codexAgent({ isolatedHome: false });
    await provider.generate("gpt-6-luna", user);
    await expect(provider.logout()).rejects.toThrow(/cannot be logged out/);
    expect(requests()).not.toContain("logout");
    expect(existsSync(path.join(shared, "auth.json"))).toBe(true);
    expect(provider.status().state).toBe("ready");
  });

  it("with its own home off and ACP logout leaves every file to the agent", async () => {
    process.env.FAKE_ACP_LOGOUT = "1";
    const shared = path.join(dir, "users-own-codex");
    writeLogin(shared);
    process.env.CODEX_HOME = shared;
    const provider = codexAgent({ isolatedHome: false });
    await provider.generate("gpt-6-luna", user);
    await provider.logout();
    expect(requests()).toContain("logout");
    // The fake agent deletes nothing, and the proxy itself never touches a shared home.
    expect(existsSync(path.join(shared, "auth.json"))).toBe(true);
    expect(existsSync(path.join(dir, "codex-home", "auth.json"))).toBe(false);
    expect(provider.status().state).toBe("needs_login");
  });
});

describe("status without a request", () => {
  it("shows needs_login for an own Codex home without auth.json, without starting the agent", () => {
    const provider = codexAgent();
    expect(provider.status()).toMatchObject({ state: "needs_login", error: expect.stringContaining("no login") });
    expect(existsSync(logFile)).toBe(false);
    // Nothing was created either: the home is only checked for existence.
    expect(existsSync(ownHome())).toBe(false);
  });

  it("is stopped once auth.json exists, or with an API key, or for another method or an own home that is off", () => {
    writeLogin(ownHome());
    expect(codexAgent().status().state).toBe("stopped");
    rmSync(path.join(ownHome(), "auth.json"));
    expect(codexAgent().status().state).toBe("needs_login");
    process.env.CODEX_API_KEY = "sk-fake";
    expect(codexAgent().status().state).toBe("stopped");
    delete process.env.CODEX_API_KEY;
    expect(codexAgent({ authMethodId: "api-key" }).status().state).toBe("stopped");
    expect(codexAgent({ isolatedHome: false }).status().state).toBe("stopped");
  });

  it("stays needs_login when a request finds no login, and the agent is not asked to authenticate", async () => {
    process.env.FAKE_ACP_AUTH_METHODS = authMethods("chat-gpt", "api-key");
    const provider = codexAgent();
    await expect(provider.generate("gpt-6-luna", user)).rejects.toBeInstanceOf(ProviderAuthRequiredError);
    expect(provider.status().state).toBe("needs_login");
    expect(requests()).not.toContain("authenticate");
  });

  it("says where the login lives and what the provider can do", () => {
    expect(codexAgent().status()).toMatchObject({ loginHome: { path: ownHome(), shared: false }, features: { imageGeneration: true, tools: false, mcp: true, webSearch: true } });
    process.env.CODEX_HOME = path.join(dir, "elsewhere");
    expect(codexAgent({ isolatedHome: false }).status().loginHome).toEqual({ path: path.join(dir, "elsewhere"), shared: true });
    const claude = (settings: Parameters<typeof claudeDescriptor>[0]) => new AcpProvider(claudeDescriptor(settings, { CLAUDE_CONFIG_DIR: undefined }), defaultRuntimeContext({ dataDir: dir }), { workRoot: path.join(dir, "work") });
    expect(claude({}).status().loginHome?.shared).toBe(true);
    expect(claude({ configDir: path.join(dir, "own-claude") }).status().loginHome).toEqual({ path: path.join(dir, "own-claude"), shared: false });
  });
});
