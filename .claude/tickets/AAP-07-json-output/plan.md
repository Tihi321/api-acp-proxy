# AAP-07: JSON output (`response_format` / `text.format`)

> Branch: `AAP-07_json-output`, cut from `master` @ 9517906. Roadmap item: "Text only, and no JSON schema (`response_format` is rejected; the apps fall back to their prompt + repair step)."

## Goal

Accept the OpenAI JSON output options and make the agent answer with JSON, so Scriptorium and Book Translator can drop their prompt-and-repair fallback:
- Chat Completions: `response_format` = `{ type: "text" }` | `{ type: "json_object" }` | `{ type: "json_schema", json_schema: { name, schema?, strict?, description? } }`.
- Responses: `text: { format: { type: "text" } | { type: "json_object" } | { type: "json_schema", name, schema?, strict?, description? } }`.

The agents cannot enforce a schema, so the proxy (1) tells the agent the required format in the prompt and (2) cleans the answer (strips Markdown fences / prose around the JSON). It does not reject an answer that is still not valid JSON: the text is returned as is, so the clients' repair step still works.

Out of scope: images/audio/tools (still rejected), schema validation of the answer.

## Steps

1. **`src/api.ts`**
   - Remove `response_format` from `unsupportedChatFields` and `text` from `unsupportedResponseFields`.
   - Add zod schemas for the chat `response_format` and the Responses `text` object (`text` is strict: only `format`; anything else, e.g. `verbosity`, is a 400 `invalid_request` with `param: "text"`). Bad shapes → 400 `invalid_request` (zod message), `param` = `response_format` / `text`.
   - Export `type OutputFormat = { type: "text" } | { type: "json"; name?: string; schema?: unknown; description?: string }`. `normalizeChat` / `normalizeResponses` return it as `format` (default `{ type: "text" }`).
   - Export `formatInstructions(format): string | undefined`: undefined for text. For JSON: "Respond with a single valid JSON value only: no prose, no explanations, no Markdown code fences." Plus, when a schema is present: "It must conform to this JSON Schema" + name/description + `JSON.stringify(schema)`.
   - `serializePrompt(messages, instructions?)`: when `instructions` is set, append a final block `[output format]\n<instructions>` after the messages.
   - Export `extractJson(text): string`: trim; if the text is wrapped in a ```` ```json ```` / ```` ``` ```` fence, take the inside; if the result parses with `JSON.parse`, return it; otherwise try the slice from the first `{` or `[` to the matching last `}` / `]` and return it if it parses; otherwise return the trimmed original.
2. **Generation options plumbing**: add `export interface GenerateOptions { instructions?: string }` in `src/provider.ts`, and an optional 5th parameter `options?: GenerateOptions` on `generate` in `Provider` (`src/provider.ts`), `AcpLike` (`src/acp.ts`), `ProviderRouter.generate` (`src/router.ts`, passes it through) and `AcpProvider.generate` (`src/acp-provider.ts`, passes `options?.instructions` to `serializePrompt`). Keep the injected instruction out of `messages` (AAP-10 matches sessions on client-visible messages).
3. **`src/server.ts`**: for a JSON format
   - pass `{ instructions: formatInstructions(parsed.format) }` to `generate`;
   - streaming: do not forward text deltas as they arrive. After `generate` resolves, emit `extractJson(result.text)` as a single delta (chat: one `delta.content` chunk; responses: one `response.output_text.delta`), then the usual finish events;
   - all final payloads (chat `message.content`, responses `output_text`, `output_text.done`, `content_part.done`, `output_item.done`, `response.completed`) use the extracted text;
   - text format: unchanged behaviour.
4. **Tests** (`tests/proxy.test.ts`, plus a small unit block for `extractJson` / `formatInstructions` / `serializePrompt`):
   - `response_format` json_object / json_schema / text are accepted; an invalid shape is 400; `text.verbosity` is 400; `tools` is still 400.
   - `extractJson`: fenced JSON, prose + JSON, plain JSON, arrays, non-JSON text returned unchanged.
   - HTTP: a fake bridge that answers ```` ```json\n{"a":1}\n``` ```` → chat non-stream content `{"a":1}`; chat stream yields exactly one content delta `{"a":1}`; responses non-stream and stream likewise; the bridge receives `options.instructions` containing the schema.
   - Update the existing AAP-05 test that expects `response_format` to be rejected (it is now accepted).
5. **Docs**: `README.md` API section (line ~127-131): document `response_format` / `text.format`, the prompt-based enforcement and fence stripping, and that the answer is not schema-validated.

## Acceptance

- `npm run typecheck` clean, `npm test` passes (previous 112 + new).
- `npm run build` succeeds.
- Requests with `response_format: { type: "json_object" }` or `json_schema` return 200 and the content is the cleaned JSON text.

## Status

- [x] 1. `src/api.ts`: zod schemas, `OutputFormat`, `format` on normalize results, `formatInstructions`, `serializePrompt(messages, instructions?)`, `extractJson`; `response_format` / `text` removed from the unsupported lists; 400 `param` set to `response_format` / `text`.
- [x] 2. `GenerateOptions` in `src/provider.ts` (re-exported from `src/acp.ts`); optional 5th `options` param on `Provider`, `AcpLike`, `ProviderRouter.generate`, `AcpProvider.generate` (passes `options?.instructions` to `serializePrompt`).
- [x] 3. `src/server.ts`: JSON format passes instructions, streams a single cleaned delta after `generate` resolves, all final payloads use the extracted text.
- [x] 4. Tests in `tests/proxy.test.ts` ("JSON output" block); AAP-05 test updated (`response_format` now accepted). `call()` helper takes an optional bridge.
- [x] 5. README "JSON output" paragraph.

Deviations: none. `ROADMAP.md` line 13 still says `response_format` is rejected (not in plan scope; left untouched).

Verification: `npm run typecheck` clean; `npm test` 12 files passed, 1 skipped; 119 passed + 1 skipped (previously 112 + 1); `npm run build` succeeded.
