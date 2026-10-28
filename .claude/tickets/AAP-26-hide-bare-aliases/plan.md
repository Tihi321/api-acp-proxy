# AAP-26 hide bare aliases

Problem: GET /v1/models lists `codex/gpt-x` and bare `gpt-x` for providers with exposeUnprefixed; discovering clients show duplicates.

Plan (branch AAP-26_hide-bare-aliases):
1. src/settings.ts: `server.listBareAliases` boolean default true (current behaviour kept); env `PROXY_LIST_BARE_ALIASES` via parseBool; pass into ProxyConfig.listBareAliases.
2. src/config.ts: add `listBareAliases?: boolean`; fix stale comment on maxConcurrent ("unset = unlimited"; settings default is 4).
3. src/router.ts: RouterOptions.listBareAliases (default true); `entries()` skips the bare id when false. `resolve()` unchanged so bare ids still route.
4. src/controller.ts: pass config.listBareAliases to ProviderRouter.
5. Renderer: checkbox `server.listBareAliases` in settings.html and field in src/renderer/settings.ts, next to reuseSessions.
6. Tests: router.test.ts (both modes: listing + bare id routes), settings.test.ts (default true, env 0/1).
7. README env table + notes; ROADMAP AAP-26 entry; fix AAP-25 line ("Not yet run on hub instance" -> running on hub since 2026-10-27, merged PR #21).
8. npm test, npm run typecheck, npm run build; commit with Co-Authored-By: Claude Opus 5.5 trailer; do not push.
