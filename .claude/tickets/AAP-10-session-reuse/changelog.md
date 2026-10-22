# AAP-10 changelog

## 2026-10-22 — AAP-10: session reuse across conversation turns

Summary: a new opt-in option, `server.reuseSessions` (env `PROXY_REUSE_SESSIONS`, a checkbox in the settings window). When it is on, an agent session is kept after a turn that ended normally. A later request that extends the same conversation continues that session and sends the agent only the new messages. With the option off, nothing changes.

**Repository:** api-acp-proxy. **Branch:** `AAP-10_session-reuse`, stacked on `AAP-09_token-limit` (28684c4).

### Files changed
- `src/acp-provider.ts`:
  - New options `reuseSessions`, `retainedSessions` (default 8) and `retainedIdleMs` (default 10 min).
  - A pool of kept sessions (`keep` / `takeKept` / `dropKept`).
  - Matching: same model and agent process. The request's messages up to the last assistant message must equal the kept transcript: same roles, equal non-assistant content, and each client assistant content (trimmed, non-empty) contained in the raw answer. At least one new message must follow.
  - An entry is removed from the pool while it is in use.
  - On reuse, `generate()` skips session creation, model selection and mode selection, and prompts with `serializePrompt(newMessages, instructions)`.
  - A session is kept only after `end_turn` with no abort, so turns cut by the AAP-09 token limit or cancelled are disposed.
  - When the pool is full the oldest session is evicted. An idle timer (unref'd) disposes kept sessions, as do `stop()` and an agent exit.
  - Cumulative agent usage is turned into a per-turn delta.
- `src/provider.ts`: `ProviderDescriptor.usageScope?: "turn" | "session"`.
- `src/providers/claude.ts`: `usageScope: "session"`, because claude-agent-acp reports cumulative usage. It also passes `reuseSessions`.
- `src/providers/codex.ts`, `src/providers/antigravity.ts`: pass `reuseSessions`.
- `src/config.ts`, `src/settings.ts`: `reuseSessions` and `PROXY_REUSE_SESSIONS`. The stale `ignoreSampling` comments no longer mention length fields (left over from AAP-09).
- `src/renderer/settings.html`, `src/renderer/settings.ts`: the checkbox.
- `README.md`: an env row and a "Session reuse" paragraph. The "fresh session" sentence is qualified.
- `tests/fixtures/fake-acp.mjs`: `FAKE_ACP_CUMULATIVE=1` reports cumulative per-session usage.
- `tests/acp-provider.test.ts`: 10 new session-reuse tests:
  - reuse off;
  - only new messages sent, with instructions;
  - a mismatch on history, model or new messages;
  - a substring match;
  - concurrent requests;
  - a cancelled turn;
  - the idle timeout;
  - the cap;
  - `close()`;
  - the usage delta.
- `tests/settings.test.ts`: `PROXY_REUSE_SESSIONS=1`.

### Deviations
- `src/shared/ipc.ts` and `src/electron/*` did not need changes. The server settings flow through generically, as `ignoreSampling` does.
- The orchestrator re-indented the `if (!reused)` block in `generate()` after review.

### Verified
- `npm run typecheck` clean.
- `npx vitest run`: 147 passed, 1 skipped.
- `npm run build` succeeded.

### Not verified
- A real multi-turn conversation through Codex or Claude with reuse on. This needs a logged-in provider.
- The checkbox in the packaged desktop app.

### Known limitations
- The agent's context holds its raw answer. If a client edits an assistant message so that it is no longer part of that answer, the request does not match, so it falls back to a fresh session. Matching never produces a wrong reuse.
- A kept session holds agent memory and a temp directory for up to 10 minutes. There are at most 8 per provider.

### Commit status
Committed on `AAP-10_session-reuse` (local, not pushed).
