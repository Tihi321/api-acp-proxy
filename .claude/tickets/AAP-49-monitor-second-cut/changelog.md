# AAP-49 changelog

## 2026-11-22 - AAP-49 Monitor second cut: sparklines, thinking tokens, conversation cache, outside server

Repo api-acp-proxy, branch `AAP-49_monitor-second-cut` (cut from `AAP-48_small-fixes` a929ecf).

Files:
- `src/shared/ipc.ts`: `EngineHistoryView`, `EngineConversationCacheView`; `EngineView.history`, `.conversationCache`; `MonitorView.local.external`; `ActivityView.reasoningTokens`.
- `src/activity.ts`: `ActivityEntry.reasoningTokens`.
- `src/server.ts`: `traceUsage` keeps the reasoning count (finite and > 0), `track` copies it to the log entry.
- `src/local-monitor.ts`: `HISTORY_POINTS = 60`; `mapStrataMetrics` maps six whitelisted history series (last 60 points, non-numbers become null, empty series dropped) and the conversation cache (numbers plus the `enabled` boolean).
- `src/electron/main.ts`: `refreshLocalSettings` also caches whether the server key is set; the `proxy:monitor` handler no longer calls `getSettings`; with no local server held it GETs Strata then Llama on their configured ports (enabled providers only, 127.0.0.1, 800 ms) and shows the first that answers as ready, `external`.
- `src/renderer/monitor-view.ts`: `spark()` inline SVG (attributes only, `.spark` class, nulls break the line, flat series at mid-height); sparklines on GPU load, VRAM, GPU temp, Power, Disk read and Decode; Conversation cache tile; "Could not show the latest reading" notice after a render error, cleared by the next good render; "started outside the app" on the Model and State tiles; Thinking cell in the proxy-requests table.
- `src/renderer/settings.ts`: Requests page Tokens cell appends "(N thinking)".
- `src/renderer/settings.html`: Thinking column header. `src/renderer/settings.css`: `.spark` rules.
- `tests/local-monitor.test.ts`, `tests/activity.test.ts`: test 1 and the first activity test extended (no new test).
- `README.md`, `ROADMAP.md`: AAP-49 sentence, done line, open line rewritten.

Deviations: sparkline is `tile()`'s fourth argument (it had three); ROADMAP open line was 48; finite check on the reasoning count; the render-error path also resets "updated" to the last good time; the orchestrator edited directly (no implementer child).

Verification: `yarn test` 44 files passed, 1 skipped; 520 tests passed, 1 skipped. `yarn typecheck` exit 0 (node, renderer, tests). `grep -n "style\." src/renderer/monitor-view.ts` and `grep -rn 'setAttribute("style"' src/renderer`: no match. No `getSettings` inside the `proxy:monitor` handler. Whitelist plants confirmed by temporary mutation (both fail).

Not run: no build (the app runs from `dist/`); UNTESTED in the window: sparklines, tile layout, render-error notice, Thinking column, outside Strata (hub K1, K5), outside Llama.cpp (no live check).

Follow-ups: llama-server `--metrics` (AAP-50); Gufo status (HUB-43 P2).

Commit status: committed on `AAP-49_monitor-second-cut` (see git log); not merged, not pushed.
