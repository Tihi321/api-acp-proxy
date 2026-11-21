# AAP-41 DOM map (from T2, for T3-T6)

Source of truth is `src/playground/playground.html` and `playground.css`; this is a summary.

## Layout and state
- `.app` grid: sidebar | `#sidebar-resize` | main | `#preview-resize` | `#preview-pane`.
- `--sidebar-w` (px) on `.app`, default 264px. `--preview-w` (px) on `.app`, default `clamp(320px,45vw,70vw)`.
- Collapsed sidebar: `.app.sidebar-collapsed` (also set `hidden` on `#sidebar-resize` to drop it from tab order).
- Preview open: `.app.preview-open`; also remove `hidden` from `#preview-pane` and `#preview-resize` (both start hidden).
- Drawer under 720px: `.app.drawer-open` shows sidebar and `#scrim`.
- Handles get `.dragging` during a drag.
- Popovers: toggle `hidden` on the `.pop` element; keep the button's `aria-expanded` in sync. `.pop` opens upward by default, `.pop.down` downward, `.pop.right` right-aligned; `.pop-anchor` is the positioning wrapper.

## Ids
- Kept: `#messages`, `#notice`, `#key`, `#system`, `#stop`, `#send`, `#input`, `#new-chat`, `#history`, `#stream`, `#search`, `#images`, `#img-negative`, `#img-size`, `#img-custom`, `#img-width`, `#img-height`, `#img-steps`, `#img-seed`, `#img-guidance`, `#img-files` (hidden input), `#img-thumbs`, `#composer` (form).
- K4 added: `#sidebar`, `#sidebar-toggle`, `#sidebar-resize`, `#history-search`, `#model-button`, `#model-pop`, `#tools-button`, `#image-settings-button`, `#attach`, `#preview-pane`, `#preview-resize`, `#lightbox`, `#settings`, `#toast`, `#refresh-models` (in Settings).
- Extra: `#settings-button` (sidebar footer), `#settings-close`; chat header `#sidebar-open` (`.open-sidebar`, shown when collapsed or < 720px), `#chat-title` (h1, tabindex 0), `#chat-title-input` (hidden rename input), `#chat-settings-button`, `#chat-settings-pop`; notice `#notice-text`, `#notice-action` (`#notice` is a div: set `#notice-text`, not `#notice.textContent`); empty state `#empty` (sibling of `#messages` in `.stage`; `#messages` starts hidden) with `#starters` (`.chip[data-prompt]`); composer `#tools-anchor`, `#tools-pop`, `#image-settings-anchor` (starts hidden), `#image-settings-pop`, `#image-settings-dot` (hidden `.dot`), `#model-anchor`, `#model-label`, `#model-search`, `#model-list`, `#model-refresh` (picker header); `#drop-overlay`; preview `#preview-title`, `#preview-reload`, `#preview-tab`, `#preview-close`, `#preview-body`; `#lightbox-img`, `#lightbox-close`; `#scrim`.
- Separators: `#sidebar-resize` (200/420/264, "Resize sidebar"); `#preview-resize` (valuemin 320, valuemax 1200, valuenow 0: T4 updates). Both role=separator, vertical, tabindex 0.
- `#settings` `<dialog class="dialog">` (system-prompt hint + D13 shortcuts table). `#lightbox` `<dialog class="lightbox">` with `img#lightbox-img`. `#toast` role=status.
- Icons: menu plus search pin pin-off more pencil trash copy retry attach send stop chevron sliders image globe gear close external download expand grip check. Use `icon(name)` from `dom.ts`.

## Sidebar classes (T3)
- `#history` is `<div class="history" role="list">`. Section `.hist-section` with `.hist-h` header and `ul.hist-list`; empty text `.hist-empty`; `.hist-section.drop-over` drop target.
- Row `li.row` (`.active`, `.menu-open`, `.dragging`): `button.row-open` containing `svg.row-pin` (icon("pin")), `.row-title`, `input.row-title-input`; then `button.icon-btn.row-more`.
- Row menu `.pop.down.right.row-menu` > `.menu` > `button.menu-item` (`.danger` for Delete), `.menu-sep`.
- Drop line `li.drop-line`. Chrome: `.side-head`, `.brand`, `.side-search`, `.side-foot`, `.side-btn`.

## Conversation classes (T4)
- Empty: toggle `hidden` on `#empty` and `#messages` (do not clear `#empty`). `.messages .empty` paragraph still styled for image mode.
- `.msg.user` / `.msg.assistant`; `.msg.user .text` is the bubble; `.who`, `.text`, `.body` (`.pending` cursor), `.error`, `.elapsed`; user attachments `.attach-row` > `img.attach-thumb` or `.attach-missing`; edit mode `.msg-edit` (textarea + `.edit-bar`).
- Actions `.actions` > `button.icon-btn` (`.danger` for delete); shown on hover/focus-within, always on touch.
- Timing `.timing` > `.strip` (`.seg.wait`, `.seg.think`, `.seg.write`, widths via `style.flexGrow`) + `.meta`; live `.rate`.
- `.thinking`, `summary.pending`, `.thinking-text`, `.cites`, `details > pre` (`.request` caps height), `figure.code`, `button.copy`, `.table-wrap`, `.preview-bar`.
- Images `.image-grid` > `.image-tile` (img + `.tile-actions` with `button.icon-btn` or `a`).
- Preview `.preview-pane`, `.pane-head`, `.pane-title`, `.pane-body`, `iframe.preview`.
- Overlays `.dialog`, `.dialog-head`, `.dialog-body`, `.shortcuts`, `.lightbox`, `.lightbox-close`; toast `.toast-item`, `.toast-text`, `.toast-action` (dom.ts).

## Composer classes (T5)
- `.composer-wrap`, `.composer`, `.composer-bar`.
- Thumbs `#img-thumbs.thumbs` > `.thumb` (img + `button.thumb-remove` with icon("close")).
- `.pill` (model button) `.pill-label`; `.send` (`#stop` also `.stop`).
- Tools `.switch-row`, `.switch-text`, `input.switch`.
- Picker `.model-pop`, `.model-head`, `.model-list`, `.model-group-h`, `.model-opt` (`.active` = active descendant, `aria-selected` = chosen), `.model-name`, `.model-empty`, `.badge` + `.image` / `.vision` / `.limit`.
- Image settings `.image-settings-pop`, `.img-form`, `.field`, `.field-row`, `.dot`.
- Drop `.drop-overlay`, `.drop-card`.

## Tokens
Plan tokens plus `--line-2`, `--signal-ink`, `--hover`, `--active`, `--scrim`, `--shadow`, `--r-composer`, `--r-bubble`, `--r-pop`, `--r-ctl`, `--r-thumb`, `--dur`, `--ease`, `--font-ui`, `--font-display`, `--font-mono`.
