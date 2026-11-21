import fsp from "node:fs/promises";
import path from "node:path";
import { DownloadError, downloadResumable, ensureFreeSpace, guardedFetch, safeEntryPath, type HostPolicy } from "./download.js";
import type { LlamaProgressView } from "./shared/ipc.js";

export const HF_POLICY: HostPolicy = { hosts: ["huggingface.co", "hf.co"], suffixes: [".huggingface.co", ".hf.co"] };

export interface HfRef { repo: string; revision: string; path?: string; quant?: string }

const SEGMENT = /^[A-Za-z0-9][\w.-]*$/;
const QUANT_SHORTHAND = /^[\w.-]+$/;
const invalid = (input: string, why: string) => new DownloadError("hf_link_invalid", `Not a Hugging Face link (${why}): ${input}`);

/** Accepts repo / tree / blob / resolve URLs on huggingface.co or hf.co, `<owner>/<repo>` and `<owner>/<repo>:<QUANT>`. */
export function parseHfLink(input: string): HfRef {
  const text = input.trim();
  if (!text) throw invalid(input, "empty");
  if (/^https?:\/\//i.test(text) || /^(?:www\.)?(?:huggingface\.co|hf\.co)\//i.test(text)) {
    let url: URL;
    try { url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`); } catch { throw invalid(input, "bad URL"); }
    const host = url.hostname.toLowerCase();
    if (host !== "huggingface.co" && host !== "hf.co") throw invalid(input, `host '${url.hostname}' is not huggingface.co or hf.co`);
    let segments: string[];
    try { segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent); } catch { throw invalid(input, "bad escape"); }
    const owner = segments[0];
    let repo = segments[1];
    let quant: string | undefined;
    if (repo?.includes(":")) { const at = repo.indexOf(":"); quant = repo.slice(at + 1); repo = repo.slice(0, at); }
    if (!owner || !repo || !SEGMENT.test(owner) || !SEGMENT.test(repo)) throw invalid(input, "expected <owner>/<repo>");
    if (quant !== undefined && !QUANT_SHORTHAND.test(quant)) throw invalid(input, "bad quant");
    const kind = segments[2];
    const ref: HfRef = { repo: `${owner}/${repo}`, revision: "main", ...(quant ? { quant } : {}) };
    if (kind === undefined) return ref;
    if (kind !== "tree" && kind !== "blob" && kind !== "resolve") throw invalid(input, `unsupported page '${kind}'`);
    const revision = segments[3];
    if (!revision) { if (kind === "tree") return ref; throw invalid(input, "missing revision"); }
    ref.revision = revision;
    const rest = segments.slice(4).join("/");
    if (rest) ref.path = rest;
    else if (kind !== "tree") throw invalid(input, "missing file path");
    return ref;
  }
  const match = /^([^/:\s]+)\/([^/:\s]+)(?::([^/\s]+))?$/.exec(text);
  if (!match || !match[1] || !match[2] || !SEGMENT.test(match[1]) || !SEGMENT.test(match[2])) throw invalid(input, "expected a Hugging Face URL or <owner>/<repo>");
  if (match[3] !== undefined && !QUANT_SHORTHAND.test(match[3])) throw invalid(input, "bad quant");
  return { repo: `${match[1]}/${match[2]}`, revision: "main", ...(match[3] ? { quant: match[3] } : {}) };
}

export interface HfFile { path: string; size: number; sha256?: string; saveAs: string }
/** `selectable` is false for split models with missing shards (their label ends in "(incomplete)"); the view type carries it too, and the UI disables such groups. */
export interface HfFileGroup { kind: "model" | "mmproj" | "draft"; label: string; quant?: string; files: HfFile[]; totalSize: number; split: boolean; selectable: boolean }
type TreeEntry = { type: string; path: string; size?: number; lfs?: { oid?: string; size?: number } };

const QUANT = /(?:^|[-_./])((?:UD-)?(?:I?Q\d(?:_[A-Z0-9]+)*|BF16|F16|F32|MXFP4(?:_MOE)?))(?=[-_./]|$)/i;
const SHARD = /-(\d{5})-of-(\d{5})\.gguf$/i;
const DRAFT_NAME = /^(dspark|mtp|dflash|eagle3?)[-_]/i;
const DRAFT_DIR = /^(dspark|mtp)$/i;

function quantOf(file: string): string | undefined {
  const stripped = file.replace(/\.gguf(?:_file)?$/i, "").replace(/-\d{5}-of-\d{5}$/i, "");
  const base = stripped.slice(stripped.lastIndexOf("/") + 1);
  return QUANT.exec(base)?.[1] ?? QUANT.exec(stripped)?.[1];
}

export function groupGgufFiles(tree: TreeEntry[]): HfFileGroup[] {
  const groups: HfFileGroup[] = [];
  const shardSets = new Map<string, { kind: HfFileGroup["kind"]; mainline: boolean; total: number; shards: Map<number, HfFile>; quant: string | undefined; dir: string }>();
  for (const entry of tree) {
    if (entry.type !== "file" || !/\.gguf(?:_file)?$/i.test(entry.path)) continue;
    const parts = entry.path.split("/");
    const name = parts[parts.length - 1] ?? entry.path;
    if (/^imatrix/i.test(name)) continue;
    const dirs = parts.slice(0, -1);
    const kind: HfFileGroup["kind"] = /^mmproj/i.test(name) ? "mmproj" : DRAFT_NAME.test(name) || dirs.some((dir) => DRAFT_DIR.test(dir)) ? "draft" : "model";
    const mainline = dirs.some((dir) => dir.toLowerCase() === "mainline_support");
    const file: HfFile = {
      path: entry.path, size: entry.lfs?.size ?? entry.size ?? 0, saveAs: entry.path.replace(/\.gguf_file$/i, ".gguf"),
      ...(entry.lfs?.oid ? { sha256: entry.lfs.oid } : {}),
    };
    const quant = quantOf(entry.path);
    const shard = kind === "model" ? SHARD.exec(name) : null;
    if (shard) {
      const key = `${dirs.join("/")}\0${name.replace(SHARD, "")}\0${shard[2]}`;
      let set = shardSets.get(key);
      if (!set) { set = { kind, mainline, total: Number(shard[2]), shards: new Map(), quant, dir: dirs.join("/") }; shardSets.set(key, set); }
      set.shards.set(Number(shard[1]), file);
      continue;
    }
    const base = name.replace(/\.gguf(?:_file)?$/i, "");
    groups.push({ kind, label: `${quant ?? base}${mainline ? " (mainline)" : ""}`, ...(quant ? { quant } : {}), files: [file], totalSize: file.size, split: false, selectable: true });
  }
  for (const set of shardSets.values()) {
    const files = [...set.shards.entries()].sort((a, b) => a[0] - b[0]).map(([, file]) => file);
    let complete = files.length === set.total;
    for (let index = 1; index <= set.total && complete; index++) if (!set.shards.has(index)) complete = false;
    const base = set.quant ?? (set.dir.slice(set.dir.lastIndexOf("/") + 1) || "split model");
    groups.push({
      kind: set.kind, label: `${base}${set.mainline ? " (mainline)" : ""}${complete ? "" : " (incomplete)"}`, ...(set.quant ? { quant: set.quant } : {}),
      files, totalSize: files.reduce((sum, file) => sum + file.size, 0), split: true, selectable: complete,
    });
  }
  return groups;
}

function hfHeaders(token: string | undefined): (url: URL) => Record<string, string> {
  return (url) => (token && url.hostname.toLowerCase() === "huggingface.co" ? { Authorization: `Bearer ${token}` } : ({} as Record<string, string>));
}

const encodePath = (value: string) => value.split("/").map(encodeURIComponent).join("/");

function mapListError(error: unknown): unknown {
  if (error instanceof DownloadError && error.code === "download_http_error") {
    const status = /HTTP (\d{3})/.exec(error.message)?.[1];
    if (status === "401") return new DownloadError("hf_auth_required", "Hugging Face needs a token for this repository (HTTP 401).");
    if (status === "403") return new DownloadError("hf_terms_required", "Hugging Face refused access (HTTP 403); accept the model's terms on huggingface.co or check the token.");
    if (status === "404") return new DownloadError("hf_not_found", "Hugging Face repository or revision not found (HTTP 404).");
  }
  return error;
}

function nextLink(header: string | null): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(/,\s*(?=<)/)) {
    const match = /^\s*<([^>]+)>\s*;(.*)$/.exec(part);
    if (match && /rel\s*=\s*"?next"?/i.test(match[2] ?? "")) return match[1];
  }
  return undefined;
}

/** Lists the repository's GGUF files. `quant` is the canonical quant of the model group matched by a shorthand `:<QUANT>` (absent otherwise); no match -> hf_not_found. The link's `path` is not used to filter. */
export async function listHfFiles(ref: HfRef, opts: { fetch: typeof fetch; token?: string; signal?: AbortSignal; policy?: HostPolicy }): Promise<{ groups: HfFileGroup[]; quant?: string }> {
  const policy = opts.policy ?? HF_POLICY;
  const init = { headersFor: hfHeaders(opts.token), ...(opts.signal ? { signal: opts.signal } : {}) };
  const tree: TreeEntry[] = [];
  let url: string | undefined = `https://huggingface.co/api/models/${encodePath(ref.repo)}/tree/${encodeURIComponent(ref.revision)}?recursive=true`;
  for (let page = 0; url && page < 200; page++) {
    let response: Response;
    try { response = await guardedFetch(opts.fetch, url, policy, init); } catch (error) { throw mapListError(error); }
    const json: unknown = await response.json();
    if (!Array.isArray(json)) throw new DownloadError("download_http_error", "Unexpected Hugging Face tree response.");
    for (const item of json) if (item && typeof item === "object" && typeof (item as TreeEntry).path === "string") tree.push(item as TreeEntry);
    const next = nextLink(response.headers.get("link"));
    url = next ? new URL(next, url).toString() : undefined;
  }
  const groups = groupGgufFiles(tree);
  if (!ref.quant) return { groups };
  const wanted = ref.quant.toLowerCase();
  const matches = groups.filter((group) => group.kind === "model" && group.selectable && group.quant?.toLowerCase() === wanted);
  const match = matches.find((group) => !group.label.endsWith("(mainline)")) ?? matches[0];
  if (!match?.quant) throw new DownloadError("hf_not_found", `No ${ref.quant} quant found in ${ref.repo}.`);
  return { groups, quant: match.quant };
}

export function hfLocalPath(modelsDir: string, repo: string, saveAs: string): string {
  return safeEntryPath(modelsDir, `${repo}/${saveAs}`);
}

/** Downloads `files` sequentially into `<modelsDir>/<owner>/<repo>/<saveAs>`; returns the relative paths (owner/repo/saveAs) in input order. */
export async function downloadHfFiles(opts: { repo: string; revision: string; files: HfFile[]; modelsDir: string; token?: string; fetch: typeof fetch;
  signal?: AbortSignal; onProgress?(p: LlamaProgressView): void; policy?: HostPolicy }): Promise<string[]> {
  const policy = opts.policy ?? HF_POLICY;
  const targets = opts.files.map((file) => ({ file, local: hfLocalPath(opts.modelsDir, opts.repo, file.saveAs) }));
  let remaining = 0;
  for (const { file, local } of targets) {
    const partial = await fsp.stat(`${local}.partial`).then((stat) => stat.size, () => 0);
    remaining += Math.max(0, file.size - partial);
  }
  await ensureFreeSpace(opts.modelsDir, remaining);
  const total = opts.files.reduce((sum, file) => sum + file.size, 0);
  let completed = 0;
  const paths: string[] = [];
  for (const { file, local } of targets) {
    const url = `https://huggingface.co/${encodePath(opts.repo)}/resolve/${encodeURIComponent(opts.revision)}/${encodePath(file.path)}`;
    const name = path.posix.basename(file.saveAs);
    await downloadResumable({
      fetch: opts.fetch, url, file: local, policy, headersFor: hfHeaders(opts.token), httpCodes: "hf", expectedSize: file.size,
      ...(file.sha256 ? { expectedSha256: file.sha256 } : {}), ...(opts.signal ? { signal: opts.signal } : {}),
      onProgress: (received) => opts.onProgress?.({ job: "model", phase: "download", file: name, received: completed + received, total }),
    });
    completed += file.size;
    paths.push(`${opts.repo}/${file.saveAs}`);
  }
  opts.onProgress?.({ job: "model", phase: "done", received: total, total });
  return paths;
}
