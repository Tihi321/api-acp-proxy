# AAP-69 changelog

- `src/settings.ts`: `providers.ollama` (`enabled` true, `baseUrl`, `apiKey`, `maxConcurrent` 1), `OLLAMA_DEFAULT_URL`; the api key is encrypted with the others.
- `src/providers/local-openai.ts`: `LocalProviderId` (`LocalServerId | "ollama"`), `ollamaRegistration`, `ollamaBaseUrl`; the not-running message for Ollama says the proxy does not start it.
- `src/controller.ts`, `src/electron/main.ts`: the registration is in the default and the desktop registry; Ollama's models are in the Monitor's "Local model ids" list.
- Settings window: Ollama page (`settings.html`, `settings.ts`, `settings-fields.ts`, `shared/ipc.ts`).
- Tests: `tests/local-openai.test.ts` (Ollama list, chat, not running), `tests/settings.test.ts` (defaults, URL), `tests/controller.test.ts` (provider list, Ollama off in the fixture). `yarn typecheck` passes; `yarn test`: 544 passed, 1 skipped.
- README: Ollama section, settings page list. ROADMAP row.
- Live check: second instance on 127.0.0.1:8797 with its own settings file (only Ollama enabled): `/v1/models` listed `ollama/qwen3.8:latest` and `ollama/inkling-2-mini:latest`; a chat completion to `ollama/qwen3.8:latest` answered "2 + 2 equals 4." with `reasoning_content`, usage 53+28 tokens. The instance was stopped. The desktop Settings page was NOT opened (UNTESTED).

GPU memory: the proxy's one-local-model rule (`LocalModelCoordinator`, `LocalServerManager`) only knows Gufo, Strata and Llama.cpp, which it starts and stops itself. Ollama loads and unloads its own models (default keep-alive 5 minutes after the last request), so the proxy cannot see or evict them. An Ollama model (qwen3.8 about 17 GB, inkling-2-mini about 18 GB) loaded beside a Strata, Gufo or Llama.cpp model can run out of GPU memory, on a shared-memory Strix Halo as well as on a discrete GPU (not measured here). Nothing is built for it; see the report's Extra ideas.
