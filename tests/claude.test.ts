import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AcpProvider } from "../src/acp-provider.js";
import { claudeDescriptor, claudeRegistration, resolveClaudeBinary, type ClaudeSettings } from "../src/providers/claude.js";
import { AcpUnavailableError, ProviderAuthRequiredError, ProviderTermsRequiredError, defaultRuntimeContext, type ProviderDescriptor, type ProviderStatus } from "../src/provider.js";
import { serializePrompt } from "../src/api.js";
import { createProxyServer } from "../src/server.js";
import type { AddressInfo } from "node:net";

const fixture = fileURLToPath(new URL("./fixtures/fake-acp.mjs", import.meta.url));
const root = path.resolve(".claude/temp/claude-tests", String(process.pid));
const user = [{ role: "user" as const, content: "hello" }];
const providers: AcpProvider[] = [];
let counter = 0;

const readLog = (file: string) => existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> }) : [];
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const ctx = () => defaultRuntimeContext({ resolveUnpacked: (file) => file });

/** Runs the fake agent instead of the real adapter. */
function make(settings: ClaudeSettings = {}, env: NodeJS.ProcessEnv = {}, overrides: Partial<ProviderDescriptor> = {}): { provider: AcpProvider; log: string } {
  const base = path.join(root, `t${++counter}`);
  mkdirSync(base, { recursive: true });
  const descriptor = claudeDescriptor({ termsAcknowledgedAt: "2026-01-01T00:00:00Z", ...settings }, env, { warmSessions: 0, launch: () => ({ command: process.execPath, args: [fixture] }), ...overrides });
  const provider = new AcpProvider(descriptor, ctx(), { workRoot: path.join(base, "work") });
  providers.push(provider);
  return { provider, log: path.join(base, "requests.log") };
}

beforeEach(() => { mkdirSync(root, { recursive: true }); });
afterEach(async () => {
  await Promise.all(providers.splice(0).map((provider) => provider.close()));
  for (const key of Object.keys(process.env)) if (key.startsWith("FAKE_ACP_")) delete process.env[key];
});

describe("Claude registration", () => {
  it("exposes the contract identity", () => {
    expect(claudeRegistration).toMatchObject({ id: "claude", displayName: "Claude" });
    const descriptor = claudeDescriptor({}, {});
    expect(descriptor).toMatchObject({ id: "claude", ownedBy: "anthropic", exposeUnprefixed: false, authMode: "on-demand", readOnlyMode: "required", modeCandidates: ["default"], sessionTimeoutMs: 120000, warmSessions: 1 });
    expect(descriptor.loginMethods?.map((method) => method.id)).toEqual(["claude-ai-login", "console-login"]);
    expect(descriptor.chooseAuth([], {})).toBeUndefined();
  });
});

describe("Claude launch", () => {
  it("maps settings to credentials and strips nested-session variables", async () => {
    const env = { PATH: "p", CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", NODE_OPTIONS: "--x", ANTHROPIC_API_KEY: "from-env" };
    const runtime = defaultRuntimeContext({ nodeRuntime: { command: "node-bin", argsPrefix: ["--prefix"], env: { ELECTRON_RUN_AS_NODE: "1" } }, resolveUnpacked: (file) => file });
    const spec = await claudeDescriptor({ apiKey: "sk-1", oauthToken: "tok", configDir: "C:\\cfg", executablePath: "C:\\claude.exe" }, env).launch(runtime);
    expect(spec.command).toBe("node-bin");
    expect(spec.args[0]).toBe("--prefix");
    expect(spec.args[1]).toMatch(/claude-agent-acp[\\/]dist[\\/]index\.js$/);
    expect(spec.env).toMatchObject({ PATH: "p", ANTHROPIC_API_KEY: "sk-1", CLAUDE_CODE_OAUTH_TOKEN: "tok", CLAUDE_CONFIG_DIR: "C:\\cfg", CLAUDE_CODE_EXECUTABLE: "C:\\claude.exe", ELECTRON_RUN_AS_NODE: "1" });
    for (const key of ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "NODE_OPTIONS"]) expect(spec.env).not.toHaveProperty(key);
  });

  it("keeps an environment API key when no setting overrides it", async () => {
    const spec = await claudeDescriptor({}, { ANTHROPIC_API_KEY: "from-env" }).launch(ctx());
    expect(spec.env?.ANTHROPIC_API_KEY).toBe("from-env");
  });
});

describe("Claude terms", () => {
  it("requires the terms to be acknowledged", async () => {
    const { provider } = make({ termsAcknowledgedAt: undefined });
    await expect(provider.generate("m", user)).rejects.toBeInstanceOf(ProviderTermsRequiredError);
    expect(provider.status().state).toBe("terms_required");
  });

  it("accepts PROXY_CLAUDE_ACCEPT_TERMS instead of the setting", async () => {
    process.env.FAKE_ACP_CLAUDE = "1";
    const { provider } = make({ termsAcknowledgedAt: undefined }, { PROXY_CLAUDE_ACCEPT_TERMS: "1" });
    await expect(provider.generate("fake-model", user)).resolves.toMatchObject({ text: "fake response" });
  });
});

describe("Claude sessions", () => {
  it("creates text-only sessions with the default mode", async () => {
    const { provider, log } = make();
    Object.assign(process.env, { FAKE_ACP_CLAUDE: "1", FAKE_ACP_LOG: log });
    await provider.generate("fake-model", user);
    const created = readLog(log).find((entry) => entry.method === "session/new");
    expect(created?.params._meta).toEqual({ disableBuiltInTools: true, claudeCode: { options: { tools: [], persistSession: false, settingSources: [] } } });
    expect(readLog(log).filter((entry) => entry.method === "session/set_mode").map((entry) => entry.params.modeId)).toEqual(["default"]);
  });

  it("shows the login methods because the agent advertises none", async () => {
    const { provider } = make();
    process.env.FAKE_ACP_CLAUDE = "1";
    await provider.listModels();
    expect(provider.status().authMethods.map((method) => method.id)).toEqual(["claude-ai-login", "console-login"]);
  });
});

describe("Claude busy refresh", () => {
  const refreshError = { code: -32603, message: "Failed to refresh OAuth token: another Claude Code process is refreshing it. Try again shortly." };

  it("maps the OAuth refresh lock error to provider_busy with a 30 s retry hint", async () => {
    Object.assign(process.env, { FAKE_ACP_CLAUDE: "1", FAKE_ACP_PROMPT_ERROR: JSON.stringify(refreshError) });
    const { provider } = make();
    const error = await provider.generate("fake-model", user).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AcpUnavailableError);
    expect(error).toMatchObject({ code: "provider_busy", retryAfterSeconds: 30 });
    expect(provider.status().state).not.toBe("needs_login");
  });

  it("also finds the text in the error data", async () => {
    Object.assign(process.env, { FAKE_ACP_CLAUDE: "1", FAKE_ACP_PROMPT_ERROR: JSON.stringify({ code: -32603, message: "Internal error", data: { details: refreshError.message } }) });
    const { provider } = make();
    expect(await provider.generate("fake-model", user).catch((e: unknown) => e)).toMatchObject({ code: "provider_busy" });
  });

  it("leaves other internal errors as a plain backend failure", async () => {
    Object.assign(process.env, { FAKE_ACP_CLAUDE: "1", FAKE_ACP_PROMPT_ERROR: JSON.stringify({ code: -32603, message: "Failed to refresh OAuth token: invalid grant" }) });
    const { provider } = make();
    const error = await provider.generate("fake-model", user).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AcpUnavailableError);
    expect((error as AcpUnavailableError).code).toBeUndefined();
    expect((error as AcpUnavailableError).retryAfterSeconds).toBeUndefined();
  });

  it("answers 503 provider_busy with a Retry-After: 30 header over HTTP", async () => {
    Object.assign(process.env, { FAKE_ACP_CLAUDE: "1", FAKE_ACP_PROMPT_ERROR: JSON.stringify(refreshError) });
    const { provider } = make();
    const server = createProxyServer({ host: "127.0.0.1", port: 0, maxBodyBytes: 1024, timeoutMs: 5000, workRoot: root, acpArgs: [] }, { hasModel: () => true, generate: (model, messages, callbacks, signal, options) => provider.generate(model, messages, callbacks, signal, options) });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "fake-model", messages: [{ role: "user", content: "hi" }] }) });
      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("30");
      expect(await response.json()).toMatchObject({ error: { type: "server_error", code: "provider_busy" } });
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });

  it("sends no Retry-After for other unavailable errors", async () => {
    const server = createProxyServer({ host: "127.0.0.1", port: 0, maxBodyBytes: 1024, timeoutMs: 5000, workRoot: root, acpArgs: [] }, { generate: async () => { throw new AcpUnavailableError("down"); } });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "gpt-5.6-luna", messages: [{ role: "user", content: "hi" }] }) });
      expect(response.status).toBe(503);
      expect(response.headers.has("retry-after")).toBe(false);
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
});

describe("Claude prompt", () => {
  it("is the generic text-only prompt, byte for byte", async () => {
    const { provider, log } = make();
    Object.assign(process.env, { FAKE_ACP_CLAUDE: "1", FAKE_ACP_LOG: log });
    await provider.generate("fake-model", user);
    const prompt = readLog(log).find((entry) => entry.method === "session/prompt");
    expect((prompt?.params.prompt as Array<{ text: string }>)[0]!.text).toBe(serializePrompt(user));
  });
});

describe("Claude authentication", () => {
  it("maps a -32000 on prompt to needs_login and provider_auth_required", async () => {
    Object.assign(process.env, { FAKE_ACP_CLAUDE: "1", FAKE_ACP_PROMPT_AUTH: "1" });
    const { provider } = make();
    const error = await provider.generate("fake-model", user).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderAuthRequiredError);
    expect((error as ProviderAuthRequiredError).code).toBe("provider_auth_required");
    expect(provider.status().state).toBe("needs_login");
  });

  it("turns _auth/status_update kind none into needs_login", async () => {
    Object.assign(process.env, { FAKE_ACP_CLAUDE: "1", FAKE_ACP_AUTH_STATUS: "none" });
    const { provider } = make();
    await provider.listModels();
    await wait(100);
    expect(provider.status()).toMatchObject({ state: "needs_login", error: "Not logged in." });
    expect(provider.status().account).toBeUndefined();
  });

  it("turns a subscription status into ready with the account label", async () => {
    Object.assign(process.env, { FAKE_ACP_CLAUDE: "1", FAKE_ACP_AUTH_STATUS: "claude_ai" });
    const { provider } = make();
    const seen: ProviderStatus[] = [];
    provider.onStatus((status) => seen.push(status));
    await provider.listModels();
    await wait(100);
    expect(provider.status()).toMatchObject({ state: "ready", account: "Fake account" });
    expect(seen.some((status) => status.account === "Fake account")).toBe(true);
  });

  it("login() runs the external login and restarts the agent", async () => {
    Object.assign(process.env, { FAKE_ACP_CLAUDE: "1", FAKE_ACP_AUTH_STATUS: "claude_ai" });
    const calls: string[] = [];
    const { provider, log } = make({}, {}, { externalLogin: async (_ctx, methodId) => { calls.push(methodId); } });
    process.env.FAKE_ACP_LOG = log;
    await provider.listModels();
    await provider.login("console-login");
    await wait(100);
    expect(calls).toEqual(["console-login"]);
    expect(readLog(log).filter((entry) => entry.method === "initialize")).toHaveLength(2);
    expect(provider.status()).toMatchObject({ state: "ready", account: "Fake account" });
    await expect(provider.generate("fake-model", user)).resolves.toMatchObject({ text: "fake response" });
  });

  it("login() failure leaves needs_login and throws provider_auth_required", async () => {
    process.env.FAKE_ACP_CLAUDE = "1";
    const { provider } = make({}, {}, { externalLogin: async () => { throw new Error("window closed"); } });
    await expect(provider.login("claude-ai-login")).rejects.toBeInstanceOf(ProviderAuthRequiredError);
    expect(provider.status().state).toBe("needs_login");
  });

  it("login() honours loginTimeoutMs", async () => {
    process.env.FAKE_ACP_CLAUDE = "1";
    const { provider } = make({}, {}, { loginTimeoutMs: 100, externalLogin: () => new Promise<void>(() => undefined) });
    await expect(provider.login("claude-ai-login")).rejects.toBeInstanceOf(ProviderAuthRequiredError);
    expect(provider.status().state).toBe("needs_login");
  });
});

describe("Claude leftovers", () => {
  it("removes the empty project directory of a disposed session but keeps non-empty ones", async () => {
    const configDir = path.join(root, `cfg${++counter}`);
    const descriptor = claudeDescriptor({ configDir }, {});
    const empty = path.join(root, "work", "request-a"); const used = path.join(root, "work", "request-b");
    const projectOf = (cwd: string) => path.join(configDir, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
    mkdirSync(path.join(projectOf(empty), "memory"), { recursive: true });
    mkdirSync(path.join(projectOf(used), "memory"), { recursive: true });
    writeFileSync(path.join(projectOf(used), "t.jsonl"), "x");
    await descriptor.onSessionDisposed?.(empty);
    await descriptor.onSessionDisposed?.(used);
    expect(existsSync(projectOf(empty))).toBe(false);
    expect(existsSync(projectOf(used))).toBe(true);
  });
});

describe("Claude binary resolution", () => {
  it("finds the bundled native binary and lets executablePath win", () => {
    const binary = resolveClaudeBinary(ctx(), {});
    expect(binary).toBeTruthy();
    expect(existsSync(binary!)).toBe(true);
    expect(path.basename(binary!)).toMatch(/^claude(\.exe)?$/);
    expect(resolveClaudeBinary(ctx(), { executablePath: "C:\custom\claude.exe" })).toBe("C:\custom\claude.exe");
  });
});
