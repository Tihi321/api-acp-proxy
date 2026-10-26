# ACP Proxy: OpenAI-compatible local proxy for ACP agents

A localhost service that exposes OpenAI-compatible Models, Chat Completions and Responses endpoints on top of [Agent Client Protocol](https://agentclientprotocol.com) (ACP) agents. Three providers are built in:

- **Codex** (OpenAI, through `@agentclientprotocol/codex-acp`), enabled by default.
- **Claude** (Anthropic, through `@agentclientprotocol/claude-agent-acp`, bundled), disabled by default. See [Claude](#claude).
- **Google Antigravity** (through Google's official `agy_acp_server`), disabled by default. See [Antigravity](#google-antigravity) and the [terms / risk note](#terms--risk).

It runs either as a **Windows desktop app** (tray icon, settings window, `.exe`) or as a **headless CLI**. Both share one settings file. Requests carry text and images (audio, files and tools are not accepted), can ask for a generated image (Antigravity and Codex), and are stateless.

## Desktop app (Windows)

Build the installers with `npm run dist` (see [Development](#development)); they are written to `release/`:

| File | What it is |
| --- | --- |
| `ACP-Proxy-Setup-<version>-x64.exe` | NSIS installer |
| `ACP-Proxy-Portable-<version>-x64.exe` | Portable single exe, no install |
| `win-unpacked/ACP Proxy.exe` | Unpacked app, runs as-is |

`npm run dist:installer` or `npm run dist:portable` builds only one of them.

The build is **unsigned**, so Windows SmartScreen shows "Windows protected your PC". Choose "More info", then "Run anyway". Antivirus heuristics may also flag unsigned Electron apps.

The app lives in the system tray and starts the proxy on launch. A second launch re-opens the settings window of the running instance. Closing the settings window hides it to the tray; use **Quit** from the tray to exit. Launch with `--hidden` to start without showing the window.

**Tray menu:** server and per-provider status lines, Start/Stop server, Retry (shown when the server failed to start, for example when the port is in use), Open settings, Copy base URL (`http://host:port/v1`), Refresh models, Open logs folder, Quit. The icon is grey when stopped, green when running and red on error.

**Settings window:** server (host, port, API key with a generator, timeouts, max body size, models wait, launch at login) and one card per provider (enable switch, state, discovered models, auth method, Login). The Antigravity card also has the executable path (Browse), a "Download from registry" button with progress, and the optional `GEMINI_API_KEY` / `GEMINI_HOME`. Fields forced by an environment variable are shown disabled. Saving restarts the server (in-flight requests get up to 5 s to finish). API keys are stored encrypted with Electron `safeStorage` (the file value starts with `enc:`).

**Files** (`%APPDATA%\api-acp-proxy\`, or the folder of `PROXY_SETTINGS_FILE`):

| Path | Content |
| --- | --- |
| `settings.json` | Settings shared by the desktop app and the CLI |
| `logs\proxy.log` | Rotating log (5 MB x 3) |
| `agents\antigravity-acp\` | Antigravity server downloaded from the registry, plus `install.json` |
| `models-cache.json` | Last discovered model lists, so `/v1/models` is fast after a restart |
| `codex-home` | Codex's own home for the proxy (its login, sessions and system skills); see [Codex](#codex) |
| `antigravity-sessions.json` | Session ids created by the proxy, used for purging |

## Headless CLI

Requires Node.js 20 or newer (22 recommended).

```sh
npm install
npm run dev        # tsx, for development
npm run build && npm start   # compiled
```

The default address is `http://127.0.0.1:8787`. On first start `settings.json` is created with defaults. For Codex with a ChatGPT subscription, press **Log in** on the Codex card once and complete the browser login (the proxy uses its own Codex home, so this is one extra login, see [Codex](#codex)), then retry the request. In a browserless environment set `NO_BROWSER=1` and use an API-key login (`CODEX_API_KEY` or `OPENAI_API_KEY`). Login URLs requested by Antigravity are printed to the console.

## Models and providers

Model ids are namespaced as `<provider>/<id>`, for example `codex/gpt-5.6-sol`, `claude/sonnet` or `antigravity/gemini-3.8-flash-low`.

- Codex models are also exposed **unprefixed** (`gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`), so existing clients keep working.
- Claude models are only available prefixed (`claude/<id>`), and are discovered at runtime from the agent.
- Antigravity models are only available prefixed, and are discovered at runtime from the agent (the list depends on your plan and on the server version).
- **Collision rule:** if an unprefixed id would be claimed by two providers, the first provider keeps it and the later one is listed only with its prefix; a warning is logged.
- Only enabled providers are listed. An unknown id returns 404 `model_not_found`.
- `/v1/models` waits up to `PROXY_MODELS_WAIT_MS` for providers that have not finished discovery; a slow provider is omitted from that response. `owned_by` reflects the provider.

## Configuration

Precedence: **environment variable > `settings.json` > defaults**. The settings file is `%APPDATA%\api-acp-proxy\settings.json` (macOS/Linux: the usual config dir) unless `PROXY_SETTINGS_FILE` is set. Setting `PROXY_SETTINGS_FILE` also moves the desktop app's user data and logs next to that file.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PROXY_SETTINGS_FILE` | `%APPDATA%\api-acp-proxy\settings.json` | Settings file location |
| `PROXY_HOST` | `127.0.0.1` | Bind address |
| `PROXY_PORT` | `8787` | HTTP port |
| `PROXY_API_KEY` | unset | Optional bearer token required by all `/v1/*` routes |
| `PROXY_MAX_BODY_BYTES` | `20971520` (20 MiB) | Maximum JSON request body (base64 images count; was 1 MiB before images were accepted) |
| `PROXY_TIMEOUT_MS` | `300000` | Per-request timeout |
| `PROXY_MODELS_WAIT_MS` | `3000` | How long `/v1/models` waits for provider discovery |
| `PROXY_WORK_ROOT` | OS temp directory | Parent for disposable session working directories |
| `PROXY_IGNORE_SAMPLING` | `false` | Drop `temperature`, `top_p`, penalties, `seed` and the Responses `stream_options` instead of answering 400, for clients that always send them (settings: `server.ignoreSampling`) |
| `PROXY_REUSE_SESSIONS` | `false` | Keep an agent session after a completed turn and continue it when the next request extends the same conversation, sending only the new messages (settings: `server.reuseSessions`) |
| `PROXY_CODEX_ENABLED` | `true` | Enable the Codex provider (`1/0`, `true/false`, `yes/no`, `on/off`) |
| `PROXY_CODEX_ISOLATED_HOME` | `true` | Run Codex with its own `CODEX_HOME` (`<data dir>/codex-home`) instead of `~/.codex`; see [Codex](#codex) (settings: `providers.codex.isolatedHome`) |
| `PROXY_ACP_COMMAND` / `PROXY_ACP_ARGS` | dependency-resolved adapter | Custom Codex ACP executable and space-separated arguments |
| `PROXY_CLAUDE_ENABLED` | `false` | Enable the Claude provider |
| `PROXY_CLAUDE_EXECUTABLE` | unset | Path to a `claude` binary (sets `CLAUDE_CODE_EXECUTABLE`; overrides the `executablePath` setting) |
| `PROXY_CLAUDE_ACCEPT_TERMS` | unset | Set to `1` to acknowledge the Claude terms headlessly |
| `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CONFIG_DIR` | unset | Passed through to the Claude agent |
| `PROXY_ANTIGRAVITY_ENABLED` | `false` | Enable the Antigravity provider |
| `PROXY_ANTIGRAVITY_COMMAND` | unset | Path to `agy_acp_server.exe` (overrides the `executablePath` setting) |
| `PROXY_ANTIGRAVITY_ACCEPT_TERMS` | unset | Set to `1` to acknowledge the Antigravity terms headlessly |
| `GEMINI_API_KEY`, `GEMINI_HOME` | unset | Passed through to the Antigravity server |

## Codex

Codex runs through `@agentclientprotocol/codex-acp` (bundled, with its own `codex` binary), in read-only mode with approvals set to "never".

**Own Codex home.** By default (`providers.codex.isolatedHome`, env `PROXY_CODEX_ISOLATED_HOME`) the proxy starts Codex with `CODEX_HOME=<data dir>/codex-home` (`%APPDATA%api-acp-proxycodex-home` on Windows; the folder is created when missing). Your `~/.codex` is not read or written, so none of your Codex skills, plugins, plugin MCP servers or `config.toml` reach proxy requests. Without this, Codex read your skills, ran tools of your plugin MCP servers without asking and printed a "Skill descriptions were shortened" warning as answer text. Turn the setting off to keep using `~/.codex` as before (the shell removal below still applies).

**Log in once.** The new home has no login. Until that login exists (no `auth.json` in the folder and no API key in the environment) the proxy does **not** start a sign-in by itself: Codex shows "needs login" and requests get 503 `provider_auth_required`, with no browser tab opened at start. Press **Log in** on the Codex card (`authenticate chat-gpt`): Codex then opens the ChatGPT sign-in page in your browser itself (the proxy never sees the URL or the tokens). Once `auth.json` exists, a restart signs in silently as before. **Existing users must log in once more after upgrading**, or turn the setting off. `CODEX_API_KEY` / `OPENAI_API_KEY` still work (auth method `api-key`, headless: also `NO_BROWSER=1`). To log out, stop the proxy and delete the `codex-home` folder (Codex keeps its login there by default, in `auth.json`).

**Safety notes.** The proxy sets `approval_policy: "never"`, `sandbox_mode: "read-only"` and removes the shell tools (`features.shell_tool` and `features.unified_exec` are off; read-only `exec_command` reads used to run without any permission request even in read-only mode). Skill lists are left out of the prompt (`skills.include_instructions: false`), plugins and multi-agent are off. These keys win over a `CODEX_CONFIG` environment variable; its other keys are kept. Still on, because Codex gives no way to ask first: **web search** (OpenAI's own, per process; a `"web_search": "disabled"` in `CODEX_CONFIG` turns it off) and the built-in **image generation** tool (it writes into `<codex home>/generated_images`). MCP tool calls still ask for permission and the proxy answers "cancelled".

## Claude

Claude runs through `@agentclientprotocol/claude-agent-acp`, which is bundled together with the native `claude` binary, so nothing needs to be installed.

1. **Acknowledge the terms.** The desktop app shows a warning the first time you enable Claude and stores `termsAcknowledgedAt`. Headless: `PROXY_CLAUDE_ACCEPT_TERMS=1`. Without it the provider reports `terms_required` and does not start.
2. **Enable it** in the UI, or `PROXY_CLAUDE_ENABLED=1`.
3. **Credentials.** Any of these works (set only one to avoid ambiguity): the `apiKey` setting (`ANTHROPIC_API_KEY`), the `oauthToken` setting (`CLAUDE_CODE_OAUTH_TOKEN`, from `claude setup-token`), or the login stored in `~/.claude` (or `configDir`, i.e. `CLAUDE_CONFIG_DIR`). Existing environment variables are passed through. `executablePath` points the adapter at another `claude` binary (`CLAUDE_CODE_EXECUTABLE`).
4. **Log in.** When nobody is signed in the provider shows "needs login" and requests get 503 `provider_auth_required`. The **Log in** button (methods `claude-ai-login` for a subscription and `console-login` for Anthropic Console billing) opens a console window that runs the bundled native `claude auth login` directly; when it finishes the agent restarts and picks up the new login. Headless, run `claude auth login` yourself, or the bundled binary: `node_modules/@anthropic-ai/claude-agent-sdk-<platform>-<arch>/claude auth login --claudeai`.

Model ids are `claude/<id>` (for example `claude/default`, `claude/sonnet`); the list comes from the agent.

**Busy login.** When another Claude Code process holds the OAuth refresh lock (`~/.claude/.oauth_refresh.lock`), the agent fails with "Failed to refresh OAuth token: another Claude Code process is refreshing it". The proxy answers 503 with code `provider_busy` and a `Retry-After: 30` header (the lock cleared after about a minute when seen); retry the request. In a stream that has already started, the error arrives as an SSE error event without the header.

**Safety notes.** Sessions are text-only: the built-in tools are disabled, permission requests are answered with "cancelled", the `default` mode is used and `persistSession: false` keeps transcripts out of `~/.claude/projects`. Settings sources are disabled (`settingSources: []`), so hooks, MCP servers, CLAUDE.md, and the `apiKeyHelper` and `env` entries of `~/.claude/settings.json` are ignored for proxy requests; use the API key / OAuth token fields instead. The CLI still leaves an empty `<config>/projects/<cwd>` directory per session; the proxy removes it after each request (one may remain after a hard kill of the proxy).

### Claude terms / risk

Using a Claude subscription through third-party tooling may conflict with Anthropic's [consumer terms](https://www.anthropic.com/legal/consumer-terms). This proxy uses Anthropic's official agent adapter and never reads your credentials itself, but **use Claude here at your own risk**, or prefer an API key. Nothing here is legal advice, and this project is not affiliated with Anthropic.

## Google Antigravity

1. **Install the server.** Either `npm run antigravity:install` (headless; downloads from the ACP registry into `agents\antigravity-acp\<version>` and verifies the Authenticode signature of Google LLC), or press "Download from registry" on the Antigravity card. Alternatively point `executablePath` / `PROXY_ANTIGRAVITY_COMMAND` at an existing `agy_acp_server.exe`. Only `https` downloads from `cdn.agentclientprotocol.com` and `dl.google.com` are accepted.
2. **Acknowledge the terms.** The desktop app shows a warning the first time you enable Antigravity and stores `termsAcknowledgedAt`. Headless: `PROXY_ANTIGRAVITY_ACCEPT_TERMS=1`. Without it the provider reports `terms_required` and does not start.
3. **Enable it** in the UI, or `PROXY_ANTIGRAVITY_ENABLED=1`.
4. **Log in.** Auth method ids are `oauth-personal` (Log in with Google), `oauth-business`, `gemini-api-key` (set `GEMINI_API_KEY` or the API key field) and `agent-platform`. The proxy authenticates automatically when it can do so without interaction (an explicit method, an API key, or your last successful login). Otherwise the provider shows "needs login" and requests get 503 `auth_required` until you press **Login** (or run the CLI and open the URL it prints). The server does not open a browser itself: it prints an `accounts.google.com` authorize URL and waits for a loopback redirect (`http://127.0.0.1:<random port>/`); the app opens that URL for you, the CLI logs it. Tokens are cached by the server under `%USERPROFILE%\.gemini\antigravity-acp` (or `GEMINI_HOME`).
5. **Models** depend on your plan and the server version (for example `gemini-3.8-flash-high|medium|low` with 1.3.0, a single `gemini-3.8-flash` with 1.4.0). A model that your account cannot use returns 403 `model_not_available`.

**Safety notes.** Antigravity has no read-only mode. The proxy uses the `default` mode (every tool permission is requested from the client) and answers all permission requests with "cancelled" (the one exception: a request that asks for an image allows that session's `generate_image` permission, see "Image generation" under [Supported API](#supported-api)), advertises no filesystem or terminal capabilities, and runs sessions in an empty temporary directory. The server always offers `search_web`, `read_url_content` and `run_command` and asked for them even on plain questions (each cancelled call cost seconds), so every Antigravity prompt carries one extra preamble line telling it not to call any tool.

**Session purge.** The server keeps every session on disk (`<GEMINI_HOME>\antigravity-acp\conversations`, `brain`). With `purgeSessions` (default on) the proxy deletes the files of the sessions it created after the server stops. The proxy stops the whole process tree on exit and, after a hard crash, kills orphaned Antigravity processes of its own install on the next start.

### Terms / risk

Google's Antigravity terms ([clause 6](https://antigravity.google/terms)) restrict using Antigravity to power other products and name third-party token replay as grounds for suspension, and there were reports of account suspensions in early 2026. This proxy uses Google's official ACP server and never touches your OAuth tokens, but routing a non-Antigravity client through it may still be considered a violation. **Use Antigravity here at your own risk**, preferably not with an account you cannot afford to lose. Nothing here is legal advice, and this project is not affiliated with Google or OpenAI.

## Supported API

`GET /healthz` is unauthenticated and returns service health. `GET /v1/models` lists the models of the enabled providers (see [Models and providers](#models-and-providers)).

`POST /v1/chat/completions` accepts `model`, `messages`, and `stream`. Messages may have `system`, `developer`, `user`, or `assistant` roles and string or part-array content (`text` parts, and `image_url` parts in user messages, see [Images](#images)). `stream_options.include_usage: true` adds a final chunk with empty `choices` and the `usage` object before `data: [DONE]` (every other chunk then carries `usage: null`). Streaming uses standard `text/event-stream` frames and terminates with `data: [DONE]`.

Both endpoints always report usage (`prompt_tokens` / `completion_tokens` / `total_tokens` with `prompt_tokens_details.cached_tokens` and `completion_tokens_details.reasoning_tokens` for chat; `input_tokens` / `output_tokens` / `total_tokens` with the matching `*_details` for Responses). The numbers come from the agent when it reports them; otherwise they are estimated at about 4 characters per token.

`POST /v1/responses` accepts a string or a message-array `input` (including system/developer instructions; content parts `input_text`, `output_text`, `text` and, in user messages, `input_image`), optional string `instructions`, `stream`, and `store: false`, and `max_output_tokens`. Responses are never persisted; `store: true`, `previous_response_id`, and `stream_options` are rejected. Streaming emits semantic Responses API events followed by `[DONE]`.

**Token limits.** `max_tokens` / `max_completion_tokens` (chat; send only one) and `max_output_tokens` (Responses) are honoured. ACP has no per-request output limit, so the proxy counts the visible answer with the same estimate of about 4 characters per token, stops at the limit, cancels the agent turn and answers with `finish_reason: "length"` (Responses: `status: "incomplete"` with `incomplete_details.reason: "max_output_tokens"`). A cut answer is at most 4 characters per token of the limit, and `usage` is then estimated from the text that was returned. Reasoning text is not counted and the estimate undercounts most non-English text, so the cut is lenient: it never stops much earlier than a real token limit would. With a JSON format the limit applies to the raw answer, so a cut JSON answer is returned as is.

**JSON output.** Chat Completions accepts `response_format` (`text`, `json_object`, or `json_schema` with `json_schema: { name, schema, strict, description }`) and Responses accepts `text.format` (the same three types, with `name` / `schema` / `strict` / `description` inline). The agents cannot enforce a schema, so the proxy adds an output-format instruction to the prompt (including the JSON Schema when given) and cleans the answer by stripping Markdown code fences and prose around the JSON. The answer is not validated against the schema: if the agent still returns something that is not valid JSON, the text is returned as is. With a JSON format, streaming sends the cleaned JSON as a single delta once the agent has finished instead of token by token. Other `text` options (such as `verbosity`) are rejected.

**Session reuse.** With `PROXY_REUSE_SESSIONS=1` (settings: `server.reuseSessions`) a session is kept after a turn that ended normally (not cancelled, not cut by a token limit, not failed). The next request continues it when it has the same model and its messages up to the last assistant message equal what the proxy saw: the same roles, the same non-assistant content (an image counts by the SHA-256 of its bytes, so the same image matches and a different one does not), and every assistant message a non-empty part of the answer the agent gave (so JSON-extracted answers still match), followed by at least one new message. Only the new messages are sent to the agent, which keeps its own context. A kept session is used by one request at a time, at most 8 are kept (the oldest is dropped), an idle one is dropped after 10 minutes, and all are dropped when the proxy or the agent stops. Any other request starts a fresh session.

**Images.** User messages may carry images: chat `{ "type": "image_url", "image_url": { "url": ..., "detail": ... } }`, Responses `{ "type": "input_image", "image_url": ..., "detail": ... }` (`detail` is accepted and ignored).
- **URLs.** A `data:` URL must be base64 (`data:image/png;base64,...`) and is decoded by the proxy. An `http://` or `https://` URL is downloaded by the proxy itself (the agents never get a URL: Codex and Claude reject one and Antigravity hangs on it): at most 15 s, at most 3 redirects (only to http or https), the answer must be `image/*`, at most 10 MB. The download sends no API key and no client header, only `Accept`. The proxy fetches whatever URL the client names, from the machine it runs on.
- **Types.** PNG, JPEG, GIF and WebP only, checked by the first bytes of the file as well as the declared type (a `data:` URL whose type does not match its bytes is rejected). Images are only accepted in user messages. The agent gets every image as a base64 block after the text of its message; a request without images sends exactly the text it always did.
- **Limits.** 10 MB per image and `PROXY_MAX_BODY_BYTES` (20 MiB by default) for the whole request body. Token usage is the agent's own when it reports it; the estimate used otherwise counts only the text.
- **Errors (400).** `unsupported_content`: a part type other than text and images (`file`, `input_file`, `input_audio`, ...), an image given as `file_id`, an image in a system, developer or assistant message, a type other than PNG, JPEG, GIF or WebP, or an agent that does not accept image input (`param` is `messages` for chat, `input` for Responses; Codex, Claude and Antigravity all accept images). `invalid_image_url`: a malformed or unreachable URL, bad base64, a download that times out or redirects too often, or an image over 10 MB. In a streamed request, an error found while the agent starts is sent as an SSE error event instead.

**Image generation.** Antigravity (its `generate_image` tool) and Codex (its built-in image tool) can draw; Claude cannot. Three ways to ask:
- `POST /v1/images/generations` with `{ model, prompt, n?: 1, size?, quality?, background?, response_format?: "b64_json", output_format? }` answers `{ created, data: [{ b64_json, revised_prompt? }], output_format }`. `model` is a chat model id of a provider that can draw (for example `antigravity/gemini-3.8-flash-low` or `codex/gpt-5.6-luna`). `size` (`WIDTHxHEIGHT` or `auto`) becomes an aspect-ratio hint in the prompt (`1536x1024` is "3:2"), `quality` and `background` are passed as hints; the agent decides the real size and style. `output_format` is accepted but the agent decides the format (Antigravity JPEG, Codex PNG): the `output_format` of the answer is the type of the image actually returned. `revised_prompt` is Codex's own rewrite of the prompt.
- `POST /v1/responses` with `tools: [{ "type": "image_generation" }]` adds an `image_generation_call` output item (`{ id, type, status: "completed", result: <base64>, revised_prompt?, output_format }`) before the message; streamed, it arrives as `response.output_item.added` / `done` events and the message follows it, its text in one piece (the stream does not carry text live for these requests). The tool's own options (`size`, `quality`, ...) are accepted and ignored; `partial_images` is a 400. `tool_choice` is accepted only as `auto`, `required` or `{ "type": "image_generation" }` next to the tool. Any other tool type is rejected as before.
- `POST /v1/chat/completions` with `modalities: ["text", "image"]` returns `message.images: [{ index, type: "image_url", image_url: { url: "data:image/png;base64,..." } }]` (streamed: one `delta.images` chunk before the finish chunk). Other modalities are rejected.
- **Errors.** 400 `unsupported_parameter` for `n` above 1, `response_format: "url"` (the proxy has no place to host images), `mask` / `image` (edits), `stream` and `partial_images`; 400 `model_not_capable` for a model whose provider cannot draw (Claude); 502 `no_image_generated` when the answer holds no image (the agent's own words, for example a refusal, are in the message). One image is returned per request.
- **Permissions and files.** The image comes from the agent's own update, not from a file. Antigravity asks permission for `generate_image`: only a request that asked for an image allows it, only that one session, only the `allow_once` option (never `allow_always`); every other request, and every other permission, stays cancelled. Codex asks no permission for its image tool and also draws in requests that never asked (the image is then dropped). The agent also writes the image to disk (Antigravity `<GEMINI_HOME>/antigravity-acp/brain/<session>`, Codex `<CODEX_HOME>/generated_images/<thread>`, the proxy's own home unless `isolatedHome` is off); the proxy deletes that file after the request (Codex: always, and the emptied `<thread>` folder with it), but only when its path resolves inside that folder. A Codex image update is about 6 MB on one line; the proxy takes it and never logs it. Generation takes about 20 s (Antigravity) to 40 s (Codex); raise `PROXY_TIMEOUT_MS` if your clients wait longer.

Tools, files, audio, function calling, persistent conversations, and other behavior-changing options are intentionally rejected. Each request gets a fresh ACP session in an isolated temporary directory (Codex: read-only mode), unless session reuse is on. Permission requests are denied (except the image permission of an image request, above) and no client filesystem or terminal capabilities are advertised.

## curl

```sh
curl http://127.0.0.1:8787/v1/models
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"gpt-5.6-sol","messages":[{"role":"user","content":"Say hello"}]}'
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"antigravity/gemini-3.8-flash-low","messages":[{"role":"user","content":"Say hello"}]}'
curl http://127.0.0.1:8787/v1/responses \
  -H 'content-type: application/json' \
  -d '{"model":"gpt-5.6-luna","input":"Say hello"}'
```

When an API key is configured, add `-H "authorization: Bearer $PROXY_API_KEY"`.

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

## Development

The project uses **npm only**. Yarn (PnP files, `.yarn/`, `yarn.lock`) was removed; use `package-lock.json` and `npm ci`.

```sh
npm ci
npm run typecheck      # core + Electron main, and the renderer
npm test               # vitest; deterministic, uses fake ACP agents on loopback only
npm run build          # tsc (core, Electron, renderer) + copy static assets
npm run app:dev        # build and start the desktop app from source
npm run dist           # build, package NSIS + portable into release/, then verify-package
npm run dist:installer # only release/ACP-Proxy-Setup-<version>-x64.exe, then verify-package
npm run dist:portable  # only release/ACP-Proxy-Portable-<version>-x64.exe, then verify-package
npm run dist:dir       # unpacked build only (release/win-unpacked)
npm run verify:package # check release/win-unpacked (codex-acp handshake under ELECTRON_RUN_AS_NODE)
npm run probe -- <cmd> [args]   # print an ACP agent's initialize authMethods, modes, config options
npm run antigravity:install
npm run icons          # regenerate assets/ and build/icon.ico (app icon is the pixel sprite in scripts/make-icons.mjs)
```

Runnable JavaScript examples (health, models, both API styles, streaming, a terminal chatbot) are in [examples/README.md](examples/README.md).

The tests need no network access and no real agent. A real-login smoke test is deliberately opt-in (`RUN_LIVE_SMOKE=1`).

Dev-only hook: if `ACP_PROXY_DEV_DIR` is set, the desktop app watches that folder: creating `quit` quits the app and `dump` writes a state dump (unpackaged builds also support `shot` and `eval.js`).

CI (`.github/workflows/ci.yml`) runs typecheck, tests and build on every push and pull request, and builds the installers on `v*` tags.
