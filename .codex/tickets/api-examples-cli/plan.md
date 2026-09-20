# API Examples and CLI Chatbot

## Goal

Add runnable JavaScript examples covering every proxy endpoint and both generation modes, plus a simple interactive chatbot that retains conversation messages in memory for the current run.

## Agreed constraints

- Use JavaScript examples only.
- Assume the proxy is already running before an example starts.
- Keep chatbot history only for the current process; do not persist it to disk.
- Use non-streaming Chat Completions in the chatbot to keep its loop straightforward.
- Do not change the proxy's public HTTP behavior.

## Implementation checklist

- [x] Add a shared example client using `PROXY_URL` (default `http://127.0.0.1:8787`), `PROXY_API_KEY` (local placeholder when unset), and `PROXY_MODEL` (default `gpt-5.6-sol`).
- [x] Add `examples/basic.js` covering health, model listing, non-streaming Chat Completions, and non-streaming Responses.
- [x] Add `examples/streaming.js` covering streaming Chat Completions and Responses and printing text deltas.
- [x] Add `examples/chatbot.js` with an interactive terminal loop, in-memory user/assistant history, empty-input handling, `/clear`, `/exit`, and `/quit`.
- [x] Ensure failed chatbot requests do not add incomplete turns to history.
- [x] Add `examples/README.md` with startup, configuration, commands, and expected behavior.
- [x] Add `example:basic`, `example:streaming`, and `example:chatbot` npm scripts.
- [x] Move `openai` from development dependencies to runtime dependencies.
- [x] Link the examples from the main README.
- [x] Add deterministic tests that run the examples against the existing fake bridge and cover chatbot prompt/exit and history clearing.
- [x] Run typecheck, tests, build, and JavaScript syntax checks for every example.

## Acceptance and verification

- The basic example reports health, all three models, Chat output, and Responses output.
- Both streaming calls print received text.
- The chatbot accepts terminal input, sends prior successful turns on later requests, prints the assistant response, and exits cleanly.
- `/clear` removes earlier turns from subsequent requests.
- All verification commands pass without using a real subscription request.

## Newly inferred implementation details

- Put common OpenAI client/environment construction in a small shared module under `examples/`.
- Give each executable a top-level error handler that prints a useful message and sets a nonzero exit code.
- Exercise executable examples as child processes from Vitest while a fake-backed proxy listens on an ephemeral local port.

## Implementation results

- Added `examples/client.js`, `basic.js`, `streaming.js`, `chatbot.js`, and `examples/README.md`.
- Added `tests/examples.test.ts` with child-process coverage for all examples, chatbot history retention, `/clear`, exit handling, and failed-request isolation.
- Added the three npm example scripts and moved `openai` to runtime dependencies in `package.json` and `package-lock.json`.
- Linked the examples from the main README.
- Verification: `npm run typecheck` passed; `npm test` passed (16 tests, 1 intentionally skipped live smoke test), including empty-input handling; `npm run build` passed; `node --check` passed for every example file.
- No real subscription backend was contacted.
