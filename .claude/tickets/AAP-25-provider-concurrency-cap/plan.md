# AAP-25 per-provider concurrency cap

Branch `AAP-25_provider-concurrency-cap` from master. Goal: many apps together cannot flood one subscription; extra requests wait in a FIFO queue.

## Design
- New `src/limiter.ts`: `ConcurrencyLimiter({ limit, maxQueue })`. `acquire(signal?) -> Promise<release>`; FIFO; `limit` 0 = unlimited; `maxQueue` 0 = unlimited, else a full queue throws `ApiError(429, "provider_queue_full")`; a queued waiter whose signal aborts is removed and `acquire` rejects with `QueueAbortedError`; release is idempotent. `stats()` = `{active, queued, limit, maxQueue}`.
- Limiting lives in `ProviderRouter.generate` (one limiter per provider id, so chat, responses, images and the MCP `ask_model` are all covered, stream and non-stream). Release in `finally`: completion, error, abort, timeout. A turn suspended on tool calls returns from `generate`, so it frees its slot; the continuation request queues again (documented, avoids deadlock).
- Waiting counts toward `timeoutMs`: the server's timer/abort signal exists before `generate`; a queued request aborted by timeout/disconnect is dropped and `generate` returns a `cancelled` result (server then answers 504 on timeout, like a running turn).
- `RouterOptions.concurrency?: { maxConcurrent, maxQueue, perProvider?: Record<string, number> }`. Log (info) when a request has to wait. `router.queueStats()` -> per provider; `AcpLike.queueStats?()`; `/healthz` adds `providers: { <id>: { active, queued, max_concurrent, max_queue } }`.
- 429 envelope type `rate_limit_error` (errorEnvelope), `Retry-After` not set.

## Settings
- `server.maxConcurrent` (int >= 0, default 4), `server.maxQueue` (int >= 0, default 0 = unlimited), `providers.<id>.maxConcurrent` (optional int >= 0, absent = inherit global).
- Env: `PROXY_MAX_CONCURRENT`, `PROXY_MAX_QUEUE`, `PROXY_CODEX_MAX_CONCURRENT`, `PROXY_CLAUDE_MAX_CONCURRENT`, `PROXY_ANTIGRAVITY_MAX_CONCURRENT` (0 allowed; need a non-negative parser).
- `ProxyConfig.maxConcurrent/maxQueue`; controller passes them with per-provider overrides to the router.
- Desktop window: server field "Max concurrent requests per provider" + "Max queued"; per-provider card field "Max concurrent (empty = global)". Update `shared/ipc.ts` types, renderer fields, html.

## Tests
- `tests/limiter.test.ts`: FIFO order, limit respected, release on error, abort of queued waiter removes it, abort signal already aborted, unlimited, maxQueue 429, idempotent release.
- Server-level (in `tests/concurrency.test.ts`): router + fake provider, N+k concurrent HTTP requests, max active == N, healthz shows counts, queue full -> 429, client disconnect while queued.
- Settings tests: defaults, env parse incl. 0, per-provider override.
- Run `npm test`, `npm run typecheck`, `npm run build`.

## Docs
README section "Concurrency cap" + env table rows + healthz mention; ROADMAP entry AAP-25.

## Live check
Separate instance on port 7471 (`PROXY_PORT=7471`, `PROXY_MAX_CONCURRENT=2`), <= 10 codex requests `gpt-5.6-luna`, poll `/healthz`, expect active <= 2. Stop it afterwards. Hub instance on 7461 is not touched (it runs old code until restarted).
