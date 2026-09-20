# Codex Subscription OpenAI-Compatible Proxy

## Goal

Build a small Node.js/TypeScript server that exposes OpenAI-compatible Models, Chat Completions, and Responses endpoints over a subscription-authenticated Codex ACP backend.

## Agreed constraints

- Use the maintained `@agentclientprotocol/codex-acp` package and official `@agentclientprotocol/sdk`.
- Expose `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna`.
- Support text-only, stateless requests; do not expose tools, files, images, audio, persistent conversations, or function calling.
- Support streaming and non-streaming forms of Chat Completions and Responses.
- Forward caller system/developer instructions by serializing all text conversation roles into the ACP prompt.
- Reject unsupported behavior-changing OpenAI features with clear OpenAI-style errors.
- Bind to localhost by default and enforce a bearer token only when `PROXY_API_KEY` is configured.

## Implementation checklist

- [x] Create a strict TypeScript ESM npm project using Node's built-in HTTP server, Zod, and Vitest.
- [x] Add a long-lived ACP bridge that launches the dependency-resolved `codex-acp` executable over stdio and initializes stable ACP v1.
- [x] Harden ACP sessions for text-only use: isolated temporary cwd, read-only mode, no filesystem/terminal capabilities, disabled subagents, and rejected permission requests.
- [x] Create a fresh session per HTTP request, select the requested model with `session/set_config_option`, stream text updates, capture usage when available, cancel on abort/timeout, and delete the session afterward.
- [x] Implement `GET /healthz` and `GET /v1/models`.
- [x] Implement `POST /v1/chat/completions` with JSON and SSE responses ending in `[DONE]`.
- [x] Implement `POST /v1/responses` with JSON and standard semantic SSE text events.
- [x] Add OpenAI-style validation and error envelopes, request-size limits, timeout handling, optional bearer authentication, graceful shutdown, and ACP child recovery.
- [x] Document setup, ChatGPT login, configuration, supported fields, limitations, curl usage, and OpenAI SDK examples.
- [x] Add deterministic unit/integration/contract tests with a fake ACP bridge plus an opt-in live smoke test.
- [x] Run typecheck, tests, build, and any feasible live smoke verification.

Verification (2026-09-20): `npm run typecheck`, `npm test` (12 passing deterministic tests plus 1 opt-in live test skipped), and `npm run build` pass. Official OpenAI SDK contract coverage exercises models listing, Chat Completions JSON/streaming, and Responses JSON/streaming against a fake bridge. ACP bridge tests cover model selection, usage mapping, permission rejection, cancellation/session cleanup, child spawn recovery, and cancellation when an HTTP client disconnects. Live ACP smoke was not run because it requires an interactive real account login; the documented curl/SDK flow remains opt-in.

## API decisions

- `GET /v1/models` returns exactly the three agreed model IDs.
- Chat input supports `system`, `developer`, `user`, and `assistant` text messages, with string or text-part content.
- Responses input supports a string or text-only message array plus string `instructions`.
- Responses are not stored: omitted/false `store` is accepted and returned as `false`; `store: true` and `previous_response_id` are rejected.
- ACP stop reasons map as follows: `end_turn` to normal completion; `max_tokens` and `max_turn_requests` to length/incomplete; `refusal` to filtered/incomplete; `cancelled` to cancellation.
- ACP usage is mapped when present; Chat usage is omitted and Responses usage is `null` when unavailable.
- Unsupported behavior-changing request fields return HTTP 400; unknown model IDs return HTTP 404; missing/incorrect configured proxy credentials return HTTP 401; ACP/auth availability errors return HTTP 503.

## Acceptance and verification

- The official OpenAI JavaScript SDK can list models and invoke both supported generation endpoints through a custom `baseURL` in streaming and non-streaming modes.
- All three model IDs are routed through ACP session model configuration.
- Permission requests are rejected, abandoned requests cancel their ACP turn, and disposable sessions are deleted.
- Deterministic tests cover normalization, response shapes, SSE framing, stop reasons, usage mapping, validation, authentication, limits, cancellation, and backend failure recovery.
- `npm run typecheck`, `npm test`, and `npm run build` pass.
- A real-login smoke test is available but remains opt-in and is not required for deterministic CI.

## Newly inferred implementation defaults

- Use `127.0.0.1:8787`, a 1 MiB request-body limit, and a five-minute request timeout unless overridden by environment variables.
- Keep one long-lived ACP subprocess and create independent disposable sessions for concurrent HTTP requests.
- Resolve the installed `codex-acp` entry point through Node rather than invoking `npx` or depending on a global binary.
