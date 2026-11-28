---
status: done
request: REQ-0025
repos: [C:/projects/Personal/api-acp-proxy]
branch: AAP-70_deepseek-provider-tokens
updated: 2026-11-28
---
# AAP-70: DeepSeek provider, and the token logic for Ollama and DeepSeek

Research: `research.md` (same folder; code facts with file:line, and the section "DeepSeek API facts (docs, 2026-11-28)").
Request: `.claude/director/requests/REQ-0025-ollama-deepseek-tokens.md`. Template for registering a provider: commit `d99bfb3` (Ollama, AAP-69).

Build reading: the full one. `deepseek` is a real provider for chat (stream and non-stream) with key, models, balance and errors, and
all four token features work end to end for `ollama` and `deepseek`. It is not a "DeepSeek settings field only" change.

## Scope

A. New cloud provider `deepseek`: the official API at `https://api.deepseek.com`, key in Settings (encrypted at rest through `mapSecrets`),
   model ids `deepseek/<id>`, models from `GET /models` with a static fallback, balance from `GET /user/balance`, its own settings page.

B. For `ollama` and `deepseek`, the token logic the other providers have:
   1. Real usage (prompt / completion / cached / reasoning) in the non-stream body, in the stream's usage chunk, in the activity log, in
      `usage.json` and on the Usage page (cached and reasoning are new fields for every provider).
   2. Output limit (`max_tokens` / `max_completion_tokens` / `max_output_tokens`) forwarded upstream as `max_tokens`; the proxy's own chars/4
      cut-off no longer runs for a provider that forwards the limit, so the upstream `finish_reason: "length"` and its real usage win.
   3. Prompt size limit: a prompt over the model's limit is refused before anything is sent: HTTP 400 `context_length_exceeded`, message
      starts "The prompt is too long". An upstream context-size 400 maps to the same code.
   4. Usage limit / balance: DeepSeek 402 (or a balance probe with `is_available: false`) -> the router's exhausted state: typed 429
      `usage_limit_exceeded`, the card line, `/v1/models` `exhausted_until`, `/healthz providers.deepseek.exhausted_until`. Ollama: not
      applicable (no quota), said so on its page.

## Out of scope

- Ollama Cloud (ollama.com hosted models, its keys and quotas).
- Cost or price display (prices are in research.md for later).
- GPU-memory coordination between Ollama and the launcher's local servers.
- Images for DeepSeek beyond pass-through: `deepseek-flash` is marked `vision: true` so image parts are sent as `image_url` like any
  vision model; nothing more (no image generation, no resizing, no live image test).
- The Anthropic-format endpoint of DeepSeek, FIM / prefix completion (`/beta`), DeepSeek web-search tools.
- Function tools through DeepSeek (the local-openai family has `tools: false`; the `reasoning_content` round trip that tools need is not built).
- A `thinking: {type}` pass-through field (only `reasoning_effort` is forwarded; see D7).
- Clamping `max_tokens` to a model's max output (passed through; an upstream 400 comes back as a 400, see D12).
- `maxPromptChars` settings for Gufo / Strata / Llama.cpp (they get the base-class check code but no automatic limit and no setting).
- Persisting the exhausted state across restarts (memory only, as AAP-31).

## Decisions (director's, baked in; the user may override any of them)

- D1 Base class: `DeepSeekProvider` in a new `src/providers/deepseek.ts` extends `LocalOpenAiProvider`. The base gets protected hooks
  (`chatBody`, `httpError`, `unreachable`, `contextTokens`) and the shared `checkPrompt` / `maxPromptCharsFor`, so Ollama gets the prompt
  check from the base. No `if (id === "deepseek")` in `local-openai.ts`.
- D2 Settings `providers.deepseek`: `enabled` default **false**; `baseUrl` default `https://api.deepseek.com` (trailing `/` and `/v1` are
  stripped; `https:` required except for `localhost` / `127.0.0.1` / `[::1]`, which may be `http:` for tests and fakes); `apiKey`
  optional (encrypted); `maxConcurrent` default **4**; `maxPromptChars` optional. Env override `PROXY_DEEPSEEK_API_KEY` (so the live check
  never writes the key to a file).
- D3 HTTP 402 (insufficient balance) -> `UsageLimitError` -> router exhausted path (429 `usage_limit_exceeded`, `Retry-After`, card line,
  `/healthz`). DeepSeek gives no reset time, so the exhaustion lasts `server.usageLimitCooldownMinutes` (default 60) or until a success
  or a balance probe that says `is_available: true`.
- D4 HTTP 429 (rate limit) -> a transient 429 `rate_limit_exceeded` passed to the client with `Retry-After` (the upstream header if it
  has one, else 10 s). Never marks the provider exhausted.
- D5 HTTP 401 / 403 -> provider state `needs_login` with the message "DeepSeek API key missing or rejected — enter a valid key in
  Settings > DeepSeek and save." and the request answers 503 `provider_auth_required` (`ProviderAuthRequiredError`, the code the ACP
  providers use). A missing key: same state and message at start, and requests answer the same 503 without a network call. Side effect,
  accepted: the tray shows its "DeepSeek needs login. Click to open the settings" notification once (controller.ts:106-108), which leads
  to the right page.
- D6 Balance: `GET /user/balance` runs together with `GET /models` in `DeepSeekProvider.listModels` (start, Refresh, and `/v1/models`),
  at most once per 60 s unless `force` (Refresh button / `router.refresh`). `is_available: false` -> exhausted; `true` -> clears an
  exhaustion. The card shows "Balance: 110.00 USD" (all `balance_infos`, joined with " + "). No polling loop. A balance probe failure
  changes nothing (no state change, the line keeps the last value).
- D7 `reasoning_effort` is forwarded unchanged (DeepSeek maps `minimal` / `medium` / `xhigh` itself). `reasoning_content` streams as
  reasoning exactly as for the local servers. `chat_template_kwargs` is NOT forwarded to DeepSeek (llama-server only).
- D8 Usage parsing (base, so every local-openai provider gets it): when `prompt_tokens_details.cached_tokens` is absent, read the top-level
  `prompt_cache_hit_tokens`.
- D9 Usage store: add `cachedTokens` and `reasoningTokens` to the per-provider/day counts for all providers. The file stays `version: 1`;
  an old file without the fields loads them as 0. The UI change is minimal: the input and output cells of the Usage table get a tooltip
  ("of which N cached" / "of which N thinking"); no new columns, tiles or chart series. `ollama` and `deepseek` get chart colours.
- D10 Output limit: a provider that forwards the limit upstream sets `forwardsOutputLimit = true` (the whole `LocalOpenAiProvider` family:
  Gufo, Strata, Llama.cpp, Ollama, DeepSeek). For those `runGeneration` (server.ts:156) passes everything through and keeps the provider's
  result: real `finish_reason`, real usage. ACP providers are unchanged (chars/4 cut, estimated usage).
- D11 Prompt limit, in characters as AAP-30 (`maxPromptChars`, `max_prompt_chars` in `/v1/models`): the effective limit per model is the
  setting when set (0 = no limit), else `contextTokens(model) * 4` (CHARS_PER_TOKEN), else none. Counted: the `instructions` text plus the
  text of every message (`messageText`), images not counted. This is lenient on purpose: DeepSeek's tokenizer is about 3.3 chars/token
  for English, so ×4 refuses only prompts the upstream would refuse too; the upstream's own context 400 is the backstop.
  - Ollama: `context_length` from `POST <root>/api/show {"model": id}` (`model_info["<arch>.context_length"]`), fetched in `listModels`
    for ids not cached yet, 3 s timeout, failures ignored (no limit for that model). Override `providers.ollama.maxPromptChars`.
  - DeepSeek: a numeric `context_length` / `context_window` / `max_context_length` field of the `/models` entry if present, else
    1,048,576 tokens (both models) -> 4,194,304 chars. Override `providers.deepseek.maxPromptChars`.
  - `promptTooLong` wording no longer ACP-specific (see Contract C3); the prefix "The prompt is too long for <Name>: " is kept.
- D12 Upstream 400 / 422 on chat: a message that matches the context regex (C4) -> 400 `context_length_exceeded`; DeepSeek's other 400 /
  422 -> 400 `invalid_request` with DeepSeek's text. Base (Gufo/Strata/Llama.cpp/Ollama): only the context-regex case changes (it was a
  503 `upstream_error`); every other non-2xx stays 503 `upstream_error` as today.
- D13 Network failure for DeepSeek: state `error`, message "DeepSeek API is not reachable — check the network and the base URL in
  Settings > DeepSeek.", 503 `provider_unreachable`. Never "start it from the app".
- D14 Settings window: page "DeepSeek" in the existing "Providers" nav group, after Antigravity. Ollama page gains the "Max prompt
  characters" field and a static line "Usage limit: not applicable (Ollama has no quota)."
- D15 Static fallback models: `deepseek-flash` (vision) and `deepseek-v4-pro` (text). Legacy ids are not listed but are accepted (any id
  routes once `/models` failed to list; if `/models` lists them they show).

## Contract (shared by the tasks; write the code to these names)

C1 `src/provider.ts`
- `Provider` gains:
  - `readonly forwardsOutputLimit?: boolean;` — "the provider sends the output limit upstream and reports the real stop and usage; the
    server does not cut its text".
  - `maxPromptCharsFor?(model: string): number | undefined;` — effective per-model limit; wins over `maxPromptChars` in `/v1/models`.
  - `checkPrompt?(messages: Message[], options?: GenerateOptions, model?: string): void;` (third parameter new; ACP ignores it).
  - `usageLimitState?(): UsageLimitError | null | undefined;` — what the provider last learned outside a request (balance probe):
    an error = exhausted now, `null` = known available, `undefined` = unknown.
- `ProviderStatus` gains `balance?: string;` ("110.00 USD"; never a secret).

C2 `src/acp.ts` `AcpLike` gains `forwardsOutputLimit?(model: string): boolean;`. `ProviderRouter` implements it as
`this.resolve(model)?.provider.forwardsOutputLimit === true`.

C3 `src/api.ts` `promptTooLong(displayName, chars, limit, param = "messages")` message becomes:
`The prompt is too long for ${displayName}: ${chars} characters, the limit is ${limit}. The proxy refused it rather than let the model cut or drop part of it. Shorten the prompt or use another model.`
New `contextTooLong(displayName: string, detail: string): ApiError` -> `new ApiError(400, "context_length_exceeded", \`The prompt is too long for ${displayName}: ${detail}\`, "messages")`.

C4 `src/providers/local-openai.ts` exports `CONTEXT_ERROR = /context length|context window|context size|maximum context|exceeds the available context|exceed_context_size|n_ctx|prompt is too long|too many tokens/i`.

C5 `LocalOpenAiProvider` (base), protected surface used by `DeepSeekProvider`:
- fields made `protected`: `baseUrl`, `apiKey`, `logger`, `fetchImpl`, `models`, `listed`, `inflight`; methods `setState`, `headers`.
- `options.maxPromptChars?: number` (absent = auto, 0 = none) and `options.contextLookup?: (model: string, signal: AbortSignal) => Promise<number | undefined>` (Ollama).
- `protected contextTokens(model: string): number | undefined` — default: the cached lookup result for `model`.
- `maxPromptCharsFor(model)`, `checkPrompt(messages, options, model)` (throws `promptTooLong`), `readonly forwardsOutputLimit = true`.
- `protected chatBody(model: string, wire: WireMessage[], options?: GenerateOptions): Record<string, unknown>` — today's body
  (local-openai.ts:227) moved here; DeepSeek overrides to drop `chat_template_kwargs`.
- `protected httpError(status: number, detail: string, response: Response): Error` — default: `CONTEXT_ERROR.test(detail)` ->
  `contextTooLong(displayName, detail)`, else today's `AcpUnavailableError(\`${displayName} answered HTTP ${status}: ${detail}\`, undefined, "upstream_error")`.
- `protected unreachable(cause: unknown): AcpUnavailableError` — default: today's `notRunning` (state `stopped`, `local_server_not_running`).
- Finish reasons: `length` -> `max_tokens`, `content_filter` -> `refusal`, everything else -> `end_turn` (`insufficient_system_resource`
  is logged at warn).

C6 `src/router.ts`
- private `markExhausted(provider: Provider, error: UsageLimitError): number` — the body of today's `track` catch (router.ts:247-254)
  minus the throw; `track` calls it then throws `usageLimitRefusal(...)` as today.
- `refreshOne` (router.ts:195): after `update`, `const known = provider.usageLimitState?.()`: an error -> `markExhausted`; `null` and an
  exhaustion is held -> delete it and call `onExhaustedChange`.
- `checkPrompt` (:221) and `generate` (:269) pass `target.model` as the third argument; `entries()` (:186) uses
  `provider.maxPromptCharsFor?.(model.id) ?? provider.maxPromptChars` per model entry.

C7 Activity and usage: `ActivityEntry.cachedTokens?: number` (activity.ts, beside `reasoningTokens`); server `Trace.cachedTokens`, set
in `traceUsage` (server.ts:54) when `usage.cached > 0`, copied into the entry (server.ts:~508). `UsageCountsView` (shared/ipc.ts:148)
becomes `{ requests; errors; inputTokens; outputTokens; estimated; cachedTokens; reasoningTokens }`. `inputTokens` keeps meaning the
OpenAI prompt total (cached included); `cachedTokens` is the part of it, `reasoningTokens` the part of `outputTokens`.

C8 Settings shapes (settings.ts, shared/ipc.ts)
- `providers.deepseek`: `{ enabled: boolean; baseUrl: string; apiKey?: string; maxConcurrent: number; maxPromptChars?: number }`.
- `providers.ollama` gains `maxPromptChars?: number`.
- `export const DEEPSEEK_DEFAULT_URL = "https://api.deepseek.com"`; `DeepSeekProviderSettingsView`; `SettingsView.providers.deepseek`;
  `SettingsPatchView.providers.deepseek`; `OllamaProviderSettingsView.maxPromptChars?`; `ProviderStatusView.balance?: string`.

C9 Error bodies the client sees (DeepSeek)
| Upstream | Proxy HTTP | `error.code` | Message |
|---|---|---|---|
| no key / 401 / 403 | 503 | `provider_auth_required` | "DeepSeek API key missing or rejected — enter a valid key in Settings > DeepSeek and save." |
| 402 | 429 + `Retry-After` | `usage_limit_exceeded` | router's `usageLimitRefusal` text; provider message "DeepSeek has hit its usage limit: insufficient balance. Top up at platform.deepseek.com." |
| 429 | 429 + `Retry-After` | `rate_limit_exceeded` | "DeepSeek is rate limiting requests (HTTP 429); retry shortly. <detail>" |
| 400 / 422, context text | 400 | `context_length_exceeded` | "The prompt is too long for DeepSeek: <detail>" |
| 400 / 422, other | 400 | `invalid_request` | "DeepSeek rejected the request (HTTP <status>): <detail>" |
| 5xx | 503 | `upstream_error` | "DeepSeek answered HTTP <status>: <detail>" |
| no connection | 503 | `provider_unreachable` | D13 text |
| proxy pre-check | 400 | `context_length_exceeded` | C3 text |

`<detail>`: `error.message` of a JSON body, `error` if it is a string, else the first 300 characters of the body (today's parsing,
local-openai.ts:230-232).

## Files and modules to touch

| File | Change | Task |
|---|---|---|
| `src/provider.ts:19,26,47-50,205-247` | C1 fields; `GenerateOptions.maxOutputTokens` doc line 19 ("forwarded upstream by providers with `forwardsOutputLimit`") | T1 |
| `src/acp.ts:19-50` | C2 | T1 |
| `src/api.ts:587-590` | C3 wording + `contextTooLong` | T1 |
| `src/router.ts:186,195-201,217-222,241-256,269` | C2 method, C6 | T1 |
| `src/server.ts:26,54-60,155-186,~508` | `runGeneration` honours `bridge.forwardsOutputLimit?.(model)`; `cachedTokens` trace | T1 |
| `src/activity.ts:24-31` | `cachedTokens?` | T1 |
| `src/usage-store.ts:33-41,71-83` | `zero`, `addInto`, `sanitize`, `add` with `cachedTokens` / `reasoningTokens` | T2 |
| `src/shared/ipc.ts:9-28,54-58,120,148` | `ProviderStatusView.balance`, `UsageCountsView`, DeepSeek and Ollama settings views | T2 |
| `src/renderer/usage-view.ts:15,135,142` | `KNOWN_SERIES` + `ollama`, `deepseek`; cell tooltips | T2 |
| `src/renderer/settings.css:9,25` | `--series-ollama`, `--series-deepseek` light and dark | T2 |
| `src/renderer/usage.css:2-8,20-26` | `.series-ollama`, `.series-deepseek` (both blocks) | T2 |
| `src/providers/local-openai.ts` (whole class, `:227-253`, `:279`, `:417-422`) | C4, C5, D8, Ollama `contextLookup` + `maxPromptChars` in `ollamaRegistration` | T3 |
| `src/providers/deepseek.ts` (new) | `DeepSeekProvider`, `deepseekRegistration`, `deepseekBaseUrl`, `DEEPSEEK_MODELS` | T4 |
| `src/settings.ts:28-38,418,470,562-600` | deepseek schema, ollama `maxPromptChars`, `mapSecrets`, `PROXY_DEEPSEEK_API_KEY` | T4 |
| `src/controller.ts:17,91` | registry + `deepseekRegistration` (appended after ollama) | T4 |
| `src/electron/main.ts:13,241` | registry + `deepseekRegistration`; `LOCAL_PROVIDER_IDS` (:117) NOT changed | T4 |
| `src/renderer/settings-fields.ts:1,51-54` | `Scope` + `"deepseek"`; fields (T5 list) | T5 |
| `src/renderer/settings.html:31-39,545-570` | nav item, `view-deepseek` section, Ollama max-prompt field and N/A line | T5 |
| `src/renderer/settings.ts:54,67,207-219,549,558,788-801` | `views`, `dirty`, `renderDeepSeek`, nav dot, wire | T5 |
| `tests/local-openai.test.ts`, `tests/usage-store.test.ts`, `tests/settings.test.ts`, `tests/controller.test.ts:32,61` | see Acceptance | T2-T4 |
| `README.md`, `ROADMAP.md`, `changelog.md` (this folder) | docs | T6 |

## Tasks for workers

Order: T1, T2 and T3 run in parallel (disjoint files, they meet at the contract). T4 starts after T3 (it extends T3's protected surface).
T5 after T2 (it uses the ipc types). T6 last. Every task ends with `fnm exec --using default npm run typecheck` and the test files it owns
passing (`fnm exec --using default npx vitest run <files>`); the final run is the whole `npm test`.

### T1. Core contracts: provider, router, server, api, activity
Inputs: C1, C2, C3, C6, C7, D10, D11.
Outputs:
- `provider.ts`, `acp.ts`: C1, C2 exactly.
- `api.ts`: C3 (message and `contextTooLong`). Update the doc comment of `provider.ts:98` ("the agent silently drops the rest" stays true
  for ACP; add "local providers: the model's context").
- `router.ts`: C6 and `forwardsOutputLimit(model)`.
- `server.ts` `runGeneration`: first line becomes `const cut = limit !== undefined && bridge.forwardsOutputLimit?.(model) !== true ? limit : undefined;`
  and every use of `limit` inside uses `cut` (budget, the `onText` condition, the short path). `traceUsage` sets `trace.cachedTokens`;
  the activity entry copies it (beside `reasoningTokens`, server.ts:508).
- `activity.ts`: `cachedTokens?: number` with doc "Of inputTokens, the part read from the provider's prompt cache".
Contract with others: T3/T4 implement the provider side of C1; T2 reads `entry.cachedTokens` / `entry.reasoningTokens`.
Tests owned: `tests/proxy.test.ts` must still pass unchanged (ACP cut-off kept); `tests/prompt-limit.test.ts` must pass unchanged (prefix
kept); `tests/router.test.ts` unchanged. No new tests here (proved in T3/T4 through the real providers).

### T2. Usage store, ipc types, Usage page colours
Inputs: C7, C8 (ipc part), D9.
Outputs:
- `usage-store.ts`: `zero()` adds `cachedTokens: 0, reasoningTokens: 0`; `addInto` sums them; `sanitize` reads them with `count()`
  (absent -> 0); `add` takes `count(entry.cachedTokens)` and `count(entry.reasoningTokens)`. `UsageFile.version` stays 1.
- `shared/ipc.ts`: `UsageCountsView` (C7), `ProviderStatusView.balance?: string`, `DeepSeekProviderSettingsView`
  `{ enabled: boolean; baseUrl: string; apiKey?: string; maxConcurrent?: number; maxPromptChars?: number }`, `SettingsView.providers.deepseek`,
  `SettingsPatchView.providers.deepseek` (same mapped form as ollama, ipc.ts:120), `OllamaProviderSettingsView.maxPromptChars?: number`.
- `usage-view.ts:15`: `KNOWN_SERIES = ["codex", "claude", "antigravity", "gufo", "strata", "llama", "ollama", "deepseek"]`. In
  `renderTable` (:135, :142) the input cell gets `title = "of which N cached"` when `cachedTokens > 0`, the output cell
  `title = "of which N thinking"` when `reasoningTokens > 0` (`full.format`). No new column.
- `settings.css:9` light `--series-ollama: #4a7a2a; --series-deepseek: #3a5fa8;` and `:25` dark `--series-ollama: #8cc46a; --series-deepseek: #86a6e6;`
  (worker may adjust for contrast; must differ from the other series). `usage.css` both blocks: `.series-ollama`, `.series-deepseek`.
Contract: T5 uses `DeepSeekProviderSettingsView` and `ProviderStatusView.balance`.
Tests owned: `tests/usage-store.test.ts` — extend "counts requests, errors, tokens and estimates..." (:21) with one entry carrying
`cachedTokens: 3, reasoningTokens: 2` and assert the sums; extend "persists to usage.json..." (:56) so a file written without the two
fields loads them as 0. Update exact `toEqual` count objects in that file for the two new zero fields.

### T3. Base class hooks, prompt check, usage parsing, Ollama context (`src/providers/local-openai.ts`)
Inputs: C4, C5, D8, D10, D11, D12.
Outputs:
- C5 surface. `generate` builds the body with `this.chatBody(...)`, maps `!response.ok` through `this.httpError(status, detail, response)`
  (keep the detail parsing of :230-232), replaces `this.notRunning(...)` in the chat, list and image paths with `this.unreachable(...)`
  (default is today's behaviour, so Gufo/Strata/Llama.cpp/Ollama keep `local_server_not_running`).
- Usage parse (:248-251): `cached = prompt_tokens_details?.cached_tokens ?? prompt_cache_hit_tokens` (then the existing clamp);
  add `prompt_cache_hit_tokens?: number` to the chunk type.
- Finish reasons per C5.
- `checkPrompt(messages, options, model)`: `const limit = model === undefined ? undefined : this.maxPromptCharsFor(model); if (!limit) return;`
  chars = `(options?.instructions?.length ?? 0) + Σ messageText(message).length`; over -> `throw promptTooLong(this.displayName, chars, limit)`.
  `maxPromptCharsFor(model)`: `options.maxPromptChars === 0 -> undefined`; `> 0 -> it`; else `contextTokens(model) * CHARS_PER_TOKEN` or undefined.
- `contextLookup`: in `listModels` (no-profile branch, after the list is read) call it for each listed id without a cached value, all in
  parallel, each with its own 3 s `AbortController`; store numbers > 0 in `private contexts = new Map<string, number>()`; never fail the
  listing.
- `export function ollamaContextLookup(rootUrl: string, fetchImpl: typeof fetch)`: `POST ${rootUrl}/api/show` with `{"model": id}`,
  returns the first numeric value of `model_info` whose key ends with `.context_length`, else undefined. `rootUrl` = `ollamaBaseUrl(...)`
  without the `/v1`.
- `ollamaRegistration.create` passes `contextLookup: ollamaContextLookup(root, globalThis.fetch)` and
  `maxPromptChars` when `providerSettings.maxPromptChars` is a number.
Contract: T4 overrides `chatBody`, `httpError`, `unreachable`, `contextTokens`, `listModels`, `status`, and uses `setState`, `headers`,
`fetchImpl`, `baseUrl`, `apiKey`, `models`, `listed`, `inflight`.
Tests owned (`tests/local-openai.test.ts`, extend, see AC2, AC3, AC6).

### T4. DeepSeek provider, settings, registration
Inputs: C1, C5, C8, C9, D2-D7, D11, D13, D15; T3 merged.
Outputs:
- `src/providers/deepseek.ts`:
  - `export const DEEPSEEK_MODELS: ModelInfo[] = [{ id: "deepseek-flash", name: "DeepSeek V4.1 Flash", vision: true }, { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", vision: false }]`;
    `export const DEEPSEEK_CONTEXT_TOKENS = 1_048_576`.
  - `export function deepseekBaseUrl(value: string): string` — trim, strip trailing `/`, then a trailing `/v1`, then `/` again.
  - `class DeepSeekProvider extends LocalOpenAiProvider` (id `"deepseek"`, displayName `"DeepSeek"`, ownedBy `"deepseek"`;
    `LocalProviderId` widened to `LocalServerId | "ollama" | "deepseek"` in local-openai.ts — T4 makes that one-line edit after T3).
  - ctor: no key -> `setState("needs_login", AUTH_MESSAGE)`.
  - `generate`: no key -> `throw new ProviderAuthRequiredError(AUTH_MESSAGE)` before any fetch; else `super.generate`.
  - `chatBody`: `super.chatBody` minus `chat_template_kwargs`.
  - `httpError`: C9 table (401/403 also `setState("needs_login", AUTH_MESSAGE)`; 429 reads `Retry-After` seconds from the response
    header, default 10).
  - `unreachable`: D13 (state `error`, code `provider_unreachable`).
  - `listModels({ force })`: no key -> return `DEEPSEEK_MODELS` (no fetch). Within 60 s of the last successful listing and not `force`
    -> cached models. Else `Promise.all([GET /models, GET /user/balance])` with the Bearer header and 5 s timeout each:
    `/models` 200 -> `models` = its ids, `vision` from `DEEPSEEK_MODELS` by id, context per D11 into the context map; 401/403 -> needs_login
    + throw `ProviderAuthRequiredError`; network / 5xx -> return `DEEPSEEK_MODELS`, state per D13 / unchanged. Balance 200 ->
    `this.balance = balance_infos.map(b => \`${b.total_balance} ${b.currency}\`).join(" + ")`, `this.availability = is_available === false
    ? new UsageLimitError("DeepSeek has hit its usage limit: insufficient balance. Top up at platform.deepseek.com.", "balance") : null`.
    A successful `/models` sets state `ready`.
  - `usageLimitState()` returns `this.availability` (initially `undefined`); a successful `generate` sets it to `null`.
  - `status()`: `super.status()` plus `balance` when known.
  - `deepseekRegistration: ProviderRegistration = { id: "deepseek", displayName: "DeepSeek", create: ({ providerSettings, ctx }) => new DeepSeekProvider({ baseUrl: deepseekBaseUrl(...), apiKey, maxPromptChars, logger: ctx.logger.child("deepseek") }) }`
    (Node `globalThis.fetch`, as Ollama).
- `src/settings.ts`: `DEEPSEEK_DEFAULT_URL`; `deepseekProviderSchema` per C8/D2 (URL refine message: "must be an https:// URL (http:// only for localhost)");
  `providers.deepseek: deepseekProviderSchema` after `ollama`; ollama schema gains `maxPromptChars: z.number().int().min(0).optional()`;
  `mapSecrets` holders + `[copy.providers.deepseek, "apiKey"]`; `resolveConfig`:
  `apply("providers.deepseek.apiKey", env.PROXY_DEEPSEEK_API_KEY || undefined, (v) => { providers.deepseek.apiKey = v; });`.
- `controller.ts:17,91` and `electron/main.ts:13,241`: append `deepseekRegistration` after `ollamaRegistration`. `LOCAL_PROVIDER_IDS` unchanged.
Tests owned: `tests/local-openai.test.ts` (new `describe("DeepSeek")`, AC1, AC4, AC5, AC7), `tests/settings.test.ts` (AC8),
`tests/controller.test.ts` (:32 add `deepseek: { enabled: false }` is not needed since the default is false; :61 append `["deepseek", "disabled"]`).

### T5. Settings window
Inputs: C8, D14; T2 merged (types).
Outputs:
- `settings-fields.ts`: `Scope` + `"deepseek"`; fields `providers.deepseek.enabled` (bool), `.baseUrl` (text), `.apiKey` (text, optional),
  `.maxConcurrent` (number, optional), `.maxPromptChars` (number, optional); `providers.ollama.maxPromptChars` (number, optional, scope ollama).
- `settings.html`: nav item `<button type="button" class="nav-item" data-view="deepseek">…DeepSeek…</button>` after Antigravity (:34).
  Section `view-deepseek` / `card-deepseek` modelled on the Ollama section (:545-570): head "DeepSeek", sub "The official DeepSeek API,
  paid per token. Requests go to api.deepseek.com with your key."; badge; enabled switch; card "API": Base URL (placeholder
  `https://api.deepseek.com`), API key (password + `deepseek-key-show` button, "Encrypted on this PC; sent as a Bearer token"), Max concurrent
  requests ("empty = 4"), Max prompt characters ("empty = the model's context × 4 = 4,194,304; 0 = no limit"); `data-role="error"`,
  `data-role="balance"` line, `data-role="usage-limit"` line; Models card with Refresh and the list; Save.
  Ollama section: add the Max prompt characters field ("empty = the model's context length × 4, read from Ollama; 0 = no limit") and a
  muted `<p class="note">Usage limit: not applicable (Ollama has no quota).</p>`.
- `settings.ts`: `views` + `"deepseek"` (after `"antigravity"`), `dirty.deepseek = false`, `renderDeepSeek(current)` = `renderOllama`'s
  body for id `deepseek` plus `usageLimitLine(status?.exhaustedUntil, Date.now())` into `usage-limit` (as :178-180) and
  `balance` line `Balance: ${status.balance}` (hidden when absent); empty list text "Enter the API key, enable and save to list DeepSeek's
  models."; called next to `renderOllama` (:549); `setNavDot("deepseek", …)` (:558); `wire()` block copied from :788-801 for save,
  refresh and `deepseek-key-show`.
Tests owned: none new; `tests/settings-fields.test.ts` and `tests/desktop-views.test.ts` must still pass.

### T6. Docs
- README: a "DeepSeek" section (settings keys, env `PROXY_DEEPSEEK_API_KEY`, model ids, C9 table, balance behaviour); prompt-limit section
  says local providers derive the limit from the model context (Ollama `/api/show`, DeepSeek 1,048,576 tokens) ×4; usage section mentions
  cached and thinking tokens and that providers with `forwardsOutputLimit` report the upstream stop and usage.
- ROADMAP: one checked line "(AAP-70) DeepSeek provider; token logic (usage, output limit, prompt limit, balance) for Ollama and DeepSeek".
- `changelog.md` in this folder with the DONE / NOT DONE / UNTESTED list.

## Acceptance criteria and the tests that prove them

Tests are few and extend existing files (test-discipline). Fake upstreams are `node:http` servers as in `tests/local-openai.test.ts`.

| # | Criterion | Proof |
|---|---|---|
| AC1 | DeepSeek non-stream and stream through the proxy: `deepseek/deepseek-flash` listed; Bearer key sent; body has `max_tokens`, `reasoning_effort`, no `chat_template_kwargs`; `reasoning_content` comes back as reasoning; usage `prompt_tokens`, `completion_tokens`, `prompt_tokens_details.cached_tokens` taken from `prompt_cache_hit_tokens`, `completion_tokens_details.reasoning_tokens` equal the upstream numbers; the activity entry has `cachedTokens`, `reasoningTokens`, `estimated` unset. | `local-openai.test.ts` `describe("DeepSeek")` it 1 "serves deepseek/ models with the upstream usage, cache hits and reasoning" (OpenAI SDK, one non-stream and one stream with `include_usage`). |
| AC2 | Output limit for a forwarding provider: upstream streams more than `max_tokens * 4` chars then `finish_reason: "length"` with usage; the client gets the whole upstream text, `finish_reason: "length"`, the upstream `completion_tokens`. ACP keeps the cut. | `local-openai.test.ts` new it "passes a forwarded output limit through: upstream text, length stop and usage win" (Ollama-style provider, chat stream). ACP: existing `proxy.test.ts` "cuts a chat stream at the limit..." (:166) still green. |
| AC3 | Ollama prompt limit: `/api/show` `context_length: 64` -> `/v1/models` `max_prompt_chars: 256` for that model; a 300-char prompt -> 400 `context_length_exceeded`, message starts "The prompt is too long for Ollama: ", upstream chat never called; `maxPromptChars: 0` turns it off. | Extend the Ollama test at `local-openai.test.ts:194` (fake `/api/show`). |
| AC4 | DeepSeek 402 -> 429 `usage_limit_exceeded` with `Retry-After`; `/healthz providers.deepseek.exhausted_until` set; the next request is refused without an upstream call. 429 -> 429 `rate_limit_exceeded`, not exhausted (the next request reaches upstream). | `describe("DeepSeek")` it 2 "maps 402 to the usage-limit 429 and 429 to a transient rate limit". |
| AC5 | Auth: no key -> state `needs_login` with the D5 message, request 503 `provider_auth_required`, zero upstream calls; upstream 401 -> same code and state. Upstream 400 with "maximum context length" text -> 400 `context_length_exceeded`. | `describe("DeepSeek")` it 3 "needs a key, maps 401 to provider_auth_required and a context 400 to context_length_exceeded". |
| AC6 | Proxy pre-check for DeepSeek: `providers.deepseek.maxPromptChars: 100` and a 200-char prompt -> 400 before any upstream chat call, also for `stream: true` (real HTTP 400, not an SSE error). Default limit 4,194,304 is listed in `/v1/models` `max_prompt_chars`. | Folded into it 3 (two more requests, same fake). |
| AC7 | Balance: `/user/balance` `is_available: false` -> after `router.refresh("deepseek")` the provider is exhausted (`exhaustedProviders()` has `deepseek`), status `balance` "0.00 USD"; then `is_available: true` + refresh clears it. | `describe("DeepSeek")` it 4 "reads the balance on refresh: unavailable marks exhausted, available clears it". |
| AC8 | Settings: `providers.deepseek` defaults `{ enabled: false, baseUrl: "https://api.deepseek.com", maxConcurrent: 4 }`; `http://example.com` refused, `http://127.0.0.1:9` accepted; `deepseekBaseUrl("https://api.deepseek.com/v1/")` = `https://api.deepseek.com`; the key is encoded by the codec on save; `PROXY_DEEPSEEK_API_KEY` overrides. | `settings.test.ts`: extend the defaults test (:18) and the codec test (:199). |
| AC9 | Usage store keeps `cachedTokens` / `reasoningTokens`, old files load. | `usage-store.test.ts` extensions (T2). |
| AC10 | Registry order and default state: controller status lists `deepseek` last, `disabled`. | `controller.test.ts:61`. |
| AC11 | Type safety and the whole suite. | `fnm exec --using default npm run typecheck`; `fnm exec --using default npm test`. |
| AC12 | Settings window: DeepSeek page saves enabled / URL / key / max concurrent / max prompt chars; shows badge, balance, usage-limit line, models, Refresh; Ollama page shows its new field and the N/A line; Usage page draws Ollama and DeepSeek in their own colours. | Manual in the app (`npm run app:dev`), screenshot; otherwise UNTESTED. |
| AC13 | Live behaviour against the real DeepSeek API and local Ollama. | Live check below. |

## Live check script (second headless instance on 8797; 8787 is not touched)

Spend: at most 6 DeepSeek chat calls, each `max_tokens` <= 64 (well under one cent). `/models` and `/user/balance` are free.
Never send a large prompt to DeepSeek; prompt-too-long is proved with fakes (AC3, AC5, AC6) and the Ollama step 9.

0. The user puts the key into `C:/projects/Personal/api-acp-proxy/.claude/temp/aap70-live/key.txt` (gitignored `.claude/temp/`). The
   worker never prints, logs or commits it; the file is deleted at step 12.
1. Write `.claude/temp/aap70-live/settings.json` (no key in it):
   `{"server":{"port":8797},"providers":{"codex":{"enabled":false},"gufo":{"enabled":false},"strata":{"enabled":false},"llama":{"enabled":false},"ollama":{"enabled":true},"deepseek":{"enabled":true}}}`
2. Start (Bash, background):
   `cd C:/projects/Personal/api-acp-proxy && PROXY_SETTINGS_FILE=.claude/temp/aap70-live/settings.json PROXY_DEEPSEEK_API_KEY="$(cat .claude/temp/aap70-live/key.txt)" fnm exec --using default npx tsx src/index.ts`
   Confirm `GET http://127.0.0.1:8787/healthz` is untouched (still answers as before) and `GET http://127.0.0.1:8797/healthz` answers.
3. `GET /v1/models` (models + balance probe): expect `deepseek/deepseek-flash` and `deepseek/deepseek-v4-pro` with `max_prompt_chars`
   4194304; Ollama models with `max_prompt_chars` = context × 4. Record the DeepSeek `/models` entry shape and the balance line
   (`GET /healthz` or the logs) in the changelog — amounts only, never the key.
4. DeepSeek call 1, non-stream: `{"model":"deepseek/deepseek-flash","messages":[{"role":"user","content":"Reply with OK."}],"max_tokens":16,"reasoning_effort":"none"}`
   -> 200, `usage.prompt_tokens` > 0, `completion_tokens` <= 16, not estimated (activity entry `estimated` unset). If `"none"` is refused,
   note the error body and use `"low"`.
5. DeepSeek call 2, stream with `stream_options.include_usage: true`, same prompt -> SSE text, final usage chunk with real numbers and
   `prompt_tokens_details.cached_tokens` present.
6. DeepSeek call 3, output limit: `"Count from 1 to 200, comma separated."`, `max_tokens: 8`, `reasoning_effort: "none"` -> `finish_reason`
   `"length"`, `completion_tokens` = 8 (upstream number, not chars/4), text longer than nothing.
7. DeepSeek call 4, reasoning: `"What is 17*23?"`, `max_tokens: 64`, `reasoning_effort: "low"`, stream -> `reasoning_content` deltas,
   `completion_tokens_details.reasoning_tokens` > 0 in the usage chunk (a `length` stop is fine).
8. DeepSeek call 5, the second model: `deepseek/deepseek-v4-pro`, call 1's body -> 200 with usage. (Call 6 is a spare for one retry.)
9. Ollama: one chat with `max_tokens: 8` to a listed model -> `finish_reason: "length"` and real usage; then stop the instance, set
   `"ollama":{"enabled":true,"maxPromptChars":100}` in the settings file, restart, send a 200-char prompt -> 400 `context_length_exceeded`
   "The prompt is too long for Ollama: 200 characters, the limit is 100. …" without Ollama seeing it (the instance log has no upstream call).
10. Wrong key (free): restart with `PROXY_DEEPSEEK_API_KEY=sk-invalid` -> `/v1/models` still answers; a chat to `deepseek/deepseek-flash`
    -> 503 `provider_auth_required` with the D5 message; record DeepSeek's real 401 body shape in the changelog.
11. `usage.json` beside the settings file (wait 3 s for the flush): `deepseek` and `ollama` entries with `cachedTokens` / `reasoningTokens`
    fields; `inputTokens` / `outputTokens` equal the sums of the calls above.
12. Stop the instance; delete `key.txt`, the settings file and its `usage.json` / `models-cache.json`; `git status` shows no file with the key.
    Not testable live (stated as UNTESTED unless it happens): 402 insufficient balance, 429 rate limit, `is_available: false`.

## Risks

- DeepSeek's `/models` may carry no context field: then the static 1,048,576 applies (fine). Its error body shape is undocumented: the
  detail parser already falls back to raw text.
- Ollama's real context is its `num_ctx` (often far below the model's `context_length`), and Ollama truncates silently beyond it. The
  auto limit from `/api/show` does not catch that; the setting does. Documented in README and on the Ollama page note.
- `reasoning_effort: "none"` semantics are from the docs only; step 4 records the live answer.
- Changing `checkPrompt` to take `model` touches every `Provider` implementer only by an optional parameter; ACP ignores it.
- The local-openai family losing the server-side cut-off: an upstream that ignores `max_tokens` would now overrun. All five targets honour
  it (llama-server, Ollama, DeepSeek); accepted.

## Open questions for the user (defaults are in Decisions)

- Q1 Default `enabled: false` for DeepSeek (D2) — or on as soon as a key is saved?
- Q2 Ollama auto limit from `context_length` (D11) can be larger than Ollama's actual `num_ctx`; is "set `maxPromptChars` yourself" acceptable,
  or should the proxy also send `options.num_ctx` (Ollama-native, not in the `/v1` API) — that would be a later ticket.
