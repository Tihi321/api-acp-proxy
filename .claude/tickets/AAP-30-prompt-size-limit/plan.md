---
status: done
request: REQ-0009
repos: [C:/projects/Personal/api-acp-proxy]
branch: AAP-30_prompt-size-limit
updated: 2026-11-11
---

# AAP-30 per-provider prompt size limit

## Problem

The Antigravity ACP agent (`agy_acp_server.exe`) keeps only the first ~192,000 characters of a prompt and silently drops the rest (measured live, see `C:/projects/Personal/scriptorium/.claude/tickets/REQ-0009-acp-review-json/research.md`, probes in `C:/projects/Personal/scriptorium/.claude/temp/req0009/probe.py` and `probe-out.jsonl`: 250k and 400k character prompts both stop at character ~191,800-192,000; both Antigravity models behave the same, so the cap belongs to the agent). The proxy joins preamble, `[system]`, `[user]` and `[output format]` into one text block (`src/api.ts:549-565` `buildPrompt`) and sends it with `session/prompt` (`src/acp-provider.ts:805-806` and `:1032-1034`) with no size check. Clients get a confident answer to a cut prompt, with no error.

Goal: the proxy refuses a prompt the agent would cut, with an OpenAI-style 400 whose message starts with "The prompt is too long". Scriptorium's `isContextError` (`C:/projects/Personal/scriptorium/src/engine/models/router.ts:345-348`) matches `prompt is too long` (and `context length`); the router then skips retries and moves to the next model (`router.ts:274-276`). Scriptorium's `httpError` keeps only the first 300 characters of the error body (`src/engine/models/types.ts:118-125`), so the phrase must sit at the start of `error.message`.

## Decisions

| # | Decision | Why |
|---|---|---|
| D1 | A per-provider limit in characters, `maxPromptChars`. Descriptor default: Antigravity `180_000`; Codex and Claude none (unlimited). Setting `providers.<id>.maxPromptChars` (int >= 0, optional): absent = the descriptor default, `0` = unlimited, `N` = N. | ~6% margin under the measured ~192k cap (exact cap 191,792-191,987 in probe C; a newer agent build may change it, so it is a setting). Codex and Claude were never probed (research, open questions); no evidence of a cut, so no default. |
| D2 | What is measured: the sum of `text.length` over all **text** blocks of the prompt the provider builds for a fresh session from the **whole** request (preamble, every `[role]` block, `[tool result]`/`[tool call]` lines, `[output format]`), the same `buildPrompt` call `generate` makes. Image blocks do not count (their base64 is not prompt text; whether the agent counts them is unknown). Text split by images is summed as one total, not per block. | It is what the agent receives. Summing across blocks is conservative: per-block vs whole-prompt cap is untested (research risk 2). |
| D3 | Session reuse and resumed tool turns are measured on the whole request too, not only on the part sent. | `server.reuseSessions` is off by default and off on the live instance (checked 2026-11-11). With reuse on, the agent holds the earlier turns anyway and whether its cap applies to the session total is unknown. Measuring the whole request makes the answer deterministic, needs no session state, and lets the check run before the queue and before an SSE stream starts. Documented in the README. |
| D4 | Error: HTTP 400, `type: "invalid_request_error"`, `code: "context_length_exceeded"` (OpenAI's code), `param: "messages"` (`"input"` for `/v1/responses`), message `The prompt is too long for <displayName>: <N> characters, the limit is <M>. The agent would silently drop the rest, so the proxy refused it. Shorten the prompt or use another model.` Plain integers, no locale grouping. | Matches Scriptorium's regex in the first 30 characters; `context_length_exceeded` is what OpenAI clients already know. |
| D5 | Where it is checked: (a) `AcpProvider.checkPrompt()` at the very start of `generate` (before the agent starts, covers every caller including the MCP endpoint's `ask_model` and `generate_image` and the legacy `AcpBridge`); (b) `ProviderRouter.generate` before `limiter.acquire` (an oversized request never takes or waits for a slot); (c) `server.ts` `handleChat` and `handleResponses` call `bridge.checkPrompt?.()` **before** `beginSse`, so a streaming request gets a real HTTP 400, not an SSE error event after a 200. | Scriptorium streams. Its SSE error path would still match the regex (`openaiCompat.ts:104` puts the error JSON in the message), but a status-less error is a weaker contract. Computing the prompt three times costs a few ms on 200k characters. |
| D6 | `/v1/models` adds `max_prompt_chars: <M>` to each model entry whose provider has a limit (absent otherwise). No `context_length`. | Cheap (router entries already carry the provider) and exact. `context_length` means tokens (OpenRouter convention, read by Scriptorium's `listedModel`); the cap is characters and 192k characters measured 45k-58k tokens depending on the text, so a token number would be a guess. See open question 2. |
| D7 | Endpoints covered: `POST /v1/chat/completions`, `POST /v1/responses`, `POST /v1/images/generations` (via the provider check; its prompts are short), `POST /v1/mcp` `ask_model` / `generate_image` (via the provider check; the MCP endpoint already turns an `ApiError` into a tool error `context_length_exceeded: The prompt is too long ...`, `src/mcp-endpoint.ts:137-142`). There is no Anthropic Messages endpoint (`src/server.ts:354` lists all routes). | Brief asked for every path that reaches the agent. |

## Scope

- Character limit per provider, checked before the agent sees the prompt, with a 400 `context_length_exceeded` "prompt is too long" error, streaming and non-streaming, chat and Responses (and every other path through the provider).
- Setting `providers.<id>.maxPromptChars` for codex, claude, antigravity; env `PROXY_CODEX_MAX_PROMPT_CHARS`, `PROXY_CLAUDE_MAX_PROMPT_CHARS`, `PROXY_ANTIGRAVITY_MAX_PROMPT_CHARS` (0 allowed); one field per provider page in the settings window (the "Capacity" card, next to Max concurrent).
- `max_prompt_chars` in `/v1/models`.
- README section, env rows, ROADMAP line.
- Rebuild of `release/win-unpacked` and a live check on 8787 (done by the user, steps below).

## Out of scope

- Splitting a long prompt into several text blocks to get round the cap (needs a multi-block probe first; research open question 1).
- Probing Codex or Claude for a similar cap, or giving them a default limit.
- Narrowing the exact Antigravity cap further.
- Counting image size against the limit.
- Checking only the part a reused session sends (D3), and any change to session reuse or tool-turn resume.
- A token-based limit or a `context_length` field in `/v1/models` (D6).
- The MCP `list_models` tool output (it could show the limit too; listed as an extra idea).
- Everything on the Scriptorium side: the `context` values for `acp/antigravity/*` in the data-folder `config/providers.md`, a router pre-check, the `chatJson` repair fixes (REQ-0009 handles those as separate Scriptorium tickets).
- Starting, stopping or reconfiguring the proxy running on 8787 during implementation.

## Files and modules

| File | Change |
|---|---|
| `src/api.ts` | New exports next to `serializePrompt` (`:568`): `promptChars(blocks: PromptBlock[]): number` (sum of text block lengths) and `promptTooLong(displayName: string, chars: number, limit: number): ApiError` (D4). |
| `src/provider.ts` | `ProviderDescriptor.maxPromptChars?: number` (doc: default limit, absent = unlimited). `Provider.maxPromptChars?: number` (readonly, the effective limit, absent = none) and `Provider.checkPrompt?(messages: Message[], options?: GenerateOptions): void` (throws the 400). |
| `src/acp-provider.ts` | `AcpProviderOptions.maxPromptChars?: number` (the setting: absent = descriptor default, 0 = unlimited). Constructor (`:227`) sets `readonly maxPromptChars` (undefined when 0/absent). New private `promptBlocks(messages, options)` that holds both current `buildPrompt` calls (plain path `:805`: with `descriptor.promptPreamble`, `options.images`, `mcp`, `search`; tools path `:1032`: `undefined` preamble, tool prompt, `search`), chosen by `options?.tools?.length` exactly like `generate` does at `:751`. Both call sites use it (no behaviour change). Public `checkPrompt(messages, options)`: no limit -> return; else `promptChars(this.promptBlocks(messages, options)) > limit` -> throw `promptTooLong(this.displayName, n, limit)`. `generate` calls `this.checkPrompt(messages, options)` as its first statement, before `generateWithTools` dispatch and outside the `try` (so `descriptor.mapError` never sees it and no agent starts). |
| `src/providers/antigravity.ts` | Descriptor `maxPromptChars: 180_000` with a comment (agent keeps ~192,000 characters, measured 2026-11, REQ-0009). Registration `create` (`:235`) passes `maxPromptChars: providerSettings.maxPromptChars as number \| undefined` in the `AcpProvider` options. `AntigravityOptions.settings` type unchanged (the setting goes to the provider options, not the descriptor). |
| `src/providers/codex.ts`, `src/providers/claude.ts` | Registration `create` (`codex.ts:103`, `claude.ts:193`) passes `maxPromptChars` the same way. |
| `src/router.ts` | `ListedModel.maxPromptChars?: number`, filled in `entries()` (`:138`) from `provider.maxPromptChars` when set. New `checkPrompt(model, messages, options)`: resolve (unknown model -> return, `generate` answers the 404), then `provider.checkPrompt?.(messages, options)`. `generate` (`:170`) calls it after `resolve` and before `limiter.acquire`. |
| `src/acp.ts` | `AcpLike.checkPrompt?(model: string, messages: Message[], options?: GenerateOptions): void` (doc: throws a 400 before anything starts). `ModelEntry.maxPromptChars?: number`. |
| `src/server.ts` | `handleChat`: after `options` is built (`:169`) and before `if (parsed.stream)` (`:177`): `bridge.checkPrompt?.(parsed.model, parsed.conversation, options)`. `handleResponses`: same after `:241`, wrapped as `try { ... } catch (error) { throw forResponses(error); }` so `param` is `input`. Both throws reach the top-level catch (`:410-415`), which answers JSON 400 and sets `trace.error`. `/v1/models` (`:404`): add `...(model.maxPromptChars ? { max_prompt_chars: model.maxPromptChars } : {})`. |
| `src/settings.ts` | `maxPromptChars: z.number().int().min(0).optional()` in `providers.codex`, `.antigravity`, `.claude` (doc comment as for `maxConcurrent`). Env rows next to `:249-251` with `parseNonNegative`: `providers.<id>.maxPromptChars` from `PROXY_<ID>_MAX_PROMPT_CHARS`. |
| `src/shared/ipc.ts` | `maxPromptChars?: number` on the three provider setting views (`:40-47`). |
| `src/renderer/settings.ts` | Three field entries `{ path: "providers.<id>.maxPromptChars", kind: "number", scope: "<id>", optional: true }` after each `maxConcurrent` entry (`:47`, `:51`, `:58`). |
| `src/renderer/settings.html` | In each provider's Capacity card (codex `:214`, claude `:258`, antigravity `:317`), a field built like the max-concurrent one: label "Max prompt characters", hint `(empty = 180000, Antigravity's limit)` on Antigravity and `(empty = no limit)` on Codex and Claude, `<small>` "Longer prompts are refused with a 400 \"prompt is too long\" instead of being cut by the agent. 0 = no limit.", plus the `data-note-for` and `data-error-for` smalls. Same ids/data-role conventions; no inline styles (CSP). |
| `tests/prompt-limit.test.ts` (new) | The tests below. |
| `README.md` | New section "Prompt size limit" after "Concurrency cap" (`:117`); env table rows after `:103`; a sentence in the Google Antigravity section (`:162`) and in "Supported API" (`:180`) about `max_prompt_chars`. |
| `ROADMAP.md` | One `[x]` line for AAP-30 after AAP-29. |

## Tasks for workers

Order: T1, then T2 and T3 in parallel, then T4. T1 and T2 touch disjoint files.

### T1. Core check (api, provider, acp-provider, router, acp, server, antigravity)

- Inputs: this plan (D1-D7, Files table rows for `src/api.ts`, `src/provider.ts`, `src/acp-provider.ts`, `src/providers/antigravity.ts`, `src/router.ts`, `src/acp.ts`, `src/server.ts`).
- Output: the code above. `promptBlocks` must reproduce today's two `buildPrompt` calls argument for argument; the existing prompt tests (`tests/antigravity.test.ts` "Antigravity prompt", `tests/acp-provider.test.ts`, `tests/tool-calling.test.ts`, `tests/images.test.ts`, `tests/web-search.test.ts`) must pass unchanged.
- Contracts:
  - `promptTooLong(displayName, chars, limit)` returns `new ApiError(400, "context_length_exceeded", "The prompt is too long for ${displayName}: ${chars} characters, the limit is ${limit}. The agent would silently drop the rest, so the proxy refused it. Shorten the prompt or use another model.", "messages")`.
  - `AcpProvider.maxPromptChars`: `options.maxPromptChars ?? descriptor.maxPromptChars`, normalised so that 0 or absent is `undefined`.
  - `checkPrompt` is synchronous and side-effect free.
  - Behaviour is unchanged for any provider without a limit (no new fields in `/v1/models`, no new errors).

### T2. Settings, registrations, settings window

- Inputs: Files table rows for `src/settings.ts`, `src/providers/codex.ts`, `src/providers/claude.ts`, `src/shared/ipc.ts`, `src/renderer/settings.ts`, `src/renderer/settings.html`; the AAP-25 pattern (`.claude/tickets/AAP-25-provider-concurrency-cap/plan.md`, "Settings").
- Output: the setting, the env overrides (marked in `overridden`, so the window shows the env note), the registrations passing `maxPromptChars` to `AcpProvider` (the antigravity registration line is T1's), and the three fields.
- Contract: `AcpProviderOptions.maxPromptChars?: number` (added by T1). If T2 runs before T1 lands, add only the option field in `acp-provider.ts` and tell the orchestrator.

### T3. Tests (`tests/prompt-limit.test.ts`)

- Inputs: Acceptance criteria below; harness patterns from `tests/antigravity.test.ts` (`setup()`, `make()`, `FAKE_ACP_AGY`, `FAKE_ACP_LOG`, `readLog`) and `tests/concurrency.test.ts` (`ProviderRouter` + `createProxyServer` on port 0).
- Output: three tests (test-discipline: no more). Write test 1 first and run it against the unfixed code to confirm it fails (it returns 200 and the log has a `session/prompt`).

### T4. Docs

- README "Prompt size limit" section: what it does and why (Antigravity silently keeps ~192,000 characters; the proxy refuses longer prompts with 400 `context_length_exceeded`, message starting "The prompt is too long"); default 180,000 for Antigravity, none for Codex and Claude; setting, env, settings-window field, `0` = unlimited, saving restarts the server; what is counted (all text blocks of the prompt including the proxy's preamble and the `[output format]` block; images not counted); with `reuseSessions` the whole conversation is counted; `/v1/models` `max_prompt_chars`; a client should treat the error as "too big for this model" and not retry. Env rows. ROADMAP line.

## Acceptance criteria and proofs

| # | Criterion | Proof |
|---|---|---|
| A1 | A chat request whose prompt is over Antigravity's limit is refused before the agent sees it: HTTP 400 (also with `stream: true`, as JSON, not SSE), `error.code` `context_length_exceeded`, `error.type` `invalid_request_error`, `error.message` matching Scriptorium's `isContextError` regex and starting with "The prompt is too long". No `session/prompt` reaches the agent. A request under the limit still answers 200. | Test 1 (reproduction; fails before the fix with 200 and a logged `session/prompt`). |
| A2 | The limit counts the prompt the agent receives: preamble and `[output format]` included, so a request whose messages alone are under the limit but whose built prompt is over it is refused; image blocks are not counted. | Test 2 (provider level, small limit). |
| A3 | `providers.<id>.maxPromptChars` and `PROXY_<ID>_MAX_PROMPT_CHARS` set the limit through the registration; `0` turns it off; Codex and Claude have none by default. | Test 3 (settings + registration). |
| A4 | `/v1/responses` gives the same 400 with `param: "input"`. | One extra request inside test 1 (same server). |
| A5 | `/v1/models` shows `max_prompt_chars: 180000` on `antigravity/...` ids and nothing on providers without a limit. | One assertion inside test 1. |
| A6 | No other behaviour changes: prompts are built exactly as before. | The existing suite passes unchanged (`tests/antigravity.test.ts` "Antigravity prompt" compares the sent text with `serializePrompt`). |
| A7 | The settings window shows and saves the three fields. | UNTESTED by automation; hand check in the packaged app (see Live check, step 3). |
| A8 | The live Antigravity proxy refuses the 250k-character REQ-0009 prompt with the 400 and still answers a 40k one. | Live check after the user restarts the app. |

### Tests (all in `tests/prompt-limit.test.ts`)

1. **"refuses an Antigravity prompt over the limit before the agent sees it (chat stream and Responses), and passes one under it"** (reproduction). Antigravity provider from `antigravityDescriptor` with the fake agent (`FAKE_ACP_AGY=1`, `FAKE_ACP_LOG`), default limit, behind `ProviderRouter` and `createProxyServer`. Send `POST /v1/chat/completions` `stream: true` with a 200,000-character user message: expect status 400, JSON content type, the error fields of A1, and `message` matched by the regex copied from Scriptorium's `isContextError` (quote the source line in a comment). Send the same to `/v1/responses` (`input` string): 400, `param: "input"`. Send a 1,000-character message: 200. Read the log: exactly one `session/prompt` (the small one). `GET /v1/models`: `antigravity/` entries carry `max_prompt_chars: 180000`.
2. **"counts the preamble and the output format, not images"**. `AcpProvider` with the fake agent and `maxPromptChars` set so that the message text is under it but `buildPrompt(... instructions)` is over it, with `response_format` JSON instructions passed as `options.instructions`: `checkPrompt` throws the 400; the same text without instructions passes; a message with a large base64 image and short text passes.
3. **"reads providers.<id>.maxPromptChars and the env override; 0 turns the limit off"**. `resolveConfig(defaultSettings(), { PROXY_ANTIGRAVITY_MAX_PROMPT_CHARS: "0", PROXY_CODEX_MAX_PROMPT_CHARS: "5000" })`: values set and listed in `overridden`. Providers created through `antigravityRegistration.create` / `codexRegistration.create` with those provider settings: `maxPromptChars` is `undefined` for Antigravity with 0, `5000` for Codex, `180000` for Antigravity with the setting absent, `undefined` for Codex by default.

## Test commands

The repo uses yarn 4 (`packageManager: yarn@4.13.0`, `yarn.lock`); scripts call `npm run` inside, and AAP-29 found `npm` does not resolve through `fnm exec`, so use a PowerShell session with fnm's env:

```powershell
fnm env --use-on-cd | Out-String | Invoke-Expression
cd C:\projects\Personal\api-acp-proxy
yarn typecheck                         # or: npx tsc --noEmit; npx tsc --noEmit -p tsconfig.renderer.json
npx vitest run tests/prompt-limit.test.ts
yarn test                              # whole suite; baseline 742 passed, 2 skipped (AAP-29)
yarn build                             # or the three steps: npx tsc; npx tsc -p tsconfig.renderer.json; node scripts/copy-static.mjs
```

Tests use only the fake agent on loopback; they never touch port 8787.

## Rebuild and restart the packaged proxy (the user)

The proxy on 8787 is the packaged desktop app (`release/win-unpacked/ACP Proxy.exe`, settings `%APPDATA%\api-acp-proxy\settings.json`, port 8787, `reuseSessions: false`). It keeps files in `release\win-unpacked` open, so:

1. Quit ACP Proxy from its tray menu (Quit, not just close the window). Wait for in-flight requests (Scriptorium jobs) to finish first, or pause the Scriptorium engine.
2. In the PowerShell above: `yarn dist:dir` (build plus `electron-builder --dir`, writes `release\win-unpacked`), then `yarn verify:package`.
3. Start `release\win-unpacked\ACP Proxy.exe`. On its Antigravity page the Capacity card shows "Max prompt characters" empty (= 180000). Leave it empty.

Packaging the portable exe or installer (`yarn dist`) is not needed for the live check.

## Live check against 8787 (after the restart)

1. `curl http://127.0.0.1:8787/healthz` -> `status: ok`, antigravity listed.
2. `GET /v1/models` (with the bearer key if `server.apiKey` is set) -> the `antigravity/gemini-3.8-flash` entry has `"max_prompt_chars": 180000`; codex and claude entries have none.
3. Re-run probe B from `C:/projects/Personal/scriptorium/.claude/temp/req0009/probe.py` (250,462 characters, `antigravity/gemini-3.8-flash`), once non-streaming and once with `stream: true`: both answer HTTP 400 within about a second, `code: context_length_exceeded`, message beginning "The prompt is too long for Google Antigravity: ... the limit is 180000". The Recent requests table shows the 400 with that code.
4. Re-run probe A (40,421 characters): HTTP 200 with valid JSON, `saw_end_marker: true`.
5. Optional, Scriptorium: queue one whole-book review of `fifty-minutes-of-common-sense` with Gemini first in the role list; the log shows the Gemini attempt failing as too big (no retries) and the next model taking the job.

## Risks

- A newer Antigravity build may change the cap; the setting is the escape hatch (documented). If a cut at a lower size is ever seen, lower the default.
- Clients that keep long chat histories on Antigravity (the playground, `ask_model` threads) now get a 400 once the whole conversation passes 180,000 characters, even with session reuse on (D3). That is the intended trade: today they silently lose the start or end of the conversation.
- `promptBlocks` refactor: a slip in the argument order would change every prompt. Mitigated by A6 (existing tests compare exact prompt text).

## Open questions

1. D3: should a request that reuses a kept session (or resumes a tool turn) be measured on what is sent instead of the whole conversation? Only matters with `reuseSessions` on, which is off on the live instance. Plan keeps the conservative whole-request rule.
2. D6: should `/v1/models` also carry a token `context_length` (for example `maxPromptChars / 4` = 45,000) so OpenRouter-style clients pick it up? Plan says no (it would be a guess); Scriptorium only reads `context_length` for discovered models, and its acp models are listed by hand.
3. Default margin: 180,000 (6% under the cap) is a judgement call; anything between ~150,000 and ~190,000 is defensible.

## Verification status

Implemented on branch AAP-30_prompt-size-limit, uncommitted; see changelog.md.
