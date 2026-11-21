# Changelog

## 2026-11-21 AAP-40 - Llama.cpp page detects models on disk, picks files instead of typing, download is its own card

Repo `api-acp-proxy`, branch `AAP-40_llama-model-picker` (from master 93403ad).

### Files changed

- `src/shared/gguf-names.ts` (new): the .gguf name rules (`QUANT`, `SHARD`, `DRAFT_NAME`, `DRAFT_DIR`, `quantOf`) moved here, plus `ggufKind`, `isMainline`, `ggufStem`. Pure, used by main and renderer.
- `src/hf-models.ts`: imports the shared rules; `groupGgufFiles` output unchanged.
- `src/llama-scan.ts` (new): `scanModelsDir` walks the models folder (depth 4, skips hidden entries, symlinks/junctions and non-`.gguf` files, caps 20 000 entries / 2 000 files with `truncated`, missing folder -> `missingDir`), groups via `groupGgufFiles`, split models listed by shard 1, sorted by path.
- `src/shared/ipc.ts`, `src/electron/preload.cts`, `src/electron/main.ts`: new `proxy:llamaScanModels` (scans the saved `modelsDir`) and `proxy:pickModelFile` (GGUF dialog, relative `/` path inside the models folder, absolute outside); `proxy:downloadProfileModels` and `ProfileModelsResult` removed; start error now "File not found: <path> (put it in the models folder or download it, then pick it on the Llama.cpp page)".
- `src/llama-jobs.ts`: `ProfileFiles`, `profileFilesPatch`, `autoMmproj` removed.
- `src/settings.ts`: two comments only; no schema change (`hf` kept).
- `src/renderer/llama-models.ts` (new): `specTypeForDraft`, `profileFromFile`, `foundFileFixes`, `applyFix` (swaps the quant in the label), `usedBy`, `draftMissingFiles` (missing files of a draft from the scan, status result kept for absolute paths).
- `src/renderer/llama-view.ts`, `settings.html`, `settings.css`: card order General, build, Models on disk, Profiles, Download from Hugging Face. Models on disk card (hint, Models folder + Browse, Rescan that saves first when dirty, status line, table with Kind/Quant/Size/Used by, Create profile, "new" badges). Profile file fields are select + Custom path + Browse pickers rebuilt in place after scans; mmproj toggles vision, a draft sets specType when none. "Use found files" / "Use <name>" fixes; "Find on Hugging Face" fills the link and lists only. Download card holds the token; per-profile download and "Create profile from this" removed; after a download the page rescans and marks new rows. Scans on show, on modelsDir change after Save, after download, on Rescan; one scan in flight, a request during it queues one more.
- `tests/llama-scan.test.ts`, `tests/llama-models.test.ts` (new; 2 tests in llama-scan, 3 in llama-models); `tests/llama-jobs.test.ts` deleted.
- `README.md`, `ROADMAP.md`: Llama.cpp section rewritten for the above; ROADMAP item checked (live checks UNTESTED).

### Deviations

- In-flight scan guard is a running flag plus a "scan again" flag instead of a token; the newest result still wins.
- `truncated` is set only when a file beyond `maxFiles` exists (exactly 2 000 files is not truncated).
- Rescan "saves first" note is a `<small>` line under the Models folder field, besides the fixed hint text.
- ROADMAP line carries a short description after the required text.

### Verification

- `fnm exec --using default npm.cmd test`: 42 files passed, 1 skipped; 506 tests passed, 1 skipped.
- `fnm exec --using default npm.cmd run typecheck`: pass (both tsconfigs).
- `fnm exec --using default npm.cmd run build`: pass.
- `tests/hf-models.test.ts` unchanged; grep for `downloadProfileModels|profileFilesPatch|autoMmproj|profile-download|llama-hf-create` in src/tests: no matches; the only `hfDownload` call is in the download card handler; `src/settings.ts` diff is comments only.
- Not run: manual checks M1-M8 in the real app (UI UNTESTED).

### Follow-ups / limitations

- The "Missing:" warning is checked against the current edits and the last scan (relative paths; the saved status is used for absolute paths), so it disappears as soon as a fix is applied. `refreshStatus` (after Save, Start and other status reads) redraws the profile warnings in place via `updateProfileButtons`.
- A Browse result outside the scan shows "(not found)" even when the file exists.
- Classification is by file name only (see plan Risks).

### Commit status

Committed on `AAP-40_llama-model-picker`: cc78b8d (T1), 98d82ab (T2), 7b2b057 (T3), c995679 (T4), b78a516 (polish), and the polish 2 commit (redraw profile warnings on status refresh; see git log). Not pushed or merged.
