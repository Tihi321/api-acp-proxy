# AAP-03: Desktop app (settings UI, tray, .exe), multi-provider routing, Google Antigravity

> Ticket folder: `.claude/tickets/AAP-03-desktop-app-settings-ui-tray-exe/` (plan, notes, changelog, handoff). Scratch files: `.claude/temp/`.

**Branch:** `AAP-03_desktop-app-antigravity` (from `origin/master` @ d697707)

## Context

Today `api-acp-proxy` is a headless Node/TS server that exposes an OpenAI-compatible API (`/v1/models`, `/v1/chat/completions`, `/v1/responses`, JSON + SSE). It is backed only by OpenAI Codex: it spawns `@agentclientprotocol/codex-acp` and talks to it over ACP (`src/acp.ts`). Configuration is env-vars only, the models are a hard-coded tuple (`src/config.ts` `MODEL_IDS`), and there is no UI or packaging. "AAP-02: Add build" only committed Yarn PnP output, and that output points at another user's Yarn cache (`knoxd`), so it is broken on this machine.

The user wants:
1. A settings UI to choose which backends are proxied.
2. A system tray to reach the settings.
3. A packaged Windows `.exe`.
4. Google Antigravity as a second backend, the way pi and DeepSeek harnesses offer it.

**Research findings on Antigravity:**
- **pi.** pi ≤ v0.70 had built-in Antigravity support. It did its own Google OAuth with Antigravity's public client id, then called the private `cloudcode-pa.googleapis.com/v1internal:streamGenerateContent`. pi v0.71 removed that support. Community extensions re-add it, and one of them (`pi-antigravity-acp-provider`) uses Google's official ACP server instead.
- **DeepSeek.** The reported DeepSeek-harness plugin uses OAuth token replay; its repo could not be verified.
- **Terms.** Google's Antigravity terms (clause 6) name third-party token replay as grounds for suspension, and there was a ban wave in February 2026.
- **Official route.** Google publishes `agy_acp_server.exe` in the ACP registry (`antigravity-acp` v1.3.0). It speaks the same protocol we already use for Codex.

**User decisions:**
- **Electron** app shell.
- **Official Antigravity ACP server**, not direct Cloud Code API calls.
- **Per-provider on/off toggles.** All enabled providers' models are exposed and routed by model id.

## Key decisions

- **npm only.** Delete `.pnp.cjs`, `.pnp.loader.mjs`, `.yarn/`, `yarn.lock`, and keep `package-lock.json`. Add `release/` to `.gitignore`.
- **Build with plain `tsc`, no bundler.**
  - `tsconfig.json` covers core plus the Electron main process (NodeNext ESM).
  - `src/electron/preload.cts` compiles to CommonJS, which a sandboxed preload requires.
  - `tsconfig.renderer.json` (DOM lib) covers the renderer.
  - `scripts/copy-static.mjs` copies the HTML, CSS and icons.
- **Settings UI in plain HTML, CSS and TS, no framework.**
- **Model ids are namespaced `<provider>/<rawId>`.**
  - Codex also exposes unprefixed ids (`exposeUnprefixed: true`), so `gpt-5.6-sol` keeps working.
  - Antigravity models are prefixed (`antigravity/...`).
  - On an unprefixed collision, the later provider's model is listed prefixed and a warning is logged.
- **Codex models stay static** (the `MODEL_IDS` contract). **Antigravity models are discovered at runtime** from the session `configOptions` and cached on disk.
- **Settings resolution order:** env var, then settings JSON, then defaults.
  - The CLI and the desktop app share one file: `%APPDATA%\api-acp-proxy\settings.json` (overridable with `PROXY_SETTINGS_FILE`).
  - In the UI, fields that an env var overrides are shown disabled.
- **Child agents under Electron** run as `process.execPath` with `ELECTRON_RUN_AS_NODE=1`, so no separate Node install is needed. Keep the `runAsNode` fuse enabled.
- **Saving settings does a full controller restart** (drain for 5 s, then restart the server and bridges).
- **Zip extraction uses `fflate`**, which is pure JS and works inside asar.

## Files

**New, core (no Electron imports)**
- `src/provider.ts`: shared types and errors:
  - `Provider`, `ProviderDescriptor`, `ProviderStatus`, `ModelInfo`, `RuntimeContext`, `LaunchSpec`
  - `ProviderNotInstalledError`, `ProviderAuthRequiredError`
- `src/acp-provider.ts`: generic `AcpProvider`, holding what `AcpBridge` does today:
  - spawn the agent, `initialize`, choose auth (eager or on-demand)
  - warm session pool; read the model option, flattening grouped options
  - mode selection driven by the descriptor; prompt and cancel
  - error mapping; `killProcessTree` on stop
- `src/providers/codex.ts`: the Codex descriptor.
  - Keeps the logic from `acp.ts:36-60` unchanged: `CODEX_CONFIG` / `INITIAL_AGENT_MODE`, the api-key vs chat-gpt auth choice, read-only mode required, and the `PROXY_ACP_COMMAND` / `PROXY_ACP_ARGS` overrides.
  - Resolves the entry point through `ctx.resolveUnpacked(...)` so it works inside asar.
- `src/providers/antigravity.ts`: the Antigravity descriptor.
  - **Preflight:** report `terms_required` or `not_installed`.
  - **Launch:** exe from `executablePath`, then `install.json`, then `PROXY_ANTIGRAVITY_COMMAND`. Pass through `GEMINI_API_KEY` and `GEMINI_HOME`; strip `ELECTRON_RUN_AS_NODE` and `NODE_OPTIONS`.
  - **Auth:** on demand.
  - **Read-only mode:** optional. If missing, warn once.
  - **Timing:** session timeout 180 s, 1 warm session.
  - **Errors:** "Requested entity was not found" → 403 `model_not_available`, and the model is marked unavailable.
- `src/providers/antigravity-installer.ts`: install the server from the ACP registry.
  - Fetch the registry JSON and map the platform (win32-x64 → `windows-x86_64`).
  - HTTPS only, from an allowlist of `cdn.agentclientprotocol.com` and `dl.google.com`.
  - Stream the download with progress and compute its SHA-256.
  - Extract with fflate, guarding against zip-slip, into `<dataDir>/agents/antigravity-acp/<ver>.partial`, then rename into place.
  - Write `install.json`. Run an optional Authenticode check (`Google LLC`) that warns rather than blocks.
- `src/router.ts`: `ProviderRouter`, which implements the server-facing backend interface.
  - `resolve(id)` maps an id to a provider and raw model.
  - `listModels({waitMs})` merges the cache with fresh results.
  - `hasModel`.
  - The model cache persists in `models-cache.json`.
- `src/settings.ts`:
  - zod schema with `version: 1` and defaults.
  - `SettingsStore`: atomic write; a corrupt file is renamed to `.bak-<ts>` and defaults are used.
  - `resolveConfig(settings, env)` returns `{config, providers, overridden}`.
  - `defaultSettingsPath()`, plus a `SecretCodec` hook.
- `src/controller.ts`: `ProxyController` (an EventEmitter) that owns the store, router and server.
  - Methods: `start`, `stop`, `applySettings`, `status`, `login`, `refreshModels`.
  - Turns `EADDRINUSE` / `EACCES` into a status instead of a crash.
- `src/process-tree.ts`: on win32, `taskkill /pid N /T /F` with `windowsHide`. On POSIX, kill the process group.
- `src/logger.ts`: console sink, rotating file sink (5 MB × 3), and a ring buffer for the UI.
- `src/shared/ipc.ts`: the IPC contract, types only.
- `scripts/acp-probe.mjs` (`npm run probe -- <cmd>`): prints `initialize` authMethods, session modes, configOptions and timings. Used for the Antigravity spike.
- `scripts/copy-static.mjs` and `scripts/verify-package.mjs`.

**New, Electron**
- `src/electron/main.ts`:
  - single-instance lock; `setPath("userData")`; `RuntimeContext` using `net.fetch`
  - `safeStorage` codec for secrets
  - `window-all-closed` does not quit; on quit, drain with `controller.stop()` capped at 5 s
  - IPC handlers that validate the sender URL
- `src/electron/tray.ts`:
  - icons for idle, running and error; the menu is rebuilt on each status event
  - menu: server and provider status lines, Start/Stop, Retry, Open settings, Open logs, Copy base URL (`http://host:port/v1`), Refresh models, Quit
  - if the port is in use: red icon, a "Port in use – Retry / Open settings" line, and a single notification
- `src/electron/settings-window.ts`: `contextIsolation`, `sandbox`, `nodeIntegration:false`, a CSP of `default-src 'self'`, and close hides the window to the tray.
- `src/electron/preload.cts`: `contextBridge` exposes `window.proxyApi`.
- `src/electron/hide-windows.cjs`: loaded with `--require` in the child. It defaults `windowsHide: true` on `spawn`/`execFile`, so `codex.exe` does not flash a console window.
- `src/renderer/settings.{html,css,ts}`:
  - **Server section:** host, port, API key (with a generate button), timeouts, max body size, models wait, launch at login.
  - **One card per provider:** enable toggle, state badge, model list with Refresh, auth-method dropdown filled from discovered methods, Login.
  - **Extra on the Antigravity card:** exe path with Browse, "Download from registry" with a progress bar, installed version and SHA-256, `GEMINI_API_KEY`, `GEMINI_HOME`.
  - **Terms modal:** shown the first time Antigravity is enabled. It links the Google terms and warns about possible suspension, then saves `termsAcknowledgedAt`.
- `assets/tray-{idle,running,error}.png`, `build/icon.ico`, `electron-builder.yml`, `tsconfig.renderer.json`.

**Modified**
- `src/acp.ts`:
  - Keeps the `GenerationResult`, `GenerationCallbacks` and `AcpUnavailableError` exports.
  - `AcpBridge(config)` becomes a thin compatibility subclass of `AcpProvider` using the Codex descriptor, so `tests/acp.test.ts` keeps working.
  - `AcpLike` gains optional `listModels?` and `hasModel?`.
- `src/config.ts`: `ModelId` widens to `string`. `MODEL_IDS` stays exported as the Codex default list. `loadConfig(env)` delegates to `resolveConfig(defaultSettings(), env)`.
- `src/api.ts`: `normalizeChat` and `normalizeResponses` take an optional `isKnownModel` argument whose default is a `MODEL_IDS` check.
- `src/server.ts`:
  - `/v1/models` uses `backend.listModels?.()` and falls back to `MODEL_IDS`, with `owned_by` set per provider.
  - Validation uses `backend.hasModel`.
  - Responses echo the model id the client sent.
- `src/index.ts`: the headless CLI runs a `ProxyController` with a console logger and handles SIGINT and SIGTERM. The startup log line stays the same.
- `tests/fixtures/fake-acp.mjs`: new env switches, with defaults kept compatible:
  - `FAKE_ACP_AUTH_METHODS`, `FAKE_ACP_REQUIRE_AUTH`, `FAKE_ACP_MODELS`, `FAKE_ACP_NO_READONLY`
  - `FAKE_ACP_SESSION_DELAY_MS`, `FAKE_ACP_ENTITY_NOT_FOUND`, `FAKE_ACP_ECHO`, `FAKE_ACP_GRANDCHILD`
- `package.json`:
  - set `main: dist/electron/main.js`
  - add the dev dependencies `electron` and `electron-builder`, and the dependency `fflate`
  - scripts: `app:dev`, `dist`, `probe`, `antigravity:install`
- `.gitignore` and `README.md`:
  - desktop app section, provider and model-id scheme, settings precedence
  - Antigravity setup plus the terms note, and the removal of Yarn
- `examples/README.md`: document that `PROXY_MODEL` may be prefixed.

New env vars:
- `PROXY_SETTINGS_FILE`, `PROXY_MODELS_WAIT_MS`
- `PROXY_CODEX_ENABLED`, `PROXY_ANTIGRAVITY_ENABLED`
- `PROXY_ANTIGRAVITY_COMMAND`, `PROXY_ANTIGRAVITY_ACCEPT_TERMS`

## Phases (each verified independently)

0. **Housekeeping.** Remove the PnP files. Then run `npm ci && npm run typecheck && npm test && npm run build`, which should report 16 passing tests and 1 skipped.
   - **Status: DONE.** PnP files, `.yarn/`, `yarn.lock` removed; `release/` and `.claude/temp/` added to `.gitignore`. Baseline after `npm ci`: typecheck clean, 16 passed / 1 skipped, build clean.
1. **Generic ACP provider and Codex descriptor (no behaviour change).** Make the logger, process-tree, provider and acp-provider changes, add the Codex descriptor, and extend fake-acp.
   - New `tests/acp-provider.test.ts` covers:
     - session pool reuse and discovery of grouped models
     - a missing read-only mode is tolerated when not required
     - `auth_required` (-32000) leads to `needs_login`
     - API-key auth is chosen and retried
     - on win32, the grandchild process is dead after `close()`
   - The existing suites must still pass unchanged.
   - **Status: DONE.** New `logger.ts`, `process-tree.ts`, `provider.ts`, `acp-provider.ts`, `providers/codex.ts`; `acp.ts` is now a compat subclass. `tests/acp-provider.test.ts`: 7 passed. Existing suites unmodified and passing. Deviations: `AcpUnavailableError` and `Generation*` types moved to `provider.ts` (re-exported by `acp.ts`) to avoid an import cycle; added `ProviderTermsRequiredError`; `AcpUnavailableError` gained an optional `code` that the server uses in the 503 body; extra provider status listener (`onStatus`) and descriptor hooks (`mapError`, `preflight`, `chooseAuth`). Warm pool is per descriptor (`warmSessions`, Codex uses 0 = unchanged behaviour). Children are spawned `detached` on POSIX so the process group can be killed.
2. **Router and dynamic models.** Add `router.ts` and the server and api changes.
   - `tests/router.test.ts` covers:
     - prefixed and unprefixed routing
     - collisions, and disabled providers excluded
     - unknown id → 404 "does not exist"
     - a slow provider is omitted after `waitMs`
     - `owned_by` set per provider
     - an OpenAI SDK test against two fake providers
   - **Status: DONE.** `src/router.ts`; `server.ts`/`api.ts` take `hasModel`/`isKnownModel`. `tests/router.test.ts`: 7 passed. Deviation: a provider that has not discovered any models yet accepts any `<provider>/<id>` (the agent decides), so the first request does not 404 before discovery completes.
3. **Settings and controller; CLI on the controller.**
   - `tests/settings.test.ts`: defaults written when the file is missing; a corrupt file is backed up; env vars override and are listed in `overridden`; saves are atomic.
   - `tests/controller.test.ts`: when the port is already taken, the status is `EADDRINUSE` and nothing throws; `applySettings` moves the server to a new port.
   - **Status: DONE.** `src/settings.ts`, `src/controller.ts`, `src/index.ts`, `config.ts` delegating to the resolver. `tests/settings.test.ts`: 10 passed, `tests/controller.test.ts`: 8 passed. Full run: 48 passed / 1 skipped (7 files), typecheck and build clean. `npm run dev` with `PROXY_SETTINGS_FILE` in `.claude/temp/` created the settings file and served `/healthz` and `/v1/models`. Deviations: `ProviderRegistration {id, displayName, create(args)}` is the factory API (`controller.registerProvider` or `ControllerOptions.registry`); `ProxyConfig` gained optional `modelsWaitMs`; codex `acpCommand`/`acpArgs` are also stored under `providers.codex`; startup log line is emitted by the controller.
4. **Antigravity provider (core).**
   - **Spike first.** Install `agy_acp_server.exe` manually and run `npm run probe`. Record in the ticket: the authMethods, whether login is interactive, the modes, the shape of configOptions, session timing, `session/delete` support, and whether the server spawns child processes. Then tune the auth `choose()` heuristics:
     1. an explicit `authMethodId`
     2. with an API key set: an env_var method, or one whose name matches /api key/
     3. otherwise a method matching /oauth|google|login/
     4. otherwise the first method
   - Then implement the descriptor and the installer.
   - `tests/antigravity.test.ts` covers:
     - auth selection
     - no read-only mode
     - not-found → 403
     - `terms_required` / `not_installed`
     - the installer against a local HTTP server serving an fflate zip, rejecting zip-slip and non-allowlisted hosts
     - registry parsing against a fixture
   - **Status: DONE (core).** Spike results are in `antigravity-spike.md` and override the guesses above (no read-only mode, API-key/OAuth ids, login URL on stderr, no session/delete, process tree, on-disk sessions).
     - **New:** `src/providers/antigravity.ts`, `src/providers/antigravity-installer.ts`, `scripts/acp-probe.mjs`, `scripts/antigravity-install.mjs`, `tests/antigravity.test.ts`, `tests/antigravity-installer.test.ts`, `tests/acp-provider-login.test.ts`, `tests/process-tree.test.ts`.
     - **Changed:** `acp-provider.ts` (abort fix, `modeCandidates`, `loginUrlPattern`, auth timeouts, `beforeStart`/`afterStop`/`onSessionCreated`/`onLoginSuccess` hooks, `agentVersion`), `provider.ts`, `process-tree.ts` (`sweepOrphans`), `controller.ts` (default registry has Antigravity; `ProviderFactoryArgs.saveSettings`), `settings.ts` (`purgeSessions`, `lastAuthMethodId`), `index.ts` (logs login URLs), `tests/fixtures/fake-acp.mjs` (`FAKE_ACP_AGY`, `FAKE_ACP_AUTH_DELAY_MS`, `FAKE_ACP_AUTH_URL`, `FAKE_ACP_LOG`).
     - **Verification:** `npm run typecheck`, `npm run build` clean; `npm test` 95 passed / 1 skipped, looped 5x with no flake; the formerly flaky `acp.test.ts` "cancels an abandoned request" also passed 8 parallel runs.
     - **Live (real `agy_acp_server.exe`, cached `oauth-personal`, headless controller):** `/v1/models` lists `antigravity/gemini-3.8-flash-{high,medium,low}`; chat completion `antigravity/gemini-3.8-flash-low` returns `pong` non-streaming (7.6 s) and streaming (5.3 s, `[DONE]`); after `controller.stop()` no `agy_acp_server.exe`/`localharness_external.exe` remain; a hard-killed headless node left 2 orphans and the next start's sweep killed them; the proxy-created conversation files were purged. Real installer into `.claude/temp/agy-install-test`: registry now serves 1.4.0 (119.8 MB), sha256 recorded, Authenticode `Valid` / `CN=Google LLC`.
     - **Deviations:**
       - The registry now lists 1.4.0 (spike used 1.3.0); registry keys are `distribution.binary["windows-x86_64"|"windows-aarch64"] = {archive, cmd, args?}`.
       - The login URL pattern is anchored to the `Open the following link to authenticate...` line. The spike's "URL printed even with cached tokens" was most likely the unrelated `accounts.google.com/AccountChooser?Email=...` link inside a `loadCodeAssist` log line, which a loose pattern matches and which leaks the email. With cached tokens the real authenticate line was not observed.
       - The server also writes `<id>.meta` next to `<id>.db*`; purge removes every `conversations/<id>.*` plus `brain/<id>` (with EBUSY retries, because the sqlite files stay locked for a moment after the tree dies; ids that stay locked remain recorded for the next start).
       - The orphan sweep only kills images named `agy_acp_server.exe`/`localharness_external.exe`/the configured exe name, under the install dir or the exe dir, whose parent process no longer exists (so a second live instance is not killed).
       - Windows PowerShell 5.1 fails to load its modules when `PSModulePath` is inherited from PowerShell 7, so the Authenticode and process-list calls drop that variable.
       - Eager authenticate that times out or is rejected no longer kills the agent: the provider goes `needs_login` and keeps the process and pending request so `login()` can adopt it; requests get `auth_required` until a login succeeds.
       - `tests/controller.test.ts` and `tests/settings.test.ts` each had one assertion adjusted (default registry now also lists `antigravity`; the antigravity settings default now includes `purgeSessions: true`).
       - A headless node killed hard (no SIGTERM handler on Windows) cannot stop its agent tree; the next start sweeps it.
5. **Electron shell.** Run with `npm run app:dev`. Covers the tray, the settings window, preload/IPC, the terms modal, the download/install flow, and Login buttons.
   - **Status: DONE (automated parts); manual UI QA pending.**
     - **Built:** `src/electron/{main,tray,settings-window,antigravity}.ts`, `preload.cts`, `hide-windows.cjs`; `src/renderer/settings.{html,css,ts}`; `src/shared/ipc.ts`; `tsconfig.renderer.json`; `scripts/{copy-static,make-icons}.mjs`; icons in `assets/` and `build/icon.ico`.
     - **Verified (`npm run app:dev`, test settings file):** main process started with no exceptions; `/healthz` and `/v1/models` respond; CSP page loads and `proxyApi` is exposed; save restarts the server and the API key is stored with an `enc:` prefix (safeStorage); terms modal Cancel and "I understand" both work; env-overridden fields are disabled; clean quit.
     - **Deviations:** dev-only `ACP_PROXY_DEV_DIR` hook (`quit`/`dump` in all builds; `shot`/`eval.js` unpackaged only); `PROXY_SETTINGS_FILE` also relocates `userData` and the logs; the settings window shows at startup unless launched with `--hidden` or via launch-at-login.
     - **Pending manual UI QA (NOT RUN):** tray visuals, states, clicks and menu; EADDRINUSE notification and Retry; light theme; close-to-tray and a second launch re-showing the window; Codex and Antigravity Login flows in the UI; download progress against the real registry; Browse dialog; launch at login; NSIS install/uninstall; portable exe from a temp folder; visual check that no console windows flash.
6. **Packaging** with `npm run dist` (electron-builder, NSIS plus portable x64).
   - `asarUnpack` covers `node_modules/@agentclientprotocol/**`, `node_modules/@openai/**` (the native `codex.exe`), codex-acp's runtime dependencies, and `hide-windows.cjs`.
   - Set `npmRebuild: false`.
   - `scripts/verify-package.mjs` runs codex-acp from `release/win-unpacked` with `ELECTRON_RUN_AS_NODE=1` and does an ACP `initialize` handshake. This catches gaps in the unpack list.
   - **Status: DONE.**
     - **Built:** `electron-builder.config.cjs` (computes `asarUnpack` from the codex-acp dependency closure, 20 packages), `scripts/verify-package.mjs`.
     - **Verified:** `npm run dist` exit 0, `verify-package` passed: codex-acp 1.12.0 initialize handshake via `ELECTRON_RUN_AS_NODE` (authMethods `api-key`, `chat-gpt`); `codex.exe` resolves from `app.asar.unpacked` (codex-cli 0.154.0). Packaged `win-unpacked` exe served a real `gpt-5.6-luna` "pong" and quit cleanly.
     - **Deviation:** a `.cjs` builder config instead of `electron-builder.yml` (the unpack list is computed).
7. **Docs and CI.** Update the README. Add a GitHub Actions `windows-latest` job (ci, typecheck, test, build) that also runs `dist` and uploads artifacts on tags.
   - **Status: DONE.**
     - `README.md` rewritten (providers, model-id scheme, desktop app, CLI, settings precedence and env table checked against `src/settings.ts`, Antigravity setup, terms/risk, development, npm only); `examples/README.md` documents prefixed `PROXY_MODEL`.
     - `.github/workflows/ci.yml`: push and pull_request on `windows-latest`, Node 22, npm cache: `npm ci`, `typecheck`, `test`, `build`. On `v*` tags also `npm run dist` and `actions/upload-artifact@v4` of `release/*.exe`. Workflow not executed (no GitHub run available locally).
     - **Network check:** no test touches the network or a real agy exe. Every test uses loopback servers or fake ACP fixtures; the https URLs in tests are strings (registry fixtures, allowlist rejection); `live.smoke.test.ts` is skipped without `RUN_LIVE_SMOKE`.

## Verification (end-to-end)

- `npm run typecheck && npm test` passes, covering the existing suites and the new acp-provider, router, settings, controller and antigravity suites.
- **Headless:** `npm run dev`.
  - With no settings file, one is created and `PROXY_PORT` is honoured.
  - `npm run example:basic` and `example:streaming` work against Codex.
- **Antigravity, headless:**
  - `npm run antigravity:install`, then set `PROXY_ANTIGRAVITY_ENABLED=1 PROXY_ANTIGRAVITY_ACCEPT_TERMS=1`.
  - `/v1/models` lists `antigravity/<id>`.
  - `PROXY_MODEL=antigravity/<id> npm run example:streaming` streams.
- **Desktop (`npm run app:dev`):**
  - The tray icon appears and Copy base URL works.
  - With the port already held, the icon turns red and shows Retry, with no crash.
  - Saving settings restarts the server.
  - The Codex Login button works.
  - Download from registry installs into userData, the terms modal appears, and Antigravity Login works.
  - The settings window closes to the tray.
- **On quit:** `tasklist` shows no leftover `codex.exe`, `node` or `agy_acp_server.exe`.
- **Packaged:**
  - `npm run dist` passes `verify-package.mjs`.
  - Install the NSIS build, make a first-run Codex request, then uninstall.
  - The portable exe runs from a temp folder.
  - No console windows flash during requests.
  - SmartScreen will warn because the build is unsigned.

### Final verification evidence (2026-10-14, final code)

- `npm run typecheck`: clean. `npm test` looped 3x: each run 11 files passed (1 skipped), 95 tests passed / 1 skipped; no flake.
- `npm run dist`: exit 0 (rebuilt after the last core change); `verify-package` passed (codex-acp 1.12.0 handshake, authMethods `api-key`, `chat-gpt`; codex-cli 0.154.0 from `app.asar.unpacked`). Artifacts in `release/`: `ACP-Proxy-Setup-0.1.0-x64.exe` 205,970,847 bytes, `ACP-Proxy-Portable-0.1.0-x64.exe` 205,751,282 bytes (plus `.blockmap`, `latest.yml`, `win-unpacked/`).
- Packaged `release/win-unpacked/ACP Proxy.exe --hidden`, port 18795, Codex and Antigravity enabled, terms acknowledged, `oauth-personal` (cached tokens, no interactive login triggered), dev hook for quit:
  - With the real `agy-acp` 1.3.0 exe: `/v1/models` listed `gpt-5.6-{sol,terra,luna}`, `codex/...` twins and `antigravity/gemini-3.8-flash-{high,medium,low}`; non-streaming `antigravity/gemini-3.8-flash-low` returned "pong"; streaming `gpt-5.6-luna` returned "pong" and `[DONE]`.
  - With the installed 1.4.0 exe: `/v1/models` listed a single `antigravity/gemini-3.8-flash` (the `-low` id returns 404 `model_not_found` there); non-streaming `antigravity/gemini-3.8-flash` returned "pong". Model ids are version/plan dependent, as designed.
  - `touch dev/quit` quit cleanly each time; `tasklist` showed no `ACP Proxy.exe`, `agy_acp_server.exe`, `localharness_external.exe` or `codex.exe` left (an unrelated system service `codex-windows-sandbox-ser`, PID 8416, predates the run); no project processes to kill. The Antigravity session purge logged the deleted sessions.
- Observation: Codex streaming output includes a leading content chunk "Warning: Skill descriptions were shortened ..." emitted by codex-acp as an agent message. Not addressed here.
- **Manual QA not run:** see the Phase 5 list; plus the Verification items above that need a human (tray, EADDRINUSE red icon/Retry, Codex/Antigravity Login in the UI, download from registry in the UI, NSIS install/uninstall, portable exe from a temp folder, console-flash check, SmartScreen behaviour).

## Risks

- **Antigravity ACP server unknowns.** Auth ids, read-only mode and `session/delete` support are unknown until the Phase 4 spike. The `authMethodId` setting gives manual control. If there is no read-only mode, safety relies on:
  - permissions being auto-cancelled
  - no fs or terminal client capabilities being offered
  - an empty temp cwd
  - the prompt preamble
- **Terms risk remains** even through the official server (it could count as "powering a non-Antigravity product"). Antigravity is off by default, behind a one-time warning, and we add no workarounds.
- **Console windows flashing** from `codex.exe` under a GUI parent. Mitigated by `hide-windows.cjs`; the fallback is a tiny console-subsystem launcher.
- **Orphaned children after a hard crash.** Record PIDs in `userData/pids.json` and reap them on the next start, after checking each image name.
- **Cold Antigravity sessions take about 2 minutes.** Mitigated by the warm pool and the persisted model cache. Request `timeoutMs` must stay above `sessionTimeoutMs`.
- **codex-acp is pinned at ^1.12; the registry has 2.2.2.** Upgrading is a separate ticket. Check codex-acp's `engines` field against Electron's bundled Node.
- **Unsigned build** triggers SmartScreen and possible antivirus heuristics. Code signing is out of scope.
