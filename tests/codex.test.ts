import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AcpProvider } from "../src/acp-provider.js";
import { serializePrompt } from "../src/api.js";
import { codexDescriptor, hardenedCodexConfig } from "../src/providers/codex.js";
import { ProviderAuthRequiredError, defaultRuntimeContext } from "../src/provider.js";

const fixture = fileURLToPath(new URL("./fixtures/fake-acp.mjs", import.meta.url));
const root = path.resolve(".claude/temp/codex-tests", String(process.pid));
const base = { acpCommand: undefined, acpArgs: [] as string[] };
const user = [{ role: "user" as const, content: "hello" }];
const providers: AcpProvider[] = [];
let counter = 0;
let saved: Record<string, string | undefined> = {};

const dataDir = () => path.join(root, `t${++counter}`);
const ctx = (dir: string) => defaultRuntimeContext({ dataDir: dir, resolveUnpacked: (file) => file });
const config = async (options: Parameters<typeof codexDescriptor>[1] = {}, dir = dataDir()) => {
  const spec = await codexDescriptor(base, options).launch(ctx(dir));
  return { spec, config: JSON.parse(spec.env!.CODEX_CONFIG!) as Record<string, any>, dir };
};

beforeEach(() => {
  mkdirSync(root, { recursive: true });
  saved = { CODEX_HOME: process.env.CODEX_HOME, CODEX_CONFIG: process.env.CODEX_CONFIG, CODEX_API_KEY: process.env.CODEX_API_KEY, OPENAI_API_KEY: process.env.OPENAI_API_KEY };
  for (const key of Object.keys(saved)) delete process.env[key];
});
afterEach(async () => {
  await Promise.all(providers.splice(0).map((provider) => provider.close()));
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  for (const key of Object.keys(process.env)) if (key.startsWith("FAKE_ACP_")) delete process.env[key];
});

describe("Codex isolated home", () => {
  it("launches with CODEX_HOME=<dataDir>/codex-home, created, by default", async () => {
    const { spec, dir } = await config();
    expect(spec.env?.CODEX_HOME).toBe(path.join(dir, "codex-home"));
    expect(existsSync(spec.env!.CODEX_HOME!)).toBe(true);
  });

  it("does the same when isolatedHome is true and replaces a CODEX_HOME of the environment", async () => {
    process.env.CODEX_HOME = path.join(root, "users-own-home");
    const { spec, dir } = await config({ isolatedHome: true });
    expect(spec.env?.CODEX_HOME).toBe(path.join(dir, "codex-home"));
  });

  it("leaves CODEX_HOME alone when isolatedHome is off", async () => {
    const { spec, dir } = await config({ isolatedHome: false });
    expect(spec.env).not.toHaveProperty("CODEX_HOME");
    expect(existsSync(path.join(dir, "codex-home"))).toBe(false);
    process.env.CODEX_HOME = path.join(root, "users-own-home");
    expect((await config({ isolatedHome: false })).spec.env?.CODEX_HOME).toBe(path.join(root, "users-own-home"));
  });
});

describe("Codex hardened config", () => {
  it("removes the shell tools and keeps read-only, never-ask and no skill list", async () => {
    const { config: cfg } = await config();
    expect(cfg).toMatchObject({ approval_policy: "never", sandbox_mode: "read-only", skills: { include_instructions: false }, features: { multi_agent: false, shell_tool: false, unified_exec: false, plugins: false } });
    expect(cfg).not.toHaveProperty("web_search");
  });

  it("cannot be weakened by a user CODEX_CONFIG, which is otherwise kept", async () => {
    process.env.CODEX_CONFIG = JSON.stringify({ approval_policy: "on-request", sandbox_mode: "danger-full-access", web_search: "cached", skills: { include_instructions: true, extra: 1 }, features: { shell_tool: true, unified_exec: true, plugins: true, multi_agent: true, custom: true } });
    const { config: cfg } = await config();
    expect(cfg).toEqual({ approval_policy: "never", sandbox_mode: "read-only", web_search: "cached", skills: { include_instructions: false, extra: 1 }, features: { multi_agent: false, shell_tool: false, unified_exec: false, plugins: false, custom: true } });
  });

  it("ignores sections of the wrong type and an invalid CODEX_CONFIG", async () => {
    expect(hardenedCodexConfig({ features: "yes", skills: [1] }).features).toEqual({ multi_agent: false, shell_tool: false, unified_exec: false, plugins: false });
    process.env.CODEX_CONFIG = "{not json";
    expect((await config()).config.features.shell_tool).toBe(false);
  });

  it("is also applied when the home is not isolated", async () => {
    expect((await config({ isolatedHome: false })).config.features).toMatchObject({ shell_tool: false, unified_exec: false });
  });
});

describe("Codex first login", () => {
  const methods = JSON.stringify([{ id: "api-key", name: "API key" }, { id: "chat-gpt", name: "ChatGPT" }]);
  /** The fake agent behind a real Codex descriptor; session/new needs a prior authenticate. */
  function make(options: Parameters<typeof codexDescriptor>[1] = {}) {
    const dir = dataDir(); mkdirSync(dir, { recursive: true });
    const log = path.join(dir, "requests.log");
    Object.assign(process.env, { FAKE_ACP_LOG: log, FAKE_ACP_AUTH_METHODS: methods, FAKE_ACP_REQUIRE_AUTH: "1" });
    const provider = new AcpProvider(codexDescriptor({ acpCommand: process.execPath, acpArgs: [fixture] }, options), ctx(dir), { workRoot: path.join(dir, "work") });
    providers.push(provider);
    const authenticated = () => existsSync(log) ? readFileSync(log, "utf8").trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as { method: string; params: { methodId?: string } }).filter((entry) => entry.method === "authenticate").map((entry) => entry.params.methodId) : [];
    return { provider, dir, authenticated };
  }
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it("does not authenticate on its own without auth.json and without an API key: needs_login", async () => {
    const { provider, authenticated } = make();
    await expect(provider.generate("gpt-5.6-luna", user)).rejects.toBeInstanceOf(ProviderAuthRequiredError);
    expect(provider.status()).toMatchObject({ state: "needs_login" });
    expect(provider.status().error).toMatch(/Log in to Codex for the proxy/);
    await wait(100);
    expect(authenticated()).toEqual([]);
  });

  it("authenticates with chat-gpt when auth.json exists (never read: an empty file is enough)", async () => {
    const { provider, dir, authenticated } = make();
    mkdirSync(path.join(dir, "codex-home"), { recursive: true });
    writeFileSync(path.join(dir, "codex-home", "auth.json"), "");
    await expect(provider.generate("gpt-5.6-luna", user)).resolves.toMatchObject({ text: "fake response" });
    expect(authenticated()).toEqual(["chat-gpt"]);
  });

  it("uses the api-key method when an API key is in the environment, with or without auth.json", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const { provider, authenticated } = make();
    await expect(provider.generate("gpt-5.6-luna", user)).resolves.toMatchObject({ text: "fake response" });
    expect(authenticated()).toEqual(["api-key"]);
  });

  it("login() runs authenticate chat-gpt even without auth.json, and the provider recovers", async () => {
    const { provider, authenticated } = make();
    await expect(provider.generate("gpt-5.6-luna", user)).rejects.toBeInstanceOf(ProviderAuthRequiredError);
    expect(authenticated()).toEqual([]);
    await provider.login();
    expect(authenticated()).toEqual(["chat-gpt"]);
    expect(provider.status().state).toBe("ready");
    await expect(provider.generate("gpt-5.6-luna", user)).resolves.toMatchObject({ text: "fake response" });
  });

  it("is unchanged with isolatedHome off: chat-gpt is authenticated automatically", async () => {
    const { provider, authenticated } = make({ isolatedHome: false });
    await expect(provider.generate("gpt-5.6-luna", user)).resolves.toMatchObject({ text: "fake response" });
    expect(authenticated()).toEqual(["chat-gpt"]);
  });
});

describe("Codex prompt", () => {
  it("is the generic text-only prompt, with no provider-specific preamble", async () => {
    const dir = dataDir(); mkdirSync(dir, { recursive: true });
    const log = path.join(dir, "requests.log");
    Object.assign(process.env, { FAKE_ACP_LOG: log });
    const provider = new AcpProvider(codexDescriptor({ acpCommand: process.execPath, acpArgs: [fixture] }, { isolatedHome: false }), ctx(dir), { workRoot: path.join(dir, "work") });
    providers.push(provider);
    await provider.generate("gpt-5.6-luna", user);
    const prompt = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { method: string; params: { prompt?: Array<{ text: string }> } }).find((entry) => entry.method === "session/prompt");
    expect(prompt?.params.prompt?.[0]?.text).toBe(serializePrompt(user));
  });
});
