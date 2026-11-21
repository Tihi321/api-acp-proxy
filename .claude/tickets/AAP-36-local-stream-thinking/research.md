# AAP-36 research: local streaming and thinking tokens (Gufo / Strata)

## Question

Why does the user see no thinking tokens (and does streaming really work) when chatting with `gufo/…` / `strata/…` in the playground? What is the smallest way to forward reasoning through the proxy and show it in a collapsible "Thinking" block? And how can the playground render markdown and highlighted code safely?

## Answer

- **Thinking: confirmed root cause.** The proxy drops reasoning everywhere. `LocalOpenAiProvider` reads only `delta.content` (src/providers/local-openai.ts:109,113-114). `GenerationCallbacks` has only `onText` and `onUsage` (src/provider.ts:21). server.ts emits only `delta.content` (src/server.ts:186). The playground reads only `delta.content` (src/playground/playground.ts:304,309). The ACP providers drop `agent_thought_chunk` too (src/acp-provider.ts:873,996 handle only `agent_message_chunk`). The proxy has no thinking mechanism at all. The only related piece is `reasoning_tokens` in usage, always 0 for local providers (src/usage.ts:14).
- **Upstream format.** Strata streams reasoning as `choices[0].delta.reasoning_content`. This is confirmed from Strata's own client: D:\Strata\app\host\server\inference.mjs:343-348, and model-providers.mjs:242 also accepts `delta.reasoning`. Gufo almost certainly does the same. This is inferred from strings in gufo.exe: `reasoning_content`, `chat_template_kwargs.enable_thinking`, `reasoning_effort`, `thinking_budget_tokens`. The installed model is Qwen3.8-27B, which has `<think>` tokens (D:\Gufo\test-qwen27-ar.log:7-9).
- **Streaming: no defect found.** It works, but it looks broken with a thinking model. During the whole reasoning phase the upstream sends only `reasoning_content` deltas. The proxy forwards nothing, so the playground shows an empty pending bubble until the first answer token. This is inferred from the format above plus the code paths. Parsing and forwarding look correct (details below), and the existing streaming test passes.
- **Minimal fix.** Add `onReasoning?(text)` to `GenerationCallbacks`. Read `delta.reasoning_content ?? delta.reasoning` in the local provider. Emit `delta.reasoning_content` chunks in the Chat stream (and `message.reasoning_content` when not streamed). In the playground, render them in a `<details>` accordion. Optionally also wire ACP `agent_thought_chunk` to the same callback.
- **Markdown: recommendation.** Write a small in-house renderer that builds DOM nodes (createElement + textContent, no innerHTML), with a small token-class highlighter. Do not vendor marked/markdown-it + highlight.js. Those return HTML strings that need innerHTML and a sanitizer, and the bundling and whitelist need changes. The CSP forbids CDNs anyway.

## Live evidence (item 1)

**Not obtained.** `netstat -ano | grep LISTENING | grep -E ":(8080|8081|8787) "` printed nothing, so no server is listening. curl to :8081, :8080, :8787 and even `127.0.0.1:1` all ended with exit 28 (timeout, not refused), so the sandbox also blocks loopback. No raw SSE was captured, so `.claude/temp/aap36/` was not created. Everything about the upstream wire format below comes from the sources and is marked as such.

Upstream format derived from the sources:
- Strata request (D:\Strata\app\host\server\inference.mjs:262-275) is a plain `fetch` POST with `content-type: application/json` and `{model, stream:true, stream_options:{include_usage:true}, ...sampling, messages}`. It needs no special header for streaming. The proxy sends the same plus `accept: text/event-stream` (local-openai.ts:63,98). **Confirmed** (read).
- Strata stream chunks carry `choices[0].delta.reasoning_content` (thinking) and `choices[0].delta.content` (answer) in separate deltas. There is also a usage chunk, an optional `timings`, and `finish_reason` (inference.mjs:326-357). Strata's own parser splits on `\n` and trims each line, which also handles `\r` and `data:` without a space. **Confirmed** (read). Non-stream answers have `message.reasoning_content` (D:\Strata\docs\bench-results\2026-10-04-community-2x-rtx3060\raw\nonstream-131072-r1.json:21). **Confirmed** (read).
- Docs note that with reasoning on, output can go entirely to `reasoning_content` and `content` stays empty (D:\Strata\docs\bench-results\2026-10-03-community-r9700-windows\METHOD-AND-DISCLOSURES.md:48, benchmark.py:211). **Confirmed** (read). In the proxy today that gives an empty answer.
- Gufo has no source here (D:\Gufo\v0.35.0\gufo.exe is a 117 MB binary). `grep -a -o` found `reasoning_content` ×3 (in response field lists and in validation strings such as "'reasoning_content' is only valid as a string on assistant messages") and `chat_template_kwargs.enable_thinking` ×2, `reasoning_effort` and `thinking_budget_tokens`. **Inferred**: Gufo emits llama-server-style `delta.reasoning_content` and accepts `reasoning_effort` / `chat_template_kwargs.enable_thinking` to turn thinking on or off. It is unverified whether it can instead leave `<think>…</think>` inline in `content`.

## Path through the code

### Provider (src/providers/local-openai.ts)
- Request: `stream: true, stream_options.include_usage` and headers `content-type`, `accept: text/event-stream`, optional bearer (:62-64, :98). It uses Node's global fetch on purpose (:166). **Confirmed.**
- SSE parsing (:122-138): a TextDecoder with `stream: true` (:129), a buffer across reads split on `\n` (:131), a trailing `\r` stripped (:132), `data:` accepted with or without a space via `.slice(5).trim()` (:133), and the last partial line flushed (:136-137). Comments, `event:` lines and blank lines are ignored. **Confirmed** (read). This parser is sound for chunk boundaries and CRLF.
- `handle` (:107-121) reads only `choices[0].delta.content` (:113-114). `reasoning_content` and `reasoning` are ignored, and `timings` too. **Confirmed.** This is the divergence point for thinking.
- No timeout on generate, other than the proxy's request timeout (below). **Confirmed** (:91-98).

### Router
- `ProviderRouter.generate` passes `callbacks` through unchanged (src/router.ts:230-247). **Confirmed.** A new callback field travels with no router change.

### Server (src/server.ts)
- `runGeneration` (:129-150) builds a new callbacks object `{ onText }` (:137-144). Any new `onReasoning` must be added here explicitly, or it is dropped. The shortcut at :130 passes `{}` when there is no limit and no emit. The `max_tokens` budget counts only `onText` text (:134-141). Reasoning should not count against it (the upstream already enforces `max_tokens`? No: the proxy does not send `max_tokens` upstream, see Risks). **Confirmed.**
- Chat stream (:180-206): `beginSse` sets `X-Accel-Buffering: no` and there is no compression (src/sse.ts:3-5). Each `onText` delta is written at once as its own `chat.completion.chunk` (:186-187). There is no special path for local providers. JSON-format requests (`asJson`) are the exception: they are buffered until the end (:187,190). **Confirmed.**
- Responses stream (:263-325): text deltas are `response.output_text.delta` (:278-281), and there is no reasoning item. Request field `reasoning` is listed as unsupported/ignored (src/api.ts:22). **Confirmed.**
- Timeout: `config.timeoutMs` defaults to 5 min (src/settings.ts:59) and covers the whole generation (server.ts:166). A long thinking phase counts against it. **Confirmed.**

### ACP providers
- `agent_message_chunk` text → `onText` (src/acp-provider.ts:873-875, :996). `agent_thought_chunk` (present in the SDK schema, node_modules/@agentclientprotocol/sdk/dist/schema/types.gen.d.ts) is ignored. **Confirmed.** So Claude/Codex thinking is dropped as well, the same gap.

### Playground (src/playground/*)
- `requestBody` sends only `content` of past turns (playground.ts:220-232), so stored reasoning would not be resent. Good. **Confirmed.**
- `readStream` (:290-329) uses `parseSseLines` (lib.ts:24-29, splits on `\r?\n` and keeps the partial rest), reads `delta.content`, `annotations`, `images`, `finish_reason` and `usage`. During streaming it writes `textContent` of the last `.msg.assistant .text` node (:312-313). `meta.firstMs` (TTFT) is set at the first content delta (:310). With thinking, that becomes "time to first answer token", and the live tok/s ignores reasoning. **Confirmed.**
- `renderMessage` (:117-182) renders blocks from `splitBlocks` as `div.text` (textContent, `white-space: pre-wrap`, playground.css:50) and `figure.code > pre > code` (textContent). A Run bar is added when `previewDocument(blocks)` finds closed html/css/js blocks (:147-148, lib.ts:98-116). The file header says "Text is always rendered as text" (playground.ts:3). `renderMessages` rebuilds every message node (:113). **Confirmed.**
- History is saved via `saveChats()` (:283). Reasoning stored in `Msg` would be persisted too, which affects size. **Inferred** from the code. The storage implementation was not checked.

### Streaming verdict (item 2, kept short per update)
- Test `tests/local-openai.test.ts` passes. I ran `fnm exec --using default node node_modules/vitest/vitest.mjs run tests/local-openai.test.ts`: 2 passed. **Confirmed.** But it writes all chunks in one go, so it does not prove incremental delivery.
- I found no buffering in the provider, router, server or playground for non-JSON chat streams. **Confirmed** (read). Node `fetch` (undici) yields body chunks as they arrive. **Inferred** (standard behaviour, not tested here).
- Why "stream does not work" was perceived: a thinking model spends its first N seconds in `reasoning_content`, which the proxy drops, so nothing appears. **Inferred.** This also matches the user's revised report ("stream might work but thinking tokens are missing").

## Reproduction

**Not reproduced live** (no server running, loopback blocked). Reproduced by reading only: a chunk `{"choices":[{"delta":{"reasoning_content":"…"}}]}` reaches `handle` and falls through (local-openai.ts:113-114 only checks `content`).

A failing test to add to tests/local-openai.test.ts (same harness as the existing test at :28-52):
1. **Reasoning forwarding.** The fake upstream writes, with `\r\n\r\n` separators and `data:` without a space for one chunk: `delta.reasoning_content: "Let me "`, `"think."`, then `delta.content: "Hi"`, finish, usage, `[DONE]`. Read the proxy's raw SSE with `fetch` (the openai SDK types do not expose `reasoning_content`, though it does pass unknown fields through). Assert that the concatenated `delta.reasoning_content` equals "Let me think.", that all reasoning chunks come before the first content chunk, and that the content equals "Hi" (reasoning not mixed into content). A non-stream variant asserts `choices[0].message.reasoning_content`.
2. **Incremental delivery** (guards the streaming claim). The upstream writes the first reasoning chunk, then waits on a promise that the test resolves only after the client has received that chunk from the proxy, then writes the rest. Without incremental delivery the test hangs and times out. One test is enough; CRLF can be folded into test 1.
3. Optional provider unit test with an injected `fetch` (the `fetch` option, local-openai.ts:13) returning a `ReadableStream` that splits a JSON line across two chunks and asserts the `onReasoning` / `onText` calls. This is likely redundant with tests 1 and 2 (test-discipline).
4. Pure lib tests (tests/playground.test.ts) for the markdown/highlight functions, if they are added.

## What the plan needs

### Thinking pipeline (minimal, consistent with the existing API shapes)
1. `src/provider.ts:21`: `GenerationCallbacks` gets `onReasoning?: (text: string) => void`. Optionally add `reasoning?: string` to `GenerationResult` for non-stream answers.
2. `src/providers/local-openai.ts:109-114`: widen the delta type and call `callbacks?.onReasoning?.(r)` for `delta.reasoning_content ?? delta.reasoning` (string, non-empty). Accumulate it for the result.
   - Option: also split inline `<think>…</think>` out of `content` if a server emits it that way. Unverified for Gufo, so treat it as a follow-up unless live output shows it.
3. `src/server.ts:129-150`: `runGeneration` takes an `emitReasoning` and passes `onReasoning` alongside `onText`. Do not count reasoning against the client budget. The :130 shortcut must not drop it.
4. Chat stream (`server.ts:186`): `chunk([{ index: 0, delta: { reasoning_content: text }, finish_reason: null }])`. This is the de facto field (DeepSeek, llama.cpp, Strata, Gufo) that OpenAI-compatible clients already read. Non-stream (`:218`): `message.reasoning_content` when present. For `asJson`, reasoning can still stream (only the content is buffered).
5. Responses (optional, can be a follow-up): a `reasoning` output item with `response.reasoning_summary_text.delta` (or `response.reasoning_text.delta`) events before the message item. Strata's own client reads `response.reasoning_summary_text.delta` (D:\Strata\app\host\server\model-providers.mjs:236). It needs output-index shifting, because the message is hard-coded at index 0 (server.ts:275-279). More work than Chat.
6. ACP (optional, cheap): handle `agent_thought_chunk` text in `src/acp-provider.ts:873` and `:996` → `onReasoning`. This gives Claude/Codex/Antigravity thinking in the same UI. The usage-limit `watch` wrapper (acp-provider.ts:795-804) spreads `...sink`, so `onReasoning` would pass through unwrapped. **Confirmed** (read).
7. Usage: local providers' `completion_tokens` already include reasoning tokens. `reasoning_tokens` stays 0 unless upstream reports `completion_tokens_details.reasoning_tokens`. Not verified for Gufo/Strata.

### Section 5: Playground UX

#### (a) Thinking accordion
- Data: `Msg` (playground.ts:6) gets `reasoning?: string` and `thoughtMs?: number`. `Meta` may get `firstReasoningMs`. `requestBody` already resends only `content` (:224-225). Keep it that way.
- `readStream` (:304-322): handle `delta.reasoning_content` (and `delta.reasoning`). On the first one, record the start time. While thinking, update a `details.thinking` node with summary "Thinking…" open (or closed with a live preview; this is a UX choice). On the first `content` delta, set `thoughtMs`, change the summary to "Thought for Ns" (`formatMs` exists, lib.ts:48) and close the details (`open = false`).
- The live tok/s (:314-321) and TTFT (:310) currently ignore reasoning. Decide whether TTFT means the first token of any kind (Strata's UI does that, inference.mjs:293-297, 345-346) or the first answer token. Also decide whether the live rate counts reasoning chars.
- `renderMessage` (:117): render `<details class="thinking"><summary>Thought for Ns</summary><div class="text">reasoning</div></details>` before the answer blocks, closed by default, using textContent (or the markdown renderer). `<details>` needs no JS and is allowed by the CSP (it is already used for "Request", :163-174).
- **Risk:** `renderMessages()` rebuilds every node (:113), which loses a user's manual expand. Store the open state per message (e.g. `Msg.thinkingOpen`, not persisted, or a WeakMap) and restore it in `renderMessage`, wired via the `toggle` event.
- An answer with reasoning and empty content (the Strata case where all output goes to reasoning) must still render (today :134 shows an empty text div). Show the accordion and the meta line.
- CSS in playground.css: a muted, smaller style for `.thinking`, and `.thinking summary` with a spinner/ellipsis while pending (the `.pending::after` blink already exists at :51).

#### (b) Markdown + code highlighting, safely
Constraints (all **confirmed**):
- CSP `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; …` (src/playground-files.ts:18). No CDN scripts or styles, no inline `<script>`, no `style="…"` attributes in markup (CSSOM `.style` assignment is still fine), and no remote images (markdown `![](https://…)` would be blocked, so render it as a link).
- Only whitelisted files are served: `playground.html`, `playground.js`, `lib.js`, `playground.css`, `preview` (src/playground-files.ts:8-14). A vendored library would need a new entry here and a test update (the CSP/whitelist test from AAP-35).
- `scripts/copy-static.mjs:9-12` copies only `*.html|*.css` from src/playground. `.js` files come from `tsc -p tsconfig.renderer.json` (ES2022 modules, `moduleResolution: Bundler`, no bundler: tsconfig.renderer.json). A vendored `marked.esm.js` would need copy-static to copy `.js` from a vendor folder, plus an import path. Packages in node_modules are not reachable from the browser as-is.
- No markdown or highlight dependency exists (package.json:31-38).

Options:
1. **In-house DOM renderer (recommended).** Pure functions in lib.ts, unit-tested in tests/playground.test.ts:
   - Extend the existing pipeline. `splitBlocks` (lib.ts:65-92) already separates fenced code, and its `text` blocks go to a small block parser: ATX headings, `-`/`*`/`1.` lists (one nesting level is enough), `>` blockquotes, GFM pipe tables, `---` rules and paragraphs.
   - An inline tokenizer handles `**bold**`, `*italic*`/`_italic_`, `` `code` ``, `[text](url)` and bare http(s) URLs. It returns a small AST (`{type, children|text, href}`), and the DOM builder uses `createElement` + `textContent` only. Links pass `isHttpUrl` (lib.ts:55) and get `target=_blank rel="noopener noreferrer"` (the same pattern as citations, playground.ts:139-141). Raw HTML in the model text stays literal text, so the invariant at playground.ts:3 holds and no sanitizer is needed.
   - Highlighter: `highlight(code, lang) → Array<{text, cls?}>`, a regex tokenizer for comments, strings, numbers and keywords for a few language families (js/ts/json, python, html/xml, css, shell, c-like). Unknown languages are returned plain. Spans get classes styled in playground.css.
   - It fits the Run button unchanged: `previewDocument(blocks)` still takes the same `splitBlocks` output (playground.ts:147). Only the display of code blocks changes (spans instead of one text node), and a "Copy" button per block would be a natural addition.
   - Cost: roughly 200-300 lines plus tests. Edge cases of CommonMark will not be perfect. That is acceptable for a playground.
2. **Vendor marked (or markdown-it) + highlight.js + DOMPurify** as local files: three libraries, a copy-static change, three whitelist entries, license notices, and `innerHTML` with sanitizer configuration. That is more attack surface and breaks the textContent invariant. Not recommended.
3. **Highlight-only (no markdown).** Smallest, but it does not meet (b).

Streaming: re-rendering markdown on every delta is O(n²) for long answers. Throttle it (for example, re-render the last message at most every 100-200 ms, as the rate at :315 already throttles at 250 ms) or render plain text while streaming and markdown at the end. The plan must pick one. Unclosed fences are already handled (`closed: false`, lib.ts:89).

## Risks
- `runGeneration` rebuilds the callbacks object (server.ts:137-144). If `onReasoning` is not threaded through there, it is silently lost. Other callers of `bridge.generate` (mcp-endpoint.ts:696,733 pass only `onText`) are unaffected.
- The proxy never forwards the client's `max_tokens` upstream; it truncates content client-side (server.ts:134-149). A thinking model can therefore think without limit, up to the 5 min `timeoutMs` (settings.ts:59). Long thinking could hit the timeout and end with a 504 error. **Inferred** from the code (whether `normalizeChat` passes `maxOutputTokens` to the local provider was not checked beyond `GenerateOptions` usage at :170; local-openai.ts:98 sends no `max_tokens`). **Confirmed** that none is sent.
- No way to turn thinking off per request: `reasoning_effort` / `chat_template_kwargs` are not forwarded (local-openai.ts:98). Possible follow-up.
- An OpenAI SDK client gets an extra `reasoning_content` delta field. That is harmless (unknown fields pass through), but a strict client would see chunks with an empty `content`. Emit `reasoning_content` only in chunks without `content`.
- The `Msg` shape change persists in history, so old entries lack the fields. Handle `undefined`.
- Markdown rendering changes every assistant message's DOM, and the Run/preview path must keep working (tests in tests/playground.test.ts).

## Open questions (for the user)
1. Accordion while streaming: open with the reasoning text scrolling, or closed showing only "Thinking…" (expandable)? After the answer starts it collapses, as you asked.
2. TTFT and tok/s: measure from the first thinking token or from the first answer token? Should the live rate include reasoning?
3. Also show thinking for ACP providers (Claude/Codex via `agent_thought_chunk`), or only Gufo/Strata in this ticket?
4. Also the Responses API (reasoning output item), or Chat Completions only for now?
5. Markdown during streaming: live (throttled) or plain text until done?
6. Is a per-request "thinking off" toggle (`reasoning_effort: "none"` / `chat_template_kwargs.enable_thinking:false`) wanted?
7. Not verified: Gufo's exact stream shape (`reasoning_content` vs inline `<think>`), and whether either server reports `reasoning_tokens`. One live curl with the servers running would settle it.
