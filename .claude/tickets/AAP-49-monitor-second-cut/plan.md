---
status: in-progress
request: creative-hub/REQ-0030
repos: [api-acp-proxy]
branch: AAP-49_monitor-second-cut
updated: 2026-11-22
---

# AAP-49 Monitor second cut: sparklines, thinking tokens per request, conversation cache, a server started outside the app

Hub ticket: creative-hub HUB-43 (`C:\projects\Personal\creative-hub\.claude\tickets\HUB-43-open-ideas\plan.md`, part B and triage items 1-3), request REQ-0030. The user said on 2026-11-22: "Ok build open idea first". This continues AAP-47 (`.claude/tickets/AAP-47-monitor-about/plan.md`, its "Second ticket (not in this cut)" section). Checked on master 23cf725 and against Strata 0.1.52 on 8080 with read-only GETs (`/metrics`, `/v1/status`, `/v1/telemetry`) on 2026-11-22; no model was called.

Notes for workers:
- The desktop proxy runs from this repo's `dist/` and is RUNNING. No `yarn build` on this branch: tests and typecheck only. Hub R1 builds and restarts after the merge, with the user's go-ahead.
- Cut this branch from the head of `AAP-48_small-fixes` (AAP-48 adds the tests typecheck; merge AAP-48 first, then AAP-49).
- The user's `%APPDATA%\api-acp-proxy\settings.json` is never edited; this ticket adds no setting, so an old settings file loads unchanged.
- Leave the two uncommitted AAP-43 files out of every commit.
- Commands (Bash: `export PATH="/c/Users/Infplane/AppData/Roaming/fnm/aliases/default:$PATH"` first): test `yarn test`; typecheck `yarn typecheck` (after AAP-48: node, renderer and tests configs); build `yarn build` (NOT in this ticket); no lint script.
- No Electron test harness exists: the renderer parts are UNTESTED until hub K1.

## Decisions per sub-item (evidence)

| sub-item | decision | evidence |
|---|---|---|
| Sparklines | BUILD, on the six Strata tiles | Strata `GET /metrics` has `history` with ten series of exactly 60 points: `gpu_util` (%), `gpu_mem_used` (bytes), `gpu_temp` (degC), `gpu_power` (W), `gpu_pcie_rx_mb` (null on this PC), `cpu` (%), `ram_used` (bytes), `disk_read_mb` (MB/s), `tok_s` (live decode tokens/s), `prefill_tok_s_mean`. Strata's sampler adds one point a second (`D:\Strata\terminal\serve\telemetry.py:27` `HISTORY = 60`, `_loop` "One sample a second", values rounded to 2 decimals, `:1806-1809`), so a line is the last 60 s. Tiles: GPU load, VRAM, GPU temp, Power, Disk read, Decode (from `tok_s`). Not CPU and RAM: their values come from this PC through Node's `os` (`src/local-monitor.ts:142-146`), and a line from Strata under them would mix two sources. Drawing: the page's CSP is `default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:` (`src/renderer/settings.html:5`); an inline `<svg>` built with `document.createElementNS` and attributes (`viewBox`, `points`) uses no style attribute; the stroke comes from a CSS class. The bars already avoid inline styles with `<progress>` (`src/renderer/monitor-view.ts:46-55`); the Usage page sets `style.height` from script (`usage-view.ts:167`), which this ticket does not copy. |
| Reasoning tokens per request | BUILD (activity log, Requests page, Monitor table) | usage reaches the activity log in `traceUsage` (`src/server.ts:54-59`), which already computes `openAiUsage(...).reasoning` and drops it. `reasoning` is `usage.thoughtTokens` for every provider that reports it (ACP agents through `USAGE_FIELDS`, `src/acp-provider.ts:130`; local servers through `completion_tokens_details.reasoning_tokens`, `src/providers/local-openai.ts:237`, estimated from `reasoning_content` when a local server reports none, `:268`), and the chars/4 estimate of the reasoning text when there is no usage at all (`src/usage.ts:11`). `traceUsage` runs for chat (stream and not) and Responses (`server.ts:223, 246, 323, 369, 424`). Counts only, never text. |
| `--metrics` for llama-server | TOO LARGE for this cut; the next proxy ticket (design below) | fits only by going over 12 files (two more: `src/llama-args.ts`, `tests/llama-args.test.ts`); facts are recorded in "Next cut" so it is ready to plan |
| Conversation cache | BUILD one tile | `/metrics` `conversation_cache` (recorded 2026-11-22): `{enabled: true, budget_mib: 1536, slots: 4, parked: 0, bytes: 0, evictions: 0, parks: 0, restores: 0, last_event: null, last_tokens: null, last_at: null, refused: {}, refused_total: 0, last_refused: null, requests: 1, requests_reused: 0, reused_tokens: 0, prompt_tokens: 16, last_reused: 0, last_prompt: 16}`. A clear tile: parked conversations of the slots, restores and evictions, memory of the budget; it is read from the same `/metrics` answer (no new request). |
| `/v1/status`, `/v1/telemetry` | NO CHANGE | `/v1/status` (recorded): `service, model, loaded, auto_load, structured_output{...}, engine, started, uptime_s, cache_max_tokens, context{native, max_positions}, concurrency{serving, requested}, dialects ["/v1/chat/completions","/v1/messages","/v1/responses"], vision{enabled, available, error}, image_generation{enabled}, activity{requests, in_flight, last_request_at}, last_timings{cache_n, prompt_n, prompt_ms, prompt_per_second, predicted_n, predicted_ms, predicted_per_second, draft_n, draft_n_accepted, at}, vram{elastic}, machine{gpu{name, used_mib, total_mib, util_pct, temp_c, power_w}, ram{used_gib, total_gib}}`. `last_timings` repeats the newest `/metrics` request; `dialects` are Strata's own, not the proxy's (the About page's line is about the proxy, which serves no `/v1/messages`); `machine` repeats `hardware`. `/v1/telemetry` (recorded): `schema_version, source, sampled_at, instance{boot_time, server, id, state}, model{id, loaded, context}, work{slots_requested, slots_effective, active, occupied_slots, queued, waiting, outside_slots, slots[], groups, ..., requests[], admission_limit, admission_rejected, oldest_queue_s, queue_timeouts, client_disconnect_cancels}, rates{answer_tok_s, prefill_tok_s, ...}, topology{...}, devices[{index, name, mem_used, mem_total, util, temp, power, pcie_gen, ...}], ram{used, total}, recent[], totals{...}, quality{...}, activity{last_seq, events[{seq, at, request_id, event}]}`: everything a tile would use is already in `/metrics`; the extra counters have no clear reader on this page. One more request per poll buys nothing. |
| "No engine data" after a render error | BUILD | `tick()` catches a render error and keeps the last state silently (`monitor-view.ts:74-75`); the page then looks live while it is not |
| `apiKeyNeeded` cache | BUILD | the handler calls `proxy.getSettings()` on every 2 s poll only for `server.apiKey` (`src/electron/main.ts:530, 560`); `getSettings` runs the controller's `load()`, which re-resolves the config and replaces `this.resolved` each time (`src/controller.ts:135-139`). The local caches are refilled after every save by `refreshLocalSettings` (`main.ts:133`, called at `:318`) |
| Gufo status | NEEDS A RUNNING SERVICE | no endpoint known: the proxy only probes `/v1/models` (`src/settings.ts:15`), Gufo has no docs on disk and is not running (hub probe P2) |
| A server started outside the app | BUILD for Strata and Llama; Gufo NEEDS A RUNNING SERVICE | today the Monitor shows "No local model loaded" when, for example, Strata was started with `hub.ps1 start strata` (no launcher entry is starting or ready, `localState`, `src/local-monitor.ts:155-165`), while the proxy sends requests straight to it (`src/local-models.ts:180-181`). `fetchEngine` already reads Strata and Llama on a given port (`:111-125`), so the handler can try the configured ports when nothing is loaded |

Honest size: 11 code and test files plus README and ROADMAP (13). About 350 lines.

## Scope

1. Sparklines on GPU load, VRAM, GPU temp, Power, Disk read and Decode, from Strata's `history`.
2. `reasoningTokens` in the activity log; shown on the Requests page and in a "Thinking" column of the Monitor's proxy-requests table.
3. A "Conversation cache" tile (Strata).
4. A distinct notice when the page could not show the latest reading.
5. `apiKeyNeeded` cached with the other local settings.
6. Strata or Llama answering on its configured port while the launcher holds nothing: shown as ready, "started outside the app".

## Out of scope

- `--metrics` and Llama speed (next cut, below); Gufo status; tiles from `/v1/status` and `/v1/telemetry`; CPU and RAM sparklines; Strata's Load/Unload; any setting; the Usage page's inline sizes (`usage-view.ts:167,231`, a separate discovery).

## Contracts

`src/shared/ipc.ts` (types only):
```ts
/** Strata's last 60 s, one point a second, oldest first; null where Strata had no reading. At most 60 points per series; a series with no number is left out. */
export interface EngineHistoryView { gpuUtilPct?: (number | null)[]; gpuMemUsedBytes?: (number | null)[]; gpuTempC?: (number | null)[]; gpuPowerW?: (number | null)[]; diskReadMBs?: (number | null)[]; decodeTokS?: (number | null)[] }
/** Strata's conversation cache: finished conversations parked off their slot and restored on the next turn. Numbers only. */
export interface EngineConversationCacheView { enabled: boolean; slots?: number; parked?: number; bytes?: number; budgetMiB?: number; restores?: number; evictions?: number; requests?: number; requestsReused?: number; reusedTokens?: number }
```
`EngineView` (`:257`) gains `history?: EngineHistoryView; conversationCache?: EngineConversationCacheView;`. `MonitorView.local` (`:271`) gains `external?: true; // answers on the configured port, not started by this app`. `ActivityView` (`:127`) gains `/** Of outputTokens, the part spent thinking (the agent's count, or estimated from the reasoning text). */ reasoningTokens?: number;`.

`src/activity.ts` `ActivityEntry` gains the same `reasoningTokens?: number` with the same doc line.

`src/local-monitor.ts`:
- `export const HISTORY_POINTS = 60;` `mapStrataMetrics` reads `history` keys `gpu_util`, `gpu_mem_used`, `gpu_temp`, `gpu_power`, `disk_read_mb`, `tok_s` only (whitelist; any other key, and `gpu_pcie_rx_mb`, `cpu`, `ram_used`, `prefill_tok_s_mean`, is not read); each array: the last `HISTORY_POINTS` entries, a finite number kept, anything else `null`; a series with no number left out; `history` left out when empty.
- `mapStrataMetrics` reads `conversation_cache` fields `enabled` (bool; the object is left out when it is not a bool), `slots`, `parked`, `bytes`, `budget_mib`, `restores`, `evictions`, `requests`, `requests_reused`, `reused_tokens` (numbers via `num`). No string field.

`src/electron/main.ts`:
- `refreshLocalSettings` (`:133`) reads `effective` once and also sets `let serverKeySet = Boolean(effective.server.apiKey)`; the `proxy:monitor` handler drops its `proxy.getSettings()` call (`:530`) and uses `apiKeyNeeded: serverKeySet`.
- In the handler, when `local.state === "none"`: for `strata` then `llama`, when that provider's cached settings say `enabled` (field per `src/settings.ts`) and give a port: `fetchEngine(server, port, key, fetch, 800)`; the first that returns an `engine` sets `local = { server, state: "ready", port, external: true }` (plus `modelId` for Strata from the status as today, `:540-542`) and `engine`. GET only, `127.0.0.1` only, as `fetchEngine` already does. Nothing when both fail (no error shown: "none loaded" stays).

`src/server.ts`: `Trace` (`:26`) gains `reasoningTokens?: number`; `traceUsage` sets `trace.reasoningTokens = usage.reasoning > 0 ? usage.reasoning : undefined`; `track` (`:500-510`) copies it like `outputTokens`.

Renderer (`src/renderer/monitor-view.ts`):
- `spark(values, opts?: { min?: number; max?: number }): SVGSVGElement | undefined`: undefined when no number; `createElementNS("http://www.w3.org/2000/svg", "svg")`, `viewBox="0 0 59 16"`, `preserveAspectRatio="none"`, `aria-hidden="true"`, class `spark`; one `<polyline>` per run of numbers (a `null` breaks the line), point `x` = index shifted right so the newest is at 59, `y` = 16 minus the value scaled between min and max (GPU load 0-100; VRAM 0 to `gpuMemTotalBytes`; others from 0, or the series' min for temperature, to the series' max; a flat series draws mid-height). Plus a `<title>` "last 60 s". No `style` attribute anywhere.
- `tile()` (`:38-44`) takes an optional fifth argument, an element appended under the sub line.
- Conversation cache tile in `mon-engine` after "Prompt reused": value `"off"` when not enabled, else `"<parked> of <slots> parked"`; sub `"<restores> restored · <evictions> evicted · <MiB of bytes> of <budgetMiB> MiB"`; a dash with `dashSub(true)` when there is no cache data.
- `tick()` catch: keep `let lastShownAt: number | undefined` (set after a successful render to `view.at`); on a render error set `mon-notice` and `about-notice` text to `Could not show the latest reading. The numbers below are from ${lastShownAt !== undefined ? clock.format(lastShownAt) : "an earlier reading"}.`; the next successful render clears it (as today).
- `modelSub`/`reason`: a `local.external` model shows the sub `started outside the app` on the Model and State tiles.
- `renderProxyRequests`: a "Thinking" cell after Output: `reasoningTokens` with the `≈ ` prefix when `estimated`, else `-`.
- `src/renderer/settings.ts:546-547` (Requests page Tokens cell): append ` (${entry.reasoningTokens} thinking)` when `reasoningTokens` is set.
- `src/renderer/settings.html:171`: `<th class="num">Thinking</th>` after `<th class="num">Output</th>`.
- `src/renderer/settings.css` (after `.mon-bar` rules, `:226-227`): `.spark { display: block; width: 100%; height: 18px; margin-top: 4px; } .spark polyline { fill: none; stroke: var(--accent); stroke-width: 1.5; vector-effect: non-scaling-stroke; }`.

## Files to touch

| file | change | rough lines |
|---|---|---|
| `src/shared/ipc.ts` | types above | 12 |
| `src/activity.ts` | `reasoningTokens` | 2 |
| `src/server.ts` | `Trace`, `traceUsage`, `track` | 4 |
| `src/local-monitor.ts` | history and conversation-cache mapping | 35 |
| `src/electron/main.ts` | key cache, external read | 20 |
| `src/renderer/monitor-view.ts` | `spark`, tiles, notice, Thinking cell | 70 |
| `src/renderer/settings.ts` | Tokens cell | 2 |
| `src/renderer/settings.html` | one `<th>` | 1 |
| `src/renderer/settings.css` | `.spark` | 2 |
| `tests/local-monitor.test.ts` | extend test 1 | 15 |
| `tests/activity.test.ts` | extend the first test | 4 |
| `README.md` | the AAP-47 paragraph (line 31) | 2 |
| `ROADMAP.md` | done line; open line rewritten | 2 |

README, after the sentence "Monitor: the model and its state, ... (counts and timings only, never text)." add: "Since AAP-49 the Strata tiles show a line of the last 60 seconds, a Conversation cache tile shows Strata's parked conversations, the request lists show the tokens spent thinking, and a Strata or Llama.cpp server started outside the app is shown as such."

ROADMAP: after the AAP-48 line add `- [x] Monitor second cut (AAP-49; creative-hub HUB-43; live check UNTESTED, hub K1): 60-second lines on Strata's GPU, VRAM, temperature, power, disk and decode tiles; thinking tokens per request in the activity log, the Requests page and the Monitor; Strata's conversation cache; a notice when a reading could not be shown; a Strata or Llama.cpp server started outside the app.` and replace the open line 47 by `- [ ] Monitor next cut: llama-server --metrics for Llama speed (AAP-49 plan, "Next cut"), Gufo status once its endpoints are known (creative-hub HUB-43 probe P2).`

## Tasks for workers

1. **Core** (one worker): `ipc.ts`, `activity.ts`, `server.ts`, `local-monitor.ts`, both test extensions. Output: `yarn test` green. Contract to task 2: the types above and the mapped `history`/`conversationCache`.
2. **Window** (same or a second worker, after 1): `main.ts`, `monitor-view.ts`, `settings.ts`, `settings.html`, `settings.css`, README, ROADMAP. Output: `yarn typecheck` green; `grep -n "style\." src/renderer/monitor-view.ts` and `grep -n "setAttribute(\"style\"" src/renderer` find nothing new.
Commit on `AAP-49_monitor-second-cut`: `AAP-49: Monitor second cut (sparklines, thinking tokens, conversation cache, outside server)`; `changelog.md` in this folder with the test count and the UNTESTED list.

## Tests (test-discipline: extend two existing tests, no new file)

- `tests/local-monitor.test.ts` test 1 ("maps Strata's metrics ..."): `strataMetrics()` gains `history` with `gpu_util` of 65 points (index 10 is `"SECRET-TEXT"` and index 20 is `null`, both inside the newest 60), `gpu_temp` of 60 numbers, an unknown series `secret_series: ["SECRET-TEXT"]`, and `cpu` (must not be read); and `conversation_cache` from the recorded sample above plus `last_event: "SECRET-TEXT"`. Assert: `view.history.gpuUtilPct` has length 60 and holds `null` where the string was; `gpuTempC` length 60; `Object.keys(view.history)` is exactly `["gpuUtilPct", "gpuTempC"]`; `view.conversationCache` equals `{ enabled: true, slots: 4, parked: 0, bytes: 0, budgetMiB: 1536, restores: 0, evictions: 0, requests: 1, requestsReused: 0, reusedTokens: 0 }`; the existing `JSON.stringify(view)` check for `SECRET` still passes.
- `tests/activity.test.ts` "records a plain chat request ...": with `behaviour` returning `usage: { inputTokens: 11, outputTokens: 4, totalTokens: 15, thoughtTokens: 3 }`, the entry has `reasoningTokens: 3`; and a request whose usage has no thought tokens (the default behaviour, second call) has no `reasoningTokens` key.

## Acceptance criteria

| # | criterion | proof |
|---|---|---|
| S1 | Strata's history maps to bounded number series, whitelisted, never text | extended test 1 |
| S2 | conversation-cache numbers map, never text | extended test 1 |
| S3 | the activity log keeps thinking tokens, only when there are some | extended activity test |
| S4 | the monitor poll no longer reloads the settings | `grep -n "getSettings" src/electron/main.ts` shows no call inside the `proxy:monitor` handler |
| S5 | no inline style in the new drawing | the two greps in task 2 |
| S6 | types compile (node, renderer, tests) | `yarn typecheck` |
| S7 | nothing else breaks | `yarn test` |
| S8 | the lines move, the cache tile and the Thinking column show values, an outside Strata is shown | hub K1 (a person reads the page) and K5 |

## UNTESTED

- The window (no Electron test harness): the sparkline drawing, the tile layout, the render-error notice (a render error cannot be produced on purpose without a code change), the Thinking column. Hub K1 reads them after `yarn build` and a restart.
- The outside-server path: hub K5 (optional, reloads Strata).
- Llama.cpp started outside the app (no live check planned).

## Next cut (not in this ticket): `--metrics` for llama-server

Facts gathered on 2026-11-22, for the planner of that ticket:
- llama-server serves Prometheus text on `GET /metrics` only with `--metrics` (llama.cpp `tools/server/README.md:222` and `:1122-1146`, read in `D:\Strata\third_party\llama.cpp`, which may be newer than the installed b12613). The embedding server on 8083 answers `/metrics` with HTTP 501 today. Lines are `llamacpp:<name> <value>`: `prompt_tokens_total`, `prompt_seconds_total`, `tokens_predicted_total`, `tokens_predicted_seconds_total` (counters), `prompt_tokens_seconds`, `predicted_tokens_seconds` (gauges, average tokens/s), `requests_processing`, `requests_deferred`, `n_decode_total`, `n_busy_slots_per_decode`, `spec_decode_*`. Decode t/s = `tokens_predicted_total / tokens_predicted_seconds_total`; prefill t/s = `prompt_tokens_total / prompt_seconds_total`.
- Change: `buildLlamaArgs` (`src/llama-args.ts:31-51`) adds `--metrics` after `--alias ...` unless `profile.extraArgs` already contains `--metrics`; `buildEmbeddingArgs` unchanged (no embedding speed is shown). Effect on running servers: none until they start again. The embedding restart logic compares `embeddingServerKey` only before and after one settings save (`main.ts:317-323`) and the key is built from `buildEmbeddingArgs`, so an upgrade never restarts the embedding server; the chat server gets the flag at its next start (the hub's proxy restart stops every local server anyway). No setting: old settings files load as they are.
- Mapper: a bounded (64 KB) text read, a regex per whitelisted counter, finite numbers only; `fetchEngine("llama")` adds `GET /metrics` beside `/props` and `/slots`; a 501 or error leaves `speed` out (sub "restart the model for speed" when the server predates the flag). Tests: `tests/llama-args.test.ts` (the exact args string) and `tests/local-monitor.test.ts` test 2 (a sample text). Live check: Inkling loaded on 8082, `curl -s http://127.0.0.1:8082/metrics` shows the names above, and the Monitor's Decode/Prefill tiles show numbers for Llama.

## Implementation record (2026-11-22, implement)

- [x] Task 1 Core: `ipc.ts`, `activity.ts`, `server.ts`, `local-monitor.ts`, both test extensions. `yarn test` 520 passed, 1 skipped (44 files).
- [x] Task 2 Window: `main.ts`, `monitor-view.ts`, `settings.ts`, `settings.html`, `settings.css`, README, ROADMAP. `yarn typecheck` exit 0; both style greps empty.
- Deviations: `tile()` had three parameters, so the sparkline is its fourth (not fifth) argument; the ROADMAP open line was 48, not 47; `traceUsage` also requires a finite number; the render-error notice also puts "updated" back to the last good reading's time and guards its own clock call; the editing was done by the orchestrator itself (no implementer child).
- Whitelist plants checked by mutation: copying raw history points fails the null check; spreading the raw cache object fails the `toEqual`.
- UNTESTED: as listed above (window, outside-server path, Llama outside); hub K1/K5.
