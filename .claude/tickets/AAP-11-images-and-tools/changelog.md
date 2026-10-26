# Changelog

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

**Status:** uncommitted, on `AAP-11_tool-spike`.

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

**Status:** uncommitted.
