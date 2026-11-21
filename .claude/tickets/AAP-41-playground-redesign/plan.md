---
status: done
request: REQ-0009
repos: [api-acp-proxy]
branch: AAP-41_playground-redesign
updated: 2026-11-21
---

# AAP-41 Playground redesign: a modern chat layout with pins, reordering and resizable panes

User request (verbatim): "update ui, make it far more user friendly, make it up to date with claude or gemini chat interfaces,, and reorder, pin it, resize parts of view, etc".

Reading chosen (full): rebuild the playground page (`/playground`) in the layout of current Claude and Gemini chat apps, and keep every feature it has today. That means:
- a collapsible sidebar you can resize, with a history you can search, pin, reorder, rename and delete from;
- a centred conversation column with a sticky composer at the bottom;
- a model picker inside the composer;
- attachments by button, drag and drop or paste;
- image-model settings in a popover;
- hover actions on messages;
- HTML preview in a resizable side pane;
- light and dark themes that follow the system;
- a responsive layout down to a narrow window.

Baseline: master as of `93403ad` plus whatever AAP-40 merges. AAP-40 does not touch `src/playground/**`, `src/playground-files.ts` or `tests/playground.test.ts`, so there is no overlap. Cut the branch from master after AAP-40 is merged. If AAP-40 is not merged yet, cut from master anyway; the files are disjoint.

What the code does today (read in full: `playground.html` 74 lines, `playground.css` 123, `playground.ts` 623, `lib.ts` 155, `markdown.ts` 650, `preview.html`, `src/playground-files.ts`, `tests/playground.test.ts`):
- **Static files:** compiled by `tsconfig.renderer.json` into `dist/playground/*.js`, with the HTML and CSS copied by `scripts/copy-static.mjs`. There is no bundler; the page loads ES modules by relative import. `servePlayground` serves only the whitelisted names in `FILES`, under `PLAYGROUND_CSP`: `script-src 'self'; style-src 'self'; img-src 'self' data:; frame-src 'self'`, with no `font-src`, so **no web fonts and no inline `style=""` attributes** (CSSOM `el.style.x = …` and `style.setProperty` are fine).
- **History:**
  - Kept in `localStorage["acp-playground-chats"]` as a JSON array of `Chat { id, title, model, system, updated, messages: Msg[] }`, most recent first, capped at `MAX_CHATS = 50` by `slice(0, 50)`.
  - When the quota is hit, the page saves a slim copy without `images`, `reasoning` and `thoughtMs`.
- **API key:** `sessionStorage["acp-playground-key"]`.
- **Image mode:**
  - It is on when the selected model has `kind === "image"` in `/v1/models`.
  - Prompt plus negative prompt, size (presets or custom W×H), steps, seed and guidance scale.
  - Up to 10 reference images; when there are any, the request goes to `/v1/images/edits` (multipart), otherwise to `/v1/images/generations`.
  - Image runs live in memory for the tab only.
- **Chat mode:**
  - Stream, Web search and Generate images toggles; web search and image output are mutually exclusive.
  - Optional system prompt.
  - Streaming with live markdown and a live `~N tok/s` estimate.
  - A thinking accordion; its open state is persisted.
  - Citations, generated images, and the error shown inline.
  - A meta line: streamed, TTFT, total, tokens, tok/s, finish.
  - Request JSON with Copy as curl.
  - Code blocks with a language label and Copy.
  - HTML/CSS/JS preview: Run opens a sandboxed iframe inline; Open in new tab is also offered.
- `/v1/models` also returns `vision` (boolean) and `exhausted_until` per model. Today's page ignores both.
- The chat API accepts `image_url` content parts (`src/api.ts`). Today's page never sends them; adding them is new, see D6.
- There are no MCP or tool features in the playground (MCP lives in the server and the desktop app). Nothing to carry over.

## Scope

1. **Layout:**
   - Collapsible left sidebar: a toggle button that remembers its state.
   - Sidebar width set by dragging a handle; the width is persisted, has a min and a max, and the handle works from the keyboard.
   - Centred conversation column with a max width.
   - Composer sticky at the bottom.
   - Right **preview pane** as a resizable split for HTML previews; it replaces the inline iframe.
2. **Composer:**
   - The textarea grows with its content.
   - Enter sends and Shift+Enter adds a new line. Ctrl/Cmd+Enter also sends; nothing sends during IME composition.
   - Attach button, drag and drop, and paste for images, with thumbnails you can remove.
   - Model picker in the composer: a button that opens a searchable popover, grouped by provider, with `image`, `vision` and `limit reached` badges.
   - Tools menu: Web search, Generate images, Stream; web search and image output stay mutually exclusive.
   - A Stop button replaces Send while a request runs. Esc in the composer stops it too.
   - "Image settings" popover with negative prompt, size, custom W×H, steps, seed and guidance. It is shown only for image models, and a dot on its button marks changes from the defaults.
3. **Messages:**
   - User messages in right-aligned bubbles; assistant replies as plain prose with a small model label.
   - Hover and focus actions:
     - Copy on every message;
     - Retry on the last answer;
     - Edit (and resend) on the last user message;
     - Delete on any message.
   - Image results in a grid; each image has Download and Open (a full-size lightbox).
   - The reasoning accordion is kept.
   - Timings in a subtle footer, with a proportional timing strip (D12).
   - Citations, request JSON and Copy as curl are kept.
4. **History:**
   - Search (by title and message text).
   - Pin and unpin; a **Pinned** section on top, in manual order.
   - Unpinned chats grouped as **Today**, **Yesterday**, **Previous 7 days** and **Older**.
   - Reorder by drag and drop within Pinned and within each date group; drag across sections to pin or unpin. Keyboard alternative: Alt+Up / Alt+Down, plus Move up / Move down in the row menu.
   - Inline rename.
   - Delete with an Undo toast.
5. **Settings dialog** (gear button in the sidebar footer): API key (still `sessionStorage`), Refresh models, the system prompt hint and the keyboard-shortcut list. The system prompt itself moves to a "Chat settings" popover in the chat header (per chat, as today).
6. **Theme:** light and dark follow the system, with one token set. Below 900 px the preview pane becomes a full overlay; below 720 px the sidebar becomes an overlay drawer with a scrim.
7. **Migration:** existing chats load unchanged; the new fields get defaults (D3).
8. **Accessibility:**
   - Visible focus rings and aria labels on icon buttons.
   - The resize handles are `role="separator"` with values.
   - Popovers and the dialog have focus management and close on Esc.
   - Shortcuts are listed in Settings.
9. **Docs:** README `## Playground` rewritten for the new UI.

## Out of scope

- Export/import of chats (not cheap with the image data URLs and quota handling; can be a later ticket).
- Persisting image-model runs in the history (they stay tab-only as today, D9).
- A manual light/dark switch (the system setting only).
- Server changes beyond adding the new file names to the `FILES` whitelist. No new endpoints, no CSP change.
- New runtime dependencies, web fonts and icon fonts. Icons are an inline SVG sprite in `playground.html`.
- Tool or MCP calls from the playground; branching or alternative versions of answers (Retry replaces the last answer, D8).
- The desktop app's own renderer pages.

## Design direction

**Subject:** a developer's bench for trying models through the proxy. People come to compare models and watch how an answer was made (TTFT, tok/s, tokens, request). So it should feel like Claude or Gemini for chatting: calm, centred prose, a floating rounded composer and a quiet sidebar. Its own identity comes from treating timing as a first-class, beautiful detail rather than a grey text line.

**The one bold thing: the timing strip.** Under each finished answer there is a 3 px hairline bar split proportionally into:
- *waiting* (up to TTFT, line colour);
- *thinking* (`thoughtMs`, amber);
- *writing* (the rest, signal teal).

To its right is a quiet line: `TTFT 1.2 s  ·  total 8.4 s  ·  412 in / 960 out  ·  71.3 tok/s`. While streaming, the writing segment grows and the live `~N tok/s` sits at its end. Image runs get a single segment for the total time. Everything else stays restrained.

Layout sketch (desktop, preview open):

```
+--------------------+--------------------------------------------+----------------------+
| [=] ACP Proxy  [+] |  Chat title (rename)          [chat ⚙] [⋯]  | Preview   [↻][↗][x] |
| [ Search chats   ] |                                             |                      |
|  Pinned            |          +---------------------------+      |   sandboxed iframe   |
|   ◆ Prompt tests ⋮ |          |  user bubble (right)      |      |                      |
|  Today             |          +---------------------------+      |                      |
|   Refactor ask   ⋮ |   codex/gpt-6-luna                          |                      |
|  Yesterday         |   ▸ Thought for 4.1 s                       |                      |
|   ...              |   Answer prose, max 720 px, markdown,       |                      |
|  Previous 7 days   |   code blocks with Copy                     |                      |
|  Older             |   ━━━━━━━━━━━━━━━━━━━━━  TTFT 1.2 s · 71 t/s |                      |
|                    |   [copy][retry][delete]    (on hover/focus) |                      |
|                    |  +---------------------------------------+  |                      |
|                    |  | [thumb][thumb]                        |  |                      |
|                    |  | Message ACP Proxy…                    |  |                      |
|  [⚙ Settings]      |  | [+] [tools] [model ▾] [img ⚙]  [Send] |  |                      |
+--------------------+--------------------------------------------+----------------------+
  ^ drag handle (sidebar width)                                   ^ drag handle (preview width)
```

Narrow (< 720 px): the sidebar is a drawer over a scrim, opened by `[=]` in the chat header. The composer spans the full width with a 12 px gutter, and the preview is a full-screen overlay.

**Tokens.** All are CSS custom properties on `:root`, redefined under `@media (prefers-color-scheme: dark)`. The cool graphite neutrals deliberately avoid the cream-and-terracotta Claude look-alike.

| token | light | dark | role |
|---|---|---|---|
| `--canvas` | `#F5F6F8` | `#121418` | page and sidebar background |
| `--surface` | `#FFFFFF` | `#1A1D23` | composer, popovers, user bubble base |
| `--ink` | `#171A21` | `#E7E9EE` | text |
| `--ink-2` | `#5D6372` | `#9BA2B0` | secondary text, meta |
| `--line` | `#E1E4EA` | `#2A2E37` | hairlines, borders |
| `--signal` | `#0B7A75` | `#3CC9BE` | accent: focus ring, Send, writing segment, active row bar |
| `--amber` | `#B4690E` | `#E6A44A` | thinking segment, the "changed" dot |
| `--danger` | `#C2362F` | `#F2766E` | errors, delete |
| `--bubble` | `#E9EEF3` | `#242933` | user bubble fill |

The existing syntax-token colours (`--tok-*`) are kept as they are.
- Radii follow hierarchy, not one value: composer 20 px, bubbles 18 px, popovers 12 px, rows and buttons 8 px, thumbs 10 px.
- One shadow token, for floating things only (composer and popovers): `0 1px 2px rgb(0 0 0 / .06), 0 8px 24px rgb(0 0 0 / .08)`; dark mode uses a darker alpha.
- Motion: 120 ms ease for opening and closing popovers and the drawer, plus the strip growing while streaming. `prefers-reduced-motion: reduce` turns transitions off.

**Typography.** System stacks only, because the CSP has no `font-src`.
- UI and prose: `"Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, sans-serif`.
- Display, for the empty-state greeting and chat titles: `"Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif`.
- Mono: `"Cascadia Code", "Cascadia Mono", Consolas, ui-monospace, monospace`.
- Scale (about 1.2): 12 (meta, badges), 13 (sidebar rows, buttons), 15/1.65 (conversation prose; prose column max 720 px, about 75 characters), 18 (chat title), 28/1.2 light 300 (empty-state greeting).
- Sentence case everywhere, no all-caps labels. Section headers in the sidebar are 12 px `--ink-2`, weight 600, normal case.

**What makes it feel like Claude or Gemini:**
- no card borders around messages;
- assistant text sits directly on the canvas;
- the user's turn is a soft bubble;
- the composer floats as a rounded surface with a shadow, and its controls sit inside it;
- actions appear on hover;
- the sidebar is quiet, with date groups;
- the empty state is a centred greeting ("What should we try?") with the model picker and three starter chips. The chips fill the composer and do not send.

## Decisions

1. **Modules, not one 1,300-line file.** `playground.ts` is split into ES modules loaded by relative import (no bundler needed):
   - `dom.ts` (helpers);
   - `history.ts` (pure history logic);
   - `sidebar.ts`;
   - `messages.ts` (rendering, moved out of `playground.ts` mostly verbatim);
   - `composer.ts`;
   - `playground.ts` (state, requests, wiring).

   `lib.ts` and `markdown.ts` stay. Each new `.js` name is added to `FILES` in `src/playground-files.ts`, because the whitelist is the only gate.
2. **Storage keys:**
   - `localStorage["acp-playground-chats"]`: same key and same array shape, with optional new fields per chat:
     - `pinned?: boolean`;
     - `order?: number`: a manual rank, bigger is higher in its section.

     No version field is needed, because the shape is a superset.
   - `localStorage["acp-playground-ui"]`, new: `{ sidebarOpen: boolean, sidebarWidth: number, previewWidth: number, stream: boolean, image: { negative, size, width, height, steps, seed, guidance } }`, parsed with defaults by a pure `parseUiPrefs`. Persisting the image settings and the Stream toggle is new and cheap. Web search and Generate images are not persisted; they reset per page load as today.
   - `sessionStorage["acp-playground-key"]`: unchanged.
   - All access stays wrapped in try/catch; the page works with no storage.
3. **Migration (`normalizeChats`, pure):**
   - Entries without an array `messages` are dropped (as today).
   - `pinned` defaults to `false`.
   - A missing or non-finite `order` becomes `length - index` of the stored array. Today's array is most recent first, so the first visible order equals today's.
   - The result is saved back only on the next normal save; there is no write at load.
4. **Ordering model:**
   - Sections: **Pinned** (pinned chats, by `order` descending), then the unpinned chats bucketed by `dateGroup(updated, now)`:
     - `today`: the same local calendar day;
     - `yesterday`;
     - `week`: 2 to 7 calendar days ago;
     - `older`.

     Inside a bucket, chats are sorted by `order` descending.
   - Sending in a chat (activity) sets `updated = now` and `order = max(order) + 1`, so it jumps to the top of Today, like Claude and Gemini. A pinned chat keeps its pinned position on activity: only `updated` changes, `order` does not.
   - Dragging reorders within a section: `moveChat` renumbers that section only.
   - Dropping an unpinned chat into Pinned pins it at the drop position; dropping a pinned chat into an unpinned group unpins it. It then lands in the bucket of its own `updated` at the top, since `order` is set to that bucket's max + 1.
   - An unpinned chat cannot be dragged into another date bucket; the drop indicator is not shown there, because its date decides the bucket.
5. **Cap:** `trimChats` keeps every pinned chat plus the newest unpinned chats by `updated` until the total is 50 (pinned count unlimited). This replaces `slice(0, 50)`, which could drop a pinned chat.
6. **Attachments for chat models (new, small):**
   - The attach button, drop and paste are enabled when the model is an image model (as reference images) or a chat model whose `vision !== false`. A model listed with `vision: false` shows the button disabled with the title "This model does not take images".
   - Chat images are sent as OpenAI content parts: the user message `content` becomes `[{ type: "text", text }, …{ type: "image_url", image_url: { url: dataUrl } }]`, built by a pure `userContent(text, images)`. With no images it stays a plain string.
   - They are stored on the user message as `attachments?: string[]` (data URLs) and resent in later turns of that chat.
   - The quota fallback drops `attachments` along with `images`. After that, those turns resend as text only, and the bubble shows "Image not saved" placeholders.
   - The stored `request` of an answer replaces each data URL with `"data:…(N KB)"`, so history does not hold every image twice; Copy as curl then contains the placeholder. The live (unsaved) request object keeps the real URLs until the page reloads.
   - Limits on the client: 10 images per message and image types only. The proxy's `maxBodyBytes` (default 20 MB) is the real limit, and its 413 error is shown inline.
7. **Send keys:** Enter sends and Shift+Enter inserts a newline. Ctrl/Cmd+Enter also sends, kept for old habits. Nothing sends while `isComposing` (IME). The rule is a pure `sendKey({ key, shiftKey, ctrlKey, metaKey, altKey, isComposing })`. The placeholder says "Message (Enter to send, Shift+Enter for a new line)" and "Describe the image…" in image mode.
8. **Message actions:**
   - Copy: the raw markdown of an answer, or the text of a user message.
   - **Retry**, on the last assistant message only: removes it and runs the answer again from the same history, with the current model and toggles.
   - **Edit**, on the last user message only: turns the bubble into a textarea with Save & send and Cancel. Saving replaces the text, drops the answer after it and sends again.
   - **Delete:** on a user message it deletes that message and the answer that follows; on an answer, only the answer. Undo comes through the same toast as chat delete.
   - All actions are disabled while a request runs.
   - In image mode a run has Retry (same prompt and settings) and Delete; there is no Edit.
9. **Image runs stay tab-only**, as today. They are drawn in the same layout:
   - a user bubble with the prompt and reference thumbs;
   - an assistant block with the image grid;
   - per image, Download (`<a download>` with a data URL, as today) and Open (a `<dialog>` lightbox; Esc and the backdrop close it). A new tab with a data URL is not used, because browsers block top-level data: navigation.

   The "Waiting for the model…" elapsed counter is kept.
10. **Preview pane:**
    - **Run** opens the preview in the right pane, a split with a drag handle: min 320 px, max 70 % of the window, default 45 %, persisted as `previewWidth` in px and clamped on resize.
    - The pane shows one preview at a time: running another answer replaces it.
    - Header: the title of the source message, Reload (re-posts the same HTML into a fresh iframe), Open in new tab (as today) and Close.
    - The iframe, the `preview.html` handshake and `PREVIEW_CSP` are unchanged; only where the frame lives changes.
    - Below 900 px the pane is a full overlay.
11. **Model picker:**
    - A `<button aria-haspopup="listbox">` showing the short model name. The popover holds a search input, then the provider groups from `groupModels` filtered by a pure `filterModelGroups(groups, query)`, as a `role="listbox"` with `aria-activedescendant`.
    - Keys: arrows, Home/End, Enter to pick, Esc to close, and typing goes to search.
    - Badges: `image` (kind), `vision`, `limit reached` (when `exhausted_until` is in the future; the model can still be picked).
    - Refresh is a small icon in the popover header and also sits in Settings.
    - The hidden native `<select id="model">` is removed; the current model lives in a module variable.
12. **Timing strip** (the signature element): pure `timingSegments(meta, thoughtMs)` returns `{ wait, think, write }` fractions that sum to 1. The values are:
    - wait = `firstMs` minus the thinking time when thinking came first;
    - think = `thoughtMs`;
    - write = the rest.

    When the values are missing it falls back to a single write segment. Segment widths are set with `style.flexGrow` (CSSOM, allowed by the CSP). The full meta text stays in a `title` and is readable by screen readers.
13. **Keyboard shortcuts:**

    | Shortcut | Action |
    |---|---|
    | Ctrl/Cmd+Shift+O | new chat |
    | Ctrl/Cmd+Shift+S | toggle sidebar |
    | Ctrl/Cmd+K | search chats (opens the sidebar if collapsed) |
    | Shift+Esc | focus composer |
    | Esc | stop the running request when the composer has focus; otherwise close the open popover, dialog, drawer or rename field |
    | Alt+Up / Alt+Down | move the focused history row |
    | F2 | rename the focused row |
    | Delete | delete the focused row (with Undo) |
    | Ctrl/Cmd+/ | open the shortcut list |

    - Ctrl+Shift+S is the browser's screenshot shortcut in Firefox and may not be overridable there; the toggle button stays the main way.
    - Shortcuts are ignored while typing in an input, except the Ctrl/Cmd ones and Shift+Esc.
14. **Sidebar resize:** a `role="separator"` handle with `aria-orientation="vertical"`, `aria-valuemin=200`, `aria-valuemax=420`, `aria-valuenow`, `tabindex=0` and the label "Resize sidebar".
    - Pointer drag uses pointer capture.
    - Keys: Left/Right change the width by 16 px, Home/End jump to min/max, and Enter or a double-click resets to 264 px.
    - The width is applied as `--sidebar-w` on `.app` via `style.setProperty`.
    - Collapsed means width 0, the handle hidden, and the toggle in the chat header.
    - Under 720 px the stored width is ignored (drawer 85 vw, max 320 px).
15. **Delete with undo:** the chat is removed and saved at once, and a toast "Chat deleted" with **Undo** (6 s, `role="status"`) restores it with its old `pinned`, `order` and `updated`. Only the last deletion can be undone. Deleting the open chat opens a new empty chat.
16. **Rename:** double-click the title, F2, or Rename in the row menu turns the title into an input. Enter or blur saves (the text is trimmed; empty keeps the old title) and Esc cancels. The chat header title is the same field. A renamed chat keeps its title: `chatTitle` only runs while the title is "New chat", as today.
17. **The busy rule is kept:** while a request runs, switching chats, New chat and history edits that touch the running chat are blocked, as today (`if (running) return`). Pin, reorder and rename of *other* chats stay allowed.

## Contracts

### K1 `src/playground/history.ts` (new, pure: no DOM, no storage)

```ts
export interface ChatLike { id: string; title: string; updated: number; pinned?: boolean; order?: number; messages: Array<{ role: string; content: string }> }
export type DateGroup = "today" | "yesterday" | "week" | "older";
export interface Section { key: "pinned" | DateGroup; label: string; ids: string[] }  // labels: Pinned, Today, Yesterday, Previous 7 days, Older
export function normalizeChats<T extends ChatLike>(raw: unknown): T[];            // D3
export function dateGroup(updated: number, now: number): DateGroup;                // local calendar days
export function historySections(chats: readonly ChatLike[], now: number, query = ""): Section[]; // D4; empty sections left out; query matches title or any message content, case-insensitive, trimmed
export function touchChat<T extends ChatLike>(chats: readonly T[], id: string, now: number): T[];   // D4 activity
export function setPinned<T extends ChatLike>(chats: readonly T[], id: string, pinned: boolean, now: number): T[]; // goes to top of its target section
export function moveChat<T extends ChatLike>(chats: readonly T[], id: string, target: { section: Section["key"]; index: number }, now: number): T[]; // D4; returns chats unchanged for a forbidden target
export function trimChats<T extends ChatLike>(chats: readonly T[], max = 50): T[];  // D5
```

All functions return new arrays and new objects for the changed chats; they never mutate their input.

### K2 additions to `src/playground/lib.ts` (pure)

```ts
export function sendKey(e: { key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean; isComposing: boolean }): boolean; // D7
export function userContent(text: string, images: readonly string[]): string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>; // D6
export function elideDataUrls(value: unknown): unknown;  // deep copy, every "data:" string -> "data:…(N KB)"
export function filterModelGroups(groups: readonly ModelGroup[], query: string): ModelGroup[]; // case-insensitive substring on id; empty groups dropped
export interface UiPrefs { sidebarOpen: boolean; sidebarWidth: number; previewWidth: number; stream: boolean; image: { negative: string; size: string; width: string; height: string; steps: string; seed: string; guidance: string } }
export function parseUiPrefs(raw: string | null): UiPrefs;  // defaults: open, 264, 0 (=45 % at first open), stream true, size "1024x1024", rest ""; widths clamped 200..420 / >=0; junk -> defaults
export function clamp(value: number, min: number, max: number): number;
export function timingSegments(meta: { firstMs?: number; totalMs: number }, thoughtMs?: number): { wait: number; think: number; write: number }; // D12
```

### K3 Module seams (DOM modules; names are binding, internals free)

- `dom.ts`:
  - `el`, `make` (moved from `playground.ts`);
  - `icon(name): SVGSVGElement`, which builds `<svg><use href="#i-NAME">`;
  - `storage`, `local`, `session` (moved);
  - `toast(text, action?: { label, run })`.
- `messages.ts`: `renderConversation(box, view: { messages: Msg[]; imageRuns: ImageRun[]; imageMode: boolean; busy: boolean }, actions: { copy(msg), retry(), edit(index, text), remove(index), retryImage(run), removeImage(run) })`, plus `streamTarget()` for the live update of the last answer (body node, thinking node, rate node, strip). It also exports `openPreview(html, title)`, `closePreview()`, `openLightbox(url)` and moves `markdownNodes`, `codeFigure` and `thinkingNode` here. The `Msg`, `Meta` and `ImageRun` types move to `messages.ts` and are re-exported from there.
- `sidebar.ts`: `initSidebar(host: { chats(): Chat[]; setChats(next: Chat[]): void; currentId(): string; open(id): void; newChat(): void; busyId(): string | undefined })` returns `{ render(), focusSearch(), toggle(), setOpen(b) }`. It owns collapse, resize, search, rows, the row menu (Pin/Unpin, Rename, Move up, Move down, Delete), drag and drop, and undo.
- `composer.ts`: `initComposer(host: { send(text, attachments: string[]): void; stop(): void; busy(): boolean; model(): string; setModel(id): void; mode(): "chat" | "image"; vision(): boolean | undefined })` returns `{ setModels(list: Array<{ id; kind?; vision?; exhausted_until? }>), setBusy(b), clear(), focus(), fill(text), imageFields(): { size, fields }, prefs() }`. It owns autogrow, attachments (button, drop, paste, thumbs), the model picker, the tools menu and the Image settings popover.
- `playground.ts`:
  - state: chats, current, running, imageRuns, kinds/vision;
  - `send`, `readStream` and `sendImage`, with the request logic unchanged except D6 and D8;
  - storage via K1/K2;
  - global shortcuts and the Settings dialog;
  - the preview message handshake (unchanged).

### K4 DOM ids kept or added (for manual checks and future tests)

- Kept: `#messages`, `#notice` (now an inline banner above the composer), `#key` (moved into the Settings dialog), `#system` (moved into the Chat settings popover), `#stop`, `#send`, `#input`, `#new-chat`, `#history`, `#stream`, `#search`, `#images`, the `#img-*` fields (moved into the Image settings popover). `#img-files` stays a hidden file input behind the attach button.
- Added: `#sidebar`, `#sidebar-toggle`, `#sidebar-resize`, `#history-search`, `#model-button`, `#model-pop`, `#tools-button`, `#image-settings-button`, `#attach`, `#preview-pane`, `#preview-resize`, `#lightbox`, `#settings`, `#toast`.
- Removed: `#model` (the select) and `#refresh` (it moves into the picker header and Settings as `#refresh-models`).

## Files

| file | change |
|---|---|
| `src/playground/history.ts` | new, K1 |
| `src/playground/lib.ts` | K2 additions; existing exports unchanged |
| `src/playground/dom.ts` | new, K3 |
| `src/playground/messages.ts` | new, rendering moved from `playground.ts` plus new layout, actions, preview pane, lightbox |
| `src/playground/sidebar.ts` | new |
| `src/playground/composer.ts` | new |
| `src/playground/playground.ts` | slimmed to state, requests and wiring |
| `src/playground/playground.html` | new structure, SVG icon sprite, dialogs |
| `src/playground/playground.css` | rewritten with tokens (sections marked `/* == base == */`, `/* == sidebar == */`, `/* == conversation == */`, `/* == composer == */`, `/* == preview == */`, `/* == overlays == */`) |
| `src/playground/preview.html` | unchanged |
| `src/playground/markdown.ts` | unchanged |
| `src/playground-files.ts` | `FILES` += `history.js`, `dom.js`, `messages.js`, `sidebar.js`, `composer.js` |
| `tests/playground.test.ts` | 2 new tests in "playground helpers", plus the new names in the serving test's file list |
| `README.md` | `## Playground` section rewritten |

`scripts/copy-static.mjs` needs no change (it copies every html and css file in the folder), and `tsconfig.renderer.json` already includes `src/playground`.

## Tasks

Order: T1, then T2, then T3, T4 and T5 (disjoint files, can run in parallel), then T6, then T7. Every task ends with `fnm exec --using default npm.cmd run typecheck`. T1, T6 and T7 also run `npm.cmd test` and `npm.cmd run build`.

### T1 Pure logic, whitelist, tests
- **Owns:** `src/playground/history.ts`, `src/playground/lib.ts` (additions only), `src/playground-files.ts`, `tests/playground.test.ts`.
- K1 and K2 exactly.
- Tests, per test-discipline (two new `it`s, no near-duplicates):
  1. "history: migrates old chats, sections pinned and date groups, moves, pins, trims". It covers:
     - an old array without `pinned`/`order` keeps its visible order;
     - `dateGroup` boundaries at local midnight for yesterday, day 7 and day 8;
     - `historySections` with a query;
     - `moveChat` within Pinned, a forbidden cross-bucket move returning the input unchanged, and a drop into Pinned pinning the chat;
     - `touchChat` moving an unpinned chat to the top of Today while a pinned chat keeps its place;
     - `trimChats` never dropping a pinned chat.
  2. "composer and request helpers: send key, content parts, elided data URLs, prefs, timing". It covers:
     - `sendKey` for Enter, Shift+Enter, Ctrl+Enter and IME;
     - `userContent` with and without images;
     - `elideDataUrls` keeping other strings;
     - `parseUiPrefs` junk and clamping;
     - `timingSegments` summing to 1 with and without thinking.
- Add `history.js`, `dom.js`, `messages.js`, `sidebar.js` and `composer.js` to the written-files list of the serving test, and assert that one of them is served. This is an extra `expect`, not a new test.

### T2 Shell markup, tokens, base CSS, dom helpers
- **Owns:** `src/playground/playground.html`, `src/playground/playground.css`, `src/playground/dom.ts`.
- HTML:
  - the full structure for K4: `.app` grid with columns `sidebar | handle | main | handle | preview`;
  - the SVG `<symbol>` sprite, with these icons: menu, plus, search, pin, pin-off, more, pencil, trash, copy, retry, attach, send, stop, chevron, sliders, image, globe, gear, close, external, download, expand, grip;
  - Settings `<dialog>`, Lightbox `<dialog>`, the toast region;
  - the Chat settings popover holding `#system`;
  - the Image settings popover holding all `#img-*` fields;
  - the tools menu holding the `#stream`, `#search` and `#images` checkboxes as switch rows.
- CSS: every token, layout, component and responsive rule from the Design direction for all sections. T3–T5 may edit only their marked section if they find a gap, and must not touch the others.
- The layout must work with no JS for the static parts. Keep the `[hidden] { display: none !important }` rule.

### T3 Sidebar
- **Owns:** `src/playground/sidebar.ts` and the `/* == sidebar == */` CSS section.
- K3 `initSidebar`:
  - collapse with the remembered state, and resize (D14);
  - search with a 120 ms debounce;
  - section rendering from `historySections`. Each row shows the title, and on hover or focus the model and relative time ("2 h ago") as its `title`;
  - row menu (a popover button with `aria-haspopup="menu"`);
  - inline rename (D16);
  - HTML5 drag and drop with a drop line indicator, using the `moveChat` targets;
  - Alt+Up/Down and F2/Delete on a focused row (D13);
  - delete with Undo (D15);
  - the drawer mode under 720 px (scrim click and Esc close it).
- Rows are `<li>` with a `<button>` that opens the chat (`aria-current="page"` on the open one). The list is a `role="list"`; no ARIA tree is needed.

### T4 Conversation rendering
- **Owns:** `src/playground/messages.ts` and the `/* == conversation == */`, `/* == preview == */` and `/* == overlays == */` CSS sections.
- Move the markdown, code, thinking, citations and request rendering from `playground.ts` without changing behaviour; textContent only, never innerHTML with model text.
- New:
  - the bubble and prose layout;
  - the model label;
  - hover and focus action bars (D8), each an icon button with `aria-label`, revealed on `:hover` and `:focus-within`, always visible on touch (`@media (hover: none)`);
  - the image grid with Download and Open (D9);
  - the timing strip and footer (D12);
  - the preview pane with its resize handle (D10, same separator rules as D14);
  - the lightbox;
  - the empty state (greeting plus three starter chips, which call `fill`).
- The streaming update path keeps the adaptive render timer from today's `readStream`, exposed through `streamTarget()`.

### T5 Composer
- **Owns:** `src/playground/composer.ts` and the `/* == composer == */` CSS section.
- K3 `initComposer`:
  - autogrow textarea up to 40 vh, scrolling after that;
  - `sendKey` (D7);
  - attachments: button, drop on the whole main column with a "Drop images to attach" overlay, and paste (D6);
  - thumbnails with remove, built with FileReader data URLs as today;
  - the model picker (D11);
  - the tools menu, keeping today's mutual-exclusion rule for web search and images;
  - Image settings (D2 prefs, the "changed" dot, custom size fields shown for "custom", `validateImageForm` before send);
  - Send and Stop swap (`#stop` shown while busy).
- In image mode the tools button is hidden and the Image settings button is shown; in chat mode the reverse.

### T6 Wiring
- **Owns:** `src/playground/playground.ts`.
- State and storage:
  - load with `normalizeChats`;
  - save with `trimChats` and the slim fallback, which now also drops `attachments`;
  - `touchChat` on activity;
  - prefs.
- Requests:
  - `send`: text plus attachments through `userContent` (D6), the stored request through `elideDataUrls`;
  - `readStream` and `sendImage`, unchanged apart from rendering through `messages.ts`;
  - Retry, Edit and Delete (D8).
- Global shortcuts (D13), the Settings dialog (key, Refresh, shortcuts list), and the chat header (title rename, Chat settings, the `[=]` toggle when collapsed).
- Keep the preview `message` handshake unchanged.
- A 401 on models shows the notice "Enter the proxy's API key in Settings." with an "Open settings" button.

### T7 Docs and full verification
- **Owns:** `README.md` (the `## Playground` section only).
- Rewrite the section for the new UI, keeping every existing statement about TTFT, tok/s, preview sandboxing, the CSP and storage. Add:
  - the storage keys;
  - pins and reorder;
  - the attachments rule (D6);
  - the shortcut table (D13).
- Run `npm.cmd test`, `npm.cmd run typecheck` and `npm.cmd run build`, check that `dist/playground/` has all 7 `.js` files plus the html and css, then start the proxy and load `/playground` (see Acceptance 9).

## Acceptance criteria (with proofs)

1. **Old history loads unchanged.** Proof: test 1 (migration keeps visible order and defaults `pinned: false`). Manual check M1.
2. **Pin, reorder, date groups, trim.** Proof: test 1 (`historySections`, `moveChat` including a forbidden move, `setPinned`, `touchChat`, `trimChats` keeping pinned).
3. **Send-key rule and content parts.** Proof: test 2 (`sendKey`, `userContent`, `elideDataUrls`).
4. **Prefs survive junk and clamp widths; the timing strip adds up.** Proof: test 2.
5. **Every new module is served and nothing else.** Proof: the serving test, extended with the new names (unknown names still 404, CSP unchanged).
6. **Existing tests keep passing.** Proof: `fnm exec --using default npm.cmd test` is green, including the markdown, highlight, image-form and CSP tests, which are unchanged.
7. **Types and build.** Proof: `npm.cmd run typecheck` and `npm.cmd run build` are green; `dist/playground` lists `playground.js lib.js markdown.js history.js dom.js messages.js sidebar.js composer.js playground.html playground.css preview.html`.
8. **No model text as HTML.** Proof: `grep -n "innerHTML\|insertAdjacentHTML\|outerHTML" src/playground/*.ts` returns nothing (the SVG sprite is static HTML in `playground.html`).
9. **The page loads with no CSP violations.** Proof (agent, in the built-in browser): start `npm.cmd run dev`, open `http://127.0.0.1:8787/playground` and check that `read_console_messages` shows no CSP or JS errors. This also catches inline `style=""` in the HTML, which the CSP blocks. Take a screenshot in light and dark (`resize_window colorScheme`) at desktop width and at 375 px. This is only a smoke check: it is UNTESTED against real providers unless one is logged in.
10. **No new runtime dependency.** Proof: `package.json` `dependencies` is unchanged in the diff.

## Manual checks for the user (UNTESTED by agents)

- **M1:** open the playground with your existing history. All chats are there under date groups. Open one, send a message, and it moves to the top of Today.
- **M2:** pin two chats, then drag them to swap. Reload, and the order holds. Drag a pinned chat into Today and it unpins. Alt+Up/Down on a focused row moves it.
- **M3:** rename a chat inline (double-click and F2). Delete a chat, then Undo; it comes back in the same place.
- **M4:**
  - Collapse the sidebar and reload: it stays collapsed.
  - Drag the sidebar wider and reload: the width is kept.
  - Use arrow keys on the focused handle.
  - Narrow the window below 720 px: the sidebar becomes a drawer.
- **M5:** the composer:
  - Enter sends and Shift+Enter adds a newline;
  - paste a screenshot into a vision chat model, send, and the model sees it;
  - drag two files onto the page and remove one thumbnail.
- **M6:** pick an image model in the model picker (search for it): Image settings appears, tools are hidden. Generate, then edit with a reference image. Use Download and Open full size in the grid.
- **M7:** ask for an HTML page and Run it: it opens in the right pane. Resize the pane, Reload it, open it in a new tab, close it.
- **M8:** stream a reasoning model: the thinking accordion, the live tok/s, then the timing strip with an amber segment. Then Retry, Edit and resend the last message, and Copy an answer.
- **M9:** switch the OS to dark mode and check the contrast. Press Ctrl+/ for the shortcut list; Ctrl+Shift+O, Ctrl+K and Shift+Esc work.

## Risks

- **Large refactor of a working page.** The streaming, image and preview logic is moved, not rewritten. T4 and T6 must keep `readStream`, `sendImage` and the preview handshake semantically identical (diff review against the old functions). Regressions show up only in the manual checks, since there is no DOM test harness, by choice.
- **CSP surprises.** No inline `style` attributes, no `blob:` images (thumbs stay data URLs), no web fonts, and `<use href="#…">` only for same-document symbols. Acceptance 9 catches violations in the console.
- **Quota.** Chat attachments as data URLs can fill `localStorage` fast. They are mitigated by elided requests (D6) and the slim fallback, and they lose images on fallback, which is visible as "Image not saved".
- **Drag and drop on touch.** HTML5 DnD does not work on touch screens; the row menu's Move up and Move down are the touch path.
- **Ctrl+Shift+S in Firefox** may stay the browser screenshot shortcut. The button and the Ctrl+K fallback remain.
- **Vision detection.** Models with `vision` undefined allow attaching. A provider that rejects images answers with an error, which is shown inline; nothing is silently dropped.
- **Parallel T3, T4 and T5 sharing one CSS file.** Each edits only its marked section; T2 has to deliver all sections first.

## T6 status (implementer)
- DONE: `src/playground/playground.ts` rewritten (state, storage, requests, Retry/Edit/Delete with Undo, header rename, Chat settings, Settings dialog, shortcuts, 401 notice). Verified: test 508 passed, typecheck and build green, dist/playground has all files, id check 124 refs / 0 missing. UNTESTED in a browser.
- Deviation: changing the model while a request runs is refused with a toast (the old select allowed it and could swap the view mid-stream).
