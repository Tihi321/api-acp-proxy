# AAP-11 to AAP-16: Images and tools

> Roadmap item: "Text only: images, audio, files and tools are still rejected." Each phase gets its own ticket branch (`AAP-NN_<what>`), stacked on the one before and cut from `master` (AAP-10 merged). Each phase is mergeable without the ones after it.
>
> **Revised 2026-10-26 after the spike** (`spike.md`). The user still uses Codex, so it stays in every phase. Changes from the first version: a new phase 1 hardens the agents (Codex runs tools without asking today), so the later phases shift by one ticket number. Phase 2 sends only base64 images. Phase 3 takes images from the agent's updates instead of files in the cwd, and covers Codex. Phase 4 answers held tool calls as SSE, with per-provider timeouts and per-agent permission rules. Phase 6 covers Codex's always-on search.

| Phase | Ticket | Branch | What |
|---|---|---|---|
| 0 | AAP-11 | `AAP-11_tool-spike` | Probe the three agents: images in, images out, MCP tools, permissions, search (done) |
| 1 | AAP-12 | `AAP-12_agent-hardening` | Isolate Codex from the user's skills, plugins and MCP servers; stop its silent shell reads; small fixes found by the spike |
| 2 | AAP-13 | `AAP-13_image-input` | Images in requests (vision), all three agents |
| 3 | AAP-14 | `AAP-14_image-generation` | `/v1/images/generations` and the Responses `image_generation` tool: Antigravity and Codex |
| 4 | AAP-15 | `AAP-15_function-calling` | OpenAI function calling through an MCP bridge hosted by the proxy |
| 5 | AAP-16 | `AAP-16_remote-mcp` | Responses `type: "mcp"` tools and MCP servers named in settings |
| 6 | AAP-17 | `AAP-17_web-search` | Optional: the agents' own web search |

## Ground rules (all phases)

- The Claude system prompt stays the `claude_code` preset (we never send `_meta.systemPrompt`; see `claude-agent-acp/dist/acp-agent.js` ~8081). Client system/developer messages stay inside the prompt text.
- Built-in agent tools stay off: no shell, no file edits, no `WebFetch`. A feature turns on only the one capability it needs, only for a request that asked for it. Where an agent cannot switch a tool off, this is stated per agent:
  - Antigravity always offers `search_web`, `read_url_content` and `run_command`. All of them ask permission, so `cancelled` blocks them, at a latency cost.
  - Codex's image tool and web search run without a permission request. Phase 1 decides what can be switched off.
- The permission handler (`src/acp-provider.ts:238`, today: always `cancelled`) becomes per session: a session carries an allow rule set by its request (image tool, bridge tools, named MCP servers, search). Everything else is still `cancelled`. The proxy only ever picks an `allow_once` option, never `allow_always` / `allow_session` / `allow-with-updates`.
- Images go to agents only as base64 `data`. Never send a `uri`: Codex and Claude reject it with `-32602`, and Antigravity hangs the turn.
- No new long-lived state on disk. Generated images are taken from the agent's update; the file the agent wrote is deleted, but only when its path is inside that agent's known image folder.
- Tests use the fake agent only (`tests/fixtures/fake-acp.mjs`, extended per phase); live checks stay behind `RUN_LIVE_SMOKE=1`. `scripts/acp-probe.mjs` (with `--allow`, `--dump`, `--mcp-url`) and `.claude/temp/aap11/mcp-echo.mjs` are the tools for live checks.
- Node is not on PATH in some shells: use `%APPDATA%\fnm\node-versions\v24.14.0\installation\node.exe`.

## Phase 0: spike (AAP-11)

Write findings to `.claude/tickets/AAP-11-images-and-tools/spike.md`. Extend `scripts/acp-probe.mjs` as needed: `--mcp-url <url>` (passed in `session/new`), `--image <file>` (sends an image block), `--allow <regex>` (answers permission requests whose JSON matches with the first allow option, logs all of them), and dumping every `session/update` and `session/request_permission` as JSON lines. For each of Codex, Claude and Antigravity, record:

1. `initialize.agentCapabilities`: `promptCapabilities.image`, `mcpCapabilities` (http / sse). Known: Claude and Antigravity have image + http + sse; Codex is unknown.
2. **Image input:** send a small PNG and ask what is in it. Does a `uri`-only image block work, or only base64 `data`?
3. **Image generation** (Antigravity; also check Codex): prompt "Generate an image of a cartoon dolphin". Record the tool call updates (`kind`, `title`, `rawInput`), any permission request and its options, where the file lands (session cwd, `<GEMINI_HOME>/antigravity-acp/brain/...`), whether any update carries an `image` / `resource_link` content block, the file type, and how long it takes. Then repeat with that permission answered `cancelled` to confirm nothing is written.
4. **MCP bridge:** run a throwaway MCP server (a ~40-line script in `.claude/temp/`, Streamable HTTP with JSON responses, one `echo` tool whose `tools/call` answer is delayed by 60 s) and point each agent at it. Record: the tool name the model sees (Claude: `mcp__<server>__echo`), whether a permission request comes first and how to recognise it, whether Claude needs `allowedTools` with `tools: []`, the agent's tool-call timeout (Claude: `MCP_TOOL_TIMEOUT`), whether parallel calls arrive together, and what Codex does with `approval_policy: "never"` + read-only sandbox.
5. **Search:** whether each agent can search with only that tool allowed (Claude `tools: ["WebSearch"]`; Codex `web_search` config, and whether codex-acp can change it per session; Antigravity's search tool name), and the time to first token against a plain prompt.

Done when `spike.md` answers every point above for the agents that are logged in. Phases 1 to 5 then fill in the per-agent rules marked "(from spike)".

**Status (2026-10-26): done.** See `spike.md` ("Rules for phases 1 to 5" at the end).
- [x] Probe extended (`scripts/acp-probe.mjs`: `--mcp-url`, `--meta`, `--mode`, `--model`, `--image`, `--image-uri`, `--allow`, `--dump`, `--unset-env`, `--cwd`, `--keep-cwd`, prints `agentCapabilities`); throwaway MCP server `.claude/temp/aap11/mcp-echo.mjs` (JSON, optional `--sse`, `--read-only-hint`).
- [x] 1 capabilities: all three agents.
- [x] 2 image input: all three (base64 only; `uri` rejected or hangs).
- [x] 3 image generation: Antigravity (allowed and cancelled), Codex (allowed only), Claude has none.
- [x] 4 MCP bridge: all three. Timeouts found: Claude 60 s (JSON response) / 300 s idle (raise with `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT=0`, verified at 330 s), Antigravity 3 min fixed, Codex 300 s fixed. Codex was probed only partly (see the correction at the top of `spike.md`).
- [x] 5 search: all three. Codex's `web_search` is on by default (no permission; per process only via `CODEX_CONFIG`).
- Deviations: `--allow` also matches the merged `tool_call` fields of the same `toolCallId` (Codex's permission request carries only the id); the MCP server gained `--sse` and `--read-only-hint` because Claude's timeout and parallelism depend on them. Findings that change phases 2 and 3 are listed at the end of `spike.md`.

## Phase 1: agent hardening (AAP-12)

The spike showed that Codex does not hold to "built-in tools off" today:
- It reads the user's skills (`~/.codex/skills`, `~/.agents/skills`).
- It loads the user's plugin MCP servers and ran one (`cua_repl`) without a permission request.
- It runs read-only `exec_command` reads (through the user's PowerShell profile) without asking.
- It prints "Skill descriptions were shortened" as answer text.

All of that comes from the user's own Codex home, plus `approval_policy: "never"`. This phase fixes it before any feature opens more doors.

1. **Probe first** (`scripts/acp-probe.mjs`, Codex, a cheap model; add findings to `spike.md` under "Phase 1"):
   - **Dedicated `CODEX_HOME`:** `CODEX_HOME=<dataDir>/codex-home` (an empty folder, no `config.toml`) with `authenticate chat-gpt`. Does codex-acp start a browser login there (the proxy never touches `auth.json`)? With that home, are skills, plugins and user MCP servers gone? Does the "Skill descriptions were shortened" text go away? Is the `.system` imagegen skill still installed?
   - **Shell:** which `CODEX_CONFIG` key stops `exec_command` without approval? Try `approval_policy: "untrusted"` and `"on-request"` (the shell must then ask, and the proxy cancels), and a `features` switch for the shell tool if codex-acp's Codex version has one. Check that image generation and web search still work without a permission request, and that MCP calls still send `is_mcp_tool_approval` requests.
   - **Search:** with the hardened home, does `"web_search": "disabled"` still make the model improvise (it can no longer reach skills or MCP; shell requests are cancelled)?
2. **`src/providers/codex.ts`**: launch with the dedicated `CODEX_HOME` when the setting `providers.codex.isolatedHome` is on (default `true`). `false` keeps the user's `~/.codex` (today's behaviour) for users who want their own config. Apply the shell setting the probe found.
   - Web search stays on, as today. It is per process and runs on OpenAI's side.
   - The image tool cannot be gated: Codex would answer an image request even without phase 3.
3. **Login**: with an isolated home the user logs in once for the proxy. The provider card's Login button runs `authenticate chat-gpt` (existing `login()` path). README: where the home is, how to log out, and that `CODEX_API_KEY` / `OPENAI_API_KEY` still work.
4. **Claude**: map `-32603 "Failed to refresh OAuth token: another Claude Code process is refreshing it"` to 503 `provider_busy` with a `Retry-After: 30` header (`mapError` in `src/providers/claude.ts`).
5. **Antigravity**: add a preamble line for Antigravity telling it not to use tools unless the request enables one. The spike saw it try `search_web`, `read_url_content` and `run_command` for plain prompts, which cost about 13 s of cancelled calls. Measure before and after with one plain prompt.
6. **Tests**:
   - The Codex launch env has `CODEX_HOME` when isolated and not when off.
   - The settings default is `true`, and the env override works (`PROXY_CODEX_ISOLATED_HOME`).
   - The Claude refresh error maps to 503 `provider_busy`.
   - The fake agent gets `FAKE_ACP_PROMPT_ERROR=<json>` to return a given error.

## Phase 2: image input (AAP-13)

All three agents advertise `promptCapabilities.image: true` and accept base64 PNG (2.5 to 4.6 s for a small image).

1. **`src/api.ts`**: the internal message becomes `Message = { role; parts: Part[] }` with `Part = { type: "text"; text } | { type: "image"; mimeType; data: string /* base64 */ }`. `TextMessage` callers move over; `asText` stays for text-only paths.
   - Chat parts: `text`, `image_url` (`{ url, detail? }`). Responses parts: `input_text`, `output_text`, `input_image` (`{ image_url, detail? }`), plus the current `text`. `file_id` and other part types → 400 `unsupported_content`.
   - URLs: `data:` URLs are decoded. `http(s)` URLs are downloaded by the proxy (`ctx.fetch`, 15 s timeout, ≤ 3 redirects, `image/*` only, 10 MB cap). PNG, JPEG, GIF and WebP only. The agent always gets `{ type: "image", mimeType, data }`, never a `uri` (see ground rules).
2. **`src/acp-provider.ts`**: the prompt becomes a list of content blocks. Text is serialized as today, and each image block follows the text of its message. Read `promptCapabilities.image` from `initialize` and keep it in the provider status. A request with images for an agent without it → 400 `unsupported_content` (param `messages`); this is a guard for future agents, since all three have it today.
3. **Session reuse**: transcript comparison compares image parts by SHA-256.
4. **Config**: raise the default `PROXY_MAX_BODY_BYTES` from 1 MiB to 20 MiB (base64 images); README note.
5. **Tests**:
   - Data URLs and downloads (a local HTTP server in the test) reach the fake agent as `data` image blocks with no `uri`.
   - Bad MIME type, oversize and `file_id` → 400.
   - An agent without the image capability → 400.
   - Reuse with the same image matches; with a different image it does not.
   - Fake agent: `FAKE_ACP_IMAGE=1` advertises the capability, echoes the image count, and fails `-32602` on a uri-only block.
6. **Live check**: describe `.claude/temp/aap11/red-circle.png` through `/v1/chat/completions` on each agent.

## Phase 3: image generation (AAP-14)

What the agents do (spike section 3):

| | Antigravity | Codex | Claude |
|---|---|---|---|
| Tool | `generate_image` | built-in "Image generation" | none |
| Permission | yes: `toolCall.title === "Run generate_image?"`, `kind === "other"`; pick the `allow_once` option (`optionId: "allow"`) | none (cannot be gated) | n/a |
| Image | completed `tool_call_update`, `content[].content` = `{ type: "image", mimeType: "image/jpeg", data, uri }` | completed `tool_call_update`, `content[]` image block `image/png` (also `rawOutput.result`) plus a "Revised prompt: ..." text block | n/a |
| File written | `rawOutput.imagePath` in `<GEMINI_HOME>/antigravity-acp/brain/<sessionId>/` | `uri` / `rawOutput.savedPath` in `<CODEX_HOME>/generated_images/<threadId>/` | n/a |
| Time | ~10 s generation, ~21 s turn | ~25 s generation, ~37 s turn | |

1. **Provider capability**: `ProviderDescriptor.imageGeneration?: { allow?(permission): boolean; imageFolder(ctx): string }`.
   - Antigravity: `allow` is the rule above; the folder is `<GEMINI_HOME>/antigravity-acp/brain`.
   - Codex: no `allow` (no permission is asked); the folder is `<CODEX_HOME>/generated_images`, the isolated home from phase 1 or `~/.codex`.
   - Claude has none.
2. **`AcpProvider.generate`** gains `options.images?: true`.
   - Only that session allows the image permission (Antigravity).
   - Collect every `image` content block from completed `tool_call_update`s into `result.images: { mimeType, data, revisedPrompt? }[]`. Codex's revised prompt comes from its "Revised prompt:" text block.
   - Then delete the file named by the block's `uri` / `rawOutput.imagePath` / `rawOutput.savedPath`, only if it resolves inside `imageFolder` (and the empty `<threadId>` folder for Codex).
   - In requests without `options.images`, images are dropped from the output as today, and Codex's file is still deleted (it may generate on its own).
3. **Large updates**: a Codex image update line is about 6 MB (the base64 twice). Make sure the ndjson reader in the ACP SDK takes it (test with a 6 MB fake update), and never log update bodies above debug level.
4. **`POST /v1/images/generations`** (`src/server.ts`): `{ model, prompt, n?: 1, size?, quality?, response_format?: "b64_json", output_format?, background? }`.
   - `n > 1`, `response_format: "url"`, `mask` and edits → 400.
   - `size` becomes an aspect-ratio hint in the prompt (Antigravity's tool takes `AspectRatio`, for example `4:3`). `quality` and `background` are hints.
   - `output_format` is accepted but the agent decides the format: Antigravity JPEG, Codex PNG. Document it.
   - The answer is `{ created, data: [{ b64_json, revised_prompt? }], output_format }`.
   - Model ids are the chat models of a capable provider. A model whose provider cannot generate → 400 `model_not_capable`. An answer with no image → 502 `no_image_generated`, with the agent's text in the message (for example a refusal).
5. **Responses** `tools: [{ type: "image_generation", ... }]`: adds an `image_generation_call` output item (`{ id, type, status: "completed", result: <base64>, revised_prompt?, output_format }`) before the message; streaming emits `response.output_item.added` / `done` for it. The tool's other options are accepted and ignored, except `partial_images` → 400.
6. **Chat** (optional, OpenRouter style): `modalities: ["text", "image"]` → `message.images: [{ type: "image_url", image_url: { url: "data:..." } }]`.
7. **Tests**:
   - Fake agent `FAKE_ACP_IMAGE_GEN=agy|codex` sends the spike's update sequence (with the permission for `agy`) and writes the file into a test `GEMINI_HOME` / `CODEX_HOME`.
   - Check the endpoint and the Responses item; for `agy`, that only that permission is allowed.
   - The file is deleted, and a path outside the image folder is not.
   - A provider without the capability → 400; no image → 502.
8. **Live check**: a dolphin from `antigravity/<model>` and from `codex/gpt-5.6-luna` through `/v1/images/generations`.

## Phase 4: function calling through an MCP bridge (AAP-15)

**Flow.** A request with `tools` gets a fresh session (not from the warm pool) whose `session/new` names one MCP server, `client`, at `http://127.0.0.1:<port>/mcp/<token>`. The token is 32 random bytes per session; the address is 127.0.0.1 even when the proxy binds `0.0.0.0`. When the agent calls a tool, the proxy:
1. ends the HTTP response with the tool calls (chat: `finish_reason: "tool_calls"`; Responses: `function_call` items), together with any text streamed before them;
2. keeps the session, the still-pending ACP prompt and the held MCP `tools/call` request(s) in a `suspended` map, keyed by the client-facing call ids;
3. when the next request's history ends with that assistant tool-call message and its results (`tool` messages / `function_call_output` items for every id), answers the held calls with those results and streams the rest of the same turn into the new response.

If nothing matches (proxy restarted, history edited, the ids are unknown, the suspension expired), it falls back to a fresh session with the whole history, tool calls and results included, serialized as text. So clients never break; they only lose the fast path.

What the agents do (spike section 4):

| | Claude | Antigravity | Codex |
|---|---|---|---|
| Name the model sees | `mcp__client__<tool>` | `client_<tool>` | `mcp.client.<tool>` |
| Permission | none with `allowedTools: ["mcp__client__*"]`; fallback rule `_meta.claudeCode.mcpServer.name === "client"` → `allow-once` | `toolCall._meta.mcp.server === "client"` and `_meta.is_mcp_tool_call` → `allow` | request has only `toolCallId` + `_meta.is_mcp_tool_approval`; match the earlier `tool_call` with that id and `rawInput.server === "client"` → `allow_once` |
| Held-call limit | 60 s for a JSON reply; with an SSE reply, 300 s of silence unless `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT=0` (then none; 330 s verified) | 180 s, fixed | 300 s, fixed |
| Parallel calls | yes, only for tools with `annotations.readOnlyHint: true` (24 ms apart) | no: the next call is sent only after the previous one is answered | no (same) |
| Call id in `tools/call` | `_meta["claudecode/toolUseId"]` | none (match by order) | `_meta.callId` |
| Handshake | `server/discover` (→ -32601), `initialize` 2025-11-25, GET (→ 405) | the same, and it reconnects (new `initialize`) at the first call | `initialize` 2025-06-18 |

Steps:
1. **`src/tool-bridge.ts`** (new), a minimal hand-written MCP Streamable HTTP endpoint:
   - `initialize` echoes the client's protocolVersion, with `capabilities: { tools: {} }`.
   - Unknown methods (`server/discover`) → `-32601`. `notifications/*` → 202. `ping`. GET → 405. DELETE → 200. No `mcp-session-id` is needed.
   - `tools/list` returns the request's tools, each with `annotations.readOnlyHint: true`. That is what lets Claude batch parallel calls; the proxy never runs these tools itself, so the hint only affects scheduling.
   - `tools/call` is answered as **SSE**: `200 text/event-stream` with a `: keepalive` comment at once and every 20 s, then one `message` event with the JSON-RPC result. This avoids Claude's 60 s limit. All other methods answer with plain JSON.
   - It must work across reconnects: state is per token, not per HTTP connection (Antigravity re-initializes at the first call).
   - It is routed in `createProxyServer` before the API-key check; the token is the credential, and an unknown token → 404.
   - The `@modelcontextprotocol/sdk` transport is not needed.
2. **Request parsing (`src/api.ts`)**:
   - Chat: `tools` (`type: "function"` only; other types → 400), `tool_choice` (`none` / `auto` / `required` / a named function), `parallel_tool_calls`, assistant messages with `tool_calls` and null content, and `role: "tool"` messages.
   - Responses: `tools` (`type: "function"`), `tool_choice`, `parallel_tool_calls`, and `function_call` / `function_call_output` input items.
   - Remove these from the unsupported lists.
3. **`src/acp-provider.ts`**:
   - **Options and result:** `generate()` options gain `tools`, `toolChoice` and `parallelToolCalls`; `GenerationResult` gains `toolCalls?: { id, name, arguments }[]`, and the stop reason is `"tool_calls"`.
   - **Call ids:** the proxy assigns `call_<random>` when a `tools/call` reaches the bridge. The ACP `tool_call` updates for `client` tools are only used for the permission rule (Codex) and are not forwarded. Antigravity's completed update carries a placeholder text, not the result.
   - **Batching:** collected for 150 ms after the latest `tools/call`. Only Claude ever sends more than one; for Antigravity and Codex each tool round trip is its own HTTP response. With `parallel_tool_calls: false`, only the first call of a Claude batch is returned, and the others get an MCP error result asking to call one tool at a time.
   - **Suspension timeout:** a new `ProviderDescriptor.toolCallLimitMs`: Claude unlimited, Antigravity 180 000, Codex 300 000. The timeout is `min(server.toolResultTimeoutMs (default 10 min), toolCallLimitMs − 30 s)`, so 150 s for Antigravity and 270 s for Codex. On expiry the held calls get an MCP error result, the turn is cancelled and the session disposed; a late follow-up uses the text fallback. Count suspended sessions against the kept-session cap.
   - **Resume:** reuses the streaming callbacks and the AAP-09 limit logic of the new request.
   - **Reuse:** after a normal `end_turn`, session reuse (AAP-10) keeps the session as today, with tool calls and results in the transcript.
4. **Prompt and choice**: with tools, the preamble says to use only the `client` tools and never to run commands or touch files. `tool_choice: "none"` → no MCP server (history with tool messages uses the text fallback). `required` / a named function → an instruction line (best effort; document that it is not enforced).
5. **Agent specifics**:
   - **Session `_meta` per request:** add `allowedTools: ["mcp__client__*"]` to `claudeCode.options` for bridge sessions only (warm sessions keep the static meta).
   - **Permission rules:** add the rules from the table to each descriptor as `allowTool(permission, trackedCall)`; the provider tracks `tool_call` fields per id for Codex.
   - **Claude env:** `claudeEnv` sets `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT=0` (not `MCP_TOOL_TIMEOUT`).
   - **Usage:** Claude turns that held a call open report inflated usage (180k to 370k tokens, mostly cache). Pass it through as reported and note it in the README.
6. **Responses streaming**: `response.output_item.added` (`function_call`), `response.function_call_arguments.delta` / `.done`, `response.output_item.done`; a terminal `response.completed`. Chat streaming: `delta.tool_calls[{ index, id, type, function: { name, arguments } }]`.
7. **Tests**: the fake agent gains `FAKE_ACP_MCP=claude|agy|codex`. On prompt it connects to the `mcpServers` URL from `session/new`, sends that agent's handshake, a permission request in that agent's shape, and `tools/call` (two at once for `claude`), then answers with the tool results as text. Cover:
   - chat and Responses, streaming and not;
   - resume on the same session;
   - parallel calls (claude) and `parallel_tool_calls: false`;
   - the SSE reply with keepalive;
   - a reconnect with a new `initialize` (agy);
   - the per-provider timeout and the fallback after it;
   - a wrong token → 404; `tool_choice: "none"`;
   - a permission allowed only for `client` tools, including a Codex request whose id matches no `client` call → cancelled.
8. **Live check**: the OpenAI JS SDK running a two-tool loop against Claude, Codex and Antigravity, with one tool result returned after 90 s (beyond Claude's 60 s JSON limit).

## Phase 5: remote MCP servers (AAP-16)

1. **Responses** `tools: [{ type: "mcp", server_label, server_url?, headers?, allowed_tools?, require_approval }]` → an extra `http` MCP server in `session/new`. All three agents speak `http`; Codex has no `sse`, so legacy SSE-only servers → 400 for Codex. Only `require_approval: "never"` (or `{ never: ... }`) is accepted for now; the approval-request flow → 400 `unsupported_parameter`.
2. **Settings**: `mcpServers: { <label>: { url, headers? } | { command, args?, env? } }`. A request may name a configured label without `server_url`. Stdio servers come only from settings, never from a request.
3. **Permission:** the phase 4 rules with the server name in place of `client`, filtered by `allowed_tools`. For Claude, add `allowedTools: ["mcp__<label>__<tool>", ...]`.
4. **Output:** `mcp_list_tools` and `mcp_call` items built from the ACP `tool_call` / `tool_call_update` updates. Antigravity's completed update carries only a placeholder (spike), so its `mcp_call.output` is that text. Document it.
5. **Timeouts:** the agents' own limits apply (Claude none with the phase 4 env, Antigravity 180 s, Codex 300 s). Document them.
6. **Settings UI:** a simple list editor in the settings window, or JSON in `settings.json` only for a first cut.
7. **Tests**:
   - A URL from a request and a label from settings both reach `session/new`.
   - Stdio from a request → 400; a non-`never` approval → 400.
   - `mcp_call` items are produced.
   - Permission is allowed only for the named servers and allowed tools.

## Phase 6: web search, optional (AAP-17)

The spike measured built-in search as slower than a plain answer:
- **Claude:** first token at 16 s against 3 s plain, with about 100x the tokens.
- **Antigravity:** adds about 10 s.
- **Codex:** about 8 s against 3 s. Its search is always on and asks no permission.

Do this phase only if the user wants it after trying their local search through phase 4 or 5.

- **Request shapes:** Chat `web_search_options`, Responses `tools: [{ type: "web_search" | "web_search_preview" }]`.
- **Claude:** `tools: ["WebSearch"]` and `allowedTools: ["WebSearch"]` (check that this skips the permission; else allow `toolCall._meta.claudeCode.toolName === "WebSearch"`). Never `WebFetch`.
- **Antigravity:** allow only `toolCall.kind === "search"` with `title === "Run search_web?"`. Never `read_url_content` or `run_command`.
- **Codex:** nothing to enable (always on; phase 1 may change that). A request without search cannot turn it off per request; document it.
- **Citations:** become `url_citation` annotations when the agent reports URLs:
  - Claude: `_meta.claudeCode.toolResponse.results[].content[{ title, url }]`.
  - Antigravity: `[n]` markers and grounding redirect links in the result text.
  - Codex: links only in the answer text.
- **Responses** adds a `web_search_call` item per search (the `tool_call` with `kind: "search"`).

## Docs (every phase)

The README "Supported API" section, env/settings tables, the safety notes per provider (what each request type can now enable), and `ROADMAP.md`.

## Acceptance

- `npm run typecheck` clean, `npm test` passes, `npm run build` succeeds, per phase.
- A live check per phase behind `RUN_LIVE_SMOKE=1`, as listed in each phase (hardened Codex answers a plain prompt; an image described by each agent; a dolphin from Antigravity and Codex; a two-tool loop with a 90 s tool against all three agents).
- A request that asks for nothing new behaves exactly as today.
