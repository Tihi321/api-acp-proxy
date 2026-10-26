# Changelog

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

**Status:** uncommitted.

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
