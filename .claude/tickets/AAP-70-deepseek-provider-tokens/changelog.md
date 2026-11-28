# Changelog: AAP-70

## 2026-11-28 - AAP-70: DeepSeek provider and token logic for Ollama and DeepSeek

DeepSeek is a real provider now (`deepseek/<id>`, key, models, balance, typed errors, settings page). For the whole local-openai family the output limit is forwarded upstream (no proxy cut), cached and thinking tokens are counted, and Ollama / DeepSeek have a prompt limit derived from the model context.

### Repo api-acp-proxy (branch `AAP-70_deepseek-provider-tokens`, base `master` 6a4e061)

- `src/provider.ts`: `Provider.forwardsOutputLimit`, `maxPromptCharsFor`, `checkPrompt(messages, options, model)`, `usageLimitState()`; `ProviderStatus.balance`.
- `src/acp.ts`: `AcpLike.forwardsOutputLimit(model)`.
- `src/api.ts`: `promptTooLong` wording no longer ACP-specific (prefix kept); new `contextTooLong` (400 `context_length_exceeded`).
- `src/router.ts`: `markExhausted` split out of `track`; `refreshOne` applies a provider's `usageLimitState` (error marks exhausted, `null` clears); `checkPrompt`/`generate` pass the model; `/v1/models` `max_prompt_chars` per model; `forwardsOutputLimit(model)`.
- `src/server.ts`: `runGeneration` does not cut text for providers that forward the limit (upstream stop and usage win); `cachedTokens` traced into the activity entry.
- `src/activity.ts`: `ActivityEntry.cachedTokens`.
- `src/providers/local-openai.ts`: `CONTEXT_ERROR`; protected hooks `chatBody`, `httpError` (context text -> 400 `context_length_exceeded`, else 503 `upstream_error`), `unreachable`, `contextTokens`; `forwardsOutputLimit = true`; `maxPromptCharsFor` / `checkPrompt`; `prompt_cache_hit_tokens` fallback for cached tokens; finish reasons `length` / `content_filter` / other (warn on `insufficient_system_resource`); per-model context lookup in `listModels` (3 s, failures ignored); `ollamaContextLookup` (`POST /api/show`); Ollama registration passes `contextLookup` and `maxPromptChars`; `LocalProviderId` includes `deepseek`.
- `src/providers/deepseek.ts` (new): `DeepSeekProvider` (needs_login without key and no network call; 401/403 -> 503 `provider_auth_required`; 402 -> usage limit; 429 -> transient 429 `rate_limit_exceeded` with `Retry-After`; 400/422 -> `context_length_exceeded` or `invalid_request`; network -> 503 `provider_unreachable`; drops `chat_template_kwargs`; `/models` + `/user/balance` together, cached 60 s unless forced; balance line and availability), `DEEPSEEK_MODELS`, `DEEPSEEK_CONTEXT_TOKENS`, `deepseekBaseUrl`, `deepseekRegistration`.
- `src/settings.ts`: `providers.deepseek` schema (`enabled` false, `https://api.deepseek.com`, https only except localhost, `maxConcurrent` 4, `apiKey`, `maxPromptChars`), `providers.ollama.maxPromptChars`, key encrypted through `mapSecrets`, env `PROXY_DEEPSEEK_API_KEY`.
- `src/controller.ts`, `src/electron/main.ts`: `deepseekRegistration` appended after Ollama.
- `src/usage-store.ts`: `cachedTokens` / `reasoningTokens` per provider/day; old files load them as 0; still `version: 1`.
- `src/shared/ipc.ts`: `UsageCountsView` new fields, `ProviderStatusView.balance`, DeepSeek settings views, Ollama `maxPromptChars`.
- `src/renderer/usage-view.ts`, `settings.css`, `usage.css`: Ollama and DeepSeek series colours; input / output cell tooltips "of which N cached" / "of which N thinking".
- `src/renderer/settings-fields.ts`, `settings.html`, `settings.ts`: DeepSeek page (Providers group, after Antigravity) with enabled, base URL, key (show button), max concurrent, max prompt chars, badge, error / balance / usage-limit lines, models with Refresh, Save; Ollama page gets Max prompt characters and "Usage limit: not applicable (Ollama has no quota)."
- Tests: `tests/local-openai.test.ts` (forwarded output limit; Ollama `/api/show` prompt limit; `describe("DeepSeek")` with 4 its for AC1, AC4, AC5+AC6, AC7), `tests/settings.test.ts` (defaults, URL rule, `deepseekBaseUrl`, codec, env override), `tests/usage-store.test.ts` (new sums, old file), `tests/controller.test.ts` (`deepseek` last, disabled).
- Docs: `README.md` (DeepSeek section with the error table and balance, env var, prompt-limit and token-limit notes, Usage tooltips), `ROADMAP.md` (checked AAP-70 line).

### Deviations

- `server.ts`: the parameter is `requestedLimit` and the filtered value keeps the name `limit` (plan: `cut`); same behaviour.
- `markExhausted` reads the clock itself; `track` takes its own `now` for the refusal text.
- A balance probe that keeps saying unavailable re-marks the provider on each refresh (extends the cooldown, logs again); C6 as written.
- `DeepSeekProvider` starts with `models = DEEPSEEK_MODELS` so the card and `acceptsImages` work before the first listing.
- D15 vs T4: on a `/models` network or 5xx failure `listModels` returns the static (or last) models as T4 says; the router then knows that list, so an unlisted legacy id (for example `deepseek-v4-flash`) does not route until a successful listing. D15 says any id routes once `/models` failed. Left as T4 for the director/user to decide.
- A 402 on chat does not set the probe availability; the router's own exhaustion handles it.
- The `PROXY_DEEPSEEK_API_KEY` check sits inside the existing codec test (no new `it`).

### Verification

- `npm run typecheck` (three tsc projects): clean.
- `npm test`: 48 files passed, 1 skipped; 549 tests passed, 1 skipped, 0 failed.
- Not run: AC12 settings window in the app (UNTESTED); AC13 live check against DeepSeek and Ollama (left to the director's checker, per brief).

### Follow-ups

- Decide the D15 / T4 legacy-id behaviour above.
- Open questions Q1 (DeepSeek enabled by default once a key is saved) and Q2 (Ollama `num_ctx`) from the plan.

### Commit status

Committed on `AAP-70_deepseek-provider-tokens` (not merged, not pushed).


## Polish round 1

- A rejected key on `GET /models` (401/403) sets `needs_login` and returns the static models instead of throwing; `/v1/models` keeps listing them and a chat answers 503 `provider_auth_required` (`src/providers/deepseek.ts`).
- A chat 402 also sets the probe availability to that `UsageLimitError`; `refreshOne` marks exhaustion only when the provider is not already exhausted (no extension, no repeated warn) and clears only on `null` (`src/router.ts`). The mark clears after a successful chat or a balance probe with `is_available: true` made after the 402.
- Legacy ids `deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` always route: new optional `Provider.acceptsModel`, consulted by `ProviderRouter.resolve`; not listed in `/v1/models`. README DeepSeek section updated. Other unlisted ids route only while DeepSeek has no known list (before this round: with the static list too, which is now narrowed to the two legacy ids).
- SSE error events use the same body as the JSON path (`errorBody` in `src/server.ts`), so `AcpUnavailableError` keeps its code (`provider_auth_required`, `provider_unreachable`, `upstream_error`, `local_server_not_running`) for all providers; stream HTTP status stays 200.
- Tests extended in `tests/local-openai.test.ts` (DeepSeek auth test and 402/429 test); no new `it`.
- Verification: typecheck clean; `npm test` 48 files passed, 1 skipped; 549 tests passed, 1 skipped.
- Polish round 2: legacy DeepSeek id test now lists models first so it proves the acceptsModel hook (503 for deepseek-v4-flash, 404 model_not_found for an unknown id); verified it fails with the hook removed.
