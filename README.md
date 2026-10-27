# ACP Proxy: OpenAI-compatible local proxy for ACP agents

A localhost service that exposes OpenAI-compatible Models, Chat Completions and Responses endpoints on top of [Agent Client Protocol](https://agentclientprotocol.com) (ACP) agents. Three providers are built in:

- **Codex** (OpenAI, through `@agentclientprotocol/codex-acp`), enabled by default.
- **Claude** (Anthropic, through `@agentclientprotocol/claude-agent-acp`, bundled), disabled by default. See [Claude](#claude).
- **Google Antigravity** (through Google's official `agy_acp_server`), disabled by default. See [Antigravity](#google-antigravity) and the [terms / risk note](#terms--risk).

It runs either as a **Windows desktop app** (tray icon, settings window, `.exe`) or as a **headless CLI**. Both share one settings file. Requests carry text and images (audio and files are not accepted), can call your function tools (OpenAI function calling, all three providers), can ask for a generated image (Antigravity and Codex), can let the agent search the web (with citations), and are stateless.

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

**Tray menu:** the server line, one line per provider with its state and account (`Claude: ready - me@example.com (5 models)`), a line with today's request count, **Log in to X** for every provider that needs login, Start/Stop server, Retry (shown when the server failed to start, for example when the port is in use), Open settings, Copy base URL (`http://host:port/v1`), Refresh models, Open logs folder, Quit. The tooltip shows the address, `N requests today, last 2 min ago` and the providers that need login. The icon is grey when stopped, green when running and red on error. When a request hits a provider that needs login, the app shows a one-time notification ("Codex needs login") and the icon turns amber until that provider is signed in.

**Overview (top of the settings window).** Answers "am I signed in, and what can it do" without sending a request: one row per provider with its state badge, the signed-in account when the agent reports one (Claude does), the capability chips (images in, image generation, tools, MCP, web search; "images in" appears once the agent has started), the model count, and where the login is kept (`Login kept in <folder>`, with a note when that is your own `~/.codex`, `~/.claude` or `~/.gemini`). Codex in its own home shows **needs login** from the start as long as that home has no `auth.json` (and no API key is set); the check is a file-exists test, nothing is started or opened. The card also shows the API address with a copy button, an **MCP** line with the address of the proxy's own MCP endpoint (`<API address>/mcp`) and a **Copy command** button that copies the `claude mcp add ...` line for it (see [MCP server (for harnesses)](#mcp-server-for-harnesses); with an API key set the command carries a `--header` placeholder, never the key), and the configured MCP servers (`settings.mcpServers`, read-only: label, transport and URL or command, never headers, env, arguments or query strings) with an **Open settings.json** button.

**Log in and log out.** Each overview row has **Log in** (it uses the sign-in method picked on the provider card) and **Log out**. Log out asks first and names what it will do; for a login in your own tool folder (`~/.codex`, `~/.claude`, `~/.gemini`) it says plainly that this signs you out of that tool on this computer, not only in the proxy. How it works per agent:

| Agent | Log out does |
| --- | --- |
| Codex | ACP `logout` (the bundled codex-acp advertises it and calls Codex's `account/logout`). In the proxy's own home the proxy then also removes `<data dir>codex-homeauth.json`, the only file it ever deletes for this, so the home surely has no login. An agent that did not advertise `logout` would be stopped, `auth.json` deleted and the agent restarted into needs login. With `isolatedHome` off the proxy deletes nothing itself: the log-out only happens through the agent. |
| Claude | ACP `logout` (the adapter runs `claude auth logout` itself and re-reads the credentials: an `ANTHROPIC_API_KEY` from the environment or the settings survives, and the account label updates accordingly). Fallback for an adapter without it: the bundled `claude auth logout`, run hidden, then a restart. |
| Antigravity | ACP `logout` of `agy_acp_server`. |

After a log-out the provider shows needs login, kept and warm agent sessions are dropped, requests to it fail with 503 `provider_auth_required` until you log in again, and API keys or tokens saved in the settings are not touched. Log out is disabled for a provider that is already signed out.

**Recent requests.** The window lists the last 20 requests, newest first: time, endpoint, model, what the request used (image in, image out, tools, MCP, search), duration, status or error code, and token counts, plus a **Clear** button. The log is a ring buffer of the last 100 requests, **in memory only** (gone when the app quits), and holds no prompt text, no answer, no headers and no keys; the tray tooltip counts the requests of the day from it. `/healthz` and the tool bridge are not listed.

**Settings window:** server (host, port, API key with a generator, timeouts, max body size, models wait, the tool result wait, launch at login) and one card per provider (enable switch, state, discovered models, auth method, Login). The Antigravity card also has the executable path (Browse), a "Download from registry" button with progress, and the optional `GEMINI_API_KEY` / `GEMINI_HOME`. Fields forced by an environment variable are shown disabled. Saving restarts the server (in-flight requests get up to 5 s to finish). API keys are stored encrypted with Electron `safeStorage` (the file value starts with `enc:`).

**Files** (`%APPDATA%\api-acp-proxy\`, or the folder of `PROXY_SETTINGS_FILE`):

| Path | Content |
| --- | --- |
| `settings.json` | Settings shared by the desktop app and the CLI |
| `logs\proxy.log` | Rotating log (5 MB x 3) |
| `agents\antigravity-acp\` | Antigravity server downloaded from the registry, plus `install.json` |
| `mcp-images\` | Images that `generate_image` of the [MCP server](#mcp-server-for-harnesses) saved when the caller gave no `save_to` (newest 100, at most 7 days) |
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

Model ids are namespaced as `<provider>/<id>`, for example `codex/gpt-6-luna`, `claude/sonnet` or `antigravity/gemini-3.8-flash-low`.

- Codex models are discovered at runtime from the agent, like the others, and are also exposed **unprefixed** (`gpt-6-luna` and `codex/gpt-6-luna` both work), so existing clients keep working. The list depends on your ChatGPT plan and on the bundled codex-acp version (with codex-acp 2.3.0 a ChatGPT Go account gets `gpt-6-luna`, `gpt-5.6-terra` and `gpt-5.6-luna`; `gpt-5.6-sol` is gone), so check `GET /v1/models` instead of assuming ids. Until the first discovery has finished (a first start, with no models cache yet) an unprefixed id is passed to Codex as it is.
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
| `PROXY_TOOL_RESULT_TIMEOUT_MS` | `600000` | How long a request that ended with tool calls waits for the next request to bring the results, before the agent turn is cancelled. Cut to the agent's own limit minus 30 s: 150 s for Antigravity, 270 s for Codex; see [Function calling](#function-calling) (settings: `server.toolResultTimeoutMs`) |
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

**Own Codex home.** By default (`providers.codex.isolatedHome`, env `PROXY_CODEX_ISOLATED_HOME`) the proxy starts Codex with `CODEX_HOME=<data dir>/codex-home` (`%APPDATA%\api-acp-proxy\codex-home` on Windows; the folder is created when missing). Your `~/.codex` is not read or written, so none of your Codex skills, plugins, plugin MCP servers or `config.toml` reach proxy requests. Without this, Codex read your skills, ran tools of your plugin MCP servers without asking and printed a "Skill descriptions were shortened" warning as answer text. Turn the setting off to keep using `~/.codex` as before (the shell removal below still applies).

**Log in once.** The new home has no login. Until that login exists (no `auth.json` in the folder and no API key in the environment) the proxy does **not** start a sign-in by itself: Codex shows "needs login" and requests get 503 `provider_auth_required`, with no browser tab opened at start. Press **Log in** on the Codex card (`authenticate chat-gpt`): Codex then opens the ChatGPT sign-in page in your browser itself (the proxy never sees the URL or the tokens). Once `auth.json` exists, a restart signs in silently as before. **Existing users must log in once more after upgrading**, or turn the setting off. `CODEX_API_KEY` / `OPENAI_API_KEY` still work (auth method `api-key`, headless: also `NO_BROWSER=1`). To log out, press **Log out** on the Codex row of the overview (see [Log in and log out](#desktop-app-windows)); by hand, stop the proxy and delete `auth.json` in the `codex-home` folder. The settings window shows the folder under the checkbox, with an **Open folder** button.

**Troubleshooting: "Codex needs login".** After upgrading to the own home, after a log-out, or on a fresh install, the Codex row shows **needs login**, and requests to `gpt-5.6-*` / `codex/*` answer 503 `provider_auth_required` (the tray shows a notification the first time). Nothing is broken: press **Log in** on the Codex row or card (or **Log in to Codex** in the tray menu), finish the ChatGPT sign-in in the browser tab Codex opens, and retry. If you would rather keep using your own `~/.codex` login, turn off "Use a separate Codex home" and save. With an API key instead, set `CODEX_API_KEY` or `OPENAI_API_KEY` (the row then shows stopped until the first request).

**Safety notes.** The proxy sets `approval_policy: "never"`, `sandbox_mode: "read-only"` and removes the shell tools (`features.shell_tool` and `features.unified_exec` are off; read-only `exec_command` reads used to run without any permission request even in read-only mode). Skill lists are left out of the prompt (`skills.include_instructions: false`), plugins and multi-agent are off. These keys win over a `CODEX_CONFIG` environment variable; its other keys are kept. Still on, because Codex gives no way to ask first: **web search** (OpenAI's own, per process; a `"web_search": "disabled"` in `CODEX_CONFIG` turns it off; see "Web search" under [Supported API](#supported-api)) and the built-in **image generation** tool (it writes into `<codex home>/generated_images`). MCP tool calls still ask for permission and the proxy answers "cancelled", except the `client` tools of a request with function tools and the tools of the MCP servers a request names (see "Function calling" and "MCP servers" under [Supported API](#supported-api)).

## Claude

Claude runs through `@agentclientprotocol/claude-agent-acp`, which is bundled together with the native `claude` binary, so nothing needs to be installed.

1. **Acknowledge the terms.** The desktop app shows a warning the first time you enable Claude and stores `termsAcknowledgedAt`. Headless: `PROXY_CLAUDE_ACCEPT_TERMS=1`. Without it the provider reports `terms_required` and does not start.
2. **Enable it** in the UI, or `PROXY_CLAUDE_ENABLED=1`.
3. **Credentials.** Any of these works (set only one to avoid ambiguity): the `apiKey` setting (`ANTHROPIC_API_KEY`), the `oauthToken` setting (`CLAUDE_CODE_OAUTH_TOKEN`, from `claude setup-token`), or the login stored in `~/.claude` (or `configDir`, i.e. `CLAUDE_CONFIG_DIR`). Existing environment variables are passed through. `executablePath` points the adapter at another `claude` binary (`CLAUDE_CODE_EXECUTABLE`).
4. **Log in.** When nobody is signed in the provider shows "needs login" and requests get 503 `provider_auth_required`. The **Log in** button (methods `claude-ai-login` for a subscription and `console-login` for Anthropic Console billing) opens a console window that runs the bundled native `claude auth login` directly; when it finishes the agent restarts and picks up the new login. Headless, run `claude auth login` yourself, or the bundled binary: `node_modules/@anthropic-ai/claude-agent-sdk-<platform>-<arch>/claude auth login --claudeai`.

Model ids are `claude/<id>` (for example `claude/default`, `claude/sonnet`); the list comes from the agent.

**Busy login.** When another Claude Code process holds the OAuth refresh lock (`~/.claude/.oauth_refresh.lock`), the agent fails with "Failed to refresh OAuth token: another Claude Code process is refreshing it". The proxy answers 503 with code `provider_busy` and a `Retry-After: 30` header (the lock cleared after about a minute when seen); retry the request. In a stream that has already started, the error arrives as an SSE error event without the header.

**Safety notes.** Sessions are text-only: the built-in tools are disabled, permission requests are answered with "cancelled" (a request with function tools adds the `client` MCP server and `allowedTools: ["mcp__client__*"]` for that session only; a request with `mcp` tools adds those servers and `allowedTools` for their tools, see "MCP servers" under [Supported API](#supported-api); a request with web search sets `tools: ["WebSearch"]` and `allowedTools: ["WebSearch"]`, never `WebFetch`, see "Web search"), the `default` mode is used and `persistSession: false` keeps transcripts out of `~/.claude/projects`. Settings sources are disabled (`settingSources: []`), so hooks, MCP servers, CLAUDE.md, and the `apiKeyHelper` and `env` entries of `~/.claude/settings.json` are ignored for proxy requests; use the API key / OAuth token fields instead. The CLI still leaves an empty `<config>/projects/<cwd>` directory per session; the proxy removes it after each request (one may remain after a hard kill of the proxy).

### Claude terms / risk

Using a Claude subscription through third-party tooling may conflict with Anthropic's [consumer terms](https://www.anthropic.com/legal/consumer-terms). This proxy uses Anthropic's official agent adapter and never reads your credentials itself, but **use Claude here at your own risk**, or prefer an API key. Nothing here is legal advice, and this project is not affiliated with Anthropic.

## Google Antigravity

1. **Install the server.** Either `npm run antigravity:install` (headless; downloads from the ACP registry into `agents\antigravity-acp\<version>` and verifies the Authenticode signature of Google LLC), or press "Download from registry" on the Antigravity card. Alternatively point `executablePath` / `PROXY_ANTIGRAVITY_COMMAND` at an existing `agy_acp_server.exe`. Only `https` downloads from `cdn.agentclientprotocol.com` and `dl.google.com` are accepted.
2. **Acknowledge the terms.** The desktop app shows a warning the first time you enable Antigravity and stores `termsAcknowledgedAt`. Headless: `PROXY_ANTIGRAVITY_ACCEPT_TERMS=1`. Without it the provider reports `terms_required` and does not start.
3. **Enable it** in the UI, or `PROXY_ANTIGRAVITY_ENABLED=1`.
4. **Log in.** Auth method ids are `oauth-personal` (Log in with Google), `oauth-business`, `gemini-api-key` (set `GEMINI_API_KEY` or the API key field) and `agent-platform`. The proxy authenticates automatically when it can do so without interaction (an explicit method, an API key, or your last successful login). Otherwise the provider shows "needs login" and requests get 503 `auth_required` until you press **Login** (or run the CLI and open the URL it prints). The server does not open a browser itself: it prints an `accounts.google.com` authorize URL and waits for a loopback redirect (`http://127.0.0.1:<random port>/`); the app opens that URL for you, the CLI logs it. Tokens are cached by the server under `%USERPROFILE%\.gemini\antigravity-acp` (or `GEMINI_HOME`).
5. **Models** depend on your plan and the server version (for example `gemini-3.8-flash-high|medium|low` with 1.3.0, a single `gemini-3.8-flash` with 1.4.0). A model that your account cannot use returns 403 `model_not_available`.

**Safety notes.** Antigravity has no read-only mode. The proxy uses the `default` mode (every tool permission is requested from the client) and answers all permission requests with "cancelled" (the exceptions: a request that asks for an image allows that session's `generate_image` permission, a request with function tools allows that session's `client` MCP tools, a request with `mcp` tools allows the allowed tools of the servers it names, and a request with web search allows `search_web` only; see "Image generation", "Function calling", "MCP servers" and "Web search" under [Supported API](#supported-api)), advertises no filesystem or terminal capabilities, and runs sessions in an empty temporary directory. The server always offers `search_web`, `read_url_content` and `run_command` and asked for them even on plain questions (each cancelled call cost seconds), so every Antigravity prompt carries one extra preamble line telling it not to call any tool.

**Session purge.** The server keeps every session on disk (`<GEMINI_HOME>\antigravity-acp\conversations`, `brain`). With `purgeSessions` (default on) the proxy deletes the files of the sessions it created after the server stops. The proxy stops the whole process tree on exit and, after a hard crash, kills orphaned Antigravity processes of its own install on the next start.

### Terms / risk

Google's Antigravity terms ([clause 6](https://antigravity.google/terms)) restrict using Antigravity to power other products and name third-party token replay as grounds for suspension, and there were reports of account suspensions in early 2026. This proxy uses Google's official ACP server and never touches your OAuth tokens, but routing a non-Antigravity client through it may still be considered a violation. **Use Antigravity here at your own risk**, preferably not with an account you cannot afford to lose. Nothing here is legal advice, and this project is not affiliated with Google or OpenAI.

## Supported API

`GET /healthz` is unauthenticated and returns service health. `GET /v1/models` lists the models of the enabled providers (see [Models and providers](#models-and-providers)). `POST /v1/mcp` is the proxy's own MCP server (Streamable HTTP) for harnesses such as Claude Code, behind the same API key as the other `/v1/*` routes; see [MCP server (for harnesses)](#mcp-server-for-harnesses).

`POST /v1/chat/completions` accepts `model`, `messages`, and `stream`. Messages may have `system`, `developer`, `user`, `assistant` or `tool` roles (see [Function calling](#function-calling)) and string or part-array content (`text` parts, and `image_url` parts in user messages, see [Images](#images)). `web_search_options` turns on web search (see [Web search](#web-search)). `stream_options.include_usage: true` adds a final chunk with empty `choices` and the `usage` object before `data: [DONE]` (every other chunk then carries `usage: null`). Streaming uses standard `text/event-stream` frames and terminates with `data: [DONE]`.

Both endpoints always report usage (`prompt_tokens` / `completion_tokens` / `total_tokens` with `prompt_tokens_details.cached_tokens` and `completion_tokens_details.reasoning_tokens` for chat; `input_tokens` / `output_tokens` / `total_tokens` with the matching `*_details` for Responses). The numbers come from the agent when it reports them; otherwise they are estimated at about 4 characters per token.

`POST /v1/responses` accepts a string or a message-array `input` (including system/developer instructions; content parts `input_text`, `output_text`, `text` and, in user messages, `input_image`; `function_call` / `function_call_output` items), optional string `instructions`, `tools` (`function`, `mcp`, `web_search` / `web_search_preview` and `image_generation`), `stream`, and `store: false`, and `max_output_tokens`. Responses are never persisted; `store: true`, `previous_response_id`, and `stream_options` are rejected. Streaming emits semantic Responses API events followed by `[DONE]`.

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

**Function calling.** Chat `tools` / `tool_choice` / `parallel_tool_calls` and Responses `tools` / `tool_choice` / `parallel_tool_calls` with `function_call` and `function_call_output` input items work with all three providers, so the OpenAI SDK's tool loop runs unchanged.
- **How it works.** The proxy hosts a small MCP server (`http://127.0.0.1:<port>/mcp/<token>`, the port the proxy really listens on, also when it binds `0.0.0.0`; the token is 32 random bytes per agent session and is the only credential this route needs). A request with tools gets a fresh agent session (never a warm one) that has your tools as the MCP server `client`, and every tool is marked read-only so Claude can call several at once. When the agent calls a tool, the response ends with it: chat `finish_reason: "tool_calls"` with `message.tool_calls` (streamed as `delta.tool_calls`), Responses `function_call` output items (streamed as `output_item.added`, `function_call_arguments.delta` / `.done`, `output_item.done`). Any text the agent wrote before the call comes first. The agent turn is **not** ended: the session, the pending prompt and the held MCP call are kept (a "suspended" turn, keyed by the `call_<random>` ids). The next request, whose history ends with that assistant message and one tool result for every id, answers the held calls and streams the rest of the same turn.
- **Fallback.** If nothing matches (the proxy was restarted, the history was edited, the ids or the tools differ, the turn expired, a result is missing), the request starts a fresh session with the whole history as text, tool calls and results included (`[tool call <id>] name {args}`, `[tool result <id>]`). Clients never break; they only lose the fast path.
- **Limits.** The agents give up on a tool call that stays open: Claude never (the proxy answers the call as an SSE stream and sets `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT=0`, so even a result that takes minutes is fine), Antigravity after 3 minutes, Codex after 5. The proxy waits `PROXY_TOOL_RESULT_TIMEOUT_MS` (default 10 minutes) cut to the agent's limit minus 30 s, then answers the held call with an error, cancels the turn and drops the session; a later request takes the text fallback. Suspended turns count against the 8 kept sessions (the oldest is given up when the cap is reached).
- **Parallel calls.** Only Claude calls several tools at once; Antigravity and Codex ask for one, wait for its result, and ask again, so each tool round trip is its own response. Calls are collected until 150 ms after the latest one. `parallel_tool_calls: false` returns only the first call of a batch and answers the others with an error asking the agent to call one tool at a time.
- **`tool_choice`.** `none` gives the agent no tools at all (tool messages in the history are sent as text). `required` and a named function only add an instruction line to the prompt: best effort, not enforced. `auto` is the default. Tools must be `type: "function"` with unique names of 1 to 64 letters, digits, `_` or `-`; `strict` is ignored.
- **Not combined with images.** A request with function tools and the `image_generation` tool or chat `modalities` is a 400 `unsupported_parameter`. A model whose provider cannot take tools answers 400 `model_not_capable`.
- **Session reuse and usage.** With session reuse on, a conversation that ended normally keeps its session for the same tools, with the tool calls and results in the kept transcript. Claude turns that held a tool call open report inflated usage (180k to 370k tokens, mostly cache); it is passed through as reported. A suspended response reports estimated usage.
- **Permissions.** Only the `client` server's tools are allowed, only with the `allow_once` option, only in a session that has tools: Claude gets `allowedTools: ["mcp__client__*"]` and asks nothing (a request for another MCP server is cancelled), Antigravity's request must carry `_meta.mcp.server === "client"`, and Codex's approval request, which names only the call id, must match a tracked tool call whose `rawInput.server` is `client`. Everything else stays cancelled.

**MCP servers.** A Responses request may hand the agent remote MCP servers: `tools: [{ "type": "mcp", "server_label": "docs", "server_url": "https://docs.example/mcp", "headers": { "Authorization": "Bearer ..." }, "allowed_tools": ["search"], "require_approval": "never" }]`. The agent calls them itself, inside its own turn; unlike function tools nothing is suspended and the client sees the calls only as output items. Chat Completions has no MCP tool type and keeps answering 400.
- **Request shape.** `server_label` (1 to 64 letters, digits, `_` or `-`; unique within the request; `client` is reserved for the function-tool bridge), `server_url` (http or https; the agent gets it as an ACP `http` server with your `headers`), optional `allowed_tools` (an array of tool names, or `{ "tool_names": [...] }`) and `server_description` (accepted and ignored). `mcp` tools may be combined with `function` tools (one session with both; the remote calls run inside the turn and only the `client` calls suspend it); with `image_generation` they are a 400. `tool_choice: "none"` leaves the MCP servers out as well. Echoing the `mcp_call` / `mcp_list_tools` output items back in `input` is accepted; they are left out of the prompt.
- **Approval.** The approval flow is not supported, so every `mcp` tool must say `"require_approval": "never"` or `{ "never": { "tool_names": ["search"] } }` (then only those tools run; with `allowed_tools` too, only tools in both). A missing value (the OpenAI default is "always"), `"always"` or any other form is a 400 `unsupported_parameter` that says so. `connector_id` and the OAuth `authorization` field are 400s too (send a credential in `headers`).
- **Servers from the settings.** `settings.json` takes a top-level `mcpServers` object, JSON only (there is no field in the settings window): `{ "docs": { "url": "https://docs.example/mcp", "headers": { "Authorization": "Bearer ..." } }, "legacy": { "url": "https://old.example/sse", "transport": "sse" }, "files": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:\\data"], "env": { "KEY": "value" } } }`. A label is 1 to 64 letters, digits, `_` or `-` (not `client`); an entry is `url` with optional `headers` and `transport` (`http`, the default, or `sse`), or `command` with optional `args` and `env` (stdio). A request names a configured server by label, without `server_url`: `{ "type": "mcp", "server_label": "files", "require_approval": "never" }`. A request cannot change a configured server: a `server_url` for a configured label, or `headers` for one, is a 400. Invalid entries are skipped and logged (the warning names the label and the first problem); the rest of the settings load normally and the file is not touched, but the next save from the settings window writes only the valid entries. Headers and env values are stored as written (not encrypted).
- **Stdio only from the settings.** A request with `command`, `args` or `env` is a 400. A stdio entry becomes an ACP stdio server (`{ name, command, args, env: [{ name, value }] }`) and the agent starts the process itself.
- **Transports.** The proxy reads `mcpCapabilities` from the agent at start-up. An `sse` server (settings only) sent to an agent that does not accept SSE answers 400 `unsupported_parameter`: that is Codex today (Claude and Antigravity accept http and sse). For a streamed request the capability is only known once the agent has started, so that error arrives as an SSE error event.
- **Output.** Each call the agent made becomes an `mcp_call` output item before the message: `{ id, type: "mcp_call", server_label, name, arguments, output, error, status }` (`status` is `completed`, `failed` or `incomplete`; a failed call has `error` and `output: null`). They are built from the agent's `tool_call` / `tool_call_update` updates. Streamed, each item arrives as `response.output_item.added`, `response.mcp_call.in_progress`, `response.mcp_call.completed` (or `.failed`) and `response.output_item.done`, and the message follows them with its text in one piece (like image generation, the text is not streamed live for these requests). There is no `mcp_list_tools` item: ACP carries no tool listing and the proxy does not connect to your servers itself. **Antigravity's completed update holds only a placeholder** such as "Docs echo tool call", not the result, so that is what `output` reports for Antigravity (the model still got the real result); Claude and Codex report the result.
- **Limits.** The agents' own limits apply to a call: Claude none (the proxy sets `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT=0`), Antigravity 3 minutes, Codex 5 minutes; the request itself is bound by `PROXY_TIMEOUT_MS`.
- **Permissions.** Only the tools of the session's own servers are allowed (the request's labels, and `client` with function tools), only with `allow_once`, only in that session, and only the tools `allowed_tools` / `never.tool_names` name when given. Claude gets `allowedTools: ["mcp__<label>__<tool>", ...]` (`mcp__<label>__*` without a tool filter) and a rule on `mcpServer.name` / `toolName`, Antigravity's request must carry `_meta.mcp.server` / `.tool`, and Codex's approval request (which names only the call id) must match a tracked tool call whose `rawInput.server` / `.tool` are allowed. A tool outside the filter, another server and every built-in tool stay cancelled. A session with remote servers is always a fresh one (never warm, never kept for reuse; with function tools too it can only be resumed by a request with the same tools and servers).
- **Security.** A request can make the agent connect to any URL it names, with the headers it sends, from the machine the proxy runs on (like image downloads); put an API key on the proxy (`PROXY_API_KEY`) when it is reachable by others. Configured stdio servers run commands on this machine with the proxy's permissions, and their results go to the agent. Nothing in a request can add or change a stdio server.

**Web search.** A request can let the agent search the web, and the answer then carries its citations. Chat Completions: `web_search_options: { "search_context_size"?, "user_location"? }` (an empty object turns it on). Responses: `tools: [{ "type": "web_search" | "web_search_preview", "search_context_size"?, "user_location"?, "filters"?: { "allowed_domains": [...] } }]` (at most one search tool; `include: ["web_search_call.action.sources"]` is accepted, the sources are always returned; `tool_choice` next to a search-only request may be `auto`, `required` or `{ "type": "web_search" }`, and `required` adds an instruction to search). Any model of an enabled provider can search; a provider without a search capability would answer 400 `model_not_capable`.
- **What it asks of the agent.** The prompt preamble is replaced by one that allows web search and nothing else (no reading URLs or pages, no commands, no files, no other tool) and asks for the sources as Markdown links `[title](url)`. Antigravity's usual "do not call any tool" line is left out for these requests. `user_location` (`{ "type": "approximate", "approximate": { city, region, country, timezone } }` in chat, the same fields next to `type` in Responses) becomes one hint line ("The user's approximate location: ..."), and `filters.allowed_domains` another ("prefer results from these domains: ..."). **Neither is enforced**: the agents have no such options, so the domain list is a request, not a filter, and answers may cite other sites. `search_context_size` is checked (`low`, `medium`, `high`) and ignored. Location fields must be single-line strings, and domains plain host names (letters, digits, `.`, `-`, `*`, `/`, `:`), because they go into the prompt.
- **Claude.** The session's built-in tools become `tools: ["WebSearch"]` (never `WebFetch`, never a shell) and `allowedTools: ["WebSearch"]`, so Claude asks no permission for it; as a fallback the proxy allows a permission request that is for the `WebSearch` tool (by `name`, `_meta.claudeCode.toolName` or the tracked call), with `allow_once` only. Claude's other tools stay cancelled. **Latency and cost:** about 16 s to the first answer token against 3 s without search (two searches of 4 to 5 s each), and a usage report of about 370k tokens (mostly cache) against 3.4k; the numbers are the agent's own.
- **Antigravity.** The agent always offers its `search_web` tool and asks permission for it. The proxy allows only a permission request with `toolCall.kind === "search"` and `title === "Run search_web?"`, with `allow_once` (never `allow_always`), only in a request that asked for search. `read_url_content` (kind `fetch`) and `run_command` (kind `execute`), which Antigravity tries when search is denied, stay cancelled. A search adds about 10 s.
- **Codex.** Its web search is on for every request (OpenAI's own, per process, no permission request), so there is nothing to enable. **A request without search cannot switch it off**: Codex may still search, and the proxy then adds no items or annotations (the answer text may still contain links). Turning it off means `"web_search": "disabled"` in `CODEX_CONFIG`, for all requests; the spike saw Codex then improvise through skills, shell and plugin tools, which the proxy's hardened config now removes, but that combination was not re-tested. In the spike a prompt with one search took about 8 s against 3 s without.
- **Output (Responses).** One `web_search_call` item per search the agent ran, before the message: `{ id, type: "web_search_call", status: "completed" | "failed", action: { type: "search", query, sources?: [{ type: "url", url }] } }`, built from the agent's `tool_call` / `tool_call_update` updates (Claude `WebSearch`, Antigravity `search_web`, Codex `kind: "search"`). `sources` are the pages Claude reported for the search (`toolResponse.results`); Antigravity and Codex report none, and Antigravity's own result text is not returned. A search that never finished counts as `failed`. Streamed, each item arrives as `response.output_item.added`, `response.web_search_call.in_progress`, `.searching`, `.completed` (not for a failed one) and `response.output_item.done`, and the message follows with its text in one piece (like image generation and MCP calls, the text is not streamed live for Responses requests with search). Chat has no search items.
- **Citations.** `url_citation` annotations on the answer text, taken from the answer itself: every Markdown link `[title](url)` and every bare `http(s)` URL in it, in text order. Responses: `{ type: "url_citation", start_index, end_index, url, title }` in `content[].annotations` (streamed also as `response.output_text.annotation.added` events before `output_text.done`); chat: `message.annotations: [{ type: "url_citation", url_citation: { start_index, end_index, url, title } }]` (streamed: one `delta.annotations` chunk before the finish chunk; the text itself streams live). The indices are UTF-16 offsets into the final text, so `text.slice(start_index, end_index)` is the whole link (`[title](url)`) or the bare URL; the title is the link text (the host name for a bare URL or an empty text). Images and non-http links are skipped, trailing punctuation is not part of a bare URL, and **nothing is invented**: a source the agent did not write into its answer is not cited (Claude's `sources` on the item list what it found, whether or not the answer cites it). Antigravity's answers cite Google grounding redirect links (`vertexaisearch.cloud.google.com/grounding-api-redirect/...`); those are what the annotations carry. Without a search request `annotations` stays empty.
- **Sessions.** A search request gets a fresh agent session with its options (never a warm one) and is not kept for reuse.
- **Combinations.** Search with `image_generation` (or chat `modalities` with an image) is a 400 `unsupported_parameter`. Search may be combined with function tools and with `mcp` tools: the session options merge (Claude's `tools` is `["WebSearch"]` and `allowedTools` lists the MCP tools and `WebSearch`), each permission rule allows its own tools, and the tools preamble adds "web search only through your web search tool". A search made before a function call is reported with the response that ends with the call, not again with the resumed one. `tool_choice: "none"` leaves search out with the tools.
- **Permissions.** Only the search tool of a request that asked for search is allowed, only with `allow_once`, only for that session; every other permission request stays cancelled. The agent runs the search on its own side (Claude: Anthropic's server-side search; Antigravity: Google's grounding): the proxy never fetches a page, and the agents cannot read URLs in these sessions.

Files, audio, persistent conversations and other behavior-changing options are intentionally rejected. Each request gets a fresh ACP session in an isolated temporary directory (Codex: read-only mode), unless session reuse is on or it resumes a suspended tool turn. Permission requests are denied (except the image permission of an image request, the `client` tools of a request with tools, the MCP servers a request names and the search tool of a search request, above) and no client filesystem or terminal capabilities are advertised.

## MCP server (for harnesses)

The proxy is also an MCP server, so a harness (Claude Code or any MCP client with HTTP support) can ask another model directly: "ask gpt-6-luna to review this function", "what is wrong in this screenshot", "draw me an icon and save it in `assets\`". It is `POST /v1/mcp` on the same address and port as the API (MCP Streamable HTTP, JSON-RPC, stateless), on by default, behind the same API key and the same bind address as `/v1/chat/completions`. Not to be confused with the private tool bridge at `/mcp/<token>` that hands your function tools to the agents (see [Function calling](#function-calling)), or with the remote MCP servers you can hand to an agent (see **MCP servers** above): this is the other direction.

Register it in Claude Code with one command (the desktop app's Overview shows the address and has a **Copy command** button):

```sh
claude mcp add --transport http acp-proxy http://127.0.0.1:8787/v1/mcp
claude mcp add --transport http acp-proxy http://127.0.0.1:8787/v1/mcp --header "Authorization: Bearer <your key>"
```

The second form is for a proxy with an API key. The Overview button never puts your key on the clipboard, only the `<your key>` placeholder.

**Tools.**
- **`list_models`** (no arguments): the models the proxy lists (as `GET /v1/models`), each once under its provider-prefixed id with its alias, provider and capabilities: `image_input` (`true`, `false`, or `null` until the agent has started and says what it accepts), `image_generation`, `web_search`. The harness should call it first.
- **`ask_model`**: text and images in, text out. Arguments: `model` (an id from `list_models`, exact), `prompt`, `system` (only on the first turn of a thread), `thread_id` (continue an earlier conversation), `web_search` (boolean, only for models that can search) and `images` (at most 8; see below). The result is the answer plus a `thread_id`, and `structuredContent` with the model, finish reason and token usage. It never asks for a generated image; use `generate_image` for that.
- **`generate_image`**: a prompt (and optional reference images) in, an image out. Arguments: `model` (one with `image_generation`), `prompt`, `images` (at most 4 reference images; the agent decides how to use them, there are no masks and no guaranteed edit), `size` (`WIDTHxHEIGHT` or `auto`, an aspect-ratio hint as for `/v1/images/generations`), `save_to` (an existing absolute folder to save into), `file_name` (with `save_to`) and `return_image` (default true). One image per call.

Failures come back as tool errors (`isError: true`) that start with a code the harness model can read: `provider_auth_required` (for example "Codex needs login: press Log in in the ACP Proxy app"), `provider_busy`, `model_not_capable` (it names the models that can), `request_timeout`, `unsupported_content`, `invalid_image_url`, `path_not_allowed`, `invalid_image_path`, `invalid_save_path`, `no_image_generated`, `thread_too_large`, `model_not_found` (the model id does not exist; the message suggests similar ids or points to `list_models`), `thread_not_found` (the `thread_id` is unknown or has expired; start a new conversation), `thread_model_mismatch` (a thread keeps the model it was started with), `thread_busy` (another call on the same thread is still running). A wrong argument shape is a JSON-RPC `-32602` error.

**The called model is read-only.** It gets the text of the prompt and the images given, and gives text (or one image) back. It cannot touch the caller's files and never gets a path; the proxy itself reads an image file the caller names and writes the generated image. So the harness pastes the code or context into the prompt and passes screenshots as `images`. Prompts, images and answers live only in memory; the Recent requests list keeps only metadata (`MCP ask_model` / `MCP generate_image`, model, timing, tokens, the `image in` / `image out` / `search` chips), never a prompt, a path or a file name.

**Threads.** `ask_model` returns a `thread_id`; pass it with the next call to continue the conversation. A thread lives in memory (never on disk, gone on restart), is bound to its model, and at most 32 are kept (the least recently used goes first); one idle for 1 hour is dropped. Its images are kept with it: at most 16 images and 64 MB per thread (over that is `thread_too_large`; start a new thread), 256 MB for all threads together. Every call sends the whole history through the proxy, so the images are replayed on every turn, unless `PROXY_REUSE_SESSIONS` (`server.reuseSessions`) is on: then the warm agent session continues and only the new message is sent (see **Session reuse** above). `generate_image` has no threads.

**Images in** (`ask_model`, and the reference images of `generate_image`). Each item is exactly one of:
- `{ "path": "C:\\Users\\me\\Pictures\\shot.png" }`: an absolute path on the machine the proxy runs on, PNG, JPEG, GIF or WebP, at most 10 MB. For callers on this machine only (see Security).
- `{ "url": "https://..." }`: an `http(s)` URL the proxy downloads, or a `data:` URL.
- `{ "data": "<base64>", "mime_type": "image/png" }`: the bytes; the declared type must match them. Base64 counts against `PROXY_MAX_BODY_BYTES`, so big images go as `path` or `url`.

At most 8 per `ask_model` call. The model must accept images (`image_input` in `list_models`; Codex, Claude and Antigravity all do). Formats, limits and download rules are those of [Images](#images).

**Image generation.** Antigravity and Codex can draw; Claude cannot (`model_not_capable`, with the list of models that can). How the agents draw, their permissions and the revised prompt are described in [Image generation](#image-generation). On top of that:
- **Where the file goes.** With `save_to` (an existing absolute folder, for example the `assets\` folder of the repo): `<save_to>\<file_name>.<ext>`, or `img-<date>-<time>.<ext>` without a name. Without `save_to`: `<data dir>\mcp-images\img-<date>-<time>-<hex>.<ext>` (`%APPDATA%\api-acp-proxy\mcp-images`), of which the newest 100 are kept and any older than 7 days are deleted (only the proxy's own `img-*` files in that folder, never anything else). `<ext>` comes from the bytes of the image (Antigravity gives JPEG, Codex PNG), not from what the agent claims. The name is cleaned to letters, digits, `.`, `_` and `-`. A file is only ever **created**, never overwritten: if the name exists, `-<6 hex>` is added and the result says so. Files in `save_to` are the caller's; the proxy never deletes them.
- **Inline.** With `return_image` true (the default) the result also holds the image as an MCP `image` block, when it is at most **3 MB** (a Codex PNG is often about 4.5 MB). A bigger one comes back as the path only, with a note to open the file; Claude Code's Read tool opens an image file and shrinks it itself. The proxy does not resize or re-encode images.
- **Remote callers** (a caller that is not on this machine) get no file at all and no `save_to`; the image comes back inline only, whatever `return_image` and the 3 MB cap say.
- If writing the file fails, the call still succeeds with the image inline and says why it was not saved.

**Security.**
- **Key and origin.** `/v1/mcp` needs the API key like every `/v1/*` route when one is set. A request with an `Origin` header that is not a loopback name (`localhost`, `127.0.0.1`, `[::1]`) or the proxy's own IP address is refused (403, DNS-rebinding protection), as is a `Content-Type` other than `application/json` (415). Harnesses send no `Origin`, so they are not affected.
- **Paths (`images[].path` and `save_to`) are only for callers on this machine.** The proxy may listen on `0.0.0.0`; a remote caller with the key must not be able to read image files from this computer or write files into it. A caller counts as local when the socket's own peer address is a loopback address (`127.0.0.0/8`, `::1`, `::ffff:127.x.x.x`); headers (`Host`, `X-Forwarded-For`, `Origin`) are never trusted for this. Anyone else gets `path_not_allowed` and sends `data` or `url` instead.
- **Caveat: a reverse proxy.** A reverse proxy running on this machine in front of the proxy (nginx, Caddy, a tunnel that connects from localhost) makes every caller look local. Do not put one in front of the proxy when it is reachable from outside, or the paths become open to everyone who can reach it.
- **Rules for a path.** It must be absolute. UNC and device paths (`\\server\share`, `//server/share`, `\\?\`, `\\.\`) are always refused before any file system call, so a crafted path cannot make Windows send your credentials to a remote share. A file to read is resolved (`realpath`) and must be a regular file of at most 10 MB whose first bytes say PNG, JPEG, GIF or WebP; a text file (keys, `.env`) fails that check and is never sent anywhere (`invalid_image_path`, with a generic message that never quotes the content). Only the bytes of a generated image are written, only as a new file, only into `save_to` (an existing folder) or the `mcp-images` folder.
- **`url` images** are downloaded from this machine exactly as the chat API does (see [Images](#images)); put an API key on the proxy when it is reachable by others.

**Timeouts and cancelling.** A call is bound by `PROXY_TIMEOUT_MS` (default 5 minutes; loading input images counts inside it; generation takes about 20 s on Antigravity and 40 s on Codex, a long answer longer). `ask_model` and `generate_image` answer as an event stream with a keepalive every 20 s (and progress notifications when the client sent a `progressToken`). For long answers raise `PROXY_TIMEOUT_MS` and Claude Code's own `MCP_TOOL_TIMEOUT` (milliseconds, an environment variable set before starting `claude`). Cancelling the tool call in the harness, or closing the connection, aborts the generation.

## Playground

Open `http://127.0.0.1:8787/playground` in a browser, or use **Open playground** in the desktop app's Overview or the tray menu. On the page you can:

- **Pick a model:** every model the proxy lists, grouped by provider.
- **Chat:** multi-turn chats with an optional system prompt, and toggles for streaming, web search and image generation.
- **See how each answer was made:**
  - time to first token and total time;
  - input and output tokens;
  - finish reason;
  - citations and any generated images;
  - the exact JSON request, with a **Copy as curl** button.
- **Keep a history:** chats are saved in this browser's `localStorage`, never on the proxy. The optional API key field is kept for the tab only.

The page itself needs no API key; its API calls send the key you enter. It talks only to the proxy that served it, under a strict Content-Security-Policy. Answers are shown as plain text, never as HTML.

## curl

```sh
curl http://127.0.0.1:8787/v1/models
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"gpt-6-luna","messages":[{"role":"user","content":"Say hello"}]}'
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
const answer = await openai.chat.completions.create({ model: "gpt-6-luna", messages: [{ role: "user", content: "Hello" }] });
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
npm run probe -- <cmd> [args]   # print an ACP agent's initialize authMethods, modes, config options (--logout: whether it advertises logout)
npm run antigravity:install
npm run icons          # regenerate assets/ and build/icon.ico (app icon is the pixel sprite in scripts/make-icons.mjs)
```

Runnable JavaScript examples (health, models, both API styles, streaming, a terminal chatbot) are in [examples/README.md](examples/README.md).

The tests need no network access and no real agent. A real-login smoke test is deliberately opt-in (`RUN_LIVE_SMOKE=1`).

Dev-only hook: if `ACP_PROXY_DEV_DIR` is set, the desktop app watches that folder: creating `quit` quits the app and `dump` writes a state dump (unpackaged builds also support `shot` and `eval.js`).

CI (`.github/workflows/ci.yml`) runs typecheck, tests and build on every push and pull request, and builds the installers on `v*` tags.
