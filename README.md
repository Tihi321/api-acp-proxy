# Codex Subscription OpenAI-Compatible Proxy

Small localhost Node.js/TypeScript service that exposes OpenAI-compatible Models, Chat Completions, and Responses endpoints over the maintained `@agentclientprotocol/codex-acp` adapter. It is intended for a local ChatGPT subscription login (or an ACP-supported API key), and accepts text-only stateless requests.

## Setup

Requires Node.js 20 or newer.

```sh
npm install
npm run build
```

Start the proxy with `npm start` (or use `npm run dev` while developing). The default address is `http://127.0.0.1:8787`. On first use, the ACP adapter may ask Codex to authenticate. For a ChatGPT subscription, complete the browser login requested by Codex and then retry the request. In a browserless environment set `NO_BROWSER=1` and use an API-key login instead (`CODEX_API_KEY` or `OPENAI_API_KEY`).

Configuration is controlled by environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PROXY_HOST` | `127.0.0.1` | Bind address |
| `PROXY_PORT` | `8787` | HTTP port |
| `PROXY_API_KEY` | unset | Optional bearer token required by all `/v1/*` routes |
| `PROXY_MAX_BODY_BYTES` | `1048576` | Maximum JSON request body |
| `PROXY_TIMEOUT_MS` | `300000` | Per-request timeout |
| `PROXY_WORK_ROOT` | OS temp directory | Parent for disposable session working directories |
| `PROXY_ACP_COMMAND` / `PROXY_ACP_ARGS` | dependency-resolved adapter | Optional custom ACP executable and space-separated arguments |

## Supported API

`GET /healthz` is unauthenticated and returns service health. `GET /v1/models` returns exactly `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna`.

`POST /v1/chat/completions` accepts `model`, `messages`, and `stream`. Messages may have `system`, `developer`, `user`, or `assistant` roles and string or text-part content. Token limits and `stream_options` are rejected because ACP does not expose a reliable per-request equivalent. Streaming uses standard `text/event-stream` frames and terminates with `data: [DONE]`.

`POST /v1/responses` accepts a string or text-only message-array `input` (including system/developer instructions), optional string `instructions`, `stream`, and `store: false`. Responses are never persisted; `store: true`, `previous_response_id`, token limits, and `stream_options` are rejected. Streaming emits semantic Responses API events (`response.created`, output item/content events, text deltas, and `response.completed`) followed by `[DONE]`.

Tools, files, images, audio, function calling, persistent conversations, and other behavior-changing options are intentionally rejected. Each request gets a fresh read-only ACP session in an isolated temporary directory. Permission requests are denied and no client filesystem or terminal capabilities are advertised.

## curl

```sh
curl http://127.0.0.1:8787/v1/models
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"gpt-5.6-sol","messages":[{"role":"user","content":"Say hello"}]}'
curl http://127.0.0.1:8787/v1/responses \
  -H 'content-type: application/json' \
  -d '{"model":"gpt-5.6-luna","input":"Say hello"}'
```

When `PROXY_API_KEY` is set, add `-H "authorization: Bearer $PROXY_API_KEY"`.

## OpenAI JavaScript SDK

```ts
import OpenAI from "openai";
const openai = new OpenAI({ apiKey: process.env.PROXY_API_KEY || "local", baseURL: "http://127.0.0.1:8787/v1" });
console.log(await openai.models.list());
const answer = await openai.chat.completions.create({ model: "gpt-5.6-sol", messages: [{ role: "user", content: "Hello" }] });
console.log(answer.choices[0]?.message.content);
const stream = await openai.responses.create({ model: "gpt-5.6-terra", input: "Hello", stream: true });
for await (const event of stream) console.log(event);
```

## Development and verification

Runnable JavaScript examples for health, model listing, both API styles, streaming, and an in-memory terminal chatbot are documented in [examples/README.md](examples/README.md).

```sh
npm run typecheck
npm test
npm run build
```

The deterministic tests use a fake ACP bridge. A real-login smoke test is deliberately opt-in: start the proxy with your environment configured, finish the Codex login, and call either endpoint with curl or the official OpenAI SDK.
