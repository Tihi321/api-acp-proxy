# AAP-71 changelog

## 2026-11-28 - AAP-71: the seven AAP-70 follow-ups built (Ollama loaded num_ctx limit, DeepSeek cost, Overview DeepSeek row, `thinking`, persisted usage-limit state, `max_tokens` clamp, full typecheck)

Repo `C:/projects/Personal/api-acp-proxy`, branch `AAP-71_aap70-extra-ideas`, cut from the unmerged `AAP-70_deepseek-provider-tokens` (3d0f285).

### Files changed

- `src/provider.ts`: `GenerateOptions.thinking` (DeepSeek only) and `GenerationResult.costUsd`.
- `src/api.ts`: `normalizeChat` parses `thinking` (D10). Only `{type: "enabled" | "disabled"}` is kept; `null` or a missing value means not sent; anything else is 400 `invalid_request`, param `thinking`. `promptTooLong` takes an optional hint, appended after the usual message.
- `src/server.ts`: `Trace.costUsd` comes from `result.costUsd` (finite and > 0) and is copied into the activity entry. Chat options carry `thinking`. The prompt is checked again right after `prepare` in `handleChat` and `handleResponses`; on a refusal the lease is released first, so a refusal from a limit learned in prepare (the Ollama loaded context) is still a real HTTP 400.
- `src/activity.ts`: `ActivityEntry.costUsd?`.
- `src/providers/local-openai.ts`:
  - New options `loadedContext`, `loadModel` and `contextHint`.
  - `prepareModel` (no profiles) reads `/api/ps` with a 2 s timeout. A number sets the loaded context, `undefined` forgets it, an error keeps what was known.
  - When a model is not loaded, `generate` first loads it (bounded by the request signal and `OLLAMA_LOAD_TIMEOUT_MS` = 300 s), reads `/api/ps` again and checks the prompt. A failed load logs one warn line and the request goes on.
  - The limit order is: setting, then loaded context × 3, then `/api/show` context × 4. A refusal based on the loaded context carries the D3 num_ctx hint.
  - Base `listModels` stores a numeric `max_output_tokens` per model. `chatBody` caps `max_tokens` at that value and logs one info line per clamp.
  - New exports `ollamaLoadedContext`, `ollamaLoadModel` and `OLLAMA_LOAD_TIMEOUT_MS`, wired into `ollamaRegistration`. The proxy never sends `num_ctx` or `keep_alive`.
- `src/providers/deepseek-pricing.ts` (new):
  - The price table (flash and v4-pro, peak and off-peak; legacy flash ids priced as flash).
  - `isDeepSeekPeak`: Mon-Fri 01:00-04:00 and 06:00-10:00 UTC; holidays are ignored.
  - `deepseekCostUsd`: hit × hit price + miss × miss price + output × output price, divided by 1e6; `undefined` for an unknown id.
- `src/providers/deepseek.ts`:
  - A `now` option (tests).
  - The cost is priced at the request start and set on a result that is not cancelled and has usage. An id without a price gets one debug line.
  - `thinking: {type}` goes into the body.
  - `/models` `max_output_tokens` is stored, and `maxOutputTokensFor` falls back to `DEEPSEEK_MAX_OUTPUT_TOKENS` = 393216.
- `src/router.ts`:
  - New option `exhaustedPath`. `<dataDir>/exhausted.json` (`{"version":1,"providers":{"<id>":{"until":"<ISO>"}}}`) is read synchronously in the constructor.
  - Entries that are passed, invalid or more than 31 days ahead are dropped. An entry for a provider that is not in this run is kept (dormant) and written back until it expires. Each restored entry logs "'<id>' is still at its usage limit until <ISO> (restored)."
  - The file is written atomically (tmp + rename, on `writeQueue`) on every mark and on the success and probe clears. Natural expiry does not write.
- `src/controller.ts`: passes `exhaustedPath: <dataDir>/exhausted.json`.
- `src/usage-store.ts`: `costUsd` in every count. It is summed as a float (not floored), and a file without it loads 0. The file stays `version: 1`.
- `src/shared/ipc.ts`: `UsageCountsView.costUsd` and `ActivityView.costUsd?`.
- `src/renderer/cost-format.ts` (new): `formatUsd` (D8) and `formatUsdFull` (the tooltip value).
- `src/renderer/settings.ts`:
  - The Overview has a DeepSeek row after the three ACP rows: badge, sign-in line, "Balance: …" when known, the usage-limit line and chips, and only a Settings button.
  - The Recent requests Tokens cell gets " · $…" when `costUsd > 0`, with the full amount in the tooltip.
- `src/renderer/usage-view.ts`: a Cost column in the provider rows and the total ("-" when 0, the full amount in the tooltip), and a Cost stat tile when the range total is above 0.
- `src/renderer/settings.html`: `<th>Cost</th>` after Output tokens.
- `scripts/typecheck.mjs` (new), `package.json`: `npm run typecheck` runs the three tsc projects (main, renderer, tests) with `spawnSync` and no shell. It always runs all three, prints `typecheck: <name> ok|FAILED (exit N)` for each, and exits 1 if any failed.
- Tests:
  - `tests/local-openai.test.ts`:
    - New `it` "limits an Ollama prompt by the loaded num_ctx from /api/ps and loads the model first" (AC1, AC2).
    - The output-limit `it` is extended with the clamp (AC8, Ollama family).
    - DeepSeek it 1 is extended with cost, `thinking` and the clamp to 1000 and to 393216 (AC3, AC8).
    - DeepSeek it 3 gets the `thinking` 400s (AC4).
  - `tests/deepseek-pricing.test.ts` (new, AC5).
  - `tests/usage-store.test.ts`: `costUsd` sum and an old file without it (AC6).
  - `tests/router.test.ts`: new `it` "keeps the usage-limit state across a restart" (AC9).
- `README.md`:
  - Ollama: the loaded context section.
  - DeepSeek: the Overview row, cost, `thinking` and the clamp.
  - Usage page: the Cost column.
  - Prompt size limit: the Ollama line.
  - Usage limit: kept across restarts in `exhausted.json`.
  - Development: the typecheck line.
- `ROADMAP.md`: a checked AAP-71 line.

### Deviations

- `ActivityView.costUsd?` was added to `src/shared/ipc.ts`, which the plan did not list. The renderer's activity type is `ActivityView`, so the Tokens-cell cost would not typecheck without it.
- The existing Ollama `it` ("serves ollama/...") was changed in two lines: the body of the unlimited request is now read before the upstream call count is asserted. The new load-first round trip delays the chat call after the stream headers, so the old order raced. Its 256-limit assertions are unchanged.
- In the extended output-limit `it`, `/models` is fetched before the clamp requests, because the router lists models lazily.
- AC3: the "`usage.json` sums it" half is not asserted in `local-openai.test.ts`, because that harness does not wire the usage store. The sum is proved by AC6 in `usage-store.test.ts`.
- AC9: the plan proves the clear-and-rewrite by "after B's success on `a`". The test instead uses the probe clear (`usageLimitState() === null`, then a forced `listModels`), and checks that the file then holds only the dormant entry. The success-clear path calls the same `persistExhausted()` but has no test of its own.
- The DeepSeek `setup()` test helper now takes an optional `now` and then builds a `DeepSeekProvider` directly. The `Fake` upstream gained a `models` field.

### Verification

- `npm run typecheck` (via `fnm exec --using default cmd //c "npm run typecheck"`): `typecheck: main ok`, `typecheck: renderer ok`, `typecheck: tests ok`, exit 0.
- `npm test`: 49 files passed and 1 skipped; 552 tests passed, 1 skipped, 0 failed.
- AC11, the T6 manual proof, was not committed. With `const x: number = "a";` added to `src/usage.ts` and to `tests/usage.test.ts`, `npm run typecheck` printed:
  ```
  src/usage.ts(29,7): error TS2322: Type 'string' is not assignable to type 'number'.
  src/usage.ts(29,7): error TS2322: Type 'string' is not assignable to type 'number'.
  tests/usage.test.ts(22,7): error TS2322: Type 'string' is not assignable to type 'number'.

  typecheck: main FAILED (exit 2)
  typecheck: renderer ok
  typecheck: tests FAILED (exit 2)
  ```
  - Exit code 1. The `src/usage.ts` error prints twice because the tests project also compiles `src`.
  - After reverting both files (`git diff` on them is empty), all three projects printed ok, exit 0.
  - `yarn typecheck` printed the same three ok lines, exit 0.

Not run:

- AC7: the Overview DeepSeek row, the activity " · $…" suffix, and the Usage Cost column and tile in the real app. This is UNTESTED; the Electron app was not started.
- AC12: the plan's live check against DeepSeek, Ollama, a second instance and a real `exhausted.json` restart. This is left to the director's checker and is not run here.
- 402, 429 and `is_available: false` against the real API, and a live clamp over 393216, were not run (they cannot be triggered for free).
- The SSE error event for a refusal after a first Ollama load in a stream that has already started has no test of its own.

### Status per task

| Task | Status |
|---|---|
| T1 core (api, provider, server, activity) | DONE |
| T2 router persistence, usage store, ipc | DONE |
| T3 Ollama loaded context, base clamp | DONE |
| T4 DeepSeek pricing, cost, thinking, clamp | DONE |
| T5 settings window | DONE (in-app view UNTESTED, AC7) |
| T6 typecheck runner | DONE (AC11 proof above) |
| T7 docs | DONE |

### Follow-ups and known limitations

- When `/api/ps` fails (older Ollama), every `ollama/*` chat first sends a load request. It is cheap when the model is already loaded, but it is one extra round trip (see `discoveries.md`).
- Whether `/api/ps` `context_length` is per slot or the total across parallel slots will be shown by the live check (step 3.2).
- `formatUsd` rounds values just under $0.01 to two significant digits, so 0.00999 shows as "$0.0100".

### Commit status

Committed on `AAP-71_aap70-extra-ideas` as 6592762; not merged, not pushed. Ticket folder files are untracked (as for AAP-70).

## 2026-11-28 - Polish round 1: Ollama limit follows the proxy's own default context, MCP cost, Ollama key on native calls

- F1/F2 `src/providers/local-openai.ts`: `loaded` -> `defaultContext` (measured only after the proxy's own load-first and after each successful proxy chat); `prepareModel` forgets it when `/api/ps` shows the model unloaded; `checkPrompt(..., beforePrepare)` skips it before `prepare`. `src/provider.ts`, `src/acp.ts`, `src/router.ts`: `beforePrepare` passed through; `src/server.ts`: the first check of chat and responses passes `true`.
- F3 `src/usage.ts` `usageTrace` / `usageEntryFields` shared by `src/server.ts` and `src/mcp-endpoint.ts`: MCP `ask_model` and `generate_image` activity entries now carry `costUsd`, `cachedTokens`, `reasoningTokens`.
- F4 tests: the Ollama `it` in `tests/local-openai.test.ts` covers the post-prepare HTTP 400, the SSE `context_length_exceeded` after the stream started, stale default re-measured (F1), another client's bigger context ignored (F2), the load info line and the Bearer key.
- F5 native `/api/show`, `/api/ps`, `/api/generate` send `authorization: Bearer <apiKey>`.
- F6 info line `loading '<model>' before the first request: done in N ms`.
- F7 `/api/ps` 404/405/501 or no model list: load-first and ps reads skipped for 10 minutes (`/api/show` × 4).
- README Ollama "Loaded context" paragraph updated to the new rule.
- Verification: typecheck main/renderer/tests ok; npm test 552 passed, 1 skipped.
