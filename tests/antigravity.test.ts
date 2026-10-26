import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AcpProvider } from "../src/acp-provider.js";
import { ApiError, serializePrompt, textMessage } from "../src/api.js";
import { antigravityDescriptor, antigravityRegistration, purgeRecordedSessions, recordSession, resolveAntigravityExecutable, type AntigravityOptions } from "../src/providers/antigravity.js";
import { ProviderAuthRequiredError, ProviderNotInstalledError, ProviderTermsRequiredError, defaultRuntimeContext, type ProviderStatus, type RuntimeContext } from "../src/provider.js";

// Every provider start runs the Windows orphan sweep (a PowerShell Get-CimInstance call), which alone can take several seconds on a cold CI runner.
vi.setConfig({ testTimeout: 30_000 });

const fixture = fileURLToPath(new URL("./fixtures/fake-acp.mjs", import.meta.url));
const root = path.resolve(".claude/temp/antigravity-tests", String(process.pid));
const user = [textMessage("user", "hello")];
const providers: AcpProvider[] = [];
let counter = 0;

interface Setup { dataDir: string; geminiHome: string; workRoot: string; }
function setup(install = true): Setup {
  const base = path.join(root, `t${++counter}`);
  const dataDir = path.join(base, "data");
  const agentDir = path.join(dataDir, "agents", "antigravity-acp");
  mkdirSync(agentDir, { recursive: true });
  if (install) writeFileSync(path.join(agentDir, "install.json"), JSON.stringify({ version: "1.0.0", url: "x", sha256: "x", command: process.execPath, args: [fixture], dir: agentDir, installedAt: new Date().toISOString() }));
  return { dataDir, geminiHome: path.join(base, "gemini"), workRoot: path.join(base, "work") };
}
type MakeOptions = Partial<AntigravityOptions> & { ctx?: Partial<RuntimeContext> };
function make(s: Setup, options: MakeOptions = {}): AcpProvider {
  const ctx = defaultRuntimeContext({ dataDir: s.dataDir, ...options.ctx });
  const provider = new AcpProvider(antigravityDescriptor(ctx, { env: {}, ...options, settings: { termsAcknowledgedAt: "2026-01-01T00:00:00Z", geminiHome: s.geminiHome, ...options.settings }, overrides: { warmSessions: 0, ...options.overrides } }), ctx, { workRoot: s.workRoot });
  providers.push(provider);
  return provider;
}
const methodsJson = JSON.stringify([{ id: "oauth-personal", name: "Log in with Google" }, { id: "gemini-api-key", name: "Gemini API key" }]);
const readLog = (file: string) => existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> }) : [];
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => { mkdirSync(root, { recursive: true }); });
afterEach(async () => {
  await Promise.all(providers.splice(0).map((provider) => provider.close()));
  for (const key of Object.keys(process.env)) if (key.startsWith("FAKE_ACP_")) delete process.env[key];
});

describe("Antigravity registration", () => {
  it("exposes the contract identity", () => {
    expect(antigravityRegistration.id).toBe("antigravity");
    expect(antigravityRegistration.displayName).toBe("Google Antigravity");
    const descriptor = antigravityDescriptor(defaultRuntimeContext(), { settings: {}, env: {} });
    expect(descriptor).toMatchObject({ id: "antigravity", ownedBy: "google", exposeUnprefixed: false, authMode: "eager", readOnlyMode: "required", sessionTimeoutMs: 180000, warmSessions: 1 });
    expect(descriptor.modeCandidates).toEqual(["read-only", "readonly", "default"]);
  });
});

describe("Antigravity prompt", () => {
  it("adds the no-tools line after the generic preamble, and only for Antigravity", async () => {
    const s = setup();
    const log = path.join(s.dataDir, "requests.log");
    Object.assign(process.env, { FAKE_ACP_AGY: "1", FAKE_ACP_LOG: log });
    const provider = make(s);
    await provider.generate("fake-model", user);
    const text = (readLog(log).find((entry) => entry.method === "session/prompt")?.params.prompt as Array<{ text: string }>)[0]!.text;
    const line = antigravityDescriptor(defaultRuntimeContext(), { settings: {}, env: {} }).promptPreamble!;
    expect(line).toMatch(/do not call any tool/i);
    expect(text).toBe(serializePrompt(user, undefined, line));
    expect(text.startsWith("This is a text-only API request.")).toBe(true);
    expect(text.split("\n")[1]).toBe(line);
    expect(serializePrompt(user)).not.toContain(line);
  });
});

describe("Antigravity preflight", () => {
  it("requires the terms to be acknowledged", async () => {
    const s = setup();
    const provider = make(s, { settings: { termsAcknowledgedAt: undefined } });
    await expect(provider.generate("m", user)).rejects.toBeInstanceOf(ProviderTermsRequiredError);
    expect(provider.status().state).toBe("terms_required");
  });

  it("accepts PROXY_ANTIGRAVITY_ACCEPT_TERMS instead of the setting", async () => {
    process.env.FAKE_ACP_AGY = "1";
    const s = setup();
    const provider = make(s, { settings: { termsAcknowledgedAt: undefined }, env: { PROXY_ANTIGRAVITY_ACCEPT_TERMS: "true" } });
    await expect(provider.generate("fake-model", user)).resolves.toMatchObject({ text: "fake response" });
  });

  it("reports not_installed when no executable can be found", async () => {
    const s = setup(false);
    const provider = make(s);
    await expect(provider.generate("m", user)).rejects.toBeInstanceOf(ProviderNotInstalledError);
    expect(provider.status().state).toBe("not_installed");
  });

  it("resolves executablePath, then install.json, then PROXY_ANTIGRAVITY_COMMAND", async () => {
    const s = setup();
    const ctx = { dataDir: s.dataDir };
    expect(await resolveAntigravityExecutable(ctx, { executablePath: process.execPath }, {})).toEqual({ command: process.execPath, args: [] });
    expect(await resolveAntigravityExecutable(ctx, { executablePath: path.join(root, "missing.exe") }, {})).toEqual({ command: process.execPath, args: [fixture] });
    const none = setup(false);
    expect(await resolveAntigravityExecutable({ dataDir: none.dataDir }, {}, { PROXY_ANTIGRAVITY_COMMAND: process.execPath })).toEqual({ command: process.execPath, args: [] });
    expect(await resolveAntigravityExecutable({ dataDir: none.dataDir }, {}, {})).toBeUndefined();
  });
});

describe("Antigravity auth selection", () => {
  const advertised = [{ id: "oauth-personal", name: "Google" }, { id: "oauth-business", name: "Enterprise" }, { id: "gemini-api-key", name: "Key" }];
  const choose = (settings: AntigravityOptions["settings"], env: NodeJS.ProcessEnv = {}, processEnv: NodeJS.ProcessEnv = {}, methods = advertised) => antigravityDescriptor(defaultRuntimeContext(), { settings, env }).chooseAuth(methods, processEnv);

  it("prefers the explicit method, then the API key, then the last used method, then the server's auth.type", () => {
    const s = setup();
    expect(choose({ authMethodId: "oauth-business", apiKey: "k", lastAuthMethodId: "oauth-personal" })).toBe("oauth-business");
    expect(choose({ apiKey: "k", lastAuthMethodId: "oauth-personal" })).toBe("gemini-api-key");
    expect(choose({}, {}, { GEMINI_API_KEY: "from-env" })).toBe("gemini-api-key");
    expect(choose({ lastAuthMethodId: "oauth-personal" })).toBe("oauth-personal");
    mkdirSync(path.join(s.geminiHome, "antigravity-acp"), { recursive: true });
    writeFileSync(path.join(s.geminiHome, "antigravity-acp", "settings.json"), JSON.stringify({ auth: { type: "oauth-business" } }));
    expect(choose({ geminiHome: s.geminiHome })).toBe("oauth-business");
    expect(choose({ geminiHome: s.geminiHome, lastAuthMethodId: "oauth-personal" })).toBe("oauth-personal");
  });

  it("returns undefined (login needed) when nothing usable is known", () => {
    const s = setup();
    expect(choose({ geminiHome: s.geminiHome })).toBeUndefined();
    expect(choose({ geminiHome: s.geminiHome, lastAuthMethodId: "unknown-method" })).toBeUndefined();
    expect(choose({ apiKey: "k", geminiHome: s.geminiHome }, {}, {}, [{ id: "oauth-personal", name: "Google" }])).toBeUndefined();
  });

  it("authenticates eagerly with the chosen method at start", async () => {
    const s = setup();
    const log = path.join(s.dataDir, "requests.log");
    Object.assign(process.env, { FAKE_ACP_AGY: "1", FAKE_ACP_AUTH_METHODS: methodsJson, FAKE_ACP_REQUIRE_AUTH: "1", FAKE_ACP_LOG: log });
    const provider = make(s, { settings: { lastAuthMethodId: "oauth-personal" } });
    await provider.generate("fake-model", user);
    expect(readLog(log).filter((entry) => entry.method === "authenticate").map((entry) => entry.params.methodId)).toEqual(["oauth-personal"]);
  });

  it("passes the API key and Gemini home to the agent and strips Electron/Node variables", async () => {
    const s = setup();
    const descriptor = antigravityDescriptor(defaultRuntimeContext({ dataDir: s.dataDir }), { settings: { apiKey: "secret-key", geminiHome: s.geminiHome }, env: {} });
    process.env.ELECTRON_RUN_AS_NODE = "1"; process.env.NODE_OPTIONS = "--no-warnings";
    try {
      const spec = await descriptor.launch(defaultRuntimeContext({ dataDir: s.dataDir }));
      expect(spec.args).toEqual([fixture]);
      expect(spec.env?.GEMINI_API_KEY).toBe("secret-key");
      expect(spec.env?.GEMINI_HOME).toBe(s.geminiHome);
      expect(spec.env).not.toHaveProperty("ELECTRON_RUN_AS_NODE");
      expect(spec.env).not.toHaveProperty("NODE_OPTIONS");
    } finally { delete process.env.ELECTRON_RUN_AS_NODE; delete process.env.NODE_OPTIONS; }
  });
});

describe("Antigravity sessions", () => {
  it("selects the default mode and never auto_edit or yolo", async () => {
    const s = setup();
    const log = path.join(s.dataDir, "requests.log");
    Object.assign(process.env, { FAKE_ACP_AGY: "1", FAKE_ACP_LOG: log });
    const provider = make(s);
    await provider.generate("fake-model", user);
    const modes = readLog(log).filter((entry) => entry.method === "session/set_mode").map((entry) => entry.params.modeId);
    expect(modes).toEqual(["default"]);
  });

  it("reports the agent version", async () => {
    const s = setup();
    process.env.FAKE_ACP_AGY = "1";
    const provider = make(s);
    await provider.listModels();
    expect(provider.status().agentVersion).toBe("1.3.0");
  });

  it("maps 'Requested entity was not found' to a 403 model_not_available", async () => {
    const s = setup();
    Object.assign(process.env, { FAKE_ACP_AGY: "1", FAKE_ACP_ENTITY_NOT_FOUND: "1" });
    const provider = make(s);
    const error = await provider.generate("fake-model", user).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 403, code: "model_not_available" });
  });

  it("turns -32000 (with a data object) into needs_login when no method is known, and login recovers", async () => {
    const s = setup();
    Object.assign(process.env, { FAKE_ACP_AGY: "1", FAKE_ACP_REQUIRE_AUTH: "1", FAKE_ACP_AUTH_METHODS: methodsJson, FAKE_ACP_ECHO: "1" });
    const saved: unknown[] = [];
    const provider = make(s, { saveSettings: (patch) => { saved.push(patch); } });
    await expect(provider.generate("fake-model", user)).rejects.toBeInstanceOf(ProviderAuthRequiredError);
    expect(provider.status().state).toBe("needs_login");
    await provider.login("oauth-personal");
    expect(provider.status().state).toBe("ready");
    expect(saved).toEqual([{ providers: { antigravity: { lastAuthMethodId: "oauth-personal" } } }]);
    expect((await provider.generate("fake-model", user)).text).toMatch(/:oauth-personal$/);
  });
});

describe("Antigravity login URL", () => {
  it("captures the URL but never opens it during a quick eager authentication", async () => {
    const s = setup();
    Object.assign(process.env, { FAKE_ACP_AGY: "1", FAKE_ACP_AUTH_METHODS: methodsJson, FAKE_ACP_REQUIRE_AUTH: "1" });
    const openUrl = vi.fn();
    const seen: ProviderStatus[] = [];
    const provider = make(s, { settings: { lastAuthMethodId: "oauth-personal" }, ctx: { openUrl }, timeouts: { loginOpenDelayMs: 50 } });
    provider.onStatus((status) => seen.push(status));
    await provider.generate("fake-model", user);
    await wait(150);
    expect(seen.some((status) => status.loginUrl?.startsWith("https://accounts.google.com/"))).toBe(true);
    expect(provider.status().loginUrl).toBeUndefined();
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("goes needs_login when eager auth blocks, keeps the URL, and opens it only for a pending user login", async () => {
    const s = setup();
    Object.assign(process.env, { FAKE_ACP_AGY: "1", FAKE_ACP_AUTH_METHODS: methodsJson, FAKE_ACP_REQUIRE_AUTH: "1", FAKE_ACP_AUTH_DELAY_MS: "900", FAKE_ACP_ECHO: "1" });
    const openUrl = vi.fn();
    const saved: unknown[] = [];
    const ctx = defaultRuntimeContext({ dataDir: s.dataDir, openUrl });
    const provider = new AcpProvider(antigravityDescriptor(ctx, { env: {}, settings: { termsAcknowledgedAt: "x", geminiHome: s.geminiHome, lastAuthMethodId: "oauth-personal" }, saveSettings: (patch) => { saved.push(patch); }, timeouts: { authTimeoutMs: 150, loginOpenDelayMs: 100 }, overrides: { warmSessions: 0 } }), ctx, { workRoot: s.workRoot });
    providers.push(provider);

    await expect(provider.generate("fake-model", user)).rejects.toBeInstanceOf(ProviderAuthRequiredError);
    const blocked = provider.status();
    expect(blocked.state).toBe("needs_login");
    expect(blocked.loginUrl).toMatch(/^https:\/\/accounts\.google\.com\//);
    await wait(250);
    expect(openUrl).not.toHaveBeenCalled();

    const login = provider.login("oauth-personal");
    await wait(300);
    expect(openUrl).toHaveBeenCalledTimes(1);
    expect(openUrl.mock.calls[0]![0]).toBe(blocked.loginUrl);
    await login;
    expect(provider.status().state).toBe("ready");
    expect(provider.status().loginUrl).toBeUndefined();
    expect(saved).toHaveLength(0); // lastAuthMethodId was already oauth-personal
    expect((await provider.generate("fake-model", user)).text).toMatch(/:oauth-personal$/);
    expect(openUrl).toHaveBeenCalledTimes(1);
  });

  it("does not open the URL when a user login finishes before the delay", async () => {
    const s = setup();
    Object.assign(process.env, { FAKE_ACP_AGY: "1", FAKE_ACP_AUTH_METHODS: methodsJson });
    const openUrl = vi.fn();
    const ctx = defaultRuntimeContext({ dataDir: s.dataDir, openUrl });
    const provider = new AcpProvider(antigravityDescriptor(ctx, { env: {}, settings: { termsAcknowledgedAt: "x", geminiHome: s.geminiHome }, timeouts: { loginOpenDelayMs: 400 }, overrides: { warmSessions: 0 } }), ctx, { workRoot: s.workRoot });
    providers.push(provider);
    await provider.login("oauth-personal");
    await wait(600);
    expect(openUrl).not.toHaveBeenCalled();
  });
});

describe("Antigravity session purge", () => {
  const writeConversation = (home: string, id: string) => {
    mkdirSync(path.join(home, "antigravity-acp", "conversations"), { recursive: true });
    mkdirSync(path.join(home, "antigravity-acp", "brain", id), { recursive: true });
    for (const suffix of [".db", ".db-wal", ".db-shm", ".meta"]) writeFileSync(path.join(home, "antigravity-acp", "conversations", `${id}${suffix}`), "x");
    writeFileSync(path.join(home, "antigravity-acp", "brain", id, "notes.md"), "x");
  };
  const present = (home: string, id: string) => existsSync(path.join(home, "antigravity-acp", "conversations", `${id}.db`)) || existsSync(path.join(home, "antigravity-acp", "brain", id));

  it("deletes only recorded sessions after stop and prunes the record", async () => {
    const s = setup();
    process.env.FAKE_ACP_AGY = "1";
    writeConversation(s.geminiHome, "fake-session");
    writeConversation(s.geminiHome, "someone-elses");
    const provider = make(s);
    await provider.generate("fake-model", user);
    expect(present(s.geminiHome, "fake-session")).toBe(true);
    expect(JSON.parse(readFileSync(path.join(s.dataDir, "antigravity-sessions.json"), "utf8")).sessionIds).toEqual(["fake-session"]);
    await provider.close();
    expect(present(s.geminiHome, "fake-session")).toBe(false);
    expect(existsSync(path.join(s.geminiHome, "antigravity-acp", "conversations", "fake-session.db-wal"))).toBe(false);
    expect(existsSync(path.join(s.geminiHome, "antigravity-acp", "conversations", "fake-session.meta"))).toBe(false);
    expect(present(s.geminiHome, "someone-elses")).toBe(true);
    expect(JSON.parse(readFileSync(path.join(s.dataDir, "antigravity-sessions.json"), "utf8")).sessionIds).toEqual([]);
  });

  it("purges leftovers from a previous run before the next start", async () => {
    const s = setup();
    process.env.FAKE_ACP_AGY = "1";
    writeConversation(s.geminiHome, "old-session");
    await recordSession(s.dataDir, "old-session");
    const provider = make(s);
    await provider.listModels();
    expect(present(s.geminiHome, "old-session")).toBe(false);
  });

  it("keeps everything when purgeSessions is off", async () => {
    const s = setup();
    process.env.FAKE_ACP_AGY = "1";
    writeConversation(s.geminiHome, "fake-session");
    const provider = make(s, { settings: { purgeSessions: false } });
    await provider.generate("fake-model", user);
    await provider.close();
    expect(present(s.geminiHome, "fake-session")).toBe(true);
    expect(existsSync(path.join(s.dataDir, "antigravity-sessions.json"))).toBe(false);
  });

  it("ignores unsafe ids and keeps ids it could not delete", async () => {
    const s = setup();
    const file = path.join(s.dataDir, "antigravity-sessions.json");
    writeFileSync(file, JSON.stringify({ sessionIds: ["../../escape", "ok-id"] }));
    writeConversation(s.geminiHome, "ok-id");
    expect(await purgeRecordedSessions({ dataDir: s.dataDir, geminiHome: s.geminiHome })).toBe(1);
    expect(present(s.geminiHome, "ok-id")).toBe(false);
    expect(JSON.parse(readFileSync(file, "utf8")).sessionIds).toEqual([]);
  });
});

process.on("exit", () => { try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } });

describe("Antigravity login URL pattern", () => {
  const pattern = antigravityDescriptor(defaultRuntimeContext(), { settings: {}, env: {} }).loginUrlPattern!;
  it("matches the authenticate line only", () => {
    const line = "Open the following link to authenticate the ACP server: https://accounts.google.com/o/oauth2/v2/auth?client_id=1&redirect_uri=http%3A%2F%2F127.0.0.1%3A49240%2F";
    expect(pattern.exec(line)?.[1]).toBe("https://accounts.google.com/o/oauth2/v2/auth?client_id=1&redirect_uri=http%3A%2F%2F127.0.0.1%3A49240%2F");
    expect(pattern.exec("I1014 onboard.py:142] loadCodeAssist response: {'privacy': 'https://accounts.google.com/AccountChooser?Email=a%40b.c'}")).toBeNull();
  });
});
