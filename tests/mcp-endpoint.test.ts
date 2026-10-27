import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import fsp from "node:fs/promises";
import { request as httpRequest, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { AcpUnavailableError, type AcpLike, type ModelEntry } from "../src/acp.js";
import { ActivityLog } from "../src/activity.js";
import { ApiError, imageGenerationText, type Message } from "../src/api.js";
import type { ProxyConfig } from "../src/config.js";
import { isLoopbackAddress } from "../src/mcp-endpoint.js";
import type { GenerateOptions, GenerationResult, Provider } from "../src/provider.js";
import { ProviderRouter } from "../src/router.js";
import { createProxyServer } from "../src/server.js";
import { ToolBridgeHub } from "../src/tool-bridge.js";

const root = path.resolve(".claude/temp/mcp-endpoint-tests", String(process.pid));
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const png = Buffer.from(PNG_B64, "base64");
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("JFIF-test-image-bytes")]);
const JPEG_B64 = jpeg.toString("base64");
const big = (bytes: number) => Buffer.concat([png, Buffer.alloc(bytes - png.length, 7)]);
const MB = 1024 * 1024;

interface Call { model: string; messages: Message[]; signal?: AbortSignal; options?: GenerateOptions; }
type Bridge = AcpLike & { calls: Call[] };
interface FakeOptions {
  /** `id`s with their provider. */
  models?: Array<{ id: string; provider: string }>;
  /** `null` leaves the method out. */
  acceptsImages?: ((id: string) => boolean | undefined) | null;
  canGenerateImages?: ((id: string) => boolean) | null;
  canSearchWeb?: ((id: string) => boolean) | null;
  generate?: (call: Call) => Promise<GenerationResult> | GenerationResult;
}

const MODELS = [
  { id: "codex/gpt-6-luna", provider: "codex" },
  { id: "gpt-6-luna", provider: "codex" },
  { id: "claude/haiku", provider: "claude" },
  { id: "antigravity/gemini-3.8-flash-low", provider: "antigravity" },
];
const answer = (text: string): GenerationResult => ({ text, stopReason: "end_turn", usage: null });
const drawn = (data = PNG_B64, mimeType = "image/png", revisedPrompt?: string): GenerationResult => ({ text: "", stopReason: "end_turn", usage: null, images: [{ mimeType, data, ...(revisedPrompt ? { revisedPrompt } : {}) }] });
const providerOfId = (list: Array<{ id: string; provider: string }>, id: string) => list.find((entry) => entry.id === id)?.provider;

function fake(options: FakeOptions = {}): Bridge {
  const models = options.models ?? MODELS;
  const calls: Call[] = [];
  const bridge: Bridge = {
    calls,
    generate: async (model, messages, _callbacks, signal, generateOptions) => {
      const call: Call = { model, messages, ...(signal ? { signal } : {}), ...(generateOptions ? { options: generateOptions } : {}) };
      calls.push(call);
      return options.generate ? await options.generate(call) : answer("an answer");
    },
    listModels: async () => models.map((entry) => ({ id: entry.id, ownedBy: "x", provider: entry.provider }) as ModelEntry),
    hasModel: (id) => models.some((entry) => entry.id === id),
    providerOf: (id) => providerOfId(models, id),
  };
  if (options.acceptsImages !== null) bridge.acceptsImages = options.acceptsImages ?? (() => true);
  if (options.canGenerateImages !== null) bridge.canGenerateImages = options.canGenerateImages ?? ((id) => ["codex", "antigravity"].includes(providerOfId(models, id) ?? ""));
  if (options.canSearchWeb !== null) bridge.canSearchWeb = options.canSearchWeb ?? ((id) => ["codex", "claude"].includes(providerOfId(models, id) ?? ""));
  return bridge;
}

let counter = 0;
const servers: Server[] = [];
interface Env { base: string; dir: string; imageDir: string; activity: ActivityLog; hub: ToolBridgeHub; port: number; }
interface StartOptions {
  config?: Partial<ProxyConfig>;
  isLocalCaller?: (request: IncomingMessage) => boolean;
  fetch?: typeof fetch;
  mcpImageDir?: string;
  mcp?: { keepaliveMs?: number; threadIdleMs?: number; maxStoreImageBytes?: number; now?: () => number };
}

async function start(bridge: AcpLike, options: StartOptions = {}): Promise<Env> {
  const dir = path.join(root, `t${++counter}`);
  mkdirSync(dir, { recursive: true });
  const imageDir = options.mcpImageDir ?? path.join(dir, "mcp-images");
  const activity = new ActivityLog();
  const hub = new ToolBridgeHub();
  const config: ProxyConfig = { host: "127.0.0.1", port: 0, maxBodyBytes: 20 * MB, timeoutMs: 20_000, workRoot: dir, acpArgs: [], ...options.config };
  const server = createProxyServer(config, bridge, { toolBridge: hub, activity, mcpImageDir: imageDir, ...(options.isLocalCaller ? { isLocalCaller: options.isLocalCaller } : {}), ...(options.fetch ? { fetch: options.fetch } : {}), ...(options.mcp ? { mcp: options.mcp } : {}) });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}`, dir, imageDir, activity, hub, port };
}

interface Rpc { status: number; headers: Headers; raw: string; events: any[]; keepalives: number; json?: any; result?: any; error?: any; }

function parse(status: number, headers: Headers, raw: string): Rpc {
  const rpc: Rpc = { status, headers, raw, events: [], keepalives: 0 };
  if ((headers.get("content-type") ?? "").includes("text/event-stream")) {
    for (const block of raw.split("\n\n")) {
      if (block.startsWith(":")) rpc.keepalives++;
      const data = block.split("\n").filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("\n");
      if (data) rpc.events.push(JSON.parse(data));
    }
    const final = rpc.events.find((event) => event.id !== undefined);
    rpc.result = final?.result;
    rpc.error = final?.error;
    rpc.json = final;
  } else {
    try { rpc.json = JSON.parse(raw); } catch { rpc.json = undefined; }
    rpc.result = rpc.json?.result;
    rpc.error = rpc.json?.error;
  }
  return rpc;
}

async function post(env: Env, body: unknown, headers: Record<string, string> = {}): Promise<Rpc> {
  const response = await fetch(`${env.base}/v1/mcp`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return parse(response.status, response.headers, await response.text());
}

let nextId = 1;
const call = (env: Env, name: string, args: unknown, extra: { meta?: unknown; headers?: Record<string, string> } = {}) =>
  post(env, { jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args, ...(extra.meta ? { _meta: extra.meta } : {}) } }, extra.headers);
const ask = (env: Env, args: Record<string, unknown>) => call(env, "ask_model", { model: "codex/gpt-6-luna", prompt: "hello", ...args });
const draw = (env: Env, args: Record<string, unknown> = {}) => call(env, "generate_image", { model: "codex/gpt-6-luna", prompt: "a fox", ...args });
const textOf = (result: any): string => (result?.content ?? []).filter((block: any) => block.type === "text").map((block: any) => block.text).join("\n");
const imageBlocks = (result: any): any[] => (result?.content ?? []).filter((block: any) => block.type === "image");
const dataImage = (bytes: Buffer = png, mime = "image/png") => ({ data: bytes.toString("base64"), mime_type: mime });
const waitFor = async (condition: () => boolean, ms = 3000): Promise<void> => { const end = Date.now() + ms; while (!condition()) { if (Date.now() > end) throw new Error("timed out waiting"); await new Promise((resolve) => setTimeout(resolve, 10)); } };
const filesIn = (dir: string): string[] => existsSync(dir) ? readdirSync(dir) : [];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A POST with headers `fetch` will not let a test set (Host). */
function rawPost(env: Env, headers: Record<string, string>, body: unknown): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: "127.0.0.1", port: env.port, path: "/v1/mcp", method: "POST", headers: { "content-type": "application/json", ...headers } }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("error", reject);
    request.end(JSON.stringify(body));
  });
}

beforeEach(() => { mkdirSync(root, { recursive: true }); });
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); })));
});
afterAll(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } });

describe("protocol", () => {
  it("initialize echoes a supported protocol version, falls back for an unknown one, and tells the harness about list_models", async () => {
    const env = await start(fake());
    for (const version of ["2025-06-18", "2025-03-26", "2024-11-05"]) {
      const reply = await post(env, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: version, capabilities: {}, clientInfo: { name: "t", version: "1" } } });
      expect(reply.status).toBe(200);
      expect(reply.result.protocolVersion).toBe(version);
      expect(reply.result.capabilities).toEqual({ tools: {} });
      expect(reply.result.serverInfo.name).toBe("acp-proxy");
      expect(reply.result.serverInfo.version).toMatch(/^\d+\.\d+\.\d+/);
      expect(reply.result.instructions).toContain("list_models");
      expect(reply.result.instructions).toContain("images: [{ path }]");
    }
    expect((await post(env, { jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } })).result.protocolVersion).toBe("2025-06-18");
    expect((await post(env, { jsonrpc: "2.0", id: 3, method: "initialize" })).result.protocolVersion).toBe("2025-06-18");
  });

  it("tools/list lists the three tools with input and output schemas and annotations", async () => {
    const env = await start(fake());
    const reply = await post(env, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const tools = reply.result.tools as any[];
    expect(tools.map((tool) => tool.name)).toEqual(["list_models", "ask_model", "generate_image"]);
    for (const tool of tools) { expect(tool.inputSchema.type).toBe("object"); expect(tool.outputSchema.type).toBe("object"); expect(typeof tool.description).toBe("string"); }
    const [list, askTool, generate] = tools;
    expect(list.annotations).toEqual({ readOnlyHint: true });
    expect(askTool.annotations).toEqual({ readOnlyHint: true });
    expect(generate.annotations).toEqual({ readOnlyHint: false, destructiveHint: false });
    expect(askTool.inputSchema.required).toEqual(["model", "prompt"]);
    expect(Object.keys(askTool.inputSchema.properties)).toEqual(["model", "prompt", "system", "thread_id", "web_search", "images"]);
    expect(askTool.inputSchema.properties.images.maxItems).toBe(8);
    expect(Object.keys(generate.inputSchema.properties)).toEqual(["model", "prompt", "images", "size", "save_to", "file_name", "return_image"]);
    expect(generate.inputSchema.properties.images.maxItems).toBe(4);
    expect(askTool.description).toContain("generate_image");
    expect(askTool.description).toContain("read-only");
  });

  it("answers ping, batches and notifications, and rejects the rest", async () => {
    const env = await start(fake());
    expect((await post(env, { jsonrpc: "2.0", id: 1, method: "ping" })).result).toEqual({});
    const batch = await post(env, [{ jsonrpc: "2.0", id: 1, method: "ping" }, { jsonrpc: "2.0", method: "notifications/initialized" }, { jsonrpc: "2.0", id: 2, method: "tools/list" }, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "ask_model" } }]);
    expect(Array.isArray(batch.json)).toBe(true);
    expect(batch.json).toHaveLength(3);
    expect(batch.json[2].error.code).toBe(-32600);
    const note = await post(env, { jsonrpc: "2.0", method: "notifications/initialized" });
    expect(note.status).toBe(202);
    expect(note.raw).toBe("");
    expect((await post(env, { jsonrpc: "2.0", id: 1, method: "resources/list" })).error.code).toBe(-32601);
    expect((await call(env, "nope", {})).error.code).toBe(-32602);
    const garbled = await fetch(`${env.base}/v1/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{nope" });
    expect(garbled.status).toBe(400);
    expect((await garbled.json() as any).error.code).toBe(-32700);
  });

  it("is stateless: GET and DELETE are 405 and no session id is issued", async () => {
    const env = await start(fake());
    for (const method of ["GET", "DELETE"]) {
      const response = await fetch(`${env.base}/v1/mcp`, { method });
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("POST");
    }
    const init = await post(env, { jsonrpc: "2.0", id: 1, method: "ping" });
    expect(init.headers.get("mcp-session-id")).toBeNull();
  });

  it("leaves the tool bridge at /mcp/<token> as it was", async () => {
    const env = await start(fake());
    const session = env.hub.create([{ name: "lookup" }]);
    const reply = await fetch(session.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) });
    expect(reply.status).toBe(200);
    expect(((await reply.json()) as any).result.serverInfo.name).toBe("client");
    const unknown = await fetch(`${env.base}/mcp/nope`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(unknown.status).toBe(404);
    session.dispose();
  });
});

describe("list_models", () => {
  it("lists each model once under its prefixed id and notes the alias", async () => {
    const env = await start(fake());
    const reply = await call(env, "list_models", {});
    expect(reply.status).toBe(200);
    expect(reply.headers.get("content-type")).toContain("application/json");
    const models = reply.result.structuredContent.models as any[];
    expect(models.map((model) => model.id)).toEqual(["codex/gpt-6-luna", "claude/haiku", "antigravity/gemini-3.8-flash-low"]);
    expect(models[0].aliases).toEqual(["gpt-6-luna"]);
    expect(models[1].aliases).toEqual([]);
    expect(models[0].provider).toBe("codex");
    const text = textOf(reply.result);
    expect(text.split("\n")).toHaveLength(3);
    expect(text).toContain("codex/gpt-6-luna (codex) — images in, image generation, web search");
    expect(text).toContain("gpt-6-luna");
    expect(text.match(/gpt-6-luna \(/g)).toHaveLength(1);
  });

  it("reports capabilities: drawing, search, and image input as true, false or null", async () => {
    const env = await start(fake({ acceptsImages: (id) => id.startsWith("codex") ? true : id.startsWith("claude") ? false : undefined }));
    const models = (await call(env, "list_models", {})).result.structuredContent.models as any[];
    const by = Object.fromEntries(models.map((model) => [model.id, model.capabilities]));
    expect(by["codex/gpt-6-luna"]).toEqual({ image_input: true, image_generation: true, web_search: true });
    expect(by["claude/haiku"]).toEqual({ image_input: false, image_generation: false, web_search: true });
    expect(by["antigravity/gemini-3.8-flash-low"]).toEqual({ image_input: null, image_generation: true, web_search: false });
    expect(textOf((await call(env, "list_models", {})).result)).toContain("images in: not known until the provider starts");
    const without = await start(fake({ acceptsImages: null, canGenerateImages: null, canSearchWeb: null }));
    const none = (await call(without, "list_models", {})).result.structuredContent.models as any[];
    expect(none.every((model) => model.capabilities.image_input === null && model.capabilities.image_generation === false && model.capabilities.web_search === false)).toBe(true);
  });
  it("works against the real router: provider ids, one entry per model, aliases and capabilities", async () => {
    const provider: Provider = {
      id: "codex", displayName: "Codex", ownedBy: "openai", exposeUnprefixed: true, staticModels: [{ id: "gpt-6-luna" }], imageGeneration: true, webSearchSupport: true,
      generate: async () => answer("from the router"), listModels: async () => [{ id: "gpt-6-luna" }],
      status: () => ({ id: "codex", name: "Codex", state: "ready", authMethods: [], models: [], capabilities: { image: true } }),
      login: async () => undefined, onStatus: () => () => undefined, close: async () => undefined,
    };
    const env = await start(new ProviderRouter({ providers: [provider] }));
    const models = (await call(env, "list_models", {})).result.structuredContent.models;
    expect(models).toEqual([{ id: "codex/gpt-6-luna", provider: "codex", aliases: ["gpt-6-luna"], capabilities: { image_input: true, image_generation: true, web_search: true } }]);
    expect((await ask(env, { model: "gpt-6-luna" })).result.structuredContent.answer).toBe("from the router");
    expect(env.activity.list()[0]).toMatchObject({ model: "gpt-6-luna", provider: "codex" });
  });
});

describe("ask_model (text)", () => {
  it("returns the answer, a thread id and usage; the result arrives as SSE after keepalives, with progress when asked", async () => {
    const bridge = fake({ generate: async () => { await sleep(150); return answer("forty-two"); } });
    const env = await start(bridge, { mcp: { keepaliveMs: 30 } });
    const reply = await ask(env, { prompt: "what is the answer?" });
    expect(reply.status).toBe(200);
    expect(reply.headers.get("content-type")).toContain("text/event-stream");
    expect(reply.raw.startsWith(": keepalive\n\n")).toBe(true);
    expect(reply.keepalives).toBeGreaterThan(2);
    expect(reply.result.isError).toBeUndefined();
    expect(reply.result.content[0]).toEqual({ type: "text", text: "forty-two" });
    const sc = reply.result.structuredContent;
    expect(sc.answer).toBe("forty-two");
    expect(sc.model).toBe("codex/gpt-6-luna");
    expect(sc.thread_id).toMatch(/^thr_[0-9a-f]{24}$/);
    expect(sc.finish_reason).toBe("stop");
    expect(sc.usage.input_tokens).toBeGreaterThan(0);
    expect(sc.usage.output_tokens).toBeGreaterThan(0);
    expect(reply.result.content[1].text).toContain(sc.thread_id);
    expect(bridge.calls).toHaveLength(1);
    expect(bridge.calls[0]!.messages).toEqual([{ role: "user", parts: [{ type: "text", text: "what is the answer?" }] }]);

    const progress = await call(env, "ask_model", { model: "codex/gpt-6-luna", prompt: "again" }, { meta: { progressToken: "tok-1" } });
    const notes = progress.events.filter((event) => event.method === "notifications/progress");
    expect(notes.length).toBeGreaterThan(1);
    expect(notes.every((event) => event.params.progressToken === "tok-1")).toBe(true);
    expect(notes.map((event) => event.params.progress)).toEqual(notes.map((_, index) => index + 1));
  });

  it("sends the whole history on a follow-up, and refuses another model, an unknown thread and an expired thread", async () => {
    const clock = { t: 1_000_000 };
    const bridge = fake({ generate: (c) => answer(`reply ${c.messages.length}`) });
    const env = await start(bridge, { mcp: { now: () => clock.t } });
    const first = await ask(env, { prompt: "one", system: "be brief" });
    const threadId = first.result.structuredContent.thread_id;
    expect(bridge.calls[0]!.messages.map((message) => message.role)).toEqual(["system", "user"]);
    const second = await ask(env, { prompt: "two", thread_id: threadId, system: "ignored" });
    expect(second.result.structuredContent.thread_id).toBe(threadId);
    expect(bridge.calls[1]!.messages.map((message) => message.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(bridge.calls[1]!.messages.map((message) => message.parts[0]).map((part: any) => part.text)).toEqual(["be brief", "one", "reply 2", "two"]);

    const other = await ask(env, { prompt: "x", thread_id: threadId, model: "claude/haiku" });
    expect(other.result.isError).toBe(true);
    expect(textOf(other.result)).toMatch(/^thread_model_mismatch:/);
    const unknown = await ask(env, { prompt: "x", thread_id: "thr_nope" });
    expect(unknown.result.isError).toBe(true);
    expect(textOf(unknown.result)).toMatch(/^thread_not_found:.*start a new conversation/);
    clock.t += 61 * 60 * 1000;
    const expired = await ask(env, { prompt: "x", thread_id: threadId });
    expect(textOf(expired.result)).toMatch(/^thread_not_found:/);
    expect(bridge.calls).toHaveLength(2);
  });

  it("keeps 32 threads and drops the least recently used one for the 33rd", async () => {
    const bridge = fake();
    const env = await start(bridge);
    const ids: string[] = [];
    for (let index = 0; index < 32; index++) ids.push((await ask(env, { prompt: `t${index}` })).result.structuredContent.thread_id);
    expect((await ask(env, { prompt: "touch", thread_id: ids[0] })).result.isError).toBeUndefined();
    const newest = (await ask(env, { prompt: "33rd" })).result.structuredContent.thread_id;
    expect(newest).toBeTruthy();
    expect(textOf((await ask(env, { prompt: "x", thread_id: ids[1] })).result)).toMatch(/^thread_not_found:/);
    expect((await ask(env, { prompt: "x", thread_id: ids[0] })).result.isError).toBeUndefined();
    expect((await ask(env, { prompt: "x", thread_id: ids[2] })).result.isError).toBeUndefined();
  });

  it("answers an unknown model with the ids that contain the text", async () => {
    const bridge = fake();
    const env = await start(bridge);
    const reply = await ask(env, { model: "luna" });
    expect(reply.result.isError).toBe(true);
    expect(textOf(reply.result)).toMatch(/^model_not_found:/);
    expect(textOf(reply.result)).toContain("codex/gpt-6-luna");
    expect(textOf(reply.result)).not.toContain("claude/haiku");
    expect(textOf((await ask(env, { model: "zzz" })).result)).toContain("list_models");
    expect(bridge.calls).toHaveLength(0);
  });

  it("turns a provider that needs login into a tool error with its message", async () => {
    const env = await start(fake({ generate: () => { throw new AcpUnavailableError("Codex needs login: press Log in in the ACP Proxy app", undefined, "provider_auth_required"); } }));
    const reply = await ask(env, {});
    expect(reply.result.isError).toBe(true);
    expect(textOf(reply.result)).toBe("provider_auth_required: Codex needs login: press Log in in the ACP Proxy app");
    expect(reply.error).toBeUndefined();
  });

  it("passes web search on only to a model that can search", async () => {
    const bridge = fake();
    const env = await start(bridge);
    const refused = await ask(env, { model: "antigravity/gemini-3.8-flash-low", web_search: true });
    expect(textOf(refused.result)).toMatch(/^model_not_capable:/);
    expect(bridge.calls).toHaveLength(0);
    const accepted = await ask(env, { web_search: true });
    expect(accepted.result.isError).toBeUndefined();
    expect(bridge.calls[0]!.options).toEqual({ webSearch: {} });
  });

  it("never asks for generated images from ask_model", async () => {
    const bridge = fake();
    const env = await start(bridge);
    await ask(env, { images: [dataImage()] });
    await ask(env, { web_search: true });
    await ask(env, {});
    for (const recorded of bridge.calls) expect(recorded.options?.images).toBeUndefined();
  });

  it("rejects bad argument shapes with -32602", async () => {
    const env = await start(fake());
    const cases: unknown[] = [{ prompt: "x" }, { model: "codex/gpt-6-luna" }, { model: 5, prompt: "x" }, { model: "m", prompt: "" }, { model: "m", prompt: "x", web_search: "yes" }, { model: "m", prompt: "x", images: "no" }, { model: "m", prompt: "x", system: 1 }, "text"];
    for (const args of cases) { const reply = await call(env, "ask_model", args); expect(reply.error?.code).toBe(-32602); expect(reply.headers.get("content-type")).toContain("application/json"); }
  });
});

describe("ask_model (images)", () => {
  it("passes a { data, mime_type } PNG after the prompt text, and logs the images feature", async () => {
    const bridge = fake();
    const env = await start(bridge);
    const reply = await ask(env, { prompt: "what is in this?", images: [dataImage()] });
    expect(reply.result.isError).toBeUndefined();
    expect(bridge.calls[0]!.messages).toEqual([{ role: "user", parts: [{ type: "text", text: "what is in this?" }, { type: "image", mimeType: "image/png", data: PNG_B64 }] }]);
    expect(env.activity.list()[0]!.features).toEqual(["images"]);
  });

  it("downloads a url with the injected fetch, and accepts a data: URL", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => { urls.push(url); return new Response(png, { headers: { "content-type": "image/png" } }); }) as unknown as typeof fetch;
    const bridge = fake();
    const env = await start(bridge, { fetch: fetchImpl });
    const reply = await ask(env, { images: [{ url: "https://example.test/a.png" }, { url: `data:image/jpeg;base64,${JPEG_B64}` }] });
    expect(reply.result.isError).toBeUndefined();
    expect(urls).toEqual(["https://example.test/a.png"]);
    const parts = bridge.calls[0]!.messages[0]!.parts;
    expect(parts.map((part) => part.type === "image" ? part.mimeType : "text")).toEqual(["text", "image/png", "image/jpeg"]);
    expect((parts[1] as any).data).toBe(PNG_B64);
    expect((parts[2] as any).data).toBe(JPEG_B64);
  });

  it("reads a PNG by path for a local caller", async () => {
    const bridge = fake();
    const env = await start(bridge);
    const file = path.join(env.dir, "shot.png");
    writeFileSync(file, png);
    const reply = await ask(env, { images: [{ path: file }, { path: file.replaceAll("\\", "/") }] });
    expect(reply.result.isError).toBeUndefined();
    const parts = bridge.calls[0]!.messages[0]!.parts;
    expect(parts).toHaveLength(3);
    expect(parts[1]).toEqual({ type: "image", mimeType: "image/png", data: PNG_B64 });
    expect(parts[2]).toEqual(parts[1]);
  });

  it("keeps mixed images in order, and rejects nine images, two sources and data without mime_type", async () => {
    const bridge = fake();
    const env = await start(bridge);
    const file = path.join(env.dir, "a.png");
    writeFileSync(file, png);
    await ask(env, { images: [dataImage(jpeg, "image/jpeg"), { path: file }, dataImage()] });
    expect(bridge.calls[0]!.messages[0]!.parts.map((part) => part.type === "image" ? part.mimeType : "text")).toEqual(["text", "image/jpeg", "image/png", "image/png"]);
    const bad: unknown[] = [Array(9).fill(dataImage()), [{ path: file, url: "https://example.test/x.png" }], [{ data: PNG_B64 }], [{}], [{ path: file, mime_type: "image/png" }], ["x"], [{ data: PNG_B64, mime_type: "image/png;base64,AAAA" }]];
    for (const images of bad) { const reply = await ask(env, { images }); expect(reply.error?.code).toBe(-32602); }
    expect(bridge.calls).toHaveLength(1);
  });

  it("refuses a declared type that the bytes do not match, bad base64 and a file over 10 MB", async () => {
    const bridge = fake();
    const env = await start(bridge);
    const mismatch = await ask(env, { images: [{ data: JPEG_B64, mime_type: "image/png" }] });
    expect(textOf(mismatch.result)).toMatch(/^unsupported_content:/);
    const base64 = await ask(env, { images: [{ data: "!!not base64!!", mime_type: "image/png" }] });
    expect(textOf(base64.result)).toMatch(/^invalid_image_url:/);
    const file = path.join(env.dir, "huge.png");
    writeFileSync(file, big(10 * MB + 1));
    const huge = await ask(env, { images: [{ path: file }] });
    expect(textOf(huge.result)).toMatch(/^invalid_image_path:.*10 MB/);
    expect(bridge.calls).toHaveLength(0);
  });

  it("replays the first turn's image on a follow-up, caps a thread at 16 images, and drops the least recently used thread over the store cap", async () => {
    const bridge = fake();
    const env = await start(bridge, { mcp: { maxStoreImageBytes: 100 } });
    const first = await ask(env, { prompt: "look", images: [dataImage()] });
    const threadId = first.result.structuredContent.thread_id;
    await ask(env, { prompt: "and now?", thread_id: threadId });
    const replay = bridge.calls[1]!.messages;
    expect(replay.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    expect((replay[0]!.parts[1] as any).data).toBe(PNG_B64);
    // The store cap (100 bytes here): a second thread with an image pushes the first one out.
    const second = await ask(env, { prompt: "look too", images: [dataImage()] });
    expect(second.result.isError).toBeUndefined();
    expect(textOf((await ask(env, { prompt: "x", thread_id: threadId })).result)).toMatch(/^thread_not_found:/);
    expect((await ask(env, { prompt: "x", thread_id: second.result.structuredContent.thread_id })).result.isError).toBeUndefined();

    const bridge2 = fake();
    const env2 = await start(bridge2);
    const eight = Array(8).fill(dataImage());
    const t = (await ask(env2, { images: eight })).result.structuredContent.thread_id;
    expect((await ask(env2, { thread_id: t, images: eight })).result.isError).toBeUndefined();
    const over = await ask(env2, { thread_id: t, images: [dataImage()] });
    expect(textOf(over.result)).toMatch(/^thread_too_large:.*start a new conversation/);
    expect(bridge2.calls).toHaveLength(2);
    expect((await ask(env2, { thread_id: t })).result.isError).toBeUndefined();
  });

  it("refuses images for a model that does not accept them, and passes the provider's own refusal on", async () => {
    const no = fake({ acceptsImages: () => false });
    const env = await start(no);
    const refused = await ask(env, { images: [dataImage()] });
    expect(textOf(refused.result)).toMatch(/^model_not_capable:.*does not accept images/);
    expect(no.calls).toHaveLength(0);
    expect((await ask(env, {})).result.isError).toBeUndefined();

    const unknown = fake({ acceptsImages: null, generate: () => { throw new ApiError(400, "unsupported_content", "Claude does not accept image input.", "messages"); } });
    const env2 = await start(unknown);
    const reply = await ask(env2, { images: [dataImage()] });
    expect(reply.result.isError).toBe(true);
    expect(textOf(reply.result)).toBe("unsupported_content: Claude does not accept image input.");
    expect(unknown.calls).toHaveLength(1);
  });
});

describe("path security", () => {
  it("refuses paths from a remote caller without touching the file system", async () => {
    const bridge = fake();
    const env = await start(bridge, { isLocalCaller: () => false });
    const file = path.join(env.dir, "shot.png");
    writeFileSync(file, png);
    const spies = (["realpath", "stat", "open", "readFile", "mkdir", "writeFile"] as const).map((name) => vi.spyOn(fsp, name));
    const reply = await ask(env, { images: [{ path: file }] });
    expect(textOf(reply.result)).toMatch(/^path_not_allowed:.*data or url/);
    const save = await draw(env, { save_to: env.dir });
    expect(textOf(save.result)).toMatch(/^path_not_allowed:/);
    const refs = await draw(env, { images: [{ path: file }] });
    expect(textOf(refs.result)).toMatch(/^path_not_allowed:/);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(bridge.calls).toHaveLength(0);
    // data and url still work for a remote caller
    expect((await ask(env, { images: [dataImage()] })).result.isError).toBeUndefined();
  });

  it("refuses relative, UNC and device paths before any file system call", async () => {
    const bridge = fake();
    const env = await start(bridge);
    const spies = (["realpath", "stat", "open", "lstat", "readFile"] as const).map((name) => vi.spyOn(fsp, name));
    for (const bad of ["shot.png", "./shot.png", "..\\shot.png", "\\\\server\\share\\x.png", "//server/share/x.png", "\\\\?\\C:\\x.png", "\\\\.\\pipe\\x", "//./pipe/x", "\\x.png", "C:x.png", "C:\\x.png:stream", ""]) {
      const reply = await ask(env, { images: [{ path: bad }] });
      if (bad === "") { expect(reply.error?.code).toBe(-32602); continue; }
      expect(textOf(reply.result), bad).toMatch(/^path_not_allowed:/);
      expect(textOf(reply.result)).not.toContain("server");
      const save = await draw(env, { save_to: bad });
      expect(textOf(save.result), bad).toMatch(/^path_not_allowed:/);
    }
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(bridge.calls).toHaveLength(0);
  });

  it("fails a directory, a missing file and a text file named .png with a generic message that never quotes content", async () => {
    const env = await start(fake());
    const secret = path.join(env.dir, "secret.png");
    writeFileSync(secret, "TOPSECRET-API-KEY=abc123\n");
    const folder = path.join(env.dir, "folder.png");
    mkdirSync(folder, { recursive: true });
    const missing = path.join(env.dir, "missing.png");
    for (const file of [secret, folder, missing]) {
      const reply = await ask(env, { images: [{ path: file }] });
      expect(textOf(reply.result)).toMatch(/^invalid_image_path:/);
      expect(reply.raw).not.toContain("TOPSECRET");
      expect(reply.raw).not.toContain("abc123");
      expect(reply.raw).not.toContain(file.replaceAll("\\", "\\\\"));
    }
    expect(textOf((await ask(env, { images: [{ path: secret }] })).result)).toContain("not a PNG, JPEG, GIF or WebP image");
  });

  it("follows a symlink to a PNG and refuses one to a text file", async () => {
    const bridge = fake();
    const env = await start(bridge);
    const target = path.join(env.dir, "real.png");
    const text = path.join(env.dir, "notes.txt");
    writeFileSync(target, png);
    writeFileSync(text, "TOPSECRET\n");
    try { symlinkSync(target, path.join(env.dir, "link.png"), "file"); symlinkSync(text, path.join(env.dir, "textlink.png"), "file"); } catch { return; }
    expect((await ask(env, { images: [{ path: path.join(env.dir, "link.png") }] })).result.isError).toBeUndefined();
    const refused = await ask(env, { images: [{ path: path.join(env.dir, "textlink.png") }] });
    expect(textOf(refused.result)).toMatch(/^invalid_image_path:/);
    expect(refused.raw).not.toContain("TOPSECRET");
  });

  it("isLoopbackAddress tells this machine from the rest", () => {
    for (const address of ["127.0.0.1", "127.5.6.7", "::1", "::ffff:127.0.0.1", "::FFFF:127.9.9.9"]) expect(isLoopbackAddress(address), address).toBe(true);
    for (const address of ["10.0.0.2", "::ffff:192.168.1.2", "192.168.1.5", "2001:db8::1", "128.0.0.1", "127.example", "localhost", ""]) expect(isLoopbackAddress(address), address).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
  });
});

describe("generate_image", () => {
  it("asks for images with the shared text, adds the aspect ratio hint, and rejects a malformed size", async () => {
    const bridge = fake({ generate: () => drawn() });
    const env = await start(bridge);
    expect((await draw(env, { prompt: "a fox" })).result.isError).toBeUndefined();
    expect(bridge.calls[0]!.options).toEqual({ images: true });
    expect(bridge.calls[0]!.messages).toEqual([{ role: "user", parts: [{ type: "text", text: imageGenerationText("a fox") }] }]);
    await draw(env, { prompt: "a fox", size: "1536x1024" });
    expect((bridge.calls[1]!.messages[0]!.parts[0] as any).text).toBe("Generate an image: a fox\nAspect ratio: 3:2 (requested size 1536x1024).");
    expect((await draw(env, { size: "big" })).error?.code).toBe(-32602);
    expect((await draw(env, { file_name: "x" })).error?.code).toBe(-32602);
    expect(bridge.calls).toHaveLength(2);
  });

  it("saves for a local caller in the image folder with the exact bytes and returns the path and an image block", async () => {
    const env = await start(fake({ generate: () => drawn() }));
    const reply = await draw(env, {});
    expect(reply.result.isError).toBeUndefined();
    const files = filesIn(env.imageDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^img-\d{8}-\d{6}-[0-9a-f]{6}\.png$/);
    const file = path.join(path.resolve(env.imageDir), files[0]!);
    expect(readFileSync(file).equals(png)).toBe(true);
    expect(textOf(reply.result)).toContain(`Saved ${file} (image/png,`);
    expect(imageBlocks(reply.result)).toEqual([{ type: "image", data: PNG_B64, mimeType: "image/png" }]);
    expect(reply.result.structuredContent.model).toBe("codex/gpt-6-luna");
    expect(reply.result.structuredContent.images).toEqual([{ path: file, mime_type: "image/png", bytes: png.length, inline: true }]);
    expect(reply.result.structuredContent.usage.input_tokens).toBeGreaterThan(0);
  });

  it("shows the revised prompt of Codex", async () => {
    const env = await start(fake({ generate: () => drawn(PNG_B64, "image/png", "a fox leaping over a log") }));
    const reply = await draw(env, {});
    expect(textOf(reply.result)).toContain("Revised prompt: a fox leaping over a log");
    expect(reply.result.structuredContent.images[0].revised_prompt).toBe("a fox leaping over a log");
  });

  it("trusts the bytes, not the agent's MIME type", async () => {
    const env = await start(fake({ generate: () => drawn(PNG_B64, "image/jpeg") }));
    const reply = await draw(env, {});
    expect(filesIn(env.imageDir)[0]).toMatch(/\.png$/);
    expect(reply.result.structuredContent.images[0].mime_type).toBe("image/png");
    expect(imageBlocks(reply.result)[0].mimeType).toBe("image/png");
    const jpg = await start(fake({ generate: () => drawn(JPEG_B64, "image/png") }));
    await draw(jpg, {});
    expect(filesIn(jpg.imageDir)[0]).toMatch(/\.jpg$/);
  });

  it("saves into save_to under file_name, never overwrites, and keeps a sanitised name inside the folder", async () => {
    const env = await start(fake({ generate: () => drawn() }));
    const folder = path.join(env.dir, "assets");
    mkdirSync(folder, { recursive: true });
    const real = realpathSync(folder);
    const first = await draw(env, { save_to: folder, file_name: "logo" });
    expect(first.result.structuredContent.images[0].path).toBe(path.join(real, "logo.png"));
    expect(textOf(first.result)).toContain(`Saved ${path.join(real, "logo.png")}`);
    writeFileSync(path.join(real, "logo.png"), "mine");
    const second = await draw(env, { save_to: folder, file_name: "logo.jpeg" });
    const secondPath = second.result.structuredContent.images[0].path as string;
    expect(path.basename(secondPath)).toMatch(/^logo-[0-9a-f]{6}\.png$/);
    expect(textOf(second.result)).toContain("already existed");
    expect(readFileSync(path.join(real, "logo.png"), "utf8")).toBe("mine");
    expect(readFileSync(secondPath).equals(png)).toBe(true);
    const sneaky = await draw(env, { save_to: folder, file_name: "../x" });
    expect(path.dirname(sneaky.result.structuredContent.images[0].path)).toBe(real);
    expect(existsSync(path.join(env.dir, "x.png"))).toBe(false);
    expect(path.basename(sneaky.result.structuredContent.images[0].path)).toMatch(/^[A-Za-z0-9._-]+\.png$/);
    const weird = await draw(env, { save_to: folder, file_name: "a b/c:d*?" });
    expect(path.basename(weird.result.structuredContent.images[0].path)).toBe("a-b-c-d--.png");
    const long = await draw(env, { save_to: folder, file_name: "x".repeat(200) });
    expect(path.basename(long.result.structuredContent.images[0].path)).toBe(`${"x".repeat(80)}.png`);
    expect(filesIn(env.imageDir)).toEqual([]);
  });

  it("prefixes a file_name whose part before the first dot is a Windows device name, and leaves other dotted names alone", async () => {
    const env = await start(fake({ generate: () => drawn() }));
    const folder = path.join(env.dir, "devices");
    mkdirSync(folder, { recursive: true });
    const nameFor = async (file_name: string) => path.basename((await draw(env, { save_to: folder, file_name })).result.structuredContent.images[0].path as string);
    expect(await nameFor("con.x.y")).toBe("img-con.x.png");
    expect(await nameFor("NUL.tar.gz")).toBe("img-NUL.tar.png");
    expect(await nameFor("com1.a.b")).toBe("img-com1.a.png");
    expect(await nameFor("con")).toBe("img-con.png");
    expect(await nameFor("my.chart.v2")).toBe("my.chart.png");
    expect(await nameFor("console.log.txt")).toBe("console.log.png");
  });

  it("refuses a save_to that is not an existing folder before generating", async () => {
    const bridge = fake({ generate: () => drawn() });
    const env = await start(bridge);
    const file = path.join(env.dir, "plain.txt");
    writeFileSync(file, "x");
    for (const bad of [path.join(env.dir, "nope"), file]) {
      const reply = await draw(env, { save_to: bad });
      expect(textOf(reply.result)).toMatch(/^invalid_save_path:/);
    }
    expect(bridge.calls).toHaveLength(0);
  });

  it("keeps a big image out of the reply (path only), and honours return_image: false", async () => {
    const bigPng = big(3 * MB + 200_000);
    const env = await start(fake({ generate: () => drawn(bigPng.toString("base64")) }));
    const reply = await draw(env, {});
    expect(imageBlocks(reply.result)).toEqual([]);
    expect(textOf(reply.result)).toMatch(/too large to show inline \(3\.\d MB\); open the file to view it/);
    expect(reply.result.structuredContent.images[0].inline).toBe(false);
    expect(readFileSync(path.join(path.resolve(env.imageDir), filesIn(env.imageDir)[0]!)).length).toBe(bigPng.length);
    const small = await start(fake({ generate: () => drawn() }));
    const quiet = await draw(small, { return_image: false });
    expect(imageBlocks(quiet.result)).toEqual([]);
    expect(quiet.result.structuredContent.images[0].inline).toBe(false);
    expect(textOf(quiet.result)).toContain("Saved ");
    expect(filesIn(small.imageDir)).toHaveLength(1);
  });

  it("gives a remote caller the image inline only, whatever its size", async () => {
    const bigPng = big(3 * MB + 200_000);
    const env = await start(fake({ generate: () => drawn(bigPng.toString("base64")) }), { isLocalCaller: () => false });
    const reply = await draw(env, { return_image: false });
    expect(imageBlocks(reply.result)).toHaveLength(1);
    expect(imageBlocks(reply.result)[0].data.length).toBe(bigPng.toString("base64").length);
    expect(filesIn(env.imageDir)).toEqual([]);
    expect(reply.result.structuredContent.images[0]).toEqual({ mime_type: "image/png", bytes: bigPng.length, inline: true });
    expect(textOf(reply.result)).not.toContain("Saved");
  });

  it("succeeds with the image inline and a save_error when the file cannot be written", async () => {
    const dir = path.join(root, `blocked${++counter}`);
    mkdirSync(dir, { recursive: true });
    const blocker = path.join(dir, "not-a-folder");
    writeFileSync(blocker, "x");
    const env = await start(fake({ generate: () => drawn() }), { mcpImageDir: blocker });
    const reply = await draw(env, { return_image: false });
    expect(reply.result.isError).toBeUndefined();
    expect(imageBlocks(reply.result)).toHaveLength(1);
    const info = reply.result.structuredContent.images[0];
    expect(info.path).toBeUndefined();
    expect(info.inline).toBe(true);
    expect(info.save_error).toMatch(/could not be saved/);
    expect(textOf(reply.result)).toContain("could not be saved");
    expect(reply.raw).not.toContain("not-a-folder");
  });

  it("gives reference images to the model in one message with the prompt", async () => {
    const bridge = fake({ generate: () => drawn() });
    const env = await start(bridge);
    const reply = await draw(env, { prompt: "make it blue", images: [dataImage(), dataImage(jpeg, "image/jpeg")] });
    expect(reply.result.isError).toBeUndefined();
    expect(bridge.calls[0]!.messages).toHaveLength(1);
    expect(bridge.calls[0]!.messages[0]!.parts.map((part) => part.type === "image" ? part.mimeType : "text")).toEqual(["text", "image/png", "image/jpeg"]);
    expect((await draw(env, { images: Array(5).fill(dataImage()) })).error?.code).toBe(-32602);
    const refusing = fake({ generate: () => drawn(), acceptsImages: () => false });
    const env2 = await start(refusing);
    expect(textOf((await draw(env2, { images: [dataImage()] })).result)).toMatch(/^model_not_capable:/);
    expect(refusing.calls).toHaveLength(0);
  });

  it("cleans the image folder: the newest 100 stay, older than 7 days go, nothing else is touched", async () => {
    const env = await start(fake({ generate: () => drawn() }));
    mkdirSync(env.imageDir, { recursive: true });
    const now = Date.now();
    const name = (index: number) => `img-20260101-${String(index).padStart(6, "0")}-aaaaaa.png`;
    for (let index = 1; index <= 101; index++) { const file = path.join(env.imageDir, name(index)); writeFileSync(file, png); utimesSync(file, new Date(now - index * 3600_000), new Date(now - index * 3600_000)); }
    const ancient = path.join(env.imageDir, "img-20250101-000000-bbbbbb.png");
    writeFileSync(ancient, png);
    utimesSync(ancient, new Date(now - 8 * 24 * 3600_000), new Date(now - 8 * 24 * 3600_000));
    writeFileSync(path.join(env.imageDir, "keep.txt"), "keep me");
    writeFileSync(path.join(env.imageDir, "img-not-ours.png"), "keep me too");
    let linked = true;
    try { symlinkSync(path.join(env.dir, "outside.png"), path.join(env.imageDir, "img-20260101-999999-cccccc.png"), "file"); } catch { linked = false; }
    const reply = await draw(env, {});
    expect(reply.result.isError).toBeUndefined();
    await waitFor(() => filesIn(env.imageDir).filter((file) => /^img-\d{8}-\d{6}-[0-9a-f]{6}\.png$/.test(file)).length <= 101);
    const remaining = filesIn(env.imageDir);
    const ours = remaining.filter((file) => /^img-\d{8}-\d{6}-[0-9a-f]{6}\.png$/.test(file) && (!linked || file !== "img-20260101-999999-cccccc.png"));
    expect(ours).toHaveLength(100);
    expect(remaining).not.toContain(name(101));
    expect(remaining).not.toContain(name(100));
    expect(remaining).toContain(name(1));
    expect(remaining).not.toContain("img-20250101-000000-bbbbbb.png");
    expect(remaining).toContain("keep.txt");
    expect(remaining).toContain("img-not-ours.png");
    if (linked) expect(remaining).toContain("img-20260101-999999-cccccc.png");
    expect(ours).toContain(path.basename(reply.result.structuredContent.images[0].path));
  });

  it("refuses a model that cannot draw and names the ones that can", async () => {
    const bridge = fake();
    const env = await start(bridge);
    const reply = await draw(env, { model: "claude/haiku" });
    expect(reply.result.isError).toBe(true);
    expect(textOf(reply.result)).toMatch(/^model_not_capable:/);
    expect(textOf(reply.result)).toContain("codex/gpt-6-luna");
    expect(textOf(reply.result)).toContain("antigravity/gemini-3.8-flash-low");
    expect(textOf(reply.result)).not.toContain("claude/haiku, ");
    expect(bridge.calls).toHaveLength(0);
  });

  it("answers no_image_generated with the agent's words when no valid image comes back", async () => {
    const said = fake({ generate: () => answer("I can't draw that") });
    const env = await start(said);
    const reply = await draw(env, {});
    expect(reply.result.isError).toBe(true);
    expect(textOf(reply.result)).toBe("no_image_generated: The agent did not generate an image. It said: I can't draw that");
    const bad = await start(fake({ generate: () => drawn(Buffer.from("not an image at all").toString("base64")) }));
    expect(textOf((await draw(bad, {})).result)).toMatch(/^no_image_generated:/);
    expect(filesIn(bad.imageDir)).toEqual([]);
    expect(bad.activity.list()[0]).toMatchObject({ status: 502, error: "no_image_generated" });
  });

  it("answers request_timeout when the model never answers, and writes no file when cancelled", async () => {
    const hang = fake({ generate: () => new Promise<GenerationResult>(() => undefined) });
    const env = await start(hang, { config: { timeoutMs: 150 } });
    const reply = await draw(env, {});
    expect(reply.result.isError).toBe(true);
    expect(textOf(reply.result)).toMatch(/^request_timeout:/);
    expect(env.activity.list()[0]).toMatchObject({ status: 504, error: "request_timeout" });
    expect(hang.calls[0]!.signal!.aborted).toBe(true);

    const waiting = fake({ generate: ({ signal }) => new Promise<GenerationResult>((resolve) => signal!.addEventListener("abort", () => resolve(drawn()), { once: true })) });
    const env2 = await start(waiting);
    const pending = post(env2, { jsonrpc: "2.0", id: 901, method: "tools/call", params: { name: "generate_image", arguments: { model: "codex/gpt-6-luna", prompt: "x" } } });
    await waitFor(() => waiting.calls.length === 1);
    const cancel = await post(env2, { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 901, reason: "user" } });
    expect(cancel.status).toBe(202);
    const done = await pending;
    expect(done.result).toBeUndefined();
    expect(waiting.calls[0]!.signal!.aborted).toBe(true);
    expect(filesIn(env2.imageDir)).toEqual([]);
  });
});

describe("transport and security", () => {
  it("aborts the generation on notifications/cancelled and when the connection closes", async () => {
    const waiting = fake({ generate: ({ signal }) => new Promise<GenerationResult>((resolve) => signal!.addEventListener("abort", () => resolve({ text: "", stopReason: "cancelled", usage: null }), { once: true })) });
    const env = await start(waiting);
    const pending = post(env, { jsonrpc: "2.0", id: 55, method: "tools/call", params: { name: "ask_model", arguments: { model: "codex/gpt-6-luna", prompt: "x" } } });
    await waitFor(() => waiting.calls.length === 1);
    expect(waiting.calls[0]!.signal!.aborted).toBe(false);
    await post(env, { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 55 } });
    await pending;
    expect(waiting.calls[0]!.signal!.aborted).toBe(true);

    const controller = new AbortController();
    const dropped = fetch(`${env.base}/v1/mcp`, { method: "POST", signal: controller.signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 56, method: "tools/call", params: { name: "ask_model", arguments: { model: "codex/gpt-6-luna", prompt: "y" } } }) }).catch(() => undefined);
    await waitFor(() => waiting.calls.length === 2);
    controller.abort();
    await dropped;
    await waitFor(() => waiting.calls[1]!.signal!.aborted);
    await waitFor(() => env.activity.list().length === 2);
    expect(env.activity.list().every((entry) => entry.error === "cancelled")).toBe(true);
  });

  it("needs the bearer key when one is set", async () => {
    const env = await start(fake(), { config: { apiKey: "secret" } });
    const body = { jsonrpc: "2.0", id: 1, method: "ping" };
    expect((await post(env, body)).status).toBe(401);
    expect((await post(env, body, { authorization: "Bearer wrong" })).status).toBe(401);
    expect((await post(env, body, { authorization: "Bearer secret" })).status).toBe(200);
    expect(env.activity.list()).toEqual([]);
  });

  it("checks the Origin and the Content-Type", async () => {
    const env = await start(fake());
    const body = { jsonrpc: "2.0", id: 1, method: "ping" };
    expect((await post(env, body, { origin: "https://evil.example" })).status).toBe(403);
    expect((await post(env, body, { origin: "null" })).status).toBe(403);
    expect((await post(env, body, { origin: "http://localhost:8787" })).status).toBe(200);
    expect((await post(env, body, { origin: "http://127.0.0.1:8787" })).status).toBe(200);
    expect((await post(env, body, { origin: "http://[::1]:8787" })).status).toBe(200);
    expect((await post(env, body)).status).toBe(200);
    // The proxy's own address as a Host is fine for an IP address, not for a name (DNS rebinding).
    expect((await rawPost(env, { host: "192.168.1.5:8787", origin: "http://192.168.1.5:8787" }, body)).status).toBe(200);
    expect((await rawPost(env, { host: "rebind.example:8787", origin: "http://rebind.example:8787" }, body)).status).toBe(403);
    const plain = await fetch(`${env.base}/v1/mcp`, { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify(body) });
    expect(plain.status).toBe(415);
    const form = await fetch(`${env.base}/v1/mcp`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "a=b" });
    expect(form.status).toBe(415);
    const charset = await fetch(`${env.base}/v1/mcp`, { method: "POST", headers: { "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(body) });
    expect(charset.status).toBe(200);
    expect((await fetch(`${env.base}/v1/mcp`, { method: "OPTIONS" })).status).toBe(405);
  });

  it("applies the body limit", async () => {
    const env = await start(fake(), { config: { maxBodyBytes: 2000 } });
    const reply = await post(env, { jsonrpc: "2.0", id: 1, method: "ping", params: { pad: "x".repeat(5000) } });
    expect(reply.status).toBe(413);
  });
});

describe("activity", () => {
  it("records one entry per ask_model and generate_image call, with features, status and codes, and never a path or a prompt", async () => {
    const secretPrompt = "SECRET-PROMPT-TEXT";
    const bridge = fake({ generate: (c) => (c.options?.images ? drawn() : answer("SECRET-ANSWER")) });
    const env = await start(bridge);
    const file = path.join(env.dir, "private-shot.png");
    writeFileSync(file, png);
    await call(env, "list_models", {});
    await post(env, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    await post(env, { jsonrpc: "2.0", id: 2, method: "ping" });
    await ask(env, { prompt: secretPrompt });
    await ask(env, { prompt: secretPrompt, images: [{ path: file }], web_search: true });
    await draw(env, { prompt: secretPrompt, file_name: "private-name", save_to: env.dir });
    await draw(env, { prompt: secretPrompt, images: [dataImage()] });
    await ask(env, { prompt: secretPrompt, model: "claude/haiku", images: [{ path: path.join(env.dir, "missing.png") }] });
    await draw(env, { prompt: secretPrompt, model: "claude/haiku" });
    await ask(env, { prompt: secretPrompt, model: "nope-model" });
    const entries = env.activity.list().reverse();
    expect(entries.map((entry) => entry.endpoint)).toEqual(["MCP ask_model", "MCP ask_model", "MCP generate_image", "MCP generate_image", "MCP ask_model", "MCP generate_image", "MCP ask_model"]);
    expect(entries[0]).toMatchObject({ model: "codex/gpt-6-luna", provider: "codex", stream: false, features: [], status: 200 });
    expect(entries[0]!.error).toBeUndefined();
    expect(entries[0]!.inputTokens).toBeGreaterThan(0);
    expect(entries[1]!.features).toEqual(["images", "search"]);
    expect(entries[2]!.features).toEqual(["imageGeneration"]);
    expect(entries[3]!.features).toEqual(["images", "imageGeneration"]);
    expect(entries[4]).toMatchObject({ status: 400, error: "invalid_image_path", model: "claude/haiku" });
    expect(entries[5]).toMatchObject({ status: 400, error: "model_not_capable" });
    expect(entries[6]).toMatchObject({ status: 404, error: "model_not_found" });
    expect(entries[6]!.model).toBeUndefined();
    const dump = JSON.stringify(entries);
    for (const forbidden of [secretPrompt, "SECRET-ANSWER", "private-shot", "private-name", env.dir, "missing.png", PNG_B64]) expect(dump).not.toContain(forbidden);
  });

  it("maps a provider failure to its status and code", async () => {
    const env = await start(fake({ generate: () => { throw new AcpUnavailableError("busy", undefined, "provider_busy"); } }));
    await ask(env, {});
    expect(env.activity.list()[0]).toMatchObject({ endpoint: "MCP ask_model", status: 503, error: "provider_busy" });
  });
});
