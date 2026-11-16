# Changelog

## 2026-11-16 AAP-34 An overage rejection resets at overageResetsAt

Outcome: a Claude `_claude/rateLimit` rejection of the overage itself (`rateLimitType: "overage"` or `overageStatus: "rejected"`) now marks the provider exhausted until the hint's `overageResetsAt` (SDKRateLimitInfo field, confirmed in the adapter's bundled claude-agent-sdk `sdk.d.ts`; seconds or ms, normalised like `src/plan-limits.ts`). Without it, `resetsAt` is used as before. A plain plan-window rejection still uses `resetsAt`.

- src/providers/claude.ts: `usageLimitFromUpdate` reads `overageResetsAt`.
- tests/usage-limit.test.ts: the existing Claude hint test gets one more case.
- README.md (Usage limit, Claude bullet) and ROADMAP.md updated.

Live check: UNTESTED (no real rejection captured).
