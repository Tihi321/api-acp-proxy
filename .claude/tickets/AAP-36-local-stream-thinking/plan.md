---
status: in-progress
request: REQ-0005
repos: [api-acp-proxy]
branch: AAP-36_local-stream-thinking
updated: 2026-11-21
---

# AAP-36 Thinking tokens end to end, playground thinking accordion and live markdown

Source of facts: `research.md` in this folder (file:line references against master after the AAP-35 merge). This plan is the only contract for the workers; each task lists its inputs, outputs and the interface it must keep.

Reading chosen (full, not narrow): reasoning is forwarded for **every** provider (Gufo/Strata via `reasoning_content`, Claude/Codex/Antigravity via ACP `agent_thought_chunk`) on Chat Completions, streamed and not streamed; the playground shows it in a collapsible accordion and renders answers as markdown **live while streaming**, with a small in-house highlighter.

## Scope

1. Provider callbacks get `onReasoning(delta)`. `LocalOpenAiProvider` reads `delta.reasoning_content ?? delta.reasoning`; the ACP providers forward `agent_thought_chunk` text. Both also return the accumulated text as `GenerationResult.reasoning`.
2. `runGeneration` passes reasoning through (not counted against the client's content budget, kept on a truncated result).
3. Chat Completions: streaming emits separate chunks `choices[0].delta.reasoning_content` (never in a chunk that carries `content`); a non-streamed answer has `choices[0].message.reasoning_content` when there was any. Reasoning is never appended to `content`.
4. Usage: when upstream reports no usage, the chars/4 estimate counts reasoning: `completion_tokens = est(text) + est(reasoning)`, `completion_tokens_details.reasoning_tokens = est(reasoning)`. When upstream reports usage, `completion_tokens` is used as is (llama-server style counts include reasoning) and `reasoning_tokens` comes from upstream `completion_tokens_details.reasoning_tokens` when present, else 0 (as today).
5. A client `max_tokens` / `max_completion_tokens` (Responses `max_output_tokens`) is forwarded upstream as `max_tokens` for the local providers (Gufo/Strata) so a long thinking phase is bounded. ACP providers: unchanged. The existing client-side content truncation stays.
6. Playground: a `<details class="thinking">` accordion per assistant message: open with live text and summary "Thinking…" while reasoning streams; auto-collapses to "Thought for Ns" at the first answer token; the user can re-open; the open/closed choice survives `renderMessages()` rebuilds and is stored with the chat history (with the reasoning), so old messages show it too.
7. Playground: markdown rendering, live while streaming (throttled ~100 ms): headings, paragraphs, bold/italic, inline code, links (http/https/mailto only, `target=_blank rel="noopener noreferrer"`), ordered/unordered lists (nested), blockquotes, GFM tables, horizontal rules, fenced code with an in-house highlighter (js/ts, html/xml, css, json, python, bash, generic fallback) and a Copy button. DOM nodes only; raw HTML in model text shows as text. CSP unchanged. The AAP-35 Run / Open in new tab preview keeps working (same `splitBlocks` / `previewDocument`).
8. Playground speed: TTFT = first token of any kind (reasoning or content); live and final tok/s include thinking tokens.

## Out of scope

- **Responses API reasoning items** (`reasoning` output item, `response.reasoning_summary_text.delta`). Not trivially consistent: the message item is hard-coded at output index 0 (server.ts:275-279) and every later index would shift. Responses only changes indirectly: its usage estimate counts reasoning (shared `openAiUsage`), and `max_output_tokens` is forwarded for local providers (shared `GenerateOptions`). Follow-up ticket.
- A per-request thinking-off toggle (`reasoning_effort`, `chat_template_kwargs.enable_thinking`), forwarding sampling fields upstream.
- Splitting inline `<think>…</think>` out of `content` (unverified that Gufo/Strata ever emit it; follow-up if live output shows it).
- Server-side markdown, external libraries (marked, markdown-it, highlight.js, DOMPurify), any CSP change.
- Chat in the Electron renderer; MCP endpoint generate calls (mcp-endpoint.ts:696,733 keep passing only `onText`).
- Raising `timeoutMs` for long thinking (5 min default stays; settings.ts:59).
- Markdown rendering of the reasoning text (it is shown as plain pre-wrap text), images in markdown (`![alt](url)` becomes a link: the CSP blocks remote images), fenced code nested inside list items or blockquotes (only top-level fences, as `splitBlocks` does today), full CommonMark conformance.

## Files and modules to touch

| File | Task | Change |
|---|---|---|
| src/provider.ts | T1 | `GenerationCallbacks.onReasoning`, `GenerationResult.reasoning`, `GenerateOptions.maxOutputTokens` |
| src/providers/local-openai.ts | T1 | read reasoning deltas, upstream reasoning_tokens, send `max_tokens` |
| src/server.ts | T1 | `runGeneration` reasoning pass-through, chat stream / non-stream fields, `maxOutputTokens` into options (chat + responses) |
| src/usage.ts | T1 | estimate counts reasoning |
| tests/local-openai.test.ts | T1 | 3 new `it`s (repro first) |
| src/acp-provider.ts | T2 | `agent_thought_chunk` → `onReasoning` at :873 and :996, accumulate `reasoning` |
| tests/fixtures/fake-acp.mjs | T2 | `FAKE_ACP_THOUGHT=<json array>` switch |
| tests/acp-provider.test.ts | T2 | 1 new `it` |
| src/playground/markdown.ts (new) | T3 | parser + highlighter (pure) |
| src/playground-files.ts | T3 | `FILES` gets `"markdown.js": "markdown.js"` |
| tests/playground.test.ts | T3, then T4 | T3: markdown `it`, highlighter `it`, serving test adds markdown.js; T4: rates `it` update |
| src/playground/playground.ts, playground.css, lib.ts | T4 | accordion, markdown DOM builder, live render, speed |
| README.md, ROADMAP.md | T5 | docs |

Build/whitelist check (confirmed): `tsconfig.renderer.json` compiles every `src/playground/*.ts` to `dist/playground/*.js` (ES modules, no bundler), so `markdown.ts` needs no build change; `scripts/copy-static.mjs` copies only html/css and needs no change; `servePlayground` serves only `FILES`, so `markdown.js` must be added there (T3), otherwise the browser's `import "./markdown.js"` gets 404 and the page breaks. The root `tsconfig.json` excludes src/playground, so the module must not import Node APIs.

## Shared contracts (all tasks code against these; do not change them without updating this plan)

### C1 Provider types (`src/provider.ts`)

```ts
export interface GenerationCallbacks {
  onText?: (text: string) => void;
  /** A piece of the model's thinking (reasoning_content / agent_thought_chunk); never part of the answer text. */
  onReasoning?: (text: string) => void;
  onUsage?: (usage: Usage) => void;
}
// GenerationResult gets:
  /** The whole thinking text of this answer; absent or "" when the model sent none. */
  reasoning?: string;
// GenerateOptions gets:
  /** The client's output limit (max_tokens / max_completion_tokens / max_output_tokens). Local OpenAI-compatible providers forward it upstream as `max_tokens`; ACP providers ignore it. */
  maxOutputTokens?: number;
```

Only non-empty strings are passed to `onReasoning`. Callers that pass no `onReasoning` are unaffected.

### C2 Wire shapes (proxy → client, Chat Completions)

- Stream, reasoning piece (its own chunk, before/among content chunks in arrival order):
  `{"id":…,"object":"chat.completion.chunk","created":…,"model":…,"choices":[{"index":0,"delta":{"reasoning_content":"<piece>"},"finish_reason":null}]}` (plus `"usage":null` when `include_usage`, as every other chunk). A chunk never has both `content` and `reasoning_content`.
- For `response_format` JSON requests (`asJson`), reasoning still streams live; only content is buffered (as today).
- Non-stream: `choices[0].message.reasoning_content: string` present only when `result.reasoning` is non-empty; `content` unchanged.
- Usage (both): `completion_tokens_details.reasoning_tokens` = upstream value, else the estimate rule of Scope 4.

### C3 Upstream request (proxy → Gufo/Strata)

`POST <baseUrl>/chat/completions` body `{ model, messages, stream: true, stream_options: { include_usage: true }, ...(options.maxOutputTokens !== undefined ? { max_tokens: options.maxOutputTokens } : {}) }`. Upstream delta read: `const r = delta.reasoning_content ?? delta.reasoning` (string, non-empty) → `reasoning += r; callbacks.onReasoning?.(r)`; then `delta.content` as today (a delta may carry both; reasoning is handled first). Upstream usage `completion_tokens_details.reasoning_tokens` (number) → `Usage.thoughtTokens`.

### C4 Stored chat message (`src/playground/playground.ts`, localStorage `acp-playground-chats`)

```ts
interface Msg {
  role: "user" | "assistant"; content: string; images?: string[]; citations?: Array<{ url: string; title: string }>; meta?: Meta; error?: string; request?: unknown;
  /** Thinking text, shown in the accordion; never resent (requestBody sends only `content`). */
  reasoning?: string;
  /** ms from the first reasoning delta to the first content delta (or to the end when no content came); absent for non-streamed answers. */
  thoughtMs?: number;
  /** The user's (or the auto-collapse's) open state of the accordion; undefined = default (open while pending or when content is empty, else closed). Persisted. */
  thinkingOpen?: boolean;
}
// Meta unchanged in shape; meaning of firstMs becomes "first token of any kind".
```

Old history entries without these fields render as before (no accordion). The quota fallback in `saveChats` (playground.ts:37) drops `reasoning` (and `thoughtMs`) together with `images`.

### C5 Markdown module (`src/playground/markdown.ts`, pure, no DOM, imports only `./lib.js`)

```ts
export type Inline =
  | { type: "text"; text: string }
  | { type: "strong"; children: Inline[] }
  | { type: "em"; children: Inline[] }
  | { type: "code"; text: string }
  | { type: "link"; href: string; children: Inline[] }   // href already passed safeHref
  | { type: "br" };                                       // a soft line break inside a paragraph (keeps today's pre-wrap look)
export interface ListItem { children: Inline[]; sub?: ListBlock }
export interface ListBlock { type: "list"; ordered: boolean; start?: number; items: ListItem[] }
export type Align = "left" | "center" | "right" | null;
export type MdBlock =
  | { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; children: Inline[] }
  | { type: "paragraph"; children: Inline[] }
  | ListBlock
  | { type: "blockquote"; children: MdBlock[] }
  | { type: "table"; align: Align[]; head: Inline[][]; rows: Inline[][][] }
  | { type: "hr" }
  | { type: "code"; lang: string; code: string; closed: boolean };   // straight from splitBlocks

/** splitBlocks(source) first; each text block goes through the block parser, each code block becomes a "code" MdBlock unchanged. Never throws; any input gives some blocks. */
export function parseMarkdown(source: string): MdBlock[];
/** `**x**`/`__x__` strong, `*x*`/`_x_` em (no intraword `_`), `` `x` `` code (any backtick run length), `[text](url)`, `![alt](url)` → link with alt text, bare http(s) URLs autolinked, `\` escapes of ASCII punctuation, `\n` → br. Unmatched markers stay literal text. A link whose url fails safeHref becomes its text (plus nothing else). */
export function parseInline(text: string): Inline[];
/** The url when its scheme is http:, https: or mailto: (URL-parsed), else undefined. Relative urls are rejected. */
export function safeHref(url: string): string | undefined;

export type TokenClass = "kw" | "str" | "com" | "num" | "tag" | "attr" | "lit";
export interface Token { text: string; cls?: TokenClass }
/** Lossless: tokens.map(t => t.text).join("") === code. Languages: js|javascript|mjs|cjs|jsx|ts|typescript|tsx, html|htm|xml|svg, css|scss, json, python|py, bash|sh|shell|zsh|console; anything else (incl. "") the generic rule (strings, numbers, // # /* */ comments). Code over 100_000 chars returns one plain token. */
export function highlight(code: string, lang: string): Token[];
```

Block rules: ATX headings `#`..`######` + space; `---` / `***` / `___` (3+, optional spaces) is hr; `>` blockquote lines (recursively parsed); list markers `-`, `*`, `+`, `1.` / `1)` with up to 3 spaces indent, a nested list when indented ≥ 2 spaces more than its parent marker (at least one level must work, deeper is allowed); continuation lines indented into an item join its text; a GFM table is a header row with `|`, a delimiter row `|:--|:-:|--:|`, then rows until a line without `|` (cells trimmed, escaped `\|` kept); blank lines end paragraphs. Anything that matches no rule is paragraph text. An unclosed fence mid-stream is already a `closed: false` code block from `splitBlocks` and renders as code.

### C6 Playground DOM builder (inside `playground.ts`, not exported)

```ts
/** DOM for markdown blocks: createElement + textContent only (the `make` helper), never innerHTML / insertAdjacentHTML / outerHTML with model text. */
function markdownNodes(blocks: readonly MdBlock[]): Node[];
/** <figure class="code"><figcaption>lang <button class="copy">Copy</button></figcaption><pre><code><span class="tok-kw">…</span>…</code></pre></figure> */
function codeFigure(lang: string, code: string): HTMLElement;
```

Links: `Object.assign(make("a", "", …), { href, target: "_blank", rel: "noopener noreferrer" })`, as for citations (playground.ts:141). Table: `<div class="table-wrap"><table><thead>…</thead><tbody>…</tbody></table></div>`, alignment via `cell.style.textAlign` (CSSOM, allowed by the CSP; never a `style` attribute string). Copy: `navigator.clipboard.writeText(code)`, button text "Copied" / "Copy failed" for 1.5 s.

## Tasks

Dependencies: **T1 and T3 in parallel first** (disjoint files). **T2 after T1** (needs C1 in provider.ts). **T4 after T1 and T3** (uses the C2 wire format and the C5 module; edits tests/playground.test.ts after T3). **T5 last.**

```
T1 ─┬─ T2 ───────┐
    └────┐       ├─ T5
T3 ──────┴─ T4 ──┘
```

### T1 Proxy plumbing: callbacks, local provider, server, usage

- Inputs: C1, C2, C3; src/provider.ts:19-21; src/providers/local-openai.ts:91-121; src/server.ts:129-150 (runGeneration), :167 (options), :180-219 (chat), :263-330 (responses options only); src/usage.ts:10-15; tests/local-openai.test.ts (harness :13-25, existing test :28-52).
- Do:
  - provider.ts: C1 verbatim.
  - local-openai.ts: C3. Widen the chunk type (`delta: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown }`, `usage.completion_tokens_details?: { reasoning_tokens?: number }`). Accumulate `reasoning`; return `{ text, stopReason, usage, ...(reasoning ? { reasoning } : {}) }`, also on the cancelled path. Debug log mentions reasoning chars.
  - server.ts `runGeneration(bridge, model, messages, options, limit, emit, signal, emitReasoning?)` (new last parameter, so other call sites stay valid): the `{}` shortcut (:130) applies only when `limit === undefined && !emit && !emitReasoning`; the callbacks object is `{ onText, ...(emitReasoning ? { onReasoning: (text) => { reasoning += text; emitReasoning(text); } } : { onReasoning: (text) => { reasoning += text; } }) }` — always collect, so a truncated result is `{ text: emitted, reasoning, stopReason: "max_tokens", usage: null }`. Reasoning never touches `emitted` / the budget.
  - Chat stream: `const thinking = (text: string) => chunk([{ index: 0, delta: { reasoning_content: text }, finish_reason: null }])`, passed as `emitReasoning` (also when `asJson`). Non-stream: add `...(result.reasoning ? { reasoning_content: result.reasoning } : {})` to `message`.
  - Options: chat (:167) and responses get `...(parsed.maxOutputTokens !== undefined ? { maxOutputTokens: parsed.maxOutputTokens } : {})`. Responses passes no `emitReasoning`.
  - usage.ts `openAiUsage`: no usage → `const reasoning = estimateTokens(result.reasoning ?? ""); completion = estimateTokens(result.text) + reasoning`, field `reasoning`; with usage unchanged (`thoughtTokens ?? 0`).
- Tests (tests/local-openai.test.ts; write and run them on master first and record that 1-3 fail, then implement):
  1. **Repro, streamed.** Fake upstream writes with `\r\n\r\n` separators, one chunk as `data:{…}` (no space): `reasoning_content: "Let me "`, `reasoning_content: "think."`, `content: "Hi"`, finish `stop`, usage `{prompt_tokens: 5, completion_tokens: 9, total_tokens: 14, completion_tokens_details: {reasoning_tokens: 7}}`, `[DONE]`. Client: raw `fetch` to the proxy `/v1/chat/completions` (`stream: true, stream_options.include_usage`), parse SSE lines. Assert: joined `delta.reasoning_content` === "Let me think."; the index of the last reasoning chunk < index of the first content chunk; no chunk has both fields; joined `content` === "Hi"; final usage `completion_tokens` 9, `completion_tokens_details.reasoning_tokens` 7.
  2. **Repro, not streamed + estimate + max_tokens.** Same reasoning/content, upstream sends **no** usage chunk and records its request body. Client sends `stream: false, max_completion_tokens: 50`. Assert `choices[0].message.reasoning_content === "Let me think."`, `content === "Hi"`, usage `completion_tokens === 4 + 1` (est("Let me think.") + est("Hi")), `reasoning_tokens === 4`, and the upstream body had `max_tokens: 50`.
  3. **Incremental delivery.** Upstream writes the first reasoning chunk, then awaits a promise the test resolves only after its `fetch` reader has seen `reasoning_content` from the proxy; then writes content and `[DONE]`. Test timeout 5 s: buffering anywhere makes it time out.
- Output: `npm test` green (existing tests unchanged, incl. tests/local-openai.test.ts :28 and tests/usage.test.ts). The repro failure on master is noted in the slice report.

### T2 ACP thought forwarding

- Inputs: C1; src/acp-provider.ts:795-804 (`watchUsageLimit` spreads `...sink`, so `onReasoning` passes through), :872-876 (plain turn handler), :993-997 (`newTurn` tool-turn handler, `turn.sink`); SDK `SessionUpdate` `agent_thought_chunk` (node_modules/@agentclientprotocol/sdk/dist/schema/types.gen.d.ts:2858, `ContentChunk`); tests/fixtures/fake-acp.mjs (switches list :7-62, `update()` :97, `FAKE_ACP_ANSWER` :321).
- Do:
  - In both handlers: `else if (update.sessionUpdate === "agent_thought_chunk" && update.content.type === "text" && update.content.text) { reasoning += update.content.text; <sink>.onReasoning?.(update.content.text); }` (plain turn: `watch.callbacks`; tool turn: `turn.sink`). Do not route it through the usage-limit notice holding (thinking is never the notice).
  - Accumulate into the result: plain turn a local `reasoning` next to `text`; tool turn a `turn.reasoning` field on `ToolTurn`. Put `...(reasoning ? { reasoning } : {})` on every `GenerationResult` those paths return (including `cancelled()` when easy; not required).
  - fake-acp.mjs: `FAKE_ACP_THOUGHT=<json array>` sends one `agent_thought_chunk` per string before the answer chunks of a plain prompt (document it in the header list).
- Test (tests/acp-provider.test.ts, one `it`): `FAKE_ACP_THOUGHT='["Hmm, ","ok."]'`, `FAKE_ACP_ANSWER='["Done"]'`; `generate` with `onText` and `onReasoning` pushing `["t"|"r", text]` into one array: the array is `[["r","Hmm, "],["r","ok."],["t","Done"]]`, `result.text === "Done"`, `result.reasoning === "Hmm, ok."`.
- Output: `npm test` green. Claude/Codex/Antigravity real behaviour is a manual check (M3).

### T3 Markdown parser and highlighter (pure)

- Inputs: C5; src/playground/lib.ts (`splitBlocks` :65-92, `isHttpUrl` :55); src/playground-files.ts:8-14; tests/playground.test.ts (helpers :13-77, serving test :102-126).
- Do: new src/playground/markdown.ts with C5 exactly, `import { splitBlocks, type Block } from "./lib.js"`. Keep it linear-time per call (no regex with catastrophic backtracking on long lines; the inline tokenizer is a single left-to-right scan with a delimiter stack or bounded lookahead). playground-files.ts `FILES` adds `"markdown.js": "markdown.js"`.
- Tests (tests/playground.test.ts, in "playground helpers"):
  1. One `it` for `parseMarkdown`: a sample with `# Title`, a paragraph with `**b**`, `*i*`, `` `c` ``, `[ok](https://a.example)`, `[bad](javascript:alert(1))`, raw `<script>alert(1)</script>`, a GFM table with alignment, a `-` list with a nested `1.` item, a `>` quote, `---`, and a trailing unclosed ```` ```js ```` fence. `toEqual` on the AST: heading level 1; the strong/em/code/link nodes; the javascript: link is plain text "bad" (no link node); the `<script>` line is a text node with the literal characters; table `align` and cells; list with `sub.ordered === true`; blockquote; hr; last block `{ type: "code", lang: "js", closed: false }`. Plus `safeHref("mailto:a@b.c")` defined, `safeHref("/x")` undefined.
  2. One `it` for `highlight`: for a js sample (`const s = "x"; // c\nlet n = 42;`) the join of token texts equals the input and the classes include `kw` for `const`, `str` for `"x"`, `com` for `// c`, `num` for `42`; `highlight("<a href=\"x\">", "html")` has a `tag` and an `attr` token; an unknown lang still round-trips losslessly.
  3. Serving test (:102): also write `markdown.js` into the temp dir and assert `/playground/markdown.js` → 200 `text/javascript; charset=utf-8`.
- Output: module + tests green; no DOM code.

### T4 Playground UI: accordion, live markdown, speed

- Inputs: C2, C4, C5, C6; src/playground/playground.ts (Msg :6, saveChats :34-39, renderMessages :107-115, renderMessage :117-178, send :239-288, readStream :290-330); lib.ts; playground.css; tests/playground.test.ts rates `it` (:71-76).
- Do:
  - lib.ts: `export function outputTokensEstimate(content: string, reasoning = ""): number` = `estimateTokens(content) + estimateTokens(reasoning)` (the server's rule, Scope 4). `decodeRate` unchanged (upstream `completion_tokens` already includes reasoning; the proxy estimate now does too).
  - renderMessage: split into the header, then `thinkingNode(message)` when `message.reasoning` (or while pending and a reasoning delta came), then a `div.body` holding the answer: for an assistant message (finished **or** pending) `markdownNodes(parseMarkdown(content))`; user messages stay plain `div.text`. Keep `previewDocument(splitBlocks(content))` + `previewBar` only for finished messages (`meta`). An assistant message with reasoning and empty content renders the accordion and the meta line, no empty text div. The pending cursor moves to `.body.pending::after`.
  - Accordion: `<details class="thinking">` + `<summary>` ("Thinking…" with class `pending` while pending without content; "Thought for ${formatMs(thoughtMs)}" when known; "Thoughts" otherwise) + `div.thinking-text` (textContent, pre-wrap, max-height ~320 px with its own scroll, kept scrolled to the bottom while streaming). `open = message.thinkingOpen ?? (pending || !message.content)`. A `toggle` listener sets `message.thinkingOpen = details.open` and calls `saveChats()` when not running.
  - readStream: on `delta.reasoning_content ?? delta.reasoning`: set `meta.firstMs` if undefined; remember `thinkStart`; `answer.reasoning += r`; update the accordion text (create it via a re-render of the pending node the first time). On the first `delta.content`: if reasoning came, `answer.thoughtMs = now - thinkStart`, `answer.thinkingOpen = false`, set `details.open = false` and the summary text; set `meta.firstMs` if undefined. At the end, if reasoning came and no content, `answer.thoughtMs = end - thinkStart`.
  - Live render: keep a reference to the pending message node; schedule a trailing re-render of its `.body` (and the thinking text) at most every 100 ms (`setTimeout`, one pending timer); measure the render time and raise the interval to `max(100, 4 × last render ms)` so huge answers stay responsive. Auto-scroll as today. The final `renderMessages()` in `send` (:285) renders the finished state.
  - Rate: `span.rate` becomes a sibling after `.body` (not inside it, since `.body` is rebuilt); live value `tokensPerSecond(outputTokensEstimate(answer.content, answer.reasoning), now - started - meta.firstMs)`, updated at most every 250 ms after the first token of any kind.
  - Non-stream: `answer.reasoning = choice.message.reasoning_content` when a non-empty string.
  - `send` finally (:280): keep a message's meta when it has content **or** reasoning. `saveChats` slim fallback also drops `reasoning`, `thoughtMs`.
  - Header comment (:3): "Model text is rendered only through DOM nodes (textContent), never as HTML."
  - playground.css: `.thinking` (muted, smaller, left border), `.thinking summary.pending::after` (reuse the `blink` keyframes), `.thinking-text`, markdown elements inside `.msg .body` (h1-h6 sizes, p margins, ul/ol padding, blockquote, table + `.table-wrap { overflow-x: auto }`, hr, inline `code`), `.copy` button, token colours `.tok-kw/.tok-str/.tok-com/.tok-num/.tok-tag/.tok-attr/.tok-lit` in light and dark.
- Test (tests/playground.test.ts): update the existing "computes live and decode tokens per second" `it` with `outputTokensEstimate("x".repeat(200), "y".repeat(200)) === 100` and `outputTokensEstimate("x".repeat(400)) === 100` (no new `it`). DOM behaviour is manual (M1-M5).
- Output: `npm run typecheck`, `npm test`, `npm run build` green.

### T5 Docs

- Inputs: everything above.
- Do: README.md — Chat Completions section: `delta.reasoning_content` / `message.reasoning_content` for every provider, reasoning never in `content`, usage estimate rule, `max_tokens` forwarded upstream for Gufo/Strata only, Responses has no reasoning item yet; Playground section (:338): thinking accordion, markdown + highlighting (DOM only, raw HTML stays text, links http/https/mailto), TTFT = first token of any kind, tok/s includes thinking. ROADMAP.md: an `[x] (AAP-36; live checks UNTESTED)` line, and an open item for Responses reasoning items / thinking-off toggle.

## Acceptance criteria

| # | Criterion | Proof |
|---|---|---|
| A1 | Streamed upstream `reasoning_content` (CRLF, `data:` without space) reaches the client as separate `delta.reasoning_content` chunks before the content; content is only the answer; upstream reasoning_tokens forwarded | T1 test 1 (fails on master) |
| A2 | Non-streamed answer has `message.reasoning_content`; no-usage estimate counts reasoning; client `max_completion_tokens` sent upstream as `max_tokens` | T1 test 2 (fails on master) |
| A3 | Chunks are delivered incrementally (no buffering) | T1 test 3 |
| A4 | ACP `agent_thought_chunk` → `onReasoning` in order, `result.reasoning` set, text unaffected | T2 test |
| A5 | Markdown AST correct for the sample; javascript: link rejected; raw `<script>` stays text; unclosed fence is code | T3 test 1 |
| A6 | Highlighter is lossless and classifies keywords/strings/comments/numbers and html tags/attrs | T3 test 2 |
| A7 | `markdown.js` served under the playground CSP; CSP strings unchanged | T3 test 3 (existing CSP asserts) |
| A8 | Live tok/s estimate includes reasoning | T4 test update |
| A9 | Accordion, live markdown, Run preview, TTFT in the real browser | M1-M5 |
| A10 | Whole suite, typecheck and build green | How to run |

## Manual verification (only the real app / browser shows these)

- M1 Gufo (`gufo/Qwen3.8-27B`) and Strata, streamed: the accordion opens at once with "Thinking…" and live text; at the first answer token it collapses to "Thought for N s"; the answer streams as markdown. Re-open it, send another message (re-render): it stays open; reload the page: the old message still has the accordion in the chosen state. Note whether Gufo emits `reasoning_content` (research: inferred only) or inline `<think>`.
- M2 Same with streaming off: accordion closed with "Thoughts"; answer rendered as markdown.
- M3 Claude (and Codex/Antigravity if they think) with a reasoning-heavy prompt: thinking appears in the accordion (depends on the agent sending `agent_thought_chunk`; note per provider).
- M4 Ask for a markdown-heavy answer (headings, table, nested list, quote, code in several languages): renders live without visible lag; a long answer (several thousand words) stays responsive; Copy copies the exact code; a link opens in a new tab; a model-written `<img src=x onerror=alert(1)>` shows as text. DevTools console: no CSP violations.
- M5 AAP-35 regression: "a single html page with a button that changes colour, css and js in separate blocks" → Run and Open in new tab still work; meta line shows TTFT (now first thinking token) and a tok/s that includes thinking.
- M6 A thinking request with `max_tokens: 200` to `gufo/…` ends with `finish_reason: "length"` well before the 5 min timeout.

## How to run

`fnm exec --using default npm.cmd test`, `fnm exec --using default npm.cmd run typecheck`, `fnm exec --using default npm.cmd run build` (plain `npm` via fnm fails on this machine; CI uses yarn with the same scripts). One test file: `fnm exec --using default node node_modules/vitest/vitest.mjs run tests/local-openai.test.ts`. Tests write only under `.claude/temp/<name>-tests`.

## Assumptions to confirm

1. Gufo streams `delta.reasoning_content` like Strata (inferred from gufo.exe strings, not seen live). If it uses inline `<think>`, a follow-up splits it.
2. Upstream `completion_tokens` already includes reasoning tokens (llama-server behaviour), so final tok/s uses it unchanged; only the no-usage estimate adds reasoning.
3. Responses API stays without reasoning items in this ticket (only its usage estimate and local `max_tokens` forwarding change).
4. Reasoning text is shown as plain text, not markdown; a soft line break in answers renders as a line break (keeps today's pre-wrap look).
5. The accordion's open state is persisted with the history (`thinkingOpen`), and the reasoning is stored in the history; on a full quota it is dropped with the images.
6. An answer with reasoning but empty content is kept (meta shown) and resent next turn as an empty assistant message, as any other answer.
7. Only top-level fences are code blocks (same as `splitBlocks` today); a fence indented inside a list item renders as list text.

## Implementation status (2026-11-21, implement)

- [x] T1 (85797f1). Repro on master: test 1 `expected '' to be 'Let me think.'`, test 2 `expected undefined to be 'Let me think.'`, test 3 timed out at 5000 ms (also failed). Deviation: `runGeneration` passes `onText` only when a limit or `emit` is set (always passing it broke tests/proxy.test.ts "cleans chat output" which asserts no `onText` for streamed asJson).
- [x] T2 (6d65180). Deviation: `ToolTurn.reasoning` holds only the current HTTP response's thinking and is reset by `suspend()`, like `text`.
- [x] T3 (fb10304). `parseMarkdown("")` returns `[]`.
- [x] T4 (79dd0db). Deviation: code `figcaption` is always rendered (it carries Copy); `toggle` ignores no-op events so the default open state is not persisted as a choice.
- [x] T5 (f8dd1bd).
- Verification: `npm test` 480 passed / 1 skipped; typecheck and build clean. M1-M6 UNTESTED (need live Gufo/Strata/agents and a browser).
