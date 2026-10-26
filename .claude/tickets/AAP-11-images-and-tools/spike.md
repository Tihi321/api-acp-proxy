# AAP-11 spike: images, MCP tools, permissions, search (2026-10-26)

Probe: `scripts/acp-probe.mjs` (raw JSON-RPC, extended for this spike with `--mcp-url`, `--meta`, `--mode`, `--model`, `--image`, `--image-uri`, `--allow`, `--dump`, `--unset-env`, `--cwd`, `--keep-cwd`). Throwaway MCP server: `.claude/temp/aap11/mcp-echo.mjs` (Streamable HTTP, JSON responses by default; `--sse` answers `tools/call` as an SSE stream whose headers go out at once; `--read-only-hint` marks the tools read-only). Raw logs and JSONL dumps of every run are in `.claude/temp/aap11/out/` (`<agent>-<test>.log` / `.jsonl`, `mcp-<port>.jsonl`).

Agents and models used (all three logged in):

| Agent | Version | Launch (mirrors the providers) | Model |
|---|---|---|---|
| Codex | codex-acp 1.12.0 (MCP client `codex-mcp-client/0.154.0`) | `INITIAL_AGENT_MODE=read-only`, `CODEX_CONFIG={"approval_policy":"never","sandbox_mode":"read-only","features":{"multi_agent":false}}`, auth `chat-gpt`, mode `read-only` | `gpt-5.6-luna` |
| Claude | claude-agent-acp 0.91.0 (MCP client `claude-code/2.1.300`) | `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `NODE_OPTIONS` unset; `_meta` = provider `sessionMeta`; mode `default` | `haiku` (Haiku 5.5) |
| Antigravity | agy-acp 1.3.0 (MCP client `antigravity-client v1.0.0`, Go http) | auth `oauth-personal`, mode `default` | `gemini-3.8-flash-low` |

**Codex scope.** During the spike, one session recorded that "the user has no Codex" and stopped probing it. The user corrected this on 2026-10-26: they still use Codex, and it stays in the plan. The Codex rows below come from the runs made before that: image input, image generation (allowed only), MCP including the timeout ceiling, and search. Codex points still open, such as hardening and a cancelled image run (not possible, there is no permission), are part of plan phase 1.

**Two sessions worked on this spike at the same time** (a first one and a resumed one, both writing into `.claude/temp/aap11/out/`). Runs from both are used; where they overlap the results agree. The mock MCP servers of one session were killed from outside twice (about 20:38 and 20:41, cause not identified, most likely the other session's cleanup), which cut two long-wait runs short; those were re-run on fresh servers (see "Timeouts").

## 1. `initialize.agentCapabilities`

| Agent | `promptCapabilities` | `mcpCapabilities` | Notes |
|---|---|---|---|
| Codex | `image: true`, `embeddedContext: true` (no audio) | `http: true`, `sse: false`, `acp: false` | `sessionCapabilities` include `delete`, `close`, `fork`. |
| Claude | `image: true`, `embeddedContext: true` | `http: true`, `sse: true` | `_meta.claudeCode.promptQueueing: true`. |
| Antigravity | `image: true`, `audio: true`, `embeddedContext: true` | `http: true`, `sse: true` | Still no `delete` (see the AAP-03 spike). |

Codex was "unknown" in the plan: it does have `image` and `http`, but **not `sse`** (only matters for legacy SSE MCP servers; Streamable HTTP is `http`).

## 2. Image input

Image: `.claude/temp/aap11/red-circle.png` (128x128 red disc on white, 568 bytes). Prompt "What is in this image? One sentence."

| Agent | base64 `data` block | `uri`-only block (`file:///...` and `https://raw.githubusercontent.com/...png`) |
|---|---|---|
| Codex | Works: "A solid red circle is centered on a white background." (4.6 s) | **Rejected** at once: `-32602 Invalid params`, zod error "data: expected string, received undefined" |
| Claude | Works: "A red circle on a white background, resembling the Japanese flag's disc." (2.5 s) | **Rejected**: same `-32602` zod error |
| Antigravity | Works: "...a solid red circle centered on a white background, resembling the flag of Japan." (4.5 s) | **Hangs**: no update, no answer, `session/prompt` still pending at the 120 s probe timeout (both `file:` and `https:`) |

So: **only base64 `data` works everywhere**. The proxy must always download/decode and send `data`; never pass a `uri`. (Plan phase 1 already does this.) For Antigravity a `uri`-only block is worse than an error: it hangs the turn.

## 3. Image generation

Prompt "Generate an image of a cartoon dolphin jumping out of the sea".

### Antigravity

- **Tool call** (`sessionUpdate: "tool_call"`): `{"toolCallId":"<32 hex>","title":"Run generate_image?","kind":"other","status":"pending","rawInput":{"AspectRatio":"4:3","ImageName":"cartoon_jumping_dolphin","Prompt":"<expanded prompt>"}}`.
- **Permission request** follows 1 ms later, same `toolCall` (title `Run generate_image?`, `kind: "other"`, `rawInput` as above). Options: `[{optionId:"allow_always",kind:"allow_always"},{optionId:"allow",kind:"allow_once"},{optionId:"deny",kind:"reject_once"}]`.
- **Allowed** (`allow`): `tool_call_update` `status:"in_progress"`, `title:"Running generate_image"`, `rawInput:{prompt,image_name,aspect_ratio}`; then after ~10 s a `tool_call_update` `status:"completed"` with
  - `content: [{type:"content", content:{type:"image", mimeType:"image/jpeg", data:"<base64, 1,113,168 chars>", uri:"file://C:\\Users\\Infplane\\.gemini\\antigravity-acp\\brain\\<sessionId>\\cartoon_jumping_dolphin_<ms>.jpg"}}]`
  - `rawOutput: {imageName, imagePath:"C:\\Users\\...\\brain\\<sessionId>\\cartoon_jumping_dolphin_1793042713004.jpg", prompt, aspectRatio}`
  - then a text `agent_message_chunk` ("Here is your cartoon dolphin...").
- **File:** JPEG (`ffd8ffe0`, JFIF with a C2PA manifest), 834,875 bytes, 4:3, written to `<GEMINI_HOME>/antigravity-acp/brain/<sessionId>/<ImageName>_<epoch ms>.jpg`. **Not** in the session cwd (the cwd stayed empty). The base64 in the update is byte-identical to the file.
- **Timing:** prompt to tool call 5.2 s, generation 10.2 s, turn end 21.4 s after the prompt (37 s including the ~16 s process start + auth + session/new).
- **Cancelled** (no `--allow`): `tool_call_update` `status:"failed"`, `rawOutput:"Rejected by user"`; the agent then says the request was "denied by the system permissions hook". The brain folder held only `.system_generated/logs/transcript*.jsonl`, **no image**. Nothing in the cwd.
- No file-write permission is involved; only the `generate_image` permission.

### Codex

- No permission request at all (approval policy `never`). Sequence: the model first **read its imagegen skill file** through `exec_command` (`kind:"read"`, title `Read file 'C:\Users\Infplane\.codex\skills\.system\imagegen\SKILL.md'`, run through the user's PowerShell profile), then:
- `tool_call` `{"kind":"other","title":"Image generation","status":"in_progress","rawInput":{"id":"exec-..."}}`; ~25 s later `tool_call_update` `status:"completed"` with `content:[{type:"content",content:{type:"text",text:"Revised prompt: ..."}},{type:"content",content:{type:"image",mimeType:"image/png",data:"<base64>",uri:"C:\\Users\\Infplane\\.codex\\generated_images\\<threadId>\\<toolCallId>.png"}}]` and `rawOutput:{status,revisedPrompt,result:"<base64>",savedPath}`.
- **File:** PNG 1536x1024, 2,266,456 bytes in `~/.codex/generated_images/<threadId>/<toolCallId>.png` (not the cwd). Total turn 37.5 s. The single `tool_call_update` line was 6 MB (base64 twice: `content` and `rawOutput.result`).
- A cancelled run is not possible to test: Codex asks no permission for the built-in image tool, so the proxy cannot gate it with the permission handler (it can only not ask for it). Not re-probed.

### Claude

No image-generation tool (built-in tools are off, and Claude Code has no image tool). Not prompted.

## 4. MCP bridge

Server tools `echo {q:string}`, `add {a:number,b:number}`. MCP config in `session/new`: `mcpServers:[{type:"http",name:"client",url:"http://127.0.0.1:<port>/mcp",headers:[]}]`.

### What each MCP client sends

| | Claude | Antigravity | Codex |
|---|---|---|---|
| Handshake | `POST server/discover` (protocol `2026-07-28`, header `mcp-method`) → our `-32601`, then `initialize` `2025-11-25` | same: `server/discover` then `initialize` `2025-11-25` | `initialize` `2025-06-18` only |
| Then | `notifications/initialized`, **`GET` (SSE stream, we 405)**, `tools/list` | `GET` x3 (405), `notifications/initialized`, `tools/list` | `notifications/initialized`, `tools/list` |
| `Accept` | `application/json, text/event-stream` | (Go client) | `text/event-stream, application/json` |
| When | at `session/new` | at `session/new`, and **again at the first tool call** (reconnects) | at `session/new` |
| `tools/call` `_meta` | `claudecode/toolUseId`, `progressToken` | `antigravity.google/artifacts_dir` (= brain/<sessionId>) | `callId`, `x-codex-turn-metadata` (session, turn, workspaces) |

A JSON-only server with `-32601` for `server/discover`, 405 for GET and 202 for notifications worked with all three. No `mcp-session-id` was needed.

### Tool name, permission and how to recognise it

- **Claude:** model sees `mcp__client__echo`. `tool_call` `{name:"mcp__client__echo",title:"mcp__client__echo",kind:"other",_meta:{claudeCode:{toolName:"mcp__client__echo"}}}`; arguments arrive in a later `tool_call_update` `rawInput`. Then `session/request_permission` with `toolCall._meta.claudeCode = {toolName:"mcp__client__echo", mcpServer:{name:"client",source:"dynamic"}}`, options `allow-once` (allow_once), `allow-with-updates` (allow_always), `reject` (reject_once). Cancelled → `status:"failed"`, `rawOutput:"Tool permission request failed: Error: Tool use aborted"`.
  - **`allowedTools: ["mcp__client__*"]`** in `claudeCode.options` (with `tools: []`): the MCP tools are visible **with or without it** (`tools: []` does not hide MCP tools), but with it **no permission request is sent at all** and the call runs. Without it a permission is requested every call.
- **Antigravity:** model sees `client_echo`. `tool_call` `{title:"client_echo",kind:"other",rawInput:{arguments:{q:"hi"},q:"hi"},_meta:{mcp:{tool:"echo",server:"client"},is_mcp_tool_call:true}}`; the permission request repeats that `toolCall` (with `_meta.mcp`), options `allow_always` / `allow` (allow_once) / `deny`. Cancelled → `"Rejected by user"`. Quirk: the completed update's `content`/`rawOutput` is the placeholder `"Call echo tool"`, not the result, although the model received the real result.
- **Codex:** `tool_call` `{kind:"execute",title:"mcp.client.echo",rawInput:{server:"client",tool:"echo",arguments:{q:"hi"}},_meta:{is_mcp_tool_call:true}}`. Despite `approval_policy: "never"` + read-only sandbox, **a permission request is sent**, but it carries **only** `toolCall:{toolCallId,kind:"execute",status:"pending"}` and `_meta:{is_mcp_tool_approval:true}`; options `allow_once`, `allow_session`, `allow_always`, `cancel`. The server/tool must be looked up from the preceding `tool_call` with the same `toolCallId`. Cancelled → `failed`, `error.message:"user cancelled MCP tool call"`; allowed → result in `rawOutput.result.content`.

### Timeouts (tool call kept open)

- **Claude, JSON response held open:** fails at **60 s** with `"The operation timed out."` (the server saw the client close the request at 60.0 s). Progress updates `toolResponse.elapsedTimeSeconds` every 30 s meanwhile.
- **Claude, SSE response** (headers + a comment sent at once, result later): it waited **300 s** and then aborted: `MCP server "client" tool "echo" sent no response or progress for 300s; aborting. If this server is configured in your MCP settings, set a per-server "timeout" (ms) to allow longer silent runs for just this server; otherwise set CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT (ms) globally (0 disables).` Then the model retried the call once by itself. So the 60 s limit is a response-start timeout; once the SSE stream is open the limit is 300 s of silence.
  - **`CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT=0` in the agent's env works** (set with `--env`): an SSE response held **330 s** completed normally (result at 344 s, `echo: slow`). This is the variable for `claudeEnv`; `MCP_TOOL_TIMEOUT` was not needed. Whether keepalive comments or `notifications/progress` reset the 300 s silence timer instead was not tested.
  - Claude's `toolResponse.elapsedTimeSeconds` progress updates arrive every 30 s while a call is open (`tool_call_update` `status:"in_progress"`, then one without status at each 30 s mark).
- **Antigravity:** waited **30 s** and **60 s** (JSON response, no SSE) and **70 s** (SSE) without complaint. A **400 s** hold failed at exactly **3 m 0 s**: `tool_call_update` `status:"failed"`, `rawOutput:"Tool execution failed"`, and the model reported `MCP tool call to server "client" timed out after 3m0s: context deadline exceeded`. The 3 min limit is the agent's own (Go `context deadline`); no setting for it was found. The call was not retried.
- **Codex (JSON response):** waited **60 s** and **90 s** fine. A **400 s** hold failed at **300 s**: `tool_call_update` `status:"failed"`, `rawOutput.error.message: "tool call error: tool call failed for `client/echo`\n\nCaused by:\n    timed out awaiting tools/call after 300s"`. codex-acp's `createMcpSeverConfig` only passes `url` and `http_headers`, so a per-server `tool_timeout_sec` cannot be set from `session/new`.

### Parallel calls ("Call echo with q='a' and add with a=1,b=2 at the same time")

- **Claude:** parallel **only when the tools are marked read-only** (`annotations.readOnlyHint: true`): both permission requests came back-to-back and both `tools/call` reached the server 24 ms apart. Without the hint (JSON server) Claude ran them **one after another** (the second permission request came only after the first call finished).
- **Antigravity:** the two `tool_call`s and permissions came 20-70 ms apart, but the **`tools/call` requests were sequential** (the second was sent only after the first answer: 60 s later with a 60 s JSON delay, 70 s with a 70 s SSE delay; the 2-call turn took 148 s). It also reconnects and re-sends `server/discover` + `initialize` at the first call.
- **Codex:** sequential (`add` was issued only after `echo` completed: `tools/call` at 10.4 s and 70.4 s with a 60 s delay), although the model said "both calls are in flight concurrently". Codex has a per-server `supports_parallel_tool_calls` setting (not reachable from `session/new`; not tested via `CODEX_CONFIG`).
- **Result echo in the update:** Antigravity's completed `tool_call_update` carries a placeholder (`"Call client echo tool"`, `"Echo with q='a'"`) even for a successful call; Claude's carries the result (`rawOutput:[{type:"text",text:"echo: hi"}]`), Codex's `rawOutput.result.content`. The proxy does not need the result from the update: it already has it from its own `tools/call` answer.

## 5. Search ("What is the latest stable version of Node.js? Search the web.")

- **Claude, `tools: ["WebSearch"]`:** works with only that tool. `tool_call` `{name:"WebSearch",title:"Web search",kind:"fetch",_meta:{claudeCode:{toolName:"WebSearch"}}}`, then `rawInput:{query, mode:"standard"|"extended"}` and a permission request (`toolCall.name:"WebSearch"`, title `Search "<query>"`, options as for MCP). Cancelled → the model answers from memory. Allowed: two searches (~4–5 s each), result in `tool_call_update` `_meta.claudeCode.toolResponse.results[].content[{title,url}]` and `rawOutput` text with "Links: [...]". The final answer carries markdown links and a "Sources:" list (but one link was mismatched). Time to first answer token **16.3 s** vs **3.0 s** for the plain prompt with tools off; ~370k tokens (mostly cache) vs 3.4k. No `WebFetch` appeared.
- **Antigravity:** search tool **`search_web`**: `tool_call` `{title:"Run search_web?",kind:"search",rawInput:{query}}`; permission options `allow_always` ("Allow Always (risky)", with `_meta["agy.security.warning"]`), `allow`, `deny`. When search is denied the model escalates: `read_url_content` (`kind:"fetch"`, `rawInput.Url`), then **`run_command`** (`kind:"execute"`, `title` = the PowerShell command line, `rawInput.CommandLine`, `Cwd: C:\Users\Infplane\.gemini\antigravity-cli\skills`, not the session cwd). Even the **plain prompt without "search"** made it try `search_web`, `read_url_content` and `node -v`. All were cancelled. Allowed (`search_web` only): one call, ~10 s, result as one text block with `[n]` markers and `vertexaisearch.cloud.google.com/grounding-api-redirect/...` source links; first answer token **31.6 s** after process start, **15 s** after the prompt; the plain (all-cancelled) prompt answered after 16 s with stale facts.
- **Codex (probed earlier, before it was dropped):** web search is **already on** with the provider's current config (`approval_policy: never`, read-only sandbox, no `web_search` key): `tool_call` `{kind:"search",title:"Web search",status:"in_progress",rawInput:{type:"webSearch",id,query:"",action:null}}`, then a `tool_call_update` `status:"completed"` with `title:"Web search: <query>"` and `rawInput.action:{type:"search",query}`. **No permission request.** No result text or URLs in any update; the answer text has markdown links. 8.4 s for the prompt (one search) against 3.3 s for "Reply with exactly: pong".
  - Per process, not per session: codex-acp builds every session's config from `CODEX_CONFIG` (parsed once at start) plus `projects` and `mcp_servers`; there is no ACP option for it. `CODEX_CONFIG` with `"web_search":"disabled"` turned the tool off, but the model then looked for other ways to reach the web: it read a user skill (`~/.agents/skills/browse/SKILL.md`, via `exec_command`, no permission), called a user MCP tool (`mcp.cua_repl.js`, kind `execute`, ran without a permission request and failed), and asked to run `Invoke-WebRequest` through the shell (permission request, which was cancelled, so the turn ended `stopReason:"cancelled"`).

## Antigravity session ids created (for the purge)

`bd6a4a54-29cb-4586-9973-bba6cecb3c64`, `d876eb3b-0060-4044-8554-e4b504c44ff5`, `dd3de00e-0ca7-4eb6-85bf-cef07d365a6a`, `f01fbec3-7e83-4b73-81bb-9b4fc59452f6`, `11bd5d48-65df-4f17-949b-8288df581fbc` (holds the dolphin JPEG), `c7562ad9-ec2a-4427-8bea-78646d062935`, `b59b8279-c89b-454d-acd7-0037f93e70ca`, `8f5f98c5-36ea-491f-8ff3-872c1675bc90`, `d224b924-7ca7-43e6-a9f9-efea0455c5e3`, `8f29f15e-19df-4ca1-a399-32ff4539c042`, `af3a4b0c-9ae5-4bc0-b687-63c29364b094`, `64392c2e-4a5c-405d-ad9d-70cf0a46fded`, `9137fbfe-a4f3-462c-966f-135566043276`, `60b8551f-5f78-45ca-98e2-3422e2a26da8`, `dc7e3331-9228-4157-893f-bb94e6432efd`, `1fc4caf9-e03f-4ccc-881b-9d08958810d3`, `6153b7c1-af44-4011-92e7-886b98e02a41`, `c93ae636-c096-4832-be0d-67f1382be604`. They live in `~/.gemini/antigravity-acp/{conversations,brain}/`; nothing was deleted. Codex also left `~/.codex/generated_images/01a179ac-e17d-7f80-9df2-d22b71b201e6/` (the PNG) and its sessions.

## Other surprises

- Claude's OAuth refresh can fail transiently when another Claude Code process holds `~/.claude/.oauth_refresh.lock`: `session/prompt` → `-32603 "Failed to refresh OAuth token: another Claude Code process is refreshing it..."`. It cleared after ~1 min. Worth mapping to a retryable 503.
- Codex prints `Warning: Skill descriptions were shortened...` (and for an unsupported default model, a 400 JSON error) as `agent_message_chunk` text, which the proxy would pass on as answer text.
- Codex runs `exec_command` reads (the skill file) with no permission even in read-only mode, through the user's PowerShell profile. It also loads the user's own skills (`~/.agents`, `~/.codex/skills`) and plugin MCP servers (`cua_repl`), and ran one of those tools with no permission request. So for Codex the "built-in tools stay off" ground rule does not hold today.
- Codex reports an MCP server that fails to start as a `tool_call` `{toolCallId:"mcp_startup.client",kind:"other",title:"mcp__client__startup",status:"failed",content:[{type:"text",text:"[codex-acp forwarded startup error] MCP server `client` failed to start: ..."}]}`. This happened when the bridge URL was not listening.
- Correlating an agent tool call with the MCP `tools/call` that reaches the bridge: Claude puts the ACP `toolCallId` in `params._meta["claudecode/toolUseId"]`, Codex puts it in `params._meta.callId`; Antigravity sends no tool call id (only `antigravity.google/conversation_id` = the ACP session id), so match by order within the session.
- Claude's `usage` varies a lot: quick turns report 3k-24k tokens, but turns that held an MCP call open for 60 s or more, or did a web search, reported 180k-370k (mostly `cachedWriteTokens`/`cachedReadTokens`) for a tiny conversation. Cause not investigated; the usage numbers the proxy reports for such turns will look inflated.

## Rules for phases 1 to 5

**Phase 1 (image input):** send images only as `{type:"image", mimeType, data}`. Never send `uri` (Codex/Claude reject it with `-32602`; Antigravity hangs). All three advertise `promptCapabilities.image: true`.

**Permission rules** (everything else stays `cancelled`):

| | (a) image tool | (b) `client` MCP tools | (c) search |
|---|---|---|---|
| **Antigravity** | `toolCall.title === "Run generate_image?"` and `toolCall.kind === "other"` → choose the `allow_once` option (`optionId:"allow"`). The image is in the completed `tool_call_update`: `content[].content` with `type:"image"` (base64 JPEG + `uri`), and the file is `rawOutput.imagePath` under `brain/<sessionId>/` (not the cwd): read the update's `data`, then delete `imagePath` (and rely on the session purge for the rest). | `toolCall._meta.mcp.server === "client"` and `_meta.is_mcp_tool_call === true` → `allow_once` (`"allow"`). Tool name: `_meta.mcp.tool`. | `toolCall.kind === "search"` and `title === "Run search_web?"` → `allow_once`. Never allow `read_url_content` (`kind:"fetch"`) or `run_command` (`kind:"execute"`). Never pick `allow_always`. |
| **Claude** | none (no tool) | `toolCall._meta.claudeCode.mcpServer.name === "client"` (or `toolName` starts with `mcp__client__`) → `allow_once` (`"allow-once"`). Better: put `allowedTools: ["mcp__client__*"]` in `claudeCode.options`; then no permission request is sent at all. Keep the permission rule as a fallback. Model-facing name `mcp__client__<tool>`. | `tools: ["WebSearch"]` in `claudeCode.options` and allow `toolCall.name === "WebSearch"` (`_meta.claudeCode.toolName`, `kind:"fetch"`) → `allow_once`. Or add `allowedTools: ["WebSearch"]` to skip the request (not tested for WebSearch; tested for `mcp__client__*`). |
| **Codex** (not re-verified) | none possible: the image tool runs without a permission request; files go to `~/.codex/generated_images/<thread>/`. | Request has `_meta.is_mcp_tool_approval === true` and only `toolCallId`; match it to the last `tool_call` with that id whose `rawInput.server === "client"` (`title` `mcp.client.<tool>`, `kind: "execute"`) → `allow_once` (`"allow_once"`). Never allow a request without that match. | none needed: `web_search` is on by default and asks no permission (`tool_call` `kind:"search"`, `title:"Web search"`). Per process only: `CODEX_CONFIG` `"web_search":"disabled"` turns it off, but then the model falls back to skills, user MCP tools and shell. |

**Timeouts:**

- Claude: answer `tools/call` with an **SSE response** (send headers + a comment at once, result later) so the 60 s response-start timeout does not apply, **and** set `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT=0` in `claudeEnv` (verified: a 330 s hold completed; without it the call aborts after 300 s of silence). Without SSE a suspended tool call dies at 60 s. `MCP_TOOL_TIMEOUT` is not needed. Untested: whether keepalive/progress events reset the 300 s timer (only matters if the env var is dropped).
- Antigravity: hard limit **3 min** per tool call (`context deadline exceeded`), not configurable from ACP; 60 s JSON and 70 s SSE both fine. A suspended call (waiting for the client's tool result) must therefore be answered within 180 s, and the proxy's `toolResultTimeoutMs` for Antigravity must be below that (use ~150 s) or fall back to the text path.
- Codex: hard limit **300 s** per tool call (`timed out awaiting tools/call after 300s`), JSON response (60 s and 90 s fine); not configurable from `session/new`. Keep the suspended-call timeout below ~280 s for Codex.
- Process start: Antigravity ~15 s before a prompt can be sent (cold start + auth + session/new); keep generous timeouts.

**Where the findings contradict the plan:**

1. *Phase 3 step 1* ("JSON responses only ... switch to the SDK transport if an agent needs SSE"): no agent **needs** SSE to connect, but Claude **needs an SSE response for any tool call held longer than 60 s**, which is exactly the suspended-call design. The bridge must stream `tools/call` responses (headers at once, keepalive/progress, result later). Hand-written SSE for that one method is ~15 lines; the SDK transport is optional.
2. *Phase 3, "batch collected for 150 ms because parallel calls arrive together"*: only Claude sends calls together, and only for tools with `annotations.readOnlyHint: true`. Antigravity and Codex send them strictly one after another (the next call only after the previous one is answered). So the bridge must mark its tools `readOnlyHint: true`, and for Antigravity/Codex a "batch" is always one call: each tool round trip becomes a separate HTTP response to the client. `parallel_tool_calls` cannot be honoured for those two.
3. *Phase 3 step 5, "a long MCP_TOOL_TIMEOUT in claudeEnv"*: the variable that matters is **`CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT=0`** (300 s no-progress limit), on top of the SSE response for the 60 s limit. `MCP_TOOL_TIMEOUT` was not needed. *And "the equivalent for Codex and Antigravity, or a documented limit"*: Codex 300 s and Antigravity 180 s are fixed. Phase 3's default `server.toolResultTimeoutMs` of 10 min exceeds both: make the suspension timeout per provider (Claude 10 min, Codex < 300 s, Antigravity < 180 s) or the resume path will find an agent that has already given up (its call fails and the model retries or answers without the result).
4. *Phase 2, "generated image files are read ... and deleted" from the cwd*: neither agent writes into the session cwd. Antigravity writes to `brain/<sessionId>/` and Codex to `~/.codex/generated_images/`. Both also return the image **inline as base64** in the completed `tool_call_update`, so the proxy can take the `data` from the update and only delete the reported path.
5. *Phase 2, "Codex if the spike finds a tool"*: Codex has a tool but **no permission gate** (it ran with `approval_policy: never`). Codex image generation stays in the plan (the user still uses Codex): the image is taken from the update, and the proxy cannot stop Codex from generating in other requests.
6. *Phase 2 test plan, "only that permission allowed ... cancelled → nothing written"*: confirmed for Antigravity (cancelled → no image).
7. *Ground rule "built-in tools off"*: Antigravity has no way to switch off its own tools; it tries `search_web`, `read_url_content` and `run_command` even for plain prompts. The `cancelled` default handles it, but it costs latency (16 s for a plain question). Consider a preamble line telling Antigravity not to use tools.
8. *Phase 5*: Claude search is ~5x slower than a plain answer and used ~100x the tokens; Antigravity search adds ~10 s. Neither is obviously better than a local search, so phase 5 stays optional.
9. *Phase 5, "Codex: only if it can be switched per session"*: Codex search is **already on** for every request (no permission, per process config only); switching it off per request is impossible, and switching it off per process makes the model improvise with skills, user MCP tools and shell. Phase 5 has nothing to enable for Codex.
10. *Ground rule "built-in tools stay off" for Codex*: not true today (read-only shell reads, user skills, plugin MCP tools and web search all run without a permission request). A Codex-specific hardening is out of scope for these phases but worth a follow-up ticket.
11. *Phase 3 flow, "the agent calls a tool → the proxy ends the HTTP response"*: Antigravity's completed `tool_call_update` for an MCP call has only a placeholder, and the real call id is not in the `tools/call` (Claude and Codex give it). Match the MCP call to the ACP tool call by order within the session for Antigravity.
