import { el, local, make, icon, storage } from "./dom.js";
import { filterModelGroups, groupModels, parseUiPrefs, sendKey, validateImageForm, type UiPrefs } from "./lib.js";

// The composer: autogrowing textarea, attachments, model picker, tools menu, Image settings popover and the Send/Stop swap. Model text never goes in through innerHTML.

export interface ComposerModel { id: string; kind?: string; vision?: boolean; /** ISO string from /v1/models (a number is read as epoch ms, or seconds when below 1e12). */ exhausted_until?: number | string }

export interface ComposerHost {
  /** Called on Enter / the Send button with the trimmed text and the attached data URLs (image mode: validated already). The composer does not clear itself: call `clear()` (or `clearText()`) when the send is accepted. */
  send(text: string, attachments: string[]): void;
  stop(): void;
  busy(): boolean;
  model(): string;
  setModel(id: string): void;
  mode(): "chat" | "image";
  vision(): boolean | undefined;
  /** The reload icon in the model picker. */
  refreshModels?(): void;
}

export interface ImageFields {
  /** "WxH" (a preset, or the custom inputs joined). */
  size: string;
  /** Raw steps text (blank = not sent), for `validateImageForm`. */
  steps: string;
  /** Optional request fields: negative_prompt, steps, seed, guidance_scale (blank ones are left out). T6 adds `model` and `prompt`. */
  fields: Record<string, string | number>;
}

export interface Composer {
  setModels(list: readonly ComposerModel[]): void;
  setBusy(busy: boolean): void;
  /** Clears the text and the current mode's attachments. */
  clear(): void;
  /** Clears the text only (image runs keep their reference images, as today). */
  clearText(): void;
  focus(): void;
  fill(text: string): void;
  imageFields(): ImageFields;
  /** Reference images (image mode) as File objects, in the same order as the data URLs passed to `host.send`. */
  files(): File[];
  /** The saved page preferences, read fresh from storage. */
  prefs(): UiPrefs;
  /** Re-reads host.mode() / host.vision() / host.model() and updates the mode-dependent UI (call after a chat switch or a model change). */
  refreshMode(): void;
}

const UI_KEY = "acp-playground-ui";
const MAX_IMAGES = 10;
const CHAT_PLACEHOLDER = "Message (Enter to send, Shift+Enter for a new line)";
const IMAGE_PLACEHOLDER = "Describe the image…";
const IMAGE_FIELDS = ["negative", "size", "width", "height", "steps", "seed", "guidance"] as const;

const shortName = (id: string): string => (id.includes("/") ? id.slice(id.indexOf("/") + 1) : id);

function exhaustedNow(value: number | string | undefined): boolean {
  if (value === undefined) return false;
  const ms = typeof value === "number" ? (value < 1e12 ? value * 1000 : value) : Date.parse(value);
  return Number.isFinite(ms) && ms > Date.now();
}

function readFile(file: File): Promise<string | undefined> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : undefined);
    reader.onerror = () => resolve(undefined);
    reader.readAsDataURL(file);
  });
}

interface Popover { button: HTMLElement; pop: HTMLElement; anchor: HTMLElement; onOpen(): void; close(restoreFocus?: boolean): void; open(): void; isOpen(): boolean }

export function initComposer(host: ComposerHost): Composer {
  const input = el<HTMLTextAreaElement>("input");
  const form = el<HTMLFormElement>("composer");
  const send = el<HTMLButtonElement>("send");
  const stop = el<HTMLButtonElement>("stop");
  const attach = el<HTMLButtonElement>("attach");
  const fileInput = el<HTMLInputElement>("img-files");
  const thumbs = el("img-thumbs");
  const stream = el<HTMLInputElement>("stream");
  const search = el<HTMLInputElement>("search");
  const images = el<HTMLInputElement>("images");

  let models: ComposerModel[] = [];
  // One list per mode: chat attachments are image_url parts, image-mode ones are edit references. Switching mode shows that mode's own list.
  const lists: Record<"chat" | "image", Array<{ file: File; url: string }>> = { chat: [], image: [] };
  const attachmentList = (): Array<{ file: File; url: string }> => lists[host.mode()];
  /** True while the chat list holds images and the model takes none (kept, but Send is blocked until they are removed). */
  const blocked = (): boolean => host.mode() === "chat" && host.vision() === false && lists.chat.length > 0;
  let blockNotice = false;
  let busy = false;
  let loaded = false;

  const setNotice = (text: string): void => { el("notice-text").textContent = text; el("notice").hidden = !text; el("notice-action").hidden = true; };

  // ---- preferences (read-modify-write the whole JSON; only `stream` and `image` are ours) ----
  const prefs = (): UiPrefs => parseUiPrefs(storage.get(local, UI_KEY));
  const imageValues = (): UiPrefs["image"] => ({
    negative: el<HTMLInputElement>("img-negative").value, size: el<HTMLSelectElement>("img-size").value, width: el<HTMLInputElement>("img-width").value,
    height: el<HTMLInputElement>("img-height").value, steps: el<HTMLInputElement>("img-steps").value, seed: el<HTMLInputElement>("img-seed").value, guidance: el<HTMLInputElement>("img-guidance").value,
  });
  const defaults = parseUiPrefs(null).image;
  function savePrefs(): void {
    let data: Record<string, unknown> = {};
    try { const parsed: unknown = JSON.parse(storage.get(local, UI_KEY) ?? "null"); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) data = parsed as Record<string, unknown>; } catch { /* junk: start over */ }
    data.stream = stream.checked;
    data.image = imageValues();
    storage.set(local, UI_KEY, JSON.stringify(data));
  }
  function updateImageUi(): void {
    const values = imageValues();
    el("img-custom").hidden = values.size !== "custom";
    el("image-settings-dot").hidden = IMAGE_FIELDS.every((name) => values[name] === defaults[name]);
  }

  // ---- popovers ----
  const popovers: Popover[] = [];
  function popover(buttonId: string, popId: string, anchorId: string, focusTarget: () => HTMLElement | null, onOpen: () => void = () => {}, onClose: () => void = () => {}): Popover {
    const button = el(buttonId), pop = el(popId), anchor = el(anchorId);
    const api: Popover = {
      button, pop, anchor, onOpen,
      isOpen: () => !pop.hidden,
      open() {
        for (const other of popovers) if (other !== api) other.close();
        pop.hidden = false;
        button.setAttribute("aria-expanded", "true");
        onOpen();
        focusTarget()?.focus();
      },
      close(restoreFocus = false) {
        if (pop.hidden) return;
        pop.hidden = true;
        button.setAttribute("aria-expanded", "false");
        onClose();
        if (restoreFocus) button.focus();
      },
    };
    button.onclick = () => (api.isOpen() ? api.close(true) : api.open());
    anchor.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && api.isOpen()) { event.preventDefault(); event.stopPropagation(); api.close(true); }
    });
    anchor.addEventListener("focusout", (event) => {
      const next = event.relatedTarget as Node | null;
      if (next && !anchor.contains(next)) api.close();
    });
    popovers.push(api);
    return api;
  }
  document.addEventListener("pointerdown", (event) => {
    for (const api of popovers) if (api.isOpen() && !api.anchor.contains(event.target as Node)) api.close();
  });

  // ---- textarea ----
  function autogrow(): void {
    input.style.height = "auto";
    input.style.height = `${input.scrollHeight}px`;
  }
  function updateSend(): void { send.disabled = !input.value.trim() || blocked(); }
  function syncBlock(): void {
    if (blocked()) { setNotice(`This model does not take images. Remove the ${lists.chat.length} attachment${lists.chat.length === 1 ? "" : "s"} or pick a vision or image model to send.`); blockNotice = true; }
    else if (blockNotice) { setNotice(""); blockNotice = false; }
    updateSend();
  }
  input.addEventListener("input", () => { autogrow(); updateSend(); });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !event.shiftKey && host.busy()) { event.preventDefault(); host.stop(); return; }
    if (sendKey(event)) { event.preventDefault(); submit(); }
  });
  form.onsubmit = (event) => { event.preventDefault(); submit(); };
  stop.onclick = () => host.stop();

  function submit(): void {
    if (host.busy()) return;
    const text = input.value.trim();
    if (!text) return;
    if (blocked()) { syncBlock(); return; }
    if (host.mode() === "image") {
      const values = imageFields();
      const problem = validateImageForm({ size: values.size, steps: values.steps, files: attachmentList().length });
      if (problem) { setNotice(problem); return; }
      setNotice("");
    }
    host.send(text, attachmentList().map((item) => item.url));
  }

  // ---- attachments ----
  function attachEnabled(): { ok: boolean; title: string } {
    if (host.mode() === "image") return { ok: true, title: "Attach reference images" };
    if (host.vision() === false) return { ok: false, title: "This model does not take images" };
    return { ok: true, title: "Attach images" };
  }
  function renderThumbs(): void {
    const attachments = attachmentList();
    thumbs.replaceChildren(...attachments.map((item) => {
      const box = make("div", "thumb");
      const remove = make("button", "thumb-remove");
      remove.type = "button";
      remove.title = "Remove this image";
      remove.setAttribute("aria-label", "Remove this image");
      remove.append(icon("close"));
      remove.onclick = () => { attachments.splice(attachments.indexOf(item), 1); renderThumbs(); syncBlock(); input.focus(); };
      box.append(Object.assign(make("img"), { src: item.url, alt: item.file.name }), remove);
      return box;
    }));
  }
  async function addFiles(files: readonly File[]): Promise<void> {
    const state = attachEnabled();
    if (!state.ok) { setNotice(state.title + "."); blockNotice = false; return; }
    const attachments = attachmentList();
    const pictures = files.filter((file) => file.type.startsWith("image/"));
    if (!pictures.length) { if (files.length) setNotice("Only image files can be attached."); return; }
    const room = MAX_IMAGES - attachments.length;
    if (pictures.length > room) setNotice(`At most ${MAX_IMAGES} images.`);
    const accepted = pictures.slice(0, Math.max(0, room));
    const urls = await Promise.all(accepted.map(readFile));
    accepted.forEach((file, index) => {
      const url = urls[index];
      if (url && attachments.length < MAX_IMAGES) attachments.push({ file, url });
    });
    if (attachments === attachmentList()) renderThumbs();
  }
  attach.onclick = () => { if (!attach.disabled) fileInput.click(); };
  fileInput.onchange = () => { void addFiles([...(fileInput.files ?? [])]); fileInput.value = ""; };
  input.addEventListener("paste", (event) => {
    const files = [...(event.clipboardData?.files ?? [])].filter((file) => file.type.startsWith("image/"));
    if (!files.length) return;
    event.preventDefault();
    void addFiles(files);
  });

  const main = el("main"), overlay = el("drop-overlay");
  const hasFiles = (event: DragEvent): boolean => [...(event.dataTransfer?.types ?? [])].includes("Files");
  let dragDepth = 0;
  main.addEventListener("dragenter", (event) => { if (!hasFiles(event)) return; dragDepth++; overlay.hidden = !attachEnabled().ok; });
  main.addEventListener("dragleave", (event) => { if (!hasFiles(event)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) overlay.hidden = true; });
  main.addEventListener("drop", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth = 0;
    overlay.hidden = true;
    void addFiles([...(event.dataTransfer?.files ?? [])]);
  });
  // A file dropped outside the main column must not navigate the tab away from the playground.
  window.addEventListener("dragover", (event) => { if (hasFiles(event)) event.preventDefault(); });
  window.addEventListener("drop", (event) => { if (hasFiles(event)) { event.preventDefault(); dragDepth = 0; overlay.hidden = true; } });

  // ---- tools menu ----
  popover("tools-button", "tools-pop", "tools-anchor", () => stream);
  stream.onchange = savePrefs;
  // Web search and image output cannot be combined (the proxy answers 400).
  search.onchange = () => { if (search.checked) images.checked = false; };
  images.onchange = () => { if (images.checked) search.checked = false; };

  // ---- Image settings ----
  popover("image-settings-button", "image-settings-pop", "image-settings-anchor", () => el("img-negative"));
  const applyImagePrefs = (): void => {
    const saved = prefs();
    stream.checked = saved.stream;
    const sizeSelect = el<HTMLSelectElement>("img-size");
    sizeSelect.value = saved.image.size;
    if (sizeSelect.value !== saved.image.size) sizeSelect.value = defaults.size;
    el<HTMLInputElement>("img-negative").value = saved.image.negative;
    el<HTMLInputElement>("img-width").value = saved.image.width;
    el<HTMLInputElement>("img-height").value = saved.image.height;
    el<HTMLInputElement>("img-steps").value = saved.image.steps;
    el<HTMLInputElement>("img-seed").value = saved.image.seed;
    el<HTMLInputElement>("img-guidance").value = saved.image.guidance;
  };
  for (const id of ["img-negative", "img-size", "img-width", "img-height", "img-steps", "img-seed", "img-guidance"]) {
    const field = el(id);
    field.addEventListener("input", () => { updateImageUi(); savePrefs(); });
    field.addEventListener("change", () => { updateImageUi(); savePrefs(); });
  }
  /** Blank field = omitted. */
  const optionalNumber = (id: string): number | undefined => { const text = el<HTMLInputElement>(id).value.trim(); return text && Number.isFinite(Number(text)) ? Number(text) : undefined; };
  function imageFields(): ImageFields {
    const choice = el<HTMLSelectElement>("img-size").value;
    const size = choice === "custom" ? `${el<HTMLInputElement>("img-width").value.trim()}x${el<HTMLInputElement>("img-height").value.trim()}` : choice;
    const fields: Record<string, string | number> = {};
    const negative = el<HTMLInputElement>("img-negative").value.trim();
    if (negative) fields.negative_prompt = negative;
    for (const [name, id] of [["steps", "img-steps"], ["seed", "img-seed"], ["guidance_scale", "img-guidance"]] as const) {
      const value = optionalNumber(id);
      if (value !== undefined) fields[name] = value;
    }
    return { size, steps: el<HTMLInputElement>("img-steps").value, fields };
  }

  // ---- model picker (D11) ----
  const modelSearch = el<HTMLInputElement>("model-search");
  const modelList = el("model-list");
  const modelLabel = el("model-label");
  let active = 0;
  let visible: string[] = [];
  const optionId = (index: number): string => `model-opt-${index}`;

  const picker = popover("model-button", "model-pop", "model-anchor", () => modelSearch, () => { modelSearch.value = ""; modelSearch.setAttribute("aria-expanded", "true"); renderModels(true); }, () => modelSearch.setAttribute("aria-expanded", "false"));
  function setActive(index: number): void {
    if (!visible.length) { active = 0; modelSearch.removeAttribute("aria-activedescendant"); modelList.removeAttribute("aria-activedescendant"); return; }
    active = (index + visible.length) % visible.length;
    modelList.querySelectorAll(".model-opt.active").forEach((node) => node.classList.remove("active"));
    const node = document.getElementById(optionId(active));
    node?.classList.add("active");
    modelSearch.setAttribute("aria-activedescendant", optionId(active));
    modelList.setAttribute("aria-activedescendant", optionId(active));
    if (node && typeof node.scrollIntoView === "function") node.scrollIntoView({ block: "nearest" });
  }
  function pick(id: string): void {
    picker.close();
    if (id && id !== host.model()) host.setModel(id);
    refreshMode();
    input.focus();
  }
  function renderModels(selectCurrent = false): void {
    const byId = new Map(models.map((model) => [model.id, model]));
    const groups = filterModelGroups(groupModels(models.map((model) => model.id)), modelSearch.value);
    visible = groups.flatMap((group) => group.models);
    const current = host.model();
    let index = 0;
    const children: HTMLElement[] = groups.map((group, groupIndex) => {
      const wrap = make("div");
      wrap.setAttribute("role", "group");
      const heading = make("div", "model-group-h", group.provider);
      heading.id = `model-group-${groupIndex}`;
      wrap.setAttribute("aria-labelledby", heading.id);
      wrap.append(heading);
      for (const id of group.models) {
        const info = byId.get(id);
        const option = make("div", "model-opt");
        option.id = optionId(index);
        option.setAttribute("role", "option");
        option.setAttribute("aria-selected", String(id === current));
        const name = make("span", "model-name", group.provider === "other" ? id : shortName(id));
        name.title = id;
        option.append(name);
        if (info?.kind === "image") option.append(make("span", "badge image", "image"));
        if (info?.vision === true) option.append(make("span", "badge vision", "vision"));
        if (exhaustedNow(info?.exhausted_until)) option.append(make("span", "badge limit", "limit reached"));
        const position = index;
        option.onmousedown = (event) => event.preventDefault(); // keep the focus in the search field
        option.onclick = () => pick(id);
        option.onmousemove = () => { if (active !== position) setActive(position); };
        wrap.append(option);
        index++;
      }
      return wrap;
    });
    if (!children.length) children.push(make("div", "model-empty", models.length ? "No model matches." : "No models."));
    modelList.replaceChildren(...children);
    setActive(selectCurrent && visible.includes(current) ? visible.indexOf(current) : 0);
  }
  modelSearch.addEventListener("input", () => renderModels());
  modelSearch.addEventListener("keydown", (event) => {
    switch (event.key) {
      case "ArrowDown": event.preventDefault(); setActive(active + 1); break;
      case "ArrowUp": event.preventDefault(); setActive(active - 1); break;
      case "Home": event.preventDefault(); setActive(0); break;
      case "End": event.preventDefault(); setActive(visible.length - 1); break;
      case "Enter": event.preventDefault(); { const id = visible[active]; if (id) pick(id); } break;
    }
  });
  // Typing anywhere in the popover (the refresh button, the list) goes to the search field.
  el("model-pop").addEventListener("keydown", (event) => {
    if (event.target === modelSearch || event.ctrlKey || event.metaKey || event.altKey || event.key.length !== 1) return;
    modelSearch.focus();
  });
  el("model-refresh").onclick = () => host.refreshModels?.();

  // ---- mode-dependent UI ----
  function refreshMode(): void {
    const image = host.mode() === "image";
    el("tools-anchor").hidden = image;
    el("image-settings-anchor").hidden = !image;
    for (const api of popovers) if (api.anchor.hidden) api.close();
    input.placeholder = image ? IMAGE_PLACEHOLDER : CHAT_PLACEHOLDER;
    const state = attachEnabled();
    attach.disabled = !state.ok;
    attach.title = state.title;
    attach.setAttribute("aria-label", state.title);
    renderThumbs();
    syncBlock();
    const id = host.model();
    modelLabel.textContent = id ? shortName(id) : loaded ? (models.length ? "Choose a model" : "No models") : "Loading models…";
    el("model-button").title = id ? `Model: ${id}` : "Choose a model";
    if (!el("model-pop").hidden) renderModels();
  }

  // ---- init ----
  applyImagePrefs();
  updateImageUi();
  updateSend();
  refreshMode();

  return {
    setModels(list) {
      models = [...list];
      loaded = true;
      if (!el("model-pop").hidden) renderModels();
      refreshMode();
    },
    setBusy(value) {
      busy = value;
      send.hidden = busy;
      stop.hidden = !busy;
    },
    clear() { input.value = ""; attachmentList().length = 0; renderThumbs(); autogrow(); updateSend(); },
    clearText() { input.value = ""; autogrow(); updateSend(); },
    focus() { input.focus(); },
    fill(text) {
      input.value = text;
      autogrow();
      updateSend();
      input.focus();
      input.setSelectionRange(text.length, text.length);
    },
    imageFields,
    files: () => attachmentList().map((item) => item.file),
    prefs,
    refreshMode,
  };
}
