import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import fsp from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP } from "node:net";
import path from "node:path";
import { AcpUnavailableError, type AcpLike, type GenerationResult } from "./acp.js";
import type { ActivityEntry, ActivityFeature, ActivityLog } from "./activity.js";
import { ApiError, imageGenerationText, serializePrompt, textMessage, type Message, type Part } from "./api.js";
import type { ProxyConfig } from "./config.js";
import { checkAbsolutePath, decodeDataUrl, IMAGE_MIME_TYPES, ImageError, loadImage, loadImageFile, sniffImage, type LoadedImage } from "./images.js";
import { openAiUsage } from "./usage.js";

/** The MCP endpoint `POST /v1/mcp` (Streamable HTTP, stateless): tools to ask another model, with images, and to generate images. Hand-written JSON-RPC, like the tool bridge. */

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const DEFAULT_KEEPALIVE_MS = 20_000;
const MAX_THREADS = 32;
const THREAD_IDLE_MS = 60 * 60 * 1000;
const THREAD_MAX_IMAGES = 16;
const THREAD_MAX_IMAGE_BYTES = 64 * 1024 * 1024;
const STORE_MAX_IMAGE_BYTES = 256 * 1024 * 1024;
const ASK_MAX_IMAGES = 8;
const GENERATE_MAX_IMAGES = 4;
const RESULT_MAX_IMAGES = 4;
const INLINE_CAP_BYTES = 3 * 1024 * 1024;
const KEEP_FILES = 100;
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const FILE_NAME_MAX = 80;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const SAVED_NAME = /^img-\d{8}-\d{6}-[0-9a-f]{6}\.(png|jpg|gif|webp)$/;
const EXTENSIONS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

const INSTRUCTIONS = "ACP Proxy lets you ask other models (Codex, Claude, Antigravity) from this session. Call list_models first to see the model ids and what each can do (images in, image generation, web search). Use ask_model for a text answer from another model; it is read-only and sees only the prompt and images you give it, so paste the code or context it needs into the prompt and pass screenshots as images: [{ path }] (an absolute path on this machine). Continue a conversation with the thread_id ask_model returns. Use generate_image to have a model draw a picture: it saves the file and returns its path (pass save_to to choose the folder).";

/** Reads the server's own version (package.json next to src/ and dist/); a packaged app without it says 0.1.0. */
function packageVersion(): string {
  try {
    const raw = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown };
    return typeof raw.version === "string" ? raw.version : "0.1.0";
  } catch { return "0.1.0"; }
}

// --- shapes -------------------------------------------------------------------------------------------------------------------

type ImageItem = { kind: "path"; path: string } | { kind: "url"; url: string } | { kind: "data"; data: string; mimeType: string };
interface AskArgs { model: string; prompt: string; system?: string; threadId?: string; webSearch: boolean; images: ImageItem[]; }
interface GenerateArgs { model: string; prompt: string; text: string; images: ImageItem[]; saveTo?: string; fileName?: string; returnImage: boolean; }
type ContentBlock = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
interface ToolOutput { content: ContentBlock[]; structuredContent?: Record<string, unknown>; isError?: true; }
interface Failure { code: string; status: number; message: string; }
/** A listed model: the router also says which provider it belongs to. */
interface Listed { id: string; provider?: string; ownedBy?: string; }
interface Trace { model?: string; features: Set<ActivityFeature>; inputTokens?: number; outputTokens?: number; }

/** A bad argument shape: a JSON-RPC `-32602` error (never a tool result). The message names fields only, never values. */
class InvalidParams extends Error {}
/** A failure the model should see: a tool result with `isError`. */
class McpToolError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); this.name = "McpToolError"; }
}
class Aborted extends Error {}

export interface McpEndpointOptions {
  config: ProxyConfig;
  bridge: AcpLike;
  /** Downloads http(s) image URLs (default: the global fetch). */
  fetch?: typeof fetch;
  /** One entry per `ask_model` / `generate_image` call. */
  activity?: ActivityLog;
  /** Where `generate_image` saves an image when the caller names no folder. */
  imageDir: string;
  /** Whether the caller is on this machine (default: the socket's address is loopback). Local paths are only accepted from local callers. */
  isLocalCaller?: (request: IncomingMessage) => boolean;
  keepaliveMs?: number;
  /** A thread that has been idle this long is dropped (default 1 hour). */
  threadIdleMs?: number;
  /** The image bytes (decoded) the whole thread store may hold (default 256 MB). */
  maxStoreImageBytes?: number;
  now?: () => number;
}
/** The knobs of the endpoint that tests turn (everything else is fixed). */
export type McpEndpointTuning = Pick<McpEndpointOptions, "keepaliveMs" | "threadIdleMs" | "maxStoreImageBytes" | "now">;

// --- helpers ------------------------------------------------------------------------------------------------------------------

const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function sendJson(response: ServerResponse, status: number, payload?: unknown, headers: Record<string, string> = {}): void {
  if (payload === undefined) { response.writeHead(status, headers).end(); return; }
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers }).end(JSON.stringify(payload));
}

/** True for `127.0.0.0/8`, `::1` and the IPv4-mapped forms of 127.x.x.x. */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const value = address.toLowerCase();
  if (value === "::1") return true;
  const mapped = /^::ffff:(.+)$/.exec(value);
  if (mapped) {
    const rest = mapped[1]!;
    if (isIP(rest) === 4) return rest.startsWith("127.");
    return /^7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(rest);
  }
  return isIP(value) === 4 && value.startsWith("127.");
}

/** An `Origin` is fine when it is a loopback name, or the very host the request was sent to and that host is an IP address (a DNS name there would be a rebinding page). */
function originAllowed(origin: string, host: string | undefined): boolean {
  let parsed: URL;
  try { parsed = new URL(origin); } catch { return false; }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (LOOPBACK_HOSTS.has(parsed.hostname)) return true;
  return host !== undefined && parsed.host.toLowerCase() === host.toLowerCase() && isIP(parsed.hostname.replace(/^\[|\]$/g, "")) !== 0;
}

function decodedSize(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

const megabytes = (bytes: number): string => bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

function finishReason(stopReason: GenerationResult["stopReason"]): string {
  switch (stopReason) {
    case "max_tokens": case "max_turn_requests": return "length";
    case "refusal": return "content_filter";
    case "tool_calls": return "tool_calls";
    default: return "stop";
  }
}

function toFailure(error: unknown): Failure {
  if (error instanceof McpToolError) return { code: error.code, status: error.status, message: error.message };
  if (error instanceof ImageError) return { code: error.code, status: 400, message: error.message };
  if (error instanceof ApiError) return { code: error.code, status: error.status, message: error.message };
  if (error instanceof AcpUnavailableError) return { code: error.code ?? "backend_unavailable", status: 503, message: error.message };
  return { code: "internal_error", status: 500, message: "The call failed unexpectedly." };
}

const failureResult = (failure: Failure): ToolOutput => ({ content: [{ type: "text", text: `${failure.code}: ${failure.message}` }], isError: true });

/** Rejects as soon as the signal aborts, even when the generation itself never answers. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) { promise.catch(() => undefined); reject(new Aborted()); return; }
    const onAbort = () => reject(new Aborted());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then((value) => { signal.removeEventListener("abort", onAbort); resolve(value); }, (error) => { signal.removeEventListener("abort", onAbort); reject(error); });
  });
}

// --- tool definitions ---------------------------------------------------------------------------------------------------------

const imageItemSchema = {
  type: "object",
  description: "One image: exactly one of path, url or data (data needs mime_type).",
  properties: {
    path: { type: "string", description: "Absolute path to a PNG, JPEG, GIF or WebP file on the machine the proxy runs on (callers on that machine only; at most 10 MB)." },
    url: { type: "string", description: "An http(s) URL the proxy downloads, or a base64 data: URL." },
    data: { type: "string", description: "Base64 image bytes (not a data: URL); needs mime_type." },
    mime_type: { type: "string", enum: [...IMAGE_MIME_TYPES], description: "The type of data." },
  },
  additionalProperties: false,
};

const usageSchema = { type: "object", properties: { input_tokens: { type: "number" }, output_tokens: { type: "number" } }, required: ["input_tokens", "output_tokens"] };

const TOOLS = [
  {
    name: "list_models",
    title: "List models",
    description: "List the models you can ask, with the provider and what each can do: image input (images in), image generation, web search. Call this first; pick a model with image_generation for generate_image and one with image_input (or unknown) for ask_model with images.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: {
      type: "object",
      properties: { models: { type: "array", items: { type: "object", properties: { id: { type: "string" }, provider: { type: "string" }, aliases: { type: "array", items: { type: "string" } }, capabilities: { type: "object", properties: { image_input: { type: ["boolean", "null"] }, image_generation: { type: "boolean" }, web_search: { type: "boolean" } }, required: ["image_input", "image_generation", "web_search"] } }, required: ["id", "provider", "aliases", "capabilities"] } } },
      required: ["models"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "ask_model",
    title: "Ask a model",
    description: "Ask another model a question and get its text answer. The model is read-only: it sees only the prompt and the images you pass, never your files or repository, so paste the code or context it needs into prompt and pass screenshots as images (for example [{ \"path\": \"C:\\\\Users\\\\me\\\\shot.png\" }]). Use a model id from list_models. The answer comes with a thread_id; pass it back to continue the conversation. To make an image, use generate_image instead.",
    inputSchema: {
      type: "object",
      properties: {
        model: { type: "string", description: "A model id from list_models." },
        prompt: { type: "string", description: "The message to send." },
        system: { type: "string", description: "System instructions; only taken on the first turn of a thread." },
        thread_id: { type: "string", description: "Continue an earlier conversation (the thread_id of a previous answer); the same model is required." },
        web_search: { type: "boolean", description: "Let the model search the web (only models that list web_search).", default: false },
        images: { type: "array", maxItems: ASK_MAX_IMAGES, items: imageItemSchema, description: `Images for the model to look at (at most ${ASK_MAX_IMAGES}); the model needs image_input in list_models.` },
      },
      required: ["model", "prompt"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: { answer: { type: "string" }, model: { type: "string" }, thread_id: { type: "string" }, finish_reason: { type: "string" }, usage: usageSchema },
      required: ["answer", "model", "thread_id", "finish_reason", "usage"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "generate_image",
    title: "Generate an image",
    description: "Have a model draw an image. Use a model that lists image_generation in list_models. The proxy saves the image as a new file and returns its path (and the image itself when it is at most 3 MB): pass save_to (an existing folder, for example your repo's assets folder) to choose where, otherwise it goes to the proxy's own folder; then copy or move it where you need it. Reference images (images) are given to the model next to the prompt; it decides how to use them. One image per call; it takes 20 to 40 seconds. Saving only works for callers on the machine the proxy runs on; other callers get the image inline.",
    inputSchema: {
      type: "object",
      properties: {
        model: { type: "string", description: "A model id with image_generation in list_models." },
        prompt: { type: "string", description: "What to draw." },
        images: { type: "array", maxItems: GENERATE_MAX_IMAGES, items: imageItemSchema, description: `Reference images (at most ${GENERATE_MAX_IMAGES}).` },
        size: { type: "string", description: "WIDTHxHEIGHT (for example 1536x1024) or auto; becomes an aspect ratio hint." },
        save_to: { type: "string", description: "Absolute path of an existing folder to save the image into (callers on the proxy's machine only)." },
        file_name: { type: "string", description: "The file's base name (only with save_to); other characters than letters, digits, . _ - are replaced, the extension is chosen from the image." },
        return_image: { type: "boolean", description: "Also return the image itself (default true; skipped above 3 MB).", default: true },
      },
      required: ["model", "prompt"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        model: { type: "string" },
        images: { type: "array", items: { type: "object", properties: { path: { type: "string" }, mime_type: { type: "string" }, bytes: { type: "number" }, inline: { type: "boolean" }, revised_prompt: { type: "string" }, save_error: { type: "string" } }, required: ["mime_type", "bytes", "inline"] } },
        usage: usageSchema,
      },
      required: ["model", "images", "usage"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
];

// --- argument validation ------------------------------------------------------------------------------------------------------

function str(args: Record<string, unknown>, name: string, required: boolean): string | undefined {
  const value = args[name];
  if (value === undefined || value === null) { if (required) throw new InvalidParams(`'${name}' is required.`); return undefined; }
  if (typeof value !== "string" || (required && !value.trim())) throw new InvalidParams(`'${name}' must be ${required ? "a non-empty " : "a "}string.`);
  return value;
}

function bool(args: Record<string, unknown>, name: string): boolean | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new InvalidParams(`'${name}' must be a boolean.`);
  return value;
}

function parseImages(args: Record<string, unknown>, max: number): ImageItem[] {
  const value = args.images;
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new InvalidParams("'images' must be an array.");
  if (value.length > max) throw new InvalidParams(`'images' holds at most ${max} images.`);
  return value.map((raw, index): ImageItem => {
    const where = `images[${index}]`;
    if (!isObject(raw)) throw new InvalidParams(`${where} must be an object.`);
    const given = (["path", "url", "data"] as const).filter((key) => raw[key] !== undefined && raw[key] !== null);
    if (given.length !== 1) throw new InvalidParams(`${where} needs exactly one of path, url or data.`);
    const key = given[0]!;
    if (typeof raw[key] !== "string" || !(raw[key] as string).length) throw new InvalidParams(`${where}.${key} must be a non-empty string.`);
    const mimeType = raw.mime_type;
    if (mimeType !== undefined && mimeType !== null && key !== "data") throw new InvalidParams(`${where}.mime_type goes with data only.`);
    if (key === "path") return { kind: "path", path: raw.path as string };
    if (key === "url") return { kind: "url", url: raw.url as string };
    if (typeof mimeType !== "string" || !/^[A-Za-z0-9.+/-]{1,100}$/.test(mimeType)) throw new InvalidParams(`${where}.mime_type is required with data (image/png, image/jpeg, image/gif or image/webp).`);
    return { kind: "data", data: raw.data as string, mimeType };
  });
}

function asObject(args: unknown): Record<string, unknown> {
  if (args === undefined || args === null) return {};
  if (!isObject(args)) throw new InvalidParams("'arguments' must be an object.");
  return args;
}

function parseAsk(raw: unknown): AskArgs {
  const args = asObject(raw);
  const system = str(args, "system", false);
  const threadId = str(args, "thread_id", false);
  return { model: str(args, "model", true)!, prompt: str(args, "prompt", true)!, ...(system !== undefined ? { system } : {}), ...(threadId ? { threadId } : {}), webSearch: bool(args, "web_search") === true, images: parseImages(args, ASK_MAX_IMAGES) };
}

function parseGenerate(raw: unknown): GenerateArgs {
  const args = asObject(raw);
  const prompt = str(args, "prompt", true)!;
  const size = str(args, "size", false);
  let text: string;
  try { text = imageGenerationText(prompt, size); } catch (error) { if (error instanceof ApiError) throw new InvalidParams("'size' must be auto or WIDTHxHEIGHT, for example 1024x1024."); throw error; }
  const saveTo = str(args, "save_to", false);
  const fileName = str(args, "file_name", false);
  if (fileName !== undefined && saveTo === undefined) throw new InvalidParams("'file_name' needs 'save_to'.");
  return { model: str(args, "model", true)!, prompt, text, images: parseImages(args, GENERATE_MAX_IMAGES), ...(saveTo !== undefined ? { saveTo } : {}), ...(fileName !== undefined ? { fileName } : {}), returnImage: bool(args, "return_image") !== false };
}

// --- threads ------------------------------------------------------------------------------------------------------------------

interface Thread { model: string; messages: Message[]; imageCount: number; imageBytes: number; lastUsed: number; seq: number; busy: boolean; }

/** The conversations of `ask_model`, in memory only: 32 at most (the least recently used goes first), dropped after an hour idle, with caps on the image data they keep. */
class ThreadStore {
  private readonly threads = new Map<string, Thread>();
  private seq = 0;

  constructor(private readonly now: () => number, private readonly idleMs: number, private readonly maxStoreImageBytes: number) {}

  private sweep(): void {
    const now = this.now();
    for (const [id, thread] of this.threads) if (!thread.busy && now - thread.lastUsed > this.idleMs) this.threads.delete(id);
  }

  /** The thread for a follow-up call, marked busy until `release`; a tool error for an unknown, expired, busy or other-model thread. */
  acquire(id: string, model: string): Thread {
    this.sweep();
    const thread = this.threads.get(id);
    if (!thread) throw new McpToolError("thread_not_found", "The thread does not exist or has expired; start a new conversation (omit thread_id).", 404);
    if (thread.model !== model) throw new McpToolError("thread_model_mismatch", "A thread belongs to the model it was started with; use that model or start a new conversation.");
    if (thread.busy) throw new McpToolError("thread_busy", "Another call on this thread is still running; wait for it or start a new conversation.", 409);
    thread.busy = true;
    return thread;
  }

  release(thread: Thread): void { thread.busy = false; }

  /** Throws `thread_too_large` when the new images do not fit the thread's caps. */
  checkRoom(thread: Thread | undefined, count: number, bytes: number): void {
    if ((thread?.imageCount ?? 0) + count > THREAD_MAX_IMAGES || (thread?.imageBytes ?? 0) + bytes > THREAD_MAX_IMAGE_BYTES) throw new McpToolError("thread_too_large", "This conversation holds too many images; start a new conversation (omit thread_id).");
  }

  /** Stores the conversation after a successful turn (a new thread when `thread` is undefined) and returns its id; then enforces the caps by dropping the least recently used other threads. */
  commit(thread: Thread | undefined, existingId: string | undefined, model: string, messages: Message[], count: number, bytes: number): string {
    const id = existingId ?? `thr_${randomBytes(12).toString("hex")}`;
    const target: Thread = thread ?? { model, messages: [], imageCount: 0, imageBytes: 0, lastUsed: 0, seq: 0, busy: false };
    target.messages = messages;
    target.imageCount += count;
    target.imageBytes += bytes;
    target.lastUsed = this.now();
    target.seq = ++this.seq;
    this.threads.set(id, target);
    this.enforce(id);
    return id;
  }

  /** Drops the least recently used threads other than `keep` until the caps hold. */
  private enforce(keep: string): void {
    const others = (): Array<[string, Thread]> => [...this.threads].filter(([id, thread]) => id !== keep && !thread.busy).sort((a, b) => a[1].seq - b[1].seq);
    while (this.threads.size > MAX_THREADS) { const oldest = others()[0]; if (!oldest) break; this.threads.delete(oldest[0]); }
    const total = () => [...this.threads.values()].reduce((sum, thread) => sum + thread.imageBytes, 0);
    while (total() > this.maxStoreImageBytes) { const oldest = others()[0]; if (!oldest) break; this.threads.delete(oldest[0]); }
  }

  clear(): void { this.threads.clear(); }
}

// --- saving generated images ----------------------------------------------------------------------------------------------------

const stamp = (date: Date): string => {
  const two = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}-${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`;
};

/** The base name for `file_name`: only letters, digits, `.`, `_` and `-` (others become `-`), no extension, no leading or trailing dot, at most 80 characters; undefined when nothing is left. A name whose part before the first dot is a Windows device name (`con.x.y`, `NUL.tar.gz`) gets an `img-` prefix, because Win32 opens such a file as the device. */
function safeBaseName(name: string): string | undefined {
  const base = name.replace(/[^A-Za-z0-9._-]/g, "-").replace(/\.[A-Za-z0-9]{1,5}$/, "").replace(/^\.+/, "").replace(/\.+$/, "").slice(0, FILE_NAME_MAX);
  if (!base) return undefined;
  return /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(base.split(".")[0] ?? "") ? `img-${base}` : base;
}

/** A reason for a failed write that holds no path. */
function writeReason(error: unknown): string {
  switch ((error as NodeJS.ErrnoException)?.code) {
    case "ENOSPC": return "the disk is full";
    case "EACCES": case "EPERM": return "permission denied";
    case "ENOENT": case "ENOTDIR": return "the folder does not exist";
    case "EEXIST": return "the target already exists";
    default: return "the file could not be written";
  }
}

/** Writes `bytes` as a new file (never overwrites): `<dir>/<name>.<ext>`, and `<name>-<6 hex>.<ext>` when that exists. */
async function writeNewFile(dir: string, name: string, extension: string, bytes: Buffer, randomSuffix: boolean): Promise<{ file: string; renamed: boolean }> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const suffix = randomSuffix || attempt > 0 ? `-${randomBytes(3).toString("hex")}` : "";
    const file = path.join(dir, `${name}${suffix}.${extension}`);
    try { await fsp.writeFile(file, bytes, { flag: "wx" }); return { file, renamed: attempt > 0 }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  throw Object.assign(new Error("no free file name"), { code: "EEXIST" });
}

/** Keeps the newest 100 of the proxy's own `img-*` files in `dir` and drops those older than 7 days (regular files only, nothing else is touched, never `keep`). Best effort. */
async function cleanImageDir(dir: string, keep: string): Promise<void> {
  try {
    const files: Array<{ name: string; time: number }> = [];
    for (const name of (await fsp.readdir(dir)).filter((entry) => SAVED_NAME.test(entry))) {
      try { const info = await fsp.lstat(path.join(dir, name)); if (info.isFile()) files.push({ name, time: info.mtimeMs }); } catch { /* gone already */ }
    }
    files.sort((a, b) => b.time - a.time || (a.name < b.name ? 1 : -1));
    const now = Date.now();
    await Promise.all(files.filter((file, index) => file.name !== keep && (index >= KEEP_FILES || now - file.time > KEEP_MS)).map((file) => fsp.unlink(path.join(dir, file.name)).catch(() => undefined)));
  } catch { /* the folder is gone: nothing to clean */ }
}

// --- the endpoint -------------------------------------------------------------------------------------------------------------

/** The SSE answer of one `tools/call`: keepalive comments, optional progress notifications, then one `message` event with the result. */
class CallStream {
  private timer?: NodeJS.Timeout;
  private count = 0;

  constructor(private readonly response: ServerResponse, private readonly rpcId: unknown, private readonly progressToken: string | number | undefined, private readonly keepaliveMs: number) {}

  private get open(): boolean { return !this.response.writableEnded && !this.response.destroyed; }

  start(): void {
    this.response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    this.response.write(": keepalive\n\n");
    this.timer = setInterval(() => { if (!this.open) return; this.response.write(": keepalive\n\n"); this.progress(); }, this.keepaliveMs);
    this.timer.unref?.();
  }

  /** A `notifications/progress` event (only when the caller sent a progress token). */
  progress(): void {
    if (this.progressToken === undefined || !this.open) return;
    this.response.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: this.progressToken, progress: ++this.count } })}\n\n`);
  }

  stop(): void { if (this.timer) clearInterval(this.timer); }

  finish(result: ToolOutput): void {
    this.stop();
    if (this.open) this.response.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: this.rpcId, result })}\n\n`);
  }

  /** Ends the stream without a result (the call was cancelled). */
  abandon(): void { this.stop(); if (this.open) this.response.end(); }
}

interface CallContext { request: IncomingMessage; signal: AbortSignal; local: boolean; trace: Trace; timedOut(): boolean; onText(): void; }

export class McpEndpoint {
  private readonly threads: ThreadStore;
  private readonly inflight = new Map<string, AbortController>();
  private readonly keepaliveMs: number;
  private readonly isLocal: (request: IncomingMessage) => boolean;
  private readonly version = packageVersion();

  constructor(private readonly options: McpEndpointOptions) {
    this.threads = new ThreadStore(options.now ?? Date.now, options.threadIdleMs ?? THREAD_IDLE_MS, options.maxStoreImageBytes ?? STORE_MAX_IMAGE_BYTES);
    this.keepaliveMs = options.keepaliveMs ?? DEFAULT_KEEPALIVE_MS;
    this.isLocal = options.isLocalCaller ?? ((request) => isLoopbackAddress(request.socket.remoteAddress));
  }

  /** Aborts the calls in flight and forgets every thread (the server is closing). */
  close(): void {
    for (const controller of this.inflight.values()) controller.abort();
    this.inflight.clear();
    this.threads.clear();
  }

  /** Routes one request of `/v1/mcp` (the key was checked already). */
  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try { await this.route(request, response); }
    catch { if (!response.headersSent) sendJson(response, 500, rpcError(null, -32603, "Internal error")); else if (!response.writableEnded) response.end(); }
  }

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const origin = request.headers.origin;
    if (origin !== undefined && !originAllowed(origin, request.headers.host)) { sendJson(response, 403, rpcError(null, -32600, "Forbidden origin.")); return; }
    const method = request.method || "GET";
    if (method !== "POST") { sendJson(response, 405, undefined, { Allow: "POST" }); return; }
    const type = (request.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
    if (type !== "application/json") { sendJson(response, 415, rpcError(null, -32600, "Content-Type must be application/json.")); return; }
    let body: unknown;
    try { body = await this.readBody(request); }
    catch (error) {
      if (error instanceof McpToolError) { sendJson(response, error.status, rpcError(null, -32600, error.message)); return; }
      sendJson(response, 400, rpcError(null, -32700, "Parse error")); return;
    }
    if (!Array.isArray(body) && isObject(body) && body.method === "tools/call" && body.id !== undefined && body.id !== null) { await this.toolCall(request, response, body); return; }
    const messages = Array.isArray(body) ? body : [body];
    if (!messages.length) { sendJson(response, 400, rpcError(null, -32600, "Invalid Request")); return; }
    const replies = (await Promise.all(messages.map(async (message): Promise<unknown> => {
      if (!isObject(message)) return rpcError(null, -32600, "Invalid Request");
      if (message.method === "tools/call") return message.id === undefined || message.id === null ? undefined : rpcError(message.id, -32600, "tools/call cannot be sent in a batch");
      return await this.reply(request, message);
    }))).filter((reply) => reply !== undefined);
    if (!replies.length) sendJson(response, 202);
    else sendJson(response, 200, Array.isArray(body) ? replies : replies[0]);
  }

  private async readBody(request: IncomingMessage): Promise<unknown> {
    const limit = this.options.config.maxBodyBytes;
    if (Number(request.headers["content-length"] || 0) > limit) throw new McpToolError("request_too_large", "Request body exceeds the configured limit.", 413);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      size += Buffer.byteLength(chunk);
      if (size > limit) throw new McpToolError("request_too_large", "Request body exceeds the configured limit.", 413);
      chunks.push(Buffer.from(chunk));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }

  /** One JSON-RPC message that is not a `tools/call`; undefined for a notification. */
  private async reply(request: IncomingMessage, message: Record<string, unknown>): Promise<unknown> {
    if (message.id === undefined || message.id === null) {
      if (message.method === "notifications/cancelled" && isObject(message.params)) this.cancel(request, message.params.requestId);
      return undefined;
    }
    if (typeof message.method !== "string") return undefined;
    const id = message.id;
    const params = isObject(message.params) ? message.params : {};
    switch (message.method) {
      case "initialize": {
        const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
        return { jsonrpc: "2.0", id, result: { protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0], capabilities: { tools: {} }, serverInfo: { name: "acp-proxy", version: this.version }, instructions: INSTRUCTIONS } };
      }
      case "ping": return { jsonrpc: "2.0", id, result: {} };
      case "tools/list": return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
      default: return rpcError(id, -32601, `Method not found: ${message.method}`);
    }
  }

  private cancelKey(request: IncomingMessage, id: unknown): string { return `${request.socket.remoteAddress ?? ""}|${typeof id}|${String(id)}`; }

  private cancel(request: IncomingMessage, id: unknown): void {
    if (typeof id !== "string" && typeof id !== "number") return;
    this.inflight.get(this.cancelKey(request, id))?.abort();
  }

  // --- tools/call -------------------------------------------------------------------------------------------------------------

  private async toolCall(request: IncomingMessage, response: ServerResponse, message: Record<string, unknown>): Promise<void> {
    const rpcId = message.id;
    const params = isObject(message.params) ? message.params : {};
    const tool = TOOLS.find((entry) => entry.name === params.name);
    if (!tool) { sendJson(response, 200, rpcError(rpcId, -32602, "Unknown tool.")); return; }
    let asked: AskArgs | undefined;
    let generated: GenerateArgs | undefined;
    try {
      if (tool.name === "ask_model") asked = parseAsk(params.arguments);
      else if (tool.name === "generate_image") generated = parseGenerate(params.arguments);
    } catch (error) {
      if (error instanceof InvalidParams) { sendJson(response, 200, rpcError(rpcId, -32602, error.message)); return; }
      throw error;
    }
    if (tool.name === "list_models") {
      let result: ToolOutput;
      try { result = await this.listModels(); } catch { result = failureResult({ code: "internal_error", status: 500, message: "The model list could not be read." }); }
      sendJson(response, 200, { jsonrpc: "2.0", id: rpcId, result });
      return;
    }
    const progressToken = isObject(params._meta) && (typeof params._meta.progressToken === "string" || typeof params._meta.progressToken === "number") ? params._meta.progressToken : undefined;
    await this.runCall(request, response, rpcId, progressToken, tool.name as "ask_model" | "generate_image", asked, generated);
  }

  private async runCall(request: IncomingMessage, response: ServerResponse, rpcId: unknown, progressToken: string | number | undefined, tool: "ask_model" | "generate_image", asked?: AskArgs, generated?: GenerateArgs): Promise<void> {
    const started = Date.now();
    const trace: Trace = { features: new Set() };
    const images = (asked ?? generated)!.images;
    if (images.length) trace.features.add("images");
    if (tool === "generate_image") trace.features.add("imageGeneration");
    if (asked?.webSearch) trace.features.add("search");

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.options.config.timeoutMs);
    const key = this.cancelKey(request, rpcId);
    this.inflight.set(key, controller);
    const stream = new CallStream(response, rpcId, progressToken, this.keepaliveMs);
    stream.start();
    response.once("close", () => { if (!response.writableEnded) controller.abort(); });

    let output: ToolOutput | undefined;
    let failure: Failure | undefined;
    let cancelled = false;
    let firstText = true;
    const context: CallContext = { request, signal: controller.signal, local: this.isLocal(request), trace, timedOut: () => timedOut, onText: () => { if (firstText) { firstText = false; stream.progress(); } } };
    try {
      output = tool === "ask_model" ? await this.ask(asked!, context) : await this.generate(generated!, context);
    } catch (error) {
      if (timedOut) failure = { code: "request_timeout", status: 504, message: "The request exceeded the configured timeout." };
      else if (controller.signal.aborted) cancelled = true;
      else failure = toFailure(error);
    } finally {
      clearTimeout(timer);
      if (this.inflight.get(key) === controller) this.inflight.delete(key);
    }
    const status = cancelled ? 499 : failure?.status ?? 200;
    const code = cancelled ? "cancelled" : failure?.code;
    if (cancelled) stream.abandon(); else stream.finish(failure ? failureResult(failure) : output!);
    this.record(tool, started, trace, status, code);
  }

  /** One entry in the activity log: metadata only (never a prompt, a path, a file name or an image). */
  private record(tool: string, started: number, trace: Trace, status: number, error?: string): void {
    const activity = this.options.activity;
    if (!activity) return;
    const provider = trace.model ? this.options.bridge.providerOf?.(trace.model) : undefined;
    const entry: ActivityEntry = {
      time: started, endpoint: `MCP ${tool}`, stream: false, features: [...trace.features], durationMs: Date.now() - started, status,
      ...(trace.model ? { model: trace.model } : {}), ...(provider ? { provider } : {}), ...(error ? { error } : {}),
      ...(trace.inputTokens !== undefined ? { inputTokens: trace.inputTokens } : {}), ...(trace.outputTokens !== undefined ? { outputTokens: trace.outputTokens } : {}),
    };
    try { activity.record(entry); } catch { /* a listener of the log must not break the call */ }
  }

  // --- models -----------------------------------------------------------------------------------------------------------------

  /** The listed models once each: an id that is the unprefixed form of `<provider>/<id>` of the same provider is an alias of that one. */
  private async modelList(): Promise<Array<{ id: string; provider: string; aliases: string[]; capabilities: { image_input: boolean | null; image_generation: boolean; web_search: boolean } }>> {
    const { bridge } = this.options;
    const entries: Listed[] = bridge.listModels ? await bridge.listModels() : [];
    const providerOf = (entry: Listed): string => entry.provider ?? bridge.providerOf?.(entry.id) ?? entry.ownedBy ?? "unknown";
    const byId = new Map(entries.map((entry): [string, Listed] => [entry.id, entry]));
    const aliasOwner = new Map<string, string>();
    for (const entry of entries) {
      const slash = entry.id.indexOf("/");
      if (slash <= 0) continue;
      const raw = entry.id.slice(slash + 1);
      const other = byId.get(raw);
      if (other && providerOf(other) === providerOf(entry)) aliasOwner.set(raw, entry.id);
    }
    return entries.filter((entry) => !aliasOwner.has(entry.id)).map((entry) => ({
      id: entry.id,
      provider: providerOf(entry),
      aliases: [...aliasOwner].filter(([, owner]) => owner === entry.id).map(([alias]) => alias),
      capabilities: { image_input: bridge.acceptsImages?.(entry.id) ?? null, image_generation: bridge.canGenerateImages?.(entry.id) === true, web_search: bridge.canSearchWeb?.(entry.id) === true },
    }));
  }

  private async listModels(): Promise<ToolOutput> {
    const models = await this.modelList();
    const lines = models.map((model) => {
      const can: string[] = [];
      if (model.capabilities.image_input === true) can.push("images in");
      else if (model.capabilities.image_input === null) can.push("images in: not known until the provider starts");
      if (model.capabilities.image_generation) can.push("image generation");
      if (model.capabilities.web_search) can.push("web search");
      return `${model.id} (${model.provider}) — ${can.length ? can.join(", ") : "text only"}${model.aliases.length ? ` [also usable as: ${model.aliases.join(", ")}]` : ""}`;
    });
    return { content: [{ type: "text", text: lines.length ? lines.join("\n") : "No models are available yet." }], structuredContent: { models } };
  }

  /** The tool error for an id the bridge does not know, with the listed ids that contain the given text. */
  private async requireModel(model: string): Promise<void> {
    const { bridge } = this.options;
    const known = bridge.hasModel ? bridge.hasModel(model) : bridge.listModels ? (await bridge.listModels()).some((entry) => entry.id === model) : true;
    if (known) return;
    const needle = model.trim().toLowerCase();
    const similar = needle ? (await this.modelList()).filter((entry) => entry.id.toLowerCase().includes(needle) || entry.aliases.some((alias) => alias.toLowerCase().includes(needle))).map((entry) => entry.id).slice(0, 10) : [];
    throw new McpToolError("model_not_found", `The model '${model.slice(0, 100)}' does not exist. ${similar.length ? `Did you mean: ${similar.join(", ")}?` : "Call list_models to see the available models."}`, 404);
  }

  /** " Models that <verb>: a, b." for the listed models that pass `test` (nothing when none does). */
  private async modelsThat(verb: string, test: (id: string) => boolean): Promise<string> {
    const ids = (await this.modelList()).map((entry) => entry.id).filter(test);
    return ids.length ? ` Models that ${verb}: ${ids.join(", ")}.` : "";
  }

  // --- images in --------------------------------------------------------------------------------------------------------------

  private async loadImages(items: ImageItem[], context: CallContext): Promise<{ parts: Part[]; bytes: number }> {
    if (items.some((item) => item.kind === "path") && !context.local) throw new McpToolError("path_not_allowed", "Image paths are only accepted from the machine the proxy runs on; send data or url instead.");
    const loaded = await Promise.all(items.map(async (item): Promise<LoadedImage> => {
      if (item.kind === "path") return await loadImageFile(item.path);
      if (item.kind === "url") return await loadImage(item.url, this.options.fetch);
      return decodeDataUrl(`data:${item.mimeType};base64,${item.data}`);
    }));
    if (context.signal.aborted) throw new Aborted();
    return { parts: loaded.map((image): Part => ({ type: "image", mimeType: image.mimeType, data: image.data })), bytes: loaded.reduce((sum, image) => sum + decodedSize(image.data), 0) };
  }

  // --- ask_model --------------------------------------------------------------------------------------------------------------

  private async ask(args: AskArgs, context: CallContext): Promise<ToolOutput> {
    const { bridge } = this.options;
    await this.requireModel(args.model);
    context.trace.model = args.model;
    const thread = args.threadId ? this.threads.acquire(args.threadId, args.model) : undefined;
    try {
      if (args.webSearch && bridge.canSearchWeb && !bridge.canSearchWeb(args.model)) throw new McpToolError("model_not_capable", `The model '${args.model}' cannot search the web.`);
      if (args.images.length && bridge.acceptsImages?.(args.model) === false) throw new McpToolError("model_not_capable", `The model '${args.model}' does not accept images.${await this.modelsThat("do", (id) => bridge.acceptsImages?.(id) === true)}`);
      const { parts, bytes } = await this.loadImages(args.images, context);
      this.threads.checkRoom(thread, parts.length, bytes);
      const user: Message = { role: "user", parts: [{ type: "text", text: args.prompt }, ...parts] };
      const history = thread ? thread.messages : args.system ? [textMessage("system", args.system)] : [];
      const messages = [...history, user];
      const result = await raceAbort(bridge.generate(args.model, messages, { onText: () => context.onText() }, context.signal, args.webSearch ? { webSearch: {} } : {}), context.signal);
      if (context.signal.aborted) throw new Aborted();
      const usage = openAiUsage(result, serializePrompt(messages));
      context.trace.inputTokens = usage.prompt;
      context.trace.outputTokens = usage.completion;
      const threadId = this.threads.commit(thread, args.threadId, args.model, [...messages, textMessage("assistant", result.text)], parts.length, bytes);
      return {
        content: [{ type: "text", text: result.text }, { type: "text", text: `thread_id: ${threadId} (pass it to continue this conversation)` }],
        structuredContent: { answer: result.text, model: args.model, thread_id: threadId, finish_reason: finishReason(result.stopReason), usage: { input_tokens: usage.prompt, output_tokens: usage.completion } },
      };
    } finally { if (thread) this.threads.release(thread); }
  }

  // --- generate_image ---------------------------------------------------------------------------------------------------------

  /** The folder `save_to` names, resolved: an absolute path of an existing directory. */
  private async saveDirectory(saveTo: string): Promise<string> {
    checkAbsolutePath(saveTo);
    try {
      const real = await fsp.realpath(saveTo);
      if (!(await fsp.stat(real)).isDirectory()) throw new Error("not a directory");
      return real;
    } catch { throw new McpToolError("invalid_save_path", "save_to must be an existing folder (an absolute path)."); }
  }

  private async generate(args: GenerateArgs, context: CallContext): Promise<ToolOutput> {
    const { bridge } = this.options;
    await this.requireModel(args.model);
    context.trace.model = args.model;
    if (bridge.canGenerateImages && !bridge.canGenerateImages(args.model)) throw new McpToolError("model_not_capable", `The model '${args.model}' cannot generate images.${await this.modelsThat("can", (id) => bridge.canGenerateImages?.(id) === true)}`);
    if (args.images.length && bridge.acceptsImages?.(args.model) === false) throw new McpToolError("model_not_capable", `The model '${args.model}' does not accept images, so it cannot take reference images.`);
    if (args.saveTo !== undefined && !context.local) throw new McpToolError("path_not_allowed", "save_to is only accepted from the machine the proxy runs on; the image comes back inline instead.");
    if (args.images.some((item) => item.kind === "path") && !context.local) throw new McpToolError("path_not_allowed", "Image paths are only accepted from the machine the proxy runs on; send data or url instead.");
    const directory = args.saveTo !== undefined ? await this.saveDirectory(args.saveTo) : undefined;
    const { parts } = await this.loadImages(args.images, context);
    const user: Message = { role: "user", parts: [{ type: "text", text: args.text }, ...parts] };
    const result = await raceAbort(bridge.generate(args.model, [user], { onText: () => context.onText() }, context.signal, { images: true }), context.signal);
    if (context.signal.aborted) throw new Aborted();
    const usage = openAiUsage(result, serializePrompt([user]));
    context.trace.inputTokens = usage.prompt;
    context.trace.outputTokens = usage.completion;
    const found: Array<{ bytes: Buffer; mimeType: string; revisedPrompt?: string }> = [];
    for (const image of (result.images ?? []).slice(0, RESULT_MAX_IMAGES)) {
      const bytes = Buffer.from(image.data, "base64");
      const mimeType = sniffImage(bytes);
      if (mimeType) found.push({ bytes, mimeType, ...(image.revisedPrompt ? { revisedPrompt: image.revisedPrompt } : {}) });
    }
    if (!found.length) { const said = result.text.trim().slice(0, 500); throw new McpToolError("no_image_generated", `The agent did not generate an image.${said ? ` It said: ${said}` : ""}`, 502); }

    const content: ContentBlock[] = [];
    const described: Array<Record<string, unknown>> = [];
    const base = args.fileName !== undefined ? safeBaseName(args.fileName) : undefined;
    for (const image of found) {
      if (context.signal.aborted) throw new Aborted();
      const extension = EXTENSIONS[image.mimeType]!;
      const size = megabytes(image.bytes.length);
      let file: string | undefined;
      let saveError: string | undefined;
      let renamed = false;
      if (context.local) {
        try {
          if (directory) ({ file, renamed } = await writeNewFile(directory, base ?? `img-${stamp(new Date())}`, extension, image.bytes, false));
          else {
            const folder = path.resolve(this.options.imageDir);
            await fsp.mkdir(folder, { recursive: true });
            ({ file } = await writeNewFile(folder, `img-${stamp(new Date())}`, extension, image.bytes, true));
            await cleanImageDir(folder, path.basename(file));
          }
        } catch (error) { saveError = `the image could not be saved (${writeReason(error)})`; }
      }
      const inline = saveError !== undefined || !context.local || (args.returnImage && image.bytes.length <= INLINE_CAP_BYTES);
      const lines: string[] = [];
      if (file) lines.push(`Saved ${file} (${image.mimeType}, ${size}).${renamed ? " A file with that name already existed, so a random suffix was added." : ""}${args.returnImage && !inline ? ` It is too large to show inline (${size}); open the file to view it.` : ""}`);
      else if (saveError) lines.push(`Generated an image (${image.mimeType}, ${size}), but ${saveError}; it is returned inline.`);
      else lines.push(`Generated an image (${image.mimeType}, ${size}); it is returned inline.`);
      if (image.revisedPrompt) lines.push(`Revised prompt: ${image.revisedPrompt}`);
      content.push({ type: "text", text: lines.join("\n") });
      if (inline) content.push({ type: "image", data: image.bytes.toString("base64"), mimeType: image.mimeType });
      described.push({ ...(file ? { path: file } : {}), mime_type: image.mimeType, bytes: image.bytes.length, inline, ...(image.revisedPrompt ? { revised_prompt: image.revisedPrompt } : {}), ...(saveError ? { save_error: saveError } : {}) });
    }
    return { content, structuredContent: { model: args.model, images: described, usage: { input_tokens: usage.prompt, output_tokens: usage.completion } } };
  }
}
