# AAP-20: Codex models from the agent, and codex-acp 2.x

> Branch: `AAP-20_codex-models`, cut from `origin/master` (`82644df`). Worktree: `.claude/temp/wt-aap20` (its own `node_modules`). AAP-19 (desktop status and log-in) is being built in the main checkout at the same time; keep changes to `src/providers/codex.ts` small to ease the merge.

## Why

The Codex model list is hardcoded: `MODEL_IDS = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]` in `src/config.ts`, used as `staticModels` in `src/providers/codex.ts`. On 2026-10-27 the user's Codex app (client 0.164.0) lists `gpt-6-luna`, `gpt-5.6-terra` and `gpt-5.6-luna` (from `~/.codex/models_cache.json`, visibility `list`).
- `gpt-5.6-sol` is gone.
- `gpt-6-luna` is missing from the proxy.

The bundled agent, `@agentclientprotocol/codex-acp` 1.12.0 (Codex 0.154.0), offered only `gpt-5.6-terra` and `gpt-5.6-luna` in its `session/new` model option during the AAP-11 spike (both described as "Older ..."). The latest codex-acp is 2.3.0.

## Steps

1. **Upgrade** `@agentclientprotocol/codex-acp` to `2.3.0` (exact, not a preview), then run `npm install` in this worktree to update `package-lock.json`. Check whether `scripts/verify-package.mjs` and `electron-builder.config.cjs` still find its entry point and native binary (`dist/index.js`, the platform package).
2. **Probe 2.3.0** with `scripts/acp-probe.mjs`, launched the way `src/providers/codex.ts` does (hardened `CODEX_CONFIG`, `INITIAL_AGENT_MODE=read-only`). Use the user's `~/.codex` login via `PROXY`-style launch without `CODEX_HOME`: the proxy's own home has no login. Record the findings in `spike.md` here:
   - `initialize`: version, `agentCapabilities` (image, MCP http/sse, `auth.logout`), auth methods.
   - The `session/new` model option list. `gpt-6-luna` is expected.
   - That the AAP-12 hardening still holds:
     - the config keys `features.shell_tool`, `features.unified_exec`, `features.plugins` and `skills.include_instructions` are still accepted;
     - with them, a "list files with a command" prompt gets no shell tool;
     - no "Skill descriptions were shortened" text appears.
   - That the read-only mode id `read-only` still exists.
   - One cheap prompt with `gpt-6-luna`.
   - The AAP-15 MCP approval shape (permission request with `_meta.is_mcp_tool_approval` and only `toolCallId`; tracked `tool_call` with `rawInput.server` / `tool`), using `.claude/temp/aap11/mcp-echo.mjs` from the main checkout.
   - Whether the image tool still runs with no permission and its update shape (AAP-14) still matches. One generation only if the shapes are otherwise unclear.
   - Whether web search still runs with no permission (AAP-17).

   Keep it to about 6 prompts. If a shape changed, update the matching provider code and tests.
3. **Discover Codex models at runtime:**
   - Drop `staticModels` for Codex, so models come from the agent's model option like Claude and Antigravity, and the models cache keeps `/v1/models` fast after a restart.
   - Keep `exposeUnprefixed: true` (`gpt-6-luna` and `codex/gpt-6-luna` both work).
   - Remove `MODEL_IDS` as the Codex contract. Where code still needs a default list (for example `validateModel`'s default and `/v1/models` without a router), use what the router knows. Remove dead code rather than keeping a stale list.
   - `server.ts`'s fallback `MODEL_IDS.map(...)` for a bridge without `listModels` can go if nothing uses it.
4. **Tests:** update the many tests that use `MODEL_IDS` or `gpt-5.6-sol`. The fake agent's default models can stay as test data, but must not be presented as the real list. Add tests for:
   - Codex models coming from the agent;
   - the unprefixed exposure;
   - the cache.
5. **Docs:** README (the models section and the examples using `gpt-5.6-sol`), `examples/client.js` and `examples/README.md`. Say that the list comes from Codex and depends on the plan and on the codex-acp version.

## Acceptance
- `npm run typecheck`, `npm test` and `npm run build` pass in the worktree.
- With the user's existing Codex login, `/v1/models` lists `gpt-6-luna` (and `codex/gpt-6-luna`), and a chat request to `gpt-6-luna` answers.
- The AAP-12 hardening still holds on codex-acp 2.3.0. The probe evidence is in `spike.md`.

## Status (implementer, 2026-10-27)

- [x] 1. Upgrade: `@agentclientprotocol/codex-acp` is `2.3.0` (exact) in `package.json`, `package-lock.json` updated by `npm install` in this worktree. Entry point and native binary resolution checked (see `spike.md`, "Packaging"); `electron-builder.config.cjs` and `scripts/verify-package.mjs` needed no change. A full `dist:dir` / `verify:package` run was not done.
- [x] 2. Probe 2.3.0: findings in `spike.md`. `gpt-6-luna` is offered; the AAP-12 hardening holds; MCP approval, web search and image shapes are unchanged. No provider code needed to follow a changed shape.
- [x] 3. Runtime discovery: `staticModels` and `MODEL_IDS` dropped for Codex (`src/providers/codex.ts`, `src/config.ts`); `validateModel` without a check accepts any id (`src/api.ts`); `/v1/models` without `listModels` is an empty list (`src/server.ts`).
- [x] 4. Tests: `gpt-5.6-sol` replaced by `gpt-6-luna` across `tests/`; new `tests/codex-models.test.ts` (agent list, unprefixed, cache, first start, list changes).
- [x] 5. Docs: README (models section and examples), `examples/client.js`, `examples/README.md`.

Verification (worktree): `npm run typecheck` pass; `npm test` 20 files passed, 1 skipped (325 tests passed, 1 skipped); `npm run build` pass. Live check with the user's login: see `spike.md`.

### Deviations
- **Router fallback (not in the plan).** With no static list, an unprefixed id such as `gpt-6-luna` would answer 404 until the first discovery finished (first start, no models cache). `ProviderRouter.resolve` now sends an unprefixed id nobody lists to the first `exposeUnprefixed` provider that has no known models yet, mirroring the existing rule for `<provider>/<id>`. Once models are known (discovered or cached) unknown ids are 404 again.
- **`staticModels` mechanism kept.** Production code no longer uses it, but it is a generic descriptor / router option that many tests use for Claude-like fixtures (`staticModels: ["haiku"]`), so it stays.
- **Codex now starts with the proxy.** The controller's start-time model refresh now starts the Codex agent (before, the static list skipped it). `tests/controller.test.ts` accepted `stopped`; it now accepts `starting|ready`, and `tests/tool-calling.test.ts` picks the `session/new` that carries the bridge instead of the first one.
- Fake agent default models stay (`tests/fixtures/fake-acp.mjs`, `tests/proxy.test.ts`, `tests/examples.test.ts`) as test data, with `gpt-5.6-sol` replaced by `gpt-6-luna` and a comment that they are not the real list.