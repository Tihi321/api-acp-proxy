# Changelog

## 2026-11-28 AAP-72: six AAP-71 follow-ups

Outcome: all six items are implemented on `AAP-72_aap71-next-ideas` (base `master` 146eadd) in commit ca5ff75. Tests and typecheck are green. Live steps 0-5 pass. The settings-window check (AC7) was not run.

### api-acp-proxy (branch `AAP-72_aap71-next-ideas`)

- `src/providers/local-openai.ts`
  - Item 1: `prepareModel` drops the measured default context in two cases: `/api/ps` reports the model as not loaded, or it reports a context that differs from the stored one. The next request then runs load-first at default options and measures again. An error or timeout (`undefined`) still changes nothing.
  - Low item: `ollamaLoadedContext` throws `PsUnsupportedError("no context_length")` for a listed entry without a usable `context_length`. A model that is not listed still returns `undefined`. The existing catch therefore turns off load-first and the `/api/ps` reads for 10 minutes, and the `/api/show` limit applies.
  - Item 4: `NEAR_CONTEXT_SHARE = 0.9`. After an Ollama answer whose prompt tokens (input + cached) are at least `ceil(measured × 0.9)`, one warn line is logged. Nothing is logged when no default has been measured.
  - Item 2: `maxOutputTokensFor` is public.
- `src/provider.ts`: optional `maxOutputTokensFor?(model)` on `Provider`.
- `src/providers/deepseek.ts`: `maxOutputTokensFor` is public (`override`).
- `src/acp.ts`: `ModelEntry` gets `maxOutputTokens?` (see Deviations).
- `src/router.ts`: `entries()` puts `maxOutputTokens` into each listed model (both the bare alias and the prefixed id) when the provider knows the limit.
- `src/server.ts`: `/v1/models` adds `max_output_tokens` right after `max_prompt_chars`, only when it is known.
- `src/renderer/overview-lines.ts` (new): `todayUsageLine` (OD6) and `localProviderLine` (K3), pure functions with no DOM.
- `src/renderer/usage-view.ts`:
  - New Cost metric: USD per day stacked per provider, with `$` tooltips, the aria label "Cost (USD) per day, last 30 days", and the OD4 empty state. A stored "cost" choice is read back.
  - `onUsageChange` dep and `todayOf(id)` handle.
- `src/renderer/settings.html`: a Cost button on the metric switch.
- `src/renderer/settings.ts`:
  - The Overview order is now Codex, Claude, Antigravity, DeepSeek, Gufo, Strata, Llama.cpp, Ollama.
  - Local rows have a Settings button only. Gufo, Strata and Llama.cpp take their badge from the launcher state. The state line comes from `localProviderLine`, with the profile label resolved as on the pages.
  - The Today line, with a full-number tooltip and `formatUsdFull`, shows on the DeepSeek row and the four local rows.
  - The Overview is rebuilt on every usage push and every local-server push.
- `tests/local-openai.test.ts`:
  - The Ollama `it` has the fake usage chunk. Seg C now tests F2 (a reload at default options; the limit stays 96). The new Seg D covers a raised default that another client loaded first. The end assertion checks for exactly one near-context warn line.
  - New small `it` for the `ollamaLoadedContext` mapping.
  - New `max_output_tokens` assertions in the output-limit `it` and DeepSeek `it` 1.
- `tests/overview-lines.test.ts` (new): one `it` (AC8).
- `README.md`:
  - Overview rows and the Today line. The Usage chart's Cost metric.
  - The Ollama "Loaded context" paragraph: the re-measure rule, the 404/405/501 / no list / no `context_length` skip rule, and the 90% warning sentence.
  - `max_output_tokens` in Discovery and in the HTTP `/v1/models` section.
  - Yarn 4 in Development, with `corepack enable && yarn install --immutable`. The Headless CLI section uses `corepack enable && yarn install`.
- `ROADMAP.md`: one checked AAP-72 line.

### T1 test first: failure on the unfixed code

The tests were changed with `src/` untouched. Result: 2 failed, 20 passed.
- `tests/local-openai.test.ts:346:24`: Seg C `expect(loadBodies).toHaveLength(2)`. Message: `AssertionError: expected [ '{"model":"qwen3.8:latest"}' ] to have a length of 2 but got 1`. Seg D was not reached.
- `tests/local-openai.test.ts:379:79`: the new `ollamaLoadedContext` `it`, for the entry without `context_length`. Message: `promise resolved "undefined" instead of rejecting`.

### Deviations

- K2 put `maxOutputTokens` on `ListedModel` in `router.ts`. `server.ts` reads `bridge.listModels()` as `ModelEntry[]`, so the field went on `ModelEntry` (`src/acp.ts:18`) instead. `ListedModel` inherits it.
- `todayUsageLine` uses the singular for 1 ("1 request", "1 error"), which the plan's test text ("1 error") implies.
- `settings.ts` has a named constant `overviewLocalIds`, which is the plan's `localIds`.
- The warn-line text is exactly K1's. In the log it reads "[ollama] Ollama: ..." (see discoveries).

### Verification

- `fnm exec --using default cmd //c "npm test"`: Test Files 50 passed | 1 skipped (51), Tests 554 passed | 1 skipped (555).
- `fnm exec --using default cmd //c "node scripts/typecheck.mjs"`: `main ok`, `renderer ok`, `tests ok`.
- T3 child: `npm run build` passed.
- AC9: `git grep -n "npm only\|package-lock\|npm ci\|npm install" README.md` printed nothing.

Live, Ollama 0.40.19 at localhost:11434, second instance on 8797, temporary model `aap72-ctx` from `qwen3.8:latest`. `/api/ps` was empty before and after. 8787 `/healthz` was ok before and after.
- Step 2:
  - `/healthz` 200.
  - `/v1/models` lists `ollama/aap72-ctx:latest` and `ollama/qwen3.8:latest`.
  - No `ollama/*` entry has `max_output_tokens` (the AC5 absent half).
- Step 3.1: after an unload, "hi" gave 200 and one "loading" line. `/api/ps` showed 2048 and `max_prompt_chars` was 6144.
- Step 3.2 (F2):
  - A foreign `num_ctx` 8192 load made `/api/ps` show 8192.
  - A 7000-character prompt gave 400 `context_length_exceeded` with "a context of 2048 tokens".
  - `/api/ps` then showed 2048 again, and the log had a second "loading" line. **The reload risk holds**: Ollama reloads at default options.
- Step 3.3: "hi" twice gave 200 each. There was no new "loading" line and `/api/ps` stayed at 2048 (no loop).
- Step 3.4 (stale default):
  - The model was re-created with `num_ctx` 4096, and another client loaded it (4096).
  - A 7000-character prompt gave **200**, with 1177 prompt tokens.
  - `max_prompt_chars` was then 12288.
  - The load-first line took 7 ms: no reload, and the runner was kept.
- Step 4 (warning, `maxPromptChars: 0`, `num_ctx` 2048):
  - The planned 12000-character prompt (and 3000-3800 characters) gave HTTP 400 from Ollama itself ("the prompt is longer than the context length currently available"). This Ollama refuses an over-context prompt instead of cutting it.
  - 2000 characters of digits gave 200 with `prompt_tokens` 2009, and one warn line: "used 2009 of the 2048 tokens of its context (num_ctx); Ollama may have dropped the start of the prompt".
  - A following "hi" gave 200 with no new warn line.
- Step 5:
  - The instance was stopped and `ollama rm aap72-ctx` was run. `/api/ps` was `{"models":[]}`, as found.
  - `.claude/temp/aap72-live` was deleted, and 8787 `/healthz` was ok.

Not run:
- Step 6 / AC7, the settings window: the Cost chart and the Overview rows in the real app. No screen or input tool was available. **UNTESTED.**
- The DeepSeek `max_output_tokens` values, live: DeepSeek is off. They are proved by test fakes.

### Status per acceptance criterion

| AC | Status | Evidence |
|---|---|---|
| AC1 | DONE | Seg D passes, and it failed before the fix (the line above). Live step 3.4. |
| AC2 | DONE | Seg C. Live step 3.2. |
| AC3 | DONE | The Seg B assertions are kept. Live step 3.3. |
| AC4 | DONE | The new `ollamaLoadedContext` `it`. |
| AC5 | DONE | The T2 assertions pass. Live step 2 shows the absent half. |
| AC6 | DONE | The B / D / end assertions. Live step 4 (2009 of 2048 warns; "hi" does not). |
| AC7 | UNTESTED | Not run in the app. |
| AC8 | DONE | `tests/overview-lines.test.ts`. |
| AC9 | DONE | The grep is empty. |
| AC10 | DONE | 554 passed, 1 skipped; typecheck gives three ok lines. |
| AC11 | DONE (steps 0-5), UNTESTED (step 6) | See above. |

### Follow-ups and known limitations

- On new Ollama versions an over-context prompt is refused with a 400 instead of being cut. The near-num_ctx warning and the stricter ×3 guard still assume a silent cut (see `discoveries.md`).
- The Overview rebuilds on every usage push and every local-server push, so keyboard focus can be lost (a known risk in the plan).

### Commit status

Committed on `AAP-72_aap71-next-ideas` as ca5ff75. Not merged, not pushed.
