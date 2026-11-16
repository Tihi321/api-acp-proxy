---
status: approved
request: REQ-0026
repos: [api-acp-proxy]
branch: AAP-32_exhausted-provider-card
updated: 2026-11-16
---
# AAP-32: the desktop provider card shows "usage limit until <local time>"

Follow-up of AAP-31 (`.claude/tickets/AAP-31-usage-limit/`, merged to `master` at `9415af6`), whose plan listed "showing it
in the desktop provider card" as out of scope. Request: creative-hub `REQ-0026`. Cut the branch from `master`.

## Scope

1. **Feature 1, built here.** While the router holds `exhaustedUntil` for a provider, the settings window shows
   `usage limit until <local time>` on that provider, in both places a provider is drawn:
   - the Overview row (`renderOverview`, `src/renderer/settings.ts:246-288`), and
   - the provider's own page (`renderProvider`, `src/renderer/settings.ts:190-222`, cards `#card-codex`, `#card-claude`,
     `#card-antigravity` in `src/renderer/settings.html`).
   The line disappears when the state clears: on a later success of that provider (AAP-31 clears it in `track`), and when
   the reset time passes (AAP-31 clears it lazily on read).
2. **Feature 2, roadmap only.** One open `ROADMAP.md` item for a built-in Claude usage-limit matcher from the
   `_claude/rateLimit` hint. Not built: no real rejection has been captured yet.

How the state gets to the window today (read for this plan):
- The router keeps `exhausted: Map<id, epoch ms>` (`src/router.ts:44`), sets it in `track` (`:212-214`), clears it on a
  non-cancelled success (`:207`) and lazily in `exhaustedUntilMs` (`:190-195`); `exhaustedProviders()` (`:221-225`) returns
  the live entries as id -> ISO.
- The window gets `StateView.status.providers: ProviderStatusView[]` (`src/shared/ipc.ts:9-26`) from
  `ProxyController.status()` (`src/controller.ts:144-152`), via `buildState` in `src/electron/main.ts:118-131`.
- Pushes: the controller emits `"status"` from `publish()` (`src/controller.ts:154-158`), `main.ts:179` debounces it (80 ms)
  into `proxy:state`, the renderer re-renders on `api.onState` (`src/renderer/settings.ts:613`). Today nothing publishes
  when the exhausted map changes, and a lazy expiry fires no event at all. Both gaps are closed below.

Format of the line (local machine time, as the 429 message of AAP-31 reads the reset):
- same local day as now: `usage limit until 11:07`
- another day: `usage limit until 2026-11-29 11:07`
- no line when `exhaustedUntil` is absent, not a valid date, or not in the future.

## Out of scope

- The Antigravity "out of quota answered as 200" item (bug 8, `ROADMAP.md:31`): checked, still open on the roadmap; a
  separate ticket, not planned here.
- Building the Claude matcher (feature 2 is a roadmap line only).
- The tray icon and its menu (`src/electron/tray.ts`), the sidebar nav dot, the badge colour: unchanged.
- Hiding or greying the exhausted provider's models, or disabling its buttons.
- Any change to the 429 contract, `/healthz`, `/v1/models`, the cooldown or the matchers of AAP-31.
- Persisting the state across restarts (still memory only).
- The Usage view (`src/renderer/usage-view.ts`) and the plan-limits panel.

## Files to touch

| File | Change |
|---|---|
| `src/router.ts:12-26` | `RouterOptions.onExhaustedChange?: () => void` |
| `src/router.ts:204-219` (`track`) | call `onExhaustedChange` after `exhausted.set(...)`, and after the success `exhausted.delete(...)` only when an entry was there. Never from `exhaustedUntilMs` (a read path; `status()` calls it) |
| `src/provider.ts:45` | `ProviderStatus.exhaustedUntil?: string` (ISO UTC; set by the controller from the router, providers never set it) |
| `src/controller.ts:144-152` | `status()`: for a live provider, add `exhaustedUntil` from `this.running.router.exhaustedProviders()[entry.id]` when present |
| `src/controller.ts:218` | pass `onExhaustedChange: () => this.publish()` to the `ProviderRouter` |
| `src/shared/ipc.ts:9-26` | `ProviderStatusView.exhaustedUntil?: string` (same doc) |
| `src/renderer/usage-limit-line.ts` (new) | pure helpers, no DOM (pattern of `src/renderer/mcp-command.ts`): `usageLimitLine(iso: string \| undefined, now: number): string \| undefined` and `nextExpiryDelay(providers: Array<{ exhaustedUntil?: string }>, now: number): number \| undefined` (ms until the earliest future `exhaustedUntil`, capped at 2^31-1) |
| `src/renderer/settings.ts:190-222` | `renderProvider`: fill `[data-role="usage-limit"]` with the line, `hidden` when none |
| `src/renderer/settings.ts:252-288` | `renderOverview`: append `make("p", "ov-line usage-limit", line)` after the sign-in line when there is one |
| `src/renderer/settings.ts:340-364` | `render()`: one module-level timer; clear it, then when `nextExpiryDelay` gives a delay, `setTimeout(() => void refresh(), delay + 1000)`. `refresh` -> `getState` -> `status()` -> lazy clear, so the line goes away on time with no main-process timer |
| `src/renderer/settings.html:201, :249, :309` | `<p class="usage-limit" data-role="usage-limit" hidden></p>` next to each card's `data-role="error"` paragraph |
| `src/renderer/settings.css` (near `.badge.warn`, `:115`) | `.usage-limit { color: var(--warn); font-weight: 600; }` (tokens exist for light and dark, `:8`, `:24`) |
| `tests/usage-limit-line.test.ts` (new) | the one renderer test below |
| `tests/router.test.ts:142-160` | extend the existing exhausted test with the callback counts (no new test) |
| `README.md:140-147` (Usage limit) | one sentence: the settings window shows `usage limit until <local time>` on the provider while it lasts |
| `ROADMAP.md:31` | feature 2 item, added after the Antigravity item |

## Tasks

Run in order; one worker can do all of it (small).

1. **State to the window.**
   Inputs: `src/router.ts`, `src/provider.ts`, `src/controller.ts`, `src/shared/ipc.ts`.
   Output: `ProviderStatus(View).exhaustedUntil`, set in `status()`; the router calls `onExhaustedChange` on set and on a
   clearing success; the controller publishes on it. Check: `status()` must not call `publish` (no loop): only `track`
   fires the callback.
2. **Renderer line and timer.**
   Inputs: task 1, `src/renderer/settings.ts`, `settings.html`, `settings.css`, `src/renderer/mcp-command.ts` (pattern).
   Output: `src/renderer/usage-limit-line.ts`; the line in the Overview row and on the provider page; the expiry timer in
   `render()`. Local time from `Date` getters (`getFullYear`, `getMonth`, `getDate`, `getHours`, `getMinutes`, zero-padded),
   not `toLocaleString`, so the text does not depend on the OS locale.
3. **Tests, docs, roadmap.**
   Inputs: tasks 1-2, `tests/mcp-command.test.ts` (pattern), `tests/router.test.ts:142-160`, `README.md:140`, `ROADMAP.md:31`.
   Output: the tests below; the README sentence; the roadmap item below. Then `npm run typecheck` and `npm test`
   (`fnm exec --using default npm test` if node is not on PATH). No request to, restart of, or build over the proxy on 8787.

## ROADMAP.md item (feature 2), after line 31

```
- [ ] Claude has no built-in usage-limit matcher: read the `_claude/rateLimit` hint the adapter pushes on `usage_update` (`status: "rejected"`, `resetsAt`; parsed today in `src/plan-limits.ts:75-84`, kept per provider at `src/acp-provider.ts:386`) and mark the provider exhausted until `resetsAt` through the AAP-31 mechanism (429 `usage_limit_exceeded`). Blocked until one real rejection is captured (which turn carries it, whether the prompt also fails, the `resetsAt` unit); until then `providers.claude.usageLimitPattern` is the workaround.
```

## Acceptance criteria

| # | Criterion | Proven by |
|---|---|---|
| A1 | With `exhaustedUntil` set for a provider, its Overview row and its page show `usage limit until <local time>`; other providers show nothing | T1 (text), live check L1 (window) |
| A2 | Same local day -> time only; another day -> date and time; absent, invalid or past -> no line | T1 |
| A3 | The line clears on a later success: the router calls `onExhaustedChange`, the controller publishes, the window re-renders | review of `track` (see T2 note), L2 |
| A4 | The line clears when the reset time passes, with the window left open (renderer timer -> `getState` -> lazy clear) | T1 (`nextExpiryDelay`), L2 |
| A5 | `status()` never publishes (no event loop); the callback fires once per set, never on a read or a lazy expiry | T2 |
| A6 | The Claude matcher item is in `ROADMAP.md`, open, saying it is blocked on a captured rejection; the Antigravity item (bug 8) is unchanged and open | review of the diff |
| A7 | typecheck and the whole suite pass | `npm run typecheck`, `npm test` |

## Tests (per test-discipline: one new test, one extended)

- **T1** `tests/usage-limit-line.test.ts`, one `it` with a small table (expected values built with local `new Date(y, m, d, h, min)`
  so the test passes in any time zone): now = 2026-11-26 09:00 local; until 2026-11-26 11:07 -> `usage limit until 11:07`;
  until 2026-11-29 11:07 -> `usage limit until 2026-11-29 11:07`; undefined, `"garbage"`, a past time -> `undefined`;
  `nextExpiryDelay` of `[{}, {exhaustedUntil: <29 Nov>}, {exhaustedUntil: <26 Nov 11:07>}]` -> the 26 Nov delay; all
  absent or past -> `undefined`.
- **T2** extend `tests/router.test.ts:142` ("refuses without calling the provider until the time passes ..."): pass
  `onExhaustedChange` counting calls; expect 1 after the first failure; still 1 after the refused `generate`, the
  `checkPrompt` and the `exhaustedProviders()` reads, and after the clock passes `until` (lazy clear, no event) and the
  final success (nothing left to clear). A clearing success only happens to a request that passed the pre-check before
  another one set the mark (concurrent requests); it is the same one-line call and is covered by review, not by a test.

No test for the DOM wiring in `settings.ts` (the repo has no DOM test setup; the helpers carry the logic).

## Live checks (all UNTESTED until run)

The proxy on 8787 is the hub's live instance (REQ-0024 production). Build and restart only when the user says go.

- **L1 (UNTESTED)** after a rebuild and restart of the desktop app on the new code: one tiny Codex request while its limit
  lasts (until 2026-11-29, only with the user's OK) -> the Overview row and the Codex page show
  `usage limit until 2026-11-29 11:07`; Claude and Antigravity show nothing.
- **L2 (UNTESTED)** clearing: hard to see live (a success needs the limit gone, the expiry is 2026-11-29). Optional with a
  short `server.usageLimitCooldownMinutes` and `providers.<id>.usageLimitPattern` on a provider that fails on purpose; only
  with the user's OK. Otherwise covered by T1/T2 and recorded as not checked live.
- **L3 (UNTESTED)** dark mode and light mode: the line is readable in both.

## Commit plan

Branch `AAP-32_exhausted-provider-card` from `master`, commits in the AAP-31 style (`AAP-32: <what>`):

1. `AAP-32: provider status carries exhaustedUntil; the router reports changes` (task 1 + T2).
2. `AAP-32: the provider card shows "usage limit until <local time>"` (task 2 + T1, README sentence).
3. `AAP-32: roadmap item for a built-in Claude usage-limit matcher` (feature 2).
4. `AAP-32: close the ticket files` (plan status `done`, `changelog.md` with DONE / NOT DONE / UNTESTED).

Merge to `master` and push only when the user asks.
