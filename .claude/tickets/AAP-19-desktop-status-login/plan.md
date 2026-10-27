# AAP-19: Desktop app — status overview, log in and log out for every provider

> Branch: `AAP-19_desktop-status-login`, cut from `master` once AAP-17 (PR #13) is merged. AAP-18 (graceful CLI stop) runs in its own session and touches `src/index.ts` / `src/process-tree.ts` only.

## Why

The desktop app (AAP-03) already has a tray icon and a settings window with a **Log in** button per provider. The user did not know about it, and it does not answer three questions:
- **Am I signed in, and as whom?**
  - Codex shows "stopped" until the first request, even when its own home (AAP-12) has no login.
  - Only Claude shows an account.
- **How do I sign out?** There is no log-out anywhere.
- **What can it do, and what is it doing?** The window does not show:
  - what the proxy can do now (images, image generation, tools, MCP servers, web search);
  - which MCP servers are configured;
  - whether requests are coming in.

## Scope

### 1. Overview card (top of the settings window)
One row per provider:
- State badge, with "needs login" shown without a request:
  - **Codex:** isolated home without `auth.json` and no API key. Check with `existsSync` only, as `loginRequired` already does.
  - **Claude and Antigravity:** their existing status.
- Signed-in account label when the agent reports one (Claude's `_auth/status_update` today).
- **Log in** and **Log out** buttons, with the sign-in method picker kept on the provider card.
- Capability chips from the provider status: images in, image generation, tools, MCP, web search.
- Model count.

The card also shows:
- The proxy URL with a copy button.
- The configured MCP servers (labels, transport, URL or command), read-only.

### 2. Log out
- **Probe first.** Run `scripts/acp-probe.mjs` with a `--logout` flag (new) to find which agents implement ACP `logout`:
  - Claude's adapter advertises `logout: {}`.
  - Antigravity advertises `auth: logout`.
  - Codex is unknown.
  - Record the findings in this folder as `spike.md`.
- `Provider.logout()` calls ACP `logout` when the agent advertises it, and falls back where it does not:
  - **Codex** with an isolated home: stop the agent and delete `<dataDir>/codex-home/auth.json` (the only file the proxy deletes; nothing in `~/.codex` is touched).
  - **Claude:** run the bundled `claude auth logout` in the same console flow as login, then restart the agent.
  - **Antigravity:** ACP `logout`.
- With a non-isolated home (`~/.codex`, `~/.claude`, `~/.gemini`), Log out signs the user out of that tool everywhere. Show a confirm dialog that says so.
- After log-out the provider shows "needs login" and drops kept/warm sessions.

### 3. Activity
- A small in-memory ring buffer (last 100 requests) in the server, with:
  - time, endpoint, model;
  - streamed or not;
  - features used (images, image generation, tools, MCP, search);
  - duration, status code / error code, and usage tokens.
- No prompt text, no output, no headers, never written to disk.
- Shown as a table in the window: last 20, newest first, with a Clear button.
- Shown in the tray tooltip as "N requests today, last 2 min ago".

### 4. Tray
- One menu line per provider with state and account, plus a **Log in to X** item when it needs login.
- The icon stays green while running. A provider that needs login shows the warning tint and a one-time notification "Codex needs login" when a request hits it.

### 5. Settings window additions
- `server.toolResultTimeoutMs` field.
- Codex home path shown (with "open folder") under the isolated-home checkbox.

## Out of scope
- **Editing MCP servers** in the UI. The card shows them read-only with an "open settings.json" button; an editor can be a later ticket.
- **Usage history across restarts.**

## Tests
- Provider status and `logout()` with the fake agent (`FAKE_ACP_LOGOUT=1`, plus a fake without the capability). Codex: isolated home `auth.json` removed and state `needs_login`, and `~/.codex` never touched (test with a temp home).
- Activity buffer:
  - cap and ordering;
  - no prompt text stored;
  - features detected for each request type.
- Renderer: the existing IPC tests pattern for the new channels (`proxy:logout`, `proxy:activity`).

## Live check
- Start the app with `ACP_PROXY_DEV_DIR` and take screenshots (`shot`) of the overview, the activity table and the tray menu text (`dump`).
- Log out and log in with Antigravity: browser flow, user present.
- Codex log-in in its own home: browser flow, the user does this. Afterwards, the open AAP-12 check: a prompt in the isolated home, with no skills or MCP visible, and image generation and search working.

## Acceptance
- `npm run typecheck`, `npm test` and `npm run build` pass.
- Without any request:
  - the window shows for each provider whether it is signed in;
  - Codex's own home shows "needs login" until the user logs in.
- Every provider can be logged out and back in from the window and the tray.
- The activity table and tray tooltip show requests as they happen.

---

## Status (implemented 2026-10-27, branch `AAP-19_desktop-status-login`, nothing committed)

- [x] **Probe first.** `scripts/acp-probe.mjs --logout` / `--do-logout`; findings in `spike.md` (all three agents advertise ACP `logout`; `logout` was only sent to Codex with an empty temporary `CODEX_HOME`).
- [x] **Status without a request.** `ProviderDescriptor.needsLogin` (Codex: own home, chat-gpt method, no API key, no `auth.json`, existence check only) makes `AcpProvider.status()` report `needs_login` instead of `stopped` without starting the agent. Also new in the status: `features` (image generation, tools, MCP, web search), `loginHome` (path, shared or not).
- [x] **Log out.** `Provider.logout()` (`AcpProvider.logout`): ACP `logout` when advertised, else the descriptor's `logoutFallback` between a stop and a restart; `afterLogout` always. Codex: removes only `<dataDir>/codex-home/auth.json`, only with the own home on. Claude: bundled `claude auth logout` (hidden, shared helper `consoleAuth` with the login). Antigravity: ACP only. Then warm and kept sessions are dropped, state `needs_login`, further requests refused with `provider_auth_required` until a login. Controller `logout(id)`, IPC `proxy:logout`, preload `logout`.
- [x] **Overview card** (top of the window): per provider state badge, sign-in line, **Log in** / **Log out**, capability chips, model count, login folder; API address with copy; read-only MCP server list with **Open settings.json**. Log out asks for confirmation naming what happens (a shared home says it signs the user out of that tool on this computer).
- [x] **Activity.** `src/activity.ts` ring buffer (100, in memory), fed from `src/server.ts` (time, endpoint, model, provider, stream, features, duration, status, error code, token counts; never text, headers, keys or URLs). `proxy:activity` (invoke and push), `proxy:clearActivity`; table of the last 20 with Clear in the window.
- [x] **Tray.** One line per provider with state and account, "N requests today, last X ago" line and tooltip, **Log in to X** items, one-time notification "X needs login" when a request hits such a provider plus a new amber icon (`assets/tray-warn*.png`, generated by `npm run icons`) until it is signed in.
- [x] **Settings additions.** `server.toolResultTimeoutMs` field; Codex home path with **Open folder** (`proxy:openPath`); MCP list (see overview).
- [x] **Tests.** New `tests/logout.test.ts` (ACP logout, Claude-style push, fallback, Codex own home / shared home / no ACP logout, status without a request, login home and features), `tests/activity.test.ts` (cap, ordering, day count, features per request type, error codes, no text stored, no /healthz), `tests/desktop-views.test.ts` (MCP list without secrets), controller tests (status, logout, activity across restart, `loginNeeded`); fake agent: `FAKE_ACP_LOGOUT=1`.
- [x] **Docs.** README: desktop section (overview, log in and log out per agent, recent requests, tray), Codex "log out" and the "Codex needs login" troubleshooting note, probe flags.

### Verification (evidence)

- `npm run typecheck`: passed (core + renderer).
- `npx vitest run --dir tests`: 22 files passed, 1 skipped (live smoke); 355 tests passed, 1 skipped. Plain `npm test` also picks up the other sessions' worktrees under `.claude/` (`.claude/worktrees/*`, `.claude/temp/wt-*`): in one run a timing-based test of `acp-provider.test.ts` (`does not keep a cancelled turn`) failed in all three copies while they ran at the same time, and passed alone three times in a row; it is unrelated to this change. A Codex home left in `.claude/temp` by a live run also contains vendored plugin tests that `npm test` would pick up (deleted).
- `npm run build`: passed.
- Live check with the dev hooks (own copy, `ACP_PROXY_DEV_DIR=.claude/temp/aap19/dev`, temporary settings and data folder `.claude/temp/aap19/live`, all three providers pointed at empty temporary homes, the user's earlier dev copy quit first with its `quit` file): overview in needs-login and stopped states, activity table after `/v1/models`, a 404, a bad model, a bad body, a Codex request without login (503 and a stream with 200 + error code), the logout dialog, and a confirmed Codex log out against the temporary home (`auth.json` gone, row back to needs login). Screenshots in `.claude/temp/aap19/`:
  - `shot-overview-needs-login.png`, `shot-overview-stopped.png` (Codex stopped, the others needs login),
  - `shot-activity.png`, `shot-codex-card.png` (Codex home path + Open folder), `shot-logout-dialog.png`, `shot-after-logout.png`,
  - `dump-stopped.txt` (window text dump).
  The copy was quit with the `quit` file afterwards.
- Not exercised: the tray itself (menu text, tooltip, notification, amber icon) cannot be read by the dev hooks; it is covered by typecheck only.

### Deviations from the plan text

- All three agents advertise ACP `logout` (the plan assumed Codex was unknown); the fallbacks are for agents that do not. Codex's own `auth.json` is also removed after an ACP logout (belt and braces), only with the own home on.
- `acp-probe.mjs --logout` only reports the capability; the request is sent only with the extra flag `--do-logout` (so `--logout` is safe against a real login).
- "Images in" is shown in the capability chips only once the agent has started (it comes from `initialize`); the other chips are static per provider.
- The tray icon stays green while running; the amber warning icon appears only after a request hit a provider that needs login (not for a provider that merely needs login), and it clears when that provider is signed in.
- After an ACP logout an eager provider (Codex, Antigravity) is blocked (503 `provider_auth_required`) until the next login so a request cannot start a browser login by itself; Claude (on-demand) is asked again on the next request so a login made in a terminal is picked up.
- A streamed request that fails after the stream started is recorded with status 200 and the proxy error code (the SSE envelope itself still says `internal_error` for a login error, as before).
- Tests live in new files (`logout`, `activity`, `desktop-views`) plus controller tests; the renderer and the Electron main/tray code have no unit tests (typecheck and the live check only). The existing controller test now expects Codex `needs_login` (not `stopped`) before the first request, because the test data dir has no `auth.json`.

### Steps left for the user (live, real accounts)

1. Antigravity: **Log out** from the Overview (confirm the dialog), check that the row shows needs login and that Antigravity is logged out (`~/.gemini` login gone), then **Log in** again (browser flow) and send a request.
2. Claude: same (Log out, then Log in with the console window); check the account label disappears and comes back. With an `ANTHROPIC_API_KEY` set the row may stay signed in after Log out, by design.
3. Codex in its own home: **Log in** once (browser flow; the Codex row shows needs login until then), then **Log out** and check that `auth.json` in the `codex-home` folder is gone. Then the open AAP-12 check: a prompt in the isolated home with no skills or MCP visible, and image generation and web search working.
4. Look at the tray: tooltip (`N requests today, last X ago`), the per-provider lines, **Log in to X**, and the one-time "needs login" notification and amber icon after a request to a provider that needs login.
