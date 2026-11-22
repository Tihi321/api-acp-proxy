---
status: done
request: creative-hub/REQ-0030
repos: [api-acp-proxy]
branch: AAP-47_monitor-about
updated: 2026-11-22
---

# AAP-47 A read-only Monitor page and an About page for the local model the proxy holds

Hub ticket: creative-hub HUB-42 (`C:\projects\Personal\creative-hub\.claude\tickets\HUB-42-pending-ideas-and-proxy-monitor\plan.md`, part B), request REQ-0030. The user asked on 2026-11-22 to add "some of these strata pages" to the proxy app, with screenshots of Strata's own Monitor and About pages. Reading (the director's): a read-only Monitor page and an About page for whichever local model the proxy holds (Strata, Gufo or a Llama.cpp profile such as Inkling, or none); no chat; a tile only where an honest data source exists. Checked on master ce7817f (2026-11-22); depends on AAP-46 being merged first (both add a ROADMAP and README line).

Do not touch the user's `%APPDATA%\api-acp-proxy\settings.json`; this ticket adds no setting. The desktop proxy runs from this repo's `dist/` and is running: run `yarn test` and `yarn typecheck` only; no `yarn build`, no restart (hub K1 does both after the merge with the user's go-ahead). Leave the two uncommitted AAP-43 files out of every commit.

Commands (Bash: `export PATH="/c/Users/Infplane/AppData/Roaming/fnm/aliases/default:$PATH"` first): test `yarn test`; typecheck `yarn typecheck` (node and renderer configs); build `yarn build` (not in this ticket); no lint script.

## What the app already has (reuse, do not duplicate)

- **Recent requests**: `ActivityLog` (`src/activity.ts`), in memory, at most 100, metadata only (never prompt, answer, header or key), pushed to the window as `proxy:activity` (50 newest, `src/electron/main.ts:243-248`) and shown on the Requests page (`settings.html:115-131`, `settings.ts:533`). Fields: time, endpoint, model, provider, stream, features, durationMs, status, error, inputTokens, outputTokens, estimated.
- **Local servers**: `servers.list()` (`LocalServerStatusView`, `src/shared/ipc.ts:93-107`: id, state, port, profile, pid, startedAt, readyAt, error), pushed as `proxy:localServers`; one exclusive server (gufo, strata, llama) at a time plus the `embed` server.
- **Queues**: `ProviderRouter.queueStats()` (`src/router.ts:305`): per provider `{active, queued, limit, maxQueue}` (also `/healthz`).
- **Connect**: the Overview's Connect card shows the API address with Copy (`settings.html:54-67`).

## Data sources (verified 2026-11-22 by read-only GETs; no model was called)

| source | endpoint | fields used (units) | verified |
|---|---|---|---|
| Strata (8080) | `GET /metrics` (Strata's UI polls it every 1 s, `web/app.js:194,201`; needs Strata's API key when Strata has one, `D:\Strata\.github\SECURITY.md:25-27`) | `engine.version` ("0.1.52"), `engine.context` (131072 tokens), `engine.images` (bool), `engine.kv` ("int8"), `engine.kv_resident` (32768 positions), `engine.expert_slots` (24576), `engine.expert_cache_mib` (MiB), `engine.drafting` ("mtp"); `live.state` ("idle", also "reading", "generating", "queued", "unloaded", "error" per its UI), `live.queued`, `live.slots[]` `{slot, state, held_tokens}`; `totals` `{requests, prompt_tokens, reused, output_tokens, prompt_ms, decode_ms}`; `requests[]` `{time (epoch s), duration_s, finish, prompt_tokens, reused, output_tokens, prompt_read, prompt_ms, decode_tok_s}`; `hardware` `{gpu_util (%), gpu_temp (degC), gpu_power (W), gpu_mem_used (bytes), gpu_mem_total (bytes), cpu (%), ram_used, ram_total (bytes), disk_read_mb (MB/s)}`; `hardware_static` `{gpu_name, cpu_name, threads}` | yes (sample in the test below) |
| Strata | `GET /health` | `images`, `max_context`, `model`, `loaded` | yes (not needed: `/metrics` has them) |
| llama-server (8082 chat, 8083 embed) | `GET /props` | `build_info` ("b12613-362ac9297"), `model_alias`, `total_slots`, `modalities.vision` (bool) | yes, on 8083 (same binary as 8082; 8082 was down) |
| llama-server | `GET /slots` | per slot `id`, `n_ctx` (tokens per slot), `is_processing`, `n_prompt_tokens` | yes, on 8083 (it also has `params` and `next_token`, which are not read) |
| llama-server | `GET /metrics` | - | needs `--metrics`, which `src/llama-args.ts` does not pass (8083 answers 501) |
| Gufo (8081) | - | none known: the proxy only probes `/v1/models` for readiness (`src/settings.ts:15`); no docs on disk (`D:\Gufo\v0.35.0` has none), Gufo was not running | UNVERIFIED |
| the proxy | `servers.list()`, `router.queueStats()`, `ActivityLog`, settings | as listed above | in the code |
| this PC | Node `os` in the main process | `os.cpus()[0].model`, `os.cpus().length`, CPU % from the difference of `os.cpus()` times between two calls, `os.totalmem()`, `os.freemem()` (bytes) | Node API, no new dependency |

## Tiles: built, and left out

Monitor page:
1. **Model state** (all servers): the loaded model (`<server>/<model>` id, the profile label), the launcher state (starting, ready, error with its message), since (`readyAt`), port; the engine state pill for Strata (`live.state`) and Llama ("busy" when any slot `is_processing`, else "idle"); the proxy queue for that provider (`active` / `limit`, `queued`). "No local model loaded" when no exclusive server is starting or ready.
2. **Speed** (Strata): decode = `totals.output_tokens / (totals.decode_ms / 1000)`; prefill = `(totals.prompt_tokens - totals.reused) / (totals.prompt_ms / 1000)` (checked against the screenshot: 2 / 0.1222 s = 16.4 t/s, 16 / 0.3586 s = 44.6 t/s). Llama: a dash (no timings without `--metrics`).
3. **Prompt reused** (Strata): `totals.reused` of `totals.prompt_tokens` and the percentage (the number that answers HUB-42 P17).
4. **Slots / context fill** (Strata and Llama): per slot busy or idle and tokens held (Strata `held_tokens` of `engine.context`; Llama `n_prompt_tokens` of `n_ctx`).
5. **GPU load, VRAM, GPU temp, Power, Disk read** (Strata only; a dash with "from Strata" otherwise): `hardware.gpu_util`, `gpu_mem_used`/`gpu_mem_total`, `gpu_temp`, `gpu_power`, `disk_read_mb`.
6. **CPU and RAM** (always, from `os`).
7. **Engine requests** (Strata): the last 12 of `requests[]`, newest first: time, finish, prompt, reused, output, prefill t/s (`prompt_read / (prompt_ms / 1000)`), decode t/s, duration.
8. **Proxy requests to local models**: the window's existing activity list filtered to providers `gufo`, `strata`, `llama` (at most 12): time, model, status, input, output tokens, took, overall t/s (`outputTokens / (durationMs / 1000)`, labelled "overall, includes reading the prompt"), with "Open Requests" to the existing page.

About page:
- **Model and engine**: model id, engine (Strata "Strata 0.1.52"; Llama "llama.cpp b12613-..."; Gufo "Gufo" and the profile id), context (Strata `engine.context`; Llama `n_ctx` per slot times slots; Gufo from the profile's `--context N` in its args, labelled "from the profile"), images (Strata `engine.images`; Llama `modalities.vision`; Gufo the profile's `vision`), KV cache and experts in VRAM (Strata only), speculation (Strata `engine.drafting`; Llama the profile's `specType`).
- **This PC**: GPU (Strata `hardware_static.gpu_name` and `gpu_mem_total` when Strata is loaded, else a dash), CPU (`os` model and threads), RAM (`os.totalmem`).
- **Connect your tools**: OpenAI base URL (`status.server.baseUrl`, e.g. `http://127.0.0.1:8787/v1`) with Copy; one line "Anthropic-compatible URL: not served (this proxy speaks the OpenAI API: chat completions, responses, images, embeddings)" (verified: `ENDPOINTS`, `src/server.ts:495`, has no `/v1/messages`); the local model ids as `GET /v1/models` lists them (`<provider>/<model>`, `src/router.ts:186-189`), each with Copy; "API key: needed" or "not needed" from whether `server.apiKey` is set (the value is never sent to the window).

Left out, with the reason: **PCIe** (Strata reports `gpu_pcie_bottleneck: null` and no PCIe rate on this PC; its own tile shows a dash); **sparklines** (second cut); **Llama speed and hardware** (no source without `--metrics`; adding the flag is a second cut); **Gufo engine state, speed, slots, version** (UNVERIFIED endpoint); **reasoning tokens per request** (not in `ActivityEntry`; second cut); **Strata's "Experts" page, Unload and Load buttons** (not read-only); **conversation cache detail** (beyond the reused total; second cut).

## Contracts

New types in `src/shared/ipc.ts` (types only):
```ts
/** One engine request as Strata reports it: counts and timings only. */
export interface EngineRequestView { time: number /* epoch ms */; durationS: number; finish?: string; promptTokens: number; reused: number; outputTokens: number; prefillTokS?: number; decodeTokS?: number }
export interface EngineSlotView { id: number; busy: boolean; tokens: number; ctx?: number }
export interface EngineView {
  kind: "strata" | "llama";
  version?: string;
  state: "idle" | "reading" | "generating" | "queued" | "unloaded" | "busy" | "error" | "unknown";
  context?: number;               // tokens (Strata: engine.context; llama: n_ctx of slot 0 times the slot count)
  images?: boolean;
  slots: EngineSlotView[];
  speed?: { decodeTokS?: number; prefillTokS?: number };
  reuse?: { reused: number; prompt: number; requests: number };
  strata?: { kv?: string; kvResident?: number; expertSlots?: number; expertCacheMiB?: number; drafting?: string };
  hardware?: { gpuName?: string; gpuUtilPct?: number; gpuMemUsedBytes?: number; gpuMemTotalBytes?: number; gpuTempC?: number; gpuPowerW?: number; diskReadMBs?: number };
  requests: EngineRequestView[];  // newest first, at most 12
}
export interface MonitorView {
  at: number;                     // epoch ms
  local: {
    server?: "gufo" | "strata" | "llama";   // the exclusive server starting or ready; absent = none loaded
    state: "none" | "starting" | "ready" | "error";
    profile?: string; label?: string; modelId?: string /* <server>/<model> */;
    port?: number; startedAt?: number; readyAt?: number; error?: string;
    queue?: { active: number; queued: number; limit: number };
    profileFacts?: { context?: number; vision?: boolean; specType?: string };  // gufo/llama, from settings
  };
  engine?: EngineView;            // absent for gufo, when none is loaded, or when the engine did not answer
  engineError?: string;           // "not reachable", "HTTP 401", "unexpected answer"
  host: { cpuName: string; threads: number; cpuPct?: number; ramUsedBytes: number; ramTotalBytes: number };
  connect: { baseUrl?: string; apiKeyNeeded: boolean; localModelIds: string[] };
}
```
`ProxyApi` gains `getMonitor(): Promise<MonitorView>;` (doc: "Read-only snapshot for the Monitor and About pages; reads the loaded local server's status endpoints on 127.0.0.1 with a 1.5 s timeout.").

IPC: one new invoke channel `proxy:monitor` (registered with the existing `handle`, which refuses other callers, `main.ts:301`); preload `getMonitor: () => invoke("proxy:monitor")`. No push channel: the page polls.

New module `src/local-monitor.ts` (plain Node, no Electron import, unit-tested):
- `mapStrataMetrics(json: unknown): EngineView` and `mapLlama(props: unknown, slots: unknown): EngineView`: whitelist mapping (read only the fields above; a missing or wrong-typed field becomes `undefined`; never copy a string field other than `version`, `state`, `finish`, `kv`, `drafting`, `gpu_name`); `requests` sorted newest first, cut to 12.
- `fetchEngine(server, port, apiKey, fetchImpl, timeoutMs = 1500): Promise<{ engine?: EngineView; error?: string }>`: Strata `GET http://127.0.0.1:<port>/metrics` with `Authorization: Bearer <key>` when Strata's settings have a key; Llama `GET /props` and `GET /slots`; Gufo: returns `{}` (no request). Only `127.0.0.1` and the configured port.
- `cpuSampler()`: returns a function that gives the CPU % since its previous call (undefined on the first).

Main (`src/electron/main.ts`): `handle("proxy:monitor", ...)` builds `MonitorView` from `servers.list()` (exclusive entry in `starting`/`ready`, else the newest `error`), the cached effective settings (`gufoSettings`, `strataSettings`, `llamaSettings`, `main.ts:124-130`) for port, key, profile label/model/vision/specType/context, `proxy.queueStats()` (new pass-through on the controller: `queueStats(): Record<string, LimiterStats> { return this.running?.router.queueStats() ?? {}; }`), `fetchEngine` for strata or llama when ready, `os`, the server status and the models of `gufo`/`strata`/`llama` in the status for `connect`.

Renderer: new `src/renderer/monitor-view.ts` with `initMonitorView({ api, showView, activity: () => ActivityView[] })` returning `{ shown(view: "monitor" | "about"): void; hidden(): void }`. Polling: `setTimeout` loop every 2000 ms, only while the Monitor or About view is shown and `document.visibilityState === "visible"`; a `visibilitychange` listener resumes it; `hidden()` (called by `showView` for any other view) stops it. A failed call shows "Engine not reachable" on the engine tiles and keeps polling.

## Files to touch (first cut: 12 files, about 800 lines)

| file | change | rough lines |
|---|---|---|
| `src/local-monitor.ts` | new: mappers, `fetchEngine`, `cpuSampler` | 170 |
| `src/shared/ipc.ts` | the types above, `getMonitor` in `ProxyApi` | 45 |
| `src/controller.ts` | `queueStats()` pass-through | 3 |
| `src/electron/main.ts` | `handle("proxy:monitor", ...)` | 40 |
| `src/electron/preload.cts` | `getMonitor` | 1 |
| `src/renderer/monitor-view.ts` | new: render both pages, polling | 260 |
| `src/renderer/settings.ts` | `views` (`:112`) gains `"monitor"`, `"about"`; `showView` (`:158-167`) calls `monitor.shown(target)` / `monitor.hidden()`; pass the current `activity` getter | 12 |
| `src/renderer/settings.html` | two nav items after Requests (`:27`): `data-view="monitor"` "Monitor", `data-view="about"` "About"; two `section.view` blocks after the Requests view (`:131`), in the existing card, `stats`, `table` and `badge` markup | 70 |
| `src/renderer/settings.css` | tile grid and slot bar classes in the existing tokens (`--surface`, `--border`, `--ok`, `--warn`) | 45 |
| `tests/local-monitor.test.ts` | new, inline JSON samples | 120 |
| `README.md` | "Monitor and About pages" paragraph in "Desktop app (Windows)" (after the Overview paragraph) | 8 |
| `ROADMAP.md` | one line after AAP-46's | 1 |

Exact README text: "**Monitor and About pages (AAP-47).** Read-only views of the local model the proxy holds. Monitor: the model and its state, the proxy queue, speed, prompt reuse, slots, GPU, VRAM, temperature, power and disk (from Strata's own `/metrics`; a dash for Llama.cpp and Gufo), CPU and RAM of this PC, Strata's last requests and the proxy's requests to local models (counts and timings only, never text). About: model, engine, context, images, this PC, and the base URL and model ids to give your tools. The pages read the local server every 2 s while they are open and stop when the window is hidden; nothing new listens on the network."

Exact ROADMAP line: `- [x] Monitor and About pages for the loaded local model (AAP-47; creative-hub HUB-42; live check UNTESTED, hub K1): read-only, from the local server's own status endpoints (Strata /metrics, llama-server /props and /slots), the launcher and the activity log; Gufo shows only what the proxy knows.` And a new open line after the Gufo follow-ups line: `- [ ] Monitor second cut: sparklines (Strata's own 60-point history), reasoning tokens per request in the activity log, llama-server --metrics for speed, Gufo status once its endpoints are known, a local server started outside the app.`

## Security and privacy

- Read-only: only GETs, to `127.0.0.1:<configured port>` of the loaded server; no Load/Unload, no settings write.
- No prompt or answer text: the mappers whitelist numeric and enum fields (Strata's `requests[]` has none; llama `/slots` `params`/`next_token` are not read). Tested.
- Strata's API key (when set) goes only in the request header from the main process; the window gets `apiKeyNeeded: boolean` for the proxy's own key and never a key value. Tested by a key-value-not-in-output assertion.
- Nothing new listens; no new setting, so `settings.json` loads unchanged from an old file and is not written by this feature.
- No new dependency.

## Tasks for workers

1. **Core** (one worker): `src/local-monitor.ts`, `ipc.ts` types, `controller.ts`, the tests. Output: `yarn test` green. Contract to task 2: the `MonitorView` type and `fetchEngine`.
2. **Window** (same or second worker, after 1): `main.ts`, `preload.cts`, `monitor-view.ts`, `settings.ts`, `settings.html`, `settings.css`, README, ROADMAP. Output: `yarn typecheck` green; the pages follow the existing view markup (`view-head`, `card`, `card-head`, `stats`, `table-wrap`), no inline styles (the page's CSP has `style-src 'self'`).
Commit on `AAP-47_monitor-about` (`AAP-47: Monitor and About pages for the loaded local model`), `changelog.md` in this folder with the test count and the UNTESTED list.

## Tests (test-discipline: one new file, four tests)

`tests/local-monitor.test.ts`, with recorded samples inline (copied from the 2026-11-22 reads, trimmed: Strata `/metrics` with `engine`, `live`, `totals`, `requests` (13 entries, to prove the cut), `hardware`, `hardware_static`, plus an extra unknown string field `projection: "SECRET-TEXT"` on a request; llama `/props` and `/slots` from 8083 with a `prompt: "SECRET-TEXT"` field added to one slot):
1. Strata mapping: state, version, context, images, slots, speed (16.4 and 44.6 from the totals), reuse, hardware, `requests` newest first and 12 long; `JSON.stringify(view)` does not contain `SECRET`.
2. Llama mapping: version from `build_info`, images from `modalities.vision`, slots busy/tokens/ctx, state "busy" when one slot processes; no `SECRET` in the output.
3. `fetchEngine` with a fake fetch: Strata sends the bearer key and the key's value is not in the result; an unreachable port gives `error: "not reachable"` and no engine; Gufo makes no request.
4. "No local model loaded": the `local` part built from a server list with only `embed` ready (export the small `localState(list)` helper from `local-monitor.ts` for this) is `{ state: "none" }`.

The bounded request history is covered by test 1 (engine requests cut to 12); the proxy's own history bound (100) is already `ActivityLog`'s and tested in `tests/activity.test.ts`.

## Acceptance criteria

| # | criterion | proof |
|---|---|---|
| M1 | Strata's status maps to the view, text never passes | test 1 |
| M2 | llama-server's status maps to the view, text never passes | test 2 |
| M3 | keys stay in main; unreachable and Gufo are honest | test 3 |
| M4 | none loaded shows "No local model loaded" | test 4 |
| M5 | types and renderer compile | `yarn typecheck` |
| M6 | nothing else breaks | `yarn test` |
| M7 | the pages show the loaded model and stop polling when hidden | hub K1 (a person reads the tiles); polling stop by code review |

## UNTESTED

- The window itself (no Electron test harness): layout, polling start/stop, copy buttons, the About numbers; hub K1 proves them by a person reading the tiles after `yarn build` and a restart.
- Llama's chat server on 8082 (its endpoints were read on the embedding server 8083, same build).
- Gufo (no running server, no docs).
- Strata with an API key set (the key header path is unit-tested only).

## Second ticket (not in this cut)

Sparklines from Strata's `history` (60 points: `gpu_util`, `gpu_mem_used`, `gpu_temp`, `gpu_power`, `cpu`, `ram_used`, `disk_read_mb`, `tok_s`, `prefill_tok_s_mean`); reasoning tokens in `ActivityEntry` (`src/activity.ts`, `src/server.ts` trace) and a column; `--metrics` for llama-server and its speed; Gufo once its status endpoint is known; detecting a local server started outside the app (`LocalModelHost.external`); Strata's conversation-cache detail.
