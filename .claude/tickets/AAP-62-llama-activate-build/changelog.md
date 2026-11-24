# AAP-62 llama-activate-build

- New IPC `activateLlamaBuild` (src/electron/main.ts, preload.cts, shared/ipc.ts): switches to a build already on disk (findInstalledBuild + installPatch), no network; refuses while a binary download runs.
- Settings > Llama.cpp: separate "Activate" button (settings.html); "Download / update" no longer turns into "Use this build" (llama-view.ts). Activate is disabled while busy, when the build is not on disk, or when it is already active.
- README Build section mentions Activate.
- No new test (no existing pattern for these handlers or the view). typecheck and yarn test pass (541 passed, 1 skipped).
