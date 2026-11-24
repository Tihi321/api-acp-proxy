# Changelog

## 2026-11-24 AAP-54 (REQ-0011): faster Llama presets, flag presets, 5-release version list, Strata Arguments optional

Repo api-acp-proxy, branch `AAP-54_llama-speed-presets` (from master 4601fd2).

Files and behaviour:
- `src/settings.ts`: built-in Inkling 2 Mini / DSpark get `-fa on` and `--no-mmap -ub 1024 -np 1 -t 16` before the sampling flags; DSpark draft max 5, draft ngl `all`. New `flagPresets` setting (schema, duplicate-id check, seeded once when absent), four built-in flag presets, `restoreMissingLlamaFlagPresets`. Stored profiles are not rewritten.
- `src/shared/ipc.ts`, `src/electron/preload.cts`, `src/electron/main.ts`: flag preset view type, `restoreLlamaFlagPresets` IPC; `proxy:llamaReleases` appends the installed release when older than the fetched 20 (failure ignored).
- `src/renderer/llama-view.ts`, `settings.html`: Flag presets card (rename, edit, delete), per-profile apply picker and Save as flag preset, Restore also restores flag presets, version list capped via `visibleReleases`; Strata label "Arguments (optional)".
- `src/renderer/llama-versions.ts` (new): `visibleReleases`. `src/renderer/settings-fields.ts` (new): field table moved out of `settings.ts` plus pure `fieldValue`; `providers.strata.args` is optional. `src/renderer/settings.ts`: uses them, sends `flagPresets` in the llama patch.
- `README.md`, `ROADMAP.md`: docs and roadmap row.
- Tests: `tests/settings-fields.test.ts` (new), `tests/llama-install.test.ts`, `tests/llama-args.test.ts`, `tests/settings.test.ts`.

Failing first:
- settings-fields: `expected { error: 'Required' } to deeply equal { value: null }`
- llama-install: `Failed to load url ../src/renderer/llama-versions.js`
- llama-args:12: exact DSpark string (`-fa auto`, `n-max 3`, `ngl 99`)
- settings:28: `draftGpuLayers "all"`/`draftNMax 5`/`flashAttn "on"` received `99`/`3`/`auto`; new `it`: `Cannot read properties of undefined (reading 'map')`

Verification: `yarn test` 46 files passed, 1 skipped; 531 tests passed, 1 skipped. `yarn typecheck` no errors. Style grep on `src/renderer` no match.

Deviations: none from the plan.

Not run (UNTESTED): speed effect of the flags on the real GPU; q8 KV and probabilistic draft presets; Flag presets card, picker, Save as, Restore, Version list and the extra `fetchRelease` call in the app; saving Strata with empty Arguments in the app. No build was run.

Follow-ups: releases cache can miss a just-installed tag until TTL; profile cards rebuild (focus loss) when presets change.

Commit: see git log (one commit, not pushed).

## Follow-ups

- Releases cache: `proxy:installLlama` (src/electron/main.ts) deletes the source's `releasesCache` entry after a successful install, so the next Version list refetches and shows the new build.
- Apply message: applying a flag preset from a profile card flashes "Applied flag preset '<label>'. Save to keep it." in `llama-profiles-msg`.
- Duplicate: each Flag presets row has a Duplicate button that inserts "<label> copy" right after it with a free `preset-<n>` id (`nextPresetId` in src/renderer/llama-models.ts, shared with Save as flag preset), marks the page dirty.
- Keep focus: rename, delete, save-as and duplicate no longer call `renderProfiles()`; `refreshPresetPickers()` rebuilds only the picker options in existing cards, and `renderFlagPresets(focusId)` re-renders just the list, focuses the new/neighbouring row's name input and restores the scroll position.
- Test: one added (`nextPresetId`) in tests/llama-models.test.ts. Not run in the real app (UNTESTED).
