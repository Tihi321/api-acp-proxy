# Changelog: AAP-03

## 2026-10-14: AAP-03, desktop app + multi-provider routing + Google Antigravity

**Outcome:**
- The proxy is now a Windows desktop app: tray icon, settings window, NSIS installer and portable `.exe`.
- It routes OpenAI-compatible requests to Codex and/or Google Antigravity. Antigravity runs through Google's official ACP server.
- Each provider can be enabled or disabled separately.
- Headless CLI mode still works.

**Repository:** `api-acp-proxy`
**Branch:** `AAP-03_desktop-app-antigravity` (from `origin/master` @ d697707)
**Status:** uncommitted.

### What changed

**Housekeeping**
- Removed the broken Yarn PnP files (`.pnp.cjs`, `.pnp.loader.mjs`, `.yarn/`, `yarn.lock`). They pointed at another user's cache. The project is npm only now.
- `.gitignore` now ignores `release/` and `.claude/temp/`.

**Core**
- `src/provider.ts`: shared provider types, errors and the `RuntimeContext`.
- `src/acp-provider.ts`: a generic ACP provider. It replaces the Codex-only bridge logic and handles:
  - spawning the agent, and auth that is eager or on demand, with a timeout
  - a user login flow: the login URL is captured from stderr, and the browser opens only if the login is still pending after 3 s
  - a warm session pool and model discovery
  - mode selection driven by each provider's descriptor
  - abort handling: an early abort now returns `cancelled`, which fixes a flaky test
  - error mapping and killing the whole process tree
- `src/acp.ts`: `AcpBridge` is now a thin compatibility subclass.
- `src/providers/codex.ts`: the Codex descriptor. Behaviour is unchanged: forced read-only mode, `CODEX_CONFIG` overrides, auth choice, and the `PROXY_ACP_*` overrides.
- `src/router.ts`: routes `<provider>/<id>` model ids. Codex also exposes unprefixed ids, and on a name collision the later provider's model is listed prefixed. The model cache persists to `models-cache.json`.
- `src/server.ts`, `src/api.ts`, `src/config.ts`:
  - `/v1/models` is built dynamically, with `owned_by` set per provider.
  - Model validation goes through the router.
  - `ModelId` is now `string`, and `MODEL_IDS` is kept as the Codex list.
- `src/settings.ts`: zod-validated settings file at `%APPDATA%\api-acp-proxy\settings.json`. Precedence is env vars, then the file, then defaults.
  - Writes are atomic, and a corrupt file is backed up.
  - Secrets go through an optional encoding hook.
  - New env vars: `PROXY_SETTINGS_FILE`, `PROXY_MODELS_WAIT_MS`, `PROXY_CODEX_ENABLED`, `PROXY_ANTIGRAVITY_ENABLED`, `PROXY_ANTIGRAVITY_COMMAND`, `PROXY_ANTIGRAVITY_ACCEPT_TERMS`.
- `src/controller.ts`: `ProxyController` owns the settings, router and HTTP server.
  - Lifecycle: start, stop, restart on apply with a 5 s drain, login, model refresh.
  - A port that is already in use shows up as a status, not a crash.
  - Providers are created from a registry of factories.
- `src/logger.ts`: rotating file log and a ring buffer.
- `src/process-tree.ts`: `taskkill /T` on Windows and process-group kill on POSIX, plus a sweep for orphaned agent processes.
- `src/index.ts`: the headless CLI now runs on the controller.

**Antigravity**
- `src/providers/antigravity.ts`: the provider settings and behaviour:
  - It only starts once the terms are acknowledged and the server exe is found.
  - Auth order: an explicit method, then the API key, then the last method used, then the server's own `settings.json`.
  - Uses `default` mode, so every tool permission is denied.
  - "Requested entity was not found" maps to 403 `model_not_available`.
  - Sessions the proxy creates are recorded and their files purged, because the server has no `session/delete`.
  - Orphaned server processes are swept on start.
- `src/providers/antigravity-installer.ts`: installs the server from the ACP registry.
  - HTTPS from allowlisted hosts only.
  - Streams the download and computes SHA-256.
  - Extracts with fflate and rejects zip entries that escape the target folder.
  - Checks the Authenticode signature for `CN=Google LLC`.
  - Writes `install.json`.
- `scripts/acp-probe.mjs` and `scripts/antigravity-install.mjs`.

**Electron**
- `src/electron/main.ts`:
  - single-instance lock and a shared settings path
  - `safeStorage` encryption for secrets
  - child agents run as `ELECTRON_RUN_AS_NODE` with `hide-windows.cjs` loaded
  - `net.fetch` for downloads, `shell.openExternal` for login links
  - IPC that checks the sender, a 5 s drain on quit, launch-at-login
  - a dev-only `ACP_PROXY_DEV_DIR` hook
- `src/electron/tray.ts`: idle, running and error icons; status lines; Start/Stop and Retry; settings, copy URL, refresh models, open logs, quit. Shows one notification when the port is in use.
- `src/electron/settings-window.ts` and `preload.cts`: the settings window is sandboxed with context isolation and a CSP, and closing it hides it to the tray. Pages can only open allowlisted external URLs.
- `src/renderer/settings.{html,css,ts}`:
  - **Server card:** fields that an env var overrides are disabled.
  - **Provider cards:** enable toggle, state, auth method, Login, login link, models.
  - **Antigravity card:** exe Browse, download with progress, install info, API key and `GEMINI_HOME`, session purge, and the terms modal.
- `src/shared/ipc.ts`: the IPC type contract.
- `tsconfig.json` (excludes the renderer) and `tsconfig.renderer.json`.

**Packaging and CI**
- `electron-builder.config.cjs`: NSIS and portable x64 targets. `asarUnpack` is computed from the codex-acp dependency closure.
- `scripts/{copy-static,make-icons,verify-package}.mjs`, plus `assets/` and `build/icon.ico`.
- `package.json`:
  - `main` set
  - new scripts: `app:dev`, `dist`, `dist:dir`, `verify:package`, `icons`, `probe`, `antigravity:install`
  - new packages: `fflate`, `electron@44.7.2`, `electron-builder@26.15.3`
- `.github/workflows/ci.yml`: Windows job (typecheck, test, build). On `v*` tags it also builds the `.exe` files and uploads them.

**Docs**
- `README.md` rewritten: desktop app, CLI, model ids, settings and env table, Antigravity setup, terms and risk.
- `examples/README.md`: covers prefixed models.

**Tests**
- New suites: `acp-provider`, `acp-provider-login`, `router`, `settings`, `controller`, `antigravity`, `antigravity-installer`, `process-tree`.
- `fake-acp.mjs` gained new switches. Its defaults are unchanged.
- The `proxy`, `acp` and `examples` suites are unchanged. In the `controller` and `settings` suites, one assertion each was adjusted for the new registry and schema defaults.

### Deviations from the plan
- **Spike results replaced plan assumptions:**
  - The server has no read-only mode, so `default` mode is used.
  - `session/delete` returns -32601, so sessions are purged from disk instead.
  - The server never opens a browser, so the proxy captures the login URL.
  - The real auth method ids are `oauth-personal`, `oauth-business`, `gemini-api-key`, `agent-platform`.
  - Session setup takes about 2.7 s, not about 2 min.
  - The server is a PyInstaller bootloader that starts a child server and `localharness_external.exe`, so a plain kill left orphans.
- Antigravity uses an eager auth call with a 10 s timeout instead of on-demand auth, because cached tokens answer in under 1 s.
- The packaging config is `electron-builder.config.cjs`, not a `.yml`, because the unpack list is computed.
- The login URL pattern is anchored. A looser pattern matched an AccountChooser link that contained the user's email.

### Verification
- `npm run typecheck`: clean.
- `npm test`: 95 passed / 1 skipped, repeated on 5+ loops by several runs, no flakes.
- `npm run build` passes, and `npm run dist` passes with exit 0. `verify-package` passed: the codex-acp handshake works through `ELECTRON_RUN_AS_NODE`, and `codex.exe` resolves from `app.asar.unpacked`.
- Artifacts:
  - `release/ACP-Proxy-Setup-0.1.0-x64.exe` (206 MB)
  - `release/ACP-Proxy-Portable-0.1.0-x64.exe` (206 MB)
- Live Antigravity spike: real `oauth-personal` login, session/model/mode discovery, and a "pong" prompt.
- Headless live run (Antigravity): `/v1/models` lists `antigravity/gemini-3.8-flash-*`, both the plain and streaming "pong" requests work, and stopping leaves no agent processes.
- Packaged smoke (`win-unpacked` exe):
  - Codex streaming `gpt-5.6-luna` returned "pong".
  - Antigravity `gemini-3.8-flash-low` returned "pong" with server 1.3.0. Server 1.4.0 exposes only `gemini-3.8-flash`, which also returned "pong".
  - Quitting left no `ACP Proxy`, `agy_acp_server`, `localharness_external` or `codex` processes.
- Real installer run (registry now at 1.4.0, 119.8 MB): SHA-256 recorded and signature Valid (`CN=Google LLC`).
- `npm run app:dev` run against test settings: settings page and IPC work, save restarts the server, the API key is stored encrypted, the terms modal works, env-overridden fields are disabled, and quit is clean.

**Not run (manual QA required):**
- Tray: icon visuals and states, clicks and menu; the port-in-use notification and Retry.
- Settings window: light theme; closing to the tray, and a second launch showing the window again.
- Login flows from the UI (Codex and Antigravity).
- Download progress in the UI, and the Browse dialog.
- Launch-at-login; NSIS install and uninstall; running the portable exe from a temp folder.
- Visual check that no console windows flash; SmartScreen behaviour.
- The GitHub Actions workflow has not been run.

### Follow-ups and known limitations
- The Codex output can begin with a codex-acp agent message: "Warning: Skill descriptions were shortened…". It comes from the user's `~/.codex` skills and existed before this change. Consider filtering it or turning skills off through `CODEX_CONFIG`.
- Antigravity model ids change with the server version (1.3.0 has `-high/-medium/-low`, 1.4.0 has `gemini-3.8-flash`). Clients should read `/v1/models`.
- The build is unsigned, so expect SmartScreen and antivirus warnings.
- The CLI has no secret codec. An API key that the desktop app saved encrypted is dropped, with a warning, when the CLI reads the file.
- codex-acp is pinned at ^1.12 while the registry has 2.x. Upgrading is a separate ticket.
- Antigravity terms risk remains even through the official server. Antigravity is off by default, with a one-time warning.
