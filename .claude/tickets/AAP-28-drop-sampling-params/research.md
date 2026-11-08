# AAP-28 research: sampling parameters (temperature and friends)

Date: 2026-11-08. Request REQ-0002 (Scriptorium's Gemini reviewer and researcher jobs fail).

## The failure

Scriptorium's `openaiCompat` client sets `body.temperature` whenever the job passes one (`src/engine/models/openaiCompat.ts:73`). Review, outline and research jobs pass `temperature: 0.2` (`longHandlers.ts`, `handlers.ts:983`), nonfiction 0.1, the humanizer 0.8. The proxy answers
`400 {"error":{"message":"Parameter 'temperature' is not supported by this proxy.","code":"unsupported_parameter"}}`.

Immediate workaround with no code change: tick "Ignore sampling fields" in the proxy's settings window (or start it with `PROXY_IGNORE_SAMPLING=1`, as the hub's instance on port 7461 does).

## Where the proxy validates parameters

All in `src/api.ts`:

- `unsupportedChatFields` (line 21): `functions, function_call, audio, logprobs, top_logprobs, prediction, service_tier, n, temperature, top_p, stop, presence_penalty, frequency_penalty, seed, logit_bias`.
- `unsupportedResponseFields` (line 22): `temperature, top_p, truncation, reasoning, include, background, stream_options`.
- `rejectUnsupported` (line 145) throws 400 `unsupported_parameter` for any of them whose value is not `undefined`, `null` or `false`. So `n: 1` (a no-op that many SDKs send) is a 400 too.
- `ignorableChatFields` / `ignorableResponseFields` (lines 26-27) and `withoutFields` (line 30): with `NormalizeOptions.ignoreSampling` these are deleted before validation. Chat: `temperature, top_p, presence_penalty, frequency_penalty, seed`. Responses: `temperature, top_p, stream_options`. `logit_bias` is not in the ignorable list, so it is rejected even with the option on.
- `normalizeChat` (line 379) and `normalizeResponses` (line 415) call both. Responses also rejects `store: true`, `previous_response_id`, and `tool_choice` / `parallel_tool_calls` without tools.
- Both request schemas are `.passthrough()`: any field in neither list (for example `metadata`, `reasoning_effort`, `verbosity`, `top_logprobs` on Responses) is accepted and silently ignored today. So the proxy is already lenient for unknown fields and strict only for the listed ones.

What each chat field does today:

| Field | Now | Notes |
|---|---|---|
| `max_tokens`, `max_completion_tokens`, `max_output_tokens` | honoured | estimate, turn cancelled, `length` / `incomplete` (AAP-09) |
| `stream_options` (chat) | honoured | usage chunk (AAP-08) |
| `response_format`, `text.format` | honoured | instructions + JSON extraction (AAP-07) |
| `tools`, `tool_choice`, `parallel_tool_calls`, `web_search_options`, `modalities` | honoured | AAP-14 to AAP-17 |
| `temperature`, `top_p`, `presence_penalty`, `frequency_penalty`, `seed` | 400, dropped with `ignoreSampling` | |
| `logit_bias` | 400 always | |
| `stop` | 400 always | could be emulated (cut the text at the first stop string, like `max_tokens`) |
| `n` | 400 for any truthy value, including 1 | |
| `logprobs`, `top_logprobs` | 400 | the agents give no token probabilities |
| `functions`, `function_call`, `audio`, `prediction`, `service_tier` | 400 | |
| Responses `reasoning` | 400 | could map to the agents' effort options, see below |

The settings plumbing: `src/config.ts:17` (`ProxyConfig.ignoreSampling`), `src/settings.ts:51` (`server.ignoreSampling`, default false), `:246` (`PROXY_IGNORE_SAMPLING`), `:272` (mapped into the config), `src/server.ts:147, 214` (passed to the normalizers), `src/renderer/settings.ts:43` and `src/renderer/settings.html:83` (the checkbox), `README.md:94` (env table).

Important for any change of default: `SettingsStore.save` (`src/settings.ts:185`) writes the whole parsed object, so every existing settings file already contains `"ignoreSampling": false`. Flipping the zod default to `true` would not reach existing installs. The server object is a plain `z.object` (not `.strict()`), so a removed key is stripped on the next load and save.

## Why the rejection exists (history)

- `8d6be07 AAP-1: Init` introduced `unsupportedChatFields` with `temperature` in it and the "Parameter '...' is not supported by this proxy." message. The reasoning: the agents behind the proxy cannot honour sampling fields, so a strict 400 tells the caller its setting did nothing.
- `1061eb3 AAP-05: Option to ignore sampling fields` (2026-10-22) added the opt-in `ignoreSampling` because Scriptorium and Book Translator send `temperature` / `max_tokens` / `stream_options` on every request. It was kept off by default "so the proxy stays strict for every client that does not ask for it" (`.claude/tickets/AAP-05-ignore-sampling/changelog.md`). ROADMAP "Where it stands" records the hub running with `PROXY_IGNORE_SAMPLING=1`.
- AAP-07 to AAP-09 later made `response_format`, `stream_options` and the token limits honoured, so only the pure sampling fields remain in the ignorable list.
- The desktop app's own instance (port 8787) still has the default (strict), which is what Scriptorium hits now.

## Existing tests that pin the behaviour

`tests/proxy.test.ts`:
- line 41, "rejects unsupported behavior and unknown models": `temperature: 0` must throw `/temperature/`.
- lines 45-53, "drops sampling fields with ignoreSampling, and still rejects behaviour-changing ones": with the option `temperature` is dropped, `functions` still throws; without it `temperature` throws.
- lines 154-157, "accepts limits by default and with ignoreSampling": passes the option; only the option argument needs removing.
- line 219-223, "accepts stream_options without ignoreSampling": Responses `stream_options` must throw `/stream_options/` without the option.
`tests/settings.test.ts` does not mention `ignoreSampling`. `tests/activity.test.ts` has the server-level activity helpers (`serve`, `call`, `lastEntry`, lines 84-102) to reuse for the reproduction test.

## Can any backend take temperature per request?

Short answer: no. None of the three agents exposes temperature, top_p, penalties, seed, logit_bias or stop through ACP, and none takes them on its command line per request.

- **ACP itself** has no sampling fields. `session/new` takes `cwd`, `mcpServers` and `_meta`; the only per-session knobs are the modes and the `configOptions` an agent advertises, set with `session/set_config_option`. The SDK allows custom `_`-prefixed option types (its own test uses a `_slider` called "temperature" as an example), but no agent here advertises such an option.
- **Codex** (`@agentclientprotocol/codex-acp` 2.3.0): advertises a model option and `reasoning_effort` (category `thought_level`), plus mode/access options. No temperature anywhere in the adapter (0 matches). Codex's models are reasoning models, and on the OpenAI API reasoning models reject `temperature` / `top_p` other than the default anyway. Codex's config has `model_reasoning_effort` and `model_verbosity`, not temperature.
- **Claude** (`@agentclientprotocol/claude-agent-acp` 0.91.0): advertises a model option, an `effort` option (`session-effort.js`) and "Fast mode" (category `model_config`). No temperature. Claude Code has no temperature setting, and with extended thinking the Claude API requires temperature 1.
- **Antigravity** (`agy_acp_server.exe`): the recorded `session/new` answers in `.claude/temp/aap11/out/agy-*.log` advertise one config option, the model, with the effort baked into the id (`gemini-3.8-flash-low/medium/high`, `gemini-4-argon-*`). No sampling options. (Gemini CLI, which the proxy does not run, has a global settings-level `generateContentConfig` per model alias; that is per install, not per request, and not reachable through Antigravity. From memory, not verified here.)

What the backends **can** honour per request, and the proxy does not use yet: a reasoning-effort level (Codex `reasoning_effort`, Claude `effort`, Antigravity via the model id). That maps to the Responses `reasoning.effort` / chat `reasoning_effort` fields, not to temperature. Separate ticket.

Even setting the agents aside: these are agent harnesses with their own system prompt, tool loop and model choice, so a caller's sampling numbers would not mean what they mean against a raw model.

## How similar gateways handle it

- **LiteLLM**: raises `UnsupportedParamsError` for a parameter the target provider does not support, unless `drop_params: true` (global, per model, or per request), which drops it silently. `additional_drop_params` lists extra fields to drop. Most deployments turn `drop_params` on.
- **OpenRouter**: forwards what the chosen provider supports and ignores the rest by default; a caller who needs them can set `provider.require_parameters: true` to only route to providers that honour every parameter.
- **OpenAI reasoning models** (o-series, GPT-5 reasoning): the API itself answers 400 `unsupported_parameter` / `unsupported_value` for `temperature`, `top_p`, penalties, `logprobs`, and `max_tokens` (wants `max_completion_tokens`). Clients that target them learn to leave those out; clients that target "any OpenAI-compatible server" (like Scriptorium) usually do not.
- Common ground: drop pure sampling knobs (they only change how random the wording is), reject fields that change the shape of the answer (`n > 1`, `logprobs`), and offer a strict switch for those who want it.

## Conclusion for the plan

Drop the pure sampling fields by default and say so in a response header and the Recent requests log; keep the contract-changing fields as 400s; accept `n: 1`. Since the existing opt-in setting is persisted as `false` in every settings file, the clean way is to remove `server.ignoreSampling` (setting, env, checkbox) rather than flip its default. A strict switch has no known user; leave it out.
