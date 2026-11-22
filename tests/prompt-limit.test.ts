import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { AcpProvider } from "../src/acp-provider.js";
import { ApiError, textMessage, type Message } from "../src/api.js";
import { defaultSettings, resolveConfig } from "../src/settings.js";
import { createLogger } from "../src/logger.js";
import { ProviderRouter } from "../src/router.js";
import { createProxyServer } from "../src/server.js";
import type { ProxyConfig } from "../src/config.js";
import { antigravityDescriptor, antigravityRegistration } from "../src/providers/antigravity.js";
import { codexRegistration } from "../src/providers/codex.js";
import { defaultRuntimeContext, type Provider } from "../src/provider.js";
import { tempRoot } from "./helpers/temp-root.js";

vi.setConfig({ testTimeout: 30_000 });

const fixture = fileURLToPath(new URL("./fixtures/fake-acp.mjs", import.meta.url));
const root = tempRoot("prompt-limit");
afterAll(() => { rmSync(root, { recursive: true, force: true }); });
const config: ProxyConfig = { host: "127.0.0.1", port: 0, maxBodyBytes: 4 * 1024 * 1024, timeoutMs: 20000, workRoot: path.join(root, "work"), acpArgs: [] };
const providers: AcpProvider[] = [];
const servers: ReturnType<typeof createProxyServer>[] = [];
let counter = 0;

function makeAgy(maxPromptChars?: number): { provider: AcpProvider; log: string } {
  const base = path.join(root, `t${++counter}`);
  const dataDir = path.join(base, "data");
  const agentDir = path.join(dataDir, "agents", "antigravity-acp");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(path.join(agentDir, "install.json"), JSON.stringify({ version: "1.0.0", url: "x", sha256: "x", command: process.execPath, args: [fixture], dir: agentDir, installedAt: new Date().toISOString() }));
  const log = path.join(base, "requests.log");
  Object.assign(process.env, { FAKE_ACP_AGY: "1", FAKE_ACP_LOG: log, FAKE_ACP_IMAGE: "1" });
  const ctx = defaultRuntimeContext({ dataDir });
  const descriptor = antigravityDescriptor(ctx, { env: {}, settings: { termsAcknowledgedAt: "2026-01-01T00:00:00Z", geminiHome: path.join(base, "gemini") }, overrides: { warmSessions: 0 } });
  const provider = new AcpProvider(descriptor, ctx, { workRoot: path.join(base, "work"), ...(maxPromptChars !== undefined ? { maxPromptChars } : {}) });
  providers.push(provider);
  return { provider, log };
}
const prompts = (log: string) => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { method: string }) : []).filter((entry) => entry.method === "session/prompt");

beforeEach(() => { mkdirSync(root, { recursive: true }); });
afterEach(async () => {
  await Promise.all(providers.splice(0).map((provider) => provider.close()));
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections?.(); })));
  for (const key of Object.keys(process.env)) if (key.startsWith("FAKE_ACP_")) delete process.env[key];
});

describe("prompt size limit", () => {
  it("refuses an Antigravity prompt over the limit before the agent sees it (chat stream and Responses), and passes one under it", async () => {
    const { provider, log } = makeAgy();
    const router = new ProviderRouter({ providers: [provider], logger: createLogger({ console: false }) });
    const server = createProxyServer(config, router); servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, config.host, resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = (route: string, body: unknown) => fetch(`${base}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const big = "x".repeat(200_000);

    const models = await (await fetch(`${base}/v1/models`)).json() as { data: Array<{ id: string; max_prompt_chars?: number }> };
    const agy = models.data.filter((model) => model.id.startsWith("antigravity/"));
    expect(agy.length).toBeGreaterThan(0);
    expect(agy.every((model) => model.max_prompt_chars === 180000)).toBe(true);
    const model = agy[0]!.id;

    const chat = await post("/v1/chat/completions", { model, stream: true, messages: [{ role: "user", content: big }] });
    expect(chat.status).toBe(400);
    expect(chat.headers.get("content-type")).toContain("application/json");
    const chatBody = await chat.json() as { error: { type: string; code: string; param: string; message: string } };
    expect(chatBody.error).toMatchObject({ type: "invalid_request_error", code: "context_length_exceeded", param: "messages" });
    expect(chatBody.error.message.startsWith("The prompt is too long for Google Antigravity: ")).toBe(true);
    expect(chatBody.error.message).toContain("the limit is 180000.");
    // Scriptorium's isContextError (src/engine/models/router.ts:345-348) must match, or its router retries instead of moving on.
    expect(chatBody.error.message).toMatch(/exceed_context_size|exceeds the available context|context (size|length|window)|maximum context|n_ctx|token limit without an answer|prompt is too long|(input|prompt|request)[^.]{0,40}too long|exceeds the maximum number of tokens/i);

    const responses = await post("/v1/responses", { model, input: big });
    expect(responses.status).toBe(400);
    expect(((await responses.json()) as { error: { code: string; param: string } }).error).toMatchObject({ code: "context_length_exceeded", param: "input" });

    const small = await post("/v1/chat/completions", { model, messages: [{ role: "user", content: "x".repeat(1000) }] });
    expect(small.status).toBe(200);
    expect(prompts(log)).toHaveLength(1);
  });

  it("counts the preamble and the output format, not images", () => {
    const { provider } = makeAgy(1000);
    const text = textMessage("user", "x".repeat(300));
    expect(() => provider.checkPrompt([text])).not.toThrow();
    // The same 300 characters plus the proxy's preamble and an [output format] block are over 1000.
    const err = (() => { try { provider.checkPrompt([text], { instructions: "y".repeat(300) }); } catch (e) { return e; } })();
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 400, code: "context_length_exceeded" });
    const withImage: Message = { role: "user", parts: [{ type: "text", text: "look" }, { type: "image", mimeType: "image/png", data: "A".repeat(100_000) }] };
    expect(() => provider.checkPrompt([withImage])).not.toThrow();
  });

  it("reads providers.<id>.maxPromptChars and the env override; 0 turns the limit off", () => {
    const resolved = resolveConfig(defaultSettings(), { PROXY_ANTIGRAVITY_MAX_PROMPT_CHARS: "0", PROXY_CODEX_MAX_PROMPT_CHARS: "5000" });
    expect(resolved.providers.antigravity?.maxPromptChars).toBe(0);
    expect(resolved.providers.codex?.maxPromptChars).toBe(5000);
    expect(resolved.overridden).toEqual(expect.arrayContaining(["providers.antigravity.maxPromptChars", "providers.codex.maxPromptChars"]));

    const ctx = defaultRuntimeContext({ dataDir: path.join(root, "reg") });
    const create = (registration: typeof codexRegistration, providerSettings: Record<string, unknown>): Provider => registration.create({ settings: defaultSettings(), providerSettings: { enabled: true, ...providerSettings }, config, ctx, env: {}, saveSettings: async () => {} });
    expect(create(antigravityRegistration, { maxPromptChars: 0 }).maxPromptChars).toBeUndefined();
    expect(create(codexRegistration, { maxPromptChars: 5000 }).maxPromptChars).toBe(5000);
    expect(create(antigravityRegistration, {}).maxPromptChars).toBe(180000);
    expect(create(codexRegistration, {}).maxPromptChars).toBeUndefined();
  });
});
