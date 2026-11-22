# AAP-48 changelog

## 2026-11-22 - AAP-48 (creative-hub HUB-43, REQ-0030): tests typechecked, local usage counts guarded, cancelled-turn test de-flaked

Repo api-acp-proxy, branch `AAP-48_small-fixes` (from master 23cf725). `yarn test`: 44 files passed, 1 skipped; 520 tests passed, 1 skipped (same count as before; no test added, one existing case extended).

### Files and what changed
- `tsconfig.tests.json` (new): extends `tsconfig.json`, `noEmit`, includes `src` and `tests`, excludes `src/renderer` and `src/playground`.
- `package.json`: `typecheck` also runs `tsc -p tsconfig.tests.json`.
- `src/providers/local-openai.ts`: `completion_tokens` goes through `finiteOrZero`; `total_tokens` is used only when a finite number, else prompt + completion.
- `tests/local-openai.test.ts`: the odd-usage case now also sends `completion_tokens: "9"` and `total_tokens: "x"` and asserts completion 0 and total 100.
- `tests/acp-provider.test.ts`: "does not keep a cancelled turn" waits (20 ms polls, up to 10 s) until the fake agent logged `session/prompt`, asserts it was sent once, then aborts. `existsSync` imported. The three old assertions are unchanged. This replaces `await sleep(250)`.
- `ROADMAP.md`: AAP-48 line after AAP-47.
- Typing fixes (type-only, every assertion kept):
  - `tests/local-servers.test.ts`: `manager: LocalServerManager` annotation and `probe` return `Promise<boolean>` (breaks the self-reference); `!` on `children[0]` and `manager.list()[0]`.
  - `tests/download.test.ts`: `headersFor` return type `Record<string, string>`.
  - `tests/llama-models.test.ts`: `!` on `scan[0]`, `scan[1]`.
  - `tests/playground.test.ts`: `!` on four indexed accesses; `as Array<[string, string]>` on the fixture list; `usage: null` on the fake bridge's `generate` result (`GenerationResult.usage` is required).
  - `tests/prompt-limit.test.ts`: the helper passes `{ enabled: true, ...providerSettings }` (resolved settings always carry `enabled`).
  - `tests/controller.test.ts`: the llama profile gets the schema defaults (`vision: false`, `gpuLayers: "auto"`, `extraArgs: ""`, `flashAttn: "auto"`, `specType: "none"`), the same values the schema would add on parse.
  - `tests/plan-limits.test.ts`: dropped the dead `signedIn` field (see below).

### The two cases that needed a look
- `plan-limits.test.ts:92` `signedIn`: `make(signedIn, log)` is the test helper's own parameter; it writes `<dir>/codex-home/auth.json` when true. It was also passed to `new ProxyController({... signedIn })`, which has no such option, so it was ignored at runtime. The controller's `dataDir` is `path.dirname(settingsPath)` (`src/controller.ts:93`), which is `<dir>`, so the file written by the helper is what the Codex status check reads. The test does test what its name says (signed-out provider is not probed). Fix: removed the dead field from the constructor call; the helper parameter stays.
- `controller.test.ts:96`: the llama profile was an incomplete literal; completed from `llamaProfileSchema` (`src/settings.ts`) rather than cast. Runtime effect none (defaults).

### Deviations
- A2 literal reading: `git diff master -- tests/` shows removed `expect(` lines beyond the `sleep(250)` swap (the `[0]` -> `[0]!` lines in local-servers, playground; the same assertions re-added with a `!`). Nothing removed or weakened; the diff shows them as replaced lines.
- `tests/local-openai.test.ts` odd case: the old `completion_tokens: 9, total_tokens: 109` values were changed (plan-directed); the old case had no assertion on them.

### Verification
- `yarn typecheck` exit 0 (three configs). Deliberate `const x: number = "a";` in `tests/download.test.ts` made it fail (exit 2, `TS2322`); removed, exit 0 again.
- `npx vitest run tests/acp-provider.test.ts -t "does not keep a cancelled turn"` x20: 20 of 20 passed.
- `yarn test` x3: 3 of 3 passed, each 520 passed, 1 skipped.
- No build, no proxy or Strata request, settings.json untouched.

### Not run (UNTESTED)
- Usage guard against a real local server sending non-numeric counts (none known): unit-tested only.
- No `yarn build`; the running app's `dist/` does not contain the guard until hub R1 builds.

### Commit
Committed on `AAP-48_small-fixes` (not merged, not pushed).
