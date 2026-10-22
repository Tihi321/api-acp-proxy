# Roadmap

What is open for the proxy as the creative hub (`C:\projects\Personal\creative-hub`) uses it. Wiring it into Scriptorium and Book Translator is hub ticket HUB-09 (on hold). Finished work is in `.claude/tickets/` (AAP-05 ignore sampling fields). Fix items on a ticket branch (`AAP-NN_<what>`) cut from `master`.

## Where it stands (2026-10-22, master 290285d)

- **The hub's use:** an `openai-compat` provider for Scriptorium and Book Translator. The hub runs it on port 7461 (its default 8787 clashed with the old flow-mcp panel) with `PROXY_IGNORE_SAMPLING=1`; see the hub's `services.json`, id `acp-proxy`.
- **AAP-05 merged:** `server.ignoreSampling` / `PROXY_IGNORE_SAMPLING=1` (and a settings checkbox) drops `stream_options`, `max_tokens` and `temperature`, which both apps send and the proxy answered with 400 `unsupported_parameter`. 112 tests pass; not yet tried with a real request (HUB-09).
- **On hold** (user, 2026-10-22: "no need for now, later if needed").

## Limits seen from the hub

- Text only, and no JSON schema (`response_format` is rejected; the apps fall back to their prompt + repair step).
- No token limit.
- No usage numbers in the stream, so the apps show a cost of 0.
- Each request is a fresh agent session.
