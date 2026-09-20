import { afterEach, describe, expect, it } from "vitest";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { createProxyServer, mapStopReason } from "../src/server.js";
import { normalizeChat, normalizeResponses, serializePrompt } from "../src/api.js";
import type { AcpLike } from "../src/acp.js";
import type { ProxyConfig } from "../src/config.js";
import OpenAI from "openai";

const config: ProxyConfig = { host: "127.0.0.1", port: 0, maxBodyBytes: 1024, timeoutMs: 5000, workRoot: ".codex/temp/test", acpArgs: [], apiKey: "secret" };
const fake: AcpLike = {
  async generate(_model, messages, callbacks) {
    callbacks?.onText?.("hello");
    return { text: `hello`, stopReason: "end_turn", usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } };
  },
};
let servers: ReturnType<typeof createProxyServer>[] = [];
afterEach(async () => { await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve())))); servers = []; });

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; text: string }> {
  const server = createProxyServer(config, fake); servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, config.host, resolve));
  const address = server.address() as AddressInfo;
  return await new Promise((resolve, reject) => {
    const req = request({ host: config.host, port: address.port, path, method, headers: { authorization: "Bearer secret", ...(body ? { "content-type": "application/json" } : {}) } }, (res) => {
      const chunks: Buffer[] = []; res.on("data", (chunk) => chunks.push(Buffer.from(chunk))); res.on("end", () => resolve({ status: res.statusCode || 0, headers: res.headers, text: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject); if (body) req.end(JSON.stringify(body)); else req.end();
  });
}

describe("normalization", () => {
  it("serializes all conversation roles", () => {
    const normalized = normalizeChat({ model: "gpt-5.6-sol", messages: [{ role: "system", content: "be concise" }, { role: "user", content: [{ type: "text", text: "hello" }] }] });
    expect(serializePrompt(normalized.textMessages)).toContain("[system]\nbe concise");
    expect(normalizeResponses({ model: "gpt-5.6-luna", input: "hi", instructions: "answer" }).textMessages).toHaveLength(2);
  });
  it("rejects unsupported behavior and unknown models", () => {
    expect(() => normalizeChat({ model: "gpt-5.6-sol", messages: [{ role: "user", content: "x" }], temperature: 0 })).toThrow(/temperature/);
    expect(() => normalizeResponses({ model: "nope", input: "x" })).toThrow(/does not exist/);
  });
  it("maps ACP stop reasons to OpenAI completion semantics", () => {
    expect(mapStopReason("end_turn")).toEqual({ chat: "stop", responseStatus: "completed" });
    expect(mapStopReason("max_tokens")).toEqual({ chat: "length", responseStatus: "incomplete" });
    expect(mapStopReason("refusal")).toEqual({ chat: "content_filter", responseStatus: "incomplete" });
    expect(mapStopReason("cancelled")).toEqual({ chat: "stop", responseStatus: "incomplete" });
  });
});

describe("HTTP contract", () => {
  it("works through the official OpenAI SDK in both endpoints and modes", async () => {
    const server = createProxyServer(config, fake); servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, config.host, resolve)); const address = server.address() as AddressInfo;
    const openai = new OpenAI({ apiKey: "secret", baseURL: `http://${config.host}:${address.port}/v1` });
    const models = await openai.models.list(); expect(models.data.map((model) => model.id)).toEqual(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);
    const chat = await openai.chat.completions.create({ model: "gpt-5.6-sol", messages: [{ role: "user", content: "hi" }] });
    expect(chat.choices[0]?.message.content).toBe("hello");
    expect(chat.usage).toMatchObject({ prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 });
    const chatStream = await openai.chat.completions.create({ model: "gpt-5.6-sol", messages: [{ role: "user", content: "hi" }], stream: true });
    const chatChunks: unknown[] = []; for await (const chunk of chatStream) chatChunks.push(chunk); expect(chatChunks.length).toBeGreaterThan(0);
    const response = await openai.responses.create({ model: "gpt-5.6-sol", input: "hi" });
    expect(response.output_text).toBe("hello"); expect(response.usage?.total_tokens).toBe(3);
    const responseStream = await openai.responses.create({ model: "gpt-5.6-sol", input: "hi", stream: true });
    const responseEvents: unknown[] = []; for await (const event of responseStream) responseEvents.push(event); expect(responseEvents.length).toBeGreaterThan(0);
  });
  it("lists models and enforces bearer auth", async () => {
    const result = await call("GET", "/v1/models");
    expect(result.status).toBe(200);
    expect(JSON.parse(result.text).data.map((model: { id: string }) => model.id)).toEqual(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);
  });
  it("returns chat JSON and responses SSE", async () => {
    const chat = await call("POST", "/v1/chat/completions", { model: "gpt-5.6-sol", messages: [{ role: "user", content: "hi" }] });
    expect(chat.status).toBe(200); expect(JSON.parse(chat.text).choices[0].message.content).toBe("hello");
    const responses = await call("POST", "/v1/responses", { model: "gpt-5.6-sol", input: "hi", stream: true });
    expect(responses.status).toBe(200); expect(responses.text).toContain("response.output_text.delta"); expect(responses.text).toContain('"sequence_number":0'); expect(responses.text).toContain("[DONE]");
  });
  it("rejects missing credentials and oversized bodies", async () => {
    const server = createProxyServer(config, fake); servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, config.host, resolve)); const address = server.address() as AddressInfo;
    const result = await new Promise<number>((resolve, reject) => { const req = request({ host: config.host, port: address.port, path: "/v1/models" }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode || 0)); }); req.on("error", reject); req.end(); });
    expect(result).toBe(401);
    const tooLarge = await call("POST", "/v1/chat/completions", { model: "gpt-5.6-sol", messages: [{ role: "user", content: "x".repeat(2000) }] });
    expect(tooLarge.status).toBe(413);
  });
  it("cancels generation when the response client disconnects", async () => {
    let markAborted!: () => void;
    const aborted = new Promise<void>((resolve) => { markAborted = resolve; });
    const waitingBridge: AcpLike = {
      async generate(_model, _messages, _callbacks, signal) {
        return await new Promise<never>((_resolve, reject) => {
          signal?.addEventListener("abort", () => { markAborted(); reject(new Error("cancelled")); }, { once: true });
        });
      },
    };
    const server = createProxyServer(config, waitingBridge); servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, config.host, resolve)); const address = server.address() as AddressInfo;
    const req = request({ host: config.host, port: address.port, path: "/v1/chat/completions", method: "POST", headers: { authorization: "Bearer secret", "content-type": "application/json" } });
    req.on("error", () => undefined);
    req.on("finish", () => setTimeout(() => req.destroy(), 20));
    req.end(JSON.stringify({ model: "gpt-5.6-sol", messages: [{ role: "user", content: "wait" }] }));
    await aborted;
  });
});
