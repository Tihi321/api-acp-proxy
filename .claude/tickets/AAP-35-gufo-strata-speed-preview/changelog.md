# Changelog

## 2026-11-20 AAP-35: Gufo and Strata providers, app launcher, playground tok/s and html preview

Gufo and Strata are now `gufo/*` and `strata/*` OpenAI-compatible providers. The desktop app can start and stop them, one at a time and hidden. The playground shows TTFT and decode tok/s, renders fenced code blocks, and runs html/css/js blocks in a sandboxed preview on click.

### api-acp-proxy (branch `AAP-35_gufo-strata-speed-preview`, from master 73a4d63)

- `src/settings.ts`: `localProviderSchema` and `providers.gufo` / `providers.strata` (`enabled` true, `port` 8081/8080, `command`, `args` with `{port}`, `cwd`, optional `apiKey`, `maxConcurrent` 1). Both `apiKey`s are encrypted like the other secrets.
- `src/shared/ipc.ts`: types `LocalServerId`, `LocalServerState`, `LocalServerStatusView` and `LocalProviderSettingsView`; settings view and patch entries; four `ProxyApi` members.
- `src/electron/preload.cts`: `getLocalServers`, `startLocalServer`, `stopLocalServer` and `onLocalServers` bridged.
- `src/providers/local-openai.ts` (new): `LocalOpenAiProvider`, `gufoRegistration` and `strataRegistration`.
  - Requests stream to `/v1/chat/completions` with `include_usage`. Usage is the upstream's, or `null` when the upstream sends none.
  - A connection failure gives 503 `local_server_not_running` ("X is not running — start it from the app."). A non-2xx answer or an in-stream error gives `upstream_error`. An abort gives `cancelled`.
  - It uses Node's fetch, not `ctx.fetch`.
- `src/controller.ts`: the default registry includes both local providers.
- `src/local-servers.ts` (new): `LocalServerManager`.
  - Spawns hidden through `cmd.exe` on Windows (`/bin/sh` detached elsewhere).
  - Refuses an empty command, a missing cwd, or a port that already answers.
  - Stops the other server first, and keeps a 200-line log with ANSI codes stripped.
  - Probes `/v1/models` until it answers (10-minute timeout), handles exit and error, and stops with `killProcessTree`.
- `src/electron/main.ts`:
  - Registry and manager.
  - A throttled `proxy:localServers` push, and a models refresh when a server turns ready.
  - Start and stop handlers that build the spec from the effective settings.
  - On quit, local servers stop in parallel with the controller within the 5 s budget.
- `src/renderer/settings.html`, `settings.ts`, `settings.css`: a "Local models" nav group with Gufo and Strata pages.
  - Each page has the fields, provider badge, launcher badge, Start/Stop, process info, the last 50 log lines and models.
  - Start saves unsaved edits first.
  - The nav dot shows launcher `starting`/`error`.
  - Series colours for light and dark.
- `src/renderer/usage-view.ts`, `usage.css`: series for gufo and strata.
- `src/playground/lib.ts`: `splitBlocks`, `previewDocument`, `estimateTokens`, `tokensPerSecond`, `decodeRate` and `formatRate`.
- `src/playground/playground.ts`:
  - Finished answers render text and code blocks, using textContent only.
  - Run (sandboxed iframe) and Open in new tab, wired to the postMessage handshake.
  - A live `~N tok/s` while streaming. The meta line shows `TTFT` and the decode rate.
- `src/playground/playground.css`: styles for code, rate and preview.
- `src/playground/preview.html` (new): the preview page, which accepts one document from its parent or opener.
- `src/playground-files.ts`: serves `/playground/preview` with `PREVIEW_CSP`. `PLAYGROUND_CSP` adds `frame-src 'self'`.
- `tests/settings.test.ts`, `tests/local-openai.test.ts` (new), `tests/local-servers.test.ts` (new), `tests/playground.test.ts`: the tests the plan lists.
- `tests/controller.test.ts`: disables gufo and strata in `make()` and lists them as disabled.
- `README.md`, `ROADMAP.md`:
  - Docs for the providers, a "Local model servers" section, and the playground TTFT, tok/s and preview.
  - The settings window page list now names the new pages.
  - A roadmap entry.

### Deviations

- `tests/controller.test.ts` was changed although the plan did not list it. The new default registrations broke its exact provider-list assertion. Disabling gufo and strata in `make()` also keeps the test from probing ports 8080/8081 on this machine.
- Small additions in T5: an apiKey Show/Hide button, a `server-info` line, a `.log` style, and the Enabled switch in the page header.
- Small additions in T6: an optional `csp` argument on the `send` helper.
- Details C4 left open, in T3: `start` claims `starting` synchronously and reverts if a pre-spawn check throws, and a signal exit is reported as "exited with signal X".

### Verification

- `npm test` passed: 35 files, 472 tests, 1 skipped.
- `npm run typecheck` passed with no errors.
- `npm run build` passed.
- These were run with node through fnm, using the same commands as the npm scripts.
- **Not run:** manual checks M1-M7. They need the real app, Gufo, Strata and a browser: no console window, process tree killed on stop and quit, real usage and tok/s, and the preview iframe, tab and CSP.

### Follow-ups / limitations

- The Gufo and Strata stream and usage format is assumed from research, not checked against the real servers.
- Strata's `--open` opens a browser tab. Point `command` at the venv python to avoid it.
- See `discoveries.md`.

Commit status: committed on `AAP-35_gufo-strata-speed-preview` (7 code/doc commits plus the ticket files commit). Not merged, not pushed.
