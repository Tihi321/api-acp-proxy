# AAP-19 spike: which agents implement ACP `logout`

Date: 2026-10-27. Tool: `scripts/acp-probe.mjs` with the new flags `--logout` (reads `agentCapabilities.auth.logout` from `initialize`, sends nothing) and `--do-logout` (also sends the `logout` request).

## Safety

- Every agent ran with an **empty temporary home** under `.claude/temp/aap19/homes/` (`CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `GEMINI_HOME`), never with the user's own login folders.
- `logout` was sent to **Codex only** (empty `CODEX_HOME`, no login in it). Claude and Antigravity were only asked what they advertise (`initialize` with `--no-session`).
- Tests use the fake agent only (`FAKE_ACP_LOGOUT=1`).

## Findings

| Agent | Version | `initialize` result | What the agent does on `logout` |
| --- | --- | --- | --- |
| Codex (`@agentclientprotocol/codex-acp` 1.12.0) | 1.12.0 | `agentCapabilities.auth = { "logout": {} }`, also `_meta.authStatus` | Calls Codex's `account/logout` and waits for the account update. Probe against an empty `CODEX_HOME`: answered `{}` in about 270 ms (nothing to remove). |
| Claude (`@agentclientprotocol/claude-agent-acp` 0.91.0) | 0.91.0 | `agentCapabilities.auth = { "logout": {} }`, also `_meta.authStatus` | From the adapter source (`acp-agent.js`, `logout`): clears its in-memory gateway credentials, runs `claude auth logout` itself (non-interactive, idempotent), then re-reads the credential store and pushes `_auth/status_update` (an `ANTHROPIC_API_KEY` from the environment survives, so the new state is not always "none"). Not called. |
| Antigravity (`agy_acp_server.exe`) | 1.3.0 | `agentCapabilities.auth = { "logout": {} }` | Not called (it would sign the user out of Antigravity). |

Result: **all three advertise ACP `logout`**. The plan expected Codex to be unknown; it is not. The descriptor fallbacks are therefore only used for an agent that does not advertise it (an older adapter, a custom `acpCommand`):

- Codex fallback (own home only): stop the agent, delete `<data dir>\codex-home\auth.json`, restart (into needs login, with no `authenticate`). The same deletion also runs after an ACP logout, so the own home surely has no login. With `isolatedHome` off there is no fallback and nothing is deleted.
- Claude fallback: run the bundled `claude auth logout` (hidden, through the same helper as the console login), then restart.
- Antigravity: no fallback (the ACP logout is the only way).

## Live end-to-end check (safe)

The desktop app was started with a temporary settings file (data dir `.claude/temp/aap19/live`, Codex's own home therefore a temporary folder with a fake `{}` `auth.json`). Log out on the Codex row, confirmed in the dialog:

- the app logged `Logging out.`, sent ACP `logout` to codex-acp, and `auth.json` was gone afterwards (the other files stayed),
- the row changed to **needs login**, "Logged out of Codex." was shown, and Log out became disabled.

Claude and Antigravity were run in that app only against empty config folders (they showed needs login); nothing was logged in or out.

## Not verified live (user step)

- Log out of a real Claude, Antigravity and Codex login, and the log-in again afterwards (browser flows).
- That Codex's `account/logout` really deletes `auth.json` in the own home (the proxy deletes it afterwards anyway).
- The Claude `_auth/status_update` push after a real logout, and the account label going away.
