---
ticket: AAP-37
status: done
request: none
branch: AAP-37_gufo-models-images
repos: [api-acp-proxy]
updated: 2026-11-21
---

# AAP-37 Gufo profiles: DeepSeek V4 Flash, Qwen3.8 Flash-Next (vision), Qwen-Image 2.1 / Turbo (generations + edits)

Facts: `research.md` in this folder. Run live Gufo: never (agents); flags inferred from `gufo.exe` strings are **editable per profile in Settings** and listed in the manual checks (M1..M12).

Reading chosen (full): Gufo becomes a set of **profiles** (one model each) that the proxy switches between by itself when a request names a model, plus a manual picker/start in Settings; vision parts reach Flash-Next; `/v1/images/generations` and `/v1/images/edits` pass through to Gufo image profiles; the playground gets an image mode.

## Decisions (binding ones from the user, plus mine)

1. **Auto-switch, one Gufo process at a time** (the one-server rule across gufo/strata stays). A request naming a Gufo model that is not the active profile stops Gufo and starts the needed profile (minutes).
2. **Concurrency policy (mine): serialize, wait, then 503.** A `LocalModelCoordinator` keeps a FIFO queue of requests per profile. A request for the active profile (ready, or being started) joins at once unless an older request for another profile is already queued (no starvation). A switch starts only when the active profile has **0 in-flight requests**; requests for a model being started wait for it. A request that waits longer than `providers.gufo.switchWaitMs` (default 30 min) gets **503 `local_model_busy`** with `Retry-After`. Justification: killing a 100 GB model mid-generation destroys another client's minutes of work and makes A/B alternation thrash (each switch costs minutes), while an unbounded wait hangs clients; waiting in a FIFO with an upper bound is predictable. A client that disconnects while waiting leaves the queue; a start already in progress is never cancelled by a leaver. A failed start rejects its waiters with 503 `local_model_start_failed` (message carries the launcher error / last log line).
3. **Vision**: image parts are sent upstream as OpenAI `image_url` parts to profiles with `vision: true` (Flash-Next). Text-only profiles (qwen27, deepseek4) and Strata answer **400 `unsupported_content`** ("The model 'gufo/deepseek4' does not accept image input.") **before** any switch is started. qwen27-q4 has an mmproj, but its preset stays `vision:false` (user said text-only; switch it on in Settings and add nothing else).
4. **Images**: generations (JSON) and edits (multipart, up to 10 references) go to Gufo image profiles unchanged in meaning; ACP models keep the existing prompt-based path.
5. **Stable model ids**: each profile exposes `gufo/<model>`; new presets add `--served-model-name <model>` so Gufo's name equals the exposed id, and the proxy sends that id upstream. Migrated qwen27 keeps `Qwen3.8-27B` (existing clients keep working).
6. Profiles are **Gufo only**; Strata keeps its single launch config.

## Scope

1. Settings: `providers.gufo.profiles[]` (see C1), `switchWaitMs`, migration of the old single `args`, five presets.
2. `/v1/models`: every enabled profile is listed (`gufo/<model>`) whether or not it runs, with extra fields `kind` and `vision`.
3. `LocalServerManager`: profile-aware start, switch (stop + start), port-release wait, per-profile start timeout, file-exists precheck.
4. `LocalModelCoordinator` (C3): switch/queue policy above, used by requests and by the Settings Start button.
5. `LocalOpenAiProvider`: profiles, per-model vision, image passthrough, per-model request timeout.
6. Server: lease before the timer, `/v1/images/generations` passthrough, new `/v1/images/edits`, image timeouts and body limit.
7. Settings UI: profile list/editor, Start/Switch per profile, active-profile badge.
8. Playground image mode. 9. Docs.

## Out of scope

- Live Gufo runs, `gufo model install`, model download UI, file/model discovery from `installed.json`.
- Vision upload in the playground chat (the API supports it; the page does not), `loras`, `n > 1`, streaming images, `response_format: url`, image masks.
- Strata profiles, running two Gufo processes, tool calling / MCP for local models.
- Chat/Responses reasoning changes (AAP-36 stays as is).

## Shared contracts

### C1 Settings (`src/settings.ts`, `src/shared/ipc.ts`)

```ts
interface GufoProfile {
  id: string;            // slug [a-z0-9._-]{1,48}, unique in the list
  label: string;         // shown in Settings and the tray/playground
  model: string;         // the id exposed as gufo/<model> and sent upstream; unique in the list
  kind: "llm" | "image";
  args: string;          // one string, {port} replaced; the launcher prepends `serve ...` only if the user wrote it (args are complete as in AAP-35)
  vision: boolean;       // llm only: accepts image parts
  startTimeoutMs?: number;    // default 30 min (kind llm and image alike)
  requestTimeoutMs?: number;  // default: kind image 15 min, llm = server.timeoutMs
}
// providers.gufo: { enabled, port, command, cwd, apiKey?, maxConcurrent, switchWaitMs (default 1_800_000), profiles: GufoProfile[], activeProfile?: never }
```

The old `providers.gufo.args` is removed from the schema output (view type too). Strata schema unchanged.

**Migration** (zod `preprocess` on `providers.gufo`, runs at every parse, no file rewrite until the user saves): when the input has no `profiles`, build the presets; if the input has a string `args`, it becomes the **args of the `qwen27-q4` profile** (the user's customization is kept verbatim, even when it differs from the old default). Stored `profiles` always win (so deleting a preset sticks); Settings has "Restore missing presets" (appends absent preset ids). `SettingsPatch` replaces `profiles` as a whole array.

**Presets** (default `D:\Gufo`, all editable; `{port}` = provider port). Inferred = not run, see M-list:

| id / model | kind | vision | args |
|---|---|---|---|
| `qwen27-q4` / `Qwen3.8-27B` | llm | false | exactly the AAP-35 default (`serve llm --model qwen27-q4 --speculative dflash2 --dflash-model D:\Gufo\models\qwen27-q4\Qwen3.8-27B-DFlash2-Q4_K_M.gguf --port {port} --context 32768`) |
| `flash-next-q4` / `flash-next-q4` | llm | true | `serve llm --model flash-next-q4 --served-model-name flash-next-q4 --speculative mtp --mtp-model D:\Gufo\models\flash-next-q4\MTP\mtp-Qwen3.8-Flash-Next-shared-Q8_0.gguf --mmproj D:\Gufo\models\flash-next-q4\mmproj-BF16.gguf --port {port} --context 32768 --max-request-bytes 33554432` |
| `deepseek4` / `deepseek4` | llm | false | `serve llm --model deepseek4 --served-model-name deepseek4 --speculative dspark --dspark-model D:\Gufo\models\deepseek4\DeepSeek-V4-Flash-DSpark-support-0731.gguf --port {port} --context 16384` |
| `qwen-image-2.1` / `qwen-image-2.1` | image | - | `serve image --model qwen-image-2.1 --served-model-name qwen-image-2.1 --port {port} --max-request-bytes 67108864` |
| `qwen-image-2.1-turbo` / `qwen-image-2.1-turbo` | image | - | same with `qwen-image-2.1-turbo` |

(Sidecar paths follow the manifest file names in research.md section 1 and the `D:\Gufo\models\<id>` layout; `--model <ID>` is used as the existing qwen27 default does; if M2/M3 show the ID form also fills the sidecars, the user can shorten the args.)

### C2 Provider additions (`src/provider.ts`, `src/acp.ts` `AcpLike`, `src/router.ts`)

```ts
interface ModelInfo { id: string; name?: string; kind?: "llm" | "image"; vision?: boolean }   // listed in /v1/models as extra fields kind, vision
interface Provider {
  acceptsImages?(model: string): boolean;            // router.acceptsImages prefers it over status().capabilities.image
  supportsImageGeneration?(model: string): boolean;   // router.canGenerateImages: this ?? imageGeneration
  /** Before the request timer starts: switch/queue to the model; rejects with ApiError 400/503; the lease is released when the request ends. */
  prepareModel?(model: string, messages: Message[] | undefined, signal: AbortSignal): Promise<{ release(): void } | undefined>;
  requestTimeoutMs?(model: string): number | undefined;
  /** Image passthrough (Gufo): present only on providers that proxy an image server. */
  generateImage?(model: string, request: ImagePassthrough, signal: AbortSignal): Promise<{ status: number; body: unknown }>;
}
type ImagePassthrough =
  | { kind: "generations"; fields: Record<string, unknown> }   // JSON fields, whitelist below
  | { kind: "edits"; fields: Record<string, string>; files: Array<{ field: string; name: string; type: string; data: Uint8Array }> };
```

`AcpLike`/router expose `prepareModel`, `requestTimeoutMs`, `imagePassthrough(model): boolean`, `generateImage`. A chat request naming an image profile, or an image request naming an llm profile, is 400 `model_not_capable` (before any switch).

### C3 Coordinator (`src/local-models.ts`, plain Node, no electron)

```ts
interface LocalModelHost {
  /** Current launcher state of gufo. */
  current(): { profile?: string; state: "stopped" | "starting" | "ready" | "error"; error?: string };
  start(profile: GufoProfile): Promise<void>;     // stop-if-different + start; resolves when spawned
  waitReady(profile: string, signal: AbortSignal): Promise<void>;  // rejects when the launcher goes to error/stopped
}
class LocalModelCoordinator {
  constructor(host: LocalModelHost, getSettings: () => { profiles: GufoProfile[]; switchWaitMs: number }, deps?: { now?; setTimeout? });
  /** Resolves with a release when the profile is ready and the caller counts as in-flight. Policy: Decision 2. */
  acquire(profileId: string, signal: AbortSignal): Promise<{ release(): void }>;
  /** Settings Start button: same queue, no in-flight lease; resolves when ready. */
  switchTo(profileId: string): Promise<void>;
}
```

Without a coordinator (plain Node proxy, no launcher) `prepareModel` returns undefined and behaviour is as today (connection refused → 503 `local_server_not_running`).

### C4 Launcher (`src/local-servers.ts`)

`LocalServerSpec` gets `profile?: string` and `startTimeoutMs?: number`; `LocalServerStatusView` gets `profile?: string`. `start(spec)`: same id + same profile starting/ready → no-op; same id + different profile → stop then start. After stopping a process (own id or the other id) wait for the port to stop answering (poll 500 ms, max 30 s, else error "port N still in use after the previous server stopped"); a port that answers with nothing of ours stopped keeps today's refusal. Timeout = `spec.startTimeoutMs ?? deps.startTimeoutMs` (default stays 10 min for Strata). Precheck: for the flags `--model --mtp-model --dspark-model --dflash-model --mmproj` whose value looks like a path (drive letter or leading `/`), `fs.existsSync` before spawn, else throw `File not found: <path> (is the model installed?)`; IDs are not checked.

### C5 Wire (image routes)

- `POST /v1/images/generations` to a Gufo image model: accepted fields `model, prompt, size, steps, seed, negative_prompt, guidance_scale, n, response_format` forwarded as given (`model` rewritten to the profile model); `response_format` other than `b64_json` -> 400; `size` must match `^\d+x\d+$`; no other validation (Gufo enforces ranges; its 4xx is relayed as 400 `invalid_request` with its message, 5xx/connection as 502/503). Response: upstream JSON when it has `data[].b64_json`, plus `created` if missing and `output_format: "png"`; else 502 `upstream_error`.
- `POST /v1/images/edits` (multipart): parsed with the built-in `new Response(buffer, { headers: { "content-type" } }).formData()`; fields as above plus `image` / `image[]` files (1..10, else 400) and optional `mask` rejected 400; rebuilt as `FormData` with the profile model and posted to Gufo; same response rules. Added to `ENDPOINTS` (activity log).
- Image routes read up to `max(server.maxBodyBytes, 64 MiB)`. Request timer for image models = `requestTimeoutMs(model)`.
- The ACP model path of `handleImageGeneration` is untouched: dispatch is `bridge.imagePassthrough(model) ? passthrough : existing`.

## Tasks

Dependencies: **T1 first.** Then **T2, T3 in parallel.** **T4 after T2 and T3.** **T5 after T4.** **T6 after T1 and T5** (needs the view types and IPC). **T7 after T5** (needs `/v1/models` fields and the image routes). **T8 last.**

```
T1 ─┬─ T2 ─┐
    └─ T3 ─┴─ T4 ─ T5 ─┬─ T6
                       └─ T7 ── T8
```

### T1 Settings schema, migration, IPC types

- Inputs: C1; src/settings.ts:13-24 (`localProviderSchema`), :124-125, :168 (`mapSecrets`); src/shared/ipc.ts (`LocalProviderSettingsView`, patch view); tests/settings.test.ts.
- Do: split a `gufoProviderSchema` from the shared helper (Strata untouched); profile schema with slug/unique checks (`model` and `id` unique, else a zod issue); preprocess migration; export `GUFO_PRESETS` and `restoreMissingPresets(profiles)` (pure, used by the UI via IPC types only: put it in `src/settings.ts`, call it from main); view/patch types get `profiles`, `switchWaitMs`, lose `args` for gufo.
- Test (tests/settings.test.ts, one `it`): (a) empty input -> 5 profiles with the table's ids/models/kinds; (b) input `{providers:{gufo:{args:"serve llm --model X --port {port}"}}}` -> `qwen27-q4` profile args equal that string, other four are presets; (c) stored `profiles` with two entries stays two entries; (d) duplicate `model` fails parse.
- Done: test green; typecheck errors only where later tasks consume the new types (T1 keeps the tree compiling by adapting renderer/main minimally or leaving a `// T6` shim; the slice report says which).

### T2 Launcher changes (C4)

- Inputs: C4; src/local-servers.ts:89, :107-131, :174-186; tests/local-servers.test.ts.
- Do: as C4. `commandLine`/view carry `profile`. Port-release wait uses the injected `probe`.
- Test (extend the existing test file, one new `it`): fake spawn as in the existing test: start gufo profile A -> ready; `start` gufo profile B -> A's child exited, B ready, view `profile === "B"`; starting the same profile again is a no-op (one spawn). A spec with `--model <nonexistent absolute path>` rejects with `File not found`. Fake probe keeps answering for 3 polls after the kill to prove the port-release wait (spawn of B happens after).
- Done: green; existing exclusivity test unchanged.

### T3 Coordinator (C3)

- Inputs: C3, Decision 2; new src/local-models.ts; src/limiter.ts for style (FIFO, abort handling).
- Do: implement the policy; injectable clock/timers for the test; `acquire` bounded by `switchWaitMs` -> `ApiError(503, "local_model_busy")` with `retryAfterSec` field if the error type supports headers (else message only; check `ApiError`); start failure -> `ApiError(503, "local_model_start_failed")`.
- Test (tests/local-models.test.ts, one `it` with a fake host that records start calls): A active with 1 in-flight; B requested -> no `start` yet (B waits); a late A request queued behind B (fairness) waits; A releases -> exactly one `start(B)` ; B ready -> B admitted; a B waiter that aborts leaves the queue without a start; a request waiting past `switchWaitMs` (fake timers) rejects `local_model_busy`; a host start failure rejects waiters with `local_model_start_failed`. Assert the host got no more than one start per switch (no thrash).
- Done: green; no electron imports.

### T4 LocalOpenAiProvider and router

- Inputs: C1, C2; src/providers/local-openai.ts (`generate` :87+, `listModels` :72, `status` :50, `messageText` :80, registrations); src/router.ts (`resolve`, `canGenerateImages` :135, `acceptsImages` :139, entries/`/v1/models` listing); src/provider.ts ModelInfo; src/controller.ts:89 registry.
- Do:
  - `gufoRegistration` becomes `createGufoRegistration(host?: { coordinator?: LocalModelCoordinator })`; `gufoRegistration` (no host) stays exported with the old name for the default registry. Provider gets `profiles` (rebuilt when settings change as today's registrations are).
  - `listModels()` for Gufo returns profile models (`kind`, `vision`) regardless of state, and still probes `GET /models` to set state `ready/stopped` (a failed probe no longer throws for the listing). Strata keeps the live list.
  - `generate`: for `vision` profiles, a message with image parts becomes `content: [{type:"text",text}, {type:"image_url", image_url:{url:"data:<mime>;base64,<data>"}}...]` (text-only messages stay strings as now); otherwise unchanged (reasoning, usage, `max_tokens` from AAP-36 untouched). Strata and non-vision profiles: `acceptsImages(model) === false`.
  - `prepareModel(model, messages, signal)`: unknown model -> n/a (router already 404s); image parts on a non-vision model -> `ApiError(400,"unsupported_content")` (thrown before the coordinator); wrong kind -> 400 `model_not_capable`; else `coordinator?.acquire(profileId, signal)`.
  - `requestTimeoutMs(model)`; `supportsImageGeneration(model)` = profile kind image; `generateImage` implements C5 upstream calls with Node fetch (not `ctx.fetch`, same Origin reason as AAP-35), apiKey bearer, signal; maps upstream 4xx/5xx and connection errors as in C5.
  - Router: the model-aware overrides of C2 (`acceptsImages`, `canGenerateImages`), `/v1/models` extra fields, `prepareModel`, `requestTimeoutMs`, `imagePassthrough`, `generateImage` delegates; `ModelInfo.kind/vision` carried through `known`.
- Tests (tests/local-openai.test.ts, 3 `it`s; fake upstream http servers):
  1. Vision: a `flash-next-q4` profile receives an `image_url` data URL part (assert the upstream body); the same request to `deepseek4` and to a `strata` provider -> 400 `unsupported_content` and the fake coordinator's `acquire` is **not** called; `/v1/models` lists `gufo/Qwen3.8-27B`, `gufo/flash-next-q4`, `gufo/deepseek4`, `gufo/qwen-image-2.1`, ... with `kind`/`vision`, also while the upstream is down.
  2. Kind mismatch: chat to an image profile and image generation to an llm profile -> 400 `model_not_capable`.
  3. `generateImage` generations: fields forwarded exactly (`size`, `steps`, `seed`, `negative_prompt`, `guidance_scale`), model id sent = profile model, upstream 400 relayed as 400.
- Done: green; tests/router.test.ts, tests/controller.test.ts unchanged and green.

### T5 Server: lease, timers, image routes

- Inputs: C2, C5; src/server.ts (`readBody` :73, handlers :160/:231/:341, `ENDPOINTS` :359, `requireImageGeneration` :92, timers :170/:245/:349, `runGeneration` :129); src/api.ts:450-501 (`normalizeImageGeneration`, unchanged for ACP); src/mcp-endpoint.ts:573, :696, :733 (generate calls).
- Do:
  - A helper `withLease(bridge, model, messages, signal, fn)` that calls `bridge.prepareModel` **before** the timer starts and releases in `finally`; used by chat, responses, images and the MCP generate paths (so a Gufo model requested through MCP also switches). The timer duration = `bridge.requestTimeoutMs?.(model) ?? config.timeoutMs`.
  - `handleImageGeneration`: read the body, peek `model`; if `bridge.imagePassthrough?.(model)` run the passthrough (C5) else the existing path with the already-parsed body (no behaviour change for ACP). New `handleImageEdits` + route + `ENDPOINTS` entry; multipart parser as in C5; `readBody` gets a raw-buffer variant with the higher image limit.
  - `requireImageGeneration` stays (model-aware through the router).
- Tests (tests/image-generation.test.ts, 2 `it`s added; existing ones stay green and prove the ACP path):
  1. Generations + edits passthrough through `createProxyServer` with a fake Gufo image upstream: JSON fields arrive unchanged; multipart edit with 2 PNG files arrives with the files and model; 11 files -> 400; `response_format: "url"` -> 400; response has `data[0].b64_json` and `output_format: "png"`.
  2. Timer/lease: with a fake coordinator whose `acquire` resolves after 150 ms and `timeoutMs` 100 ms, the request still succeeds (the wait is outside the timer); a second request that exceeds its own image timeout (profile `requestTimeoutMs` 100 ms, upstream sleeps 300 ms) -> 504 `request_timeout`.
- Done: green.

### T6 Electron wiring and Settings UI

- Inputs: C1, C3; src/electron/main.ts:245-259 (IPC start/stop), registry (:93); src/renderer/settings.ts (`localOrder` :101, `renderLocal` :245, `renderLocalServers` :261, `startLocal` :291), settings.html:367-407; src/shared/ipc.ts, preload.cts.
- Do:
  - main.ts: build a `LocalModelHost` over the manager and the settings (`providers.gufo`), a `LocalModelCoordinator`, `createGufoRegistration({ coordinator })`. `proxy:startLocalServer("gufo", profileId?)` goes through `coordinator.switchTo(profileId ?? activeProfile ?? first llm profile)`; `stopLocalServer` unchanged. On ready, `proxy.refreshModels("gufo")` as today.
  - Settings Gufo page: replace the single Arguments field by a **Profiles** card list: per profile label, id, model id, kind, vision switch, args (textarea), start/request timeout (minutes, optional), Remove; "Add profile", "Restore missing presets". Per profile a **Start / Switch to this** button (disabled while that profile is `starting`/`ready`); the launcher badge shows `Gufo: <label>` using `view.profile`; a "Starting a large model can take many minutes" note. Provider-level fields keep Port, Max concurrent, Command, Working folder, API key, plus "Wait for a busy server (minutes)" (`switchWaitMs`). Start saves unsaved edits first (as now). Strata page unchanged.
  - A requested switch from the proxy appears in the same view (launcher push), so the user sees what the proxy started.
- Tests: none new (DOM); `tests/desktop-views.test.ts` must stay green; typecheck/build.
- Done: typecheck, build, existing tests green; M1-M5 manual.

### T7 Playground image mode

- Inputs: src/playground/playground.html (:14 model select, :31-40 controls), playground.ts (model list load, send/abort, `make` helper, key header), lib.ts, playground.css; CSP `src/playground-files.ts:19` (`img-src 'self' data:`, `connect-src 'self'` stays unchanged: no CSP change allowed).
- Do:
  - The model select reads `kind` from `/v1/models`; picking a `kind: "image"` model switches the page to **image mode** (chat input/system/stream/search/images toggles hidden, image panel shown); picking an llm model switches back. Mode is derived, not stored.
  - Image panel: prompt (reuse the message textarea), negative prompt, size (select: 1024x1024, 768x768, 1024x1536, 1536x1024, plus "Custom" W x H number inputs), steps, seed, guidance scale (all optional; **blank = field omitted**, placeholders say "model default"; no invented defaults), reference images (`<input type="file" accept="image/*" multiple>`, max 10, thumbnails via `FileReader.readAsDataURL` so no `blob:` CSP change, each removable). Client checks only what is certain from the research: custom size multiples of 32, max 4096 per side, <= 4 megapixels, steps 2-100 when set, <= 10 files; the server remains the authority.
  - Send: no references -> `POST /v1/images/generations` JSON; with references -> `POST /v1/images/edits` as `FormData` (fields + `image` files; the browser sets the boundary). Same auth header and abort button as chat; shows "Waiting for the model (it may be starting, this can take minutes)..." and elapsed seconds. Result: one `<img>` per `data[].b64_json` as `data:image/png;base64,...` (DOM nodes only), plus a Save link (`<a download>`) and the elapsed time; errors shown as today. Results stay in memory for the tab only (not written to localStorage; history stores no images).
  - lib.ts: pure `imageRequest(fields): { path: "/v1/images/generations" | "/v1/images/edits"; json?: object; form?: ... }`-style builder is **not** needed; keep one pure `validateImageForm(fields): string | undefined` (size/steps/files rules) for the test.
- Test (tests/playground.test.ts, one `it`): `validateImageForm` accepts `1024x1024`, steps blank; rejects `1000x1000` (not multiple of 32), `4128x64`, steps 1, 11 files. Serving/CSP tests unchanged and green (proves no CSP edit).
- Done: typecheck, build, tests green; M8-M10 manual.

### T8 Docs

- README.md: "Local model servers" gains Profiles (table of presets, editable args, `--served-model-name`, migration note), auto-switch and the queue/503 policy with `switchWaitMs`, vision (which models, 400 elsewhere), `/v1/images/generations` and `/v1/images/edits` fields and limits, image timeouts, playground image mode, memory warning (one process; 92-115 GB models vs 63 GiB RAM). ROADMAP.md: `[x] (AAP-37; live checks UNTESTED)`, open items: `loras`, `n > 1`, playground chat image upload, Strata profiles.
- Done: docs match the shipped field names.

## Acceptance criteria

| # | Criterion | Proof |
|---|---|---|
| A1 | Old single `args` survives as the qwen27 profile; defaults give 5 profiles | T1 test |
| A2 | Switching profiles stops/starts once, waits for the port, prechecks files | T2 test |
| A3 | Switch policy: no switch while in-flight, no thrash, FIFO fairness, bounded wait 503, abort leaves queue | T3 test |
| A4 | All profile models listed with kind/vision; vision parts reach Flash-Next; 400 on text-only before any switch | T4 tests 1-2 |
| A5 | Image generations/edits passthrough with exact fields; ACP image path unchanged | T4 test 3, T5 test 1, existing image-generation tests |
| A6 | Lease wait does not count against the request timer; image timeout per profile | T5 test 2 |
| A7 | Playground form validation; no CSP change | T7 test, existing CSP asserts |
| A8 | Whole suite, typecheck, build green | `fnm exec --using default npm.cmd test`, `... run typecheck`, `... run build` |
| A9 | Real behaviour with real models | M1-M12 (user) |

## Risks

- **Memory**: deepseek4 (92.7 GB) and flash-next-q4 (115 GB) on a 63 GiB RAM box may fail or freeze Windows; contexts are capped in presets (16384 / 32768) and the user raises them knowingly.
- **Readiness**: `/v1/models` may answer before a big model is loaded; a request could hit a half-loaded server (M2). If so the follow-up is a profile-level `readyProbe`.
- **Inferred args**: `--model <ID>` for deepseek4/flash-next/images, sidecar paths, `--served-model-name` behaviour on image servers, image request field names (`steps`, `seed`, `negative_prompt`, `guidance_scale`) are inferred; all are profile args or forwarded as given, so the fix is a Settings edit, not code. The only hard-coded guesses: response `data[].b64_json` and PNG.
- **Long waits vs clients**: HTTP clients with their own 60 s timeouts will give up while Gufo starts; the queue entry leaves on disconnect, the start continues.
- **Client body size**: Gufo's default `--max-request-bytes` is 8 MiB (presets raise it for vision/image); the proxy image limit is 64 MiB; a chat with big base64 images still obeys `server.maxBodyBytes` (20 MiB).
- **Kill reliability**: orphan GPU memory after `killProcessTree` (M6); port-release wait mitigates the port, not VRAM.
- **Shared files** (settings.ts, ipc.ts, main.ts, renderer, server.ts, router.ts): conflict-prone; T1 and T4/T5 must not be parallelised.
- Qwen-Image weights carry a non-commercial licence (research); a README note, no code.

## Manual checks (user; nothing here was run by an agent)

- M1 Existing setup: after the upgrade, Settings shows 5 profiles; `qwen27-q4` has your previous args; Start it; `gufo/Qwen3.8-27B` chats as before.
- M2 flash-next-q4: Start from Settings; note load time, whether the server answers `/v1/models` before it is really ready, whether `--model flash-next-q4` finds the MTP/mmproj itself (then shorten args), RAM/VRAM peak.
- M3 deepseek4: Start; does it fit in memory at `--context 16384`? Is `--model deepseek4` accepted (else put the real gguf path)?
- M4 Auto-switch: with qwen27 running, send a chat to `gufo/flash-next-q4`; qwen27 stops, flash-next starts, the request is answered after the wait; the launcher view shows the profile. No `gufo.exe` orphan.
- M5 Concurrency: start a long generation on A, send a request for B: B waits (no kill of A); after A ends the switch happens; with `switchWaitMs` set to 1 minute, B gets 503 `local_model_busy`; a disconnecting waiter does not start anything.
- M6 Switch twice quickly (A, B, A): port reuse works, memory is released (Task Manager).
- M7 Vision: Flash-Next with an `image_url` (PNG data URL) in a chat; the answer describes it. The same request to `gufo/deepseek4` and `gufo/Qwen3.8-27B` returns 400 and does not start anything.
- M8 `POST /v1/images/generations` to `gufo/qwen-image-2.1-turbo` with `size`, `steps`, `seed`: a PNG comes back as `b64_json`; report the exact upstream error text if a field name is wrong (fix the playground/passthrough names); try `n: 2`, `negative_prompt`, `guidance_scale` on both models (one may reject them).
- M9 `POST /v1/images/edits` with 1 and with several references; 11 references -> 400.
- M10 Playground: picking an image model shows the image panel; generate, save, edit with references; picking a chat model restores chat; no CSP errors in the console.
- M11 Image generation time vs timeouts: a full 33 GB model at a large size stays under the 15 min request timeout (raise `requestTimeoutMs` otherwise).
- M12 ACP image generation (a Codex/Claude model) via `/v1/images/generations` still works.

## How to run

`fnm exec --using default npm.cmd test`, `... npm.cmd run typecheck`, `... npm.cmd run build`. One file: `fnm exec --using default node node_modules/vitest/vitest.mjs run tests/local-models.test.ts`. Tests write only under `.claude/temp/<name>-tests` and use fake local servers only.

## Assumptions to confirm

1. qwen27-q4 stays `vision:false` by default.
2. Image model results are not persisted by the playground.
3. A client that never sends `max wait` gets the 30 min default `switchWaitMs`.
4. The Strata page and settings are unchanged.
