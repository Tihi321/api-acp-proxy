---
status: done
request: creative-hub/REQ-0030
repos: [api-acp-proxy]
branch: AAP-42_local-thinking
updated: 2026-11-21
---

# AAP-42 Local servers get the client's thinking switch (`reasoning_effort`, `chat_template_kwargs`)

Part of creative-hub HUB-38 "ACP for all" (`C:\projects\Personal\creative-hub\.claude\tickets\HUB-38-acp-for-all\plan.md`, contract C6). Every creative-hub app now sends its local-model requests through this proxy (`gufo/*`, `strata/*`, `llama/*`). Their rows send `reasoning_effort: "none"` (merged into the request body from `extra_body`) because thinking on made a short answer take minutes instead of seconds. Today `LocalOpenAiProvider.generate` builds the upstream body from `model, messages, stream, stream_options, max_tokens` only (`src/providers/local-openai.ts:166`), so the field is lost and the local model always thinks.

Starts after AAP-40 (`AAP-40_llama-model-picker`) and AAP-41 (playground redesign, another session's ticket) are merged: one working tree, and AAP-40 touches `settings.ts` and `electron/main.ts` (not this ticket's files, but the tree must be clean to branch).

## Scope

1. A chat completion (`POST /v1/chat/completions`) to a local provider forwards two client fields upstream when present: `reasoning_effort` (string) and `chat_template_kwargs` (plain object). Absent fields are not sent.
2. The ACP providers (codex, antigravity, claude) are unchanged: they ignore both (ROADMAP "reasoning_effort ... not passed on" stays open for them).
3. README: the local-provider section names the two forwarded fields; ROADMAP line.

## Out of scope

- The Responses API (`/v1/responses`, `reasoning.effort`), mapping effort for Codex/Claude, a per-request thinking-off toggle for ACP agents.
- `stop`, `temperature`, `top_p`, `seed`, `top_k`, `min_p`, `response_format` forwarding; tools for local models.
- Image routes, embeddings (AAP-43).

## Files and tasks

- T1 `src/provider.ts:21` `GenerateOptions`: add `reasoningEffort?: string` and `chatTemplateKwargs?: Record<string, unknown>` with a doc comment ("local OpenAI-compatible providers forward them upstream as `reasoning_effort` / `chat_template_kwargs`; ACP providers ignore them").
- T2 `src/api.ts` chat normalisation (the function that returns the object at `:404`): read `parsed.data.reasoning_effort` when it is a non-empty string and `parsed.data.chat_template_kwargs` when it is a plain object (the schema already lets unknown fields through with `.passthrough()`, `:62`); add them to `NormalizedRequest` (`:158`) as `reasoningEffort` / `chatTemplateKwargs`. Do not add them to `droppedChatFields` or `unsupportedChatFields`. A wrong type (number, array) is ignored, not a 400.
- T3 `src/server.ts:198` (chat handler `options`): spread `reasoningEffort` and `chatTemplateKwargs` into `GenerateOptions` when set. `:277` (Responses) unchanged.
- T4 `src/providers/local-openai.ts:166`: the upstream JSON body adds `...(options?.reasoningEffort !== undefined ? { reasoning_effort: options.reasoningEffort } : {})` and the same for `chat_template_kwargs`.
- T5 README local-provider section (near "Sampling passthrough", README:142): one sentence "`reasoning_effort` and `chat_template_kwargs` are forwarded to Gufo, Strata and Llama.cpp as sent (AAP-42); what they do depends on the server (Strata and llama-server with a Qwen template turn thinking off with `reasoning_effort: none` or `chat_template_kwargs: {enable_thinking: false}`)." Do not claim more than that; the effect per server is a live check.
- T6 ROADMAP: under the local items add `- [x] Local servers get reasoning_effort and chat_template_kwargs (AAP-42; live check UNTESTED)`.

Contract with other tickets: creative-hub C6 (the apps send `reasoning_effort: none` on their local rows). AAP-43 builds on the same `local-openai.ts`; keep the body construction readable (one object literal with the conditional spreads).

## Acceptance and tests

- A1 A chat request to a local model with `reasoning_effort: "none"` and `chat_template_kwargs: {enable_thinking: false}` reaches the upstream body with both fields; without them, the upstream body has neither. Test: one table-driven case in `tests/local-openai.test.ts` (extend the existing upstream-body test there; the fake fetch already captures the body): rows "both set", "neither set".
- A2 An ACP provider request with `reasoning_effort` behaves as before (no 400, field not forwarded anywhere). Covered by the existing `tests/proxy.test.ts` suite passing; no new test.
- A3 `npm test` (vitest) and `npm run typecheck` pass.
- Live (UNTESTED unless run by the hub's HUB-38 check C4, which loads Strata onto the GPU with the user's go-ahead): a curl to `strata/qwen3.8-flash-next-unsloth-ud-iq4_xs` with `reasoning_effort: "none"` returns no `reasoning_content`, and the header `x-acp-proxy-ignored-params` does not list it.

## ROADMAP row

`- [x] Local servers get reasoning_effort and chat_template_kwargs (AAP-42; live check UNTESTED): forwarded to Gufo, Strata and Llama.cpp as sent, so a client can turn thinking off per request (creative-hub HUB-38).`
