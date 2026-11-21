---
status: draft
request: creative-hub/REQ-0030
repos: [api-acp-proxy]
branch: AAP-43_local-embeddings
updated: 2026-11-21
---

# AAP-43 `POST /v1/embeddings`: nomic-embed-text-v1.5 on its own small llama-server beside the chat model

Part of creative-hub HUB-38 "ACP for all" (`C:\projects\Personal\creative-hub\.claude\tickets\HUB-38-acp-for-all\plan.md`, contract C6, decision 4). Scriptorium's RAG embeds every chapter with `nomic-embed-text-v1.5` through LM Studio (`~\Scriptorium\config\roles.md` `embeddings: lmstudio/text-embedding-nomic-embed-text-v1.5`; 768 dimensions; its sqlite-vec index in `~\Scriptorium\index` is rebuilt when the dimension changes). The hub wants LM Studio gone, so the proxy must serve the **same model file** (same GGUF as LM Studio's, so stored vectors stay comparable and nothing is re-indexed). Today the proxy has no such route (`src/server.ts:498-515` lists healthz, models, chat/completions, images generations/edits, responses, mcp; anything else is 404).

Starts after AAP-40 and AAP-41 (playground redesign, another session's ticket) and AAP-42 are merged (same working tree; AAP-40 changes `src/settings.ts`, `src/electron/main.ts`, the Llama.cpp page; AAP-42 changes `src/providers/local-openai.ts`). Read first: `.claude/tickets/AAP-38-llama-cpp-provider/plan.md` (contracts C1..C8), `.claude/tickets/AAP-40-llama-model-picker/plan.md` (models-folder scan and file pickers), `README.md` local-provider sections.

## Why a second server, not a profile of the chat server

The coordinator (`src/local-models.ts`) and `LocalServerManager.start` (`src/local-servers.ts:116-159`, the sweep at `:138-141`) keep one local server at a time and stop any other server the app owns before spawning. An embedding model as a normal profile would evict the chat model (Strata, ~38 GB) on every chapter index and back, minutes each way. nomic-embed-text-v1.5 is ~0.1-0.3 GB, so it runs as its own always-allowed process.

## Scope

1. Settings: `providers.llama.embedding` = `{ enabled: boolean (default false), port: number (default 8083), model: string (default "nomic-embed-text-v1.5"), modelFile: string (relative to `providers.llama.modelsDir`, default "nomic-ai/nomic-embed-text-v1.5-GGUF/" + the file name the user copies there, see below), ctxSize: number (default 2048), gpuLayers: "all" | number (default "all"), maxConcurrent: number (default 4), extraArgs: string (default "") }`. Uses the same llama-server binary as the chat profiles (`providers.llama.binary`). Unknown fields kept as the AAP-38 C1 rule says for `binary`/`profiles`.
2. A fourth local server id `embed` ("Embeddings (llama.cpp)") in `LOCAL_SERVER_IDS` / `LOCAL_SERVER_NAMES`. `LocalServerManager.start`: the stop-others sweep never stops `embed`, and starting `embed` stops nothing; `stopAll` and app quit still stop it. Its port must differ from gufo 8081, strata 8080, llama 8082 (settings validation error otherwise).
3. Args (new `buildEmbeddingArgs` in `src/llama-args.ts`, next to `buildLlamaArgs`): `-m "<modelsDir>\<modelFile>" --host 127.0.0.1 --port {port} --alias <model> --embedding --pooling mean -c <ctxSize> -b <ctxSize> -ub <ctxSize> -ngl <gpuLayers> -np <maxConcurrent>` plus `extraArgs`. The same file precheck as chat profiles (`checkLlamaFiles` / `checkModelFiles`).
4. Model listing: when `embedding.enabled`, `/v1/models` lists `llama/<model>` with `kind: "embedding"` (extend the `kind` union `llm | image` with `embedding` where the listing and `ModelInfo` carry it). A chat or image request to it is 400 `model_not_capable` before any start (same place as the image-model check, `local-openai.ts:104-106`).
5. Route `POST /v1/embeddings` (new handler in `src/server.ts`, dispatched in the route table at `:509-513`, body limit `server.maxBodyBytes`): body `{ model: string, input: string | string[], encoding_format?: "float", dimensions?: never, user?: string }`. `encoding_format: "base64"` and `dimensions` are 400 `unsupported_parameter`; an empty `input` array or an empty string item is 400 `invalid_request`; more than 256 items is 400. The model must resolve to the llama provider's embedding model, else 400 `model_not_capable` (also for every ACP provider and gufo/strata models). Answer: `{ object: "list", data: [{ object: "embedding", index, embedding: number[] }], model: "llama/<model>", usage: { prompt_tokens, total_tokens } }`, data in input order. The input text is sent as is: the client adds nomic's `search_document: ` / `search_query: ` prefixes (Scriptorium does).
6. `LocalOpenAiProvider` (llama registration) gets `embed(model, input, signal)`: ensures the `embed` server runs (desktop app: `LocalServerManager.start` with the embed spec on the first request, waits for `GET /v1/models` on its port like `startAndWait`, start timeout `startTimeoutMs` 10 min; headless CLI without a manager: pass straight through, and no listener gives 503 `local_server_not_running` "Embeddings are not running - start them from the app"), then POSTs `http://127.0.0.1:<embedding.port>/v1/embeddings` with `{ model, input }` using Node's global fetch (as the chat path), maps upstream errors like `generateImage` does (`local-openai.ts:260-269`). No coordinator lease (not exclusive). Its own FIFO limit of `embedding.maxConcurrent` (reuse `src/limiter.ts`), counted in `/healthz` as provider `llama-embed` `{active, queued, max_concurrent}`.
7. Desktop UI (Llama.cpp page): an "Embeddings" card with Enabled, Model file (the AAP-40 file picker over the models-folder scan, "Custom path…", Browse), Port, Context, and the state line of the `embed` server with Start/Stop (as the profile cards show theirs). The local servers list shows `embed` automatically once it is a `LOCAL_SERVER_ID` (check the views that iterate `LOCAL_SERVER_IDS` still render).
8. README: an "Embeddings" section (what runs, the port, that it runs beside the chat model, the prefixes are the client's job, how to point it at LM Studio's nomic file); ROADMAP line.

## Out of scope

- Any other embedding model or provider (Gufo's binary may have `/v1/embeddings`: not used), Responses API, MCP tools for embeddings.
- Downloading the model (the user copies LM Studio's file; the AAP-40 download card can fetch `nomic-ai/nomic-embed-text-v1.5-GGUF` too, but that is the user's choice).
- Changing the chat coordinator, Gufo or Strata.
- Re-indexing anything in Scriptorium.

## Inputs the worker needs

- The model file: LM Studio's own nomic GGUF (not under `C:\Users\Infplane\.lmstudio\models`: checked 2026-11-21; LM Studio bundles it with the app). The user copies it (creative-hub user step U5) to `D:\LlamaCpp\models\nomic-ai\nomic-embed-text-v1.5-GGUF\` keeping its file name; the worker sets `modelFile` to that relative path in the live settings only with the user's yes (live settings are not part of the code change).
- llama-server is not installed on this PC yet (`D:\LlamaCpp\bin` missing): unit tests use the fake spawn/probe the existing local-server tests use; the live check waits for user step U2.

## Files

`src/settings.ts` (schema, defaults, validation), `src/llama-args.ts`, `src/local-servers.ts` (ids, names, sweep exemption), `src/providers/local-openai.ts` (`embed`, kind check, listing), `src/provider.ts` (optional `embed` on the provider interface, `ModelInfo.kind`), `src/server.ts` (route, handler, healthz), `src/limiter.ts` (reuse only), `src/electron/main.ts` (give the llama registration the embed spec builder and the manager, as it does for chat at `:120-168`), the Llama.cpp page renderer files changed by AAP-40, `src/shared/ipc.ts` if the card needs IPC, `README.md`, `ROADMAP.md`. Tests: `tests/local-servers.test.ts`, `tests/local-openai.test.ts` or a new `tests/embeddings.test.ts` (one file only).

## Contract with other tickets

creative-hub C6: `POST /v1/embeddings` with `model: "llama/nomic-embed-text-v1.5"` returns 768-dimension float vectors in the OpenAI shape; never evicts the loaded chat model. Scriptorium uses it by config only: `acp` row `- id: llama/nomic-embed-text-v1.5, family: nomic, embedding: true` and `roles.md` `embeddings: acp/llama/nomic-embed-text-v1.5` (its `embedWithPrefix` adds the nomic prefixes for ids matching `/nomic/i` on a `local: true` provider, which `acp` is).

## Acceptance and tests

- A1 `POST /v1/embeddings` with a string and with a two-item array returns the OpenAI shape in input order; `encoding_format: "base64"` is 400; a chat model id is 400 `model_not_capable`. Test: one table-driven test through the HTTP server with a fake upstream (as `tests/image-generation.test.ts` does for images).
- A2 Starting a chat server (gufo, strata or llama) does not stop a running `embed` server, and starting `embed` stops nothing. Test: one case in `tests/local-servers.test.ts` with the fake spawn.
- A3 `npm test`, `npm run typecheck` pass; the desktop page builds (`npm run build`).
- Live (creative-hub check C9; GPU, small; needs U2 and U5 and LM Studio up): for `search_document: The lighthouse keeper counted ships.`, `search_query: who counted ships`, `search_document: Rain on the salt line.` the proxy's and LM Studio's vectors have 768 dimensions and cosine >= 0.999 each; and the longest chunk Scriptorium's indexer sends (read its chunk size in `scriptorium/src/engine/memory/index.ts` and send one of that size) embeds without "input too large". If the cosine is lower, do not tune silently: report the numbers (ctxSize / pooling are the suspects).

## ROADMAP row

`- [x] Embeddings (AAP-43; live check UNTESTED): POST /v1/embeddings with llama/nomic-embed-text-v1.5 on its own llama-server (port 8083) beside the loaded chat model, never evicting it; for Scriptorium's RAG without LM Studio (creative-hub HUB-38).`
