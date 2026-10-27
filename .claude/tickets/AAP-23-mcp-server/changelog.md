# AAP-23 changelog

## 2026-10-27 - AAP-23: MCP server endpoint `POST /v1/mcp` (list_models, ask_model with images, generate_image)

Outcome: a harness such as Claude Code can ask another model, with image input, and generate images, through one MCP Streamable HTTP endpoint on the existing proxy.

### Repository `api-acp-proxy`, branch `AAP-23_mcp-server` (from `origin/master` 297ec65)
- `src/mcp-endpoint.ts` (new): hand-written stateless JSON-RPC endpoint. `initialize` (echoes 2025-06-18 / 2025-03-26 / 2024-11-05), `ping`, `tools/list`, batches (not `tools/call`), notifications, `notifications/cancelled`. `tools/call` for `ask_model` and `generate_image` answers as SSE (keepalive every 20 s, progress with a `progressToken`, one result event); both are bound by `PROXY_TIMEOUT_MS` and abort on cancel or connection close. Tools: `list_models` (once per model, aliases, `image_input` true/false/null, `image_generation`, `web_search`), `ask_model` (threads in memory: 32, 1 h idle, 16 images / 64 MB per thread, 256 MB store; images by `path`/`url`/`data`, max 8), `generate_image` (reference images max 4, `size`, `save_to`, `file_name`, `return_image`, 3 MB inline cap, saved with `wx`, cleanup of own `img-*` files, remote callers inline only). Errors are tool results with codes; bad shapes are `-32602`. Origin check (403), Content-Type check (415), local-caller check by socket address (`isLoopbackAddress`), body limit, one activity entry per tool call (metadata only).
- `src/images.ts`: `checkAbsolutePath` and `loadImageFile` (absolute local paths only, UNC/device/ADS rejected before any file system call, `realpath`, regular file <= 10 MB checked before reading, magic-byte check, generic messages); `ImageError` gains `path_not_allowed` and `invalid_image_path`.
- `src/api.ts`: exported `imageGenerationText`, shared with `/v1/images/generations`.
- `src/acp.ts`, `src/router.ts`: `AcpLike.acceptsImages?` and `ProviderRouter.acceptsImages` (provider's `promptCapabilities.image`, undefined until started).
- `src/server.ts`: routes `/v1/mcp` after the key check (no `track()` for it, it logs its own entries); options `mcpImageDir`, `isLocalCaller`, `mcp` (test tuning); the endpoint is closed with the server. The `/mcp/<token>` tool bridge is unchanged.
- `src/controller.ts`: `mcpImageDir` = `<dataDir>/mcp-images`.
- `src/renderer/settings.html`, `settings.ts`, `settings.css`, `src/renderer/mcp-command.ts` (new): Overview **MCP** line with the endpoint URL and **Copy command** button (placeholder `--header` when a key is set, never the key). Recent requests needed no change (unknown endpoints print as is; the feature chips exist).
- `README.md`: new "MCP server (for harnesses)" section, endpoint mention in Supported API, Overview text, `mcp-images\` row in the Files table. `ROADMAP.md`: checked AAP-23 item.
- Tests: `tests/mcp-endpoint.test.ts` (new, 48 tests covering the plan's Tests list, plus one against the real `ProviderRouter`), `tests/images.test.ts` (`loadImageFile`), `tests/router.test.ts` (`acceptsImages`), `tests/mcp-command.test.ts` (new, 3).
- Ticket: `.claude/tickets/AAP-23-mcp-server/plan.md` (branch note, status) and this file. `.gitignore` carries the pre-approved `.claude/director/` line (CRLF kept).

### Deviations from the plan
1. Origin rule is stricter: the proxy's own `Host` is accepted as an Origin only when it is an IP literal (a DNS name there is what a rebinding page uses). Loopback names and requests without `Origin` behave as planned. README text adjusted.
2. A relative or UNC `save_to` is `path_not_allowed` (same rule as `images[].path`); a missing folder or a file is `invalid_save_path`.
3. Cancelled calls are logged as status 499, error `cancelled`, and the stream ends without a result (the plan gave no status).
4. `-32602` argument errors are not logged as activity entries; an unknown model is logged without a `model` field.
5. Extra tool error `thread_busy` (409) for two simultaneous calls on one thread; a failed call leaves the thread unchanged; a new thread exists only after a successful turn.
6. `finish_reason` is mapped locally (no import cycle with `server.ts`); the generation promise is raced against the abort signal so a silent provider still ends in `request_timeout` or a cancel.
7. `notifications/cancelled` is matched by caller address plus request id.
8. `mime_type` must match `[A-Za-z0-9.+/-]` and only goes with `data`.
9. Extra files: `src/renderer/mcp-command.ts` (pure helper; `shared/ipc.ts` stays types-only), `tests/mcp-command.test.ts`, a router test.

### Verification (run by the orchestrator after review)
- `npm run typecheck`: pass.
- `npx vitest run --dir tests`: 26 files passed, 1 skipped (live smoke, skipped before this change); 422 tests passed, 1 skipped.
- `npm run build`: pass.
- Review of `src/mcp-endpoint.ts` and `src/images.ts` against the plan's Security section (local-caller rule, absolute/UNC rules, `wx` writes, file-name sanitising, cleanup scope, no paths or prompts in activity entries or logs): no gaps found.

### Not verified (for the user)
- In a running app: `claude mcp add --transport http acp-proxy http://127.0.0.1:8787/v1/mcp`, then `ask_model` with gpt-6-luna and a follow-up on the `thread_id`.
- `ask_model` with a real screenshot by `path`, and a follow-up on the thread.
- `generate_image` with `save_to` on a repo `assets\` folder with Codex (PNG) and Antigravity (JPEG), inline vs over 3 MB.
- `generate_image` with a Claude model (`model_not_capable`) and a Codex model that needs login (tool error, no hang) against real agents.
- The Overview MCP line, the Copy command click and the Recent requests chips in the real Electron window (the settings page was not rendered here).
- No real SMB/UNC access was attempted; UNC rejection is shown only by file-system spies not being called.

### Follow-ups and limits
- A reverse proxy on this machine in front of the proxy makes every caller look local (documented in the README).
- Fixed after review (user-approved): `safeBaseName` now tests the part before the first dot against the Windows device names (`con.x.y`, `NUL.tar.gz` get `img-`), with a test; the README tool error list now names `model_not_found`, `thread_not_found`, `thread_model_mismatch` and `thread_busy`. `conin$`/`conout$` need nothing: the sanitiser already turns `$` into `-`.
- A stdio wrapper, persisted threads, resizing and non-image files remain out of scope per the plan.

### Commit status
Uncommitted on branch `AAP-23_mcp-server` (nothing pushed).
