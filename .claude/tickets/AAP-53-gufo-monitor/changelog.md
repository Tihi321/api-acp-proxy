# Changelog

## 2026-11-23 AAP-53: Gufo status on the Monitor, image flag note on About

A loaded Gufo language model now fills the Monitor's engine tiles (state, slots, context, average speed) from its llama-server style `/props`, `/slots` and `/metrics`, with Gufo's key in the request header; a GPU context loss count above 0 shows on the Engine tile; a Gufo image model is not read and says so; About notes when the server's image flag and the profile's vision flag disagree.

### api-acp-proxy, branch `AAP-53_gufo-monitor` (from master 07bccd3)

- `src/shared/ipc.ts`: `EngineView.kind` gains `"gufo"`; new `deviceLost?: number`; `speedMissing` and `MonitorView.engine` comments updated.
- `src/local-monitor.ts`: new `parseGufoDeviceLost`; `mapLlama` takes a `kind` ("llama" default, "gufo"): for Gufo no `version` (its `build_info` is never copied), a missing counter read is always `"metrics-unread"`, and `deviceLost` is read; `readText` takes headers; `fetchEngine` reads Gufo like llama-server with one `Authorization` header object shared by every read (Strata, `/props`, `/slots`, `/metrics`); the alias is read for Llama.cpp only; the AAP-51 identity check now covers Gufo.
- `src/electron/main.ts`: no engine read for a Gufo image profile; Gufo's own `apiKey` is passed for a Gufo read only (to Gufo's port from its server entry); Llama.cpp still gets no key. The outside-server path is unchanged.
- `src/renderer/monitor-format.ts`: `SpeedSubInput.gufo`; Gufo never gets a llama-server or `--metrics` text; new `deviceLostText` and `imagesNote`.
- `src/renderer/monitor-view.ts`: Gufo counts as llama-style for the speed tiles; "Starting" before the Gufo reason, which now reads "No status source for Gufo image models"; Engine tile sub line from `deviceLostText`; About Images sub line from `imagesNote` first.
- `tests/local-monitor.test.ts`: Gufo fixture (recorded 2026-11-23, planted markers); one new `it`; the fetch test now reads Gufo instead of asserting no call.
- `tests/monitor-format.test.ts`: one `speedSub` row; one new `it`.
- `README.md`, `ROADMAP.md`: Monitor paragraph and a new done row; the "Monitor next cut: Gufo status" row removed.

### Failing first (on the unchanged code)

- `maps Gufo's llama-style props, slots and metrics, never text, a path or its build string`: `expected { kind: 'llama', …(7) } to deeply equal { kind: 'gufo', state: 'idle', …(6) }`
- `keeps keys in the request header, reports an unreachable port and reads Gufo like llama-server`: `expected undefined to be 'gufo' // Object.is equality`
- `gives every empty speed tile its reason` (new row): `Gufo without a speed read: expected 'restart the model for speed' to be 'speed not read this time'`
- `notes a GPU context loss and an image flag that disagrees with the profile`: `TypeError: (0 , deviceLostText) is not a function`

### Deviations

- Director's note on the key: besides the planned assertions, the fetch test also asserts that a 401 from Gufo returns `{ error: "HTTP 401" }` and that neither the view nor that error contains the key value.
- The orchestrator did the edits itself instead of launching one implementer child (one small, plan-dictated slice).
- `imagesNote` applies to any engine with an image flag and a profile vision flag, so a Llama.cpp model whose `/props` vision disagrees with its profile also gets the note (the plan's code does this; noted here, not changed).

### Verification

- `yarn test tests/local-monitor.test.ts tests/monitor-format.test.ts` before the code: 4 failed, 5 passed; after: all pass.
- `yarn test`: 45 files passed, 1 skipped; 526 tests passed, 1 skipped.
- `yarn typecheck`: exit 0.
- `grep -rn 'style\.\|setAttribute("style"' src/renderer`: no match.
- `grep -n 'kind === "llama"' src/renderer/monitor-view.ts`: line 186 has `|| engine?.kind === "gufo"`.
- `git diff --stat`: nothing under `src/providers`, `src/router.ts`, `src/settings.ts`.
- Line endings kept (CRLF working tree, LF index).

### UNTESTED

- Monitor and About with a real Gufo loaded (tiles, speed after a request, the Images note).
- A Gufo started with a key (not configured on this PC).
- `gufo_device_lost_total` above 0.
- A Gufo image profile on the Monitor; `gufo/flash-next-q4` and `gufo/deepseek4`.
- Whether `gufo/Qwen3.8-27B` really reads images.
- No build, no app start (the app runs from `dist/`).

### Follow-ups

- Speculation tile from `llamacpp:spec_decode_*` and `gufo_spec_lookup_*`; a Gufo server started outside the app (plan, out of scope).

Commit status: code and docs committed as 73cbf63 on `AAP-53_gufo-monitor`; ticket records (this folder) uncommitted; not pushed, not merged.

## Polish 1

- A Gufo language model whose start failed no longer shows "No status source for Gufo image models" on the Engine tile; it shows "Engine not reachable". The image-models text now appears only when the loaded Gufo profile is an image one. A starting Gufo shows "Starting", as before.
- `reason()` moved out of `monitor-view.ts` as the pure `engineReason()` in `monitor-format.ts`. One optional field, `local.image?: true`, added to `MonitorView` in `src/shared/ipc.ts` and set only in `src/electron/main.ts` from the Gufo profile's kind (no secret in it).
- Test: one table-style case in `tests/monitor-format.test.ts` (image ready, language error, starting); it failed on the old logic (Expected "Engine not reachable", Received "No status source for Gufo image models").
