# AAP-69 Ollama provider

Numbered AAP-69: AAP-55 to AAP-68 were already taken (the brief said AAP-55).

Goal: `ollama` as a provider next to Gufo, Strata and Llama.cpp (user, 2026-11-26: "you can add ollama as choice").

Design
- Reuse `LocalOpenAiProvider` the way Strata is used: no profiles, models listed from the upstream `/v1/models`, no coordinator lease. Ollama keeps its tag form: `ollama/qwen3.8:latest`.
- `providers.ollama`: `enabled` (true), `baseUrl` (`http://127.0.0.1:11434`, http(s) only; trailing `/` or `/v1` ignored), `apiKey` (optional, encrypted like the others), `maxConcurrent` (1). No port, command or cwd: the proxy never starts or stops Ollama.
- Not running: the provider goes `stopped` with "Ollama is not running or not reachable"; a request answers 503 `local_server_not_running`; the proxy and the other providers are unaffected.
- Settings window: page "Ollama" under Local models (enabled, base URL, API key, max concurrent, models, refresh, save), no Start/Stop. `ollama` is not a `LocalServerId` (that type is the launcher's).
- Tests: one provider test (list, chat, base URL forms, reasoning_effort passthrough, not-running error), one settings test (defaults, URL validation), controller test lists `ollama`.
- Live check on a second headless instance (port 8797, own settings file); the live proxy on 8787 is not touched.

Out of scope: GPU-memory coordination with the other local servers, images, usage chart colour, Ollama model unload.
