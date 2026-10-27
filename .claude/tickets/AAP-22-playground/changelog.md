# AAP-22 changelog

## 2026-10-27: Playground page at /playground

Added a browser page, served by the proxy, for trying out models. It lists every model grouped by provider, holds multi-turn chats, and keeps a history in the browser. For each answer it shows the timing, token counts and the exact request, which can be copied as curl. The desktop app opens it from the Overview and from the tray.

**Repository:** api-acp-proxy. **Branch:** `AAP-22_playground`, cut from `master` `45e193a`.

### Files changed

**New**
- `src/playground/playground.html`, `playground.css` and `playground.ts`: the page.
  - **Header:** a model picker grouped by provider, a Refresh button, and an API key field. The key is kept in `sessionStorage`.
  - **Sidebar:** the chat history (`localStorage`, up to 50 chats) with New chat and Delete per chat.
  - **Chat:**
    - an optional system prompt;
    - toggles for Stream, Web search (`web_search_options`) and Generate images (`modalities`); web search and image generation exclude each other;
    - Send with Ctrl+Enter, and Stop.
  - **Each answer shows:**
    - the text, rendered as plain text;
    - http(s) citation links;
    - generated `data:image/` images;
    - first-token and total time, input and output tokens, finish reason;
    - a "Request" panel with the JSON body sent, and Copy as curl.
  - **Storage:** every storage access is wrapped in try/catch. When the quota is full, the history is saved again without images.
- `src/playground/lib.ts`: pure helpers for model grouping, SSE line parsing, the curl command (the key is replaced by `$ACP_PROXY_KEY`), chat titles, time formatting and the http(s) URL check.
- `src/playground-files.ts`: `servePlayground()`.
  - It answers `GET` and `HEAD` for `/playground` and a fixed list of files: `playground.js`, `lib.js` and `playground.css`. Anything else under `/playground/` gets 404; methods other than GET and HEAD get 405.
  - Headers on every response: a strict CSP (`default-src 'none'`, with only `self` allowed for scripts, styles and connections, plus `data:` images), `nosniff`, `no-store` and `no-referrer`.
  - It reads the files from `dist/playground`, and falls back to the built copy when run with `tsx`.
- `tests/playground.test.ts`:
  - the helpers;
  - serving files with the headers;
  - unknown files and other methods;
  - the page answering before the API key check;
  - the page not being logged as activity.

**Changed**
- `src/server.ts`: routes `/playground` after the tool bridge and before the API key check and activity tracking.
- `tsconfig.json`, `tsconfig.renderer.json`: `src/playground` is built with the browser config (DOM) into `dist/playground`.
- `scripts/copy-static.mjs`: also copies the playground's HTML and CSS.
- Desktop app:
  - `src/shared/ipc.ts`, `src/electron/preload.cts` and `src/electron/main.ts`: new IPC `proxy:openPlayground`. The main process builds the URL from the server status, so the window never supplies a URL.
  - `src/renderer/settings.html` and `src/renderer/settings.ts`: an **Open playground** button next to the API address in the Overview. If opening fails, the button says "Could not open" for a moment.
  - `src/electron/tray.ts`: an **Open playground** tray item, enabled while the server runs.
- `README.md`: a "Playground" section.

### Deviations from the plan
- **Image input** (attaching an image to a message) is not included, to keep the page small. The proxy supports it, so it can be added later.
- **HEAD support and `Referrer-Policy: no-referrer`** were added beyond the plan.

### Verification
- `npm run typecheck`: passed.
- `npx vitest run --dir tests`: 24 files passed, 1 skipped; 366 tests passed, 1 skipped (6 new).
- `npm run build`: passed, and `dist/playground` holds the 4 files.
- Live, in the restarted desktop app and the browser pane at `http://127.0.0.1:8787/playground`:
  - **Models:** grouped as Codex (3) and Antigravity (2).
  - **Streamed** `codex/gpt-6-luna`: "pong", first token 2.1 s, total 2.3 s, 12595 in / 5 out tokens.
  - **Non-streamed** `antigravity/gemini-3.8-flash`: "ping", total 4.4 s.
  - **After a reload:** both chats were still in the history, and the Request panel showed the exact JSON.
  - **Desktop window:** shows **Open playground**.
- **Not run:**
  - clicking **Open playground** in the window and the tray, because it would open the user's default browser;
  - web search and image generation from the page;
  - Copy as curl, which needs clipboard permission in the pane.

### Commit status
Uncommitted, on `AAP-22_playground`.
