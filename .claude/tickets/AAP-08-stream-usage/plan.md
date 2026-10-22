# AAP-08: Usage numbers in the stream

> Branch: `AAP-08_stream-usage`, cut from `AAP-07_json-output` (stacked; all roadmap tickets edit `src/server.ts`). Roadmap item: "No usage numbers in the stream, so the apps show a cost of 0."

## Facts

- Both bundled agents already return per-request `usage` on the ACP `session/prompt` response (`PromptResponse.usage`, experimental): codex-acp `toPromptUsage` (input without cached, `cachedReadTokens`, output, `thoughtTokens`), claude-agent-acp `sessionUsage` (input, output, cache read/write, total). `AcpProvider.generate` already returns it as `GenerationResult.usage`.
- Non-stream chat already sends `usage` when the agent reports it. Streaming chat never sends usage: `stream_options` is rejected by default and dropped with `ignoreSampling` (AAP-05).

## Steps

1. **`src/usage.ts`** (new):
   - `estimateTokens(text: string): number` = `Math.ceil(text.length / 4)` (`CHARS_PER_TOKEN = 4`, exported, reused by AAP-09).
   - `openAiUsage(result: GenerationResult, promptText: string)`: returns `{ prompt, completion, total, cached, reasoning }`. `prompt = inputTokens + (cachedReadTokens ?? 0) + (cachedWriteTokens ?? 0)` (OpenAI `prompt_tokens` includes cached tokens), `completion = outputTokens`, `total = prompt + completion`, `cached = cachedReadTokens ?? 0`, `reasoning = thoughtTokens ?? 0`. When `result.usage` is null, estimate: `prompt = estimateTokens(promptText)`, `completion = estimateTokens(result.text)`, `cached = reasoning = 0`.
   - `chatUsage(...)` → `{ prompt_tokens, completion_tokens, total_tokens, prompt_tokens_details: { cached_tokens }, completion_tokens_details: { reasoning_tokens } }` and `responsesUsage(...)` → `{ input_tokens, input_tokens_details: { cached_tokens }, output_tokens, output_tokens_details: { reasoning_tokens }, total_tokens }`.
   - The prompt text for estimates is `serializePrompt(parsed.textMessages, instructions)`.
2. **`src/api.ts`**:
   - Chat: `stream_options` becomes supported: remove it from `unsupportedChatFields` and from `ignorableChatFields`; schema `stream_options: z.object({ include_usage: z.boolean().optional() }).passthrough().nullable().optional()`. It is ignored when `stream` is false.
   - Responses: `stream_options` stays as it is (ignorable / rejected); Responses streams already carry usage in `response.completed`.
3. **`src/server.ts`**:
   - Replace the local `chatUsage` / `responsesUsage` with the `src/usage.ts` versions. Non-stream chat and all Responses payloads always carry usage now (estimated when the agent reports none).
   - Streaming chat with `stream_options.include_usage: true`: every chunk carries `usage: null`, and after the finish chunk (before `[DONE]`) one extra chunk `{ id, object: "chat.completion.chunk", created, model, choices: [], usage: {...} }`. Without `include_usage`, the stream is unchanged.
4. **Settings/docs**: the `server.ignoreSampling` checkbox label (`src/renderer/settings.html`) and the README `PROXY_IGNORE_SAMPLING` row no longer mention `stream_options` for chat. README API section: `stream_options.include_usage`, the usage fields, and the estimate fallback (≈4 characters per token) when an agent reports no usage.
5. **Tests** (`tests/proxy.test.ts`, new `tests/usage.test.ts`):
   - `openAiUsage` for codex-style and claude-style usage, and the estimate fallback.
   - Chat stream with `include_usage` → last data chunk before `[DONE]` has `choices: []` and `usage.total_tokens`; other chunks have `usage: null`. Without it → no usage chunk.
   - `stream_options` accepted without `ignoreSampling`; the AAP-05 tests still pass (adjust the one that asserts `stream_options` is dropped).
   - Non-stream chat with a bridge that returns `usage: null` → estimated usage present.
   - The `openai` SDK client (already a devDependency used in tests) reads the usage chunk: `stream_options: { include_usage: true }` → final chunk `usage` defined.

## Acceptance

- `npm run typecheck` clean, `npm test` passes, `npm run build` succeeds.
- A streamed chat request with `stream_options: { include_usage: true }` ends with a usage chunk; both endpoints always report usage.

## Status

- [x] 1. `src/usage.ts`: `CHARS_PER_TOKEN`, `estimateTokens`, `openAiUsage`, `chatUsage`, `responsesUsage` (no deviation; helpers take `(result, promptText)`).
- [x] 2. `src/api.ts`: chat `stream_options` supported (removed from unsupported/ignorable lists, added to schema); Responses unchanged.
- [x] 3. `src/server.ts`: local usage helpers replaced; chat and Responses always carry usage (estimated if none); `include_usage` streams get `usage: null` on every chunk plus a final `choices: []` usage chunk before `[DONE]`. Estimates use `serializePrompt(parsed.textMessages, instructions)` and, in JSON mode, the extracted text actually returned.
- [x] 4. Settings label now reads "(temperature, max_tokens, ...)"; README `PROXY_IGNORE_SAMPLING` row and API section updated (include_usage, usage fields, ~4 chars/token estimate).
- [x] 5. Tests: new `tests/usage.test.ts`; new "usage" block in `tests/proxy.test.ts` (acceptance, usage chunk, no chunk without flag, estimate fallback, OpenAI SDK). The existing AAP-05 test needed no change (its `stream_options` is now simply accepted).
- Deviation: `stream_options` is read in `server.ts` through a type cast because the passthrough schema's `Omit` type drops the key.

Verification: `npm run typecheck` clean; `npx vitest run` 128 passed + 1 skipped (13 files passed, 1 skipped); `npm run build` succeeded.
