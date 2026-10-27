# Changelog

## 2026-10-26: AAP-17 Phase 6 (web search)

Chat `web_search_options` and the Responses `web_search` tool now turn on the agents' own web search. Claude and Antigravity search only when a request asks; Codex always can. Answers come with `url_citation` annotations, and Responses also returns `web_search_call` items. The live check passed on all three agents.

**Repository** `api-acp-proxy`, branch `AAP-17_web-search` (from `origin/master` at `219c106`; AAP-12 to AAP-16 merged):
- `src/provider.ts`: `ProviderDescriptor.webSearch` (`sessionMeta`, `allow`, `search`).
- `src/acp-provider.ts`:
  - A search request gets a fresh session with the search meta. It is never kept for reuse.
  - Search permissions go through the existing per-session rules, answered with `allow_once` only.
  - `web_search_call` results are collected from the `kind: "search"` tool calls.
  - `mergeMeta` joins arrays (so Claude's `tools` / `allowedTools` from search, MCP servers and function tools merge), and `trackToolCall` merges `_meta`, so Claude's `toolResponse` survives the final update.
  - A debug log line records each permission decision (kind, title, outcome; never the body).
- `src/providers/claude.ts`: the search session gets `tools: ["WebSearch"]` and `allowedTools: ["WebSearch"]`, never `WebFetch`. A fallback rule allows only `WebSearch`.
- `src/providers/antigravity.ts`: allows only `kind === "search"` with `title === "Run search_web?"`. `read_url_content` and `run_command` stay cancelled.
- `src/providers/codex.ts`: search is always on; nothing to enable, and it can't be turned off per request.
- `src/api.ts`:
  - Chat `web_search_options` and Responses `web_search` / `web_search_preview` (at most one per request) are accepted.
  - `search_context_size` is checked and ignored. `user_location` and `filters.allowed_domains` are validated and become hint lines.
  - A search-only preamble replaces the generic one and leaves out Antigravity's no-tools line.
  - `include: ["web_search_call.action.sources"]` is accepted, and so is `tool_choice` of `auto`, `required` or `{ type: "web_search" }`.
  - Search with `image_generation` or chat `modalities` gets a 400.
- `src/citations.ts` (new): `url_citation` annotations from the Markdown links and bare http(s) URLs actually present in the answer, indexed in UTF-16 units (`text.slice(start, end)` is the cited text).
- `src/server.ts`:
  - **Responses, items:** a `web_search_call` item per search, shaped `{ id, type, status, action: { type: "search", query, sources? } }`, placed before the message. Streaming sends `output_item.added`, `web_search_call.in_progress` / `.searching` / `.completed` and `output_item.done`.
  - **Responses, citations:** in `content[].annotations`, and streamed as `response.output_text.annotation.added`.
  - **Chat:** `message.annotations`, and in streaming one `delta.annotations` chunk before the finish chunk.
  - **Capability check:** `model_not_capable` is checked before a stream starts.
- `src/router.ts`, `src/acp.ts`: `canSearchWeb`.
- `tests/web-search.test.ts` (new, 29 tests). `tests/fixtures/fake-acp.mjs`: `FAKE_ACP_SEARCH=claude|agy|codex`. `tests/image-generation.test.ts`, `tests/tool-calling.test.ts`: the "unsupported Responses tool" example is now `file_search`.
- `README.md`:
  - A "Web search" block covering the request shapes, what each agent does, timings, citations, and what is not enforced (domains, context size, Codex always on).
  - The Codex home path now renders as `%APPDATA%\api-acp-proxy\codex-home`.
- `ROADMAP.md`: one line.
- `.claude/tickets/AAP-11-images-and-tools/plan.md`: Phase 6 status, decisions and the live table.

**Live check** (headless CLI, temporary settings, `PROXY_CODEX_ISOLATED_HOME=0`, prompt "What is the latest stable version of Node.js? Search the web."):

| API | Model | Time | Searches | Citations |
|---|---|---|---|---|
| Responses | `claude/haiku` | 17.4 s | 2 items, 10 sources each | 9 annotations, 4 distinct URLs |
| Responses | `codex/gpt-5.6-luna` | 11.7 s | 1, no sources | 1 |
| Responses | `antigravity/gemini-3.8-flash-low` | 19.9 s | 1 | 2 |
| Chat `web_search_options` | `codex/gpt-5.6-luna` | 14.6 s | n/a | 1 |

`allowedTools: ["WebSearch"]` suppresses Claude's permission request; the debug log showed none during both searches. Antigravity asked once (`Run search_web?`), and that request was allowed once.

**Deviations**
- Search may be combined with function tools and `mcp` servers instead of being rejected: the meta and permission rules merge, and the tool-set key for kept or suspended sessions includes search. A search made before a function call is reported with the response that ends in that call.
- `action.sources` uses OpenAI's `[{ type: "url", url }]` shape, so Claude's page titles are not on the item.
- Antigravity's grounding links are not turned into `sources`, because its search result text is not returned. They appear as annotations only when the answer contains them.

**Verification**
- `npm run typecheck`: clean.
- `npx vitest run`: 320 passed, 1 skipped (20 files).
- `npm run build`: succeeded.
- I ran all three on the final tree.
- Not run:
  - plain-prompt baselines in this check (the timings match the spike);
  - Codex with `"web_search": "disabled"` under the hardened config;
  - the `RUN_LIVE_SMOKE` test.
- Live-check cleanup: killing the proxy orphaned Antigravity's processes, which were stopped by hand. The proxy's orphan sweep would also catch them at the next start. Both Antigravity sessions were purged.

**Follow-ups**
- Optional: a graceful stop for the headless CLI on Windows, since `kill` skips the shutdown hook and orphans Antigravity's child processes. This came up in every live check.
- Still pending: the Codex check in its own home, after the user's first Codex login (AAP-12).

**Status:** committed as `fcd55de` on `AAP-17_web-search`, merged to `master` in PR #13.

## 2026-10-26: AAP-16 Phase 5 (remote MCP servers)

Responses requests can give the agent MCP servers: an http(s) URL in the request, or a label configured in `settings.json` (http, sse or stdio). The agent calls them itself during its turn, and each call comes back as an `mcp_call` output item. This works with Claude, Codex and Antigravity.

**Repository** `api-acp-proxy`, branch `AAP-16_remote-mcp` (stacked on `AAP-15_function-calling` at `5cf41fc`, PR #11 open):
- `src/mcp-config.ts` (new): the label, header-name, plain-value and tool-filter rules, and the `McpServerSpec` type.
- `src/mcp-servers.ts` (new): `resolveMcpServers` matches a request's `mcp` tools with the configured servers. It returns 400 for any of these:
  - a stdio server in a request;
  - a `server_url` or `headers` on a configured label;
  - an unknown label;
  - the reserved label `client`, or a duplicate label;
  - an approval other than `"never"` / `{ never: { tool_names } }`, including a missing one;
  - an empty tool filter.
- `src/api.ts`: Responses `tools: [{ type: "mcp", ... }]` parsing, and a tool prompt generalized to several servers. Echoed `mcp_call` / `mcp_list_tools` input items are accepted and left out of the prompt. Chat Completions still rejects `mcp` tools. `mcp` together with `image_generation` gets a 400.
- `src/settings.ts`, `src/config.ts`:
  - **Setting:** top-level `mcpServers` (`{ url, headers?, transport? }` or `{ command, args?, env? }`).
  - **Validation:** `sanitizeMcpServers` checks entries one at a time at load. An invalid entry, or a non-object `mcpServers`, is dropped with a warning; the rest of the settings loads, and the file is neither moved aside nor rewritten.
  - **Next save:** a save from the settings window writes only the valid entries.
  - **Corrupt files:** a file that isn't valid JSON still gets the `.bak` behaviour.
- `src/provider.ts`: `GenerateOptions.mcpServers`, `McpCallResult`, `McpAccess`, `Provider.mcpSupport`, and tracked `rawOutput` / `content`. `allowTool(permission, tracked, mcp)` takes a third argument. `mcpTarget` is new, and `mcpSessionMeta` replaces `bridgeSessionMeta`.
- `src/acp-provider.ts`:
  - **Capabilities:** reads `mcpCapabilities` at initialize; an `sse` server sent to an agent without sse (Codex) gets 400 `unsupported_parameter`.
  - **Sessions:** a session with `mcp` servers is always fresh. It names the bridge first (when there are function tools), then the remote servers (`http` / `sse` / stdio `{ name, command, args, env }`).
  - **Permissions:** a rule per session covering the session's labels and tool filter, answered only with `allow_once`.
  - **Calls:** remote calls are collected from the `tool_call` updates. An `mcp`-only session is never kept for reuse.
- `src/providers/claude.ts`:
  - **Session settings:** `mcpSessionMeta` gives `allowedTools` entries `mcp__<label>__<tool>`, or `mcp__<label>__*` when there is no filter.
  - **Fallback rule:** `_meta.claudeCode.mcpServer.name`, plus a check on the tool name.
- `src/providers/antigravity.ts`: allows a tool only when `_meta.mcp.server` and `_meta.mcp.tool` are allowed and `is_mcp_tool_call` is set.
- `src/providers/codex.ts`: allows `is_mcp_tool_approval` only when the tracked `tool_call` has an allowed `rawInput.server` and `rawInput.tool`.
- `src/server.ts`: resolves `mcp` tools before a stream starts. Adds `mcp_call` items (`{ id, type, server_label, name, arguments, output, error, status }`) before the message. Streaming emits `output_item.added`, `response.mcp_call.in_progress`, `.completed` / `.failed` and `output_item.done`, and then the message text in one delta.
- `src/router.ts`, `src/acp.ts`: `canUseMcp`.
- Tests:
  - `tests/mcp-servers.test.ts` (new, 31 tests).
  - `tests/settings.test.ts`: 3 new tests for the per-entry `mcpServers` validation.
  - `tests/tool-calling.test.ts`: one override renamed.
  - `tests/fixtures/fake-acp.mjs`: `FAKE_ACP_REMOTE=claude|agy|codex`, `_CALLS`, `_FAIL`, `FAKE_ACP_MCP_CAPS`; the fake now advertises `mcpCapabilities`.
- `README.md`: an "MCP servers" block covering:
  - the request shape and accepted approvals, and the settings JSON with an example;
  - that stdio comes only from settings, and how invalid entries are handled;
  - the output items, per-agent timeouts and Antigravity's placeholder output;
  - the security notes: a request can point the agent at any URL, configured stdio servers run commands on this machine, and settings headers and env are stored in plain text.
- `ROADMAP.md`: one line.
- `.claude/tickets/AAP-11-images-and-tools/plan.md`: Phase 5 status, decisions, deviations and the live table.

**Live check** (headless CLI, temporary settings, `mcp-echo.mjs` over http, a stdio echo server configured as `stdioecho`, `PROXY_CODEX_ISOLATED_HOME=0`):

| Server | Model | Time | `mcp_call` |
|---|---|---|---|
| http | `claude/haiku` | 2.9 s | real result, completed |
| http | `codex/gpt-5.6-luna` | 11.7 s | real result, completed |
| http | `antigravity/gemini-3.8-flash-low` | 14.6 s | placeholder "Docs echo tool call", completed |
| stdio (`stdioecho`) | `claude/haiku` | 3.2 s | real result |
| http, streamed | `claude/haiku` | 2.5 s | the expected event sequence |

**Deviations**
- No `mcp_list_tools` item: no ACP update lists a server's tools, so it is omitted (documented).
- Tool filter:
  - When both `allowed_tools` and `never.tool_names` are given, their intersection applies; an empty result gets 400 `invalid_request`.
  - `never` without `tool_names` means all tools.
  - `tool_choice: "none"` with function tools drops the `mcp` tools too.
  - `tool_choice` and `parallel_tool_calls` stay rejected for an `mcp`-only request.
- With function tools, the tool-set key includes the servers, so only a request with the same tools and servers resumes or reuses the session.
- An `sse` server sent to Codex on a streamed request gets its 400 as an SSE error event, because the check needs the started agent.
- Review fix: per-entry `mcpServers` validation, so a typo in that section no longer resets the whole settings file.
- No settings-window editor for `mcpServers`: JSON only, as decided.

**Verification**
- `npm run typecheck`: clean.
- `npx vitest run`: 291 passed, 1 skipped (19 files).
- `npm run build`: succeeded.
- I ran all three on the final tree after the review fix.
- Not run live: stdio servers with Codex and Antigravity (only Claude), and an `sse` server against Claude or Antigravity.

**Follow-ups**
- Optional: a settings-window editor for `mcpServers`, and encrypted storage for header and env values.
- Still pending: the Codex isolated-home live check after the user's first Codex login (AAP-12).

**Status:** committed as `db1de08` on `AAP-16_remote-mcp`, merged to `master` in PR #12.

## 2026-10-26: AAP-15 Phase 4 (function calling through an MCP bridge)

OpenAI function calling now works with Claude, Codex and Antigravity, for Chat Completions and Responses, streaming too. The client's tools reach each agent through an MCP endpoint that the proxy hosts for that session. A tool call suspends the agent's turn; the client's next request with the results resumes it.

**Repository** `api-acp-proxy`, branch `AAP-15_function-calling` (stacked on `AAP-14_image-generation` at `9d11a14`, PR #10 open):
- `src/tool-bridge.ts` (new):
  - `ToolBridgeHub` serves `/mcp/<token>`, with a 32-byte random token per agent session and 404 for an unknown token. Request bodies are capped.
  - `BridgeSession` answers `initialize` (echoing the protocol version), `ping`, and `tools/list` with every tool marked `readOnlyHint: true`. `server/discover` and other unknown methods get `-32601`, notifications 202, GET 405, DELETE 200.
  - `tools/call` is answered as SSE: a `: keepalive` comment at once and every 20 s, then one `message` event with the result.
  - State is per token, so Antigravity's reconnect works.
  - The hub learns the real listening address from the server and maps a wildcard bind to `127.0.0.1`.
- `src/server.ts`:
  - Routes `/mcp/<token>` before the API-key check (the token is the credential).
  - Rejects tools for a provider that can't take them (400 `model_not_capable`) before a stream starts.
  - Chat output: `finish_reason: "tool_calls"`, `message.tool_calls` and `delta.tool_calls`.
  - Responses output: `function_call` items, with `output_item.added`, `function_call_arguments.delta` / `.done` and `output_item.done`.
- `src/acp-provider.ts`:
  - A request with tools gets a fresh session (never a warm one) whose `session/new` names the `client` MCP server and merges the descriptor's `bridgeSessionMeta` into `_meta`.
  - Tool calls are batched until 150 ms after the latest one. The turn is then suspended, with the pending prompt and the held MCP calls kept and keyed by call id. Suspended turns count against the kept-session cap.
  - The suspension timeout is `min(server.toolResultTimeoutMs, toolCallLimitMs − 30 s)`. On expiry the held calls get an error result, the turn is cancelled and the session disposed.
  - Resume requires the same model, the same tools and the same earlier history, ending with the tool-call message and one result per id. Anything else uses a fresh session with the whole history as text.
  - `parallel_tool_calls: false` returns the first call, and the others get an MCP error.
  - `client` tool updates are tracked per id and never forwarded.
- `src/provider.ts`: `toolCallLimitMs`, `bridgeSessionMeta`, `allowTool(permission, tracked)`, `Provider.toolCalling`, and the tool fields on the generate options and result.
- `src/providers/claude.ts`:
  - `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT=0` in `claudeEnv`.
  - Bridge sessions get `allowedTools: ["mcp__client__*"]`.
  - Fallback permission rule: `_meta.claudeCode.mcpServer.name === "client"`.
- `src/providers/antigravity.ts`: `toolCallLimitMs` 180 000. Allows `toolCall._meta.mcp.server === "client"` with `is_mcp_tool_call`.
- `src/providers/codex.ts`: `toolCallLimitMs` 300 000. Allows `_meta.is_mcp_tool_approval` only when the tracked `tool_call` with that id has `rawInput.server === "client"`. Every rule answers only with `allow_once`, only in sessions that have tools.
- `src/api.ts`:
  - **Chat:** `tools` (`type: "function"`), `tool_choice`, `parallel_tool_calls`, assistant `tool_calls` with null content, and `role: "tool"` messages.
  - **Responses:** `tools` (`function` next to `image_generation`), `tool_choice`, `parallel_tool_calls`, `function_call` / `function_call_output` items, and message items with `type` / `id` / `status`.
  - **Text form of tool history:** `[tool call <id>] name args`, `[tool result <id>]`.
  - **Tool choice:** `none` creates no bridge. `required` or a named function adds an instruction line only.
- `src/controller.ts`, `src/acp.ts`, `src/router.ts`: the controller owns the hub (passed to providers through `RuntimeContext.toolBridge` and to the server) and closes it on stop. The router gains `canCallTools(model)`.
- `src/config.ts`, `src/settings.ts`: `server.toolResultTimeoutMs` (default 600 000, env `PROXY_TOOL_RESULT_TIMEOUT_MS`).
- `README.md`: function calling, timeouts per agent, the suspension and fallback, the usage note. `ROADMAP.md`: tools are now accepted.
- Tests:
  - `tests/tool-calling.test.ts` (new, 42 tests).
  - `tests/fixtures/fake-acp.mjs`: `FAKE_ACP_MCP=claude|agy|codex` with `_CALLS`, `_TEXT`, `_ONCE` and `_STRAY` options.
  - `tests/proxy.test.ts`: the "unsupported field" example is now `functions`. `tests/settings.test.ts` covers the new setting.
- `.claude/tickets/AAP-11-images-and-tools/plan.md`: Phase 4 status, deviations and the live table.

**Live check** (port 18915, OpenAI JS SDK 7.20, tools `get_weather(city)` and `add(a, b)`, `PROXY_CODEX_ISOLATED_HOME=0`):

| API | Model | Round trips | Time |
|---|---|---|---|
| chat | `claude/haiku` | 2 (both tools in round 1) | 3.2 s |
| chat, streamed, first result held 90 s | `claude/haiku` | 2 | 94.3 s |
| chat | `codex/gpt-5.6-luna` | 2 (both tools in round 1) | 11.4 s |
| Responses | `codex/gpt-5.6-luna` | 2 (both tools in round 1) | 10.7 s |
| chat | `antigravity/gemini-3.8-flash-low` | 4 (it retried a call with a wrong argument name) | 25.5 s |

All five answers were correct. The 90 s hold ran past Claude's 60 s JSON limit; the SSE reply and the idle-timeout env carried it.

**Deviations**
- Tools combined with `image_generation` or chat `modalities` are rejected with 400 `unsupported_parameter`.
- Responses message input items accept `type: "message"`, `id` and `status`, because clients send the proxy's own output items back.
- A cancelled suspended turn sends `session/cancel` before answering its held calls with an error, so the agent does not continue on the error.
- In the live runs, Codex returned both tools in one batch, where the spike had seen them strictly one after another. The 150 ms batching handles both.
- `toolResultTimeoutMs` is set in the settings file or by env only; there is no settings-window field.
- A response that ends with tool calls reports estimated usage. The final response carries the agent's usage for the whole prompt, which is inflated for Claude (noted in the README).
- The proxy does not validate tool arguments against the schema; Antigravity once sent `location` instead of `city` and retried.

**Verification**
- `npm run typecheck`: clean.
- `npx vitest run`: 257 passed, 1 skipped (18 files).
- `npm run build`: succeeded.
- I ran all three on the final tree.
- Exercised only by the fake agent, not live:
  - Claude's permission fallback (it isn't needed with `allowedTools`).
  - The full 20 s keepalive and `closeAll` (unit level).
  - Antigravity's 180 s and Codex's 300 s limits (descriptor tests and the injectable timeout test).
  - Codex's approval path appears to have run in the live Codex loop (it completed), but it wasn't inspected separately.

**Follow-ups**
- Optional: validate tool arguments against the declared schema before returning a tool call.
- Still pending: the Codex isolated-home live check after the user's first Codex login (AAP-12).

**Status:** committed as `5cf41fc` on `AAP-15_function-calling`, merged to `master` in PR #11.

## 2026-10-26: AAP-14 Phase 3 (image generation)

Antigravity and Codex now generate images through `/v1/images/generations`, the Responses `image_generation` tool and Chat `modalities`. The live check produced a dolphin from each.

**Repository** `api-acp-proxy`, branch `AAP-14_image-generation`. It was cut on `AAP-13_image-input` and fast-forwarded to `master` at `26612ee` once PR #8 and PR #9 were merged.
- `src/acp-provider.ts`:
  - **Permissions are per session.** `answerPermission` looks up the rule of the session the request belongs to. Only the session of an image request gets one, and it is removed when the turn ends. When the rule allows a request, the proxy picks its `allow_once` option, never `allow_always`; everything else stays `cancelled`.
  - **Images:** collected from completed `tool_call_update` image blocks, with Codex's "Revised prompt:" text.
  - **Agent's file:** deleted after the turn.
  - **Image requests:** don't reuse sessions. One sent to a provider without the capability gets 400 `model_not_capable`.
- `src/generated-images.ts` (new):
  - `toFilePath` reads `file://C:\...`, `file:///C:/...` and plain paths.
  - `deleteGeneratedFile` deletes only a regular file whose real path (symlinks and junctions followed) is strictly inside the agent's image folder. It optionally prunes the emptied parent folder, and it never throws.
- `src/provider.ts`:
  - New types `GeneratedImage` and `ImageGeneration`.
  - New fields: `GenerationResult.images`, `GenerateOptions.images`, `ProviderDescriptor.imageGeneration` (`allow`, `imageFolder`, `pruneEmptyParent`) and `Provider.imageGeneration`.
- `src/router.ts`, `src/acp.ts`: `canGenerateImages(model)`, so the server can reject an incapable model before a stream starts.
- `src/providers/antigravity.ts`: allows `title === "Run generate_image?"` with `kind === "other"`; the image folder is `<GEMINI_HOME>/antigravity-acp/brain`.
- `src/providers/codex.ts`: no permission rule (Codex asks none); the image folder is `<CODEX_HOME>/generated_images` (the isolated home, `$CODEX_HOME` or `~/.codex`), and the emptied thread folder is pruned.
- `src/api.ts`:
  - `normalizeImageGeneration` for the new endpoint.
  - Chat `modalities: ["text", "image"]` and the Responses `image_generation` tool, both set `generateImages`.
  - `buildPrompt` takes a flag that switches to the image preamble and leaves out the provider's no-tools line.
- `src/server.ts`:
  - `POST /v1/images/generations` returns `{ created, data: [{ b64_json, revised_prompt? }], output_format }`. `size` becomes an aspect-ratio hint, and `quality` / `background` become hints.
  - It returns 400 for `n` ≠ 1, `response_format` other than `b64_json`, `mask` / `image` / `images`, `stream: true`, `partial_images`, a bad `size`, and an incapable model. It returns 502 `no_image_generated` with the agent's text.
  - Responses adds `image_generation_call` items, streaming and not. Chat adds `message.images` / `delta.images`.
- `tests/image-generation.test.ts` (new, 28 tests) and `tests/fixtures/fake-acp.mjs`: `FAKE_ACP_IMAGE_GEN=agy|codex` with options `_OPTIONS`, `_OUTSIDE`, `_BYTES` and `_NONE`. The fake also logs permission answers.
- `README.md`: an "Image generation" block under Supported API, the Antigravity safety note and the intro. `ROADMAP.md`: one line.
- `.claude/tickets/AAP-11-images-and-tools/plan.md`: Phase 3 status, deviations and the live-check table.

**Live check** (headless CLI, temporary settings, `PROXY_CODEX_ISOLATED_HOME=0`, prompt "a cartoon dolphin jumping out of the sea"):

| Request | Model | Time | Result | Agent's file |
|---|---|---|---|---|
| `/v1/images/generations` | `antigravity/gemini-3.8-flash-low` | 22.0 s | JPEG, 824,189 bytes | deleted |
| `/v1/images/generations` | `codex/gpt-5.6-luna` | 30.4 s | PNG, 2,088,340 bytes, with a revised prompt | deleted, together with its thread folder |
| `/v1/responses` with `image_generation` | `antigravity/gemini-3.8-flash-low` | 22.2 s | JPEG, 920,944 bytes | deleted |

**Deviations**
- Image requests use their own preamble, which allows one image tool call and no other tool, and they leave out Antigravity's no-tools line, which would forbid the image tool.
- Sessions with images are not kept for reuse.
- In Responses streaming with the image tool, the message text arrives in one delta after the image items. Without the tool, streaming is unchanged.
- Additions beyond the plan:
  - The image endpoint also rejects `stream: true`, `partial_images` and the edit fields.
  - Responses accepts `tool_choice` of `auto`, `required` or `{type: "image_generation"}` when the image tool is present, and `partial_images: 0`.
- Not done: `capabilities.imageGeneration` in `ProviderStatus`. The router and the provider expose it instead.

**Verification**
- `npm run typecheck`: clean.
- `npx vitest run`: 214 passed, 1 skipped (17 files).
- `npm run build`: succeeded.
- I ran all three on the final tree.
- The SDK's ndjson limit is 32 MiB per line; a 6.1 MB update line is tested.
- Not run: the `RUN_LIVE_SMOKE` test. The live check above was done by hand.

**Follow-ups**
- The live proxy was stopped with `kill -TERM`, which on Windows ends the process without a graceful shutdown. No agent processes were left, and the three Antigravity sessions were purged with the proxy's own purge.
- Still pending: the Codex isolated-home live check after the user's first Codex login (AAP-12).

**Status:** committed as `9d11a14` on `AAP-14_image-generation`, merged to `master` in PR #10.

## 2026-10-26: AAP-13 Phase 2 (image input)

Chat Completions and Responses now accept images. They reach Codex, Claude and Antigravity as base64 image blocks; each agent described a test image in the live check.

**Repository** `api-acp-proxy`, branch `AAP-13_image-input` (from `origin/master` at `fa8d586`):
- `src/images.ts` (new):
  - `data:` URLs are decoded (base64 only).
  - `http(s)` URLs are downloaded with at most 3 manual redirects, http(s) only, a 15 s overall timeout, an `image/*` content type and a 10 MB cap (also enforced while streaming). Only an `Accept` header is sent.
  - PNG, JPEG, GIF and WebP are checked by their magic bytes; a declared type must match the bytes.
  - Errors are `unsupported_content` (type) or `invalid_image_url` (URL, body or size).
- `src/api.ts`:
  - The internal `Message` is `{ role, parts: (text | image)[] }`.
  - Chat accepts `image_url` parts; Responses accepts `input_text`, `output_text` and `input_image` (plus `text`). `file_id` and other part types get 400 `unsupported_content`, and images are allowed only in user messages.
  - `normalizeChat` / `normalizeResponses` are async (they load images).
  - `buildPrompt` produces the ACP content blocks. A text-only request is still exactly one text block, byte-identical to before. With images, each image follows its message's text, and the preamble says "an API request with text and images".
- `src/acp-provider.ts`:
  - Reads `promptCapabilities.image` at initialize and exposes it in the status as `capabilities.image`.
  - Images sent to an agent without the capability get 400 `unsupported_content`.
  - Session reuse compares images by SHA-256 and never keeps the base64.
- `src/server.ts` and `src/controller.ts`: the image loader uses the runtime's `fetch`, and Responses errors name the `input` param.
- `src/provider.ts`, `src/acp.ts`, `src/router.ts`: type changes (`Message`, `capabilities`).
- `src/settings.ts`: the default `maxBodyBytes` is 20 MiB (was 1 MiB).
- `README.md`: the top sentence, the env table default, "Supported API" with a new "Images" block, and session reuse with images. The README also says image downloads are not filtered by private address.
- `ROADMAP.md`: images are accepted; audio, files and tools still are not.
- Tests:
  - `tests/images.test.ts` (new, 18 tests).
  - `tests/fixtures/fake-acp.mjs`: `FAKE_ACP_IMAGE=1` advertises the capability, echoes `images:<n>`, and fails `-32602` on a uri-only block.
  - `tests/proxy.test.ts`, `tests/acp-provider.test.ts`, `tests/settings.test.ts` and the other suites were moved to `Message` and the async normalizers.
- `.claude/tickets/AAP-11-images-and-tools/plan.md`: Phase 2 status.

**Live check** (headless CLI, temporary settings file, `PROXY_CODEX_ISOLATED_HOME=0`, `.claude/temp/aap11/red-circle.png` as a data URL):

| Endpoint | Model | Time | Answer |
|---|---|---|---|
| chat | `codex/gpt-5.6-luna` | 8.7 s | "A red circle is centered on a white background." |
| chat | `claude/haiku` | 1.8 s | "A solid red circle on a white background..." |
| chat | `antigravity/gemini-3.8-flash-low` | 6.9 s | "The image shows a solid red circle centered on a white background." |
| Responses (`input_text` + `input_image`) | `claude/haiku` | 3.2 s | same as the Claude chat answer |

**Deviations**
- The preamble's first sentence changes only when a request has images, so the model isn't told it can't see them.
- A streamed request to an agent without image support gets the 400 as an SSE error event, because the capability is known only after the agent starts. All three current agents have the capability.
- Images are accepted only in user messages.
- `image/jpg` is accepted as an alias of `image/jpeg`.
- Not implemented: a cap on images per request, private-address filtering of downloads (documented), and image tokens in the fallback usage estimate.

**Verification**
- `npm run typecheck`: clean.
- `npx vitest run`: 186 passed, 1 skipped (16 files).
- `npm run build`: succeeded.
- I ran all three on the final tree.
- Not tested: the 15 s download timeout itself (the other limits are).
- The live check stopped the proxy with a hard kill, which orphaned its Antigravity child. The implementer killed it by hand, and the proxy's own orphan sweep also covers this case.

**Follow-ups**
- Optional: private-address filtering for image downloads, if the proxy is ever bound beyond localhost.
- Optional: a cap on images per request.
- The Codex isolated-home live check still waits for the user's first Codex login (AAP-12).

**Status:** committed as `dabba93` on `AAP-13_image-input`, merged to `master` in PR #8.

## 2026-10-26: AAP-12 Phase 1 (agent hardening)

Codex now runs without shell tools, skills or plugins, in its own home by default. Claude's login-refresh clash becomes a retryable 503, and Antigravity gets a no-tools prompt line. A live check in the new Codex home is waiting for the user's first login.

**Repository** `api-acp-proxy`, branch `AAP-12_agent-hardening` (stacked on `AAP-11_tool-spike` at `75bea33`):
- `src/providers/codex.ts`:
  - `hardenedCodexConfig()` merges the user's `CODEX_CONFIG` and then forces `approval_policy: never`, `sandbox_mode: read-only`, `skills.include_instructions: false`, and `features` `multi_agent`, `shell_tool`, `unified_exec` and `plugins` all false. A user value cannot weaken these.
  - With `isolatedHome` (default on), Codex runs with `CODEX_HOME=<dataDir>/codex-home`, created if missing.
  - On a fresh isolated home with no `auth.json` (checked with `existsSync` only) and no API key, the eager auth is skipped. The provider reports `needs_login` instead of opening a browser at every start, and the Log in button runs `chat-gpt`.
- `src/provider.ts`:
  - `AcpUnavailableError` takes an optional `retryAfterSeconds`.
  - `ProviderDescriptor` gains `promptPreamble`, `loginRequired` and `defaultLoginMethod`.
- `src/acp-provider.ts`:
  - The eager start honours `loginRequired`.
  - `login()` falls back to `defaultLoginMethod`.
  - Prompts carry the descriptor's `promptPreamble`.
- `src/api.ts`: `serializePrompt` takes an optional extra preamble line; other providers' prompts are unchanged.
- `src/providers/claude.ts`: `mapError` maps "Failed to refresh OAuth token ... another Claude Code process is refreshing" to 503 `provider_busy` with `Retry-After: 30`.
- `src/server.ts`: sends `Retry-After` for such errors (non-streaming responses only).
- `src/providers/antigravity.ts`: a no-tools line in the preamble.
- `src/settings.ts`, `src/shared/ipc.ts`, `src/renderer/settings.html`, `src/renderer/settings.ts`: the setting `providers.codex.isolatedHome` (default true, env `PROXY_CODEX_ISOLATED_HOME`) and a checkbox on the Codex card.
- `README.md`:
  - A Codex section covering the hardening, the separate home, the one extra login and how to log out.
  - The env table row and the files table.
  - Notes on Claude's busy error and the Antigravity prompt line.
- Tests:
  - `tests/codex.test.ts` (new): launch env, a hostile `CODEX_CONFIG`, and first login with no automatic `authenticate`.
  - `tests/settings.test.ts`, `tests/claude.test.ts` (503 plus the header over HTTP) and `tests/antigravity.test.ts` (preamble only for Antigravity).
  - `tests/fixtures/fake-acp.mjs`: `FAKE_ACP_PROMPT_ERROR`.
- `.claude/tickets/AAP-11-images-and-tools/spike.md` ("Phase 1 (AAP-12) probe") and `plan.md` (Phase 1 status).

**Probe findings** (details in `spike.md`)
- **Shell:** `approval_policy: "untrusted"` is rejected by this Codex (0.154.0), and `"on-request"` still ran listings without asking. Only `features.shell_tool` plus `unified_exec` off removes the shell.
- **Still working under the hardened config:** image generation (35.6 s, no permission), web search (8.3 s, no permission) and MCP approvals (`is_mcp_tool_approval`, blocked by `cancelled`). The skill list and the "Skill descriptions were shortened" text are gone.
- **Isolated home:**
  - User MCP servers (`cua_repl` and others) and plugin skills are gone.
  - `~/.agents/skills` is still listed, because it is under the user profile and cannot be hidden. It is unreachable without a shell and without the skill list.
  - `authenticate chat-gpt` opens the browser itself and prints no URL.
- **Antigravity preamble:** no measurable gain. The proxy's generic preamble already stopped the tool attempts the spike saw with raw prompts. The line is kept as a guard.

**Deviations**
- The shell is stopped by feature switches, not an approval policy. `plugins` and `skills.include_instructions` were also turned off.
- Codex has no `loginUrlPattern`, because no URL is printed, so the Codex card shows no login link.
- Review fix: no automatic browser sign-in at start. The first run left eager auth on, which would open a ChatGPT tab at every start of a fresh isolated home.
- `ROADMAP.md` is unchanged; it lists hub limits, not provider hardening.

**Verification**
- `npm run typecheck`: clean.
- `npx vitest run`: 168 passed, 1 skipped (15 files).
- `npm run build`: succeeded.
- I ran all three on the final tree after the review fix.
- Live probes for the shell, image generation, search, MCP approval and the Antigravity timings ran on the user's normal Codex home.
- Not verified:
  - A live prompt in the isolated home, pending the user's Codex login: no skills or MCP visible, image generation and search, `generated_images` landing in that home.
  - That deleting `codex-home` logs out (it assumes Codex's default file credential store).
  - Which of the two shell feature switches alone is enough.

**Follow-ups**
- After merging, the user logs in to Codex once for the proxy (Log in button on the Codex card), and then the isolated-home live check runs.
- Probe leftovers: a Codex image in `~/.codex/generated_images/01a179d6-...` and the AAP-11 Antigravity sessions. Nothing was deleted.

**Status:** committed as `6e81ff3` on `AAP-12_agent-hardening`, merged to `master` in PR #6.

## 2026-10-26: plan revised after the spike

The user confirmed they still use Codex. `plan.md` phases 1 to 5 were rewritten from `spike.md` and now run as phases 1 to 6 (AAP-12 to AAP-17):
- **New phase 1, agent hardening (AAP-12):**
  - Codex gets a dedicated `CODEX_HOME` (setting `providers.codex.isolatedHome`, default on) and a shell setting that stops silent `exec_command`, both checked by a short probe first.
  - Claude's OAuth refresh-lock error maps to a retryable 503.
  - Antigravity gets a no-tools preamble line.
- **Images in (AAP-13):** base64 `data` only.
- **Image generation (AAP-14):** covers Antigravity (permission-gated) and Codex (not gated). Images come from the completed `tool_call_update`, and the agent's file is deleted only inside its image folder.
- **Function calling (AAP-15):**
  - `tools/call` is answered as SSE with keepalives.
  - Tools are marked `readOnlyHint`.
  - Per-agent permission rules, and `allowedTools` for Claude.
  - `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT=0`.
  - Per-provider suspension timeouts: Antigravity 150 s, Codex 270 s.
  - Antigravity's calls are matched by order.
- **Remote MCP (AAP-16) and web search (AAP-17):** adjusted to the agents' limits. Search stays optional.
- `spike.md`: the "user has no Codex" notes are corrected.

**Status:** committed as `75bea33` on `AAP-11_tool-spike`, merged to `master` in PR #7.

## 2026-10-26: AAP-11 Phase 0 (spike)

Codex, Claude and Antigravity were probed live for image input, image generation, MCP tools, permissions and web search. The findings and the per-agent rules for phases 1 to 5 are in `spike.md`. No proxy code changed.

**Repository** `api-acp-proxy`, branch `AAP-11_tool-spike` (from `origin/master` at `e7dfc02`):
- `scripts/acp-probe.mjs`:
  - New flags: `--mcp-url` (repeatable; http MCP servers named `client`, `client2`, ...), `--meta` (`_meta` on `session/new`), `--mode`, `--model`, `--image` (base64 block), `--image-uri` / `--image-mime` (uri-only block), `--allow <regex>` (answers only matching permission requests with `allow_once`, else `cancelled`), `--dump` (JSON lines of every update and permission request with the answer given), `--unset-env`, `--cwd`, `--keep-cwd`.
  - Prints the full `agentCapabilities`.
  - `--allow` also tests the merged `tool_call` fields of the same `toolCallId`, because Codex's permission request carries only the id.
  - A given `--cwd` is never deleted.
- `.claude/tickets/AAP-11-images-and-tools/spike.md`: new, the findings.
- `.claude/tickets/AAP-11-images-and-tools/plan.md`: Phase 0 status checklist.
- Not in the repository: `.claude/temp/aap11/mcp-echo.mjs` (test MCP server with `echo`/`add`, `--delay-ms`, `--sse`, `--keepalive-ms`, `--read-only-hint`) and the raw logs in `.claude/temp/aap11/out/`.

**Deviations and decisions**
- Two sessions worked on the spike at the same time: the implementer started from this session, and the "Proxy safety comparison" session in this folder. Both wrote to `.claude/temp/aap11/out/`; the other session wrote the first `spike.md`, `changelog.md` and the plan status, and the implementer added to them. Where runs overlap, the results agree. Mock MCP servers were killed from outside twice, and the two long-wait runs that were cut short were re-run.
- The other session recorded "the user has no Codex", so Codex was not probed after that. The Codex results come from earlier runs. The user later corrected this: Codex stays (see the entry above).
- The test MCP server gained `--sse`, `--keepalive-ms` and `--read-only-hint` beyond the plan, because Claude's timeout and parallel calls depend on them.

**Findings that change the plan** (details in `spike.md`, "Where the findings contradict the plan")
- **Phase 1:** only base64 image `data` works. A `uri`-only block is rejected by Codex and Claude with `-32602`, and makes Antigravity hang.
- **Phase 2:**
  - Antigravity: `generate_image` asks permission (title `Run generate_image?`, kind `other`). The image comes back inline as base64 JPEG in the completed `tool_call_update`; the file goes to `~/.gemini/antigravity-acp/brain/<sessionId>/`, not the session cwd. Cancelling writes nothing.
  - Codex: generates without any permission request, so the proxy cannot gate it.
  - Claude has no image tool.
- **Phase 3:**
  - Claude drops a `tools/call` held longer than 60 s unless it is answered as SSE, and then aborts after 300 s of silence unless `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT=0` (verified with a 330 s hold). `MCP_TOOL_TIMEOUT` is not the variable.
  - Antigravity (3 min) and Codex (300 s) have fixed tool-call limits, so the suspension timeout must be per provider.
  - Only Claude sends parallel calls, and only for tools marked `readOnlyHint: true`.
  - Antigravity's `tools/call` carries no call id, so calls are matched by order.
  - Permission rules per agent: Claude `allowedTools: ["mcp__client__*"]` (then no permission request is sent at all); Antigravity `_meta.mcp.server === "client"`; Codex `_meta.is_mcp_tool_approval` matched to the earlier `tool_call` with `rawInput.server === "client"`.
- **Phase 5:** built-in search works with only that tool allowed (Claude `WebSearch`, Antigravity `search_web`) but is not clearly faster: Claude's first token came at 16 s against 3 s plain. Codex search is always on, per process. Phase 5 stays optional.
- **Codex hardening:** the "built-in tools off" rule does not hold for Codex today. It reads the user's skills, ran a user MCP tool (`cua_repl`) without a permission request, and tries shell commands.

**Verification**
- `npm run typecheck`: clean (implementer's run after the last edit).
- `npm test`: 147 passed, 1 skipped, 13 files (implementer's run).
- Reviewed: the `scripts/acp-probe.mjs` diff and `spike.md`. Not re-run by the orchestrator.
- Not tested: whether SSE keepalive or MCP progress events reset Claude's 300 s timer; whether `allowedTools` also skips the `WebSearch` permission; Codex's `supports_parallel_tool_calls`.

**Follow-ups**
- Correct `plan.md` phases 2, 3 and 5 to match these findings before phase 1 starts.
- Purge the Antigravity probe sessions listed in `spike.md` (and the Codex PNG in `~/.codex/generated_images/`), or leave them to the proxy's purge.
- Map Claude's transient "another process is refreshing the OAuth token" error to a retryable 503.
- Codex hardening ticket (skills, user MCP servers, read-only shell reads), if Codex stays in use.

**Status:** committed as `75bea33` on `AAP-11_tool-spike`, merged to `master` in PR #7.
