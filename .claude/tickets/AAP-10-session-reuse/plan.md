# AAP-10: Reuse agent sessions across conversation turns

> Branch: `AAP-10_session-reuse`, cut from `AAP-09_token-limit` (stacked). Roadmap item: "Each request is a fresh agent session."

## Goal

OpenAI clients resend the whole conversation on every turn. Today each request creates a new ACP session and the full history is serialized into one prompt again. With the new option, a session is kept after a successful turn and the next request of the same conversation continues in it, sending only the new messages. That is faster, keeps the agent's own context and prompt cache, and costs fewer input tokens.

Opt-in: `server.reuseSessions` (default `false`), env `PROXY_REUSE_SESSIONS`, a settings checkbox. With it off, behaviour is unchanged.

## Matching rule

A request with messages `M` continues a kept session when:
- the model is the same;
- `M` has an assistant message, with last assistant index `i`, and `M[i+1..]` is not empty;
- the kept session's transcript `T` (the client-visible messages it was prompted with, plus each answer as an assistant message holding the agent's raw text) has `T.length === i + 1`, the same role at each position, equal content for every non-assistant message, and for every assistant message the client's content (trimmed, non-empty) is contained in the raw answer. This allows for AAP-07 `extractJson` (a substring of the raw answer).

The `GenerateOptions.instructions` (AAP-07) are not part of the transcript; each turn's prompt carries its own.

## Steps

1. **`src/provider.ts`**: `ProviderDescriptor.usageScope?: "turn" | "session"` (default `"turn"`): whether the agent's `PromptResponse.usage` covers only the last turn or the whole session. **`src/providers/claude.ts`**: `usageScope: "session"` (claude-agent-acp `sessionUsage` is cumulative; codex-acp reports the last turn).
2. **`src/acp-provider.ts`**:
   - `AcpProviderOptions` gains `reuseSessions?: boolean`, `retainedSessions?: number` (default 8) and `retainedIdleMs?: number` (default 10 min).
   - Kept sessions: `{ session: PreparedSession, model, transcript: TextMessage[], usage?: Usage, timer }`. Lookup with the matching rule, which removes the entry while it is in use (a concurrent request with the same history gets a fresh session). The pool is capped (evict and dispose the oldest), and an idle timer (`unref`) disposes an entry after `retainedIdleMs`. `stop()` and an agent exit (`generation++`) dispose all of them, like `dropWarm`.
   - `generate()`: with a match, skip session creation, `setConfigOption` and `setMode` (already done) and prompt with `serializePrompt(M.slice(i + 1), instructions)`. Without a match, the current path.
   - After a turn that ended with `stopReason === "end_turn"`, not aborted and reuse on: keep the session (transcript = messages + `{ role: "assistant", content: text }`) instead of disposing it. Every other outcome disposes it as today (cancelled, max-tokens cut, errors).
   - Usage with `usageScope: "session"`: report this turn's delta (current minus the usage stored with the kept session, field by field, never below 0) and store the cumulative value.
   - A prompt on a kept session that fails (e.g. the agent dropped the session) is not retried silently: the error goes out as today and the session is disposed.
3. **Config/settings**: `ProxyConfig.reuseSessions`; `settings.ts` `server.reuseSessions` (default false), `PROXY_REUSE_SESSIONS`; pass `reuseSessions: config.reuseSessions` in the `AcpProvider` options in `src/providers/codex.ts`, `claude.ts` and `antigravity.ts`; `src/renderer/settings.html` checkbox "Reuse agent sessions across conversation turns" + the `src/renderer/settings.ts` field spec (same as `server.ignoreSampling`); the `src/shared/ipc.ts` types if they list server fields.
4. **AAP-09 interplay**: a request cut by the token limit ends `cancelled` at the provider, so it is not kept. Nothing else changes in `src/server.ts`.
5. **Docs**: README env table row and a short "Session reuse" paragraph (matching rule, idle timeout, cap, only after a completed turn); update the README line "Each request gets a fresh ACP session…".
6. **Tests** (`tests/acp-provider.test.ts` with its fake agent fixture, `tests/settings.test.ts`):
   - Reuse off: two turns → two sessions (unchanged).
   - Reuse on: turn 1 → session kept (not deleted); turn 2 with `[...turn1, {assistant: answer}, {user: next}]` → same session id, and the prompt holds only the new user message; a changed history (edited earlier user message) → new session; a different model → new session; the client-visible assistant content as a substring (fenced raw answer) still matches.
   - Cancelled/aborted turn → not kept. Idle timeout disposes it (short `retainedIdleMs`). Cap evicts the oldest. `close()` disposes the kept sessions.
   - `usageScope: "session"` → turn 2 reports the delta.
   - Settings: `PROXY_REUSE_SESSIONS=1` → `config.reuseSessions === true` and listed in `overridden`.
   - Read the fake agent fixture in `tests/fixtures` first; extend it if it cannot keep a session across prompts or echo the prompt text.

## Acceptance

- `npm run typecheck` clean, `npm test` passes, `npm run build` succeeds.
- With reuse on, a multi-turn conversation reuses one ACP session and sends only the new messages; with it off nothing changes.

## Status

- [x] 1. `usageScope` on `ProviderDescriptor`; Claude descriptor sets `"session"`.
- [x] 2. `src/acp-provider.ts`: `reuseSessions` / `retainedSessions` / `retainedIdleMs` options, kept-session pool (`keep`, `takeKept`, `dropKept`), matching rule, skip create/config/mode on reuse, retain only on `end_turn` and not aborted, usage delta for session scope, dispose on `stop()` (awaited before the connection closes) and on agent exit.
- [x] 3. Config/settings: `ProxyConfig.reuseSessions`, `server.reuseSessions`, `PROXY_REUSE_SESSIONS`, passed in codex/claude/antigravity providers, settings checkbox + field spec. Deviation: `src/shared/ipc.ts` does not list `ignoreSampling` (or other new server fields), so it was left unchanged; no `src/electron/*` change needed.
- [x] 4. AAP-09 interplay: a limit cut aborts the turn, so it is not kept; `src/server.ts` unchanged.
- [x] 5. README: env table row, "Session reuse" paragraph, "fresh ACP session" sentence qualified.
- [x] 6. Tests: 10 new in `tests/acp-provider.test.ts` (reuse off, only new messages sent, changed history / other model / no new message, substring match, concurrent requests, cancelled, idle timeout, cap, close, usage delta), 1 in `tests/settings.test.ts`; `tests/fixtures/fake-acp.mjs` gained `FAKE_ACP_CUMULATIVE=1`.

Verification: `npm run typecheck` clean; `npx vitest run` 147 passed, 1 skipped (13 files passed, 1 skipped); `npm run build` succeeded.
