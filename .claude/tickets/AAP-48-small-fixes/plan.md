---
status: done
request: creative-hub/REQ-0030
repos: [api-acp-proxy]
branch: AAP-48_small-fixes
updated: 2026-11-22
---

# AAP-48 Small proxy fixes: typecheck the tests, guard local usage counts, de-flake the cancelled-turn test

Hub ticket: creative-hub HUB-43 (`C:\projects\Personal\creative-hub\.claude\tickets\HUB-43-open-ideas\plan.md`, triage items 5, 6, 7), request REQ-0030. The user said on 2026-11-22: "Ok build open idea first". Checked on master 23cf725 (AAP-46 and AAP-47 merged).

Notes for workers:
- The desktop proxy the hub starts runs from this repo's `dist/` and is RUNNING. No `yarn build` on this branch: tests, typecheck only (hub R1 builds after the merge, with the user's go-ahead).
- Leave the two uncommitted AAP-43 files (`.claude/tickets/AAP-43-local-embeddings/events.jsonl`, `plan.md`) out of every commit.
- The user's `%APPDATA%\api-acp-proxy\settings.json` is never touched; this ticket adds no setting.
- Commands (Bash: `export PATH="/c/Users/Infplane/AppData/Roaming/fnm/aliases/default:$PATH"` first): test `yarn test`; typecheck `yarn typecheck`; build `yarn build` (NOT in this ticket); there is no lint script.
- Merge order: AAP-48 merges before AAP-49 (AAP-49 is cut from AAP-48's head, so its tests are typechecked too; both add a ROADMAP line).

## Scope

1. A typecheck config for `tests/` (item 5). Verified: `tsconfig.json` includes only `src` (minus renderer and playground) and `tsconfig.renderer.json` only `src/renderer`, `src/shared`, `src/playground`, so no test file is typechecked. A trial run on 2026-11-22 (a temp config extending `tsconfig.json` with `tests` added, `noEmit`) found 29 errors in 7 files: `tests/local-servers.test.ts` 13 (implicit `any` on `manager`/`probe`/`s` at 20, 27, 29, 40, 66; possibly-undefined at 44, 49, 76, 79, 133), `tests/playground.test.ts` 7 (146, 149, 152, 172, 224 x2, 252), `tests/download.test.ts` 4 (46, 52, 61, 65: the fake `fetch` type), `tests/llama-models.test.ts` 2 (50), `tests/controller.test.ts` 1 (96: a llama profile literal without `vision` and the other required fields), `tests/plan-limits.test.ts` 1 (92: `signedIn` is not a `ControllerOptions` field), `tests/prompt-limit.test.ts` 1 (105: `Record<string, unknown>` as `ProviderSettings`).
2. `src/providers/local-openai.ts:235-237`: `completion_tokens` and `total_tokens` from upstream are used unguarded (`chunk.usage.completion_tokens ?? 0`, `chunk.usage.total_tokens ?? inputTotal + outputTokens`); `prompt_tokens` and `cached_tokens` already go through `finiteOrZero` (item 6).
3. `tests/acp-provider.test.ts:185` (the discoveries say 195) "does not keep a cancelled turn" fails now and then under full-suite load (item 7). The race, found by reading the code: the test aborts after a fixed `await sleep(250)`. Under load the fake agent's spawn and `initialize` take longer than 250 ms, so the abort lands while `generate` awaits `this.start()` (`src/acp-provider.ts:864`); `generate` then returns `cancelled` at `:865` before any session exists, the `finally` (`:921-924`) has no session to dispose, no `session/delete` is sent, and `methodCount(log, "session/delete")` is 0, not 1. The provider is right in both cases; the test does not wait for the state it means to test (a cancel during a running prompt).

## Out of scope

- Item 4 (`architecture.input_modalities` for Gufo and Llama profiles): NO CHANGE for Llama (a profile's `vision` and its `--mmproj` flag come from the same profile fields, `src/llama-args.ts:40` and `src/providers/local-openai.ts:41`, so they cannot disagree while the server runs); Gufo NEEDS A RUNNING SERVICE (hub plan, probe P2).
- Any change to `src/` other than the usage guard; the renderer typecheck config.
- The Monitor second cut (AAP-49).

## Files and modules to touch

| file | change |
|---|---|
| `tsconfig.tests.json` (new) | `{ "extends": "./tsconfig.json", "compilerOptions": { "noEmit": true, "rootDir": ".", "declaration": false, "sourceMap": false }, "include": ["src", "tests"], "exclude": ["src/renderer", "src/playground"] }` (tests that import renderer modules pull them in as imports; the trial showed no DOM errors from that) |
| `package.json` | `"typecheck": "tsc --noEmit && tsc --noEmit -p tsconfig.renderer.json && tsc -p tsconfig.tests.json"` |
| the 7 test files above | fix each error with the smallest type-only change (annotations, `!` or a guard where the test already asserts the value exists, a typed fake `fetch` (`as unknown as typeof fetch` only where the fake is deliberately partial), the missing profile fields). Two need a look, not a cast: `plan-limits.test.ts:92` passes `signedIn`, which `ControllerOptions` does not have: find what the test means (read `src/controller.ts` options and the test's name) and pass the real option or drop the dead field, keeping what the test asserts; `controller.test.ts:96` builds a llama profile: complete it from the profile schema in `src/settings.ts` rather than casting. No assertion is weakened or removed. |
| `src/providers/local-openai.ts:235-237` | `const outputTokens = finiteOrZero(chunk.usage.completion_tokens);` and `totalTokens: typeof chunk.usage.total_tokens === "number" && Number.isFinite(chunk.usage.total_tokens) ? chunk.usage.total_tokens : inputTotal + outputTokens` |
| `tests/local-openai.test.ts:95-101` | extend the existing odd-usage case (it already sends `cached_tokens: "80"`): also send `completion_tokens: "9"` and `total_tokens: "x"`; assert the client's usage has `completion_tokens` 0 and `total_tokens` 100 |
| `tests/acp-provider.test.ts:185-196` | replace `await sleep(250);` (line 191) by waiting until the fake agent logged the prompt: `for (let n = 0; n < 500 && !(existsSync(log) && methodCount(log, "session/prompt") > 0); n++) await sleep(20);` then `expect(methodCount(log, "session/prompt")).toBe(1);` before `controller.abort()` (`existsSync` from `node:fs`: `readLog`, line 111, uses `readFileSync` and throws while the file does not exist yet). The fake answers a prompt only after 500 ms (`FAKE_ACP_DELAY=1`, `tests/fixtures/fake-acp.mjs:401`), so the abort now always lands during the prompt. The three existing assertions stay unchanged. |
| `ROADMAP.md` | one line after the AAP-47 line (44): `- [x] Tests are typechecked, local usage counts are guarded, the cancelled-turn test waits for its prompt (AAP-48; creative-hub HUB-43): \`yarn typecheck\` also runs \`tsconfig.tests.json\`; a non-numeric completion_tokens or total_tokens from a local server counts as 0 or the sum; "does not keep a cancelled turn" aborts once the prompt was sent.` |

## Contracts

- `yarn typecheck` now runs three configs and fails on a type error in `tests/`.
- `LocalOpenAiProvider` usage: every number it reports is finite (`prompt`, `cached`, `completion`, `total`, `thoughtTokens` as today).

## Tasks for workers

1. One worker, in order: (a) `tsconfig.tests.json`, `package.json`, the test-file fixes, until `yarn typecheck` passes; (b) the usage guard and its test; (c) the de-flake; (d) ROADMAP; `changelog.md` in this folder (test count, what each test-file fix was, UNTESTED list). Output: one commit `AAP-48: typecheck the tests, guard local usage counts, de-flake the cancelled-turn test` on `AAP-48_small-fixes`.

## Acceptance criteria

| # | criterion | proof |
|---|---|---|
| A1 | test files are typechecked, and pass | `yarn typecheck` exit 0; deliberately add `const x: number = "a";` to any test file, `yarn typecheck` fails, remove it |
| A2 | no assertion was weakened by the typing fixes | `git diff master -- tests/` shows no removed `expect(` line except the `sleep(250)` swap |
| A3 | non-numeric completion/total counts are guarded | the extended `tests/local-openai.test.ts` case |
| A4 | the cancelled-turn test is no longer timing-bound | `npx vitest run tests/acp-provider.test.ts -t "does not keep a cancelled turn"` 20 times in a loop, all pass; then `yarn test` three times in a row, all pass |
| A5 | nothing else breaks | `yarn test` |

## UNTESTED

- Nothing user-visible changes; no live check is needed. The usage guard against a real local server that sends a non-numeric count (none known) is unit-tested only.
