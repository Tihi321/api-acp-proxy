---
status: in-progress
request: creative-hub/REQ-0030
repos: [api-acp-proxy]
branch: AAP-44_extra-ideas
updated: 2026-11-22
---

# AAP-44 Embedding server guards (dimension, port, restart on change, "Used by", context note) and reasoning_tokens for local servers

Part of creative-hub HUB-40 (`C:\projects\Personal\creative-hub\.claude\tickets\HUB-40-extra-ideas\plan.md`, ideas 17-23 of REQ-0030). Follow-up to AAP-42 and AAP-43.

Do not touch `%APPDATA%\api-acp-proxy\settings.json` (the user's settings; the user set both Inkling profiles to the IQ4_NL file himself). Do not start the desktop app or a llama-server; tests use the existing fakes. The working tree has uncommitted edits to `.claude/tickets/AAP-43-local-embeddings/events.jsonl` and `plan.md` that are not part of this ticket: leave them out of the AAP-44 commit.

## Scope

1. **reasoning_tokens** (idea 17): llama-server streams `reasoning_content` but its usage has no `completion_tokens_details`, so `/v1/chat/completions` reports `reasoning_tokens: 0` (seen in hub check K1). When the upstream gives none (absent or 0) and reasoning text arrived, estimate it from the reasoning text.
2. **Dimension check** (idea 22): `providers.llama.embedding.dimensions`, default 768 (nomic-embed-text-v1.5), 0 = not checked. A vector of another length is a 502, so a wrong model file never reaches a client (Scriptorium drops its whole index when the dimension changes).
3. **Port check** (idea 23): an enabled embedding server may not use the proxy's own `server.port` (8787).
4. **Restart on change** (idea 19): saving settings that change the embed server's command line (model file, port, context, parallel slots, GPU layers, extra args) or switch it off stops a running `embed` server; the next `POST /v1/embeddings` starts it with the new settings.
5. **"Used by"** (idea 20): the models-folder table names the Embeddings card for the embedding file.
6. **Context note** (idea 18): README and the Context field say the nomic GGUF's native context is 2048. Verified 2026-11-22 from the file's own metadata (`D:\LlamaCpp\models\nomic-ai\nomic-embed-text-v1.5-GGUF\nomic-embed-text-v1.5.Q4_K_M.gguf`: `nomic-bert.context_length = 2048`, `nomic-bert.embedding_length = 768`). The claim that a larger context needs rope-scaling flags was not verified: do not write it.
7. **AAP-43 discoveries wording** (idea 21).
8. ROADMAP line.

## Out of scope

- The Inkling presets in `src/settings.ts:134-149` (self-consistent defaults; the user's own profiles are his).
- Restarting the embed server in place while a request runs (stop, then start on demand, is enough), and any UI for `dimensions` (JSON only, like `extraArgs` defaults).
- The Gufo/Strata/Llama chat servers and the coordinator.

## Files and modules to touch (verified on master, 2026-11-22)

**1. `src/providers/local-openai.ts`** (streaming chat, `handle` at about line 218, the return at about line 258). After the stream ends and before `return { text, stopReason, usage, ... }`: if `usage` is set, `reasoning` is non-empty and `usage.thoughtTokens` is undefined or 0, set `usage.thoughtTokens = Math.min(usage.outputTokens, estimateTokens(reasoning))` (`estimateTokens` from `../usage.js`, 4 characters per token). Upstream values above 0 stay as sent. The no-usage path is unchanged (`src/usage.ts:12` already estimates it).

**2. Dimension**
- `src/settings.ts:176-191` (`llamaEmbeddingSchema`): add `/** Expected vector length; a different one is refused (502). 0 = not checked. nomic-embed-text-v1.5 gives 768. */ dimensions: z.number().int().min(0).default(768),`.
- `src/providers/local-openai.ts:31`: `EmbeddingSettings` picks `"dimensions"` too; `setEmbedding` (`:107-111`) stores it; `updateSettings` (`:119`) passes it (treat a missing value as 768 when the settings come from before the field).
- `embed()` (`:339-363`): after the existing "one vector per input" check, when `embedding.dimensions > 0` and any vector's length differs, throw `new ApiError(502, "upstream_error", \`The embedding server answered ${length}-dimension vectors; providers.llama.embedding.dimensions is ${dimensions}. Check the model file.\`)`.

**3. Port** `src/settings.ts:335-339` (`superRefine`): add the proxy's own port to the map, as `"proxy server"`, only when `settings.server.port` is not 0 (0 picks a free port). The message stays `The embedding port ${port} is already the ${name} port.`

**4. Restart on change**
- `src/llama-args.ts`: a pure `embeddingServerKey(embedding: LlamaEmbedding, modelsDir: string): string` = `JSON.stringify({ enabled, port, args })` where `args` is `buildEmbeddingArgs(embedding, modelsDir)`, or the string `"invalid"` if that throws.
- `src/electron/main.ts`, the `proxy:saveSettings` handler (`:312-317`): before `proxy.applySettings`, remember `embeddingServerKey(llamaSettings.embedding, llamaSettings.modelsDir)` (when `llamaSettings` is loaded); after `refreshLocalSettings()`, if the key changed and the `embed` entry of `servers.list()` is `ready` or `starting`, `await servers.stop("embed")` and log one line ("embedding settings changed: embedding server stopped, it starts again on the next request"). The llama binary path is not part of the key (a changed binary is rare and the README says Stop/Start).
- `README.md:221`: "Saving settings does not restart a running embedding server: Stop and Start it to apply a changed file, port or context." becomes "Saving a changed file, port, context, slot count, GPU layers or extra args stops a running embedding server; the next request starts it with the new settings."

**5. "Used by"** `src/renderer/llama-models.ts:82-86`: `usedBy(path, profiles, embeddingFile?: string)` appends `"embeddings"` when `embeddingFile` matches `path` (same `norm` comparison). `src/renderer/llama-view.ts:255` passes the saved embedding file (`embedDraft.modelFile`, set at `:774`).

**6. Context note**
- `README.md:220`, after the sentence that ends "(with the defaults `-c 8192 -b 2048 -ub 2048 -np 4`, 2048 tokens per request).", add: "The nomic-embed-text-v1.5 GGUF says its native context is 2048 tokens (`nomic-bert.context_length` in the file's metadata), so keep `ctxSize` at 2048 or lower. The vectors have 768 dimensions; `dimensions` (default 768, 0 = not checked) refuses any other length with a 502."
- `src/renderer/settings.html:565`, the first `<small>` of the Context field: append " nomic-embed-text-v1.5 is made for 2048 tokens: keep 2048 or less."

**7. `.claude/tickets/AAP-43-local-embeddings/discoveries.md:2`**: append to the end of the line: " - resolved in AAP-43: `-c` is now ctxSize x maxConcurrent (`src/llama-args.ts:62`), so each request gets ctxSize (2048) tokens." The entry stays (it is a dated record).

**Tests** (update existing files; one new `it` only where a behaviour has no test yet)
- `tests/local-openai.test.ts`: one new `it` next to `"forwards upstream reasoning_content as separate chunks..."` (line 74), using `thinkingProxy`: the upstream usage is `{ prompt_tokens: 5, completion_tokens: 9, total_tokens: 14 }` with no details; the last chunk's `usage.completion_tokens_details.reasoning_tokens` is 4 ("Let me think." is 13 characters) and `completion_tokens` stays 9.
- `tests/embeddings.test.ts`: in the existing refusals `it`, a fake upstream answering a 3-number vector gives 502 `upstream_error` naming `dimensions` (the file's `vector()` is already 768 long, so the other cases still pass).
- `tests/settings.test.ts:36`: the loop also refuses port 8787 (default `server.port`); and `server: { port: 0 }` with embedding port 8787 is accepted. Line 34's `toEqual` gets `dimensions: 768`.
- `tests/llama-args.test.ts`: in the existing `it`, `embeddingServerKey` changes when `modelFile`, `port` or `ctxSize` change or `enabled` becomes false, and is equal for a copy.
- `tests/llama-models.test.ts`: one assertion that `usedBy(file, profiles, file)` contains `"embeddings"`.

## Tasks for workers

- **T1 reasoning_tokens** (local-openai.ts, local-openai.test.ts).
- **T2 settings: dimensions and port** (settings.ts, local-openai.ts embedding settings and `embed`, settings.test.ts, embeddings.test.ts). Contract with T3: the field is `providers.llama.embedding.dimensions`.
- **T3 restart on change** (llama-args.ts, main.ts, llama-args.test.ts, README line 221). Contract: `embeddingServerKey` is exported from `src/llama-args.ts`.
- **T4 UI and docs** ("Used by", settings.html hint, README line 220, discoveries line).
- **T5 ROADMAP** (`ROADMAP.md`, after the AAP-43 line 40, same style):
  `- [x] Embedding guards and local reasoning_tokens (AAP-44; live check UNTESTED): vectors of another length than providers.llama.embedding.dimensions (768) are refused, the embedding port may not be the proxy's own, a changed file/port/context stops a running embedding server so the next request starts it with the new settings, the models table shows "embeddings" under Used by, and reasoning_tokens is estimated from reasoning_content when llama-server reports none (creative-hub HUB-40).`

## Acceptance criteria and the command that proves each

Commands (Bash): `export PATH="/c/Users/Infplane/AppData/Roaming/fnm/aliases/default:$PATH"; cd /c/projects/Personal/api-acp-proxy`, then `npm test` (= `vitest run`), `npm run typecheck`, `npm run build` (as AAP-43 and the hub's `services.json` run them). If `npm run build` fails because `dist/` is in use by the running desktop app, say so and do not stop the app.

| # | criterion | proof |
|---|---|---|
| A1 | `reasoning_tokens` is not 0 when a local server streamed reasoning and reported none | `tests/local-openai.test.ts` new case |
| A2 | A vector of the wrong length is a 502 | `tests/embeddings.test.ts` |
| A3 | An enabled embedding server on the proxy's port is refused; port 0 is not compared | `tests/settings.test.ts` |
| A4 | A changed file, port or context changes the server key | `tests/llama-args.test.ts`; the main.ts wiring by review |
| A5 | "Used by" shows "embeddings" for the embedding file | `tests/llama-models.test.ts` |
| A6 | The context note says only what the GGUF metadata shows | `git diff README.md src/renderer/settings.html`: 2048 and 768, no rope-scaling claim |
| A7 | Nothing else broke | `npm test`, `npm run typecheck`, `npm run build` pass |

## UNTESTED

- The embed server stop on save in the real desktop app (Electron main; no test harness for `main.ts`).
- The dimension check and the reasoning estimate against a real llama-server (needs the proxy restarted on the new build: the user's go-ahead).
- The Llama.cpp page ("Used by" cell, the Context hint) in the running window.
