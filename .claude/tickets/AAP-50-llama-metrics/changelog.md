# AAP-50 changelog

## 2026-11-22 - AAP-50: llama-server --metrics, Llama speed on the Monitor, per-request Llama context

Branch `AAP-50_llama-metrics` (cut from AAP-49 head ccb52d5).

- `src/llama-args.ts`: `buildLlamaArgs` adds `--metrics` once after `--alias` (not when `extraArgs` has it as a whole token). Embedding args and key unchanged.
- `src/local-monitor.ts`: `MonitorFetch` gains `text()`; `MAX_METRICS_BYTES`, whitelist `parseLlamaMetrics` (four counters, finite non-negative numbers), `readText`; `mapLlama` takes the metrics text, gives `speed` / `speedMissing`, and `context` is slot 0's `n_ctx` (fallback `default_generation_settings.n_ctx`); `fetchEngine` reads `/metrics` on 127.0.0.1:<port> unless `/props` says `endpoint_metrics: false`.
- `src/shared/ipc.ts`: `EngineView.speedMissing`, `context` comment.
- `src/renderer/monitor-view.ts`: Decode and Prefill tiles show Llama speed ("average since the model started") or a reason; Strata unchanged.
- `tests/llama-args.test.ts`, `tests/local-monitor.test.ts`: extended tests 1-3 (no new test case).
- `README.md`, `ROADMAP.md`: AAP-50 paragraph, flag-table row, done line, shortened open line.

Deviations: none from the plan; adapted to AAP-49's moved lines (Decode tile keeps its sparkline argument).

Verification: `yarn typecheck` (three configs) exit 0; `yarn test` 520 passed, 1 skipped. Mutation (raw metrics text copied into the view) made the SECRET check fail; restored.

UNTESTED: the window (no Electron harness); b12613's real `/metrics` text; per-slot `n_ctx` with `-np` auto on a chat server; unsloth build with `--metrics`; external server without `--metrics`. Hub K1.

Commit: committed on AAP-50_llama-metrics (not merged, not pushed).
