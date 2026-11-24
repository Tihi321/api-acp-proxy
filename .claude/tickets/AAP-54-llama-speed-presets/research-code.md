# AAP-54 research (code): llama.cpp profiles/presets, version list cap, Strata "Required"

All paths relative to C:/projects/Personal/api-acp-proxy. Read only; nothing run or reproduced (UI not launched). No CLAUDE.md in the repo root.

## Question
A) How llama.cpp profiles/presets work and where a "flag presets" feature fits. B) Where the Version dropdown list comes from and how to cap it at 5 (keeping the installed one). C) Why Strata shows a red "Required" under Arguments.

## Answer
- A: Profiles are zod objects in `src/settings.ts:103-130`, built-ins in `LLAMA_PRESETS` (`:134-150`), turned into llama-server args by `buildLlamaArgs` (`src/llama-args.ts:31-53`), saved wholesale in settings.json. There is no reusable "flag preset" today; only whole-profile presets plus a free-text `extraArgs`.
- B: Releases come from `fetchReleases` with `per_page=20` (`src/llama-releases.ts:106`); the renderer lists all of them (`src/renderer/llama-view.ts:124`). The installed tag is NOT guaranteed to be in the list today (it is older than 20 => absent). Cap needs an "always include installed" rule.
- C: A real renderer-side bug (over-strict validation): Arguments is declared a required field (`src/renderer/settings.ts:79`), so empty gives "Required" (`:680`). The schema default is `""` (`src/settings.ts:27`, `:333`), `{port}` is NOT required, and it has nothing to do with Max concurrent.

## A. Llama.cpp profiles and presets

**Profile shape** (confirmed `src/settings.ts:31-41, 103-130`): base `id` (slug regex), `label`, `model` (exposed `llama/<model>`), `vision`, `startTimeoutMs?`, `requestTimeoutMs?`; plus `modelFile`, `mmprojFile?`, `ctxSize?`, `gpuLayers` (auto|all|int, default auto), `flashAttn` (auto|on|off), `specType` (13 values, `LLAMA_SPEC_TYPES` `:98`), `draftFile?`, `draftNMax?`, `draftNMin?`, `draftGpuLayers?`, `extraArgs` (string, "appended verbatim"), `hf?` (repo/revision/quant/mmproj/draft), `requires?` (minBuild, sources). Refine: vision needs mmprojFile (`:129`). Unique id and model enforced (`:222-230`).

**Built-in presets** (confirmed `src/settings.ts:132-150`): `inkling-2-mini` labelled "Inkling 2 Mini (Q8_0, vision)" and `inkling-2-mini-dspark` "Inkling 2 Mini DSpark (Unsloth build)". Both use ctx 32768, `-ngl all`, `extraArgs = "--temp 1.0 --top-p 1.0 --top-k 0 --min-p 0.0"` (`INKLING_SAMPLING`). The label "(Q4_0, vision)" the user sees is NOT in source (only Q8_0); a test uses "IQ4_NL" (`tests/llama-models.test.ts:24`). Inferred: the user's saved profile was edited or relabelled via "Use found files" (`src/renderer/llama-models.ts`, `applyFix`), as the saved profiles array is authoritative.
- Defaults: if `providers.llama.profiles` is absent, presets are cloned in (`src/settings.ts:196-198`).
- "Restore missing presets": button `src/renderer/settings.html:613`, handler `src/renderer/llama-view.ts:781-790` -> IPC `proxy:restoreLlamaPresets` (`src/electron/main.ts:376`, `preload.cts:53`, `shared/ipc.ts:359`) -> `restoreMissingLlamaPresets` (`src/settings.ts:154-158`): appends presets whose id AND model are both absent. It does not reset an edited preset. (Gufo equivalent: `restoreMissingPresets`, `src/settings.ts:63`.)

**Profile -> args** (confirmed `src/llama-args.ts:31-53`): `-m "<abs model>" --host 127.0.0.1 --port {port} --alias <model> [--metrics unless extraArgs has it] [-c ctx] -ngl X -fa Y [--mmproj ..if vision] [--spec-type T --spec-draft-model .. --spec-draft-n-max .. --spec-draft-n-min .. --spec-draft-ngl ..if specType != none] <extraArgs>`. `{port}` is substituted by the launcher (`src/local-servers.ts:15-18`: `"<command>" <args>` through cmd.exe). `%` and `"` are rejected (`:23-26`). No flags exist for batch/ubatch/threads/parallel/KV-cache type: those only fit in `extraArgs`.

**Editor UI** (`src/renderer/llama-view.ts:545-609`): grid with each field above, `extraArgs` textarea (`:573`), profile list in a `profiles` array (`:70`); collect trims and returns `profiles` (`:821-851`), saved as a whole value by `collectPatch` (`src/renderer/settings.ts:693-701`) -> `api.saveSettings` -> main `proxy:saveSettings` (`src/electron/main.ts:321`) -> `mergeSettings` (`src/settings.ts:366-381`, arrays replace) -> `SettingsStore` atomic write of `%APPDATA%\api-acp-proxy\settings.json` (or `PROXY_SETTINGS_FILE`, `:356-362`, `:395`).

**Where a "presets" feature would fit** (inferred options):
1. Named flag-preset list under `providers.llama.flagPresets: [{id,label,flags/extraArgs, maybe structured subset}]`, a dropdown in each profile card (beside `extraArgs`, `llama-view.ts:573/607`) that copies into `extraArgs` (simple) or is referenced by id (`flagPreset?` on the profile, merged in `buildLlamaArgs` before `extraArgs`, then it also needs to be part of any "server key" that decides a restart).
2. Reuse the proven pattern: schema + `restoreMissing...` + IPC + button (Gufo/Llama preset code above).
3. Existing similar: `extraArgs` free text; `INKLING_SAMPLING` constant shared by presets (`settings.ts:132`); whole-profile `LLAMA_PRESETS`; `requires` gate (`llama-args.ts:106`). Embedding server has its own `extraArgs` (`settings.ts:190`), which a shared preset could also serve.
- Schema change must stay backward compatible: new field optional/default (`profiles` are parsed by `llamaProfileSchema`; settings version literal is 1, `:260`). IPC view types (`src/shared/ipc.ts:82-87` area, `LlamaProfileView`) must be extended by hand.

**Tests covering this** (confirmed by grep): `tests/llama-args.test.ts` (exact `buildLlamaArgs` strings `:12`, `--metrics` de-dup `:16`, `%` rejection `:20`), `tests/settings.test.ts:32` (`restoreMissingLlamaPresets` length), `tests/llama-models.test.ts` (file fixes/labels), `tests/llama-install.test.ts` (releases), `tests/local-servers.test.ts` (launcher). No renderer DOM test for the llama view found (`tests/desktop-views.test.ts` has no strata/llama hits).

## B. Version dropdown (b12674 ...)

- Fetch: `fetchReleases(source, opts)` -> `GET https://api.github.com/repos/<repo>/releases?per_page=${opts.perPage ?? 20}` (`src/llama-releases.ts:105-107`). Called only from `proxy:llamaReleases` (`src/electron/main.ts:412-421`) with no perPage, cached 10 min per source (`RELEASES_TTL_MS`, `main.ts:73`, `:402`); `refresh=true` from "Refresh versions" (`settings.html:586`, `llama-view.ts:759`). Note: `parseReleases` drops drafts and releases with no Windows asset (`:63-84`), so the visible count can be below 20 already.
- List: `fillVersions()` (`src/renderer/llama-view.ts:116-129`) renders every release as an `Option` (`:124`); selected tag kept if still present (`:125-127`), else the first release having the chosen backend.
- Installed/active info: `binary.installed` (`{source, tag, backend, arch,...}`, `src/settings.ts:160-173`, rendered `llama-view.ts:145-148`). "Active" test in `updateBuildButtons` (`:176-186`) compares `info.tag` with the selected release. If the installed tag is not in `releases`, today it simply never appears (nothing selects it), and the note "Not active: the app uses ..." (`:185`) shows for whatever is selected.
- Cap options (inferred): (a) slice in the renderer `fillVersions` to the first 5 plus the installed tag (and the currently selected tag) if missing; (b) `perPage: 5` in `fetchReleases` call in main.ts, but then an older installed release is not in the data at all and the plan needs `fetchRelease(source, tag)` (`llama-releases.ts:121`, exists) for the installed tag, or build a stub option from `binary.installed`. Option (a) with a stub/`fetchRelease` fallback keeps `selectedRelease()` (`:102`) working for the installed one. Caveat: with per_page=5 and drafts/no-Windows-asset releases filtered, fewer than 5 may remain; slicing after parse (e.g. keep per_page 20 or ~10, slice to 5 after filtering) is safer.
- On-disk check `refreshOnDisk` (`:159-169`) works on `selectedRelease()`, so a listed-but-old release can offer "Use this build".
- Tests to update: `tests/llama-install.test.ts:20-49` asserts the exact URL `per_page=20` (breaks if perPage changes). The renderer function is not unit tested.

## C. Strata "Required" under Arguments

- Page markup: `src/renderer/settings.html:494-522`; Arguments input `providers.strata.args` with error slot `data-error-for="providers.strata.args"` (`:518`); Max concurrent `:515` is a separate field with label "(empty = 1)".
- Field table: `src/renderer/settings.ts:76-82`: `strata.args` is `{kind:"text", scope:"strata"}` with NO `optional: true`; `strata.maxConcurrent` is `optional: true` (`:82`); `command`, `cwd` also required, `apiKey` optional (`:81`).
- Validation: `collectPatch` (`settings.ts:665-685`): for a text field, `if (text === "") { if (!spec.optional) { errors.push({path, message: "Required"}); continue; } ... }` (`:679-681`). `showErrors` (`:705-714`) writes it into the matching `data-error-for` node, hence the red "Required" under Arguments; Save aborts at `saveScope` `:727` (nothing is sent).
- Server side: `args: z.string().default(defaults.args)` (`src/settings.ts:27`); Strata default is `args: ""` (`:333`, command default is a .bat in D:\Strata\terminal). So an empty value is valid for the schema, the launcher (`src/local-servers.ts:15-18` handles empty args: `"<command>"` only), and the shipped default. `{port}` placeholder is documented as optional ("is replaced", `settings.ts:15`, `settings.html:514`); nothing requires it.
- Max concurrent: unrelated to args. Empty -> `null` in the patch -> key deleted -> schema default 1 (`settings.ts:20`, `mergeSettings :372`); it feeds only the per-provider request limiter (`src/controller.ts:248`, `router.ts:57`), NOT llama-server `-np`. For Strata (a user-supplied .bat) no argument is derived from it. The apparent link is, inferred, coincidence: the user likely saved with Arguments empty while that field was also blank/1; the Required error appears regardless of Max concurrent.
- Verdict: BUG (renderer validation stricter than the schema/default and than the launcher; the default Strata config, args "", cannot be saved back once the form is re-collected). Not a misplaced message, not a real requirement; the label "Required" is wrong. Fix is one flag: add `optional: true` to `providers.strata.args` (`settings.ts:79`) so empty sends `null` and the schema default `""` applies (check `setPath(patch, ..., null)` is handled like the other optional text fields: `:681-684` sends `null` => key removed => default `""`). Gufo has no top-level args field, so no other page shares it. Not reproduced in the running app (read only); logic read directly from code.
- Tests: none found for `collectPatch` (renderer). A regression test would need extracting the validation or a DOM test.

## What the plan needs
- Files: `src/settings.ts` (schema/presets), `src/llama-args.ts`, `src/shared/ipc.ts` + `src/electron/main.ts` + `src/electron/preload.cts` (new IPC if presets are managed in main), `src/renderer/llama-view.ts` + `settings.html` (UI), `src/llama-releases.ts`/`main.ts`/`llama-view.ts` (cap), `src/renderer/settings.ts` (Strata fix); tests above; README sections (`README.md:149-214`) mention presets/restore.
- Interfaces: `LlamaProfileView` mirror type in `shared/ipc.ts`; `LlamaReleasesResult` (`ipc.ts:235`).

## Risks
- Adding profile fields: `mergeSettings` replaces `profiles` whole (arrays), settings.json forward/backward compat (old app reading a new field: zod object strips unknown keys by default, inferred, so downgrade loses them).
- Changing per_page changes the cached list and a test; installed-older-than-cap must not vanish (it is also used for "Not active" note).
- Any new flag fed to `buildLlamaArgs` must go through `safe()` (cmd.exe quoting) and be part of the restart-needed key.
- Strata fix: relies on `null` -> default; check `mergeSettings` delete then schema default (confirmed `settings.ts:372,380`).

## Open questions
- What exactly are "best flags/commands" to save (structured fields vs raw text; apply to profile or to embedding too)? Scope decision for the user.
- Where did "Q4_0" label come from (user's settings.json; not inspected).
- Cap source: 5 per source (ggml-org and unsloth separately), and whether fewer-than-5 after filtering is acceptable.
