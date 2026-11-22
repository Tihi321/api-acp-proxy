# Changelog AAP-46

## 2026-11-22 AAP-46: Strata images from /v1/models, local cached tokens, hf.mmproj/draft on found files

Repo api-acp-proxy, branch `AAP-46_strata-vision-and-cache`.

- `src/providers/local-openai.ts`: `listModels` (no-profile branch) sets `vision: true` for a model whose `architecture.input_modalities` contains `image`; `acceptsImages` uses that when the provider has no profiles; `prepareModel` calls `acceptsImages` (same result for Gufo/Llama); the stream usage maps `prompt_tokens_details.cached_tokens` to `cachedReadTokens` and `inputTokens = prompt_tokens - cached`. `prompt_tokens` is read for chat only in the stream usage handler; the other read (embeddings usage, ~line 363) is not cached-token related and is unchanged.
- `src/renderer/llama-models.ts`: `applyFix` sets `hf.mmproj` / `hf.draft` to the file name for an mmproj or draft fix when the profile already has one.
- `README.md`, `ROADMAP.md`: one sentence and one line as planned.
- Tests: `tests/local-openai.test.ts` (new Strata vision test; the reasoning/usage test now checks `prompt_tokens` 100 and `cached_tokens` 80), `tests/llama-models.test.ts` (one mmproj assertion).

Deviations: the cached-tokens assertions extend the existing usage test (its fake usage chunk changed from 5 to 100 prompt tokens) instead of a separate test.

Verification: `yarn test` 43 files passed, 1 skipped; 516 tests passed, 1 skipped (517). `yarn typecheck` exit 0. Not run: any build, a real Strata request, real cached numbers (hub K1/K3/K4).

Commit: see git log on the branch (not merged, not pushed).
Polish 1: cached and prompt token counts from upstream count only when they are finite numbers (checker note)
