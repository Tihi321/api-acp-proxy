import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AcpProvider } from "../src/acp-provider.js";
import { buildPrompt, normalizeChat, normalizeImageGeneration, normalizeResponses, textMessage } from "../src/api.js";
import type { ProxyConfig } from "../src/config.js";
import { deleteGeneratedFile, toFilePath } from "../src/generated-images.js";
import { defaultRuntimeContext, type ProviderDescriptor } from "../src/provider.js";
import { antigravityDescriptor } from "../src/providers/antigravity.js";
import { codexDescriptor } from "../src/providers/codex.js";
import { ProviderRouter } from "../src/router.js";
import { createProxyServer } from "../src/server.js";

// Every Antigravity provider start runs the Windows orphan sweep, which is slow.
vi.setConfig({ testTimeout: 30_000 });

const fixture = fileURLToPath(new URL("./fixtures/fake-acp.mjs", import.meta.url));
const root = path.resolve(".claude/temp/image-generation-tests", String(process.pid));
const PLAIN_PREAMBLE = "This is an API request. Do not use your own environment: no shell commands, no file access, no web access, no permission requests. If the conversation describes actions, functions or a JSON format for you to produce, produce them as text exactly as asked: the calling application executes them. Respond with the answer only.";
const JPEG_START = "/9j/";
const PNG_START = "iVBORw0KGgo";

let counter = 0;
const servers: Server[] = [];
const providers: AcpProvider[] = [];
interface Dirs { base: string; dataDir: string; geminiHome: string; codexHome: string; workRoot: string; log: string }

function dirs(): Dirs {
  const base = path.join(root, `t${++counter}`);
  const d: Dirs = { base, dataDir: path.join(base, "data"), geminiHome: path.join(base, "gemini"), codexHome: path.join(base, "data", "codex-home"), workRoot: path.join(base, "work"), log: path.join(base, "requests.log") };
  const agentDir = path.join(d.dataDir, "agents", "antigravity-acp");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(path.join(agentDir, "install.json"), JSON.stringify({ version: "1.0.0", url: "x", sha256: "x", command: process.execPath, args: [fixture], dir: agentDir, installedAt: new Date().toISOString() }));
  process.env.FAKE_ACP_LOG = d.log;
  return d;
}
function agy(d: Dirs): AcpProvider {
  const ctx = defaultRuntimeContext({ dataDir: d.dataDir });
  const provider = new AcpProvider(antigravityDescriptor(ctx, { env: {}, settings: { termsAcknowledgedAt: "2026-01-01T00:00:00Z", geminiHome: d.geminiHome }, overrides: { warmSessions: 0 } }), ctx, { workRoot: d.workRoot });
  providers.push(provider);
  return provider;
}
function codex(d: Dirs, isolatedHome = true): AcpProvider {
  const provider = new AcpProvider(codexDescriptor({ acpCommand: process.execPath, acpArgs: [fixture] }, { isolatedHome }), defaultRuntimeContext({ dataDir: d.dataDir }), { workRoot: d.workRoot });
  providers.push(provider);
  return provider;
}
/** A provider without image generation, named like Claude. */
function claudeLike(d: Dirs): AcpProvider {
  const descriptor: ProviderDescriptor = { id: "claude", displayName: "Claude", ownedBy: "anthropic", exposeUnprefixed: false, staticModels: ["haiku"], authMode: "on-demand", readOnlyMode: "optional", launch: () => ({ command: process.execPath, args: [fixture], env: { ...process.env } }), chooseAuth: () => undefined };
  const provider = new AcpProvider(descriptor, defaultRuntimeContext({ dataDir: d.dataDir }), { workRoot: d.workRoot });
  providers.push(provider);
  return provider;
}
async function start(d: Dirs, list: AcpProvider[]): Promise<string> {
  const config: ProxyConfig = { host: "127.0.0.1", port: 0, maxBodyBytes: 20 * 1024 * 1024, timeoutMs: 25_000, workRoot: d.workRoot, acpArgs: [], apiKey: "secret" };
  const server = createProxyServer(config, new ProviderRouter({ providers: list }));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function send(base: string, route: string, body: unknown): Promise<{ status: number; body: any; raw: string }> {
  const response = await fetch(`${base}${route}`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer secret" }, body: JSON.stringify(body) });
  const raw = await response.text();
  let parsed: any; try { parsed = JSON.parse(raw); } catch { parsed = undefined; }
  return { status: response.status, body: parsed, raw };
}
const sse = (raw: string) => raw.split("\n\n").flatMap((block) => { const data = block.split("\n").filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("\n"); return data && data !== "[DONE]" ? [JSON.parse(data) as any] : []; });
const readLog = (d: Dirs) => readFileSync(d.log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { method: string; params: any });
const promptText = (d: Dirs): string => readLog(d).find((entry) => entry.method === "session/prompt")!.params.prompt[0].text;
const permissionAnswers = (d: Dirs) => readLog(d).filter((entry) => entry.method === "permission_response").map((entry) => entry.params.outcome);
const filesUnder = (dir: string): string[] => existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? filesUnder(path.join(dir, entry.name)) : [path.join(dir, entry.name)]) : [];
const AGY_MODEL = "antigravity/gemini-3.8-flash-low";
const CODEX_MODEL = "codex/gpt-6-luna";
const imageRequest = (model: string, extra: Record<string, unknown> = {}) => ({ model, prompt: "a cartoon dolphin jumping out of the sea", ...extra });
const chat = (model: string, extra: Record<string, unknown> = {}) => ({ model, messages: [{ role: "user", content: "draw a dolphin" }], ...extra });
const resp = (model: string, extra: Record<string, unknown> = {}) => ({ model, input: "draw a dolphin", ...extra });

beforeEach(() => { mkdirSync(root, { recursive: true }); });
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); })));
  await Promise.all(providers.splice(0).map((provider) => provider.close()));
  for (const key of Object.keys(process.env)) if (key.startsWith("FAKE_ACP_")) delete process.env[key];
});

describe("POST /v1/images/generations", () => {
  it("returns the Antigravity JPEG from the update, allows only its permission, passes the size as a ratio and deletes the agent's file", async () => {
    const d = dirs();
    Object.assign(process.env, { FAKE_ACP_AGY: "1", FAKE_ACP_IMAGE_GEN: "agy" });
    const base = await start(d, [agy(d)]);
    const result = await send(base, "/v1/images/generations", imageRequest(AGY_MODEL, { size: "1536x1024", quality: "high", output_format: "png" }));
    expect(result.status).toBe(200);
    expect(result.body.data).toHaveLength(1);
    expect(result.body.data[0].b64_json.startsWith(JPEG_START)).toBe(true);
    expect(result.body.data[0]).not.toHaveProperty("revised_prompt");
    expect(result.body.output_format).toBe("jpeg");
    expect(typeof result.body.created).toBe("number");
    expect(permissionAnswers(d)).toEqual([{ outcome: "selected", optionId: "allow" }]);
    const text = promptText(d);
    expect(text).toContain("allows one generated image");
    expect(text).not.toContain("Do not call any tool");
    expect(text).toContain("[user]\nGenerate an image: a cartoon dolphin jumping out of the sea\nAspect ratio: 3:2 (requested size 1536x1024).\nQuality: high.");
    expect(filesUnder(path.join(d.geminiHome, "antigravity-acp", "brain"))).toEqual([]);
  });

  it("returns the Codex PNG with its revised prompt, asks no permission, and removes the file and its empty thread folder", async () => {
    const d = dirs();
    process.env.FAKE_ACP_IMAGE_GEN = "codex";
    const base = await start(d, [codex(d)]);
    const result = await send(base, "/v1/images/generations", imageRequest(CODEX_MODEL));
    expect(result.status).toBe(200);
    expect(result.body.data[0].b64_json.startsWith(PNG_START)).toBe(true);
    expect(result.body.data[0].revised_prompt).toBe("a cartoon dolphin leaping from the sea");
    expect(result.body.output_format).toBe("png");
    expect(permissionAnswers(d)).toEqual([]);
    const folder = path.join(d.codexHome, "generated_images");
    expect(existsSync(folder)).toBe(true);
    expect(readdirSync(folder)).toEqual([]);
  });

  it("uses ~/.codex-style CODEX_HOME when the isolated home is off", async () => {
    const d = dirs();
    const own = path.join(d.base, "users-codex");
    Object.assign(process.env, { FAKE_ACP_IMAGE_GEN: "codex", CODEX_HOME: own });
    try {
      const base = await start(d, [codex(d, false)]);
      expect((await send(base, "/v1/images/generations", imageRequest(CODEX_MODEL))).status).toBe(200);
      expect(readdirSync(path.join(own, "generated_images"))).toEqual([]);
      expect(existsSync(d.codexHome)).toBe(false);
    } finally { delete process.env.CODEX_HOME; }
  });

  it("takes a 6 MB Codex update line", async () => {
    const d = dirs();
    Object.assign(process.env, { FAKE_ACP_IMAGE_GEN: "codex", FAKE_ACP_IMAGE_GEN_BYTES: "2300000" });
    const base = await start(d, [codex(d)]);
    const result = await send(base, "/v1/images/generations", imageRequest(CODEX_MODEL));
    expect(result.status).toBe(200);
    expect(result.body.data[0].b64_json).toHaveLength(Math.ceil(2_300_000 / 3) * 4);
    expect(Math.ceil(2_300_000 / 3) * 4 * 2).toBeGreaterThan(6_000_000);
    expect(readdirSync(path.join(d.codexHome, "generated_images"))).toEqual([]);
  });

  it("cancels an offer that has only allow_always, and answers 502 with the agent's words", async () => {
    const d = dirs();
    Object.assign(process.env, { FAKE_ACP_AGY: "1", FAKE_ACP_IMAGE_GEN: "agy", FAKE_ACP_IMAGE_GEN_OPTIONS: "always-only" });
    const base = await start(d, [agy(d)]);
    const result = await send(base, "/v1/images/generations", imageRequest(AGY_MODEL));
    expect(result.status).toBe(502);
    expect(result.body.error.code).toBe("no_image_generated");
    expect(result.body.error.message).toContain("The image tool was denied.");
    expect(permissionAnswers(d)).toEqual([{ outcome: "cancelled" }]);
    expect(filesUnder(path.join(d.geminiHome, "antigravity-acp", "brain"))).toEqual([]);
  });

  it("answers 502 no_image_generated when the agent only talks", async () => {
    const d = dirs();
    Object.assign(process.env, { FAKE_ACP_IMAGE_GEN: "codex", FAKE_ACP_IMAGE_GEN_NONE: "1" });
    const base = await start(d, [codex(d)]);
    const result = await send(base, "/v1/images/generations", imageRequest(CODEX_MODEL));
    expect(result.status).toBe(502);
    expect(result.body.error).toMatchObject({ code: "no_image_generated" });
    expect(result.body.error.message).toContain("I cannot generate that image.");
  });

  it("does not allow other permissions in an image request", async () => {
    const d = dirs();
    Object.assign(process.env, { FAKE_ACP_AGY: "1", FAKE_ACP_REQUIRE_PERMISSION: "1" });
    const base = await start(d, [agy(d)]);
    const result = await send(base, "/v1/images/generations", imageRequest(AGY_MODEL));
    expect(result.status).toBe(502);
    expect(permissionAnswers(d)).toEqual([{ outcome: "cancelled" }]);
  });

  it("rejects what the proxy cannot do with 400, and a model that cannot generate with model_not_capable", async () => {
    const d = dirs();
    process.env.FAKE_ACP_IMAGE_GEN = "codex";
    const base = await start(d, [codex(d), claudeLike(d)]);
    const cases: Array<[Record<string, unknown>, string, string]> = [
      [{ n: 2 }, "unsupported_parameter", "n"],
      [{ response_format: "url" }, "unsupported_parameter", "response_format"],
      [{ mask: "data:image/png;base64,AAAA" }, "unsupported_parameter", "mask"],
      [{ image: "data:image/png;base64,AAAA" }, "unsupported_parameter", "image"],
      [{ stream: true }, "unsupported_parameter", "stream"],
      [{ partial_images: 2 }, "unsupported_parameter", "partial_images"],
      [{ size: "wide" }, "invalid_request", "size"],
      [{ prompt: "" }, "invalid_request", "prompt"],
    ];
    for (const [extra, code, param] of cases) {
      const result = await send(base, "/v1/images/generations", imageRequest(CODEX_MODEL, extra));
      expect(result.status, JSON.stringify(extra)).toBe(400);
      expect(result.body.error, JSON.stringify(extra)).toMatchObject({ code, param });
    }
    expect((await send(base, "/v1/images/generations", imageRequest(CODEX_MODEL, { n: 1, response_format: "b64_json", size: "auto" }))).status).toBe(200);
    const notCapable = await send(base, "/v1/images/generations", imageRequest("claude/haiku"));
    expect(notCapable.status).toBe(400);
    expect(notCapable.body.error).toMatchObject({ code: "model_not_capable", param: "model" });
    await fetch(`${base}/v1/models`, { headers: { authorization: "Bearer secret" } }); // Codex models come from the agent: a model is only unknown once they are discovered.
    expect((await send(base, "/v1/images/generations", imageRequest("codex/nope"))).status).toBe(404);
  });

  it("keeps the requests of other sessions cancelled while one session may generate", async () => {
    const d = dirs();
    Object.assign(process.env, { FAKE_ACP_AGY: "1", FAKE_ACP_IMAGE_GEN: "agy" });
    const base = await start(d, [agy(d)]);
    const [generated, plain] = await Promise.all([send(base, "/v1/images/generations", imageRequest(AGY_MODEL)), send(base, "/v1/chat/completions", chat(AGY_MODEL))]);
    expect(generated.status).toBe(200);
    expect(generated.body.data[0].b64_json.startsWith(JPEG_START)).toBe(true);
    expect(plain.status).toBe(200);
    expect(plain.body.choices[0].message.content).toBe("The image tool was denied.");
    expect(permissionAnswers(d).map((outcome) => outcome.outcome).sort()).toEqual(["cancelled", "selected"]);
  });
});

describe("files the agent wrote", () => {
  it.each([["agy"], ["codex"]])("leaves a file outside the agent's image folder alone (%s)", async (kind) => {
    const d = dirs();
    const outside = path.join(d.base, "elsewhere", "precious.png");
    Object.assign(process.env, { FAKE_ACP_IMAGE_GEN: kind, FAKE_ACP_IMAGE_GEN_OUTSIDE: outside, ...(kind === "agy" ? { FAKE_ACP_AGY: "1" } : {}) });
    const base = await start(d, [kind === "agy" ? agy(d) : codex(d)]);
    const result = await send(base, "/v1/images/generations", imageRequest(kind === "agy" ? AGY_MODEL : CODEX_MODEL));
    expect(result.status).toBe(200);
    expect(result.body.data[0].b64_json.length).toBeGreaterThan(10);
    expect(existsSync(outside)).toBe(true);
  });

  it("deletes the Codex file in a request that did not ask for an image, and drops the image", async () => {
    const d = dirs();
    process.env.FAKE_ACP_IMAGE_GEN = "codex";
    const base = await start(d, [codex(d)]);
    const result = await send(base, "/v1/chat/completions", chat(CODEX_MODEL));
    expect(result.status).toBe(200);
    expect(result.body.choices[0].message).toEqual({ role: "assistant", content: "Here is your image." });
    expect(promptText(d)).toContain(PLAIN_PREAMBLE);
    expect(readdirSync(path.join(d.codexHome, "generated_images"))).toEqual([]);
  });

  it("cancels the Antigravity image permission in a request that did not ask for images", async () => {
    const d = dirs();
    Object.assign(process.env, { FAKE_ACP_AGY: "1", FAKE_ACP_IMAGE_GEN: "agy" });
    const base = await start(d, [agy(d)]);
    const result = await send(base, "/v1/chat/completions", chat(AGY_MODEL));
    expect(result.status).toBe(200);
    expect(result.body.choices[0].message.content).toBe("The image tool was denied.");
    expect(permissionAnswers(d)).toEqual([{ outcome: "cancelled" }]);
    expect(filesUnder(path.join(d.geminiHome, "antigravity-acp", "brain"))).toEqual([]);
  });

  it("answers a plain request exactly as before: one text block, every permission cancelled", async () => {
    const d = dirs();
    Object.assign(process.env, { FAKE_ACP_AGY: "1", FAKE_ACP_REQUIRE_PERMISSION: "1" });
    const base = await start(d, [agy(d)]);
    const result = await send(base, "/v1/chat/completions", chat(AGY_MODEL));
    expect(result.status).toBe(200);
    expect(result.body.choices[0].message.content).toBe("fake response");
    expect(permissionAnswers(d)).toEqual([{ outcome: "cancelled" }]);
    const blocks = readLog(d).find((entry) => entry.method === "session/prompt")!.params.prompt;
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toBe((buildPrompt([textMessage("user", "draw a dolphin")], undefined, antigravityDescriptor(defaultRuntimeContext(), { settings: {}, env: {} }).promptPreamble)[0] as { text: string }).text);
    expect(blocks[0].text).toContain("This is an API request.");
    expect(blocks[0].text).not.toContain("allows one generated image");
  });
});

describe("deleteGeneratedFile", () => {
  const make = (name: string) => { const dir = path.join(root, `del-${++counter}-${name}`); mkdirSync(path.join(dir, "brain", "session"), { recursive: true }); return { dir, folder: path.join(dir, "brain") }; };

  it("deletes a file inside the folder, from a plain path or either file URI form", async () => {
    const { folder } = make("inside");
    const file = path.join(folder, "session", "a.png");
    for (const reported of [file, `file://${file}`, `file:///${file.replaceAll("\\", "/")}`]) {
      writeFileSync(file, "x");
      expect(await deleteGeneratedFile(reported, folder), reported).toBe(true);
      expect(existsSync(file)).toBe(false);
    }
  });

  it("never deletes outside the folder: a sibling, a name sharing the prefix, a ../ path, the folder itself, a directory, a relative path, a missing file", async () => {
    const { dir, folder } = make("outside");
    mkdirSync(path.join(dir, "brain-evil"), { recursive: true });
    const sibling = path.join(dir, "sibling.png"); writeFileSync(sibling, "x");
    const prefixed = path.join(dir, "brain-evil", "b.png"); writeFileSync(prefixed, "x");
    const inside = path.join(folder, "session", "keep.png"); writeFileSync(inside, "x");
    const traversal = path.join(folder, "session", "..", "..", "sibling.png");
    for (const reported of [sibling, prefixed, traversal, `file://${sibling}`, folder, path.join(folder, "session"), "sibling.png", "..\\sibling.png", path.join(folder, "session", "missing.png"), ""]) {
      expect(await deleteGeneratedFile(reported, folder), reported).toBe(false);
    }
    expect(existsSync(sibling) && existsSync(prefixed) && existsSync(inside) && existsSync(path.join(folder, "session"))).toBe(true);
    expect(await deleteGeneratedFile(sibling, path.join(dir, "no-such-folder"))).toBe(false);
  });

  it("does not follow a link that leaves the folder", async () => {
    const { dir, folder } = make("link");
    const outside = path.join(dir, "outside"); mkdirSync(outside);
    const target = path.join(outside, "secret.png"); writeFileSync(target, "x");
    try { symlinkSync(outside, path.join(folder, "link"), "junction"); } catch { return; }
    expect(await deleteGeneratedFile(path.join(folder, "link", "secret.png"), folder)).toBe(false);
    expect(existsSync(target)).toBe(true);
  });

  it("removes the emptied parent folder only when asked, only when empty, and never the image folder", async () => {
    const { folder } = make("prune");
    const thread = path.join(folder, "session");
    writeFileSync(path.join(thread, "a.png"), "x"); writeFileSync(path.join(thread, "b.png"), "x");
    expect(await deleteGeneratedFile(path.join(thread, "a.png"), folder, { pruneEmptyParent: true })).toBe(true);
    expect(existsSync(thread)).toBe(true);
    expect(await deleteGeneratedFile(path.join(thread, "b.png"), folder)).toBe(true);
    expect(existsSync(thread)).toBe(true);
    writeFileSync(path.join(thread, "c.png"), "x");
    expect(await deleteGeneratedFile(path.join(thread, "c.png"), folder, { pruneEmptyParent: true })).toBe(true);
    expect(existsSync(thread)).toBe(false);
    writeFileSync(path.join(folder, "top.png"), "x");
    expect(await deleteGeneratedFile(path.join(folder, "top.png"), folder, { pruneEmptyParent: true })).toBe(true);
    expect(existsSync(folder)).toBe(true);
  });

  it("reads the file URI forms the agents use", () => {
    expect(toFilePath("file://C:\\Users\\x\\a b.jpg")).toBe(process.platform === "win32" ? "C:\\Users\\x\\a b.jpg" : undefined);
    expect(toFilePath("file:///C:/Users/x/a%20b.jpg")).toBe(process.platform === "win32" ? "C:/Users/x/a b.jpg" : undefined);
    expect(toFilePath("relative/a.png")).toBeUndefined();
  });
});

describe("Responses image_generation tool", () => {
  it("adds an image_generation_call item before the message", async () => {
    const d = dirs();
    process.env.FAKE_ACP_IMAGE_GEN = "codex";
    const base = await start(d, [codex(d)]);
    const result = await send(base, "/v1/responses", resp(CODEX_MODEL, { tools: [{ type: "image_generation", size: "1024x1024", quality: "low" }], tool_choice: { type: "image_generation" } }));
    expect(result.status).toBe(200);
    const [call, message] = result.body.output;
    expect(call).toMatchObject({ type: "image_generation_call", status: "completed", revised_prompt: "a cartoon dolphin leaping from the sea", output_format: "png" });
    expect(call.id).toMatch(/^ig-/);
    expect(call.result.startsWith(PNG_START)).toBe(true);
    expect(message).toMatchObject({ type: "message", role: "assistant" });
    expect(message.content[0].text).toBe("Here is your image.");
    expect(promptText(d)).toContain("allows one generated image");
    expect(readdirSync(path.join(d.codexHome, "generated_images"))).toEqual([]);
  });

  it("streams the image item added and done, then the message", async () => {
    const d = dirs();
    Object.assign(process.env, { FAKE_ACP_AGY: "1", FAKE_ACP_IMAGE_GEN: "agy" });
    const base = await start(d, [agy(d)]);
    const result = await send(base, "/v1/responses", resp(AGY_MODEL, { stream: true, tools: [{ type: "image_generation" }] }));
    expect(result.status).toBe(200);
    const events = sse(result.raw);
    expect(events.map((event) => event.type)).toEqual(["response.created", "response.output_item.added", "response.output_item.done", "response.output_item.added", "response.content_part.added", "response.output_text.delta", "response.output_text.done", "response.content_part.done", "response.output_item.done", "response.completed"]);
    expect(events.map((event) => event.sequence_number)).toEqual(events.map((_, index) => index));
    expect(events[1]).toMatchObject({ output_index: 0, item: { type: "image_generation_call", status: "in_progress", result: null } });
    expect(events[2]).toMatchObject({ output_index: 0, item: { type: "image_generation_call", status: "completed", output_format: "jpeg" } });
    expect(events[2].item.result.startsWith(JPEG_START)).toBe(true);
    expect(events[3]).toMatchObject({ output_index: 1, item: { type: "message" } });
    expect(events[5]).toMatchObject({ output_index: 1, delta: "Here is your cartoon dolphin." });
    const output = events[9].response.output;
    expect(output.map((item: any) => item.type)).toEqual(["image_generation_call", "message"]);
    expect(output[0].id).toBe(events[2].item.id);
    expect(permissionAnswers(d)).toEqual([{ outcome: "selected", optionId: "allow" }]);
  });

  it("rejects partial_images and other tools, and a model that cannot generate", async () => {
    const d = dirs();
    process.env.FAKE_ACP_IMAGE_GEN = "codex";
    const base = await start(d, [codex(d), claudeLike(d)]);
    const partial = await send(base, "/v1/responses", resp(CODEX_MODEL, { tools: [{ type: "image_generation", partial_images: 2 }] }));
    expect(partial.status).toBe(400);
    expect(partial.body.error).toMatchObject({ code: "unsupported_parameter", param: "tools" });
    for (const tools of [[{ type: "file_search" }], [{ type: "image_generation" }, { type: "function", name: "f" }], [], "image_generation"]) {
      const rejected = await send(base, "/v1/responses", resp(CODEX_MODEL, { tools }));
      expect(rejected.status, JSON.stringify(tools)).toBe(400);
      expect(rejected.body.error).toMatchObject({ code: "unsupported_parameter", param: "tools" });
    }
    const choice = await send(base, "/v1/responses", resp(CODEX_MODEL, { tool_choice: "auto" }));
    expect(choice.status).toBe(400);
    expect(choice.body.error.param).toBe("tool_choice");
    for (const stream of [false, true]) {
      const notCapable = await send(base, "/v1/responses", resp("claude/haiku", { stream, tools: [{ type: "image_generation" }] }));
      expect(notCapable.status).toBe(400);
      expect(notCapable.body.error).toMatchObject({ code: "model_not_capable" });
    }
  });

  it("answers a request without the tool exactly as before (no image item, image dropped)", async () => {
    const d = dirs();
    process.env.FAKE_ACP_IMAGE_GEN = "codex";
    const base = await start(d, [codex(d)]);
    const result = await send(base, "/v1/responses", resp(CODEX_MODEL));
    expect(result.status).toBe(200);
    expect(result.body.output.map((item: any) => item.type)).toEqual(["message"]);
    const streamed = sse((await send(base, "/v1/responses", resp(CODEX_MODEL, { stream: true }))).raw);
    expect(streamed.map((event) => event.type).slice(0, 3)).toEqual(["response.created", "response.output_item.added", "response.content_part.added"]);
    expect(streamed.at(-1).response.output.map((item: any) => item.type)).toEqual(["message"]);
  });
});

describe("Chat modalities", () => {
  it("returns message.images as data URLs", async () => {
    const d = dirs();
    process.env.FAKE_ACP_IMAGE_GEN = "codex";
    const base = await start(d, [codex(d)]);
    const result = await send(base, "/v1/chat/completions", chat(CODEX_MODEL, { modalities: ["text", "image"] }));
    expect(result.status).toBe(200);
    const message = result.body.choices[0].message;
    expect(message.content).toBe("Here is your image.");
    expect(message.images).toHaveLength(1);
    expect(message.images[0]).toMatchObject({ index: 0, type: "image_url" });
    expect(message.images[0].image_url.url.startsWith(`data:image/png;base64,${PNG_START}`)).toBe(true);
    expect(readdirSync(path.join(d.codexHome, "generated_images"))).toEqual([]);
  });

  it("streams the images in a delta before the finish chunk", async () => {
    const d = dirs();
    Object.assign(process.env, { FAKE_ACP_AGY: "1", FAKE_ACP_IMAGE_GEN: "agy" });
    const base = await start(d, [agy(d)]);
    const result = await send(base, "/v1/chat/completions", chat(AGY_MODEL, { stream: true, modalities: ["image", "text"] }));
    const chunks = sse(result.raw);
    const withImages = chunks.filter((chunk) => chunk.choices?.[0]?.delta?.images);
    expect(withImages).toHaveLength(1);
    expect(withImages[0].choices[0].delta.images[0].image_url.url.startsWith(`data:image/jpeg;base64,${JPEG_START}`)).toBe(true);
    expect(chunks.at(-1).choices[0].finish_reason).toBe("stop");
    expect(chunks.indexOf(withImages[0])).toBe(chunks.length - 2);
  });

  it("accepts only text and image, ignores a text-only list, and answers model_not_capable", async () => {
    const d = dirs();
    process.env.FAKE_ACP_IMAGE_GEN = "codex";
    const base = await start(d, [codex(d), claudeLike(d)]);
    const audio = await send(base, "/v1/chat/completions", chat(CODEX_MODEL, { modalities: ["text", "audio"] }));
    expect(audio.status).toBe(400);
    expect(audio.body.error).toMatchObject({ code: "unsupported_parameter", param: "modalities" });
    const textOnly = await send(base, "/v1/chat/completions", chat(CODEX_MODEL, { modalities: ["text"] }));
    expect(textOnly.status).toBe(200);
    expect(textOnly.body.choices[0].message).not.toHaveProperty("images");
    const notCapable = await send(base, "/v1/chat/completions", chat("claude/haiku", { modalities: ["text", "image"] }));
    expect(notCapable.status).toBe(400);
    expect(notCapable.body.error).toMatchObject({ code: "model_not_capable" });
  });
});

describe("request parsing", () => {
  it("normalizes the three request kinds", async () => {
    expect(normalizeImageGeneration({ model: "m", prompt: "p", size: "1792x1024" }, () => true).conversation[0]!.parts[0]).toEqual({ type: "text", text: "Generate an image: p\nAspect ratio: 7:4 (requested size 1792x1024)." });
    expect((await normalizeChat({ model: "gpt-6-luna", messages: [{ role: "user", content: "x" }], modalities: ["image"] })).generateImages).toBe(true);
    expect((await normalizeChat({ model: "gpt-6-luna", messages: [{ role: "user", content: "x" }] })).generateImages).toBe(false);
    expect((await normalizeResponses({ model: "gpt-6-luna", input: "x", tools: [{ type: "image_generation", partial_images: 0 }] })).generateImages).toBe(true);
    await expect(normalizeResponses({ model: "gpt-6-luna", input: "x", tools: [{ type: "image_generation" }], parallel_tool_calls: true })).rejects.toMatchObject({ param: "parallel_tool_calls" });
  });

  it("keeps the plain prompt byte for byte and swaps only the preamble for an image request", () => {
    const messages = [textMessage("user", "hi")];
    expect(buildPrompt(messages, undefined, "extra")).toEqual([{ type: "text", text: `${PLAIN_PREAMBLE}\nextra\n\n[user]\nhi` }]);
    expect(buildPrompt(messages, undefined, "extra", false)).toEqual(buildPrompt(messages, undefined, "extra"));
    const generating = buildPrompt(messages, undefined, "extra", true);
    expect(generating).toHaveLength(1);
    expect((generating[0] as { text: string }).text).toBe("This is an API request that allows one generated image. If the request asks for an image, use your image generation tool once. Do not use any other tool, run commands, access files, or ask for other permissions. Respond with a short text answer only.\n\n[user]\nhi");
  });
});

