import { afterEach, describe, expect, it } from "vitest";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { ActivityLog, describeActivity, type ActivityEntry } from "../src/activity.js";
import { createProxyServer } from "../src/server.js";
import { ApiError } from "../src/api.js";
import { ProviderAuthRequiredError } from "../src/provider.js";
import type { AcpLike, GenerationResult } from "../src/acp.js";
import type { ProxyConfig } from "../src/config.js";

const entry = (time: number, extra: Partial<ActivityEntry> = {}): ActivityEntry => ({ time, endpoint: "POST /v1/chat/completions", stream: false, features: [], durationMs: 5, status: 200, ...extra });

describe("ActivityLog", () => {
  it("keeps the newest requests up to the cap and lists them newest first", () => {
    const log = new ActivityLog(3);
    for (let n = 1; n <= 5; n++) log.record(entry(n * 1000, { model: `m${n}` }));
    expect(log.list().map((item) => item.model)).toEqual(["m5", "m4", "m3"]);
    expect(log.list(2).map((item) => item.model)).toEqual(["m5", "m4"]);
    // The day's count is a counter, not the buffer size.
    expect(log.summary()).toEqual({ today: 5, lastAt: 5000 });
  });

  it("orders by the start of the request, the later recorded one first on a tie", () => {
    const log = new ActivityLog();
    log.record(entry(2000, { model: "late-start" }));
    log.record(entry(1000, { model: "long-request" }));
    log.record(entry(2000, { model: "tie" }));
    expect(log.list().map((item) => item.model)).toEqual(["tie", "late-start", "long-request"]);
  });

  it("has a default cap of 100", () => {
    const log = new ActivityLog();
    for (let n = 0; n < 130; n++) log.record(entry(n));
    expect(log.list()).toHaveLength(100);
    expect(log.list()[0]?.time).toBe(129);
    expect(log.list().at(-1)?.time).toBe(30);
  });

  it("clears, emits record and change, and restarts the day count at midnight", () => {
    let now = new Date(2026, 5, 1, 23, 0, 0).getTime();
    const log = new ActivityLog(100, () => now);
    const events: string[] = [];
    log.on("record", () => events.push("record"));
    log.on("change", () => events.push("change"));
    log.record(entry(now));
    expect(events).toEqual(["record", "change"]);
    expect(log.summary().today).toBe(1);
    now = new Date(2026, 5, 2, 0, 5, 0).getTime();
    expect(log.summary().today).toBe(0);
    log.record(entry(now));
    expect(log.summary().today).toBe(1);
    log.clear();
    expect(log.list()).toEqual([]);
    expect(log.summary()).toEqual({ today: 0 });
    expect(events.at(-1)).toBe("change");
  });

  it("describes the log for the tray tooltip", () => {
    const now = Date.now();
    expect(describeActivity({ today: 0 }, now)).toBe("No requests yet");
    expect(describeActivity({ today: 1, lastAt: now - 10_000 }, now)).toBe("1 request today, last <1 min ago");
    expect(describeActivity({ today: 7, lastAt: now - 2 * 60_000 }, now)).toBe("7 requests today, last 2 min ago");
    expect(describeActivity({ today: 7, lastAt: now - 3 * 3600_000 }, now)).toBe("7 requests today, last 3 h ago");
  });
});

const config: ProxyConfig = { host: "127.0.0.1", port: 0, maxBodyBytes: 100_000, timeoutMs: 5000, workRoot: ".claude/temp/aap19/activity", acpArgs: [], apiKey: "secret" };
const TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const SECRET_PROMPT = "SECRET-PROMPT-TEXT";
const SECRET_ANSWER = "SECRET-ANSWER-TEXT";
let behaviour: (model: string) => Promise<GenerationResult> | GenerationResult = () => ({ text: SECRET_ANSWER, stopReason: "end_turn", usage: { inputTokens: 11, outputTokens: 4, totalTokens: 15 } });
const bridge: AcpLike = {
  async generate(model, _messages, callbacks) { const result = await behaviour(model); if (result.text) callbacks?.onText?.(result.text); return result; },
  hasModel: () => true,
  providerOf: (model) => model.split("/")[0],
};
let servers: ReturnType<typeof createProxyServer>[] = [];
afterEach(async () => {
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); })));
  servers = [];
  behaviour = () => ({ text: SECRET_ANSWER, stopReason: "end_turn", usage: { inputTokens: 11, outputTokens: 4, totalTokens: 15 } });
});

async function serve(activity: ActivityLog, apiKey: string | undefined = "secret"): Promise<number> {
  const server = createProxyServer({ ...config, apiKey }, bridge, { activity });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, config.host, resolve));
  return (server.address() as AddressInfo).port;
}
function call(port: number, method: string, path: string, body?: unknown, headers: Record<string, string> = { authorization: "Bearer secret" }): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: config.host, port, path, method, headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) } }, (res) => {
      const chunks: Buffer[] = []; res.on("data", (chunk) => chunks.push(Buffer.from(chunk))); res.on("end", () => resolve({ status: res.statusCode || 0, text: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject); if (body) req.end(JSON.stringify(body)); else req.end();
  });
}
/** The log entry of the request just made (the entry is recorded when the response closes, a moment after the client has the answer). */
async function lastEntry(activity: ActivityLog, count = 1): Promise<ActivityEntry> {
  for (let n = 0; n < 100 && activity.list().length < count; n++) await new Promise((resolve) => setTimeout(resolve, 10));
  return activity.list()[0]!;
}
const chat = (extra: Record<string, unknown> = {}) => ({ model: "fake/m", messages: [{ role: "user", content: SECRET_PROMPT }], ...extra });

describe("activity from the server", () => {
  it("records a plain chat request with its model, provider, timing and token counts", async () => {
    const activity = new ActivityLog();
    const port = await serve(activity);
    expect((await call(port, "POST", "/v1/chat/completions", chat())).status).toBe(200);
    const recorded = await lastEntry(activity);
    expect(recorded).toMatchObject({ endpoint: "POST /v1/chat/completions", model: "fake/m", provider: "fake", stream: false, features: [], status: 200, inputTokens: 11, outputTokens: 4 });
    expect(recorded.error).toBeUndefined();
    expect(recorded.durationMs).toBeGreaterThanOrEqual(0);
    expect(Math.abs(recorded.time - Date.now())).toBeLessThan(10_000);
  });

  it("marks streaming requests, in chat and in Responses", async () => {
    const activity = new ActivityLog();
    const port = await serve(activity);
    await call(port, "POST", "/v1/chat/completions", chat({ stream: true }));
    expect(await lastEntry(activity)).toMatchObject({ stream: true, status: 200 });
    await call(port, "POST", "/v1/responses", { model: "fake/m", input: "hi", stream: true });
    expect(await lastEntry(activity, 2)).toMatchObject({ endpoint: "POST /v1/responses", stream: true, outputTokens: 4 });
  });

  it("detects the features of every kind of request", async () => {
    const activity = new ActivityLog();
    const port = await serve(activity);
    const featuresOf = async (path: string, body: unknown, count: number): Promise<string[]> => { await call(port, "POST", path, body); return (await lastEntry(activity, count)).features.slice().sort(); };
    const image = { type: "image_url", image_url: { url: `data:image/png;base64,${TINY_PNG}` } };
    expect(await featuresOf("/v1/chat/completions", chat({ messages: [{ role: "user", content: [{ type: "text", text: SECRET_PROMPT }, image] }] }), 1)).toEqual(["images"]);
    expect(await featuresOf("/v1/chat/completions", chat({ modalities: ["text", "image"] }), 2)).toEqual(["imageGeneration"]);
    expect(await featuresOf("/v1/chat/completions", chat({ tools: [{ type: "function", function: { name: "f", parameters: { type: "object", properties: {} } } }] }), 3)).toEqual(["tools"]);
    expect(await featuresOf("/v1/chat/completions", chat({ web_search_options: {} }), 4)).toEqual(["search"]);
    expect(await featuresOf("/v1/responses", { model: "fake/m", input: "hi", tools: [{ type: "mcp", server_label: "docs", server_url: "https://example.com/mcp?token=SECRET-TOKEN", require_approval: "never" }] }, 5)).toEqual(["mcp"]);
    expect(await featuresOf("/v1/responses", { model: "fake/m", input: "hi", tools: [{ type: "web_search" }] }, 6)).toEqual(["search"]);
    expect(await featuresOf("/v1/responses", { model: "fake/m", input: "hi", tools: [{ type: "function", name: "f", parameters: { type: "object", properties: {} } }, { type: "web_search" }] }, 7)).toEqual(["search", "tools"]);
    behaviour = () => ({ text: "", stopReason: "end_turn", usage: null, images: [{ mimeType: "image/png", data: TINY_PNG }] });
    expect(await featuresOf("/v1/images/generations", { model: "fake/m", prompt: SECRET_PROMPT }, 8)).toEqual(["imageGeneration"]);
    expect(activity.list()[0]).toMatchObject({ endpoint: "POST /v1/images/generations", status: 200 });
  });

  it("records models listings, auth failures, unknown paths and error codes", async () => {
    const activity = new ActivityLog();
    const port = await serve(activity);
    await call(port, "GET", "/v1/models");
    expect(await lastEntry(activity)).toMatchObject({ endpoint: "GET /v1/models", status: 200, stream: false });
    await call(port, "GET", "/v1/models", undefined, {});
    expect(await lastEntry(activity, 2)).toMatchObject({ status: 401, error: "invalid_api_key" });
    await call(port, "GET", "/v1/nope");
    expect(await lastEntry(activity, 3)).toMatchObject({ endpoint: "other", status: 404, error: "not_found" });
    await call(port, "POST", "/v1/chat/completions", { model: "fake/m" });
    expect(await lastEntry(activity, 4)).toMatchObject({ status: 400 });
    expect((await lastEntry(activity, 4)).error).toBeTruthy();
    behaviour = () => { throw new ApiError(400, "unsupported_content", "no images", "messages"); };
    await call(port, "POST", "/v1/chat/completions", chat());
    expect(await lastEntry(activity, 5)).toMatchObject({ status: 400, error: "unsupported_content", model: "fake/m" });
    behaviour = () => { throw new ProviderAuthRequiredError("Fake requires login."); };
    await call(port, "POST", "/v1/chat/completions", chat());
    expect(await lastEntry(activity, 6)).toMatchObject({ status: 503, error: "provider_auth_required", provider: "fake" });
  });

  it("keeps the error code of a stream that fails after it started (status 200)", async () => {
    const activity = new ActivityLog();
    const port = await serve(activity);
    behaviour = () => { throw new ProviderAuthRequiredError("Fake requires login."); };
    await call(port, "POST", "/v1/chat/completions", chat({ stream: true }));
    expect(await lastEntry(activity)).toMatchObject({ stream: true, status: 200, error: "provider_auth_required" });
  });

  it("does not record /healthz and stores no prompt, answer, header, key or URL", async () => {
    const activity = new ActivityLog();
    const port = await serve(activity);
    await call(port, "GET", "/healthz");
    await call(port, "POST", "/v1/chat/completions", chat({ user: "SECRET-USER" }), { authorization: "Bearer secret", "x-custom": "SECRET-HEADER" });
    await call(port, "POST", "/v1/responses", { model: "fake/m", input: SECRET_PROMPT, tools: [{ type: "mcp", server_label: "docs", server_url: "https://example.com/mcp?token=SECRET-TOKEN", headers: { authorization: "SECRET-MCP-HEADER" } }] });
    await lastEntry(activity, 2);
    expect(activity.list()).toHaveLength(2);
    const text = JSON.stringify(activity.list());
    for (const secret of [SECRET_PROMPT, SECRET_ANSWER, "SECRET-USER", "SECRET-HEADER", "SECRET-TOKEN", "SECRET-MCP-HEADER", "secret", "example.com"]) expect(text).not.toContain(secret);
    const allowed = new Set(["time", "endpoint", "model", "provider", "stream", "features", "durationMs", "status", "error", "inputTokens", "outputTokens"]);
    for (const item of activity.list()) for (const key of Object.keys(item)) expect(allowed.has(key)).toBe(true);
  });

  it("works without an activity log", async () => {
    const server = createProxyServer(config, bridge);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, config.host, resolve));
    expect((await call((server.address() as AddressInfo).port, "POST", "/v1/chat/completions", chat())).status).toBe(200);
  });
});
