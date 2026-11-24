# AAP-55: replace the removed --no-mmap flag

Cause: AAP-54 put `--no-mmap` into the built-in presets; every installed llama-server build rejects it (`error: invalid argument: --no-mmap`, exit 1). See AAP-54-llama-speed-presets/research-start-failure.md.

## Decision
`-lm, --load-mode MODE` (all 4 builds): "auto: mmap, unless a device does not support it; none: no special loading mode; mmap; mlock; mmap+mlock; dio". So `none` = no mmap. `--no-mmap` becomes `-lm none`.

## Files
- src/settings.ts: STRIX_HALO_ROCM uses `-lm none`; `migrateNoMmap` + `migrateStored` in the llama preprocess rewrite the standalone token in stored profiles' `extraArgs` and flag presets' `args` (pure, idempotent; `--no-mmap-like` untouched).
- src/renderer/llama-view.ts (updateProfileButtons): a profile card shows "Stopped: <launcher.error>" (e.g. `exited with code 1: error: ...`) when the launcher is in state error for that profile. Uses the existing `LocalServerStatusView.error`; textContent only, no styles.
- tests/llama-args.test.ts, tests/settings.test.ts (one new migration test), README.md.

## Failing first
- tests/llama-args.test.ts:12 expected `-lm none -ub 1024...`, received `--no-mmap -ub 1024...`
- tests/settings.test.ts "llama --no-mmap migration": expected `-lm none -ub 1024 --temp 1.0 --no-mmap-like`, received `--no-mmap -ub 1024 ...`

## Flags vs --help (b12613, b12651, unsloth b12588, unsloth b12649), all present
-m, --host, --port, --alias, --metrics, -c, -ngl (all), -fa (on|off|auto), --mmproj, --spec-type (draft-dspark), --spec-draft-model, --spec-draft-n-max, --spec-draft-ngl, -lm (none), -ub, -np, -t, --temp, --top-p, --top-k, --min-p, -ctk/-ctv (q8_0), --spec-draft-sampling (probabilistic). `--no-mmap`: absent in all 4.

## Verification
yarn test 533 passed, 1 skipped; yarn typecheck clean.
UNTESTED: real start of a model with `-lm none` (only --help was run); the exit-reason line in the running app; load-time effect of `-lm none` on ROCm.
