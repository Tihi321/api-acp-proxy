import { DownloadError, guardedFetch, type HostPolicy } from "./download.js";
import type { LlamaSource } from "./settings.js";

export const LLAMA_REPOS: Record<LlamaSource, string> = { "ggml-org": "ggml-org/llama.cpp", unsloth: "unslothai/llama.cpp" };

/** `api.github.com` serves the release list; the other hosts serve the asset downloads and their redirects. */
export const GITHUB_POLICY: HostPolicy = { hosts: ["api.github.com", "github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"] };

export const GITHUB_API_BASE = "https://api.github.com";

export interface LlamaAssetView { name: string; size: number; sha256?: string; url: string; backend: string; arch: "x64" | "arm64"; runtime?: { name: string; size: number; sha256?: string; url: string } }
export interface LlamaReleaseView { source: LlamaSource; tag: string; build?: number; publishedAt: string; assets: LlamaAssetView[] }

export interface ReleaseFetchOptions { fetch: typeof fetch; perPage?: number; signal?: AbortSignal; policy?: HostPolicy; /** Tests only: replaces https://api.github.com. */ apiBase?: string }

export const GITHUB_HEADERS = { "User-Agent": "api-acp-proxy", Accept: "application/vnd.github+json" } as const;

const GGML_ASSET = /^llama-(b\d+)-bin-win-(cpu|vulkan|rocm-[\d.]+|cuda-[\d.]+|sycl|openvino-[\d.]+|opencl-adreno)-(x64|arm64)\.zip$/;
const GGML_RUNTIME = /^cudart-llama-bin-win-cuda-(\d+)\.[\d.]+-(x64|arm64)\.zip$/;
const UNSLOTH_ASSET = /^app-.+-windows-(x64|arm64)-(.+)\.zip$/;

function normalizeGgmlBackend(raw: string): string {
  if (raw.startsWith("rocm-")) return "rocm";
  if (raw.startsWith("openvino-")) return "openvino";
  const cuda = /^cuda-(\d+)\./.exec(raw);
  return cuda ? `cuda-${cuda[1]}` : raw;
}

export function parseAssetName(source: LlamaSource, name: string): { backend: string; arch: "x64" | "arm64" } | undefined {
  if (source === "unsloth") {
    const match = UNSLOTH_ASSET.exec(name);
    return match ? { backend: match[2]!, arch: match[1] as "x64" | "arm64" } : undefined;
  }
  const match = GGML_ASSET.exec(name);
  return match ? { backend: normalizeGgmlBackend(match[2]!), arch: match[3] as "x64" | "arm64" } : undefined;
}

export function buildNumber(tag: string): number | undefined {
  const match = /^b(\d+)/.exec(tag);
  return match ? Number(match[1]) : undefined;
}

type RawAsset = { name: string; size: number; sha256?: string; url: string };

function sha256Of(digest: unknown): string | undefined {
  const match = typeof digest === "string" ? /^sha256:([0-9a-f]{64})$/i.exec(digest) : null;
  return match ? match[1]!.toLowerCase() : undefined;
}

function rawAssets(release: Record<string, unknown>): RawAsset[] {
  if (!Array.isArray(release.assets)) return [];
  const out: RawAsset[] = [];
  for (const entry of release.assets) {
    if (!entry || typeof entry !== "object") continue;
    const asset = entry as Record<string, unknown>;
    if (typeof asset.name !== "string" || typeof asset.browser_download_url !== "string") continue;
    const sha256 = sha256Of(asset.digest);
    out.push({ name: asset.name, size: typeof asset.size === "number" ? asset.size : 0, url: asset.browser_download_url, ...(sha256 ? { sha256 } : {}) });
  }
  return out;
}

function parseRelease(source: LlamaSource, release: Record<string, unknown>): LlamaReleaseView | undefined {
  if (release.draft === true || typeof release.tag_name !== "string") return undefined;
  const raws = rawAssets(release);
  const runtimes = new Map<string, RawAsset>();   // `<major>-<arch>`
  if (source === "ggml-org") {
    for (const asset of raws) {
      const match = GGML_RUNTIME.exec(asset.name);
      if (match) runtimes.set(`${match[1]}-${match[2]}`, asset);
    }
  }
  const assets: LlamaAssetView[] = [];
  for (const asset of raws) {
    const parsed = parseAssetName(source, asset.name);
    if (!parsed) continue;
    const cuda = source === "ggml-org" ? /^cuda-(\d+)$/.exec(parsed.backend) : null;
    const runtime = cuda ? runtimes.get(`${cuda[1]}-${parsed.arch}`) : undefined;
    assets.push({ ...asset, ...parsed, ...(runtime ? { runtime } : {}) });
  }
  if (!assets.length) return undefined;
  const build = buildNumber(release.tag_name);
  return { source, tag: release.tag_name, ...(build !== undefined ? { build } : {}), publishedAt: typeof release.published_at === "string" ? release.published_at : "", assets };
}

export function parseReleases(source: LlamaSource, json: unknown): LlamaReleaseView[] {
  if (!Array.isArray(json)) return [];
  const out: LlamaReleaseView[] = [];
  for (const entry of json) {
    if (!entry || typeof entry !== "object") continue;
    const release = parseRelease(source, entry as Record<string, unknown>);
    if (release) out.push(release);
  }
  return out;
}

async function getJson(url: string, opts: ReleaseFetchOptions): Promise<unknown> {
  const response = await guardedFetch(opts.fetch, url, opts.policy ?? GITHUB_POLICY, { ...(opts.signal ? { signal: opts.signal } : {}), headersFor: () => ({ ...GITHUB_HEADERS }) });
  return response.json();
}

const apiRoot = (source: LlamaSource, opts: ReleaseFetchOptions) => `${opts.apiBase ?? GITHUB_API_BASE}/repos/${LLAMA_REPOS[source]}`;

/** Never uses `/releases/latest`: that endpoint points at a stale non-build release. */
export async function fetchReleases(source: LlamaSource, opts: ReleaseFetchOptions): Promise<LlamaReleaseView[]> {
  return parseReleases(source, await getJson(`${apiRoot(source, opts)}/releases?per_page=${opts.perPage ?? 20}`, opts));
}

/** The release JSON for one tag, unparsed (the installer also needs non-binary assets such as the unsloth checksum list). */
export async function fetchReleaseRaw(source: LlamaSource, tag: string, opts: ReleaseFetchOptions): Promise<Record<string, unknown>> {
  try {
    const json = await getJson(`${apiRoot(source, opts)}/releases/tags/${encodeURIComponent(tag)}`, opts);
    if (!json || typeof json !== "object" || Array.isArray(json)) throw new DownloadError("llama_release_not_found", `Release ${tag} of ${LLAMA_REPOS[source]} was not found.`);
    return json as Record<string, unknown>;
  } catch (error) {
    if (error instanceof DownloadError && error.code === "download_http_error" && /HTTP 404/.test(error.message)) throw new DownloadError("llama_release_not_found", `Release ${tag} of ${LLAMA_REPOS[source]} was not found.`);
    throw error;
  }
}

export async function fetchRelease(source: LlamaSource, tag: string, opts: ReleaseFetchOptions): Promise<LlamaReleaseView> {
  const release = parseRelease(source, await fetchReleaseRaw(source, tag, opts));
  if (!release) throw new DownloadError("llama_release_not_found", `Release ${tag} of ${LLAMA_REPOS[source]} has no Windows build.`);
  return release;
}

export { rawAssets as releaseAssets };
