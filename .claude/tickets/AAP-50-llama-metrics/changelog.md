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

## Polish 1

1. A speed is shown only when it is a finite number above 0 (`rate()` in `src/local-monitor.ts`, Strata and Llama paths); test in `tests/local-monitor.test.ts`. AAP-47/49/50 Monitor.
2. Thinking tokens from the upstream `reasoning_tokens` count only when finite (`src/providers/local-openai.ts`); test in `tests/local-openai.test.ts`. AAP-48.
3. README Monitor paragraph: the opening parenthesis now agrees with the AAP-50 sentence (Llama.cpp shows slots and speed). AAP-50.
4. Llama Prefill or Decode dash gets the reason "no prompt read yet" or "no reply yet" when the other speed exists (`src/renderer/monitor-view.ts`). AAP-50.
5. A flat sparkline sits on the baseline at the scale minimum, at the top at a given maximum, mid-height only with no bounds (`spark()` in `src/renderer/monitor-view.ts`). AAP-47/49/50 Monitor.
