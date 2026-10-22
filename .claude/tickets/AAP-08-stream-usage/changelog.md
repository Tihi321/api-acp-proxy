# AAP-08 changelog

## 2026-10-22: AAP-08, usage numbers in the stream

Summary: chat `stream_options.include_usage` is now supported. The stream ends with a usage chunk (`choices: []`) before `[DONE]`. Every chat and Responses payload now carries usage. When the agent reports usage, the payload uses it, with cached and reasoning token details. When it does not, the proxy estimates usage at about 4 characters per token, so clients never see 0.

**Repository:** api-acp-proxy. **Branch:** `AAP-08_stream-usage`, stacked on `AAP-07_json-output` (d234269).

### Files changed
- `src/usage.ts` (new): `CHARS_PER_TOKEN`, `estimateTokens`, `openAiUsage`, `chatUsage` and `responsesUsage`.
  - `prompt_tokens` = input + cache read + cache write, which is the OpenAI meaning: prompt tokens include cached ones.
  - Cached tokens come from `cachedReadTokens`, reasoning tokens from `thoughtTokens`.
- `src/api.ts`: chat `stream_options` is accepted by default and is no longer dropped by `ignoreSampling`. The schema allows `include_usage` and passes other keys through. Responses `stream_options` is unchanged.
- `src/server.ts`:
  - Uses the `usage.ts` helpers.
  - With `include_usage`, every chunk has `usage: null` and a final usage chunk follows the finish chunk.
  - Non-stream chat and Responses always include usage.
  - Estimates use the serialized prompt (with the AAP-07 instructions) and the text actually returned (the cleaned JSON in JSON mode).
- `src/renderer/settings.html`: the ignore-sampling label no longer lists `stream_options`.
- `README.md`:
  - The `PROXY_IGNORE_SAMPLING` row now says only Responses `stream_options`.
  - The API section documents `include_usage`, the usage fields and the estimate fallback.
- `tests/usage.test.ts` (new): the estimate, Codex-style and Claude-style usage, and the fallback.
- `tests/proxy.test.ts`: a usage block covering:
  - `stream_options` accepted for chat and still rejected for Responses;
  - the usage chunk present with the flag and absent without it;
  - estimated usage for chat, Responses and stream;
  - the `openai` SDK reading the usage chunk.

### Deviations
- `server.ts` reads `parsed.stream_options` through a type cast, because the passthrough schema's inferred type does not expose the key after `Omit`.

### Verified
- `npm run typecheck` clean.
- `npx vitest run`: 128 passed, 1 skipped.
- `npm run build` succeeded (implementer run).

### Not verified
- The real agent usage numbers against Scriptorium / Book Translator cost display (HUB-09).

### Known limitations
- The estimate is approximate (4 characters per token). It is used only when an agent reports no usage. The bundled Codex and Claude agents do report usage.

### Commit status
Committed on `AAP-08_stream-usage` (local, not pushed).
