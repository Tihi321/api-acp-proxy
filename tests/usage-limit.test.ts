import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { AcpProvider } from "../src/acp-provider.js";
import { codexDescriptor } from "../src/providers/codex.js";
import { defaultRuntimeContext, type Provider } from "../src/provider.js";
import { createLogger } from "../src/logger.js";
import { ProviderRouter } from "../src/router.js";
import { createProxyServer } from "../src/server.js";
import type { ProxyConfig } from "../src/config.js";
import { exhaustedUntil, matchCodexUsageLimit, matchPattern, parseResetTime } from "../src/usage-limit.js";

vi.setConfig({ testTimeout: 30_000 });

const fixture = fileURLToPath(new URL("./fixtures/fake-acp.mjs", import.meta.url));
const root = path.resolve(".claude/temp/usage-limit-tests", String(process.pid));
const config: ProxyConfig = { host: "127.0.0.1", port: 0, maxBodyBytes: 4 * 1024 * 1024, timeoutMs: 20000, workRoot: path.join(root, "work"), acpArgs: [] };
const providers: Array<{ close(): Promise<void> }> = [];
const servers: ReturnType<typeof createProxyServer>[] = [];

beforeEach(() => { mkdirSync(root, { recursive: true }); });
afterEach(async () => {
  await Promise.all(providers.splice(0).map((provider) => provider.close()));
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections?.(); })));
  for (const key of Object.keys(process.env)) if (key.startsWith("FAKE_ACP_")) delete process.env[key];
});

const limitMessage = "You've hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), or try again at Nov 29th, 2026 11:07 AM.";
const limitError = { code: -32603, message: "Internal error", data: { message: limitMessage, codexErrorInfo: "usageLimitExceeded" } };

describe("usage limit, over HTTP", () => {
  it("answers the first failure with the 429 contract, refuses the next request (stream too) without running the agent, shows it in /healthz and /v1/models, leaves another provider alone", async () => {
    const dir = path.join(root, "http"); mkdirSync(dir, { recursive: true });
    const log = path.join(dir, "requests.log");
    Object.assign(process.env, { FAKE_ACP_LOG: log, FAKE_ACP_PROMPT_ERROR: JSON.stringify(limitError) });
    const codex = new AcpProvider(codexDescriptor({ acpCommand: process.execPath, acpArgs: [fixture] }, { isolatedHome: false }), defaultRuntimeContext({ dataDir: dir }), { workRoot: path.join(dir, "work") });
    providers.push(codex);
    const other: Provider = {
      id: "other", displayName: "Other", ownedBy: "other", exposeUnprefixed: false, staticModels: [{ id: "m" }],
      async generate() { return { text: "other answer", stopReason: "end_turn", usage: null }; },
      async listModels() { return [{ id: "m" }]; },
      status: () => ({ id: "other", name: "Other", state: "ready", authMethods: [], models: [{ id: "m" }] }),
      async login() { /* not needed */ }, onStatus: () => () => undefined, async close() { /* nothing */ },
    };
    // The clock is three days before the reset, so the parsed time (not the cooldown) is used.
    const now = new Date(2026, 10, 26, 12, 0).getTime();
    const router = new ProviderRouter({ providers: [codex, other], logger: createLogger({ console: false }), now: () => now });
    const server = createProxyServer(config, router); servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, config.host, resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = (body: unknown) => fetch(`${base}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const prompts = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as { method: string }) : []).filter((entry) => entry.method === "session/prompt").length;
    const until = new Date(2026, 10, 29, 11, 7).toISOString();
    const retryAfter = Math.ceil((new Date(until).getTime() - now) / 1000);

    const first = await post({ model: "codex/gpt-6-luna", messages: [{ role: "user", content: "hi" }] });
    expect(first.status).toBe(429);
    expect(first.headers.get("retry-after")).toBe(String(retryAfter));
    const body = await first.json() as { error: Record<string, unknown> };
    expect(body.error).toMatchObject({ type: "rate_limit_error", param: "model", code: "usage_limit_exceeded", provider: "codex", exhausted_until: until, retry_after: retryAfter });
    expect(String(body.error.message)).toContain("Codex has hit its usage limit; it resets at 2026-11-29 11:07 (local time).");
    expect(prompts()).toBe(1);

    const streamed = await post({ model: "codex/gpt-6-luna", stream: true, messages: [{ role: "user", content: "hi" }] });
    expect(streamed.status).toBe(429);
    expect(streamed.headers.get("content-type")).toContain("application/json");
    expect(((await streamed.json()) as { error: { code: string } }).error.code).toBe("usage_limit_exceeded");
    expect(prompts()).toBe(1);

    const health = await (await fetch(`${base}/healthz`)).json() as { providers: Record<string, { exhausted_until?: string }> };
    expect(health.providers.codex?.exhausted_until).toBe(until);
    expect(health.providers.other?.exhausted_until).toBeUndefined();
    const models = await (await fetch(`${base}/v1/models`)).json() as { data: Array<{ id: string; exhausted_until?: string }> };
    expect(models.data.filter((model) => model.id.startsWith("codex/")).every((model) => model.exhausted_until === until)).toBe(true);
    expect(models.data.some((model) => model.id.startsWith("codex/"))).toBe(true);
    expect(models.data.find((model) => model.id === "other/m")?.exhausted_until).toBeUndefined();

    const answered = await post({ model: "other/m", messages: [{ role: "user", content: "hi" }] });
    expect(answered.status).toBe(200);
  });

  it("does not mark a provider exhausted for a rate limit or a plain failure, and uses usageLimitPattern only when set", async () => {
    const dir = path.join(root, "pattern"); mkdirSync(dir, { recursive: true });
    const failing = { code: -32603, message: "Internal error", data: { message: "Quota exceeded for today" } };
    Object.assign(process.env, { FAKE_ACP_PROMPT_ERROR: JSON.stringify(failing) });
    const make = (usageLimitPattern?: string) => {
      const provider = new AcpProvider(codexDescriptor({ acpCommand: process.execPath, acpArgs: [fixture] }, { isolatedHome: false }), defaultRuntimeContext({ dataDir: dir }), { workRoot: path.join(dir, "work"), ...(usageLimitPattern ? { usageLimitPattern } : {}) });
      providers.push(provider);
      return new ProviderRouter({ providers: [provider], logger: createLogger({ console: false }) });
    };
    const ask = (router: ProviderRouter) => router.generate("codex/gpt-6-luna", [{ role: "user", parts: [{ type: "text", text: "hi" }] }]);
    const plain = make();
    await expect(ask(plain)).rejects.toMatchObject({ name: "AcpUnavailableError" });
    expect(plain.exhaustedProviders()).toEqual({});
    const withPattern = make("quota exceeded");
    await expect(ask(withPattern)).rejects.toMatchObject({ status: 429, code: "usage_limit_exceeded" });
    expect(Object.keys(withPattern.exhaustedProviders())).toEqual(["codex"]);
  });
});

describe("usage limit parsing", () => {
  const local = (y: number, m: number, d: number, h: number, min: number) => new Date(y, m, d, h, min).getTime();
  const now = local(2026, 10, 26, 12, 0);

  it("reads the reset time as local time: dated, suffixes, 12 AM / 12 PM, time only; anything else is undefined", () => {
    expect(parseResetTime(limitMessage, now)).toBe(local(2026, 10, 29, 11, 7));
    expect(parseResetTime("try again at Dec 1st, 2026 12:00 AM.", now)).toBe(local(2026, 11, 1, 0, 0));
    expect(parseResetTime("try again at Jan 2nd, 2027 12:30 PM", now)).toBe(local(2027, 0, 2, 12, 30));
    expect(parseResetTime("try again at 3:15 PM.", now)).toBe(local(2026, 10, 26, 15, 15));
    expect(parseResetTime("try again at 9:05 AM.", now)).toBe(local(2026, 10, 27, 9, 5));
    for (const text of ["try again later", "try again at Foo 29th, 2026 11:07 AM", "try again at Feb 31st, 2026 1:00 PM", "try again at Nov 29th, 2026 13:00 AM"]) expect(parseResetTime(text, now)).toBeUndefined();
  });

  it("falls back to the cooldown for no, past or over-31-day reset times", () => {
    const hour = 3_600_000, cap = 31 * 24 * hour;
    expect(exhaustedUntil(limitMessage, now, hour, cap)).toBe(local(2026, 10, 29, 11, 7));
    expect(exhaustedUntil("garbage", now, hour, cap)).toBe(now + hour);
    expect(exhaustedUntil("try again at Nov 1st, 2026 11:07 AM", now, hour, cap)).toBe(now + hour);
    expect(exhaustedUntil("try again at Dec 30th, 2026 11:07 AM", now, hour, cap)).toBe(now + hour);
  });

  it("matches Codex usage limits only, and a pattern only when given", () => {
    const rpc = (message: string, info?: string) => Object.assign(new Error(message), { data: info ? { codexErrorInfo: info } : undefined });
    expect(matchCodexUsageLimit(rpc("x", "usageLimitExceeded"))).toBe(true);
    expect(matchCodexUsageLimit(rpc("x", "usage_limit_exceeded"))).toBe(true);
    expect(matchCodexUsageLimit(rpc("You've hit your usage limit."))).toBe(true);
    for (const error of [rpc("x", "rateLimitExceeded"), rpc("x", "serverOverloaded"), rpc("Internal error")]) expect(matchCodexUsageLimit(error)).toBe(false);
    expect(matchPattern(rpc("Quota exceeded"), /quota/i)).toBe(true);
    expect(matchPattern(rpc("Quota exceeded"), undefined)).toBe(false);
  });
});
