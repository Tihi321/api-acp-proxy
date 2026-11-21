import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Unzip, UnzipInflate } from "fflate";

const MAX_REDIRECTS = 5;
const FREE_SPACE_MARGIN = 1024 * 1024 * 1024;

/** Which hosts a download may touch. `hosts` match exactly, `suffixes` (".hf.co") match any subdomain but never the bare suffix text inside another name. `allowHttp` exists for tests only. */
export interface HostPolicy { hosts: readonly string[]; suffixes?: readonly string[]; allowHttp?: boolean }

export type DownloadErrorCode = "download_host_not_allowed" | "download_http_error" | "download_checksum_mismatch" | "download_size_mismatch"
  | "download_cancelled" | "download_disk_space" | "download_busy" | "hf_link_invalid" | "hf_auth_required" | "hf_terms_required" | "hf_not_found"
  | "llama_release_not_found" | "llama_asset_not_found" | "llama_no_digest" | "llama_server_missing" | "llama_build_too_old";

export class DownloadError extends Error {
  constructor(readonly code: DownloadErrorCode, message: string) {
    super(message);
    this.name = "DownloadError";
  }
}

export function assertAllowedUrl(raw: string, policy: HostPolicy): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new DownloadError("download_host_not_allowed", `Invalid download URL: ${raw}`); }
  if (url.protocol !== "https:" && !(policy.allowHttp && url.protocol === "http:")) throw new DownloadError("download_host_not_allowed", `Refusing to download over ${url.protocol.replace(":", "")}; HTTPS is required (${url.origin}).`);
  const host = url.host.toLowerCase();
  const hostname = url.hostname.toLowerCase();
  const exact = policy.hosts.map((entry) => entry.toLowerCase());
  const suffixes = (policy.suffixes ?? []).map((entry) => entry.toLowerCase());
  const allowed = exact.includes(host) || exact.includes(hostname) || suffixes.some((suffix) => hostname.length > suffix.length && hostname.endsWith(suffix));
  if (!allowed) throw new DownloadError("download_host_not_allowed", `Refusing to download from '${url.hostname}': host is not allowed.`);
  return url;
}

interface GuardedInit { signal?: AbortSignal; headers?: Record<string, string>; headersFor?: (url: URL) => Record<string, string> }

/** GET with manual redirects; returns the final response whatever its status. Every hop is checked against the policy before it is requested. */
async function fetchFollowing(fetchImpl: typeof fetch, start: string, policy: HostPolicy, init: GuardedInit | undefined): Promise<{ response: Response; url: URL }> {
  let current = assertAllowedUrl(start, policy);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const headers = { ...(init?.headers ?? {}), ...(init?.headersFor?.(current) ?? {}) };
    const response = await fetchImpl(current.toString(), { redirect: "manual", ...(Object.keys(headers).length ? { headers } : {}), ...(init?.signal ? { signal: init.signal } : {}) });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => undefined);
      if (!location) throw new DownloadError("download_http_error", `Redirect without a location from ${current.toString()}.`);
      current = assertAllowedUrl(new URL(location, current).toString(), policy);
      continue;
    }
    return { response, url: current };
  }
  throw new DownloadError("download_http_error", "Too many redirects.");
}

/** GET with manual redirect handling so every hop is checked against the HTTPS and host rules before it is requested. `headersFor` is evaluated per hop. */
export async function guardedFetch(fetchImpl: typeof fetch, url: string, policy: HostPolicy, init?: { signal?: AbortSignal; headersFor?: (url: URL) => Record<string, string> }): Promise<Response> {
  const { response, url: finalUrl } = await fetchFollowing(fetchImpl, url, policy, init);
  if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw new DownloadError("download_http_error", `Download failed: HTTP ${response.status} from ${finalUrl.host}.`); }
  return response;
}

/** Resolves an archive member name to a path inside `root`, rejecting absolute paths, drive letters and `..` segments (zip-slip). */
export function safeEntryPath(root: string, name: string): string {
  const normalized = name.replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized) || normalized.includes("\0")) throw new Error(`Unsafe path in archive: ${name}`);
  if (normalized.split("/").some((part) => part === "..")) throw new Error(`Unsafe path in archive: ${name}`);
  const target = path.resolve(root, normalized);
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Unsafe path in archive: ${name}`);
  return target;
}

const cancelled = () => new DownloadError("download_cancelled", "The download was cancelled.");

/** Streams `response.body` into `out`, hashing and counting. `hash`/`received` carry bytes that were already on disk. */
async function pump(response: Response, out: fs.WriteStream, hash: ReturnType<typeof createHash>, startBytes: number, total: number | undefined, onProgress: ((received: number, total?: number) => void) | undefined, signal: AbortSignal | undefined): Promise<number> {
  let received = startBytes;
  let lastEmit = 0;
  try {
    if (!response.body) throw new DownloadError("download_http_error", "The download response has no body.");
    const reader = response.body.getReader();
    try {
      for (;;) {
        if (signal?.aborted) throw cancelled();
        const { done, value } = await reader.read();
        if (done) break;
        hash.update(value);
        received += value.length;
        if (!out.write(value)) await new Promise<void>((resolve, reject) => { out.once("drain", resolve); out.once("error", reject); });
        const now = Date.now();
        if (now - lastEmit > 100) { lastEmit = now; onProgress?.(received, total); }
      }
    } catch (error) {
      if (signal?.aborted && !(error instanceof DownloadError)) throw cancelled();
      throw error;
    } finally {
      reader.cancel().catch(() => undefined);
    }
    onProgress?.(received, total ?? received);
  } finally {
    await new Promise<void>((resolve) => out.end(() => resolve()));
  }
  return received;
}

/** Writes a response body to `file`, returning its sha256 and size. */
export async function downloadToFile(response: Response, file: string, opts: { onProgress?(received: number, total?: number): void; signal?: AbortSignal }): Promise<{ sha256: string; bytes: number }> {
  const total = Number(response.headers.get("content-length")) || undefined;
  const hash = createHash("sha256");
  const bytes = await pump(response, fs.createWriteStream(file), hash, 0, total, opts.onProgress, opts.signal);
  return { sha256: hash.digest("hex"), bytes };
}

async function hashFile(file: string, hash: ReturnType<typeof createHash>): Promise<void> {
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Uint8Array);
}

const sizeOf = (file: string) => fsp.stat(file).then((stat) => stat.size, () => 0);

function mapHfStatus(status: number, host: string): DownloadError | undefined {
  if (status === 401) return new DownloadError("hf_auth_required", `Hugging Face needs a token for this file (HTTP 401 from ${host}).`);
  if (status === 403) return new DownloadError("hf_terms_required", `Hugging Face refused access (HTTP 403 from ${host}); accept the model's terms on huggingface.co or check the token.`);
  if (status === 404) return new DownloadError("hf_not_found", `Hugging Face file not found (HTTP 404 from ${host}).`);
  return undefined;
}

/**
 * Download to `<file>.partial`, resuming with `Range` when a partial exists. The URL is re-resolved (redirects included) on every call
 * because signed CDN URLs expire. Cancelling keeps the partial; a size or checksum mismatch deletes it.
 */
export async function downloadResumable(opts: { fetch: typeof fetch; url: string; file: string; policy: HostPolicy; headersFor?: (url: URL) => Record<string, string>; httpCodes?: "hf";
  expectedSize?: number; expectedSha256?: string; signal?: AbortSignal; onProgress?(received: number, total?: number): void }): Promise<{ sha256: string; bytes: number }> {
  const partial = `${opts.file}.partial`;
  await fsp.mkdir(path.dirname(opts.file), { recursive: true });
  let restarted = false;
  for (;;) {
    const existing = await sizeOf(partial);
    const hash = createHash("sha256");
    if (existing > 0) await hashFile(partial, hash);
    let response: Response;
    let finalUrl: URL;
    try {
      ({ response, url: finalUrl } = await fetchFollowing(opts.fetch, opts.url, opts.policy, { ...(opts.signal ? { signal: opts.signal } : {}), ...(existing > 0 ? { headers: { Range: `bytes=${existing}-` } } : {}), ...(opts.headersFor ? { headersFor: opts.headersFor } : {}) }));
    } catch (error) {
      if (opts.signal?.aborted && !(error instanceof DownloadError)) throw cancelled();
      throw error;
    }
    let append = false;
    let finished = false;
    if (response.status === 416) {
      await response.body?.cancel().catch(() => undefined);
      if (existing > 0 && existing === opts.expectedSize) finished = true;
      else if (!restarted) { restarted = true; await fsp.rm(partial, { force: true }); continue; }
      else throw new DownloadError("download_http_error", `Download failed: HTTP 416 from ${finalUrl.host}.`);
    } else if (response.status === 206) append = true;
    else if (response.status === 200) append = false;
    else {
      await response.body?.cancel().catch(() => undefined);
      throw (opts.httpCodes === "hf" ? mapHfStatus(response.status, finalUrl.host) : undefined) ?? new DownloadError("download_http_error", `Download failed: HTTP ${response.status} from ${finalUrl.host}.`);
    }

    let bytes = existing;
    if (!finished) {
      const useHash = append ? hash : createHash("sha256");
      const startBytes = append ? existing : 0;
      const length = Number(response.headers.get("content-length")) || undefined;
      const total = opts.expectedSize ?? (length !== undefined ? length + startBytes : undefined);
      const out = fs.createWriteStream(partial, { flags: append ? "a" : "w" });
      bytes = await pump(response, out, useHash, startBytes, total, opts.onProgress, opts.signal);
      return await verify(useHash.digest("hex"), bytes, partial, opts);
    }
    return await verify(hash.digest("hex"), bytes, partial, opts);
  }
}

async function verify(sha256: string, bytes: number, partial: string, opts: { file: string; expectedSize?: number; expectedSha256?: string }): Promise<{ sha256: string; bytes: number }> {
  if (opts.expectedSize !== undefined && bytes !== opts.expectedSize) {
    await fsp.rm(partial, { force: true });
    throw new DownloadError("download_size_mismatch", `Downloaded ${bytes} bytes, expected ${opts.expectedSize}.`);
  }
  if (opts.expectedSha256 && sha256.toLowerCase() !== opts.expectedSha256.toLowerCase()) {
    await fsp.rm(partial, { force: true });
    throw new DownloadError("download_checksum_mismatch", `The download's SHA-256 (${sha256}) does not match the expected ${opts.expectedSha256}.`);
  }
  await fsp.rm(opts.file, { force: true });
  await fsp.rename(partial, opts.file);
  return { sha256, bytes };
}

/** Streams a zip from disk into `dest` without holding the archive or any entry in memory. */
export async function extractZip(zipFile: string, dest: string, opts: { maxBytes: number; onProgress?(done: number, total: number): void }): Promise<void> {
  await fsp.mkdir(dest, { recursive: true });
  const total = (await fsp.stat(zipFile)).size;
  const unzip = new Unzip();
  unzip.register(UnzipInflate);
  let failure: Error | undefined;
  let written = 0;
  let pendingWrites = Promise.resolve();
  const fail = (error: unknown) => { failure ??= error instanceof Error ? error : new Error(String(error)); };
  unzip.onfile = (file) => {
    if (failure) return;
    let target: string;
    try { target = safeEntryPath(dest, file.name); } catch (error) { fail(error); return; }
    if (file.name.endsWith("/")) { pendingWrites = pendingWrites.then(() => fsp.mkdir(target, { recursive: true }).then(() => undefined)); return; }
    let fd: number | undefined;
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fd = fs.openSync(target, "w");
    } catch (error) { fail(error); return; }
    const handle = fd;
    file.ondata = (error, chunk, final) => {
      if (error) { fail(error); try { fs.closeSync(handle); } catch { /* ignore */ } return; }
      try {
        written += chunk.length;
        if (written > opts.maxBytes) throw new Error("The archive expands to more than the allowed size.");
        fs.writeSync(handle, chunk);
        if (final) fs.closeSync(handle);
      } catch (writeError) { fail(writeError); try { fs.closeSync(handle); } catch { /* ignore */ } }
    };
    file.start();
  };
  let read = 0;
  for await (const chunk of fs.createReadStream(zipFile, { highWaterMark: 256 * 1024 })) {
    unzip.push(chunk as Uint8Array);
    read += (chunk as Uint8Array).length;
    opts.onProgress?.(read, total);
    if (failure) throw failure;
  }
  unzip.push(new Uint8Array(0), true);
  await pendingWrites;
  if (failure) throw failure;
}

/** Refuses when `dir`'s volume has less than `bytes` plus 1 GiB free. Uses the nearest existing ancestor when `dir` does not exist yet. */
export async function ensureFreeSpace(dir: string, bytes: number, statfs: typeof fs.promises.statfs = fsp.statfs): Promise<void> {
  let probe = path.resolve(dir);
  for (;;) {
    try {
      const stats = await statfs(probe);
      const free = Number(stats.bavail) * Number(stats.bsize);
      if (free < bytes + FREE_SPACE_MARGIN) throw new DownloadError("download_disk_space", `Not enough free disk space in ${probe}: ${free} bytes free, ${bytes} bytes needed plus 1 GiB spare.`);
      return;
    } catch (error) {
      if (error instanceof DownloadError) throw error;
      const parent = path.dirname(probe);
      if (parent === probe) throw error;
      probe = parent;
    }
  }
}
