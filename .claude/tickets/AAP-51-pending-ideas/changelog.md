## 2026-11-22 AAP-51 Pending proxy ideas (creative-hub HUB-44, REQ-0031)

Outcome: all IN items of the plan (P-02, P-03, P-04, P-05 a-d, P-06, P-08, P-09, P-10 Llama.cpp, P-11, P-14 (1)) built; tests and typecheck pass; nothing seen in the window.

### api-acp-proxy, branch `AAP-51_pending-ideas` (from master 9f23c3a)

- `src/shared/ipc.ts`: `EngineView.speedMissing` gains `"metrics-unread"`; `ActivityView.reasoningEstimated?: boolean`.
- `src/local-monitor.ts`: `mapLlama` says `metrics-unread` when `/props` has `endpoint_metrics: true` and the `/metrics` read failed (P-05 c); `readText` reads the body chunk by chunk and cancels it as soon as it passes `MAX_METRICS_BYTES` (P-09); `fetchEngine` refuses a `/props` without `total_slots` and without `default_generation_settings` as "unexpected answer" (P-10); new `llamaAlias` (id-shaped `model_alias` only) and `fetchEngine` returns `alias` for Llama.cpp (P-06). The engine view still never carries the alias.
- `src/electron/main.ts`: an outside llama-server gets `modelId: llama/<alias>` and, when a profile's model matches, its label and profile id (P-06); `refreshLocalSettings()` after the Antigravity install and the terms acknowledgement (P-08); a failed `servers.stop("embed")` is logged as a warning and the save still returns `ok: true` (P-14 1).
- `src/providers/local-openai.ts`: for a provider without profiles (Strata) the image check runs after the lease and reads the model list again before refusing (P-02); `generate` returns `reasoningEstimated: true` when it estimated the thinking tokens (P-05 d).
- `src/provider.ts`, `src/server.ts`, `src/activity.ts`: `reasoningEstimated` carried from the result through the trace to the activity entry, only together with `reasoningTokens`.
- `src/renderer/monitor-format.ts` (new, pure): `gib` (GiB label, P-03), `sparkGeometry` (lines plus dots for a single reading, P-04, P-05 b), `speedSub` (Strata reason for a missing speed, "speed not read this time", P-05 a, c).
- `src/renderer/monitor-view.ts`: uses those helpers; `gb`, `llamaWhy` and the local spark geometry removed; dots drawn as `polyline.dot`; the Thinking cell shows "≈" for an estimated count.
- `src/renderer/settings.ts`: Requests page thinking part shows "≈" when only the thinking count is estimated.
- `src/renderer/settings.css`: `.spark polyline.dot` rule.
- `src/renderer/usage-view.ts`, `src/renderer/usage.css`: the 30-day chart is one SVG per day with `rect` segments (1000-unit grid, minimum 15 units); the plan-limit meter is a `progress` element; no inline style left (P-11). Segments lose their rounded top.
- `tests/local-monitor.test.ts`, `tests/local-openai.test.ts` (extended, no new `it`), `tests/monitor-format.test.ts` (new, three `it`s).
- `README.md` (one Monitor sentence), `ROADMAP.md` (AAP-51 row).

### Failing first (one line each)

- local-monitor, P-05 c: `expected 'no-metrics' to be 'metrics-unread'`
- local-monitor, P-06: `expected undefined to be 'inkling-2-mini'`
- local-monitor, P-09: `expected false to be true` (the cancel flag; the `metrics-unread` part of that case already passed on the old code because `text()` rejects)
- local-monitor, P-10: `expected { engine: { kind: 'llama', …(4) } } to deeply equal { error: 'unexpected answer' }`
- local-monitor guards not shown failing alone: `llamaAlias` with a path (the function did not exist), the view JSON not containing the alias (the view never carried it).
- monitor-format, gib (old "GB" label, re-shown by the orchestrator): `AssertionError: expected '63.2 GB' to be '63.2 GiB'`
- monitor-format, sparkGeometry dots: `expected { lines: [ '58,8.00 59,4.00' ] } to deeply equal { lines: [ '58,8.00 59,4.00' ], …(1) }`
- monitor-format, flatY mutation (always `SPARK_H / 2`): `expected [ '57,8.00 58,8.00 59,8.00' ] to deeply equal [ '57,16.00 58,16.00 59,16.00' ]`
- monitor-format, speedSub (old rule): `Strata decode without prefill: expected undefined to be 'no prompt read yet'` (the table stops at the first failing row; the metrics-unread row would give "restart the model for speed")
- local-openai, P-05 d: `AssertionError: expected { time: 1795382646400, …(10) } to match object { reasoningTokens: 4, …(1) }`
- local-openai, P-02: `ApiError: The model 'strata/qwen-flash' does not accept image input.` (the `:228` server-down and `:252-253` text-only-list assertions still pass)

### Deviations

- `changelog.md` written by the implement orchestrator, not Worker A (the implement skill makes the orchestrator its writer).
- `main.ts` outside path written as spreads (Llama fields only for `id === "llama"`); same effect, Strata unchanged.
- `prepareModel` image helpers are closures inside the method (they need `this.id` and `model`).

### Verification

- `yarn test`: 45 files passed, 1 skipped; 523 tests passed, 1 skipped (524).
- `yarn typecheck`: exit 0.
- `grep -rn "style\.\|setAttribute(\"style\"" src/renderer`: no match.
- `grep -n "GB\b" src/renderer/monitor-view.ts`: no match.
- `grep -n "applySettings\|refreshLocalSettings" src/electron/main.ts`: each `applySettings` (325, 619, 630) followed by `refreshLocalSettings()`.
- `git diff --check`: clean; files stay CRLF in the working tree.
- No build, no Electron start, `settings.json` untouched.

### Not run (UNTESTED)

- Monitor and About pages in the window: GiB labels, the dot, the Strata Prefill reason, "speed not read this time", ≈ on the Thinking cell and the Requests page, an outside Llama.cpp alias.
- Usage page: SVG chart (heights, colours, minimum height, hover title) and the `progress` meters (75% and 90% colours).
- A live image request to Strata before its first load (needs a rebuild and proxy restart).
- The render-error notice (P-07, no change), the Antigravity install and terms paths (P-08), a failing embedding-server stop (P-14 1) in the running app.
- Gufo endpoint probe P1 (live round, not this build).

### Follow-ups

- Gufo tiles and vision cross-check from probe P1 (P-01).

Commit status: committed on `AAP-51_pending-ideas` (one commit); not pushed, not merged.

## Polish 1 (checker findings F1, F3, F4, F5)

- F1 (`src/providers/local-openai.ts`, `src/router.ts`, `src/provider.ts`): `LocalOpenAiProvider.acceptsImages` returns `undefined` (not known yet) for a provider without profiles (Strata) until its first successful `listModels()`; `Provider.acceptsImages` may return `undefined`; `ProviderRouter.acceptsImages` passes the provider's answer through (it falls back to `capabilities.image` only for a provider without the method). `ask_model` (`src/mcp-endpoint.ts:704`) and `generate_image` (`:744`) refuse only on an explicit `false`, so an image call to Strata before its first load reaches `prepareModel`, which refuses after the lease and a fresh list as on the HTTP routes. That refusal reaches the MCP caller as the provider's own `unsupported_content: ... does not accept image input.` (the existing pass-through, covered by "passes the provider's own refusal on"). A Strata whose list is known and has no vision keeps the early `model_not_capable`. Gufo, Llama.cpp and cloud providers are unchanged.
- F3 (`tests/local-openai.test.ts`): the P-02 test now also builds Strata with a coordinator double and a text-only list; an image request is refused with 400 `unsupported_content` and the lease is released once.
- F4 (`src/renderer/monitor-format.ts`): a dot's two x values are clamped into 0..59 and stay 1 unit long (x=59 gives `58,y 59,y`, x=0 gives `0,y 1,y`).
- F5 (`src/shared/ipc.ts`): the `speedMissing` comment now says what `mapLlama` does: no counters read plus `endpoint_metrics: true` gives "metrics-unread" (read failed, too large, or an answer without the counters).

Failing first: F1 `ask_model (images) > forwards an image to Strata before its first load` on 3e538cc: "expected true to be undefined" (isError). F4 `sparkGeometry([1, 2, null, 3], ...)`: dot was "58.5,4.00 59.5,4.00", expected "58,4.00 59,4.00". F3: with `lease?.release()` removed, "expected [] to deeply equal [ 'strata' ]" (restored).

Verification: `yarn test` 524 passed, 1 skipped; `yarn typecheck` exit 0. UNTESTED: a live image request to Strata before its first load in the running app (needs rebuild and restart).
