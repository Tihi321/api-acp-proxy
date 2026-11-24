---
status: in-progress
request: REQ-0011
repos: [api-acp-proxy]
branch: AAP-54_llama-speed-presets
updated: 2026-11-24
---

# AAP-54 Faster Llama.cpp presets, saved flag presets, a 5-release version list, Strata Arguments optional

Request: `.claude/director/requests/REQ-0011-llama-speed-presets.md`. Sources: `research-code.md` (code map) and `research-flags.md` (llama.cpp flags, checked against `--help` of ggml-org b12651 and unsloth b12649 in `D:\LlamaCpp\bin`). Line numbers were checked on master 4601fd2.

Reading chosen (one line, per the scope rule): **full reading** of "presets so we can save best commands" means named flag sets the user can save, rename, delete and apply to any profile; the narrow reading (only better built-in profiles) is part 1 and is done as well.

## Rules for every worker

- Branch `AAP-54_llama-speed-presets`, cut from master 4601fd2. Workers do not commit; the orchestrator makes **one commit** after the checks, subject `AAP-54: faster Llama.cpp presets, flag presets, 5-release version list, Strata args optional`, written with a Bash heredoc (`git commit -F - <<'EOF'`), a blank line after the subject, ending with the attribution line from the session. No push, no merge.
- The proxy app may be running from `dist/`: no `yarn build`, no `yarn dist*`, no `yarn app:dev`. Tests and typecheck only. Never read, print or touch `%APPDATA%\api-acp-proxy\settings.json`.
- Commands (from `package.json` scripts), run from `C:\projects\Personal\api-acp-proxy`. `fnm exec --using default yarn` fails on this PC ("program not found"); in Bash first run `export PATH="/c/Users/Infplane/AppData/Roaming/fnm/aliases/default:$PATH"` (checked: `yarn --version` gives 4.13.0).
  - all tests: `yarn test` (`vitest run`); some files: `yarn test tests/<file>.test.ts ...`
  - typecheck: `yarn typecheck` (node, renderer and tests configs)
  - there is no lint script; do not invent one.
- Tests follow the global `test-discipline` skill: only the tests listed under Tests. Every new or changed assertion is first **shown failing** on the unchanged code (or, for the Strata test, on the pure refactor before the one-flag fix); the failing line goes into `changelog.md`.
- Renderer text only through `textContent` / `make(tag, class, text)`; no inline styles (`style-src 'self'`, `src/renderer/settings.html:5`). `src/renderer` cannot import `src/settings.ts` (renderer tsconfig includes only `src/renderer`, `src/shared`, `src/playground`).
- Working trees are CRLF, git stores LF: do not flip line endings. Write regexes and Windows paths with the Edit/Write tool, not a Bash heredoc.

## Scope

### 1. Faster built-in Llama profiles (`LLAMA_PRESETS`, `src/settings.ts:132-150`)

Every flag below is listed in the `--help` of both installed builds (research-flags section 3). The generated flags come from `buildLlamaArgs` (`src/llama-args.ts:31-53`): `flashAttn` becomes `-fa <value>` and the draft fields become `--spec-draft-n-max`, `--spec-draft-n-min`, `--spec-draft-ngl` (the new names; the removed `--draft`, `--draft-max`, `--draft-min` are never generated). `buildLlamaArgs` is **not changed**.

New constant beside `INKLING_SAMPLING` (`:132`):
```ts
/** AAP-54 Strix Halo ROCm speed flags (research-flags.md 4a): no mmap (slow ROCm loads), larger ubatch (prefill), one slot (full ctx), 16 physical cores. */
const STRIX_HALO_ROCM = "--no-mmap -ub 1024 -np 1 -t 16";
```

| preset | change | why |
|---|---|---|
| both | `flashAttn: "on"` (was `"auto"`) | kyuz0 recommends FA on for Strix Halo; auto may resolve to off. Generates `-fa on`. |
| both | `extraArgs: \`${STRIX_HALO_ROCM} ${INKLING_SAMPLING}\`` | `--no-mmap`, `-ub 1024`, `-np 1`, `-t 16`; sampling flags kept unchanged at the end. `-b` stays at its default 2048 (not written). |
| `inkling-2-mini-dspark` | `draftGpuLayers: "all"` (was `99`) | draft fully on the GPU, the research's `--spec-draft-ngl all` |
| `inkling-2-mini-dspark` | `draftNMax: 5` (was 3) | see decision below |

**Decision, draft max 5:** the llama.cpp speculative docs use 7, the value is clamped to the draft's trained block size, and the Inkling Small DSpark card measured a mean acceptance length of about 3.7-3.8 at block 7. With acceptance above 3, a cap of 3 throws away accepted tokens; 7 risks more wasted verify work on a looped target (each verify runs the loop core 3 times). 5 is the middle of the research's 3/5/7 sweep. It is a starting point until the user benchmarks (research-flags section 6); no source measured Mini DSpark.

Not changed (decisions): no `-ctk/-ctv q8_0` (a memory trade, not speed, at ctx 32768), no `--n-cpu-moe`/`-ot`/`--mlock`, no `--jinja` (not in the request), no `--spec-draft-p-min` (needs a confidence head, unknown for the Mini draft), no `--spec-draft-sampling probabilistic` in the built-in profile (low confidence; offered as a flag preset). `vision`, files, `ctxSize`, `gpuLayers "all"`, `requires` stay.

**Existing saved profiles are not overwritten.** Stored `providers.llama.profiles` always win (the preprocess at `src/settings.ts:196-198` only seeds when the array is absent), and "Restore missing presets" only appends ids and models that are absent (`:154-158`). This ticket keeps both rules. How a user gets the new defaults, said in the README and in the Flag presets card note:
- on any profile, apply the flag preset "Strix Halo ROCm speed" (part 2) and set Flash attention to `on`; for DSpark also set Draft tokens max 5 and Draft GPU layers `all`;
- or remove the built-in profile and click "Restore missing presets" (this loses the user's own file choices on that profile).

### 2. Flag presets (named, saved sets of extra arguments)

Decision: **apply copies** the preset's text into the profile's Extra arguments (replacing it). No reference by id: nothing changes in `buildLlamaArgs` or in what decides a restart, and the user can edit the copied text right after. Built-in presets therefore include the sampling flags, so applying one keeps them. Presets hold only flags that no profile field generates (not `-fa`, `-ngl`, `-c`, `--mmproj`, `--spec-type`, `--spec-draft-model/-n-max/-n-min/-ngl`), so the command line never carries a flag twice.

Settings: `providers.llama.flagPresets: Array<{ id, label, args }>`, seeded with the built-ins when the key is absent (same rule as `profiles`), stored as a whole array (arrays replace in `mergeSettings`, `src/settings.ts:366-381`), so an emptied list stays empty. Old app versions reading the file drop the unknown key (zod strips), accepted.

Built-in flag presets (`LLAMA_FLAG_PRESETS` in `src/settings.ts`):

| id | label | args |
|---|---|---|
| `strix-halo-rocm` | Strix Halo ROCm speed | `${STRIX_HALO_ROCM} ${INKLING_SAMPLING}` |
| `strix-halo-rocm-kv-q8` | Strix Halo ROCm speed, KV cache q8_0 (less memory, needs Flash attention on) | `${STRIX_HALO_ROCM} -ctk q8_0 -ctv q8_0 ${INKLING_SAMPLING}` |
| `dspark-probabilistic` | DSpark probabilistic draft (experiment) | `${STRIX_HALO_ROCM} --spec-draft-sampling probabilistic ${INKLING_SAMPLING}` |
| `inkling-sampling` | Inkling sampling only (the old default) | `${INKLING_SAMPLING}` |

Decision: the brief's example "DSpark draft n=5" is not a flag preset, because draft max is a profile field (`draftNMax`) and a `--spec-draft-n-max` in the text would duplicate the generated flag; the built-in DSpark profile carries n=5 instead.

UI (Llama.cpp page):
- a new card **Flag presets** after the Profiles card: one row per preset with Name (text input, renames), Arguments (textarea) and Delete. A note: "Saved sets of extra arguments. Apply one on a profile: it replaces that profile's Extra arguments, which you can then edit. Leave flags that profile fields set (-fa, -ngl, -c, --spec-*) to the fields. To get the AAP-54 speed defaults on an existing profile, apply Strix Halo ROCm speed and set Flash attention to on."
- in each profile card, beside Extra arguments: a select whose first option is "Apply a flag preset…" (value `""`), then one option per preset; choosing one sets the textarea and `profile.extraArgs` to its `args`, marks the page dirty and resets the select to `""`. A button **Save as flag preset** (disabled while the textarea is empty) appends `{ id: unique "preset-<n>", label: "<profile label> arguments", args: <trimmed text> }`, re-renders the Flag presets list and flashes "Saved as flag preset; rename it under Flag presets. Save to keep it."
- "Restore missing presets" (`settings.html:613`) also restores missing **built-in flag presets** (by id) through a new IPC, and its message counts both.
- Everything is saved by the Llama page's Save, like profiles (dirty flag, `collectPatch`). No new dialog (Electron has no `window.prompt`).

### 3. Version dropdown: the latest 5 per source, plus installed and selected

- `fetchReleases` keeps `per_page=20` (`src/llama-releases.ts:106`): drafts and releases without a Windows asset are dropped after the fetch, so fetching only 5 could show fewer. `tests/llama-install.test.ts:44-46` (URL `per_page=20`) therefore stays as is.
- Main (`proxy:llamaReleases`, `src/electron/main.ts:412-421`): after `fetchReleases`, when `llamaSettings.binary.installed` is of this source and its tag is not in the list, append `await fetchRelease(source, installed.tag, opts)` (exists, `src/llama-releases.ts:121`); a failure is ignored (the list still works). Call `await refreshLocalSettings()` first, as `proxy:llamaBuildOnDisk` does. The result is cached like today.
- Renderer: a new pure `visibleReleases(releases, keep, max = 5)` returns the first `max` releases in the given (newest-first) order plus every later release whose tag is in `keep`, order kept. `fillVersions` (`src/renderer/llama-view.ts:116-129`) renders and picks from `visibleReleases(releases, [installedTagOfThisSource, selectedTag])` instead of `releases`. `selectedRelease()` (`:102`) keeps searching the full `releases`.

### 4. Strata Arguments "Required" (bug)

Cause (research-code C): `src/renderer/settings.ts:79` declares `providers.strata.args` as a required text field, so `collectPatch` (`:678-681`) pushes "Required" for an empty value and Save aborts (`:727`), although the schema default is `""` (`src/settings.ts:27`, `:333`) and the launcher handles empty args. Max concurrent is unrelated.

Fix: `optional: true` on that field. Empty then sends `null`, `mergeSettings` deletes the key (`src/settings.ts:372`) and the schema default `""` applies. The label becomes "Arguments (optional)" (`settings.html:518`).

To test it without the DOM: move `Scope`, `FieldSpec`, the `fields` table (`settings.ts:8-9`, `:36-91`) and the per-field text/number check out of `collectPatch` into a new pure module `src/renderer/settings-fields.ts`. `settings.ts` cannot be imported by a test (it reads `window.proxyApi` at load).

Other local-server pages, checked for the same mistake on args-like fields:
- Gufo: no top-level args field. Profile `args` (`settings.ts:369-381`) is not validated in the renderer and the schema allows empty (`src/settings.ts:47`). No bug.
- Llama.cpp: profile `extraArgs` (`llama-view.ts:573`) is not validated (`:843` only trims). No bug.
- Embeddings: `embedding.extraArgs` has no field in the UI. No bug.
- Still required on purpose (real requirements, not changed): `command`, `cwd`, `port` of Gufo and Strata, `providers.llama.modelsDir`, `binary.dir`, `embedding.modelFile`.

So `providers.strata.args` is the only instance.

## Out of scope

- Downloading or comparing a Vulkan build; any auto-benchmark or llama-bench run from the app.
- Changing `reasoning_effort` (the research's biggest latency lever, not requested) or any sampling value.
- MTP (`draft-mtp`) settings, `--jinja`, KV-cache type in the built-in profiles, ROCm env vars.
- Changes to `buildLlamaArgs`, the server/restart key, Gufo or embedding presets, flag presets for the embedding server.
- Resetting a user's edited profile to the new built-in values automatically.
- Anything not listed under Scope.

## Files and modules to touch

| file | worker | what |
|---|---|---|
| `src/shared/ipc.ts` | A (first step) | `LlamaFlagPresetView`, `flagPresets` on `LlamaProviderSettingsView` (`:81-84`), `restoreLlamaFlagPresets` on the API (`:359`) |
| `src/settings.ts` | A | `STRIX_HALO_ROCM`, new `LLAMA_PRESETS` values, `llamaFlagPresetSchema`, `LLAMA_FLAG_PRESETS`, `restoreMissingLlamaFlagPresets`, seeding in the llama preprocess (`:194-198`), `flagPresets` in `llamaProviderSchema` |
| `src/electron/main.ts` | A | IPC `proxy:restoreLlamaFlagPresets` beside `:376`; installed-release append in `proxy:llamaReleases` (`:412-421`); import `fetchRelease` |
| `src/electron/preload.cts` | A | `restoreLlamaFlagPresets: (presets) => invoke("proxy:restoreLlamaFlagPresets", presets)` beside `:53` |
| `tests/settings.test.ts`, `tests/llama-args.test.ts` | A | see Tests |
| `README.md` (`:186-214`), `ROADMAP.md` | A | profile defaults, flag presets, version list, Strata args |
| `src/renderer/settings-fields.ts` (new) | B | `Scope`, `FieldSpec`, `fields`, `fieldValue` |
| `src/renderer/settings.ts` | B | import from `settings-fields.ts`; `collectPatch` uses `fieldValue`; `providers.llama.flagPresets` in the llama patch (`:693-701`) |
| `src/renderer/llama-versions.ts` (new) | B | `visibleReleases` |
| `src/renderer/llama-view.ts` | B | version cap in `fillVersions`; flag preset state, card, profile-card picker and Save-as, restore, `load`/`collect` |
| `src/renderer/settings.html` | B | Flag presets card after the Profiles card (`:612-617`); Strata label (`:518`) |
| `src/renderer/settings.css` | B | only if the new rows need a class the sheet lacks (reuse `.profile`, `.grid`, `.field`, `.row` first) |
| `tests/settings-fields.test.ts` (new), `tests/llama-install.test.ts` | B | see Tests |
| `.claude/tickets/AAP-54-llama-speed-presets/changelog.md` (new) | orchestrator | files, failing-first lines, counts, UNTESTED list |

## Tasks for workers

Two workers, disjoint files; they can run in parallel.

### Worker A: settings, main, presets, docs

Inputs: this plan, `research-flags.md`, `src/settings.ts`, `src/llama-args.ts` (read only), `src/electron/main.ts`, `src/electron/preload.cts`, `src/shared/ipc.ts`, the two test files.

Steps:
1. **`src/shared/ipc.ts` first** (the contract below, verbatim), then tell the orchestrator it is in, so Worker B can typecheck.
2. Tests of the Tests section (A items) on the unchanged code; record one failing line each.
3. `src/settings.ts`: the constant and preset values of Scope 1; then
   ```ts
   const llamaFlagPresetSchema = z.object({
     id: z.string().regex(/^[a-z0-9._-]{1,48}$/, "A flag preset id is 1 to 48 characters of a-z, 0-9, '.', '_' or '-'."),
     label: z.string().min(1, "A flag preset needs a name."),
     /** Copied into a profile's extraArgs when applied; never referenced by a profile. */
     args: z.string(),
   });
   export type LlamaFlagPreset = z.infer<typeof llamaFlagPresetSchema>;
   export const LLAMA_FLAG_PRESETS: readonly LlamaFlagPreset[] = [ /* the four rows of Scope 2, in that order */ ];
   /** `presets` plus the built-in flag presets whose id is absent. Pure. */
   export function restoreMissingLlamaFlagPresets(presets: readonly LlamaFlagPreset[]): LlamaFlagPreset[];
   ```
   In the llama preprocess (`:194-197`) seed `profiles` and `flagPresets` independently (each only when not an array). In `llamaProviderSchema` add `flagPresets: z.array(llamaFlagPresetSchema).default([])` with a duplicate-id `superRefine` (message `Duplicate flag preset id '<id>'.`).
4. `main.ts`: `handle("proxy:restoreLlamaFlagPresets", (presets: unknown): LlamaFlagPresetView[] => Array.isArray(presets) ? restoreMissingLlamaFlagPresets(presets as LlamaFlagPreset[]) : [])`; the release append of Scope 3. `preload.cts`: the one line.
5. `yarn test tests/settings.test.ts tests/llama-args.test.ts` green, then `yarn typecheck`.
6. README: the `flashAttn` row note and the presets paragraph (`:207-212`: FA on, the speed flags, draft max 5, draft `-ngl all`), a short **Flag presets** paragraph (what they are, apply copies and replaces, Save as, rename/delete, Restore, seeded once, stored as `providers.llama.flagPresets`), the version list rule (latest 5 per source plus installed and selected), and "Strata `args` may be empty". ROADMAP: one `- [x]` row in the AAP-53 row's style, "live check UNTESTED".

Outputs: the files above; failing-first lines; pass counts.

Contract with Worker B (`src/shared/ipc.ts`, exact):
```ts
/** A named set of extra arguments (AAP-54; see `LlamaFlagPreset` in settings.ts). Applying one copies `args` into a profile's `extraArgs`. */
export interface LlamaFlagPresetView { id: string; label: string; args: string }
// LlamaProviderSettingsView gains:  flagPresets: LlamaFlagPresetView[];   (replaced as a whole value, like profiles)
// ProxyApi gains, next to restoreLlamaPresets:
  restoreLlamaFlagPresets(presets: LlamaFlagPresetView[]): Promise<LlamaFlagPresetView[]>;
```
`SettingsPatchView` picks up `flagPresets` by itself (`:114` maps the keys of `LlamaProviderSettingsView`). Main guarantees `settings.providers.llama.flagPresets` is always an array in the state view, and that `proxy:llamaReleases` may return one extra, older release (the installed one) after the newest ones.

### Worker B: renderer

Inputs: this plan, the contract above, `src/renderer/settings.ts`, `src/renderer/llama-view.ts`, `src/renderer/settings.html`, `src/renderer/settings.css`, `tests/llama-install.test.ts`.

Steps:
1. Strata, reproduction first: create `src/renderer/settings-fields.ts` holding `Scope`, `FieldSpec`, `fields` (moved unchanged, **still without** `optional` on `providers.strata.args`) and
   ```ts
   /** The patch value of one text or number field from its raw input text, or the error shown under it. Empty optional -> null (the key is cleared, the schema default applies). Pure. */
   export function fieldValue(spec: FieldSpec, raw: string): { value: string | number | null } | { error: string };
   ```
   (text and select, as today's `else` branch: `apiKey` paths untrimmed, others trimmed; empty -> `"Required"` or `null`; number: empty -> `"Required"` or `null`, non-finite -> `"Must be a number"`). `collectPatch` (`settings.ts:665-685`) calls it for every kind but bool; bool stays as it is. Behaviour of every other field is unchanged (pure move). Write `tests/settings-fields.test.ts`, run it, record the failing line (`{ error: "Required" }`). Then add `optional: true` to `providers.strata.args`; the test passes. Label in `settings.html:518`: "Arguments (optional)".
2. `src/renderer/llama-versions.ts`:
   ```ts
   /** The releases the Version list shows: the first `max` (newest first, as fetched) plus any later one whose tag is in `keep`; order kept. Pure. */
   export function visibleReleases<T extends { tag: string }>(releases: readonly T[], keep: ReadonlyArray<string | undefined>, max = 5): T[];
   ```
   Test in `tests/llama-install.test.ts` first (fails: module missing). Use it in `fillVersions` with `keep = [binary.installed?.source === sourceSelect.value ? binary.installed.tag : undefined, selectedTag]`; the options, the `keep` check and the default pick all use the visible list.
3. Flag presets in `llama-view.ts`: state `let flagPresets: LlamaFlagPresetView[] = []`; `load()` copies `settings.flagPresets`; `renderFlagPresets()` fills `#llama-flag-presets` (Name input `change` re-renders the profile pickers, Arguments textarea `input` marks dirty, Delete removes and re-renders both); profile card picker and **Save as flag preset** per Scope 2 (unique id `preset-<n>` not taken by another preset); `collect()` returns `flagPresets` trimmed (label and args) and adds the error `{ path: "providers.llama.flagPresets", message: "A flag preset needs a name." }` when a label is empty; `LlamaViewCollected` gains `flagPresets`. "Restore missing presets" handler (`:781-790`) also calls `api.restoreLlamaFlagPresets(flagPresets)` and reports "Added N profile presets and M flag presets. Save to keep them." (or "All presets are present."). `settings.ts` collectPatch: `setPath(patch, "providers.llama.flagPresets", collected.flagPresets)` beside `:699`.
4. `settings.html`: the Flag presets card (`<section class="card">`, head `<h2>Flag presets</h2>`, the note of Scope 2, `<div id="llama-flag-presets"></div>`, `<p class="msg" id="llama-flag-presets-msg" role="status"></p>`) right after the Profiles card.
5. `yarn test tests/settings-fields.test.ts tests/llama-install.test.ts`, then (once Worker A's `ipc.ts` is in) `yarn typecheck`; `grep -rn "style\.\|setAttribute(\"style\"" src/renderer` gives no match.

Outputs: the files above; failing-first lines; pass counts; note any CSS added.

Contract with Worker A: uses only the `ipc.ts` contract above; touches none of Worker A's files.

Order: Worker A step 1 lands before Worker B's typecheck; otherwise both run in parallel. The orchestrator then runs `yarn test`, `yarn typecheck`, the style grep, reads the full diff and writes `changelog.md`.

## Tests (test-discipline: three new `it`s, two changed)

1. **`tests/settings-fields.test.ts`** (new, the reproduction), `it("an empty Strata Arguments saves and clears to the default; Command stays required")`:
   - `const spec = (path: string) => fields.find((f) => f.path === path)!;`
   - `expect(fieldValue(spec("providers.strata.args"), "")).toEqual({ value: null })` (fails before the fix: `{ error: "Required" }`);
   - `expect(fieldValue(spec("providers.strata.args"), "  --x {port}  ")).toEqual({ value: "--x {port}" })`;
   - `expect(fieldValue(spec("providers.strata.command"), "")).toEqual({ error: "Required" })`;
   - `expect(mergeSettings(mergeSettings(defaultSettings(), { providers: { strata: { args: "--x" } } }), { providers: { strata: { args: null } } }).providers.strata.args).toBe("")` (the null reaches the schema default).
2. **`tests/llama-install.test.ts`**, new `it("shows the latest 5 releases plus the installed and the selected one")`: ten releases `b10`..`b1` (newest first); `visibleReleases(list, [])` tags are `b10`..`b6`; `visibleReleases(list, ["b2", undefined, "b8"])` is `b10`..`b6`, `b2`; a list of 3 gives 3. Fails before: module missing. The existing URL assertion (`per_page=20`, `:44-46`) is unchanged and still passes.
3. **`tests/llama-args.test.ts`**, the existing test (`:8`): the DSpark exact string becomes `... -c 32768 -ngl all -fa on --mmproj "..." --spec-type draft-dspark --spec-draft-model "..." --spec-draft-n-max 5 --spec-draft-ngl all --no-mmap -ub 1024 -np 1 -t 16 ${sampling}`; add `expect(plain).toContain("-fa on")`, `expect(plain).toContain("--no-mmap -ub 1024 -np 1 -t 16 --temp 1.0")` and, for both presets, `not.toMatch(/(^|\s)--draft(-max|-min)?(\s|$)/)` (no removed flag). Fails before on the exact string (`-fa auto`, `n-max 3`, `ngl 99`).
4. **`tests/settings.test.ts`**, `:28` becomes `toMatchObject({ specType: "draft-dspark", draftNMax: 5, draftGpuLayers: "all", flashAttn: "on", vision: true })` (fails before). New `it("seeds the flag presets once, keeps the user's lists and never rewrites a stored profile")`:
   - `settingsSchema.parse({}).providers.llama.flagPresets.map((p) => p.id)` is `["strix-halo-rocm", "strix-halo-rocm-kv-q8", "dspark-probabilistic", "inkling-sampling"]`, and every `args` ends with `--temp 1.0 --top-p 1.0 --top-k 0 --min-p 0.0` and none matches `/(^|\s)(-fa|-ngl|-c|--spec-draft-n-max|--spec-draft-ngl|--draft-max)(\s|$)/`;
   - `{ flagPresets: [] }` stays `[]`; a stored `[{ id: "mine", label: "Mine", args: "-t 8" }]` stays exactly that; two with id `mine` throw `/Duplicate flag preset id/`;
   - `restoreMissingLlamaFlagPresets([{ id: "mine", label: "Mine", args: "" }])` has length 5 and starts with `mine`;
   - a stored old DSpark profile (`{ ...LLAMA_PRESETS[1], flashAttn: "auto", draftNMax: 3, draftGpuLayers: 99 }`) parses back with `flashAttn: "auto"`, `draftNMax: 3`, `draftGpuLayers: 99`, and `restoreMissingLlamaPresets` of it plus the mini preset returns the same two profiles unchanged.
   Fails before: `flagPresets` is undefined / `restoreMissingLlamaFlagPresets` is not exported.
5. No test for `main.ts` (not loaded by tests) or the DOM code in `llama-view.ts` / `settings.ts`: proof by reading the diff.

## Acceptance criteria

| # | criterion | proof |
|---|---|---|
| S1 | Built-in Inkling 2 Mini and DSpark generate `-fa on`, `--no-mmap -ub 1024 -np 1 -t 16`, the unchanged sampling flags; DSpark `--spec-draft-n-max 5 --spec-draft-ngl all`; no removed `--draft*` flag | Test 3; Test 4 (`:28`) |
| S2 | A stored profile keeps its own values; Restore only appends missing ones | Test 4 (old DSpark profile) |
| S3 | Flag presets are seeded once when absent, an emptied or user list is kept, ids are unique, Restore appends missing built-ins | Test 4 (new `it`) |
| S4 | Built-in flag presets keep the sampling flags and never carry a flag a profile field generates | Test 4 (regex) |
| S5 | Applying a preset replaces the profile's Extra arguments with editable text; Save as adds a preset from the current text; rename and delete in the Flag presets card; all saved by the page's Save | diff of `llama-view.ts`, `settings.ts`, `settings.html`; UNTESTED in the app |
| S6 | The Version list shows at most the 5 newest releases per source plus the installed and the selected tag, even when older | Test 2; diff of `fillVersions` and `main.ts` `proxy:llamaReleases` |
| S7 | The releases fetch URL is unchanged (`per_page=20`) | existing assertion `tests/llama-install.test.ts:44-46` |
| S8 | Strata saves with Arguments empty; Command still required | Test 1 (fails before the one-flag fix) |
| S9 | No other args-like field on the Gufo, Llama.cpp or Embeddings pages is wrongly required | the list in Scope 4; `grep -n "Required" src/renderer/*.ts` shows only the fields named there |
| S10 | No inline style in the renderer | `grep -rn "style\.\|setAttribute(\"style\"" src/renderer` no match |
| S11 | Nothing else breaks | `yarn test`, `yarn typecheck` |

## UNTESTED (needs the real app, a GPU and the user's eyes)

- That `-fa on`, `--no-mmap`, `-ub 1024`, `-np 1`, `-t 16`, draft max 5 and `--spec-draft-ngl all` actually make Inkling 2 Mini faster on this Strix Halo; no flag was benchmarked (research-flags section 6 has the commands). If `-fa on` fails to load on a build, set Flash attention back to `auto`.
- `-ctk q8_0 -ctv q8_0` and `--spec-draft-sampling probabilistic` presets on these builds.
- The Flag presets card, the picker, Save as, Restore, and the Version list in the running app; an installed build older than the 20 fetched releases (the extra `fetchRelease` call).
- Saving the Strata page with Arguments empty in the app.
