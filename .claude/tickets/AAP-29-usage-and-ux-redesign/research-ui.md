# AAP-29 research: settings window, usage data flow, persistence, tests

## Question
Map the settings window (UI, IPC, build, theming), the usage/activity data flow and persistence patterns, the headless path, tests and redesign risks, so a planner can write (1) persisted per-provider usage totals and (2) a settings window UX redesign.

## Answer
- The window is one static page (`settings.html`, 239 lines) plus one ES-module script (`settings.ts`, 559 lines) and one CSS file; no framework, no bundler (plain `tsc` + file copy). State arrives by full-`StateView` push (`proxy:state`, 80 ms debounce) and an activity-list push (`proxy:activity`, 150 ms debounce). No polling.
- Every request already ends in exactly one `ActivityLog.record(ActivityEntry)` carrying `provider`, `inputTokens`, `outputTokens`, `time`. That is the single hook for persisted totals (HTTP: `server.ts:356` `track`; MCP: `mcp-endpoint.ts:601` `record`). `ActivityLog` is in-memory, a 100-entry ring, and `clear()` wipes it, so totals need their own store.
- Streaming requests DO get token counts (same `traceUsage` after the stream completes). Counts are the agent's own, else a chars/4 estimate; the entry does not say which.
- Persistence pattern to reuse: atomic tmp + rename JSON with `{version:1,...}`, e.g. `router.ts:68-79` (models-cache.json in `dataDir`); `SettingsStore.save` (`settings.ts:186-205`) adds a serialized queue and a Windows EPERM/EBUSY rename retry.
- Headless CLI (`index.ts`) has no UI; it uses the same `ProxyController`, so recording usage inside the controller covers it. No usage HTTP endpoint exists; `/healthz` is the only status route.
- Tests: vitest, 46 files passed / 2 skipped, 736 tests passed / 2 skipped. Command: `fnm exec --using default node node_modules/vitest/vitest.mjs run` (`npx` is not on PATH). No DOM/renderer tests; only pure helpers are tested.

## Path through the code

### 1. Settings window

Files (confirmed): `src/renderer/settings.html` 239 lines, `settings.ts` 559, `settings.css` 78 (dense rules), `mcp-command.ts` 8, `src/electron/settings-window.ts` 78, `preload.cts` 34, `src/shared/ipc.ts` 128, `main.ts` 297, `tray.ts` 134.

**Layout (settings.html)**: sticky header `.top` (title, `#top-badge` server badge, `#top-url`) lines 11-17; `<main>` max-width 860 px, single column of `.card` sections; footer; two `<dialog>`s.
- `#card-overview` (20-43): API address + Copy + "Open playground" (`ov-copy`, `ov-playground`); MCP url + "Copy command" (`ov-mcp-url`, `ov-mcp-copy`); `#ov-providers` list rendered by JS (per provider: name, badge, version, Log in / Log out, sign-in line, feature chips, model count, login-home line); `#ov-msg`; read-only MCP servers list (`#ov-mcp`, `#ov-mcp-count`) + "Open settings.json" (`open-settings-file`).
- `#card-activity` (45-58) "Recent requests": table Time, Request, Model, Uses, Took, Result, Tokens (`#act-body`), `#act-summary`, Clear `act-clear`, empty text `#act-empty`. Shows the newest 20 (`settings.ts:264`) of the 50 pushed (`main.ts:145`). Natural neighbour for a usage card.
- `#card-server` (60-93): badge `server-badge`, url + `copy-url`, `server-error`; fields `server.host`, `server.port`, `server.apiKey` (password + `server-key-show` + `server-key-gen`), `server.timeoutMs`, `server.maxBodyBytes`, `server.modelsWaitMs`, `server.toolResultTimeoutMs`, `server.maxConcurrent`, `server.maxQueue`; checkboxes `server.launchAtLogin`, `server.listBareAliases`, `server.reuseSessions`; buttons `server-save` ("Save and restart"), `server-toggle` (Start/Stop/Retry); `server-msg`, `server-general-error`. `server.workRoot` is in the schema and `SettingsView` but has no control.
- `#card-codex` (95-120): badge, version, `providers.codex.enabled`, `providers.codex.maxConcurrent`, error line, select `providers.codex.authMethodId` + Log in, login-link box (url + Copy link), `providers.codex.isolatedHome`, Codex home path + "Open folder" (`open-codex-home`), Models chips + Refresh, Save and restart, msg, general-error.
- `#card-antigravity` (122-167): as Codex (no isolatedHome) plus fieldset "Agent": `providers.antigravity.executablePath` + Browse (`browse-exe`), "Download from registry" (`install-agy`), `<progress id=install-progress>`, `install-text`, `install-info`; fieldset "Credentials and data": `providers.antigravity.apiKey` (+ `agy-key-show`), `geminiHome`, `purgeSessions`.
- `#card-claude` (169-209): as Codex plus terms blurb, `data-role=account` ("Signed in as ..."), fieldset "Credentials and data": `providers.claude.apiKey` (+ `claude-key-show`), `oauthToken` (+ `claude-token-show`), `configDir`, `executablePath` + Browse (`browse-claude-exe`).
- Footer (212-216): settings path, secrets-encrypted note, "Open logs folder" (`open-logs`).
- Dialogs: `#logout-dialog` (218-225), `#terms-dialog` (227-235).
- Only in settings.json (no UI): `mcpServers` (read-only list), claude `authPolicy`, `acpCommand`/`acpArgs`, `lastAuthMethodId`, `server.workRoot`.

**Renderer logic (settings.ts)**: `fields: FieldSpec[]` table (32-63) drives load/collect: field id == dotted settings path; kind text|number|bool|select; scope server|codex|antigravity|claude; optional. Hooks are by id (`el(...)`), `data-role` inside a card (`role()`), `data-note-for`, `data-error-for`. Per-scope `dirty` flags (92), set on any input/change (462-463), stop state pushes overwriting an edited card (`renderFields` 131, `renderAuth` 143). `render()` (295) redraws everything from a `StateView`. `collectPatch` (371) builds a `SettingsPatchView` (empty optional -> `null` clears; apiKey-like values are not trimmed (384); env-overridden fields are skipped (375)). `saveScope` (406) -> `api.saveSettings`; ok -> "Saved. The server was restarted."; errors map to `data-error-for` by path. Terms gating: enabling antigravity/claude opens the terms dialog (`ensureTerms` 428; on checkbox change 521-526; again in `saveScope` 411-414).

**IPC (ipc.ts `ProxyApi` 102-124, preload.cts 140-161, main.ts handlers 186-255)**. All are `ipcRenderer.invoke` except pushes. Every handler rejects senders whose frame URL is not the settings page (`main.ts:176-182`).

| Channel | Dir | Payload -> result |
|---|---|---|
| `proxy:getState` | R->M | -> `StateView` |
| `proxy:saveSettings` | R->M | `SettingsPatchView` -> `SaveResult` (zod issues -> `FieldError[]`); also re-applies login item |
| `proxy:startServer`, `proxy:stopServer` | R->M | -> `ActionResult` |
| `proxy:refreshModels` | R->M | `providerId?` -> `ActionResult` |
| `proxy:login` | R->M | `providerId, methodId?` -> `ActionResult` |
| `proxy:logout` | R->M | `providerId` -> `ActionResult` |
| `proxy:activity` | R->M | -> `ActivityView[]` (50 newest) |
| `proxy:clearActivity` | R->M | -> void |
| `proxy:openPath` | R->M | `"codexHome"` or `"settingsFile"` -> `ActionResult` |
| `proxy:pickExecutable` | R->M | -> `{path?}` |
| `proxy:installAntigravity` | R->M | -> `InstallResult` |
| `proxy:acknowledgeTerms` | R->M | `"antigravity"` or `"claude"` -> `ActionResult` |
| `proxy:openLogs` | R->M | -> void |
| `proxy:openPlayground` | R->M | -> `ActionResult` |
| `proxy:copyText` | R->M | string (<=10 000) -> void |
| `proxy:openExternal` | R->M | url (allow-list: antigravity.google/terms, anthropic.com consumer-terms, accounts.google.com) -> `ActionResult` |
| `proxy:state` | M->R push | `StateView` (80 ms debounce on controller "status"; `main.ts:135-143,170`) |
| `proxy:activity` | M->R push | `ActivityView[]` (150 ms debounce on controller "activity"; also updates the tray; `main.ts:146-150,171`) |
| `proxy:installProgress` | M->R push | `InstallProgressView` (`main.ts:230`) |

Adding a channel touches `ipc.ts` (`ProxyApi`), `preload.cts` (api object), `main.ts` (`handle(...)`). `ipc.ts` must stay types-only (compiled by both tsconfigs). The preload is sandboxed: only `electron` may be required at runtime (`preload.cts:5`).

`StateView` (ipc.ts 78-93): status, settings (stored), effective (env applied), overridden[], settingsPath, antigravityInstall?, secretsEncrypted, codexHome, mcpServers. `ActivityView` (69-77) already has `provider`... note: `ActivityView` in ipc.ts has `model`, `provider`, `inputTokens`, `outputTokens`. Type gap (confirmed): `SettingsView.server` (`ipc.ts:35-38`) lacks `reuseSessions` and `listBareAliases`, although the UI reads them at runtime via `getPath` (`settings.ts:43-44`; schema `settings.ts:48,50`).

**Refresh model**: push-only. `refresh()` (317) calls `getState` after login/logout/save/install/terms; initial `getActivity` + `refresh` at 558-559. No renderer timers. The tray has its own 30 s timer for "last N min ago" (`tray.ts:52`).

**Build / CSP / theme**
- `package.json`: `build` = `tsc && tsc -p tsconfig.renderer.json && node scripts/copy-static.mjs`; `typecheck` runs both tsconfigs; `app:dev` = build + `electron .`; `dist*` = build + electron-builder + `scripts/verify-package.mjs`. Yarn 4 (`packageManager`). No bundler, no UI framework in dependencies.
- `tsconfig.json` excludes `src/renderer` and `src/playground`. `tsconfig.renderer.json` (ES2022 modules, `moduleResolution: Bundler`, DOM lib, `types: []`) compiles `src/renderer`, `src/shared`, `src/playground` to `dist/`. Renderer imports use `.js` suffixes (`settings.ts:1-2`). HTML loads `<script type="module" src="settings.js">` (`settings.html:237`), so extra renderer modules work as native ES modules over `file://` if imported with `.js` paths.
- `scripts/copy-static.mjs` copies only `*.html|*.css` from `src/renderer` and `src/playground`. New asset types (svg, fonts) need the regex extended.
- CSP (`settings.html:5`): `default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:`. So: no inline script, no inline `<style>`, no `style="..."` attributes, no inline event handlers. Setting `element.style.x` via CSSOM is allowed. The code uses classes and `[hidden]` only.
- Window: 980x760, min 640x480, `contextIsolation`, `sandbox`, `nodeIntegration:false`; close hides (`settings-window.ts:196-218`); `will-navigate` blocked unless same file.
- Light/dark: purely CSS. `:root { color-scheme: light dark }` with CSS variables, overridden under `@media (prefers-color-scheme: dark)` (`settings.css:1-8`); plus `<meta name="color-scheme" content="light dark">` (`settings.html:6`). No toggle, no JS, no `nativeTheme` use (grep of `src/electron`: none). A manual theme switch would need `data-theme` + variables, or `nativeTheme.themeSource` through a new IPC.
- Badge classes `ok|warn|err|info`, mapping at `settings.ts:74-77`.
- Dev inspection hook `ACP_PROXY_DEV_DIR` (`main.ts:267-296`): create files `dump`, `shot` (not when packaged), `eval.js`, `quit` there for text dump, screenshot, script eval, clean quit.

### 2. Usage data flow
- Provider result: `GenerationResult.usage: Usage | null` (`provider.ts:20`; `Usage` from the ACP SDK: `inputTokens`, `outputTokens`, `cachedReadTokens?`, `cachedWriteTokens?`, `thoughtTokens?`). Set in `acp-provider.ts:742-748` (plain path) and `:991-998` (tool path). For `usageScope === "session"` providers the delta against the previous cumulative is used (`:744`, `:993`, `usageDelta` `:127`). A suspended tool-call response returns `usage: null` (`:907`); cancelled returns `null` (`:694`, `:941`). `GenerationCallbacks.onUsage` (`provider.ts:19`) is declared but unused (grep: only the declaration).
- Conversion: `usage.ts:9-15` `openAiUsage(result, promptText)`: `prompt = inputTokens + cachedRead + cachedWrite`, `completion = outputTokens`; with `usage == null` it estimates `ceil(len/4)` for prompt and text. It does not flag estimates.
- Trace to entry: `server.ts:23` `Trace`, `traceUsage` (`:51`) sets `trace.inputTokens/outputTokens`; called after generation completes in chat stream (`:185`), chat non-stream (`:208`), responses stream (`:279`), responses non-stream (`:325`), image generation (`:346`). So **streaming gets token counts** (at the end, from the final `GenerationResult`). A stream that errors or is aborted before the result, and every failed request, records no counts.
- Recorder: HTTP `server.ts:356-368` `track()` registers `response.once("close")` and calls `activity.record({..., provider: bridge.providerOf(model)})`. `GET /v1/models`, 401s and 404s are also recorded (no tokens, often no provider). MCP: `mcp-endpoint.ts:601-611` `record()`, endpoint `MCP <tool>`, tokens from `ask_model` (`:696-698`) and `generate_image` (`:732-734`); the HTTP request to `/v1/mcp` itself is not tracked (`server.ts:394-399`). `providerOf` = `router.ts:135`; provider ids `codex|antigravity|claude`.
- Owner: `ProxyController.activity = new ActivityLog()` (`controller.ts:72`), passed to `createProxyServer` (`:183`), survives server restarts. The controller subscribes to `"record"` (`:85-89`, for `loginNeeded`) and forwards `"change"` as `"activity"` (`:84`). A persistent store can subscribe to `"record"` the same way. `ActivityLog.clear()` (`activity.ts:194`) clears entries and the day counter, so totals must live elsewhere to survive Clear and restarts.
- Time bucketing: `activity.ts:12` `dayKey` is local `getFullYear-getMonth-getDate` (0-based month, not padded); a persisted per-day store should use sortable local `YYYY-MM-DD`. `entry.time` is the request start; `record` increments `todayCount` by `now()`, not `entry.time`.
- Tray: `tray.ts:44,69` keeps `summary {today, lastAt}` from `proxy.activity.summary()` (pushed at `main.ts:149`), shows `describeActivity` in the tooltip (`:91`) and a disabled menu line (`:116`). No tokens in the tray. `describeActivity` lives in `activity.ts:201` and is tested.
- Persistence locations: `defaultSettingsPath` (`settings.ts:90-96`): `PROXY_SETTINGS_FILE` or `%APPDATA%/api-acp-proxy/settings.json` (macOS `~/Library/Application Support`, else `$XDG_CONFIG_HOME` or `~/.config`). `dataDir = dirname(settingsPath)` (`main.ts:26`, `controller.ts` ctor `this.dataDir`) holds `settings.json`, `models-cache.json`, `logs/`, `codex-home/`, `mcp-images/`, antigravity `install.json` and sessions file (README file table near line 53).
- Patterns to copy: `router.ts:68-79` (write queue, mkdir, tmp `.tmp-<pid>`, rename, failure logged at debug; load with try/catch returning `{}`); `settings.ts:186-205` `SettingsStore.save` (serialized queue + EPERM/EBUSY rename retry, best for frequent writes on Windows); `antigravity.ts:71-72`, `antigravity-installer.ts:245-246`.
- Secrets: only `apiKey`/`oauthToken` are `enc:`-wrapped (`settings.ts:128-129`); a usage file would hold none.

### 3. CLI / headless
- `src/index.ts` (25 lines): `new ProxyController()`, logs login URLs on "status", `start()`, SIGINT/SIGTERM -> `stop()`. No activity consumer. If the controller owns the usage store, headless gets persistence automatically (`dataDir` defaults to the settings dir).
- Existing HTTP surfaces: `GET /healthz` (unauthenticated, `server.ts:~394`, with per-provider queue stats via `healthProviders` `server.ts:372-380`); `/playground` (static, unauthenticated, not logged); `/v1/*` behind the API key. Nothing exposes usage or activity over HTTP. A usage endpoint (or `/healthz` extension) is optional and a design decision; the window gets data over IPC. `createProxyServer` receives `activity` as an option (`server.ts:383`); a store would be passed the same way.
- Playground (`src/playground/playground.ts:216-260`) reads `usage` from responses client-side; unrelated.

### 4. Tests
- Runner vitest 3 (`package.json` `test` = `vitest run`); no vitest config file; tests in `tests/*.test.ts` importing `../src/...js`.
- **Result of my run: Test Files 46 passed | 2 skipped (48); Tests 736 passed | 2 skipped (738); 24.6 s** (confirmed by running `fnm exec --using default node node_modules/vitest/vitest.mjs run` from the repo root).
- Relevant tests: `tests/activity.test.ts` (201 lines: `ActivityLog` ring/order/clear/day roll, `describeActivity`, "activity from the server" with a fake bridge incl. `providerOf` (line ~75), token counts, streaming, features, error codes, no secrets in entries), `tests/usage.test.ts` (21 lines), `tests/mcp-command.test.ts`, `tests/desktop-views.test.ts` (`listMcpServers`), `tests/logout.test.ts`, `tests/settings.test.ts`, `tests/controller.test.ts`, `tests/proxy.test.ts`, `tests/mcp-endpoint.test.ts`, `tests/antigravity-installer.test.ts`.
- No test loads `settings.html`/`settings.ts` (needs `window.proxyApi`); none covers `tray.ts` or `main.ts` (electron imports). Only pure functions are testable today; a redesign wanting renderer tests should extract pure helpers into DOM-free modules (as `mcp-command.ts` and `activity.ts` do). Follow the global `test-discipline` skill.

## Reproduction
Not a bug ticket. The existing suite was run and is green (above). The Electron window was not launched (no GUI run), so visual layout was not observed; `npm run app:dev` with `ACP_PROXY_DEV_DIR` would allow it.

## What the plan needs

Usage totals:
- New module, e.g. `src/usage-store.ts`: per provider, per local day `{requests, inputTokens, outputTokens}` (day/week/all-time derived), file `<dataDir>/usage.json` `{version:1,...}`, atomic write queue (router.ts / SettingsStore pattern), tolerant load (missing/corrupt -> empty).
- Wiring in `ProxyController` next to `activity` (`controller.ts:72`), subscribed to `activity.on("record")` (`:85`); flush in `stop()` (and mind the 5 s window in `main.ts:63-74`). Decide which entries count: skip no-provider entries (models list, 401, 404), and whether failed/zero-token requests count as requests; MCP `ask_model`/`generate_image` entries have a provider and tokens.
- Estimated vs reported: `ActivityEntry` has no flag. If wanted, add it via `openAiUsage` (`usage.ts`), `traceUsage` (`server.ts:51`), `mcp-endpoint.ts:696,732`, `ActivityEntry` (`activity.ts`), `ActivityView` (`ipc.ts`).
- Definitions needed: week (rolling 7 days vs calendar), local midnight. "Clear" in Recent requests should clear the list only (or get a separate "Reset usage").
- IPC: `getUsage(): Promise<UsageView>` + push (or put usage in `StateView`; the activity push at `main.ts:147-150` is a ready hook) and optional `resetUsage`. Touch `ipc.ts`, `preload.cts`, `main.ts`.
- Tray: optional; extend `setActivity` payload (not unit tested).
- Tests: pure store (bucketing, rollover, week sums, corrupt file, round trip in a tmp dir), controller-level recording via the fake bridge pattern in `tests/activity.test.ts`.
- Docs: README line ~41 ("never written to disk", "in memory only") and the file table (~line 53); `#act-empty` text in `settings.html:57`.

Redesign:
- Surface is 3 files (html/css/ts) plus IPC types; the data contract can stay untouched for a structural/visual redesign. Natural structure: nav/tabs (Overview, Usage, Server, one per provider, MCP/Advanced) with `[hidden]` switching; keep field ids or update the `fields[]` table and `data-*` hooks together.
- New markup must obey the CSP (no inline style/handlers/scripts); icons as `data:` URIs or same-origin files (extend `copy-static.mjs` for non-html/css).
- Current save model: per-card "Save and restart" (each save restarts the server) with per-scope `dirty`. An alternative (one save bar, autosave) must keep: patch-by-scope semantics, `null` to clear, trimming rules, env-forced skip, terms gating, and `dirty` protecting edits from 80 ms state pushes.
- Verify with `npm run typecheck` (both tsconfigs) and `app:dev` + `ACP_PROXY_DEV_DIR` shots.

## Risks (easy to break)
1. Env-forced fields: `renderFields` disables the input, shows the "Overridden by an environment variable." note via `[data-note-for="<path>"]`, displays the `effective` value (`settings.ts:127-133`), and `collectPatch` skips it (`:375`). Paths come from `resolveConfig` (`settings.ts:202-230`): `server.host/port/apiKey/maxBodyBytes/timeoutMs/modelsWaitMs/workRoot/reuseSessions/listBareAliases/toolResultTimeoutMs/maxConcurrent/maxQueue`, provider `enabled/isolatedHome/maxConcurrent`, `acpCommand/acpArgs`, `executablePath`, terms flags. Any new or moved control for these must keep the note element and the disabled state. `launchAtLogin`, claude `apiKey/oauthToken/configDir`, antigravity `apiKey/geminiHome` are not env-overridden.
2. `enc:` secrets: `SettingsStore.save` wraps `apiKey`/`oauthToken` (`settings.ts:128-129,186`) and `load` decrypts; undecryptable values are dropped with a warning (`:157-159`). The renderer receives plaintext keys in `settings`/`effective` and sends plaintext back. An empty secret input sends `null`, which DELETES the key (`collectPatch` 380-388); apiKey-like values are not trimmed (`:384`). Do not drop secret fields from `collectPatch` or send `""`/`null` by accident when re-laying out or masking inputs. The footer note (`:314`) depends on `secretsEncrypted`.
3. Save = server restart (`applySettings`, `main.ts:187-198`); each scope sends only its fields; `launchAtLogin` side effect is applied in main (`:191`).
4. Login/logout: Log in/out controls exist in the overview rows and the provider cards; they share `loggingIn`/`loggingOut`, `isSignedIn`, `providerUsable` (`settings.ts:93-94,162-167,188-194,226-236`); login needs the provider enabled + saved + server running; claude message "Complete the login in the console window..." (`:322`); the login URL box (`data-role` `login-link`/`login-url`/`copy-login`) is driven by `status.loginUrl` and opened only through `proxy:openExternal` (allow-list). `logoutText` (333-342) warns that a shared login home (`loginHome.shared`) signs the user out of Codex / Claude Code / Gemini tools on the machine; keep that. The tray can log in too (`main.ts:161`). Controller-side tests: `tests/logout.test.ts`.
5. Antigravity download progress: `onInstallProgress` is global (`settings.ts:545-552`) and drives `#install-progress` / `#install-text` by id; `install-agy` state uses the `installing` flag and `renderInstall`; main enforces a single flight (`main.ts:226-229`); after success it calls `applySettings({})` (restart, `:231`). Those elements must stay in the DOM when a tab/section is hidden, and `[hidden]` is `display:none !important` (`settings.css:78`).
6. Terms dialogs: gated on the Enabled checkbox change and on save; `proxy:acknowledgeTerms` stores `termsAcknowledgedAt` (env `PROXY_*_ACCEPT_TERMS` can pre-accept); `<dialog>.showModal`, Esc via `oncancel`.
7. The auth-method `<select>` is rebuilt on every state push (`renderAuth`) and keeps the user's choice only while `dirty[scope]`; `defaultAuth`/`fallbackAuth` (claude subscription-only by default) must stay.
8. `isOwnUrl` requires the page to be exactly `dist/renderer/settings.html` for IPC authorization (`settings-window.ts:180-187`, `main.ts:176-182`); a second HTML page would be rejected unless `isOwnUrl` is extended.
9. `ENDPOINT_LABELS` (`settings.ts:260`) does not know `MCP ...` endpoints (shown raw); the Tokens column shows estimates as if real.
10. Persisted usage: write frequency (coalesce), Windows rename EPERM (copy the retry from `SettingsStore`), flush on quit, local-time day boundaries and DST, and no double counting (HTTP and MCP each call `record` once per request).

## Open questions
- What counts as a "request": every recorded entry with a provider, only successes, or only generation endpoints (chat, responses, images, MCP tools)? Do errors with zero tokens count?
- Show estimated tokens as-is or flag them? Cached tokens are folded into input (`usage.ts:14`); show them separately?
- Week = rolling 7 days or calendar week?
- Resettable from the UI? Should "Clear" leave totals alone?
- Is an HTTP usage endpoint wanted for headless users (auth rules; `/healthz` is unauthenticated)?
- Redesign scope: structure only, or also theme toggle, new fonts/icons (CSP and `copy-static` changes), or a bundler/framework? The code does not answer this.
- The Electron window was not launched, so visual issues were not observed.
