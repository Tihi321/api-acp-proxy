# AAP-07 changelog

## 2026-10-22 — AAP-07: JSON output

Summary: `response_format` (chat) and `text.format` (Responses) are accepted. For `json_object` / `json_schema` the proxy adds an output-format block to the agent prompt (with the schema) and cleans the answer: Markdown fences and prose around the JSON are stripped. An answer that is still not JSON is returned as is, so the clients' repair step still works. The answer is not validated against the schema.

**Repository:** api-acp-proxy. **Branch:** `AAP-07_json-output`, cut from `origin/master` at 9517906.

### Files changed
- `src/api.ts`:
  - `response_format` (text / json_object / json_schema) and the Responses `text` object (strict; only `format`) are now validated. Bad shapes return 400 `invalid_request` with `param` set to `response_format` or `text`.
  - New `OutputFormat`, and a `format` on the normalized requests.
  - `formatInstructions(format)` builds the prompt text, including the schema.
  - `serializePrompt(messages, instructions?)` appends an `[output format]` block.
  - `extractJson(text)` strips fences, then tries the slice from the first `{` or `[` to the last `}` or `]`, and falls back to the trimmed text.
- `src/provider.ts`, `src/acp.ts`, `src/router.ts`, `src/acp-provider.ts`: an optional 5th `generate` parameter, `GenerateOptions { instructions? }`. It passes through the router to `serializePrompt`, so the injected instruction stays out of the client-visible `messages`.
- `src/server.ts`: in JSON mode, text deltas are buffered. After the agent finishes, the cleaned JSON is sent as one delta (chat `delta.content` / Responses `output_text.delta`), and every final payload uses the cleaned text. Text mode is unchanged.
- `tests/proxy.test.ts`:
  - The AAP-05 test now expects `response_format` to be accepted.
  - The `call()` helper takes an optional bridge.
  - 7 new tests: format parsing, 400s with the right `param`, `extractJson`, `formatInstructions` / `serializePrompt`, HTTP chat and Responses in both stream and non-stream mode, and text mode unchanged.
- `README.md`: a "JSON output" paragraph in the API section.

### Deviations
None.

### Verified
- `npm run typecheck` clean.
- `npx vitest run`: 119 passed, 1 skipped (was 112 + 1 skipped).
- `npm run build` succeeded (implementer run).

### Not verified
- A real agent answer in JSON mode (needs a logged-in provider).

### Commit status
Committed on `AAP-07_json-output` (local, not pushed).
