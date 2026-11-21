---
status: done
request: REQ-0007
repos: [api-acp-proxy]
branch: AAP-38_llama-cpp-provider
updated: 2026-11-21
---

# AAP-38 Llama.cpp local provider: managed or own `llama-server.exe`, Hugging Face model downloads, Inkling 2 Mini presets

Facts: `research.md` in this folder (file:line refs, release assets, flags, HF API). Agents never download real binaries or models and never run a real `llama-server`; every test uses local fake HTTP servers and in-test zips. Live behaviour is the manual list M1..M12 (user).

Reading chosen (full): a third local server `llama` ("Llama.cpp") shaped like Gufo: profiles exposed as `llama/<model>`, one local server process at a time across Gufo, Strata and Llama.cpp, auto-switch per request, a Settings page under Local models with per-profile Start / "Switch to this", plus in-app download of llama.cpp builds (two sources) and of GGUF models from Hugging Face links.

## Decisions

1. **Profile schema: separate `LlamaProfile`, shared base.** Gufo profiles are a raw `args` string with `kind: llm|image`; llama profiles are structured fields that generate args (model file, mmproj, draft, ctx, ngl, ...) and are always `llm`. One union schema would make half the fields meaningless per server and complicate validation. A `profileBase` zod object (`id`, `label`, `model`, `vision`, `startTimeoutMs`, `requestTimeoutMs`) is shared by both schemas; `GufoProfile` is unchanged.
2. **Profile id collisions: namespaced coordinator keys.** The coordinator key of a target is `gufo:<id>`, `llama:<id>` or `strata`. Gufo and llama profiles may use the same id without any cross-provider validation (a cross-page error would be confusing in Settings). The launcher view keeps the bare profile id; the host builds the key.
3. **Structured fields plus a raw `extraArgs` string**, appended verbatim after the generated flags (a later flag wins in llama.cpp's parser, so `extraArgs` can also override).
4. **No `apiKey`, no `command`/`cwd` fields on `providers.llama`.** The command is derived from the binary settings; `cwd` is the folder of `llama-server.exe` (DLLs sit next to it). The probe sends no key, so a key would break readiness (research Risks).
5. **Default port 8082** (Strata 8080, Gufo 8081, proxy 8787; llama-server's own default 9931 is not used). The builder always passes `--host 127.0.0.1 --port {port}`.
6. **Default backend: ROCm (HIP).** Evidence: the ggml-org Windows ROCm build (`llama-<tag>-bin-win-rocm-10.0-x64.zip`) is built for gfx1150-1153 per `release.yml` (research B), which includes Strix Halo's **gfx1151**, and it bundles the HIP runtime DLLs (no separate runtime download). Unsloth's fork ships a dedicated `rocm-gfx1151` zip. So the defaults are `backend: "rocm"` (ggml-org) and `backend: "rocm-gfx1151"` (unsloth). Vulkan stays one click away and is the documented fallback if ROCm fails to load on this machine (M3). The gfx list comes from the workflow file, not from listing a zip (no download allowed).
7. **Releases: never `/releases/latest`** (stale `v1.0.0`, all builds are prereleases). The list comes from `GET /repos/<owner>/<repo>/releases?per_page=20`; drafts are dropped; the version picker defaults to the first entry that has an asset for the chosen backend and arch. `prerelease` is ignored.
8. **Integrity**: a binary is accepted only when its sha256 equals the API `digest` (`sha256:<hex>`); for the unsloth source the `llama-prebuilt-sha256.json` release asset is the fallback when `digest` is absent. Neither present -> refuse with `llama_no_digest`. HF files are checked against the LFS `oid` (sha256) from the tree API when present, and always against the expected size.
9. **Inkling 2 Mini**: two presets (C3). Default `inkling-2-mini` = `ggml-org/Inkling-2-Mini-GGUF` **Q8_0** (27.82 GB, fits 64 GB VRAM with 32K ctx and the BF16 mmproj), no drafter (the model has no MTP head; the DSpark drafter is unverified on mainline). Second `inkling-2-mini-dspark` = `unsloth/Inkling-2-Mini-GGUF` **UD-Q8_K_XL** (22.87 GB, the 8-bit of that repo; its root files only load in Unsloth's build) + `dspark-Inkling-2-Mini-Q8_0.gguf` with `--spec-type draft-dspark`. Research gives no reason to deviate from Q8_0.
10. **Build gate**: a profile's `requires = { minBuild?, sources? }` passes when `binary.source ∈ sources` or `build >= minBuild`. Preset 1: `{ minBuild: 12607, sources: ["unsloth"] }` (the user's rule "newer than b12606, or the Unsloth fork"). Preset 2: `{ sources: ["unsloth"] }`. A failing gate shows **"needs a newer build"** on that profile card and makes its start fail with `llama_build_too_old`; it never affects other profiles. An unknown build (own exe whose `--version` could not be parsed) only warns ("build unknown"), never blocks. The user can clear `requires` in the profile editor.
11. **Downloads run in the Electron main process**, one binary job and one model job at a time (single flight each), progress on one channel, cancel per job. A cancelled or failed HF download keeps `<file>.partial` so the next attempt resumes with `Range`; a failed checksum deletes it.
12. **Host allowlists** (separate policies, nothing else widened; the Antigravity list is unchanged):
    - GitHub policy: `api.github.com` (release list; required, not in the user's list but nothing works without it), `github.com`, `objects.githubusercontent.com`, `release-assets.githubusercontent.com`.
    - HF policy: exact `huggingface.co`, `hf.co`; suffixes `.huggingface.co`, `.hf.co` (CDN hops such as `us.aws.cdn.hf.co`, `cas-bridge.xethub.hf.co`).
    - `Authorization: Bearer <hfToken>` is attached only on hops whose hostname is exactly `huggingface.co`; never on the CDN hop, never on GitHub.
13. **Router mode** (`--models-dir`, llama.cpp switching by itself) is not used: the app owns switching through the coordinator, like Gufo.

## Scope

1. Settings: `providers.llama` (C1) with binary, folders, token (encrypted), switch wait, profiles + two presets; view and patch types.
2. Shared download core `src/download.ts` extracted from the Antigravity installer (host policy per call, per-hop headers, resumable download, zip extraction with configurable cap); Antigravity uses it unchanged in behaviour.
3. llama.cpp release lookup and install for sources `ggml-org` and `unsloth`, every Windows backend the release offers, CUDA runtime (`cudart-*`) zip extracted next to the exe, version picker; or a user-chosen `llama-server.exe` with build detection via `--version`.
4. Hugging Face: link parser, GGUF listing with sizes grouped by quant (split shards, mmproj, drafters), resumable download with progress and cancel, free-space check, optional token.
5. Args builder from profile fields, file prechecks (incl. all split shards), build gate.
6. Coordinator generalised to three servers with namespaced keys; host extracted from `main.ts` into a plain-Node module; launcher knows `llama` and the llama.cpp path flags.
7. `LocalOpenAiProvider` registration `llama` (profiles, vision via mmproj, lease `llama:<id>`); controller default registry; usage series.
8. Electron IPC: directory picker, releases, install, executable check, HF list/download, profile model download, cancel, presets, status, progress channel.
9. Settings UI page "Llama.cpp" under Local models.
10. README section and ROADMAP entry.

## Out of scope

- Running two local servers at once; llama.cpp router mode; `-hf` server-side downloads.
- Tools / MCP / web search for local models (provider stays `tools:false`), image generation on llama.
- Linux/macOS binaries (assets are Windows only: `win-*` / `windows-*`), automatic GPU detection, benchmarking backends.
- Deleting old builds or models from the UI (the user deletes folders by hand; README says where).
- Private/gated repo UX beyond "token field + 401/403 message"; HF search/browse; non-GGUF formats.
- Authenticode checks for llama.cpp (unsigned); auto-update of builds.
- Gufo or Strata behaviour changes (beyond the key namespacing, which is invisible to users).
- Playground changes (llama models appear in its model list through `/v1/models` already).

## Shared contracts

### C1 Settings (`src/settings.ts`) and views (`src/shared/ipc.ts`)

```ts
export const LLAMA_SOURCES = ["ggml-org", "unsloth"] as const;              // settings.ts
export type LlamaSource = (typeof LLAMA_SOURCES)[number];
export const LLAMA_SPEC_TYPES = ["none", "draft-simple", "draft-eagle3", "draft-mtp", "draft-dflash", "draft-dspark", "draft-dflash2",
  "draft-lilicorr", "ngram-simple", "ngram-map-k", "ngram-map-k4v", "ngram-mod", "ngram-cache"] as const;
type Layers = "auto" | "all" | number;                                       // z.union([z.enum(["auto","all"]), z.number().int().min(0)])

interface LlamaProfile {                 // profileBase + these
  id: string;                            // slug ^[a-z0-9._-]{1,48}$, unique among llama profiles
  label: string;
  model: string;                         // exposed as llama/<model>, sent as --alias; unique among llama profiles
  vision: boolean;                       // default false; true requires mmprojFile (zod issue otherwise)
  modelFile: string;                     // relative to modelsDir or absolute; first shard of a split model
  mmprojFile?: string;
  ctxSize?: number;                      // -c; absent = model default
  gpuLayers: Layers;                     // -ngl, default "auto"
  flashAttn: "auto" | "on" | "off";      // -fa, default "auto"
  specType: (typeof LLAMA_SPEC_TYPES)[number];  // --spec-type, default "none" (flag omitted)
  draftFile?: string;                    // --spec-draft-model (draft model, DSpark drafter or MTP sidecar)
  draftNMax?: number;                    // --spec-draft-n-max
  draftNMin?: number;                    // --spec-draft-n-min
  draftGpuLayers?: Layers;               // --spec-draft-ngl (-ngld)
  extraArgs: string;                     // default "", appended verbatim
  hf?: { repo: string; revision: string /* default "main" */; quant: string; mmproj?: string; draft?: string };  // where "Download model files" fetches from
  requires?: { minBuild?: number; sources?: LlamaSource[] };
  startTimeoutMs?: number;               // default: launcher default (10 min)
  requestTimeoutMs?: number;             // default: server.timeoutMs
}

// providers.llama
{
  enabled: true,
  port: 8082,
  maxConcurrent: 1,
  switchWaitMs: 1_800_000,
  modelsDir: "D:\\LlamaCpp\\models",
  hfToken?: string,                      // secret: added to mapSecrets holders (encrypted "enc:" like apiKey)
  binary: {
    mode: "managed" | "custom",          // default "managed"
    dir: "D:\\LlamaCpp\\bin",            // managed installs go to <dir>/<source>-<tag>-<backend>/
    source: LlamaSource,                 // default "ggml-org"
    backend: string,                     // default "rocm" (unsloth default "rocm-gfx1151"; the UI swaps the default when the source changes)
    arch: "x64" | "arm64",               // default "x64"
    customPath?: string,                 // mode custom: full path of llama-server.exe
    customBuild?: number,                // filled by proxy:checkLlamaExecutable
    installed?: LlamaInstallInfo,        // written by main after a successful install
  },
  profiles: LlamaProfile[],              // absent -> LLAMA_PRESETS (preprocess, like migrateGufo; stored profiles win)
}
interface LlamaInstallInfo { source: LlamaSource; tag: string; build?: number; backend: string; arch: "x64" | "arm64"; assetName: string; sha256: string; runtimeAssetName?: string; command: string; dir: string; installedAt: string }
```

Exports from settings.ts: `LLAMA_PRESETS`, `restoreMissingLlamaPresets(profiles)` (same rule as Gufo: skip a preset whose id or model exists). `providers.llama` registered next to gufo/strata. Views: `LlamaProfileView`, `LlamaProviderSettingsView` (same fields; `hfToken` shown like other secrets), `SettingsView.providers.llama`, `SettingsPatchView.providers.llama` (`profiles` and `binary` replaced as whole values: `binary` is a nested object, so the patch sends the whole `binary`). `LocalServerId = "gufo" | "strata" | "llama"`.

### C2 Coordinator and host (`src/local-models.ts`, new `src/local-host.ts`)

```ts
export type LocalModelTarget =
  | { key: `gufo:${string}`; server: "gufo"; profile: GufoProfile }
  | { key: `llama:${string}`; server: "llama"; profile: LlamaProfile }
  | { key: "strata"; server: "strata" };
export const targetKey = (server: LocalServerId, profileId?: string): string => server === "strata" ? "strata" : `${server}:${profileId}`;

interface LocalModelHost {
  current(): { key?: string; state: "stopped" | "starting" | "ready" | "error"; error?: string };   // was `profile`
  start(target: LocalModelTarget): Promise<void>;
  external?(target: LocalModelTarget): Promise<boolean>;
  waitReady(key: string, signal: AbortSignal): Promise<void>;
}
new LocalModelCoordinator(host, () => ({ targets: readonly LocalModelTarget[]; switchWaitMs(server: LocalServerId): number }), deps?)
acquire(key, signal) / switchTo(key)        // keys, not bare profile ids; unknown key -> 404 model_not_found "Unknown local model 'x'."
```

Strata uses the Gufo `switchWaitMs` (today's behaviour). Queue policy unchanged (AAP-37 Decision 2).

`src/local-host.ts` (no electron imports): `createLocalModelHost(manager: LocalServerManager, specs: LocalSpecSource): LocalModelHost`, where

```ts
interface LocalSpecSource {
  /** Throws (message shown to the user) when the target cannot start: settings not loaded, build gate, missing files. */
  specFor(target: LocalModelTarget): LocalServerSpec;
  port(server: LocalServerId): number | undefined;
}
```

`current()` = the first server in `LOCAL_SERVER_IDS` that is starting/ready (key via `targetKey(id, entry.profile)`), else the entry with the newest `startedAt` (its error), else stopped. `waitReady` is today's main.ts logic keyed by server id (rejects when the server is switched to another profile, errors or stops). main.ts implements `specFor` (Gufo as today; Strata as today; llama via C4).

### C3 Presets (`LLAMA_PRESETS` in settings.ts)

| id = model | hf | modelFile (rel. to modelsDir) | fields |
|---|---|---|---|
| `inkling-2-mini` | `ggml-org/Inkling-2-Mini-GGUF`, quant `Q8_0`, mmproj `mmproj-Inkling-2-Mini-BF16.gguf` | `ggml-org/Inkling-2-Mini-GGUF/Inkling-2-Mini-Q8_0.gguf`, mmprojFile `ggml-org/Inkling-2-Mini-GGUF/mmproj-Inkling-2-Mini-BF16.gguf` | vision true, ctxSize 32768, gpuLayers "all", flashAttn "auto", specType "none", extraArgs `--temp 1.0 --top-p 1.0 --top-k 0 --min-p 0.0`, requires `{ minBuild: 12607, sources: ["unsloth"] }`, label "Inkling 2 Mini (Q8_0, vision)" |
| `inkling-2-mini-dspark` | `unsloth/Inkling-2-Mini-GGUF`, quant `UD-Q8_K_XL`, mmproj `mmproj-F16.gguf`, draft `dspark-Inkling-2-Mini-Q8_0.gguf` | `unsloth/Inkling-2-Mini-GGUF/Inkling-2-Mini-UD-Q8_K_XL.gguf`, mmproj `.../mmproj-F16.gguf`, draftFile `.../dspark-Inkling-2-Mini-Q8_0.gguf` | vision true, ctxSize 32768, gpuLayers "all", flashAttn "auto", specType "draft-dspark", draftNMax 3, draftGpuLayers 99, same sampling extraArgs, requires `{ sources: ["unsloth"] }`, label "Inkling 2 Mini DSpark (Unsloth build)" |

The file names in `modelFile` follow the repo naming seen in research (exact Q8_0 / UD-Q8_K_XL names **inferred**); "Download model files" resolves the real names from the tree listing by quant and writes `modelFile` / `mmprojFile` / `draftFile` back into the profile, so a wrong guess self-corrects.

### C4 Args builder and checks (new `src/llama-args.ts`, pure)

```ts
export function resolveModelPath(modelsDir: string, file: string): string;          // absolute stays; relative -> path.resolve(modelsDir, file)
export function buildLlamaArgs(profile: LlamaProfile, modelsDir: string): string;  // contains "{port}"
export function checkLlamaFiles(profile: LlamaProfile, modelsDir: string, exists?: (p: string) => boolean): string[];  // missing absolute paths, every shard of a split model
export function checkBuild(profile: LlamaProfile, binary: { source: LlamaSource | "custom"; build?: number }): { ok: true } | { ok: false; code: "llama_build_too_old"; message: string } | { ok: "unknown"; message: string };
export function splitShards(file: string): string[] | undefined;                    // "-00001-of-00003.gguf" -> the 3 names
```

Output order (exact): `-m "<model>" --host 127.0.0.1 --port {port} --alias <model> [-c <ctx>] -ngl <gpuLayers> -fa <flashAttn> [--mmproj "<mmproj>"] [--spec-type <t> [--spec-draft-model "<draft>"] [--spec-draft-n-max N] [--spec-draft-n-min N] [--spec-draft-ngl L]] [<extraArgs>]`. Paths are always double-quoted; a path or `model` containing `"` or `%` (cmd.exe) throws `Error("Unsupported character in <field>: ...")`. `--mmproj` is emitted only when `vision` and `mmprojFile` are set. Spec flags only when `specType !== "none"`. `ngl "all"` is passed as `all`.

`checkBuild` messages: fail -> `"<label> needs a newer build: b<minBuild> or newer from ggml-org, or the Unsloth build (installed: <source> b<build>)."`; sources-only fail -> `"<label> needs the Unsloth build of llama.cpp."`; unknown -> `"The llama-server build is unknown; <label> may need a newer build."`.

main.ts `specFor(llama target)`: command = `binary.mode === "custom" ? binary.customPath : binary.installed?.command` (none -> `Error("Llama.cpp is not installed: download a build or choose your own llama-server.exe on the Llama.cpp page.")`); `checkBuild` (fail -> `Error(message)`, coordinator wraps it into 503 `local_model_start_failed` whose message contains "needs a newer build"); `checkLlamaFiles` (non-empty -> `Error("File not found: <first> (download the model files on the Llama.cpp page)")`); spec `{ id: "llama", command, args: buildLlamaArgs(...), cwd: dirname(command), port, profile: profile.id, startTimeoutMs }`.

Launcher `PATH_FLAGS` (local-servers.ts:19) becomes `(?:^|\s)(?:-m|-md|-mm|--(?:model|model-draft|spec-draft-model|mtp-model|dspark-model|dflash-model|mmproj))\s+("[^"]*"|\S+)`.

### C5 Download core (new `src/download.ts`, moved from `src/providers/antigravity-installer.ts`)

```ts
export interface HostPolicy { hosts: readonly string[]; suffixes?: readonly string[]; allowHttp?: boolean }   // allowHttp: tests only
export class DownloadError extends Error { constructor(readonly code: DownloadErrorCode, message: string) }
export type DownloadErrorCode = "download_host_not_allowed" | "download_http_error" | "download_checksum_mismatch" | "download_size_mismatch"
  | "download_cancelled" | "download_disk_space" | "download_busy" | "hf_link_invalid" | "hf_auth_required" | "hf_terms_required" | "hf_not_found"
  | "llama_release_not_found" | "llama_asset_not_found" | "llama_no_digest" | "llama_server_missing" | "llama_build_too_old";
export function assertAllowedUrl(raw: string, policy: HostPolicy): URL;
export function guardedFetch(fetchImpl: typeof fetch, url: string, policy: HostPolicy, init?: { signal?: AbortSignal; headersFor?: (url: URL) => Record<string, string> }): Promise<Response>;  // manual redirects, each hop checked, headersFor called per hop
export function downloadToFile(response: Response, file: string, opts: { onProgress?(received: number, total?: number): void; signal?: AbortSignal }): Promise<{ sha256: string; bytes: number }>;   // the old download()
export function downloadResumable(opts: { fetch: typeof fetch; url: string; file: string; policy: HostPolicy; headersFor?: (url: URL) => Record<string, string>;
  expectedSize?: number; expectedSha256?: string; signal?: AbortSignal; onProgress?(received: number, total?: number): void }): Promise<{ sha256: string; bytes: number }>;
export function extractZip(zipFile: string, dest: string, opts: { maxBytes: number; onProgress?(done: number, total: number): void }): Promise<void>;
export function safeEntryPath(root: string, name: string): string;
export function ensureFreeSpace(dir: string, bytes: number, statfs?: typeof fs.promises.statfs): Promise<void>;   // free < bytes + 1 GiB -> download_disk_space
```

`downloadResumable`: writes `<file>.partial`; when it exists with size `s > 0` it hashes the existing bytes first, then requests with `Range: bytes=s-`; 206 -> append; 200 -> truncate and restart; 416 with `s === expectedSize` -> finish; other 416 -> delete partial and restart once. HTTP 401/403/404 map to `hf_auth_required` / `hf_terms_required` / `hf_not_found` only when the caller passes `httpCodes: "hf"` (else `download_http_error`). On completion: size mismatch -> `download_size_mismatch`, sha mismatch -> `download_checksum_mismatch` (partial deleted in both), else rename partial -> file. Abort -> `download_cancelled`, partial kept. The redirect is re-resolved on every call (signed CDN URLs expire).

Antigravity: `ALLOWED_HOSTS` stays in the installer and becomes `{ hosts: ALLOWED_HOSTS }`; `testOptions.allowedHosts/allowHttp` map to a policy; `MAX_EXTRACTED_BYTES` (2 GiB) stays for Antigravity; llama uses 8 GiB.

### C6 Releases and install (new `src/llama-releases.ts`, `src/llama-install.ts`; no electron imports)

```ts
export const LLAMA_REPOS: Record<LlamaSource, string> = { "ggml-org": "ggml-org/llama.cpp", unsloth: "unslothai/llama.cpp" };
export const GITHUB_POLICY: HostPolicy;   // Decision 12
export interface LlamaAssetView { name: string; size: number; sha256?: string; url: string; backend: string; arch: "x64" | "arm64"; runtime?: { name: string; size: number; sha256?: string; url: string } }
export interface LlamaReleaseView { source: LlamaSource; tag: string; build?: number; publishedAt: string; assets: LlamaAssetView[] }
export function parseAssetName(source: LlamaSource, name: string): { backend: string; arch: "x64" | "arm64" } | undefined;
export function buildNumber(tag: string): number | undefined;      // /^b(\d+)/
export function parseReleases(source: LlamaSource, json: unknown): LlamaReleaseView[];   // drops drafts and releases with no Windows asset; pairs cuda assets with the cudart asset of the same major
export function fetchReleases(source: LlamaSource, opts: { fetch: typeof fetch; perPage?: number /* 20 */; signal?: AbortSignal; policy?: HostPolicy }): Promise<LlamaReleaseView[]>;
export function fetchRelease(source: LlamaSource, tag: string, opts): Promise<LlamaReleaseView>;   // GET /releases/tags/<tag>; 404 -> llama_release_not_found
// llama-install.ts
export function installLlama(opts: { source: LlamaSource; tag: string; backend: string; arch: "x64" | "arm64"; binDir: string; fetch: typeof fetch;
  signal?: AbortSignal; onProgress?(p: LlamaProgressView): void; policy?: HostPolicy }): Promise<LlamaInstallInfo>;
export function probeLlamaVersion(exe: string, run?: (exe: string, args: string[]) => Promise<string>): Promise<{ build?: number; text: string }>;
```

Asset regexes: ggml-org `^llama-(b\d+)-bin-win-(cpu|vulkan|rocm-[\d.]+|cuda-[\d.]+|sycl|openvino-[\d.]+|opencl-adreno)-(x64|arm64)\.zip$`, backend normalised `rocm-10.0 -> rocm`, `cuda-12.4 -> cuda-12`, `cuda-13.5 -> cuda-13`, `openvino-2026.4.1 -> openvino`; runtime `^cudart-llama-bin-win-cuda-(\d+)\.[\d.]+-(x64|arm64)\.zip$`. Unsloth `^app-.+-windows-(x64|arm64)-(.+)\.zip$`, backend = group 2 verbatim (`rocm-gfx1151`, `cuda12-portable`, ...). Requests send `User-Agent: api-acp-proxy` and `Accept: application/vnd.github+json`; main caches the list 10 min per source.

`installLlama`: `fetchRelease` -> asset for backend/arch (else `llama_asset_not_found`) -> sha256 from digest / unsloth sha json (else `llama_no_digest`) -> `ensureFreeSpace(binDir, 3 x size)` -> download to `<binDir>/.download-<pid>.zip` (and the runtime zip for CUDA) -> compare sha256 -> extract both into `<binDir>/<source>-<tag>-<backend>.partial` (cap 8 GiB) -> find `llama-server.exe` anywhere in the tree, depth <= 3 (else `llama_server_missing`) -> remove an existing final dir of the same name, rename -> return info (`command` = final path of the exe, `dir` = its folder). Old builds are kept. Zips deleted in `finally`; `.partial` dir deleted on error.

`probeLlamaVersion`: `execFile(exe, ["--version"], { timeout: 15000, windowsHide: true })`, stdout+stderr; build = first match of `/version:\s*(\d+)/i` or `/\bb(\d{4,})\b/` (**inferred** output format).

### C7 Hugging Face (new `src/hf-models.ts`; no electron imports)

```ts
export const HF_POLICY: HostPolicy;   // Decision 12
export interface HfRef { repo: string; revision: string; path?: string; quant?: string }
export function parseHfLink(input: string): HfRef;   // throws DownloadError hf_link_invalid
export interface HfFile { path: string; size: number; sha256?: string; saveAs: string }   // saveAs: path with ".gguf_file" -> ".gguf"
export interface HfFileGroup { kind: "model" | "mmproj" | "draft"; label: string; quant?: string; files: HfFile[]; totalSize: number; split: boolean }
export function groupGgufFiles(tree: Array<{ type: string; path: string; size?: number; lfs?: { oid?: string; size?: number } }>): HfFileGroup[];
export function listHfFiles(ref: HfRef, opts: { fetch: typeof fetch; token?: string; signal?: AbortSignal; policy?: HostPolicy }): Promise<HfFileGroup[]>;
export function hfLocalPath(modelsDir: string, repo: string, saveAs: string): string;   // <modelsDir>/<owner>/<repo>/<saveAs>, via safeEntryPath
export function downloadHfFiles(opts: { repo: string; revision: string; files: HfFile[]; modelsDir: string; token?: string; fetch: typeof fetch;
  signal?: AbortSignal; onProgress?(p: LlamaProgressView): void; policy?: HostPolicy }): Promise<string[]>;   // relative paths (owner/repo/saveAs), in input order
```

Link forms: `https://huggingface.co/<o>/<r>`, `.../tree/<rev>[/<dir>]`, `.../blob/<rev>/<path>`, `.../resolve/<rev>/<path>[?download=true]`, the same on `hf.co`, `<o>/<r>`, `<o>/<r>:<QUANT>`. Any other host -> `hf_link_invalid`. Repo segment `^[A-Za-z0-9][\w.-]*$`.

Listing: `GET https://huggingface.co/api/models/<repo>/tree/<rev>?recursive=true`, follows `Link: <...>; rel="next"` (same policy), token header per C5 rule. Grouping: keep `.gguf` and `.gguf_file`; skip `imatrix*`; `mmproj*` -> mmproj; basename `^(dspark|mtp|dflash|eagle3?)[-_]` or a `dspark/` / `MTP/` dir -> draft; shards `-(\d{5})-of-(\d{5})\.gguf$` grouped into one model group (`split: true`, sorted, all shards present else the group gets label suffix "(incomplete)" and is not selectable); quant label from `(?:^|[-_.])((?:UD-)?(?:I?Q\d(?:_[A-Z0-9]+)*|BF16|F16|F32|MXFP4(?:_MOE)?))(?=[-_.]|$)` (case-insensitive), files under `Mainline_Support/` get label suffix " (mainline)". Shorthand quant selects the model group whose `quant` matches case-insensitively (returned as `HfListResult.quant`).

Download: `resolve/<rev>/<path>` per file through `downloadResumable` (`expectedSize` = size, `expectedSha256` = `lfs.oid`), `ensureFreeSpace(modelsDir, remaining)` first, files sequential, progress aggregated (`received/total` over all files, `file` = current name).

### C8 IPC (`src/shared/ipc.ts` types, `src/electron/preload.cts`, `src/electron/main.ts`)

| channel | args | result |
|---|---|---|
| `proxy:pickDirectory` | `title: string` (<= 100 chars), `defaultPath?: string` | `PickResult` (`openDirectory`, `createDirectory`) |
| `proxy:llamaReleases` | `source: LlamaSource`, `refresh?: boolean` | `{ ok: true; releases: LlamaReleaseView[] } \| Failure` |
| `proxy:installLlama` | `{ source, tag, backend, arch }` | `{ ok: true; info: LlamaInstallInfo } \| Failure`; on success main saves `binary.installed`, `binary.mode = "managed"`, source/backend/arch |
| `proxy:checkLlamaExecutable` | `path: string` (must end in `.exe` and exist) | `{ ok: true; build?: number; version: string } \| Failure`; on success main saves `binary.customPath`, `binary.customBuild`, `mode = "custom"` |
| `proxy:hfListFiles` | `link: string` | `{ ok: true; repo; revision; quant?: string; groups: HfFileGroup[] } \| Failure` |
| `proxy:hfDownload` | `{ repo, revision, files: string[] }` (paths from the listing; main re-lists to get sizes/sha, never trusts renderer sizes) | `{ ok: true; paths: string[] } \| Failure` |
| `proxy:downloadProfileModels` | `profileId: string` | `{ ok: true; profile: LlamaProfileView } \| Failure`; resolves `profile.hf` (quant group + mmproj + draft by file name), downloads, writes the real relative paths back into the stored profile |
| `proxy:cancelLlamaDownload` | `job: "binary" \| "model"` | `void` |
| `proxy:restoreLlamaPresets` | `profiles` | `LlamaProfileView[]` |
| `proxy:llamaStatus` | - | `LlamaStatusView` |
| push `proxy:llamaProgress` | - | `LlamaProgressView` |

```ts
type Failure = { ok: false; message: string; code?: DownloadErrorCode };
interface LlamaProgressView { job: "binary" | "model"; phase: "release" | "download" | "verify" | "extract" | "done" | "error" | "cancelled"; file?: string; received?: number; total?: number; message?: string }
interface LlamaStatusView {
  binary: { mode: "managed" | "custom"; command?: string; source: LlamaSource | "custom"; tag?: string; build?: number; backend?: string; exists: boolean };
  profiles: Record<string, { build: "ok" | "too_old" | "unknown"; buildMessage?: string; missingFiles: string[] }>;
  jobs: { binary: boolean; model: boolean };     // running
}
```

A second concurrent job of the same kind -> `Failure` with `download_busy`. `proxy:startLocalServer` / `proxy:stopLocalServer` accept `"llama"` (guard `LOCAL_SERVER_IDS.includes(id)`); llama start: `coordinator.switchTo(targetKey("llama", profileId ?? running ?? first profile))`. `proxy:openExternal` additionally allows `https://huggingface.co/<path>` (repo links in the UI) and nothing else new. The token is read from settings in main; it never crosses IPC back to the renderer except as the normal secret field of the settings view (same as API keys).

## Tasks

Dependencies: **T1 and T2 first, in parallel** (disjoint files). Then **T3, T4, T5 in parallel** (T3, T4 need T2; T5 needs T1). **T6 after T1 and T5.** **T7 after T3-T6.** **T8 after T1, can run in parallel with T7** against C8. **T9 last.**

```
T1 ─────────┬─ T5 ─ T6 ─┐
T2 ─┬─ T3 ──┼───────────┼─ T7 ─┐
    └─ T4 ──┘           │      ├─ T9
T1 ──────────────────── T8 ────┘
```

### T1 Settings, presets, view types

- Owns: `src/settings.ts`, `src/shared/ipc.ts` (types only, incl. C8 view types and `LocalServerId`), `src/local-servers.ts` lines 8-9 only (`LOCAL_SERVER_IDS = ["gufo","strata","llama"]`, `LOCAL_SERVER_NAMES.llama = "Llama.cpp"`), `tests/settings.test.ts`, `tests/local-servers.test.ts:43` (id list expectation).
- Inputs: C1, C3; settings.ts:13-90 (localBase, gufo schemas, migrateGufo), :190-191, :232-246 (`mapSecrets`).
- Do: `profileBase`; `llamaProfileSchema` with refine (vision -> mmprojFile; unique id/model in the list); `llamaProviderSchema` with preprocess (absent profiles -> clone of `LLAMA_PRESETS`); `LLAMA_SOURCES`, `LLAMA_SPEC_TYPES`, `LLAMA_PRESETS`, `restoreMissingLlamaPresets`; `hfToken` in `mapSecrets`. ipc types per C1/C8 (`ProxyApi` methods declared here; implemented in T7). Keep the tree compiling: renderer/main untouched except where the widened `LocalServerId` breaks an exhaustive `Record` (add a `llama` entry with a `// T8` note).
- Test (extend existing `it("keeps and defaults the gufo and strata keys")` and the secrets `it`, no new `it`): defaults have `providers.llama.port === 8082`, `binary.backend === "rocm"`, `binary.source === "ggml-org"`, `modelsDir === "D:\\LlamaCpp\\models"`, two presets with C3 ids, `requires` as C3; `hfToken` is stored with `enc:` and decoded on load; a profile with `vision: true` and no `mmprojFile` fails parse.
- Done: settings tests green; typecheck green.

### T2 Download core extraction

- Owns: new `src/download.ts`, `src/providers/antigravity-installer.ts` (imports from it; public exports unchanged, `safeEntryPath` re-exported), new `tests/download.test.ts`.
- Inputs: C5; antigravity-installer.ts:74-180.
- Do: move `assertAllowedUrl` (policy with exact hosts + suffixes; a suffix `.hf.co` matches `x.hf.co`, never `evilhf.co`), `guardedFetch` (+ `headersFor` per hop), `download` -> `downloadToFile`, `extractZip` (+ `maxBytes`), `safeEntryPath`; add `downloadResumable`, `ensureFreeSpace`, `DownloadError`.
- Test (`tests/download.test.ts`, 1 `it`, local http server on 127.0.0.1 that redirects `/resolve/f` to `http://localhost:<port>/cdn/f`, supports `Range`, records request headers; policy `{ hosts: ["127.0.0.1","localhost"], allowHttp: true }`, `headersFor` adds `authorization` only for host `127.0.0.1`): abort after the first chunk -> `download_cancelled` and `.partial` exists; second call sends `Range: bytes=<n>-`, completes, sha256 equals the fixture's; the CDN hop never received `authorization`; a third run with a wrong `expectedSha256` -> `download_checksum_mismatch` and no `.partial` left; a host outside the policy in a redirect -> `download_host_not_allowed`.
- Done: new test and `tests/antigravity-installer.test.ts` green unchanged.

### T3 llama.cpp releases and install

- Owns: new `src/llama-releases.ts`, `src/llama-install.ts`, `tests/llama-install.test.ts`.
- Inputs: C5, C6, research B; T2 exports.
- Do: as C6. No network in tests: `fetch` and `policy` are injectable; the GitHub base URL is a module constant overridable by an option (`apiBase`, tests only).
- Test (`tests/llama-install.test.ts`, 2 `it`s):
  1. `parseReleases` on an inline JSON with a draft, a stale `v1.0.0` (only `nightly-tag.txt`), and `b12606` (cpu, vulkan, rocm-10.0, cuda-12.4, cuda-13.5, both cudart zips, sycl, arm64 cpu) plus an unsloth release (`app-b12588-mix-c0c3de8-windows-x64-rocm-gfx1151.zip`, `...-cuda12-portable.zip`): drafts and `v1.0.0` dropped; backends `cpu, vulkan, rocm, cuda-12, cuda-13, sycl` for x64; `cuda-12` paired with the cudart 12 asset; `buildNumber("b12588-mix-c0c3de8") === 12588`; `fetchReleases` requested `/releases?per_page=20` and never `/releases/latest` (fake fetch records URLs).
  2. `installLlama` against a local http server serving the API JSON and an in-test fflate zip with `bin/llama-server.exe` + `bin/ggml-rocm.dll` (correct digest): info `command` ends in `bin\llama-server.exe` inside `<binDir>/ggml-org-b12606-rocm`; the same with a wrong digest -> `download_checksum_mismatch`, no final dir, no `.partial` dir, no zip left.
- Done: green, no electron imports.

### T4 Hugging Face listing and download

- Owns: new `src/hf-models.ts`, `tests/hf-models.test.ts`.
- Inputs: C7, research D; T2 exports.
- Test (`tests/hf-models.test.ts`, 2 `it`s):
  1. `parseHfLink`: repo URL, `/blob/main/Q4_K_M/x-00001-of-00003.gguf`, `/resolve/main/x.gguf?download=true`, `hf.co/...`, `unsloth/Inkling-2-Mini-GGUF:q8_k_xl` (quant `q8_k_xl`, revision `main`), and `https://example.com/a/b` -> `hf_link_invalid`.
  2. `groupGgufFiles` on an inline tree: 3 shards in `Q4_K_M/` -> one `split` group with summed size; a group missing shard 2 is "(incomplete)"; `mmproj-BF16.gguf` -> mmproj; `dspark-Inkling-2-Mini-Q8_0.gguf` -> draft; `imatrix.gguf` skipped; `Mainline_Support/Inkling-2-Mini-UD-Q4_K_XL.gguf_file` -> `saveAs` ends in `.gguf`, label has " (mainline)"; `hfLocalPath` rejects a `..` path.
- Done: green. (Resume/redirect/token behaviour is proven once in T2; `downloadHfFiles` is a thin loop and gets no own test.)

### T5 Args builder, coordinator keys, host, launcher flags

- Owns: new `src/llama-args.ts`, new `src/local-host.ts`, `src/local-models.ts`, `src/local-servers.ts` (`PATH_FLAGS` only; T1 owns lines 8-9), `tests/llama-args.test.ts`, `tests/local-models.test.ts`, `tests/local-servers.test.ts` (precheck assertion; T1 changed only the id list line).
- Inputs: C2, C4; local-models.ts (whole), main.ts:105-149 (current host logic to move), local-servers.ts:19-28.
- Do: C4 functions; C2 coordinator change (keys, `targets`, `switchWaitMs(server)`, error text "Unknown local model"); `createLocalModelHost` with the current main.ts logic generalised over `LOCAL_SERVER_IDS`; `PATH_FLAGS` per C4. Update the fake host in `tests/local-models.test.ts` to keys (`gufo:a`, `strata`).
- Tests:
  - `tests/llama-args.test.ts`, 1 `it`: `buildLlamaArgs` for the `inkling-2-mini-dspark` preset with `modelsDir = "D:\\My Models"` equals the exact C4 string (quoted paths with the space); `inkling-2-mini` has `--mmproj` and no `--spec-*`; a `modelFile` with `%` throws; `checkLlamaFiles` with a fake `exists` reports shard 2 of 3 missing; `checkBuild`: preset 1 with ggml-org b12606 -> `too_old` message contains "needs a newer build", b12607 -> ok, unsloth b12588 -> ok; preset 2 with ggml-org b99999 -> fails ("Unsloth build"); custom without build -> `unknown`.
  - `tests/local-models.test.ts`, 1 new `it`: targets `gufo:same`, `llama:same`, `strata`; `gufo:same` active with 1 in-flight; `acquire("llama:same")` causes no start until release, then exactly one `start` with `server: "llama"`; `llama:same` and `gufo:same` are distinct (no false "already active").
  - `tests/local-servers.test.ts`: extend the existing precheck `it` (l.91) with one spec using `-m <missing abs path>` and one with `--spec-draft-model <missing>`, both reject `File not found`; the existing one-at-a-time `it` additionally starts `llama` on a third fake port and asserts gufo was stopped (no new `it`).
- Done: green; existing coordinator tests green after the key rename.

### T6 Provider registration

- Owns: `src/providers/local-openai.ts`, `src/controller.ts` (import + default registry), `src/renderer/usage-view.ts:15` (`KNOWN_SERIES` + `"llama"`), `tests/local-openai.test.ts`, `tests/controller.test.ts:60`.
- Inputs: C1, C2; local-openai.ts:9-21, :59-93, :274-284.
- Do: `LocalOpenAiOptions.id: LocalServerId`; profiles typed `GufoProfile[] | LlamaProfile[]` through a small adapter (`{ id, model, label, kind: "llm" | "image", vision, requestTimeoutMs }` derived at construction; llama kind is always `llm`, vision = `vision && !!mmprojFile`); lease key = `targetKey(this.id, profile.id)`, strata `"strata"`; `createLlamaRegistration(host)` + `llamaRegistration`; profiles wired when `providerSettings.profiles` is an array (not `id === "gufo"`); not-running message "Llama.cpp is not running — start it from the app.".
- Test (`tests/local-openai.test.ts`, 1 new `it`): llama registration with the two presets and a fake coordinator: `/v1/models` lists `llama/inkling-2-mini` and `llama/inkling-2-mini-dspark` with `vision: true` while the upstream is down; a chat to `llama/inkling-2-mini` calls `acquire("llama:inkling-2-mini")` and the fake upstream receives `model: "inkling-2-mini"`; an image part to a llama profile with `vision: false` -> 400 `unsupported_content` with no `acquire`.
- Done: green; existing Gufo/Strata tests green (they now see `gufo:<id>` keys through the fake coordinator).

### T7 Electron main and preload

- Owns: `src/electron/main.ts`, `src/electron/preload.cts`.
- Inputs: C2, C6, C7, C8; main.ts:95-160 (host, coordinator, registry), :295-370 (IPC), :229-239 (refreshModels on change).
- Do:
  - Replace `gufoHost` with `createLocalModelHost(servers, { specFor, port })`; cached settings for gufo/strata/llama in `refreshLocalSettings`; coordinator `targets` = gufo profiles + llama profiles + strata; `switchWaitMs(server)` = llama's for llama, gufo's otherwise; registry adds `createLlamaRegistration({ coordinator })`.
  - IPC handlers of C8 with single-flight flags `llamaBinaryJob` / `llamaModelJob` (`AbortController`s; cancel aborts them), progress pushed on `proxy:llamaProgress`, Node `fetch` for GitHub/HF (headers needed; same as the provider's reason), releases cache 10 min. After install / exe check / profile download, persist through `proxy.applySettings(patch)` and push the new state; do not restart a running llama server.
  - `proxy:pickDirectory` via `dialog.showOpenDialog({ title, defaultPath, properties: ["openDirectory", "createDirectory"] })`.
  - start/stop guards accept `llama`; `openExternal` allowlist adds `https://huggingface.co/...`.
  - preload: one bridge method per channel + `onLlamaProgress(cb)`; still no runtime imports besides electron.
- Tests: none new (Electron); `tests/desktop-views.test.ts` green; typecheck, build.
- Done: typecheck, build, full suite green.

### T8 Settings UI page "Llama.cpp"

- Owns: `src/renderer/settings.html`, `src/renderer/settings.ts` (nav, `Scope`, `localOrder`, `views`, `dirty`, save branch, badge), new `src/renderer/llama-view.ts` (page logic), `src/renderer/settings.css`.
- Inputs: C1, C8; renderer/settings.ts:6, :68-80, :100-114, :244-396, :656-661, :800-852; settings.html:33-35, :366-421.
- Do: nav entry "Llama.cpp" after Strata; view `#view-llama` with `data-provider="llama"`, cards:
  1. **Server**: enable switch, state badge (`Llama.cpp: <profile label>`), Stop, port, max concurrent, "Wait for a busy server (minutes)" (`switchWaitMs`), log (as Gufo).
  2. **llama.cpp build**: radio Managed / My own exe. Managed: Source select (ggml-org default, Unsloth), Backend select filled from the chosen release's assets (default per C1; label notes "ROCm: Strix Halo gfx1151 supported; Vulkan if ROCm fails"), Version select (releases, newest first, default first), Binaries folder + Browse (`pickDirectory`), Download/Update button, progress bar (bytes, phase), Cancel; installed line `ggml-org b12606 rocm - D:\LlamaCpp\bin\...`. Own exe: path + Browse (`pickExecutable`) + "Check" (`checkLlamaExecutable`), detected build line or "build unknown".
  3. **Models**: Models folder + Browse; "Hugging Face token (optional)" password field; link input + "List files"; result table: groups with label, size (GB, 2 decimals), kind; radio for one model group, checkboxes for mmproj/draft groups; Download + progress (current file, total) + Cancel; after success "Create profile from this" (adds a draft profile with `modelFile`/`mmprojFile`/`draftFile` from the returned paths, `model` = slug of the quant label, `vision` = mmproj chosen).
  4. **Profiles**: cards with label, id, model id, model file, mmproj, vision, ctx, GPU layers (auto/all/number), flash attention, speculative type select (C1 list, with "draft-mtp = MTP heads" hint), draft file, draft n max / n min, draft GPU layers, extra args, start/request timeout (minutes), Remove; per profile **Start / Switch to this** (disabled while starting/ready), **Download model files** (only with `hf`; disabled while a model job runs), warnings from `llamaStatus`: "needs a newer build" (`too_old`, with the message), "build unknown", "Missing: <file>". "Add profile", "Restore missing presets". Start saves unsaved edits first (as Gufo). A failing gate never disables other cards.
  - Error display: `Failure.message`, plus a hint for `hf_auth_required` ("add a token"), `hf_terms_required` ("accept the model's terms on huggingface.co"), `download_disk_space`.
  - Gufo/Strata pages unchanged.
- Tests: none new (DOM); `tests/desktop-views.test.ts` green; typecheck, build.
- Done: typecheck, build green; M1, M2, M5, M7 manual.

### T9 Docs

- Owns: `README.md`, `ROADMAP.md`.
- Do: sidebar sentence (README l.47) and provider list (l.81) mention Llama.cpp; section "Local model servers" renamed "(Gufo, Strata, Llama.cpp)" with a **Llama.cpp** subsection: what it is; one server at a time across all three and the auto-switch/queue (`switchWaitMs`, 503 `local_model_busy`); build sources (ggml-org default, Unsloth fork), backends and the ROCm default for Strix Halo (Vulkan fallback), version picker and why `/releases/latest` is not used, sha256 check, install folder layout `<dir>/<source>-<tag>-<backend>/`, CUDA runtime zip; own exe and build detection; models folder, HF link forms, quant table, split models, mmproj, resume/cancel, token (encrypted, only sent to huggingface.co); profile fields table with the generated flag per field and `extraArgs`; Inkling 2 Mini presets with the build requirement ("needs a newer build"), sizes, DSpark vs no-MTP note; allowed download hosts; where to delete old builds/models; port 8082. ROADMAP: `[x] Llama.cpp provider (AAP-38; live checks UNTESTED)`, open: tools for local models, router mode, deleting builds/models from the UI.
- Done: docs match the shipped field names and channels.

## Acceptance criteria

| # | Criterion | Proof |
|---|---|---|
| A1 | `providers.llama` defaults (port 8082, ROCm, ggml-org, D: folders, 2 Inkling presets with `requires`), token encrypted, vision needs mmproj | T1 settings tests |
| A2 | Download core: resume with Range after cancel, sha256 verified, mismatch deletes the partial, token never sent to the redirect host, disallowed redirect host refused; Antigravity unchanged | T2 test, existing antigravity-installer tests |
| A3 | Release list ignores `/releases/latest` and drafts, picks backends for both sources, pairs CUDA runtime; install verifies digest, finds nested `llama-server.exe`, cleans up on failure | T3 tests |
| A4 | HF links (5 forms + shorthand quant) parse; invalid host refused; GGUF grouping handles split, mmproj, drafter, `.gguf_file`, imatrix; path traversal refused | T4 tests |
| A5 | Exact generated args incl. quoting and spec flags; split shard and file prechecks; build gate (b12606 blocked, b12607 ok, Unsloth ok, unknown warns) | T5 llama-args test |
| A6 | One server at a time across gufo/strata/llama; cross-server switch waits for in-flight; same profile id in Gufo and llama does not collide | T5 local-models and local-servers tests |
| A7 | `llama/<model>` listed while stopped with vision; lease key `llama:<id>`; 400 before any switch for images on non-vision | T6 test |
| A8 | Whole suite, typecheck, build green | `fnm exec --using default npm.cmd test`, `... npm.cmd run typecheck`, `... npm.cmd run build` |
| A9 | Real downloads, real llama-server, UI flows | M1-M12 (user) |

## Risks

- **Inkling on mainline**: PR #32704 merged after b12606; the gate uses the user's rule (`minBuild 12607`), but the merge commit 690b87d is 5 commits after b12606, so b12607..b12610 may still lack the fix if tags were cut in between. M8 checks the first ggml-org build that answers coherently; raising `minBuild` in the preset is a one-line change.
- **DSpark on mainline is unverified**; that is why the DSpark preset requires the Unsloth build. Whether Unsloth's build loads the ggml-org Q8_0 (mainline layout) is unverified too (M9).
- **ROCm on Windows for gfx1151**: listed in the build matrix, not run here; unified memory may behave differently with `-ngl all`. Vulkan fallback is one select away (M3).
- **Zip layouts inferred** (flat for ggml-org, unknown for Unsloth): the extractor searches for `llama-server.exe` to depth 3; a deeper layout fails with `llama_server_missing` (clear message, no partial install).
- **GitHub redirect host** for release assets is inferred (`objects.githubusercontent.com` / `release-assets.githubusercontent.com`); a different host fails with `download_host_not_allowed` naming the host (M2), and the fix is adding one constant.
- **Flag renames** between builds (`--draft-max` removed): the builder targets current names; an older own exe fails at start with llama-server's own error in the log; `extraArgs` is the escape hatch.
- **`--version` output format** inferred; an unparsable output gives "build unknown" (warn only).
- **Unauthenticated GitHub API**: 60 requests/h; releases are cached 10 min and fetched only on page open / refresh.
- **Disk**: 28 GB model + 0.6 GB mmproj, ROCm zip 285 MB compressed (up to 8 GiB extract cap); free-space check before every job; Defender may lock files during rename (error shown, retry by the user).
- **Signed CDN URLs expire** during long downloads; resume re-resolves through `resolve/`, so a retry after expiry works; a mid-stream expiry shows `download_http_error` and the partial stays.
- **Shared files** (`settings.ts`, `ipc.ts`, `local-servers.ts`, `main.ts`, renderer): T1 and T5 split `local-servers.ts` by line ranges; T7 and T8 are the only writers of main/preload and renderer respectively.
- **Security**: running downloaded unsigned binaries; integrity only vs GitHub's digest. The token is sent only to `huggingface.co`; zip-slip and path traversal guarded by `safeEntryPath`.

## Manual checks (user; nothing here was run by an agent)

- M1 Settings shows "Llama.cpp" under Local models; folders default to `D:\LlamaCpp\bin` / `D:\LlamaCpp\models`; Browse opens a folder picker and saves.
- M2 Managed install, ggml-org, newest version, ROCm: download progress, sha256 ok, installed line shows the tag; note the real redirect host if it fails.
- M3 Start a small model with ROCm, then with Vulkan; note which loads on Strix Halo and tokens/s.
- M4 Unsloth source, `rocm-gfx1151`: installs; the DSpark preset's warning disappears.
- M5 HF link `unsloth/Inkling-2-Mini-GGUF:UD-Q8_K_XL` lists quants with sizes; download, cancel at ~10%, download again: resumes (does not start from 0).
- M6 Split model repo (any `-00001-of-0000N`): all shards downloaded, profile `modelFile` = shard 1, start works.
- M7 Inkling preset with ggml-org b12606 shows "needs a newer build" and Start fails with that message; other profiles still start.
- M8 First ggml-org build after the fix: `llama/inkling-2-mini` answers coherently, image input works (mmproj); report the build number (adjust `minBuild`).
- M9 `llama/inkling-2-mini-dspark` on the Unsloth build: draft acceptance in the log, speed vs no draft; also try the ggml-org Q8_0 file on the Unsloth build.
- M10 Auto-switch: Gufo running, request `llama/inkling-2-mini`: Gufo stops, llama starts, answer arrives; then a Gufo request switches back; no orphan `llama-server.exe`.
- M11 Own `llama-server.exe`: Browse, Check shows the build; Start uses it.
- M12 Gated repo without token -> "add a token" message; with token works; the token never appears in logs.

## How to run

`fnm exec --using default npm.cmd test`, `... npm.cmd run typecheck`, `... npm.cmd run build`. One file: `fnm exec --using default node node_modules/vitest/vitest.mjs run tests/llama-install.test.ts`. Tests write only under `.claude/temp/<name>-tests` and use local fake HTTP servers and in-test zips only.

## Assumptions to confirm

1. Default folders `D:\LlamaCpp\bin` and `D:\LlamaCpp\models`.
2. Inkling `minBuild` 12607 per your rule, to be raised after M8 if needed.
3. Old builds and models are kept on disk (no delete UI in this ticket).
4. `api.github.com` is allowed in addition to the hosts you listed (the release list lives there).
