# JavaScript examples

These examples use the official OpenAI JavaScript SDK against the local proxy. Start the proxy first:

```sh
npm start
```

Then run an example from the project root:

```sh
npm run example:basic
npm run example:streaming
npm run example:chatbot
```

The examples use these environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PROXY_URL` | `http://127.0.0.1:8787` | Proxy origin, including a non-default port when needed |
| `PROXY_API_KEY` | `local` | Bearer token sent to the proxy |
| `PROXY_MODEL` | `gpt-6-luna` | Model used by the examples. May be a provider-prefixed id, e.g. `codex/gpt-6-luna` or `antigravity/gemini-3.8-flash-low`. The Codex list comes from Codex itself and depends on your plan and the codex-acp version, so check `GET /v1/models` and set this if `gpt-6-luna` is not listed |

`basic.js` checks health, lists models, and makes non-streaming Chat Completions and Responses requests. `streaming.js` makes both streaming requests and prints received text deltas as they arrive.

`chatbot.js` keeps successful user and assistant messages in memory for the current process. Empty input is ignored with a helpful message. Use `/clear` to remove the current conversation, or `/exit` / `/quit` to leave. A failed request is not added to the conversation history.
