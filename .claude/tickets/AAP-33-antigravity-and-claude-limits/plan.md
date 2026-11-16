---
status: in-progress
request: REQ-0028
repos: [api-acp-proxy]
branch: AAP-33_antigravity-and-claude-limits
updated: 2026-11-16
---
# AAP-33: Antigravity's out-of-quota answer and Claude's rejected rate-limit hint become the AAP-31 429

Request: creative-hub `REQ-0028` (pieces 1 and 3; bug 8 of `REQ-0025`). Builds on AAP-31 (`UsageLimitError`, router state,
the 429 contract) and AAP-32 (the provider card). The two open ROADMAP.md items: "Antigravity out of quota is answered as a
normal 200" and "Claude has no built-in usage-limit matcher".

## Scope

1. **Antigravity out of quota (bug 8).** Antigravity answers an out-of-quota turn with assistant text like
   "Usage Limit Reached ... Your limit will reset in 6 days, 15 hours" and ends the turn normally (`end_turn`).
   - The descriptor gets `usageLimitNotice: { couldBe(textSoFar), is(text) }` (new `ProviderDescriptor` field);
     Antigravity sets it from `src/usage-limit.ts` (`couldBeAntigravityNotice`, `matchAntigravityUsageLimit`).
   - Strict match: the whole answer, at most 500 characters, starts with "Usage Limit Reached" (leading whitespace and
     Markdown marks `# * _ >` allowed) and holds "reset in <N> <unit>". A longer answer, one that starts otherwise, or one
     without the relative reset is a normal answer.
   - `AcpProvider` (both `generate` and `generateWithTools`) holds back the opening of the streamed text while it could
     still be the notice; it flushes it as soon as it cannot (first characters that do not fit the heading, or over the
     cap), on a tool-call suspend, and at the end of a normal turn. A turn whose whole text is the notice throws
     `UsageLimitError` with the text as `resetText`, before the session is kept, so the notice is never sent as content.
     With the hold, a stream sends no notice delta; it still gets the contract's mid-stream SSE error (the SSE headers and
     the role chunk go out before the turn starts, as for Codex).
   - `parseResetTime` gains the relative form "reset in N days[, M hours][, K minutes]" (any subset, `and` allowed,
     singular units), read against the router's clock (`now + N`). The router then applies the AAP-31 contract unchanged.
2. **Claude matcher.** The adapter pushes `usage_update` with `_meta["_claude/rateLimit"]` (read by `readRateLimitHint`,
   `src/plan-limits.ts`). A new descriptor hook `usageLimitFromUpdate(update)` returns `{ resetAt }` for
   `status: "rejected"`; the turn that saw it throws `UsageLimitError` with `resetAt` (epoch ms), whether the prompt then
   ended or failed. `UsageLimitError` carries `resetAt?`; `exhaustedUntil` takes it before the text (same past / 31-day
   cap / cooldown rules). The provider-wide `rateLimitHint()` for plan limits is unchanged. Built against a synthetic
   fixture (no real rejection captured): the live check is UNTESTED.

## Out of scope

- Capturing a real Antigravity or Claude rejection (none found in `~/.claude`, `~/.gemini`, the proxy's logs, Scriptorium);
  the brief's Antigravity text is used.
- Taking back text already streamed (the hold only covers the opening, within the cap).
- Making Claude's adapter send the hint on a turn with no assistant message yet (see the changelog).
- Persisting the state; any other provider.

## Files

| File | Change |
|---|---|
| `src/usage-limit.ts` | `UsageLimitError.resetAt`; relative form in `parseResetTime`; `exhaustedUntil(..., resetAt?)`; `couldBeAntigravityNotice`, `matchAntigravityUsageLimit` |
| `src/provider.ts` | `ProviderDescriptor.usageLimitNotice?`, `usageLimitFromUpdate?` |
| `src/acp-provider.ts` | the hold on `onText`, the notice check at turn end, the update hook (both generate paths) |
| `src/providers/antigravity.ts`, `src/providers/claude.ts` | set the hooks |
| `src/router.ts` | pass `error.resetAt` to `exhaustedUntil` |
| `tests/fixtures/fake-acp.mjs` | `FAKE_ACP_ANSWER` (chunks), `FAKE_ACP_RATE_LIMIT` (a `usage_update` before the answer) |
| `tests/usage-limit.test.ts` | the three tests below |
| `README.md`, `ROADMAP.md` | Usage limit section; both items done, live checks UNTESTED |

## Acceptance

| # | Criterion | Proven by |
|---|---|---|
| A1 | The notice text, the near-miss genuine answers and the reset variants (days+hours, hours only, minutes, singular, `and`) are told apart and parsed | table test (fails on master: no export) |
| A2 | An Antigravity turn answering the notice gives 429 `usage_limit_exceeded` with `exhausted_until` = now + 6 d 15 h and Retry-After, `/healthz` shows `exhausted_until`; a streaming caller gets no notice text as a delta | HTTP test (fails on master: 200) |
| A3 | A Claude turn with a `rejected` hint gives 429 with `exhausted_until` = `resetsAt` | HTTP test (fails on master: 200) |
| A4 | Plan limits and `rateLimitHint()` behave as before; typecheck and the whole suite pass (twice) | `npm run typecheck`, `npm test` x2 |
| A5 | Live checks on a real exhausted Antigravity or Claude | UNTESTED (no real rejection; no proxy restart on 8787) |
