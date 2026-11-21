import { chatTitle, elideDataUrls, groupModels, outputTokensEstimate, parseSseLines, tokensPerSecond, userContent } from "./lib.js";
import { normalizeChats, touchChat, trimChats } from "./history.js";
import { el, local, session, storage, toast } from "./dom.js";
import { onStarter, onThinkingToggle, renderConversation, setElapsed, streamTarget, type ImageRun, type Meta, type Msg } from "./messages.js";
import { initSidebar, type Sidebar } from "./sidebar.js";
import { initComposer, type Composer, type ComposerModel } from "./composer.js";

// The playground page served by the proxy at /playground: state, requests and wiring. Rendering lives in messages.ts, the sidebar in sidebar.ts, the composer in composer.ts. Model text is rendered only through DOM nodes (textContent), never as HTML.

interface Chat { id: string; title: string; model: string; system: string; updated: number; pinned?: boolean; order?: number; messages: Msg[] }

const API = `${location.origin}/v1`;
const HISTORY_KEY = "acp-playground-chats";
const KEY_KEY = "acp-playground-key";
const BUSY_TEXT = "Wait for the answer to finish first.";

// The current model lives here (there is no <select>); the composer's picker changes it through host.setModel.
let model = "";
let chats: Chat[] = loadChats();
let current: Chat = blankChat();
let running: AbortController | undefined;
let runningId: string | undefined;

// Image mode: picking a model whose /v1/models `kind` is "image". Derived from `model`, never stored. Results live in memory for this tab only (not in the history).
const kinds = new Map<string, string>();
const visionOf = new Map<string, boolean>();
const modelIds = new Set<string>();
const imageRuns: ImageRun[] = [];
/** What an image run was sent with, so Retry can send the same request again. */
const runInfo = new WeakMap<ImageRun, { fields: Record<string, string | number>; files: File[] }>();
const imageMode = (): boolean => kinds.get(model) === "image";

let composer: Composer;
let sidebar: Sidebar;

function loadChats(): Chat[] {
  try { return normalizeChats<Chat>(JSON.parse(storage.get(local, HISTORY_KEY) ?? "[]") as unknown); } catch { return []; }
}

/** Saves the history (every pinned chat plus the newest others, up to 50); when the browser's quota is full, saves it again without the generated images, the thinking text and the attached images (those stay as "" entries so the bubble shows "Image not saved"). */
function saveChats(): void {
  chats = trimChats(chats);
  // Stored requests get their data URLs elided ("data:…(N KB)") so history does not hold each image twice; the in-memory request keeps them.
  const stored = chats.map((chat) => ({ ...chat, messages: chat.messages.map((message) => (message.request === undefined ? message : { ...message, request: elideDataUrls(message.request) })) }));
  if (storage.set(local, HISTORY_KEY, JSON.stringify(stored))) return;
  const slim = stored.map((chat) => ({
    ...chat,
    messages: chat.messages.map(({ images: _images, reasoning: _reasoning, thoughtMs: _thoughtMs, attachments, ...message }) => (attachments ? { ...message, attachments: attachments.map(() => "") } : message)),
  }));
  if (!storage.set(local, HISTORY_KEY, JSON.stringify(slim))) notice("The history could not be saved in this browser.");
}

function blankChat(): Chat { return { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, title: "New chat", model, system: "", updated: Date.now(), messages: [] }; }

function notice(text: string, action?: { label: string; run(): void }): void {
  el("notice-text").textContent = text;
  el("notice").hidden = !text;
  const button = el<HTMLButtonElement>("notice-action");
  button.hidden = !text || !action;
  button.textContent = action?.label ?? "";
  button.onclick = action ? () => action.run() : null;
}

function headers(json = true): Record<string, string> {
  const key = el<HTMLInputElement>("key").value.trim();
  return { ...(json ? { "Content-Type": "application/json" } : {}), ...(key ? { Authorization: `Bearer ${key}` } : {}) };
}

/** The proxy's error message from an error response or an SSE error envelope. */
function errorText(payload: unknown, status?: number): string {
  const error = (payload as { error?: { message?: string; code?: string } } | undefined)?.error;
  if (error?.message) return `${error.message}${error.code ? ` (${error.code})` : ""}`;
  return status ? `HTTP ${status}` : "The request failed.";
}

interface ModelInfo { id: string; kind?: string; vision?: unknown; exhausted_until?: unknown }

async function loadModels(): Promise<void> {
  const wanted = model || current.model;
  let unauthorized = false;
  try {
    const response = await fetch(`${API}/models`, { headers: headers() });
    const payload = await response.json().catch(() => undefined) as { data?: ModelInfo[] } | undefined;
    if (!response.ok) { unauthorized = response.status === 401; throw new Error(errorText(payload, response.status)); }
    const data = payload?.data ?? [];
    kinds.clear();
    visionOf.clear();
    modelIds.clear();
    for (const item of data) {
      modelIds.add(item.id);
      if (item.kind) kinds.set(item.id, item.kind);
      if (typeof item.vision === "boolean") visionOf.set(item.id, item.vision);
    }
    const groups = groupModels(data.map((item) => item.id));
    // Like the old <select>: keep the wanted model when it is listed, else the first one.
    model = wanted && modelIds.has(wanted) ? wanted : groups[0]?.models[0] ?? "";
    composer.setModels(data.map((item): ComposerModel => ({
      id: item.id,
      ...(item.kind ? { kind: item.kind } : {}),
      ...(typeof item.vision === "boolean" ? { vision: item.vision } : {}),
      ...(typeof item.exhausted_until === "string" || typeof item.exhausted_until === "number" ? { exhausted_until: item.exhausted_until } : {}),
    })));
    notice("");
  } catch (error) {
    kinds.clear();
    visionOf.clear();
    modelIds.clear();
    model = "";
    composer.setModels([]);
    if (unauthorized || /api_key/.test(String(error))) notice("Enter the proxy's API key in Settings.", { label: "Open settings", run: () => openSettings("key") });
    else notice(`Models: ${error instanceof Error ? error.message : String(error)}`);
  }
  refreshMode();
}

/** Shows or hides the chat-only controls for the selected model and redraws the conversation (the composer swaps its own tools). */
function refreshMode(): void {
  const image = imageMode();
  const anchor = el("chat-settings-button").parentElement;
  if (anchor) anchor.hidden = image;
  if (image) setChatSettings(false);
  composer.refreshMode();
  renderMessages();
}

function showHeader(): void { el("chat-title").textContent = current.title; }

function showChat(): void {
  el<HTMLTextAreaElement>("system").value = current.system;
  setChatSettings(false);
  endTitleEdit(false);
  showHeader();
  if (current.model && modelIds.has(current.model)) model = current.model;
  refreshMode();
  sidebar.render();
}

function renderMessages(): void {
  renderConversation(el("messages"), { messages: current.messages, imageRuns, imageMode: imageMode(), busy: Boolean(running) }, {
    copy: (message) => navigator.clipboard.writeText(message.content),
    retry: retryLast,
    edit: editMessage,
    remove: removeMessage,
    retryImage,
    removeImage,
  });
}

function setRunning(controller: AbortController | undefined): void {
  running = controller;
  runningId = controller ? current.id : undefined;
  composer.setBusy(Boolean(controller));
}

// ---- chats: open, new, rename, activity ----

function openChat(id: string): void {
  if (running) { toast(BUSY_TEXT); return; }
  const chat = chats.find((entry) => entry.id === id);
  if (!chat) return;
  current = chat;
  showChat();
}

function newChat(): void {
  if (running) { toast(BUSY_TEXT); return; }
  current = blankChat();
  showChat();
  composer.focus();
}

/** The sidebar's way to change the list (pin, move, rename, delete, undo): store it, keep `current` pointing at the open chat's newest object, save. */
function setChats(next: Chat[]): void {
  chats = next;
  saveChats();
  current = chats.find((entry) => entry.id === current.id) ?? current;
  showHeader();
}

/** Activity in the open chat: it joins the history if it is new and jumps to the top of Today (a pinned chat keeps its place). */
function touchCurrent(): void {
  if (!chats.some((entry) => entry.id === current.id)) chats = [current, ...chats];
  chats = touchChat(chats, current.id, Date.now());
  current = chats.find((entry) => entry.id === current.id) ?? current;
}

function renameCurrent(title: string): void {
  if (chats.some((entry) => entry.id === current.id)) setChats(chats.map((entry) => (entry.id === current.id ? { ...entry, title } : entry)));
  else { current.title = title; showHeader(); }
  sidebar.render();
}

function beginTitleEdit(): void {
  if (running) { toast(BUSY_TEXT); return; }
  const input = el<HTMLInputElement>("chat-title-input");
  input.value = current.title;
  el("chat-title").hidden = true;
  input.hidden = false;
  input.focus();
  input.select();
}

/** Enter or blur saves the trimmed text (empty keeps the old title); Esc cancels. */
function endTitleEdit(save: boolean): void {
  const input = el<HTMLInputElement>("chat-title-input");
  if (input.hidden) return;
  const value = input.value.trim();
  input.hidden = true;
  el("chat-title").hidden = false;
  if (save && value && value !== current.title) renameCurrent(value);
}

// ---- chat settings popover and the Settings dialog ----

function setChatSettings(open: boolean, restoreFocus = false): void {
  const pop = el("chat-settings-pop"), button = el("chat-settings-button");
  if (pop.hidden === !open) return;
  pop.hidden = !open;
  button.setAttribute("aria-expanded", String(open));
  if (open) el("system").focus();
  else if (restoreFocus) button.focus();
}

let settingsOpener: HTMLElement | undefined;

function openSettings(target?: "key" | "shortcuts"): void {
  const dialog = el<HTMLDialogElement>("settings");
  if (!dialog.open) {
    settingsOpener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    dialog.showModal();
  }
  if (target === "key") el("key").focus();
  else if (target === "shortcuts") document.querySelector<HTMLElement>("#settings .shortcuts")?.scrollIntoView({ block: "start" });
}

// ---- requests ----

type Citation = { url_citation?: { url?: string; title?: string } };
const citationsOf = (annotations: Citation[] | undefined) => (annotations ?? []).flatMap((annotation) => annotation.url_citation?.url ? [{ url: annotation.url_citation.url, title: annotation.url_citation.title ?? "" }] : []);
const imagesOf = (images: Array<{ image_url?: { url?: string } }> | undefined) => (images ?? []).flatMap((image) => image.image_url?.url ? [image.image_url.url] : []);

/** The request body for the current chat: system prompt, then every turn that has an answer (failed answers are left out). A user turn with attachments sends content parts; an attachment the quota fallback dropped ("") is left out. */
function requestBody(modelId: string, stream: boolean): Record<string, unknown> {
  const messages: Array<{ role: string; content: ReturnType<typeof userContent> }> = [];
  if (current.system.trim()) messages.push({ role: "system", content: current.system });
  for (const message of current.messages) {
    if (message.role === "assistant" && (message.error || !message.meta)) continue;
    const pictures = message.role === "user" ? (message.attachments ?? []).filter((url) => url.startsWith("data:image/")) : [];
    messages.push({ role: message.role, content: userContent(message.content, pictures) });
  }
  return {
    model: modelId, messages, stream,
    ...(stream ? { stream_options: { include_usage: true } } : {}),
    ...(el<HTMLInputElement>("search").checked ? { web_search_options: {} } : {}),
    ...(el<HTMLInputElement>("images").checked ? { modalities: ["text", "image"] } : {}),
  };
}

/** Composer's send: an image model goes to sendImage, anything else is a chat turn. */
function onSend(text: string, attachments: string[]): void {
  if (running) return;
  if (imageMode()) { void sendImage(text, attachments); return; }
  void sendChat(text, attachments);
}

async function sendChat(text: string, attachments: string[]): Promise<void> {
  if (!text || running) return;
  if (!model) { notice("Pick a model first."); return; }
  notice("");
  current.messages.push({ role: "user", content: text, ...(attachments.length ? { attachments } : {}) });
  if (current.title === "New chat") current.title = chatTitle(text);
  composer.clear();
  await runChat();
}

/** Sends the current history to the current model and appends the answer. Shared by send, Retry and Edit. */
async function runChat(): Promise<void> {
  const stream = el<HTMLInputElement>("stream").checked;
  current.system = el<HTMLTextAreaElement>("system").value;
  current.model = model;
  touchCurrent();
  const modelId = model;
  const body = requestBody(modelId, stream);
  // The live request keeps the real image data URLs (Copy as curl works until reload); saveChats elides them in storage.
  const answer: Msg = { role: "assistant", content: "", request: body };
  current.messages.push(answer);
  const controller = new AbortController();
  setRunning(controller);
  renderMessages();
  showHeader();
  sidebar.render();
  const started = performance.now();
  const meta: Meta = { model: modelId, stream, totalMs: 0 };
  try {
    const response = await fetch(`${API}/chat/completions`, { method: "POST", headers: headers(), body: JSON.stringify(body), signal: controller.signal });
    if (!response.ok) { const payload = await response.json().catch(() => undefined); throw new Error(errorText(payload, response.status)); }
    if (stream && response.body) await readStream(response.body, answer, meta, started);
    else {
      const payload = await response.json() as { model?: string; choices?: Array<{ message?: { content?: string | null; reasoning_content?: unknown; annotations?: Citation[]; images?: Array<{ image_url?: { url?: string } }> }; finish_reason?: string }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
      const choice = payload.choices?.[0];
      answer.content = choice?.message?.content ?? "";
      if (typeof choice?.message?.reasoning_content === "string" && choice.message.reasoning_content) answer.reasoning = choice.message.reasoning_content;
      answer.citations = citationsOf(choice?.message?.annotations);
      answer.images = imagesOf(choice?.message?.images);
      meta.finish = choice?.finish_reason;
      meta.inputTokens = payload.usage?.prompt_tokens;
      meta.outputTokens = payload.usage?.completion_tokens;
    }
  } catch (error) {
    answer.error = controller.signal.aborted ? "Stopped." : error instanceof Error ? error.message : String(error);
  } finally {
    meta.totalMs = performance.now() - started;
    if (!answer.error) answer.meta = meta;
    else if (answer.content || answer.reasoning) answer.meta = meta;
    setRunning(undefined);
    saveChats();
    renderMessages();
    sidebar.render();
  }
}

async function readStream(body: ReadableStream<Uint8Array>, answer: Msg, meta: Meta, started: number): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const target = streamTarget(answer, meta, started);
  let rateAt = 0;
  let thinkStart: number | undefined;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const { events, rest } = parseSseLines(buffer + decoder.decode(value, { stream: true }));
      buffer = rest;
      for (const data of events) {
        if (data === "[DONE]") continue;
        let chunk: { error?: unknown; choices?: Array<{ delta?: { content?: string; reasoning_content?: unknown; reasoning?: unknown; annotations?: Citation[]; images?: Array<{ image_url?: { url?: string } }> }; finish_reason?: string | null }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
        try { chunk = JSON.parse(data); } catch { continue; }
        if (chunk.error) throw new Error(errorText(chunk));
        const choice = chunk.choices?.[0];
        const delta = choice?.delta;
        const thought = delta?.reasoning_content ?? delta?.reasoning;
        let token = false;
        if (typeof thought === "string" && thought) {
          token = true;
          const now = performance.now();
          meta.firstMs ??= now - started;
          thinkStart ??= now;
          answer.reasoning = (answer.reasoning ?? "") + thought;
          target.thinking();
        }
        if (delta?.content) {
          token = true;
          const now = performance.now();
          meta.firstMs ??= now - started;
          if (thinkStart !== undefined && answer.thoughtMs === undefined) {
            answer.thoughtMs = now - thinkStart;
            answer.thinkingOpen = false;
            target.thoughtDone();
          }
          answer.content += delta.content;
          target.schedule();
        }
        if (token && meta.firstMs !== undefined) {
          const now = performance.now();
          if (now - rateAt >= 250) {
            const live = tokensPerSecond(outputTokensEstimate(answer.content, answer.reasoning), now - started - meta.firstMs);
            if (live !== undefined) {
              rateAt = now;
              target.rate(live);
            }
          }
        }
        if (delta?.annotations) answer.citations = [...(answer.citations ?? []), ...citationsOf(delta.annotations)];
        if (delta?.images) answer.images = [...(answer.images ?? []), ...imagesOf(delta.images)];
        if (choice?.finish_reason) meta.finish = choice.finish_reason;
        if (chunk.usage) { meta.inputTokens = chunk.usage.prompt_tokens; meta.outputTokens = chunk.usage.completion_tokens; }
      }
    }
  } finally {
    target.stop();
    if (thinkStart !== undefined && answer.thoughtMs === undefined) answer.thoughtMs = performance.now() - thinkStart;
  }
}

async function sendImage(prompt: string, refs: string[]): Promise<void> {
  if (!prompt || running) return;
  notice("");
  const info = { fields: { model, prompt, size: composer.imageFields().size, ...composer.imageFields().fields } as Record<string, string | number>, files: composer.files() };
  const ok = await runImage(prompt, info, refs);
  if (ok) composer.clearText();
}

/** One image request (generations, or edits when there are reference files). Returns true when images came back. */
async function runImage(prompt: string, info: { fields: Record<string, string | number>; files: File[] }, refs: string[]): Promise<boolean> {
  const modelId = String(info.fields.model);
  const edit = info.files.length > 0;
  const run: ImageRun = { model: modelId, prompt, edit, urls: [], elapsedS: 0, pending: true, refs: [...refs] };
  runInfo.set(run, info);
  imageRuns.push(run);
  const controller = new AbortController();
  setRunning(controller);
  renderMessages();
  const started = performance.now();
  const tick = setInterval(() => {
    run.elapsedS = Math.round((performance.now() - started) / 1000);
    setElapsed(run.elapsedS);
  }, 1000);
  let ok = false;
  try {
    let response: Response;
    if (edit) {
      const form = new FormData();
      for (const [name, value] of Object.entries(info.fields)) form.append(name, String(value));
      for (const file of info.files) form.append("image", file, file.name);
      response = await fetch(`${API}/images/edits`, { method: "POST", headers: headers(false), body: form, signal: controller.signal });
    } else response = await fetch(`${API}/images/generations`, { method: "POST", headers: headers(), body: JSON.stringify(info.fields), signal: controller.signal });
    const payload = await response.json().catch(() => undefined) as { data?: Array<{ b64_json?: string }> } | undefined;
    if (!response.ok) throw new Error(errorText(payload, response.status));
    run.urls = (payload?.data ?? []).flatMap((item) => item.b64_json ? [`data:image/png;base64,${item.b64_json}`] : []);
    if (!run.urls.length) run.error = "The server returned no image.";
    else ok = true;
  } catch (error) {
    run.error = controller.signal.aborted ? "Stopped." : error instanceof Error ? error.message : String(error);
  } finally {
    clearInterval(tick);
    run.pending = false;
    run.totalMs = performance.now() - started;
    setRunning(undefined);
    renderMessages();
  }
  return ok;
}

// ---- message actions: Retry, Edit, Delete (all blocked while a request runs) ----

function retryLast(): void {
  if (running) return;
  const last = current.messages.at(-1);
  if (last?.role !== "assistant" || current.messages.at(-2)?.role !== "user") return;
  if (!model) { notice("Pick a model first."); return; }
  notice("");
  current.messages.pop();
  void runChat();
}

/** Edit and resend: replaces the text of the last user message, drops the answer after it and asks again. */
function editMessage(index: number, text: string): void {
  if (running) return;
  const message = current.messages[index];
  if (message?.role !== "user" || index !== current.messages.map((entry) => entry.role).lastIndexOf("user")) return;
  if (!model) { notice("Pick a model first."); return; }
  notice("");
  message.content = text;
  current.messages.length = index + 1;
  void runChat();
}

/** Deletes a user message with the answer that follows it, or a single answer; the toast's Undo puts it back. */
function removeMessage(index: number): void {
  if (running) return;
  const message = current.messages[index];
  if (!message) return;
  const count = message.role === "user" && current.messages[index + 1]?.role === "assistant" ? 2 : 1;
  const removed = current.messages.splice(index, count);
  const chatId = current.id;
  if (chats.some((entry) => entry.id === chatId)) saveChats();
  renderMessages();
  toast(count === 2 ? "Message deleted" : "Answer deleted", {
    label: "Undo",
    run: () => {
      if (running) { toast(BUSY_TEXT); return; }
      const chat = chats.find((entry) => entry.id === chatId);
      if (!chat) return;
      chat.messages.splice(Math.min(index, chat.messages.length), 0, ...removed);
      saveChats();
      if (current.id === chatId) renderMessages();
      sidebar.render();
    },
  });
}

function retryImage(run: ImageRun): void {
  if (running) return;
  const info = runInfo.get(run);
  if (!info) return;
  const at = imageRuns.indexOf(run);
  if (at >= 0) imageRuns.splice(at, 1);
  void runImage(run.prompt, info, run.refs ?? []);
}

function removeImage(run: ImageRun): void {
  if (running) return;
  const at = imageRuns.indexOf(run);
  if (at >= 0) imageRuns.splice(at, 1);
  renderMessages();
}

// ---- init ----

function init(): void {
  // Registered before the sidebar's own listener: when Esc closes something of ours it calls preventDefault, which the sidebar's drawer Esc respects.
  document.addEventListener("keydown", onShortcut);
  document.addEventListener("pointerdown", (event) => {
    const anchor = el("chat-settings-button").parentElement;
    if (!el("chat-settings-pop").hidden && anchor && !anchor.contains(event.target as Node)) setChatSettings(false);
  });

  const key = el<HTMLInputElement>("key");
  key.value = storage.get(session, KEY_KEY) ?? "";
  key.onchange = () => { storage.set(session, KEY_KEY, key.value.trim()); void loadModels(); };
  el("refresh-models").onclick = () => void loadModels();

  const settings = el<HTMLDialogElement>("settings");
  el("settings-button").onclick = () => openSettings();
  el("settings-close").onclick = () => settings.close();
  settings.addEventListener("close", () => {
    const back = settingsOpener && settingsOpener.isConnected && settingsOpener.offsetParent !== null ? settingsOpener : el("settings-button");
    settingsOpener = undefined;
    back.focus();
  });

  el("chat-settings-button").onclick = () => setChatSettings(el("chat-settings-pop").hidden);
  el("chat-settings-pop").addEventListener("keydown", (event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setChatSettings(false, true); } });
  el<HTMLTextAreaElement>("system").onchange = () => { current.system = el<HTMLTextAreaElement>("system").value; if (!running && chats.some((entry) => entry.id === current.id)) saveChats(); };

  const title = el("chat-title"), titleInput = el<HTMLInputElement>("chat-title-input");
  title.addEventListener("dblclick", beginTitleEdit);
  title.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === "F2") { event.preventDefault(); beginTitleEdit(); } });
  titleInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); endTitleEdit(true); title.focus(); }
    else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); endTitleEdit(false); title.focus(); }
  });
  titleInput.addEventListener("blur", () => endTitleEdit(true));

  onThinkingToggle(() => { if (!running) saveChats(); });

  composer = initComposer({
    send: onSend,
    stop: () => running?.abort(),
    busy: () => Boolean(running),
    model: () => model,
    setModel: (id) => {
      if (running) { toast(BUSY_TEXT); return; }
      model = id;
      current.model = id;
      refreshMode();
    },
    mode: () => (imageMode() ? "image" : "chat"),
    vision: () => visionOf.get(model),
    refreshModels: () => void loadModels(),
  });
  onStarter((text) => composer.fill(text));

  sidebar = initSidebar<Chat>({
    chats: () => chats,
    setChats,
    currentId: () => current.id,
    open: openChat,
    newChat,
    busyId: () => runningId,
  });

  showChat();
  void loadModels().then(() => { current.model = model; });
}

/** Global shortcuts (D13). Everything here is a Ctrl/Cmd combination, Shift+Esc or Esc closing something of ours, so it works while typing too. */
function onShortcut(event: KeyboardEvent): void {
  const mod = event.ctrlKey || event.metaKey;
  const key = event.key.toLowerCase();
  const dialog = el<HTMLDialogElement>("settings");
  if (event.key === "Escape" && !event.shiftKey && !mod && !event.altKey) {
    if (dialog.open) { event.preventDefault(); dialog.close(); }
    else if (!el("chat-settings-pop").hidden) { event.preventDefault(); setChatSettings(false, true); }
    return;
  }
  if (dialog.open) {
    if (mod && event.key === "/") event.preventDefault();
    return;
  }
  if (event.key === "Escape" && event.shiftKey && !mod) { event.preventDefault(); composer.focus(); return; }
  if (!mod || event.altKey) return;
  if (event.shiftKey && key === "o") { event.preventDefault(); newChat(); }
  else if (event.shiftKey && key === "s") { event.preventDefault(); sidebar.toggle(); }
  else if (!event.shiftKey && key === "k") { event.preventDefault(); sidebar.focusSearch(); }
  else if (!event.shiftKey && event.key === "/") { event.preventDefault(); openSettings("shortcuts"); }
}

init();
