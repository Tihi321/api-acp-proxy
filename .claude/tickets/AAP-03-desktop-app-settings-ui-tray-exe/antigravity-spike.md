# Antigravity ACP server spike (2026-10-14)

Source: `https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.3.0-windows-x86_64.zip`.

## The archive

- **Size:** 124,509,787 bytes.
- **sha256:** `65215e0688681fa3116e048a9eab27ef53af1bbd6f3da3f1c52bd4911d8b17f9`.
- **Contents:** two executables, both Authenticode-valid and signed `CN=Google LLC, O=Google LLC, L=Mountain View, S=California, C=US`:
  - `agy_acp_server.exe` (81 MB). This is the entry point (registry `cmd`).
  - `localharness_external.exe` (146 MB). It is probably spawned by the server, which makes the process-tree kill on stop important.
- **Extracted locally to:** `.claude/temp/agy-acp/` (scratch, not committed).

## Probe results

Probe: a raw newline-delimited JSON-RPC client, no SDK. It sends `initialize` and then `session/new` with an empty temp cwd and does not call `authenticate`.

### Startup

- The server is a PyInstaller-style bundle (Python 3.10). Its stderr is chatty: a `FutureWarning` from google.api_core plus absl `I…` log lines. Log it at debug level or drop the noise.
- `initialize` returned after about 8.4 s on a cold start. Most of that is PyInstaller unpacking.
- Gemini home resolves to `%USERPROFILE%\.gemini`; `$GEMINI_HOME` overrides it.
- The settings file is `<GEMINI_HOME>\antigravity-acp\settings.json` (missing on this machine).

### `initialize` result

- `agentInfo`: `{name:"antigravity-acp", title:"Google Antigravity", version:"1.3.0"}`.
- `agentCapabilities`:
  - `loadSession: true`
  - `promptCapabilities`: image, audio and embeddedContext
  - `mcpCapabilities`: http and sse
  - `sessionCapabilities`: `list` and `resume`. There is **no `delete`**: don't rely on `session/delete`. Call it best effort and ignore errors.
  - `auth`: `logout`
- `authMethods` (ids are exact):

  | id | name |
  |---|---|
  | `oauth-personal` | "Log in with Google" |
  | `oauth-business` | "Log in with Gemini Enterprise" (needs `gcp.project` / `location`) |
  | `gemini-api-key` | "Gemini API key" (needs the `GEMINI_API_KEY` env var) |
  | `agent-platform` | "Gemini Enterprise Agent Platform" (formerly Vertex; `GOOGLE_API_KEY` or ADC plus `GOOGLE_CLOUD_PROJECT` / `GOOGLE_CLOUD_LOCATION`) |

  The error data also names a `gateway` type (`AGY_LLM_GATEWAY_URL`), which is not offered as an auth method.

### `session/new` without auth

It fails immediately (2 ms) with:

```
{ code: -32000, message: "Authentication required",
  data: { message: "No authentication method selected. Either call the `authenticate` method (supports oauth-personal, gemini-api-key, agent-platform), or set `auth.type` in settings.json (...) ..." } }
```

So the server does not remember a chosen auth method between runs unless `auth.type` is set in its `settings.json`. Every process start needs an `authenticate` call. After the first interactive OAuth login, `oauth-personal` should reuse the cached tokens; this still needs checking.

## After an interactive login (oauth-personal, the user's account)

### Login

- **`authenticate {methodId:"oauth-personal"}` does not open a browser.** The server writes this line to stderr and blocks until a loopback redirect to `http://127.0.0.1:<random port>/` completes:

  ```
  Open the following link to authenticate the ACP server: https://accounts.google.com/o/oauth2/v2/auth?...client_id=1071006060591-...&redirect_uri=http%3A%2F%2F127.0.0.1%3A49240%2F&scope=cloud-platform+userinfo.email+aicode...&code_challenge_method=S256
  ```

  The first probe never opened that URL, so `authenticate` was still pending when the probe's 300 s timeout hit. The second probe opened it and `authenticate` returned `{}` after the user logged in.
- **After a successful login the server persists:**
  - `<GEMINI_HOME>/antigravity-acp/acp_token.json` (tokens; not read)
  - `settings.json`, set to `{"auth":{"type":"oauth-personal"}}`
- **On a fresh process start with cached tokens:**
  - `authenticate oauth-personal` returns in 0.9 s.
  - The probe opened a browser tab during this run. **Correction (Phase 4):** the probe's loose `accounts.google.com` regex matched an `AccountChooser?Email=<user email>` link inside a `loadCodeAssist` log line, not the authenticate line, and that link exposes the user's email. The pattern is now anchored to `Open the following link to authenticate the ACP server:`.
  - The provider must not open the URL right away. Open it only if `authenticate` has not resolved after about 3 s, and surface it in the UI or tray and the CLI log.
  - Because `settings.json` now has `auth.type`, a `session/new` without `authenticate` should also work on later starts. Not tested: `session/new` without `authenticate` after a fresh start.

### Session

- `session/new` takes 2.6–2.8 s once authenticated. That is fast, so the ~2 min worry is not real for this account. Cold process start (to `initialize`) is about 8–9 s.
- `modes`:
  - `default`: "Default permission prompt flow"
  - `auto_edit`
  - `yolo`
- **There is no read-only mode.** Use `default`: every tool permission request goes to the client, and we already answer `cancelled`. Never select `auto_edit` or `yolo`. The descriptor's mode candidates are `["read-only","readonly","default"]` with `required: true`. Mode is also exposed as configOption `id:"mode", category:"mode"`.
- The model configOption is `{id:"model", category:"model", type:"select", currentValue, options:[{value,name,description}]}` (flat, not grouped).
  - It is also mirrored in the `models.availableModels[{modelId,name}]` / `currentModelId` field.
  - On this account only `gemini-3.8-flash-high`, `gemini-3.8-flash-medium` and `gemini-3.8-flash-low` are offered. The list is plan-gated, so model ids must come from runtime discovery.
- The server sends `session/update` notifications that we ignore safely:
  - `available_commands_update` (`/plan`, `/logout`)
  - `usage_update` `{used, size}`, which is context-window usage, not token counts

### Prompt and delete

- `session/prompt` with "Reply with exactly: pong" streamed one `agent_message_chunk` "pong" and finished with `stopReason:"end_turn"` in 3.3 s. No `usage` came back in the prompt result.
- `session/delete` returns `-32601 Method not found`.
- The server keeps each session on disk under `<GEMINI_HOME>/antigravity-acp/conversations/<sessionId>.db` (sqlite plus WAL) and `brain/<sessionId>/`. Proxy sessions therefore pile up on disk.
  - Record the session ids the proxy creates (`<dataDir>/antigravity-sessions.json`).
  - On provider stop or the next start, after the process has exited (the sqlite files are locked while it runs), best-effort delete only those ids' `conversations/<id>.db*` and `brain/<id>`.
  - Make this a setting, `purgeSessions`, on by default.

## Consequences for the descriptor

- **Login URL.** Watch the server's stderr for `https://accounts.google.com/...`, store it in the status as `loginUrl`, and open it in the browser only if a user-started Login's `authenticate` is still pending about 3 s later. In headless mode, print it.
- **Auth policy.** Call `authenticate` eagerly at start, but only when a method can be chosen without user interaction:
  1. An explicit `authMethodId` setting wins.
  2. If `GEMINI_API_KEY` or an `apiKey` setting is present, use `gemini-api-key`.
  3. If the user has logged in before, use that method. Record `lastAuthMethodId` after a successful UI or CLI Login; alternatively, check whether the server's own `settings.json` has `auth.type`. With an eager `authenticate` and cached tokens, the call returns in under 1 s, but it must not open the URL (see Login URL).
  4. Otherwise set the state to `needs_login`, and offer the Login button (methods listed from `initialize`).

  Default to `oauth-personal` for the UI Login button.
- **Error mapping.** On `-32000 Authentication required` from `session/new`, set the state to `needs_login` and return 503 `auth_required`.
- **`session/delete`.** Not advertised. Keep the call best-effort, and keep the warm pool small (1) so we don't pile up sessions on the server.
- **Process tree.** The server likely spawns `localharness_external.exe`, so use `taskkill /T` on stop.
- **Installer.** Verify the Authenticode signer `CN=Google LLC` on both exes (status `Valid`). The registry `cmd` is `./agy_acp_server.exe`; extract the whole zip.

- **Process tree, observed.** `agy_acp_server.exe` is a PyInstaller onefile bootloader that starts a second `agy_acp_server.exe`, which in turn starts `localharness_external.exe`. A plain `child.kill()` (TerminateProcess on the bootloader) orphaned the inner server and localharness processes: 4 servers and 2 harnesses were left behind after the probes. `taskkill /T /F` on the bootloader pid is required, and so is a next-start sweep of orphans whose image path matches the install dir.
