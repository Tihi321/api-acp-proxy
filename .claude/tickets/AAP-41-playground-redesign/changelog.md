# Changelog

## 2026-11-21 AAP-41 Playground redesign

Rebuilt `/playground` as a Claude/Gemini-style chat layout: a resizable, collapsible sidebar with searchable history, pins, date groups and reordering; a floating composer with a model picker, tools menu, image settings and attachments; hover actions on messages; a timing strip; and HTML preview in a resizable right pane. Existing features and stored chats are kept.

### api-acp-proxy (branch `AAP-41_playground-redesign`, from master 230e5bf)
- `src/playground/history.ts` (new): pure history logic. Covers migration of old chats (`pinned` false, `order` from the stored position), sections (Pinned, Today, Yesterday, Previous 7 days, Older), search, `touchChat`, `setPinned`, `moveChat` (forbidden cross-date moves are a no-op) and `trimChats` (keeps every pinned chat, 50 in total).
- `src/playground/lib.ts`: new pure helpers.
  - `sendKey`: Enter and Ctrl/Cmd+Enter send; Shift+Enter and IME composition do not.
  - `userContent`: builds `image_url` content parts.
  - `elideDataUrls`, `filterModelGroups`, `parseUiPrefs`, `clamp`.
  - `timingSegments`.
- `src/playground/dom.ts` (new): the `el` and `make` helpers, `icon` (SVG sprite), storage wrappers and `toast`.
- `src/playground/sidebar.ts` (new):
  - collapse, resize by pointer and keys;
  - search with debounce;
  - row menu: pin, rename, move up and down, delete;
  - drag and drop with a drop line; Alt+Up/Down, F2 and Delete;
  - delete with Undo;
  - a drawer below 720 px.
- `src/playground/messages.ts` (new):
  - Rendering moved from `playground.ts`: markdown, code, thinking, citations, request JSON and Copy as curl.
  - User bubbles with attachment thumbs and "Image not saved" placeholders.
  - Model label; actions Copy, Retry, Edit and Delete.
  - Image grid with Download and an Open lightbox.
  - Timing strip and footer.
  - Preview pane with resize, Reload, Open in new tab and Close. The preview handshake moved here unchanged.
  - Empty state with starter chips.
- `src/playground/composer.ts` (new):
  - textarea that grows with its content;
  - attachments by button, drop and paste, limited to 10 images;
  - model picker: a listbox with search, provider groups and `image`, `vision` and `limit reached` badges;
  - tools menu, keeping the web search / image output exclusion and persisting Stream;
  - Image settings popover with persisted values and a "changed" dot;
  - Send/Stop swap.
- `src/playground/playground.ts`: slimmed to state, storage and requests.
  - Storage: `normalizeChats` on load; on save, `trimChats` and the slim quota fallback, which turns attachments into "" placeholders. Stored requests have their data URLs elided.
  - Requests: image content parts are sent; Retry, Edit and Delete with Undo.
  - Chat header: rename and Chat settings with the system prompt.
  - Settings dialog with the API key and Refresh models; global shortcuts.
  - A 401 shows "Enter the proxy's API key in Settings." with an Open settings button.
- `src/playground/playground.html` and `playground.css`: rewritten. New structure with an SVG icon sprite and dialogs. Light and dark tokens. Responsive: the preview becomes an overlay below 900 px and the sidebar a drawer below 720 px. No inline styles.
- `src/playground-files.ts`: the whitelist includes the 5 new modules.
- `tests/playground.test.ts`: 2 new helper tests. The serving test lists the new files and checks that one is served.
- `README.md`: `## Playground` rewritten. It covers the storage keys, pins and reorder, the attachment rule and the shortcut table.

### Deviations
- `timingSegments`: wait is `firstMs` itself, not `firstMs - thoughtMs`. `readStream` sets `firstMs` at the first reasoning or content delta, so the K2 formula shrank the wait segment to 0 for reasoning models. The test expectation was updated.
- Extra API beyond K3:
  - composer: `clearText`, `files`, `refreshMode`, optional `host.refreshModels`;
  - messages: `streamTarget(answer, meta, started)` takes arguments, plus `onStarter`, `onThinkingToggle` and `setElapsed`; `ImageRun.refs`.
- Extra ids beyond K4. They are listed in `dom-map.md`.
- Changing the model while a request runs is refused with a toast.
- Renaming a chat or editing the system prompt of a saved chat saves at once.
- Deleting an image run has no Undo.
- Vision `false` clears attachments that were already added.

### Verification
- `fnm exec --using default npm.cmd test`: 42 files passed, 1 skipped; 508 tests passed, 1 skipped.
- `npm.cmd run typecheck`: green.
- `npm.cmd run build`: green. `dist/playground` has all 8 `.js` files plus `playground.html`, `playground.css` and `preview.html`.
- grep for innerHTML, insertAdjacentHTML and outerHTML: comments only. No `style=` in the html.
- Every id the playground modules use exists in `playground.html`: 124 references, 0 missing.
- `package.json` dependencies are unchanged.
- NOT RUN:
  - the browser smoke check (Acceptance 9), because the desktop app already listens on port 8787;
  - the manual checks M1 to M9.

### Follow-ups
- Run Acceptance 9 (console free of CSP and JS errors, light and dark, 375 px) and M1 to M9.

### Commit status
Committed on `AAP-41_playground-redesign` (768c302..e15b7e8). Not pushed, not merged.

### Polish
- Per-mode attachment lists (chat vs image); non-vision chat keeps attachments and blocks Send with a notice; empty model list shows a banner hint; aria fixes on model-search and tools-button.
