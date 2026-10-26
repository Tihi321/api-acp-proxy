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

**Status (2026-10-26): implemented, one live check pending a user login.** Details in `spike.md` ("Phase 1 (AAP-12) probe").
- [x] 1 probe: shell (4 configs), image generation, web search and MCP approval under the chosen config, empty `CODEX_HOME`, login mechanics (without opening a browser), skills/plugins/MCP isolation (app-server calls), Antigravity before/after.
- [x] 2 `src/providers/codex.ts`: `CODEX_HOME=<dataDir>/codex-home` (created) when `providers.codex.isolatedHome` (default `true`); `hardenedCodexConfig()` merges the user's `CODEX_CONFIG` first and forces the safety keys on top. Setting wired through `src/settings.ts` (`PROXY_CODEX_ISOLATED_HOME`, reported in `overridden`), the registration, `src/shared/ipc.ts` and a checkbox on the Codex card (`settings.html`, `settings.ts`).
- [x] 3 login: the existing `login()` / eager `authenticate chat-gpt` path is unchanged; no `loginUrlPattern` (see deviations). README has a new "Codex" section (home location, one extra login after upgrading, logout by deleting the folder, API keys, safety notes).
- [x] 4 Claude `mapError` (`provider_busy`, 503, `Retry-After: 30`); `AcpUnavailableError` gained an optional `retryAfterSeconds`, read in the `src/server.ts` error handler (non-streaming only; a stream that has started carries the error as an SSE event).
- [x] 5 Antigravity: new `ProviderDescriptor.promptPreamble`, appended after the generic line by `serializePrompt(messages, instructions, extraPreamble)`; other providers' prompts are byte-identical (tested).
- [x] 6 tests: `tests/codex.test.ts` (new), `tests/settings.test.ts`, `tests/claude.test.ts`, `tests/antigravity.test.ts`; fake agent `FAKE_ACP_PROMPT_ERROR=<json>`.
- [x] 7 docs: README (Codex section, env row, files table, Claude busy error, Antigravity safety note). `ROADMAP.md` untouched (it lists hub limits, not provider hardening).
- [x] Review fix: no automatic browser sign-in at start (see deviations).
- [ ] **Pending a user login of the proxy's Codex home:** live prompt in the isolated home (no skills, plugins or user MCP tools, image generation and search work there, files land in `<codex home>/generated_images`).

Deviations from the plan text:
- **The shell is stopped by `features.shell_tool=false` + `features.unified_exec=false`, not by an approval policy.** `"untrusted"` is rejected by this Codex (`-32603`, "no longer supported") and `"on-request"` still lets read-only `exec_command` run without a request. Two more keys were added: `features.plugins=false` and `skills.include_instructions=false`.
- **The isolated home does not hide `~/.agents/skills`** (it is under the user profile, not `CODEX_HOME`; 90 skills still show up in `skills/list`). Plugin skills, plugin MCP servers (`cua_repl` etc.) are gone. The model no longer sees any skill list because of `skills.include_instructions=false`, which also removes the "Skill descriptions were shortened" answer text, and without a shell it cannot read a skill file.
- **No `loginUrlPattern` for Codex:** codex-acp opens the browser itself and prints no URL, so the Codex card shows no login link.
- **Review fix (no browser at start):** `authenticate chat-gpt` opens a browser tab by itself, so with the eager auth every start of a fresh isolated home would open one. Now `chooseAuth` returns nothing for `chat-gpt` when the isolated home is in use, there is no `CODEX_API_KEY` / `OPENAI_API_KEY` and `<codex home>/auth.json` does not exist (`existsSync` only, never read). New optional descriptor fields: `loginRequired(env)` (the eager step then blocks auth: state `needs_login` with "Log in to Codex for the proxy...", requests 503 `provider_auth_required`) and `defaultLoginMethod` (`login()` falls back to it, so the Log in button runs `chat-gpt` instead of the first advertised method, `api-key`). With `auth.json`, an API key or `isolatedHome: false` nothing changes. Tests: `tests/codex.test.ts` "Codex first login".
- The `"web_search": "disabled"` question under the hardened config was not re-probed (few live prompts); web search stays on.
- Antigravity preamble: the measured gain is nil. The spike's cancelled tool calls came from raw prompts; with the existing generic preamble Antigravity did not try a tool in 5 runs. Kept as a guard.
- The image tool still cannot be gated and now also runs in the isolated home (works with the shell off, 35 s). Phase 3's Codex `imageFolder` is `<CODEX_HOME>/generated_images` for the isolated home (the probe only saw it under `~/.codex`).

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

**Status (2026-10-26): implemented and live-checked.** Typecheck, build and the whole suite pass (see below).
- [x] 1 `src/api.ts` (`Message` / `Part`, `textMessage`, `messageText`, `hasImages`, `buildPrompt`; `normalizeChat` / `normalizeResponses` are now async; the parsed request's `textMessages` became `conversation`). New `src/images.ts`: `data:` decoding, guarded download (manual redirects, 15 s, `image/*`, 10 MB), magic-byte check. `createProxyServer(config, bridge, { fetch })` takes the download `fetch`; the controller passes `ctx.fetch` (Electron's `net.fetch`).
- [x] 2 `src/acp-provider.ts`: the prompt is `buildPrompt()` content blocks; `promptCapabilities.image` is read from `initialize` and exposed as `status().capabilities.image` (`ProviderStatus.capabilities?`); a request with images for an agent without it throws `ApiError(400, unsupported_content, param messages)`, which `AcpProvider.generate` now passes through instead of wrapping into a 503. The server turns the param into `input` for Responses.
- [x] 3 session reuse: the kept transcript is `{ role, text, images: sha256[] }` per message (no base64 kept); history matching compares the hashes.
- [x] 4 config: default `maxBodyBytes` 20 MiB (`src/settings.ts`), README env table updated.
- [x] 5 tests: `tests/images.test.ts` (18 tests), fake agent `FAKE_ACP_IMAGE=1`, existing tests moved to the new message type (`textMessage()` helper, async `normalize*`), settings default test.
- [x] 6 docs: README (top sentence, env table, Supported API, a new "Images" block, session reuse), ROADMAP last item split into "images accepted" (done) and "audio, files and tools still rejected".
- [x] 7 live check (below).

Prompt layout: the first text block is the preamble, then a `[role]` block per message, joined by a blank line; each image becomes an `image` block right after the text of its message and ends the current text block, so the text that follows starts a new block; `[output format]` goes into the last text block. A request without images is exactly one text block, identical to before (asserted through `FAKE_ACP_LOG`).

Deviations and decisions:
- **Preamble for image requests:** the first sentence is "This is an API request with text and images." instead of "This is a text-only API request." (only when the request has images; the rest of the line is unchanged). A text-only request keeps the old wording byte for byte.
- **Streaming and the capability guard:** the capability is only known once the agent has started, so for a streamed request the 400 `unsupported_content` arrives as an SSE error event (like every other error found after the stream began), not as an HTTP 400. Non-streaming requests get a real 400.
- **Part parsing:** content parts are parsed one by one (the zod schemas only check `{ type: string }`), so any unknown type answers `unsupported_content` instead of a schema error. Images are only accepted in user messages (system / developer / assistant images answer `unsupported_content`). Chat text parts are no longer `.strict()`.
- **Error codes:** `unsupported_content` (part type, MIME type or magic bytes, `file_id`, image in a non-user message, agent without the capability) and `invalid_image_url` (malformed or unreachable URL, bad base64, timeout, too many redirects, over 10 MB).
- A `data:` URL whose declared type does not match its bytes is rejected; a downloaded image is typed by its bytes, not by its `Content-Type` (which only has to start with `image/`). `image/jpg` is accepted as an alias of `image/jpeg`.
- No cap on the number of images per request, and no private-address filtering for downloads (the proxy fetches whatever URL the client names); documented in the README.
- Not tested: the 15 s download timeout itself (it would cost 15 s of wall time); the other limits are.
- Token estimates for requests without agent usage count only the text (images are left out of `serializePrompt`).

Verification: `npm run typecheck` clean; `npm test` 15 files passed, 186 tests passed, 1 skipped (live smoke); `npm run build` succeeds.

Live check (headless CLI on port 18913, a temporary `PROXY_SETTINGS_FILE` under `.claude/temp/aap13/live/`, `PROXY_CODEX_ISOLATED_HOME=0`, `CLAUDECODE` / `CLAUDE_CODE_ENTRYPOINT` / `NODE_OPTIONS` unset; `.claude/temp/aap11/red-circle.png` as a data URL, "What is in this image? One sentence."):

| Endpoint | Model | Time | Answer |
|---|---|---|---|
| chat | `codex/gpt-5.6-luna` | 8.7 s | "A red circle is centered on a white background." |
| chat | `claude/haiku` | 1.8 s | "A solid red circle on a white background, resembling the Japanese flag's disc." |
| chat | `antigravity/gemini-3.8-flash-low` | 6.9 s | "The image shows a solid red circle centered on a white background." |
| responses (`input_text` + `input_image`) | `claude/haiku` | 3.2 s | "A solid red circle on a white background, resembling the Japanese flag's disc." |

Four prompts in total on the real accounts (plus the model listing). The proxy was stopped afterwards (the process was killed, so its Antigravity child was orphaned and killed by hand); no agent process of the run is left.

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

**Status (2026-10-26): implemented and live-checked.** The branch `AAP-14_image-generation` is based on `master` (AAP-13 is merged as PR #8), not stacked on AAP-13. `npm run typecheck` clean, `npm run build` succeeds, `npm test`: 16 files passed, 214 tests passed, 1 skipped (live smoke).
- [x] 1 capability: `ProviderDescriptor.imageGeneration?: { allow?(permission), imageFolder(ctx), pruneEmptyParent? }` (`src/provider.ts`). Antigravity: `allow` = `title === "Run generate_image?"` and `kind === "other"`, folder `<GEMINI_HOME>/antigravity-acp/brain` (`resolveGeminiHome`). Codex: no `allow`, folder `<CODEX_HOME>/generated_images` (`<dataDir>/codex-home` when isolated, else `$CODEX_HOME` or `~/.codex`), `pruneEmptyParent: true`. Claude: none. `Provider.imageGeneration` and `ProviderRouter.canGenerateImages(model)` / `AcpLike.canGenerateImages?` tell the server before a stream starts.
- [x] 2 `AcpProvider.generate` `options.images`: the permission handler is now `answerPermission`, looking up `permissionRules.get(params.sessionId)`; a rule is set only for the session of a request with `images` (Antigravity `allow`), removed in `finally`, and the answer is the session's `allow_once` option or `cancelled` (never `allow_always`, never another option). Completed `tool_call_update`s are scanned for image content blocks (`result.images: { mimeType, data, revisedPrompt? }[]`, Codex's "Revised prompt:" text block) and the reported files (`content.uri`, `rawOutput.imagePath` / `savedPath`); without `options.images` the images are dropped. The files are deleted after the turn (`src/generated-images.ts`: `file://C:\\...`, `file:///C:/...` or plain path, `realpath` of file and folder, regular file strictly inside the folder, empty parent pruned for Codex; never throws). A request for images on a provider without the capability throws 400 `model_not_capable`.
- [x] 3 large updates: the SDK's `ndJsonStream` limit is 32 MiB per line by default; tested with a ~6.1 MB update line (fake Codex image of 2.3 MB, base64 twice). Update bodies are never logged (a debug line carries only the MIME type and length).
- [x] 4 `POST /v1/images/generations` (`handleImageGeneration` in `src/server.ts`, `normalizeImageGeneration` in `src/api.ts`). 400s: `n` ≠ 1, `response_format` other than `b64_json`, `mask` / `image` / `images`, `stream: true`, `partial_images`, a `size` that is not `auto` or WIDTHxHEIGHT, `model_not_capable`; 404 for an unknown model; 502 `no_image_generated` with the agent's text. `size` becomes "Aspect ratio: W:H (requested size WxH)." (reduced by the gcd), `quality` / `background` become hint lines. One image (the first) is returned; `output_format` comes from the MIME type.
- [x] 5 Responses `tools: [{ type: "image_generation" }]` (non-streaming and streaming: `output_item.added` with `status: "in_progress"` and `result: null`, then `done`, then the message).
- [x] 6 chat `modalities` (kept small): `message.images` / one `delta.images` chunk before the finish chunk.
- [x] 7 tests: `tests/image-generation.test.ts` (28 tests) and the fake agent `FAKE_ACP_IMAGE_GEN=agy|codex` (+ `_OPTIONS=always-only`, `_OUTSIDE=<file>`, `_BYTES=<n>`, `_NONE=1`; the fake now also logs permission answers as `permission_response`). Covers: both endpoints, Responses and chat (stream and not), only `allow_once` taken (an `allow_always`-only offer is cancelled), a plain request and an unrelated permission still cancelled, per-session rule under two concurrent requests, file deleted, outside file kept (fake agy and codex, plus unit tests for `..`, sibling and prefix folders, the folder itself, a junction, URI forms), empty thread folder removed, Codex file deleted in a non-image request, 400s, 502, the 6 MB line, the plain prompt unchanged.
- [x] 8 live check (below).
- [x] Docs: README ("Image generation" block under Supported API, Antigravity safety note, intro), ROADMAP.

Deviations and decisions:
- **Prompt for image requests:** a request with `options.images` replaces the preamble ("This is an API request that allows one generated image. If the request asks for an image, use your image generation tool once. Do not use any other tool, ...") and leaves out the provider's no-tools line (Antigravity's would forbid the tool). `buildPrompt` got a fourth argument for this; a request that does not ask for images builds the same prompt as before.
- **Sessions with images are not kept** for reuse (`!options.images`), and do not take a kept session.
- **Responses streaming with the tool:** the message item (and its text, in one delta) is emitted after the image items, so text is not streamed live for these requests. Without the tool the stream is unchanged.
- **Extras beyond the plan text:** the image endpoint also rejects `stream: true`, `partial_images` and the edit fields `image` / `images` (400 `unsupported_parameter`); Responses accepts `tool_choice` of `auto` / `required` / `{ type: "image_generation" }` when the image tool is present (clients that force the tool send it), otherwise `tool_choice` is rejected as before; `partial_images: 0` is tolerated. The tool's `size` / `quality` are accepted and ignored, as planned.
- **No `capabilities.imageGeneration` in `ProviderStatus`** (kept small; the router and provider expose `imageGeneration` instead).
- The `model_not_capable` check runs before the stream starts when the bridge is the router (real 400 even for streaming); a bridge without `canGenerateImages` leaves it to the provider.
- The new test file keeps the 30 s `testTimeout` that PR #9 added for tests that start an Antigravity provider.

Live check (headless CLI on port 18914, temporary `PROXY_SETTINGS_FILE` under `.claude/temp/aap14/live/`, Antigravity enabled with the downloaded `agy_acp_server.exe`, `PROXY_CODEX_ISOLATED_HOME=0`, `CLAUDECODE` / `CLAUDE_CODE_ENTRYPOINT` / `NODE_OPTIONS` unset; prompt "a cartoon dolphin jumping out of the sea"):

| Endpoint | Model | Time | Result | File afterwards |
|---|---|---|---|---|
| `/v1/images/generations` | `antigravity/gemini-3.8-flash-low` | 22.0 s | `output_format` `jpeg`, 824,189 bytes (`ffd8ffe0`), a cartoon dolphin | the agent's `brain/<session>/` held only its logs, no image |
| `/v1/images/generations` | `codex/gpt-5.6-luna` | 30.4 s | `output_format` `png`, 2,088,340 bytes (`89504e47`), `revised_prompt` present, a cartoon dolphin | `~/.codex/generated_images` listing unchanged (the new file and its thread folder are gone) |
| `/v1/responses` `image_generation` | `antigravity/gemini-3.8-flash-low` | 22.2 s | `image_generation_call` `jpeg`, 920,944 bytes | no image left in `brain` |

Three generations on the real accounts, plus the model listing. The images are saved as `.claude/temp/aap14/live/{agy-images.jpg,codex-images.png,agy-responses.jpg}`. The proxy was stopped with Git Bash's `kill -TERM` (on Windows this ends the process; the log has no "Received SIGTERM" line, so the graceful shutdown did not run); no `agy_acp_server.exe` / `localharness_external.exe` / codex child of the run was left. The three Antigravity sessions of the run (two generations and the model listing) were then purged with the proxy's own `purgeRecordedSessions` from the recorded ids, so `~/.gemini/antigravity-acp/brain` is as before. Nothing else under `~/.codex`, `~/.claude`, `~/.gemini` or `~/.agents` was touched.

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

**Status (2026-10-26): implemented and live-checked.** `npm run typecheck` clean, `npm run build` succeeds, `npm test`: 17 files passed, 257 tests passed, 1 skipped (live smoke). Branch `AAP-15_function-calling` (stacked on `AAP-14_image-generation`), nothing committed.
- [x] 1 `src/tool-bridge.ts`: `ToolBridgeHub` (token to `BridgeSession`, route `/mcp/<token>`) and `BridgeSession` (`initialize` echoing the protocol version, `ping`, `tools/list` with `readOnlyHint: true`, `-32601` for other methods such as `server/discover`, 202 for notifications, GET 405, DELETE 200, `tools/call` as SSE: `: keepalive` at once and every 20 s, one `message` event). State is per token, so a reconnect with a new `initialize` works. The route is in `createProxyServer` before the API-key check; an unknown token is a 404. The hub learns where the proxy listens from the server's `listening` event (`setAddress`, a wildcard bind becomes `127.0.0.1`), so the port is the real one also with `port: 0`; the controller creates the hub, puts it into `RuntimeContext.toolBridge` (providers) and `createProxyServer` options (route), and `closeAll()`s it before it drains the server on stop.
- [x] 2 `src/api.ts`: chat `tools` / `tool_choice` / `parallel_tool_calls`, assistant `tool_calls` with null content, `role: "tool"`; Responses function `tools`, `tool_choice`, `parallel_tool_calls`, `function_call` / `function_call_output` items (a `function_call` joins the assistant message right before it). `Message` gained `role: "tool"`, `toolCalls`, `toolCallId`; normalized requests carry `functionTools`, `toolChoice`, `parallelToolCalls` (none for `tool_choice: "none"`). `buildPrompt` serializes tool calls and results (`[tool call <id>] name args`, `[tool result <id>]`) and takes a fifth argument for the tools preamble (`client` MCP server only; `required` / named function / `parallel_tool_calls: false` add an instruction line). `tools` and `tool_choice` left the unsupported lists.
- [x] 3 `src/acp-provider.ts`: `generate()` with `options.tools` goes to `generateWithTools`; fresh bridge session (never from the warm pool; `mcpServers: [{ type: "http", name: "client", url, headers: [] }]` and the descriptor's `bridgeSessionMeta` merged into `_meta`); `ToolTurn` (the pending prompt, `sink` callbacks, tracked `tool_call` fields per id, pending calls); batching 150 ms after the latest `tools/call`; `suspend` / `takeSuspended` (matches the ids and the whole earlier history with the same comparison as session reuse, same model and same tools) / `expire`; the `suspended` map is keyed by call id and counts against the kept-session cap (`keep` and `suspend` evict the oldest; a finished conversation is not kept when suspended turns fill the cap). `GenerationResult.toolCalls` and `stopReason: "tool_calls"`. Resume reuses `runGeneration` of the new request, so the AAP-09 limit applies to the resumed text.
- [x] 4 prompt and `tool_choice`: see step 2; `none` gives no bridge; the Antigravity no-tools preamble line is not added to a tools prompt.
- [x] 5 agents: Claude `bridgeSessionMeta` (`allowedTools: ["mcp__client__*"]`), rule `_meta.claudeCode.mcpServer.name === "client"`, `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT=0` in `claudeEnv`, no limit; Antigravity rule `toolCall._meta.mcp.server === "client"` and `is_mcp_tool_call`, limit 180 000; Codex rule `_meta.is_mcp_tool_approval` and the tracked `rawInput.server === "client"`, limit 300 000. All through the AAP-14 `permissionRules` / `answerPermission` (new descriptor field `allowTool(permission, tracked)`); only `allow_once`. Setting `server.toolResultTimeoutMs` (env `PROXY_TOOL_RESULT_TIMEOUT_MS`, default 600 000); the effective timeout is `min(setting, toolCallLimitMs - 30 s)`.
- [x] 6 output: chat `finish_reason: "tool_calls"`, `message.tool_calls` (content null without text), streaming `delta.tool_calls`; Responses `function_call` items after the message (the message item is opened lazily with the first text; none when the agent said nothing), events `output_item.added` / `function_call_arguments.delta` / `.done` / `output_item.done`, then `response.completed`.
- [x] 7 tests: `tests/tool-calling.test.ts` (42 tests) and the fake agent `FAKE_ACP_MCP=claude|agy|codex` (+ `_CALLS`, `_TEXT`, `_ONCE`, `_STRAY`). Covers chat and Responses (stream and not), resume on the same session (one `session/new`, one `session/prompt`), several rounds, parallel calls and `parallel_tool_calls: false`, the SSE reply with keepalives (also at the hub with a short interval), the agy reconnect (two `initialize`), the per-provider timeout and the text fallback after it, the cap, a wrong token 404, `tool_choice` none / required / named, the permission matrix per agent (stray requests cancelled, Codex id without a client call cancelled, the Claude fallback rule), session reuse after a tool conversation, no hand-over between tool and plain kept sessions, the warm pool left alone, the loopback address for wildcard binds, the controller port, parsing and 400s, a provider without tools (400 before the stream), `max_tokens` with tools, and requests without tools unchanged. Short timeouts are injectable (`AcpProviderOptions.toolBatchMs` / `toolCallMarginMs` / `toolResultTimeoutMs`, `ToolBridgeHub({ keepaliveMs })`).
- [x] 8 live check (below).
- [x] Docs: README (intro, env row, Supported API "Function calling", safety notes of the three providers), ROADMAP.

Deviations and decisions:
- **Where the port comes from:** the server's `listening` event, not the controller (so tests with port 0 and the hub's 7461 behave the same). A provider without a hub in its `RuntimeContext` (for example the `AcpBridge` compatibility class) cannot take tools: `Provider.toolCalling` is false and the server answers 400 `model_not_capable` before a stream starts (`AcpLike.canCallTools`, `ProviderRouter.canCallTools`).
- **Tools with images:** function tools together with the `image_generation` tool or chat `modalities` are a 400 `unsupported_parameter` (param `tools`); not worth combining the two permission rules and prompts.
- **Unsupported-parameter behaviour kept:** `tools: []`, `tool_choice` without tools and (Responses) `parallel_tool_calls` without function tools are still 400s, as the AAP-14 tests pin them; chat accepts `parallel_tool_calls` silently as before. `functions` / `function_call` (legacy) stay unsupported. A named `tool_choice` must be in `tools`. `tests/proxy.test.ts` used `tools: [{ type: "function" }]` as its "unsupported field" example; it now uses `functions`.
- **Responses input items:** message items now accept `type: "message"`, `id` and `status` (clients send our own output items back, which the strict schema rejected).
- **Cancel order:** a turn that is cancelled sends `session/cancel` first and answers its held calls with an error afterwards, so an agent does not continue the turn on the error result.
- **Claude permission rule through a descriptor field:** `bridgeSessionMeta` (generic deep merge into the session `_meta`) instead of Claude-specific code in the provider.
- **No settings-window field** for `toolResultTimeoutMs` (settings file and env only).
- **Usage:** a response that ends with tool calls reports the estimate (the agent's usage arrives with the final response); the final response reports the whole prompt's usage as the agent gave it (inflated for Claude, as the spike saw; noted in the README).
- **Codex batching differs from the spike:** in the live runs Codex (`gpt-5.6-luna`) returned both tools in one batch (two `tools/call`s within 150 ms), the spike saw them strictly one after another. The batching handles both.

Live check (headless CLI on port 18915, temporary `PROXY_SETTINGS_FILE` under `.claude/temp/aap15/live/`, Claude / Antigravity enabled with the terms env vars, `PROXY_CODEX_ISOLATED_HOME=0`, `CLAUDECODE` / `CLAUDE_CODE_ENTRYPOINT` / `NODE_OPTIONS` unset; the OpenAI JS SDK 7.20 driver `.claude/temp/aap15/live/loop.mjs` with `get_weather(city)` and `add(a, b)`, prompt "What is the weather in Paris, and what is 17 plus 25? Use the tools, then answer in one sentence."):

| API | Model | Round trips | Time | Answer |
|---|---|---|---|---|
| chat | `claude/haiku` | 2 (both tools in round 1) | 3.2 s | "In Paris it is 18 °C and sunny, and 17 plus 25 is 42." |
| chat, streamed, first tool result held **90 s** | `claude/haiku` | 2 | 94.3 s (round 2 took 2.2 s after the result) | "In Paris it is currently 18°C and sunny, and 17 plus 25 is 42." |
| chat | `codex/gpt-5.6-luna` | 2 (both tools in round 1) | 11.4 s | "It is 18°C and sunny in Paris, and 17 plus 25 equals 42." |
| responses | `codex/gpt-5.6-luna` | 2 (both tools in round 1) | 10.7 s | "It is 18°C and sunny in Paris, and 17 plus 25 equals 42." |
| chat | `antigravity/gemini-3.8-flash-low` | 4 (one call each; the first `get_weather` used `location` instead of `city` and was retried) | 25.5 s | "The weather in Paris is 18°C and sunny, and 17 plus 25 is 42." |

The 90 s hold ran past Claude's 60 s limit for a JSON reply: the SSE reply and `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT=0` carried it, and the same session finished the turn in the second request. Five conversations on the real accounts (plus the model listing). The proxy was stopped with `kill -TERM` (it was down afterwards); no `agy_acp_server` / `localharness_external` / `codex-acp` / `claude-agent-acp` process of the run was left (the `codex` processes seen belong to the user's Codex desktop app). The two recorded Antigravity sessions of the run (the model listing and the loop) were purged with the proxy's own `purgeRecordedSessions`. Nothing under `~/.codex`, `~/.claude`, `~/.gemini` or `~/.agents` was read or edited by hand.

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

**Status (2026-10-26): implemented and live-checked.** Branch `AAP-16_remote-mcp` (stacked on `AAP-15_function-calling`), nothing committed. `npm run typecheck` clean, `npm run build` succeeds, `npm test`: 18 files passed, 288 tests passed, 1 skipped (live smoke).
- [x] 1 Responses `mcp` tools (`parseMcpTool` in `src/api.ts`, `normalizeResponses` returns `mcpTools`): label, `server_url` (http/https), `headers`, `allowed_tools` (array or `{ tool_names }`), `require_approval` (only `"never"` / `{ never: { tool_names? } }`), `server_description` ignored. `src/mcp-servers.ts` `resolveMcpServers` matches them with the settings and builds `McpServerSpec`s (`src/mcp-config.ts`); `AcpProvider` turns them into the ACP entries (`acpServer`: `{ type: "http" | "sse", name: <label>, url, headers: [{ name, value }] }`, stdio `{ name, command, args, env: [{ name, value }] }`) in `session/new`, next to the `client` bridge when there are function tools. The agent's `mcpCapabilities` are read at initialize; an `sse` server for an agent without it (Codex) is a 400 `unsupported_parameter`.
- [x] 2 Settings: top-level `mcpServers` (zod in `src/settings.ts`: validated labels, `client` reserved, `{ url, headers?, transport? }` or `{ command, args?, env? }`), `ProxyConfig.mcpServers`. A request may name a configured label without `server_url`; a `server_url` or `headers` for a configured label, a stdio server in a request and an unknown label are 400s. JSON only, no settings-window editor.
- [x] 3 Permissions: the AAP-15 per-agent rules generalized to the session's server labels and the tool filter. `ProviderDescriptor.allowTool(permission, tracked, mcp)` now gets `mcp: { labels, allows(server, tool) }`; new `mcpTarget(call, labels)` (identifies an MCP call: server, tool, arguments) and `mcpSessionMeta(servers)` (replaces `bridgeSessionMeta`; Claude `allowedTools`: `mcp__<label>__<tool>` or `mcp__<label>__*`). Claude: `_meta.claudeCode.mcpServer.name` + `toolName`; Antigravity: `_meta.mcp.server` / `.tool` + `is_mcp_tool_call`; Codex: `is_mcp_tool_approval` + the tracked `rawInput.server` / `.tool`. Only `allow_once`; everything else cancelled.
- [x] 4 Output: `mcp_call` items `{ id, type, server_label, name, arguments, output, error, status }` from the tracked `tool_call` / `tool_call_update` fields (`trackToolCall`, `toolOutput`, `collectMcpCalls`), before the message; streamed as `output_item.added`, `response.mcp_call.in_progress`, `response.mcp_call.completed` / `.failed`, `output_item.done`. No `mcp_list_tools` item (see deviations).
- [x] 5 Timeouts documented (Claude none, Antigravity 180 s, Codex 300 s).
- [x] 6 Settings UI: JSON only (README).
- [x] 7 Tests: `tests/mcp-servers.test.ts` (31 tests) and the fake agent `FAKE_ACP_REMOTE=claude|agy|codex` (+ `_CALLS`, `_FAIL`, `FAKE_ACP_MCP_CAPS`); a tiny `node:http` MCP server in the test. Covers a request URL with headers and a settings label (Claude, Antigravity), a settings stdio entry (Codex), sse to Claude and refused for Codex, all the 400s (stdio in a request, missing / non-never approval, reserved / bad / duplicate labels, configured-label override, headers on a configured server, bad URL / header / filter, connector, authorization, with `image_generation`, chat, a provider without MCP), `mcp_call` items non-streaming and streaming (completed and failed), the permission matrix per agent (the allowed tool runs, a tool outside `allowed_tools` or `never.tool_names` is cancelled and shows as a failed item), the descriptor rules unit-tested (wrong server, wrong tool, missing flag, Codex without a tracked call), a combined `function` + `mcp` request (non-streaming with resume, streaming, same-servers rule), sessions with servers never kept, the settings schema, requests without `mcp` tools unchanged. The existing suite passes unchanged except `bridgeSessionMeta` → `mcpSessionMeta` in one test override.
- [x] Docs: README ("MCP servers" block under Supported API, the three safety notes, the Responses paragraph), ROADMAP (one line).
- [x] Live check (below).

Decisions (given by the orchestrator, implemented as stated):
- **Where:** only Responses (chat has no MCP tool type and keeps its 400). `mcp` may be combined with `function` tools (the `client` bridge plus the remote servers in one session); with `image_generation` it is a 400 `unsupported_parameter`.
- **Approval:** only `"never"` and `{ never: { tool_names } }` (only those tools run); anything else, the missing default included, is a 400 `unsupported_parameter` that says the approval flow is not supported and to send `require_approval: "never"`.
- **Labels:** `^[A-Za-z0-9_-]{1,64}$`, not `client`, unique within a request.
- **Transport:** a request's `server_url` becomes an ACP `http` server; a settings entry may say `transport: "sse"`; sse for an agent without `mcpCapabilities.sse` is a 400.
- **Settings:** `mcpServers` in `settings.json`, JSON only; a request may name a configured label; a request `server_url` must not reuse a configured label; stdio only from settings.
- **Permissions:** per agent, as in the rules above; always `allow_once` only.
- **Output:** `mcp_call` items from the ACP updates; Antigravity's output is its placeholder text.
- **Timeouts:** the agents' own limits apply. **Fresh sessions:** sessions with `mcp` tools are always fresh (never warm).

Deviations and notes:
- **No `mcp_list_tools` item.** No ACP update lists an MCP server's tools (the spike dumps and the live runs show `available_commands_update` for slash commands only, and Codex reports only startup failures), and the proxy does not connect to the remote servers itself. Omitted, as the plan allowed; documented in the README.
- **Not kept for reuse:** a request with `mcp` tools and no function tools is never kept (always disposed after its turn). With function tools too, the tool-set key (`toolsKey`) includes the servers (labels, URLs, headers, filter), so a kept or suspended session is taken only by a request with the same tools and servers.
- **`tool_choice` / `parallel_tool_calls` without function tools** are still rejected for an `mcp`-only request, as for the image tool. `tool_choice: "none"` with function tools drops the `mcp` tools as well.
- **Tool filter:** `allowed_tools` and `never.tool_names` both given means the intersection (empty intersection or an empty list: 400 `invalid_request`). `never` without `tool_names` means all tools. Tool names in a filter cannot contain spaces, `*` or parentheses (Claude's `allowedTools` syntax). The prompt names the servers and, when filtered, the tools the agent may use.
- **Echoed items:** `mcp_call` and `mcp_list_tools` items in a Responses `input` are accepted and left out of the prompt (clients send our output items back; the strict input schema would have rejected them). Not in the plan text.
- **Streaming text:** with `mcp` tools the message item comes after the `mcp_call` items, so its text is not streamed live (one delta), as for image generation (the server's `deferred` flag covers both).
- **Capability for sse/http** is checked once the agent has started, so for a streamed request the 400 arrives as an SSE error event (as for the image capability in AAP-13). Everything that can be checked before (labels, approval, settings, a provider without MCP support, `model_not_capable`) is a real 400.
- The fake agent now always advertises `mcpCapabilities` (`{ http: true, sse: true }`, `FAKE_ACP_MCP_CAPS` overrides).
- Headers and env of settings entries are stored in plain text (the settings codec only encrypts the known secret fields); documented.
- **Review fix: a bad `mcpServers` entry no longer resets the settings file.** `SettingsStore.load()` parses the file without `mcpServers`, then `sanitizeMcpServers` (`src/settings.ts`) checks the label and the entry one by one: a valid entry is kept, an invalid one (or a non-object `mcpServers`) is dropped with a `logger.warn` naming the label and the first issue. The rest of the settings load, the file is not moved to `.bak-*` and not rewritten (the user's text stays so they can fix it). Only genuinely corrupt files (bad JSON, other invalid fields) get the `.bak` behaviour. `settingsSchema` itself stays strict, so `save()` / `mergeSettings` validate what the app writes; the consequence is that a later save from the settings window writes only the valid entries (documented in the README). The settings window does not expose `mcpServers`. Tests: `tests/settings.test.ts` ("mcpServers": one valid and several invalid entries with other settings, non-object values, bad JSON still backed up).

Live check (headless CLI on port 18916, temporary `PROXY_SETTINGS_FILE` `.claude/temp/aap16/live/settings.json` with a `stdioecho` entry, `PROXY_CODEX_ISOLATED_HOME=0`, `CLAUDECODE` / `CLAUDE_CODE_ENTRYPOINT` / `NODE_OPTIONS` unset; remote server `.claude/temp/aap11/mcp-echo.mjs` on port 18917 (`echo`), driver `.claude/temp/aap16/live/ask.mjs` with the OpenAI JS SDK, `require_approval: "never"`, prompt "Call the echo tool of the MCP server named docs with q='hello from <model>', then tell me what it returned in one sentence."):

| Server | Model | Time | `mcp_call` item | Answer |
|---|---|---|---|---|
| http, request `server_url` | `claude/haiku` | 2.9 s | `echo`, output `echo: hello from claude/haiku`, completed | "The docs echo tool returned ..." |
| http, request `server_url` | `codex/gpt-5.6-luna` | 11.7 s | `echo`, output `echo: hello from codex/gpt-5.6-luna`, completed | "The echo tool returned: ..." |
| http, request `server_url` | `antigravity/gemini-3.8-flash-low` | 14.6 s | `echo`, output `Docs echo tool call` (the agent's placeholder), completed | "The tool returned \"echo: hello from antigravity/...\"" (the model had the real result) |
| stdio, configured label `stdioecho` (`.claude/temp/aap16/stdio-echo.mjs`) | `claude/haiku` | 3.2 s | `stdio_echo`, output `stdio echo: hello from claude/haiku`, completed; the stdio log shows Claude started the process and sent `initialize`, `tools/list` and `tools/call` | "The stdio_echo tool returned ..." |
| http, streamed | `claude/haiku` | 2.5 s | events: `response.created`, `output_item.added`, `mcp_call.in_progress`, `mcp_call.completed`, `output_item.done`, then the message events, `response.completed` | |

Five prompts on the real accounts (plus the model listing). The proxy and the mock server were stopped with `kill -TERM` (nothing listens on 18916 / 18917 afterwards; the proxy log has no "Received SIGTERM" line, as in the earlier phases); no `agy_acp_server` / `localharness_external` / `codex-acp` / `claude-agent-acp` / stdio echo process of the run is left. The two recorded Antigravity sessions of the run (the model listing and the request) were purged with the proxy's own `purgeRecordedSessions` (`.claude/temp/aap16/live/purge.mjs`, returned 2). Nothing under `~/.codex`, `~/.claude`, `~/.gemini` or `~/.agents` was read or edited by hand.

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

**Status (2026-10-26): implemented and live-checked.** Branch `AAP-17_web-search` (cut from `origin/master` `219c106`), nothing committed. `npm run typecheck` clean, `npm run build` succeeds, `npm test`: 19 files passed, 320 tests passed, 1 skipped (live smoke).
- [x] 1 request shapes: chat `web_search_options`; Responses `web_search` / `web_search_preview` tools (`search_context_size`, `user_location`, `filters.allowed_domains`). `parseWebSearch` and friends in `src/api.ts`; normalized requests carry `webSearch?: WebSearchRequest` (`{ location?, domains?, required? }`); `GenerateOptions.webSearch`.
- [x] 2 per agent: new `ProviderDescriptor.webSearch?: { sessionMeta?, allow?(permission, tracked), search(call) }` (`src/provider.ts`). Claude: `sessionMeta` `{ claudeCode: { options: { tools: ["WebSearch"], allowedTools: ["WebSearch"] } } }` and `allow` on `name` / `_meta.claudeCode.toolName` / the tracked call. Antigravity: `allow` = `kind === "search"` and `title === "Run search_web?"`. Codex: only `search` (always on, no permission). `AcpProvider.webSearchSupport`, `ProviderRouter.canSearchWeb`, `AcpLike.canSearchWeb`: a model whose provider cannot search is a 400 `model_not_capable` before a stream starts.
- [x] 3 prompt: `buildPrompt` gets a sixth argument; a search request replaces the generic preamble (and leaves out Antigravity's no-tools line); with tools the tools preamble says "web search only through your web search tool". The location, domains and `required` become hint lines. A request without search builds the same prompt as before (asserted byte for byte).
- [x] 4 sessions: a search request gets a fresh session (`createSession(..., search)` merges `webSearch.sessionMeta`), never from the warm pool, never kept and never takes a kept one.
- [x] 5 output: `GenerationResult.searches`; Responses `web_search_call` items before the message and the streaming events; `url_citation` annotations from `src/citations.ts` (Responses `content[].annotations` and `response.output_text.annotation.added`; chat `message.annotations` and one `delta.annotations` chunk). Without a search request `annotations` is unchanged.
- [x] 6 README: "Web search" block under Supported API, Codex path fix (`%APPDATA%\api-acp-proxy\codex-home`), intro and safety notes. `ROADMAP.md`: one line.
- [x] 7 tests: `tests/web-search.test.ts` (29 tests) and the fake agent `FAKE_ACP_SEARCH=claude|agy|codex` (+ `_COUNT`, `_TEXT`, `_STRAY`, `_ASK`). Covers chat and Responses (stream and not), the items and their events, annotation indices checked with `text.slice`, the Claude session meta (`tools` and `allowedTools`, no `WebFetch`), the permission matrix (Antigravity's `read_url_content` / `run_command` / a look-alike cancelled, Claude's `WebFetch` cancelled, the `WebSearch` fallback rule), a request without search keeping its prompt / meta / permissions, fresh sessions (warm pool and reuse), combinations with function tools and `mcp` tools, all the 400s, the citation extractor and the descriptor rules.
- [x] 8 live check (below).

Decisions and deviations:
- **Search with function tools and `mcp` tools is allowed** (not a 400): Claude's `tools` / `allowedTools` lists merge (`mergeMeta` now joins two arrays without duplicates instead of replacing; nothing else had two arrays), the permission rules are or-ed (`toolRule`: the MCP rule or the search rule), and the tool-set key of a kept or suspended session includes `search`. A search made before a function call is reported with the response that ends with the call (the `reported` set is shared with MCP calls), not again with the resumed one. With `tool_choice: "none"` search is left out with the tools. Search with image generation (Responses tool, chat `modalities`) is a 400 `unsupported_parameter`.
- **`web_search_call.action.sources` is `[{ type: "url", url }]`** (OpenAI's shape), so Claude's page titles are not on the item. Only Claude reports pages; Antigravity's result text and Codex's results are not returned.
- **Citation indices are UTF-16 offsets** (`text.slice(start, end)` is the whole `[title](url)` or the bare URL). Only links in the answer text are cited; the title is the link text or the host name.
- **Extras beyond the plan text:** `include: ["web_search_call.action.sources"]` is accepted next to a search tool (it would otherwise be a 400); `tool_choice` of `auto` / `required` / `{ type: "web_search" }` is accepted for a request whose tools are only search (and `mcp`), `required` adds an instruction line; at most one search tool; `user_location` is accepted in both the chat (`approximate` object) and the Responses (flat) shape; domains and location strings are validated (they go into the prompt); `trackToolCall` now merges `_meta` instead of replacing it (Claude's `toolResponse` arrives in an update that the final `completed` update, which only names the tool, would have overwritten); `answerPermission` logs one debug line per request (kind, title, allowed or cancelled; never the body), which is how the live check saw that Claude asked nothing.
- **Existing tests changed:** two tests used `{ type: "web_search" }` as their example of an unsupported Responses tool (`tests/image-generation.test.ts`, `tests/tool-calling.test.ts`); they use `file_search` now.
- **Streaming:** as for images and MCP, a Responses request with search sends its message in one delta after the items; chat text streams live and the annotations come in one chunk before the finish chunk.
- **Not enforced, documented:** `filters.allowed_domains` (a hint line only), `user_location` (a hint line), `search_context_size` (ignored). A request without search cannot switch off Codex's always-on search.
- **Not done:** the plan's "Antigravity: `[n]` markers and grounding redirect links in the result text" as sources on the item (the result text is not returned); the redirect links only show up as annotations when the answer itself contains them.

Live check (headless proxy on port 18918, `.claude/temp/aap17/live/run.mjs` = the CLI with a debug console logger, temporary `PROXY_SETTINGS_FILE` under `.claude/temp/aap17/live/`, Antigravity from `.claude/temp/agy-acp`, `PROXY_CODEX_ISOLATED_HOME=0`, `CLAUDECODE` / `CLAUDE_CODE_ENTRYPOINT` / `NODE_OPTIONS` unset; prompt "What is the latest stable version of Node.js? Search the web.", driver `.claude/temp/aap17/live/ask.mjs`):

| Endpoint | Model | Time | Searches | Citations | Notes |
|---|---|---|---|---|---|
| responses `web_search` | `claude/haiku` | 17.4 s | 2 `web_search_call` items, 10 sources each | 9 annotations (4 distinct URLs), every `slice` equals its link | **no permission request** (see below) |
| responses `web_search` | `codex/gpt-5.6-luna` | 11.7 s | 1 (query "site:nodejs.org latest stable version Node.js official"), no sources | 1 (a Markdown link) | no permission request |
| responses `web_search` | `antigravity/gemini-3.8-flash-low` | 19.9 s | 1 (`search_web`), no sources | 2 (Markdown links in a "Sources" list; this run held no grounding redirect links) | one permission request (kind `search`, title `Run search_web?`) allowed once |
| chat `web_search_options` | `codex/gpt-5.6-luna` | 14.6 s | n/a (chat has no items) | 1 `message.annotations` entry, `slice` matches | usage 15,565 total tokens |

**`allowedTools: ["WebSearch"]` does suppress Claude's permission request:** with the debug log on (one line per permission request) the Claude run logged none, and both searches ran. The fallback rule stays (tested with the fake agent). Four prompts on the real accounts (plus the model listing); no plain-prompt baseline was measured, so the timings are compared with the spike's (Claude 16.3 s vs 3.0 s plain, Antigravity +10 s, Codex 8 s vs 3 s), which they match. The proxy was killed with `Stop-Process` (the run's Antigravity `agy_acp_server` and two `localharness_external` children were orphaned and stopped by hand; no `agy_acp_server` / `localharness_external` / `codex-acp` / `claude-agent-acp` process of the run is left, and nothing listens on 18918). The two recorded Antigravity sessions of the run were purged with the proxy's own `purgeRecordedSessions` (`.claude/temp/aap17/live/purge.mjs`, returned 2). Nothing under `~/.codex`, `~/.claude`, `~/.gemini` or `~/.agents` was read or edited by hand.

## Docs (every phase)

The README "Supported API" section, env/settings tables, the safety notes per provider (what each request type can now enable), and `ROADMAP.md`.

## Acceptance

- `npm run typecheck` clean, `npm test` passes, `npm run build` succeeds, per phase.
- A live check per phase behind `RUN_LIVE_SMOKE=1`, as listed in each phase (hardened Codex answers a plain prompt; an image described by each agent; a dolphin from Antigravity and Codex; a two-tool loop with a 90 s tool against all three agents).
- A request that asks for nothing new behaves exactly as today.
