# AAP-22: Playground — try every model in the browser

> Branch: `AAP-22_playground`, cut from `master` (`45e193a`).

## Why
The user wants a small UI to pick any model the proxy offers, keep a chat history, and see how a request works. There is none today; testing means curl or a client.

## Decision
- **A browser page served by the proxy** at `GET /playground`. It works for the desktop app and for `npm start` alike, and needs no Electron window or extra CSP exceptions.
- The desktop app links to it:
  - an **Open playground** button in the Overview;
  - an **Open playground** tray item.
  - Both use a new IPC call, `proxy:openPlayground`. It takes no arguments; the main process builds the URL from the server status.

## Page
- **Model picker:** every id from `/v1/models`, grouped by provider (`codex/…`, `antigravity/…`, `claude/…`). Ids that are also listed unprefixed are shown once, under their provider. There is a Refresh button.
- **API key field:** only needed when `server.apiKey` is set. The key is kept in `sessionStorage`, so it is gone when the tab closes.
- **Chat:**
  - multi-turn, with an optional system prompt;
  - Stream on/off, and Web search on/off (`web_search_options`);
  - Send with Ctrl+Enter, plus a Stop button (abort).
- **Each answer shows:**
  - the text, rendered as plain text and never as HTML;
  - model, time to first token and total time, input and output tokens, finish reason;
  - citations as links (http(s) only);
  - generated images;
  - errors inline.
  - "Request" details: the JSON body that was sent, plus a copy-as-curl button. The key is never included; a placeholder is used instead.
- **History:** chats are saved in the browser (`localStorage`). A sidebar lists them by first message and model, with New chat and Delete. Every storage access is wrapped in try/catch, so the page still works without storage.

## Server
- `GET /playground` serves the HTML. `GET /playground/<file>` serves only a fixed list of files (`playground.js`, `lib.js`, `playground.css`).
- The page is served before the API key check, because it holds no data; the API calls it makes still need the key.
- It is not recorded in the activity log.
- **Headers:**
  - `Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
  - `X-Content-Type-Options: nosniff`
  - `Cache-Control: no-store`
- **Where the files come from:**
  - Source: `src/playground/` (TypeScript, built with the renderer tsconfig into `dist/playground/`), with the HTML and CSS copied by `copy-static`.
  - The server looks for the files next to its own module, falling back to `dist/playground` when run with `tsx`.

## Tests
- `/playground` and its files are served with the headers above, even when an API key is set.
- Unknown files under `/playground/` get 404.
- Playground requests are not recorded in the activity log.
- Pure helpers (`src/playground/lib.ts`): model grouping, the SSE line parser, curl building, and the chat title.

## Docs
README: a short "Playground" section.

## Acceptance
- `npm run typecheck`, `npx vitest run --dir tests` and `npm run build` pass.
- In the running app:
  - `http://127.0.0.1:8787/playground` lists Codex and Antigravity models;
  - a streamed and a non-streamed chat both answer;
  - the history survives a reload;
  - **Open playground** opens it.
