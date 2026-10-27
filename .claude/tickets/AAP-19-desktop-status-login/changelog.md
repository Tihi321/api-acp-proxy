# AAP-19 changelog

## 2026-10-27: desktop overview, log out for every provider, activity, tray

The settings window opens on an Overview card that shows, without a request, whether each provider is signed in. Every provider can log out from the window, and the tray shows provider state, request counts and "Log in to X".

**Repository:** api-acp-proxy. **Branch:** `AAP-19_desktop-status-login`, cut from `master` `82644df`.

### Files changed

**Providers and log out**
- `src/provider.ts`:
  - New status fields: `features` (image generation, tools, MCP, web search) and `loginHome` (`{ path, shared }`).
  - New descriptor hooks: `needsLogin`, `loginHome`, `logoutFallback` and `afterLogout`.
  - New optional method: `Provider.logout()`.
- `src/acp-provider.ts`:
  - `status()` reports `needs_login` before the agent has started, when the descriptor says it certainly has no login.
  - Reads `agentCapabilities.auth.logout`.
  - `logout()` sends ACP `logout` when the agent advertises it. Otherwise it stops the agent, runs the descriptor's fallback and restarts the agent.
  - After a logout it drops warm, kept and suspended sessions and calls `afterLogout`.
  - It ends in `needs_login`. Codex and Antigravity are then blocked with `provider_auth_required` until the next login; Claude is asked again on the next request.
- `src/providers/codex.ts`:
  - Codex's own home with no `auth.json` and no API key is `needs_login` from the start. This is an existence check only.
  - `loginHome`: the own home, or the shared `~/.codex`.
  - After any logout the proxy removes `<dataDir>/codex-home/auth.json`, and only in its own home. That file is also the fallback when there is no ACP logout. `~/.codex` is never touched by hand.
- `src/providers/claude.ts`:
  - The login helper becomes `consoleAuth`, which runs `claude auth <args>` visible (login) or hidden (logout).
  - `logoutFallback` runs `claude auth logout`.
  - `loginHome`: the config dir, or the shared `~/.claude`.
- `src/providers/antigravity.ts`: `loginHome` is the Gemini home, shared unless the setting names another folder.
- `src/controller.ts`:
  - `logout(id)`.
  - An `activity` log that outlives server restarts.
  - Events: `activity`, and `loginNeeded` (a request hit a provider that needs login).

**Activity**
- `src/activity.ts` (new): an in-memory ring buffer of the last 100 requests, with a day counter and `describeActivity()` for the tray text. It stores metadata only.
- `src/server.ts`: records one entry per API request when its response closes. `/healthz` and the tool bridge are not recorded. Each entry has endpoint, model, provider, stream, features, duration, status, error code and token counts; never text, headers or keys.
- `src/router.ts` and `src/acp.ts`: `providerOf(model)`, so an entry knows its provider.

**Desktop app**
- `src/mcp-servers.ts`: `listMcpServers()` lists the configured MCP servers for the window. A URL is shown without credentials, query or fragment, and a command without its arguments; headers and env are never shown.
- `src/shared/ipc.ts` and `src/electron/preload.cts`:
  - IPC `proxy:logout`, `proxy:activity` (invoke and push), `proxy:clearActivity` and `proxy:openPath`.
  - `proxy:openPath` accepts only the targets `codexHome` and `settingsFile`.
  - New view types.
- `src/electron/main.ts`:
  - Wires the new IPC handlers, the batched activity push and the tray hooks.
  - Adds `codexHome` and `mcpServers` to the state sent to the window.
- `src/electron/tray.ts`:
  - One line per provider with its state and account.
  - A line "N requests today, last X ago", also in the tooltip.
  - "Log in to X" items.
  - A one-time notification and an amber icon after a request hit a provider that needs login; both clear once it is signed in.
- `src/renderer/settings.{html,ts,css}`:
  - Overview card: per-provider badge, sign-in line, Log in and Log out, capability chips, model count and login folder.
  - The API address with a Copy button.
  - The read-only MCP list with "Open settings.json".
  - The "Recent requests" table: last 20, with Clear.
  - A confirmation before log out. For a shared home it says the user is signed out of that tool on this computer.
  - Settings: a `toolResultTimeoutMs` field, and the Codex home path with "Open folder".
- `assets/tray-warn.png` and `assets/tray-warn@2x.png` (new), from `scripts/make-icons.mjs`.

**Probe and docs**
- `scripts/acp-probe.mjs`:
  - `--logout` only reports the capability.
  - `--do-logout` also sends the request. It was only used with an empty temporary home.
- `README.md`: the desktop section covers the overview, log in and log out per agent, recent requests and the tray. It also adds Codex log out, the "Codex needs login" troubleshooting note and the probe flags.

**Tests**
- New `tests/logout.test.ts`, `tests/activity.test.ts` and `tests/desktop-views.test.ts`.
- `tests/controller.test.ts` gains status, logout, activity-across-restart and `loginNeeded` cases.
- `tests/fixtures/fake-acp.mjs` gains `FAKE_ACP_LOGOUT=1`.

### Deviations from the plan
- **Log out support:** all three agents advertise ACP `logout`; the plan expected Codex to be unknown. The fallbacks are for agent versions without it. Findings are in `spike.md`.
- **Codex `auth.json`:** also removed after an ACP logout, as belt and braces, and only in the proxy's own home.
- **Amber tray icon:** shown only after a request hit a provider that needs login, not whenever one needs login.
- **"Images in" chip:** appears only once the agent has started, because it comes from `initialize`. The other chips are static per provider.
- **Failed streams:** a stream that fails after it started is recorded with status 200 plus the proxy's error code.
- **Existing controller test:** it now expects Codex `needs_login` instead of `stopped` before the first request, because the test data dir has no `auth.json`.

### Verification
- **Implementer runs:**
  - `npm run typecheck` passed.
  - `npx vitest run --dir tests`: 22 files passed and 1 skipped; 355 tests passed and 1 skipped.
  - `npm run build` passed.
- **Orchestrator re-run:** the same three commands, with the same results.
- **Live, with the dev hooks:**
  - Setup: a separate app copy on port 8799 with temporary settings, and every provider on an empty temporary home.
  - Screenshots: the overview in the needs-login and stopped states, the activity table, the Codex card and the logout dialog.
  - A confirmed Codex logout against the temporary home: `auth.json` was gone and the row showed needs login.
  - Screenshots are in `.claude/temp/aap19/`.
- **Not run:**
  - The tray (menu text, tooltip, notification, amber icon): the dev hooks cannot read it, so it is covered by typecheck only.
  - The renderer and Electron main code have no unit tests.
  - Log out and log in again against real accounts; the user does this.
  - Plain `npm test` also collects tests from other worktrees under `.claude/`. A timing-based test, `acp-provider` "does not keep a cancelled turn", failed once while three copies ran in parallel and passed alone.

### Follow-ups
- The user's live check with real accounts, as listed in `plan.md`: log out and back in for Antigravity, Claude and Codex (own home), then the open AAP-12 Codex check.
- Scope `npm test` to `tests/`, so worktrees under `.claude/` are not collected.
- AAP-20 also edits `src/providers/codex.ts` and `src/server.ts` (`MODEL_IDS`), so expect small merge conflicts.

### Commit status
Uncommitted, on `AAP-19_desktop-status-login`.
