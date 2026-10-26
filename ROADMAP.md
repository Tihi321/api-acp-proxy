# Roadmap

What is open for the proxy as the creative hub (`C:\projects\Personal\creative-hub`) uses it. Wiring it into Scriptorium and Book Translator is hub ticket HUB-09 (on hold). Finished work is in `.claude/tickets/` (AAP-05 ignore sampling fields, AAP-07 to AAP-10 the limits below). Fix items on a ticket branch (`AAP-NN_<what>`) cut from `master`.

## Where it stands (2026-10-22)

- **The hub's use:** an `openai-compat` provider for Scriptorium and Book Translator. The hub runs it on port 7461 (its default 8787 clashed with the old flow-mcp panel) with `PROXY_IGNORE_SAMPLING=1`; see the hub's `services.json`, id `acp-proxy`.
- **AAP-05 merged:** `server.ignoreSampling` / `PROXY_IGNORE_SAMPLING=1` (and a settings checkbox) dropped `stream_options`, `max_tokens` and `temperature`, which both apps send and the proxy answered with 400 `unsupported_parameter`. Not yet tried with a real request (HUB-09).
- **AAP-07 to AAP-10** (stacked branches `AAP-07_json-output` → `AAP-08_stream-usage` → `AAP-09_token-limit` → `AAP-10_session-reuse`, 147 tests pass, not yet tried with a real request). They change what `PROXY_IGNORE_SAMPLING` drops: chat `stream_options` and the token limits are now honoured, so only `temperature`, `top_p`, penalties, `seed` and the Responses `stream_options` are dropped. The apps' `max_tokens` now cuts answers (≈4 characters per token).
- **HUB-09 on hold** (user, 2026-10-22: "no need for now, later if needed").

## Limits seen from the hub

- [x] No JSON schema: `response_format` (chat) and `text.format` (Responses) are accepted; the agent is told the format and schema and the answer is cleaned of fences and prose. Not schema-validated, so the apps' repair step still matters. (AAP-07)
- [x] No token limit: `max_tokens` / `max_completion_tokens` / `max_output_tokens` are honoured with an estimate; the turn is cancelled and the stop is `length` / `incomplete`. (AAP-09)
- [x] No usage numbers in the stream: `stream_options.include_usage` adds the final usage chunk; usage comes from the agent, or an estimate when it reports none. (AAP-08)
- [x] Each request is a fresh agent session: opt-in `PROXY_REUSE_SESSIONS` / `server.reuseSessions` continues the session of the same conversation and sends only the new messages. (AAP-10)
- [x] Images are accepted (chat `image_url`, Responses `input_image`; PNG, JPEG, GIF, WebP; base64 or an http(s) URL the proxy downloads). (AAP-13)
- [x] Images can be generated: `POST /v1/images/generations`, Responses `image_generation` tool, chat `modalities` (Antigravity and Codex). (AAP-14)
- [x] Function calling: chat `tools` and Responses `function_call` items, through an MCP server the proxy hosts for the agents (Codex, Claude, Antigravity). (AAP-15)
- [x] Remote MCP servers: Responses `type: "mcp"` tools and `mcpServers` in the settings (http, sse, stdio), with `mcp_call` output items. (AAP-16)
- [x] Web search: chat `web_search_options` and the Responses `web_search` tool, with `web_search_call` items and `url_citation` annotations (Claude, Antigravity; Codex always searches). (AAP-17)
- [ ] Audio and files are still rejected. Not needed by the hub's apps.
