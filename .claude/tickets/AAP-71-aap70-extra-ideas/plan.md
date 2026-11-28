---
status: done
request: REQ-0026
repos: [C:/projects/Personal/api-acp-proxy]
branch: AAP-71_aap70-extra-ideas
base: AAP-70_deepseek-provider-tokens
updated: 2026-11-28
---
# AAP-71: the seven follow-ups from AAP-70

Base: the unmerged branch `AAP-70_deepseek-provider-tokens` (94b8986, 6953806, 3d0f285). Read `../AAP-70-deepseek-provider-tokens/plan.md`,
`research.md` ("DeepSeek API facts") and `changelog.md` first; this plan uses their names (C1-C9, D1-D15).

What gets built: the full version of all seven items. Ollama (1) gets a real guard against silent truncation, not only a setting. Cost (2)
is stored, summed and shown. The other five (3-7) are built end to end too.

## Scope

1. **Ollama `num_ctx`.** The prompt limit of an Ollama model is the context Ollama actually runs it with (`context_length` of `GET /api/ps`).
   The model is loaded first when it is not loaded yet, so the limit is known before the prompt is sent. A prompt over it is refused with
   400 `context_length_exceeded` and a hint on how to raise `num_ctx` in Ollama. The proxy never sends `num_ctx`.
2. **DeepSeek cost per request.** USD from one price table (cache hit, cache miss and output per 1M tokens; peak and off-peak; per model).
   Stored as `costUsd` on the activity entry and in `usage.json`, and shown in the activity log, as a Usage table column and as a Usage stat tile.
3. **DeepSeek on the Overview.** A new DeepSeek row in the Providers card with its state, the balance line, the usage-limit line and a
   Settings button.
4. **`thinking` pass-through.** A chat request's `thinking: {type: "enabled" | "disabled"}` is checked and forwarded to DeepSeek only.
5. **Exhausted state survives restarts.** The state is kept in `<dataDir>/exhausted.json` beside `usage.json` and read when the router
   starts; expired entries are dropped. This covers every provider that goes through the router's exhausted path.
6. **`max_tokens` clamp.** The value is capped at the model's maximum output: DeepSeek's `max_output_tokens` from `/models`, else 393216.
   Other providers are capped only when their `/models` reports `max_output_tokens`. Each clamp writes one info log line.
7. **`npm run typecheck`.** It runs all three tsc projects, reports every failure and exits 1 if any project failed. It works under npm
   and yarn on Windows.

## Out of scope (explicit)

- Sending `num_ctx` (or any `options`) to Ollama, switching Ollama to its native `/api/chat`, and a `providers.ollama.numCtx` setting (see D1).
- Chinese public holidays in DeepSeek's peak/off-peak rule. They are ignored: a weekday holiday is priced as a normal weekday (D6).
- Currency other than USD; CNY prices; converting the balance; budgets or spend alerts; cost for any provider other than DeepSeek.
- Cost in the OpenAI response body, in a response header, on the Usage chart or on the DeepSeek settings card.
- `thinking` on `/v1/responses` (chat completions only), `thinking.budget_tokens` or any other key besides `type`, and forwarding
  `thinking` to Gufo / Strata / Llama.cpp / Ollama / ACP.
- A live 402 / 429 / `is_available: false` test (they cannot be triggered for free). These are proved with fakes.
- `max_output_tokens` in `/v1/models` entries (listed under Extra ideas in the report).
- The open D15 / T4 legacy-id question from AAP-70.
- Overview rows for Gufo / Strata / Llama.cpp / Ollama.

## Decisions (the user may override any of them; the ones marked **USER** need an answer or a nod)

- **D1 Ollama context (USER).** The proxy reads, it does not set. Facts checked on 2026-11-28 (docs.ollama.com):
  - `/v1/chat/completions` lists no `options` or `num_ctx`. The compatibility page says "The OpenAI API does not have a way of setting the
    context size for a model" and suggests a Modelfile with `PARAMETER num_ctx`.
  - The native `/api/generate` and `/api/chat` take `options.num_ctx`.
  - `GET /api/ps` returns `context_length` for each loaded model (docs example `"context_length": 4096`; `ollama ps` shows it as CONTEXT).
  - The default context is 4096 per the FAQ, or 4k / 32k / 256k by VRAM per the context-length page. It can be set with
    `OLLAMA_CONTEXT_LENGTH`.
  - `POST /api/generate` with a model and no prompt loads the model.

  The docs do not say whether a different `num_ctx` reloads the model. It does in Ollama's scheduler (the runner is reloaded when its
  options differ); this is inferred and the live check verifies it.

  Why not send a context per request: switching Ollama to `/api/chat` means a second wire format (NDJSON, `prompt_eval_count`, no cache
  counts). A `num_ctx` that varies per request reloads the model each time, which is seconds to minutes. A fixed `numCtx` setting still
  reloads the model once and fights the user's own Ollama setting.

  Chosen design:
  - In `prepareModel`, a cheap `GET /api/ps` (2 s timeout) records the loaded context.
  - If the model is not loaded, `generate` (inside the router's limiter, so the queue order holds) first loads it with
    `POST /api/generate {"model": id}`, without `keep_alive`, so Ollama's own `keep_alive` applies. It then reads `/api/ps` again and
    checks the prompt before sending it. The load uses the same Modelfile and server defaults the request would use, so it costs no extra
    reload; it only moves the load earlier.
  - The server checks the prompt a second time right after `prepare`, so a model that is already loaded gets a real HTTP 400 even for
    `stream: true`. A refusal after a first load comes from inside `generate`: a JSON 400 for a non-stream request, and an SSE error
    event with code `context_length_exceeded` for a stream that has already started.
- **D2 Ollama characters per token (USER).** The limit is `context_length` from `/api/ps` × **3** characters. This is stricter than the ×4
  used everywhere else, because Ollama truncates silently: about 3.5 characters per token for English means ×4 would let prompts of up
  to 1.15× `num_ctx` through. ×3 refuses some prompts that would have fit. When `/api/ps` gives nothing (old Ollama, an error), the limit
  stays as in AAP-70: `/api/show` `context_length` × 4. `providers.ollama.maxPromptChars` still wins (0 = off).
- **D3 Ollama hint.** A refusal based on the loaded context ends with: " Ollama runs this model with a context of N tokens (num_ctx); raise
  it in Ollama (the app's context length setting, OLLAMA_CONTEXT_LENGTH, or PARAMETER num_ctx in a Modelfile) to allow a longer prompt."
- **D4 Load timeout.** The load is bounded by the request's abort signal and by `OLLAMA_LOAD_TIMEOUT_MS = 300_000`. If it fails or times
  out, the request goes on without the loaded limit (the `/api/show` limit applies) and one warn line is logged. The failure is not an
  error to the client.
- **D5 Cost computation.** The provider computes the cost, because it knows the raw model id, the token split and the request time:
  `costUsd = (hit × price.hit + miss × price.miss + output × price.output) / 1e6`.
  - hit = `usage.cachedReadTokens`; miss = `usage.inputTokens` (which is prompt minus cached in this code base); output =
    `usage.outputTokens` (reasoning included, as DeepSeek bills it).
  - A cancelled result or one without usage has no cost.
  - An unknown model id has no cost; one debug line per id is logged.
  - Legacy ids `deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` use the flash prices.
- **D6 Peak rule.** Peak is Monday to Friday, 01:00-04:00 and 06:00-10:00 UTC (start inclusive, end exclusive). Every other time is
  off-peak. The time used is the request start (when the chat POST is sent). Chinese public holidays are ignored and the constant's
  comment says so.
- **D7 Where cost shows.**
  - Activity log Tokens cell: appended " · $0.000123".
  - Usage page: a new "Cost" column in the table (provider rows and the total; "-" when 0), and a "Cost" stat tile shown only when the
    range's total is above 0.
  - Not on the Overview "Today" strip and not on the DeepSeek card. The card shows the balance, which is the real money.
- **D8 Cost format.** Under $0.01: 2 significant digits ("$0.00012"). From $0.01 up: 4 decimals up to $1 ("$0.0123"), then 2 decimals
  ("$12.34"). The full value goes in the tooltip ("$0.000123456").
- **D9 Overview DeepSeek row.** It is appended after the three ACP rows and has no Log in / Log out buttons, because it uses a key. Its line
  comes from `describeSignIn`, which already covers disabled, `needs_login` (the key message) and error. Below that: "Balance: 30.05 USD"
  when known, the usage-limit line, and the model-count chip.
- **D10 `thinking` validation.**
  - Accepted only as an object whose `type` is `"enabled"` or `"disabled"`. Other keys are dropped and only `{type}` is forwarded.
  - `null` or absent means not sent.
  - Any other value is a 400 `invalid_request` with param `thinking` and the message
    `thinking must be {"type": "enabled"} or {"type": "disabled"}.`
  - Providers other than DeepSeek ignore it silently, as ACP does with `reasoning_effort`; it is not put in `x-acp-proxy-ignored-params`.
  - It is forwarded next to `reasoning_effort` when both are sent, and DeepSeek resolves the two.
- **D11 Exhausted file (USER, small).**
  - `<dataDir>/exhausted.json` holds `{"version": 1, "providers": {"<id>": {"until": "<ISO>"}}}`.
  - It is read synchronously in the router constructor (like `models-cache.json`). An entry is dropped when its time has passed, when it
    is more than `maxMs` (31 days) ahead, or when it is invalid.
  - Entries for provider ids that are not in this run (a disabled provider) are kept as they are and written back until they expire, so
    turning a provider off and on does not forget its limit.
  - The file is written atomically (tmp + rename, on the router's `writeQueue`) on every mark and every clear. Natural expiry does not
    write; the next load drops the entry.
  - Each restored entry logs one info line: `'<id>' is still at its usage limit until <ISO> (restored).`
  - The restored mark is cleared the usual ways: a success, a DeepSeek probe with `is_available: true`, or its time passing.
- **D12 Clamp.** Clamping is silent to the client: the response is not marked, and `max_tokens` in the body is the clamped value. One info
  log line per clamped request: `max_tokens <n> is over <model>'s output limit of <max>; sent <max>.` The base class takes the limit from
  a numeric `max_output_tokens` in the `/models` entry. DeepSeek uses its `/models` value, else `DEEPSEEK_MAX_OUTPUT_TOKENS = 393_216`
  for any id.
- **D13 Typecheck runner.** `scripts/typecheck.mjs` runs `process.execPath node_modules/typescript/bin/tsc <args>` three times with
  `spawnSync` and `stdio: "inherit"`. It uses no shell, so it behaves the same under npm, yarn, Windows and CI. The args are:
  - `--noEmit`
  - `--noEmit -p tsconfig.renderer.json`
  - `-p tsconfig.tests.json`

  All three always run. It then prints a summary line per project (`typecheck: <project> ok` or `typecheck: <project> FAILED (exit N)`)
  and sets `process.exitCode = 1` if any failed. `package.json` `typecheck` becomes `node scripts/typecheck.mjs`. CI (`yarn typecheck`)
  needs no change: `.yarnrc.yml` has `nodeLinker: node-modules`, so `node_modules/typescript` exists.

## Contracts

K1 `src/providers/local-openai.ts`, `LocalOpenAiOptions` gains:
- `loadedContext?: (model: string, signal: AbortSignal) => Promise<number | undefined>`: the context the upstream runs the model with now,
  or `undefined` when the model is not loaded (Ollama: `/api/ps`).
- `loadModel?: (model: string, signal: AbortSignal) => Promise<void>`: loads the model (Ollama: `POST /api/generate {"model"}`).
- `contextHint?: (tokens: number) => string`: the D3 text, appended to a refusal that is based on the loaded context.

Class changes:
- `private readonly loaded = new Map<string, number>()`.
- `contextTokens(model)` = `this.contexts.get(model)` as today. A new `maxPromptCharsFor(model)` order: setting (0 = none, > 0 = it), then
  `loaded.get(model) * 3` (`LOADED_CHARS_PER_TOKEN = 3`), then `contextTokens(model) * CHARS_PER_TOKEN`, else none.
- `checkPrompt` passes `contextHint(loaded tokens)` to `promptTooLong` when the limit came from `loaded`.
- `prepareModel`, no-profile branch, when `loadedContext` is set: `GET` with a 2 s timeout. A number sets `loaded`, `undefined` deletes it,
  and an error leaves it unchanged.
- `generate`, at the start, when `loadModel` is set and `!loaded.has(model)`: `loadModel` (D4 timeout, linked to the request signal), then
  `loadedContext` again, then `this.checkPrompt(messages, options, model)`. On failure: warn and go on.
- `protected readonly outputLimits = new Map<string, number>()`. Base `listModels` (no-profile) stores a numeric `max_output_tokens > 0`
  of each entry.
- `protected maxOutputTokensFor(model: string): number | undefined` returns `outputLimits.get(model)`.
- `chatBody`: when `maxOutputTokens > max`, it sends `max` and logs the D12 line.

New exports:
- `ollamaLoadedContext(rootUrl, fetchImpl)`: `GET <root>/api/ps`; the entry with `name === model || model === model`; a numeric
  `context_length > 0`, else `undefined`.
- `ollamaLoadModel(rootUrl, fetchImpl)`: `POST <root>/api/generate` with body `{"model": id}` only, read to the end; a non-2xx status
  throws.
- `ollamaRegistration` passes all three, plus `contextHint` with the D3 text.

K2 `src/api.ts`:
- `promptTooLong(displayName, chars, limit, param = "messages", hint?: string)`. With a hint, the message is the C3 text + " " + hint. The
  prefix is unchanged.
- `NormalizedRequest.thinking?: "enabled" | "disabled"`, parsed per D10 in `normalizeChat`. Error:
  `new ApiError(400, "invalid_request", 'thinking must be {"type": "enabled"} or {"type": "disabled"}.', "thinking")`.

K3 `src/provider.ts`:
- `GenerateOptions.thinking?: "enabled" | "disabled"` with the doc "DeepSeek only; others ignore it".
- `GenerationResult.costUsd?: number` with the doc "Provider-computed price of this call in USD (DeepSeek); absent when unknown".

K4 `src/providers/deepseek-pricing.ts` (new):
```ts
export interface TokenPrices { hit: number; miss: number; output: number } // USD per 1M tokens
/** Checked 2026-11-28 at api-docs.deepseek.com. Peak = Mon-Fri 01:00-04:00 and 06:00-10:00 UTC; Chinese public holidays are ignored. */
export const DEEPSEEK_PRICES: Record<string, { offPeak: TokenPrices; peak: TokenPrices }> = {
  "deepseek-flash":  { offPeak: { hit: 0.003, miss: 0.15, output: 0.6 },  peak: { hit: 0.006, miss: 0.3,  output: 1.2 } },
  "deepseek-v4-pro": { offPeak: { hit: 0.022, miss: 0.66, output: 1.98 }, peak: { hit: 0.044, miss: 1.32, output: 3.96 } },
};
export const DEEPSEEK_PRICE_ALIASES: Record<string, string> = { "deepseek-v4-flash": "deepseek-flash", "deepseek-v4-flash-vision-exp": "deepseek-flash" };
export const DEEPSEEK_PEAK_WINDOWS_UTC: ReadonlyArray<[startHour: number, endHour: number]> = [[1, 4], [6, 10]];
export function isDeepSeekPeak(at: Date): boolean;               // getUTCDay() 1..5 and an hour inside a window
export function deepseekCostUsd(model: string, usage: Usage, at: Date): number | undefined;
```

K5 `DeepSeekProvider`:
- New option `now?: () => number` (tests).
- `generate` takes `started = new Date(now())` before `super.generate` and, on a result that is not cancelled and has usage, sets
  `result.costUsd = deepseekCostUsd(model, usage, started)`.
- `chatBody` adds `thinking: { type: options.thinking }` when set.
- `listModels` stores `max_output_tokens` into `outputLimits`.
- `maxOutputTokensFor(model)` = `outputLimits.get(model) ?? DEEPSEEK_MAX_OUTPUT_TOKENS`.
- Export `DEEPSEEK_MAX_OUTPUT_TOKENS = 393_216`.

K6 Activity and usage:
- `ActivityEntry.costUsd?: number`, server `Trace.costUsd`, set in `traceUsage` from `result.costUsd` when it is finite and > 0, and copied
  into the entry beside `cachedTokens`.
- `UsageCountsView.costUsd: number`. In `usage-store.ts`: `zero()` gets `costUsd: 0`, `addInto` sums it, a new `amount(v)` (finite, ≥ 0, no
  floor) is used in `sanitize` and `add`. The file stays `version: 1` and old files load 0.

K7 Router: `RouterOptions.exhaustedPath?: string`, D11 format and behaviour. Controller (`src/controller.ts:249`) passes
`exhaustedPath: path.join(this.dataDir, "exhausted.json")`.

K8 Renderer: `src/renderer/cost-format.ts` (new) with `formatUsd(value: number): string` and `formatUsdFull(value: number): string` (D8).

K9 Server: `bridge.checkPrompt?.(parsed.model, parsed.conversation, options)` is called again right after `prepare(...)` in `handleChat` and
`handleResponses`. A throw releases the lease first (`lease?.release()`; Responses wraps it with `forResponses`). `handleChat` options
carry `thinking`.

## Files and modules to touch

| File:line (on AAP-70 head 3d0f285) | Change | Task |
|---|---|---|
| `src/provider.ts:20,22` | K3 | T1 |
| `src/api.ts:53-62,158,402-408,588-590` | K2: `thinking` parse (schema stays passthrough; parse like `reasoning_effort` at :404-407), `promptTooLong` hint | T1 |
| `src/server.ts:26,61-69,210,216-217,289-295,514-520` | `Trace.costUsd`, `traceUsage`, options `thinking`, K9 second check, entry `costUsd` | T1 |
| `src/activity.ts:28-33` | `costUsd?` | T1 |
| `src/router.ts:12-28,45-62,197-203,250-270` | K7: option, load in ctor, `persistExhausted()` called from `markExhausted`, the `track` clear (:253) and the `refreshOne` clear (:202) | T2 |
| `src/controller.ts:249` | `exhaustedPath` | T2 |
| `src/usage-store.ts:32-43,77-81` | K6 store part | T2 |
| `src/shared/ipc.ts:154` | `UsageCountsView.costUsd` | T2 |
| `src/providers/local-openai.ts:14-35,95-109,168-203,238-257,272-289,480-499` | K1 | T3 |
| `src/providers/deepseek-pricing.ts` (new) | K4 | T4 |
| `src/providers/deepseek.ts:9-19,33-47,65-70,94-99` | K5 | T4 |
| `src/renderer/cost-format.ts` (new) | K8 | T5 |
| `src/renderer/settings.ts:50,449-497,520-522` | D9 Overview row; activity cost suffix | T5 |
| `src/renderer/usage-view.ts:106-150` | Cost tile and column | T5 |
| `src/renderer/settings.html:103` | `<th>Cost</th>` | T5 |
| `src/renderer/settings.css:214-217` | `.ov-line.balance` only if needed (reuse `.ov-line muted`) | T5 |
| `scripts/typecheck.mjs` (new), `package.json` `scripts.typecheck` | D13 | T6 |
| `tests/local-openai.test.ts:195-250` (Ollama), `:415-560` (DeepSeek) | see Acceptance | T3, T4 |
| `tests/deepseek-pricing.test.ts` (new) | AC5 | T4 |
| `tests/router.test.ts:139-175` | AC9 | T2 |
| `tests/usage-store.test.ts:21,57` | AC6 | T2 |
| `README.md` (Ollama, DeepSeek, Usage, Usage limit and Development sections), `ROADMAP.md`, `changelog.md` (this folder) | docs | T7 |

## Tasks for workers

Order: T1, T2, T6 run in parallel (disjoint files). T3 after T1 (needs the `promptTooLong` hint). T4 after T1 and T3 (needs K3 and the
`outputLimits` / `maxOutputTokensFor` surface). T5 after T2 (needs `UsageCountsView.costUsd`, `ActivityEntry.costUsd`). T7 last.
Every task ends with `fnm exec --using default npm run typecheck` (after T6 lands, the new runner) and its own test files
(`fnm exec --using default npx vitest run <files>`). The final run is the whole `fnm exec --using default npm test`.

### T1. Core: api, provider, server, activity
Inputs: K2, K3, K6 (entry part), K9, D10.
Outputs:
- `normalizeChat` returns `thinking`.
- `handleChat` options include `...(parsed.thinking ? { thinking: parsed.thinking } : {})`.
- K9 second check in both handlers.
- `traceUsage` sets `trace.costUsd`, and the entry copies it.
- `promptTooLong` hint parameter.
- `activity.ts` `costUsd?` with the doc "Provider-computed price in USD (DeepSeek)".

Tests: `tests/prompt-limit.test.ts`, `tests/proxy.test.ts` and `tests/api*.test` must stay green unchanged; the new behaviour is proved in
T3 and T4.

### T2. Router persistence, usage store, ipc
Inputs: K6 (store part), K7, D11.
Outputs:
- In the router: `private readonly dormant = new Map<string, number>()` for the ids of other runs.
- `readExhausted()` in the ctor; `persistExhausted()` writes `exhausted` + `dormant` (as ISO) with the tmp + rename pattern of `persist()`
  (:76-89) on `writeQueue`.
- `close()` already awaits `writeQueue`.
- Usage store and ipc per K6.
- The `controller.ts` option.

Tests owned: AC6, AC9.

### T3. Ollama loaded context and the base clamp (`src/providers/local-openai.ts`)
Inputs: K1, D1-D4, D12.
Outputs: K1 exactly. Notes:
- The load in `generate` happens before the chat fetch and uses its own `AbortController`, linked to `signal` and to the D4 timer.
- Never send `keep_alive`.
- The `prepareModel` read applies only when there are no profiles and `loadedContext` is set. Gufo, Strata and Llama.cpp do not set it,
  so they are unchanged.

Interface to T4: `protected outputLimits`, `protected maxOutputTokensFor`, the clamp inside the base `chatBody`, and `protected logger`
(already protected).

Tests owned: AC1, AC2, AC8 (Ollama part).

### T4. DeepSeek: pricing, cost, thinking, clamp
Inputs: K4, K5, D5, D6, D10, D12; T1 and T3 merged.
Outputs: `deepseek-pricing.ts`; the `DeepSeekProvider` changes per K5; `deepseekRegistration` unchanged (`now` is test-only).

Tests owned: AC3, AC4, AC5, AC8 (DeepSeek part).

### T5. Settings window
Inputs: K6, K8, D7, D8, D9; T2 merged.
Outputs:
- `cost-format.ts`.
- `renderOverview`: `const overviewOrder = [...providerOrder, "deepseek"] as const`. For `deepseek` the actions are the Settings button
  only. After the sign-in line comes `make("p", "ov-line muted", \`Balance: ${status.balance}\`)` when `status.balance` is set. The rest is
  shared (badge, usage-limit line, chips).
- Activity Tokens cell: appended `` ` · ${formatUsd(entry.costUsd)}` `` when `entry.costUsd > 0`, with the cell `title` set to
  `formatUsdFull`.
- Usage: a `costCell(value)` that shows "-" when 0 and has a title; a column in the rows and the total; `renderStats` adds
  `stat("Cost", formatUsd(counts.costUsd), { title: formatUsdFull(...) })` when `counts.costUsd > 0`.
- `settings.html:103` `<th>Cost</th>` after Output tokens.

Tests: none new; `tests/settings-fields.test.ts` and `tests/desktop-views.test.ts` stay green. AC10 is manual.

### T6. Typecheck runner
Inputs: D13. Outputs: `scripts/typecheck.mjs` and the `package.json` script.

Proof (AC11, by hand, not committed):
1. Add `const x: number = "a";` to `src/usage.ts` and to `tests/usage.test.ts`.
2. Run `fnm exec --using default npm run typecheck`: both errors are printed, the summary shows main FAILED, renderer ok, tests FAILED,
   and the exit code is 1.
3. Revert and run it again: all ok, exit 0.
4. Also run `fnm exec --using default yarn typecheck` once.

### T7. Docs
- README:
  - Ollama: the loaded-context limit, ×3, the load-first step, the hint, and that the proxy never sends `num_ctx`.
  - DeepSeek: cost (where it shows, the table file, peak rule, holidays ignored), `thinking`, and the clamp.
  - Usage page: the Cost column.
  - Usage limit: survives restarts in `exhausted.json`.
  - Development: `npm run typecheck` reports all three projects.
- ROADMAP: one checked line "(AAP-71) AAP-70 follow-ups: Ollama loaded num_ctx limit, DeepSeek cost, Overview balance, thinking
  pass-through, persisted usage-limit state, max_tokens clamp, full typecheck".
- `changelog.md` in this folder with DONE / NOT DONE / UNTESTED.

## Acceptance criteria and the tests that prove them

Few tests, extending existing files; one new file for the pure price function. Fake upstreams are `node:http`, as in
`tests/local-openai.test.ts`.

| # | Criterion | Proof |
|---|---|---|
| AC1 | Ollama, model not loaded (`/api/ps` without it): a chat makes exactly one `POST /api/generate` with body `{"model":"qwen3.8:latest"}` (no `prompt`, no `keep_alive`), then reads `/api/ps` (`context_length: 32`). A 200-character prompt (> 32 × 3 = 96) answers 400 `context_length_exceeded`; the message starts "The prompt is too long for Ollama: 200 characters, the limit is 96." and contains "num_ctx". The upstream chat is never called. | New `it` in `describe("LocalOpenAiProvider")` of `tests/local-openai.test.ts`: "limits an Ollama prompt by the loaded num_ctx from /api/ps and loads the model first" (non-stream request). |
| AC2 | Same fake, model now loaded: a 200-character `stream: true` request answers a real HTTP 400 (not SSE), with no second load. An 80-character prompt goes through (200). `/v1/models` `max_prompt_chars` = 96. The existing Ollama test (no `/api/ps`, 404) keeps its 256 limit unchanged. | Same `it`, three more requests; the existing test at :195 untouched and green. |
| AC3 | DeepSeek non-stream at a fixed peak time (Tue 02:00 UTC) with upstream usage `prompt_tokens 1000, prompt_cache_hit_tokens 400, completion_tokens 200`: the activity entry `costUsd` = (400×0.006 + 600×0.3 + 200×1.2)/1e6 = 0.0004224 (`toBeCloseTo`, 10 digits). `usage.json` `costUsd` sums it. The request `thinking: {type: "disabled", budget_tokens: 5}` reaches upstream as `thinking: {type: "disabled"}`. `max_tokens: 500000` reaches upstream as the `/models` `max_output_tokens` (fake: 1000). | Extend DeepSeek it 1 (`local-openai.test.ts:447`), with `now` injected through a directly built `DeepSeekProvider`. |
| AC4 | `thinking: {type: "on"}` → 400 `invalid_request`, param `thinking`, no upstream call. `thinking: "enabled"` → the same. | Fold into DeepSeek it 3 (`:498`). |
| AC5 | Peak and off-peak: Mon 01:00 UTC peak, Mon 04:00 off-peak, Fri 09:59 peak, Sat 02:00 off-peak. Legacy `deepseek-v4-flash` priced as flash. An unknown model → `undefined`. Off-peak cost of the AC3 usage = 0.0002112. | New `tests/deepseek-pricing.test.ts`, one `it`. |
| AC6 | The usage store sums `costUsd` (floats, not floored), and a file without `costUsd` loads 0. | Extend `usage-store.test.ts:21` (an entry with `costUsd: 0.0004224` twice → 0.0008448) and `:57` (old file). Update exact `toEqual` count objects for `costUsd: 0`. |
| AC7 | Overview shows a DeepSeek row: badge, line, "Balance: 30.05 USD", usage-limit line, Settings button, no Log in / Log out. The Activity log shows "· $…". The Usage table has a Cost column and a Cost tile. | Manual in the app (`fnm exec --using default npm run app:dev`), screenshot; otherwise UNTESTED. |
| AC8 | Clamp: base provider with `/models` `max_output_tokens: 50` and `max_tokens: 80` → upstream `max_tokens: 50` plus one info log line. Without the field it is unchanged. DeepSeek: the AC3 fake's `/models` gives `max_output_tokens` for `deepseek-flash` only, and one more request to `deepseek/deepseek-v4-pro` with `max_tokens: 500000` reaches upstream as 393216. | Ollama-family part: extend the "passes a forwarded output limit through" `it` (`local-openai.test.ts:252`). DeepSeek part: one more request in DeepSeek it 1 (AC3). |
| AC9 | Persistence: router A marks `a` exhausted (cooldown 5 min) with `exhaustedPath` in a temp dir. Router B on the same file, before any call, refuses `a/m` with 429 `usage_limit_exceeded` without calling the provider, and `exhaustedProviders()` has the same ISO. A file entry whose time has passed is dropped. An entry for an id not in router B's providers is kept in the file after B writes. After B's success on `a` the file has no `a`. | New `it` in the exhaustion `describe` of `tests/router.test.ts` (:139): "keeps the usage-limit state across a restart". |
| AC10 | No regression. | `fnm exec --using default npm run typecheck`; `fnm exec --using default npm test` (expect 550+ passed, 1 skipped, 0 failed). |
| AC11 | The typecheck runner reports every failing project and exits non-zero. | T6 manual proof, recorded in the changelog. |
| AC12 | Live behaviour. | Live check below. |

## Live check (second headless instance on port 8797; never touch 8787)

Spend: at most **4** DeepSeek chat calls, each with `max_tokens` ≤ 64. `/models` and `/user/balance` are free. The clamp is proved with
fakes only: a live `max_tokens` over 64 is forbidden.

0. The user puts the key in `C:/projects/Personal/api-acp-proxy/.claude/temp/aap71-live/key.txt` (`.claude/temp/` is gitignored). The
   worker never prints, logs or commits it. Ollama must be running with at least one small model pulled (free).
1. Write `.claude/temp/aap71-live/settings.json` (no key in it):
   `{"server":{"port":8797},"providers":{"codex":{"enabled":false},"claude":{"enabled":false},"antigravity":{"enabled":false},"gufo":{"enabled":false},"strata":{"enabled":false},"llama":{"enabled":false},"ollama":{"enabled":true},"deepseek":{"enabled":true}}}`
2. Start (Bash, background):
   `cd C:/projects/Personal/api-acp-proxy && PROXY_SETTINGS_FILE=.claude/temp/aap71-live/settings.json PROXY_DEEPSEEK_API_KEY="$(cat .claude/temp/aap71-live/key.txt)" fnm exec --using default npx tsx src/index.ts`
   Check that `GET http://127.0.0.1:8797/healthz` answers. Do not call 8787.
3. Ollama, free (`<m>` = a listed `ollama/<name>:<tag>`, `<root>` = `http://127.0.0.1:11434`):
   1. Unload it: `curl -s <root>/api/generate -d '{"model":"<name:tag>","keep_alive":0}'`. `GET <root>/api/ps` should not list it.
   2. Chat through 8797 with `max_tokens: 8` and a short prompt → 200. The instance log shows the load, and `<root>/api/ps` now lists the
      model with `context_length` = the CONTEXT column of `ollama ps`. Record the value N and whether `OLLAMA_NUM_PARALLEL` changes it.
   3. `GET :8797/v1/models` → `max_prompt_chars` for `<m>` = N × 3.
   4. A prompt of N × 3 + 10 characters, `stream: true` → HTTP 400 `context_length_exceeded` with the num_ctx hint. `ollama ps` shows
      the same model loaded since before (no reload). Ollama's log shows no request.
   5. D1 fact check: `curl -s <root>/v1/chat/completions -d '{"model":"<name:tag>","messages":[{"role":"user","content":"hi"}],"max_tokens":4,"options":{"num_ctx":<N*2>}}'`
      directly to Ollama, then `GET /api/ps`. Record whether `context_length` changed. If it changed, `/v1` honours `options`; the design
      stands either way. Note it in the changelog for a later ticket. Then put the model back with `keep_alive: 0` and one normal chat.
4. DeepSeek `/models` (free): `GET :8797/v1/models` → `deepseek/deepseek-flash` and `deepseek/deepseek-v4-pro`. The instance's debug log or
   a temporary `curl` to `https://api.deepseek.com/models` with the key from the env shows `max_output_tokens: 393216`. Record the balance
   (amounts only).
5. DeepSeek call 1: `{"model":"deepseek/deepseek-flash","messages":[{"role":"user","content":"Reply with OK."}],"max_tokens":16,"thinking":{"type":"disabled"}}`
   → 200, `completion_tokens_details.reasoning_tokens` 0 or absent. The activity entry (`GET` via the instance's usage file after the flush,
   step 8) has `costUsd` > 0 and equal to K4 for the reported usage and the call's UTC time (compute by hand, record it).
6. DeepSeek call 2, stream: the same prompt, `"thinking":{"type":"enabled"}`, `"reasoning_effort":"low"`, `max_tokens: 64`,
   `stream_options.include_usage: true` → `reasoning_content` deltas and `reasoning_tokens` > 0 in the usage chunk. A `length` stop is fine.
7. DeepSeek call 3: `deepseek/deepseek-v4-pro`, call 1's body → 200, and its cost uses the pro prices. Call 4 is a spare for one retry.
8. After 3 s (the flush), `.claude/temp/aap71-live/usage.json` has `deepseek.costUsd` = the sum of steps 5-7 (±1e-9). The `ollama` entries
   have no `costUsd` (0).
9. Persistence (free):
   1. Stop the instance.
   2. Write `.claude/temp/aap71-live/exhausted.json`:
      `{"version":1,"providers":{"deepseek":{"until":"<now + 10 min ISO>"},"codex":{"until":"<now - 1 min ISO>"}}}`.
   3. Start again. The log has the "restored" line for deepseek only.
   4. A chat to `deepseek/deepseek-flash` → 429 `usage_limit_exceeded` with `Retry-After` and no upstream call (the call count stays 3).
      `/healthz` shows `providers.deepseek.exhausted_until`.
   5. `GET /v1/models` (the balance probe says available) → the mark is cleared. The file no longer has `deepseek`, and `codex` was dropped.
10. Typecheck runner: run `fnm exec --using default npm run typecheck` on the finished branch → three "ok" lines, exit 0.
11. Overview: if the director runs the app (`npm run app:dev`, which uses its own settings, not 8787's process), screenshot the DeepSeek row
    with the balance. Otherwise AC7 is UNTESTED.
12. Stop the instance. Delete `key.txt`, `settings.json`, `usage.json`, `models-cache.json` and `exhausted.json` under
    `.claude/temp/aap71-live/`. `git status` shows no file with the key.

Not testable live (UNTESTED unless it happens): 402, 429, `is_available: false`, and a clamp of a live `max_tokens` over 393216.

## Risks

- `/api/ps` `context_length` may be the total across parallel slots on some Ollama versions. Step 3.2 compares it with `ollama ps`. If it is
  the total, divide by the parallel count (the ticket gets a follow-up; a ×3 limit on a doubled context is too lenient).
- The load-first step adds the model load before the request timer in the non-loaded case only. It is inside the router's limiter, so with
  `maxConcurrent: 1` a slow load holds the queue just like the request itself would.
- The ×3 ratio refuses some prompts that would fit (dense code, CJK the other way round). The setting overrides it.
- DeepSeek may bill by completion time, not by request start. A call that crosses a window edge may then be priced at the other rate.
  Accepted (rare, at most 2×).
- Floating sums in `usage.json` accumulate rounding error around 1e-12 per add; negligible.

## Implementation status (2026-11-28, implement)

- [x] T1 core - DONE
- [x] T2 router persistence, usage store, ipc - DONE (AC6, AC9 pass)
- [x] T3 Ollama loaded context, base clamp - DONE (AC1, AC2, AC8 pass)
- [x] T4 DeepSeek pricing, cost, thinking, clamp - DONE (AC3, AC4, AC5, AC8 pass)
- [x] T5 settings window - DONE; AC7 UNTESTED (app not started)
- [x] T6 typecheck runner - DONE; AC11 proof in changelog.md
- [x] T7 docs - DONE
- AC10: typecheck 3x ok; npm test 552 passed, 1 skipped, 0 failed. AC12 live check: left to the director's checker.
- Deviations: see changelog.md.

### Polish round 1 (2026-11-28): D1/K1 rule changed

Live fact: Ollama `/v1/chat/completions` ignores `num_ctx`; a `/v1` request runs the model at Ollama's default context (and reloads a runner started with other options). So the K1 `loaded` map is replaced by `defaultContext`: the context the proxy's own `/v1` requests run at, measured only from `/api/ps` right after the proxy's load-first (`/api/generate {model}`) and after each successful proxy chat (background, 2 s). A `/api/ps` value another client caused is not the limit. `maxPromptCharsFor` = setting (0 = off), else `defaultContext` × 3, else `/api/show` × 4. `prepareModel` reads `/api/ps` and forgets `defaultContext` of a model that is not loaded (the next load re-measures). The server's check before `prepare` passes `beforePrepare = true` and skips `defaultContext` (only the setting and `/api/show`); the K9 check after `prepare` uses it, so an already-measured model still gets a real HTTP 400. `/api/ps` 404/405/501 or no model list turns the load-first step and the `/api/ps` reads off for 10 minutes. Native Ollama calls send the Bearer key.
