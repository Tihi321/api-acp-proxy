---
status: in-progress
request: REQ-0004
repos: [api-acp-proxy]
branch: AAP-35_gufo-strata-speed-preview
updated: 2026-11-20
---

# AAP-35 Gufo and Strata providers, launch from the app, tokens/sec, HTML preview

Source of facts: `research.md` in this folder (file:line references). This plan is the only contract for the workers; each task lists its inputs, outputs and the interface it must keep.

Reading chosen (full, not narrow): Gufo and Strata become real proxy providers (`gufo/...`, `strata/...`) that the desktop app can also start and stop itself; the playground gets tok/s and a click-to-run preview of html/css/js blocks.

## Scope

1. A generic OpenAI-compatible HTTP upstream provider class (`LocalOpenAiProvider`) with two configured instances, `gufo` and `strata`, routed as `gufo/<model>` and `strata/<model>` (no bare ids). Streaming passes through; usage comes from the upstream's final usage chunk, otherwise `usage: null` (the existing chars/4 estimate in `src/usage.ts` applies). An unreachable server answers 503 `local_server_not_running` with the message `Gufo is not running — start it from the app.` (or `Strata ...`).
2. Both are listed wherever providers are listed: the settings window (own nav items and views), the Usage view (series colours), the model list (`/v1/models`, playground), the tray (automatic via `status.providers`).
3. An app-owned launcher (`LocalServerManager`) in the Electron main process: spawns the configured command hidden (`windowsHide: true`, no console window), tracks state `stopped | starting | ready | error` (ready = HTTP 200 from `GET http://127.0.0.1:<port>/v1/models`), keeps the last 200 log lines, stops with `killProcessTree` (src/process-tree.ts), stops everything on app quit. Only one runs at a time: starting one stops the other first.
4. Settings: per local provider `enabled`, `port`, `command`, `args`, `cwd`, `apiKey` (optional secret), `maxConcurrent` (default 1), editable in the settings window with prefilled defaults.
5. Playground: live estimated tok/s while streaming; on completion `TTFT` and decode tok/s = output tokens / ((total − TTFT) / 1000).
6. Playground: fenced code blocks shown as code; a **Run** button on a finished assistant message that has html/css/js blocks; the blocks of that message combined into one document and run on click in `<iframe sandbox="allow-scripts">` (no `allow-same-origin`) under the message, loaded from a separate whitelisted `/playground/preview` page with its own CSP, fed by `postMessage`; plus **Open in new tab** (same preview page, sandboxed by its CSP header).

## Out of scope

- Markdown rendering of normal text (bold, lists, links, tables); only ``` / ~~~ fences are recognised. Syntax highlighting.
- Model download/install, choosing a model in the UI (the model is whatever the configured command loads), editing Strata's JSON configs.
- An ACP wrapper for Gufo/Strata; tool calling, MCP, web search, image input or image generation through them (the router answers 400 `model_not_capable`, as for any provider without the flag).
- Chat in the Electron renderer; tok/s in the Electron Requests/activity view.
- `strata launch` detached mode, visible console windows, adopting a server started outside the app (it is reported, not controlled).
- Auto-running previews; loading external scripts, fonts or network calls inside a preview (blocked by its CSP).
- Tray menu items for Start/Stop; env-variable overrides for the new settings.
- Starting servers automatically at app launch.

## Shared contracts (all tasks code against these; do not change them without updating this plan)

### C1 Settings schema (`src/settings.ts`, inside `providers`)

Same zod object for both ids, built by one helper `localProviderSchema(defaults)`:

```ts
// providers.gufo / providers.strata
{
  enabled: z.boolean().default(true),
  /** 127.0.0.1:<port> is where the proxy sends requests and where the launcher probes /v1/models. `{port}` in `args` is replaced with it. */
  port: z.number().int().min(1).max(65535).default(<8081 | 8080>),
  command: z.string().default(<see below>),
  /** One command-line string, passed to cmd.exe as written after the quoted command. */
  args: z.string().default(<see below>),
  cwd: z.string().default(<see below>),
  apiKey: z.string().optional(),            // secret: add both to mapSecrets
  maxConcurrent: z.number().int().min(0).default(1),
}
```

Defaults (confirmed paths, research A):

| id | command | args | cwd | port |
|---|---|---|---|---|
| gufo | `D:\Gufo\gufo.cmd` | `serve llm --model qwen27-q4 --speculative dflash2 --dflash-model D:\Gufo\models\qwen27-q4\Qwen3.8-27B-DFlash2-Q4_K_M.gguf --port {port} --context 32768` | `D:\Gufo` | 8081 |
| strata | `D:\Strata\terminal\run-unsloth-ud-iq4_xs.bat` | `` (empty; the bat has port 8080 baked in) | `D:\Strata` | 8080 |

`SettingsPatch` already allows a partial `providers.gufo` (keys are depth 3). `mapSecrets` (settings.ts:151-161) gets `[copy.providers.gufo, "apiKey"], [copy.providers.strata, "apiKey"]`.

### C2 IPC contract (`src/shared/ipc.ts`, types only)

```ts
export type LocalServerId = "gufo" | "strata";
export type LocalServerState = "stopped" | "starting" | "ready" | "error";
export interface LocalServerStatusView {
  id: LocalServerId;
  name: string;                 // "Gufo" | "Strata"
  state: LocalServerState;
  port?: number;                // of the last start
  pid?: number;                 // while the process lives
  startedAt?: number;           // epoch ms of the last spawn
  readyAt?: number;             // epoch ms the probe first answered 200
  error?: string;               // set in state "error"
  commandLine?: string;         // what was run (no secrets: apiKey is never put on the command line)
  log: string[];                // last lines, oldest first, at most 200, ANSI codes stripped
}
export interface LocalProviderSettingsView { enabled: boolean; port: number; command: string; args: string; cwd: string; apiKey?: string; maxConcurrent?: number }
// SettingsView.providers gets:   gufo: LocalProviderSettingsView; strata: LocalProviderSettingsView;
// SettingsPatchView.providers gets: gufo?/strata?: { [K in keyof LocalProviderSettingsView]?: LocalProviderSettingsView[K] | null }
// ProxyApi gets:
getLocalServers(): Promise<LocalServerStatusView[]>;                 // invoke "proxy:localServers"
startLocalServer(id: LocalServerId): Promise<ActionResult>;          // invoke "proxy:startLocalServer", id
stopLocalServer(id: LocalServerId): Promise<ActionResult>;           // invoke "proxy:stopLocalServer", id
onLocalServers(callback: (servers: LocalServerStatusView[]) => void): () => void;  // push "proxy:localServers"
```

`getLocalServers` / the push always return both ids, in the order gufo, strata. `startLocalServer` resolves `{ok:true}` once the process is spawned (not when ready); readiness arrives by push. It returns `{ok:false, message}` for an unknown id, an empty command, a missing `cwd`, a port that already answers before the spawn, or a spawn error.

### C3 Provider module (`src/providers/local-openai.ts`)

```ts
export interface LocalOpenAiOptions {
  id: "gufo" | "strata"; displayName: string;            // "Gufo" | "Strata"
  baseUrl: string;                                       // "http://127.0.0.1:<port>/v1"
  apiKey?: string; logger: Logger;
  fetch?: typeof fetch;                                  // default globalThis.fetch (NOT ctx.fetch, see T2)
}
export class LocalOpenAiProvider implements Provider { constructor(options: LocalOpenAiOptions) }
export const gufoRegistration: ProviderRegistration;     // { id: "gufo", displayName: "Gufo", create }
export const strataRegistration: ProviderRegistration;   // { id: "strata", displayName: "Strata", create }
export function notRunningMessage(displayName: string): string; // `${displayName} is not running — start it from the app.`
```

### C4 Launcher module (`src/local-servers.ts`, plain Node, no electron import)

```ts
export const LOCAL_SERVER_IDS: readonly LocalServerId[] = ["gufo", "strata"];
export const LOCAL_SERVER_NAMES: Record<LocalServerId, string> = { gufo: "Gufo", strata: "Strata" };
export interface LocalServerSpec { id: LocalServerId; command: string; args: string; cwd: string; port: number }
/** `"<command>" <args>` with every `{port}` in args replaced by the port. */
export function commandLine(spec: LocalServerSpec): string;
export interface LocalServerDeps {
  spawn?(spec: LocalServerSpec, line: string): ChildProcess;   // default: hidden spawn (below)
  kill?(child: ChildProcess): Promise<void>;                     // default: killProcessTree
  probe?(port: number, signal: AbortSignal): Promise<boolean>;   // default: fetch GET http://127.0.0.1:<port>/v1/models, true on 2xx, 2 s timeout
  pollMs?: number;            // default 1000
  startTimeoutMs?: number;    // default 600_000 (Strata loads 1-3 min)
  maxLogLines?: number;       // default 200
  logger?: Logger;
}
export class LocalServerManager extends EventEmitter {           // emits "change" with LocalServerStatusView[]
  constructor(deps?: LocalServerDeps);
  list(): LocalServerStatusView[];
  start(spec: LocalServerSpec): Promise<void>;   // stops every other running/starting server first (awaited), then spawns; no-op if this id is already starting/ready
  stop(id: LocalServerId): Promise<void>;
  stopAll(): Promise<void>;
}
```

### C5 Playground pure helpers (`src/playground/lib.ts`)

```ts
export type Block = { type: "text"; text: string } | { type: "code"; lang: string; code: string; closed: boolean };
/** Splits text at ``` / ~~~ fences (fence line: up to 3 spaces, 3+ backticks or tildes, optional info string; `lang` = first word of it, lower-cased, "" if none). A fence closes on a line of the same char, at least as long, nothing but spaces after. An unclosed last fence gives `closed: false`. Empty text blocks are left out. */
export function splitBlocks(text: string): Block[];
/** One HTML document from the closed code blocks of one message: html|htm blocks joined, css as <style>, js|javascript|mjs as <script> (each `</script` / `</style` escaped as `<\/script` / `<\/style`). If an html block has </head> / </body>, styles / scripts go before them; otherwise the parts are wrapped in `<!doctype html><html><head><meta charset="utf-8">…</head><body>…</body></html>`. undefined when there is no such block. */
export function previewDocument(blocks: readonly Block[]): string | undefined;
/** ceil(chars / 4), the proxy's estimate. */
export function estimateTokens(text: string): number;
/** tokens per second, or undefined when tokens <= 0 or ms <= 0. */
export function tokensPerSecond(tokens: number, ms: number): number | undefined;
/** Final decode speed: outputTokens / ((totalMs - firstMs) / 1000) when firstMs is known, else outputTokens / (totalMs / 1000); undefined without outputTokens or a positive duration. */
export function decodeRate(meta: { outputTokens?: number; firstMs?: number; totalMs: number }): number | undefined;
/** "45.3 tok/s" (one decimal under 100, none above). */
export function formatRate(rate: number): string;
```

### C6 Preview page protocol (`/playground/preview`)

- Served from `src/playground/preview.html` (new; an inline `<script>` only, no external file) with header `Content-Security-Policy: PREVIEW_CSP` =
  `sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`
  (no hash or nonce: a hash would disable `'unsafe-inline'`). The `sandbox` directive makes the page an opaque origin also when opened as a top-level tab.
- `PLAYGROUND_CSP` changes only by adding `frame-src 'self'`; it keeps `frame-ancestors 'none'`.
- Handshake: on load the preview posts `{ type: "acp-preview-ready" }` to `window.parent !== window ? window.parent : window.opener`. The playground answers that window (matched by `event.source === iframe.contentWindow` or `=== tabHandle`) with `postMessage({ type: "acp-preview-run", html }, "*")` (target `*` because the preview is opaque). The preview accepts only a message whose `event.source` is that same parent/opener and whose `type` and `html` (string) match, sets `window.opener = null`, then `document.open(); document.write(html); document.close();`. It takes one message only.

## Files and modules to touch

| File | Task | Change |
|---|---|---|
| src/settings.ts | T1 | `localProviderSchema`, `providers.gufo`/`providers.strata`, `mapSecrets` |
| src/shared/ipc.ts | T1 | C2 types |
| tests/settings.test.ts | T1 | 1 test |
| src/providers/local-openai.ts (new) | T2 | C3 |
| src/controller.ts | T2 | default registry (controller.ts:89) adds `gufoRegistration, strataRegistration` |
| tests/local-openai.test.ts (new) | T2 | 1 file, 2 tests |
| src/local-servers.ts (new) | T3 | C4 |
| tests/local-servers.test.ts (new) | T3 | 1 test |
| src/electron/main.ts, src/electron/preload.cts | T4 | registry, manager, IPC, quit |
| src/renderer/settings.ts, settings.html, settings.css, usage-view.ts, usage.css | T5 | views, fields, launcher card, series |
| src/playground/lib.ts, playground.ts, playground.css, preview.html (new), src/playground-files.ts, tests/playground.test.ts | T6 | tok/s, blocks, preview |
| README.md, ROADMAP.md | T7 | docs |

`scripts/copy-static.mjs` already copies every .html/.css of src/playground, so `preview.html` needs no build change; `servePlayground` serves only whitelisted names, so it must be added to `FILES` (T6).

## Tasks

Dependencies: **T1 first** (small; everything else compiles against it). Then **T2, T3, T5, T6 in parallel** (disjoint files; T6 does not need T1 at all and may start immediately). **T4 after T1+T2+T3.** **T7 last.**

```
T6 ───────────────────────────────┐
T1 ─┬─ T2 ─┐                      ├─ T7
    ├─ T3 ─┴─ T4 ─────────────────┤
    └─ T5 ────────────────────────┘
```

### T1 Settings schema and IPC types

- Inputs: C1, C2; src/settings.ts:63-111 (schema), :151-161 (mapSecrets); src/shared/ipc.ts:38-64, :140-175.
- Do: add `localProviderSchema` and the two entries with the C1 defaults (Windows paths as JS strings with escaped backslashes). Add the C2 types and `ProxyApi` members verbatim. No env overrides. Keep ipc.ts free of runtime code.
- Test (tests/settings.test.ts, one `it`): `settingsSchema.parse({ providers: { gufo: { port: 9000 } } })` keeps `providers.gufo.port === 9000`, fills the gufo `command`/`args` defaults, and `providers.strata` has port 8080 and the bat command; `mergeSettings(defaults, { providers: { strata: { args: "--x" } } })` keeps `args === "--x"` (proves the keys are no longer stripped).
- Output: `npm run typecheck` will fail in preload.cts until T4 adds the new `ProxyApi` members; that is expected. To keep each slice green, T1 may add the four preload entries itself (`getLocalServers: () => invoke("proxy:localServers")`, `startLocalServer: (id) => invoke("proxy:startLocalServer", id)`, `stopLocalServer: (id) => invoke("proxy:stopLocalServer", id)`, `onLocalServers: (cb) => subscribe("proxy:localServers", cb)`) — then T4 does not touch preload.cts. **Decision: T1 adds them.**

### T2 LocalOpenAiProvider and registrations

- Inputs: C1, C3; `Provider` (src/provider.ts:193-223), `AcpUnavailableError` (provider.ts:23-26), `Message`/`Part` (src/api.ts:103-105), `ProviderRegistration` (src/controller.ts:34-40), router resolve rules (src/router.ts:118-131), server 503 mapping (src/server.ts:420).
- Do, in src/providers/local-openai.ts:
  - `id`, `displayName`, `ownedBy = id`, `exposeUnprefixed = false`, no capability flags (`toolCalling`, `mcpSupport`, `imageGeneration`, `webSearchSupport` absent), no `staticModels`.
  - `listModels()`: `GET <baseUrl>/models` (Authorization `Bearer <apiKey>` when set), map `data[].id` to `ModelInfo`; on success state `ready`; on a connection failure throw `AcpUnavailableError(notRunningMessage(name), cause, "local_server_not_running")` and set state `stopped` with that message as `error`. Emit `onStatus` listeners on every state change.
  - `status()`: `{ id, name, state, error?, authMethods: [], models: <last list>, capabilities: { image: false }, features: { imageGeneration: false, tools: false, mcp: false, webSearch: false } }`; initial state `stopped`.
  - `generate(model, messages, callbacks, signal, options)`: POST `<baseUrl>/chat/completions` with `{ model, messages, stream: true, stream_options: { include_usage: true } }`. Messages: `options.instructions` first as a `system` message; `developer` → `system`; `tool` → `user`; content = `messageText(message)`; `toolCalls` dropped. Read the SSE body (split lines, `data:` payloads, ignore `[DONE]`); each `choices[0].delta.content` → `callbacks.onText(delta)` and appended to `text`; keep `finish_reason`; a chunk with `usage` → `Usage { inputTokens: prompt_tokens, outputTokens: completion_tokens, totalTokens: total_tokens ?? sum }` and `callbacks.onUsage(usage)`. Return `{ text, stopReason, usage }` with `stop` → `end_turn`, `length` → `max_tokens`, anything else → `end_turn`; `usage: null` when none came (the server then estimates).
  - Abort: pass `signal` to fetch; if it aborts return `{ text, stopReason: "cancelled", usage: null }` (as AcpProvider does, src/acp-provider.ts:838).
  - Errors: connection refused / reset / DNS (fetch `TypeError`, `cause.code` in ECONNREFUSED, ECONNRESET, ENOTFOUND, or any fetch failure before a response) → `AcpUnavailableError(notRunningMessage(displayName), error, "local_server_not_running")` and state `stopped`. Non-2xx → `AcpUnavailableError(\`${displayName} answered HTTP ${status}: ${upstream error.message or body slice(0,300)}\`, undefined, "upstream_error")`. An `error` object inside the stream → same `upstream_error`.
  - `login()` no-op; `close()` aborts in-flight requests it owns (keep a Set of AbortControllers) and clears listeners.
  - Registrations: `create({ providerSettings, ctx })` builds `baseUrl = http://127.0.0.1:${port}/v1`, `apiKey`, `logger: ctx.logger.child(id)`. Do **not** pass `ctx.fetch` (Electron's `net.fetch`): Strata refuses a POST that carries a browser `Origin` header (research A, DETAILS.md:727); Node's fetch sends none. Say so in a one-line comment.
  - src/controller.ts:89 default registry → `[codexRegistration, antigravityRegistration, claudeRegistration, gufoRegistration, strataRegistration]`.
- Test (tests/local-openai.test.ts, two `it`s, temp dir `.claude/temp/local-openai-tests`; template: tests/router.test.ts `serve()` + `openai` client):
  1. A fake upstream `http.createServer` answers `GET /v1/models` with `{data:[{id:"Qwen3.8-27B"}]}` and `POST /v1/chat/completions` with three SSE delta chunks ("Hel", "lo", "!"), a finish chunk and a `{choices:[], usage:{prompt_tokens:5, completion_tokens:3, total_tokens:8}}` chunk. Router with `new LocalOpenAiProvider({ id: "gufo", displayName: "Gufo", baseUrl: <fake>/v1, logger })` behind `createProxyServer`; `openai.chat.completions.create({ model: "gufo/Qwen3.8-27B", stream: true, stream_options: { include_usage: true } })` yields text "Hello!" and usage `completion_tokens: 3` (upstream, not the estimate); `/v1/models` lists `gufo/Qwen3.8-27B` and no bare `Qwen3.8-27B`.
  2. A provider `id: "strata"` pointing at a closed port (listen on 0, close, reuse the port): a non-streamed request for `strata/any` gets status 503, `code: "local_server_not_running"`, message `Strata is not running — start it from the app.`
- Output: provider module + registry; `npm test` green.

### T3 LocalServerManager

- Inputs: C2, C4; `killProcessTree` (src/process-tree.ts:5-17); the hidden-spawn pattern (src/acp-provider.ts:391) and the cmd.exe quoting pattern (src/providers/claude.ts:69-72).
- Do, in src/local-servers.ts:
  - Default spawn on win32: `spawn("cmd.exe", ["/d", "/s", "/c", `"${line}"`], { cwd, windowsHide: true, windowsVerbatimArguments: true, stdio: ["ignore", "pipe", "pipe"], env: process.env })` — Node refuses to spawn a `.bat`/`.cmd` directly, so it must go through cmd.exe; `stdin: "ignore"` makes the bat's `if errorlevel 1 pause` return at once. Elsewhere: `spawn("/bin/sh", ["-c", line], { cwd, detached: true, stdio: [...] })` so `killProcessTree` can kill the group.
  - `start(spec)`: refuse an empty command or a `cwd` that does not exist (`fs.existsSync`) by throwing an `Error` with a user-readable message. If this id is `starting`/`ready`, return. `await` stop of every other id that has a child. Probe the port once; if it already answers, throw `Port ${port} already answers (a server started outside the app?). Stop it first.` Spawn, record `pid`, `startedAt`, `commandLine`, state `starting`, emit. Read stdout and stderr line by line (utf8, `\r?\n`, strip ANSI `/\x1b\[[0-9;?]*[A-Za-z]/g`) into the ring buffer; emit `change` at most every 250 ms for log lines. Poll `probe(port)` every `pollMs` while starting; first `true` → `ready`, `readyAt`. Timeout `startTimeoutMs` → kill, state `error` "did not answer on port N within M min".
  - Child `exit`: if a stop was requested → `stopped`; code 0 → `stopped`; else → `error` "exited with code N" plus the last log line. Clear `pid`. A spawn `error` event → `error` with its message.
  - `stop(id)`: mark stop requested, `await kill(child)`, wait for `exit` (max 5 s), state `stopped`. `stopAll()` stops all in parallel.
  - `list()` returns both ids (C4 order) with `LOCAL_SERVER_NAMES`, a copy of the log array.
- Test (tests/local-servers.test.ts, one `it`; test-discipline: exclusivity with a fake process): inject `spawn` that returns `spawn(process.execPath, ["-e", "console.log('up'); setInterval(() => {}, 1000)"], { stdio: ["ignore","pipe","pipe"], detached: process.platform !== "win32" })` and `probe` that resolves true only for a port whose child printed `up` (or simply after spawn); real `killProcessTree`. Start gufo → wait for `ready`; start strata → gufo is `stopped`, its child has exited, strata is `ready`; log of gufo contains `up`; `stopAll()` leaves both `stopped`. `pollMs: 20`.
- Output: module + test; no Electron import (it must run under vitest).

### T4 Electron main wiring

- Inputs: T1 (preload already done), T2 registrations, T3 manager, C2; src/electron/main.ts:61-75 (before-quit), :93 (registry), :185-259 (IPC `handle`, `action`).
- Do:
  - main.ts:93 registry adds `gufoRegistration, strataRegistration`.
  - Create `const localServers = new LocalServerManager({ logger: logger.child?.("local") ?? logger })` in `main()` scope, visible to the before-quit handler (declare `let localServers: LocalServerManager | undefined` next to `controller`).
  - Push: `localServers.on("change", ...)` → throttled (250 ms) `win.send("proxy:localServers", localServers.list())`. When an id turns `ready`, `void proxy.refreshModels(id).catch(() => undefined)` so its models appear.
  - Handlers: `handle("proxy:localServers", () => localServers.list())`; `handle("proxy:startLocalServer", (id) => ...)` validates `id` is `"gufo" | "strata"`, reads `(await proxy.getSettings()).effective.providers[id]`, builds `LocalServerSpec { id, command, args, cwd, port }`, returns `action(() => localServers.start(spec))`; `handle("proxy:stopLocalServer", (id) => ...)` same validation, `action(() => localServers.stop(id))`. The apiKey is never put on the command line.
  - Quit: in the before-quit IIFE run `localServers.stopAll()` in parallel with the controller stop, inside the same 5 s budget (`Promise.all([Promise.race([controller stop, timeout]), Promise.race([localServers?.stopAll(), timeout])])`), so a model server never outlives the app.
- Test: none new (wiring); `npm run typecheck`, `npm run build`, manual checks M1-M5.

### T5 Settings window and usage view

- Inputs: T1 types; src/renderer/settings.ts (Scope :6, fields :52-67, providerOrder :86, views :87, dirty :100, render :366-367, loops :576/:589), settings.html (nav :31-32, views :187-297), settings.css (series vars :9, :25), usage-view.ts:15, usage.css:2-5.
- Do:
  - `Scope` adds `"gufo" | "strata"`; `dirty` gets both; fields `providers.<id>.enabled` (bool), `.port` (number), `.command`, `.args`, `.cwd` (text), `.apiKey` (text, optional), `.maxConcurrent` (number, optional) for both ids.
  - settings.html: nav group `<p class="nav-group">Local models</p>` with `data-view="gufo"` and `data-view="strata"` items (with `nav-dot`); `views` adds both. Each view `id="view-<id>"` with `id="card-<id>"`, `data-provider="<id>"`: head with title, sub "A local model server on this PC, started by this app.", provider badge (`data-role="badge"`), launcher badge (`data-role="server-badge"`), Start and Stop buttons (`data-role="start"`, `data-role="stop"`); a line "Only one local server runs at a time: starting one stops the other."; the fields; Save (`data-role="save"`), Refresh models (`data-role="refresh"`), message line (`data-role="msg"`), error line (`data-role="error"`), models list; a `<pre data-role="log" class="log">` with the last 50 lines (textContent only), scrolled to bottom on update.
  - settings.ts: a `renderLocal(id, current)` (do not reuse `renderProvider`: it renders login and terms parts) for fields, provider badge and models; `renderLocalServers(list)` for launcher badge, Start/Stop enabled state (Start disabled while `starting`/`ready`, Stop disabled while `stopped`), error, pid/ready time, log. Subscribe `api.onLocalServers(renderLocalServers)` and call `api.getLocalServers()` at init. Start: if the scope is dirty, `await saveScope(id)` first, then `api.startLocalServer(id)`; show `{ok:false}` messages with `flash(msg, message, true)`. Nav dots: provider state from `status.providers`, overridden by launcher state `starting`/`error` when present. Do not add the local ids to the existing login/terms loops.
  - Badge classes: `starting` already `info`; `ready` `ok`; `error` `err`; `stopped` plain.
  - Usage: `KNOWN_SERIES` adds `"gufo", "strata"`; usage.css `.series-gufo`, `.series-strata`; settings.css `--series-gufo` / `--series-strata` in both the light and the dark block (pick two colours distinct from the existing four).
- Test: none new (DOM); `npm run typecheck`; existing tests/desktop-views.test.ts must stay green.

### T6 Playground: tok/s, code blocks, preview

- Inputs: C5, C6; src/playground/playground.ts (Meta :5, renderMessage :117-161, send :183-232, readStream :234-263), lib.ts, playground.css, src/playground-files.ts (FILES :8-13, CSP :17, send headers), tests/playground.test.ts.
- Do:
  - lib.ts: the C5 functions.
  - playground-files.ts: `FILES` gets `"preview": "preview.html"`; export `PREVIEW_CSP` (C6); `PLAYGROUND_CSP` adds `frame-src 'self'`; the `send` helper uses `PREVIEW_CSP` for the preview file, `PLAYGROUND_CSP` for everything else (including 404/405 answers).
  - preview.html (new): minimal doc, inline script implementing the C6 handshake; body text "Waiting for code…".
  - playground.ts, rendering: an assistant message with `meta` renders `splitBlocks(content)`: text blocks as `div.text` (textContent, pre-wrap as now), code blocks as `<figure class="code">` with a lang label and `<pre><code>` (textContent). Keep the no-innerHTML rule everywhere. While a message is pending (streaming) keep today's plain-text update path unchanged.
  - Preview: when `previewDocument(splitBlocks(content))` is defined for a finished assistant message, show a bar with **Run** and **Open in new tab**. Run creates (or replaces) `<iframe class="preview" sandbox="allow-scripts" src="/playground/preview" title="Preview">` below the message and answers its ready message with the document (C6); a **Close** button removes it. Open in new tab: `const tab = window.open("/playground/preview", "_blank")` (no `noopener`, the handle is needed), answer its ready message. One global `message` listener keyed by source window; drop entries when answered. Never run on render, only on click.
  - tok/s: during streaming, a `span.rate` in the pending message shows `~${formatRate(tokensPerSecond(estimateTokens(answer.content), now - started - firstMs))}` updated at most every 250 ms after the first token. Meta line on completion: rename `first token X` to `TTFT X`; add `formatRate(decodeRate(meta))` after the token counts when defined (computed at render time, so old history entries get it too; no change to the stored `Meta`).
  - playground.css: styles for `.code`, `.preview` (width 100%, height 360px, border), `.rate`, the preview bar.
- Tests (tests/playground.test.ts; extend, do not duplicate):
  1. In "playground helpers", one new `it` for `splitBlocks`: text + closed `html` block + text + closed `css` + unclosed `js` → the right block list with `lang`, `closed`; and `previewDocument` of the closed html+css+js blocks of a message contains the html, a `<style>`, a `<script>` with `</script` escaped, and returns undefined for a message with only a `python` block.
  2. In "playground helpers", one new `it` for rates: `decodeRate({ outputTokens: 100, firstMs: 1000, totalMs: 3000 }) === 50`; `decodeRate({ outputTokens: 100, totalMs: 2000 }) === 50`; `decodeRate({ totalMs: 2000 })` undefined; `tokensPerSecond(estimateTokens("x".repeat(400)), 2000) === 50`.
  3. Update "serves the page and its fixed files with a strict CSP": write a `preview.html` into the temp dir; `/playground/preview` → 200 with `content-security-policy === PREVIEW_CSP`; assert `PLAYGROUND_CSP` contains `frame-src 'self'` and `frame-ancestors 'none'`, and `PREVIEW_CSP` starts with `sandbox allow-scripts` and contains `connect-src 'none'`.
- Output: no proxy (server.ts) change.

### T7 Docs

- Inputs: everything above.
- Do: README.md — "Models and providers" (`gufo/`, `strata/`, OpenAI-compatible upstream, text only, `local_server_not_running`), a new "Local model servers (Gufo, Strata)" section (settings keys, `{port}`, one at a time, hidden, stopped on quit, `--open` in the Strata bat opens a browser tab), "Playground" (TTFT, tok/s definition and that ACP usage may be an estimate, Run/Open in new tab, sandbox and CSP). ROADMAP.md: a `[x] (AAP-35 ...)` line with UNTESTED live checks as they stand.

## Acceptance criteria

| # | Criterion | Proof |
|---|---|---|
| A1 | `gufo/<model>` streams through the proxy with upstream usage; models listed prefixed only | T2 test 1 |
| A2 | Unreachable server → 503 `local_server_not_running`, "Strata is not running — start it from the app." | T2 test 2 |
| A3 | Settings accept and keep `providers.gufo` / `providers.strata` with the C1 defaults | T1 test |
| A4 | Starting one server stops the other; log lines kept; stopAll stops all | T3 test |
| A5 | `splitBlocks` handles closed/unclosed fences and langs; html+css+js combine into one document | T6 test 1 |
| A6 | Decode tok/s and live estimate computed as defined | T6 test 2 |
| A7 | Preview page served with its own sandboxed CSP; playground CSP allows only same-origin frames and keeps `frame-ancestors 'none'` | T6 test 3 |
| A8 | Gufo/Strata appear in the settings nav, Usage view colours, tray provider lines, playground model list | M2, M6 |
| A9 | Whole suite, typecheck and build green | `npm test`, `npm run typecheck`, `npm run build` |

## Manual verification (only the real app shows these)

- M1 Start Gufo from its view: no console window appears; `gufo.exe` runs under the app (Task Manager); state goes `starting` → `ready` and log lines stream in.
- M2 With Gufo ready, the playground model list shows `gufo/Qwen3.8-27B`; a chat streams, the meta line shows TTFT, real token counts and a tok/s near the measured ~45 tok/s (DFlash2); live `~N tok/s` shows while streaming.
- M3 Start Strata while Gufo runs: Gufo goes `stopped` and `gufo.exe` is gone; Strata reaches `ready` within a few minutes; `strata/<model>` answers. Note whether its `--open` opened a browser tab and whether the python child and engine processes all die on Stop (taskkill /T reaches only descendants; Strata's procs\*.json show it may start an engine and a vision process).
- M4 Quit the app from the tray with a server running: no `gufo.exe` / Strata python or engine process is left.
- M5 Stop both, send to `gufo/...` from the playground: the error reads "Gufo is not running — start it from the app."
- M6 Ask a model for "a single html page with a button that changes colour, with css and js in separate blocks": Run shows a working page under the message; Open in new tab works; in the preview's devtools `localStorage` access throws (opaque origin) and `fetch("/v1/models")` is blocked by CSP.
- M7 CSP: in the playground devtools console, `document.body.append(Object.assign(document.createElement("iframe"), { src: "https://example.com" }))` is blocked by `frame-src`; loading `/playground` itself inside an iframe from another page is refused (`frame-ancestors 'none'`).

## How to run

`npm test`, `npm run typecheck`, `npm run build` (CI uses yarn: same scripts). If `node`/`npm` is not on PATH: `fnm exec --using default npm test` (and the same for the others). Tests write only under `.claude/temp/<name>-tests`.

## Assumptions to confirm

1. `enabled` defaults to **true** for both (so their models are listed once a server ran; an unreachable server is a cheap ECONNREFUSED). Say if they should be off by default.
2. `args` is one string with a `{port}` placeholder, not an array; the Strata bat has its own port 8080 baked in, so the `port` setting must match it.
3. Strata default is `run-unsloth-ud-iq4_xs.bat` (the measured UD-IQ4_XS pack). Its `--open` flag opens a browser tab on start; pointing `command` at the venv python with the bat's arguments minus `--open` avoids that.
4. A server already answering on the port before Start is refused with a message, not adopted.
5. The provider uses Node's fetch, not Electron's `net.fetch` (Strata's Origin check).
6. Ready = `GET /v1/models` 200 for both; Strata may answer while its model shows `unloaded`, and the first request then waits for the load (proxy `timeoutMs` 5 min).
7. Code blocks are rendered only after an answer finishes; streaming stays plain text.

## Implementation status (2026-11-20, implement)

- [x] T1 settings schema and IPC types (+ preload entries) - settings test green
- [x] T2 LocalOpenAiProvider and registrations - 2 tests green. Deviation: tests/controller.test.ts `make()` now disables gufo/strata and its provider-list assertion includes them as disabled (the new default registrations broke it; disabling keeps the test from probing ports 8080/8081 on this machine)
- [x] T3 LocalServerManager - 1 test green (3 runs). Details left open by C4: `start` claims `starting` synchronously and reverts to `stopped` if a pre-spawn check throws; signal exit reads "exited with signal X"; `commandLine` has no trailing space for empty args
- [x] T4 Electron main wiring - typecheck/build green; runtime UNTESTED (M1-M5)
- [x] T5 settings pages and usage colours - typecheck, desktop-views green; DOM UNTESTED. Additions: apiKey Show/Hide button, `server-info` line (pid, port, ready time, command line), `.log` style, Enabled switch in the header
- [x] T6 playground tok/s, code blocks, preview - 3 test changes green; browser behaviour UNTESTED (M2, M6, M7). Addition: `send` helper takes an optional csp argument
- [x] T7 README and ROADMAP
- Verification: `npm test` 35 files / 472 passed / 1 skipped; `npm run typecheck` clean; `npm run build` clean. M1-M7 not run.
