---
status: done
request: REQ-0027
repos: [api-acp-proxy]
branch: AAP-72_aap71-next-ideas
updated: 2026-11-28
---
# AAP-72: six follow-ups from AAP-71

Base: `master` at 146eadd (AAP-70 and AAP-71 merged). Background: `../AAP-71-aap70-extra-ideas/plan.md` (D1-D13, K1-K9 and the
"Polish round 1" note at the end), `../AAP-71-aap70-extra-ideas/discoveries.md` and `changelog.md`, and
`../AAP-70-deepseek-provider-tokens/plan.md`. Line numbers below are for 146eadd.

Reading of the brief: the full version of each item. Item 3 means a real Cost metric on the chart plus a today line on the Overview row.
Item 5 means four new Overview rows built only from data the window already has.

## Scope

1. **Ollama stale default context.** `prepareModel` also forgets the measured default context when `/api/ps` reports a number that
   differs from the stored one. The next `generate` then runs load-first and measures again. The related low item: an `/api/ps` entry
   without `context_length` counts as "`/api/ps` unsupported" for 10 minutes, so requests stop running load-first every time.
2. **`max_output_tokens` in `/v1/models`.** It is added to every listed model whose provider knows its output limit (DeepSeek from
   `/models`, else 393216; any provider of the `LocalOpenAiProvider` family whose `/models` reports `max_output_tokens`). It is left out
   where the limit is unknown. No existing field changes.
3. **Cost in the UI.**
   1. A third "Cost" button on the Usage chart's metric switch. It shows USD per day, stacked per provider.
   2. The Overview DeepSeek row gets a "Today:" line with requests, tokens and spend, from the usage data.
4. **Ollama near-`num_ctx` warning.** When an Ollama answer's prompt tokens are at least 90% of the measured default context, the proxy
   logs one warn line.
5. **Overview rows for Gufo, Strata, Llama.cpp and Ollama.** Each row has the state badge, one state line (from the launcher state, or
   for Ollama from the provider state), the model count chip, the same "Today:" line as item 3.2, and a Settings button. There are no new
   probes.
6. **README.** The "npm only" sentence and the npm install lines are corrected to Yarn 4.

## Out of scope (explicit)

- Sending `num_ctx` or any `options` to Ollama, and any change to how the default context is measured, except the item 1 rule.
- The pre-existing race where the background `measureDefault` after a chat reads a context another client set in between (see Risks).
- Transient `/api/ps` 500 / 401 / timeout handling. These already map to `undefined` ("unknown") in `readLoadedContext`
  (`local-openai.ts:221-227`), so `prepareModel` keeps the stored value. The only cost is that a model that was never measured runs
  load-first again on the next request, which is cheap when it is loaded. This is left as it is (see item 1 analysis).
- `max_output_tokens` in the MCP endpoint's model list, in the settings window or in `/healthz`. ACP providers get no output limit.
- A cost line on the Overview "Today" strip or on the DeepSeek settings page. Cost for any provider other than DeepSeek.
- A "Today:" line on the three ACP rows (Codex, Claude, Antigravity). See Extra ideas in the report.
- Start / Stop / profile buttons on the new Overview rows. Any new Ollama reachability probe or timer.
- Marking the near-`num_ctx` case in the activity entry, the response or a header (log only, see OD1).
- Rewriting every `npm run` line of the README to `yarn` (see OD5), and any change to `package.json`, CI or the lockfile.
- The open D15 / T4 legacy-id question from AAP-70.

## Item 1 analysis (the contract for T1)

Today (`src/providers/local-openai.ts:207-208`):
```ts
if (!this.profiles && this.psSupported() && (await this.readLoadedContext(model, signal)) === null) this.defaultContext.delete(model);
```
New rule:
```ts
if (!this.profiles && this.psSupported()) {
  const current = await this.readLoadedContext(model, signal);
  const stored = this.defaultContext.get(model);
  if (current === null || (typeof current === "number" && stored !== undefined && current !== stored)) this.defaultContext.delete(model);
}
```
`undefined` (an error or a timeout) still changes nothing. `generate` (`:361`) already runs `loadFirst` when
`!this.defaultContext.has(model)`, so the rest follows unchanged:
1. `POST /api/generate {"model"}` loads the model at its default options.
2. `measureDefault` reads `/api/ps`.
3. `checkPrompt` runs.

**F2 (a client loaded the model with its own `num_ctx`) is still not adopted.** Ollama reloads a runner whose options differ from the
request's options (the AAP-71 live fact: `/v1` reloads a runner started with other options). The load-first request carries default
options, so it reloads the model at the default, and the measurement after it is the default, not the foreign value. The proxy's own
`/v1` chat would have caused the same reload a moment later, so the change only moves that reload earlier. It does not add one.

There is a side effect. In the F2 case, a stream request over the limit is now refused from inside `loadFirst`, which is an SSE error
event after a 200. Before, it was a real HTTP 400 from the check after `prepare` (K9). This happens only on the first request after
another client reloaded the model. It is accepted.

**No reload loop.** After `loadFirst` the stored value equals what `/api/ps` shows, so the next `prepareModel` compares equal and does
nothing. A reload happens only when another client changed the runner since the last proxy run, and in that case the proxy's `/v1`
request reloads anyway. Two clients that keep switching the model's context cause one reload per switch, as they do today.

**The stale-default symptom is fixed.** Suppose the user raised the default (`OLLAMA_CONTEXT_LENGTH`, the app setting, or a Modelfile
`PARAMETER num_ctx`) and another client loaded the model first. `/api/ps` shows the new value, which is not the stored one, so the
stored value is dropped. Load-first then sends default options, which match the running runner, so nothing is reloaded. The
measurement gives the new default.

**Low item, `/api/ps` entry without `context_length`.** `ollamaLoadedContext` (`:589-597`) returns `undefined` for a found entry
without a numeric `context_length > 0`. `readLoadedContext` maps that to `null` ("not loaded"), so every request deletes the value, runs
load-first and logs the "loading" info line. The minimal fix is in `ollamaLoadedContext`:
- an entry that is found but has no usable `context_length` throws `new PsUnsupportedError("no context_length")`;
- `models: []` or no matching entry still returns `undefined`.

The existing catch (`:223-226`) then switches load-first and the `/api/ps` reads off for 10 minutes and clears `defaultContext`, so the
limit comes from `/api/show` × 4. That is the same path as an old Ollama without `/api/ps`, and it logs one info line per 10 minutes.

## Open decisions (recommendation first; the director or user may override)

- **OD1 Warning threshold and place (item 4).** Recommended:
  - Warn when `promptTokens >= Math.ceil(measured × 0.9)`, where `promptTokens = usage.inputTokens + (usage.cachedReadTokens ?? 0)` and
    `measured = defaultContext.get(model)`.
  - Use `this.logger.warn` only, once per request, with no activity field.
  - Do not warn when no default is measured. `/api/show` is the model's maximum, not the context it runs at.

  Why 90%: Ollama cuts an over-long prompt down to about `num_ctx`, so a cut prompt reports about 100%. Below 90% a cut is unlikely, and
  the generation still has some room. An activity flag would touch `ActivityEntry`, the server trace, ipc and the renderer, which is not
  minimal.
- **OD2 Which local rows show.** Recommended: all four always, in the order Gufo, Strata, Llama.cpp, Ollama, after DeepSeek. Disabled
  rows say "Off. Turn it on on its page.", like the ACP rows. The alternative is to hide disabled local providers.
- **OD3 Actions on local rows.** Recommended: the Settings button only. Gufo and Llama.cpp start with a profile choice on their pages.
- **OD4 Cost button visibility.** Recommended: always shown. With no cost, the chart shows the empty state "No priced requests in the
  last 30 days (only DeepSeek has prices)."
- **OD5 README scope.** Recommended:
  - Fix the sentence and the two install lines (`npm install` in Headless CLI, `npm ci` in Development).
  - Keep the `npm run <script>` lines and add one line saying that `yarn <script>` works the same, as CI uses.
  - Reason: installing with npm ignores `yarn.lock` and writes a `package-lock.json`, which is the real defect. `npm run` works with
    `nodeLinker: node-modules`.
- **OD6 Today line text.** Recommended: `Today: 12 requests · ≈ 34.5K tokens · 1 error · $0.0123`.
  - The "≈ " appears only when some counts are estimated, the error part only when there are errors, and the cost part only when it is
    above 0.
  - The line is left out when today has 0 requests.
  - Tooltip: the full numbers and `formatUsdFull`.

## Contracts

K1 `src/providers/local-openai.ts` (T1):
- `prepareModel` (`:207-208`) follows the item 1 rule. Update the comment to: "a model that is not loaded any more, or runs at another
  context than the one measured, is measured again by the next load".
- `ollamaLoadedContext` (`:589-597`) follows the low-item fix. Update the doc comment.
- In `generate`, right before `if (this.psSupported()) void this.measureDefault(model);` (`:436`), add the OD1 warning:
  ```ts
  const measured = this.loadedContext ? this.defaultContext.get(model) : undefined;
  if (reported && measured) { const promptTokens = reported.inputTokens + (reported.cachedReadTokens ?? 0); if (promptTokens >= Math.ceil(measured * NEAR_CONTEXT_SHARE)) this.logger.warn(`${this.displayName}: the prompt of ${model} used ${promptTokens} of the ${measured} tokens of its context (num_ctx); Ollama may have dropped the start of the prompt without an error. Raise num_ctx in Ollama to be sure the whole prompt is read.`); }
  ```
  Add the constant `const NEAR_CONTEXT_SHARE = 0.9;` next to `LOADED_CHARS_PER_TOKEN` (`:58`), with a one-line doc.

K2 Output limit surface (T2):
- `src/provider.ts:224`: after `maxPromptCharsFor?`, add
  `maxOutputTokensFor?(model: string): number | undefined;` with the doc "The model's output limit in tokens when the provider knows it;
  listed as `max_output_tokens` in /v1/models."
- `src/providers/local-openai.ts:318`: `protected maxOutputTokensFor` becomes public. Drop `protected`, keep the body.
- `src/providers/deepseek.ts:56`: `protected override maxOutputTokensFor` becomes `override maxOutputTokensFor`.
- `src/router.ts:31`: `ListedModel` gets `maxOutputTokens?: number`.
- `src/router.ts:232-233`: in `entries()`, add `const output = provider.maxOutputTokensFor?.(model.id);` and put
  `...(output ? { maxOutputTokens: output } : {})` into `limit`. That covers both the bare alias and the prefixed entry.
- `src/server.ts:553`: in the `/v1/models` map, add `...(model.maxOutputTokens ? { max_output_tokens: model.maxOutputTokens } : {})`
  right after `max_prompt_chars`. Nothing else in the entry changes.

K3 Renderer helpers, `src/renderer/overview-lines.ts` (new, pure, no DOM; T3):
```ts
import type { LocalServerStatusView, ProviderStatusView, UsageCountsView } from "../shared/ipc.js";
/** OD6. Undefined when there are no counts or 0 requests. `count` formats a number (default: compact Intl); `usd` is formatUsd. */
export function todayUsageLine(counts: UsageCountsView | undefined, count?: (value: number) => string): string | undefined;
/** The state line of a local provider row (no DOM). */
export function localProviderLine(input: {
  id: "gufo" | "strata" | "llama" | "ollama";
  status: ProviderStatusView | undefined;          // undefined or state "disabled" -> "Off. Turn it on on its page."
  launcher?: LocalServerStatusView;                // gufo / strata / llama only
  profileLabel?: string;                           // the label of launcher.profile, resolved by the caller
  serverRunning: boolean;                          // the proxy server state === "running"
  ollamaUrl?: string;                              // settings.providers.ollama.baseUrl
}): string;
```
`localProviderLine` rules, the first match wins:
1. disabled → "Off. Turn it on on its page."
2. gufo / strata / llama, by the launcher state:
   - `ready` → `Running${profileLabel ? ` ${profileLabel}` : ""}${launcher.port ? ` on port ${launcher.port}` : ""}.`
   - `starting` → "Starting…"
   - `error` → `launcher.error ?? "The server failed to start."`
   - otherwise → "Stopped. Start it on its page."
3. ollama:
   - the proxy is not running → "The server is not running."
   - `status.state === "ready"` → `Reachable at ${ollamaUrl}.`
   - `status.error` → that text
   - otherwise → "Not checked yet."

K4 Usage view handle (T3), `src/renderer/usage-view.ts`:
- `UsageViewDeps` gets `onUsageChange?(): void`. It is called at the end of `renderUsage()`.
- `UsageViewHandle` gets `todayOf(id: string): UsageCountsView | undefined`, which returns `usage?.providers.find((p) => p.id === id)?.today`.
- `Metric` becomes `"requests" | "tokens" | "cost"`. The stored metric is read as one of the three, else "requests".
- In `renderChart`:
  - `valueOf` returns `counts.costUsd` for "cost".
  - The segment tooltip uses `formatUsd(value)` for cost and `full.format` otherwise.
  - The aria label is "Cost (USD) per day, last 30 days".
  - The empty state is the OD4 text.

## Files and modules to touch

| File:line (146eadd) | Change | Task |
|---|---|---|
| `src/providers/local-openai.ts:58,207-208,433-436,589-597` | K1 (item 1, low item, item 4) | T1 |
| `tests/local-openai.test.ts:286-384` (the Ollama `it`), plus one new small `it` in `describe("LocalOpenAiProvider")` | AC1-AC4 | T1 |
| `src/provider.ts:224` | K2 | T2 |
| `src/providers/local-openai.ts:318` | K2, one word | T2 (after T1) |
| `src/providers/deepseek.ts:56` | K2 | T2 |
| `src/router.ts:31,232-233` | K2 | T2 |
| `src/server.ts:553` | K2 | T2 |
| `tests/local-openai.test.ts:254-285` (the output-limit `it`) and `:533-573` (DeepSeek `it` 1) | AC5 | T2 (after T1) |
| `src/renderer/overview-lines.ts` (new) | K3 | T3 |
| `tests/overview-lines.test.ts` (new) | AC8 | T3 |
| `src/renderer/usage-view.ts:4-9,12-13,88,218-262,375-380,392` | K4 (handle, deps, metric) | T3 |
| `src/renderer/settings.html:105` | a third button `<button type="button" data-metric="cost">Cost</button>` | T3 |
| `src/renderer/settings.ts:51-53,72,267-301,452-500` | Overview rows (items 3.2 and 5) | T3 |
| `README.md:29,45,128,318,386,66-72,568-572` | item 6, plus doc lines for items 1-5 | T4 |
| `ROADMAP.md` (after line 54), `changelog.md` (this folder) | docs | T4 |

## Tasks for workers

Order: T1 and T3 run in parallel (disjoint files). T2 starts after T1, because both edit `local-openai.ts` and
`tests/local-openai.test.ts`. T4 runs last. Every task ends with
`fnm exec --using default cmd //c "node scripts/typecheck.mjs"` and its own test files
(`fnm exec --using default cmd //c "npx vitest run <files>"`). The final run is the whole suite:
`fnm exec --using default cmd //c "npm test"`.

### T1. Ollama: stale default, `/api/ps` without `context_length`, near-`num_ctx` warning

Inputs: Item 1 analysis, K1, OD1.

**Test first.** Before touching `src/`, change the Ollama `it` (`tests/local-openai.test.ts:286`) as below and run it. It must fail on
the unfixed code, at Seg C's `loadBodies` length 2 or at Seg D's status 200. Record the failing line in `changelog.md`.

Fake changes:
- Add `let promptTokens: number | undefined;`.
- When it is set, the chat handler writes a usage chunk
  `{ choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: 1, total_tokens: promptTokens + 1 } }` before `[DONE]`.

Segments:
- **A** (unchanged): not loaded; load; 400.
- **B** (existing): set `promptTokens = 30` for the 80-character request (≥ ceil(32 × 0.9) = 29), then set it back to `undefined`. Keep
  every existing assertion.
- **C** (F2, changed): `context = 1000`, then `ask(200, false)` → 400 `context_length_exceeded`.
  - `loadBodies` has length 2: the proxy reloaded at default options.
  - `context` is 32 again.
  - `limitListed()` is 96.

  Replace the old stream assertion and its comment with: "Another client loads the model with a bigger num_ctx: the proxy loads it
  back at its default (its own /v1 request would reload it anyway) and keeps 96."
- **D** (new, item 1): the default was raised and another client loaded the model first at the new default. Set `defaultCtx = 100`,
  `context = 100` (`loaded` stays true) and `promptTokens = 20`.
  - `ask(250, false)` → 200.
  - `loadBodies` has length 3 and `chatCalls` is 2.
  - Then `await vi.waitFor(async () => expect(await limitListed()).toBe(300))` and set `promptTokens = undefined`.
  - Before the fix this answers 400 (limit 96).
- **E** and **F** (existing): bump the counts. E: `loadBodies` 4, `chatCalls` 3. F: `loadBodies` 5, `chatCalls` 3.
- **End:** exactly one warn line contains "may have dropped the start of the prompt", from B; D's 20 of 100 gives none. The existing
  Bearer-key assertion stays.

New small `it` "maps /api/ps answers: an entry without context_length is unsupported, a missing model is not loaded", calling
`ollamaLoadedContext` directly with a fake `fetchImpl` (no server):
- `{models:[{name:"m:latest"}]}` → rejects with `PsUnsupportedError`.
- `{models:[]}` → resolves `undefined`.
- HTTP 500 → rejects with an `Error` that is not a `PsUnsupportedError`.

Import `ollamaLoadedContext` and `PsUnsupportedError` from `../src/providers/local-openai.js`.

Outputs: K1 exactly. Do not touch `:318` (T2 owns it).

Tests owned: AC1, AC2, AC3, AC4, AC6.

### T2. `max_output_tokens` in `/v1/models`

Inputs: K2; T1 merged.

Outputs: K2 exactly. Tests:
- In the output-limit `it` (`:254`), after `await fetch(`${base}/models`)` (`:279`), read the list and assert:
  - `ollama/m:latest` has `max_output_tokens: 50`;
  - `ollama/n:latest` has no `max_output_tokens` (`not.toHaveProperty`).
- In DeepSeek `it` 1, after `await fetch(`${priced.base}/models`)` (`:562`), read the JSON and assert:
  - `deepseek/deepseek-flash` → 1000;
  - `deepseek/deepseek-v4-pro` → 393216;
  - `max_prompt_chars` is still present on both, unchanged.

Tests owned: AC5.

### T3. Settings window: Cost metric, Today line, local rows

Inputs: K3, K4, OD2-OD4, OD6. Files: `overview-lines.ts` (new), `usage-view.ts`, `settings.html`, `settings.ts`, and
`tests/overview-lines.test.ts` (new). It runs in parallel with T1 and T2 and uses no new backend data.

Outputs:
1. `overview-lines.ts` per K3. `todayUsageLine` uses `formatUsd` from `./cost-format.js`.
2. `usage-view.ts` per K4.
3. `settings.html:105`: the Cost button.
4. `settings.ts`:
   - `const overviewOrder = [...providerOrder, "deepseek", "gufo", "strata", "llama", "ollama"] as const;` (`:53`).
   - `initUsageView({ ..., onUsageChange: () => { if (state) renderOverview(state); } })` (`:73`).
   - At the end of `renderLocalServers` (`:300`): `if (state) renderOverview(state);`.
   - In `renderOverview` (`:459-500`):
     - Action buttons: login and logout only for `providerOrder` ids; the Settings button only for the rest.
     - Badge: `setBadge(badge, localDotState(id))` for gufo / strata / llama; the provider state for the others.
     - Line: `localProviderLine(...)` for the four local ids; `describeSignIn` for the others. Gufo resolves `profileLabel` from
       `gufoDraft`, Llama.cpp from `current.settings.providers.llama.profiles`, the same way `renderLocalServers` does (`:276`, `:281`).
     - The balance and usage-limit lines stay as they are.
     - After them: `const today = todayUsageLine(usage.todayOf(id)); if (today && (id === "deepseek" || localIds.includes(id))) row.append(make("p", "ov-line muted", today))`.
       Set the line's `title` to the full numbers and, when cost > 0, `formatUsdFull(cost)`.
     - Chips: unchanged (feature chips and model count). `loginHome` stays only where set.
   - No CSS change unless a row breaks; reuse `.ov-line muted`.

Tests: `tests/overview-lines.test.ts`, one `it`:
- `todayUsageLine`:
  - DeepSeek-like counts (3 requests, 1,200 tokens, 1 error, `costUsd` 0.0004224, `estimated` 0) with `count = String` →
    `"Today: 3 requests · 1200 tokens · 1 error · $0.00042"`;
  - `requests: 0` → `undefined`.
- `localProviderLine`:
  - Gufo launcher ready, profile "Qwen 27B", port 8090 → `"Running Qwen 27B on port 8090."`;
  - Strata launcher stopped → `"Stopped. Start it on its page."`;
  - Ollama ready → `"Reachable at http://localhost:11434."`;
  - Ollama stopped with error "Ollama is not running or not reachable …" → that text;
  - disabled → the Off text.

Tests owned: AC7 (manual), AC8.

### T4. Docs

Inputs: T1-T3 merged.

README:
- `:570`: "The project uses **Yarn 4** (`packageManager: yarn@4.13.0`, `yarn.lock`, `nodeLinker: node-modules` in `.yarnrc.yml`); CI runs
  `yarn install --immutable`, `yarn typecheck`, `yarn test` and `yarn build`. Run `corepack enable` once, then `yarn install`. Do not
  install with npm: it ignores `yarn.lock`. The scripts below also run as `yarn <script>`."
- In the code block, `npm ci` becomes `corepack enable && yarn install --immutable`. In Headless CLI (`:69`), `npm install` becomes
  `corepack enable && yarn install`.
- `:128` (Ollama "Loaded context"): replace "Before each request `/api/ps` is read once more: a model that is not loaded any more is
  measured again by the next load ..." with this rule: a model that is not loaded any more, or that runs at another context than the
  measured one, is loaded again at Ollama's default options and measured. This picks up a raised default even when another client
  loaded the model first, and a context another client chose is never adopted.
- Also at `:128`: change "When `/api/ps` answers 404 (or without a model list)" to "404, 405 or 501, without a model list, or without
  `context_length` for the model". Add one sentence: "An answer whose prompt used at least 90% of that context logs a warning, because
  Ollama may have cut it."
- `:318` and `:386`: `GET /v1/models` also has `max_output_tokens` where the provider knows the output limit (DeepSeek: `/models` or
  393216; an OpenAI-compatible upstream that reports it).
- `:45` (Usage): the chart has a Cost metric.
- `:29` (Overview page): rows for DeepSeek, Gufo, Strata, Llama.cpp and Ollama, with a "Today:" line (requests, tokens, errors, cost).

Other files:
- ROADMAP: one checked line after `:54`: "(AAP-72) AAP-71 follow-ups: Ollama stale default context re-measured, max_output_tokens in
  /v1/models, cost on the Usage chart and the Overview, near-num_ctx warning, Overview rows for the local providers, README Yarn".
- `changelog.md` in this folder: DONE / NOT DONE / UNTESTED per item, the T1 before-fix failing line, and the live results.

## Acceptance criteria and the tests that prove them

| # | Criterion | Proof |
|---|---|---|
| AC1 | Item 1: when `/api/ps` shows a measured model at another context, the stored default is dropped and load-first measures again. A raised default that another client loaded first is adopted (100 tokens → 300 characters, a 250-character prompt passes). The test fails before the fix. | Seg D of the Ollama `it`; the run before the fix is recorded in the changelog. |
| AC2 | F2 is not adopted: a foreign context of 1000 leads to one reload at default options; the limit stays 96 and a 200-character prompt is refused with 400. | Seg C of the same `it`. |
| AC3 | No reload loop: with `/api/ps` stable, later requests make no load (`loadBodies` does not grow in B). | The existing B assertions, kept. |
| AC4 | An `/api/ps` entry without `context_length` → `PsUnsupportedError`; a missing model → `undefined`; a 500 → a plain `Error`. | New small `it` (T1). |
| AC5 | `/v1/models`: `max_output_tokens` is 1000 / 393216 on DeepSeek and 50 on a family model that reports it. It is absent on a model without a known limit. `max_prompt_chars` is unchanged. | T2 assertions in the two existing `it`s. |
| AC6 | Item 4: one warn line when prompt tokens ≥ 90% of the measured context (30 of 32); none at 20 of 100. | B, D and the end assertion of the Ollama `it`. |
| AC7 | The Usage chart has a Cost button: per-day USD bars per provider, `$` tooltips, the OD4 empty state, and the choice is remembered. The Overview shows the DeepSeek Today line with the spend, and the four local rows with badge, line, chips, Today line and Settings button. | Manual in the app (Live step 6) with a screenshot; otherwise UNTESTED. |
| AC8 | The Today line and the local state line texts. | `tests/overview-lines.test.ts`. |
| AC9 | README: no "npm only", no `package-lock.json` / `npm ci` / `npm install` advice; it names Yarn 4 and `yarn install`. | `git grep -n "npm only\|package-lock\|npm ci\|npm install" README.md` is empty. |
| AC10 | No regression. | `fnm exec --using default cmd //c "node scripts/typecheck.mjs"`: three ok lines. `fnm exec --using default cmd //c "npm test"`: expect 554 passed (552 + 2 new `it`s), 1 skipped, 0 failed. |
| AC11 | Live behaviour. | Live verification below, results in the changelog. |

## Live verification

Rules:
- Use a second headless instance on port **8797**.
- Never call the live proxy on 8787, except `GET http://127.0.0.1:8787/healthz`, which may be read to confirm it is untouched.
- Make no DeepSeek calls (DeepSeek is off in these settings).
- Ollama is at `http://localhost:11434` with `qwen3.8:latest`; it is local and free.
- `<root>` = `http://localhost:11434`, `<dir>` = `C:/projects/Personal/api-acp-proxy/.claude/temp/aap72-live`.

0. **Temporary model.** It keeps the user's `qwen3.8:latest` unchanged:
   `curl -s <root>/api/create -d '{"model":"aap72-ctx","from":"qwen3.8:latest","parameters":{"num_ctx":2048}}'`.
   If this Ollama does not take `from`, use a Modelfile instead (`FROM qwen3.8:latest` and `PARAMETER num_ctx 2048`) and run
   `ollama create aap72-ctx -f <dir>/Modelfile`.
1. **Settings.** Write `<dir>/settings.json`:
   `{"server":{"port":8797},"providers":{"codex":{"enabled":false},"claude":{"enabled":false},"antigravity":{"enabled":false},"gufo":{"enabled":false},"strata":{"enabled":false},"llama":{"enabled":false},"ollama":{"enabled":true,"baseUrl":"http://localhost:11434"},"deepseek":{"enabled":false}}}`
2. **Start** (Bash, background):
   `cd C:/projects/Personal/api-acp-proxy && PROXY_SETTINGS_FILE=<dir>/settings.json fnm exec --using default npx tsx src/index.ts`.
   Then:
   - `GET http://127.0.0.1:8797/healthz` → 200.
   - `GET :8797/v1/models` lists `ollama/aap72-ctx:latest` and `ollama/qwen3.8:latest`.
   - No `ollama/*` entry has `max_output_tokens` (Ollama's `/v1/models` does not report it). This is the AC5 "absent" half.
3. **Item 1 and F2** on `ollama/aap72-ctx:latest`, all with `max_tokens: 4`:
   1. Unload: `curl -s <root>/api/generate -d '{"model":"aap72-ctx","keep_alive":0}'`. Chat "hi" through 8797 → 200; the log has one
      "loading 'aap72-ctx:latest'" line. `/api/ps` shows `context_length` 2048, and `/v1/models` `max_prompt_chars` is 6144.
   2. F2: a foreign client loads it bigger:
      `curl -s <root>/api/generate -d '{"model":"aap72-ctx","options":{"num_ctx":8192}}'`. `/api/ps` shows 8192. Then a non-stream
      prompt of 7000 characters (`"hello "` repeated) through 8797 → 400 `context_length_exceeded` with "a context of 2048 tokens".
      After it, `/api/ps` shows 2048 again (the proxy reloaded at the default), and the log has a second "loading" line.
   3. No loop: chat "hi" twice more → 200 each. No new "loading" line, and `/api/ps` stays 2048.
   4. Stale default (the item 1 symptom):
      1. Re-create the model with a bigger default:
         `curl -s <root>/api/create -d '{"model":"aap72-ctx","from":"qwen3.8:latest","parameters":{"num_ctx":4096}}'`.
      2. Another client loads it first: `curl -s <root>/api/generate -d '{"model":"aap72-ctx"}'`. `/api/ps` shows 4096.
      3. Send a 7000-character prompt through 8797 → **200** (6144 < 7000 ≤ 12288). Before the fix this was a 400 with "2048 tokens".
      4. `/v1/models` `max_prompt_chars` is now 12288, and the log has one "loading" line for this request and no reload: `ollama ps`
         shows the same UNTIL time or the same runner.
4. **Item 4 warning.**
   1. Stop the instance, set `"ollama":{"enabled":true,"baseUrl":"http://localhost:11434","maxPromptChars":0}` (the guard is off so
      Ollama itself cuts), and start it again.
   2. Re-create `aap72-ctx` with `num_ctx` 2048 (step 0 command).
   3. Send a non-stream prompt of about 12000 characters of `"1 2 3 4 5 6 7 8 9 0 "` → 200.
   4. The response `usage.prompt_tokens` is ≥ 1844, and the log has one warn line "used N of the 2048 tokens of its context (num_ctx);
      Ollama may have dropped the start of the prompt". If `prompt_tokens` is below 1844, repeat with 24000 characters.
   5. A short "hi" gives no warn line.
5. **Clean up the headless part.**
   - Stop the instance.
   - `curl -s -X DELETE <root>/api/delete -d '{"model":"aap72-ctx"}'`, or `ollama rm aap72-ctx`.
   - Delete `<dir>/settings.json`, `usage.json`, `models-cache.json`, `exhausted.json` and `logs/`.
   - `GET http://127.0.0.1:8787/healthz` still answers, as before.
6. **Settings window (AC7), optional when a screen is available.**
   1. Write `<dir>/app/settings.json` (step 1 settings; Ollama on) and seed `<dir>/app/usage.json`:
      ```json
      {"version":1,"since":"<today-7>","totals":{"deepseek":{"requests":5,"errors":0,"inputTokens":4000,"outputTokens":900,"estimated":0,"cachedTokens":1000,"reasoningTokens":0,"costUsd":0.0021}},"days":{"<today>":{"deepseek":{"requests":3,"errors":0,"inputTokens":2400,"outputTokens":500,"estimated":0,"cachedTokens":600,"reasoningTokens":0,"costUsd":0.0012}},"<today-2>":{"deepseek":{"requests":2,"errors":0,"inputTokens":1600,"outputTokens":400,"estimated":0,"cachedTokens":400,"reasoningTokens":0,"costUsd":0.0009}}}}
      ```
      Use local `YYYY-MM-DD` day keys. The file is fake data, which is free.
   2. Run `PROXY_SETTINGS_FILE=<dir>/app/settings.json fnm exec --using default cmd //c "npm run app:dev"`. The separate data folder
      gives it its own single-instance lock, so it does not touch the live app.
   3. Check:
      - Overview: the rows for DeepSeek (Off) and the four local providers; the Ollama row says "Reachable at http://localhost:11434."
        and has a model count; the DeepSeek row has "Today: 3 requests · 2.9K tokens · $0.0012" (shown even while DeepSeek is off,
        since the data exists).
      - Usage: Cost shows two bars, with "$" tooltips.
   4. Take screenshots. Close the app and delete `<dir>/app`. If no screen tool is available, AC7 is UNTESTED.

Not testable live: the `max_output_tokens` values of DeepSeek (DeepSeek is off; proved by AC5 fakes).

## Risks

- **Ollama may not reload on a load with default options.** The F2 guard rests on Ollama reloading a runner whose options differ when
  `POST /api/generate {"model"}` comes in with default options. Live step 3.2 checks this. If `/api/ps` still shows 8192 after the
  proxy's request, the proxy adopts the foreign value. In that case, stop and report: the fix then needs `loadFirst` to unload first
  (`keep_alive: 0`), which is a product decision because it would disturb the other client.
- **Pre-existing measurement race.** If another client reloads the model between the proxy's chat and the background `measureDefault`,
  the foreign value is stored, and the item 1 rule then keeps it while `/api/ps` keeps showing it. This is not new, and it is not fixed
  here.
- **A stream refusal can now be an SSE error.** In the F2 case, a stream request over the limit gets an SSE error (after a 200) instead
  of a real HTTP 400. Accepted (see Item 1 analysis).
- **Faster Overview rebuilds.** With `onUsageChange`, the Overview is rebuilt on every usage push (once per finished request). This is
  the same pattern as the state pushes, and keyboard focus on an Overview button can be lost then.
