# Changelog AAP-52

## 2026-11-22 AAP-52: one MCP code for a model that does not accept images, AAP-51 leftovers

Branch `AAP-52_extra-ideas` (from master 33a76c2).

Files:
- `src/mcp-endpoint.ts`: `ask` has one `noImages()` refusal; an `unsupported_content` ApiError from `context.prepare` while the call carries images becomes `model_not_capable` with the models that do (Strata after its load). A provider's own refusal from `generate` still passes on.
- `src/local-monitor.ts`: `readText` exported for its test.
- `src/electron/main.ts`: install comment moved to the `applySettings` line.
- `src/renderer/usage-view.ts`: unused `chart-seg` class dropped.
- `tests/mcp-endpoint.test.ts`, `tests/local-monitor.test.ts`: two existing tests extended.
- `README.md`, `ROADMAP.md`: docs.

Failing first:
- Test 1: on unchanged code `expected 'unsupported_content: The model 'strata/qwen-flash' does not accept image input.' to match /^model_not_capable:.*does not accept images/`.
- Test 2 (guard) by mutation, `decoder.decode(value, { stream: true })` -> `decoder.decode(value)`: expected `# HELP llamacpp:x čas`, received two replacement characters. Restored.

Deviation: test 1 uses its own `textBodies` array (expects length 0) instead of the shared `bodies` (length 1); same meaning.

Verification: `yarn typecheck` exit 0; `yarn test` 45 files passed, 1 skipped; 524 tests passed, 1 skipped. `grep -rn chart-seg src tests` empty. No build, no Electron start, `dist/` and settings.json untouched.

UNTESTED: a live `ask_model` with an image to a Strata whose model reads no images after a proxy start; the Usage page after the class change.

Commit status: committed on AAP-52_extra-ideas (not pushed).
