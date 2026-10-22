# AAP-05 changelog

## 2026-10-22 — AAP-05: ignore sampling fields

Summary: a new option, `server.ignoreSampling` (env `PROXY_IGNORE_SAMPLING`, a checkbox in the settings window), drops sampling and length fields instead of answering 400 `unsupported_parameter`. It is off by default, so the proxy stays strict for every client that does not ask for it.

Why: Scriptorium and Book Translator (creative hub) send `stream_options: { include_usage: true }` on every chat request, and `max_tokens` / `temperature` on many. The proxy rejected all of them, so neither app could use it as an `openai-compat` provider.

**Repository:** api-acp-proxy. **Branch:** `AAP-05_ignore-sampling`, cut from `master` at 6ebcdd3.

### Files changed
- `src/api.ts`: `ignorableChatFields` (temperature, top_p, presence/frequency penalty, seed, max_tokens, max_completion_tokens, stream_options) and `ignorableResponseFields` (temperature, top_p, max_output_tokens, stream_options). With `ignoreSampling` they are removed before validation. `normalizeChat` / `normalizeResponses` take `NormalizeOptions`. Behaviour-changing fields (tools, response_format, stop, n, ...) are still rejected.
- `src/config.ts`: `ProxyConfig.ignoreSampling`.
- `src/settings.ts`: `server.ignoreSampling` (default false), `PROXY_IGNORE_SAMPLING`, mapped into the config.
- `src/server.ts`: passes the option to both normalizers.
- `src/renderer/settings.ts`, `src/renderer/settings.html`: the checkbox.
- `README.md`: the env var.
- `tests/proxy.test.ts`: dropped fields, still-rejected `tools` / `response_format`, and the strict default.

### Verified
- `npm run typecheck` clean; `vitest run` 112 passed, 1 skipped (the live smoke test).
- `npm run build` done.

### Not verified
- A real Scriptorium or Book Translator request through the proxy (needs a provider logged in).
- The checkbox in the packaged desktop app.
