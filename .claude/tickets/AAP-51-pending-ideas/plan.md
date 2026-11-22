---
status: in-progress
request: creative-hub/REQ-0031
repos: [api-acp-proxy]
branch: AAP-51_pending-ideas
updated: 2026-11-22
---

# AAP-51 Pending proxy ideas: Strata image list at first load, GiB, spark test, Monitor reasons and dots, outside Llama id, settings caches, capped metrics read, server identity, Usage page without inline sizes

Hub ticket: creative-hub HUB-44 (`C:\projects\Personal\creative-hub\.claude\tickets\HUB-44-pending-ideas\handoff.md`, section 3.1, items P-01 to P-14), request REQ-0031. Every line number below was checked on master 9f23c3a (2026-11-22).

## Rules for every worker

- Branch `AAP-51_pending-ideas`, cut from master 9f23c3a. Workers do not commit. The orchestrator makes **one commit** for the whole ticket after all three workers and the checks: `AAP-51: Strata vision at first load, GiB, spark test, Monitor reasons, outside Llama id, capped metrics, identity check, Usage page without inline sizes` (Bash heredoc `git commit -F - <<'EOF'`, blank line after the subject, attribution line from the session reminder). No push, no merge.
- The proxy app is **running from `dist/`**: no `yarn build`, no `yarn dist*`, no `yarn app:dev`, no Electron start. Tests and typecheck only. Never read, print or touch `%APPDATA%\api-acp-proxy\settings.json`. No setting is added.
- Commands (verified in `package.json` scripts). In Bash, first: `export PATH="/c/Users/Infplane/AppData/Roaming/fnm/aliases/default:$PATH"` (`fnm exec yarn` fails). Run from `C:\projects\Personal\api-acp-proxy`:
  - all tests: `yarn test` (`vitest run`); one file: `yarn test tests/<file>.test.ts`
  - typecheck: `yarn typecheck` (node, renderer and tests configs)
  - there is **no lint script** in `package.json`; do not invent one.
- Monitor rule: counts and timings only, never prompt or answer text, never a key value; renderer text only through `textContent` (or `make(tag, class, text)`); no inline styles (`style.` or a `style` attribute) anywhere in `src/renderer` (the page CSP is `style-src 'self'`, `src/renderer/settings.html:5`). SVG presentation attributes (`points`, `x`, `y`, `width`, `height`) are allowed.
- Tests follow the global `test-discipline` skill: only the tests listed under Tests, in the files named there. Every new or extended assertion is first **shown failing** (on the unchanged code, or by the mutation named for it), and the failing line is pasted into `changelog.md`. Trap: an assertion that passes on the old code proves nothing.
- Working trees are CRLF, git stores LF: do not flip line endings. Write regexes and Windows paths with the Edit or Write tool, not through a Bash heredoc (backslashes get stripped).

## Scope (item, decision, verified cause)

| item | decision | cause, verified on 9f23c3a |
|---|---|---|
| P-01 Gufo tiles | OUT of the build | No Gufo endpoint is known (`src/local-monitor.ts:183` returns `{}` for Gufo; nothing on disk). Only the live probe P1 below; the tiles are built in a follow-up ticket from its recorded answers. |
| P-02 Strata image before first load | IN | `LocalOpenAiProvider` without profiles (Strata) decides vision from its own `this.models` (`src/providers/local-openai.ts:127-128`), which is `[]` until `listModels()` succeeds (`:76`, `:182-195`). `prepareModel` refuses an image request with 400 `unsupported_content` **before** the lease that would start Strata (`:150-156`), so right after a proxy start (Strata not loaded yet) an image request to Strata is refused even though Strata reads images. The app already refreshes the list once on each transition to ready (`src/electron/main.ts:279`), but that never runs for the refused request, and the `/v1/models` row comes from the router's `models-cache.json` (`src/router.ts:59`, `:64-73`), which can carry no `vision`. Fix at the point of use: for a provider without profiles, the image check happens after the lease and reads the list again first. |
| P-03 VRAM "GB" | IN | `gb()` divides by 1024^3 and writes "GB" (`src/renderer/monitor-view.ts:22`, `:35`); used for VRAM, RAM and GPU memory (`:221`, `:226`, `:229-230`, `:312`, `:314`). Fix: label GiB (the maths is GiB already), consistent with the MiB on the Conversation cache tile (`:211`). |
| P-04 `spark()` test | IN | `spark()` is private in `monitor-view.ts:57-87`; the tests config cannot load DOM code. Fix: move its geometry to a new pure module and test that. |
| P-05 (a) Strata Prefill reason | IN | Strata's speed sub line is `!speed && noRequest ? "no request yet" : dashSub(true)` (`monitor-view.ts:205`): with a decode speed but no prefill speed (every prompt cached, `src/local-monitor.ts:94`), the Prefill dash has no reason. Llama has it since AAP-50 polish 1 (`:205` llama branch). |
| P-05 (b) isolated points | IN | `flush()` draws only runs of 2 or more points (`monitor-view.ts:78-81`), so a number between two nulls is dropped. Fix: draw it as a dot. The rule "fewer than two numbers in the series: no sparkline" (`:60`) stays. |
| P-05 (c) passing `/metrics` failure | IN | `readText` returns undefined on any failure (`src/local-monitor.ts:172-179`) and `mapLlama` then says `speedMissing: "no-metrics"` (`:156`), so a server whose `/props` says `endpoint_metrics: true` (`:197`) and whose one `/metrics` read failed shows "restart the model for speed" (`monitor-view.ts:202`), which is wrong advice: it has `--metrics`. Fix: a third value `metrics-unread` with its own text "speed not read this time". |
| P-05 (d) estimated thinking count | IN | `local-openai.ts:266-268` estimates `thoughtTokens` from the reasoning text when the server reports usage without `reasoning_tokens`; `usageEstimated()` is false because usage exists (`src/usage.ts:18`), so the Monitor's Thinking cell (`monitor-view.ts:269`, `:275`) and the Requests page (`src/renderer/settings.ts:547`) show the estimate without "≈". |
| P-06 outside Llama model id | IN | Not done: `mapLlama` never reads `model_alias` (`local-monitor.ts:139-158`), and the outside path sets a model id only for Strata (`main.ts:571-572`). |
| P-07 render-error state | NO CHANGE | AAP-49 built it: a render error keeps the last rendered numbers under the notice "Could not show the latest reading. The numbers below are from <time>." on both pages, resets "updated" to the last good time and always schedules the next poll (`monitor-view.ts:119-131`); the next good render overwrites both notices (`:189`, `:307`). That is the distinct state the idea asked for. Only seeing it is open (UNTESTED, in the window). |
| P-08 settings caches | IN | `proxy.applySettings` at `main.ts:612` (Antigravity install) and `:621` (terms acknowledgement) is not followed by `refreshLocalSettings()` (`:135-140`), unlike the save handler (`:325-326`). |
| P-09 `readText` cap | IN | `local-monitor.ts:176-177` reads the whole body with `text()` and only then checks `MAX_METRICS_BYTES` (`:118`); only the timeout bounds the read. |
| P-10 foreign program on the port | IN (Llama.cpp); Strata NO CHANGE | Llama: `fetchEngine` accepts any JSON object from `/props` (`local-monitor.ts:193-195`). llama-server's `/props` always carries `total_slots` (test sample `tests/local-monitor.test.ts:29`) and `default_generation_settings` (live record, `creative-hub\runs\hub-43-open-ideas.md:103`). Strata: already refused unless `/metrics` has an `engine` or `live` object (`local-monitor.ts:188-189`); the recorded sample has both (`tests/local-monitor.test.ts:10-12`); a program that does not speak Strata's `/metrics` gets "unexpected answer". The outside path skips any read without `engine` (`main.ts:569`), so a refused identity shows nothing. |
| P-11 Usage inline sizes | IN | `usage-view.ts:167` `segment.style.height` and `:231` `fill.style.width`. |
| P-12 `--metrics` build gate | OUT | Director default: low value (both installed builds support it). |
| P-13 Strata telemetry sources | OUT, closed NO CHANGE | HUB-43 triage row 2a: every number a tile uses is in `/metrics`. |
| P-14 (1) embed stop throws | IN | `main.ts:327-330`: `await servers.stop("embed")` sits inside the save handler's `try`, so a throw returns `ok:false` with the settings already applied (`:325`). |
| P-14 (2) provider without dimensions | NO CHANGE | `EmbeddingSettings.dimensions` is a required `number` (`local-openai.ts:32`), the settings schema defaults it to 768 (`src/settings.ts:192`) and `updateSettings` falls back to 768 (`local-openai.ts:120`); 0 turns the check off on purpose (`settings.ts:192` `min(0)`, `local-openai.ts:367`). A provider "without dimensions" cannot be built through the settings. |
| P-14 (3) Strata ready, provider off | NO CHANGE | The Model tile shows a dash with the reason "provider is off in the proxy" (`monitor-view.ts:153`); a provider that is off lists no model, so a dash with its reason is right. |
| P-14 (4) `/v1/models` marks Strata `vision: true` | NO CHANGE (report only) | See "Who reads the vision flag" below: no sibling client reads the proxy's `vision` field. |
| P-14 (5) AAP-45 mmproj fix and `hf` | NO CHANGE | Now asserted: `tests/llama-models.test.ts:27` expects `applyFix(preset, "mmprojFile", mmproj).hf` to equal `{ ...preset.hf, mmproj: mmproj.name }` (AAP-46 changed the rule and added the assertion). |

### Who reads the vision flag (P-14 (4), read-only grep of the sibling repos)

- The proxy's `GET /v1/models` emits a `vision` field and no `architecture.input_modalities` (`src/server.ts:549`).
- visual-novels-orchestrator, edu-game-studio, cartoon-studio filter by vision (`visionOnly` for the art-critic / frame-critic: `visual-novels-orchestrator/src/engine/models/router.ts:100`, `:118`; `src/engine/vn/handlers.ts:542`), but the flag comes from their own config rows (`src/engine/models/registry.ts:240`, `:277` in all three); their `openaiCompat.ts` reads no vision from a model list.
- pixel-art-generator and midi-generator read vision of discovered models from `architecture.input_modalities` (`src/llm/openaiCompat.ts:383`) or from config/profiles (`src/llm/registry.ts:313`, `:415`, `:454`), never the proxy's `vision` field. Pixel's Strata row is `vision: false` in its config (handoff P-15).
- scriptorium and book-translator mention `vision` only in schemas and migrations.
- So no client starts choosing Strata as a vision model because of the flag. No code change.

## Out of scope

- Gufo status tiles and the Gufo vision cross-check (P-01, after the probe); the `--metrics` build gate (P-12); Strata `/v1/telemetry` and `/v1/status` (P-13).
- The proxy's chat routing still sends requests, and the Strata key, to whatever answers on the configured port (P-10 covers only what the Monitor shows).
- The router's `models-cache.json` row for Strata without `vision` before the first load (cosmetic in `/v1/models`; the request path is fixed by P-02).
- Emitting `architecture.input_modalities` in `/v1/models`; any README rewrite beyond the one sentence below.

## Files to touch (verified)

### Worker A: engine reads, Electron main, shared types, docs

**`src/shared/ipc.ts`** (do this first, the other workers code against it):
- `:271-272`: `speedMissing?: "no-metrics" | "no-request" | "metrics-unread";` and the comment gains: `"metrics-unread" = /props says --metrics is on but this /metrics read failed or was too large`.
- `ActivityView` (`:126-138`), after `reasoningTokens` (`:137`): `/** True when reasoningTokens is the chars/4 estimate from the reasoning text (the server reported usage without reasoning_tokens). */ reasoningEstimated?: boolean;`

**`src/local-monitor.ts`**:
- P-05 (c), `mapLlama` `:156`: `speedMissing: parsed === undefined ? (root["endpoint_metrics"] === true ? ("metrics-unread" as const) : ("no-metrics" as const)) : hasSpeed ? undefined : ("no-request" as const)`. Doc comment `:138` adds "endpoint_metrics is read to tell a failed read from a server without --metrics".
- P-09, `MonitorFetch` `:161`: the response type gains `body?: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void> } } | null` (Node's global `fetch` `Response.body` fits). `readText` `:172-179`: when `response.body?.getReader` exists, read chunk by chunk, add `value.byteLength` to a running total, and as soon as the total exceeds `MAX_METRICS_BYTES` call `await reader.cancel().catch(() => undefined)` and return undefined; at the end decode the chunks with one `TextDecoder("utf-8")` (`decode(chunk, { stream: true })` per chunk, then `decode()`). Without a body keep today's `text()` path and its after-read check. Doc comment: "capped while it streams: at most MAX_METRICS_BYTES are read".
- P-10, `fetchEngine` `:193-195`: after `const root = obj(props.json)`, return `{ error: "unexpected answer" }` unless `num(root["total_slots"]) !== undefined || obj(root["default_generation_settings"]) !== undefined`. Comment: "a llama-server /props always has total_slots and default_generation_settings: anything else on the port is not shown as a model".
- P-06: a new exported pure function after `mapLlama`:
  ```ts
  /** llama-server's `--alias` from `/props` `model_alias`, only when it looks like a model id (letters, digits, dot, dash, underscore, 1-64 characters): a path or anything else gives undefined. */
  export function llamaAlias(props: unknown): string | undefined
  ```
  Rule: `const alias = obj(props)?.["model_alias"]; return typeof alias === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(alias) ? alias : undefined;`. `fetchEngine`'s return type becomes `Promise<{ engine?: EngineView; error?: string; alias?: string }>`; the Llama branch `:198` returns `{ engine: mapLlama(...), ...(llamaAlias(props.json) ? { alias: llamaAlias(props.json)! } : {}) }`. `mapLlama` still never reads `model_alias` (the view whitelist test stays).

**`src/electron/main.ts`**:
- P-06, outside path `:566-573`: for `id === "llama"`, when `read.alias` is set: `const profile = llamaSettings?.profiles.find((candidate) => candidate.model === read.alias);` and `local = { server: id, state: "ready", port, external: true, modelId: \`llama/${read.alias}\`, ...(profile ? { label: profile.label, profile: profile.id } : {}) }`. Strata's branch unchanged. (`modelSub` returns "started outside the app" for an external server first, `monitor-view.ts:150`, so the Model tile shows the label or id with that sub line.)
- P-08, `:612`: `await proxy.applySettings({}); await refreshLocalSettings(); // restart so the provider picks up install.json`. `:621`: `return action(async () => { await proxy.applySettings({ providers: { [providerId]: { termsAcknowledgedAt: new Date().toISOString() } } }); await refreshLocalSettings(); });`.
- P-14 (1), `:328-329`: `await servers.stop("embed").then(() => logger.info("embedding settings changed: embedding server stopped, it starts again on the next request"), (error) => logger.warn(\`embedding settings changed but the embedding server did not stop: ${error instanceof Error ? error.message : String(error)}\`));` so a failed stop no longer turns a saved patch into `ok:false`.

**`README.md:31`** (Monitor paragraph), append one sentence: "Since AAP-51 sizes are shown in GiB, a single reading between gaps is drawn as a dot, a Prefill or Decode dash always says why, an estimated thinking count carries ≈, a Llama.cpp server started outside the app shows its `--alias`, and a program on the port that is not llama-server is not shown as a model."

**`ROADMAP.md`**, a new row after `:47` (the AAP-50 row), in its style:
"- [x] Monitor and proxy leftovers (AAP-51; creative-hub HUB-44; live check UNTESTED): an image request to Strata before its first load reads Strata's model list again after the load instead of being refused; the Monitor shows GiB, draws a single reading as a dot, says why a Prefill dash is empty on Strata and that a failed /metrics read is not a missing --metrics, marks an estimated thinking count with ≈, shows an outside Llama.cpp server's alias and ignores a program on the port that is not llama-server; the /metrics read is capped while it streams; the Antigravity install and terms acknowledgement refresh the cached local settings; a failed embedding-server stop no longer fails a saved patch; the Usage page draws its bars without inline sizes."

**`.claude/tickets/AAP-51-pending-ideas/changelog.md`** (new): files, deviations, the failing-first evidence of every test, test counts, UNTESTED list. Worker A writes it last, from the other workers' reports.

### Worker B: Monitor renderer

**`src/renderer/monitor-format.ts`** (new, pure, no DOM, like `src/renderer/llama-models.ts:4`), exports:
- `export const GIB = 1024 ** 3;` and `export const gib = (bytes: number): string => \`${(bytes / GIB).toFixed(1)} GiB\`;`
- `export const SPARK_W = 59; export const SPARK_H = 16;`
- `export function sparkGeometry(values: readonly (number | null)[] | undefined, opts: { min?: number | undefined; max?: number | undefined } = {}): { lines: string[]; dots: string[] } | undefined` — the body of today's `spark()` (`monitor-view.ts:58-68`, `:77-85`) without the DOM: undefined when fewer than two finite numbers; each run of 2 or more consecutive numbers is one `lines` entry `"x,y x,y ..."` (x = `index + shift`, y `toFixed(2)`, exactly as `:83`); a run of exactly one number is one `dots` entry `"${x - 0.5},${y} ${x + 0.5},${y}"` (same y string). Doc comment carries today's flat-line rule text (`:55`, `:66`).
- ```ts
  export interface SpeedSubInput { llama: boolean; value: number | undefined; haveSpeed: boolean; missingText: string; noRequest: boolean; speedMissing?: "no-metrics" | "no-request" | "metrics-unread"; external: boolean; fallback: string | undefined }
  /** The sub line of the Decode and Prefill tiles. */
  export function speedSub(input: SpeedSubInput): string | undefined
  ```
  Rule. Llama: value set → "average since the model started"; else other speed set (`haveSpeed`) → `missingText`; else `speedMissing` "no-request" → "no request yet"; "metrics-unread" → "speed not read this time"; else `external` → "start llama-server with --metrics for speed"; else "restart the model for speed". Not Llama (Strata or no engine): value set → undefined; `haveSpeed` → `missingText` (new, P-05 (a)); `noRequest` → "no request yet"; else `fallback`.

**`src/renderer/monitor-view.ts`**:
- Delete `GB` (`:22`) and `gb` (`:35`); import `gib`, `sparkGeometry`, `SPARK_W`, `SPARK_H`, `speedSub` from `./monitor-format.js`; replace every `gb(` with `gib(` (`:221`, `:226`, `:229`, `:230`, `:312`, `:314`).
- `spark()` (`:50-87`) keeps its signature and DOM part: `const geometry = sparkGeometry(values, opts); if (!geometry) return undefined;` then the same `svg` and `title`, one `polyline` per `geometry.lines` entry, and one `polyline` with `setAttribute("class", "dot")` per `geometry.dots` entry. Delete the local `SPARK_W`/`SPARK_H` (`:51-52`).
- Delete `llamaWhy` (`:201-202`); `speedSub` (`:205`) becomes `const speedText = (value: number | undefined, missingText: string): string | undefined => speedSub({ llama, value, haveSpeed: speed !== undefined, missingText, noRequest, speedMissing: engine?.speedMissing, external: local?.external === true, fallback: dashSub(true) });` and `:207-208` call `speedText(...)`.
- P-05 (d), `:269-275`: `const thinkApprox = entry.estimated || entry.reasoningEstimated ? "≈ " : "";` and the Thinking cell uses `thinkApprox` instead of `approx`.

**`src/renderer/settings.ts:547`**: the thinking part becomes `` ` (${entry.reasoningEstimated && !entry.estimated ? "≈ " : ""}${entry.reasoningTokens} thinking)` `` (the leading "≈ " already covers a fully estimated row).

**`src/renderer/settings.css:232`**, after it: `.spark polyline.dot { stroke-width: 3; stroke-linecap: round; }`.

### Worker C: provider, server, activity, Usage page

**`src/provider.ts:19`** `GenerationResult`: add `/** True when usage.thoughtTokens is the chars/4 estimate from `reasoning` (the server reported usage without reasoning tokens). */ reasoningEstimated?: true;`.

**`src/providers/local-openai.ts`**:
- P-02, `prepareModel` `:146-157`: keep the embedding check (`:148`) and the image-profile check (`:151`) and the non-chat check (`:153`). The vision check `:152` runs before the lease only when `this.profiles` is set (Gufo, Llama.cpp: the profile decides, unchanged). Then: `const lease = leaseId && this.coordinator ? await this.coordinator.acquire(leaseId, signal) : undefined;` and, for a provider without profiles (Strata) with an image part and `!this.acceptsImages(model)`: `await this.listModels().catch(() => undefined);` (Strata is ready once the lease resolved), and if `acceptsImages` is still false: `lease?.release();` and throw the same 400 `unsupported_content` as `:152`. Return `lease`. Doc comment `:146` becomes: "Checks the request against the model's profile, then waits for the coordinator to make that profile ready. Gufo and Llama.cpp 400s come before any switch; Strata's image check comes after its lease and reads Strata's model list again, because before its first load the list is empty or has no vision flag (AAP-51)."
- P-05 (d), `:266-269`: `const estimate = reported !== null && reasoning !== "" && !reported.thoughtTokens; if (estimate) reported.thoughtTokens = Math.min(reported.outputTokens, estimateTokens(reasoning));` and the return adds `...(estimate ? { reasoningEstimated: true as const } : {})`.

**`src/server.ts`**: `Trace` (`:26`) gains `reasoningEstimated?: boolean`; `traceUsage` (`:54-60`) sets `trace.reasoningEstimated = result.reasoningEstimated === true;`; `track` (`:507`) adds `...(trace.reasoningTokens !== undefined && trace.reasoningEstimated ? { reasoningEstimated: true as const } : {})`.

**`src/activity.ts:29`**: after `reasoningTokens`, `/** reasoningTokens is the chars/4 estimate from the reasoning text. */ reasoningEstimated?: true;`.

**`src/renderer/usage-view.ts`** (P-11, no `style.` left):
- Chart `:156-180`: each `.chart-day` column div stays (title, hover); inside it one `svg` (`document.createElementNS("http://www.w3.org/2000/svg", "svg")`) with attributes `class="chart-svg"`, `viewBox="0 0 1 1000"`, `preserveAspectRatio="none"`, `aria-hidden="true"`. Segments from the bottom: `let cursor = 1000;` for each nonzero value `const h = Math.max(15, Math.round((value / max) * 1000)); const y = Math.max(0, cursor - h);` a `rect` with `class="chart-seg ${seriesClass(id)}"`, `x="0"`, `width="1"`, `y=String(y)`, `height=String(cursor - y)`; `cursor = y`. 15 units is about 2 px of the 140 px chart (today's `min-height: 2px`). Delete `topSegment` and `is-top` (`:161`, `:169`, `:172`). Constants `CHART_UNITS = 1000`, `MIN_SEG_UNITS = 15` at the top of the file.
- Meter `:229-232`: `const meter = make("progress", \`meter${entry.usedPercent >= 90 ? " is-err" : entry.usedPercent >= 75 ? " is-warn" : ""}\`); meter.max = 100; meter.value = Math.max(0, Math.min(100, entry.usedPercent)); meter.setAttribute("aria-label", \`${entry.label} used\`); item.append(head, meter);` (`make` at `usage-view.ts:25` takes any HTML tag, `progress` included).

**`src/renderer/usage.css`**:
- Replace `:19-20` (`.chart-seg`, `.chart-seg.is-top`) with `.chart-svg { display: block; width: 100%; height: 100%; }` and seven fill rules `.chart-svg .series-codex { fill: var(--series-codex); }` for codex, claude, antigravity, gufo, strata, llama, other (the names of `:2-8`).
- Replace `:35-38` with: `.meter { appearance: none; display: block; width: 100%; height: 8px; border: 0; border-radius: var(--radius-sm); background: var(--surface-2); overflow: hidden; accent-color: var(--accent); }`, `.meter::-webkit-progress-bar { background: var(--surface-2); border-radius: var(--radius-sm); }`, `.meter::-webkit-progress-value { background: var(--accent); border-radius: var(--radius-sm); }`, `.meter.is-warn::-webkit-progress-value { background: var(--warn); }`, `.meter.is-err::-webkit-progress-value { background: var(--err); }` (the pattern of `settings.css:226-230`).

## Tests (test-discipline: one new file, the rest extend existing tests)

1. **`tests/local-monitor.test.ts`** (Worker A), extend the test at `:98` ("keeps keys in the request header..."); no new `it`:
   - P-05 (c): change `:126` to `expect(huge.engine?.speedMissing).toBe("metrics-unread");` — fails on the old code (it gives "no-metrics"). `:123` (`endpoint_metrics: false`) keeps "no-metrics".
   - P-09: a fetch whose `/metrics` answer has a `body` that yields 16 KiB chunks for ever and records `cancel()`, and whose `text()` rejects; expect `speedMissing` "metrics-unread" and `cancelled === true`. Fails on the old code (it calls `text()`, never cancels).
   - P-10: `/props` answering `{ status: "ok" }` gives `{ error: "unexpected answer" }`. Fails on the old code (it returns an engine).
   - P-06: change the sample's `model_alias` (`:29`) from "SECRET-TEXT" to "inkling-2-mini"; expect `withSpeed.alias` to be "inkling-2-mini" (fails on the old code: no `alias`), and `llamaAlias({ model_alias: "C:\\models\\x.gguf" })` to be undefined. `:84` (`mapLlama` JSON has no "SECRET") stays and must still pass; also assert `JSON.stringify(mapLlama(llamaProps, llamaSlots, llamaMetrics))` does not contain "inkling-2-mini" (the view never carries the alias).
2. **`tests/monitor-format.test.ts`** (new; no existing file covers renderer Monitor helpers, and `local-monitor.test.ts` belongs to Worker A). Worker B: first move `gb`, the spark geometry and the speed-sub logic into `monitor-format.ts` **unchanged** (label "GB", no dots, old Strata rule), write the tests, run them and paste the failures, then make the three fixes. Three `it`s:
   - `gib`: `gib(67_884_810_240)` is "63.2 GiB" and `gib(68_719_476_736)` is "64.0 GiB" (fails with the "GB" label).
   - `sparkGeometry`: `[1, null, 2, 3]` with `{ min: 0, max: 4 }` gives `{ lines: ["58,8.00 59,4.00"], dots: ["55.5,12.00 56.5,12.00"] }` (fails without dots); `[0, 0, 0]` with `{ min: 0 }` gives lines `["57,16.00 58,16.00 59,16.00"]`; `[100, 100]` with `{ min: 0, max: 100 }` gives `["58,0.00 59,0.00"]`; `[5, 5]` gives `["58,8.00 59,8.00"]`; `[null, 7]` gives undefined. The flat-line cases pass on the moved code, so prove them by mutation: make `flatY` always return `SPARK_H / 2`, see the test fail, restore.
   - `speedSub`: a table of six rows: Strata with decode but no prefill → "no prompt read yet" (fails on the old rule: undefined); Llama `metrics-unread` → "speed not read this time" (fails on the old rule); Llama value 50 → "average since the model started"; Llama `no-metrics` external → "start llama-server with --metrics for speed"; Strata no speed, `noRequest` → "no request yet"; no engine, fallback "Engine not reachable" → "Engine not reachable".
3. **`tests/local-openai.test.ts`** (Worker C):
   - P-02: extend the test at `:238`: before `:248` (`await strata.listModels()`), make a second provider on the same port that has never listed, `const fresh = new LocalOpenAiProvider({ id: "strata", displayName: "Strata", baseUrl: \`http://127.0.0.1:${port}/v1\`, logger }); const freshRouter = new ProviderRouter({ providers: [fresh] });`, then `await freshRouter.prepareModel("strata/qwen-flash", withImage, abort)` resolves and `await freshRouter.generate("strata/qwen-flash", withImage)` sends the `image_url` part (check the last entry of `bodies`). Fails on the old code (400 `unsupported_content`). The assertions at `:228` (server down: still 400) and `:252-253` (text-only list: still 400) must still pass.
   - P-05 (d): extend the test at `:108`: `thinkingProxy` (`:57`) and `serve` (`:27`) take an optional `ActivityLog` passed to `createProxyServer(config, router, { activity })`; after the response, poll up to 1 s for `activity.list()[0]` and expect it to match `{ reasoningTokens: 4, reasoningEstimated: true }` and not to have `estimated`. Fails on the old code (no `reasoningEstimated`).
4. No test for `main.ts` (P-06 outside wiring, P-08, P-14 (1)): Electron main is not loaded by the tests. Proof by reading, and `grep -n "applySettings" src/electron/main.ts` shows each call followed by `refreshLocalSettings()`.
5. No test for P-11: proof by `grep -rn "style\.\|setAttribute(\"style\"" src/renderer` giving no match, and a look at the Usage page (UNTESTED).

## Live step for the hub's live round (not part of this build)

**P1, Gufo endpoints (read-only GET, only after the user loads a Gufo model through the proxy; a GPU switch of minutes, so it needs the user's go-ahead):**
`curl -s -o - -w " %{http_code}" http://127.0.0.1:8081/health`, then the same for `/metrics`, `/v1/status`, `/props`, `/slots`, `/v1/models`. Record per path: status code, the top-level JSON keys (no values beyond numbers and enum-like strings, no prompt text), and whether `/v1/models` entries have `architecture.input_modalities`. Write it to the hub run log. The Gufo tiles (P-01) and the Gufo vision cross-check are then planned in a follow-up ticket from those answers.

## Tasks for workers

Three workers, disjoint files. Worker A changes `src/shared/ipc.ts` first and tells the others when it is done; B and C code against the names below from the start and run `yarn typecheck` only after A's `ipc.ts` change is in.

| worker | files (only these) | inputs | outputs |
|---|---|---|---|
| A, engine and main | `src/shared/ipc.ts`, `src/local-monitor.ts`, `src/electron/main.ts`, `tests/local-monitor.test.ts`, `README.md`, `ROADMAP.md`, `.claude/tickets/AAP-51-pending-ideas/changelog.md` | this plan; B's and C's reports for the changelog | P-05 (c) engine part, P-06, P-08, P-09, P-10, P-14 (1); docs; changelog |
| B, Monitor renderer | `src/renderer/monitor-format.ts` (new), `src/renderer/monitor-view.ts`, `src/renderer/settings.ts`, `src/renderer/settings.css`, `tests/monitor-format.test.ts` (new) | A's `ipc.ts` names | P-03, P-04, P-05 (a), (b), (c) text, (d) display |
| C, provider and Usage | `src/provider.ts`, `src/providers/local-openai.ts`, `src/server.ts`, `src/activity.ts`, `tests/local-openai.test.ts`, `src/renderer/usage-view.ts`, `src/renderer/usage.css` | A's `ipc.ts` names | P-02, P-05 (d) data path, P-11 |

Contract between them:
- `EngineView.speedMissing` values: `"no-metrics" | "no-request" | "metrics-unread"` (A writes, B reads; B's text for `metrics-unread` is "speed not read this time").
- `ActivityEntry.reasoningEstimated?: true` (C, `src/activity.ts`), `ActivityView.reasoningEstimated?: boolean` (A, `src/shared/ipc.ts`), set only together with `reasoningTokens` (C, `server.ts`), shown as "≈" (B).
- `fetchEngine(...)` result `alias?: string` (A only; main.ts is A's).
- Each worker runs its own test file, then `yarn test` and `yarn typecheck`, and reports: files changed, each test's failing-first output (one line), the final pass counts, deviations. The orchestrator runs `yarn test`, `yarn typecheck` and the grep checks once more after all three, then commits once.

## Acceptance criteria

| # | criterion | proof |
|---|---|---|
| A1 | an image request to Strata before its model list is known is forwarded with its image when Strata's list says it reads images; still 400 when it does not or Strata is down | `tests/local-openai.test.ts` test at `:238` and the `:228` assertion |
| A2 | sizes on the Monitor and About pages say GiB, computed from 1024^3 | `gib` test; `grep -n "GB\b" src/renderer/monitor-view.ts` gives no size label |
| A3 | `sparkGeometry` is tested: flat lines at baseline, top and middle, nulls break the line, a single reading is a dot | `tests/monitor-format.test.ts`; the `flatY` mutation fails it |
| A4 | Strata's Prefill (or Decode) dash says why when the other speed exists; a failed `/metrics` read on a server with `--metrics` says "speed not read this time" | `speedSub` table; `local-monitor` "metrics-unread" assertion |
| A5 | an estimated thinking count reaches the activity entry as `reasoningEstimated` and is shown with ≈ on the Monitor and the Requests page | `tests/local-openai.test.ts` test at `:108`; code review of `monitor-view.ts` Thinking cell and `settings.ts:547` |
| A6 | an outside llama-server shows its `--alias` (label when it matches a profile); a path-like alias is not shown; the engine view never carries it | `local-monitor` alias assertions; code review of `main.ts` outside path |
| A7 | a program on Llama.cpp's port whose `/props` is not llama-server's is not shown as a model | `local-monitor` "unexpected answer" assertion |
| A8 | the `/metrics` read stops and cancels once it passes 64 KiB | `local-monitor` cancel assertion |
| A9 | every `applySettings` in `main.ts` is followed by `refreshLocalSettings()`; a failed embedding-server stop is logged and the save returns `ok: true` | `grep -n "applySettings\|refreshLocalSettings\|servers.stop(\"embed\")" src/electron/main.ts`; code review |
| A10 | no inline style in the renderer | `grep -rn "style\.\|setAttribute(\"style\"" src/renderer` gives no match |
| A11 | nothing else breaks | `yarn test` and `yarn typecheck` exit 0; no build was run; `settings.json` untouched |

## UNTESTED (only a person can see these in the window, or a live check)

- The Monitor and About pages after the change: GiB labels, the dot on a single reading between gaps, the Strata Prefill reason, "speed not read this time", the ≈ on the Thinking cell and on the Requests page Tokens cell, an outside Llama.cpp server's alias with "started outside the app".
- The Usage page: the 30-day chart drawn as SVG (segment heights, colours per provider, the minimum segment height, the hover title per day; segments lose their rounded top) and the plan-limit meters as `progress` elements (colours at 75% and 90%).
- A live image request to Strata right after a proxy start, before Strata's first load (needs a proxy restart, which needs a rebuild and the user's go-ahead).
- The render-error notice (P-07) as a person sees it.
- The Antigravity install and terms acknowledgement paths (P-08) and a failing embedding-server stop (P-14 (1)) in the running app.
- Gufo endpoints (P1 above).

## Implementation status (implement, 2026-11-22)

- [x] Worker A: ipc.ts, local-monitor.ts (P-05 c, P-06, P-09, P-10), main.ts (P-06, P-08, P-14 1), README, ROADMAP, local-monitor tests.
- [x] Worker B: monitor-format.ts, monitor-view.ts, settings.ts, settings.css, monitor-format tests (P-03, P-04, P-05 a-d display).
- [x] Worker C: provider.ts, local-openai.ts (P-02, P-05 d), server.ts, activity.ts, usage-view.ts, usage.css (P-11), local-openai tests.
- [x] Verification: `yarn test` 523 passed, 1 skipped; `yarn typecheck` exit 0; style and GB greps empty. Failing-first lines in `changelog.md`.
- [ ] UNTESTED in the window and live: see the UNTESTED section above. Changelog written by the orchestrator, not Worker A.
