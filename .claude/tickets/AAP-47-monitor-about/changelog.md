# AAP-47 changelog

## 2026-11-22 AAP-47 Monitor and About pages for the loaded local model

Outcome: read-only Monitor and About pages for the local model the proxy holds (Strata, Llama.cpp, Gufo or none), built and unit-tested; the window is UNTESTED until hub K1.

### api-acp-proxy (branch `AAP-47_monitor-about`, cut from `AAP-46_strata-vision-and-cache` ccfcfe3)

- `src/local-monitor.ts` (new): `mapStrataMetrics` and `mapLlama` whitelist numeric/enum fields (only `version`, `state`, `finish`, `kv`, `drafting`, `gpu_name` strings), speeds rounded to 0.1 t/s, engine requests newest first, at most 12; `fetchEngine` GETs only `127.0.0.1:<port>` (Strata `/metrics` with a bearer key when set; Llama `/props` + `/slots`; Gufo no request) with a 1.5 s timeout and errors "not reachable", "HTTP n", "unexpected answer"; `cpuSampler`; helpers `localState`, `hostView`, `contextFromArgs`.
- `src/shared/ipc.ts`: `EngineRequestView`, `EngineSlotView`, `EngineView`, `MonitorView`; `ProxyApi.getMonitor`.
- `src/controller.ts`: `queueStats()` pass-through to the router.
- `src/electron/main.ts`: `handle("proxy:monitor")` builds the snapshot from the launcher, the cached local settings, the queue, `fetchEngine` (only when the server is `ready`), `os` and the status; the window gets `apiKeyNeeded`, never a key.
- `src/electron/preload.cts`: `getMonitor`.
- `src/renderer/monitor-view.ts` (new): renders both pages; `setTimeout` poll every 2 s while Monitor/About is shown and the document is visible; `hidden()` and a hidden window stop it; a generation counter keeps an in-flight call from rendering or rescheduling after `hidden()`; failures show "Engine not reachable" and keep polling; bars are `<progress>` elements (no inline styles).
- `src/renderer/settings.ts`: `views` gains `monitor`, `about`; `showView` calls `shown`/`hidden`.
- `src/renderer/settings.html`: nav items Monitor and About after Requests; two view sections in the existing card/stats/table markup.
- `src/renderer/settings.css`: tile grid and bar classes in the existing tokens.
- `tests/local-monitor.test.ts` (new): the four planned tests.
- `README.md`: the plan's "Monitor and About pages (AAP-47)" paragraph after the Overview paragraph.
- `ROADMAP.md`: the plan's `[x]` line after AAP-46's, and the `[ ]` second-cut line after the Gufo follow-ups line.

### Deviations

- Extra exported helpers `hostView`, `contextFromArgs` (and `localState`, named in test 4) in `src/local-monitor.ts`, to keep `main.ts` small.
- The engine is read only in launcher state `ready`; `starting` shows "Starting".
- The handler calls `proxy.getSettings()` (which runs the controller's `load()`) on every poll for `server.apiKey`; the local settings caches are not refreshed per poll.

### Verification

- `yarn typecheck` (node and renderer configs): exit 0.
- `yarn test`: 44 files passed, 1 skipped; 520 tests passed, 1 skipped (includes the 4 new tests).
- Not run: `yarn build`, the window, a live read through the handler (hub K1); Llama on 8082; Gufo; Strata with a key (unit only).

### Follow-ups

- ROADMAP "Monitor second cut" line (sparklines, reasoning tokens, llama `--metrics`, Gufo status, external server).

Commit status: committed in 964d535 (code); ticket records in the next commit; not merged, not pushed.
