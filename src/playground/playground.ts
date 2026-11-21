import { chatTitle, curlFor, decodeRate, formatMs, formatRate, groupModels, isHttpUrl, outputTokensEstimate, parseSseLines, previewDocument, splitBlocks, tokensPerSecond, validateImageForm } from "./lib.js";
import { highlight, parseMarkdown, type Inline, type ListBlock, type MdBlock } from "./markdown.js";

// The playground page served by the proxy at /playground: pick a model, chat, keep a history in this browser. Model text is rendered only through DOM nodes (textContent), never as HTML.

interface Meta { model: string; stream: boolean; firstMs?: number; totalMs: number; inputTokens?: number; outputTokens?: number; finish?: string }
interface Msg { role: "user" | "assistant"; content: string; images?: string[]; citations?: Array<{ url: string; title: string }>; meta?: Meta; error?: string; request?: unknown;
  /** Thinking text, shown in the accordion; never resent (requestBody sends only `content`). */
  reasoning?: string;
  /** ms from the first reasoning delta to the first content delta (or to the end when no content came); absent for non-streamed answers. */
  thoughtMs?: number;
  /** The user's (or the auto-collapse's) open state of the accordion; undefined = default (open while pending or when content is empty, else closed). Persisted. */
  thinkingOpen?: boolean }
interface Chat { id: string; title: string; model: string; system: string; updated: number; messages: Msg[] }

const API = `${location.origin}/v1`;
const HISTORY_KEY = "acp-playground-chats";
const KEY_KEY = "acp-playground-key";
const MAX_CHATS = 50;

const el = <T extends HTMLElement = HTMLElement>(id: string): T => { const node = document.getElementById(id); if (!node) throw new Error(`#${id} missing`); return node as T; };
const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] => { const node = document.createElement(tag); if (className) node.className = className; if (text) node.textContent = text; return node; };

// Storage can be unavailable (private window, blocked site data): the page then works without history.
const storage = {
  get(area: Storage | undefined, key: string): string | null { try { return area?.getItem(key) ?? null; } catch { return null; } },
  set(area: Storage | undefined, key: string, value: string): boolean { try { area?.setItem(key, value); return true; } catch { return false; } },
};
const local = (() => { try { return window.localStorage; } catch { return undefined; } })();
const session = (() => { try { return window.sessionStorage; } catch { return undefined; } })();

let chats: Chat[] = loadChats();
let current: Chat = newChat();
let running: AbortController | undefined;

// Image mode: picking a model whose /v1/models `kind` is "image". Derived from the select, never stored. Results live in memory for this tab only (not in the history).
interface ImageRun { model: string; prompt: string; edit: boolean; urls: string[]; error?: string; totalMs?: number; elapsedS: number; pending: boolean }
const kinds = new Map<string, string>();
const imageRuns: ImageRun[] = [];
const refImages: Array<{ file: File; url: string }> = [];
const imageMode = (): boolean => kinds.get(el<HTMLSelectElement>("model").value) === "image";

function loadChats(): Chat[] {
  try { const parsed = JSON.parse(storage.get(local, HISTORY_KEY) ?? "[]") as unknown; return Array.isArray(parsed) ? (parsed as Chat[]).filter((chat) => chat && Array.isArray(chat.messages)) : []; } catch { return []; }
}

/** Saves the history; when the browser's quota is full, saves it again without the generated images. */
function saveChats(): void {
  const list = chats.slice(0, MAX_CHATS);
  if (storage.set(local, HISTORY_KEY, JSON.stringify(list))) return;
  const slim = list.map((chat) => ({ ...chat, messages: chat.messages.map(({ images: _images, reasoning: _reasoning, thoughtMs: _thoughtMs, ...message }) => message) }));
  if (!storage.set(local, HISTORY_KEY, JSON.stringify(slim))) notice("The history could not be saved in this browser.");
}

function newChat(): Chat { return { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, title: "New chat", model: el<HTMLSelectElement>("model").value, system: "", updated: Date.now(), messages: [] }; }

function notice(text: string): void { const node = el("notice"); node.textContent = text; node.hidden = !text; }

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

async function loadModels(): Promise<void> {
  const select = el<HTMLSelectElement>("model");
  const wanted = select.value || current.model;
  try {
    const response = await fetch(`${API}/models`, { headers: headers() });
    const payload = await response.json().catch(() => undefined) as { data?: Array<{ id: string; kind?: string }> } | undefined;
    if (!response.ok) throw new Error(errorText(payload, response.status));
    kinds.clear();
    for (const model of payload?.data ?? []) if (model.kind) kinds.set(model.id, model.kind);
    const groups = groupModels((payload?.data ?? []).map((model) => model.id));
    select.replaceChildren(...groups.map((group) => {
      const optgroup = make("optgroup");
      optgroup.label = group.provider;
      optgroup.append(...group.models.map((id) => Object.assign(make("option", "", id), { value: id })));
      return optgroup;
    }));
    if (!groups.length) select.append(Object.assign(make("option", "", "No models (log in to a provider in the app)"), { value: "" }));
    if (wanted && [...select.options].some((option) => option.value === wanted)) select.value = wanted;
    notice("");
    applyMode();
  } catch (error) {
    select.replaceChildren(Object.assign(make("option", "", "Could not load models"), { value: "" }));
    notice(`Models: ${error instanceof Error ? error.message : String(error)}${/401|api_key/.test(String(error)) ? " Enter the proxy's API key above." : ""}`);
  }
}

function renderHistory(): void {
  const list = el("history");
  list.replaceChildren(...chats.map((chat) => {
    const item = make("li", chat.id === current.id ? "active" : "");
    const open = make("button", "open");
    open.type = "button";
    open.append(make("span", "", chat.title), make("small", "", `${chat.model || "no model"} · ${new Date(chat.updated).toLocaleString()}`));
    open.onclick = () => { if (running) return; current = chat; showChat(); };
    const remove = make("button", "link", "✕");
    remove.type = "button";
    remove.title = "Delete this chat";
    remove.onclick = () => { chats = chats.filter((entry) => entry.id !== chat.id); saveChats(); if (current.id === chat.id) { current = newChat(); showChat(); } else renderHistory(); };
    item.append(open, remove);
    return item;
  }));
  if (!chats.length) list.append(make("li", "muted small", "No chats yet."));
}

function showChat(): void {
  el<HTMLTextAreaElement>("system").value = current.system;
  el<HTMLDetailsElement>("system-box").open = Boolean(current.system);
  const select = el<HTMLSelectElement>("model");
  if (current.model && [...select.options].some((option) => option.value === current.model)) select.value = current.model;
  applyMode();
  renderHistory();
}

function renderMessages(): void {
  const box = el("messages");
  if (imageMode()) {
    box.replaceChildren(...(imageRuns.length ? imageRuns.map(renderImageRun) : [make("p", "empty", "Write a prompt and send it. Reference images are optional. Results stay in this tab only.")]));
    box.scrollTop = box.scrollHeight;
    return;
  }
  if (!current.messages.length) {
    box.replaceChildren(make("p", "empty", "Pick a model and send a message. Each answer shows the time, the tokens and the exact request, which you can copy as curl."));
    return;
  }
  box.replaceChildren(...current.messages.map(renderMessage));
  box.scrollTop = box.scrollHeight;
}

const isPending = (message: Msg): boolean => message.role === "assistant" && !message.meta && !message.error;

function inlineNodes(list: readonly Inline[]): Node[] {
  return list.map((item): Node => {
    switch (item.type) {
      case "text": return document.createTextNode(item.text);
      case "br": return document.createElement("br");
      case "code": return make("code", "", item.text);
      case "strong": { const node = make("strong"); node.append(...inlineNodes(item.children)); return node; }
      case "em": { const node = make("em"); node.append(...inlineNodes(item.children)); return node; }
      case "link": { const node = Object.assign(make("a"), { href: item.href, target: "_blank", rel: "noopener noreferrer" }); node.append(...inlineNodes(item.children)); return node; }
    }
  });
}

function listNode(list: ListBlock): HTMLElement {
  const node = make(list.ordered ? "ol" : "ul");
  if (list.ordered && list.start !== undefined && list.start !== 1) (node as HTMLOListElement).start = list.start;
  for (const item of list.items) {
    const li = make("li");
    li.append(...inlineNodes(item.children));
    if (item.sub) li.append(listNode(item.sub));
    if (item.rest) li.append(...markdownNodes(item.rest));
    node.append(li);
  }
  return node;
}

/** DOM for markdown blocks: createElement + textContent only, never innerHTML with model text. */
function markdownNodes(blocks: readonly MdBlock[]): Node[] {
  return blocks.map((block): Node => {
    switch (block.type) {
      case "heading": { const node = make(`h${block.level}` as "h1"); node.append(...inlineNodes(block.children)); return node; }
      case "paragraph": { const node = make("p"); node.append(...inlineNodes(block.children)); return node; }
      case "list": return listNode(block);
      case "blockquote": { const node = make("blockquote"); node.append(...markdownNodes(block.children)); return node; }
      case "hr": return make("hr");
      case "code": return codeFigure(block.lang, block.code);
      case "table": {
        const cell = (tag: "th" | "td", content: readonly Inline[], index: number) => {
          const node = make(tag);
          const align = block.align[index];
          if (align) node.style.textAlign = align;
          node.append(...inlineNodes(content));
          return node;
        };
        const headRow = make("tr");
        block.head.forEach((content, index) => headRow.append(cell("th", content, index)));
        const thead = make("thead");
        thead.append(headRow);
        const tbody = make("tbody");
        for (const row of block.rows) {
          const tr = make("tr");
          row.forEach((content, index) => tr.append(cell("td", content, index)));
          tbody.append(tr);
        }
        const table = make("table");
        table.append(thead, tbody);
        const wrap = make("div", "table-wrap");
        wrap.append(table);
        return wrap;
      }
    }
  });
}

/** <figure class="code"><figcaption>lang <button class="copy">Copy</button></figcaption><pre><code>highlighted spans</code></pre></figure> */
function codeFigure(lang: string, code: string): HTMLElement {
  const figure = make("figure", "code");
  const caption = make("figcaption");
  const copy = make("button", "copy", "Copy");
  copy.type = "button";
  const label = (text: string) => { copy.textContent = text; setTimeout(() => { copy.textContent = "Copy"; }, 1500); };
  copy.onclick = () => void Promise.resolve().then(() => navigator.clipboard.writeText(code)).then(() => label("Copied"), () => label("Copy failed"));
  caption.append(make("span", "lang", lang), copy);
  const codeNode = make("code");
  codeNode.append(...highlight(code, lang).map((token) => token.cls ? make("span", `tok-${token.cls}`, token.text) : document.createTextNode(token.text)));
  const pre = make("pre");
  pre.append(codeNode);
  figure.append(caption, pre);
  return figure;
}

const thinkingSummary = (message: Msg): string => message.thoughtMs !== undefined ? `Thought for ${formatMs(message.thoughtMs)}` : isPending(message) && !message.content ? "Thinking…" : "Thoughts";

/** The collapsible thinking accordion of one answer; its open state is kept on the message (and saved with the history). */
function thinkingNode(message: Msg): HTMLDetailsElement {
  const details = make("details", "thinking");
  const summary = make("summary", isPending(message) && !message.content ? "pending" : "", thinkingSummary(message));
  details.append(summary, make("div", "thinking-text", message.reasoning ?? ""));
  details.open = message.thinkingOpen ?? (isPending(message) || !message.content);
  let last = details.open;
  details.addEventListener("toggle", () => {
    if (details.open === last) return;
    last = details.open;
    message.thinkingOpen = details.open;
    if (!running) saveChats();
  });
  return details;
}

function renderMessage(message: Msg): HTMLElement {
  const node = make("div", `msg ${message.role}`);
  node.append(make("div", "who", message.role === "user" ? "You" : message.meta?.model ?? "Assistant"));
  const assistant = message.role === "assistant";
  const pending = isPending(message);
  if (assistant && message.reasoning) node.append(thinkingNode(message));
  if (!assistant) node.append(make("div", "text", message.content));
  else if (pending || message.content || (!message.error && !message.reasoning)) {
    const body = make("div", pending ? "body pending" : "body");
    body.append(...markdownNodes(parseMarkdown(message.content)));
    node.append(body);
  }
  const blocks = assistant && message.meta ? splitBlocks(message.content) : [];
  for (const url of message.images ?? []) if (url.startsWith("data:image/")) node.append(Object.assign(make("img"), { src: url, alt: "Generated image" }));
  if (message.citations?.length) {
    const list = make("ol", "cites");
    for (const citation of message.citations) {
      if (!isHttpUrl(citation.url)) continue;
      const link = Object.assign(make("a", "", citation.title || citation.url), { href: citation.url, target: "_blank", rel: "noopener noreferrer" });
      const item = make("li");
      item.append(link);
      list.append(item);
    }
    node.append(list);
  }
  if (message.error) node.append(make("div", "error", message.error));
  const html = message.role === "assistant" && message.meta ? previewDocument(blocks) : undefined;
  if (html !== undefined) node.append(previewBar(html));
  if (message.meta) {
    const meta = message.meta;
    const rate = decodeRate(meta);
    const parts = [
      meta.stream ? "streamed" : "not streamed",
      ...(meta.firstMs !== undefined ? [`TTFT ${formatMs(meta.firstMs)}`] : []),
      `total ${formatMs(meta.totalMs)}`,
      ...(meta.inputTokens !== undefined ? [`${meta.inputTokens} in / ${meta.outputTokens ?? 0} out tokens`] : []),
      ...(rate !== undefined ? [formatRate(rate)] : []),
      ...(meta.finish ? [`finish: ${meta.finish}`] : []),
    ];
    const line = make("div", "meta");
    line.append(...parts.map((part) => make("span", "", part)));
    node.append(line);
  }
  if (message.request) {
    const details = make("details");
    details.append(make("summary", "", "Request"));
    const body = JSON.stringify(message.request, null, 2);
    details.append(make("pre", "", body));
    const copy = make("button", "", "Copy as curl");
    copy.type = "button";
    copy.onclick = () => void navigator.clipboard.writeText(curlFor(API, message.request, Boolean(el<HTMLInputElement>("key").value.trim()))).then(() => { copy.textContent = "Copied"; setTimeout(() => { copy.textContent = "Copy as curl"; }, 1500); }, () => { copy.textContent = "Copy failed"; });
    details.append(copy);
    node.append(details);
  }
  return node;
}

function renderImageRun(run: ImageRun): HTMLElement {
  const node = make("div", "msg assistant image-result");
  node.append(make("div", "who", `${run.model}${run.edit ? " (edit)" : ""}`), make("div", "text", run.prompt));
  if (run.pending) node.append(make("div", "elapsed muted", waitingText(run.elapsedS)));
  run.urls.forEach((url, index) => {
    if (!url.startsWith("data:image/")) return;
    node.append(Object.assign(make("img"), { src: url, alt: "Generated image" }));
    node.append(Object.assign(make("a", "", "Save"), { href: url, download: `image-${index + 1}.png` }));
  });
  if (run.error) node.append(make("div", "error", run.error));
  if (run.totalMs !== undefined) node.append(make("div", "meta", `total ${formatMs(run.totalMs)}`));
  return node;
}

const waitingText = (seconds: number): string => `Waiting for the model (it may be starting, this can take minutes)... ${seconds} s`;

/** Shows or hides the chat-only controls and the image panel for the selected model. */
function applyMode(): void {
  const image = imageMode();
  el("image-panel").hidden = !image;
  el("system-box").hidden = image;
  for (const id of ["stream", "search", "images"]) { const label = el(id).parentElement; if (label) label.hidden = image; }
  el<HTMLTextAreaElement>("input").placeholder = image ? "Image prompt (Ctrl+Enter to send)" : "Message (Ctrl+Enter to send)";
  renderMessages();
}

function renderThumbs(): void {
  el("img-thumbs").replaceChildren(...refImages.map((ref) => {
    const box = make("div", "thumb");
    const remove = make("button", "", "x");
    remove.type = "button";
    remove.title = "Remove this image";
    remove.onclick = () => { refImages.splice(refImages.indexOf(ref), 1); renderThumbs(); };
    box.append(Object.assign(make("img"), { src: ref.url, alt: ref.file.name }), remove);
    return box;
  }));
}

/** Blank field = omitted. */
const optionalNumber = (id: string): number | undefined => { const text = el<HTMLInputElement>(id).value.trim(); return text && Number.isFinite(Number(text)) ? Number(text) : undefined; };

async function sendImage(): Promise<void> {
  const input = el<HTMLTextAreaElement>("input");
  const prompt = input.value.trim();
  const model = el<HTMLSelectElement>("model").value;
  if (!prompt || running) return;
  const sizeChoice = el<HTMLSelectElement>("img-size").value;
  const size = sizeChoice === "custom" ? `${el<HTMLInputElement>("img-width").value.trim()}x${el<HTMLInputElement>("img-height").value.trim()}` : sizeChoice;
  const problem = validateImageForm({ size, steps: el<HTMLInputElement>("img-steps").value, files: refImages.length });
  if (problem) { notice(problem); return; }
  notice("");
  const fields: Record<string, string | number> = { model, prompt, size };
  const negative = el<HTMLInputElement>("img-negative").value.trim();
  if (negative) fields.negative_prompt = negative;
  for (const [name, id] of [["steps", "img-steps"], ["seed", "img-seed"], ["guidance_scale", "img-guidance"]] as const) { const value = optionalNumber(id); if (value !== undefined) fields[name] = value; }
  const edit = refImages.length > 0;
  const run: ImageRun = { model, prompt, edit, urls: [], elapsedS: 0, pending: true };
  imageRuns.push(run);
  renderMessages();
  const controller = new AbortController();
  setRunning(controller);
  const started = performance.now();
  const tick = setInterval(() => {
    run.elapsedS = Math.round((performance.now() - started) / 1000);
    const node = [...el("messages").querySelectorAll<HTMLElement>(".elapsed")].at(-1);
    if (node) node.textContent = waitingText(run.elapsedS);
  }, 1000);
  try {
    let response: Response;
    if (edit) {
      const form = new FormData();
      for (const [name, value] of Object.entries(fields)) form.append(name, String(value));
      for (const ref of refImages) form.append("image", ref.file, ref.file.name);
      response = await fetch(`${API}/images/edits`, { method: "POST", headers: headers(false), body: form, signal: controller.signal });
    } else response = await fetch(`${API}/images/generations`, { method: "POST", headers: headers(), body: JSON.stringify(fields), signal: controller.signal });
    const payload = await response.json().catch(() => undefined) as { data?: Array<{ b64_json?: string }> } | undefined;
    if (!response.ok) throw new Error(errorText(payload, response.status));
    run.urls = (payload?.data ?? []).flatMap((item) => item.b64_json ? [`data:image/png;base64,${item.b64_json}`] : []);
    if (!run.urls.length) run.error = "The server returned no image.";
    else input.value = "";
  } catch (error) {
    run.error = controller.signal.aborted ? "Stopped." : error instanceof Error ? error.message : String(error);
  } finally {
    clearInterval(tick);
    run.pending = false;
    run.totalMs = performance.now() - started;
    setRunning(undefined);
    renderMessages();
  }
}

// The preview page announces itself with a message; the window that sent it (iframe or tab) is answered with the document, once. Model code runs only after a click.
const waiting = new Map<MessageEventSource, string>();
window.addEventListener("message", (event) => {
  const html = event.source ? waiting.get(event.source) : undefined;
  if (html === undefined || !event.source || (event.data as { type?: unknown } | null)?.type !== "acp-preview-ready") return;
  waiting.delete(event.source);
  // The target is "*" because the sandboxed preview has an opaque origin; the receiver checks that the sender is its parent/opener.
  (event.source as Window).postMessage({ type: "acp-preview-run", html }, "*");
});

/** Run (in a sandboxed iframe under the message) and Open in new tab for the html/css/js blocks of one finished answer. */
function previewBar(html: string): HTMLElement {
  const bar = make("div", "preview-bar");
  const holder = make("div", "preview-holder");
  const run = make("button", "", "Run");
  run.type = "button";
  const tab = make("button", "", "Open in new tab");
  tab.type = "button";
  run.onclick = () => {
    const frame = make("iframe", "preview");
    frame.setAttribute("sandbox", "allow-scripts");
    frame.src = "/playground/preview";
    frame.title = "Preview";
    const close = make("button", "", "Close");
    close.type = "button";
    close.onclick = () => holder.replaceChildren();
    holder.replaceChildren(close, frame);
    if (frame.contentWindow) waiting.set(frame.contentWindow, html);
  };
  tab.onclick = () => {
    const handle = window.open("/playground/preview", "_blank");
    if (handle) waiting.set(handle, html);
  };
  bar.append(run, tab);
  const wrap = make("div", "preview-wrap");
  wrap.append(bar, holder);
  return wrap;
}

/** The request body for the current chat: system prompt, then every turn that has an answer (failed answers are left out). */
function requestBody(model: string, stream: boolean): Record<string, unknown> {
  const messages: Array<{ role: string; content: string }> = [];
  if (current.system.trim()) messages.push({ role: "system", content: current.system });
  for (const message of current.messages) {
    if (message.role === "assistant" && (message.error || !message.meta)) continue;
    messages.push({ role: message.role, content: message.content });
  }
  return {
    model, messages, stream,
    ...(stream ? { stream_options: { include_usage: true } } : {}),
    ...(el<HTMLInputElement>("search").checked ? { web_search_options: {} } : {}),
    ...(el<HTMLInputElement>("images").checked ? { modalities: ["text", "image"] } : {}),
  };
}

type Citation = { url_citation?: { url?: string; title?: string } };
const citationsOf = (annotations: Citation[] | undefined) => (annotations ?? []).flatMap((annotation) => annotation.url_citation?.url ? [{ url: annotation.url_citation.url, title: annotation.url_citation.title ?? "" }] : []);
const imagesOf = (images: Array<{ image_url?: { url?: string } }> | undefined) => (images ?? []).flatMap((image) => image.image_url?.url ? [image.image_url.url] : []);

async function send(): Promise<void> {
  if (imageMode()) return sendImage();
  const input = el<HTMLTextAreaElement>("input");
  const text = input.value.trim();
  const model = el<HTMLSelectElement>("model").value;
  if (!text || running) return;
  if (!model) { notice("Pick a model first."); return; }
  notice("");
  current.system = el<HTMLTextAreaElement>("system").value;
  current.model = model;
  current.messages.push({ role: "user", content: text });
  if (current.title === "New chat") current.title = chatTitle(text);
  if (!chats.includes(current)) chats.unshift(current);
  input.value = "";
  const stream = el<HTMLInputElement>("stream").checked;
  const body = requestBody(model, stream);
  const answer: Msg = { role: "assistant", content: "", request: body };
  current.messages.push(answer);
  renderMessages();
  const controller = new AbortController();
  setRunning(controller);
  const started = performance.now();
  const meta: Meta = { model, stream, totalMs: 0 };
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
    current.updated = Date.now();
    chats = [current, ...chats.filter((chat) => chat !== current)];
    setRunning(undefined);
    saveChats();
    renderMessages();
    renderHistory();
  }
}

async function readStream(body: ReadableStream<Uint8Array>, answer: Msg, meta: Meta, started: number): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const messages = el("messages");
  const node = [...messages.querySelectorAll<HTMLElement>(".msg.assistant")].at(-1);
  const bodyNode = node?.querySelector<HTMLElement>(":scope > .body");
  let details: HTMLDetailsElement | undefined;
  let rateNode: HTMLElement | undefined;
  let rateAt = 0;
  let thinkStart: number | undefined;
  // Live render: one trailing timer; the interval grows with the measured render time so a huge answer stays responsive.
  let timer: ReturnType<typeof setTimeout> | undefined;
  let interval = 100;
  const render = () => {
    timer = undefined;
    const t0 = performance.now();
    if (bodyNode) bodyNode.replaceChildren(...markdownNodes(parseMarkdown(answer.content)));
    const thinking = details?.querySelector<HTMLElement>(".thinking-text");
    if (thinking) { thinking.textContent = answer.reasoning ?? ""; thinking.scrollTop = thinking.scrollHeight; }
    messages.scrollTop = messages.scrollHeight;
    interval = Math.max(100, 4 * (performance.now() - t0));
  };
  const schedule = () => { timer ??= setTimeout(render, interval); };
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
          if (!details && bodyNode) { details = thinkingNode(answer); bodyNode.before(details); }
          schedule();
        }
        if (delta?.content) {
          token = true;
          const now = performance.now();
          meta.firstMs ??= now - started;
          if (thinkStart !== undefined && answer.thoughtMs === undefined) {
            answer.thoughtMs = now - thinkStart;
            answer.thinkingOpen = false;
            if (details) {
              details.open = false;
              const summary = details.querySelector("summary");
              if (summary) { summary.textContent = thinkingSummary(answer); summary.classList.remove("pending"); }
            }
          }
          answer.content += delta.content;
          schedule();
        }
        if (token && meta.firstMs !== undefined) {
          const now = performance.now();
          if (now - rateAt >= 250) {
            const live = tokensPerSecond(outputTokensEstimate(answer.content, answer.reasoning), now - started - meta.firstMs);
            if (live !== undefined) {
              rateAt = now;
              if (!rateNode && bodyNode) { rateNode = make("span", "rate"); bodyNode.after(rateNode); }
              if (rateNode) rateNode.textContent = `~${formatRate(live)}`;
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
    if (timer !== undefined) clearTimeout(timer);
    if (thinkStart !== undefined && answer.thoughtMs === undefined) answer.thoughtMs = performance.now() - thinkStart;
  }
}

function setRunning(controller: AbortController | undefined): void {
  running = controller;
  el<HTMLButtonElement>("send").disabled = Boolean(controller);
  el("stop").hidden = !controller;
}

function init(): void {
  const key = el<HTMLInputElement>("key");
  key.value = storage.get(session, KEY_KEY) ?? "";
  key.onchange = () => { storage.set(session, KEY_KEY, key.value.trim()); void loadModels(); };
  el("refresh").onclick = () => void loadModels();
  el("new-chat").onclick = () => { if (running) return; current = newChat(); showChat(); el("input").focus(); };
  el("stop").onclick = () => running?.abort();
  el<HTMLSelectElement>("model").onchange = () => applyMode();
  el<HTMLSelectElement>("img-size").onchange = () => { el("img-custom").hidden = el<HTMLSelectElement>("img-size").value !== "custom"; };
  el<HTMLInputElement>("img-files").onchange = (event) => {
    const input = event.target as HTMLInputElement;
    for (const file of [...(input.files ?? [])]) {
      const reader = new FileReader();
      reader.onload = () => { if (typeof reader.result === "string") { refImages.push({ file, url: reader.result }); renderThumbs(); } };
      reader.readAsDataURL(file);
    }
    input.value = "";
  };
  el<HTMLFormElement>("composer").onsubmit = (event) => { event.preventDefault(); void send(); };
  el("input").onkeydown = (event) => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void send(); } };
  el<HTMLTextAreaElement>("system").onchange = () => { current.system = el<HTMLTextAreaElement>("system").value; };
  // Web search and image output cannot be combined (the proxy answers 400).
  const search = el<HTMLInputElement>("search");
  const images = el<HTMLInputElement>("images");
  search.onchange = () => { if (search.checked) images.checked = false; };
  images.onchange = () => { if (images.checked) search.checked = false; };
  showChat();
  void loadModels().then(() => { current.model = el<HTMLSelectElement>("model").value; });
}

init();
