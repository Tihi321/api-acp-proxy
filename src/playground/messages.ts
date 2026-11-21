import { clamp, curlFor, decodeRate, formatMs, formatRate, isHttpUrl, parseUiPrefs, previewDocument, splitBlocks, timingSegments } from "./lib.js";
import { highlight, parseMarkdown, type Inline, type ListBlock, type MdBlock } from "./markdown.js";
import { el, icon, local, make, storage } from "./dom.js";

// Conversation rendering for the playground: bubbles, prose, action bars, image grid, timing strip, the preview pane and the lightbox. Model text is rendered only through DOM nodes (textContent), never as HTML.

export interface Meta { model: string; stream: boolean; firstMs?: number; totalMs: number; inputTokens?: number; outputTokens?: number; finish?: string }
export interface Msg { role: "user" | "assistant"; content: string; images?: string[]; citations?: Array<{ url: string; title: string }>; meta?: Meta; error?: string; request?: unknown;
  /** Image attachments of a user message (data URLs). An entry that is not a data:image URL is drawn as "Image not saved" (the quota fallback dropped it). */
  attachments?: string[];
  /** Thinking text, shown in the accordion; never resent (requestBody sends only `content`). */
  reasoning?: string;
  /** ms from the first reasoning delta to the first content delta (or to the end when no content came); absent for non-streamed answers. */
  thoughtMs?: number;
  /** The user's (or the auto-collapse's) open state of the accordion; undefined = default (open while pending or when content is empty, else closed). Persisted. */
  thinkingOpen?: boolean }
/** One image-model run; lives in memory for the tab only. `refs` are the reference images (data URLs) shown as thumbs on the prompt bubble. */
export interface ImageRun { model: string; prompt: string; edit: boolean; urls: string[]; error?: string; totalMs?: number; elapsedS: number; pending: boolean; refs?: string[] }

export interface ConversationView { messages: Msg[]; imageRuns: ImageRun[]; imageMode: boolean; busy: boolean }
export interface ConversationActions {
  /** May return a promise; the button shows "copied" when it resolves. */
  copy(message: Msg): void | Promise<void>;
  retry(): void;
  edit(index: number, text: string): void;
  remove(index: number): void;
  retryImage(run: ImageRun): void;
  removeImage(run: ImageRun): void;
}

const API = `${location.origin}/v1`;
const UI_KEY = "acp-playground-ui";

export const isPending = (message: Msg): boolean => message.role === "assistant" && !message.meta && !message.error;

// The thinking accordion saves its open state on the message; the page decides whether saving is allowed (not while a request runs).
let thinkingToggled: () => void = () => {};
/** Called after the user opens or closes a thinking accordion (message.thinkingOpen is already updated). The caller saves the history unless a request is running. */
export function onThinkingToggle(fn: () => void): void { thinkingToggled = fn; }

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
export function markdownNodes(blocks: readonly MdBlock[]): Node[] {
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
export function codeFigure(lang: string, code: string): HTMLElement {
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
export function thinkingNode(message: Msg): HTMLDetailsElement {
  const details = make("details", "thinking");
  const summary = make("summary", isPending(message) && !message.content ? "pending" : "", thinkingSummary(message));
  details.append(summary, make("div", "thinking-text", message.reasoning ?? ""));
  details.open = message.thinkingOpen ?? (isPending(message) || !message.content);
  let last = details.open;
  details.addEventListener("toggle", () => {
    if (details.open === last) return;
    last = details.open;
    message.thinkingOpen = details.open;
    thinkingToggled();
  });
  return details;
}

// ---- small building blocks ----

function iconButton(name: string, label: string, onClick: () => void, extra = ""): HTMLButtonElement {
  const button = make("button", `icon-btn${extra ? ` ${extra}` : ""}`);
  button.type = "button";
  button.setAttribute("aria-label", label);
  button.title = label;
  button.append(icon(name));
  button.onclick = onClick;
  return button;
}

/** The copy button: shows a check for a moment once the action's promise resolves. */
function copyButton(run: () => void | Promise<void>, label: string): HTMLButtonElement {
  const button = iconButton("copy", label, () => {
    void Promise.resolve().then(run).then(() => {
      button.replaceChildren(icon("check"));
      setTimeout(() => button.replaceChildren(icon("copy")), 1500);
    }, () => { button.title = "Copy failed"; setTimeout(() => { button.title = label; }, 1500); });
  });
  return button;
}

function attachRow(urls: readonly string[]): HTMLElement | undefined {
  if (!urls.length) return undefined;
  const row = make("div", "attach-row");
  for (const url of urls) {
    if (url.startsWith("data:image/")) {
      const thumb = Object.assign(make("img", "attach-thumb"), { src: url, alt: "Attached image" });
      row.append(thumb);
    } else row.append(make("span", "attach-missing", "Image not saved"));
  }
  return row;
}

function modelLabel(message: Msg): string {
  const requested = (message.request as { model?: unknown } | undefined)?.model;
  return message.meta?.model ?? (typeof requested === "string" && requested ? requested : "Assistant");
}

const imageName = (url: string, index: number): string => { const ext = /^data:image\/([a-z0-9]+)/.exec(url)?.[1] ?? "png"; return `image-${index + 1}.${ext === "jpeg" ? "jpg" : ext}`; };

function imageGrid(urls: readonly string[]): HTMLElement | undefined {
  const shown = urls.filter((url) => url.startsWith("data:image/"));
  if (!shown.length) return undefined;
  const grid = make("div", "image-grid");
  shown.forEach((url, index) => {
    const tile = make("div", "image-tile");
    tile.append(Object.assign(make("img"), { src: url, alt: "Generated image" }));
    const tools = make("div", "tile-actions");
    const open = iconButton("expand", "Open full size", () => openLightbox(url));
    const download = Object.assign(make("a"), { href: url, download: imageName(url, index), title: "Download" });
    download.setAttribute("aria-label", "Download");
    download.append(icon("download"));
    tools.append(open, download);
    tile.append(tools);
    grid.append(tile);
  });
  return grid;
}

/** The three segments of the timing strip; widths are fractions set through flexGrow (CSSOM, allowed by the CSP). */
function stripNode(meta: { firstMs?: number; totalMs: number }, thoughtMs?: number): HTMLElement {
  const strip = make("div", "strip");
  strip.setAttribute("aria-hidden", "true");
  setStrip(strip, meta, thoughtMs);
  return strip;
}

function setStrip(strip: HTMLElement, meta: { firstMs?: number; totalMs: number }, thoughtMs?: number): void {
  const parts = timingSegments(meta, thoughtMs);
  if (!strip.firstElementChild) strip.append(make("span", "seg wait"), make("span", "seg think"), make("span", "seg write"));
  const [wait, think, write] = [...strip.children] as [HTMLElement, HTMLElement, HTMLElement];
  wait.style.flexGrow = String(parts.wait);
  think.style.flexGrow = String(parts.think);
  write.style.flexGrow = String(parts.write);
}

/** Strip plus the quiet footer line. The visible line is `TTFT 1.2 s · total 8.4 s · 412 in / 960 out · 71.3 tok/s`; the full text (streamed, finish) is in the title and in a screen-reader span. */
function timingNode(meta: Meta, thoughtMs: number | undefined): HTMLElement {
  const rate = decodeRate(meta);
  const tokens = meta.inputTokens !== undefined ? `${meta.inputTokens} in / ${meta.outputTokens ?? 0} out` : undefined;
  const visible = [
    ...(meta.firstMs !== undefined ? [`TTFT ${formatMs(meta.firstMs)}`] : []),
    `total ${formatMs(meta.totalMs)}`,
    ...(tokens ? [tokens] : []),
    ...(rate !== undefined ? [formatRate(rate)] : []),
    ...(meta.finish && meta.finish !== "stop" ? [`finish: ${meta.finish}`] : []),
  ].join(" · ");
  const full = [
    meta.stream ? "streamed" : "not streamed",
    ...(meta.firstMs !== undefined ? [`TTFT ${formatMs(meta.firstMs)}`] : []),
    `total ${formatMs(meta.totalMs)}`,
    ...(tokens ? [`${tokens} tokens`] : []),
    ...(rate !== undefined ? [formatRate(rate)] : []),
    ...(meta.finish ? [`finish: ${meta.finish}`] : []),
  ].join(", ");
  const node = make("div", "timing");
  node.title = full;
  const line = make("div", "meta", visible);
  line.setAttribute("aria-hidden", "true");
  node.append(stripNode(meta, thoughtMs), line, make("span", "sr-only", full));
  return node;
}

function requestDetails(message: Msg): HTMLElement {
  const details = make("details", "request");
  details.append(make("summary", "", "Request"));
  details.append(make("pre", "", JSON.stringify(message.request, null, 2)));
  const copy = make("button", "", "Copy as curl");
  copy.type = "button";
  copy.onclick = () => void navigator.clipboard.writeText(curlFor(API, message.request, Boolean(el<HTMLInputElement>("key").value.trim()))).then(() => { copy.textContent = "Copied"; setTimeout(() => { copy.textContent = "Copy as curl"; }, 1500); }, () => { copy.textContent = "Copy failed"; });
  details.append(copy);
  return details;
}

/** Run (opens the pane) and Open in new tab for the html/css/js blocks of one finished answer. */
function previewBar(html: string, title: string): HTMLElement {
  const bar = make("div", "preview-bar");
  const run = make("button", "", "Run");
  run.type = "button";
  const tab = make("button", "", "Open in new tab");
  tab.type = "button";
  run.onclick = () => openPreview(html, title);
  tab.onclick = () => openInTab(html);
  bar.append(run, tab);
  return bar;
}

function actionBar(items: HTMLButtonElement[], busy: boolean): HTMLElement {
  const bar = make("div", "actions");
  bar.setAttribute("role", "group");
  bar.setAttribute("aria-label", "Message actions");
  for (const item of items) { item.disabled = busy; bar.append(item); }
  return bar;
}

function renderUser(message: Msg, index: number, canEdit: boolean, view: ConversationView, actions: ConversationActions): HTMLElement {
  const node = make("div", "msg user");
  node.append(make("div", "who sr-only", "You"));
  const row = attachRow(message.attachments ?? []);
  if (row) node.append(row);
  const text = make("div", "text", message.content);
  node.append(text);
  const items = [copyButton(() => actions.copy(message), "Copy")];
  if (canEdit) items.push(iconButton("pencil", "Edit and resend", () => beginEdit(node, text, index, message, actions)));
  items.push(iconButton("trash", "Delete", () => actions.remove(index), "danger"));
  node.append(actionBar(items, view.busy));
  return node;
}

/** Swaps the bubble for a textarea with Save & send / Cancel (Cancel restores the bubble). */
function beginEdit(node: HTMLElement, text: HTMLElement, index: number, message: Msg, actions: ConversationActions): void {
  const form = make("div", "msg-edit");
  const area = make("textarea");
  area.value = message.content;
  area.rows = Math.min(10, Math.max(2, message.content.split("\n").length));
  area.setAttribute("aria-label", "Edit message");
  const bar = make("div", "edit-bar");
  const cancel = make("button", "", "Cancel");
  cancel.type = "button";
  const save = make("button", "primary", "Save & send");
  save.type = "button";
  const restore = () => { form.replaceWith(text); node.querySelector<HTMLElement>(":scope > .actions")?.removeAttribute("hidden"); };
  cancel.onclick = restore;
  const submit = () => { const value = area.value.trim(); if (value) actions.edit(index, value); };
  save.onclick = submit;
  area.onkeydown = (event) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); restore(); }
    else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); submit(); }
  };
  bar.append(cancel, save);
  form.append(area, bar);
  text.replaceWith(form);
  node.querySelector<HTMLElement>(":scope > .actions")?.setAttribute("hidden", "");
  area.focus();
}

function renderAssistant(message: Msg, index: number, isLast: boolean, view: ConversationView, actions: ConversationActions): HTMLElement {
  const node = make("div", "msg assistant");
  node.append(make("div", "who", modelLabel(message)));
  const pending = isPending(message);
  if (message.reasoning) node.append(thinkingNode(message));
  if (pending || message.content || (!message.error && !message.reasoning)) {
    const body = make("div", pending ? "body pending" : "body");
    body.append(...markdownNodes(parseMarkdown(message.content)));
    node.append(body);
  }
  const blocks = message.meta ? splitBlocks(message.content) : [];
  const grid = imageGrid(message.images ?? []);
  if (grid) node.append(grid);
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
  const html = message.meta ? previewDocument(blocks) : undefined;
  if (html !== undefined) node.append(previewBar(html, `${modelLabel(message)} preview`));
  if (message.meta) node.append(timingNode(message.meta, message.thoughtMs));
  if (message.request) node.append(requestDetails(message));
  if (!pending) {
    const items = [copyButton(() => actions.copy(message), "Copy all")];
    if (isLast) items.push(iconButton("retry", "Retry last answer", () => actions.retry()));
    items.push(iconButton("trash", "Delete answer", () => actions.remove(index), "danger"));
    node.append(actionBar(items, view.busy));
  }
  return node;
}

export const waitingText = (seconds: number): string => `Waiting for the model (it may be starting, this can take minutes)... ${seconds} s`;
/** Updates the "Waiting for the model" counter of the newest pending image run (called once a second by the page's timer). */
export function setElapsed(seconds: number): void {
  const node = [...el("messages").querySelectorAll<HTMLElement>(".elapsed")].at(-1);
  if (node) node.textContent = waitingText(seconds);
}

function renderImageRun(run: ImageRun, view: ConversationView, actions: ConversationActions): HTMLElement[] {
  const user = make("div", "msg user");
  user.append(make("div", "who sr-only", "You"));
  const row = attachRow(run.refs ?? []);
  if (row) user.append(row);
  user.append(make("div", "text", run.prompt));
  const node = make("div", "msg assistant image-result");
  node.append(make("div", "who", `${run.model}${run.edit ? " (edit)" : ""}`));
  if (run.pending) node.append(make("div", "elapsed", waitingText(run.elapsedS)));
  const grid = imageGrid(run.urls);
  if (grid) node.append(grid);
  if (run.error) node.append(make("div", "error", run.error));
  if (run.totalMs !== undefined) {
    const timing = make("div", "timing");
    const full = `total ${formatMs(run.totalMs)}`;
    timing.title = full;
    const strip = stripNode({ totalMs: run.totalMs });
    const line = make("div", "meta", full);
    timing.append(strip, line);
    node.append(timing);
  }
  if (!run.pending) node.append(actionBar([iconButton("retry", "Retry", () => actions.retryImage(run)), iconButton("trash", "Delete", () => actions.removeImage(run), "danger")], view.busy));
  return [user, node];
}

/** Draws the conversation (or the image runs) into `box` (#messages) and toggles the empty state (#empty) against it. */
export function renderConversation(box: HTMLElement, view: ConversationView, actions: ConversationActions): void {
  const empty = el("empty");
  const showStarters = !view.imageMode && !view.messages.length;
  empty.hidden = !showStarters;
  box.hidden = showStarters;
  if (showStarters) { box.replaceChildren(); return; }
  if (view.imageMode) {
    box.replaceChildren(...(view.imageRuns.length ? view.imageRuns.flatMap((run) => renderImageRun(run, view, actions)) : [make("p", "empty", "Write a prompt and send it. Reference images are optional. Results stay in this tab only.")]));
  } else {
    const lastUser = view.messages.map((message) => message.role).lastIndexOf("user");
    box.replaceChildren(...view.messages.map((message, index) => message.role === "user" ? renderUser(message, index, index === lastUser, view, actions) : renderAssistant(message, index, index === view.messages.length - 1, view, actions)));
  }
  box.scrollTop = box.scrollHeight;
}

let starterBound = false;
/** Clicking a starter chip (`.chip[data-prompt]` in #starters) calls `fill` with its prompt; the page puts it in the composer and does not send. */
export function onStarter(fill: (text: string) => void): void {
  const host = el("starters");
  if (!starterBound) {
    starterBound = true;
    host.addEventListener("click", (event) => {
      const chip = (event.target as Element | null)?.closest<HTMLElement>(".chip[data-prompt]");
      const prompt = chip?.dataset.prompt;
      if (prompt) starterFill?.(prompt);
    });
  }
  starterFill = fill;
}
let starterFill: ((text: string) => void) | undefined;

// ---- live streaming ----

export interface StreamTarget {
  /** Call on each reasoning delta (after answer.reasoning is updated): creates the accordion once, notes when thinking began, and schedules a re-render. */
  thinking(): void;
  /** Call once when the first content delta arrives after thinking (answer.thoughtMs is set): collapses the accordion and fixes its summary. */
  thoughtDone(): void;
  /** Call after answer.content (or reasoning) changed: one trailing timer re-renders the markdown; its interval grows with the measured render time. */
  schedule(): void;
  /** Shows the live `~N tok/s` at the end of the live timing strip (call at most every 250 ms, as readStream does). */
  rate(tokPerSec: number): void;
  /** Cancels the pending render timer (call in readStream's finally). The caller re-renders the whole conversation afterwards. */
  stop(): void;
}

/** Live updates of the newest answer in #messages: body, thinking accordion, the growing timing strip with the live rate. Keeps today's adaptive render timer. */
export function streamTarget(answer: Msg, meta: Meta, started: number): StreamTarget {
  const messages = el("messages");
  const node = [...messages.querySelectorAll<HTMLElement>(".msg.assistant")].at(-1);
  const bodyNode = node?.querySelector<HTMLElement>(":scope > .body");
  let details: HTMLDetailsElement | undefined;
  let timing: { box: HTMLElement; strip: HTMLElement; rate: HTMLElement } | undefined;
  let thinkStart: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let interval = 100;
  const liveTiming = () => {
    if (!timing && bodyNode) {
      const box = make("div", "timing");
      const strip = make("div", "strip");
      strip.setAttribute("aria-hidden", "true");
      const rate = make("span", "rate");
      box.append(strip, rate);
      bodyNode.after(box);
      timing = { box, strip, rate };
    }
    return timing;
  };
  const updateStrip = () => {
    const live = liveTiming();
    if (!live) return;
    const now = performance.now();
    const thought = answer.thoughtMs ?? (thinkStart !== undefined ? now - thinkStart : undefined);
    setStrip(live.strip, { firstMs: meta.firstMs, totalMs: now - started }, thought);
  };
  const render = () => {
    timer = undefined;
    const t0 = performance.now();
    if (bodyNode) bodyNode.replaceChildren(...markdownNodes(parseMarkdown(answer.content)));
    const thinking = details?.querySelector<HTMLElement>(".thinking-text");
    if (thinking) { thinking.textContent = answer.reasoning ?? ""; thinking.scrollTop = thinking.scrollHeight; }
    updateStrip();
    messages.scrollTop = messages.scrollHeight;
    interval = Math.max(100, 4 * (performance.now() - t0));
  };
  const schedule = () => { timer ??= setTimeout(render, interval); };
  return {
    thinking() {
      thinkStart ??= performance.now();
      if (!details && bodyNode) { details = thinkingNode(answer); bodyNode.before(details); }
      schedule();
    },
    thoughtDone() {
      if (!details) return;
      details.open = false;
      const summary = details.querySelector("summary");
      if (summary) { summary.textContent = thinkingSummary(answer); summary.classList.remove("pending"); }
    },
    schedule,
    rate(tokPerSec: number) {
      const live = liveTiming();
      if (!live) return;
      live.rate.textContent = `~${formatRate(tokPerSec)}`;
      updateStrip();
    },
    stop() { if (timer !== undefined) clearTimeout(timer); timer = undefined; },
  };
}

// ---- preview pane ----

// The preview page announces itself with a message; the window that sent it (iframe or tab) is answered with the document, once. Model code runs only after a click.
const waiting = new Map<MessageEventSource, string>();
window.addEventListener("message", (event) => {
  const html = event.source ? waiting.get(event.source) : undefined;
  if (html === undefined || !event.source || (event.data as { type?: unknown } | null)?.type !== "acp-preview-ready") return;
  waiting.delete(event.source);
  // The target is "*" because the sandboxed preview has an opaque origin; the receiver checks that the sender is its parent/opener.
  (event.source as Window).postMessage({ type: "acp-preview-run", html }, "*");
});

const PREVIEW_MIN = 320;
const PREVIEW_STEP = 16;
let previewHtml: string | undefined;
let previewFrameWindow: Window | null = null;
let previewWidth = 0; // px; 0 = the default (45 % of the window) until the user picks one
let previewBound = false;

const previewMax = (): number => Math.max(PREVIEW_MIN, Math.round(window.innerWidth * 0.7));
const previewDefault = (): number => clamp(Math.round(window.innerWidth * 0.45), PREVIEW_MIN, previewMax());
const appNode = (): HTMLElement => document.querySelector<HTMLElement>(".app") ?? (() => { throw new Error(".app missing"); })();

/** Applies the pane width (px) to --preview-w and the separator values; `persist` writes previewWidth into the UI prefs JSON. */
function applyPreviewWidth(width: number, persist: boolean): void {
  const value = clamp(Math.round(width), PREVIEW_MIN, previewMax());
  appNode().style.setProperty("--preview-w", `${value}px`);
  const handle = el("preview-resize");
  handle.setAttribute("aria-valuemax", String(previewMax()));
  handle.setAttribute("aria-valuenow", String(value));
  if (persist) { previewWidth = value; savePreviewWidth(value); }
}

/** Read-modify-write of the whole prefs JSON; only previewWidth changes (the sidebar writes the same key). */
function savePreviewWidth(width: number): void {
  let data: Record<string, unknown> = {};
  try { const parsed: unknown = JSON.parse(storage.get(local, UI_KEY) ?? "null"); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) data = parsed as Record<string, unknown>; } catch { /* junk: start over */ }
  data.previewWidth = width;
  storage.set(local, UI_KEY, JSON.stringify(data));
}

function bindPreview(): void {
  if (previewBound) return;
  previewBound = true;
  previewWidth = parseUiPrefs(storage.get(local, UI_KEY)).previewWidth;
  el("preview-close").onclick = closePreview;
  el("preview-reload").onclick = () => { if (previewHtml !== undefined) mountFrame(previewHtml); };
  el("preview-tab").onclick = () => { if (previewHtml !== undefined) openInTab(previewHtml); };
  window.addEventListener("resize", () => { if (previewHtml !== undefined) applyPreviewWidth(previewWidth || previewDefault(), false); });
  const handle = el("preview-resize");
  const dragTo = (clientX: number) => applyPreviewWidth(appNode().getBoundingClientRect().right - clientX, false);
  handle.addEventListener("pointerdown", (event) => { handle.setPointerCapture(event.pointerId); handle.classList.add("dragging"); event.preventDefault(); });
  handle.addEventListener("pointermove", (event) => { if (handle.hasPointerCapture(event.pointerId)) dragTo(event.clientX); });
  const end = (event: PointerEvent) => {
    if (!handle.hasPointerCapture(event.pointerId)) return;
    handle.releasePointerCapture(event.pointerId);
    handle.classList.remove("dragging");
    applyPreviewWidth(appNode().getBoundingClientRect().right - event.clientX, true);
  };
  handle.addEventListener("pointerup", end);
  handle.addEventListener("pointercancel", (event) => { if (handle.hasPointerCapture(event.pointerId)) { handle.releasePointerCapture(event.pointerId); handle.classList.remove("dragging"); } });
  handle.addEventListener("dblclick", () => { applyPreviewWidth(previewDefault(), true); previewWidth = 0; savePreviewWidth(0); });
  // Keys follow the handle: Left moves it left (the pane grows), Right shrinks; Home/End jump to min/max; Enter resets to the default.
  handle.addEventListener("keydown", (event) => {
    const current = Number(handle.getAttribute("aria-valuenow")) || previewDefault();
    if (event.key === "ArrowLeft") applyPreviewWidth(current + PREVIEW_STEP, true);
    else if (event.key === "ArrowRight") applyPreviewWidth(current - PREVIEW_STEP, true);
    else if (event.key === "Home") applyPreviewWidth(PREVIEW_MIN, true);
    else if (event.key === "End") applyPreviewWidth(previewMax(), true);
    else if (event.key === "Enter") { applyPreviewWidth(previewDefault(), true); previewWidth = 0; savePreviewWidth(0); }
    else return;
    event.preventDefault();
  });
}

/** A fresh sandboxed iframe in #preview-body; the preview page is answered with the document once it announces itself. */
function mountFrame(html: string): void {
  if (previewFrameWindow) waiting.delete(previewFrameWindow);
  const frame = make("iframe", "preview");
  frame.setAttribute("sandbox", "allow-scripts");
  frame.src = "/playground/preview";
  frame.title = "Preview";
  el("preview-body").replaceChildren(frame);
  previewFrameWindow = frame.contentWindow;
  if (frame.contentWindow) waiting.set(frame.contentWindow, html);
}

function openInTab(html: string): void {
  const handle = window.open("/playground/preview", "_blank");
  if (handle) waiting.set(handle, html);
}

/** Shows `html` in the right-hand preview pane (replacing any earlier preview). The iframe stays sandboxed (allow-scripts only) under the page's CSP. */
export function openPreview(html: string, title: string): void {
  bindPreview();
  previewHtml = html;
  el("preview-title").textContent = title;
  el("preview-pane").hidden = false;
  el("preview-resize").hidden = false;
  appNode().classList.add("preview-open");
  applyPreviewWidth(previewWidth || previewDefault(), false);
  mountFrame(html);
}

export function closePreview(): void {
  if (previewFrameWindow) waiting.delete(previewFrameWindow);
  previewFrameWindow = null;
  previewHtml = undefined;
  document.getElementById("preview-body")?.replaceChildren();
  document.getElementById("preview-pane")?.setAttribute("hidden", "");
  document.getElementById("preview-resize")?.setAttribute("hidden", "");
  document.querySelector(".app")?.classList.remove("preview-open");
}

// ---- lightbox ----

let lightboxBound = false;

/** Full-size image in the #lightbox dialog; Esc, the close button and a click on the backdrop close it. */
export function openLightbox(url: string): void {
  const dialog = el<HTMLDialogElement>("lightbox");
  if (!lightboxBound) {
    lightboxBound = true;
    el("lightbox-close").onclick = () => dialog.close();
    dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
    dialog.addEventListener("close", () => el<HTMLImageElement>("lightbox-img").removeAttribute("src"));
  }
  el<HTMLImageElement>("lightbox-img").src = url;
  if (!dialog.open) dialog.showModal();
}
