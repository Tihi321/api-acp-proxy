import { execFile } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { DownloadError, downloadResumable, ensureFreeSpace, extractZip, guardedFetch, type HostPolicy } from "./download.js";
import { buildNumber, fetchReleaseRaw, GITHUB_HEADERS, GITHUB_POLICY, parseAssetName, releaseAssets, type LlamaAssetView } from "./llama-releases.js";
import type { LlamaProgressView } from "./shared/ipc.js";
import type { LlamaInstallInfo, LlamaSource } from "./settings.js";

const MAX_EXTRACTED_BYTES = 8 * 1024 * 1024 * 1024;
const SERVER_EXE = "llama-server.exe";
const SHA_LIST = "llama-prebuilt-sha256.json";
const MAX_SEARCH_DEPTH = 3;

const HEX64 = /^[0-9a-f]{64}$/i;
const hexOf = (value: unknown): string | undefined => {
  const text = typeof value === "string" ? value.replace(/^sha256:/i, "").trim() : "";
  return HEX64.test(text) ? text.toLowerCase() : undefined;
};

/** The format of `llama-prebuilt-sha256.json` is not documented; accepts `{ "<name>": "<hex>" }`, nested maps and arrays of `{ name|file|asset, sha256|digest|hash }`. */
function findSha(json: unknown, name: string, depth = 0): string | undefined {
  if (depth > 4 || !json || typeof json !== "object") return undefined;
  if (Array.isArray(json)) {
    for (const entry of json) {
      if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        const record = entry as Record<string, unknown>;
        if ([record.name, record.file, record.asset, record.filename].includes(name)) { const hex = hexOf(record.sha256) ?? hexOf(record.digest) ?? hexOf(record.hash); if (hex) return hex; }
      }
      const nested = findSha(entry, name, depth + 1);
      if (nested) return nested;
    }
    return undefined;
  }
  const record = json as Record<string, unknown>;
  if (name in record) { const direct = hexOf(record[name]) ?? (record[name] && typeof record[name] === "object" ? hexOf((record[name] as Record<string, unknown>).sha256) : undefined); if (direct) return direct; }
  for (const value of Object.values(record)) { const nested = findSha(value, name, depth + 1); if (nested) return nested; }
  return undefined;
}

async function findServerExe(root: string): Promise<string | undefined> {
  let level = [root];
  for (let depth = 0; depth <= MAX_SEARCH_DEPTH && level.length; depth++) {
    const next: string[] = [];
    for (const dir of level) {
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      const hit = entries.find((entry) => entry.isFile() && entry.name.toLowerCase() === SERVER_EXE);
      if (hit) return path.join(dir, hit.name);
      for (const entry of entries) if (entry.isDirectory()) next.push(path.join(dir, entry.name));
    }
    level = next;
  }
  return undefined;
}

export async function installLlama(opts: { source: LlamaSource; tag: string; backend: string; arch: "x64" | "arm64"; binDir: string; fetch: typeof fetch;
  signal?: AbortSignal; onProgress?(p: LlamaProgressView): void; policy?: HostPolicy;
  /** Tests only. */ apiBase?: string; statfs?: typeof fs.promises.statfs }): Promise<LlamaInstallInfo> {
  const policy = opts.policy ?? GITHUB_POLICY;
  const emit = (p: Omit<LlamaProgressView, "job">) => opts.onProgress?.({ job: "binary", ...p });
  const apiOpts = { fetch: opts.fetch, policy, ...(opts.signal ? { signal: opts.signal } : {}), ...(opts.apiBase ? { apiBase: opts.apiBase } : {}) };
  const headersFor = () => ({ "User-Agent": GITHUB_HEADERS["User-Agent"] });

  emit({ phase: "release", message: `Looking up ${opts.tag}` });
  const raw = await fetchReleaseRaw(opts.source, opts.tag, apiOpts);
  const rawList = releaseAssets(raw);
  const asset = rawList.map((entry) => ({ entry, parsed: parseAssetName(opts.source, entry.name) })).find((item) => item.parsed && item.parsed.backend === opts.backend && item.parsed.arch === opts.arch);
  if (!asset?.parsed) throw new DownloadError("llama_asset_not_found", `Release ${opts.tag} has no ${opts.backend} (${opts.arch}) Windows build for ${opts.source}.`);

  // CUDA runtime zip of the same major, ggml-org only (parseReleases does the pairing; reuse it through the asset list).
  let runtime: LlamaAssetView["runtime"];
  const cuda = opts.source === "ggml-org" ? /^cuda-(\d+)$/.exec(opts.backend) : null;
  if (cuda) {
    const pattern = new RegExp(`^cudart-llama-bin-win-cuda-${cuda[1]}\\.[\\d.]+-${opts.arch}\\.zip$`);
    runtime = rawList.find((entry) => pattern.test(entry.name));
    if (!runtime) throw new DownloadError("llama_asset_not_found", `Release ${opts.tag} has no CUDA ${cuda[1]} runtime zip for ${opts.arch}.`);
  }

  let sha256 = asset.entry.sha256;
  if (!sha256 && opts.source === "unsloth") {
    const list = rawList.find((entry) => entry.name === SHA_LIST);
    if (list) {
      const response = await guardedFetch(opts.fetch, list.url, policy, { ...(opts.signal ? { signal: opts.signal } : {}), headersFor });
      sha256 = findSha(await response.json().catch(() => undefined), asset.entry.name);
    }
  }
  if (!sha256) throw new DownloadError("llama_no_digest", `No SHA-256 is published for ${asset.entry.name}; refusing to install an unverified binary.`);
  const runtimeSha = runtime ? runtime.sha256 : undefined;
  if (runtime && !runtimeSha) throw new DownloadError("llama_no_digest", `No SHA-256 is published for ${runtime.name}; refusing to install an unverified runtime.`);

  const totalSize = asset.entry.size + (runtime?.size ?? 0);
  await fsp.mkdir(opts.binDir, { recursive: true });
  await ensureFreeSpace(opts.binDir, 3 * totalSize, opts.statfs);

  const stamp = `.download-${process.pid}`;
  const zip = path.join(opts.binDir, `${stamp}.zip`);
  const runtimeZip = path.join(opts.binDir, `${stamp}-runtime.zip`);
  const finalName = `${opts.source}-${opts.tag}-${opts.backend}`;
  const finalDir = path.join(opts.binDir, finalName);
  const partialDir = `${finalDir}.partial`;
  let received = 0;
  const download = async (file: string, item: { name: string; url: string; size: number }, expected: string, base: number) => {
    emit({ phase: "download", file: item.name, received: base, total: totalSize });
    await downloadResumable({ fetch: opts.fetch, url: item.url, file, policy, headersFor, expectedSha256: expected, ...(item.size ? { expectedSize: item.size } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}), onProgress: (done) => emit({ phase: "download", file: item.name, received: base + done, total: totalSize }) });
  };
  try {
    await download(zip, asset.entry, sha256, 0);
    received = asset.entry.size;
    if (runtime && runtimeSha) await download(runtimeZip, runtime, runtimeSha, received);
    emit({ phase: "verify", file: asset.entry.name });
    await fsp.rm(partialDir, { recursive: true, force: true });
    emit({ phase: "extract", file: asset.entry.name });
    await extractZip(zip, partialDir, { maxBytes: MAX_EXTRACTED_BYTES });
    if (runtime) await extractZip(runtimeZip, partialDir, { maxBytes: MAX_EXTRACTED_BYTES });
    const exe = await findServerExe(partialDir);
    if (!exe) throw new DownloadError("llama_server_missing", `${asset.entry.name} does not contain ${SERVER_EXE} (searched ${MAX_SEARCH_DEPTH} folder levels deep).`);
    const relative = path.relative(partialDir, exe);
    await fsp.rm(finalDir, { recursive: true, force: true });
    await fsp.rename(partialDir, finalDir);
    const command = path.join(finalDir, relative);
    const build = buildNumber(opts.tag);
    const info: LlamaInstallInfo = { source: opts.source, tag: opts.tag, ...(build !== undefined ? { build } : {}), backend: opts.backend, arch: opts.arch, assetName: asset.entry.name, sha256,
      ...(runtime ? { runtimeAssetName: runtime.name } : {}), command, dir: path.dirname(command), installedAt: new Date().toISOString() };
    emit({ phase: "done" });
    return info;
  } catch (error) {
    await fsp.rm(partialDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  } finally {
    await Promise.all([zip, runtimeZip, `${zip}.partial`, `${runtimeZip}.partial`].map((file) => fsp.rm(file, { force: true }).catch(() => undefined)));
  }
}

function defaultRun(exe: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(exe, args, { timeout: 15_000, windowsHide: true }, (error, stdout, stderr) => {
      if (error && !stdout && !stderr) reject(error);
      else resolve(`${stdout}\n${stderr}`.trim());
    });
  });
}

/** Runs `llama-server --version`; the output format is inferred, an unparsable output gives no build. */
export async function probeLlamaVersion(exe: string, run: (exe: string, args: string[]) => Promise<string> = defaultRun): Promise<{ build?: number; text: string }> {
  const text = (await run(exe, ["--version"])).trim();
  const match = /version:\s*(\d+)/i.exec(text) ?? /\bb(\d{4,})\b/.exec(text);
  return { ...(match ? { build: Number(match[1]) } : {}), text };
}
