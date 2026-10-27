# AAP-23: MCP server endpoint — let a harness ask another model (text, images, image generation)

> Branch: `AAP-23_mcp-server`, cut from `master` (`297ec65`).
> Implementation branch created locally from `origin/master` (`297ec65`); the `.gitignore` change and this ticket folder were carried over.
> Revision 2: images in `ask_model` and a `generate_image` tool are now in scope (the user asked for "support for images as well support for all generating images"). Files other than images stay out.

## Why
The user wants to say "ask Luna to look at X" in Claude Code (or any MCP-capable harness) and have the harness call the model directly, including "look at this screenshot" and "draw me an icon and put it in the repo". Today the proxy only speaks MCP the other way round: it hands MCP servers to the agents (AAP-16) and hosts the private function-tool bridge at `/mcp/<token>` (AAP-15). A harness can reach the models only through hand-built curl calls to `/v1/chat/completions` or `/v1/images/generations`, with the address and key typed in and images base64-encoded by hand.

## Decision
- **A public MCP endpoint on the existing server** at `POST /v1/mcp` (MCP Streamable HTTP). No new process, no new port, no stdio wrapper. Registering it is one command:
  - `claude mcp add --transport http acp-proxy http://127.0.0.1:8787/v1/mcp`
  - with a key: add `--header "Authorization: Bearer <key>"`.
- `/v1/mcp`, not `/mcp`: `/mcp` and `/mcp/<token>` belong to the tool bridge, which is routed before the key check.
- **Hand-written JSON-RPC, no `@modelcontextprotocol/sdk`**, like `tool-bridge.ts`. The surface is small (initialize, ping, tools/list, tools/call, notifications) and the bridge already shows the pattern.
- **On by default, no setting.** It is another API route behind the same key and the same bind address as `/v1/chat/completions`, so it adds no new exposure. The two things that are new (reading an image file by path, writing a generated image to disk) are allowed **only for callers on this machine** (see Security).
- **Three tools:** `list_models`, `ask_model` (text and images in, text out), `generate_image` (prompt and optional reference images in, an image out, saved to disk for local callers).
- **Read-only agents stay read-only.** The called model gets text and images in and gives text (or, through `generate_image`, an image) back; it cannot touch the caller's files. The proxy itself reads an image file the caller names and writes the generated image; the agent never gets a path. The tool descriptions say so, so the harness pastes code or context into the prompt and passes screenshots as `images`.
- **Reuse, do not fork:** image loading reuses `src/images.ts` (magic-byte check, 10 MB cap, guarded http(s) download), image generation reuses the `images: true` generation path of `/v1/images/generations` (`src/server.ts:487-507`), capability checks reuse the `AcpLike.can*` methods (`src/acp.ts:158-165`).

## Tools
### `list_models`
- No arguments.
- Returns the ids from `bridge.listModels()` (the same list as `GET /v1/models`), one per line with the provider and its capabilities, e.g. `codex/gpt-6-luna (codex) — images in, image generation, web search`, plus `structuredContent: { models: [{ id, provider, aliases, capabilities: { image_input, image_generation, web_search } }] }`.
- Unprefixed duplicates (`gpt-6-luna` next to `codex/gpt-6-luna`) are listed once, under their prefixed id, with the unprefixed alias in `aliases` (and noted in the text line).
- Capabilities:
  - `image_generation`: `bridge.canGenerateImages(id)` (router: the provider's descriptor, `src/router.ts:114`; today Antigravity and Codex).
  - `web_search`: `bridge.canSearchWeb(id)` (`src/router.ts:116`).
  - `image_input`: new optional `AcpLike.acceptsImages?(model): boolean | undefined`. The router answers `provider.status().capabilities?.image` (`src/provider.ts:43`), which is the agent's own `promptCapabilities.image` from `initialize` (`src/acp-provider.ts:390`) and is **undefined until the provider has started**. So `image_input` is `true`, `false` or `null`; the text says "images in: not known until the provider starts" for `null`. All three agents report `true` today (README "Images"), so `null` only shows before first use. A bridge without the method gives `null` for every model.
- The tool description says: pick a model with `image_generation` for `generate_image`, with `image_input` (or `null`) for `ask_model` with images.

### `ask_model`
- Arguments (JSON Schema in `inputSchema`):
  - `model` (string, required): a model id from `list_models`.
  - `prompt` (string, required): the message to send.
  - `system` (string, optional): system instructions; only taken on the first turn of a thread.
  - `thread_id` (string, optional): continue an earlier conversation.
  - `web_search` (boolean, optional, default false): let the model search the web (only providers with `canSearchWeb`).
  - `images` (array, optional, at most 8 items): images for the model to look at, each exactly one of:
    - `{ path: string }`: an absolute path to a PNG, JPEG, GIF or WebP file on the proxy's machine. **Local callers only** (see Security). This is what a harness has: a screenshot on disk.
    - `{ url: string }`: an `http(s)` URL the proxy downloads (`downloadImage`, `src/images.ts:66`: 15 s, 3 redirects, `image/*`, 10 MB) or a `data:` URL (`decodeDataUrl`, `src/images.ts:35`).
    - `{ data: string, mime_type: string }`: base64 bytes; `mime_type` one of `image/png`, `image/jpeg`, `image/gif`, `image/webp` (decoded through the same `decodeDataUrl` by building `data:<mime_type>;base64,<data>`, so the declared type must match the bytes).
- Images ride in the new user message as `Part`s after the prompt text (`{ role: "user", parts: [{ type: "text", text: prompt }, ...images] }`, `src/api.ts:101-103`); `buildPrompt` already puts each image block after its message text (`src/api.ts:547-550`) and switches the preamble to "an API request with text and images" (`src/api.ts:541`).
- Limits: 8 images per call; 10 MB each (`MAX_IMAGE_BYTES`, `src/images.ts:2`); PNG, JPEG, GIF, WebP only, checked by magic bytes (`sniffImage`, `src/images.ts:18`); base64 `data` also counts against the request body limit (`config.maxBodyBytes`, 20 MiB by default), so big images go as `path` or `url`. Per-thread and store-wide image caps are under Threads.
- `ask_model` never asks for generated images: it does not pass `images: true` to `generate`, so the agent's image tool stays denied (Codex may still draw on its own; the provider drops that image, `src/acp-provider.ts:728`). Reason: an image request disables session reuse (`src/acp-provider.ts:716`, `:741`) and changes the preamble (`src/api.ts:544`); a separate tool keeps the intent explicit. Its description says "to make an image, use generate_image".
- Result:
  - `content`: the answer text, then a second short text item `thread_id: <id> (pass it to continue this conversation)`.
  - `structuredContent: { answer, model, thread_id, finish_reason, usage: { input_tokens, output_tokens } }`, with a matching `outputSchema`.
- **Model lookup:** an exact id, as `/v1/models` resolves it. An unknown id is a tool error (`isError: true`) that lists the ids containing the given text, so `luna` answers "did you mean gpt-6-luna, gpt-5.6-luna?". No fuzzy guessing: the harness picks.
- **Image checks before anything is loaded or started:** `images` on a model with `acceptsImages(model) === false` is a `model_not_capable` tool error ("<model> does not accept images; models that do: ..."). With `null` the call goes ahead and the provider's own check after start (`src/acp-provider.ts:714`, `ApiError 400 unsupported_content` "does not accept image input") comes back as a tool error with that code.
- **Errors** are tool results with `isError: true`, never JSON-RPC errors, so the harness model sees them. The text starts with the code: `provider_auth_required` ("Codex needs login: press Log in in the ACP Proxy app"), `provider_busy`, `model_not_capable` (web search, images), `request_timeout`, `unsupported_content` and `invalid_image_url` (an `ImageError` from `src/images.ts`, same messages as the chat API), `path_not_allowed` and `invalid_image_path` (see Security). Bad argument shapes (wrong types, an image item with zero or two of `path`/`url`/`data`, more than 8 images, `data` without `mime_type`) are JSON-RPC `-32602`.

### `generate_image`
- Arguments:
  - `model` (string, required): a model with `image_generation` in `list_models`.
  - `prompt` (string, required): what to draw.
  - `images` (array, optional, at most 4): reference images (same item shapes and checks as `ask_model`). They ride in the user message next to the prompt, as chat `modalities: ["image"]` with an image part does today; the agent decides how to use them (no masks, no guaranteed edit).
  - `size` (string, optional): `WIDTHxHEIGHT` or `auto`; becomes the aspect-ratio hint line exactly as `/v1/images/generations` does (`imageHints`, `src/api.ts:457-468`). A malformed size is `-32602`.
  - `save_to` (string, optional, local callers only): an absolute path to an **existing directory** to save the image into (e.g. the harness's repo `assets/` folder).
  - `file_name` (string, optional, only with `save_to`): the file's base name; characters outside `[A-Za-z0-9._-]` are replaced by `-`, at most 80 characters, no leading dot; any extension is replaced by the real one.
  - `return_image` (boolean, optional, default true): also return the image as an MCP `image` content block (subject to the inline cap below).
- No count argument: one image per call, like `/v1/images/generations` (`n = 1`, `src/api.ts:476`). If the agent produced more than one, all of them (at most 4) are returned and saved.
- No `web_search`: the provider rejects search with image generation (`src/acp-provider.ts:710`).
- How it runs: the same as `handleImageGeneration` (`src/server.ts:487-507`) without HTTP: build the text with the shared helper (refactor `src/api.ts:482` into an exported `imageGenerationText(prompt, size)` used by both), `bridge.generate(model, [userMessage], callbacks, signal, { images: true })`, take `result.images`. The provider allows the image permission for that session only and deletes the agent's own copy of the file afterwards (`src/acp-provider.ts:731`, `:755`); nothing about that changes.
- Checks, in order: unknown model (as `ask_model`); `canGenerateImages(model) === false` → `model_not_capable` tool error listing the models that can (from `listModels()` filtered by `canGenerateImages`); reference images on `acceptsImages(model) === false` → `model_not_capable`; `save_to` / `path` from a remote caller → `path_not_allowed`; `save_to` not an absolute existing directory → `invalid_save_path`. All of these before the generation starts (it takes 20 to 40 s).
- Each returned image is checked with `sniffImage` before it is written or returned; its MIME type is the sniffed one (the agent's claim is ignored). No image, or no valid one, is a `no_image_generated` tool error with the agent's own words, as `src/server.ts:504` does.
- **Saving (local callers only):**
  - With `save_to`: `<save_to>/<file_name or img-YYYYMMDD-HHMMSS>.<ext>`, written with `flag: "wx"` (never overwrites). If the name exists, `<base>-<6 hex>.<ext>` is used instead and the result says so (the image is not thrown away after 40 s of work). `save_to` files are the caller's: the proxy never deletes them.
  - Without `save_to`: `<dataDir>/mcp-images/img-YYYYMMDD-HHMMSS-<6 hex>.<ext>`. The folder is created on demand. Cleanup after each save, best effort: keep the newest 100 files and drop any older than 7 days; only regular files (via `lstat`, symlinks skipped) directly in that folder whose name matches `^img-\d{8}-\d{6}-[0-9a-f]{6}\.(png|jpg|gif|webp)$`. Nothing else is ever touched.
  - `<ext>`: `png`, `jpg`, `gif`, `webp` from the sniffed type (Antigravity gives JPEG, Codex PNG).
  - If writing fails (disk full, directory removed), the call still succeeds with the image inline (inline cap ignored) and the text says the save failed and why; `structuredContent.images[i].path` is absent and `save_error` set.
  - Remote callers get no file at all (a path on the proxy's machine is no use to them); the image comes back inline only, regardless of `return_image` and the inline cap.
- **Inline cap:** an `image` block is added only when `return_image` is true and the image is at most **3 MB** (decoded; about 4 MB base64, below the 5 MB per-image limit common to model APIs and small enough not to swamp the harness context). A bigger image (a Codex PNG is about 4.5 MB: its update is ~6 MB base64, README "Image generation") comes back as the path only, with "too large to show inline (4.5 MB); open the file to view it". Claude Code's Read tool opens and downsizes an image file itself, so the harness can still look at it. No resizing in the proxy: there is no image library in the dependencies (only `fflate`), and a native one (`sharp`) does not belong in the Electron package.
- Result:
  - `content`: one text item per image, `Saved C:\...\img-20261027-153012-a1b2c3.png (image/png, 1.4 MB).` plus `Revised prompt: ...` when Codex gave one, then the `image` block (`{ type: "image", data, mimeType }`) when inline.
  - `structuredContent: { model, images: [{ path?, mime_type, bytes, inline, revised_prompt?, save_error? }], usage: { input_tokens, output_tokens } }`, with a matching `outputSchema`.
- A harness uses the image afterwards by its path: copy or move it into the repo (or name `save_to` up front), or pass `{ path }` back into `ask_model` to have another model review it.
- Tool annotations: `list_models` and `ask_model` `readOnlyHint: true`; `generate_image` `readOnlyHint: false, destructiveHint: false` (it only creates new files).

## Threads
- A thread is the conversation kept **in memory** by the MCP layer: `{ model, messages: Message[], imageBytes, lastUsed }`, keyed by `thr_<random>`. Never written to disk, gone on restart. Only `ask_model` has threads; `generate_image` is one-shot.
- Each `ask_model` call sends the thread's whole history through `bridge.generate`, like a stateless chat client. The thread keeps the image parts with their base64 (the provider needs the bytes to replay them).
  - With `server.reuseSessions` on, the provider's existing session reuse continues the warm agent session and sends only the new message: a kept transcript holds only the SHA-256 of each image (`toKept`, `src/acp-provider.ts:20-22`) and matches the resent history by those hashes (`sameTranscript`, `src/acp-provider.ts:25-35`), so the same images match and are not sent again.
  - Without it the whole history is replayed, images included, on every turn (the README says so). No new provider code.
- A thread is bound to its model: a `thread_id` with another `model` is a tool error.
- Caps: 32 threads, the least recently used dropped first; a thread idle for 1 hour is dropped. An unknown or expired `thread_id` is a tool error that says to start a new thread.
- Image caps: a thread holds at most 16 images and 64 MB of image data (decoded) over all its turns; a call that would go over is a tool error (`thread_too_large`, "start a new thread"). The whole store holds at most 256 MB of image data; going over drops the least recently used other threads until it fits.

## Protocol
- `initialize`: echo the client's `protocolVersion` when it is one of `2025-06-18`, `2025-03-26`, `2024-11-05`, else answer `2025-06-18`. `capabilities: { tools: {} }`, `serverInfo: { name: "acp-proxy", version: <package version> }`, plus `instructions`: one paragraph telling the harness what the server is for, to call `list_models` first, to pass screenshots as `images: [{ path }]`, and that `generate_image` saves the file and returns its path.
- Stateless: no `Mcp-Session-Id` is issued. `GET /v1/mcp` → 405 (no server-to-client stream), `DELETE` → 405.
- `tools/call` for `ask_model` and `generate_image` answers as `text/event-stream`, like the bridge: a keepalive comment at once and every 20 s, then one `message` event with the result (a generated image is one large event; fine). When the call carries `_meta.progressToken`, the server also sends `notifications/progress` every 20 s (and on the first text), so clients that reset their timeout on progress keep waiting.
- `list_models`, `initialize`, `ping`, `tools/list` answer plain JSON. Batches are accepted except for `tools/call`, as in the bridge.
- Cancellation: `notifications/cancelled` with the request id, or the HTTP connection closing, aborts the generation (the same `AbortController` path as chat). An image file already being written is finished (it is one `writeFile`).
- Each call is bound by `PROXY_TIMEOUT_MS` (default 5 minutes; generation takes about 20 s on Antigravity and 40 s on Codex). Loading the input images (downloads: 15 s each) counts inside that time.

## Security
- **Key:** `/v1/mcp` sits after `authenticated()` (`src/server.ts:541`); with `server.apiKey` set it needs `Authorization: Bearer <key>` like every `/v1/*` route.
- **Origin check (DNS rebinding, as the MCP spec requires):** a request with an `Origin` header whose host is not a loopback name (`localhost`, `127.0.0.1`, `[::1]`) or the proxy's own `Host` gets 403. Harnesses send no `Origin`, so they are unaffected.
- `Content-Type` must be `application/json` (415 otherwise), so a browser cannot send it as a CORS "simple" request without a preflight; the proxy answers no preflight.
- Body limit: `config.maxBodyBytes`.
- Prompts, images and answers live only in the in-memory thread store; no log line and no activity entry holds them (the activity log keeps only metadata, as today). Never log a path's content or a base64 body; a debug line may name the MIME type and size only (as `src/acp-provider.ts:1019` does).
- **Local paths (`images[].path`, `save_to`).** The proxy can bind `0.0.0.0`, and then a remote caller with the key could otherwise read any image-looking file on this machine or drop files anywhere. So:
  - **Local callers only.** A caller is local when `request.socket.remoteAddress` is `127.0.0.0/8`, `::1` or `::ffff:127.x.x.x`. Headers (`Host`, `X-Forwarded-For`, `Origin`) are never trusted for this. Anyone else gets `path_not_allowed` ("image paths are only accepted from this machine; send `data` or `url`"). A browser on this machine is already stopped by the Origin and Content-Type checks. Caveat in the README: a reverse proxy on this machine in front of the proxy makes every caller look local; do not put one there when it is reachable from outside.
  - **Absolute paths only** (`path.isAbsolute`); relative ones are `path_not_allowed` (the proxy's working directory means nothing to the caller).
  - **No UNC or device paths:** anything starting with `\\` or `//` (including `\\?\`, `\\.\`, `\\server\share`) is `path_not_allowed` before any file system call, so a crafted path cannot make Windows authenticate to a remote SMB share and leak the user's NTLM hash.
  - **Reading:** `realpath`, then `stat` must say regular file (no directories, FIFOs or devices) of at most 10 MB, checked before reading; the bytes go through the existing magic-byte check (`checkedImage`, `src/images.ts:27-33`, exported as part of a new `loadImageFile(path)` in `src/images.ts`). Anything else is `invalid_image_path` with a generic message ("not found or not readable", "not a PNG, JPEG, GIF or WebP image", "larger than 10 MB"); the message never quotes file content. The image bytes go only to the agent; nothing is ever returned to the caller but the model's answer. A text file (keys, `.env`) fails the magic-byte check and is never sent anywhere.
  - **Writing:** only the generated image's bytes (sniffed as an image), only as a new file (`wx`), only in `save_to` (an existing directory, resolved with `realpath`, same absolute / no-UNC rules) or `<dataDir>/mcp-images`. Cleanup only ever deletes the proxy's own `img-*` files in `<dataDir>/mcp-images`.
  - Testability: `createProxyServer` options get `isLocalCaller?: (request) => boolean` (default: the socket check above), so tests can act as a remote caller on a loopback socket.
- `url` images: the proxy downloads whatever URL the caller names, from this machine, exactly as the chat API does today (README "Images"); nothing new.

## Activity log
- Each `ask_model` and `generate_image` call is one entry, recorded by the MCP layer itself (not by `track()`, which logs per HTTP request, `src/server.ts:512`): endpoint `MCP ask_model` / `MCP generate_image`, model, provider, duration, status (200, or the HTTP status the error would have had: 400 for `model_not_capable` / image errors / `path_not_allowed`, 502 `no_image_generated`, 503 provider errors, 504 timeout), error code, tokens. `stream: false`.
- Features (the existing `ActivityFeature` values, `src/activity.ts:4`): `images` when the call carried images, `imageGeneration` for every `generate_image`, `search` for `web_search: true`.
- Never a path, a file name, a prompt or an image in an entry.
- `initialize`, `tools/list`, `list_models`, pings and notifications are not logged. The HTTP request for `/v1/mcp` itself is not passed to `track()`.

## Desktop app
- Overview: under the API address, an **MCP** line with the endpoint URL (`<baseUrl>/mcp`) and a **Copy command** button that copies the `claude mcp add ...` line (with a `--header` placeholder `Bearer <your key>` when a key is set, never the key itself).
- Recent requests: the `MCP ...` endpoints show with their image chips like any other entry (check the renderer).
- Tray: no change.

## Files
- `src/mcp-endpoint.ts` (new): JSON-RPC handling, the three tools, argument validation, the thread store (with image caps), the origin check, the local-caller check, image input resolution (`path` / `url` / `data` → `Part`), saving and cleaning generated images, activity entries.
- `src/images.ts`: export `loadImageFile(file)` (the path rules and checks under Security; reuses `checkedImage`) and keep `loadImage` as is.
- `src/api.ts`: export `imageGenerationText(prompt, size?)` (the text built at `:482`, with `imageHints`), used by `normalizeImageGeneration` and by `generate_image`; export `imageFormatName` stays.
- `src/acp.ts`: `AcpLike.acceptsImages?(model): boolean | undefined`.
- `src/router.ts`: `acceptsImages(id)` → `this.resolve(id)?.provider.status().capabilities?.image`.
- `src/server.ts`: route `POST|GET|DELETE /v1/mcp` after the key check, before the 404; new options `mcpImageDir?: string` (default `path.join(os.tmpdir(), "api-acp-proxy", "mcp-images")`, like `defaultRuntimeContext`, `src/provider.ts:61`) and `isLocalCaller?`; pass `options.fetch` and `options.activity` through.
- `src/controller.ts`: pass `mcpImageDir: path.join(this.dataDir, "mcp-images")` to `createProxyServer` (`:183`).
- `src/activity.ts`: nothing new beyond the endpoint strings (check the renderer shows them).
- `src/renderer/settings.html`, `settings.ts`, `settings.css`: the MCP line in the Overview.
- `tests/mcp-endpoint.test.ts` (new); `tests/images.test.ts`: `loadImageFile`.
- `README.md`: an "MCP server (for harnesses)" section; `ROADMAP.md`: a checked item.

## Tests
With a fake `AcpLike` (with and without `acceptsImages`, `canGenerateImages`, `canSearchWeb`), against a real `createProxyServer` on port 0, temp folders under `.claude/temp/mcp-endpoint-tests/<pid>` (as `tests/image-generation.test.ts` does), small real PNG/JPEG fixtures built in the test:
- Protocol
  - `initialize` echoes a supported protocol version and falls back for an unknown one; `instructions` mention `list_models`.
  - `tools/list` lists the three tools with their input and output schemas and annotations.
- `list_models`
  - Models listed once each, alias noted.
  - Capabilities: a model whose provider draws has `image_generation: true`; search likewise; `image_input` is `true` / `false` from `acceptsImages`, and `null` when it answers undefined or the bridge has no such method.
- `ask_model` text
  - Returns the answer, a `thread_id` and usage; the SSE result arrives after keepalives.
  - A second call with the `thread_id` sends the whole history to `generate`; a different model on the same thread, an unknown thread and an expired thread are tool errors.
  - Thread cap: the 33rd thread drops the least recently used.
  - Unknown model: tool error listing the ids that contain the text.
  - `AcpUnavailableError` (`provider_auth_required`) becomes `isError: true` with the message.
  - `web_search: true` on a provider without search: `model_not_capable` tool error; on one with search, `webSearch` reaches `generate`.
  - `generate` is never called with `images: true` from `ask_model`.
- `ask_model` images
  - `{ data, mime_type }` PNG: `generate` gets one user message whose parts are the prompt text then the image (base64 equal to the input); activity features include `images`.
  - `{ url }` with the injected `fetch`: downloaded and passed on; a `data:` URL works too.
  - `{ path }` to a PNG in the temp folder from a local caller: passed on with `image/png`.
  - Mixed: two images in order; nine images → `-32602`; an item with both `path` and `url` → `-32602`; `data` without `mime_type` → `-32602`.
  - `data` declared `image/png` but JPEG bytes → `unsupported_content` tool error; bad base64 → `invalid_image_url`; a 10 MB + 1 byte file by path → `invalid_image_path`.
  - Thread replay: second call on the same thread sends the first turn's image again (same base64) plus the new message; a thread over 16 images → `thread_too_large`; store over 256 MB (lower the cap through an internal option in the test) drops the least recently used other thread.
  - **Provider without image input:** fake with `acceptsImages: () => false` → `model_not_capable` tool error and `generate` not called; fake with `acceptsImages` undefined whose `generate` throws `ApiError(400, "unsupported_content", "... does not accept image input.")` → tool error with that code and message.
- Path security (`images[].path` and `save_to`)
  - `isLocalCaller: () => false`: `{ path }` → `path_not_allowed`, no file read (spy on the read); `save_to` → `path_not_allowed`.
  - Relative path → `path_not_allowed`.
  - `\\server\share\x.png`, `//server/share/x.png`, `\\?\C:\x.png`, `\\.\pipe\x` → `path_not_allowed` without touching the file system.
  - A directory → `invalid_image_path`; a missing file → `invalid_image_path`; a text file named `secret.png` → `invalid_image_path` and its content appears nowhere in the response.
  - A symlink (skip when the OS refuses to create one, as `image-generation.test.ts` does) to a text file → `invalid_image_path`; to a PNG → accepted.
  - `isLoopbackAddress` unit cases: `127.0.0.1`, `127.5.6.7`, `::1`, `::ffff:127.0.0.1` local; `10.0.0.2`, `::ffff:192.168.1.2`, `undefined` not local.
- `generate_image`
  - Fake returns one PNG: `generate` got `{ images: true }` and the text from `imageGenerationText`; with `size: "1536x1024"` the prompt has the 3:2 hint; `size: "big"` → `-32602`.
  - Local caller, no `save_to`: file `img-<date>-<time>-<hex>.png` in `mcpImageDir` with the exact bytes; result text names the path; an `image` block with the base64 and `image/png`; `structuredContent.images[0]` has `path`, `bytes`, `inline: true`.
  - Codex-style `revisedPrompt` shows in the text and `revised_prompt`.
  - Agent says JPEG-type data but the bytes are PNG → saved as `.png` with `image/png`.
  - `save_to` an existing temp dir with `file_name: "logo"` → `<dir>/logo.png`; called again → `<dir>/logo-<hex>.png`, first file unchanged; `file_name: "../x"` → sanitised, stays inside `save_to`; `save_to` a missing dir or a file → `invalid_save_path` before `generate` is called.
  - Image over 3 MB (built in the test): no `image` block, text says it is too large, file saved; `return_image: false` → no block for a small image either.
  - Remote caller (`isLocalCaller: () => false`), no `save_to`: no file written, `image` block present even over 3 MB.
  - Save failure (`mcpImageDir` pointing at a file): success with the image inline and `save_error` set.
  - Reference images: `images: [{ data }]` reach `generate` with the prompt in one user message.
  - Cleanup: 101 old `img-*` files plus a file `keep.txt` and a symlink in `mcpImageDir` → after a save, 100 `img-*` files remain (the oldest gone), `keep.txt` and the symlink untouched; a file dated 8 days ago is removed.
  - **Provider without image generation:** `canGenerateImages: () => false` → `model_not_capable` tool error naming the models that can, `generate` not called; reference images on `acceptsImages: () => false` → `model_not_capable`.
  - Fake returns no image (text "I can't draw that") → `no_image_generated` tool error with that text; fake returns non-image bytes → `no_image_generated`, nothing written.
  - Timeout (`timeoutMs` small, fake never answers) → `request_timeout` tool error; cancellation aborts the signal and writes no file.
- Transport and security
  - `notifications/cancelled` and a closed connection abort the signal passed to `generate`.
  - With an API key: no bearer → 401; with it → 200.
  - `Origin: https://evil.example` → 403; `Origin: http://localhost:8787` → 200; no `Origin` → 200. `Content-Type: text/plain` → 415.
  - `GET /v1/mcp` → 405. `/mcp/<token>` (tool bridge) still routes as before.
- Activity
  - One `MCP ask_model` entry per call (features `images` when images were sent); one `MCP generate_image` entry with `imageGeneration` (and `images` with references); error entries carry the code and the mapped status; none for `tools/list` or `list_models`; no entry holds a path or prompt.
- `tests/images.test.ts`: `loadImageFile` accepts PNG/JPEG/GIF/WebP files, rejects a directory, a too-large file (checked by size before reading), a non-image, a UNC path.

## Docs
README "MCP server (for harnesses)" section:
- What it is, the `claude mcp add` command (with and without a key), the three tools with their arguments.
- Threads (in memory, 32, 1 hour; images kept with the thread, 16 / 64 MB per thread; replayed on every turn unless `server.reuseSessions` is on).
- Images in: `path` (this machine only, absolute, PNG/JPEG/GIF/WebP, 10 MB), `url`, `data`; 8 per call; the model must accept images (`list_models` shows it).
- Image generation: which providers draw (Antigravity, Codex), where the file goes (`save_to`, or `<data folder>/mcp-images`, newest 100 kept for 7 days), the 3 MB inline cap and `return_image`, that remote callers get the image inline only.
- Security: paths only for callers on this machine, never UNC paths, files only created never overwritten; the reverse-proxy caveat.
- That the called model is read-only and sees only the prompt and the images given.
- The timeout (`PROXY_TIMEOUT_MS`; generation takes 20 to 40 s; for long answers raise it and Claude Code's `MCP_TOOL_TIMEOUT`).
- Link the existing "Images" and "Image generation" sections for formats and provider behaviour instead of repeating them.

## Acceptance
- `npm run typecheck`, `npx vitest run --dir tests` and `npm run build` pass.
- With the app running: `claude mcp add --transport http acp-proxy http://127.0.0.1:8787/v1/mcp`, then in a Claude Code session "ask gpt-6-luna to review this function" calls `ask_model` and shows the answer; a follow-up with the returned `thread_id` continues the conversation.
- In Claude Code, with a local screenshot (e.g. `C:\Users\<you>\Pictures\Screenshots\shot.png`): "ask gpt-6-luna what is wrong in this screenshot <path>" calls `ask_model` with `images: [{ path }]` and the answer describes the screenshot; a follow-up on the thread still knows the image.
- In Claude Code, in a repo: "generate a 64x64 app icon of a fox with codex/gpt-5.6-luna and save it to <repo>\assets" calls `generate_image` with `save_to`; the file exists in `assets\` and Claude Code shows the image (inline, or by reading the file when it is over 3 MB); `git status` shows the new file. The same with `antigravity/<model>` gives a `.jpg`.
- `generate_image` with a Claude model answers the `model_not_capable` tool error naming the models that can draw.
- A Codex model that needs login answers with the "needs login" tool error, not a hang.
- The Overview shows the MCP URL and copies the command; Recent requests shows the `MCP ask_model` / `MCP generate_image` entries with their image chips.

## Out of scope
- Files other than images in `ask_model` (PDF, text files: the caller pastes text).
- Returning generated images from `ask_model` (use `generate_image`).
- Resizing or re-encoding images in the proxy (no image library; the 3 MB inline cap and the saved path cover it).
- Masks, `n` above 1, and guaranteed edits of a reference image (the agent decides how to use it).
- Serving generated images over HTTP (the proxy has no place to host them, as for `/v1/images/generations`).
- A setting to turn off local paths, or to allow them for remote callers.
- Letting the called model edit the caller's repository (agents stay read-only; the proxy writes only the generated image file the caller asked for).
- A stdio wrapper (`npx acp-proxy-mcp`) for harnesses without HTTP MCP; add later if one needs it.
- Persisting threads or an index of generated images across restarts.

## Implementation status (2026-10-27)
Branch `AAP-23_mcp-server`, nothing committed. Every section is implemented (details in `changelog.md`).
- [x] Tools `list_models`, `ask_model` (with `images`), `generate_image`; threads; protocol; security; activity log
- [x] Desktop Overview MCP line and Copy command
- [x] Tests: `tests/mcp-endpoint.test.ts` (48), `tests/images.test.ts` (`loadImageFile`), `tests/router.test.ts`, `tests/mcp-command.test.ts`
- [x] README section and ROADMAP item

Acceptance evidence:
- [x] `npm run typecheck` pass; `npx vitest run --dir tests`: 26 files passed, 1 skipped (live smoke), 422 tests passed, 1 skipped; `npm run build` pass.
- [ ] Not verified (needs the running app and real agents; left for the user): the Claude Code `claude mcp add` flow, `ask_model` with a screenshot by `path` and thread follow-ups, `generate_image` with `save_to` on Codex and Antigravity, the Codex "needs login" error against a real agent, the Overview Copy command and the Recent requests chips in the real window.

Deviations: stricter Origin rule (the proxy's own host accepted only as an IP literal); relative/UNC `save_to` is `path_not_allowed`; cancelled calls logged as 499 `cancelled`; `-32602` errors not logged as activity; extra `thread_busy` tool error (409); `mime_type` charset-checked; cancel matched by caller address plus request id; extra files `src/renderer/mcp-command.ts`, `tests/mcp-command.test.ts` and a router test.
