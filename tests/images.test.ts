import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import fsp from "node:fs/promises";
import { createServer as createHttpServer, request as httpRequest, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { spawn } from "node:child_process";
import readline from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AcpProvider } from "../src/acp-provider.js";
import { buildPrompt, serializePrompt, textMessage, type Message } from "../src/api.js";
import { loadConfig, type ProxyConfig } from "../src/config.js";
import { ImageError, loadImageFile, MAX_IMAGE_BYTES, sniffImage } from "../src/images.js";
import { defaultRuntimeContext, type ProviderDescriptor } from "../src/provider.js";
import { createProxyServer } from "../src/server.js";

const fixture = fileURLToPath(new URL("./fixtures/fake-acp.mjs", import.meta.url));
const workRoot = path.resolve(".claude/temp/image-tests");
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const png = Buffer.from(PNG_B64, "base64");
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("JFIF-test-image-bytes")]);
const gif = Buffer.from("GIF89a-test-image-bytes");
const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.from([4, 0, 0, 0]), Buffer.from("WEBPVP8 ")]);
const dataUrl = (type: string, bytes: Buffer) => `data:${type};base64,${bytes.toString("base64")}`;
const user = (...parts: Message["parts"]): Message => ({ role: "user", parts });
const image = (bytes: Buffer, mimeType = "image/png"): Message["parts"][number] => ({ type: "image", mimeType, data: bytes.toString("base64") });
const big = (bytes: number) => Buffer.concat([png, Buffer.alloc(bytes - png.length)]);
const PREAMBLE = "This is a text-only API request. Do not use tools, run commands, access files, or ask for permissions. Respond with the answer only.";

const servers: Server[] = [];
const providers: AcpProvider[] = [];
beforeEach(() => { mkdirSync(workRoot, { recursive: true }); });
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); })));
  await Promise.all(providers.splice(0).map((provider) => provider.close()));
  for (const key of Object.keys(process.env).filter((name) => name.startsWith("FAKE_ACP_"))) delete process.env[key];
});

function descriptor(): ProviderDescriptor {
  return { id: "fake", displayName: "Fake", ownedBy: "fake-co", exposeUnprefixed: false, authMode: "on-demand", readOnlyMode: "optional", launch: () => ({ command: process.execPath, args: [fixture], env: { ...process.env } }), chooseAuth: () => undefined };
}
function makeProvider(reuseSessions = false): AcpProvider {
  const provider = new AcpProvider(descriptor(), defaultRuntimeContext(), { workRoot, reuseSessions });
  providers.push(provider);
  return provider;
}
function logFile(): string { const file = path.join(workRoot, `img-${process.pid}-${Math.random().toString(36).slice(2)}.log`); rmSync(file, { force: true }); process.env.FAKE_ACP_LOG = file; return file; }
const readLog = (file: string) => readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { method: string; params: Record<string, any> });
const prompts = (file: string) => readLog(file).filter((entry) => entry.method === "session/prompt").map((entry) => entry.params.prompt as Array<Record<string, any>>);

async function startProxy(provider: AcpProvider, config: Partial<ProxyConfig> = {}, fetchImpl?: typeof fetch): Promise<string> {
  const full: ProxyConfig = { host: "127.0.0.1", port: 0, maxBodyBytes: 20 * 1024 * 1024, timeoutMs: 20_000, workRoot, acpArgs: [], apiKey: "secret", ...config };
  const server = createProxyServer(full, { hasModel: () => true, generate: (model, messages, callbacks, signal, options) => provider.generate(model, messages, callbacks, signal, options) }, fetchImpl ? { fetch: fetchImpl } : {});
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function post(base: string, route: string, body: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(`${base}${route}`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer secret", "x-client-header": "secret-client" }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
const chat = (content: unknown, extra: Record<string, unknown> = {}) => ({ model: "gpt-6-luna", messages: [{ role: "user", content }], ...extra });
const responses = (content: unknown, extra: Record<string, unknown> = {}) => ({ model: "gpt-6-luna", input: [{ role: "user", content }], ...extra });
const text = (value: string) => ({ type: "text", text: value });
const imageUrl = (url: string) => ({ type: "image_url", image_url: { url, detail: "low" } });

describe("image helpers", () => {
  it("recognises PNG, JPEG, GIF and WebP by their first bytes only", () => {
    expect([png, jpeg, gif, webp].map((bytes) => sniffImage(bytes))).toEqual(["image/png", "image/jpeg", "image/gif", "image/webp"]);
    expect(sniffImage(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeUndefined();
    expect(sniffImage(Buffer.from("RIFF....WAVE"))).toBeUndefined();
    expect(sniffImage(Buffer.alloc(0))).toBeUndefined();
  });

  it("lays the prompt out as text and image blocks, and keeps a text-only prompt as one block", () => {
    const messages: Message[] = [user({ type: "text", text: "look" }, image(png), image(jpeg, "image/jpeg")), { role: "assistant", parts: [{ type: "text", text: "a dot" }] }, user({ type: "text", text: "and this" }, image(gif, "image/gif"))];
    const blocks = buildPrompt(messages, "be brief", "extra line");
    expect(blocks.map((block) => block.type)).toEqual(["text", "image", "image", "text", "image", "text"]);
    expect(blocks[0]).toEqual({ type: "text", text: `This is an API request with text and images. Do not use tools, run commands, access files, or ask for permissions. Respond with the answer only.\nextra line\n\n[user]\nlook` });
    expect(blocks[1]).toEqual({ type: "image", mimeType: "image/png", data: PNG_B64 });
    expect(blocks[3]).toEqual({ type: "text", text: "[assistant]\na dot\n\n[user]\nand this" });
    expect(blocks[5]).toEqual({ type: "text", text: "[output format]\nbe brief" });
    expect(serializePrompt(messages)).toContain("[user]\nand this");
    expect(buildPrompt([textMessage("system", "s"), textMessage("user", "u")], "fmt")).toEqual([{ type: "text", text: `${PREAMBLE}\n\n[system]\ns\n\n[user]\nu\n\n[output format]\nfmt` }]);
  });
});

describe("fake agent image switch", () => {
  it("fails -32602 on an image block without data", async () => {
    const child = spawn(process.execPath, [fixture], { env: { ...process.env, FAKE_ACP_IMAGE: "1" }, stdio: ["pipe", "pipe", "inherit"] });
    try {
      const lines = readline.createInterface({ input: child.stdout })[Symbol.asyncIterator]();
      const ask = async (id: number, method: string, params: unknown) => { child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); const { value } = await lines.next(); return JSON.parse(value as string); };
      expect((await ask(1, "initialize", { protocolVersion: 1 })).result.agentCapabilities.promptCapabilities).toEqual({ image: true });
      const session = (await ask(2, "session/new", { cwd: workRoot, mcpServers: [] })).result.sessionId;
      const reply = await ask(3, "session/prompt", { sessionId: session, prompt: [{ type: "text", text: "x" }, { type: "image", mimeType: "image/png", uri: "file:///x.png" }] });
      expect(reply.error).toMatchObject({ code: -32602 });
    } finally { child.kill(); }
  });
});

describe("image input through the proxy", () => {
  it("sends a chat data URL to the agent as a base64 data block with no uri", async () => {
    process.env.FAKE_ACP_IMAGE = "1";
    const log = logFile();
    const base = await startProxy(makeProvider());
    const result = await post(base, "/v1/chat/completions", chat([text("What is in this image?"), imageUrl(dataUrl("image/png", png))]));
    expect(result.status).toBe(200);
    expect(result.body.choices[0].message.content).toBe("fake response images:1");
    const [blocks] = prompts(log);
    expect(blocks!.map((block) => block.type)).toEqual(["text", "image"]);
    expect(blocks![0]!.text).toContain("[user]\nWhat is in this image?");
    expect(blocks![1]).toEqual({ type: "image", mimeType: "image/png", data: PNG_B64 });
    expect(blocks![1]).not.toHaveProperty("uri");
  });

  it("downloads an http image itself, sends no client headers, follows at most 3 redirects, and ignores the declared type for the real one", async () => {
    process.env.FAKE_ACP_IMAGE = "1";
    const hits: Array<{ url: string; headers: IncomingHttpHeaders }> = [];
    const host = createHttpServer((request, response) => {
      const url = request.url ?? "";
      hits.push({ url, headers: request.headers });
      const redirect = (to: string) => { response.writeHead(302, { location: to }); response.end(); };
      if (url === "/img.png") { response.writeHead(200, { "content-type": "image/jpeg" }); response.end(png); }
      else if (url === "/r/1") redirect("/r/2"); else if (url === "/r/2") redirect("/r/3"); else if (url === "/r/3") redirect("/img.png");
      else if (url === "/l/1") redirect("/l/2"); else if (url === "/l/2") redirect("/l/3"); else if (url === "/l/3") redirect("/l/4"); else if (url === "/l/4") redirect("/img.png");
      else if (url === "/to-file") redirect("file:///etc/passwd");
      else { response.writeHead(404); response.end(); }
    });
    servers.push(host);
    await new Promise<void>((resolve) => host.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(host.address() as AddressInfo).port}`;
    const log = logFile();
    const base = await startProxy(makeProvider());
    const ok = await post(base, "/v1/chat/completions", chat([imageUrl(`${origin}/r/1`)]));
    expect(ok.status).toBe(200);
    expect(ok.body.choices[0].message.content).toBe("fake response images:1");
    expect(prompts(log)[0]![1]).toEqual({ type: "image", mimeType: "image/png", data: PNG_B64 });
    expect(hits.map((hit) => hit.url)).toEqual(["/r/1", "/r/2", "/r/3", "/img.png"]);
    for (const hit of hits) { expect(hit.headers.authorization).toBeUndefined(); expect(hit.headers["x-client-header"]).toBeUndefined(); }
    for (const url of [`${origin}/l/1`, `${origin}/to-file`, `${origin}/missing`, "http://127.0.0.1:1/never"]) {
      const rejected = await post(base, "/v1/chat/completions", chat([imageUrl(url)]));
      expect(rejected.status, url).toBe(400);
      expect(rejected.body.error).toMatchObject({ code: "invalid_image_url", param: "messages" });
    }
    expect(prompts(log)).toHaveLength(1);
  });

  it("rejects downloads that are not images or are over 10 MB", async () => {
    process.env.FAKE_ACP_IMAGE = "1";
    const host = createHttpServer((request, response) => {
      const url = request.url ?? "";
      if (url === "/page") { response.writeHead(200, { "content-type": "text/html" }); response.end("<html></html>"); }
      else if (url === "/fake.png") { response.writeHead(200, { "content-type": "image/png" }); response.end("this is not a png"); }
      else if (url === "/svg") { response.writeHead(200, { "content-type": "image/svg+xml" }); response.end("<svg xmlns='http://www.w3.org/2000/svg'/>"); }
      else if (url === "/big") { const body = big(MAX_IMAGE_BYTES + 1); response.writeHead(200, { "content-type": "image/png", "content-length": String(body.length) }); response.end(body); }
      else if (url === "/big-chunked") { response.writeHead(200, { "content-type": "image/png" }); const body = big(MAX_IMAGE_BYTES + 1); for (let at = 0; at < body.length; at += 1 << 20) response.write(body.subarray(at, at + (1 << 20))); response.end(); }
      else if (url === "/exact") { response.writeHead(200, { "content-type": "image/png" }); response.end(big(MAX_IMAGE_BYTES)); }
      else { response.writeHead(404); response.end(); }
    });
    servers.push(host);
    await new Promise<void>((resolve) => host.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(host.address() as AddressInfo).port}`;
    const base = await startProxy(makeProvider());
    for (const [route, code] of [["/page", "unsupported_content"], ["/fake.png", "unsupported_content"], ["/svg", "unsupported_content"], ["/big", "invalid_image_url"], ["/big-chunked", "invalid_image_url"]] as const) {
      const result = await post(base, "/v1/chat/completions", chat([imageUrl(`${origin}${route}`)]));
      expect(result.status, route).toBe(400);
      expect(result.body.error.code, route).toBe(code);
    }
    expect((await post(base, "/v1/chat/completions", chat([imageUrl(`${origin}/exact`)]))).status).toBe(200);
  });

  it("uses the supplied fetch (the runtime context's) for downloads", async () => {
    process.env.FAKE_ACP_IMAGE = "1";
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fake = (async (url: string | URL | Request, init?: RequestInit) => { calls.push({ url: String(url), init }); return new Response(png, { headers: { "content-type": "image/png" } }); }) as typeof fetch;
    const base = await startProxy(makeProvider(), {}, fake);
    const result = await post(base, "/v1/chat/completions", chat([imageUrl("https://images.example/cat.png")]));
    expect(result.status).toBe(200);
    expect(calls.map((call) => call.url)).toEqual(["https://images.example/cat.png"]);
    expect(calls[0]!.init?.redirect).toBe("manual");
    expect(Object.keys(calls[0]!.init?.headers as Record<string, string>)).toEqual(["accept"]);
  });

  it("rejects a bad type, a type that does not match the bytes, and non-base64 data URLs with 400", async () => {
    process.env.FAKE_ACP_IMAGE = "1";
    const log = logFile();
    const base = await startProxy(makeProvider());
    const cases: Array<[string, string, string]> = [
      ["svg", dataUrl("image/svg+xml", Buffer.from("<svg/>")), "unsupported_content"],
      ["text type", dataUrl("text/plain", png), "unsupported_content"],
      ["bad magic", dataUrl("image/png", Buffer.from("definitely not a png")), "unsupported_content"],
      ["mismatch", dataUrl("image/png", jpeg), "unsupported_content"],
      ["not base64", `data:image/png,${encodeURIComponent("\u0089PNG")}`, "unsupported_content"],
      ["bad alphabet", "data:image/png;base64,@@@@", "invalid_image_url"],
      ["no comma", "data:image/png;base64", "invalid_image_url"],
      ["ftp", "ftp://example.com/a.png", "invalid_image_url"],
    ];
    for (const [name, url, code] of cases) {
      const result = await post(base, "/v1/chat/completions", chat([imageUrl(url)]));
      expect(result.status, name).toBe(400);
      expect(result.body.error, name).toMatchObject({ code, param: "messages" });
    }
    const jpg = await post(base, "/v1/chat/completions", chat([imageUrl(dataUrl("image/jpg", jpeg))]));
    expect(jpg.status).toBe(200);
    expect(prompts(log)).toHaveLength(1);
  });

  it("rejects a data URL image over 10 MB with 400", async () => {
    process.env.FAKE_ACP_IMAGE = "1";
    const base = await startProxy(makeProvider());
    const result = await post(base, "/v1/chat/completions", chat([imageUrl(dataUrl("image/png", big(MAX_IMAGE_BYTES + 1)))]));
    expect(result.status).toBe(400);
    expect(result.body.error).toMatchObject({ code: "invalid_image_url", param: "messages" });
    expect(result.body.error.message).toMatch(/10 MB/);
  });

  it("rejects file_id, other part types and images outside user messages with 400 unsupported_content", async () => {
    process.env.FAKE_ACP_IMAGE = "1";
    const base = await startProxy(makeProvider());
    const bad: Array<[string, string, unknown, string]> = [
      ["responses file_id image", "/v1/responses", responses([{ type: "input_image", file_id: "file-abc" }]), "input"],
      ["responses input_file", "/v1/responses", responses([{ type: "input_file", file_id: "file-abc" }]), "input"],
      ["responses unknown", "/v1/responses", responses([{ type: "input_audio", data: "AAAA" }]), "input"],
      ["chat file", "/v1/chat/completions", chat([{ type: "file", file: { file_id: "file-abc" } }]), "messages"],
      ["chat input_audio", "/v1/chat/completions", chat([{ type: "input_audio", input_audio: { data: "AAAA", format: "wav" } }]), "messages"],
      ["chat image with file_id", "/v1/chat/completions", chat([{ type: "image_url", file_id: "file-abc", image_url: { url: dataUrl("image/png", png) } }]), "messages"],
      ["chat responses-type part", "/v1/chat/completions", chat([{ type: "input_image", image_url: dataUrl("image/png", png) }]), "messages"],
      ["image in assistant", "/v1/chat/completions", { model: "gpt-6-luna", messages: [{ role: "assistant", content: [imageUrl(dataUrl("image/png", png))] }, { role: "user", content: "hi" }] }, "messages"],
      ["image in system", "/v1/chat/completions", { model: "gpt-6-luna", messages: [{ role: "system", content: [imageUrl(dataUrl("image/png", png))] }, { role: "user", content: "hi" }] }, "messages"],
    ];
    for (const [name, route, body, param] of bad) {
      const result = await post(base, route, body);
      expect(result.status, name).toBe(400);
      expect(result.body.error, name).toMatchObject({ code: "unsupported_content", param });
    }
  });

  it("rejects images for an agent without the image capability with 400, not 503", async () => {
    const provider = makeProvider();
    const log = logFile();
    const base = await startProxy(provider);
    const result = await post(base, "/v1/chat/completions", chat([imageUrl(dataUrl("image/png", png))]));
    expect(result.status).toBe(400);
    expect(result.body.error).toMatchObject({ code: "unsupported_content", param: "messages" });
    expect(provider.status().capabilities).toEqual({ image: false });
    const viaResponses = await post(base, "/v1/responses", responses([{ type: "input_image", image_url: dataUrl("image/png", png) }]));
    expect(viaResponses.status).toBe(400);
    expect(viaResponses.body.error).toMatchObject({ code: "unsupported_content", param: "input" });
    expect(prompts(log)).toHaveLength(0);
    const plain = await post(base, "/v1/chat/completions", chat("hello"));
    expect(plain.status).toBe(200);
    expect(plain.body.choices[0].message.content).toBe("fake response");
  });

  it("reports the image capability in the provider status", async () => {
    process.env.FAKE_ACP_IMAGE = "1";
    const provider = makeProvider();
    expect(provider.status().capabilities).toBeUndefined();
    await provider.generate("gpt-6-luna", [textMessage("user", "hi")]);
    expect(provider.status().capabilities).toEqual({ image: true });
  });

  it("accepts Responses input_text, output_text and input_image parts, with the instructions kept as the system message", async () => {
    process.env.FAKE_ACP_IMAGE = "1";
    const log = logFile();
    const base = await startProxy(makeProvider());
    const result = await post(base, "/v1/responses", {
      model: "gpt-6-luna",
      instructions: "be terse",
      input: [
        { role: "user", content: [{ type: "input_text", text: "first" }] },
        { role: "assistant", content: [{ type: "output_text", text: "earlier answer" }] },
        { role: "user", content: [{ type: "input_text", text: "what is this?" }, { type: "input_image", image_url: dataUrl("image/png", png), detail: "high" }, { type: "text", text: "(plain text part)" }] },
      ],
    });
    expect(result.status).toBe(200);
    expect(result.body.output[0].content[0].text).toBe("fake response images:1");
    const [blocks] = prompts(log);
    expect(blocks!.map((block) => block.type)).toEqual(["text", "image"]);
    expect(blocks![0]!.text).toContain("[system]\nbe terse\n\n[user]\nfirst\n\n[assistant]\nearlier answer\n\n[user]\nwhat is this?(plain text part)");
    expect(blocks![1]).toEqual({ type: "image", mimeType: "image/png", data: PNG_B64 });
    const stream = await fetch(`${base}/v1/responses`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer secret" }, body: JSON.stringify({ model: "gpt-6-luna", stream: true, input: [{ role: "user", content: [{ type: "input_image", image_url: dataUrl("image/png", png) }] }] }) });
    expect(await stream.text()).toContain("fake response images:1");
  });

  it("keeps a text-only request's prompt byte-identical: one text block", async () => {
    process.env.FAKE_ACP_IMAGE = "1";
    const log = logFile();
    const base = await startProxy(makeProvider());
    const result = await post(base, "/v1/chat/completions", { model: "gpt-6-luna", messages: [{ role: "system", content: "be concise" }, { role: "user", content: [{ type: "text", text: "hel" }, { type: "text", text: "lo" }] }] });
    expect(result.status).toBe(200);
    expect(prompts(log)).toEqual([[{ type: "text", text: `${PREAMBLE}\n\n[system]\nbe concise\n\n[user]\nhello` }]]);
    const json = await post(base, "/v1/responses", { model: "gpt-6-luna", input: "hi", text: { format: { type: "json_object" } } });
    expect(json.status).toBe(200);
    expect(prompts(log)[1]).toEqual([{ type: "text", text: `${PREAMBLE}\n\n[user]\nhi\n\n[output format]\nRespond with a single valid JSON value only: no prose, no explanations, no Markdown code fences.` }]);
  });

  it("still answers 413 above the new 20 MiB default body limit, and accepts a 2 MiB body", async () => {
    expect(loadConfig({}).maxBodyBytes).toBe(20 * 1024 * 1024);
    process.env.FAKE_ACP_IMAGE = "1";
    const base = await startProxy(makeProvider(), { maxBodyBytes: loadConfig({}).maxBodyBytes });
    const ok = await post(base, "/v1/chat/completions", chat("x".repeat(2 * 1024 * 1024)));
    expect(ok.status).toBe(200);
    const body = JSON.stringify(chat("x".repeat(21 * 1024 * 1024)));
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(`${base}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer secret", "content-length": Buffer.byteLength(body) } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on("error", (error) => { if ((error as NodeJS.ErrnoException).code !== "ECONNRESET" && (error as NodeJS.ErrnoException).code !== "EPIPE") reject(error); });
      req.end(body);
    });
    expect(status).toBe(413);
  });
});

describe("image input with session reuse", () => {
  const model = "gpt-6-luna";
  const methodCount = (file: string, method: string) => readLog(file).filter((entry) => entry.method === method).length;
  const turn = (picture: Buffer, answer: string, next: Buffer | undefined): Message[] => [
    user({ type: "text", text: "describe" }, image(picture)),
    { role: "assistant", parts: [{ type: "text", text: answer }] },
    user({ type: "text", text: "and now?" }, ...(next ? [image(next)] : [])),
  ];

  it("continues the kept session when the same image comes back, and sends only the new messages", async () => {
    process.env.FAKE_ACP_IMAGE = "1";
    const log = logFile();
    const provider = makeProvider(true);
    const first = await provider.generate(model, [user({ type: "text", text: "describe" }, image(png))]);
    expect(first.text).toBe("fake response images:1");
    const kept = (provider as unknown as { kept: Array<{ transcript: unknown }> }).kept;
    expect(kept).toHaveLength(1);
    expect(JSON.stringify(kept[0]!.transcript)).not.toContain(PNG_B64);
    expect(JSON.stringify(kept[0]!.transcript)).toMatch(/[0-9a-f]{64}/);
    const second = await provider.generate(model, turn(png, first.text, jpeg));
    expect(second.text).toBe("fake response images:1");
    expect(methodCount(log, "session/new")).toBe(1);
    const sent = prompts(log);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.map((block) => block.type)).toEqual(["text", "image"]);
    expect(sent[1]![0]!.text).toContain("[user]\nand now?");
    expect(sent[1]![0]!.text).not.toContain("describe");
    expect(sent[1]![1]!.data).toBe(jpeg.toString("base64"));
  });

  it("starts a new session when a past image differs", async () => {
    process.env.FAKE_ACP_IMAGE = "1";
    const log = logFile();
    const provider = makeProvider(true);
    const first = await provider.generate(model, [user({ type: "text", text: "describe" }, image(png))]);
    const second = await provider.generate(model, turn(jpeg, first.text, undefined));
    expect(second.text).toBe("fake response images:1");
    expect(methodCount(log, "session/new")).toBe(2);
    const sent = prompts(log);
    expect(sent[1]!.map((block) => block.type)).toEqual(["text", "image", "text"]);
    expect(sent[1]![1]!.data).toBe(jpeg.toString("base64"));
  });

  it("does not match a history where an image was dropped or added", async () => {
    process.env.FAKE_ACP_IMAGE = "1";
    const log = logFile();
    const provider = makeProvider(true);
    const first = await provider.generate(model, [textMessage("user", "describe")]);
    await provider.generate(model, turn(png, first.text, undefined));
    expect(methodCount(log, "session/new")).toBe(2);
  });
});

describe("loadImageFile", () => {
  const dir = path.join(workRoot, `files-${process.pid}`);
  const file = (name: string, bytes: Buffer | string): string => { const target = path.join(dir, name); writeFileSync(target, bytes); return target; };
  beforeEach(() => { mkdirSync(dir, { recursive: true }); });
  afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

  it("reads PNG, JPEG, GIF and WebP files with the type named by their bytes", async () => {
    for (const [name, bytes, mimeType] of [["a.png", png, "image/png"], ["b.jpg", jpeg, "image/jpeg"], ["c.gif", gif, "image/gif"], ["d.webp", webp, "image/webp"], ["noext", png, "image/png"], ["wrong.jpg", png, "image/png"]] as const) {
      const loaded = await loadImageFile(file(name, bytes));
      expect(loaded).toEqual({ mimeType, data: bytes.toString("base64") });
    }
    expect((await loadImageFile(file("fwd.png", png).replaceAll("\\", "/"))).mimeType).toBe("image/png");
  });

  it("rejects a directory, a missing file and a non-image with invalid_image_path and a message that never quotes content or the path", async () => {
    mkdirSync(path.join(dir, "folder.png"), { recursive: true });
    const text = file("secret.png", "TOPSECRET=1\n");
    for (const target of [path.join(dir, "folder.png"), path.join(dir, "missing.png"), text]) {
      const error = await loadImageFile(target).then(() => undefined, (failure: unknown) => failure);
      expect(error).toBeInstanceOf(ImageError);
      expect((error as ImageError).code).toBe("invalid_image_path");
      expect((error as ImageError).message).not.toContain("TOPSECRET");
      expect((error as ImageError).message).not.toContain(dir);
      expect((error as ImageError).message).not.toContain("secret.png");
    }
  });

  it("checks the size before reading: a file over 10 MB is rejected without being opened", async () => {
    const target = file("huge.png", big(MAX_IMAGE_BYTES + 1));
    const open = vi.spyOn(fsp, "open");
    const readFile = vi.spyOn(fsp, "readFile");
    const error = await loadImageFile(target).then(() => undefined, (failure: unknown) => failure) as ImageError;
    expect(error.code).toBe("invalid_image_path");
    expect(error.message).toContain("10 MB");
    expect(open).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
    expect((await loadImageFile(file("max.png", big(MAX_IMAGE_BYTES)))).mimeType).toBe("image/png");
  });

  it("rejects relative, UNC and device paths as path_not_allowed before touching the file system", async () => {
    const spies = (["realpath", "stat", "open", "lstat"] as const).map((name) => vi.spyOn(fsp, name));
    for (const bad of ["a.png", "./a.png", "\\\\server\\share\\a.png", "//server/share/a.png", "\\\\?\\C:\\a.png", "\\\\.\\pipe\\a", "\\a.png", "C:a.png", ""]) {
      const error = await loadImageFile(bad).then(() => undefined, (failure: unknown) => failure);
      expect(error, bad).toBeInstanceOf(ImageError);
      expect((error as ImageError).code, bad).toBe("path_not_allowed");
      expect((error as ImageError).message).not.toContain("server");
    }
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});
