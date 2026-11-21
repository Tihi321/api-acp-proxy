---
status: done
request: REQ-0008
repos: [api-acp-proxy]
branch: AAP-40_llama-model-picker
updated: 2026-11-21
---

# AAP-40 Llama.cpp page: detect models on disk, pick files instead of typing, download as its own section

User request (verbatim): "make it more easiy, detect model that we have in folder, and leave all option we can have, download model should be separate, that we add link".

Trigger case: `Inkling-2-Mini-IQ4_NL.gguf` and `mmproj-Inkling-2-Mini-Q8_0.gguf` were copied by hand into `D:\LlamaCpp\models\ggml-org\Inkling-2-Mini-GGUF\`; the `inkling-2-mini` preset points at `...-Q8_0.gguf` / `mmproj-...-BF16.gguf`, so the card says "Missing" and the paths had to be typed.

Reading chosen (full): the app scans the models folder and lists every `.gguf` it finds (model / mmproj / draft, split models as one row); a profile can be created from a found model in one click; the three file fields of a profile become pickers filled from the scan (custom path and Browse still possible); a preset whose files are missing but whose folder holds another quant of the same model offers a one-click "Use found files"; every profile field stays; downloading from Hugging Face is only in its own section, never started from a profile card.

Baseline: AAP-38 on master (`.claude/tickets/AAP-38-llama-cpp-provider/plan.md`, contracts C1..C8). Everything not changed here keeps those contracts (C1: `binary` replaced whole, `profiles` replaced as a whole array).

## Scope

1. Scanner of the saved `providers.llama.modelsDir` (bounded, no symlinks/junctions, skips hidden folders) that classifies `.gguf` files with the same rules as the Hugging Face grouping; IPC `proxy:llamaScanModels`.
2. Classification rules (quant, shard, mmproj, draft) moved to a pure shared module used by `hf-models.ts`, the scanner and the renderer (one rule set).
3. Llama.cpp page: a "Models on disk" card (hint text, models folder, Rescan, table with "Create profile" per model); profile cards with pickers for Model file, mmproj file, Draft file (scan entries, "(none)", "Custom path…", Browse…); "Use found files" fix on cards with missing files.
4. File picker IPC `proxy:pickModelFile` (returns a path relative to the saved models folder when inside it).
5. Download moved to its own card "Download from Hugging Face" (link, token, list, pick, download, progress, cancel); after a download the scan refreshes and the new rows are marked. Per-profile download removed (button, IPC, job patch, auto-mmproj).
6. A profile with `hf` and missing files gets "Find on Hugging Face", which only fills the download card's link and lists the files (no download).
7. README Llama.cpp section; ROADMAP line.

## Out of scope

- Deleting or moving model files from the UI; scanning folders other than `modelsDir`; watching the folder for changes (Rescan is manual, plus the automatic triggers in D7).
- Reading GGUF headers (architecture, context length, vision capability); classification is by file name only, like the HF listing.
- Changing the args builder, the build gate, the coordinator, the provider registration, the build install, or Gufo/Strata pages.
- New profile fields; editing `hf` in the UI (it was not editable in AAP-38 either).
- Pre-checking an mmproj in the download listing (the AAP-38 auto-mmproj rule goes away with the per-profile download, D5).

## Decisions

1. **One rule set, extracted, not duplicated.** `QUANT`, `SHARD`, `DRAFT_NAME`, `DRAFT_DIR`, `quantOf` and the kind rule (`imatrix*` skipped, `mmproj*` -> mmproj, drafter names or `dspark`/`mtp` folders -> draft, else model) move from `src/hf-models.ts` to a new pure `src/shared/gguf-names.ts` (no node imports; `src/shared` is compiled by both tsconfigs). `groupGgufFiles` keeps its signature and output exactly (the existing hf-models test proves it). The scanner feeds the files it finds to `groupGgufFiles` as tree entries (`{ type: "file", path: <relative posix>, size }`), so split shards, incomplete splits, mainline variants and quant labels behave exactly as in the download listing.
2. **Scan the saved folder.** `proxy:llamaScanModels` takes no argument and scans the saved `modelsDir` (re-read with `refreshLocalSettings()`), because profile paths are stored relative to the saved folder and Start resolves them against it. If the Models folder field has unsaved edits, Rescan saves the page first (same rule as Start and Download: `deps.isDirty() && !await deps.save()`), and the card says so in its note.
3. **Traversal bounds.** Depth: files directly in `modelsDir` are depth 0; directories are entered down to 4 levels (`a/b/c/d/x.gguf` is found, `a/b/c/d/e/x.gguf` is not). Skipped: every entry whose name starts with `.` (covers `.cache`, `.git`, `.huggingface`), entries for which `Dirent.isSymbolicLink()` is true (Node reports Windows junctions as symbolic links too, so neither is followed), and files not ending in `.gguf` (so `*.gguf.partial` downloads in progress are skipped). Caps: at most 20 000 directory entries read and 2 000 `.gguf` files; hitting a cap stops the walk and sets `truncated: true`. Unreadable subfolders (EACCES/EPERM) are skipped silently; a missing `modelsDir` is `{ ok: true, missingDir: true, files: [] }`, not an error. Sizes come from `fs.promises.stat` of each `.gguf` file only.
4. **Paths returned are relative, posix separators** (`ggml-org/Inkling-2-Mini-GGUF/Inkling-2-Mini-IQ4_NL.gguf`), the same form the presets and HF downloads already store; `resolveModelPath` resolves them on Windows unchanged. A split model's `path` is always its `-00001-of-N` name (computed with `splitShards` from any shard), even when shard 1 is the missing one.
5. **Per-profile download removed; `profile.hf` kept.**
   - Removed: the card button "Download model files", `proxy:downloadProfileModels` (main handler, preload, `ProxyApi.downloadProfileModels`, `ProfileModelsResult`), `profileFilesPatch`, `ProfileFiles`, `autoMmproj` from `src/llama-jobs.ts`, and `tests/llama-jobs.test.ts` (it tests only those two). Keeping the channel unused would be dead code with its own validation and a settings writer nobody calls; nothing outside the page used it.
   - Kept: `LlamaProfile.hf` stays in the schema unchanged (the constraint "no profile field removed"; also, dropping it from the zod object would silently strip it from stored settings on the next save). Its new meaning: where "Find on Hugging Face" points. That button fills the download card's link with `<repo>:<quant>` (revision `main`) or `https://huggingface.co/<repo>/tree/<revision>` (other revisions; no quant preselect then), scrolls to the card and runs List files. The user still picks and clicks Download; nothing downloads implicitly.
   - Auto-mmproj: unreachable after the removal, so it is deleted (not moved).
   - `installPatch` and `customExePatch` stay in `src/llama-jobs.ts` unchanged.
6. **Download card is self-contained.** The HF token field moves into it. The "Create profile from this" button of the download card is removed: after a successful download the page rescans, marks the returned paths as "new" in Models on disk (match on the scanned `path`; a split download returns shard 1 first), and says "Downloaded N files. Create a profile from them under Models on disk." One way to create a profile from files, not two.
7. **When the page scans:** when it is shown (`shown()`), after a Save that changed `modelsDir` (in `load()`, when the saved folder differs from the last scanned one), after a successful HF download, and on Rescan. A scan already in flight is not started twice (token like `loadToken`; a newer result wins).
8. **Pickers are selects, with a custom path escape.** Each of Model file / mmproj file / Draft file is a `<select>` plus a text input and a Browse… button:
   - Options: Model file -> scanned `model` entries; mmproj -> `(none)` + `mmproj` entries; Draft -> `(none)` + `draft` entries + an optgroup "Other models" (a small model is a valid `draft-simple` draft). Option text `folder/name - quant - size` (incomplete splits shown disabled with "(incomplete)").
   - The stored value always appears: if it is not in the scan it is an extra selected option `<value> (not found)`.
   - `Custom path…` shows the text input (prefilled with the current value), which writes the field as typed (relative or absolute, as in AAP-38). Browse… opens `proxy:pickModelFile` and sets the field to its result (relative when inside the saved models folder, absolute otherwise), adding it as an option.
   - Picking an mmproj when the profile had none turns `vision` on; picking `(none)` turns it off (the schema refuses vision without an mmproj). Picking a draft when `specType` is `none` sets the spec type from the name (D10). Both checkbox/select update in place.
   - Selects are rebuilt in place after a scan without re-rendering the cards (typing in other fields is not interrupted), like `updateProfileButtons`.
9. **"Use found files" matcher (pure, `src/renderer/llama-models.ts`).** A field (modelFile, mmprojFile when set, draftFile when set) is *missing* when it is relative and no complete scanned entry has the same path (case-insensitive, `\` read as `/`). Candidates: scanned complete entries of the same kind (draft field: kind draft), in the same folder (case-insensitive), with the same `ggufStem` and a different path. `ggufStem(name)` (in `gguf-names.ts`) = basename without `.gguf`, without the shard suffix, without the quant token found by the QUANT rule (and the separator before it), lower-cased; e.g. `Inkling-2-Mini-Q8_0` and `Inkling-2-Mini-IQ4_NL` -> `inkling-2-mini`, `mmproj-Inkling-2-Mini-BF16` and `mmproj-Inkling-2-Mini-Q8_0` -> `mmproj-inkling-2-mini`. UI: when every missing field has exactly one candidate, one button "Use found files: <names>" applies them all; otherwise one "Use <name>" button per candidate (at most 3 per field, sorted by name). Absolute paths never get a fix. Applying a model fix also replaces the old quant in the label when the label contains it (`Inkling 2 Mini (Q8_0, vision)` -> `Inkling 2 Mini (IQ4_NL, vision)`); nothing else changes. The page is then dirty; Start saves it as today.
10. **Create profile from a found model (pure helper).** Id/model = slug of the file name without `.gguf` and shard suffix, made unique against existing ids and models (`-2`, `-3`, ... as today); label = the file name without `.gguf`; `modelFile` = the entry path; `mmprojFile` = the only mmproj in the same folder, if there is exactly one, and then `vision: true`; `draftFile` = the only draft in the same folder, if exactly one, with `specType` from its name: `dspark*` -> `draft-dspark`, `mtp*` -> `draft-mtp`, `dflash*` -> `draft-dflash`, `eagle*` -> `draft-eagle3`, else `draft-simple`. Other fields: the AAP-38 new-profile defaults (`gpuLayers: "auto"`, `flashAttn: "auto"`, `extraArgs: ""`). No `hf`. The new card is scrolled into view; the message says "Save to keep it" (unchanged wording).
11. **"Used by" column.** Each scanned row lists the profile ids whose model/mmproj/draft field equals its path, so the user sees which files are in use.
12. **No contract change to `LlamaStatusView`.** The card's "Missing: ..." warning still comes from `llamaStatus().profiles[id].missingFiles`; the fix buttons come from the scan. The start error in `main.ts` becomes "File not found: <path> (put it in the models folder or download it, then pick it on the Llama.cpp page)".

## Contracts

### K1 `src/shared/gguf-names.ts` (new, pure, no imports from node)

```ts
export type GgufKind = "model" | "mmproj" | "draft";
export const QUANT: RegExp; export const SHARD: RegExp;          // moved verbatim from hf-models.ts
export function quantOf(path: string): string | undefined;        // moved verbatim
/** undefined = not a model file to list (not .gguf / .gguf_file, or imatrix*). `path` is posix, relative. */
export function ggufKind(path: string): GgufKind | undefined;
export function isMainline(path: string): boolean;                 // a "mainline_support" folder in the path
export function ggufStem(path: string): string;                    // D9
```

`hf-models.ts` imports these; `groupGgufFiles` output is unchanged.

### K2 Scanner `src/llama-scan.ts` (new; node fs only, no electron)

```ts
export interface ScanOptions { maxDepth?: number /* 4 */; maxEntries?: number /* 20_000 */; maxFiles?: number /* 2_000 */ }
export async function scanModelsDir(modelsDir: string, opts?: ScanOptions): Promise<{ missingDir: boolean; truncated: boolean; files: LlamaLocalFileView[] }>;
```

Rules D3/D4; grouping via `groupGgufFiles`; output sorted by `path` (case-insensitive).

### K3 IPC (`src/shared/ipc.ts`, `src/electron/preload.cts`, `src/electron/main.ts`)

```ts
export interface LlamaLocalFileView {
  kind: "model" | "mmproj" | "draft";
  path: string;        // relative to modelsDir, "/" separators; shard 1 for a split model
  folder: string;      // path without the file name ("" at the root)
  name: string;        // file name
  quant?: string;
  size: number;        // bytes, all present shards
  shards?: number;     // total shard count of a split model
  complete: boolean;   // false for a split model with a missing shard
  mainline?: boolean;
}
export type LlamaScanResult = { ok: true; modelsDir: string; missingDir?: boolean; truncated?: boolean; files: LlamaLocalFileView[] } | Failure;
// ProxyApi
llamaScanModels(): Promise<LlamaScanResult>;          // proxy:llamaScanModels
pickModelFile(): Promise<PickResult>;                 // proxy:pickModelFile; dialog filter *.gguf, defaultPath = saved modelsDir;
                                                      // result relative ("/") when inside modelsDir, else absolute
// removed: downloadProfileModels, ProfileModelsResult, proxy:downloadProfileModels
```

### K4 Renderer helpers `src/renderer/llama-models.ts` (new, pure; imports only types and `../shared/gguf-names.js`)

```ts
export function specTypeForDraft(name: string): string;                                          // D10
export function profileFromFile(file: LlamaLocalFileView, files: readonly LlamaLocalFileView[], taken: ReadonlySet<string>): LlamaProfileView;  // D10
export type FileField = "modelFile" | "mmprojFile" | "draftFile";
export interface FoundFix { field: FileField; current: string; candidates: LlamaLocalFileView[] }
export function foundFileFixes(profile: LlamaProfileView, files: readonly LlamaLocalFileView[]): FoundFix[];      // D9; only missing fields with >= 1 candidate
export function applyFix(profile: LlamaProfileView, field: FileField, file: LlamaLocalFileView): LlamaProfileView; // D9 (label quant swap for modelFile)
export function usedBy(path: string, profiles: readonly LlamaProfileView[]): string[];                            // D11
```

## Files

| File | Change |
| --- | --- |
| `src/shared/gguf-names.ts` | new (K1) |
| `src/hf-models.ts` | import the rules from K1; behaviour unchanged |
| `src/llama-scan.ts` | new (K2) |
| `src/shared/ipc.ts` | K3 types and `ProxyApi`; remove `downloadProfileModels`, `ProfileModelsResult` |
| `src/electron/preload.cts` | add `llamaScanModels`, `pickModelFile`; remove `downloadProfileModels` |
| `src/electron/main.ts` | handlers `proxy:llamaScanModels`, `proxy:pickModelFile`; remove `proxy:downloadProfileModels` and its imports; start error text (D12) |
| `src/llama-jobs.ts` | remove `ProfileFiles`, `profileFilesPatch`, `autoMmproj` (and the `hf-models` import); header comment |
| `src/settings.ts` | comments only: `LLAMA_PRESETS` ("corrected by Download model files" -> "pick the files you have, or Use found files"), `hf` ("where Find on Hugging Face points") |
| `src/renderer/llama-models.ts` | new (K4) |
| `src/renderer/llama-view.ts` | Models on disk card logic, pickers, fixes, Find on Hugging Face, download card changes, removal of the per-profile download |
| `src/renderer/settings.html` | card order and markup (T3) |
| `src/renderer/settings.css` | small additions for the table/new badge/picker row only if the existing classes do not cover them |
| `tests/llama-scan.test.ts` | new |
| `tests/llama-models.test.ts` | new |
| `tests/llama-jobs.test.ts` | deleted (tests only removed functions) |
| `README.md`, `ROADMAP.md` | T4 |

## Tasks

Order: T1 -> T2 -> T3 -> T4 (T4 may run in parallel with T3 once T2 is done). `npm.cmd run typecheck` covers both tsconfigs; after T1 the renderer project fails only on the removed `downloadProfileModels` call in `llama-view.ts`, which T3 removes. Run commands as `fnm exec --using default npm.cmd test`, `... npm.cmd run typecheck`, `... npm.cmd run build`.

### T1 Shared rules, scanner, IPC, per-profile download removal

- Owns: `src/shared/gguf-names.ts`, `src/hf-models.ts`, `src/llama-scan.ts`, `src/shared/ipc.ts`, `src/electron/preload.cts`, `src/electron/main.ts`, `src/llama-jobs.ts`, `src/settings.ts` (comments), `tests/llama-scan.test.ts`, delete `tests/llama-jobs.test.ts`.
- Inputs: D1-D5, D12, K1-K3; existing `groupGgufFiles`, `splitShards` (`src/llama-args.ts`), `pickExecutable` handler as the dialog pattern, `refreshLocalSettings`.
- Do: extract K1 (move, do not rewrite, the regexes); implement K2 with `fs.promises.readdir(dir, { withFileTypes: true })`, an explicit stack/queue with depth, and the caps; `proxy:llamaScanModels` = refresh settings, scan, return K3 (errors -> `Failure` via `llamaFailure`); `proxy:pickModelFile` = open dialog (`openFile`, filters `GGUF` `gguf` + all files, defaultPath saved modelsDir when it exists), convert with `path.relative` when the result is inside modelsDir (no `..`, not absolute) to `/` separators; remove the per-profile download (D5).
- Test (`tests/llama-scan.test.ts`, `tempRoot("llama-scan")`, small files written with `writeFileSync`): one `it` for classification: Inkling IQ4_NL model + mmproj Q8_0 in `ggml-org/Inkling-2-Mini-GGUF/`, a complete 3-shard split in `o/r/Q4_K_M/` (one row, `path` = shard 1, `shards: 3`, size = sum), a split missing shard 1 (`complete: false`, path still `-00001-of-`), `dspark-x-Q8_0.gguf` (draft), `imatrix.gguf` (absent); one `it` for bounds: `.cache/x.gguf`, `m.gguf.partial`, a file at depth 4 (found) and depth 5 (absent), a junction (`fs.symlinkSync(target, link, "junction")`) to a folder with a `.gguf` (absent), missing dir -> `missingDir: true`, and `maxFiles: 1` -> `truncated: true`.
- Done: `npm.cmd test` green (hf-models test unchanged and passing); `tsc --noEmit` (node project) passes.

### T2 Renderer pure helpers

- Owns: `src/renderer/llama-models.ts`, `tests/llama-models.test.ts`.
- Inputs: D9-D11, K4, K1 `ggufStem`, `LlamaLocalFileView`.
- Test (one or two `it`s, no DOM): the Inkling case with the real preset from `LLAMA_PRESETS` and the two found files -> `foundFileFixes` returns modelFile and mmprojFile with exactly one candidate each, a different model stem in the same folder is not a candidate, an absolute path gets none; `applyFix` sets the path and swaps `Q8_0` -> `IQ4_NL` in the label; `profileFromFile` on the IQ4_NL entry gives a unique id, `mmprojFile` set and `vision: true`, and with two mmproj files in the folder leaves `mmprojFile` unset and `vision: false`.
- Done: tests green; renderer helpers compile under `tsconfig.renderer.json`.

### T3 Llama.cpp page

- Owns: `src/renderer/llama-view.ts`, `src/renderer/settings.html`, `src/renderer/settings.css`.
- Inputs: D2, D5-D11, K3, K4; existing `updateProfileButtons` in-place pattern, `deps.save()`.
- Do:
  - Card order: General, llama.cpp build, **Models on disk**, Profiles, **Download from Hugging Face**.
  - Models on disk: hint (`<p class="note">`): "1. Put .gguf files in the models folder (subfolders up to 4 levels deep are found), or download them with a link in Download from Hugging Face below. 2. Create a profile from a model here, or pick the files in an existing profile. 3. Start." Then the Models folder field (moved here, Browse… kept), Rescan button, status line ("Scanned D:\LlamaCpp\models: 3 files", "Folder does not exist yet", "Stopped after 2000 files", errors), table: File (folder/name, mono), Kind, Quant, Size, Used by, action ("Create profile" for complete models; incomplete rows show "(incomplete)" and no action); rows from the last download get a "new" badge; empty state "No .gguf files found in <dir>."
  - Profile cards: replace the three text inputs with the pickers (D8); render fixes (D9) under the warnings; "Find on Hugging Face" (D5) next to the missing warning when `profile.hf` is set; remove the "Download model files" button, `downloadProfile`, `profileJob`.
  - Download card: HF token field (moved), link, List files, table, Download, Cancel, progress (unchanged logic); remove "Create profile from this" and `createProfile`/`storedPath`; after success: rescan, mark new rows, message (D6).
  - Scan triggers (D7) with an in-flight token.
  - All element ids that `settings.ts` reads through generic `providers.llama.*` field binding (`providers.llama.modelsDir`, `providers.llama.hfToken`) keep their ids, only move in the DOM.
- Done: `npm.cmd run typecheck` and `npm.cmd run build` pass; no reference to `downloadProfileModels`, `llama-hf-create` or `profile-download` left (`rg` proof).

### T4 Docs

- Owns: `README.md`, `ROADMAP.md`.
- Do: Llama.cpp section: new "Models on disk" bullet (scan rules: depth 4, hidden folders and links skipped, `.partial` skipped, same classification as the HF listing, Rescan and when it runs automatically, Create profile defaults); "Models" bullet renamed to "Download from Hugging Face" (no per-profile download; Find on Hugging Face fills the link); profile fields table: `modelFile`/`mmprojFile`/`draftFile` are picked from the scan, Custom path or Browse; `hf` row = "where Find on Hugging Face points" (auto-mmproj text removed); presets paragraph: "pick the quant you have; Use found files swaps a missing preset file for another quant of the same model in the same folder" instead of "Download model files lists the repository and corrects them". ROADMAP: add `[x] Llama.cpp model picker (AAP-40; live checks UNTESTED)`.
- Done: no README mention of "Download model files" or the auto-picked mmproj; field names match the code.

## Acceptance criteria (with proofs)

1. The scanner finds models, mmproj and drafts, groups split shards to shard 1 and marks incomplete splits. Proof: `tests/llama-scan.test.ts` classification test.
2. The scanner never goes deeper than 4 folder levels, never follows junctions/symlinks, skips hidden folders and `.partial` files, handles a missing folder, and stops at the cap with `truncated`. Proof: `tests/llama-scan.test.ts` bounds test.
3. HF grouping behaviour is unchanged after the extraction. Proof: `tests/hf-models.test.ts` passes untouched (`git diff --stat tests/hf-models.test.ts` empty).
4. The Inkling preset with IQ4_NL + mmproj Q8_0 on disk gets a one-click fix to exactly those files. Proof: `tests/llama-models.test.ts`.
5. Create profile prefills model, the single same-folder mmproj (vision on) and leaves mmproj empty when ambiguous. Proof: `tests/llama-models.test.ts`.
6. No profile field is removed. Proof: `git diff src/settings.ts` touches comments only; `LlamaProfileView` in `src/shared/ipc.ts` keeps every field (diff review).
7. No download can start from a profile card. Proof: `rg -n "downloadProfileModels|profileFilesPatch|autoMmproj|profile-download|llama-hf-create" src tests` returns nothing; the only `hfDownload` call is in the download card handler.
8. `npm.cmd test`, `npm.cmd run typecheck`, `npm.cmd run build` pass (all via `fnm exec --using default`).
9. README describes the shipped behaviour (T4 Done check).

## Manual checks (user; UNTESTED by agents)

- M1 (Inkling IQ4_NL, end to end): with `Inkling-2-Mini-IQ4_NL.gguf` and `mmproj-Inkling-2-Mini-Q8_0.gguf` in `D:\LlamaCpp\models\ggml-org\Inkling-2-Mini-GGUF\`, open Llama.cpp. Models on disk lists both (model IQ4_NL, mmproj Q8_0, sizes plausible). The `inkling-2-mini` card shows "Missing: ..." and "Use found files: Inkling-2-Mini-IQ4_NL.gguf, mmproj-Inkling-2-Mini-Q8_0.gguf". Click it: the pickers show those files, the label reads "Inkling 2 Mini (IQ4_NL, vision)". Click Start: the page saves, the server starts (with a build that passes the gate), "Missing" disappears, and a vision request to `llama/inkling-2-mini` answers.
- M2: Instead of the fix, click "Create profile" on the IQ4_NL row: a new card with model + mmproj + vision on; Save; Start works; "Used by" shows the new id on both rows.
- M3: In a card, open the Model file picker: every scanned model is listed; choose "Custom path…", type an absolute path, Save, reopen the page: the value is kept and shown as "(not found)" if it does not exist. Browse… to a file inside the models folder stores a relative path; outside, an absolute one.
- M4: Pick an mmproj on a text-only profile: vision turns on; pick "(none)": vision turns off; Save succeeds both times.
- M5: Copy a new `.gguf` into a subfolder while the page is open, click Rescan: it appears. A file in `.cache\` or 5 levels deep does not.
- M6: Download from Hugging Face: paste a small repo link, List files, pick a small quant, Download (progress, Cancel works and resumes on retry); on success the rows appear in Models on disk marked "new"; Create profile from them.
- M7: The `inkling-2-mini-dspark` card (files absent) shows "Find on Hugging Face": it fills `unsloth/Inkling-2-Mini-GGUF:UD-Q8_K_XL` in the download card and lists the files, and nothing downloads until Download is clicked.
- M8: Change the Models folder field and click Rescan: the page saves first, then lists the new folder.

## Risks

- **Name-only classification.** A vision projector not named `mmproj*` (some repos use `*-mmproj-*.gguf` or `vision-*.gguf`) is listed as a model; a draft model without a drafter name is a model (it is still offered in the Draft picker's "Other models"). Same limitation as the HF listing; accepted for one rule set.
- **Stem matching false negatives/positives.** Repos that name quants unusually (e.g. `q4_k_m` lower-case is handled by the case-insensitive QUANT; `4bit` is not) get no fix; the picker still works. A different model with the same stem in the same folder would be offered, which is harmless (the user clicks it).
- **Junction detection on Windows.** Relies on `Dirent.isSymbolicLink()` reporting junctions; the test creates a real junction to prove it on this machine.
- **Large folders on slow disks.** Bounded by the caps; the scan runs in main asynchronously and the UI shows "Scanning…".
- **Removing the per-profile download changes AAP-38 behaviour** a user may have relied on; "Find on Hugging Face" keeps the presets one click from their files. Old settings keep `hf`.
- **Moving the token and models-folder fields in the DOM** could break generic field binding in `settings.ts` if ids change; T3 keeps the ids.
