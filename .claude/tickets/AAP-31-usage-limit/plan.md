---
status: done
request: REQ-0025
repos: [api-acp-proxy]
branch: AAP-31_usage-limit
updated: 2026-11-16
---
# AAP-31: a provider that hit its usage limit is refused fast with a typed 429

Research: `research.md` (same folder). Request: creative-hub `REQ-0025`, bug 7. Hub side: creative-hub `HUB-35`
(`C:\projects\Personal\creative-hub\.claude\tickets\HUB-35-usage-limit-status\plan.md`), which reads the `/healthz` field below.
Consumer: Scriptorium's bug-2 fix (an SCP ticket, planned separately) reads the 429 body below to try the next model.

## Scope

- Codex: detect a usage-limit failure (`usageLimitExceeded` / `usage_limit_exceeded`, or the adapter's "You've hit your
  usage limit" message on the failure path) and parse the reset time from "try again at <time>".
- Reset time has no zone: read it as **local machine time** (the rollout logs show 14:33 local = 13:33Z on 2026-11-15).
  Documented in the README.
- Parse failure, a time in the past, or a time over the cap (31 days): use a cooldown, default **60 minutes**, setting
  `server.usageLimitCooldownMinutes` / env `PROXY_USAGE_LIMIT_COOLDOWN_MINUTES`.
- Router keeps per provider `exhaustedUntil` (epoch ms) and refuses every request for that provider **before the limiter**
  (nothing queues) with `ApiError(429, "usage_limit_exceeded")` and `Retry-After`. The first failing request also answers
  this 429 (not the 503 of today).
- The state clears when `now >= until` (checked lazily on each read) and on any later success of that provider.
  In memory only: a proxy restart forgets it and the first request re-learns it (one ~2.4 s failure).
- Streams get a real HTTP 429: the check runs in the pre-stream `checkPrompt` hook (`src/server.ts:171`, `:244`) as well as
  in `generate` (images endpoint, MCP `ask_model`).
- Visibility: models stay in `/v1/models`, each entry of an exhausted provider carries `exhausted_until`; `/healthz`
  `providers.<id>.exhausted_until`.
- Opt-in generic matcher for any provider: setting `providers.<id>.usageLimitPattern` (a regex, case-insensitive, default
  absent). Judged safe because it is off by default, runs only on the failure path (the error of a failed turn, never an
  answer's text), and without a parsed reset time it locks the provider only for the cooldown.

## Out of scope

- Built-in Claude and Antigravity matchers: their limit wording and codes were never captured. Claude's `_claude/rateLimit`
  hint (`status: "rejected"`, `resetsAt`, `src/acp-provider.ts:380-383`) is the likely signal; a later ticket once a real
  rejection is captured. Until then the user can set `usageLimitPattern` for them.
- `rate_limited` / `rateLimitExceeded` / `serverOverloaded`: transient, stay as today (never mark exhausted).
- Persisting the state across restarts; showing it in the desktop provider card; hiding exhausted models.
- Taking back text the agent already streamed before the failure (see task 1: the adapter may stream the limit message as
  text first; the error event then follows in the same stream).
- Plan-limits probe (`router.probePlanLimits`, `src/router.ts:194`) is not refused: it is how the user sees the limit.

## Files and modules

| File | Change |
|---|---|
| `src/usage-limit.ts` (new) | `UsageLimitError` (extends `ApiError`, status 429, code `usage_limit_exceeded`, carries `resetText?`); `parseResetTime(text, now): number \| undefined`; `errorText(error)` (message + `JSON.stringify(error.data)`, the trick of `src/providers/claude.ts:176`); `matchCodexUsageLimit(error)`; `matchPattern(error, regex)` |
| `src/api.ts:114-124` | `ApiError` gets optional `retryAfterSeconds` and `details: Record<string, unknown>`; `errorEnvelope` spreads `details` into `error` |
| `src/providers/codex.ts:27-69` | descriptor gains `mapError` (Codex has none today) returning `UsageLimitError`; if task 1 finds path B, also `usageLimitFromUpdate` |
| `src/provider.ts:146-147` | `ProviderDescriptor.usageLimitFromUpdate?(update)` (only if path B is confirmed) |
| `src/acp-provider.ts:124` | `AcpProviderOptions.usageLimitPattern?: string` |
| `src/acp-provider.ts:833-838`, `:1084-1089` | after `descriptor.mapError` returns nothing, apply `usageLimitPattern`; path B: the session handler records a usage-limit update and the turn throws `UsageLimitError` instead of returning its text |
| `src/providers/{codex.ts:103,claude.ts:193,antigravity.ts:237}` | pass `usageLimitPattern` from provider settings |
| `src/router.ts:11-21` | `RouterOptions.usageLimit?: { cooldownMs: number; maxMs?: number }`, `now?: () => number` (tests) |
| `src/router.ts:138-150` | `entries()` adds `exhaustedUntil` (ISO) to that provider's entries; `ListedModel` (`:22`) gets the field |
| `src/router.ts:172-191` | `checkPrompt` and `generate` call `refuseIfExhausted(provider)` first; `generate` wraps both provider calls (`:181` and `:189`): `UsageLimitError` -> set state, throw the contract error; success -> clear state |
| `src/router.ts:211-219` | `exhaustedProviders(): Record<string, string>` (id -> ISO), only live entries |
| `src/acp.ts:39-41` | `AcpLike.exhaustedProviders?()` |
| `src/server.ts:376-385` | `healthProviders` adds `exhausted_until`; return providers when any of the three sources has data |
| `src/server.ts:407` | `/v1/models` entry adds `exhausted_until` when set |
| `src/server.ts:416` | an `ApiError` with `retryAfterSeconds` sets `Retry-After` |
| `src/settings.ts:50-60, :72/:87/:101, :254, :282`; `src/config.ts:20-28` | `server.usageLimitCooldownMinutes` (default 60, min 1) + env; `providers.<id>.usageLimitPattern` (string, must compile as a RegExp) |
| `src/controller.ts:218` | pass `usageLimit: { cooldownMs }` to the router |
| `tests/fixtures/fake-acp.mjs:380` | reuse `FAKE_ACP_PROMPT_ERROR` (code, message, data) for path A; path B only: a new `FAKE_ACP_PROMPT_TEXT_FAIL` that streams text then ends `end_turn` with the update task 1 finds |
| `README.md:126, :193` | `/healthz` and `/v1/models` fields; a "Usage limit" section: what is detected, local-time reading, cooldown setting, `usageLimitPattern` |
| `ROADMAP.md:29` | line below (director adds it) |

## Tasks for workers

Run in order; 2 and 3 can run in parallel after 1.

1. **Confirm how the Codex adapter reports the failure (before writing any matcher).**
   Inputs: `node_modules/@agentclientprotocol/codex-acp/dist/index.js` 35505-35520, 35640-35665, 36270-36335, 36414-36470,
   47754, 51015-51065, 51300-51330, 51428-51440, 51530-51545; the proxy's `initialize` (`src/acp-provider.ts:404`, sends
   `clientCapabilities: {}`); `%APPDATA%\api-acp-proxy\codex-home\archived_sessions\rollout-2026-11-15T14-3*.jsonl`
   (read only; never copy account data into the repo).
   Planner's reading, to confirm or correct: with no AIR capability the adapter does not send typed session failures;
   for `usageLimitExceeded` it first streams the readable message as an `agent_message_chunk` and sets
   `failure = RequestError.internalError({ message: additionalDetails ?? message, codexErrorInfo: "usageLimitExceeded", additionalDetails? })`,
   then the prompt throws it (51320-51323, 51432-51435): **path A**, a JSON-RPC error -32603 with `data.codexErrorInfo`.
   The v2 path (51040-51063) may instead end the prompt `end_turn` after the text: **path B**.
   Output: `notes.md` in this folder: which path(s) the bundled adapter takes for a non-AIR client, the exact error/update
   shape, and the reset text formats seen in the logs (with date and year, time only, other). If path B is real, the
   matcher for it reads a `session_info_update` with `_meta.codex.error.codexErrorInfo === "usageLimitExceeded"` (36041-36047);
   if the only path B signal is the answer text, match only a Codex turn whose whole text is the adapter's message
   (`^\s*You've hit your usage limit\b`, under 600 characters, no tool calls, no images), and say so in `notes.md`.
2. **Detection and parsing** (`src/usage-limit.ts`, `src/providers/codex.ts`, `src/acp-provider.ts`, settings for the pattern).
   Contract: `matchCodexUsageLimit` is true for `usageLimitExceeded`, `usage_limit_exceeded`, or `/hit your usage limit/i`
   in `errorText(error)`; false for `rateLimitExceeded`, `serverOverloaded`, anything else. `parseResetTime` accepts
   `try again at <Mon> <D>[st|nd|rd|th], <YYYY> <h:mm> AM|PM` (local: `new Date(y, m, d, h, min)`), and a time-only
   `try again at <h:mm> AM|PM` (today local, tomorrow if already past); anything else -> `undefined`. Add formats found in task 1.
3. **State, refusal and visibility** (`src/api.ts`, `src/router.ts`, `src/acp.ts`, `src/server.ts`, `src/controller.ts`,
   cooldown setting). Until = parsed reset, or `now + cooldown` when undefined, in the past or more than 31 days ahead.
   Retry-After = `ceil((until - now) / 1000)`, at least 1. The check is a `Map.get` plus a compare (O(1)); other providers
   are untouched. A refused request never reaches the limiter or the agent and is not counted in the usage totals
   (confirm where usage is recorded).
4. **Tests** (below), README, `npm run typecheck`, `npm test` (use `fnm exec --using default` if node is not on PATH).
   No completion request, restart or load test against the running proxy on 8787.

## Contract

Identical in HUB-35's plan. Consumers detect the case by `error.code === "usage_limit_exceeded"`, never by the status alone
(`provider_queue_full` is also a 429).

Refusal (and the first failing request), HTTP:

```
HTTP/1.1 429 Too Many Requests
Content-Type: application/json
Retry-After: 1203420

{
  "error": {
    "message": "Codex has hit its usage limit; it resets at 2026-11-29 11:07 (local time). Use another model or wait.",
    "type": "rate_limit_error",
    "param": "model",
    "code": "usage_limit_exceeded",
    "provider": "codex",
    "exhausted_until": "2026-11-29T10:07:00.000Z",
    "retry_after": 1203420
  }
}
```

- `provider`: the provider id (`codex`, `claude`, `antigravity`), the prefix of the model id.
- `exhausted_until`: ISO 8601 in UTC (`Z`), always present. `retry_after`: whole seconds from now, at least 1, always
  present, equal to the `Retry-After` header.
- `message` is for people; do not parse it.
- A stream refused before it starts gets this same HTTP answer (JSON, not SSE). Only a stream whose first request fails
  mid-turn gets it as an SSE event `data: {"error": {...same object...}}` with no `Retry-After` header.

`/healthz` (unauthenticated) and `/v1/models`:

```
GET /healthz
{ "status": "ok", "uptime_seconds": 28994,
  "providers": { "codex": { "active": 0, "queued": 0, "max_concurrent": 4, "max_queue": 0,
                            "exhausted_until": "2026-11-29T10:07:00.000Z" } } }

GET /v1/models
{ "object": "list", "data": [ { "id": "codex/gpt-6-luna", "object": "model", "created": 0, "owned_by": "openai",
                                "exhausted_until": "2026-11-29T10:07:00.000Z" } ] }
```

`exhausted_until` is absent when the provider is not exhausted (including after the time has passed).

## Acceptance criteria

| # | Criterion | Proven by |
|---|---|---|
| A1 | A Codex usage-limit failure answers 429 `usage_limit_exceeded` with the contract body and `Retry-After`; the next request is refused without the agent seeing a prompt; another provider still answers | T1 (reproduction) |
| A2 | `/healthz` and `/v1/models` show `exhausted_until` for that provider only, models still listed | T1 |
| A3 | A stream to an exhausted provider gets an HTTP 429 JSON answer, not an SSE 200 | T1 |
| A4 | The state clears at `until` (fake clock) and on a later success | T3 |
| A5 | Reset parsing: dated text, suffixes, 12 AM / 12 PM, time-only, garbage -> cooldown; past or > 31 days -> cooldown | T2 |
| A6 | `rateLimitExceeded` and a plain failure do not mark exhausted (503 as today) | T2 |
| A7 | `usageLimitPattern` set on a provider marks it exhausted for the cooldown; unset, the same error is a 503 | T2 |
| A8 | Path B (only if task 1 confirms it): the update/text turn gives the 429 | one case added to T1 |
| A9 | typecheck and the whole suite pass | `npm run typecheck`, `npm test` |

## Tests (few, per test-discipline)

- **T1 reproduction, HTTP level** (new `tests/usage-limit.test.ts`, pattern of `tests/prompt-limit.test.ts`): a Codex
  provider on the fake agent (`codexDescriptor({ acpCommand: process.execPath, acpArgs: [fixture] })`) with
  `FAKE_ACP_PROMPT_ERROR={"code":-32603,"message":"Internal error","data":{"message":"You've hit your usage limit. ... or try again at Nov 29th, 2026 11:07 AM.","codexErrorInfo":"usageLimitExceeded"}}`
  and the router's `now` fixed at 2026-11-26 local (so the parsed time, not the cooldown, is used; `exhausted_until`
  equals `new Date(2026, 10, 29, 11, 7).toISOString()`), plus a second provider that answers. Request 1 (chat): **today 503 `backend_unavailable`** (fails before the fix);
  after: 429, contract body, `Retry-After`. Request 2 (chat, `stream: true`): 429 JSON, `FAKE_ACP_LOG` shows one
  `session/prompt` only. `/healthz` and `/v1/models` carry `exhausted_until` on codex only; the other provider answers 200.
- **T2 unit** (`tests/usage-limit.test.ts`, no agent): `parseResetTime` table; `matchCodexUsageLimit` true/false table
  (`usageLimitExceeded`, `usage_limit_exceeded`, message only, `rateLimitExceeded`, plain); `matchPattern` with and without a pattern.
- **T3 router** (extend `tests/router.test.ts` with a stub provider, `now` injected): exhausted -> refused without calling
  the provider; clock past `until` -> called again; a success clears; the other provider is never refused.

## Reproduction (fails before the fix)

T1's first request: today `src/acp-provider.ts:838` wraps the fake failure as `AcpUnavailableError` and
`src/server.ts:417` answers **503 `backend_unavailable`**; the second request runs the agent again (two `session/prompt`
lines in `FAKE_ACP_LOG`). After the fix: 429 `usage_limit_exceeded`, and the second request is refused with no new prompt.
Run T1 on master first and record the failure in the changelog.

## ROADMAP.md entry (the director adds it, under "Limits seen from the hub", after line 29)

```
- [ ] A subscription's usage limit (Codex until 2026-11-29) is passed through as a 503 and every request runs the agent again: mark the provider exhausted until its reset time (cooldown when unparsed), refuse fast with 429 `usage_limit_exceeded` and `Retry-After`, show `exhausted_until` in `/healthz` and `/v1/models`. (AAP-31)
```

## Deploy note

The proxy on 8787 serves REQ-0024's live production. Merge and build any time; **restart the proxy only after REQ-0024's
production has finished and the user says go**. After the restart, `GET /healthz` must answer as before. The state is in
memory, so `exhausted_until` appears only after the next real Codex failure: the live check is one tiny Codex request
(only with the user's OK, while the limit lasts until 2026-11-29), then `/healthz`, `/v1/models` and HUB-35's
`hub.ps1 status`. Until then mark the live criteria UNTESTED.
