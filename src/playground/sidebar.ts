// The playground sidebar: collapse and resize, search, date sections, row menu, inline rename, drag and drop, undo. Titles go in through textContent only.

import { clamp, parseUiPrefs } from "./lib.js";
import { dateGroup, historySections, moveChat, setPinned, type ChatLike, type Section } from "./history.js";
import { el, icon, local, make, storage, toast } from "./dom.js";

type SideChat = ChatLike & { model?: string };

export interface SidebarHost<C extends SideChat> {
  chats(): C[];
  /** Expected to persist. The sidebar calls render() itself afterwards. */
  setChats(next: C[]): void;
  currentId(): string;
  open(id: string): void;
  newChat(): void;
  /** The chat that has a running request, if any: edits touching it are blocked. */
  busyId(): string | undefined;
}

export interface Sidebar { render(): void; focusSearch(): void; toggle(): void; setOpen(open: boolean): void }

const PREFS_KEY = "acp-playground-ui";
const MIN_W = 200, MAX_W = 420, DEFAULT_W = 264, STEP = 16;
const NARROW = "(max-width: 720px)";

/** Read-modify-write of the whole prefs object: only the given fields change, the rest (stream, image, previewWidth...) is kept as stored. */
function savePrefs(patch: { sidebarOpen?: boolean; sidebarWidth?: number }): void {
  let data: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(storage.get(local, PREFS_KEY) ?? "null");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) data = parsed as Record<string, unknown>;
  } catch { /* junk: start over */ }
  storage.set(local, PREFS_KEY, JSON.stringify({ ...data, ...patch }));
}

/** "just now", "5 min ago", "2 h ago", "3 d ago", else the date. */
function ago(then: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - then) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days < 30 ? `${days} d ago` : new Date(then).toLocaleDateString();
}

export function initSidebar<C extends SideChat>(host: SidebarHost<C>): Sidebar {
  const found = document.querySelector<HTMLElement>(".app");
  if (!found) throw new Error(".app missing");
  const app: HTMLElement = found;
  const history = el("history"), search = el<HTMLInputElement>("history-search"), handle = el("sidebar-resize");
  const narrow = window.matchMedia(NARROW);

  let width = DEFAULT_W;
  let query = "";
  let menuId: string | undefined;
  let renameId: string | undefined;
  let renameDraft = "";
  let dragId: string | undefined;
  let lastDeleted: { chat: C; index: number } | undefined;

  const find = (id: string) => host.chats().find((chat) => chat.id === id);
  const busy = (id: string): boolean => host.busyId() === id;
  const blocked = (id: string): boolean => {
    if (!busy(id)) return false;
    toast("Wait for the answer to finish first.");
    return true;
  };

  // ---------- collapse, drawer, resize ----------

  const isOpen = (): boolean => (narrow.matches ? app.classList.contains("drawer-open") : !app.classList.contains("sidebar-collapsed"));

  function setOpen(open: boolean): void {
    if (narrow.matches) {
      const was = app.classList.contains("drawer-open");
      app.classList.toggle("drawer-open", open);
      if (open && !was) search.focus();
      else if (!open && was) { const back = document.getElementById("sidebar-open"); if (back && back.offsetParent !== null) back.focus(); }
      return;
    }
    app.classList.toggle("sidebar-collapsed", !open);
    handle.hidden = !open;
    savePrefs({ sidebarOpen: open });
    if (!open && app.querySelector("#sidebar")?.contains(document.activeElement)) (document.getElementById("sidebar-open") ?? document.body).focus();
  }

  function applyWidth(next: number, save: boolean): void {
    width = clamp(Math.round(next), MIN_W, MAX_W);
    app.style.setProperty("--sidebar-w", `${width}px`);
    handle.setAttribute("aria-valuenow", String(width));
    if (save) savePrefs({ sidebarWidth: width });
  }

  // Initial state from the saved prefs. Under 720 px the stored width is ignored by the CSS and the drawer starts closed.
  const prefs = parseUiPrefs(storage.get(local, PREFS_KEY));
  applyWidth(prefs.sidebarWidth, false);
  if (!prefs.sidebarOpen) { app.classList.add("sidebar-collapsed"); handle.hidden = true; }

  narrow.addEventListener("change", () => app.classList.remove("drawer-open"));

  el("sidebar-toggle").addEventListener("click", () => setOpen(false));
  document.getElementById("sidebar-open")?.addEventListener("click", () => setOpen(true));
  document.getElementById("scrim")?.addEventListener("click", () => setOpen(false));
  el("new-chat").addEventListener("click", () => { host.newChat(); if (narrow.matches) setOpen(false); });

  handle.addEventListener("pointerdown", (e) => {
    if (narrow.matches || e.button !== 0) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add("dragging");
    const startX = e.clientX, startW = width;
    const move = (ev: PointerEvent) => applyWidth(startW + ev.clientX - startX, false);
    const end = () => {
      handle.classList.remove("dragging");
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      savePrefs({ sidebarWidth: width });
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  });
  handle.addEventListener("keydown", (e) => {
    if (narrow.matches) return;
    const next = e.key === "ArrowLeft" ? width - STEP : e.key === "ArrowRight" ? width + STEP : e.key === "Home" ? MIN_W : e.key === "End" ? MAX_W : e.key === "Enter" ? DEFAULT_W : undefined;
    if (next === undefined) return;
    e.preventDefault();
    applyWidth(next, true);
  });
  handle.addEventListener("dblclick", () => applyWidth(DEFAULT_W, true));

  // Esc closes the drawer (menus and rename stop their own Esc first).
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && narrow.matches && app.classList.contains("drawer-open") && !e.defaultPrevented) { e.preventDefault(); setOpen(false); }
  });

  // ---------- search ----------

  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  search.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { query = search.value; render(); }, 120);
  });
  search.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && search.value) { e.preventDefault(); e.stopPropagation(); search.value = ""; clearTimeout(searchTimer); query = ""; render(); }
  });

  // ---------- chat actions ----------

  function apply(next: C[]): void { host.setChats(next); render(); }

  function sectionOf(id: string): { section: Section; index: number } | undefined {
    for (const section of historySections(host.chats(), Date.now())) {
      const index = section.ids.indexOf(id);
      if (index >= 0) return { section, index };
    }
    return undefined;
  }

  function togglePin(id: string): void {
    const chat = find(id);
    if (!chat || blocked(id)) return;
    apply(setPinned(host.chats(), id, chat.pinned !== true, Date.now()));
  }

  function shift(id: string, delta: -1 | 1): boolean {
    if (blocked(id)) return false;
    const at = sectionOf(id);
    if (!at) return false;
    const index = at.index + delta;
    if (index < 0 || index >= at.section.ids.length) return false;
    apply(moveChat(host.chats(), id, { section: at.section.key, index }, Date.now()));
    return true;
  }

  function remove(id: string): void {
    const chats = host.chats();
    const index = chats.findIndex((chat) => chat.id === id);
    if (index < 0 || blocked(id)) return;
    const chat = chats[index]!;
    const wasOpen = host.currentId() === id;
    lastDeleted = { chat, index };
    apply(chats.filter((other) => other.id !== id));
    if (wasOpen) host.newChat();
    toast("Chat deleted", {
      label: "Undo",
      run: () => {
        const saved = lastDeleted;
        lastDeleted = undefined;
        if (!saved || host.chats().some((other) => other.id === saved.chat.id)) return;
        const next = [...host.chats()];
        next.splice(Math.min(saved.index, next.length), 0, saved.chat);
        apply(next);
      },
    });
  }

  function startRename(id: string): void {
    const chat = find(id);
    if (!chat || blocked(id)) return;
    closeMenu();
    renameId = id;
    renameDraft = chat.title;
    render();
    const input = history.querySelector<HTMLInputElement>(".row-title-input");
    input?.focus();
    input?.select();
  }

  function focusRow(id: string): void {
    for (const button of history.querySelectorAll<HTMLElement>(".row-open")) if (button.closest<HTMLElement>(".row")?.dataset.id === id) { button.focus(); return; }
  }

  // ---------- row menu ----------

  function closeMenu(focusId?: string): void {
    if (menuId === undefined) return;
    menuId = undefined;
    for (const open of history.querySelectorAll(".row.menu-open")) open.classList.remove("menu-open");
    for (const pop of history.querySelectorAll(".row-menu")) pop.remove();
    for (const more of history.querySelectorAll(".row-more")) more.setAttribute("aria-expanded", "false");
    if (focusId) focusRow(focusId);
  }

  function menuItem(label: string, iconName: string | undefined, run: () => void, opts: { danger?: boolean; disabled?: boolean } = {}): HTMLButtonElement {
    const item = make("button", opts.danger ? "menu-item danger" : "menu-item");
    item.type = "button";
    item.setAttribute("role", "menuitem");
    item.disabled = opts.disabled === true;
    if (iconName) item.append(icon(iconName));
    item.append(make("span", "", label));
    item.onclick = (e) => { e.stopPropagation(); run(); };
    return item;
  }

  function buildMenu(chat: C): HTMLElement {
    const at = sectionOf(chat.id);
    const locked = busy(chat.id);
    const pop = make("div", "pop down right row-menu");
    const menu = make("div", "menu");
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", "Chat actions");
    const pinned = chat.pinned === true;
    menu.append(
      menuItem(pinned ? "Unpin" : "Pin", pinned ? "pin-off" : "pin", () => { closeMenu(); togglePin(chat.id); }, { disabled: locked }),
      menuItem("Rename", "pencil", () => startRename(chat.id), { disabled: locked }),
      menuItem("Move up", undefined, () => { const id = chat.id; closeMenu(); if (shift(id, -1)) focusRow(id); }, { disabled: locked || !at || at.index === 0 }),
      menuItem("Move down", undefined, () => { const id = chat.id; closeMenu(); if (shift(id, 1)) focusRow(id); }, { disabled: locked || !at || at.index >= at.section.ids.length - 1 }),
      make("div", "menu-sep"),
      menuItem("Delete", "trash", () => { closeMenu(); remove(chat.id); }, { danger: true, disabled: locked }),
    );
    pop.append(menu);
    pop.addEventListener("keydown", (e) => {
      const items = [...menu.querySelectorAll<HTMLButtonElement>(".menu-item:not(:disabled)")];
      const at = items.indexOf(document.activeElement as HTMLButtonElement);
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeMenu(chat.id); }
      else if (e.key === "Tab") closeMenu();
      else if (e.key === "ArrowDown") { e.preventDefault(); items[(at + 1) % items.length]?.focus(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); items[(at <= 0 ? items.length : at) - 1]?.focus(); }
      else if (e.key === "Home") { e.preventDefault(); items[0]?.focus(); }
      else if (e.key === "End") { e.preventDefault(); items[items.length - 1]?.focus(); }
    });
    return pop;
  }

  function showMenu(row: HTMLElement, chat: C, focusFirst: boolean): void {
    row.classList.add("menu-open");
    row.querySelector(".row-more")?.setAttribute("aria-expanded", "true");
    const pop = buildMenu(chat);
    row.append(pop);
    // Flip upward when there is no room below inside the scrolling list.
    const room = history.getBoundingClientRect().bottom - pop.getBoundingClientRect().bottom;
    if (room < 0) pop.classList.remove("down");
    if (focusFirst) pop.querySelector<HTMLButtonElement>(".menu-item:not(:disabled)")?.focus();
  }

  function openMenu(id: string): void {
    if (menuId === id) { closeMenu(id); return; }
    closeMenu();
    const chat = find(id);
    const row = [...history.querySelectorAll<HTMLElement>(".row")].find((candidate) => candidate.dataset.id === id);
    if (!chat || !row) return;
    menuId = id;
    showMenu(row, chat, true);
  }

  document.addEventListener("pointerdown", (e) => {
    if (menuId === undefined) return;
    if (e.target instanceof Element && e.target.closest(".row-menu, .row-more")) return;
    closeMenu();
  });

  // ---------- rows ----------

  function buildRow(chat: C, now: number, canDrag: boolean): HTMLLIElement {
    const row = make("li", "row");
    row.dataset.id = chat.id;
    if (chat.id === host.currentId()) row.classList.add("active");

    if (renameId === chat.id) {
      const input = make("input", "row-title-input");
      input.type = "text";
      input.value = renameDraft;
      input.autocomplete = "off";
      input.spellcheck = false;
      input.setAttribute("aria-label", "Chat title");
      let finished = false;
      const finish = (save: boolean, refocus: boolean) => {
        if (finished) return;
        finished = true;
        const title = input.value.trim();
        renameId = undefined;
        const current = find(chat.id);
        if (save && title && current && title !== current.title) apply(host.chats().map((other) => (other.id === chat.id ? { ...other, title } : other)));
        else render();
        if (refocus) focusRow(chat.id);
      };
      input.addEventListener("input", () => { renameDraft = input.value; });
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); finish(true, true); }
        else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(false, true); }
      });
      input.addEventListener("blur", () => finish(true, false));
      row.append(input);
      return row;
    }

    const open = make("button", "row-open");
    open.type = "button";
    open.title = `${chat.model || "no model"} · ${ago(chat.updated, now)}`;
    if (chat.id === host.currentId()) open.setAttribute("aria-current", "page");
    if (chat.pinned === true) { const pin = icon("pin"); pin.setAttribute("class", "icon row-pin"); open.append(pin); }
    open.append(make("span", "row-title", chat.title || "New chat"));
    open.onclick = () => { closeMenu(); host.open(chat.id); if (narrow.matches) setOpen(false); };
    open.addEventListener("dblclick", () => startRename(chat.id));

    const more = make("button", "icon-btn row-more");
    more.type = "button";
    more.setAttribute("aria-label", `Actions for ${chat.title || "chat"}`);
    more.setAttribute("aria-haspopup", "menu");
    more.setAttribute("aria-expanded", "false");
    more.append(icon("more"));
    more.onclick = (e) => { e.stopPropagation(); openMenu(chat.id); };

    row.append(open, more);
    if (canDrag) {
      row.draggable = true;
      row.addEventListener("dragstart", (e) => {
        if (e.target !== row) return;
        if (busy(chat.id)) { e.preventDefault(); toast("Wait for the answer to finish first."); return; }
        closeMenu();
        dragId = chat.id;
        e.dataTransfer?.setData("text/plain", chat.id);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
        // Changing the DOM after the browser took its drag image keeps the drag alive.
        setTimeout(() => {
          if (dragId !== chat.id) return;
          row.classList.add("dragging");
          if (!history.querySelector('.hist-section[data-key="pinned"]')) {
            const section = make("div", "hist-section hist-placeholder");
            section.dataset.key = "pinned";
            section.append(make("div", "hist-h", "Pinned"), make("ul", "hist-list"), make("div", "hist-empty", "Drop here to pin"));
            history.prepend(section);
          }
        }, 0);
      });
      row.addEventListener("dragend", endDrag);
    }
    return row;
  }

  function render(): void {
    const keepFocus = history.contains(document.activeElement) ? (document.activeElement as HTMLElement).closest<HTMLElement>(".row")?.dataset.id : undefined;
    const keepRename = renameId !== undefined && document.activeElement instanceof HTMLInputElement && history.contains(document.activeElement);
    const now = Date.now();
    const chats = host.chats();
    const sections = historySections(chats, now, query);
    const byId = new Map(chats.map((chat) => [chat.id, chat]));
    if (menuId !== undefined && !byId.has(menuId)) menuId = undefined;
    if (renameId !== undefined && !byId.has(renameId)) renameId = undefined;
    history.replaceChildren();
    if (sections.length === 0) {
      history.append(make("p", "hist-empty", query.trim() ? "No chats match." : "No chats yet."));
      return;
    }
    const canDrag = !query.trim();
    for (const section of sections) {
      const box = make("div", "hist-section");
      box.dataset.key = section.key;
      const list = make("ul", "hist-list");
      for (const id of section.ids) {
        const chat = byId.get(id);
        if (chat) list.append(buildRow(chat, now, canDrag));
      }
      box.append(make("div", "hist-h", section.label), list);
      history.append(box);
    }
    if (menuId !== undefined) {
      const row = [...history.querySelectorAll<HTMLElement>(".row")].find((candidate) => candidate.dataset.id === menuId);
      const chat = byId.get(menuId);
      if (row && chat) showMenu(row, chat, false); else menuId = undefined;
    }
    if (keepRename) { const input = history.querySelector<HTMLInputElement>(".row-title-input"); input?.focus(); }
    else if (keepFocus) focusRow(keepFocus);
  }

  // ---------- keyboard on rows ----------

  history.addEventListener("keydown", (e) => {
    if (!(e.target instanceof HTMLElement) || !e.target.classList.contains("row-open")) return;
    const id = e.target.closest<HTMLElement>(".row")?.dataset.id;
    if (!id) return;
    if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      if (shift(id, e.key === "ArrowUp" ? -1 : 1)) focusRow(id);
    } else if (e.key === "F2") { e.preventDefault(); startRename(id); }
    else if (e.key === "Delete") {
      e.preventDefault();
      // Keep the focus near the deleted row.
      const rows = [...history.querySelectorAll<HTMLElement>(".row-open")];
      const at = rows.indexOf(e.target);
      remove(id);
      (history.querySelectorAll<HTMLElement>(".row-open")[Math.min(at, rows.length - 2)] ?? search).focus();
    }
  });

  // ---------- drag and drop ----------

  interface Drop { key: Section["key"]; index: number; line: boolean }

  function dropTarget(clientY: number): Drop | undefined {
    const chat = dragId ? find(dragId) : undefined;
    if (!chat) return undefined;
    const sections = [...history.querySelectorAll<HTMLElement>(".hist-section")];
    if (sections.length === 0) return undefined;
    // The section under the pointer; in the gaps the one above, above the first the first.
    let section = sections[0]!;
    for (const candidate of sections) if (candidate.getBoundingClientRect().top <= clientY) section = candidate;
    const key = section.dataset.key as Section["key"];
    if (key !== "pinned") {
      if (chat.pinned === true) return { key, index: 0, line: false };
      if (dateGroup(chat.updated, Date.now()) !== key) return undefined;
    }
    const rows = [...section.querySelectorAll<HTMLElement>(".hist-list > .row")].filter((row) => row.dataset.id !== dragId);
    let index = 0;
    for (const row of rows) { const box = row.getBoundingClientRect(); if (box.top + box.height / 2 < clientY) index += 1; }
    return { key, index, line: true };
  }

  function clearDrop(): void {
    for (const line of history.querySelectorAll(".drop-line")) line.remove();
    for (const over of history.querySelectorAll(".drop-over")) over.classList.remove("drop-over");
  }

  function endDrag(): void {
    dragId = undefined;
    clearDrop();
    for (const row of history.querySelectorAll(".row.dragging")) row.classList.remove("dragging");
    for (const placeholder of history.querySelectorAll(".hist-placeholder")) placeholder.remove();
  }

  function over(e: DragEvent): void {
    if (!dragId) return;
    const target = dropTarget(e.clientY);
    clearDrop();
    if (!target) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    const section = [...history.querySelectorAll<HTMLElement>(".hist-section")].find((box) => box.dataset.key === target.key);
    if (!section) return;
    const rows = [...section.querySelectorAll<HTMLElement>(".hist-list > .row")].filter((row) => row.dataset.id !== dragId);
    if (!target.line || (rows.length === 0 && section.classList.contains("hist-placeholder"))) { section.classList.add("drop-over"); return; }
    const line = make("li", "drop-line");
    line.setAttribute("aria-hidden", "true");
    const list = section.querySelector(".hist-list");
    const before = rows[target.index];
    if (before) before.before(line); else list?.append(line);
  }

  history.addEventListener("dragenter", over);
  history.addEventListener("dragover", over);
  history.addEventListener("dragleave", (e) => { if (!(e.relatedTarget instanceof Node) || !history.contains(e.relatedTarget)) clearDrop(); });
  history.addEventListener("drop", (e) => {
    const id = dragId;
    if (!id) return;
    const target = dropTarget(e.clientY);
    e.preventDefault();
    endDrag();
    if (!target || blocked(id)) return;
    apply(moveChat(host.chats(), id, { section: target.key, index: target.index }, Date.now()));
  });

  render();

  return {
    render,
    focusSearch() { if (!isOpen()) setOpen(true); search.focus(); search.select(); },
    toggle() { setOpen(!isOpen()); },
    setOpen,
  };
}
