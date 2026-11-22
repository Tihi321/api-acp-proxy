# AAP-44 changelog

## 2026-11-22 - AAP-44 Embedding guards and local reasoning_tokens

Outcome: embedding dimension and port guards, embed server stop on changed settings, "embeddings" under Used by, context note and reasoning_tokens estimate for local servers. Branch `AAP-44_extra-ideas` (from master), repo api-acp-proxy.

Files:
- `src/providers/local-openai.ts`: streamed reasoning without reported reasoning_tokens gets `thoughtTokens` = min(output tokens, estimate of reasoning text); `embed()` refuses vectors whose length differs from `dimensions` (502 upstream_error); `dimensions` is carried by the embedding settings (missing = 768).
- `src/settings.ts`: `providers.llama.embedding.dimensions` (default 768, 0 = not checked); an enabled embedding server may not use `server.port` (skipped when that is 0).
- `src/llama-args.ts`: `embeddingServerKey`.
- `src/electron/main.ts`: `proxy:saveSettings` stops a ready/starting `embed` server when the key changed.
- `src/renderer/llama-models.ts`, `llama-view.ts`: Used by names "embeddings" for the embedding file.
- `src/renderer/settings.html`, `README.md`: context note (2048 native, 768 dimensions; no rope-scaling claim), restart-on-change text, port list now includes the proxy port.
- `ROADMAP.md`: AAP-44 line. `.claude/tickets/AAP-43-local-embeddings/discoveries.md`: resolved note.
- Tests: `tests/local-openai.test.ts` (new case), `embeddings.test.ts`, `settings.test.ts`, `llama-args.test.ts`, `llama-models.test.ts` (new case).

Deviations: README port sentence (line 218) also names the proxy server port. `tests/embeddings.test.ts` `start()` passes `dimensions: 768` to the provider.

Verification: `npm test` 515 passed, 1 skipped; `npm run typecheck` and `npm run build` pass.
Not run (UNTESTED): embed server stop on save in the desktop app (main.ts has no harness); dimension check and reasoning estimate against a real llama-server; Llama.cpp page Used by cell and Context hint in the window.

Commit: see git log on `AAP-44_extra-ideas` (not merged, not pushed).
Polish 1: the Port hint names the proxy's own port (checker note)
