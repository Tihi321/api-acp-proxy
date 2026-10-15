# AAP-04 changelog

## 2026-10-15 — AAP-04: Claude (Anthropic) provider

Summary: added a third backend, `claude`, built on the bundled `@agentclientprotocol/claude-agent-acp@0.91.0`. It is text-only and sits behind a terms gate. The Log in button opens a console window. It has settings and a UI card, and it is packaged and verified.

**Repository:** api-acp-proxy. **Branch:** `AAP-04_claude-anthropic-provider`, cut from `origin/master` at 1565705.

### Files changed
- `package.json`, `package-lock.json`: new dependency `@agentclientprotocol/claude-agent-acp` pinned at `0.91.0`; the description now mentions Claude.
- `src/provider.ts`:
  - New descriptor hooks: `sessionMeta`, `loginMethods`, `externalLogin(ctx, methodId)` and `onSessionDisposed(cwd)`.
  - New field `ProviderStatus.account`.
- `src/acp-provider.ts`:
  - `sessionMeta` is sent as `_meta` on `session/new`.
  - `loginMethods` are used when the agent advertises no auth methods.
  - Subscribes to `_auth/status_update`: kind `none` → `needs_login`; any other kind → `account` label, and the provider goes back to `ready`.
  - `login()` runs `externalLogin` under the login timeout, then restarts the agent.
  - A -32000 response from `setConfigOption` or `session/prompt` now sets `needs_login` and throws `ProviderAuthRequiredError`, which becomes a 503 `provider_auth_required`. This applies to every provider.
  - `onSessionDisposed` is called after a session is disposed.
- `src/providers/claude.ts` (new):
  - Descriptor and registration: id `claude`, prefixed ids only, mode `default`.
  - `_meta` sets `tools: []`, `persistSession: false` and `settingSources: []`.
  - Terms preflight; `PROXY_CLAUDE_ACCEPT_TERMS` also satisfies it.
  - Env mapping: `apiKey`/`oauthToken`/`configDir`/`executablePath` → `ANTHROPIC_API_KEY`/`CLAUDE_CODE_OAUTH_TOKEN`/`CLAUDE_CONFIG_DIR`/`CLAUDE_CODE_EXECUTABLE`. `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT` and `NODE_OPTIONS` are removed.
  - `resolveClaudeBinary` finds the native `claude.exe`.
  - The Windows console login runs `cmd /d /s /c "start "Claude login" /wait "<claude.exe>" auth login --claudeai|--console"`. It falls back to `<node> <entry> --cli` when the binary cannot be resolved.
  - After each session, the empty `<config>/projects/<cwd>[/memory]` directories the CLI leaves behind are removed.
- `src/settings.ts`:
  - New `providers.claude` schema; `enabled` defaults to `false`.
  - `apiKey` and `oauthToken` are encrypted at rest. The secret mapping was generalised to `[holder, key]` pairs.
  - Env overrides: `PROXY_CLAUDE_ENABLED`, `PROXY_CLAUDE_ACCEPT_TERMS`, `PROXY_CLAUDE_EXECUTABLE`.
- `src/controller.ts`, `src/electron/main.ts`: `claudeRegistration` is added to the registries.
- `src/electron/main.ts`:
  - The IPC call `proxy:acknowledgeAntigravityTerms` is replaced by `proxy:acknowledgeTerms(providerId)`, which accepts only `antigravity` or `claude`.
  - The `openExternal` allowlist adds `https://www.anthropic.com/legal/consumer-terms`.
  - The executable picker title is now generic.
- `src/electron/preload.cts`, `src/shared/ipc.ts`:
  - Added the `claude` settings view and patch types.
  - Added `ProviderStatusView.account`.
  - Added `acknowledgeTerms(providerId)`.
- `src/renderer/settings.html`, `src/renderer/settings.ts`:
  - New Claude card: enable, sign-in method and Log in, a "Signed in as …" line, a risk note, API key, OAuth token, config dir, executable path with Browse, and models.
  - The terms dialog is now per provider. Its content is filled with `textContent`; the Antigravity text is unchanged.
  - Enabling Claude, or saving with it enabled, requires accepting the terms.
- `electron-builder.config.cjs`:
  - The asarUnpack closure now covers both codex-acp and claude-agent-acp.
  - `node_modules/@anthropic-ai/**` is unpacked.
- `scripts/verify-package.mjs`:
  - The handshake was moved into a function, and it now also runs for claude-agent-acp.
  - Checks that `claude.exe` resolves from the unpacked tree and that `--version` works.
- `tests/fixtures/fake-acp.mjs`: new knobs `FAKE_ACP_CLAUDE`, `FAKE_ACP_PROMPT_AUTH` and `FAKE_ACP_AUTH_STATUS`.
- `tests/claude.test.ts` (new): env mapping, terms, session `_meta`/mode, prompt auth_required → 503, auth-status transitions, external login success/failure/timeout, leftover cleanup, and binary resolution.
- `tests/settings.test.ts`, `tests/controller.test.ts`: Claude defaults, secrets, env overrides, and registration disabled by default.
- `README.md`: Claude in the provider list and model ids, env vars, a Claude section and a risk note.

### Deviations from the plan
- **Extra hook `onSessionDisposed`:** `persistSession: false` keeps transcripts out, but the CLI still creates an empty `~/.claude/projects/<cwd>/memory` directory per session. The hook deletes it non-recursively, so only empty directories are removed. One directory can remain while a warm session is alive, or after a hard kill.
- **Login launch:** Login launches the native `claude.exe` directly instead of `<ACP Proxy.exe> <entry> --cli`. ACP Proxy.exe is a GUI-subsystem exe and would not get a console window, so it was changed during review.
- **verify-package resolution:** the script resolves the SDK from its entry, because its `package.json` is not exported. It handles both the nested dev layout and the flat packaged layout.

### Verification
- `npm run typecheck`: passed. Re-run by the orchestrator after the final changes.
- `npm test`: 111 passed, 1 skipped (`live.smoke`). Re-run by the orchestrator.
- `npm run build`: passed. Re-run by the orchestrator.
- `npm run dist:dir` + `npm run verify:package`: passed (implementer run, before the login-launch change, which does not affect packaging). Codex 0.154.0 resolves. `claude.exe` `2.1.300 (Claude Code)` resolves from `app.asar.unpacked`. Both ACP handshakes succeed: codex-acp 1.12.0 and claude-agent-acp 0.91.0.
- Live headless smoke with an existing Claude Code login:
  - `/v1/models` listed 13 `claude/*` ids.
  - Non-streaming and streaming `claude/haiku` completions returned text.
  - No project directories accumulated after the cleanup hook was added.
- The resolved `claude.exe auth status --json` returned `loggedIn: true`, `authMethod: "claude.ai"`.

**Not run:**
- The real Log in console window (it opens a browser OAuth flow).
- The live not-logged-in scenario. It is covered by fake-agent tests only.
- Interactive QA of the Electron UI (Claude card, terms dialog).

### Follow-ups / known limitations
- `settingSources: []` means `apiKeyHelper` and `env` from `~/.claude/settings.json` are ignored. Use the API key or OAuth token fields instead.
- OpenAI `reasoning_effort` is not yet mapped to the adapter's `effort` config option.
- Off Windows there is no login button; the user has to run `claude auth login` manually.
- The adapter is pinned exactly at 0.91.0, so upgrades are manual.

### Commit status
Committed as 737f031 on `AAP-04_claude-anthropic-provider` (not pushed).
