# Changelog

## 2026-11-09 AAP-29: per-provider usage totals, plan limits, and a redesigned settings window

Outcome: the proxy now persists request and token totals per provider and day in `usage.json`, reads plan limits from Codex (`/status`) and Claude (`/usage`) on demand, and the settings window has a sidebar layout with seven pages, design tokens, and light and dark themes.

### api-acp-proxy (branch `AAP-29_usage-and-ux-redesign`, from `origin/master` e3b3c70)

- `src/shared/ipc.ts`: new view types (`UsageView`, `UsageCountsView`, `PlanLimitsView`, `PlanLimitWindowView`, `RateLimitHintView`, ...), `ActivityView.estimated`, and the `ProxyApi` methods `getUsage`, `resetUsage`, `onUsage`, `getPlanLimits` and `refreshPlanLimits`.
- `src/usage-store.ts` (new): `UsageStore` and `localDayKey`.
  - Counts per provider and local day, with all-time totals that are never pruned. Day buckets are kept for 400 days.
  - Writes are debounced (2 s) and atomic (tmp file plus rename, with an EPERM/EBUSY/EACCES retry).
  - On load the file's counts are merged into anything added before the load finished. A broken file starts the store empty.
  - `reset()` writes the zeroed file at once.
- `src/usage.ts`: `usageEstimated()`.
- `src/activity.ts`: `ActivityEntry.estimated`.
- `src/server.ts`, `src/mcp-endpoint.ts`: the activity record carries `estimated: true` when the token counts are the chars/4 estimate.
- `src/controller.ts`:
  - New `usage` (a `UsageStore`) and `planLimits` (a `PlanLimitsCache`) fields, and a `"usage"` event.
  - Every activity record is counted.
  - New `usageSummary()` and `resetUsage()` methods.
  - `stop()` flushes `usage.json`, and `logout()` drops the cached plan limits.
  - `ProviderRegistration.planLimits` is new.
- `src/plan-limits.ts` (new):
  - Parsers for Codex `/status` (where "% left" becomes used) and Claude `/usage`.
  - A redaction step that drops emails, `$` lines, Account/Directory/Session lines and the session section.
  - A reader for Claude's `_claude/rateLimit` hint.
  - `PlanLimitsCache`, which caches values for 60 s, shares one probe between concurrent calls, and never probes while the provider needs login.
- `src/provider.ts`: `PlanLimitsSpec`, the descriptor fields `planLimits` and `planLimitsUnavailable`, and the optional `Provider.planLimits()` and `rateLimitHint()`.
- `src/acp-provider.ts`:
  - It captures the rate-limit hint from `usage_update`.
  - `planLimits()` sends only the slash command in a throwaway session: no warm or kept session, no model, no preamble. It has a 30 s timeout, cancels on timeout or abort, and logs only at debug level without the reply text.
- `src/router.ts`: `probePlanLimits()` takes a slot of the provider's concurrency limiter.
- `src/providers/codex.ts`:
  - It sends `/status`.
  - A custom `PROXY_ACP_COMMAND` adapter is reported as unsupported.
  - The registration has `planLimits: true`.
- `src/providers/claude.ts`: it sends `/usage`, and the registration has `planLimits: true`.
- `src/electron/preload.cts`, `src/electron/main.ts`:
  - The IPC channels `proxy:usage` (invoke, and a push debounced at 500 ms), `proxy:resetUsage`, `proxy:planLimits` and `proxy:refreshPlanLimits`.
  - The tray is untouched.
- `src/renderer/settings.html`, `settings.css`, `settings.ts`:
  - A sidebar shell with Overview, Usage, Requests, Server, Codex, Claude and Antigravity. It shows nav status dots and an unsaved-changes marker, and remembers the last view.
  - The "quiet console" token set in light and dark, and the shared components.
  - Sticky save bars.
  - A reset-usage dialog.
  - "≈" on estimated token cells.
  - All existing ids and `data-role` values are kept.
- `src/renderer/usage-view.ts`, `usage.css` (new):
  - Range tiles, a per-provider table with a totals row, and a 30-day stacked bar chart with Requests and Tokens metrics.
  - A note, and Reset with confirmation.
  - Plan-limit cards for every state, with meters and Claude's hint line.
  - The Overview "Today" strip.
- `tests/usage-store.test.ts` (new, 3 tests), `tests/plan-limits.test.ts` (new, 3 tests), `tests/controller.test.ts` (one assertion added), `tests/fixtures/fake-acp.mjs` (`FAKE_ACP_SLASH`).
- `README.md`: new Usage and Plan limits paragraphs, the sidebar described in Overview and Settings window, Requests and Clear, and a `usage.json` row in the Files table. `ROADMAP.md` has one `[x]` line.

### Deviations from the plan

- Verification step 4: `npm` does not resolve through `fnm exec` on this machine, so the build ran as its three steps (`tsc`, `tsc -p tsconfig.renderer.json`, `node scripts/copy-static.mjs`).
- Renderer:
  - Each provider page's head (name, badge, version and Enabled switch) sits inside `#card-<provider>`, so that the existing scoped `role()` lookups keep working.
  - Refresh on a plan-limit card is enabled when the provider is `ready` or `stopped`, in every state except `unsupported`.
  - `.stat` tiles have a `--surface-2` fill.
  - `.grid` goes to two columns through a container query.
- `UsageStore` load also sanitises counts and skips malformed day keys.

### Verification

- `tsc --noEmit`: clean.
- `tsc --noEmit -p tsconfig.renderer.json`: clean.
- `vitest run`: 742 passed, 2 skipped (baseline 736, plus 6 new).
- Build, run as its three steps: ok. `dist/renderer` holds `usage-view.js` and `usage.css`.
- CSP greps (`style=`, `onclick=`, `<style`, `setAttribute("style"`): empty.
- App (`electron .` with `ACP_PROXY_DEV_DIR` and a temp `PROXY_SETTINGS_FILE`, all providers off):
  - All seven views were screenshotted in dark (the system theme) and in light (the dark media rules were removed in the page for the shots).
  - The plan-limits cards and the reset dialog (open and cancel) were also screenshotted.
  - No renderer errors in `proxy.log`.
  - Shots are in `.claude/temp/aap29-app/shots/`.
- Headless CLI (`dist/index.js`, temp settings, fake agent as `PROXY_ACP_COMMAND`): one chat request wrote `usage.json` with 1 codex request. The file came from the debounced write; the SIGINT flush path was not exercised, because Git Bash's `kill -INT` did not stop the native process.

### Not run

- A9: real Codex and Claude probes, which need real logins.
- The 640x480 layout.
- The chart with data.
- A real OS light theme (light was simulated in the page).
- The hand-run T5 feature checklist beyond navigation and the reset dialog.

### Follow-ups

See `discoveries.md`:

- The server pill's URL wrapping.
- Content showing under the sticky save bar.
- `list()` for a custom Codex adapter.
- The SettingsView fields.
- The unused `onUsage` callback.
- `workRoot`.
- The tray count.

Commit status: uncommitted.
