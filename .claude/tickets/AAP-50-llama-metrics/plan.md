---
status: done
request: creative-hub/REQ-0030
repos: [api-acp-proxy]
branch: AAP-50_llama-metrics
updated: 2026-11-22
---

# AAP-50 llama-server `--metrics`: the Monitor shows speed for a Llama.cpp model such as Inkling

Hub ticket: creative-hub HUB-43 (`C:\projects\Personal\creative-hub\.claude\tickets\HUB-43-open-ideas\plan.md`, triage item 1c and open question 4: "its own small proxy ticket after AAP-49"), request REQ-0030. This turns AAP-49's "Next cut (not in this ticket): `--metrics` for llama-server" (`.claude/tickets/AAP-49-monitor-second-cut/plan.md`) into a plan; the Monitor contracts, the whitelist rule and the tile list are AAP-47's (`.claude/tickets/AAP-47-monitor-about/plan.md`).

Checked on 2026-11-22 against master 23cf725 (`git show master:<path>`; AAP-48 and AAP-49 had no branch yet), the two installed llama.cpp builds (`--version` and `--help` only, no server started), their `llama-server-impl.dll` strings, the vendored source `D:\Strata\third_party\llama.cpp` (Strata's copy, not the same commit as either build), and read-only GETs to the embedding server on 8083 (`/props`, `/slots`, `/metrics`). 8082 was down (no chat model loaded); no model was called.

Notes for workers:
- The desktop proxy runs from this repo's `dist/` and is RUNNING. No `yarn build` on this branch: tests and typecheck only. Hub R1 builds and restarts after the merge, with the user's go-ahead.
- Cut `AAP-50_llama-metrics` from the head of `AAP-49_monitor-second-cut` (after AAP-49's commit; AAP-49 is cut from AAP-48). Merge order: AAP-48, AAP-49, AAP-50. This ticket uses AAP-49's `MonitorView.local.external` and edits the same two files as AAP-49 (`src/local-monitor.ts`, `tests/local-monitor.test.ts`) in different functions and tests (named below), so it applies on top without conflict.
- The user's `%APPDATA%\api-acp-proxy\settings.json` is never edited. This ticket adds no setting: an old settings file loads unchanged.
- Leave the two uncommitted AAP-43 files (`.claude/tickets/AAP-43-local-embeddings/events.jsonl`, `plan.md`) out of every commit.
- Commands (Bash: `export PATH="/c/Users/Infplane/AppData/Roaming/fnm/aliases/default:$PATH"` first): test `yarn test`; typecheck `yarn typecheck` (after AAP-48: node, renderer and tests configs); build `yarn build` (NOT in this ticket); no lint script.
- No Electron test harness exists: the renderer part is UNTESTED until hub K1.

## Verified facts (evidence)

| fact | evidence |
|---|---|
| The proxy runs ggml-org b12613 today | managed binaries live in `<binary.dir>/<source>-<tag>-<backend>/` (`src/settings.ts:209-213`, default dir `D:\LlamaCpp\bin`). `D:\LlamaCpp\bin` holds `ggml-org-b12613-rocm` and `unsloth-b12588-mix-c0c3de8-rocm-gfx1151`. The running embedding server's command line (Win32_Process) is `"D:\LlamaCpp\bin\ggml-org-b12613-rocm\llama-server.exe" -m "...nomic-embed-text-v1.5.Q4_K_M.gguf" --host 127.0.0.1 --port 8083 --alias nomic-embed-text-v1.5 --embedding --pooling mean -c 8192 -b 2048 -ub 2048 -ngl all -np 4`; chat and embedding share one binary (`llamaBinary(llama)`, `src/electron/main.ts:143,163`). `--version`: `version: 1.0.0-dev (build 12613, commit 362ac9297)`. The unsloth build: `build 12588, commit 883286076` (the DSpark preset needs it, `src/settings.ts:148`). |
| Both builds support `--metrics` | `--help` of b12613 (line 647) and of unsloth b12588 (line 653): `--metrics  enable prometheus compatible metrics endpoint (default: disabled) (env: LLAMA_ARG_ENDPOINT_METRICS)`. No `--no-metrics` flag exists. 8083 answers `GET /metrics` with HTTP 501 `{"error":{"code":501,"message":"This server does not support metrics endpoint. Start it with `--metrics`","type":"not_supported_error"}}`. |
| `/props` says whether metrics are on | 8083 `/props` keys: `default_generation_settings, total_slots, model_alias, model_ftype, model_path, modalities, media_marker, endpoint_slots, endpoint_props, endpoint_metrics, ui, ui_settings, chat_template, chat_template_caps, bos_token, eos_token, build_info, is_sleeping, cors_proxy_enabled`; `endpoint_metrics: false`, `endpoint_slots: true`, `build_info: "b12613-362ac9297"`. |
| Metric names | Both DLLs (`llama-server-impl.dll`) contain exactly these names: counters `prompt_tokens_total`, `prompt_tokens_cached_total`, `prompt_seconds_total`, `tokens_predicted_total`, `tokens_predicted_seconds_total`, `spec_decode_num_draft_tokens_total`, `spec_decode_num_accepted_tokens_total`, `spec_decode_num_drafts_total`, `spec_decode_num_accepted_tokens_per_pos_total`; gauges `prompt_tokens_seconds`, `predicted_tokens_seconds`, `requests_processing`, `requests_deferred`, `n_busy_slots_per_decode`; the prefix `llamacpp:`; and the description "Number of prompt tokens processed, excluding cached tokens". The line format (vendored `tools/server/server-task.cpp:1593-1599`): `# HELP llamacpp:<name> <description>`, `# TYPE llamacpp:<name> counter|gauge`, `llamacpp:<name> <value>`; the only labelled series is `llamacpp:spec_decode_num_accepted_tokens_per_pos_total{position="<n>"} <value>` (`:1607-1613`). README table: vendored `tools/server/README.md:1122-1146`. The exact output of b12613 was not read (no server with the flag runs): hub K1 records it. |
| No prompt text in `/metrics` | every name and description is a fixed string in the source; values are numbers; the one label is a position index. Nothing from a request reaches it. |
| Counters, not gauges | counter `tokens_predicted_seconds_total` = generation time in s, `prompt_seconds_total` = prompt time in s (`server-task.cpp:1534-1546`), plain sums since the server started. The gauges `prompt_tokens_seconds` / `predicted_tokens_seconds` come from a bucket that is reset on every `/metrics` read (vendored `server-common.h:463-465,488-491`, "these are reset by reset_bucket(), only the rate is read from them"; reset on a metrics task, `server-context.cpp:4684-4697`), so the value means "since anyone last read it": 0 between two 2 s polls when idle, and a second reader would steal it. The b12613 DLL has the words "EMA decay" right after the prompt description, so its gauges may be computed differently from the vendored copy: not relied on either way. Strata's tiles use the same kind of number (totals since start, `src/local-monitor.ts:56-59`). |
| Where the flag goes | `buildLlamaArgs` (`src/llama-args.ts:31-51`) builds `-m ... --host 127.0.0.1 --port {port} --alias <model>`, then `-c`, `-ngl`, `-fa`, `--mmproj`, spec flags, and `profile.extraArgs` verbatim last (`:48-49`). `buildEmbeddingArgs` (`:54-69`) is separate; `embeddingServerKey` (`:72-76`) hashes only `enabled`, `port` and `buildEmbeddingArgs`. |
| No running server is restarted | the embedding key is compared only before and after one settings save (`src/electron/main.ts:317-323`) and is unchanged by this ticket. The chat server: the launcher spec is built by `specFor` only when a server starts (`main.ts:141-151`); the coordinator compares target keys `llama:<profile id>` and profile ids, never args (`src/local-host.ts:25-28,37-43`, `src/local-models.ts:72-131`); `local-servers.ts` only substitutes `{port}` (`:17,25`). A running Inkling keeps its old command line (no `--metrics`) until its next start; the hub's proxy restart (`hub.ps1 stop acp-proxy`) stops it anyway. |
| Context of a Llama model (AAP-47's formula overstates) | 8083 (`-c 8192 -np 4`): `/props` `default_generation_settings.n_ctx` 2048, `total_slots` 4; `/slots` four slots, `n_ctx` 2048 each. AAP-47's `n_ctx of slot 0 times the slot count` (`src/local-monitor.ts:90-95`) gives 8192: the pool, while one request can use 2048. The chat server gets no `-np` (`buildLlamaArgs`), so `-np` is auto: llama-server then uses 4 slots and a unified KV pool (b12613 `--help`: `-np ... (default: -1, -1 = auto)`, `--kv-unified ... (default: enabled if number of slots is auto)`; vendored `tools/server/server.cpp:154-158` "using n_parallel = 4 and kv_unified = true"), and with a unified pool every slot's `n_ctx` is the full `-c` (vendored `src/llama-context.cpp:289-290` `n_ctx_seq = n_ctx`; `server-context.cpp:1295,4027-4031` `slot.n_ctx = n_ctx_slot()`). So for Inkling (`-c 32768`) the formula shows 131,072 for a 32,768 pool: four times too much. Fix in this ticket: `context` = slot 0's `n_ctx` (what one request can use, in both modes; Strata's `engine.context` means the same). Not read live on 8082 (down): hub K1 step reads it. |
| The fetch type | `MonitorFetch` (`src/local-monitor.ts:100`) returns `{ ok, status, json() }`; `main.ts:549` passes Node's global `fetch`, whose `Response` also has `text()`. Tests build answers with `answer(body, status)` (`tests/local-monitor.test.ts:26`). |

## Scope

1. `buildLlamaArgs` adds `--metrics` after `--alias <model>`, once (not when `profile.extraArgs` already has it). The embedding server's args are unchanged.
2. `fetchEngine("llama")` reads `GET /metrics` (bounded text) when `/props` does not say `endpoint_metrics: false`; a whitelist parser takes the four counters; the view gets `speed` (decode and prefill t/s, average since the server started) or a reason it has none.
3. The Monitor's existing Decode and Prefill tiles show Llama's numbers with the sub "average since the model started", or a dash with "no request yet", "restart the model for speed", or (a server started outside the app, AAP-49) "start llama-server with --metrics for speed". No new tile.
4. A Llama model's `context` is slot 0's `n_ctx` (fallback `default_generation_settings.n_ctx`), no longer multiplied by the slot count.

## Out of scope

- The embedding server (no embedding speed is shown; its args and restart key stay as they are); restarting a running server; any setting; gauges, `requests_processing`, `requests_deferred`, speculative-decoding counters, `prompt_tokens_cached_total` (no tile reads them); a Strata change (its Decode/Prefill subs stay as they are); a sparkline for Llama; Gufo; router mode (`?model=`); a gate for custom builds that might not know `--metrics` (both installed builds do; a build that refuses the flag fails to start with llama-server's own message in the launcher log).

## Files and modules to touch (verified lines on master 23cf725; AAP-49 moves some lines, the functions named stay)

| file | change | rough lines |
|---|---|---|
| `src/llama-args.ts` | `buildLlamaArgs` (`:31-51`): `--metrics` after `--alias` | 3 |
| `src/local-monitor.ts` | `MonitorFetch` (`:100`) gains `text()`; new `MAX_METRICS_BYTES`, `LLAMA_COUNTERS`, `parseLlamaMetrics`, `readText`; `mapLlama` (`:80-97`) gains a third argument and the context fix; `fetchEngine` llama branch (`:121-124`) reads `/metrics`. AAP-49's edits are in `mapStrataMetrics` and the constants above it: not touched here | 40 |
| `src/shared/ipc.ts` | `EngineView` (`:257-269`): `speedMissing`, the `context` comment (`:261`) | 3 |
| `src/renderer/monitor-view.ts` | `renderMonitor`, the `el("mon-engine").replaceChildren(` block (`:141-147`): the Decode and Prefill `tile(...)` calls (`:142-143`). AAP-49 adds a fifth (sparkline) argument to the Decode call: keep it | 10 |
| `tests/llama-args.test.ts` | test "builds the exact args ..." (`:8-...`) | 3 |
| `tests/local-monitor.test.ts` | the `answer` helper (`:26`), test 2 "maps llama-server's props and slots ..." (`:49-55`), test 3 "keeps keys in the request header ..." (`:57-...`), a new inline `llamaMetrics` sample after `llamaSlots` (`:20-23`). AAP-49 changes test 1 and `strataMetrics()`: not touched here | 30 |
| `README.md` | the AAP-47 paragraph (`:31`, after AAP-49's added sentence); the Llama.cpp flag table (`:186-200`) | 3 |
| `ROADMAP.md` | done line; the open "Monitor next cut" line shortened | 2 |

Honest size: 8 files (6 code and test, README, ROADMAP), about 95 lines. No `main.ts`, `settings.ts`, HTML or CSS change.

## Contracts

`src/llama-args.ts`, in `buildLlamaArgs`, the first array becomes:
```ts
    `--alias ${safe(profile.model, "model")}`,
  ];
  // AAP-50: the Monitor reads llama-server's Prometheus counters; skipped when extraArgs already passes the flag.
  if (!/(^|\s)--metrics(\s|$)/.test(profile.extraArgs)) parts.push("--metrics");
  if (profile.ctxSize !== undefined) parts.push(`-c ${profile.ctxSize}`);
```
`buildEmbeddingArgs` and `embeddingServerKey`: unchanged.

`src/shared/ipc.ts`, `EngineView`:
```ts
  context?: number;               // tokens one request can use (Strata: engine.context; llama: n_ctx of slot 0, which with -np auto is the whole shared pool)
  ...
  speed?: { decodeTokS?: number; prefillTokS?: number };
  /** llama only, when `speed` is absent: "no-metrics" = the server runs without --metrics (or /metrics gave no counters); "no-request" = it has served nothing yet. */
  speedMissing?: "no-metrics" | "no-request";
```

`src/local-monitor.ts`:
```ts
/** The minimal fetch the monitor needs (global `fetch` fits). */
export type MonitorFetch = (url: string, init: { headers?: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

/** llama-server's /metrics answer is about 3 KB; anything larger is not read. */
export const MAX_METRICS_BYTES = 64 * 1024;
/** The only Prometheus series read (AAP-50); every other line, comments and labelled series included, is ignored. */
const LLAMA_COUNTERS = ["prompt_tokens_total", "prompt_seconds_total", "tokens_predicted_total", "tokens_predicted_seconds_total"] as const;

/** llama-server's Prometheus text as average speeds since the server started. Undefined when none of the four counters is there. */
export function parseLlamaMetrics(body: string): { decodeTokS?: number; prefillTokS?: number } | undefined {
  const values: Partial<Record<(typeof LLAMA_COUNTERS)[number], number>> = {};
  for (const name of LLAMA_COUNTERS) {
    const match = new RegExp(`^llamacpp:${name} ([0-9.eE+-]+)\\r?$`, "m").exec(body);
    const value = match ? Number(match[1]) : Number.NaN;
    if (Number.isFinite(value) && value >= 0) values[name] = value;
  }
  if (Object.keys(values).length === 0) return undefined;
  const ms = (s: number | undefined): number | undefined => (s === undefined ? undefined : s * 1000);
  return compact({
    decodeTokS: rate(values.tokens_predicted_total, ms(values.tokens_predicted_seconds_total)),
    prefillTokS: rate(values.prompt_tokens_total, ms(values.prompt_seconds_total)),
  });
}
```
(`rate` and `compact` exist, `:21-22`; `rate` returns undefined for 0 tokens or 0 time, so an idle server gives `{}`.) The regex is built only from the constant names above, never from the answer.

`readText(fetchImpl, url, timeoutMs): Promise<string | undefined>`: like `readJson` (`:103-108`) with no headers; undefined on a thrown fetch, `!ok` (the 501), a thrown `text()`, or `body.length > MAX_METRICS_BYTES`. A `/metrics` failure never sets `engineError`: the engine answered on `/props`.

`mapLlama(props: unknown, slotsJson: unknown, metricsText?: string): EngineView`:
- `context: perSlot ?? num(obj(root["default_generation_settings"])?.["n_ctx"])` (the `count` constant goes);
- `const parsed = metricsText === undefined ? undefined : parseLlamaMetrics(metricsText);` then `speed: parsed && Object.keys(parsed).length ? parsed : undefined`, `speedMissing: parsed === undefined ? "no-metrics" : Object.keys(parsed).length ? undefined : "no-request"`;
- everything else as today (no string from `/metrics` is copied).

`fetchEngine`, llama branch:
```ts
  const [props, slots] = await Promise.all([readJson(fetchImpl, `${base}/props`, {}, timeoutMs), readJson(fetchImpl, `${base}/slots`, {}, timeoutMs)]);
  if ("error" in props) return { error: props.error };
  const root = obj(props.json);
  if (!root) return { error: "unexpected answer" };
  // b12613's /props says whether --metrics is on; an older build without the field is simply asked.
  const metrics = root["endpoint_metrics"] === false ? undefined : await readText(fetchImpl, `${base}/metrics`, timeoutMs);
  return { engine: mapLlama(props.json, "json" in slots ? slots.json : undefined, metrics) };
```
GET only, `127.0.0.1` and the configured port only, as today. Nothing new listens: `/metrics` is served by the same llama-server listener on `127.0.0.1:<port>` that already serves `/props` and `/slots`.

Renderer, `renderMonitor` in `src/renderer/monitor-view.ts`, before `el("mon-engine").replaceChildren(`:
```ts
    const llama = engine?.kind === "llama";
    /** Why Llama has no speed. */
    const llamaWhy = llama && !speed ? (engine?.speedMissing === "no-request" ? "no request yet" : local?.external ? "start llama-server with --metrics for speed" : "restart the model for speed") : undefined;
    const speedValue = (value: number | undefined): string | undefined => (value === undefined ? undefined : llama ? `${rateText(value)} t/s` : fromStrata(`${rateText(value)} t/s`));
    const speedSub = (value: number | undefined): string | undefined => (llama ? (value !== undefined ? "average since the model started" : llamaWhy) : !speed && noRequest ? "no request yet" : dashSub(true));
```
and the two tiles become `tile("Decode", speedValue(speed?.decodeTokS), speedSub(speed?.decodeTokS)[, AAP-49's sparkline])` and `tile("Prefill", speedValue(speed?.prefillTokS), speedSub(speed?.prefillTokS))`. Strata's behaviour is unchanged (`fromStrata`, `noRequest`, `dashSub(true)` exactly as today); Gufo and "none loaded" still get `dashSub(true)`'s reason. No inline style, no new element.

README (`:31`), after AAP-49's "Since AAP-49 ..." sentence, add: "Since AAP-50 the proxy starts llama-server with `--metrics`, so the Decode and Prefill tiles also show a Llama.cpp model's average speed since it started (from llama-server's own `/metrics` counters; a model started before the update shows a dash until it starts again), and a Llama.cpp model's context is what one request can use." Flag table (`:186-200`), after the `model` row: `| (always) | - | `--metrics` (the Monitor's speed; not added twice when `extraArgs` has it) |`.

## Tasks for workers

1. **One worker** (the whole ticket is small): `llama-args.ts`, `local-monitor.ts`, `ipc.ts`, `monitor-view.ts`, both test files, README, ROADMAP, in that order. Output: `yarn test` and `yarn typecheck` green; `grep -n "style" src/renderer/monitor-view.ts` shows nothing new.
Commit on `AAP-50_llama-metrics`: `AAP-50: llama-server --metrics, Llama speed on the Monitor, per-request Llama context`; `changelog.md` in this folder with the test count and the UNTESTED list.

## Tests (test-discipline: extend three existing tests, no new file, no new test case)

- `tests/llama-args.test.ts` "builds the exact args, prechecks every shard and gates on the build": the expected dspark string becomes `... --alias inkling-2-mini-dspark --metrics -c 32768 -ngl all -fa auto ...` (rest unchanged); add `expect(buildLlamaArgs({ ...mini, extraArgs: "--metrics --temp 1.0" }, dir).match(/--metrics/g)).toHaveLength(1);`. The existing exact `buildEmbeddingArgs` assertion (no `--metrics`) and the `embeddingServerKey` assertions stay as they are and prove the embedding server is unchanged.
- `tests/local-monitor.test.ts`:
  - `answer` gains `text: async () => (typeof body === "string" ? body : JSON.stringify(body))`.
  - New sample after `llamaSlots`, in the format of `server-task.cpp:1593-1613` (synthetic numbers: no server with `--metrics` was running; replace with K1's recording if wanted), with planted text and gauges set to 0 to prove the counters are used:
    ```
    # HELP llamacpp:prompt_tokens_total Number of prompt tokens processed, excluding cached tokens
    # TYPE llamacpp:prompt_tokens_total counter
    llamacpp:prompt_tokens_total 446
    llamacpp:prompt_tokens_cached_total 0
    llamacpp:prompt_seconds_total 0.5
    llamacpp:tokens_predicted_total SECRET-TEXT
    llamacpp:tokens_predicted_total 120
    llamacpp:tokens_predicted_seconds_total 2.4
    llamacpp:prompt_tokens_seconds 0
    llamacpp:predicted_tokens_seconds 0
    # HELP llamacpp:secret SECRET-TEXT
    llamacpp:secret{prompt="SECRET-TEXT"} 1
    llamacpp:spec_decode_num_accepted_tokens_per_pos_total{position="0"} 3
    ```
  - Test 2: `mapLlama(llamaProps, llamaSlots, llamaMetrics)`; the expected object's `context` becomes 4096 (was 8192: slot 0's `n_ctx`, not times 2) and gains `speed: { decodeTokS: 50, prefillTokS: 892 }`; `view.speedMissing` is undefined; `mapLlama(llamaProps, llamaSlots)` has no `speed` and `speedMissing: "no-metrics"`; the same text with the four counters at 0 gives `speedMissing: "no-request"`; the existing `JSON.stringify(view)` check for `SECRET` covers the metrics view too.
  - Test 3: a fake fetch that answers by URL (`/props` with `endpoint_metrics: true`, `/slots`, `/metrics` with `llamaMetrics`): `fetchEngine("llama", 8082, undefined, fake)` requests `http://127.0.0.1:8082/metrics` and returns `engine.speed.decodeTokS` 50; with `endpoint_metrics: false` no `/metrics` URL is requested and `speedMissing` is `"no-metrics"`; a `/metrics` body of `MAX_METRICS_BYTES + 1` characters gives `speedMissing: "no-metrics"`.

## Acceptance criteria

| # | criterion | proof |
|---|---|---|
| L1 | the chat server gets `--metrics` exactly once; the embedding args and restart key are unchanged | extended llama-args test |
| L2 | the four counters map to decode and prefill t/s; no other line, no text passes | extended test 2 (`SECRET` check, gauges 0) |
| L3 | no metrics, an idle server and an oversized body are honest | test 2 (`no-metrics`, `no-request`), test 3 (oversize, `endpoint_metrics: false` makes no request) |
| L4 | a Llama model's context is what one request can use | test 2 (`context: 4096`) |
| L5 | no running server is restarted by the upgrade | code reading recorded above (no args comparison exists); hub K1 step 2 restarts the proxy, which is the only restart |
| L6 | types compile (node, renderer, tests) | `yarn typecheck` |
| L7 | nothing else breaks | `yarn test` |
| L8 | Inkling's Decode and Prefill tiles show numbers; `/metrics` on 8082 has the counters; the context tile shows 32,768 | hub K1 line below (a person reads the page) |

## ROADMAP (repo style)

After AAP-49's done line add:
`- [x] Llama.cpp speed on the Monitor (AAP-50; creative-hub HUB-43; live check UNTESTED, hub K1): llama-server starts with --metrics; the Decode and Prefill tiles show a Llama.cpp model's average speed since it started, from its four Prometheus counters; a Llama.cpp model's context is what one request can use (a slot's n_ctx, not times the slots).`
Replace AAP-49's open line `- [ ] Monitor next cut: llama-server --metrics for Llama speed (AAP-49 plan, "Next cut"), Gufo status once its endpoints are known (creative-hub HUB-43 probe P2).` by `- [ ] Monitor next cut: Gufo status once its endpoints are known (creative-hub HUB-43 probe P2).`

## Live check for the hub (HUB-43 K1, after the proxy rebuild and restart)

With the user's go-ahead (it loads Inkling on the GPU, which evicts Strata from the proxy and shares memory with ComfyUI): one request to `llama/inkling-2-mini` ("Reply with the word OK.", `max_tokens` 20); then `curl -s http://127.0.0.1:8082/metrics` (record the `llamacpp:` lines; the four counters are there), `curl -s http://127.0.0.1:8082/props` (`endpoint_metrics: true`, `default_generation_settings.n_ctx`, `total_slots`) and `curl -s http://127.0.0.1:8082/slots` (each slot's `n_ctx`) at the same time; expected `n_ctx` 32768 on each of 4 slots (unified pool) and the Monitor's Context tile 32,768; the Decode and Prefill tiles show numbers with "average since the model started".

## UNTESTED

- The window (no Electron test harness): the two tiles' values and subs for Llama. Hub K1.
- b12613's real `/metrics` text (names verified in the DLL, format from the vendored source): hub K1 records it.
- The chat server's per-slot `n_ctx` with `-np` auto (from `--help` and the vendored source; 8082 was down): hub K1.
- The unsloth build with `--metrics` (flag in its `--help`; no live read); a custom `llama-server.exe` that predates the flag (it would refuse to start).
- A Llama server started outside the app without `--metrics` (the "start llama-server with --metrics" sub): no live check planned.
