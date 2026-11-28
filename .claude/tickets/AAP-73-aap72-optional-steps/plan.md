---
status: done
request: REQ-0028
repos: [api-acp-proxy]
branch: AAP-73_aap72-optional-steps
updated: 2026-11-28
---
# AAP-73: four optional steps after AAP-72

Base: `master` at 51d9bac (AAP-70, AAP-71 and AAP-72 merged). Background: `../AAP-72-aap71-next-ideas/plan.md`, `changelog.md`
(live step 4: Ollama 0.40.19 refuses an over-context prompt with HTTP 400) and `discoveries.md`, and
`../AAP-71-aap70-extra-ideas/plan.md` (K1-K9, the "Polish round 1" note). Line numbers below are for 51d9bac.

Reading of the brief: the narrow version of each item. Item 1 rewords the warning and the README; it does not change the limit. Item 2
is a check plus a decision, not new code (no tokenize endpoint exists, see the live finding). Item 3 fixes focus loss without a
rewrite of the Overview. Item 4 is a one-line change.

## Live finding for item 2 (done while planning, 2026-11-28)

Ollama at `http://localhost:11434`, `GET /api/version` → `{"version":"0.40.19"}`. `/api/ps` was `{"models":[]}` before and after; no
model was loaded or unloaded.

| Request (body `{"model":"qwen3.8:latest","content":...,"prompt":...,"text":...}`) | Answer |
|---|---|
| `POST /api/tokenize` | `404 page not found` (HTTP 404, 0.21 s) |
| `POST /api/detokenize` | `404 page not found` |
| `POST /tokenize` | `404 page not found` |
| `POST /v1/tokenize` | `404 page not found` |
| `POST /api/v1/tokenize` | `404 page not found` |
| `GET /api/tokenize` | `404 page not found` |
| control: `POST /api/show {}` | HTTP 400 `{"error":"model is required"}` (a route that exists answers in JSON) |
| control: `POST /api/nonexistent {}` | `404 page not found` (same text as the tokenize routes) |

The plain-text `404 page not found` is the router's own "no such route" answer, so the route is missing; it is not a model error.

The installed binary, `%LOCALAPPDATA%\Programs\Ollama\ollama.exe`, has these `/api/...` route strings: `blobs`, `chat`, `copy`, `create`,
`delete`, `embed`, `embeddings`, `generate`, `ps`, `pull`, `push`, `show`, `tags`, `version` and a few app/cloud ones. It has no
`/api/tokenize`. The only `/tokenize` and `/detokenize` strings belong to the internal model runner: a child process on a random local
port, which is not a public API.

Conclusion: **this Ollama has no public tokenize endpoint.** The other ways to get an exact count are not worth it:
- `/api/generate` or `/api/chat` with `num_predict` 0 or 1 does a full prefill of the prompt, so it doubles the prompt work.
- `/api/embed` on a chat model may load another runner (the reload risk from AAP-71).
- A tighter ratio for digit-heavy text is a guess and makes the limit stricter for normal text.

Also, 0.40.19 refuses an over-context prompt itself with HTTP 400. The proxy already maps that to 400 `context_length_exceeded` (`CONTEXT_ERROR`
matches "context length", `src/providers/local-openai.ts:69`, `httpError` `:312-315`). So an exact count would only move a refusal the
user already gets. See OD2.

## Scope

1. **Near-num_ctx warning and README (newer Ollama).** Reword the AAP-72 warning so it no longer claims a cut on a version that
   refuses. Remove the duplicated provider name from the log line. Reword the README sentences and the code comments that say Ollama
   always cuts silently, including the reason given for the ×3 guard. The limit (×3 measured, ×4 `/api/show`) and the 90% threshold
   stay as they are.
2. **Exact Ollama token counting.** Decided by the live finding above: no code (OD2). The only output is one README clause, written
   under item 1's README task, saying the ×3 guard is an estimate.
3. **Overview rebuild.** `renderOverview` replaces the provider rows only when the built rows differ from the ones shown. When it does
   replace them, keyboard focus on a row button moves to the same button in the new rows, or to that row's Settings button when the
   same button is now disabled.
4. **Today line on the ACP rows.** Codex, Claude and Antigravity show the same `todayUsageLine` as the DeepSeek and local rows.

## Out of scope (explicit)

- Any change to the prompt limit itself: the ×3 / ×4 ratios, `NEAR_CONTEXT_SHARE`, load-first, `/api/ps` handling, or a version check
  (`/api/version`) to decide whether a cut is possible. These are under Extra ideas in the report.
- Any token counting call (tokenize, prefill probe, embed) and any change to `checkPrompt`'s synchronous contract
  (`src/provider.ts:227-228`).
- Turning Ollama's in-stream 400 (after `beginSse`, `src/server.ts:223`) into a real HTTP 400. That behaviour predates this ticket.
- The duplicated provider name in the `insufficient_system_resource` warn line (`src/providers/local-openai.ts:435`). It is listed
  under Discoveries; only the near-num_ctx line is in scope.
- Changing the push cadence in `src/electron/main.ts:310-314` (the 250 ms local-server throttle and the 500 ms usage throttle). The
  fix is in the renderer, so `main.ts` is not touched.
- Rebuilding other Overview parts (`ov-mcp`, the URL lines). They have no focusable row buttons.
- The badge mismatch between the Gufo/Llama.cpp Overview rows and their pages (AAP-72 discovery).
- New usage counters or cost sources for the ACP providers. Whatever `usage.todayOf(id)` already returns is shown.

## Open decisions (recommendation first; the director or user may override)

- **OD1 Near-num_ctx warning: reword or drop. Recommended: reword and keep it.**
  - Why keep it: a prompt at 90% or more of `num_ctx` that Ollama accepts leaves at most 10% of the context for the answer. The answer
    can then stop early or be shifted, and the user sees no error. Older Ollama versions also cut such a prompt silently, and the proxy
    does not know which version it talks to.
  - New text (the logger already adds `[ollama]`): ``the prompt of ${model} used ${promptTokens} of the ${measured} tokens of its
    context (num_ctx), which leaves little room for the answer (older Ollama versions also cut such a prompt without an error). Raise
    num_ctx in Ollama for longer prompts.``
  - Alternative: drop the warning, `NEAR_CONTEXT_SHARE` and the test lines. That is right only if the user runs nothing older than
    0.40.x and does not care about room for the answer.
  - Live step 3 records the `finish_reason` and `completion_tokens` of a near-limit answer on 0.40.19. If the answer is clearly cut
    (`finish_reason` `length` with no `max_tokens` set), that supports the "little room" wording.
- **OD2 Exact token counting: drop the item. Recommended: drop it**, because no endpoint exists (live finding) and 0.40.19 refuses
  over-context prompts itself. The only change is one README clause (T1): "the ×3 is an estimate; text of mostly digits runs at about
  one token per character and can pass it, and Ollama itself then answers 400, which the proxy maps to the same
  `context_length_exceeded`". The alternative of a prefill probe (`/api/generate` with `num_predict` 0) is rejected: it doubles the
  prompt work, and a tighter ratio for digits is a guess. Revisit only if Ollama adds a public tokenize route.
- **OD3 Overview fix. Recommended: skip the replace when the built markup is unchanged, and restore focus by key when it changes.**
  - The skip removes the 4-per-second rebuilds while a launcher writes log lines. Those pushes change nothing in the Overview.
  - The focus restore covers the real changes, such as a usage push after each request changing a Today line.
  - Why compare markup and not a signature of the inputs: the rows read about ten inputs (`state`, `localServers`, `gufoDraft`, the
    `loggingIn` / `loggingOut` sets, `usage.todayOf`, `Date.now()` for the limit line). A signature has to list them all and goes stale
    as soon as a row reads a new one. The markup is what the user sees, and building the rows is already done on every push today.
    The click handlers are closures over `id` only, so equal markup means equal behaviour.
  - Rejected: "skip while focus is inside the Overview". It leaves stale text, for example "Logging in…", for as long as the focus
    stays there. Also rejected: "update lines in place", which is a bigger rewrite of `renderOverview`.

## Files and modules to touch

| File (51d9bac) | Change | Task |
|---|---|---|
| `src/providers/local-openai.ts:58-61` | Reword the comments on `LOADED_CHARS_PER_TOKEN` and `NEAR_CONTEXT_SHARE` (older versions cut silently, newer ones refuse with 400; ×3 also absorbs token-dense text). Values unchanged. | T1 |
| `src/providers/local-openai.ts:441-443` | Comment and warn text per OD1. Drop `${this.displayName}: ` from the message. Same condition. | T1 |
| `tests/local-openai.test.ts:375` | The end assertion matches the new phrase and checks that the message does not start with the provider name. | T1 |
| `README.md:128` | The "Loaded context (AAP-71)" paragraph: the opening "Ollama cuts ... silently", "(stricter than the × 4 used elsewhere, because a cut is silent)" and "because Ollama may have cut it". | T1 |
| `README.md:314` | "and Ollama truncates beyond it silently, so since AAP-71 ..." | T1 |
| `README.md:29` | The Overview paragraph: the Today line is on every row, not only DeepSeek and the local rows. | T1 (text given below) |
| `ROADMAP.md:55` (append after) | One checked line `- [x] (AAP-73) ...`. | T1 |
| `src/renderer/overview-lines.ts:1-41` | New pure `overviewFocusTarget`. | T2 |
| `src/renderer/settings.ts:462-521` | `data-ov-focus` keys on the three row buttons (`:473-487`). Today counts for every id (`:505`). Markup compare and focus restore around `replaceChildren` (`:521`). One module-level `let overviewMarkup = ""` next to `overviewLocalIds` (`:55`). | T2 |
| `tests/overview-lines.test.ts` | One new `it` for `overviewFocusTarget`. | T2 |

`src/electron/main.ts:310-317`, `src/server.ts`, `src/router.ts` and `src/provider.ts` are read for context only and not changed.

## Tasks

T1 and T2 touch disjoint files and can run in parallel. T1 owns every README and ROADMAP edit, including the Overview sentence for
item 4, so that only one task edits `README.md`.

### T1 Ollama warning text, comments and README (items 1, 2, 4 docs)

Inputs: OD1 and OD2 as decided, and the lines in the table.

Outputs:
1. `local-openai.ts:58` comment, for example: "The measured context counts 3 characters per token, not the usual 4: older Ollama versions
   cut a too long prompt silently (0.40.19 refuses it with HTTP 400, which maps to the same 400), and some text, such as digits, runs
   at about 1 token per character."
2. `:60` comment: "An Ollama answer whose prompt used at least this share of the measured context logs a warning: little room is left
   for the answer, and an older Ollama may have cut the prompt."
3. `:441` comment: the same idea in one line.
4. `:443` message: exactly the OD1 text, with no `${this.displayName}: ` prefix. If OD1 is decided as "drop", remove the constant, the
   two lines and the test assertion instead.
5. `tests/local-openai.test.ts:375`: filter the warn entries by `entry.message.includes("leaves little room for the answer")` and expect
   length 1. In the same `expect` chain, check that this entry's message does not start with `"Ollama"`. Nothing else in the test
   changes; Seg B already sets `promptTokens = 30` of 32.
6. `README.md:128`. Replace the three phrases:
   - Opening: "Ollama's OpenAI-compatible `/v1` endpoint ignores `num_ctx`: a `/v1` request always runs the model at Ollama's default
     context ... A prompt longer than that context is refused by newer Ollama versions with HTTP 400 (seen on 0.40.19; the proxy maps
     it to the same 400 `context_length_exceeded`), and older versions cut it silently."
   - "The limit is the measured context × 3 characters (stricter than the × 4 used elsewhere: older versions cut silently, and some
     text runs at about one token per character, so × 3 is still an estimate; text of mostly digits can pass it, and Ollama's own 400
     then answers)".
   - "An answer whose prompt used at least 90% of that context logs a warning: little room is left for the answer, and an older Ollama
     may have cut the prompt."
7. `README.md:314`: "Ollama's real context is its `num_ctx`, often smaller than the model's `context_length` (older versions cut a
   prompt beyond it silently; newer ones answer 400), so since AAP-71 ...".
8. `README.md:29`: "The DeepSeek row and the four local rows ... also have a line such as" becomes: "Every row also has a line such as
   "Today: 3 requests · ≈ 1.2K tokens · 1 error · $0.0004" ...". Keep the sentence on the local rows (state line, Settings button, no
   Start or Stop) as its own sentence.
9. `ROADMAP.md`: after `:55`, add `- [x] (AAP-73) AAP-72 optional steps: Ollama near-num_ctx warning and README for Ollama's 400 refusal,
   no tokenize endpoint (dropped), Overview keeps focus and skips unchanged rebuilds, Today line on the ACP rows.`

Contract: no behaviour change in `local-openai.ts` except the log text. `git diff src/providers/local-openai.ts` touches only comments
and the one template string.

### T2 Overview rebuild and the ACP Today line (items 3, 4)

Inputs: OD3 as decided.

Outputs:
1. `src/renderer/overview-lines.ts`, a new export with no DOM:
   ```ts
   /** The data-ov-focus key to focus after the Overview rows are rebuilt: the same button when it is still enabled, else that row's Settings button, else none. Keys are "<id>:login" | "<id>:logout" | "<id>:settings". */
   export function overviewFocusTarget(previous: string | undefined, buttons: ReadonlyArray<{ key: string; disabled: boolean }>): string | undefined
   ```
   It returns undefined when `previous` is undefined or neither candidate is present and enabled.
2. `settings.ts:473-487`: set `login.dataset.ovFocus = `${id}:login``, and the same for `logout` and `settingsButton` (`:settings`).
3. `settings.ts:505`: `const todayCounts = usage.todayOf(id);`. The `if (today && todayCounts)` block below it is unchanged, so the ACP
   rows get the same line and tooltip.
4. `settings.ts:521`: replace `el("ov-providers").replaceChildren(...rows);` with:
   ```ts
   const list = el("ov-providers");
   const markup = rows.map((row) => row.outerHTML).join("");
   if (markup !== overviewMarkup) {
     overviewMarkup = markup;
     const active = document.activeElement;
     const previous = active instanceof HTMLElement && list.contains(active) ? active.dataset.ovFocus : undefined;
     list.replaceChildren(...rows);
     const buttons = [...list.querySelectorAll<HTMLButtonElement>("button[data-ov-focus]")].map((button) => ({ key: button.dataset.ovFocus!, disabled: button.disabled }));
     const target = overviewFocusTarget(previous, buttons);
     if (target) list.querySelector<HTMLElement>(`button[data-ov-focus="${target}"]`)?.focus({ preventScroll: true });
   }
   ```
   Everything after it (`ov-mcp`, `codex-home-path`) stays as it is.
5. `tests/overview-lines.test.ts`: one new `it` with three expectations:
   - same key, enabled → same key;
   - same key now disabled → `"<id>:settings"`;
   - `previous` undefined → undefined.

Contract: the rows' content and order are unchanged, apart from the Today line on the three ACP rows. `renderOverview` still runs on
every push (`settings.ts:75`, `:301`, `:600`); only the DOM replace is skipped. Nothing else in `settings.ts` changes.

## Acceptance criteria

Each criterion names the test or step that proves it.

| AC | Criterion | Proof |
|---|---|---|
| AC1 | The near-num_ctx warn line uses the OD1 text, logs once per qualifying answer, and does not repeat the provider name. | `tests/local-openai.test.ts`, the updated assertion at `:375`. Live step 3. |
| AC2 | The README no longer says that Ollama always cuts silently. It names the 400 refusal of newer versions, and the reason for ×3 says it is an estimate. | `git grep -n "may have cut it\|cuts a prompt longer\|truncates beyond it silently\|because a cut is silent\|may have dropped the start" README.md src` prints nothing; `git grep -n "0.40.19" README.md` prints the new line(s). |
| AC3 | Item 2 is recorded as dropped, with the live 404 evidence, and no tokenize code is added. | This plan's live finding. `git diff master --stat` shows no new source file and no `tokenize` string: `git grep -n -i tokenize src` is empty. |
| AC4 | `overviewFocusTarget` keeps the same button, falls back to the row's Settings button, and returns undefined without a previous key. | The new `it` in `tests/overview-lines.test.ts`. |
| AC5 | A launcher log push does not replace the Overview rows. A focused row button keeps focus across a real change. | Live step 6 (app). UNTESTED if the app cannot be driven. |
| AC6 | Codex, Claude and Antigravity rows show the Today line once they have a request today. | Live step 6 (app). UNTESTED if the app cannot be driven. No unit test: `todayUsageLine` is already covered by AC8 of AAP-72. |
| AC7 | Tests and the typecheck are green. | `fnm exec --using default cmd //c "npm test"` and `fnm exec --using default cmd //c "node scripts/typecheck.mjs"` (three `ok` lines). |
| AC8 | The live run leaves Ollama and 8787 as found. | Live step 5: `/api/ps` is `{"models":[]}`, `ollama list` has no `aap73-ctx`, and 8787 `/healthz` is ok. |

Test discipline: two test changes in total, one edited assertion and one new `it`. There is no DOM test for the markup skip; the
environment has no DOM, and the logic is one string compare.

## Live verification

Rules:
- Use a second headless instance on port **8797**, with its settings under `C:/projects/Personal/api-acp-proxy/.claude/temp/aap73-live/`
  (`<dir>`).
- Touch the live proxy on 8787 only with `GET http://127.0.0.1:8787/healthz`, before and after.
- Make no DeepSeek calls; DeepSeek is off in the temp settings.
- Ollama is at `http://localhost:11434` (`<root>`), version 0.40.19, and is local and free.
- Record `/api/ps` first. On 2026-11-28 it was `{"models":[]}`. Leave it the same at the end.
- The temporary model `aap73-ctx` is removed at the end.

0. **Before.** `curl -s http://127.0.0.1:8787/healthz` is ok, `curl -s <root>/api/ps` is recorded, and
   `curl -s -X POST <root>/api/tokenize -d '{"model":"qwen3.8:latest","content":"hi"}'` is still `404 page not found` (it re-confirms OD2).
1. **Temporary model and settings.**
   - `curl -s <root>/api/create -d '{"model":"aap73-ctx","from":"qwen3.8:latest","parameters":{"num_ctx":2048}}'`
   - `<dir>/settings.json`:
     `{"server":{"port":8797},"providers":{"codex":{"enabled":false},"claude":{"enabled":false},"antigravity":{"enabled":false},"gufo":{"enabled":false},"strata":{"enabled":false},"llama":{"enabled":false},"ollama":{"enabled":true,"baseUrl":"http://localhost:11434","maxPromptChars":0},"deepseek":{"enabled":false}}}`
     (`maxPromptChars` 0 lets near-limit and over-limit prompts reach Ollama.)
2. **Start** (Bash, background), with the log going to `<dir>/proxy.out`:
   `cd C:/projects/Personal/api-acp-proxy && PROXY_SETTINGS_FILE=<dir>/settings.json fnm exec --using default npx tsx src/index.ts > <dir>/proxy.out 2>&1`.
   Then `GET http://127.0.0.1:8797/healthz` returns 200.
3. **Item 1 on `ollama/aap73-ctx:latest`, non-stream, no `max_tokens`.**
   1. Send 2000 characters of digits (`"1234567890"` × 200) → 200. `usage.prompt_tokens` is at least 1844; it was 2009 in AAP-72. Record
      `finish_reason` and `completion_tokens` for OD1.
   2. `<dir>/proxy.out` has exactly one warn line containing "leaves little room for the answer". It reads `[ollama] the prompt of
      aap73-ctx:latest used ...`, with no "Ollama:" after the scope.
   3. Send 3000 characters of digits → HTTP 400 `context_length_exceeded`. This is Ollama's own refusal mapped by the proxy, and it
      confirms the README wording.
   4. Send "hi" → 200, and no new warn line.
4. **Stop** the instance.
5. **Clean up.**
   - `curl -s <root>/api/generate -d '{"model":"aap73-ctx","keep_alive":0}'`, then `ollama rm aap73-ctx`.
   - `curl -s <root>/api/ps` matches step 0. If `qwen3.8:latest` shows up, unload it with `keep_alive` 0 in the same way.
   - Delete `<dir>`. `curl -s http://127.0.0.1:8787/healthz` is ok.
6. **Settings window (AC5, AC6).** Run this only if the implement run can drive the Electron window without touching the user's running
   app. That means separate temp settings and port 8797, and no single-instance clash; the `run` skill decides. Otherwise mark AC5
   and AC6 UNTESTED.
   - Open the Overview and Tab to a Settings button. Start a Llama.cpp or Gufo server so that log lines stream. The focus ring stays
     on the button.
   - Send one request to a signed-in ACP provider of that instance. Its row shows "Today: 1 request · ...", and the focused button
     keeps focus after the usage push.

## Commands (Bash)

- `fnm exec --using default cmd //c "npm test"`
- `fnm exec --using default cmd //c "node scripts/typecheck.mjs"`

## Risks

- `outerHTML` must cover every visible difference. The `disabled`, `title`, `hidden` and `type` properties reflect to attributes, and
  the text is in the markup. The handlers are closures over `id` only. A future row with a handler that closes over changing data
  would need a key in its markup; T2 adds a comment saying so at the compare.
- The "older versions cut silently" wording is not tied to a version number, because the version where the 400 started was not
  checked. The README names only 0.40.19, the version that was seen.

## Implementation results (implement, 2026-11-28)

Branch `AAP-73_aap72-optional-steps`, commit 90db8a1 (not merged, not pushed).
- T1 DONE: outputs 1-9. Deviation: the :441 comment says "an older Ollama cuts such a prompt without an error" instead of "may have cut it", because the latter matches the AC2 grep. The test uses `nearLimit[0]?.message` for the tests typecheck.
- T2 DONE: outputs 1-5, with the Risks comment at the compare.
- AC1 DONE (unit + live), AC2 DONE, AC3 DONE, AC4 DONE, AC7 DONE, AC8 DONE. AC5 and AC6 UNTESTED: the user's 8787 app is `electron .` from this repo's `dist/`, so building `dist/` for a second Electron instance would change the files the live app runs from.
- Live step 3 on Ollama 0.40.19: 2000 digits → 200, prompt_tokens 2010 of 2048, finish_reason `length`, completion_tokens 38 (supports OD1 wording), one warn line `[ollama] the prompt of aap73-ctx:latest used 2010 of the 2048 ...`; 3000 digits → 400 `context_length_exceeded`; "hi" → 200, no new warn.
