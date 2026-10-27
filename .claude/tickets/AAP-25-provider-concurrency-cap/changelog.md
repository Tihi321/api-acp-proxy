# Changelog AAP-25

## 2026-10-27 per-provider concurrency cap
Branch `AAP-25_provider-concurrency-cap`. Requests above a per-provider cap wait in a FIFO queue.

- `src/limiter.ts` (new): semaphore with FIFO queue, abort removes a waiter, optional queue cap (429 `provider_queue_full`).
- `src/router.ts`: one limiter per provider around `generate`; log line on wait; `queueStats()`.
- `src/settings.ts`, `config.ts`, `controller.ts`: `server.maxConcurrent` (4), `server.maxQueue` (0), `providers.<id>.maxConcurrent`; env `PROXY_MAX_CONCURRENT`, `PROXY_MAX_QUEUE`, `PROXY_<CODEX|CLAUDE|ANTIGRAVITY>_MAX_CONCURRENT` (0 allowed).
- `src/server.ts`, `acp.ts`, `api.ts`: `/healthz` per-provider counts; 429 envelope type `rate_limit_error`.
- Desktop window: `renderer/settings.html|ts`, `shared/ipc.ts`: server fields and one field per provider card.
- README section and env rows, ROADMAP entry.

Deviation: implemented directly by the orchestrator, no implementer child. A tool-call turn frees its slot when it returns (documented).

Verification: `npm run typecheck`, `npm run build`, `npx vitest run` 730 pass, 2 skipped (16 new). Live on port 7471, cap 2, 10 codex requests: all 200, peak active 2, queued up to 8.
Not verified: desktop settings window in a running Electron app; Claude/Antigravity under the cap; hub instance (7461) still runs old code until restarted.
Commit: committed on the branch, not pushed.
