# AAP-09: Token limit (`max_tokens` / `max_completion_tokens` / `max_output_tokens`)

> Branch: `AAP-09_token-limit`, cut from `AAP-08_stream-usage` (stacked). Roadmap item: "No token limit."

## Goal

Honour the client's output limit instead of rejecting it (default) or dropping it (`ignoreSampling`). ACP has no per-request output limit and no per-chunk token counts, so the proxy counts the visible answer with the AAP-08 estimate (`estimateTokens`, ≈4 characters per token), stops at the limit, cancels the agent turn and reports a length stop, like OpenAI does.

The estimate only counts visible text (not reasoning) and undercounts for most non-English text, so the cut is lenient: it never stops much earlier than a real token limit would. This is documented.

## Steps

1. **`src/api.ts`**:
   - Remove `max_tokens`, `max_completion_tokens` from `unsupportedChatFields` and `ignorableChatFields`; remove `max_output_tokens` from `unsupportedResponseFields` and `ignorableResponseFields`. The schemas already validate them as positive integers, and "only one of max_tokens / max_completion_tokens" stays.
   - The normalizers return `maxOutputTokens?: number` (chat: `max_completion_tokens ?? max_tokens`; responses: `max_output_tokens`).
   - Update the comment above the ignorable lists: what is left is only sampling (`temperature`, `top_p`, penalties, `seed`, and Responses `stream_options`).
2. **`src/server.ts`**: one shared helper used by all four paths (chat/responses × stream/non-stream), e.g. `runGeneration(bridge, parsed, onText, signal)`:
   - Own `AbortController` linked to the request signal (request abort / timeout still aborts it).
   - Track emitted text. When a chunk would make `estimateTokens(emitted)` exceed the limit, emit only the part that fits (`limit * CHARS_PER_TOKEN - emitted.length` characters), mark `truncated`, and abort the generation (the provider sends `session/cancel`).
   - After a truncation the result is `{ text: emitted, stopReason: "max_tokens", usage }`, whether `generate` resolved (typically `stopReason: "cancelled"`) or rejected because of the cancel. Usage is then estimated from the truncated text (the agent's own count covers text the client did not get).
   - Non-stream requests use the same counting (the final text is cut to the budget).
   - Compose with AAP-07 JSON mode: the limit applies to the raw answer before `extractJson`; a truncated JSON answer is returned as is with `finish_reason: "length"`.
   - `mapStopReason("max_tokens")` already gives chat `length` and responses `incomplete`; add `incomplete_details: { reason: "max_output_tokens" }` to the Responses object when it is incomplete because of the limit (otherwise `incomplete_details: null`).
3. **Settings/docs**: the `ignoreSampling` checkbox label and the README row list only the remaining fields (temperature, top_p, penalties, seed). README API section: token limits are honoured with the estimate and the length stop.
4. **Tests**:
   - Normalization: `max_tokens` accepted by default; still accepted with `ignoreSampling` and returned as `maxOutputTokens`; both `max_tokens` and `max_completion_tokens` → 400.
   - HTTP with a fake bridge that streams many chunks and honours the abort signal (resolves `stopReason: "cancelled"` when aborted): chat stream with `max_tokens: 3` → content ≤ 12 characters, `finish_reason: "length"`, the bridge saw the abort; non-stream likewise; a bridge that rejects after abort still gives 200 + `length`; responses → `status: "incomplete"`, `incomplete_details.reason === "max_output_tokens"`; without a limit, unchanged.
   - Update the AAP-05 tests that expect `max_tokens` to be rejected/dropped.

## Acceptance

- `npm run typecheck` clean, `npm test` passes, `npm run build` succeeds.
- A request with `max_tokens: N` returns at most `4·N` characters and `finish_reason: "length"` when it was cut; the agent turn is cancelled.

## Status

- [x] Step 1 `src/api.ts`: limits removed from the unsupported/ignorable lists, comment updated, normalizers return `maxOutputTokens`.
- [x] Step 2 `src/server.ts`: shared `runGeneration` helper for all four paths (own linked AbortController, character budget `limit * CHARS_PER_TOKEN`, cancel on truncation, "max_tokens" stop with estimated usage, rejection after a truncation still gives 200); Responses `incomplete_details`.
- [x] Step 3 settings checkbox label, README config row and a new "Token limits" paragraph.
- [x] Step 4 tests: new "token limit" describe (8 tests); AAP-05 test no longer expects `max_tokens` / `max_output_tokens` to be dropped.

Deviations: with no limit and no stream (or JSON-mode stream), `runGeneration` calls the bridge without `onText`, so JSON-mode streaming still buffers and the AAP-07 `hasOnText: false` test keeps passing. `incomplete_details` is set whenever the result stopReason is `max_tokens` (also an agent-reported one). Timeout test covers a bridge that resolves "cancelled" (a rejecting bridge yields 500/503 as before, unchanged behaviour).

Verification: `npm run typecheck` clean; `npx vitest run` 136 passed + 1 skipped (13 files passed, 1 skipped); `npm run build` succeeded.
