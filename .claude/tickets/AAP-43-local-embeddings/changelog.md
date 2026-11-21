# AAP-43 changelog

## 2026-11-21 AAP-43: POST /v1/embeddings on its own llama-server (embed, port 8083) beside the chat model

Repo api-acp-proxy, branch `AAP-43_local-embeddings` (from master 72733cb).

### Files
- `src/settings.ts`: `providers.llama.embedding` (enabled false, port 8083, model `nomic-embed-text-v1.5`, modelFile, ctxSize 2048, gpuLayers "all", maxConcurrent 4, extraArgs); root `superRefine` rejects an embedding port equal to the gufo, strata or llama port.
- `src/shared/ipc.ts`: `embed` in `LocalServerId`, embedding settings view, `LlamaStatusView.embedding`.
- `src/local-servers.ts`: `embed` id and name "Embeddings (llama.cpp)", `EXCLUSIVE_SERVER_IDS`; starting `embed` stops nothing and chat starts never stop it; `stopAll`/close still stop it; new `waitReady(id, signal)`.
- `src/local-host.ts`: the coordinator ignores `embed` when it picks the active or failed server.
- `src/llama-args.ts`: `buildEmbeddingArgs` (`--embedding --pooling mean -c/-b/-ub ctxSize -ngl -np` + extraArgs) and `checkEmbeddingFiles`.
- `src/provider.ts`, `src/acp.ts`, `src/router.ts`: optional `embed` / `canEmbed`, `EmbeddingResult`, `kind: "embedding"`, merged queue stats.
- `src/providers/local-openai.ts`: lists `llama/<model>` with `kind: "embedding"` when enabled; chat or image to it is 400 `model_not_capable`; `embed()` with its own FIFO limiter (`llama-embed` in `/healthz`), no coordinator lease, start through the embed host, headless closed port is 503 `local_server_not_running`; upstream error mapping shared with `generateImage`.
- `src/server.ts`: `handleEmbeddings` and route `POST /v1/embeddings` (base64 / dimensions 400 `unsupported_parameter`; empty, empty item or >256 items 400 `invalid_request`; non-embedding model 400 `model_not_capable`); OpenAI shape in input order.
- `src/electron/main.ts`: embed spec and host (start on first request), IPC start/stop of `embed` outside the coordinator, missing-file status.
- `src/renderer/settings.html`, `llama-view.ts`, `settings.ts`: Embeddings card (Enabled, Model file via the AAP-40 picker, Port, Context, state, Start/Stop).
- `README.md` (Embeddings section), `ROADMAP.md` (row).
- Tests: new `tests/embeddings.test.ts` (A1 table test + headless 503); `tests/local-servers.test.ts` (A2), `tests/settings.test.ts`, `tests/llama-args.test.ts` extended.

### Deviations
- Default modelFile name `nomic-embed-text-v1.5.Q4_K_M.gguf` is a guess (plan fixed only the folder); confirm against LM Studio's file.
- A string `input` goes upstream as a one-item array (text unchanged).
- With embeddings disabled the model is unlisted, so a request is 404 `model_not_found`, not 400.
- Settings changes do not restart a running embed server (README says Stop/Start).
- Renderer: `PageServerId` excludes `embed` (no `card-embed`); `filePicker` retyped to `Pick<LlamaProfileView, FileField>`.

### Verification
- `npm run typecheck`: clean (both projects).
- `npm test`: Test Files 43 passed | 1 skipped (44); Tests 513 passed | 1 skipped (514).
- Not run: `npm run build` (app running from dist/), the desktop card in the app, live check C9 (no llama-server, no nomic GGUF).

### Known limitations
- llama-server splits `-c` across `-np` slots: defaults give 512 tokens per request; may fail on longer Scriptorium chunks. Decide in C9.

### Commit status
Uncommitted.

## Polish 1
- `src/settings.ts`: the embedding port collision check (root `superRefine`) now applies only when `providers.llama.embedding.enabled` is true, so an older settings file with another server on 8083 and no `embedding` key still loads; `ctxSize` doc comment now says per request.
- `src/llama-args.ts`: `buildEmbeddingArgs` passes `-c ctxSize * maxConcurrent` (`-b`/`-ub` stay ctxSize, `-np` maxConcurrent); defaults give `-c 8192 -b 2048 -ub 2048 -np 4`.
- `src/renderer/settings.html`: Embeddings card label "Context per request (tokens)" and hint (text only).
- `README.md`: restored the corrupted backslash paths (`<modelsDir>\<modelFile>`, `<modelsDir>\nomic-ai\nomic-embed-text-v1.5-GGUF\`); the context sentence now says ctxSize is per request and what the server receives.
- Tests: `tests/settings.test.ts` (same case: port clash only when enabled; gufo on 8083 without `embedding` parses); `tests/llama-args.test.ts` (`-c 8192`).
- The "Known limitations" item about 512 tokens per request is resolved by this.
- Not run: `npm run build`.
