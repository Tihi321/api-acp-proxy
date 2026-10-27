# AAP-20 changelog

## 2026-10-27: rebased onto master after AAP-19 (PR #14)

- **`src/server.ts`, conflict resolved:** kept AAP-19's activity tracking and the `hasImages` import, and AAP-20's removal of `MODEL_IDS`. `/v1/models` returns `[]` for a bridge without `listModels`.
- **`src/acp-provider.ts`, AAP-19 and AAP-20 together:** `listModels()` no longer starts an agent that is stopped and certainly has no login (`needsLogin`, e.g. Codex's own home without `auth.json`).
  - Without this, Codex started at launch only to find no login, and AAP-19's "needs login without starting anything" no longer held.
  - Codex with a login still starts with the proxy and lists its models.
  - Without a login, an unprefixed id still reaches Codex, which answers 503 `provider_auth_required` and opens no browser.
- **`tests/controller.test.ts`:**
  - The conflict is resolved.
  - `make()` has a `signedIn` option that writes `codex-home/auth.json`. "Starts, serves requests and stops" uses it.
  - Without a login, Codex is `needs_login`.
  - AAP-19's new tests use `gpt-6-luna`.
- **`tests/codex-models.test.ts`:** the Codex helper writes `auth.json`, so these tests run a signed-in Codex.
- **`tests/logout.test.ts`:** `gpt-5.6-sol` becomes `gpt-6-luna`.
- **Verification** after the rebase:
  - `npm run typecheck` passed.
  - `npx vitest run --dir tests`: 23 files passed and 1 skipped; 360 tests passed and 1 skipped.
  - `npm run build` passed.
- **Deviation 3 below** ("Codex now starts with the proxy") now applies only to a signed-in Codex.

## 2026-10-27: Codex models come from the agent; codex-acp 2.3.0

The proxy no longer has a hardcoded list of Codex models; it gets them from the agent. `/v1/models` now lists `gpt-6-luna`, `gpt-5.6-terra` and `gpt-5.6-luna`, both unprefixed and as `codex/...`. `gpt-5.6-sol` is gone. The bundled Codex agent is upgraded from 1.12.0 to 2.3.0, which bundles Codex 0.164.0.

**Repository:** api-acp-proxy. **Branch:** `AAP-20_codex-models`, cut from `master` `82644df`. **Worktree:** `.claude/temp/wt-aap20`.

### Files changed

**Dependencies**
- `package.json`: `@agentclientprotocol/codex-acp` is pinned to `2.3.0` (exact, was `^1.12.0`).
- `package-lock.json`: regenerated. codex-acp 2.3.0 brings its own nested `@agentclientprotocol/sdk` 2.x and `zod` 4. `electron-builder.config.cjs` picks them up without changes.

**Source**
- `src/config.ts`: removed `MODEL_IDS`.
- `src/providers/codex.ts`: removed `staticModels`. Codex models now come from the agent's `model` option in `session/new`, as for Claude and Antigravity. They are still exposed unprefixed.
- `src/router.ts`: an unprefixed id that no provider lists now goes to the first unprefixed provider that has not discovered models yet. This covers a first start with no models cache. Once models are known or cached, an unknown id gets 404 again.
- `src/api.ts`: `validateModel` has no default list. Without a model check, any id is accepted and the agent decides.
- `src/server.ts`: `/v1/models` returns `[]` for a bridge without `listModels`, instead of the old fixed list.

**Docs**
- `README.md`, `examples/client.js` and `examples/README.md`:
  - The default and example model is now `gpt-6-luna`.
  - They say the list comes from Codex and depends on the ChatGPT plan and the codex-acp version.

**Tests**
- New `tests/codex-models.test.ts`. It covers:
  - models supplied by the agent;
  - unprefixed exposure;
  - routing and 404s;
  - list changes;
  - a first start with no cache;
  - the models cache.
- `gpt-5.6-sol` is replaced by `gpt-6-luna` in the other test files.
- The fixture model lists are marked as test data.
- The fake bridges got `listModels`.
- `controller`, `image-generation` and `tool-calling` tests are adapted because Codex now starts with the proxy (see Deviations).

**Ticket notes**
- `spike.md` (new): the codex-acp 2.3.0 probe findings.
- `plan.md`: a status checklist and the deviations.

### codex-acp 2.3.0 probe results
- **Capabilities:**
  - `auth.logout` is still advertised.
  - Image input is supported.
  - MCP is http only (no sse).
  - The auth methods are `api-key` and `chat-gpt`.
- **Models** with the user's ChatGPT Go login: `gpt-6-luna`, `gpt-5.6-terra` and `gpt-5.6-luna`. This matches the Codex app.
- **Read-only mode:** the `read-only` mode id still exists.
- **AAP-12 hardening still holds:**
  - The config keys are accepted.
  - A shell request gets no tool call and no permission request.
  - No "Skill descriptions were shortened" text appears.
- **Earlier features keep their shapes, so no code changes were needed:**
  - AAP-15 MCP approval.
  - AAP-17 web search.
  - AAP-14 image tool (it adds `rawOutput.savedPath`, which `takeImages` already reads).
- **New in 2.3.0:** after `authenticate` the agent sends `_auth/status_update` with the account label and plan. The proxy does not use it yet, but AAP-19's `onAuthStatus` handles this push, so the Codex account should appear once both branches are together.

### Deviations from the plan
1. **Router fallback (not planned).** Without it, an unprefixed `gpt-6-luna` gave 404 on a first start until discovery finished. Side effect: until Codex has listed models, an unprefixed typo goes to Codex instead of getting 404. That includes the case where Codex needs login.
2. **`staticModels` kept as an option.** Production code no longer uses it, but many tests use it for Claude-style fixtures.
3. **Codex now starts with the proxy.** The model refresh at start now starts the Codex agent, as it already did for Claude and Antigravity.
   - Codex's own home without a login does not open a browser, because `loginRequired` still guards it.
   - When Codex uses the user's `~/.codex` and it has no login, the sign-in now starts when the proxy starts rather than on the first request.

### Verification
- **Implementer runs:**
  - `npm run typecheck` passed.
  - `npm test`: 20 files passed and 1 skipped; 325 tests passed and 1 skipped.
  - `npm run build` passed.
- **Orchestrator re-run in the worktree:** `npm run typecheck`, `npx vitest run --dir tests` and `npm run build`, with the same results.
- **Live check:**
  - Setup: the user's `~/.codex` login (`PROXY_CODEX_ISOLATED_HOME=0`), a temporary settings file and port 18790.
  - `gpt-6-luna` answered in 5.3 s, sent before discovery had finished.
  - `/v1/models` listed all three models, unprefixed and as `codex/...`.
  - `codex/gpt-6-luna` answered, `gpt-5.6-sol` returned 404, and `models-cache.json` was written.
- **Not run:**
  - `npm run dist:dir` and `verify:package` (a full electron-builder package). Packaging was only checked by resolving the native binary and loading the builder config.
  - The Codex own-home path with a real login. It is still waiting for the user's Codex login.

### Follow-ups
- **Merging with AAP-19:**
  - Expect small conflicts in `src/server.ts` (the `MODEL_IDS` import and the `/v1/models` line next to AAP-19's activity tracking) and maybe in `src/providers/codex.ts`'s import block.
  - AAP-19's Codex card says "Starts on the first request". That text is stale once Codex starts with the proxy.
- **Packaging:** run `npm run dist:dir` and `verify:package` before the next release.

### Commit status
Uncommitted, on `AAP-20_codex-models` in the worktree `.claude/temp/wt-aap20`.
