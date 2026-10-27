import fsp from "node:fs/promises";
import path from "node:path";

/** Image inputs: `data:` URL decoding, guarded `http(s)` downloads, local files and magic-byte checks. Agents only ever get base64 data, never a URI. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const IMAGE_DOWNLOAD_TIMEOUT_MS = 15_000;
export const MAX_IMAGE_REDIRECTS = 3;
export const IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;

export interface LoadedImage { mimeType: string; data: string; }
/** `unsupported_content`: a type the proxy does not accept; `invalid_image_url`: a URL or body that cannot be used; `path_not_allowed`: a file path the proxy refuses to touch (relative, UNC or device); `invalid_image_path`: a file that is missing, unreadable, too large or not an image. */
export class ImageError extends Error {
  constructor(message: string, public readonly code: "unsupported_content" | "invalid_image_url" | "path_not_allowed" | "invalid_image_path") { super(message); this.name = "ImageError"; }
}

const unsupported = (message: string) => new ImageError(message, "unsupported_content");
const invalid = (message: string) => new ImageError(message, "invalid_image_url");
const tooLarge = () => invalid(`The image is larger than ${MAX_IMAGE_BYTES / (1024 * 1024)} MB.`);

/** The image type named by the first bytes, or undefined when it is not PNG, JPEG, GIF or WebP. */
export function sniffImage(bytes: Uint8Array): (typeof IMAGE_MIME_TYPES)[number] | undefined {
  const at = (offset: number, text: string) => text.length + offset <= bytes.length && [...text].every((char, index) => bytes[offset + index] === char.charCodeAt(0));
  if (bytes.length >= 8 && bytes[0] === 0x89 && at(1, "PNG\r\n") && bytes[6] === 0x1a && bytes[7] === 0x0a) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (at(0, "GIF87a") || at(0, "GIF89a")) return "image/gif";
  if (at(0, "RIFF") && at(8, "WEBP")) return "image/webp";
  return undefined;
}

function checkedImage(bytes: Uint8Array, declared?: string): LoadedImage {
  if (bytes.length > MAX_IMAGE_BYTES) throw tooLarge();
  const mimeType = sniffImage(bytes);
  if (!mimeType) throw unsupported("Only PNG, JPEG, GIF and WebP images are supported (the image content is none of them).");
  if (declared && declared !== mimeType) throw unsupported(`The image content is ${mimeType}, not the declared ${declared}.`);
  return { mimeType, data: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64") };
}

export function decodeDataUrl(url: string): LoadedImage {
  const comma = url.indexOf(",");
  if (comma < 0) throw invalid("The data URL is malformed.");
  const [rawType = "", ...params] = url.slice(5, comma).split(";");
  if (params[params.length - 1]?.toLowerCase() !== "base64") throw unsupported("Only base64 data URLs are supported.");
  const declared = rawType.trim().toLowerCase().replace(/^image\/jpg$/, "image/jpeg");
  if (!(IMAGE_MIME_TYPES as readonly string[]).includes(declared)) throw unsupported(`The image type '${rawType || "(none)"}' is not supported; use PNG, JPEG, GIF or WebP.`);
  let payload = url.slice(comma + 1);
  if (payload.includes("%")) { try { payload = decodeURIComponent(payload); } catch { throw invalid("The data URL is malformed."); } }
  payload = payload.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(payload)) throw invalid("The data URL is not valid base64.");
  if (Math.floor((payload.length * 3) / 4) > MAX_IMAGE_BYTES + 3) throw tooLarge();
  return checkedImage(Buffer.from(payload, "base64"), declared);
}

async function readCapped(response: Response): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) return Buffer.from(await response.arrayBuffer());
  const chunks: Buffer[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_IMAGE_BYTES) { await reader.cancel().catch(() => undefined); throw tooLarge(); }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/** Downloads an image from an http(s) URL: manual redirects (at most 3, http(s) only), 15 s overall, `image/*` only, at most 10 MB. Only an Accept header is sent. */
export async function downloadImage(url: string, fetchImpl: typeof fetch = fetch): Promise<LoadedImage> {
  const signal = AbortSignal.timeout(IMAGE_DOWNLOAD_TIMEOUT_MS);
  let current: URL;
  try { current = new URL(url); } catch { throw invalid("The image URL is malformed."); }
  try {
    for (let hops = 0; ; hops++) {
      if (current.protocol !== "http:" && current.protocol !== "https:") throw invalid("Image URLs must use http, https or data.");
      const response = await fetchImpl(current.href, { redirect: "manual", signal, headers: { accept: IMAGE_MIME_TYPES.join(",") } });
      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location) {
        await response.body?.cancel().catch(() => undefined);
        if (hops >= MAX_IMAGE_REDIRECTS) throw invalid(`The image URL redirects more than ${MAX_IMAGE_REDIRECTS} times.`);
        try { current = new URL(location, current); } catch { throw invalid("The image URL redirects to a malformed URL."); }
        continue;
      }
      if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw invalid(`The image could not be downloaded (HTTP ${response.status}).`); }
      const type = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
      if (!type.startsWith("image/")) { await response.body?.cancel().catch(() => undefined); throw unsupported(`The URL did not return an image (content type '${type || "none"}').`); }
      if (Number(response.headers.get("content-length") ?? 0) > MAX_IMAGE_BYTES) { await response.body?.cancel().catch(() => undefined); throw tooLarge(); }
      return checkedImage(await readCapped(response));
    }
  } catch (error) {
    if (error instanceof ImageError) throw error;
    throw invalid(`The image could not be downloaded: ${signal.aborted ? "timed out" : error instanceof Error ? error.message : String(error)}.`);
  }
}

export async function loadImage(url: string, fetchImpl?: typeof fetch): Promise<LoadedImage> {
  if (/^data:/i.test(url)) return decodeDataUrl(url);
  return downloadImage(url, fetchImpl);
}

const notAllowed = (message: string) => new ImageError(message, "path_not_allowed");
const badPath = (message: string) => new ImageError(message, "invalid_image_path");

/**
 * Throws `path_not_allowed` unless `file` is an absolute path on a local drive: relative paths, UNC and device paths (anything that starts with two slashes or two backslashes, such as \\?\C:\x, \\.\pipe\x or \\server\share) and, on Windows, paths without a drive letter or with a stream name are refused.
 * Nothing touches the file system here, so a crafted path cannot make Windows reach out to a network share. The messages never quote the path.
 */
export function checkAbsolutePath(file: unknown): asserts file is string {
  if (typeof file !== "string" || !file || file.length > 4096 || file.includes("\0")) throw notAllowed("The path must be a non-empty absolute path.");
  if (/^[\\/]{2}/.test(file)) throw notAllowed("UNC and device paths are not accepted.");
  if (!path.isAbsolute(file)) throw notAllowed("The path must be absolute.");
  if (process.platform === "win32" && (!/^[A-Za-z]:[\\/]/.test(file) || file.indexOf(":", 2) >= 0)) throw notAllowed("The path must start with a drive letter (for example C:\\) and hold no stream name.");
}

/**
 * Reads an image from a file path the caller named: absolute local paths only (`checkAbsolutePath`), then `realpath`, a regular file of at most 10 MB (checked before anything is read), and the magic-byte check.
 * Errors: `path_not_allowed` for the path itself, `invalid_image_path` for everything else, with generic messages that never quote the path or the content.
 */
export async function loadImageFile(file: string): Promise<LoadedImage> {
  checkAbsolutePath(file);
  let real: string;
  try {
    real = await fsp.realpath(file);
    const info = await fsp.stat(real);
    if (!info.isFile()) throw badPath("The path is not a file.");
    if (info.size > MAX_IMAGE_BYTES) throw badPath(`The image file is larger than ${MAX_IMAGE_BYTES / (1024 * 1024)} MB.`);
  } catch (error) { throw error instanceof ImageError ? error : badPath("The image file was not found or cannot be read."); }
  let bytes: Buffer;
  try {
    const handle = await fsp.open(real, "r");
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_IMAGE_BYTES) throw badPath("The image file was not found or cannot be read.");
      bytes = Buffer.alloc(info.size);
      let filled = 0;
      while (filled < bytes.length) {
        const { bytesRead } = await handle.read(bytes, filled, bytes.length - filled, filled);
        if (!bytesRead) break;
        filled += bytesRead;
      }
      bytes = bytes.subarray(0, filled);
    } finally { await handle.close().catch(() => undefined); }
  } catch (error) { throw error instanceof ImageError ? error : badPath("The image file was not found or cannot be read."); }
  try { return checkedImage(bytes); }
  catch { throw badPath("The file is not a PNG, JPEG, GIF or WebP image."); }
}
