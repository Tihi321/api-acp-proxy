---
status: done
request: REQ-0002
repos: [api-acp-proxy]
branch: AAP-28_drop-sampling-params
updated: 2026-11-08
---

# AAP-28 drop sampling params by default

Problem: Scriptorium sends `"temperature": 0.2` on chat completions and the proxy answers 400 `unsupported_parameter`, so its Gemini reviewer and researcher jobs fail. No agent behind the proxy can honour temperature or any other sampling field (see `research.md`), so rejecting them only breaks clients. Branch `AAP-28_drop-sampling-params`, cut from `master`.

Reading of the request: the narrow one. Drop and report the sampling fields; do not implement new parameters (no `stop` emulation, no reasoning-effort mapping).

## Scope

- By default, chat and Responses requests accept and drop the pure sampling fields:
  - chat: `temperature`, `top_p`, `presence_penalty`, `frequency_penalty`, `seed`, `logit_bias`;
  - Responses: `temperature`, `top_p`, `stream_options`.
- Each dropped field present in the request (value not `undefined` / `null`) is reported:
  - response header `x-acp-proxy-ignored-params: temperature, top_p` (comma and space, in the list order above), on both JSON and SSE answers;
  - the Recent requests log: `ActivityEntry.ignoredParams`, shown in the table's features cell as `ignored: temperature`.
- `n: 1` is accepted (it is the only value the proxy can give); `n > 1` stays a 400.
- These stay a 400 `unsupported_parameter`, unchanged: `n > 1`, `logprobs`, `top_logprobs`, `stop`, `functions`, `function_call`, `audio`, `prediction`, `service_tier`, Responses `truncation`, `reasoning`, `include`, `background`, `store: true`, `previous_response_id`.
- Remove the `server.ignoreSampling` setting, its `PROXY_IGNORE_SAMPLING` env var and its checkbox. Reason: `SettingsStore.save` writes every key, so existing settings files hold `"ignoreSampling": false` and a flipped default would never reach them. The old key is stripped by zod on load; the hub's `PROXY_IGNORE_SAMPLING=1` becomes a harmless unknown variable.
- README and ROADMAP updated.

## Out of scope

- A strict mode (the old 400 behaviour) as a setting. No known caller wants it; add it later if one does.
- Emulating `stop` (cutting the answer at a stop string) and passing reasoning effort to the agents (`reasoning_effort` / `reasoning.effort` → Codex `reasoning_effort`, Claude `effort`). Separate tickets; note them in ROADMAP.
- Changing what the passthrough schemas do with unknown fields (they stay silently ignored and are not reported).
- The image endpoint and the MCP `ask_model` tool.

## Files and modules

- `src/api.ts`: field lists, `withoutFields`, `NormalizeOptions`, `normalizeChat`, `normalizeResponses`.
- `src/server.ts`: `handleChat`, `handleResponses`, `Trace`, `track`.
- `src/activity.ts`: `ActivityEntry`.
- `src/shared/ipc.ts`: `ActivityView`.
- `src/renderer/settings.ts`: `renderActivity`, the settings field list (line 43).
- `src/renderer/settings.html`: the checkbox (line 83).
- `src/config.ts`, `src/settings.ts`: the `ignoreSampling` plumbing.
- `README.md`, `ROADMAP.md`.
- `tests/proxy.test.ts`, `tests/activity.test.ts`.

## Tasks

1. **Normalizers drop and report** (`src/api.ts`).
   - Input: raw request body.
   - Change: rename `ignorableChatFields` / `ignorableResponseFields` to `droppedChatFields` (`temperature, top_p, presence_penalty, frequency_penalty, seed, logit_bias`) and `droppedResponseFields` (`temperature, top_p, stream_options`). Remove those names from `unsupportedChatFields` / `unsupportedResponseFields`. `withoutFields` always runs and also returns the names it removed whose value was not `undefined` / `null`. Remove `ignoreSampling` from `NormalizeOptions`. Before `rejectUnsupported` on chat, treat `n === 1` as absent.
   - Output contract: `normalizeChat` and `normalizeResponses` results gain `ignoredParams: string[]` (empty when nothing was dropped, in list order). The returned object does not contain the dropped fields.
2. **Header and trace** (`src/server.ts`).
   - In `handleChat` and `handleResponses`, right after normalizing: when `parsed.ignoredParams.length`, `response.setHeader("x-acp-proxy-ignored-params", parsed.ignoredParams.join(", "))` (set before `json()` / `beginSse()` so `writeHead` merges it) and `trace.ignoredParams = parsed.ignoredParams`. Drop the `ignoreSampling` option from both normalizer calls.
   - `Trace` gains `ignoredParams?: string[]`; `track` copies it into the entry only when non-empty.
3. **Activity log and UI** (`src/activity.ts`, `src/shared/ipc.ts`, `src/renderer/settings.ts`).
   - `ActivityEntry` and `ActivityView` gain `ignoredParams?: string[]` (metadata only: names, never values).
   - `renderActivity`: the features cell appends `ignored: <names>` (joined with ", ") after the feature labels; `-` stays for neither.
4. **Remove the setting** (`src/config.ts`, `src/settings.ts`, `src/renderer/settings.ts`, `src/renderer/settings.html`).
   - Delete `ProxyConfig.ignoreSampling`, `server.ignoreSampling` in the schema, the `PROXY_IGNORE_SAMPLING` `apply` line, the config mapping, the field-list entry and the checkbox label.
5. **Docs** (`README.md`, `ROADMAP.md`).
   - README: remove the `PROXY_IGNORE_SAMPLING` row; add a short "Sampling parameters" note: which fields are dropped, the header, the log, which fields are still 400s, and that `n: 1` is accepted.
   - ROADMAP: an `[x]` line for AAP-28; fix the "Where it stands" bullets that say the hub needs `PROXY_IGNORE_SAMPLING=1`; open `[ ]` lines for `stop` emulation and reasoning-effort pass-through.
6. **Tests** (see below), then `yarn typecheck`, `yarn test`, `yarn build`.
7. **Live check**: start the proxy from the branch on a spare port, send Scriptorium's request shape (chat, `temperature: 0.2`, `max_tokens`, a Gemini model through Antigravity) with curl, confirm 200 and the header, and see the row in the app's Recent requests (or `/healthz` if the UI is not run). Then one Scriptorium reviewer job against it if the user wants.

## Acceptance criteria and the tests that prove each

| # | Criterion | Proof |
|---|---|---|
| A1 | A chat completion with `temperature: 0.2` answers 200, with header `x-acp-proxy-ignored-params: temperature`, and its Recent requests entry has `ignoredParams: ["temperature"]` | New test T1 (reproduction) |
| A2 | Chat drops all six sampling fields and Responses drops its three, reporting them in order; `n: 1` is accepted | Rewritten test T2 |
| A3 | `n: 2`, `logprobs: true` and `stop` still answer 400 `unsupported_parameter` with the right `param` | Rewritten test T2 |
| A4 | A request with no sampling fields has no header and no `ignoredParams` | T1's existing neighbour, "records a plain chat request ..." in `tests/activity.test.ts`, keeps passing (its `toMatchObject` plus an `ignoredParams` undefined check added to it) |
| A5 | The setting is gone and an old settings file with `"ignoreSampling": false` still loads | `yarn typecheck` (no references left); existing `tests/settings.test.ts` passes; manual: start the app with the current settings file |
| A6 | The UI shows `ignored: temperature` in the row | Live check (task 7); UNTESTED until run in the app |

Tests (test-discipline: two tests, the rest are edits of existing ones):

- **T1, reproduction, fails before the fix** (`tests/activity.test.ts`, "activity from the server"): `serve(activity)`, POST `/v1/chat/completions` with `chat({ temperature: 0.2 })`; expect status 200, `headers["x-acp-proxy-ignored-params"]` to be `"temperature"`, and `(await lastEntry(activity)).ignoredParams` to equal `["temperature"]`. The file's `call` helper returns `headers` as well (one-line change). Before the fix the status is 400 with `unsupported_parameter`.
- **T2** (`tests/proxy.test.ts`): replace "drops sampling fields with ignoreSampling, and still rejects behaviour-changing ones" with "drops sampling fields and still rejects contract-changing ones": `normalizeChat` with all six chat fields plus `n: 1` resolves, has none of them, and `ignoredParams` equals the six in order; `normalizeResponses` with `temperature` and `stream_options` reports `["temperature", "stream_options"]`; `n: 2`, `logprobs: true` and `stop: ["x"]` reject with `/n/`, `/logprobs/`, `/stop/`.
- Edits: line 41 uses `n: 2` instead of `temperature: 0`; lines 154-157 drop the `{ ignoreSampling: true }` argument (remove the duplicate assertion); line 223 (Responses `stream_options` rejected) becomes resolves, or is deleted since T2 covers it.

No renderer test: the cell text is one line and the live check covers it.
