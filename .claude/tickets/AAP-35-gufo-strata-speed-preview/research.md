# AAP-35 research: Gufo + Strata providers, launch from app, tokens/sec, HTML preview

## Question
How do Gufo (D:\Gufo) and Strata (D:\Strata, data D:\Strata-data) work, how are providers added to this proxy, where do the playground chat, usage and rendering live, and what is the safest way to add tokens/sec and a sandboxed HTML/JS/CSS preview.

Nothing was run or started. Everything below was read from files (marked confirmed with a path) or reasoned (marked inferred).

## Answer
- Neither tool speaks ACP. Both are local model servers (llama-server style) with an OpenAI-compatible HTTP API (Strata also Anthropic Messages and Responses). They are not agent CLIs. Closest analogue: LM Studio / llama-server.
- This repo has only ACP providers (codex, claude, antigravity). A new HTTP provider means implementing `Provider` directly (no `AcpProvider`) and registering it in about 6 places (see "What the plan needs").
- No generic "launch a process from the UI" exists. Nearest pieces: `consoleLogin` in claude.ts (spawns a visible cmd window), `killProcessTree`, and the IPC pattern (renderer -> preload -> main handler -> controller). The app needs a new local-server manager plus IPC actions.
- The playground is a plain browser page served by the proxy (not the Electron renderer). It renders all text with `textContent` (no markdown, no code blocks) under a strict CSP. Its meta line already shows first-token time, total time and tokens; tokens/sec is a small client-side addition. The proxy sends usage only in the LAST SSE chunk, so a live tok/s must be estimated client-side.
- HTML preview: the current CSP blocks iframes and would block inline scripts in a `srcdoc` iframe. Safest is a separate whitelisted preview page with its own CSP, in `<iframe sandbox="allow-scripts">` (no `allow-same-origin`), fed by postMessage, run on click.

## A. What Gufo and Strata are

### Gufo (confirmed unless marked)
- `D:\Gufo\v0.35.0\gufo.exe` (117 MB), MIT, upstream gufo-org/gufo (D:\Gufo\v0.35.0\NOTICE; C:\projects\Cowork\Computer\notes\gufo.md:5-10). Windows is a "development target". Strix Halo (gfx1151) engine with bundled ROCm DLLs.
- Launcher `D:\Gufo\gufo.cmd` (lines 1-6) sets `GUFO_MODELS_DIR=D:\Gufo\models` and runs `D:\Gufo\v0.35.0\gufo.exe %*`. The versioned folder changes on upgrade (scripts\install-gufo.ps1 rewrites gufo.cmd), so call `gufo.cmd`, not the exe.
- Subcommands (strings in gufo.exe, notes): `serve llm|embedding|image|tts|video|decision`, `chat`, `prompt`, `model list|install|remove`, `diagnose`, `extension`.
- HTTP API (inferred from exe strings, confirmed by notes gufo.md "Clients"): `/v1/chat/completions`, `/v1/completions`, `/v1/embeddings`, `/v1/models`, `/v1/messages`, `/v1/health`, image and audio endpoints. `/` returns `{"status":"ok"}`; tool calling worked over HTTP (notes). No web page.
- Start command the user used (notes gufo.md "Clients"; not run by me): `D:\Gufo\gufo.cmd serve llm --model qwen27-q4 --speculative dflash2 --dflash-model D:\Gufo\models\qwen27-q4\Qwen3.8-27B-DFlash2-Q4_K_M.gguf --port 8081 --context 32768`. Flags found in the exe: `--model --port --host --api-key --context --dflash --dflash-model --mmproj --served-model-name --mtp-model`. Default port looks like 8080 (`127.0.0.1:8080` string in exe, inferred); 8081 was used to avoid Strata.
- Model choice: an installed model id given at server start; the server serves ONE pinned model, and requests must name it (`Qwen3.8-27B`), there is no default (notes). Only `qwen27-q4` is installed here (D:\Gufo\models\installed.json; folder models\qwen27-q4 holds weights, DFlash2 draft, mmproj). Catalogue in notes: flash-next-q4, qwen27-q4, qwen27-q8, deepseek4, plus embedding, ASR, image models.
- Auth: none by default; `--api-key` exists. Speed on this PC: 11.7 tok/s AR, 45.5 tok/s with DFlash2 (D:\Gufo\test-qwen27-*.log and notes).
- Strata's GGUFs do not load in Gufo (notes).

### Strata (confirmed unless marked)
- `D:\Strata`, a git clone of Niko1221/Strata, MIT, version 0.2.17, engine 0.1.63 (D:\Strata\AGENTS.md:3). Three parts: desktop app (Tauri `app/desktop` + Node host `app/host`), Terminal (`strata.py`, `strata_cli`, `strata_control`), engine plus Python server (`terminal/serve/server.py` in this checkout).
- A local model server, not an agent; only a few model families (Qwen3.8-Flash-Next, Qwen3.6-35B-A3B, DeepSeek-V4.1-Flash packs; notes strata.md:6-10).
- API at `http://127.0.0.1:8080`: `POST /v1/chat/completions`, `/v1/responses`, `/v1/messages`, `GET /v1/models`, `/health`, `/props`, `/api-monitor`, plus `/v1/load`, `/v1/unload`, `/v1/status` (D:\Strata\docs\AI_REFERENCE.md:92-100; docs\DETAILS.md:415-423, 468-479). `/v1/models` lists only the loaded model, possibly as `unloaded` while idle (DETAILS.md:415, 495). Any model name is served (DETAILS.md:542).
- Auth: optional API key; the local default needs none. A POST with a browser `Origin` header is refused unless from Strata's own page (DETAILS.md:727); a Node `fetch` sends no Origin (inferred).
- How it starts on this PC: `D:\Strata\terminal\run-unsloth-ud-iq4_xs.bat` runs `terminal\.venv\Scripts\python.exe terminal\serve\server.py --engine strata --config D:\Strata\terminal\strata-unsloth-ud-iq4_xs.json --port 8080 --open`. Siblings: `run-unsloth-ud-iq4_xs-parallel.bat`, `run-deepseek-v4.1-flash-ista-das-coder.bat`, `run-deepseek-v4.1-flash-ist-das-2.00bpw.bat`. Each has a `strata-<name>.json` (engine exe, args, `model_name`, `port: 8080`, `lib_dirs`, `env`). Closing the bat window stops the server. The official command is `strata launch ... --yes --no-tui` with `--status`, `--stop`, `--show-key`, `--port`, `--api-key-env` (docs\TERMINAL_LAUNCH.md:10-16, 103-113). The shim is `%LOCALAPPDATA%\Strata\runtime\strata.cmd`; `strata` is not on PATH here.
- Model choice: set by which run script/config JSON is started (packs in `D:\Strata-data\packs\...`; `D:\Strata-data\models\` holds IQ3_S and unsloth-UD-IQ4_XS). One model per server. Loading takes 1-3 minutes and the PC is slow meanwhile (notes strata.md "Run / stop").
- `%LOCALAPPDATA%\Strata\procs\*.json` show an engine and a vision process with recorded pids, so Strata ran recently. Not verified as live.
- Measured by the user: IQ3_S 52 tok/s, UD-IQ4_XS 46 tok/s (notes strata.md benchmarks).

### Ambiguities for the user
1. Both default to 8080; the proxy defaults to 8787 (src/settings.ts:43). Gufo has been used on 8081.
2. Four Strata run scripts exist and only one big model fits in memory; Gufo and Strata together probably do not fit on the GPU (notes: Gufo tested with Strata stopped). Should starting one stop the other?
3. Gufo has no default model or flags; only `qwen27-q4` is installed.
4. "Support in the proxy" is read here as an upstream OpenAI-compatible HTTP provider. An ACP wrapper would not apply.
5. Tool calling, image input and web search: the proxy's tool bridge is ACP/MCP specific; a first version can be text-only.

## B. How providers are added in this repo

### Path through the code (confirmed)
- `Provider` interface: src/provider.ts:193-223. Required members: `id, displayName, ownedBy, exposeUnprefixed`, `generate(model, messages, callbacks{onText,onUsage}, signal, options) -> {text, stopReason, usage: Usage|null}`, `listModels`, `status`, `login`, `onStatus`, `close`. Optional: `staticModels`, `toolCalling`, `mcpSupport`, `imageGeneration`, `webSearchSupport`, `maxPromptChars`, `checkPrompt`, `logout`, `planLimits`.
- `Usage` is the ACP shape `{inputTokens, outputTokens, totalTokens, thoughtTokens?, cachedReadTokens?}` (node_modules/@agentclientprotocol/sdk types.gen.d.ts:2730). `openAiUsage` converts it, or estimates chars/4 when `usage` is null (src/usage.ts:12-14).
- ACP route: a `ProviderDescriptor` (src/provider.ts:79-168) wrapped by `AcpProvider` (src/acp-provider.ts, spawn at :391). Examples: src/providers/codex.ts, claude.ts (`claudeRegistration` at :206-211), antigravity.ts. `src/acp.ts` is only the `AcpLike` interface the server uses.
- Registration: `ProviderRegistration {id, displayName, planLimits?, create(args)}` (src/controller.ts:34-40). Default list: src/controller.ts:89 `[codexRegistration, antigravityRegistration, claudeRegistration]`, and again src/electron/main.ts:93. The controller creates only registrations whose `settings.providers[id].enabled` is true (controller.ts:216-220) and hands them to `ProviderRouter` (controller.ts:221).
- Router (src/router.ts): ids `<provider>/<model>`; bare ids if `exposeUnprefixed` (:101-131); models cached in models-cache.json unless `staticModels` (:60, :93-99); per-provider concurrency limiter (:54-59); usage-limit refusal (:200-221). A provider with no discovered models accepts any `<id>/<model>` (:118-131).
- Settings: `settingsSchema` has a FIXED `providers` object with codex, antigravity, claude (src/settings.ts:63-111). zod strips unknown keys by default, so a new provider must be added to the schema. Env overrides in `resolveConfig` (:236-257) are optional. `mapSecrets` (:151-161) lists encrypted fields (add a stored API key there).
- UI contract: `SettingsView` / `SettingsPatchView` in src/shared/ipc.ts:38-64 are hand-written per provider.
- Settings window (Electron renderer, hard-coded lists): src/renderer/settings.ts `Scope` (:6), field table (:52-67), `toolName` (:85), `providerOrder` (:86), `views` (:87), `dirty` (:100), render calls (:366-367), loops (:576, :589); nav buttons and a `view-<id>` section per provider in src/renderer/settings.html (:31-32, :234, :297); usage chart `KNOWN_SERIES` (src/renderer/usage-view.ts:15). Tray: src/electron/tray.ts.
- There is no HTTP/upstream provider and no OpenAI client in src. `ctx.fetch` is available in `RuntimeContext` (provider.ts:56). The `openai` package is used only by tests (tests/router.test.ts:4).

### Minimal set
- ACP provider (for reference): descriptor file, 2 registrations, schema (+env), ipc.ts view types, settings.ts/html card, usage-view series, tests with tests/fixtures/fake-acp.mjs.
- HTTP-backed provider (Gufo/Strata): one file `src/providers/local-openai.ts` (generic class taking id, baseUrl, apiKey; streams SSE from `<baseUrl>/chat/completions`, forwards deltas to `callbacks.onText`, maps the final `usage` to `Usage`, honors `signal`), registrations `gufoRegistration` / `strataRegistration`, then the same 5 shared places (controller.ts:89, main.ts:93, settings schema, ipc.ts, renderer settings.ts/html + KNOWN_SERIES). `status()` can map reachability of `/v1/models` (or `/health`) onto `ready` / `stopped` / `error` (states at provider.ts:40). `login()` is required by the interface; make it a no-op.
- Gotchas: reject or ignore `options.tools`/`mcpServers`/`images` (router checks capability flags, router.ts:135-143; absent flags give a 400 `model_not_capable`); `Message[]` comes from src/api.ts (image parts need mapping for vision); sampling params are already dropped (AAP-28); an unreachable server should become `AcpUnavailableError` (503) rather than hang (provider.ts:23-26).

### Existing launch mechanism
- `killProcessTree` (taskkill /T /F or process group): src/process-tree.ts:5-17; orphan sweep follows in the same file.
- Visible console spawn: src/providers/claude.ts:69-72 (`spawn("cmd.exe", ["/d","/s","/c", line], {windowsHide:false, windowsVerbatimArguments:true})`), used by `externalLogin`.
- Agent spawn: src/acp-provider.ts:391 (stdio pipes, `windowsHide: true`).
- UI trigger pattern: renderer `window.proxyApi.<method>` -> preload `ipcRenderer.invoke("proxy:<name>")` (src/electron/preload.cts:13-37) -> `handle("proxy:<name>", ...)` in src/electron/main.ts:196-259 (handlers refuse foreign callers, :185-187) -> `ProxyController`. Types: `ProxyApi` (src/shared/ipc.ts:140-175). Similar actions: `proxy:login` (main.ts:212), `proxy:installAntigravity` (:240), `proxy:openPlayground` (:257).
- For "start from the app" the plan needs a new manager (spawn, pid tracking, ready-wait on `/v1/models` or `/health` because loading takes 1-3 min, logs, stop via `killProcessTree`, cleanup on quit) and IPC `proxy:startLocal` / `proxy:stopLocal`. Options: (a) app-owned hidden process, stopped on quit; (b) visible cmd window like Strata's bat (progress visible; closing stops it); (c) `strata launch --yes --no-tui` / `--stop`, which detaches and outlives the app. Settings needed: command or script, args, port, model, cwd, stop-on-quit.

## C. Playground chat and tokens/sec

- Standalone page: src/playground/playground.html, playground.ts (290 lines), lib.ts (pure helpers), playground.css. Built by tsconfig.renderer.json and copied by scripts/copy-static.mjs (all .html/.css in src/playground). Served by `servePlayground` (src/playground-files.ts) at `/playground` with a fixed whitelist `FILES` (:8-13): any new file must be added there. Electron opens it in the default browser (main.ts:162-166), so the Electron settings CSP is not involved.
- Rendering: `renderMessage` (playground.ts:117-161) sets `div.text` with `textContent` (:120; streaming :255); css `white-space: pre-wrap`. No markdown, no code-block handling, no innerHTML.
- Streaming: `send()` (:183-232) and `readStream` (:234-263) read the fetch body, parse with `parseSseLines` (lib.ts:24-29), set `meta.firstMs` at the first content delta (:252), take usage from `chunk.usage` (:260) or `payload.usage` (:216-217), set `meta.totalMs` in `finally` (:222). The meta line is built at :136-148 (streamed, first token, total, in/out tokens, finish). `Meta` type at :5.
- Server: with `stream_options.include_usage` (always sent by the playground, :173) one final `{choices: [], usage}` chunk is written after the finish chunk (src/server.ts:181, :200). Usage is the agent's or the chars/4 estimate (src/usage.ts:12-14). Text deltas arrive as the agent emits them, often in large chunks.
- Best place for tokens/sec (proposal, option A): client side only, no proxy change.
  - Final value: `outputTokens / ((totalMs - firstMs) / 1000)` as decode speed when `firstMs` is known and the elapsed time is above zero; for non-streamed answers `outputTokens / (totalMs / 1000)`. Add `tokensPerSecond` to `Meta` (:5) and a part in the list at :138-144. Old history entries simply lack it.
  - Live value while streaming: chars/4 of `answer.content` over time since first token, shown as "~N tok/s" next to the pending text and replaced by the real figure when the usage chunk arrives. Put the pure maths in lib.ts (next to `formatMs`) so it is unit-testable.
  - Caveat: ACP providers often report no usage, so the final number is itself chars/4. The playground cannot tell (no `estimated` flag in the usage object). A local upstream like Strata/Gufo gives real usage. Exact usage/timings chunk shape for them is NOT verified.
  - Option B: also show tok/s in the Electron activity view from `ActivityView.outputTokens / durationMs` (src/shared/ipc.ts:100-110), but duration includes queue and prompt processing.
- Only one chat window exists (the playground); the Electron window has no chat.

## D. Message rendering, sanitization, CSP

- No markdown library: package.json dependencies are the ACP adapters, ACP SDK, fflate, openai, zod. The playground has no runtime deps.
- Playground CSP (src/playground-files.ts:17): `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`, sent on every playground file. With no `frame-src`/`child-src`, `default-src 'none'` blocks any iframe (inferred from CSP rules). A `srcdoc` document also inherits the embedding page's policy, so inline `<script>`/`<style>` in it would be blocked by `script-src 'self'` / `style-src 'self'` even under `sandbox="allow-scripts"` (inferred from the CSP spec; verify in a browser).
- Recommended design (option A): a second whitelisted file `GET /playground/preview` (new `preview.html` + entry in `FILES`) with its own CSP: `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; frame-ancestors 'self'`. The main page's CSP gets only `frame-src 'self'` and keeps `frame-ancestors 'none'`. The iframe is `<iframe sandbox="allow-scripts" src="/playground/preview">` (no `allow-same-origin`, no forms, popups, modals, top-navigation). Code is delivered by `postMessage` after load (opaque origin, so target `*`; the child checks `event.source === window.parent`), or the preview page builds the document with `document.open/write`. Under `sandbox` without `allow-same-origin` the preview cannot read the playground's localStorage (chat history) or sessionStorage (API key) and cannot call `/v1` with credentials; `connect-src 'none'` blocks network calls.
- Option B: `srcdoc` with a CSP `<meta>` inside. Needs `frame-src` allowing it and still intersects with the inherited policy, so inline scripts stay blocked unless the parent CSP is loosened. Worse.
- Parsing: a pure `splitBlocks(text)` in lib.ts returning `{type:"text"}` / `{type:"code", lang, code, closed}` for ``` fences, tolerant of an unclosed fence while streaming. Render code with `<pre><code>` via `textContent` (keep the "no innerHTML" invariant). Show a "Run preview" button only for `html`, or for `html`/`css`/`js|javascript` blocks of one message (assemble one document: html + `<style>` + `<script>`). Run on click only, not automatically, because model output is untrusted code; render during streaming only for closed blocks.
- Electron settings window (separate): `sandbox: true`, `contextIsolation: true` (src/electron/settings-window.ts:43-45), `setWindowOpenHandler` deny and a `will-navigate` guard (:57-58), CSP `default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:` (src/renderer/settings.html:5). The preview does not belong there.

## E. Tests, build, conventions

- Vitest 3: `npm test` = `vitest run`; vitest.config.ts excludes `.claude/**`. `npm run typecheck` runs tsc for main (NodeNext) and tsconfig.renderer.json (DOM; includes src/renderer, src/shared, src/playground); strict plus `noUncheckedIndexedAccess`. `npm run build` = tsc + renderer tsc + scripts/copy-static.mjs. CI: yarn typecheck, yarn test, yarn build on windows-latest (.github/workflows/ci.yml); packageManager yarn@4.13.0; Node >= 20. If node is missing use `fnm exec --using default npm test`. I did not run the tests (read-only brief, none requested).
- Tests that cover this area: tests/router.test.ts (fake `Provider` objects + `createProxyServer` + openai client; template for a provider test), tests/playground.test.ts (lib helpers, `servePlayground`, `PLAYGROUND_CSP` via the constant, so a CSP edit follows), tests/settings.test.ts (schema), tests/controller.test.ts (registry), tests/usage.test.ts, tests/desktop-views.test.ts, tests/acp-provider.test.ts + tests/fixtures/fake-acp.mjs (ACP only).
- Conventions: ESM with `.js` import suffixes; long single-line JSDoc explaining why; `ApiError(status, code, message, param)` for client errors; one provider per file in src/providers/; pure helpers apart from DOM code (lib.ts) and unit-tested; tests write under `.claude/temp/<name>-tests`. Tickets in `.claude/tickets/AAP-NN-.../` (plan.md, changelog.md, events.jsonl, research.md); ROADMAP.md updated per ticket; branch `AAP-NN_short-name`, one commit per ticket, merged as "Merge AAP-NN_..." (git log). Global rule: few, important tests; commit by heredoc.

## What the plan needs
1. Confirm the reading with the user (open questions). Suggested order: tokens/sec (small), preview (medium), HTTP provider (medium), launcher (largest, riskiest). Four independent pieces; consider one ticket each or one ticket with four tasks.
2. Provider: `src/providers/local-openai.ts` + registrations; edits in src/controller.ts:89, src/electron/main.ts:93, src/settings.ts (schema, env, `mapSecrets`), src/shared/ipc.ts, src/renderer/settings.ts and settings.html, src/renderer/usage-view.ts:15, README/ROADMAP.
3. Launcher: new manager module, IPC in ipc.ts/preload.cts/main.ts, card buttons, a `starting` status while loading, quit cleanup.
4. Playground: lib.ts (`splitBlocks`, tok/s helpers), playground.ts, playground.css, `preview.html` (+ preview script if any) with the whitelist entry in `FILES`, CSP changes in src/playground-files.ts. Check scripts/verify-package.mjs for a list of packaged playground files (not read).
5. Tests: lib helpers, CSP and whitelist test, provider test with a fake SSE upstream, settings schema test.

## Risks
- GPU memory is shared: Gufo plus Strata, or two Strata models, may not fit; Strata load slows the PC for 1-3 minutes.
- The default `maxConcurrent` 4 per provider (src/settings.ts:57) is too high for one local GPU model; use a lower per-provider default.
- Proxy `timeoutMs` default is 5 minutes (src/settings.ts:46); first request may trigger a model load (Strata can show `unloaded`).
- A stopped local server gives an empty model list; the router then accepts any `<id>/<model>` (router.ts:122-127). Use live discovery with a clear 503 "not running".
- Spawning commands from settings is a local code-execution surface; IPC already checks the sender (main.ts:185-187); validate or fix paths and arguments.
- Running model-generated HTML/JS: sandbox without same-origin, never innerHTML, run on click; the playground stores the API key in sessionStorage and chats in localStorage.
- Changing `PLAYGROUND_CSP` affects every playground file; keep `frame-ancestors 'none'` for the main page and give the preview file its own CSP.
- Shared files (controller.ts, settings.ts, ipc.ts, renderer settings.ts) are touched by every provider: merge-conflict prone. No data migration (zod defaults).
- Strata/Gufo streaming usage format unverified; if the server omits usage the proxy falls back to chars/4.

## Open questions
1. Is "support in the proxy" meant as upstream OpenAI-compatible HTTP providers `gufo/...` and `strata/...`?
2. Ports: Strata 8080 and Gufo 8081 (as in the notes), proxy 8787?
3. Which Strata run script/model and which Gufo model/flags (qwen27-q4 with dflash2, 32K context)? Chosen in the UI or fixed in settings?
4. Launch style: app-owned hidden process stopped on quit, visible console window, or `strata launch` detached? Should starting one stop the other?
5. Tokens/sec: decode speed (after first token) or overall? Live while streaming (estimated) or only at the end? Also in the Electron activity view?
6. Preview: on click only? Combine html+css+js blocks of a message into one page? Inline in the message, a larger pane, or a new tab?
7. Not verified: whether Gufo/Strata are running now, and the exact stream/usage format of each (nothing was run).
