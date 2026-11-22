---
status: in-progress
request: creative-hub/REQ-0031
repos: [api-acp-proxy]
branch: AAP-52_extra-ideas
updated: 2026-11-22
---

# AAP-52 Extra proxy ideas: one MCP code for "does not accept images", AAP-51 leftovers (comment line, unused chart class, multi-byte metrics test)

Hub ticket: creative-hub HUB-44, request REQ-0031 (the extra ideas the AAP-51 check left; the user said 2026-11-22 "use all recommendation, add all possible extras"). Every line number below was checked on master 33a76c2 (2026-11-22).

## Rules for every worker

- Branch `AAP-52_extra-ideas`, cut from master 33a76c2. The worker does not commit. The orchestrator makes **one commit** after the checks: subject `AAP-52: one MCP code for a model that does not accept images, comment and chart class leftovers, multi-byte metrics test` (Bash heredoc `git commit -F - <<'EOF'`, blank line after the subject, last line `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`). No push, no merge.
- The proxy app is **running from `dist/`** during the hub's live round: no `yarn build`, no `yarn dist*`, no `yarn app:dev`, no Electron start, nothing under `dist/` or `out/` touched. Tests and typecheck only. Never read, print or touch `%APPDATA%\api-acp-proxy\settings.json`. No setting is added.
- Commands (from `package.json`). In Bash, first: `export PATH="/c/Users/Infplane/AppData/Roaming/fnm/aliases/default:$PATH"` (`fnm exec yarn` fails). Run from `C:\projects\Personal\api-acp-proxy`:
  - all tests: `yarn test` (`vitest run`); one file: `yarn test tests/<file>.test.ts`
  - typecheck: `yarn typecheck`
  - there is **no lint script**; do not invent one.
- Monitor rule: counts and timings only; no inline styles anywhere in `src/renderer` (CSP `style-src 'self'`).
- Tests follow the global `test-discipline` skill: only the assertions listed under Tests, in the existing files named there, no new test file. Each new assertion is first **shown failing** (on the unchanged code, or by the mutation named for it), and the failing line goes into `changelog.md`.
- Working trees are CRLF (`.ts`, `README.md`, `ROADMAP.md`), git stores LF: do not flip line endings. Write regexes, `\u` escapes and Windows paths with the Edit tool, not through a Bash heredoc.

## Scope (item, decision, verified cause)

| item | decision | cause, verified on 33a76c2 |
|---|---|---|
| a. one MCP code for "does not accept images" | IN | `ask` refuses early with `McpToolError("model_not_capable", "The model '<id>' does not accept images. Models that do: ...")` only when `bridge.acceptsImages(model) === false` (`src/mcp-endpoint.ts:704`). For Strata before its first model list `acceptsImages` is `undefined` (`src/providers/local-openai.ts:130-131`), so the call goes on to `context.prepare` (`mcp-endpoint.ts:710`); after the lease `prepareModel` reads Strata's list and, when it has no image modality, throws `ApiError(400, "unsupported_content", "... does not accept image input.")` (`local-openai.ts:154`, `:161-163`). `toFailure` passes that code on (`mcp-endpoint.ts:138`), so the same fact reaches the MCP caller as `unsupported_content` instead of `model_not_capable`, and without the list of models that do. Fix in `ask` only: a refusal from `prepare` with code `unsupported_content` while the call carries images becomes the early check's error. Not changed: a provider's own refusal from `generate` (`tests/mcp-endpoint.test.ts:485-489` asserts it passes on as `unsupported_content`; that is the provider speaking, not the proxy's check), and the HTTP routes (OpenAI clients get `unsupported_content` there, `README.md:164`, `:342`). |
| b. `architecture.input_modalities` in `GET /v1/models` | OUT | Today `/v1/models` emits `vision` only (`src/server.ts:551`). Pixel and Chiptune parse `architecture.input_modalities` into `vision` (`pixel-art-generator` and `midi-generator` `src/llm/openaiCompat.ts:383`; `textOnly` reads `output_modalities`, `:380`). What would change in those clients: configured rows keep their own `vision` (`src/llm/registry.ts:399-403`, `:437-441` in both: a `known` row wins), but a **discovered, unconfigured** `acp/...` row of a Gufo or Llama.cpp profile with `vision: true`, or of Strata once listed, flips from `vision: false` (`registry.ts:454` default) to `true`. That row then (1) gets images in its tool results and style previews (Pixel `src/llm/agent.ts:276`, `:379`, `src/main/agent.ts:287`; Chiptune `src/llm/agent.ts:312`, `:376`, `src/main/agent.ts:288`) and (2) moves in or out of a primary's fallback list, which keeps only models with the same `vision` (Pixel `src/llm/agent.ts:211`, Chiptune `:214`). The role's primary pick does not change (`src/llm/router.ts:74` does not filter by vision), but **which model a role falls back to changes without the user's config saying so**, and Pixel's own docs say the proxy's models are text only (`seed/config/providers.md:275`). That is behaviour clients rely on: out. A follow-up would need the client side decided first (ignore discovered vision for `acp`, or emit it and add the rows to the seeds). |
| c. `models-cache.json` row for Strata without `vision` before the first load | NO CHANGE (already done) | On each transition of a local server to ready the app calls `proxy.refreshModels(entry.id)` (`src/electron/main.ts:279`) -> `router.refresh` -> `refreshOne` -> `update` (`src/router.ts:212-214`, `:196-197`, `:101-107`), which replaces the cached row with Strata's fresh list (with `vision: true` from `input_modalities`, `local-openai.ts:201`) and persists it (`router.ts:76-89`, written with `vision`, read back with it `:70`). Every `GET /v1/models` and MCP `list_models` also refreshes first (`server.ts:551` -> `router.listModels` `:205-208`). The row is stale only while Strata has never answered since the cache was written, and then there is nothing newer to write. |
| d. Strata's `/health` `loaded: true` as its ready check | OUT | The ready check is one probe for every server, "`GET /v1/models` answers 2xx" (`src/local-servers.ts:59-68`, used by the start poll `:279-290`, the outside-server check `:173-178` and the port-release wait `:233-240`). For Strata it already means "loaded" in the default start: `serve()` opens the HTTP port only after the engine started (`D:\Strata\terminal\serve\server.py:8490` engine, `:8705` `serve`). With `--lazy` or `lazy_load: true` (`server.py:8234`, `:8415`) the port opens unloaded and `loaded` (`:4006-4007`, `/health` `:6942-6946`) stays false **until the first request**, which the proxy sends only after the ready check: a `/health loaded` check would never pass, the start would time out after 10 minutes (`local-servers.ts:291-301`) and every Strata request would fail. After an idle unload `loaded` is false too while the server serves. Not contained: out. (Discovery below: a lazy Strata lists no model before its first request.) |
| e1. `main.ts:620` comment on the wrong line | IN | AAP-51 inserted `await refreshLocalSettings();` under `await proxy.applySettings({});` and the comment "restart so the provider picks up install.json" moved with the new line (`git log -L619,620:src/electron/main.ts`: AAP-03 had it on `applySettings`). The restart is `applySettings`. |
| e2. unused `chart-seg` class | IN | `src/renderer/usage-view.ts:179` sets `class="chart-seg <series>"`; no CSS rule or test names `chart-seg` (`grep -rn "chart-seg" src tests` finds only that line; `usage.css:19-26` style `.chart-svg` and `.chart-svg .series-*`). |
| e3. multi-byte character split across two chunks | IN (guard test) | `readText` decodes with one `TextDecoder("utf-8")` and `decode(value, { stream: true })` per chunk (`src/local-monitor.ts:187-198`), which is right; no test splits a character. `readText` is module-private (`:178`), and `mapLlama` reads only ASCII metric lines, so a broken character is invisible through `fetchEngine`: the function is exported for its test. |

## Out of scope

- b and d above (reasons in the table); the HTTP routes' `unsupported_content` for images; a provider's own image refusal from `generate`.
- `README.md:164` still says "Text-only profiles and Strata answer 400 `unsupported_content` before any switch" (Strata answers after its lease since AAP-51): listed as a discovery, not edited here.

## Files to touch (verified)

One worker (all items are small and touch different lines).

**`src/mcp-endpoint.ts`** (item a):
- In `ask` (`:697-725`), before `:704`, add
  ```ts
  /** The refusal for images to a model that does not take them, the same before and after a local model's load. */
  const noImages = async (): Promise<McpToolError> => new McpToolError("model_not_capable", `The model '${args.model}' does not accept images.${await this.modelsThat("do", (id) => bridge.acceptsImages?.(id) === true)}`);
  ```
  and make `:704` `if (args.images.length && bridge.acceptsImages?.(args.model) === false) throw await noImages();` (same text as today).
- `:710` `const lease = await context.prepare(args.model, messages);` becomes
  ```ts
  let lease: { release(): void } | undefined;
  // Strata knows whether it reads images only once it is loaded: its refusal after the lease is the same tool error as the check above.
  try { lease = await context.prepare(args.model, messages); }
  catch (error) { if (parts.length && error instanceof ApiError && error.code === "unsupported_content") throw await noImages(); throw error; }
  ```
  `ApiError` is already imported (used at `:138`). Nothing else in `ask` changes; `prepareModel` already released its lease before throwing (`local-openai.ts:163`).

**`src/local-monitor.ts`** (item e3), `:177-178`: `async function readText` becomes `export async function readText`; the doc comment gains "Exported for its test."

**`src/electron/main.ts`** (item e1), `:619-620` become
```ts
      await proxy.applySettings({}); // restart so the provider picks up install.json
      await refreshLocalSettings();
```

**`src/renderer/usage-view.ts`** (item e2), `:179`: `segment.setAttribute("class", seriesClass(id));`.

**`README.md:403`** (MCP failures list): `` `model_not_capable` (it names the models that can) `` becomes `` `model_not_capable` (it names the models that can; also for images to a local model that turns out not to read them once it is loaded, Strata before its first load) ``.

**`ROADMAP.md`**, a new row after `:48` (the AAP-51 row), in its style:
"- [x] Extra proxy ideas (AAP-52; creative-hub HUB-44, REQ-0031): the MCP `ask_model` answers `model_not_capable` (with the models that do) for images to a local model that turns out not to read them only after its load, as it does before; the AAP-51 leftovers (a comment on the wrong line, an unused chart class, a test that splits a multi-byte character across two `/metrics` chunks). Not done, with reasons in the plan: `architecture.input_modalities` in `/v1/models` (it would change Pixel's and Chiptune's fallback choice), Strata's `/health` `loaded` as its ready check (a lazy Strata would never be ready)."

**`.claude/tickets/AAP-52-extra-ideas/changelog.md`** (new): files, deviations, the failing-first evidence of each test, test counts, UNTESTED list.

## Tests (test-discipline: two existing tests extended, no new file, no new `it`)

1. **`tests/mcp-endpoint.test.ts`**, extend the test at `:493` ("forwards an image to Strata before its first load ..."); rename it to "forwards an image to Strata before its first load, and refuses one with model_not_capable when Strata's list says it reads none". After `:504` add a second Strata provider whose fake `fetch` answers `/models` with `{ data: [{ id: "qwen-flash", architecture: { input_modalities: ["text"] } }] }` and pushes every other request's body into `bodies`; start an env on `new ProviderRouter({ providers: [textOnly] })`; `ask(env2, { model: "strata/qwen-flash", images: [dataImage()] })`; expect `textOf(refused.result)` to match `/^model_not_capable:.*does not accept images/` and `bodies` to still have length 1 (no chat request sent). **Fails on the old code** (the text starts `unsupported_content:`). `:477-491` (early refusal; a provider's own `unsupported_content` from `generate` passes on unchanged) must still pass.
2. **`tests/local-monitor.test.ts`**, extend the test at `:98`; add `readText` to the import at `:2`. After `:136`: a `MonitorFetch` whose `body.getReader().read()` yields two chunks of `new TextEncoder().encode("# HELP llamacpp:x \u010das\nllamacpp:tokens_predicted_total 120\n")` cut one byte into the `\u010d` (cut at `bytes.indexOf(0xc4) + 1`), then `{ done: true }`, and whose `text()` rejects; expect `await readText(split, "http://127.0.0.1:8082/metrics", 1000)` to equal the original string. Guard test (the code is right): **prove it by mutation**: change `decoder.decode(value, { stream: true })` at `local-monitor.ts:196` to `decoder.decode(value)`, see the assertion fail (two `\uFFFD`), restore. Write `\u010d` as an escape so the file stays ASCII.
3. No test for e1 and e2: proof by reading and `grep -rn "chart-seg" src tests` giving no match.

## Tasks for workers

| worker | files (only these) | outputs |
|---|---|---|
| A | `src/mcp-endpoint.ts`, `src/local-monitor.ts`, `src/electron/main.ts`, `src/renderer/usage-view.ts`, `tests/mcp-endpoint.test.ts`, `tests/local-monitor.test.ts`, `README.md`, `ROADMAP.md`, `.claude/tickets/AAP-52-extra-ideas/changelog.md` | items a, e1, e2, e3; docs; changelog |

Order: write test 1, run `yarn test tests/mcp-endpoint.test.ts` and paste the failure; change `mcp-endpoint.ts`; rerun. Test 2: add it, run green, apply the mutation, paste the failure, restore, rerun. Then e1, e2, README, ROADMAP; `yarn test` and `yarn typecheck`. Report: files changed, both failing-first lines, final pass counts, deviations. The orchestrator reruns `yarn test`, `yarn typecheck` and the grep, then commits once.

## Acceptance criteria

| # | criterion | proof |
|---|---|---|
| A1 | `ask_model` with images to a model that does not take them answers `model_not_capable` (with the models that do) whether the proxy knew it before the call or learned it after the local model's load | test 1; `:477-491` still green |
| A2 | a provider's own image refusal from `generate` still passes on with its code | `tests/mcp-endpoint.test.ts:485-489` |
| A3 | `readText` keeps a character split across two chunks | test 2 and its mutation |
| A4 | the install comment sits on the `applySettings` line; no `chart-seg` left | reading `main.ts:619-620`; `grep -rn "chart-seg" src tests` empty |
| A5 | nothing else breaks | `yarn test`, `yarn typecheck` exit 0; no build run; `settings.json` untouched |

## UNTESTED

- A live `ask_model` with an image to a Strata whose model reads no images, right after a proxy start (needs a proxy restart from a new build and the user's go-ahead).
- The Usage page after the class change (it has no style on `chart-seg`, so nothing should change).
