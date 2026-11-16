# Changelog

## 2026-11-16 AAP-33 Antigravity's out-of-quota answer and Claude's rejected rate-limit hint become the AAP-31 429

Outcome: an Antigravity turn whose whole answer is its out-of-quota notice ("Usage Limit Reached ... Your limit will reset in 6 days, 15 hours") no longer comes back as a 200 answer. It answers 429 `usage_limit_exceeded` with `exhausted_until` = now + the relative reset, and the provider is marked exhausted, as AAP-31 does for Codex. A streamed answer never sends the notice as content. A Claude turn during which the adapter's `_claude/rateLimit` hint says `status: "rejected"` answers the same 429 until `resetsAt`.

Repo api-acp-proxy, branch AAP-33_antigravity-and-claude-limits (from master with AAP-31 and AAP-32 merged). What changed, in short:
- src/usage-limit.ts: `matchAntigravityUsageLimit` (strict: the whole answer is at most 500 characters, starts with "Usage Limit Reached" after whitespace and Markdown marks, and holds "reset in N <unit>"); `couldBeAntigravityNotice` (the hold test); `parseResetTime` reads "reset in N days, M hours" (also hours only, minutes, singular units, "and"), counted from the router's clock; `UsageLimitError.resetAt`, which `exhaustedUntil` takes before the text.
- src/provider.ts: descriptor hooks `usageLimitNotice` and `usageLimitFromUpdate`.
- src/acp-provider.ts: `watchUsageLimit`, one watch per request in both `generate` and `generateWithTools`. It holds the opening of the streamed text while it may still be the notice. It flushes the text as soon as it cannot be the notice, on a tool-call suspend, and at the end of a normal turn. It sees every session update. Before the session is kept, a notice turn or a rejecting update becomes `UsageLimitError`. A rejecting update also wins over a failed prompt.
- src/providers/antigravity.ts, src/providers/claude.ts: set the hooks. Claude reads the hint with the existing `readRateLimitHint`.
- src/router.ts: passes `resetAt` to `exhaustedUntil`.
- tests/fixtures/fake-acp.mjs: `FAKE_ACP_ANSWER` (the answer as chunks), `FAKE_ACP_RATE_LIMIT` (a `usage_update` with the hint before the answer).
- tests/usage-limit.test.ts: three tests (below). README.md, Usage limit section. ROADMAP.md: both items marked done, with live checks UNTESTED.

Real text: no capture of the Antigravity notice was found. Searched `~/.claude` (projects and transcripts), `~/.gemini` (including the binary conversation stores), `%APPDATA%\api-acp-proxy` (logs and settings), the Scriptorium repo, all of `%APPDATA%`, the creative-hub repo and the director's REQ files. The fixture uses the brief's wording ("Usage Limit Reached ... Your limit will reset in 6 days, 15 hours", REQ-0025 bug 8), and the middle sentence is assumed.

Fail before, pass after (the new tests run against master's src, then on the branch):
- Table test (notice, near misses, reset variants): master fails with `TypeError: matchAntigravityUsageLimit is not a function`. Passes on the branch.
- HTTP, Antigravity notice: master gives `expected 200 to be 429` (the notice was sent as the answer). On the branch: 429 with `exhausted_until` = now + 6 d 15 h, `Retry-After` 572400, `/healthz` `exhausted_until`, and no text reaches `onText` on a direct streamed call.
- HTTP, Claude hint `rejected`: master gives `expected 200 to be 429`. On the branch: 429 with `exhausted_until` = `resetsAt`.

Verification: `npm run typecheck` clean. `npm test` run twice: 466 passed, 1 skipped (467), both runs.

Decisions:
- The text match runs only on the whole answer of a turn that ended normally (not cancelled, not aborted). For a tool-calling turn it runs only when the request's text is the start of the answer (a fresh or kept session, not a resumed one).
- Holding the opening means a genuine answer that starts with "Usage Limit Reached" streams its first characters (up to 500) only once it stops looking like the notice, or at the end. Any other answer is released after its first non-matching character.
- The SSE headers and the role chunk go out before the turn starts (as for Codex), so a stream whose first request finds the limit gets the contract's mid-stream SSE error event, with no notice text before it.
- Claude: the provider-wide `rateLimitHint()` that the plan limits show is unchanged. The new hook reads the same hint per turn.

UNTESTED:
- Live check on a real exhausted Antigravity: the wording comes from one sighting, with no full capture, and the proxy on 8787 was not started or restarted.
- Live check on a real Claude rejection: the matcher is built against a synthetic hint (`{status: "rejected", rateLimitType, resetsAt}` in seconds), and no real rejection has been captured. It is not known which turn carries the hint or whether the prompt also fails. The adapter (claude-agent-acp, `acp-agent.js` around line 5782) forwards `rate_limit_event` only when `lastAssistantTotalUsage !== null`, so a rejection on a session's first turn may never reach the proxy as a hint.
- The settings-window card (AAP-32) for these two providers: it reads the same router state, but has not been seen in the real window.

Commit status: committed on AAP-33_antigravity-and-claude-limits; not merged, not pushed.
