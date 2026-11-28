import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import OpenAI from "openai";
import { ActivityLog } from "../src/activity.js";
import type { ProxyConfig } from "../src/config.js";
import type { LocalModelCoordinator } from "../src/local-models.js";
import { createLogger } from "../src/logger.js";
import { LLAMA_PRESETS, type GufoProfile } from "../src/settings.js";
import { DeepSeekProvider, deepseekRegistration } from "../src/providers/deepseek.js";
import { createLlamaRegistration, LocalOpenAiProvider, ollamaBaseUrl, ollamaRegistration } from "../src/providers/local-openai.js";
import { ProviderRouter } from "../src/router.js";
import { createProxyServer } from "../src/server.js";
import { tempRoot } from "./helpers/temp-root.js";

const config: ProxyConfig = { host: "127.0.0.1", port: 0, maxBodyBytes: 1024 * 1024, timeoutMs: 5000, workRoot: tempRoot("local-openai"), acpArgs: [] };
afterAll(() => { rmSync(config.workRoot, { recursive: true, force: true }); });
const logger = createLogger({ console: false });

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }))); });

async function listen(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}
async function serve(router: ProviderRouter, activity?: ActivityLog): Promise<string> { return `http://127.0.0.1:${await listen(createProxyServer(config, router, activity ? { activity } : {}))}/v1`; }

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
  async function thinkingProxy(script: (response: import("node:http").ServerResponse) => Promise<void> | void, bodies: unknown[] = [], activity?: ActivityLog): Promise<string> {
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
    return await serve(new ProviderRouter({ providers: [new LocalOpenAiProvider({ id: "gufo", displayName: "Gufo", baseUrl: `http://127.0.0.1:${port}/v1`, logger })] }), activity);
  }
  const sse = (response: import("node:http").ServerResponse, chunk: unknown) => response.write(`data:${JSON.stringify(chunk)}\r\n\r\n`);
  const thinkChunk = (reasoning_content: string) => ({ choices: [{ delta: { reasoning_content } }] });
  const askBody = { model: "gufo/Qwen3.8-27B", messages: [{ role: "user", content: "hi" }] };

  it("forwards upstream reasoning_content as separate chunks before the content, with the upstream usage", async () => {
    const base = await thinkingProxy((response) => {
      sse(response, thinkChunk("Let me ")); sse(response, thinkChunk("think.")); sse(response, { choices: [{ delta: { content: "Hi" } }] });
      sse(response, { choices: [{ delta: {}, finish_reason: "stop" }] });
      sse(response, { choices: [], usage: { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 80 }, completion_tokens: 9, total_tokens: 109, completion_tokens_details: { reasoning_tokens: 7 } } });
      response.end("data: [DONE]\r\n\r\n");
    });
    const res = await fetch(`${base}/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...askBody, stream: true, stream_options: { include_usage: true } }) });
    const chunks = (await res.text()).split("\n").filter((line) => line.startsWith("data: {")).map((line) => JSON.parse(line.slice(6)) as { choices: Array<{ delta: { content?: string; reasoning_content?: string } }>; usage?: { prompt_tokens: number; prompt_tokens_details: { cached_tokens: number }; completion_tokens: number; completion_tokens_details: { reasoning_tokens: number } } | null });
    const deltas = chunks.map((chunk) => chunk.choices[0]?.delta ?? {});
    expect(deltas.map((delta) => delta.reasoning_content ?? "").join("")).toBe("Let me think.");
    expect(deltas.map((delta) => delta.content ?? "").join("")).toBe("Hi");
    expect(deltas.some((delta) => delta.content !== undefined && delta.reasoning_content !== undefined)).toBe(false);
    expect(deltas.map((delta) => delta.reasoning_content !== undefined).lastIndexOf(true)).toBeLessThan(deltas.findIndex((delta) => delta.content !== undefined));
    const usage = chunks.at(-1)?.usage;
    expect(usage?.completion_tokens).toBe(9);
    expect(usage?.completion_tokens_details.reasoning_tokens).toBe(7);
    expect(usage?.prompt_tokens).toBe(100);
    expect(usage?.prompt_tokens_details.cached_tokens).toBe(80);
    const oddBase = await thinkingProxy((response) => {
      sse(response, { choices: [{ delta: { content: "Hi" } }] });
      // Raw text: JSON.stringify would turn Infinity into null, but a real upstream can send 1e999, which JSON.parse reads as Infinity.
      response.write('data:{"choices":[],"usage":{"prompt_tokens":100,"prompt_tokens_details":{"cached_tokens":"80"},"completion_tokens":"9","total_tokens":"x","completion_tokens_details":{"reasoning_tokens":1e999}}}\r\n\r\n');
      response.end("data: [DONE]\r\n\r\n");
    });
    const oddRes = await fetch(`${oddBase}/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...askBody, stream: true, stream_options: { include_usage: true } }) });
    const oddUsage = (await oddRes.text()).split("\n").filter((line) => line.startsWith("data: {")).map((line) => JSON.parse(line.slice(6)) as { usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number; prompt_tokens_details: { cached_tokens: number }; completion_tokens_details?: { reasoning_tokens?: number } } | null }).at(-1)?.usage;
    expect(oddUsage?.prompt_tokens).toBe(100);
    expect(oddUsage?.prompt_tokens_details.cached_tokens).toBe(0);
    expect(oddUsage?.completion_tokens).toBe(0);
    expect(oddUsage?.total_tokens).toBe(100);
    expect(oddUsage?.completion_tokens_details?.reasoning_tokens).toBe(0);
  });

  it("estimates reasoning_tokens from the reasoning text when the local server reports none, and the activity entry says it is an estimate", async () => {
    const activity = new ActivityLog();
    const base = await thinkingProxy((response) => {
      sse(response, thinkChunk("Let me think.")); sse(response, { choices: [{ delta: { content: "Hi" } }] });
      sse(response, { choices: [{ delta: {}, finish_reason: "stop" }] });
      sse(response, { choices: [], usage: { prompt_tokens: 5, completion_tokens: 9, total_tokens: 14 } });
      response.end("data: [DONE]\r\n\r\n");
    }, [], activity);
    const res = await fetch(`${base}/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...askBody, stream: true, stream_options: { include_usage: true } }) });
    const chunks = (await res.text()).split("\n").filter((line) => line.startsWith("data: {")).map((line) => JSON.parse(line.slice(6)) as { usage?: { completion_tokens: number; completion_tokens_details: { reasoning_tokens: number } } | null });
    expect(chunks.at(-1)?.usage?.completion_tokens_details.reasoning_tokens).toBe(4);
    expect(chunks.at(-1)?.usage?.completion_tokens).toBe(9);
    for (let wait = 0; wait < 20 && activity.list().length === 0; wait++) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(activity.list()[0]).toMatchObject({ reasoningTokens: 4, reasoningEstimated: true });
    expect(activity.list()[0]).not.toHaveProperty("estimated");
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

  it.each([
    ["both set", { reasoning_effort: "none", chat_template_kwargs: { enable_thinking: false } }, { reasoning_effort: "none", chat_template_kwargs: { enable_thinking: false } }],
    ["neither set", {}, {}],
    ["wrong types are ignored", { reasoning_effort: 3, chat_template_kwargs: [1] }, {}],
  ])("forwards the thinking switch upstream: %s", async (_name, extra, expected) => {
    const bodies: Array<Record<string, unknown>> = [];
    const base = await thinkingProxy((response) => {
      sse(response, { choices: [{ delta: { content: "Hi" } }] });
      sse(response, { choices: [{ delta: {}, finish_reason: "stop" }] });
      response.end("data: [DONE]\r\n\r\n");
    }, bodies as Array<{ max_tokens?: number }>);
    const res = await fetch(`${base}/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...askBody, stream: false, ...extra }) });
    expect(res.status).toBe(200);
    expect(bodies[0]?.reasoning_effort).toEqual((expected as { reasoning_effort?: unknown }).reasoning_effort);
    expect(bodies[0]?.chat_template_kwargs).toEqual((expected as { chat_template_kwargs?: unknown }).chat_template_kwargs);
    expect("reasoning_effort" in (bodies[0] ?? {})).toBe("reasoning_effort" in expected);
    expect("chat_template_kwargs" in (bodies[0] ?? {})).toBe("chat_template_kwargs" in expected);
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

  it("serves ollama/<name>:<tag> from Ollama's /v1, passes reasoning_effort, and names Ollama in the not-running error", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const upstream = createServer((request, response) => {
      if (request.method === "GET" && request.url === "/v1/models") { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ object: "list", data: [{ id: "qwen3.8:latest" }, { id: "inkling-2-mini:latest" }] })); return; }
      if (request.method === "POST" && request.url === "/v1/chat/completions") {
        let raw = ""; request.on("data", (chunk) => { raw += String(chunk); });
        request.on("end", () => {
          seen.push(JSON.parse(raw) as Record<string, unknown>);
          response.setHeader("content-type", "text/event-stream");
          response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Hi" } }] })}\n\n`);
          response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
          response.end("data: [DONE]\n\n");
        });
        return;
      }
      if (request.method === "POST" && request.url === "/api/show") {
        let raw = ""; request.on("data", (chunk) => { raw += String(chunk); });
        request.on("end", () => { response.setHeader("content-type", "application/json"); response.end(JSON.stringify((JSON.parse(raw) as { model: string }).model === "qwen3.8:latest" ? { model_info: { "general.architecture": "qwen3", "qwen3.context_length": 64 } } : { model_info: {} })); });
        return;
      }
      response.statusCode = 404; response.end();
    });
    const port = await listen(upstream);
    expect(ollamaBaseUrl(`http://127.0.0.1:${port}/`)).toBe(`http://127.0.0.1:${port}/v1`);
    expect(ollamaBaseUrl(`http://127.0.0.1:${port}/v1`)).toBe(`http://127.0.0.1:${port}/v1`);
    const provider = ollamaRegistration.create({ providerSettings: { enabled: true, baseUrl: `http://127.0.0.1:${port}` } as never, ctx: { logger } as never } as never);
    const client = new OpenAI({ baseURL: await serve(new ProviderRouter({ providers: [provider] })), apiKey: "test" });
    expect((await client.models.list()).data.map((model) => model.id).sort()).toEqual(["ollama/inkling-2-mini:latest", "ollama/qwen3.8:latest"]);
    const answer = await client.chat.completions.create({ model: "ollama/qwen3.8:latest", messages: [{ role: "user", content: "hi" }], reasoning_effort: "low" });
    expect(answer.choices[0]?.message.content).toBe("Hi");
    expect(seen[0]).toMatchObject({ model: "qwen3.8:latest", reasoning_effort: "low", stream: true });

    // The prompt limit comes from /api/show: context_length 64 tokens -> 256 characters; a model without one has no limit.
    const base = await serve(new ProviderRouter({ providers: [provider] }));
    const listed = (await (await fetch(`${base}/models`)).json() as { data: Array<{ id: string; max_prompt_chars?: number }> }).data;
    expect(listed.find((model) => model.id === "ollama/qwen3.8:latest")?.max_prompt_chars).toBe(256);
    expect(listed.find((model) => model.id === "ollama/inkling-2-mini:latest")?.max_prompt_chars).toBeUndefined();
    const ask = (url: string) => fetch(`${url}/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "ollama/qwen3.8:latest", stream: true, messages: [{ role: "user", content: "x".repeat(300) }] }) });
    const sent = seen.length;
    const refused = await ask(base);
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: { code: "context_length_exceeded", message: expect.stringMatching(/^The prompt is too long for Ollama: /) } });
    expect(seen.length).toBe(sent);
    const unlimited = ollamaRegistration.create({ providerSettings: { enabled: true, baseUrl: `http://127.0.0.1:${port}`, maxPromptChars: 0 } as never, ctx: { logger } as never } as never);
    const open = await serve(new ProviderRouter({ providers: [unlimited] }));
    await fetch(`${open}/models`);
    const allowed = await ask(open);
    expect(allowed.status).toBe(200);
    await allowed.text(); // the stream headers go out before the upstream is called (the model load comes first), so wait for the end
    expect(seen.length).toBe(sent + 1);

    const probe = createServer();
    const closed = await listen(probe);
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const down = await fetch(`${await serve(new ProviderRouter({ providers: [new LocalOpenAiProvider({ id: "ollama", displayName: "Ollama", baseUrl: ollamaBaseUrl(`http://127.0.0.1:${closed}`), logger })] }))}/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "ollama/qwen3.8:latest", messages: [{ role: "user", content: "hi" }] }) });
    expect(down.status).toBe(503);
    expect(await down.json()).toMatchObject({ error: { code: "local_server_not_running", message: expect.stringContaining("Ollama is not running or not reachable") } });
  });

  it("passes a forwarded output limit through: upstream text, length stop and usage win", async () => {
    const bodies: Array<{ max_tokens?: number }> = [];
    const capture = createLogger({ console: false });
    const long = "word ".repeat(40); // 200 chars, far over max_tokens 2 * 4
    const upstream = createServer((request, response) => {
      if (request.method === "GET" && request.url === "/v1/models") { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ data: [{ id: "m:latest", max_output_tokens: 50 }, { id: "n:latest" }] })); return; }
      let raw = ""; request.on("data", (part) => { raw += part; });
      request.on("end", () => {
        bodies.push(JSON.parse(raw) as { max_tokens?: number });
        response.setHeader("content-type", "text/event-stream");
        for (const chunk of [{ choices: [{ delta: { content: long } }] }, { choices: [{ delta: {}, finish_reason: "length" }] }, { choices: [], usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 } }]) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
        response.end("data: [DONE]\n\n");
      });
    });
    const port = await listen(upstream);
    const base = await serve(new ProviderRouter({ providers: [new LocalOpenAiProvider({ id: "ollama", displayName: "Ollama", baseUrl: `http://127.0.0.1:${port}/v1`, logger: capture })] }));
    const res = await fetch(`${base}/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "ollama/m:latest", stream: true, max_tokens: 2, stream_options: { include_usage: true }, messages: [{ role: "user", content: "hi" }] }) });
    const chunks = (await res.text()).split("\n").filter((line) => line.startsWith("data: {")).map((line) => JSON.parse(line.slice(6)) as { choices: Array<{ delta: { content?: string }; finish_reason: string | null }>; usage?: { completion_tokens: number } | null });
    expect(bodies[0]?.max_tokens).toBe(2);
    expect(chunks.map((chunk) => chunk.choices[0]?.delta?.content ?? "").join("")).toBe(long);
    expect(chunks.find((chunk) => chunk.choices[0]?.finish_reason)?.choices[0]?.finish_reason).toBe("length");
    expect(chunks.at(-1)?.usage?.completion_tokens).toBe(2);

    // The model list's max_output_tokens caps a bigger request (one info line); a model without one is unchanged.
    const askFor = (model: string, max: number) => fetch(`${base}/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, max_tokens: max, messages: [{ role: "user", content: "hi" }] }) });
    await fetch(`${base}/models`);
    expect((await askFor("ollama/m:latest", 80)).status).toBe(200);
    expect((await askFor("ollama/n:latest", 80)).status).toBe(200);
    expect(bodies.map((body) => body.max_tokens)).toEqual([2, 50, 80]);
    expect(capture.recent().filter((entry) => entry.level === "info" && entry.message.includes("output limit")).map((entry) => entry.message)).toEqual(["max_tokens 80 is over m:latest's output limit of 50; sent 50."]);
  });

  it("limits an Ollama prompt by the default context the proxy's own load measured, loads the model first and sends the key on native calls", async () => {
    // `context`: what /api/ps reports while loaded; `/api/generate` (the proxy's load at default options) loads at `defaultCtx`.
    let loaded = false; let context = 32; let defaultCtx = 32; let psCalls = 0; let chatCalls = 0; const loadBodies: string[] = []; const nativeAuth = new Set<string | undefined>();
    const upstream = createServer((request, response) => {
      let raw = ""; request.on("data", (part) => { raw += part; });
      request.on("end", () => {
        response.setHeader("content-type", "application/json");
        if (request.url?.startsWith("/api/")) nativeAuth.add(request.headers.authorization);
        if (request.url === "/v1/models") { response.end(JSON.stringify({ data: [{ id: "qwen3.8:latest" }] })); return; }
        if (request.url === "/api/ps") { psCalls++; response.end(JSON.stringify({ models: loaded ? [{ name: "qwen3.8:latest", model: "qwen3.8:latest", context_length: context }] : [] })); return; }
        if (request.method === "POST" && request.url === "/api/generate") { loadBodies.push(raw); loaded = true; context = defaultCtx; response.end(JSON.stringify({ model: "qwen3.8:latest", done: true })); return; }
        if (request.method === "POST" && request.url === "/v1/chat/completions") {
          chatCalls++;
          response.setHeader("content-type", "text/event-stream");
          response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Hi" } }] })}\n\n`);
          response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
          response.end("data: [DONE]\n\n"); return;
        }
        response.statusCode = 404; response.end();
      });
    });
    const port = await listen(upstream);
    const capture = createLogger({ console: false });
    const provider = ollamaRegistration.create({ providerSettings: { enabled: true, baseUrl: `http://127.0.0.1:${port}`, apiKey: "k" } as never, ctx: { logger: capture } as never } as never);
    const base = await serve(new ProviderRouter({ providers: [provider] }));
    await fetch(`${base}/models`);
    const ask = (chars: number, stream: boolean) => fetch(`${base}/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "ollama/qwen3.8:latest", stream, messages: [{ role: "user", content: "x".repeat(chars) }] }) });
    const limitListed = async () => (await (await fetch(`${base}/models`)).json() as { data: Array<{ id: string; max_prompt_chars?: number }> }).data.find((model) => model.id === "ollama/qwen3.8:latest")?.max_prompt_chars;

    // Not loaded: one load (the model only, no prompt, no keep_alive, with the key), then the prompt is checked against 32 tokens x 3 = 96 characters.
    const refused = await ask(200, false);
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: { code: "context_length_exceeded", message: expect.stringMatching(/^The prompt is too long for Ollama: 200 characters, the limit is 96\..*a context of 32 tokens.*num_ctx/) } });
    expect(loadBodies).toEqual(['{"model":"qwen3.8:latest"}']);
    expect(psCalls).toBeGreaterThanOrEqual(2);
    expect(chatCalls).toBe(0);
    expect(capture.recent().some((entry) => entry.level === "info" && entry.message.startsWith("loading 'qwen3.8:latest' before the first request"))).toBe(true);

    // Measured and still loaded: the check after prepare makes a stream request a real HTTP 400 (not SSE) and loads nothing; a prompt within the limit goes through.
    const streamed = await ask(200, true);
    expect(streamed.status).toBe(400);
    expect(streamed.headers.get("content-type")).toContain("application/json");
    expect(await streamed.json()).toMatchObject({ error: { code: "context_length_exceeded" } });
    expect(loadBodies).toHaveLength(1);
    expect(chatCalls).toBe(0);
    const psBefore = psCalls;
    expect((await ask(80, false)).status).toBe(200);
    expect(chatCalls).toBe(1);
    expect(loadBodies).toHaveLength(1);
    await vi.waitFor(() => expect(psCalls).toBe(psBefore + 2)); // prepare's read and the read after the chat
    expect(await limitListed()).toBe(96);

    // Another client loads the model with a bigger num_ctx: the proxy's own /v1 request would run at the default, so the limit stays 96.
    context = 1000;
    expect((await ask(200, true)).status).toBe(400);
    expect(await limitListed()).toBe(96);

    // Ollama restarted with a bigger default and the model is unloaded: prepare forgets the old value, the load measures 200 tokens again (600 characters).
    loaded = false; defaultCtx = 200;
    const bigger = await ask(500, false);
    expect(bigger.status).toBe(200);
    expect(loadBodies).toHaveLength(2);
    expect(chatCalls).toBe(2);

    // Unloaded and restarted smaller: the stream has started when the load-first step refuses, so the refusal is an SSE error.
    await vi.waitFor(async () => expect(await limitListed()).toBe(600));
    loaded = false; defaultCtx = 32;
    const late = await ask(200, true);
    expect(late.status).toBe(200);
    expect(await late.text()).toContain('"code":"context_length_exceeded"');
    expect(loadBodies).toHaveLength(3);
    expect(chatCalls).toBe(2);
    expect([...nativeAuth]).toEqual(["Bearer k"]);
  });

  const profile = (id: string, kind: "llm" | "image", vision = false, extra: Partial<GufoProfile> = {}): GufoProfile => ({ id, label: id, model: id, kind, vision, args: "", ...extra });
  const profiles = [{ ...profile("qwen27-q4", "llm"), model: "Qwen3.8-27B" }, profile("flash-next-q4", "llm", true), profile("deepseek4", "llm"), profile("qwen-image-2.1", "image"), profile("qwen-image-2.1-turbo", "image")];
  const image = { type: "image" as const, mimeType: "image/png", data: "QUJD" };
  const withImage = [{ role: "user" as const, parts: [{ type: "text" as const, text: "what is this?" }, image] }];
  const abort = new AbortController().signal;

  /** A Gufo provider over a fake upstream that records chat and image bodies; the coordinator counts acquires. */
  async function gufo(handler?: (request: IncomingMessage, response: ServerResponse, body: string) => void): Promise<{ provider: LocalOpenAiProvider; router: ProviderRouter; bodies: string[]; acquired: string[] }> {
    const bodies: string[] = []; const acquired: string[] = [];
    const upstream = createServer((request, response) => {
      let raw = ""; request.on("data", (part) => { raw += part; });
      request.on("end", () => {
        if (request.method === "GET") { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ data: [] })); return; }
        bodies.push(raw);
        if (handler) { handler(request, response, raw); return; }
        response.setHeader("content-type", "text/event-stream");
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })}\n\n`); response.end("data: [DONE]\n\n");
      });
    });
    const port = await listen(upstream);
    const coordinator = { acquire: async (id: string) => { acquired.push(id); return { release: () => undefined }; } } as unknown as LocalModelCoordinator;
    const provider = new LocalOpenAiProvider({ id: "gufo", displayName: "Gufo", baseUrl: `http://127.0.0.1:${port}/v1`, logger, profiles, coordinator });
    return { provider, router: new ProviderRouter({ providers: [provider] }), bodies, acquired };
  }

  it("sends image parts to a vision profile only, refuses them elsewhere before any switch, and lists every profile with kind and vision", async () => {
    const { router, bodies, acquired } = await gufo();
    const lease = await router.prepareModel("gufo/flash-next-q4", withImage, abort);
    expect(acquired).toEqual(["gufo:flash-next-q4"]);
    lease?.release();
    await router.generate("gufo/flash-next-q4", withImage);
    expect(JSON.parse(bodies[0]!).messages[0].content).toEqual([{ type: "text", text: "what is this?" }, { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } }]);
    await router.generate("gufo/deepseek4", [{ role: "user", parts: [{ type: "text", text: "hi" }] }]);
    expect(JSON.parse(bodies[1]!).messages[0].content).toBe("hi");

    expect(router.acceptsImages("gufo/flash-next-q4")).toBe(true);
    expect(router.acceptsImages("gufo/deepseek4")).toBe(false);
    await expect(router.prepareModel("gufo/deepseek4", withImage, abort)).rejects.toMatchObject({ status: 400, code: "unsupported_content" });
    const strata = new LocalOpenAiProvider({ id: "strata", displayName: "Strata", baseUrl: "http://127.0.0.1:1/v1", logger });
    await expect(new ProviderRouter({ providers: [strata] }).prepareModel("strata/x", withImage, abort)).rejects.toMatchObject({ status: 400, code: "unsupported_content" });
    expect(acquired).toEqual(["gufo:flash-next-q4"]);

    // Listed while the upstream is down too: the profiles, not the server, decide.
    const down = createServer(); const port = await listen(down); await new Promise<void>((resolve) => down.close(() => resolve()));
    const offline = new ProviderRouter({ providers: [new LocalOpenAiProvider({ id: "gufo", displayName: "Gufo", baseUrl: `http://127.0.0.1:${port}/v1`, logger, profiles })] });
    const listed = await offline.listModels({ waitMs: 2000 });
    expect(listed.map((model) => [model.id, model.kind, model.vision])).toEqual([["gufo/Qwen3.8-27B", "llm", false], ["gufo/flash-next-q4", "llm", true], ["gufo/deepseek4", "llm", false], ["gufo/qwen-image-2.1", "image", false], ["gufo/qwen-image-2.1-turbo", "image", false]]);
  });

  it("takes vision for a provider without profiles from /v1/models input_modalities: image parts forwarded, else 400", async () => {
    const bodies: string[] = []; let modalities: string[] = ["text", "image"];
    const upstream = createServer((request, response) => {
      if (request.method === "GET" && request.url === "/v1/models") { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ data: [{ id: "qwen-flash", architecture: { input_modalities: modalities } }] })); return; }
      let body = ""; request.on("data", (data) => { body += data; });
      request.on("end", () => { bodies.push(body); response.setHeader("content-type", "text/event-stream"); response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`); });
    });
    const port = await listen(upstream);
    const strata = new LocalOpenAiProvider({ id: "strata", displayName: "Strata", baseUrl: `http://127.0.0.1:${port}/v1`, logger });
    const router = new ProviderRouter({ providers: [strata] });
    // A provider that has never listed (right after a proxy start): the image check reads the list again instead of refusing.
    const fresh = new LocalOpenAiProvider({ id: "strata", displayName: "Strata", baseUrl: `http://127.0.0.1:${port}/v1`, logger });
    const freshRouter = new ProviderRouter({ providers: [fresh] });
    await freshRouter.prepareModel("strata/qwen-flash", withImage, abort);
    await freshRouter.generate("strata/qwen-flash", withImage);
    expect(JSON.parse(bodies.at(-1)!).messages[0].content).toEqual([{ type: "text", text: "what is this?" }, { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } }]);
    bodies.length = 0;
    await strata.listModels();
    await router.prepareModel("strata/qwen-flash", withImage, abort);
    await router.generate("strata/qwen-flash", withImage);
    expect(JSON.parse(bodies[0]!).messages[0].content).toEqual([{ type: "text", text: "what is this?" }, { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } }]);
    modalities = ["text"]; await strata.listModels();
    await expect(router.prepareModel("strata/qwen-flash", withImage, abort)).rejects.toMatchObject({ status: 400, code: "unsupported_content" });

    // With a coordinator: a refusal after the lease (text-only list, never listed before) releases the lease once.
    const released: string[] = [];
    const coordinator = { acquire: async (id: string) => ({ release: () => { released.push(id); } }) } as unknown as LocalModelCoordinator;
    const leased = new LocalOpenAiProvider({ id: "strata", displayName: "Strata", baseUrl: `http://127.0.0.1:${port}/v1`, logger, coordinator, leaseProfile: "strata" });
    await expect(new ProviderRouter({ providers: [leased] }).prepareModel("strata/qwen-flash", withImage, abort)).rejects.toMatchObject({ status: 400, code: "unsupported_content" });
    expect(released).toEqual(["strata"]);
  });

  it("registers llama with its profiles: listed while stopped, leased as llama:<id>, upstream gets the model, no image to a non-vision profile", async () => {
    const acquired: string[] = []; const bodies: string[] = [];
    const coordinator = { acquire: async (id: string) => { acquired.push(id); return { release: () => undefined }; } } as unknown as LocalModelCoordinator;
    const noVision = { ...structuredClone(LLAMA_PRESETS[1]!), id: "text-only", model: "text-only", vision: false, mmprojFile: undefined };
    const make = (port: number) => createLlamaRegistration({ coordinator }).create({ providerSettings: { port, profiles: [LLAMA_PRESETS[0], LLAMA_PRESETS[1], noVision] }, ctx: { logger } } as never) as LocalOpenAiProvider;
    const down = createServer(); const closedPort = await listen(down); await new Promise<void>((resolve) => down.close(() => resolve()));
    const offline = await new ProviderRouter({ providers: [make(closedPort)] }).listModels({ waitMs: 2000 });
    expect(offline.map((model) => [model.id, model.vision])).toEqual([["llama/inkling-2-mini", true], ["llama/inkling-2-mini-dspark", true], ["llama/text-only", false]]);

    const upstream = createServer((request, response) => {
      let raw = ""; request.on("data", (part) => { raw += part; });
      request.on("end", () => { bodies.push(raw); response.setHeader("content-type", "text/event-stream"); response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })}

data: [DONE]

`); });
    });
    const router = new ProviderRouter({ providers: [make(await listen(upstream))] });
    const lease = await router.prepareModel("llama/inkling-2-mini", [{ role: "user", parts: [{ type: "text", text: "hi" }] }], abort);
    lease?.release();
    await router.generate("llama/inkling-2-mini", [{ role: "user", parts: [{ type: "text", text: "hi" }] }]);
    expect(acquired).toEqual(["llama:inkling-2-mini"]);
    expect(JSON.parse(bodies[0]!).model).toBe("inkling-2-mini");
    await expect(router.prepareModel("llama/text-only", withImage, abort)).rejects.toMatchObject({ status: 400, code: "unsupported_content" });
    expect(acquired).toEqual(["llama:inkling-2-mini"]);
  });

  it("answers 400 model_not_capable for chat to an image profile and for images from an llm profile, before any switch", async () => {
    const { router, acquired } = await gufo();
    await expect(router.prepareModel("gufo/qwen-image-2.1", [{ role: "user", parts: [{ type: "text", text: "hi" }] }], abort)).rejects.toMatchObject({ status: 400, code: "model_not_capable" });
    await expect(router.prepareModel("gufo/deepseek4", undefined, abort)).rejects.toMatchObject({ status: 400, code: "model_not_capable" });
    expect(router.canGenerateImages("gufo/deepseek4")).toBe(false);
    expect(router.canGenerateImages("gufo/qwen-image-2.1")).toBe(true);
    expect(router.imagePassthrough("gufo/qwen-image-2.1")).toBe(true);
    await expect(router.generateImage("gufo/deepseek4", { kind: "generations", fields: { prompt: "a cat" } }, abort)).rejects.toMatchObject({ status: 400, code: "model_not_capable" });
    expect(acquired).toEqual([]);
  });

  it("forwards generations fields exactly with the profile model, wraps the result as png, and relays an upstream 400", async () => {
    let status = 200;
    const { router, bodies } = await gufo((_request, response) => {
      response.statusCode = status; response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(status === 200 ? { data: [{ b64_json: "AAAA" }] } : { error: { message: "steps must be between 1 and 8" } }));
    });
    const fields = { model: "gufo/qwen-image-2.1-turbo", prompt: "a cat", size: "1024x768", steps: 4, seed: 7, negative_prompt: "blur", guidance_scale: 1.5, ignored: "x" };
    const result = await router.generateImage("gufo/qwen-image-2.1-turbo", { kind: "generations", fields }, abort);
    expect(JSON.parse(bodies[0]!)).toEqual({ model: "qwen-image-2.1-turbo", prompt: "a cat", size: "1024x768", steps: 4, seed: 7, negative_prompt: "blur", guidance_scale: 1.5 });
    expect(result.body).toMatchObject({ data: [{ b64_json: "AAAA" }], output_format: "png", created: expect.any(Number) });
    expect(router.requestTimeoutMs("gufo/qwen-image-2.1-turbo")).toBe(15 * 60 * 1000);
    await expect(router.generateImage("gufo/qwen-image-2.1", { kind: "generations", fields: { prompt: "x", response_format: "url" } }, abort)).rejects.toMatchObject({ status: 400 });
    status = 400;
    await expect(router.generateImage("gufo/qwen-image-2.1", { kind: "generations", fields: { prompt: "x", steps: 99 } }, abort)).rejects.toMatchObject({ status: 400, code: "invalid_request", message: "steps must be between 1 and 8" });
    status = 401;
    await expect(router.generateImage("gufo/qwen-image-2.1", { kind: "generations", fields: { prompt: "x" } }, abort)).rejects.toMatchObject({ status: 502, code: "local_upstream_auth", message: expect.stringContaining("API key") });
    status = 404;
    await expect(router.generateImage("gufo/qwen-image-2.1", { kind: "generations", fields: { prompt: "x" } }, abort)).rejects.toMatchObject({ status: 502, code: "upstream_error" });
  });
});

describe("DeepSeek", () => {
  interface Fake { models: unknown[]; chatCalls: number; otherCalls: number; chatBodies: Array<Record<string, unknown>>; auth: Array<string | undefined>; balance: { is_available: boolean }; modelsStatus?: number; chat: (response: ServerResponse) => void }
  const sseOk = (response: ServerResponse): void => {
    response.setHeader("content-type", "text/event-stream");
    const usage = { prompt_tokens: 20, completion_tokens: 9, total_tokens: 29, prompt_cache_hit_tokens: 12, prompt_cache_miss_tokens: 8, completion_tokens_details: { reasoning_tokens: 5 } };
    for (const chunk of [{ choices: [{ delta: { reasoning_content: "Think. " } }] }, { choices: [{ delta: { content: "Hi" } }] }, { choices: [{ delta: {}, finish_reason: "stop" }], usage }]) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
    response.end("data: [DONE]\n\n");
  };
  const reply = (status: number, error: unknown, headers: Record<string, string> = {}) => (response: ServerResponse): void => { response.statusCode = status; response.setHeader("content-type", "application/json"); for (const [name, value] of Object.entries(headers)) response.setHeader(name, value); response.end(JSON.stringify({ error })); };

  /** A fake DeepSeek on 127.0.0.1 (no /v1 in its paths) behind a DeepSeek provider built by the registration. */
  async function setup(settings: Record<string, unknown> = { apiKey: "sk-test" }, now?: () => number) {
    const fake: Fake = { models: [{ id: "deepseek-flash" }, { id: "deepseek-v4-pro" }], chatCalls: 0, otherCalls: 0, chatBodies: [], auth: [], balance: { is_available: true }, chat: sseOk };
    const upstream = createServer((request, response) => {
      fake.auth.push(request.headers.authorization);
      if (request.method === "GET" && request.url === "/models") { fake.otherCalls++; if (fake.modelsStatus) { response.statusCode = fake.modelsStatus; response.end(); return; } response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ object: "list", data: fake.models })); return; }
      if (request.method === "GET" && request.url === "/user/balance") { fake.otherCalls++; response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ ...fake.balance, balance_infos: [{ currency: "USD", total_balance: fake.balance.is_available ? "110.00" : "0.00" }] })); return; }
      if (request.method === "POST" && request.url === "/chat/completions") {
        let raw = ""; request.on("data", (part) => { raw += part; });
        request.on("end", () => { fake.chatCalls++; fake.chatBodies.push(JSON.parse(raw) as Record<string, unknown>); fake.chat(response); });
        return;
      }
      response.statusCode = 404; response.end();
    });
    const port = await listen(upstream);
    const provider = now ? new DeepSeekProvider({ baseUrl: `http://127.0.0.1:${port}`, apiKey: "sk-test", logger, now }) : deepseekRegistration.create({ providerSettings: { enabled: true, baseUrl: `http://127.0.0.1:${port}/v1/`, ...settings } as never, ctx: { logger } as never } as never);
    const router = new ProviderRouter({ providers: [provider] });
    const activity = new ActivityLog();
    return { fake, router, provider, base: await serve(router, activity), activity };
  }
  const ask = (base: string, extra: Record<string, unknown> = {}, content = "hi") => fetch(`${base}/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "deepseek/deepseek-flash", messages: [{ role: "user", content }], ...extra }) });

  it("serves deepseek/ models with the upstream usage, cache hits and reasoning", async () => {
    const { fake, base, activity } = await setup();
    const client = new OpenAI({ baseURL: base, apiKey: "test" });
    expect((await client.models.list()).data.map((model) => model.id)).toEqual(["deepseek/deepseek-flash", "deepseek/deepseek-v4-pro"]);

    const whole = await client.chat.completions.create({ model: "deepseek/deepseek-flash", messages: [{ role: "user", content: "hi" }], max_tokens: 50, reasoning_effort: "low", chat_template_kwargs: { enable_thinking: false } } as never) as OpenAI.Chat.ChatCompletion;
    expect((whole.choices[0]?.message as { reasoning_content?: string }).reasoning_content).toBe("Think. ");
    expect(whole.usage).toMatchObject({ prompt_tokens: 20, completion_tokens: 9, prompt_tokens_details: { cached_tokens: 12 }, completion_tokens_details: { reasoning_tokens: 5 } });
    const stream = await client.chat.completions.create({ model: "deepseek/deepseek-flash", messages: [{ role: "user", content: "hi" }], stream: true, stream_options: { include_usage: true } });
    let reasoning = ""; let usage: OpenAI.CompletionUsage | undefined;
    for await (const chunk of stream) { reasoning += (chunk.choices[0]?.delta as { reasoning_content?: string } | undefined)?.reasoning_content ?? ""; if (chunk.usage) usage = chunk.usage; }
    expect(reasoning).toBe("Think. ");
    expect(usage).toMatchObject({ prompt_tokens: 20, completion_tokens: 9, prompt_tokens_details: { cached_tokens: 12 }, completion_tokens_details: { reasoning_tokens: 5 } });

    expect(fake.auth.every((header) => header === "Bearer sk-test")).toBe(true);
    expect(fake.chatBodies[0]).toMatchObject({ model: "deepseek-flash", max_tokens: 50, reasoning_effort: "low", stream: true });
    expect(fake.chatBodies[0]).not.toHaveProperty("chat_template_kwargs");
    for (let wait = 0; wait < 20 && activity.list().filter((entry) => entry.provider === "deepseek").length < 2; wait++) await new Promise((resolve) => setTimeout(resolve, 50));
    const chats = activity.list().filter((entry) => entry.provider === "deepseek");
    expect(chats).toHaveLength(2);
    for (const entry of chats) { expect(entry).toMatchObject({ inputTokens: 20, outputTokens: 9, cachedTokens: 12, reasoningTokens: 5 }); expect(entry).not.toHaveProperty("estimated"); }

    // Cost at a fixed peak time (Tuesday 02:00 UTC), thinking forwarded as {type} only, and the max_tokens clamp from /models (flash: 1000) or the 393216 default (pro).
    const priced = await setup({ apiKey: "sk-test" }, () => Date.UTC(2026, 11, 1, 2, 0, 0));
    priced.fake.models = [{ id: "deepseek-flash", max_output_tokens: 1000 }, { id: "deepseek-v4-pro" }];
    priced.fake.chat = (response) => {
      response.setHeader("content-type", "text/event-stream");
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Hi" } }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1000, prompt_cache_hit_tokens: 400, completion_tokens: 200, total_tokens: 1200 } })}\n\n`);
      response.end("data: [DONE]\n\n");
    };
    await fetch(`${priced.base}/models`);
    expect((await ask(priced.base, { max_tokens: 500000, thinking: { type: "disabled", budget_tokens: 5 } })).status).toBe(200);
    expect(priced.fake.chatBodies[0]).toMatchObject({ max_tokens: 1000, thinking: { type: "disabled" } });
    expect(priced.fake.chatBodies[0]?.thinking).toEqual({ type: "disabled" });
    for (let wait = 0; wait < 20 && priced.activity.list().length < 1; wait++) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(priced.activity.list()[0]?.costUsd).toBeCloseTo((400 * 0.006 + 600 * 0.3 + 200 * 1.2) / 1e6, 10);
    expect((await ask(priced.base, { model: "deepseek/deepseek-v4-pro", max_tokens: 500000 })).status).toBe(200);
    expect(priced.fake.chatBodies[1]).toMatchObject({ model: "deepseek-v4-pro", max_tokens: 393216 });
    expect(priced.fake.chatBodies[1]).not.toHaveProperty("thinking");
  });

  it("maps 402 to the usage-limit 429 and 429 to a transient rate limit", async () => {
    const out = await setup();
    out.fake.chat = reply(402, { message: "Insufficient Balance" });
    await fetch(`${out.base}/models`); // lists (and probes: available) before the 402
    const first = await ask(out.base);
    expect(first.status).toBe(429);
    expect(first.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(await first.json()).toMatchObject({ error: { code: "usage_limit_exceeded" } });
    const health = await (await fetch(`${out.base.replace(/\/v1$/, "")}/healthz`)).json() as { providers: Record<string, { exhausted_until?: string }> };
    expect(health.providers.deepseek?.exhausted_until).toEqual(expect.any(String));
    expect((await ask(out.base)).status).toBe(429);
    expect(out.fake.chatCalls).toBe(1);
    // A models refresh within 60 s (the cached list, availability set by the 402) neither clears the mark nor moves its end.
    const until = out.router.exhaustedProviders().deepseek;
    await fetch(`${out.base}/models`);
    expect(out.router.exhaustedProviders().deepseek).toBe(until);

    const rate = await setup();
    rate.fake.chat = reply(429, { message: "Rate limit reached" }, { "retry-after": "7" });
    const limited = await ask(rate.base);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("7");
    expect(await limited.json()).toMatchObject({ error: { code: "rate_limit_exceeded", message: expect.stringContaining("Rate limit reached") } });
    expect((await ask(rate.base)).status).toBe(429);
    expect(rate.fake.chatCalls).toBe(2);
    expect(rate.router.exhaustedProviders()).toEqual({});
  });

  it("needs a key, maps 401 to provider_auth_required and a context 400 to context_length_exceeded", async () => {
    const keyless = await setup({});
    expect(keyless.provider.status()).toMatchObject({ state: "needs_login", error: expect.stringContaining("API key missing or rejected") });
    const missing = await ask(keyless.base);
    expect(missing.status).toBe(503);
    expect(await missing.json()).toMatchObject({ error: { code: "provider_auth_required" } });
    expect(keyless.fake.chatCalls + keyless.fake.otherCalls).toBe(0);

    const keyed = await setup();
    keyed.fake.chat = reply(401, { message: "Authentication Fails" });
    const rejected = await ask(keyed.base);
    expect(rejected.status).toBe(503);
    expect(await rejected.json()).toMatchObject({ error: { code: "provider_auth_required" } });
    expect(keyed.provider.status().state).toBe("needs_login");

    // A rejected key on /models keeps the static models listed; a stream error keeps its typed code; the legacy id routes (503, not 404).
    const denied = await setup();
    denied.fake.modelsStatus = 401; denied.fake.chat = reply(401, { message: "Authentication Fails" });
    expect((await (await fetch(`${denied.base}/models`)).json() as { data: Array<{ id: string }> }).data.map((model) => model.id)).toEqual(["deepseek/deepseek-flash", "deepseek/deepseek-v4-pro"]);
    expect(denied.provider.status().state).toBe("needs_login");
    const streamed = await (await ask(denied.base, { stream: true })).text();
    expect(streamed).toContain('"code":"provider_auth_required"');
    expect(streamed).not.toContain("internal_error");
    // List first so the router knows the static ids; only then does the acceptsModel hook decide the legacy id (503) versus an unknown one (404).
    await fetch(`${keyless.base}/models`);
    const chatWith = (model: string) => fetch(`${keyless.base}/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }) });
    const legacy = await chatWith("deepseek/deepseek-v4-flash");
    expect(legacy.status).toBe(503);
    expect(await legacy.json()).toMatchObject({ error: { code: "provider_auth_required" } });
    const unknown = await chatWith("deepseek/not-a-model");
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ error: { code: "model_not_found" } });
    keyed.fake.chat = reply(400, { message: "This model's maximum context length is 1048576 tokens." });
    const tooLong = await ask(keyed.base);
    expect(tooLong.status).toBe(400);
    expect(await tooLong.json()).toMatchObject({ error: { code: "context_length_exceeded", message: expect.stringMatching(/^The prompt is too long for DeepSeek: /) } });

    // The proxy's own check: the default limit is listed, and a lower setting refuses before any upstream chat call (also for a stream).
    const listed = (await (await fetch(`${keyed.base}/models`)).json() as { data: Array<{ id: string; max_prompt_chars?: number }> }).data;
    expect(listed.find((model) => model.id === "deepseek/deepseek-flash")?.max_prompt_chars).toBe(4_194_304);
    const small = await setup({ apiKey: "sk-test", maxPromptChars: 100 });
    for (const extra of [{}, { stream: true }]) {
      const refused = await ask(small.base, extra, "x".repeat(200));
      expect(refused.status).toBe(400);
      expect(await refused.json()).toMatchObject({ error: { code: "context_length_exceeded", message: expect.stringMatching(/^The prompt is too long for DeepSeek: 200 characters, the limit is 100/) } });
    }
    expect(small.fake.chatCalls).toBe(0);

    // A bad thinking value is a 400 on the proxy side (param thinking), never sent upstream.
    const before = keyed.fake.chatCalls;
    for (const thinking of [{ type: "on" }, "enabled"]) {
      const bad = await ask(keyed.base, { thinking });
      expect(bad.status).toBe(400);
      expect(await bad.json()).toMatchObject({ error: { code: "invalid_request", param: "thinking" } });
    }
    expect(keyed.fake.chatCalls).toBe(before);
  });

  it("reads the balance on refresh: unavailable marks exhausted, available clears it", async () => {
    const { fake, router, provider } = await setup();
    fake.balance = { is_available: false };
    await router.refresh("deepseek");
    expect(Object.keys(router.exhaustedProviders())).toEqual(["deepseek"]);
    expect(provider.status()).toMatchObject({ balance: "0.00 USD" });
    fake.balance = { is_available: true };
    await router.refresh("deepseek");
    expect(router.exhaustedProviders()).toEqual({});
    expect(provider.status()).toMatchObject({ balance: "110.00 USD" });
  });
});
