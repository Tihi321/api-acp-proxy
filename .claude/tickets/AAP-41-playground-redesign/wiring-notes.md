# AAP-41 wiring notes for T6 (from the T3, T4, T5 reports)

## sidebar.ts (T3)
- `initSidebar<C>(host: { chats(); setChats(next); currentId(); open(id); newChat(); busyId() })` -> `{ render(), focusSearch(), toggle(), setOpen(b) }`. It renders once at init.
- Call `sidebar.render()` after anything that changes chats, the open chat or a title: chat switch, new chat, send (`touchChat`), auto-title, stream completion.
- The sidebar calls `host.setChats(next)` and then renders. `setChats` must persist (save + trim) and refresh the chat header title (a rename can change the open chat). Used for pin, move, drag, rename, delete, undo. Deleting the open chat: `setChats` first, then `host.newChat()`.
- Prefs: `acp-playground-ui` is read-modify-written by each module; the sidebar changes only `sidebarOpen` and `sidebarWidth`. T6 must never overwrite the whole object from a stale in-memory copy.
- Global shortcuts stay in T6: Ctrl/Cmd+K -> `focusSearch()`; Ctrl/Cmd+Shift+S -> `toggle()`; Ctrl/Cmd+Shift+O -> `host.newChat()`.
- Sidebar owns (do not repeat): clicks on `#sidebar-toggle`, `#sidebar-open`, `#scrim`, `#new-chat`; Alt+Up/Down, F2, Delete on rows; Esc for drawer, row menu, rename, search. The drawer Esc is a document listener that skips `defaultPrevented` events: when T6's global Esc closes a popover or dialog first, call `preventDefault`.
- `host.open(id)` and `host.newChat()` must enforce the busy rule (D17) themselves.

## messages.ts (T4)
- Import `Msg`, `Meta`, `ImageRun` from `messages.js`; delete the moved code from `playground.ts`: the types, `markdownNodes`, `codeFigure`, `thinkingNode`, `previewBar`, the `waiting` map and its window `message` listener (moved into messages.ts with identical logic: two listeners would answer twice), `renderMessage`, `renderImageRun`, `waitingText`.
- `renderConversation(el("messages"), { messages, imageRuns, imageMode, busy }, actions)`; call after `setRunning(...)` so `busy` is right. It toggles `#empty` vs `#messages` and scrolls to the bottom.
- In init: `onStarter((text) => composer.fill(text))`; `onThinkingToggle(() => { if (!running) saveChats(); })`.
- `readStream`: `const target = streamTarget(answer, meta, started)`. Per reasoning delta (after updating `answer.reasoning`): `target.thinking()`. First content delta after thinking, once `answer.thoughtMs` is set: `target.thoughtDone()` (still set `answer.thinkingOpen = false` yourself). After each content delta: `target.schedule()`. Live rate: `target.rate(live)`. In `finally`: `target.stop()`. The adaptive timer lives in streamTarget.
- Image runs: `setElapsed(run.elapsedS)` replaces the timer's node lookup; set `run.refs = refImages.map(r => r.url)` (data URLs) when creating a run.
- Actions: `copy(msg)` -> return `navigator.clipboard.writeText(msg.content)`; `retry()`, `edit(i, text)`, `remove(i)` per D8; `retryImage(run)`, `removeImage(run)` (shown on every finished run).
- Slim-save fallback: map `attachments` to `""` entries (not drop the field) so bubbles show "Image not saved".
- Lightbox and preview pane are self-wired.
- Model label comes from `meta.model`, then `request.model`.

## composer.ts (T5)
- `initComposer(host: { send(text, attachments); stop(); busy(); model(); setModel(id); mode(); vision(); refreshModels?() })` -> `{ setModels(list), setBusy(b), clear(), clearText(), focus(), fill(text), imageFields(), files(), prefs(), refreshMode() }`.
- `host.send(text, dataUrls)` is called on Enter / Ctrl+Enter / Send with trimmed non-empty text, never while busy. In image mode it runs `validateImageForm` first and writes the error into `#notice-text` itself.
- The composer never clears itself: chat -> `composer.clear()` once accepted; image -> `clearText()` on success (reference images stay).
- Image request: `{ model, prompt, size: imageFields().size, ...imageFields().fields }` (fields holds only non-blank negative_prompt, steps, seed, guidance_scale). Multipart edits use `composer.files()` (File objects, same order); edit when `files().length > 0`.
- Toggles: T6 reads `#stream`, `#search`, `#images` checkboxes directly. The composer handles exclusion and persists Stream (and sets `#stream.checked` from prefs at init).
- After `loadModels`: `setModels(list)`. After chat switch, model change, kinds/vision update: `refreshMode()`. `mode()`, `vision()`, `model()` must already return the new values. `#model-refresh` -> `host.refreshModels`.
- `setBusy(true/false)` around requests.
- `exhausted_until` is an ISO string in `/v1/models`.
