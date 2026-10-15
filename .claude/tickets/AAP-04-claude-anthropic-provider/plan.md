# AAP-04: Claude (Anthropic) provider

> Branch: `AAP-04_claude-anthropic-provider` (from `origin/master` @ 1565705). Plan path: `.claude/tickets/AAP-04-claude-anthropic-provider/plan.md`.

## Context

The proxy exposes an OpenAI-compatible API in front of ACP agents. It supports Codex (`@agentclientprotocol/codex-acp`, bundled) and Google Antigravity (`agy_acp_server`). The user wants Claude as a third backend, so a Claude subscription or Anthropic key can serve `/v1/chat/completions` the same way.

Decisions already made with the user:
- **Auth:** reuse the existing Claude Code credentials automatically. Add optional API key and OAuth token fields. A **Log in** button opens a console window that runs `claude auth login`.
- **Terms:** enabling the provider requires an acknowledgment dialog, the same as Antigravity (`termsAcknowledgedAt`, with an env override).

### Facts verified in `@agentclientprotocol/claude-agent-acp@0.91.0` (the dist was read)
- Entry: `dist/index.js`. It spawns the native `claude` binary from the optional dependency `@anthropic-ai/claude-agent-sdk-win32-x64`. `CLAUDE_CODE_EXECUTABLE` overrides the binary. `node dist/index.js --cli <args>` runs that CLI directly, so `--cli auth login --claudeai|--console` performs the login.
- `authMethods` lists only terminal methods (`claude-ai-login`, `console-login`), and only when the client declares terminal-auth capability. `authenticate` throws for every method except the gateway ones. In practice, credentials come from `~/.claude` (`CLAUDE_CONFIG_DIR`), `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`.
- When the user is not logged in, the error shows up as JSON-RPC `-32000` on **`session/prompt`** (not on `session/new`). The adapter also pushes the notification `_auth/status_update` → `{ authStatus: { kind, label } }`, with `kind: "none"` meaning logged out. It sends this after `initialize` and at the start of each prompt.
- Modes are `default` (Manual: always asks), `acceptEdits`, `plan`, `auto` and `bypassPermissions`. There is no read-only mode.
- `session/new` `_meta.claudeCode.options` is spread into the SDK options. `tools: []` disables the built-in tools; `persistSession` and `settingSources` can be overridden there too.
- Models come from a `model` select config option (category `model`), which the existing `createSession` discovery already handles.
- Its `@agentclientprotocol/sdk@1.8.0` is a nested dependency, so ours (`^1.4.0`) stays.

## Approach

### 1. Generic `AcpProvider` / `ProviderDescriptor` extensions (`src/provider.ts`, `src/acp-provider.ts`)
- `ProviderDescriptor.sessionMeta?: Record<string, unknown>`: sent as `_meta` on `session/new` in `createSession`.
- `ProviderDescriptor.loginMethods?: AuthMethodInfo[]`: shown in `status().authMethods` when the agent advertises none.
- `ProviderDescriptor.externalLogin?(ctx, methodId): Promise<void>`: when present, `login()` calls it instead of ACP `authenticate`. It keeps the `userLogins` / `loginTimeoutMs` handling. On success it restarts the agent (`stop()` then `connect()`), so the new `initialize` runs a fresh auth probe and warm sessions are dropped. On failure it calls `blockAuth` and throws `ProviderAuthRequiredError`.
- `generate()`: when `setConfigOption` or `session/prompt` fails with `-32000` (reuse `isAuthRequired`), set the state to `needs_login` and throw `ProviderAuthRequiredError`. That already maps to 503 `provider_auth_required` in `src/server.ts:151`. This also helps the other providers.
- Register `app.onNotification("_auth/status_update", parser, handler)` in `doStart`. It is harmless for agents that never send it. `kind === "none"` → `setState("needs_login", "Not logged in.")`. Any other kind → store `account = label` and, if the state is `needs_login` and no auth is in flight, `setState("ready")`.
- `ProviderStatus.account?: string`, included in `status()`.

### 2. New `src/providers/claude.ts` (modeled on `codex.ts` / `antigravity.ts`)
`claudeDescriptor(settings, env, overrides?)` and `claudeRegistration`:
- `id: "claude"`, `displayName: "Claude"`, `ownedBy: "anthropic"`, `exposeUnprefixed: false` (ids look like `claude/sonnet`, so values such as `default` never collide), `authMode: "on-demand"`, `chooseAuth: () => undefined`, `readOnlyMode: "required"`, `modeCandidates: ["default"]`, `sessionTimeoutMs: 120_000`, `warmSessions: 1`, `stderrLogLevel: "debug"`.
- `sessionMeta`: `{ disableBuiltInTools: true, claudeCode: { options: { tools: [], persistSession: false, settingSources: [] } } }`. This makes it text-only and writes no transcripts to `~/.claude/projects`. The user's hooks, MCP servers and CLAUDE.md do not run for proxy requests.
- `preflight`: returns `terms_required` unless `termsAcknowledgedAt` is set or `PROXY_CLAUDE_ACCEPT_TERMS` is truthy (copy the `truthy` helper pattern from `antigravity.ts`).
- `launch`: resolve the entry the same way as `codex.ts` (`createRequire(import.meta.url).resolve("@agentclientprotocol/claude-agent-acp/dist/index.js")` → `ctx.resolveUnpacked`), and run it with `ctx.nodeRuntime` (command + argsPrefix + env). Env setup:
  - Map `apiKey` → `ANTHROPIC_API_KEY`, `oauthToken` → `CLAUDE_CODE_OAUTH_TOKEN`, `configDir` → `CLAUDE_CONFIG_DIR` and `executablePath` → `CLAUDE_CODE_EXECUTABLE`.
  - Delete `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT` and `NODE_OPTIONS`, so the agent does not refuse to start as a nested session when the proxy is run from inside Claude Code.
- `loginMethods`: `claude-ai-login` ("Claude subscription") and `console-login` ("Anthropic Console (API billing)").
- `externalLogin(ctx, methodId)`:
  - On Windows, spawn `cmd.exe /d /s /c start "Claude login" /wait "<node cmd>" "<entry>" --cli auth login --claudeai|--console`. Use the same env as `launch`, but **without** the `hide-windows.cjs` argsPrefix, and set `windowsVerbatimArguments: true` with explicit quoting, because the install path may contain spaces. Reject on a non-zero exit code.
  - On other platforms, throw `AcpUnavailableError` with the command to run manually.
  - Can be overridden for tests.
- `mapError`: none for now.

### 3. Settings (`src/settings.ts`)
- Add a `providers.claude` schema: `enabled` (default `false`), `apiKey?`, `oauthToken?`, `configDir?`, `executablePath?`, `authMethodId?`, `termsAcknowledgedAt?`.
- `mapSecrets`: encrypt `providers.claude.apiKey` and `providers.claude.oauthToken`. Generalize the holder loop to a list of `[object, key]` pairs.
- `resolveConfig` env overrides: `PROXY_CLAUDE_ENABLED`, `PROXY_CLAUDE_ACCEPT_TERMS` (same pattern as Antigravity) and `PROXY_CLAUDE_EXECUTABLE`.

### 4. Wiring
- `src/controller.ts`: add `claudeRegistration` to the default registry.
- `src/electron/main.ts`: add `claudeRegistration` to the registry. Replace the `proxy:acknowledgeAntigravityTerms` handler with `proxy:acknowledgeTerms(providerId)`, which accepts only `antigravity` and `claude`. Add `https://www.anthropic.com/legal/consumer-terms` to the `openExternal` allowlist.
- `src/electron/preload.cts` and `src/shared/ipc.ts`: add the `claude` settings view and patch types, `ProviderStatusView.account`, and `acknowledgeTerms(providerId)`.

### 5. Settings UI (`src/renderer/settings.html`, `settings.ts`)
- New `card-claude`, following the Antigravity card markup:
  - enabled switch, sign-in method select with a **Log in** button, and an account label (`status.account`);
  - a one-line risk note;
  - a "Credentials and data" fieldset: API key (Show button), OAuth token (Show button), config dir, executable path;
  - models list and Save.
- `settings.ts`:
  - add the `claude` scope, field specs, `fallbackAuth.claude`, `defaultAuth.claude = "claude-ai-login"`, `dirty.claude`, and add `"claude"` to the `renderProvider` loop;
  - generalize `ensureTerms(provider)` so the dialog's title, body and terms link come from a per-provider map (Antigravity text unchanged; the Claude text says that using a Claude subscription through third-party tooling may conflict with Anthropic's terms, at your own risk).
- The Log in button already calls `api.login("claude", method)`. While the console window is open, show "Complete the login in the console window…".

### 6. Packaging
- `electron-builder.config.cjs`: compute `runtimeClosure` for both `@agentclientprotocol/codex-acp` and `@agentclientprotocol/claude-agent-acp`, and add `node_modules/@anthropic-ai/**` to `asarUnpack` (the native `claude.exe` lives there).
- `scripts/verify-package.mjs`:
  - check that the claude-agent-acp entry is unpacked;
  - check that `@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe` resolves from the unpacked tree and that `--version` works;
  - run an `initialize` handshake for Claude too (factor the existing handshake into a function).
- `package.json`: add the dependency `"@agentclientprotocol/claude-agent-acp": "0.91.0"` (pinned exactly, because the adapter changes quickly) and update the description.

### 7. Docs
- `README.md`:
  - add Claude to the provider list;
  - add a "Claude" section: no install needed (bundled); credential sources and their precedence; Log in button / `claude auth login`; model ids `claude/<id>`; tools disabled and no transcripts persisted; `settingSources: []` means `apiKeyHelper` and `env` from `~/.claude/settings.json` are ignored;
  - add env vars and settings keys;
  - add a terms/risk note.

### 8. Tests (vitest; extend `tests/fixtures/fake-acp.mjs`)
- New fixture knobs:
  - `FAKE_ACP_CLAUDE=1`: Claude modes (`default`, `acceptEdits`, `plan`, `auto`, `bypassPermissions`) and no `authMethods`;
  - `FAKE_ACP_PROMPT_AUTH=1`: `session/prompt` fails with `-32000`;
  - `FAKE_ACP_AUTH_STATUS=<kind>`: send `_auth/status_update` after `initialize`.
  - `FAKE_ACP_LOG` already records params, which lets the tests assert `_meta`.
- New `tests/claude.test.ts` (patterns from `tests/antigravity.test.ts`):
  - the launch env mapping, with `CLAUDECODE` stripped;
  - the terms preflight;
  - `session/new` carries `_meta.claudeCode.options.tools = []`, and mode `default` is set;
  - prompt `-32000` → 503 `provider_auth_required` and state `needs_login`;
  - status `kind: "none"` → `needs_login`, a subscription kind → `ready` with `account`;
  - `login()` calls an injected `externalLogin` and restarts the agent.
- `tests/settings.test.ts`: Claude defaults, secret encoding of `apiKey` / `oauthToken`, env overrides.
- `tests/controller.test.ts`: Claude is registered and disabled by default.

## Verification
1. `npm run typecheck`, `npm test`, `npm run build`.
2. Live headless run with an existing Claude Code login (PowerShell): `$env:PROXY_CLAUDE_ENABLED=1; $env:PROXY_CLAUDE_ACCEPT_TERMS=1; npm run dev`.
   - `curl http://127.0.0.1:8787/v1/models` lists `claude/*`.
   - Non-streaming and streaming `chat/completions` with `claude/sonnet` (or the first discovered id) return text.
   - `~/.claude/projects` gains no new `request-*` directories, which confirms `persistSession: false`. If it does gain them, fall back to purging `<configDir>/projects/<sanitized cwd>` in session disposal.
3. Not logged in: set `CLAUDE_CONFIG_DIR` to an empty directory. The provider shows `needs_login` and requests get 503.
4. `npm run app:dev`: enable Claude → the terms dialog appears; Log in opens a console running `claude auth login`; after finishing, the badge turns ready and shows the account; models populate.
5. `npm run dist:dir` then `npm run verify:package`: both the Codex and Claude handshakes pass, and `claude.exe` resolves unpacked.

## Progress

Sections 1, 2, 3, 4 (controller.ts), 6 (package.json), 7, 8 done by implementer A. Sections 4 (electron/ipc), 5, 6 (builder/verify script) belong to the other implementer.

- [x] 1. `provider.ts` / `acp-provider.ts`: `sessionMeta`, `loginMethods`, `externalLogin`, `onSessionDisposed` (new), `ProviderStatus.account`, `_auth/status_update` subscription, -32000 on setConfigOption/prompt -> `needs_login` + `ProviderAuthRequiredError`.
- [x] 2. `src/providers/claude.ts` (`claudeDescriptor`, `claudeRegistration`), Windows login via `cmd.exe /d /s /c "start ... /wait ..."` with verbatim args (not launched in tests; the string is built but only exercised by the real flow).
- [x] 3. `settings.ts`: `providers.claude`, secrets (apiKey, oauthToken), env overrides.
- [x] 4. `controller.ts` registers `claudeRegistration`.
- [x] 6. `package.json`: `@agentclientprotocol/claude-agent-acp` 0.91.0 exact, description updated; lockfile updated.
- [x] 7. README Claude section, env vars, terms.
- [x] 8. Tests: `tests/claude.test.ts` (new), fixture knobs (FAKE_ACP_CLAUDE / PROMPT_AUTH / AUTH_STATUS), settings and controller tests.

Verification: `npm run typecheck` pass, `npm test` 12 files passed / 1 skipped (110 tests pass, 1 skipped), `npm run build` pass.
Live smoke (existing Claude Code login): `/v1/models` listed 13 `claude/*` ids; non-streaming and streaming `claude/haiku` completions returned "pong".

Deviations:
- Live smoke showed `persistSession:false` still leaves an empty `<config>/projects/<sanitized cwd>/memory` directory per session (no transcripts). Added `ProviderDescriptor.onSessionDisposed(cwd)` and a Claude implementation that rmdirs these (never non-empty dirs). The warm session's directory remains until its session is disposed (a hard kill of the proxy leaves one).
- `externalLogin` failure sets `needs_login` without `authBlock`, so a user who is already logged in elsewhere is not locked out.
- Claude-state tracking uses a `loggedOut` flag so doStart/createSession do not overwrite `needs_login` pushed by `_auth/status_update`.
- Not verified: the real Windows login window (`Log in` flow) and the not-logged-in live scenario (empty CLAUDE_CONFIG_DIR).

### Follow-up (login fix and README)
- [x] `consoleLogin` now starts the native console `claude` binary directly (`resolveClaudeBinary`: `executablePath`, else the SDK platform package resolved like the adapter / `verify-package.mjs`), with `ELECTRON_RUN_AS_NODE` removed; falls back to `<node> <entry> --cli` if unresolvable. Non-Windows message suggests `"<claude>" auth login <flag>`.
- [x] Unit test for binary resolution added. `npm run typecheck`, `npm test` (111 passed, 1 skipped), `npm run build` pass.
- [x] Safe live check: resolved `claude.exe` runs `auth status --json` -> `{loggedIn, authMethod, apiProvider, analyticsDisabled, projectsDirectory, configDirectory, email, orgId, orgName, subscriptionType}`.
- [x] README: removed the unverified credential precedence and the unverified Anthropic-restriction claim; documented the new login launch and leftover-directory cleanup.
- Not verified: the visible login window itself.

### Implementer B (electron / UI / packaging)
- [x] 4. `main.ts` registry + `proxy:acknowledgeTerms(providerId)` + Anthropic terms URL allowlist; `preload.cts` / `ipc.ts` types (`claude` settings, `account`, `acknowledgeTerms`).
- [x] 5. Claude card in `settings.html`, `settings.ts` scope/fields/terms map (textContent only), terms gate on toggle and save.
- [x] 6. `electron-builder.config.cjs` closure for both adapters + `@anthropic-ai/**` unpack; `verify-package.mjs` Claude entry, `claude.exe --version`, and handshake.
- Verification: typecheck/build pass; `npm run dist:dir` + `npm run verify:package` pass (claude.exe 2.1.300 unpacked, claude-agent-acp 0.91.0 handshake). Interactive UI QA not run.

Final orchestrator re-run (2026-10-15): typecheck pass, `npm test` 111 passed / 1 skipped, build pass. Changelog: `changelog.md`.
