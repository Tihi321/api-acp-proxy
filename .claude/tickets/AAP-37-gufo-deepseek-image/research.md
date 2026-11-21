# AAP-37 research: more Gufo models (DeepSeek V4 Flash, Qwen3.8 Flash-Next Q4, Qwen-Image 2.1 / Turbo)

## Question
What does it take for the proxy to support Gufo's `deepseek4`, `flash-next-q4` (with vision) and the image models `qwen-image-2.1` / `qwen-image-2.1-turbo`: how Gufo serves each, how the proxy launches and routes Gufo today, and a recommended design.

Method: read-only. Ran only `D:\Gufo\v0.35.0\gufo.exe` with `--help` and `model list` (text output; `D:\Gufo\gufo.cmd` first read: it only sets `GUFO_MODELS_DIR` and forwards args, `D:\Gufo\gufo.cmd:1-6`). No `serve`, no `model install`. Gufo ships no docs folder (only LICENSE, NOTICE, THIRD_PARTY_NOTICES.md), so API shapes beyond `--help` come from string/JSON data embedded in `gufo.exe` (`grep -a`), marked **inferred** where they are only error-message strings.

## Answer
- Chat models are `gufo serve llm --model <path-or-ID>` with a model-specific draft backend: deepseek4 uses `--speculative dspark --dspark-model <gguf>`, flash-next-q4 uses `--speculative mtp --mtp-model <gguf>` plus `--mmproj` (vision, auto-discovered beside the model). Image models are `gufo serve image --model <diffusers dir>` (a separate subcommand, `/v1/images/generations` and `/v1/images/edits`). One process serves one model on one port; there are separate subcommands per modality.
- Only `qwen27-q4` is installed. deepseek4 (92.7 GB), flash-next-q4 (115 GB) and both image models (33 GB each) show "available" and are not installed; large `.part` downloads in `D:\Gufo\models\downloads` are in progress (a `gufo.exe` process, pid 11672, was running; likely the downloader), so nothing to test live yet.
- The proxy has the pieces for chat: one `providers.gufo` launch config, a `LocalServerManager` that runs one command at a time, a text-only `LocalOpenAiProvider`. It lacks (1) multiple launch profiles per provider, (2) vision pass-through (images are silently dropped), (3) any upstream image passthrough (`/v1/images/generations` exists but only goes through ACP agents and is refused for local providers), (4) a playground image mode (the playground only displays images returned from chat).
- Recommendation: launch profiles (named presets with a model id and arguments, one active at a time, reusing the one Gufo port) + `LocalOpenAiProvider` image-generation passthrough + vision content parts + playground image mode. Details below.

## 1. Gufo CLI (D:\Gufo, v0.35.0)

### Commands and layout (confirmed)
- `gufo.exe --help`: `serve`, `prompt`, `chat`, `bench`, `eval`, `video`, `transcribe`, `speak`, `decide`, `diagnose`, `extension`, `model`.
- `gufo serve --help` (confirmed): subcommands `llm` (default), `video`, `image`, `tts`, `asr`, `embedding`, `decision`. Common server flags: `-i/--host` (default 127.0.0.1), `-p/--port` (default 8080), `-j/--sessions` (default 1, "preallocated GPU request sessions"), `--max-connections` (16), `--max-request-bytes` (8388608 = 8 MiB, matters for base64 images in vision chat).
- `gufo model --help`: `list [--json]`, `install <ID> [--component ROLE]`, `update`, `remove`, `verify`. "Pass an installed model's ID to --model to use it." Models live in `$GUFO_MODELS_DIR`.
- `gufo model list` (run, confirmed):

| ID | Extension | Size | Status here |
|---|---|---|---|
| deepseek4 | deepseek_v4_flash | 92.7 GB | available (not installed) |
| flash-next-q4 | qwen38_flash_next | 115.0 GB | available |
| qwen-image-2.1 | qwen_image_21 | 33.1 GB | available |
| qwen-image-2.1-turbo | qwen_image_21 | 32.5 GB | available |
| qwen27-q4 | qwen | 19.7 GB | installed (weights, dflash, mmproj) |
| qwen27-q8, qwen3-asr, embeddinggemma-2 | | | available |

- Installed now (confirmed): `D:\Gufo\models\installed.json` lists only `qwen27-q4` (weights `Qwen3.8-27B-UD-Q4_K_XL.gguf`, dflash `Qwen3.8-27B-DFlash2-Q4_K_M.gguf`, mmproj `mmproj-BF16.gguf`), folder `D:\Gufo\models\qwen27-q4`. `D:\Gufo\models\downloads\` holds 7 `.part` files (up to 86.7 GB, modified 2026-11-21 12:32), so installs of the big models are running or were interrupted. Not verified which model each `.part` belongs to.

### Model components (confirmed: JSON manifests embedded in `gufo.exe`, `grep -a -n '"id" : "deepseek4"'` etc.)
- deepseek4: component `weights` (option `--model`), component `dspark` (option `--dspark-model`, file `DeepSeek-V4-Flash-DSpark-support-0731.gguf`, install: default). Description "DeepSeek V4 Flash, IQ2XXS GGUF".
- flash-next-q4: `weights` (`--model`, entry `UD-Q4_K_XL/Qwen3.8-Flash-Next-UD-Q4_K_XL-00001-of-00004.gguf`, 4 shards), `mtp` (`--mtp-model`, `MTP/mtp-Qwen3.8-Flash-Next-shared-Q8_0.gguf`), `mmproj` (`--mmproj`, `mmproj-BF16.gguf`); all installed by default. So the "vision file" is `mmproj-BF16.gguf`.
- qwen-image-2.1 / -turbo: one component `weights`, option `--model`, entry `.` (the model directory, diffusers layout).
- Likely folder layout per model: `D:\Gufo\models\<id>\...` (qwen27-q4 proves it).

### How to serve each (flags from `gufo serve llm --help` / `serve image --help`, confirmed)
`serve llm`:
- Model: `-m/--model <PATH>` (required; help says PATH although the `model` help says an ID works), `--mmproj <PATH>` ("Qwen BF16 vision sidecar (auto-discovered beside model)"), `--served-model-name <ID>` (repeatable; first is primary), `-c/--context <N>` (default 0 = model native context), `--enable-yarn` (Flash-Next only: YaRN beyond native 262144).
- Reasoning: `--think on|off|auto`, `--reasoning-effort auto|minimal|low|medium|high|xhigh|max`, `--preserve-thinking`, `--reasoning-budget <N>`.
- Speculative: `--speculative dspark|dflash2|mtp|off` ("HTTP draft backend"), `--dflash-model` (Qwen 27B DFlash2), `--dspark-model` (DeepSeek V4 Flash DSpark), `--mtp-model` (Qwen3.8-Flash-Next MTP sidecar). Error text in the exe: "DFlash2 requires --dflash-model".
- Server/scheduling: `-p`, `-i`, `-j/--sessions`, `--max-pending` (16), `--request-timeout-ms`, `--cache-ram-bytes`, `--cache-disk <DIR>` ("Flash-Next: owned by one process"), sampling defaults (`--temperature`, `--top-k`, ...).
- Candidate commands (inferred from flags; not run; whether an ID works for `--model` and auto-fills `--mtp-model/--dspark-model/--mmproj` is NOT confirmed; the AAP-35 default used explicit paths):
  - deepseek4: `gufo.cmd serve llm --model <deepseek gguf> --speculative dspark --dspark-model <DSpark gguf> --port 8081 --context <N>`
  - flash-next-q4: `gufo.cmd serve llm --model <...00001-of-00004.gguf> --speculative mtp --mtp-model <mtp gguf> [--mmproj <mmproj gguf>] --port 8081 --context 32768`
- Published speeds (C:\projects\Cowork\Computer\notes\gufo.md "Models it offers", Linux numbers): flash-next-q4 decode up to 117 tok/s with MTP, prefill 1,801; deepseek4 decode up to 30, prefill 475. Memory: Flash-Next Q4 peaks 88.8-90.5 GiB at 133K context; DeepSeek's docs say 80.8 GiB "needs a 128 GiB system" (notes gufo.md). This PC is 63 GiB RAM, 64/64 split, GPU can address about 111 GB (notes). So deepseek4 may not fit; flash-next-q4 "should" (notes, untested).

`serve image` (confirmed help): `-m/--model <DIR>` (diffusers layout), `--served-model-name <NAME>` (repeatable), `--lora <NAME=PATH>`, `--lora-default <NAME:SCALE>`, `-i/-p`, `--max-connections`, `--max-request-bytes`. No sessions, steps, or size flags at server level; those are per request.

### HTTP API
- LLM server (confirmed text in `serve --help`): `/v1/chat/completions`, `/v1/completions`; also Anthropic `/v1/messages`, `/v1/models`, `/` returning `{"status":"ok"}` (notes gufo.md "Clients", AAP-35 research). Default port 8080 (`serve --help`), the user ran it on 8081. Requests must name the model (`Qwen3.8-27B` for qwen27; no default) (notes). `--served-model-name` can set the name.
- Vision in chat (**inferred** from exe error strings, confirmed they exist): message content parts must be `text` or `image_url` (`"message content parts must use text or image_url"`, `"image parts require 'image_url': {'url': '...'}"`, `image_url.detail` in `auto|low|high|original`, "image_url requires a user or tool message and a string URL"); also `input_image`. So standard OpenAI vision parts work when an mmproj is loaded. Whether data URLs or http URLs are accepted: not confirmed (a data URL is the normal case; proxy's `loadImage` already converts all to base64). Zed was configured "images off" for qwen27 (notes), so not yet verified live. flash-next-q4 has the mmproj component installed by default, so vision should work for it; deepseek4 has no mmproj (text only).
- Reasoning: `reasoning_content` is accepted on assistant messages (exe string) and the AAP-36 provider reads `delta.reasoning_content`.
- Image server (help line: "Serve Qwen-Image-2.1 (/v1/images/generations, /v1/images/edits)"; the rest **inferred** from exe error strings):
  - `POST /v1/images/generations` (JSON) and `POST /v1/images/edits` (multipart/form-data, "image edits require multipart/form-data", "accept at most 10 reference images", "image edit requires an image").
  - Output: "image output supports PNG with response_format b64_json": only PNG in `b64_json`; no URL answers.
  - Size: "image size must be multiples of 32, at most 4096 per side and 4 megapixels". Steps: "image steps must be between 2 and 100" (field name probably `steps`; not confirmed; no `num_inference_steps` string found). `guidance_scale` 0-100 and `negative_prompt` exist, and one model path "does not support negative_prompt or guidance_scale" (likely the Turbo variant; not confirmed). `seed` must be uint32. Prompt limit 64 KiB / 16384 encoder tokens. `loras` per request. `model` is required ("'model' is required").
  - Exact request/response JSON (field names, default size/steps, whether `n` > 1 works, response envelope) is NOT documented locally: needs one live request or the upstream repo (github.com/gufo-org/gufo).
- Concurrency: `-j/--sessions` default 1; one GPU session per process.

### One process or many?
Confirmed one model per `serve` process: `--model` is a single path, each modality is its own subcommand, `--served-model-name` only aliases (repeatable names for one model), notes gufo.md: "It runs one pinned model per use case". Two processes on different ports are possible in principle but the GPU memory (63 GiB RAM, 64/64 split) rules out a 90+ GB chat model plus a 33 GB image model together (inferred). An LLM and an image model must be started in turn.

## 2. This repo today (all confirmed by reading)

### Launch config
- `src/settings.ts:13-24` `localProviderSchema`: per provider `enabled, port, command, args (one string, `{port}` replaced), cwd, apiKey, maxConcurrent (default 1)`. Defaults `providers.gufo` at :124 (port 8081, `D:\Gufo\gufo.cmd`, args for qwen27-q4 + dflash2 + `--context 32768`, cwd `D:\Gufo`), `providers.strata` at :125. `apiKey` encrypted via `mapSecrets` (:168).
- `src/local-servers.ts`: `LocalServerManager`, ids fixed `["gufo","strata"]` (:8-9). `start(spec)` (:107-131) refuses if that id is running or starting, stops the OTHER id first (:115), refuses when the port already answers (:116), spawns `cmd.exe /d /s /c "<command> <args>"` hidden (:34-37), polls `GET http://127.0.0.1:<port>/v1/models` every 1 s until 200 (:42, :174-186), start timeout 10 min (:89), logs last 200 lines, `stop` via `killProcessTree`. Per-id state is `stopped|starting|ready|error`. There is no concept of "which model/profile".
- `src/electron/main.ts:245-259`: IPC `proxy:startLocalServer(id)` reads `effective.providers[id]` and builds the spec; `stopLocalServer`; push event `proxy:localServers`. Both validated as `"gufo"|"strata"`.
- `src/renderer/settings.ts:101` `localOrder`, `renderLocal` (:245), `renderLocalServers` (:261), `startLocal` (:291) (saves unsaved edits first); `settings.html:367-407` Gufo page: Port, Max concurrent, Command, Arguments, Working folder, API key, models chips, Log. Hard-coded per provider (also a Strata twin).
- `src/providers/local-openai.ts`: `LocalOpenAiProvider` posts `/chat/completions` stream with `stream_options.include_usage` and `max_tokens`; reads `reasoning_content`; `listModels()` from `/v1/models`; status capability `image: false`, all features false (:50). Messages are flattened to strings with `messageText` (:80-81), which drops image parts silently (`src/api.ts:107` "images are left out"). Unreachable -> 503 `local_server_not_running`.
- Router exposes `gufo/<id>` where `<id>` comes from the live `/v1/models` (so the served model name, e.g. `Qwen3.8-27B`); when the server is down the list is empty and any `gufo/<x>` is accepted (AAP-35 research router.ts:118-131).

### Images in the proxy
- `POST /v1/images/generations` exists (`src/server.ts:341-358`, route :417). Request schema `src/api.ts:450-461`, normalised at :487-501: only `n=1`, `response_format` only `b64_json`, no `image/mask`, no stream, `size` only as `WIDTHxHEIGHT`/`auto` converted to an "Aspect ratio" prompt hint (`imageGenerationText` :482), quality/background hints. It runs `runGeneration(... { images: true })` through a `Provider` and answers `{created, data:[{b64_json, revised_prompt?}], output_format}`.
- Gate: `requireImageGeneration` (server.ts:92-94) uses `router.canGenerateImages(id)` = `provider.imageGeneration === true` (router.ts:135). `LocalOpenAiProvider` has no such flag (it is a status feature at :50, always false), so a gufo model is answered 400 `model_not_capable`. The generate path returns images as `result.images` (agent-generated).
- MCP `generate_image` (src/mcp-endpoint.ts:290-300, 726) uses the same capability check and saves to disk.
- No steps/size/seed/negative-prompt pass-through exists; the whole path is agent-prompt-based (size becomes an aspect hint), which is wrong for a diffusion server that wants exact `size` and `steps`.

### Playground
- `src/playground/playground.ts`: chat only; the `images` checkbox sends chat `modalities: ["text","image"]` (:333) and displays `choices[0].message.images[].image_url.url` data URLs as `<img>` (:238, :339, :373, :469); history saved without images if the quota is full (:44). Page CSP `img-src 'self' data:` (src/playground-files.ts:19) so `data:` images work. There is no image-generation mode (no `/v1/images/generations` call) and no image upload for vision in the page (grep found no file input; **inferred**: not read in full).

### Image inputs in chat for local providers
- The server parses `image_url` parts into base64 `Part`s (`src/api.ts:162-181`, `src/images.ts`), so the request is valid; `LocalOpenAiProvider` then drops them silently (message text only) and the model never sees the image. The ACP providers instead throw 400 `unsupported_content` if the provider lacks `imageInput` (acp-provider.ts:866). Local provider reports `capabilities.image: false` yet does not reject: an inconsistency to fix when enabling vision.

### Tests that cover the area
`tests/local-openai.test.ts`, `tests/local-servers.test.ts`, `tests/settings.test.ts`, `tests/image-generation.test.ts`, `tests/playground.test.ts`, `tests/router.test.ts`, `tests/controller.test.ts`, `tests/desktop-views.test.ts`. Not run.

## 3. Recommended design

Reading to build: full (chat profiles that start from the app AND image generation through the proxy), not config-only.

### (a) Chat models as Gufo launch profiles
- Settings: `providers.gufo.profiles: Array<{ id, name, args, model?, servedName?, port? }>` plus `providers.gufo.activeProfile` (migrate the existing `args` into a profile "Qwen3.8 27B (dflash2)"; keep `command`, `cwd`, `port`, `apiKey`). Ship built-in presets (inferred flags above), editable:
  1. `qwen27-q4` (existing),
  2. `flash-next-q4` (`--speculative mtp --mtp-model ... --mmproj ...`, vision on),
  3. `deepseek4` (`--speculative dspark --dspark-model ...`),
  4. image: `qwen-image-2.1`, `qwen-image-2.1-turbo` (`serve image --model <dir>`).
  A profile has `kind: "llm"|"image"` so the provider knows which API to use.
- `LocalServerManager`: `start(spec)` already supports one spec per id, so profiles need only: the spec carries the selected profile's args; `stop` the running profile then start the other (switching = stop + start, ~minutes for 100 GB models; `startTimeoutMs` 10 min may be too short for first load of 92-115 GB: raise to e.g. 30 min or make it a setting). Show active profile in the view (`LocalServerStatusView.profile`). Port reuse: keep one port per provider; after `killProcessTree` wait for the port to free (probe at start already refuses while it answers, local-servers.ts:116).
- UI: a "Model" dropdown on the Gufo page (profiles), a Start button using it, name/args editable; models list chips come from `/v1/models` as today. A "Switch model" while running: stop then start with confirmation.
- Provider: `listModels()` yields the served name; no change except vision (below). Optionally pass `--served-model-name <profile id>` so the proxy id is stable (`gufo/flash-next-q4`) instead of whatever Gufo reports.
- Vision: in `LocalOpenAiProvider.generate`, send content arrays with `{type:"image_url", image_url:{url:"data:<mime>;base64,..."}}` for image parts; set `capabilities.image` per profile (true only for profiles that include `--mmproj`); raise `--max-request-bytes` in the preset args if images exceed 8 MiB; return 400 `unsupported_content` when the active profile has no vision. Whether the proxy should accept an image on a text-only profile: reject (consistent with ACP providers).
- Concurrency: keep `maxConcurrent` 1 (one session, `-j 1`).

### (b) Image models via passthrough + playground image mode
- Provider flag: add an `imageGeneration` capability to `Provider` implementations that proxy an image server; for `LocalOpenAiProvider` expose `imageGeneration` true when the active profile kind is image (or always true and let the upstream answer 404 on an LLM server). Add an optional `Provider.generateImage?(model, request, signal)` returning `{b64_json, mimeType, revisedPrompt?}`; `handleImageGeneration` calls it when present instead of `runGeneration` with the agent-prompt path, and forwards `size` (exact WIDTHxHEIGHT), `steps`, `seed`, `negative_prompt`, `guidance_scale`, `loras` as given; `normalizeImageGeneration` must stop turning size into an aspect hint for passthrough models and allow the extra fields. Keep `response_format: b64_json` only (Gufo returns PNG b64_json only); keep `n: 1` until confirmed.
- Edits (`/v1/images/edits`, multipart up to 10 refs): out of scope for a first cut; add as follow-up (proxy has no multipart parser).
- Timeouts: image generation on a 33 GB DiT is slow; proxy `timeoutMs` default 5 min (src/settings.ts:46, AAP-35 research) may be too short for non-turbo; make it per-profile or document.
- Playground: an "Image" mode (toggle or model-type detection) that posts `{model, prompt, size, steps?, seed?}` to `/v1/images/generations` and shows `data:image/png;base64,<b64_json>` in an `<img>` (CSP already allows `data:`); the existing `images` rendering at playground.ts:238 can be reused; a size select (multiples of 32, 4 MP cap) and steps (2-100), Turbo preset lower steps. Store images out of localStorage history (already slimmed).
- Tests: provider passthrough with a fake upstream (like tests/local-openai.test.ts), image route validation, settings profile schema, local-servers profile switching.

### Risks
- One GPU: only one of {chat model, image model} fits at a time; 92-115 GB models leave little room on a 63 GiB/64-64 split machine (notes gufo.md). Starting deepseek4 may fail or make Windows unusable; flash-next at 133K context peaks about 90 GiB (Linux figure). Cap `--context` in presets (e.g. 32768) until measured.
- Long load times: first load of 90-115 GB takes minutes; the 10-min start timeout and the 1 s `/v1/models` probe: does `/v1/models` answer only after the model is loaded? (qwen27 loaded in ~5 s; unknown for the big ones; if the server answers early the proxy would send requests during load.)
- Switching models = kill + restart; port reuse needs the old process gone (local-servers.ts:116 guard) and orphan GPU memory must be released.
- Installs are huge and in progress (`D:\Gufo\models\downloads`): do not run `model install` (user restriction), and launching a profile whose files are missing must give a clear error (check existence before spawn).
- DSpark/MTP model arg correctness is inferred; `--model <ID>` shorthand not confirmed; presets may need real paths.
- Image API field names/defaults unverified; Qwen-Image is "non-commercial license" (notes gufo.md).
- Silent image drop for local chat today is a correctness bug independent of this ticket.
- Shared files touched: settings.ts, ipc.ts, main.ts, renderer settings.ts/html, local-servers.ts, api.ts, server.ts, provider.ts: conflict-prone, and the Strata twin shares the schema helper.

## Open questions (for the user)
1. Which of the four models are the target first, and are downloads of deepseek4 / flash-next-q4 / image models finishing now (so a live check is possible)?
2. Should profiles be only for Gufo, or generic for Strata too?
3. Should an image model and a chat model be switched manually in the UI, or should the proxy auto-start the profile a request names (auto-switching would kill the running model mid-use)?
4. Vision: is image input for flash-next-q4 required in this ticket (needs provider change), and should images on a text-only profile be rejected?
5. Image API: need one live `POST /v1/images/generations` on a started image model to confirm field names (`size`, `steps`, `seed`, `n`) and defaults, or are the upstream docs available?
6. Image edits (`/v1/images/edits`, multipart) in scope?
7. Does `--model <ID>` resolve installed models and add the sidecars (`--mtp-model`, `--dspark-model`, `--mmproj`) automatically? One `gufo serve llm --help`-level check will not answer it; a live start (user-approved) would.
8. Context length per preset (native is 262144; memory-bound).
