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
- Live check on a real Claude rejection: the matcher is built against a synthetic hint (`{status: "rejected", rateLimitType, resetsAt}` in seconds), and no real rejection has been captured. It is not known which turn carries the hint or whether the prompt also fails. The adapter (claude-agent-acp 0.91.0, `acp-agent.js` around line 5782) forwards `rate_limit_event` only when `lastAssistantTotalUsage !== null`, and that value is per turn: it is reset whenever a turn becomes active (`runConsumer` :2536-2542, `resetTurnScratch` :2779-2781). So a rejection with no real model frame earlier in the same turn likely never reaches the proxy; the matcher probably fires only for a rejection after a turn's first model call. (Corrected in polish round 1; it said "a session's first turn" before.)
- The settings-window card (AAP-32) for these two providers: it reads the same router state, but has not been seen in the real window.

Commit status: committed on AAP-33_antigravity-and-claude-limits; not merged, not pushed.

## 2026-11-16 AAP-33 polish round 1: Claude overage, a stricter Antigravity heading, the per-turn gate

- src/providers/claude.ts `usageLimitFromUpdate`: reads the raw `_meta["_claude/rateLimit"]` for the SDK's overage fields (`SDKRateLimitInfo`, which `readRateLimitHint` drops). A `rejected` hint is no limit when `isUsingOverage` or `overageInUse` is true or `overageStatus` is `allowed` / `allowed_warning`; a rejection with `rateLimitType: "overage"` or `overageStatus: "rejected"` stays a 429.
- src/usage-limit.ts: the heading "Usage Limit Reached" must be the whole first non-empty line (after stripping `# * _ >`, whitespace and trailing punctuation); the 500-character cap and the "reset in" requirement stay. `couldBeAntigravityNotice` follows the same rule, so a first line that goes on past the heading is released at once. The relative parser reads weeks ("reset in 1 week").
- src/acp-provider.ts: on a failure that is not a usage limit, both catch blocks release the held text before the error, so partial text streams ahead of the SSE error as before AAP-33. A rejecting hint seen before a tool-call suspend is carried to the resumed request's watch (`UsageLimitWatch.rejected()`, third argument of `watchUsageLimit`). The ToolTurn doc comment is back above `ToolTurn`.
- README.md Usage limit: the stricter heading, weeks, the held text on failure, resumed tool-call requests not checked for the Antigravity notice, the overage rule, the carried hint, and the per-turn gate (above). ROADMAP.md: the stale "Blocked until ..." sentence on the done Claude item is reworded.
- tests/usage-limit.test.ts: in the Claude HTTP test, the hook on an overage-carried rejection (no limit) and on a rejected overage (limit). In the table: the near-miss "Usage Limit Reached is what Antigravity shows; it says your limit will reset in 5 hours.", "reset in 1 week", and the one-line "Usage Limit Reached. Your limit ..." row now has a line break after the heading. The hold check also covers "Usage Limit Reached is what".

Fail before, pass after (new tests against 631c3ca's src): the Claude test fails with `expected [ { resetAt: 1794844800000 }, …(1) ] to deeply equal [ undefined, …(1) ]` (the overage row); the table test fails. The near-miss sentence on its own: 631c3ca's `matchAntigravityUsageLimit` returns true, the branch false ("1 week": false / undefined before, true / 7 days after). Both pass on the branch.

Verification: `npm run typecheck` clean. `npm test` run twice: 466 passed, 1 skipped (467), both runs.

Remaining gaps: the carried hint has no test of its own (UNTESTED). Live checks as above stay UNTESTED.

## 2026-11-16 AAP-33 polish round 2: the one-line notice matches again, quotes do not, the reset sentence is required

- src/usage-limit.ts: a first line counts as the heading when it is "Usage Limit Reached" alone (as in round 1), or when it starts with the heading followed by `.`, `!`, `:`, an en dash or an em dash (`HEADING_THEN_SENTENCE`) and holds "your limit will reset in N" (`RESET_SENTENCE`). This undoes the round-1 regression that refused "Usage Limit Reached. Your limit will reset in 6 days, 15 hours." on one line. `LEAD` no longer strips `>`, so a quoted heading is not the notice. The whole answer must hold `RESET_SENTENCE` ("your limit will reset in N"), not just "reset in N"; the reset time is still parsed with `RELATIVE`. `couldBeAntigravityNotice` follows: a complete first line is held when the same two-way test passes; an incomplete line longer than the heading is held when it is the heading or `HEADING_THEN_SENTENCE` matches, so every prefix of the one-line notice stays held.
- src/acp-provider.ts: `UsageLimitWatch.releaseOrNotice()`. In both catch blocks, a failure that is not a usage limit now throws the notice's UsageLimitError when the held-back text is the notice; only held text that is not the notice is released before the error.
- README.md Usage limit: the final rule (one-line form, no quoted heading, "Your limit will reset in N" required, the notice on a failed turn).
- tests/usage-limit.test.ts (table rows only): the original one-line row "Usage Limit Reached. Your limit will reset in 45 minutes." is back in place of the round-1 line-break variant; `:` and em-dash one-line matches; near misses "Usage Limit Reached: this means your quota is spent. It will reset in 5 hours.", the `> ` blockquote and the `## ...` explainer with "it will reset in 5 hours"; every prefix of the one-line notice is held.

Fail before, pass after: with f3a8029's src/usage-limit.ts and the new tests, the table test fails on `Usage Limit Reached. Your limit will reset in 45 minutes.: expected false to be true`. It passes on the branch.

Verification: `npm run typecheck` clean. `npm test` run twice: 466 passed, 1 skipped (467), both runs.

UNTESTED: the failed-turn notice (`releaseOrNotice`) has no test of its own (the brief allowed table rows only). Live checks as above stay UNTESTED.
