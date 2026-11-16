# Changelog

## 2026-11-16 AAP-31 a provider at its usage limit is refused fast with a typed 429

Outcome: a Codex usage-limit failure answers 429 `usage_limit_exceeded` (contract body, `Retry-After`) instead of 503 `backend_unavailable`; the provider is then refused before the limiter until its reset time (cooldown, default 60 minutes, when the time is unknown, past or over 31 days); `exhausted_until` shows in `/healthz` and `/v1/models`.

Repo api-acp-proxy, branch AAP-31_usage-limit (from master). What changed, in short:
- src/usage-limit.ts (new): `UsageLimitError`, `parseResetTime` (local time), `exhaustedUntil`, `matchCodexUsageLimit`, `matchPattern`, `usageLimitRefusal`.
- src/api.ts: `ApiError.retryAfterSeconds` / `details`, spread into the error envelope.
- src/providers/codex.ts, src/acp-provider.ts: Codex `mapError`; opt-in `providers.<id>.usageLimitPattern`.
- src/router.ts: per provider `exhausted` state; `refuseIfExhausted` in `checkPrompt` and `generate`; `exhaustedProviders()`; `exhausted_until` on listed models.
- src/server.ts, src/acp.ts, src/controller.ts, src/settings.ts, src/config.ts: `Retry-After`, `/healthz` and `/v1/models` fields, `server.usageLimitCooldownMinutes` / `PROXY_USAGE_LIMIT_COOLDOWN_MINUTES`.
- src/usage-store.ts: an entry whose `error` is `usage_limit_exceeded` is not counted in the usage totals (it stays in the activity log). Other errors (400, 503) count as before.
- tests/usage-limit.test.ts (HTTP, parsing and totals), tests/router.test.ts, README.md, ROADMAP.md (item added; the hub's port corrected from 7461 to 8787, as in the hub's services.json).

Reproduction on master (test T1 against the unfixed code): request 1 answered 503 `backend_unavailable`, request 2 answered 503 again, and the fake agent's log showed 2 `session/prompt` lines. With the fix: request 1 answers 429 with the contract body and `Retry-After`; request 2 (stream too) answers an HTTP 429 JSON and the log shows only 1 `session/prompt` line.

Worker decisions:
- Re-check after the queue slot: `generate` calls `refuseIfExhausted` a second time once `limiter.acquire` returns. A request that waited in the queue may have been overtaken by one that found the limit used up; without the re-check it would run the agent and fail again.
- "cancelled" does not clear the state: `track` clears the exhausted mark only on a result whose `stopReason` is not `cancelled`. A client that left or a timeout proves nothing about the limit, so it must not lift the refusal.
- Refusals stay out of the usage totals: the check is on the activity entry's `error` code in `UsageStore.add`, so the first failing request (which also answers the 429) is not counted either.

Verification: `npm run typecheck` clean; `npm test` 462 passed, 1 skipped (463 total).

UNTESTED:
- Live check on the proxy at 8787: one tiny Codex request while the limit lasts (until 2026-11-29, only with the user's OK), then `/healthz`, `/v1/models` and the hub's `hub.ps1 status`. The state is in memory, so `exhausted_until` appears only after the next real Codex failure.
- Restart or rebuild of the packaged app (the proxy on 8787 serves live production; restart only when the user says go).
- Claude and Antigravity matchers (out of scope; their limit wording was never captured).

Commit status: committed on AAP-31_usage-limit; not merged, not pushed.
