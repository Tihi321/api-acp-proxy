# Changelog AAP-37

## 2026-11-21 AAP-37: Gufo profiles, auto-switch, vision, image passthrough

Branch `AAP-37_gufo-models-images` (from origin/master), repo api-acp-proxy. Commits (all local, not pushed):
f1fbfda T1, cf56c00 T2, ae4cc04 T3, a93fb27 T4, 1ce8b82 T5, 6dc6498 T7, a5c8b27 T6, 8408b9d T8.

### Changes
- `src/settings.ts`, `src/shared/ipc.ts`: `providers.gufo.profiles[]`, `switchWaitMs`, five presets, migration of old `args` to `qwen27-q4`, `restoreMissingPresets`.
- `src/local-servers.ts`: profile-aware start/switch, port-release wait, per-profile start timeout, model file precheck.
- `src/local-models.ts` (new): `LocalModelCoordinator` (FIFO, no switch while in flight, bounded wait 503, abort leaves queue).
- `src/providers/local-openai.ts`, `src/router.ts`, `src/provider.ts`, `src/acp.ts`: profile models listed with `kind`/`vision`, vision `image_url` parts, per-model hooks, image passthrough upstream.
- `src/server.ts`, `src/mcp-endpoint.ts`: lease before the request timer, `/v1/images/generations` passthrough, new `/v1/images/edits`, 64 MiB image limit, `/v1/models` kind/vision.
- `src/electron/main.ts`, `preload.cts`, `src/renderer/*`: coordinator wiring, Profiles UI, Start/Switch per profile.
- `src/playground/*`: image mode, `validateImageForm`.
- `README.md`, `ROADMAP.md`: docs.
- Tests: settings (1), local-servers (1), local-models (1), local-openai (3), image-generation (2), playground (1).

### Deviations
- C4: port-release wait polls only the new spec's port (old port's fake probe hung the existing test).
- Coordinator ApiError field is `retryAfterSeconds` (capped at 60 s).
- No single `withLease` wrapper; `prepare` + finally in handlers, `withImageRequest` for image routes. MCP timer is paused during the lease and re-armed.
- Extra IPC `restoreGufoPresets` (renderer cannot import settings.ts). Gufo Start IPC now resolves when ready, not when spawned.
- `restoreMissingPresets` also skips a preset whose model already exists.

### Verification
- `npm.cmd test`: 36 files passed, 1 skipped; 489 passed, 1 skipped. (One earlier run had 4 failures in tests/logout.test.ts; rerun green, and green alone on master: flake.)
- `npm.cmd run typecheck`: clean. `npm.cmd run build`: OK.
- NOT run: anything with real Gufo, Electron UI, browser playground (M1-M12).

### Follow-ups
- MCP `generate_image` on a Gufo image model still uses the chat path; `loras`, `n > 1`, playground chat image upload, Strata profiles.

Commit status: code committed locally; ticket folder files uncommitted.

## Polish commit (checker defects)
- Strata is coordinator profile `strata` (leases on every Strata request, Settings Start via `switchTo`); Gufo and Strata no longer kill each other mid-request.
- Coordinator never switches away from a profile whose start is pending (leaver abort safe).
- `LocalServerManager.start` claims the generation before awaiting stop; the replaced start rejects with "replaced by a newer start".
- Image passthrough upstream errors: 401/403 -> 502 `local_upstream_auth`, 404 -> 502, 413 -> 413, other 4xx -> 400.
- server.ts: `serializePrompt` moved before the lease, `beginSse`/first event moved inside the try (chat and Responses).
- Tests: typecheck clean, build OK, `npm.cmd test` 36 files passed, 1 skipped; 491 passed, 1 skipped.

## Polish 2
- External server passthrough: `LocalModelHost.external?` + `LocalServerManager.answersExternally`; a request (not the Settings Start) to a server the app does not own whose port answers goes straight upstream, nothing started or stopped. README documents it (incl. Gufo may serve another model).
- Settings: Gufo profile id `strata` rejected (reserved).
- `LocalServerManager.start`: a Settings Stop during a switch now ends silently (uses `cancelled()`), only a newer start throws SupersededError.
- Tests: coordinator passthrough test, settings reserved-id assertion; 36 files passed, 1 skipped; 492 passed, 1 skipped.
