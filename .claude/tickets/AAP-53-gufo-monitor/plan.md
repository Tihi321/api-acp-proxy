---
status: done
request: creative-hub/REQ-0031
repos: [api-acp-proxy]
branch: AAP-53_gufo-monitor
updated: 2026-11-23
---

# AAP-53 Gufo on the Monitor: slots, context and speed from its llama-style endpoints, a GPU-loss count, and an image-flag note on About

Hub ticket: creative-hub HUB-44 (`C:\projects\Personal\creative-hub\.claude\tickets\HUB-44-pending-ideas\handoff.md`, item P-01), request REQ-0031. Source of the facts: the Gufo probe P1 of 2026-11-23 (`C:\projects\Personal\creative-hub\runs\hub-44-pending-ideas.md`, section K8; bodies in `C:\projects\Personal\creative-hub\.claude\temp\hub44-live\`). Every line number below was checked on master 07bccd3 (2026-11-23).

## Rules for every worker

- Branch `AAP-53_gufo-monitor`, cut from master 07bccd3. One worker (the change is small and its files are disjoint from nothing else). The worker does not commit; the orchestrator makes **one commit** after the checks: subject `AAP-53: Gufo status on the Monitor, image flag note on About`, written with a Bash heredoc (`git commit -F - <<'EOF'`), a blank line after the subject, last line `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`. No push, no merge.
- The proxy app is **running from `dist/`**: no `yarn build`, no `yarn dist*`, no `yarn app:dev`, no Electron start. Tests and typecheck only. Never read, print or touch `%APPDATA%\api-acp-proxy\settings.json`. No setting is added. No routing change.
- Commands (verified in `package.json` scripts). In Bash, first: `export PATH="/c/Users/Infplane/AppData/Roaming/fnm/aliases/default:$PATH"` (`fnm exec yarn` fails). Run from `C:\projects\Personal\api-acp-proxy`:
  - all tests: `yarn test` (`vitest run`); one file: `yarn test tests/<file>.test.ts`
  - typecheck: `yarn typecheck` (node, renderer and tests configs)
  - there is **no lint script** in `package.json`; do not invent one.
- Monitor rule: counts and timings only, never prompt or answer text, never a key value, never a path. Gufo's `/slots` carries a `prompt` field and `/props` carries `model_path` and `build_info`: none of them is ever mapped (the mapper whitelists fields). Renderer text only through `textContent` (or `make(tag, class, text)`); no inline styles anywhere in `src/renderer` (CSP `style-src 'self'`, `src/renderer/settings.html:5`).
- Tests follow the global `test-discipline` skill: only the tests listed under Tests, in the files named there. Every new or changed assertion is first **shown failing** on the unchanged code, and the failing line is pasted into `changelog.md`.
- Working trees are CRLF, git stores LF (`core.autocrlf true`; `src/local-monitor.ts` is CRLF): do not flip line endings. Write regexes and Windows paths with the Edit or Write tool, not through a Bash heredoc (backslashes get stripped).

## What the probe showed (K8, recorded 2026-11-23, Gufo `gufo/Qwen3.8-27B` on 8081, started by the proxy)

| path | answer | what the Monitor can use |
|---|---|---|
| `/health` | 200 `{"status":"ok"}` | nothing (used by the studios' autostart, P-26) |
| `/metrics` | 200 Prometheus text, 2,801 bytes: 14 `llamacpp:*` and 3 `gufo_*` series | the four counters `parseLlamaMetrics` reads are **all there with llama-server's names** (`llamacpp:prompt_tokens_total`, `prompt_seconds_total`, `tokens_predicted_total`, `tokens_predicted_seconds_total`); `gufo_device_lost_total` |
| `/v1/status` | 404 | nothing |
| `/props` | 200 | `total_slots` 1 and `default_generation_settings.n_ctx` 32768 (so AAP-51's identity rule passes), `modalities.vision` true; **no `endpoint_metrics` field**; `build_info` 49 characters, content not recorded |
| `/slots` | 200, array of 1 | `id`, `n_ctx`, `is_processing`, `n_prompt_tokens`: exactly the four fields `mapLlama` reads (`src/local-monitor.ts:143-148`); also `prompt` (never read) |
| `/v1/models` | 200 | `architecture.input_modalities ["text","image"]`, `owned_by "gufo"` |

Conclusion: Gufo's language-model server answers the llama-server status paths with the same field and counter names, so the whole Llama.cpp path (`mapLlama`, `parseLlamaMetrics`, the AAP-51 identity check, the capped `readText`) is shared. Three differences need code: the view's `kind`, no `endpoint_metrics` (Gufo serves `/metrics` without a flag: the preset args `src/settings.ts:51` have no `--metrics`, and the probe got 200), and `build_info`, whose content was not recorded and so is not shown.

## Scope (item, decision, verified cause)

| item | decision | cause, verified on 07bccd3 |
|---|---|---|
| P-01 (a) Gufo engine tiles | IN | `fetchEngine` returns `{}` for Gufo before any request (`src/local-monitor.ts:204`, comment `:202`), so `MonitorView.engine` is absent (`src/shared/ipc.ts:294`) and every engine tile shows a dash with "No status source for Gufo" (`src/renderer/monitor-view.ts:149`). Fix: read Gufo like llama-server and map it with `mapLlama(..., "gufo")`. |
| P-01 (a) speed reasons | IN | `mapLlama` says `"no-metrics"` when no counter was read and `/props` lacks `endpoint_metrics: true` (`local-monitor.ts:156`); Gufo's `/props` never has that field, so a failed `/metrics` read would show "restart the model for speed" (`src/renderer/monitor-format.ts:48`), which is wrong advice for Gufo (it has no such flag). Fix: for Gufo a missing read is always `"metrics-unread"` ("speed not read this time"), and the renderer never gives a llama-server or `--metrics` text for Gufo. |
| P-01 (a) identity check | IN (no new code) | AAP-51's rule (`local-monitor.ts:216-217`: a `/props` without `total_slots` and without `default_generation_settings` is "unexpected answer") applies to Gufo unchanged, since Gufo goes through the same branch; the recorded `/props` has both. Asserted in the test. |
| P-01 (a) Gufo key | IN | Gufo has an optional `apiKey` (`src/settings.ts:19`, `localBase`; secret list `:385`) that the chat path sends as `Bearer` (`src/providers/local-openai.ts:182`), but the Monitor sends a key only for Strata (`src/electron/main.ts:557`) and `readText` sends no header at all (`local-monitor.ts:180`). Without it a Gufo started with a key would answer the Monitor 401. Fix: send Gufo's key in the `Authorization` header of its three reads, nowhere else. |
| P-01 (a) Gufo image models | IN | A Gufo image profile (`kind: "image"`, `src/settings.ts:52`, `serve image ...`) was not probed; reading `/props` from it would most likely give "Engine: HTTP 404" instead of today's honest dash. Fix: `main.ts` does not read the engine for a Gufo image profile, and the reason text becomes "No status source for Gufo image models". |
| P-01 (a) renderer kind checks | IN | `const llama = engine?.kind === "llama"` (`monitor-view.ts:186`) decides whether speed values are shown (`:187`) and which speed sub line is used (`:189`); a `"gufo"` engine would be treated as Strata and its speeds hidden by `fromStrata`. `reason()` returns "No status source for Gufo" before "Starting" (`:149-150`). |
| P-01 (a) `gufo_*` counters | `gufo_device_lost_total` IN; the two `gufo_spec_lookup_*` OUT | `gufo_device_lost_total` (HELP "Confirmed GPU context losses", recorded 0) is a count whose non-zero value plainly means the GPU was lost and the model may be broken: shown as the Engine tile's sub line only when it is above 0. `gufo_spec_lookup_tokens_total` / `gufo_spec_lookup_accepted_tokens_total` (prompt-lookup copies proposed / accepted, both 0 in the sample) only mean something as an acceptance rate next to the `llamacpp:spec_decode_*` counters, which Llama.cpp has as well: that is a new Speculation tile for two servers and needs a design (Extra ideas). |
| P-01 (a) Gufo build string | OUT | `/props` `build_info` was recorded only as "string, 49 chars" (`gufo-props.json`); its content is unknown (it could carry a path). Not copied for Gufo; About shows "Gufo" without a version, as today (`monitor-view.ts:277`). |
| P-01 (a) outside Gufo | OUT | The outside-server path lists only Strata and Llama.cpp (`main.ts:564-567`); there is no Gufo outside path today, so nothing is extended (Extra ideas). |
| P-01 (b) vision cross-check | IN (read-only note) | The `vision: false` in the proxy's row for `gufo/Qwen3.8-27B` comes from the Gufo profile (`GufoProfileView.vision`, `src/shared/ipc.ts:58`), which starts as the repo preset `qwen27-q4` with `vision: false` (`src/settings.ts:55`) and lives in the user's settings; `main.ts:553` copies it into `profileFacts.vision`. The About page's Images tile shows `engine?.images ?? facts?.vision` (`monitor-view.ts:279`), so with Gufo's engine read it will say "yes" (from `/props` `modalities.vision`) while the routing still refuses images for that profile (README `:173`, 400 before any switch). The handoff decided the profile is the user's business (section 3, "Decided no change"). Fix: no routing change, no settings edit; the Images tile's sub line says "the server reports image input; the profile says no vision" (or the reverse text) when the two disagree. |

## Out of scope

- Routing, the profile's `vision` flag, the presets in `src/settings.ts`, `/v1/models` output.
- A Speculation or prompt-cache tile from `llamacpp:spec_decode_*`, `llamacpp:prompt_tokens_cached_total`, `gufo_spec_lookup_*`; the gauges `requests_processing`, `requests_deferred`, `kv_cache_usage_ratio`.
- A Gufo server started outside the app; Gufo image server endpoints.

## Files to touch (verified)

**`src/shared/ipc.ts`** (first):
- `:266` `kind: "strata" | "llama" | "gufo";`
- `:273` doc comment of `speedMissing`: "llama and gufo only, ..." and add at the end: "Gufo has no `endpoint_metrics` and serves /metrics without a flag: a Gufo read with no counters is always \"metrics-unread\"."
- After `:274` add: `/** gufo only: \`gufo_device_lost_total\` from /metrics, confirmed GPU context losses since the server started. */ deviceLost?: number;`
- `:294` comment: `// absent for a Gufo image model, when none is loaded, or when the engine did not answer`

**`src/local-monitor.ts`**:
- After `parseLlamaMetrics` (`:136`), a new exported pure function (regex through the Edit tool):
  ```ts
  /** Gufo's `gufo_device_lost_total` counter (confirmed GPU context losses) from its Prometheus text; undefined when absent or not a whole number >= 0. */
  export function parseGufoDeviceLost(body: string): number | undefined {
    const match = /^gufo_device_lost_total ([0-9.eE+-]+)\r?$/m.exec(body);
    const value = match ? Number(match[1]) : Number.NaN;
    return Number.isInteger(value) && value >= 0 ? value : undefined;
  }
  ```
- `mapLlama` (`:138-158`): signature `mapLlama(props: unknown, slotsJson: unknown, metricsText?: string, kind: "llama" | "gufo" = "llama"): EngineView`. Inside: `kind` (not the literal `"llama"`) in the result; `version: kind === "llama" ? build : undefined`; `speedMissing: parsed === undefined ? (kind === "gufo" || root["endpoint_metrics"] === true ? ("metrics-unread" as const) : ("no-metrics" as const)) : hasSpeed ? undefined : ("no-request" as const)`; add `deviceLost: kind === "gufo" && metricsText !== undefined ? parseGufoDeviceLost(metricsText) : undefined`. Doc comment `:138` gains: "Also Gufo's language-model server (`kind` \"gufo\"), which answers the same paths with the same fields (creative-hub HUB-44 K8); its `build_info` is not copied."
- `readText` (`:177-180`): a fourth parameter `headers: Record<string, string> = {}` used in the `fetchImpl` call (`:180`) instead of `{}`; doc comment "no headers" becomes "the given headers only (Gufo's key)".
- `fetchEngine` (`:202-222`): doc comment `:202` "Gufo: no known endpoint, no request." becomes "Gufo is read like llama-server (`/props`, `/slots`, `/metrics`) with its key in the header." Delete `:204`. Before the Strata branch: `const headers: Record<string, string> = apiKey ? { Authorization: \`Bearer ${apiKey}\` } : {};` and use `headers` in the Strata read (`:207`), both `readJson` calls (`:213`) and the `readText` call (`:219`, new fourth argument). Return (`:220-221`): `const alias = server === "llama" ? llamaAlias(props.json) : undefined; return { engine: mapLlama(props.json, "json" in slots ? slots.json : undefined, metrics, server === "gufo" ? "gufo" : "llama"), ...(alias ? { alias } : {}) };`. The identity check (`:216-217`) stays as is and now covers Gufo; its comment gains "(Gufo's /props has both too)".

**`src/electron/main.ts`**:
- `:556` `if (local.state === "ready" && local.port !== undefined && gufoProfile?.kind !== "image") {` with a comment line before it: `// A Gufo image model was never probed: no engine read, the page says so.`
- `:557` `const key = server === "strata" ? strataSettings?.apiKey || undefined : server === "gufo" ? gufoSettings?.apiKey || undefined : undefined;`
- The outside path (`:563-582`) is not changed.

**`src/renderer/monitor-format.ts`**:
- `SpeedSubInput` (`:40`): add `gufo?: boolean`. In `speedSub` (`:43-49`), replace `:47` by `if (input.speedMissing === "metrics-unread" || input.gufo) return "speed not read this time";` and add the doc line: "`llama` is true for Llama.cpp and Gufo (llama-style counters); Gufo never gets a llama-server or --metrics text."
- Two new exported pure functions:
  ```ts
  /** The Engine tile's sub line for Gufo's GPU context losses: shown only when the count is above 0. */
  export function deviceLostText(count: number | undefined): string | undefined {
    return count !== undefined && count > 0 ? `GPU context lost ${count} ${count === 1 ? "time" : "times"} since Gufo started` : undefined;
  }
  /** The About Images tile's sub line when the server's own image flag and the profile's vision flag disagree; undefined when they agree or one is unknown. Read-only: routing follows the profile. */
  export function imagesNote(engineImages: boolean | undefined, profileVision: boolean | undefined): string | undefined {
    if (engineImages === undefined || profileVision === undefined || engineImages === profileVision) return undefined;
    return engineImages ? "the server reports image input; the profile says no vision" : "the server reports no image input; the profile says vision";
  }
  ```

**`src/renderer/monitor-view.ts`**:
- `:2` import also `deviceLostText`, `imagesNote`.
- `reason()` `:149-150`: swap so "Starting" comes first, and change the Gufo line to `if (view.local.server === "gufo") return "No status source for Gufo image models";` (only an image model reaches it now: a Gufo language model has an engine or an `engineError`).
- `:170` Engine tile: `tile("Engine", engine ? (engine.state === "unknown" ? undefined : engine.state) : undefined, engine ? deviceLostText(engine.deviceLost) : why)`.
- `:186` `const llama = engine?.kind === "llama" || engine?.kind === "gufo";`
- `:189` add `gufo: engine?.kind === "gufo"` to the `speedSub({...})` input.
- `:287` Images tile sub line: `images !== undefined ? imagesNote(engine?.images, facts?.vision) ?? profileNote(engine?.images) : why ?? "no source"`.
- Nothing else: the GPU, VRAM, Prompt reused and Conversation cache tiles keep "from Strata" for Gufo as for Llama.cpp; the About engine name stays "Gufo" (`:277`, fallback via `local.server`).

**`README.md:31`** (Monitor paragraph): replace "a dash for Gufo" with "since AAP-53 the same for a Gufo language model, from its llama-server style `/props`, `/slots` and `/metrics`", and append: "Since AAP-53 the Engine tile says how often Gufo lost its GPU context when that count is above 0, a Gufo image model shows no engine numbers (\"No status source for Gufo image models\"), and the About page's Images tile says when the server's own image flag and the profile's vision flag disagree (requests still follow the profile)."

**`ROADMAP.md`**: a new row after `:49` (the AAP-52 row), in its style: "- [x] Gufo on the Monitor (AAP-53; creative-hub HUB-44, REQ-0031; live check UNTESTED): a Gufo language model shows its state, slots, context and average speed from its llama-server style /props, /slots and /metrics (Gufo's key in the header), the Engine tile counts GPU context losses above 0, a Gufo image model says it has no status source, and About notes when the server's image flag and the profile's vision flag disagree (no routing change)." Delete `:52` ("Monitor next cut: Gufo status once its endpoints are known ..."), which this row closes.

**`.claude/tickets/AAP-53-gufo-monitor/changelog.md`** (new): files, deviations, each test's failing-first line, test counts, the UNTESTED list.

## Test fixture (copied from the recorded bodies of 2026-11-23; `model_path`, `build_info` and the slot `prompt` replaced by planted markers that must never come through)

Put these constants at the top of `tests/local-monitor.test.ts`, after `llamaMetrics` (`:49`), with the comment `// Gufo 8081, recorded 2026-11-23 (creative-hub HUB-44 K8), trimmed; planted text must never come through.`:

```ts
const gufoProps = {
  model: "Qwen3.8-27B", model_alias: "Qwen3.8-27B", template: "", model_info: {}, model_path: "SECRET-PATH", build_info: "SECRET-BUILD",
  total_slots: 1, default_generation_settings: { n_ctx: 32768, params: { temperature: 1, top_k: 20, max_tokens: -1 } },
  modalities: { vision: true, video: false, audio: false },
};
const gufoSlots = [{
  id: 0, n_ctx: 32768, speculative: true, is_processing: false, id_task: -1, task_id: -1, state: 0, n_prompt_tokens: 0, n_prompt_tokens_cache: 0,
  n_prompt_tokens_processed: 0, prompt: "SECRET-TEXT", next_token: [{ has_next_token: false, has_new_line: false, n_remain: -1, n_decoded: 0 }], model: "Qwen3.8-27B",
}];
const gufoMetrics = [
  "# HELP gufo_device_lost_total Confirmed GPU context losses",
  "# TYPE gufo_device_lost_total counter",
  "gufo_device_lost_total 0",
  "llamacpp:prompt_tokens_total 18",
  "llamacpp:prompt_tokens_cached_total 0",
  "llamacpp:prompt_seconds_total 0.52592850000000002",
  "llamacpp:tokens_predicted_total 1",
  "llamacpp:tokens_predicted_seconds_total 0.41458859999999997",
  "llamacpp:n_tokens_max 19",
  "llamacpp:spec_decode_num_drafts_total 1",
  "llamacpp:spec_decode_num_draft_tokens_total 6",
  "llamacpp:spec_decode_num_accepted_tokens_total 0",
  "gufo_spec_lookup_tokens_total 0",
  "gufo_spec_lookup_accepted_tokens_total 0",
  "llamacpp:prompt_tokens_seconds 34.225184602089449",
  "llamacpp:predicted_tokens_seconds 2.4120296602463265",
  "llamacpp:requests_processing 0",
  "llamacpp:requests_deferred 0",
  "llamacpp:kv_cache_usage_ratio 0",
  "",
].join("\n");
```

Expected speeds from the counters: prefill 18 / 0.5259285 s = 34.22 -> 34.2 t/s; decode 1 / 0.4145886 s = 2.41 -> 2.4 t/s (the recorded gauges 34.2 and 2.4 agree).

## Tests (test-discipline: one new `it`, the rest extend existing ones)

1. **`tests/local-monitor.test.ts`**, a new `it` after the llama mapping test (`:97`): `"maps Gufo's llama-style props, slots and metrics, never text, a path or its build string"`:
   - `expect(mapLlama(gufoProps, gufoSlots, gufoMetrics, "gufo")).toEqual({ kind: "gufo", state: "idle", context: 32768, speed: { decodeTokS: 2.4, prefillTokS: 34.2 }, images: true, slots: [{ id: 0, busy: false, tokens: 0, ctx: 32768 }], requests: [], deviceLost: 0 });` (exact: no `version`, no `speedMissing`).
   - its `JSON.stringify` contains neither "SECRET" nor "Qwen3.8".
   - `mapLlama(gufoProps, gufoSlots, undefined, "gufo")` has `speedMissing` "metrics-unread" and no `speed`.
   - `mapLlama(gufoProps, gufoSlots, gufoMetrics.replace("gufo_device_lost_total 0", "gufo_device_lost_total 2"), "gufo").deviceLost` is 2.
   - `mapLlama(llamaProps, llamaSlots, \`${llamaMetrics}gufo_device_lost_total 3\n\`)` has no property `deviceLost` (only Gufo reads it).
   Fails on the old code: `mapLlama` ignores the fourth argument and returns `kind: "llama"` with `version: "SECRET-BUILD"`.
2. **`tests/local-monitor.test.ts`**, the test at `:99`: rename it to `"keeps keys in the request header, reports an unreachable port and reads Gufo like llama-server"` and replace `:150-152` (the "does not call Gufo" lines) with:
   - a fake that records `{ url, headers }` and answers `/props` with `gufoProps`, `/slots` with `gufoSlots`, anything else with `gufoMetrics`; `const gufo = await fetchEngine("gufo", 8081, "GUFO-KEY-1", gufoFetch);`
   - `expect(gufo.engine?.kind).toBe("gufo")`, `expect(gufo.engine?.speed?.prefillTokS).toBe(34.2)`, `expect(gufo).not.toHaveProperty("alias")`;
   - the sorted URLs are exactly `http://127.0.0.1:8081/metrics`, `/props`, `/slots`, and every recorded `headers.Authorization` is `"Bearer GUFO-KEY-1"`; `JSON.stringify(gufo)` does not contain "GUFO-KEY-1";
   - `expect(await fetchEngine("gufo", 8081, undefined, () => answer({ status: "ok" }))).toEqual({ error: "unexpected answer" })` (the AAP-51 identity rule for Gufo; `{ status: "ok" }` is what Gufo's `/health` says, not its `/props`).
   Fails on the old code: `fetchEngine("gufo", ...)` returns `{}` and asks nothing.
3. **`tests/monitor-format.test.ts`**:
   - the `speedSub` table (`:22-29`) gets one row: `["Gufo without a speed read", { llama: true, gufo: true }, "speed not read this time"]`. Fails on the old code ("restart the model for speed").
   - a new `it("notes a GPU context loss and an image flag that disagrees with the profile")`: `deviceLostText(undefined)` and `deviceLostText(0)` undefined; `deviceLostText(1)` "GPU context lost 1 time since Gufo started"; `deviceLostText(2)` "GPU context lost 2 times since Gufo started"; `imagesNote(true, false)` "the server reports image input; the profile says no vision"; `imagesNote(false, true)` "the server reports no image input; the profile says vision"; `imagesNote(true, true)` and `imagesNote(true, undefined)` undefined. Fails on the old code (`deviceLostText is not a function`).
4. No test for `main.ts` (Electron main is not loaded by the tests) and none for the DOM code in `monitor-view.ts`: proof by reading (`git diff` of both) and `grep -n "kind === \"llama\"" src/renderer/monitor-view.ts` showing the `|| engine?.kind === "gufo"` line.

## Tasks for workers

| worker | files (only these) | outputs |
|---|---|---|
| one | `src/shared/ipc.ts`, `src/local-monitor.ts`, `src/electron/main.ts`, `src/renderer/monitor-format.ts`, `src/renderer/monitor-view.ts`, `tests/local-monitor.test.ts`, `tests/monitor-format.test.ts`, `README.md`, `ROADMAP.md`, `.claude/tickets/AAP-53-gufo-monitor/changelog.md` | all of P-01 (a) and (b) |

Order: (1) write the fixture and the tests of items 1-3 on the unchanged code, run `yarn test tests/local-monitor.test.ts tests/monitor-format.test.ts`, paste one failing line per test into the changelog; (2) `ipc.ts`; (3) `local-monitor.ts`; (4) `main.ts`; (5) `monitor-format.ts`, `monitor-view.ts`; (6) both test files pass; (7) `yarn test` and `yarn typecheck` (both green); (8) the `style.` grep below; (9) README, ROADMAP, changelog. Report: files changed, failing-first lines, pass counts, deviations. The orchestrator reruns `yarn test`, `yarn typecheck` and the greps, reads the diff, then commits once.

## Acceptance criteria

| # | criterion | proof |
|---|---|---|
| G1 | a loaded Gufo language model gives an engine view with kind "gufo", state, slots, context 32768 from slot 0's `n_ctx`, images, and both speeds from the four llama counters | new `it` (item 1); `fetchEngine` assertions (item 2) |
| G2 | the view never carries the slot `prompt`, `model_path`, `build_info`, the model name or the key | "SECRET", "Qwen3.8", "GUFO-KEY-1" absent (items 1, 2) |
| G3 | Gufo's key goes in the `Authorization` header of its three reads and nowhere else; Llama.cpp still gets no header from `main.ts` | item 2; `main.ts:557` diff |
| G4 | a program on 8081 whose `/props` is not llama-style is "unexpected answer" | item 2 last assertion |
| G5 | a Gufo speed dash says "speed not read this time", never a llama-server or `--metrics` text | `speedSub` row (item 3); mapper "metrics-unread" (item 1) |
| G6 | `gufo_device_lost_total` above 0 shows as the Engine tile's sub line; 0 shows nothing | item 1 (`deviceLost` 0 and 2); `deviceLostText` (item 3); `monitor-view.ts:170` diff |
| G7 | a Gufo image profile is not read and says "No status source for Gufo image models"; a starting Gufo says "Starting" | `main.ts:556`, `monitor-view.ts:149-150` diff |
| G8 | About's Images tile notes a disagreement between the server's image flag and the profile's vision; routing and settings unchanged | `imagesNote` (item 3); `git diff --stat` shows no change under `src/providers`, `src/router.ts`, `src/settings.ts` |
| G9 | no inline style in the renderer | `grep -rn "style\.\|setAttribute(\"style\"" src/renderer` gives no match |
| G10 | nothing else breaks | `yarn test`, `yarn typecheck` |

## UNTESTED (needs the user's go-ahead for a GPU switch, and the user's eyes)

- The Monitor and About pages with a real Gufo loaded (request `gufo/Qwen3.8-27B` through the proxy, then open Monitor and About): the tiles, the speed after a request, the Images note "the server reports image input; the profile says no vision".
- A Gufo started with a key (`providers.gufo.apiKey` set and Gufo run with it): not configured on this PC.
- `gufo_device_lost_total` above 0 (never seen).
- A Gufo image profile on the Monitor (not probed); `gufo/flash-next-q4` and `gufo/deepseek4` (only Qwen3.8-27B was probed; assumed to answer the same paths).
- Whether `gufo/Qwen3.8-27B` really reads images (its `/props` says so although its args have no `--mmproj`); not tested, and this ticket changes nothing about it.
