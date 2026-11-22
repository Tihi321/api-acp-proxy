# Changelog

## 2026-11-22 AAP-45 "Use found files" keeps hf.quant in line with the model file

Repo api-acp-proxy, branch `AAP-45_fix-hf-quant`.

- `src/renderer/llama-models.ts`: `applyFix` for a model file now also sets `hf.quant` to the chosen file's quant when the profile has `hf` (copy, the input profile is not mutated). mmproj and draft fixes leave `hf` as it was.
- `tests/llama-models.test.ts`: the first test also asserts the new `hf` and that the preset is unchanged.
- `ROADMAP.md`: checked item for AAP-45.

Deviations: none.

Verification: `npm test` (vitest run) 43 files passed, 515 tests passed, 1 skipped; `npm run typecheck` exit 0; `npx vitest run tests/llama-models.test.ts` 4 passed. `yarn` not used. No build run.

Not run: the Llama.cpp page in the desktop app (button press and save).

Commit status: committed on the branch, not merged, not pushed.
