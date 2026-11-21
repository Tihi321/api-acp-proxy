# Changelog AAP-38

## 2026-11-21 AAP-38 Llama.cpp local provider

Outcome: a third local server `llama` ("Llama.cpp") with `llama/<model>` profiles, one local server at a time across Gufo, Strata and Llama.cpp, managed llama.cpp builds (ggml-org, Unsloth) or an own `llama-server.exe`, Hugging Face GGUF downloads, two Inkling 2 Mini presets, and a Settings page. Live behaviour is UNTESTED (M1-M12).

### api-acp-proxy, branch `AAP-38_llama-cpp-provider` (from master 2c37d17)

- `src/settings.ts`: `providers.llama` (port 8082, `switchWaitMs` 30 min, `modelsDir` `D:\LlamaCpp\models`, `binary` managed/custom with dir `D:\LlamaCpp\bin`, source ggml-org, backend rocm, arch x64, `installed`, `customPath`/`customBuild`), encrypted `hfToken`, llama profile schema (vision requires mmproj, unique id/model), `LLAMA_PRESETS` (inkling-2-mini, inkling-2-mini-dspark), `restoreMissingLlamaPresets`. The Gufo schema now extends a shared `profileBase` (behaviour unchanged).
- `src/shared/ipc.ts`: llama settings views and patch, C8 views (`LlamaProgressView`, `LlamaStatusView`, release/HF views incl. `selectable`), `Failure`, `ProxyApi` methods; `LocalServerId` gains `llama`.
- `src/download.ts` (new): host policy with exact hosts and suffixes, guarded fetch with per-hop headers, resumable `.partial` download with Range, size and sha256 checks, zip extraction with a cap, free-space check, `DownloadError` codes. `src/providers/antigravity-installer.ts` uses it; behaviour and exports unchanged.
- `src/llama-releases.ts`, `src/llama-install.ts` (new): release list via `/releases?per_page=20` (drafts dropped, never `/releases/latest`), Windows asset to backend mapping for both sources, CUDA runtime pairing, install verified against the GitHub digest (Unsloth sha json fallback), exe search to depth 3, cleanup on failure, `--version` build probe.
- `src/hf-models.ts` (new): HF link parser (URL forms and `owner/repo:QUANT`), GGUF grouping (split shards, incomplete groups, mmproj, drafters, imatrix skipped, `.gguf_file` mainline files), paginated tree listing, sequential resumable downloads; the token goes only to `huggingface.co`.
- `src/llama-args.ts` (new): args builder with quoted paths and spec flags, shard-aware file checks, build gate with the "needs a newer build" messages.
- `src/local-models.ts`: coordinator keys `gufo:<id>`, `llama:<id>`, `strata`; targets list and per-server switch wait; unknown key gives 404 "Unknown local model". `src/local-host.ts` (new): host moved out of main.ts and generalised to three servers. `src/local-servers.ts`: `llama` id and name; the path precheck knows `-m`, `-md`, `-mm`, `--model-draft`, `--spec-draft-model`.
- `src/providers/local-openai.ts`: Gufo or llama profiles through an adapter, lease via `targetKey`, `createLlamaRegistration` / `llamaRegistration`. `src/controller.ts`: llama in the default registry. `src/renderer/usage-view.ts`: llama series.
- `src/electron/main.ts`, `src/electron/preload.cts`: llama spec (binary, gate, files, args), coordinator over all three servers, C8 IPC handlers with single-flight binary/model jobs, progress channel, 10-minute release cache, folder picker, start/stop for llama, `openExternal` allows huggingface.co.
- `src/renderer/settings.html`, `settings.ts`, `llama-view.ts` (new), `settings.css`: "Llama.cpp" page with Server, build, Models and Profiles cards.
- `README.md`, `ROADMAP.md`: Llama.cpp section and roadmap entry.
- Tests: new `tests/download.test.ts`, `tests/llama-install.test.ts`, `tests/hf-models.test.ts`, `tests/llama-args.test.ts`; extended settings, local-servers, local-models, local-openai and controller tests.

### Deviations from the plan

- `downloadResumable` takes `httpCodes?: "hf"` (named in the C5 text, absent from its signature).
- `listHfFiles` returns `{ groups, quant? }`; groups carry `selectable` (also added to `HfFileGroupView`).
- `checkBuild`: an own exe with a sources-only requirement (DSpark preset) warns ("unknown") instead of failing, since an own exe may be an Unsloth build.
- A CUDA install refuses with `llama_no_digest` when the cudart zip has no digest.
- `proxy:hfListFiles` runs inside the model job (counts for `download_busy`); release and listing requests use timeouts.
- The UI saves unsaved edits before download, list, check and profile download, not only before Start.
- The controller test expects llama `stopped` (enabled by default per C1), not disabled.
- `tests/local-servers.test.ts` needed a second id-list line (post-stopAll state) updated.

### Verification

- `fnm exec --using default npm.cmd test`: 40 files passed, 1 skipped; 500 tests passed, 1 skipped.
- `fnm exec --using default npm.cmd run typecheck`: clean.
- `fnm exec --using default npm.cmd run build`: passed.
- One earlier full run had 4 logout-test failures under load; they passed alone and in the full rerun above (see discoveries.md).
- Not run: M1-M12 (real downloads, real llama-server, ROCm/Vulkan on Strix Halo, UI flows), the Electron app and its IPC handlers, the CUDA runtime and Unsloth sha-json install paths, `probeLlamaVersion`, `listHfFiles` / `downloadHfFiles` against HF.

### Follow-ups and known limitations

- Inferred: Inkling file names (self-correct via "Download model files"), zip layouts, GitHub asset redirect hosts, the Unsloth sha json format, `--version` output; `minBuild` 12607 may need raising after M8.
- Open roadmap items: tools for local models, router mode, deleting builds/models from the UI.

### Commit status

Committed on `AAP-38_llama-cpp-provider` (not pushed, not merged).
