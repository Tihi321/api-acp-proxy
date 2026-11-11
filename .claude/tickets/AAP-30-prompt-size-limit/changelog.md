# Changelog

## 2026-11-11 AAP-30 per-provider prompt size limit

Outcome: Antigravity prompts over 180,000 characters are refused with a 400 `context_length_exceeded` ("The prompt is too long for Google Antigravity: N characters, the limit is 180000. ...") before the agent starts; setting, env, settings-window field, `/v1/models` `max_prompt_chars`, docs.

Repo api-acp-proxy, branch AAP-30_prompt-size-limit (from master):
- src/api.ts: `promptChars`, `promptTooLong` (D4 message).
- src/provider.ts: `ProviderDescriptor.maxPromptChars`, `Provider.maxPromptChars` / `checkPrompt`.
- src/acp-provider.ts: `AcpProviderOptions.maxPromptChars`, `promptBlocks` (both former `buildPrompt` calls, unchanged arguments), public `checkPrompt`, called first in `generate`.
- src/providers/antigravity.ts: default 180_000; codex.ts, claude.ts, antigravity.ts registrations pass the setting.
- src/router.ts: `checkPrompt`, called in `generate` before the limiter; `ListedModel.maxPromptChars`.
- src/acp.ts: `AcpLike.checkPrompt`, `ModelEntry.maxPromptChars`.
- src/server.ts: check before the SSE starts in `handleChat` / `handleResponses` (param `input`); `max_prompt_chars` in `/v1/models`.
- src/settings.ts, src/shared/ipc.ts, src/renderer/settings.ts, src/renderer/settings.html: setting, env `PROXY_<ID>_MAX_PROMPT_CHARS`, three fields.
- tests/prompt-limit.test.ts (new, 3 tests), README.md, ROADMAP.md.

Deviations: none of substance. The request timer in `handleChat`/`handleResponses` is cleared when the check throws (it is armed before the check).

Verification: `yarn typecheck` clean; `yarn test` 454 passed, 1 skipped (455 total, was 451 on master, which in this run also had one flaky tests/process-tree failure); `yarn build` OK (out folder only). Reproduction test failed on the unfixed code (stashed src), passes after.
Not run: settings window hand check (A7), live check on 8787 (A8), rebuild/restart of the packaged app.

Commit status: uncommitted.
