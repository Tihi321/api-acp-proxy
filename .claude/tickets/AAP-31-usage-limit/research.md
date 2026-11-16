# AAP-31 usage-limit: research

## Question
When a subscription provider (seen: Codex) hits its usage limit, the proxy only passes the error through. Where are provider errors handled, can a usage-limit error be told from a transient one, how could the proxy mark a provider "exhausted until <time>" (fast typed 429 + retry-after, visible in /v1/models or a status endpoint), and how could creative-hub `scripts\hub.ps1 status` show it?

## Answer
- Ticket ids: proxy style is `AAP-NN_<what>` branches and `.claude/tickets/AAP-NN-<what>/`. Highest is AAP-30 (branch AAP-30_prompt-size-limit, merged cd007bf); no AAP-31 branch exists (`git branch -a | grep AAP-31` is empty). Next free: **AAP-31**. Hub: highest is HUB-34 (`creative-hub/.claude/tickets/HUB-34-http-health`), next **HUB-35**.
- Root cause (confirmed): no code recognises a usage limit. A failed turn goes to `src/acp-provider.ts:833-838`: `descriptor.mapError` (Codex has none; only Claude `src/providers/claude.ts:175` and Antigravity `src/providers/antigravity.ts:223` define one, neither for limits), then the generic `AcpUnavailableError("The Codex ACP backend failed to process the request.")`, answered as **503 `backend_unavailable`** (`src/server.ts:417`), same as any transient failure. Every later request starts a new agent turn and fails again (~2.4 s each) until the limit lifts.
- A usage limit CAN be told apart (confirmed for Codex). Codex's own session log records `"error":{"message":"You've hit your usage limit. ... or try again at Nov 29th, 2026 11:07 AM.","codex_error_info":"usage_limit_exceeded"}` (`%APPDATA%\api-acp-proxy\codex-home\archived_sessions\rollout-2026-11-15T14-33-08-*.jsonl`, line 15). The adapter maps `usageLimitExceeded` to `quota_exhausted` and `rateLimitExceeded` to `rate_limited` (`node_modules/@agentclientprotocol/codex-acp/dist/index.js:35513-35516`). So there is a stable code plus a human reset time.
- Fix shape: per-provider "exhausted until" state in the proxy (set by a `mapError` match, cleared at the time or on success), checked in `Router.generate` before the limiter, answering 429 `usage_limit_exceeded` with `Retry-After`; shown in `/healthz` and `/v1/models`; hub.ps1 reads `/healthz`.

## Path through the code
Confirmed by reading unless marked.
1. `src/server.ts:407-410` routes `/v1/models`, chat, images, responses. The `/v1/models` handler (`:407`) returns only `id, object, created, owned_by, max_prompt_chars`.
2. Handlers call `Router.generate` (`src/router.ts:176`): resolve model, `checkPrompt` (AAP-30, `:179`), `limiter.acquire`, `provider.generate`. Insert point for the fast refusal: right after `checkPrompt`, before the limiter, so nothing queues for an exhausted provider.
3. `AcpProvider.generate` (`src/acp-provider.ts` catch at `:828-839`; the tool-call path repeats it at `:1085-1089`): aborted -> cancelled; `descriptor.mapError?.(error, model)` (`:835`, interface `src/provider.ts:147`); `ApiError`/`AcpUnavailableError` pass; anything else -> generic `AcpUnavailableError`.
4. Error output: `ApiError` -> `errorEnvelope` (`src/api.ts:121-124`), which already types 429 as `rate_limit_error` (used by `provider_queue_full`, `src/limiter.ts:33`). `AcpUnavailableError` -> 503 with `Retry-After` when `retryAfterSeconds` is set (`src/server.ts:417`, `src/provider.ts:23-25`; precedent: Claude `provider_busy`). Streaming errors use `writeSse(errorEnvelope(...))` (`src/server.ts:203, 322`); `errorEnvelope` turns a non-ApiError into `internal_error` (`src/api.ts:123`), so the typed error should be an `ApiError(429, ...)` to survive SSE (inferred; verify in a test).
5. `errorCode()` (`src/server.ts:26-29`) feeds the Recent requests log.
6. Related existing pieces: `/healthz` per-provider block `healthProviders` (`src/server.ts:376-385`: active, queued, max_concurrent, max_queue, auth_method); plan limits for Codex/Claude via a `/status` probe (`src/plan-limits.ts`, `parseCodexStatus` already extracts `resetText`); `RateLimitHintView` (`src/shared/ipc.ts:112`) set from Claude's `_claude/rateLimit` meta at `src/acp-provider.ts:380-383` (has `status: "rejected"` and `resetsAt`): Claude already gives a structured signal, shown only in the desktop UI and never used to refuse requests.
7. NOT confirmed: the exact shape in which the Codex adapter hands the failure to the proxy (JSON-RPC error from `session/prompt`, or a typed session-failure `session/update`, adapter `index.js:35640-35730`). `proxy.log` has nothing for 2026-11-15 (debug lines only up to 11-13). The run log says consumers got text containing "try again at", while the generic 503 text would not, so the message reaches them somewhere (see open question 1).

## Reproduction
Not reproduced: a completion request is forbidden here. The limit is live until 2026-11-29, so any tiny request to an `acp/codex/...` model should reproduce it: today a 503 (or text) with no typed code; after the fix a 429 `usage_limit_exceeded`. Evidence read: many Codex rollout logs 14:33-14:34 local, each ~2.4 s, `last_agent_message: null`. The reset text is local time with no zone; rollout timestamps are UTC (13:33Z = 14:33 local, so local is UTC+1 on that date).

## Proposed fix

### Proxy (AAP-31, repo api-acp-proxy, branch `AAP-31_usage-limit` from master)
1. **Detect** in the provider's `mapError` plus a shared helper in a new small module (e.g. `src/usage-limit.ts`). Text = error message + `JSON.stringify(error.data)` (same trick as `claude.ts:176`, `antigravity.ts:224`). Codex: `usage_limit_exceeded` / `usageLimitExceeded` or `/hit your usage limit/i`. Do NOT treat `rate_limited` / `serverOverloaded` as exhausted: transient, short Retry-After only. Claude: hint `status: "rejected"` with `resetsAt`, plus its limit text (not captured). Antigravity: wording unknown.
2. **Parse the reset**: `try again at <Mon> <D>(st|nd|rd|th), <YYYY> <h:mm> AM|PM`, machine local zone -> epoch ms. If parsing fails, use a short cooldown (e.g. 15 min) and retry afterwards so a misparse never locks a provider long. Cap the maximum (e.g. 31 days).
3. **State**: `Map<providerId, { until, message }>` in `Router` (or the provider). Cleared when `now >= until`, on provider restart/login/logout, and on any later success. Optional persistence next to `usage.json` so a restart does not forget (without it the first request after restart pays one 2.4 s failure and re-learns).
4. **Refuse fast** in `Router.generate` after `checkPrompt`: `throw new ApiError(429, "usage_limit_exceeded", "<Provider> has hit its usage limit; it resets at <local time>.", "model")`. `ApiError` needs an optional `retryAfterSeconds`; the top-level catch (`src/server.ts:416`) and the SSE paths set `Retry-After`. Choice for the planner: 429 (clients treat it as rate limit and may retry with backoff, wasteful for a 14-day limit but consumers can special-case the code) versus another status.
5. **Visibility**: `/healthz` `providers.<id>.exhausted_until` (ISO) and a short message (no account data). `/v1/models`: extra field `exhausted_until` on that provider's model entries (same pattern as `max_prompt_chars`, `src/server.ts:407`). Do not remove the models from the list: roles that name `acp/codex/...` would get 404 `model_not_found` instead of a clear 429, and discovering clients would silently re-route. Optional: show in the desktop provider card.
6. **Docs**: README `/healthz` section (`README.md:126`) and a ROADMAP line (director edits, not me).

### creative-hub (separate ticket HUB-35, in the creative-hub repo, NOT the proxy repo)
`scripts\hub.ps1`: `Get-Health` (`:183-195`) already fetches the health URL and parses JSON but keeps only `model`. Extend it to also return a note when `providers.*.exhausted_until` exists, and in `Show-Status` (`:228-278`) print under the table like the existing `Note:` lines (`:269-271`), e.g. `Note: acp-proxy: codex exhausted until 2026-11-29 11:07` in Yellow (or a `Detail` column). No extra request: `services.json:179` already has `http: http://127.0.0.1:8787/healthz`. Also in HUB-35: a rule in the production skills (make-visual-novel, make-video, make-edu-game) to check this before choosing `acp/codex` roles and to not fall back silently to a weak local model. Depends on AAP-31 being merged and the proxy rebuilt/restarted.
The proxy serves a live production: restart for AAP-31 only on the user's go.

## What the plan needs
- Proxy files: `src/provider.ts`, `src/providers/codex.ts` (add `mapError`), `src/providers/claude.ts` (hint -> exhausted), `src/router.ts` (state + fast refusal), `src/api.ts` (`ApiError` retry-after), `src/server.ts` (`Retry-After`, `/healthz`, `/v1/models`), new `src/usage-limit.ts`, README, ROADMAP.
- Existing tests to extend (confirmed by `ls tests`): `tests/acp-provider.test.ts:76` (mapError test pattern), `tests/router.test.ts`, `tests/proxy.test.ts` (HTTP-level), `tests/codex.test.ts`, `tests/claude.test.ts`.
- New tests (few): (1) time parser: "Nov 29th, 2026 11:07 AM", suffixes, 12 AM/PM, garbage -> fallback; (2) Codex `mapError`: usage-limit error marks exhausted, a plain failure and `rate_limited` do not; (3) router: after one limit error the next request gets 429 `usage_limit_exceeded` + Retry-After without calling the provider, clears at `until` (fake clock) and on success, other providers unaffected; (4) HTTP: `/healthz` and `/v1/models` expose `exhausted_until`; SSE path emits the typed error.
- Hub: manual check of `hub.ps1 status` against a stub `/healthz` (no hub test suite checked).

## Risks
- Misparse of the zone-less local reset time could lock a provider: cap, fallback cooldown, clear on success.
- False positive from loose matching: match the error code/field, never prose in a successful answer; apply only on the failure path.
- 429 triggers client retries (noisy, harmless).
- Hiding models would break pinned roles; recommended against.
- `Router.generate` is on every request's path: keep the check O(1); other providers must be unaffected.
- Live production: no restart or completion test against the running proxy.

## Open questions
1. How does the Codex adapter surface the failure to the proxy (RPC error with `data.codexErrorInfo`, or a failure session update)? Needs one capture or a unit test with a fake agent, plus reading adapter `index.js:35640-36300` further. A live capture needs a completion request (the user's OK).
2. Claude's and Antigravity's limit wording/codes (never captured); Claude's `_claude/rateLimit` `status: "rejected"` is the likely signal.
3. Is the reset time always machine-local? Assumed; `parseCodexStatus` `resetText` could cross-check.
4. Status code for a multi-day limit (429 or other): planner decision.
5. Persist the exhausted state across restarts? (nice-to-have)
