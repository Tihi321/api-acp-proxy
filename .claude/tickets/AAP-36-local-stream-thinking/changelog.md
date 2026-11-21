# Changelog

## 2026-11-21 AAP-36 - thinking tokens end to end, playground thinking accordion and live markdown

Reasoning from every provider now reaches Chat Completions clients as `reasoning_content` (streamed and not), the local providers get the client's output limit as `max_tokens`, and the playground shows thinking in an accordion and renders answers as markdown live.

### api-acp-proxy (branch AAP-36_local-stream-thinking, from master c1a8214)

- src/provider.ts: `GenerationCallbacks.onReasoning`, `GenerationResult.reasoning`, `GenerateOptions.maxOutputTokens`.
- src/providers/local-openai.ts: reads `delta.reasoning_content ?? delta.reasoning` (before content), returns `reasoning` (also when cancelled), maps upstream `completion_tokens_details.reasoning_tokens` to `thoughtTokens`, sends `max_tokens` upstream when the client set a limit.
- src/server.ts: `runGeneration` gets `emitReasoning`, always collects reasoning (kept on a truncated result, outside the content budget); chat stream emits separate `delta.reasoning_content` chunks (also for JSON response_format); non-stream message gets `reasoning_content`; chat and responses pass `maxOutputTokens`.
- src/usage.ts: no-usage estimate adds est(reasoning) to completion tokens and reports it as reasoning tokens.
- src/acp-provider.ts: `agent_thought_chunk` text goes to `onReasoning` in plain and tool turns and is returned as `reasoning` (tool turns: per HTTP response).
- src/playground/markdown.ts (new): pure markdown parser (headings, paragraphs, emphasis, code, safe links, nested lists, quotes, GFM tables, hr, fences via splitBlocks) and lossless highlighter (js/ts, html/xml, css, json, python, bash, generic).
- src/playground-files.ts: serves markdown.js.
- src/playground/playground.ts: DOM-only markdown rendering of assistant answers, live while streaming (trailing timer, max(100 ms, 4x render time)); code figures with highlighting and Copy; thinking accordion (Thinking… -> auto-collapse to "Thought for N" at the first answer token; open state persisted); reasoning stored in history and dropped with images on a full quota; TTFT = first token of any kind; live tok/s includes reasoning; non-stream reads `reasoning_content`.
- src/playground/lib.ts: `outputTokensEstimate(content, reasoning)`.
- src/playground/playground.css: accordion, markdown elements, table wrap, Copy button, token colours (light/dark).
- tests: local-openai.test.ts (+3 tests), acp-provider.test.ts (+1), playground.test.ts (+2, serving and rate tests extended), fixtures/fake-acp.mjs (`FAKE_ACP_THOUGHT`).
- README.md, ROADMAP.md: reasoning fields, usage rule, local max_tokens, playground features; roadmap done line and follow-up item.

### Deviations from the plan

- runGeneration passes `onText` only when a limit or emit is set (plan: always), to keep the existing "no onText for streamed asJson" behaviour that tests/proxy.test.ts asserts.
- T1 repro test 3 also failed on master (plan allowed it to pass).
- Tool-turn reasoning is per HTTP response, mirroring `text`.
- Code figcaption always rendered because it holds the Copy button.

### Verification

- `fnm exec --using default npm.cmd test`: 35 files passed, 1 skipped; 480 tests passed, 1 skipped.
- `npm.cmd run typecheck`: clean (both tsconfigs). `npm.cmd run build`: clean.
- Repro tests on master: test 1 and test 2 failed on assertions, test 3 timed out.
- Not run: M1-M6 (live Gufo/Strata, Claude/Codex/Antigravity thinking, browser accordion/markdown/Copy/CSP, AAP-35 Run preview regression, max_tokens 200 against gufo).

### Follow-ups

- Responses API reasoning items and a per-request thinking-off toggle (ROADMAP open item).
- Inline `<think>` splitting if live Gufo output shows it.
- See discoveries.md.

### Commit status

Committed on AAP-36_local-stream-thinking (85797f1, fb10304, 6d65180, 79dd0db, f8dd1bd, plus ticket files); not merged, not pushed.
