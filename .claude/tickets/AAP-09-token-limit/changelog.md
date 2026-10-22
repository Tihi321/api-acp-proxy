# AAP-09 changelog

## 2026-10-22 — AAP-09: token limit

Summary: `max_tokens` / `max_completion_tokens` (chat) and `max_output_tokens` (Responses) are now honoured by default and with `ignoreSampling`. The proxy counts the visible answer at about 4 characters per token. At the limit it emits the part that fits, cancels the agent turn and reports a length stop: chat `finish_reason: "length"`, Responses `status: "incomplete"` with `incomplete_details.reason: "max_output_tokens"`.

**Repository:** api-acp-proxy. **Branch:** `AAP-09_token-limit`, stacked on `AAP-08_stream-usage` (1db687a).

### Files changed
- `src/api.ts`:
  - The limit fields are no longer rejected or dropped.
  - `ignoreSampling` now only drops temperature, top_p, penalties, seed and Responses `stream_options`.
  - The normalizers return `maxOutputTokens`: chat uses `max_completion_tokens ?? max_tokens`.
  - Sending both chat fields is still a 400.
- `src/server.ts`: new `runGeneration` helper, used by chat and Responses, stream and non-stream.
  - It has its own AbortController linked to the request, so timeouts (504) and client disconnects behave as before.
  - It applies a character budget of `limit × 4` to the raw text, including in JSON mode where deltas are buffered.
  - On a cut it aborts the generation and returns `{ text: <cut text>, stopReason: "max_tokens", usage: null }`. The usage is then estimated from the text the client got. This holds even when the bridge rejects after the cancel.
  - Responses objects carry `incomplete_details`.
- `src/renderer/settings.html`: the ignore-sampling label lists temperature, top_p, penalties and seed.
- `README.md`: the `PROXY_IGNORE_SAMPLING` row is trimmed, a "Token limits" paragraph is added, and the old sentences saying token limits are rejected are removed.
- `tests/proxy.test.ts`: the AAP-05 test is updated. 8 new token-limit tests cover:
  - normalization;
  - a stream cut, including the usage chunk;
  - a non-stream cut, with a bridge that resolves and one that rejects;
  - a cut in the middle of a chunk;
  - no change when the answer fits or there is no limit;
  - Responses stream and non-stream;
  - JSON mode;
  - a timeout still returning 504.

### Deviations
- `incomplete_details` is also set when the agent itself reports `max_tokens`. That stop has the same meaning.
- A bridge that *rejects* on a timeout abort still gives 500 or 503. This was already the case and is unchanged.

### Verified
- `npm run typecheck` clean.
- `npx vitest run`: 136 passed, 1 skipped.
- `npm run build` succeeded (implementer run).

### Not verified
- A real agent cancelled mid-answer by the limit (needs a logged-in provider).

### Known limitations
- The count is an estimate. It covers only visible text, not reasoning, and undercounts most non-English text, so the cut errs late rather than early.

### Commit status
Committed on `AAP-09_token-limit` (local, not pushed).
