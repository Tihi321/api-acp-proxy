import { afterAll, afterEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import OpenAI from "openai";
import { ActivityLog } from "../src/activity.js";
import type { ProxyConfig } from "../src/config.js";
import type { LocalModelCoordinator } from "../src/local-models.js";
import { createLogger } from "../src/logger.js";
import { LLAMA_PRESETS, type GufoProfile } from "../src/settings.js";
import { createLlamaRegistration, LocalOpenAiProvider } from "../src/providers/local-openai.js";
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
