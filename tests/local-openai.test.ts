import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import OpenAI from "openai";
import type { ProxyConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { LocalOpenAiProvider } from "../src/providers/local-openai.js";
import { ProviderRouter } from "../src/router.js";
import { createProxyServer } from "../src/server.js";

const config: ProxyConfig = { host: "127.0.0.1", port: 0, maxBodyBytes: 1024 * 1024, timeoutMs: 5000, workRoot: ".claude/temp/local-openai-tests", acpArgs: [] };
mkdirSync(path.resolve(config.workRoot), { recursive: true });
const logger = createLogger({ console: false });

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }))); });

async function listen(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}
async function serve(router: ProviderRouter): Promise<string> { return `http://127.0.0.1:${await listen(createProxyServer(config, router))}/v1`; }

describe("LocalOpenAiProvider", () => {
  it("streams a gufo/ model through the proxy with the upstream usage and lists only the prefixed id", async () => {
    const upstream = createServer((request, response) => {
      if (request.method === "GET" && request.url === "/v1/models") { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ data: [{ id: "Qwen3.8-27B" }] })); return; }
      if (request.method === "POST" && request.url === "/v1/chat/completions") {
        response.setHeader("content-type", "text/event-stream");
        const delta = (content: string) => ({ choices: [{ delta: { content } }] });
        for (const chunk of [delta("Hel"), delta("lo"), delta("!"), { choices: [{ delta: {}, finish_reason: "stop" }] }, { choices: [], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }]) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
        response.end("data: [DONE]\n\n"); return;
      }
      response.statusCode = 404; response.end();
    });
    const port = await listen(upstream);
    const router = new ProviderRouter({ providers: [new LocalOpenAiProvider({ id: "gufo", displayName: "Gufo", baseUrl: `http://127.0.0.1:${port}/v1`, logger })] });
    const client = new OpenAI({ baseURL: await serve(router), apiKey: "test" });

    const stream = await client.chat.completions.create({ model: "gufo/Qwen3.8-27B", messages: [{ role: "user", content: "hi" }], stream: true, stream_options: { include_usage: true } });
    let text = ""; let completionTokens: number | undefined;
    for await (const chunk of stream) { text += chunk.choices[0]?.delta?.content ?? ""; if (chunk.usage) completionTokens = chunk.usage.completion_tokens; }
    expect(text).toBe("Hello!");
    expect(completionTokens).toBe(3);

    const listed = (await client.models.list()).data.map((model) => model.id);
    expect(listed).toContain("gufo/Qwen3.8-27B");
    expect(listed).not.toContain("Qwen3.8-27B");
  });

  /** A fake upstream: GET /v1/models and a streaming POST /v1/chat/completions that `script` writes. */
  async function thinkingProxy(script: (response: import("node:http").ServerResponse) => Promise<void> | void, bodies: unknown[] = []): Promise<string> {
    const upstream = createServer((request, response) => {
      if (request.method === "GET" && request.url === "/v1/models") { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ data: [{ id: "Qwen3.8-27B" }] })); return; }
      if (request.method === "POST" && request.url === "/v1/chat/completions") {
        let raw = ""; request.on("data", (part) => { raw += part; });
        request.on("end", () => { bodies.push(JSON.parse(raw)); response.setHeader("content-type", "text/event-stream"); void Promise.resolve(script(response)); });
        return;
      }
      response.statusCode = 404; response.end();
    });
    const port = await listen(upstream);
    return await serve(new ProviderRouter({ providers: [new LocalOpenAiProvider({ id: "gufo", displayName: "Gufo", baseUrl: `http://127.0.0.1:${port}/v1`, logger })] }));
  }
  const sse = (response: import("node:http").ServerResponse, chunk: unknown) => response.write(`data:${JSON.stringify(chunk)}\r\n\r\n`);
  const thinkChunk = (reasoning_content: string) => ({ choices: [{ delta: { reasoning_content } }] });
  const askBody = { model: "gufo/Qwen3.8-27B", messages: [{ role: "user", content: "hi" }] };

  it("forwards upstream reasoning_content as separate chunks before the content, with the upstream usage", async () => {
    const base = await thinkingProxy((response) => {
      sse(response, thinkChunk("Let me ")); sse(response, thinkChunk("think.")); sse(response, { choices: [{ delta: { content: "Hi" } }] });
      sse(response, { choices: [{ delta: {}, finish_reason: "stop" }] });
      sse(response, { choices: [], usage: { prompt_tokens: 5, completion_tokens: 9, total_tokens: 14, completion_tokens_details: { reasoning_tokens: 7 } } });
      response.end("data: [DONE]\r\n\r\n");
    });
    const res = await fetch(`${base}/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...askBody, stream: true, stream_options: { include_usage: true } }) });
    const chunks = (await res.text()).split("\n").filter((line) => line.startsWith("data: {")).map((line) => JSON.parse(line.slice(6)) as { choices: Array<{ delta: { content?: string; reasoning_content?: string } }>; usage?: { completion_tokens: number; completion_tokens_details: { reasoning_tokens: number } } | null });
    const deltas = chunks.map((chunk) => chunk.choices[0]?.delta ?? {});
    expect(deltas.map((delta) => delta.reasoning_content ?? "").join("")).toBe("Let me think.");
    expect(deltas.map((delta) => delta.content ?? "").join("")).toBe("Hi");
    expect(deltas.some((delta) => delta.content !== undefined && delta.reasoning_content !== undefined)).toBe(false);
    expect(deltas.map((delta) => delta.reasoning_content !== undefined).lastIndexOf(true)).toBeLessThan(deltas.findIndex((delta) => delta.content !== undefined));
    const usage = chunks.at(-1)?.usage;
    expect(usage?.completion_tokens).toBe(9);
    expect(usage?.completion_tokens_details.reasoning_tokens).toBe(7);
  });

  it("returns message.reasoning_content when not streamed, counts it in the estimated usage and sends max_tokens upstream", async () => {
    const bodies: Array<{ max_tokens?: number }> = [];
    const base = await thinkingProxy((response) => {
      sse(response, thinkChunk("Let me ")); sse(response, thinkChunk("think.")); sse(response, { choices: [{ delta: { content: "Hi" } }] });
      sse(response, { choices: [{ delta: {}, finish_reason: "stop" }] });
      response.end("data: [DONE]\r\n\r\n");
    }, bodies);
    const res = await fetch(`${base}/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...askBody, stream: false, max_completion_tokens: 50 }) });
    const body = await res.json() as { choices: Array<{ message: { content: string; reasoning_content?: string } }>; usage: { completion_tokens: number; completion_tokens_details: { reasoning_tokens: number } } };
    expect(body.choices[0]?.message.reasoning_content).toBe("Let me think.");
    expect(body.choices[0]?.message.content).toBe("Hi");
    expect(body.usage.completion_tokens).toBe(4 + 1);
    expect(body.usage.completion_tokens_details.reasoning_tokens).toBe(4);
    expect(bodies[0]?.max_tokens).toBe(50);
  }, 5000);

  it("delivers a reasoning chunk to the client before the upstream has finished", async () => {
    let seen!: () => void; const clientSawReasoning = new Promise<void>((resolve) => { seen = resolve; });
    const base = await thinkingProxy(async (response) => {
      sse(response, thinkChunk("Hmm"));
      await clientSawReasoning;
      sse(response, { choices: [{ delta: { content: "Hi" } }] }); sse(response, { choices: [{ delta: {}, finish_reason: "stop" }] });
      response.end("data: [DONE]\r\n\r\n");
    });
    const res = await fetch(`${base}/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...askBody, stream: true }) });
    const reader = res.body!.getReader(); const decoder = new TextDecoder(); let text = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (text.includes("reasoning_content")) seen();
    }
    expect(text).toContain('"reasoning_content":"Hmm"');
    expect(text).toContain('"content":"Hi"');
  }, 5000);

  it("answers 503 local_server_not_running when the upstream port is closed", async () => {
    const probe = createServer();
    const port = await listen(probe);
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    servers.length = 0;
    const router = new ProviderRouter({ providers: [new LocalOpenAiProvider({ id: "strata", displayName: "Strata", baseUrl: `http://127.0.0.1:${port}/v1`, logger })] });
    const base = await serve(router);

    const res = await fetch(`${base}/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "strata/any", messages: [{ role: "user", content: "hi" }] }) });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: "local_server_not_running", message: "Strata is not running — start it from the app." } });
  });
});
