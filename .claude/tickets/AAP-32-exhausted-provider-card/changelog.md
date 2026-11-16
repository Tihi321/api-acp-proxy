# Changelog

## 2026-11-16 AAP-32 the settings window shows "usage limit until <local time>" on an exhausted provider

Outcome: while the router holds `exhaustedUntil` for a provider, its Overview row and its own page show `usage limit until 11:07` (same local day) or `usage limit until 2026-11-29 11:07` (another day). The line goes away on a later success (the router reports the change, the controller publishes) and when the reset time passes (one renderer timer re-reads the state just after the earliest reset).

Repo api-acp-proxy, branch AAP-32_exhausted-provider-card (from master). What changed, in short:
- src/router.ts: `RouterOptions.onExhaustedChange`, called after a failure marks a provider and after a success that really clears a mark; never from a read or a lazy expiry.
- src/provider.ts, src/shared/ipc.ts: `exhaustedUntil?: string` on `ProviderStatus` / `ProviderStatusView`.
- src/controller.ts: `status()` adds `exhaustedUntil` to a live provider from the router; the router's callback publishes. `status()` itself never publishes.
- src/renderer/usage-limit-line.ts (new): pure `usageLimitLine` and `nextExpiryDelay`, local time from Date getters.
- src/renderer/settings.ts, settings.html, settings.css: the line in `renderOverview` and `renderProvider` (three cards), the expiry timer in `render()`, warn colour.
- tests/usage-limit-line.test.ts (new, one test), tests/router.test.ts (callback counts added to the existing test), README.md (one sentence), ROADMAP.md (open item: built-in Claude usage-limit matcher, blocked on a captured rejection; the Antigravity item is unchanged).

Verification: `npm run typecheck` clean; `npm test` 463 passed, 1 skipped (464 total; 33 files passed, 1 skipped).

DONE: task 1 (state to the window), task 2 (renderer line and timer), task 3 (tests, README, roadmap); A1-A7 by unit test, typecheck and diff review.

UNTESTED:
- L1: the Overview row and the Codex page in the real window with a real exhausted Codex (needs a rebuild and restart on 8787, only when the user says go).
- L2: the line clearing live (a success after the limit, or the reset time passing with the window open).
- L3: dark and light mode readability of the line.
- The DOM wiring in settings.ts has no test (the repo has no DOM test setup).

Ticket status: left at in-progress (director-managed, REQ-0026); plan.md status not changed.

Commit status: committed on AAP-32_exhausted-provider-card; not merged, not pushed.
