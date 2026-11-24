# AAP-56 Llama.cpp unknown flag warning

- `src/shared/llama-help.ts`: `parseHelpFlags(helpText)`, `splitArgs`, `unknownFlags(args, known)` (pure; used by main and renderer).
- `src/electron/main.ts`: `llamaHelpFlags()` runs `<llama-server.exe> --help` (execFile, windowsHide, 10 s timeout), cached by exe path + mtime; `proxy:llamaStatus` returns it as `helpFlags` (absent on failure or empty parse = no warnings).
- `src/shared/ipc.ts`: `LlamaStatusView.helpFlags?`.
- `src/renderer/llama-view.ts`: profile warning "Unknown to <tag or folder>: ..." from Extra arguments only (not generated flags); refreshed on typing and when status arrives.
- Tests: `tests/llama-help.test.ts` with fixture `tests/fixtures/llama-server-help.txt` (real b12651 ROCm `--help`).
- README: one paragraph in the Llama.cpp section.
- Not run in the real app (UNTESTED).
