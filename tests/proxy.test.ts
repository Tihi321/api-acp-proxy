import { afterEach, describe, expect, it } from "vitest";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { createProxyServer, mapStopReason } from "../src/server.js";
import { extractJson, formatInstructions, normalizeChat, normalizeResponses, serializePrompt } from "../src/api.js";
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

async function call(method: string, path: string, body?: unknown, bridge: AcpLike = fake): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; text: string }> {
  const server = createProxyServer(config, bridge); servers.push(server);
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
  it("drops sampling fields with ignoreSampling, and still rejects behaviour-changing ones", () => {
    const body = { model: "gpt-5.6-sol", messages: [{ role: "user", content: "x" }], temperature: 0.7, max_tokens: 100, stream_options: { include_usage: true } };
    const chat = normalizeChat(body, undefined, { ignoreSampling: true });
    expect(chat).not.toHaveProperty("temperature");
    expect(chat.max_tokens).toBeUndefined();
    expect(() => normalizeChat({ ...body, tools: [{ type: "function" }] }, undefined, { ignoreSampling: true })).toThrow(/tools/);
    expect(normalizeChat({ ...body, response_format: { type: "json_object" } }, undefined, { ignoreSampling: true }).format).toEqual({ type: "json" });
    expect(normalizeResponses({ model: "gpt-5.6-luna", input: "x", temperature: 1, max_output_tokens: 5 }, undefined, { ignoreSampling: true }).textMessages).toHaveLength(1);
    expect(() => normalizeChat(body)).toThrow(/temperature/);
  });
  it("maps ACP stop reasons to OpenAI completion semantics", () => {
    expect(mapStopReason("end_turn")).toEqual({ chat: "stop", responseStatus: "completed" });
    expect(mapStopReason("max_tokens")).toEqual({ chat: "length", responseStatus: "incomplete" });
    expect(mapStopReason("refusal")).toEqual({ chat: "content_filter", responseStatus: "incomplete" });
    expect(mapStopReason("cancelled")).toEqual({ chat: "stop", responseStatus: "incomplete" });
  });
});

describe("JSON output", () => {
  const schema = { type: "object", properties: { a: { type: "number" } }, required: ["a"] };
  const chatBody = { model: "gpt-5.6-sol", messages: [{ role: "user", content: "hi" }] };
  it("accepts response_format and text.format, and rejects bad shapes", () => {
    expect(normalizeChat(chatBody).format).toEqual({ type: "text" });
    expect(normalizeChat({ ...chatBody, response_format: { type: "text" } }).format).toEqual({ type: "text" });
    expect(normalizeChat({ ...chatBody, response_format: { type: "json_object" } }).format).toEqual({ type: "json" });
    expect(normalizeChat({ ...chatBody, response_format: { type: "json_schema", json_schema: { name: "out", schema, strict: true, description: "d" } } }).format).toEqual({ type: "json", name: "out", schema, description: "d" });
    expect(normalizeResponses({ model: "gpt-5.6-sol", input: "x", text: { format: { type: "json_schema", name: "out", schema } } }).format).toEqual({ type: "json", name: "out", schema });
    expect(normalizeResponses({ model: "gpt-5.6-sol", input: "x", text: { format: { type: "json_object" } } }).format).toEqual({ type: "json" });
    expect(() => normalizeChat({ ...chatBody, response_format: { type: "xml" } })).toThrow();
    expect(() => normalizeChat({ ...chatBody, response_format: { type: "json_schema" } })).toThrow();
    expect(() => normalizeResponses({ model: "gpt-5.6-sol", input: "x", text: { verbosity: "low" } })).toThrow();
    expect(() => normalizeChat({ ...chatBody, tools: [{ type: "function" }] })).toThrow(/tools/);
  });
  it("returns 400 with the offending param", async () => {
    const chat = await call("POST", "/v1/chat/completions", { ...chatBody, response_format: { type: "xml" } });
    expect(chat.status).toBe(400); expect(JSON.parse(chat.text).error).toMatchObject({ code: "invalid_request", param: "response_format" });
    const responses = await call("POST", "/v1/responses", { model: "gpt-5.6-sol", input: "x", text: { verbosity: "low" } });
    expect(responses.status).toBe(400); expect(JSON.parse(responses.text).error).toMatchObject({ code: "invalid_request", param: "text" });
    expect((await call("POST", "/v1/chat/completions", { ...chatBody, tools: [{ type: "function" }] })).status).toBe(400);
  });
  it("extracts JSON from fences and prose", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(extractJson('```\n[1,2]\n```')).toBe("[1,2]");
    expect(extractJson('Sure! Here it is:\n{"a":1}\nHope that helps.')).toBe('{"a":1}');
    expect(extractJson('  {"a":1}  ')).toBe('{"a":1}');
    expect(extractJson("Result: [1, 2, 3]")).toBe("[1, 2, 3]");
    expect(extractJson("  not json at all ")).toBe("not json at all");
    expect(extractJson("{broken")).toBe("{broken");
  });
  it("builds format instructions and the output format prompt block", () => {
    expect(formatInstructions({ type: "text" })).toBeUndefined();
    expect(formatInstructions({ type: "json" })).toMatch(/single valid JSON value/);
    const instructions = formatInstructions({ type: "json", name: "out", schema, description: "the output" })!;
    expect(instructions).toContain(JSON.stringify(schema)); expect(instructions).toContain("out"); expect(instructions).toContain("the output");
    const messages = [{ role: "user" as const, content: "hi" }];
    expect(serializePrompt(messages)).not.toContain("[output format]");
    expect(serializePrompt(messages, instructions).endsWith(`[output format]\n${instructions}`)).toBe(true);
  });
  describe("over HTTP", () => {
    const seen: Array<{ messages: unknown; instructions?: string; hasOnText: boolean }> = [];
    const jsonBridge: AcpLike = {
      async generate(_model, messages, callbacks, _signal, options) {
        seen.push({ messages, instructions: options?.instructions, hasOnText: !!callbacks?.onText });
        callbacks?.onText?.("```json\n{\"a\":");
        return { text: '```json\n{"a":1}\n```', stopReason: "end_turn", usage: null };
      },
    };
    const format = { type: "json_schema", json_schema: { name: "out", schema } };
    it("cleans chat output, streaming and not", async () => {
      seen.length = 0;
      const plain = await call("POST", "/v1/chat/completions", { ...chatBody, response_format: format }, jsonBridge);
      expect(plain.status).toBe(200); expect(JSON.parse(plain.text).choices[0].message.content).toBe('{"a":1}');
      expect(seen[0]!.instructions).toContain(JSON.stringify(schema));
      expect(seen[0]!.messages).toEqual([{ role: "user", content: "hi" }]);
      const stream = await call("POST", "/v1/chat/completions", { ...chatBody, stream: true, response_format: { type: "json_object" } }, jsonBridge);
      const contents = stream.text.split("\n").filter((line) => line.startsWith("data: {")).map((line) => JSON.parse(line.slice(6)).choices?.[0]?.delta?.content).filter((content) => content !== undefined);
      expect(contents).toEqual(['{"a":1}']); expect(seen[1]!.hasOnText).toBe(false);
    });
    it("cleans responses output, streaming and not", async () => {
      seen.length = 0;
      const plain = await call("POST", "/v1/responses", { model: "gpt-5.6-sol", input: "hi", text: { format: { type: "json_schema", name: "out", schema } } }, jsonBridge);
      expect(plain.status).toBe(200); expect(JSON.parse(plain.text).output[0].content[0].text).toBe('{"a":1}');
      expect(seen[0]!.instructions).toContain(JSON.stringify(schema));
      const stream = await call("POST", "/v1/responses", { model: "gpt-5.6-sol", input: "hi", stream: true, text: { format: { type: "json_object" } } }, jsonBridge);
      const events = stream.text.split("\n").filter((line) => line.startsWith("data: {")).map((line) => JSON.parse(line.slice(6)));
      expect(events.filter((e) => e.type === "response.output_text.delta").map((e) => e.delta)).toEqual(['{"a":1}']);
      expect(events.find((e) => e.type === "response.output_text.done").text).toBe('{"a":1}');
      expect(events.find((e) => e.type === "response.completed").response.output[0].content[0].text).toBe('{"a":1}');
    });
    it("keeps text format unchanged", async () => {
      seen.length = 0;
      const text = await call("POST", "/v1/chat/completions", { ...chatBody, response_format: { type: "text" } }, jsonBridge);
      expect(JSON.parse(text.text).choices[0].message.content).toBe('```json\n{"a":1}\n```');
      expect(seen[0]!.instructions).toBeUndefined();
    });
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
