# AAP-20 spike: codex-acp 2.3.0

Date 2026-10-27. Agent: `@agentclientprotocol/codex-acp` 2.3.0 (bundled `@openai/codex` 0.164.0, `@openai/codex-win32-x64` 0.164.0-win32-x64), run with `node scripts/acp-probe.mjs node <entry>` the way `src/providers/codex.ts` launches it: `INITIAL_AGENT_MODE=read-only` and the hardened `CODEX_CONFIG` (`approval_policy: never`, `sandbox_mode: read-only`, `skills.include_instructions: false`, `features.{multi_agent,shell_tool,unified_exec,plugins}: false`). No `CODEX_HOME`, so the user's normal `~/.codex` login was used (`authenticate chat-gpt` answered `{}`). Raw dumps: `.claude/temp/aap20/p*.txt` / `p*.jsonl` (scratch, not committed). Account details are left out here on purpose.

Prompts run: 5 real ones (shell, MCP, web search, image generation, plus one MCP prompt that failed because the mock server had not started and so tested nothing) and the 3 live-check chats. Image generation: the model drew twice in one turn.

## initialize
- `agentInfo`: `@agentclientprotocol/codex-acp` 2.3.0, `protocolVersion` 1. Started in about 1 s.
- `agentCapabilities`: `auth.logout: {}` (still there), `loadSession: true`, `promptCapabilities: { embeddedContext: true, image: true }`, `mcpCapabilities: { acp: false, http: true, sse: false }`, `sessionCapabilities`: `resume`, `list`, `close`, `delete`, `fork`, `additionalDirectories`, `subagents`, `systemPrompt` (the AAP-11 spike recorded `delete`, `close`, `fork`; the others were not noted then). `_meta.authStatus: {}` is there too (see below). Top level `_meta.steering.supported: true`.
- `authMethods`: `api-key` ("API Key", `_meta["api-key"].provider: "openai"`) and `chat-gpt` ("ChatGPT"). Same ids as 1.12.0.
- New and relevant to AAP-19: right after `authenticate` the agent sends a `_auth/status_update` notification `{ authStatus: { kind: "account", label: "<plan name>", account: { email, plan } } }`. It is not a `session/update`, and the provider currently does not use it. Nothing in the proxy depends on it.

## session/new
- `modes.availableModes`: `read-only`, `workspace-write`, `agent`, `agent-full-access` (ids as before; `read-only` exists and is `currentModeId` with `INITIAL_AGENT_MODE=read-only`). `modeCandidates` default in the provider still finds it.
- `configOptions`: `mode`, `collaboration_mode` (`default`, `plan`), `model`, `reasoning_effort` (`low`..`max`, current `high`).
- **`model` option** (category `model`, current `gpt-5.6-luna`), for a ChatGPT Go account:

  | value | name | description |
  |---|---|---|
  | `gpt-6-luna` | 6 Luna | Fast and affordable model for easier tasks. |
  | `gpt-5.6-terra` | 5.6 Terra | Older balanced model for straightforward work. |
  | `gpt-5.6-luna` | 5.6 Luna | Older fast and efficient model. |

  `gpt-5.6-sol` is not offered. This matches the Codex app's `~/.codex/models_cache.json` list. The list depends on the account plan.
- The legacy `models.availableModels` has `<model>[<effort>]` ids (`gpt-6-luna[low]` ...); the provider keeps reading the `model` config option (`flattenSelectOptions`), which has plain ids, so nothing changes.
- `session/set_config_option model=gpt-6-luna` works, and the turn's `_meta.quota.model_usage[].model` was `gpt-6-luna`.

## AAP-12 hardening: still holds
- No config key was rejected: no stderr output, no error, the session was created and ran normally with `features.shell_tool`, `features.unified_exec`, `features.plugins` and `skills.include_instructions` set.
- Prompt "List the files in the current directory by running a shell command. If you have no tool that can run commands, reply with exactly: NO SHELL" (model `gpt-6-luna`): no `tool_call`, no permission request, answer `NO SHELL` (preceded by "I'll list the current directory with a shell command."). No "Skill descriptions were shortened" text. 28.8k tokens for the turn.
- A cheap prompt with `gpt-6-luna` answers (see above).

## AAP-15 MCP approval: same shape
Mock server `mcp-echo.mjs` on 127.0.0.1 as MCP server `client`, `--allow` limited to the echo tool of `client`:
- `tool_call` `{ toolCallId: "exec-<uuid>", kind: "execute", title: "mcp.client.echo", status: "in_progress", rawInput: { server: "client", tool: "echo", arguments: { q: "hello" } }, _meta: { is_mcp_tool_call: true } }`.
- `session/request_permission`: `toolCall: { toolCallId, kind: "execute", status: "pending" }` only, `_meta: { is_mcp_tool_approval: true }`, options `allow_once` (allow_once), `allow_session` (allow_always), `allow_always` (allow_always), `cancel` (reject_once). Identical to what `tests/fixtures/fake-acp.mjs` emits.
- After `allow_once`: `tool_call_update` `in_progress`, then `completed` with `rawOutput: { result: { content: [{ type: "text", text: "echo: hello" }], structuredContent: null, _meta: null }, error: null }`. The echo ran and the model answered. The provider's `allowTool` / `codexTarget` match this as is.
- Only the `client` echo tool was allowed; no execute or edit tool was allowed in any probe.

## AAP-17 web search: same shape, no permission
`tool_call` `{ kind: "search", title: "Web search", status: "in_progress", rawInput: { type: "webSearch", id, query: "", action: null } }`, then `tool_call_update` `completed` with `title: "Web search: <query>"` and `rawInput.query` / `rawInput.action.query` filled in. No permission request. `webSearch.search` in `codex.ts` reads exactly these. The answer used the search ("24.22.1").

## AAP-14 image tool: same shape, one detail more
No permission request. `tool_call` `{ kind: "other", title: "Image generation", status: "in_progress", rawInput: { id } }`, then `tool_call_update` `completed` with `content: [text "Revised prompt: ...", image { data, mimeType: "image/png", uri: "<CODEX_HOME>\\generated_images\\<threadId>\\<toolCallId>.png" }]` and `rawOutput: { status, revisedPrompt, result: <base64>, savedPath }`. `takeImages` in `acp-provider.ts` already reads `content.uri` and `rawOutput.savedPath` and deletes only files inside the image folder, so no change was needed. The files were 0.87 and 0.95 MB PNGs. Cleanup: the new thread folder under `~/.codex/generated_images/` (2 PNGs, from the model drawing twice) was deleted; the 2 pre-existing entries were not touched.

## Packaging (step 1)
- `dist/index.js` is still the entry (`main` and `bin`), a single 2 MB bundled file.
- `@openai/codex` 0.164.0 and `@openai/codex-win32-x64` stay hoisted in the top-level `node_modules/@openai/`, so `scripts/verify-package.mjs` (`createRequire(<unpacked>/node_modules/@openai/codex/package.json).resolve("@openai/codex-win32-x64/package.json")` and `vendor/x86_64-pc-windows-msvc/bin/codex.exe`) resolves the same way. Checked locally: it resolves and `codex.exe` exists.
- codex-acp 2.3.0 now has its own nested `@agentclientprotocol/sdk` (2.x) and `zod` 4 under `node_modules/@agentclientprotocol/codex-acp/node_modules/`. `electron-builder.config.cjs`'s `runtimeClosure` follows nested packages: its `asarUnpack` list now has `.../codex-acp/node_modules/@agentclientprotocol/sdk/**` and `.../codex-acp/node_modules/zod/**` next to the earlier entries (35 entries in all). Checked by loading the config.
- NOT run: `npm run dist:dir` / `verify:package` (a full electron-builder build); packaging is only checked as above.

## Live check (proxy with the user's login, `PROXY_CODEX_ISOLATED_HOME=0`, empty data folder, port 18790)
- A chat to `gpt-6-luna` sent 2 s after the start, before any discovery had finished (no cache): answered `pong` (5.3 s) with `model: gpt-6-luna`.
- `/v1/models`: `gpt-6-luna, codex/gpt-6-luna, gpt-5.6-terra, codex/gpt-5.6-terra, gpt-5.6-luna, codex/gpt-5.6-luna`.
- `codex/gpt-6-luna` answered. `gpt-5.6-sol` answered 404. `models-cache.json` was written with the three Codex models.
- Proxy stopped afterwards; no probe or mock process left.
