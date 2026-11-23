import type { ActivityView, EngineView, MonitorView, ProxyApi } from "../shared/ipc.js";
import { deviceLostText, engineReason, gib, imagesNote, SPARK_H, SPARK_W, sparkGeometry, speedSub } from "./monitor-format.js";

/** Page logic of the Monitor and About pages (AAP-47). Read-only: it polls `getMonitor` while one of them is shown and the window is visible. */
export interface MonitorViewDeps {
  api: ProxyApi;
  showView(name: string): void;
  /** The activity list the Requests page already holds (newest first). */
  activity(): ActivityView[];
}
export interface MonitorViewHandle {
  /** The Monitor or About view became visible: read now, then every 2 s. */
  shown(view: "monitor" | "about"): void;
  /** Any other view is shown: stops the timer. */
  hidden(): void;
}

const POLL_MS = 2000;
const LOCAL_PROVIDERS = ["gufo", "strata", "llama"];
const MAX_PROXY_ROWS = 12;
const clock = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const whole = new Intl.NumberFormat();
const MIB = 1024 ** 2;
/** Sub line of the Model and State tiles for a server answering on its port that this app did not start. */
const OUTSIDE = "started outside the app";

const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
};
const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const seconds = (value: number): string => (value >= 10 ? `${value.toFixed(0)} s` : `${value.toFixed(1)} s`);
const millis = (ms: number): string => (ms >= 1000 ? seconds(ms / 1000) : `${ms} ms`);
const rateText = (value: number | undefined): string => (value === undefined ? "-" : value.toFixed(1));

/** A `.stat` tile. A missing value is a dash (never a guess) with the reason underneath; `extra` (a sparkline) goes under the sub line. */
function tile(label: string, value: string | undefined, sub?: string, extra?: Element): HTMLElement {
  const node = make("div", "stat");
  const valueNode = make("div", value === undefined ? "stat-value dash" : "stat-value", value ?? "-");
  node.append(make("div", "stat-label", label), valueNode);
  if (sub) node.append(make("div", "stat-sub", sub));
  if (extra) node.append(extra);
  return node;
}

const SVG_NS = "http://www.w3.org/2000/svg";
/**
 * A sparkline of Strata's last 60 s as an inline SVG (attributes only: the page's CSP forbids inline styles; the stroke comes from `.spark`). The geometry (lines, dots, flat-series rule) is `sparkGeometry`.
 */
function spark(values: readonly (number | null)[] | undefined, opts: { min?: number | undefined; max?: number | undefined } = {}): SVGSVGElement | undefined {
  const geometry = sparkGeometry(values, opts);
  if (!geometry) return undefined;
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${SPARK_W} ${SPARK_H}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", "spark");
  const title = document.createElementNS(SVG_NS, "title");
  title.textContent = "last 60 s";
  svg.append(title);
  const polyline = (points: string, className?: string): void => {
    const line = document.createElementNS(SVG_NS, "polyline");
    line.setAttribute("points", points);
    if (className) line.setAttribute("class", className);
    svg.append(line);
  };
  for (const points of geometry.lines) polyline(points);
  for (const points of geometry.dots) polyline(points, "dot");
  return svg;
}

/** A labelled bar. The bar is a <progress> element: its width needs no inline style (the page's CSP forbids them). */
function barRow(label: string, value: number, max: number, text: string, busy = false): HTMLElement {
  const row = make("div", "mon-row");
  const bar = make("progress", "mon-bar");
  bar.max = max > 0 ? max : 1;
  bar.value = Math.max(0, Math.min(value, bar.max));
  if (max > 0 && value / max >= 0.9) bar.classList.add("full"); else if (busy) bar.classList.add("busy");
  row.append(make("span", "", label), bar, make("span", "mono", text));
  return row;
}

export function initMonitorView(deps: MonitorViewDeps): MonitorViewHandle {
  let current: "monitor" | "about" | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** Bumped by every shown(), hidden() and resume: a read that started before the bump neither renders nor reschedules. */
  let generation = 0;
  let connectKey = "";
  /** `at` of the last reading rendered without an error. */
  let lastShownAt: number | undefined;

  const active = (): boolean => current !== undefined && document.visibilityState === "visible";
  const stopTimer = (): void => { if (timer !== undefined) { clearTimeout(timer); timer = undefined; } };

  async function tick(): Promise<void> {
    stopTimer();
    if (!active()) return;
    const mine = generation;
    let view: MonitorView | undefined;
    try { view = await deps.api.getMonitor(); } catch { view = undefined; }
    if (mine !== generation || !active()) return;
    // A render error (for example a time the clock cannot format) keeps the last rendered state under a notice; the next good render clears it. The next poll is always scheduled.
    try {
      render(view);
      if (view) lastShownAt = view.at;
    } catch {
      let when = "an earlier reading";
      try { if (lastShownAt !== undefined) when = clock.format(lastShownAt); } catch { /* keep the generic wording */ }
      const notice = `Could not show the latest reading. The numbers below are from ${when}.`;
      el("mon-notice").textContent = notice;
      el("about-notice").textContent = notice;
      el("mon-updated").textContent = lastShownAt !== undefined ? `updated ${when}` : ""; // render() may have stamped the failed reading's time
    }
    timer = setTimeout(() => void tick(), POLL_MS);
  }
  function restart(): void { generation += 1; stopTimer(); void tick(); }

  document.addEventListener("visibilitychange", () => {
    if (current === undefined) return;
    if (document.visibilityState === "visible") restart(); else { generation += 1; stopTimer(); }
  });
  el("mon-open-requests").onclick = () => deps.showView("requests");

  function render(view: MonitorView | undefined): void {
    el("mon-updated").textContent = view ? `updated ${clock.format(view.at)}` : "";
    renderMonitor(view);
    renderAbout(view);
  }

  /** Sub-line of a Model tile: the model id under a label, or the reason there is no model id. */
  function modelSub(local: MonitorView["local"] | undefined): string | undefined {
    if (!local) return undefined;
    if (local.external) return OUTSIDE;
    if (local.label) return local.modelId;
    if (local.state === "none") return "No local model loaded";
    if (local.modelId === undefined) return local.server === "strata" ? "provider is off in the proxy" : "model id unknown";
    return undefined;
  }

  /** Why the engine tiles have no numbers. */
  function reason(view: MonitorView | undefined): string | undefined {
    return engineReason({ reachable: view !== undefined, hasEngine: view?.engine !== undefined, state: view?.local.state ?? "error", server: view?.local.server, image: view?.local.image, engineError: view?.engineError });
  }

  function renderMonitor(view: MonitorView | undefined): void {
    const local = view?.local;
    const engine = view?.engine;
    const why = reason(view);
    const badge = el("mon-state");
    const state = local?.state ?? "error";
    badge.className = `badge ${state === "ready" ? "ok" : state === "starting" ? "info" : state === "error" ? "err" : ""}`.trim();
    badge.textContent = view ? (state === "none" ? "none loaded" : state) : "unreachable";

    const fromStrata = (value: string | undefined, onlyStrata = true): string | undefined => (value !== undefined && (!onlyStrata || engine?.kind === "strata") ? value : undefined);
    const dashSub = (strataOnly: boolean): string | undefined => (engine ? (strataOnly && engine.kind !== "strata" ? "from Strata" : undefined) : why);

    const queue = local?.queue;
    el("mon-model").replaceChildren(
      tile("Model", local?.label ?? local?.modelId, modelSub(local)),
      tile("State", local && local.state !== "none" ? local.state : undefined, local?.error ?? (local?.external ? OUTSIDE : undefined)),
      tile("Engine", engine ? (engine.state === "unknown" ? undefined : engine.state) : undefined, engine ? deviceLostText(engine.deviceLost) : why),
      tile("Since", local?.readyAt !== undefined ? clock.format(local.readyAt) : undefined, local?.startedAt !== undefined && local.readyAt === undefined ? `started ${clock.format(local.startedAt)}` : undefined),
      tile("Port", local?.port !== undefined ? String(local.port) : undefined),
      tile("Proxy queue", queue ? `${queue.active} / ${queue.limit > 0 ? queue.limit : "unlimited"}` : undefined, queue ? `${queue.queued} queued` : undefined),
    );
    el("mon-notice").textContent = !view ? "Engine not reachable. Still trying every 2 seconds." : local?.state === "none" ? "No local model loaded. Start one on the Gufo, Strata or Llama.cpp page, or send a request to a local model." : "";

    const speed = engine?.speed;
    const reuse = engine?.reuse;
    const busySlots = engine?.slots.filter((slot) => slot.busy).length;
    /** Strata is up but has served nothing yet: the speed and reuse tiles are dashes for that reason. */
    const reuseEmpty = reuse !== undefined && reuse.prompt === 0 && reuse.reused === 0;
    const noRequest = engine?.kind === "strata" && !speed && (!reuse || reuseEmpty);
    const history = engine?.kind === "strata" ? engine.history : undefined;
    const cache = engine?.kind === "strata" ? engine.conversationCache : undefined;
    const count = (value: number | undefined): string => (value !== undefined ? whole.format(value) : "-");
    const llama = engine?.kind === "llama" || engine?.kind === "gufo";
    const speedValue = (value: number | undefined): string | undefined => (value === undefined ? undefined : llama ? `${rateText(value)} t/s` : fromStrata(`${rateText(value)} t/s`));
    /** `missingText` is the reason for a dash when the engine has the other speed (for example every prompt was cached, so there is no prefill number). */
    const speedText = (value: number | undefined, missingText: string): string | undefined => speedSub({ llama, gufo: engine?.kind === "gufo", value, haveSpeed: speed !== undefined, missingText, noRequest, speedMissing: engine?.speedMissing, external: local?.external === true, fallback: dashSub(true) });
    el("mon-engine").replaceChildren(
      tile("Decode", speedValue(speed?.decodeTokS), speedText(speed?.decodeTokS, "no reply yet"), spark(history?.decodeTokS, { min: 0 })),
      tile("Prefill", speedValue(speed?.prefillTokS), speedText(speed?.prefillTokS, "no prompt read yet")),
      tile("Prompt reused", fromStrata(reuse && !reuseEmpty ? `${whole.format(reuse.reused)} of ${whole.format(reuse.prompt)}` : undefined), reuse && !reuseEmpty && engine?.kind === "strata" ? `${reuse.prompt > 0 ? Math.round((100 * reuse.reused) / reuse.prompt) : 0}% over ${reuse.requests} requests` : noRequest ? "no request yet" : dashSub(true)),
      tile("Conversation cache", cache ? (cache.enabled ? `${count(cache.parked)} of ${count(cache.slots)} parked` : "off") : undefined,
        cache ? (cache.enabled ? `${count(cache.restores)} restored · ${count(cache.evictions)} evicted · ${cache.bytes !== undefined ? whole.format(Math.round(cache.bytes / MIB)) : "-"} of ${count(cache.budgetMiB)} MiB` : undefined) : dashSub(true)),
      tile("Context", engine?.context !== undefined ? `${whole.format(engine.context)} tokens` : undefined, engine?.context !== undefined ? undefined : dashSub(false)),
      tile("Slots busy", engine && engine.slots.length ? `${busySlots} / ${engine.slots.length}` : undefined, engine?.slots.length ? undefined : dashSub(false)),
    );
    renderSlots(engine);

    const hw = engine?.kind === "strata" ? engine.hardware : undefined;
    const host = view?.host;
    el("mon-hw").replaceChildren(
      tile("GPU load", hw?.gpuUtilPct !== undefined ? `${Math.round(hw.gpuUtilPct)}%` : undefined, hw?.gpuUtilPct === undefined ? dashSub(true) : hw.gpuName, spark(history?.gpuUtilPct, { min: 0, max: 100 })),
      tile("VRAM", hw?.gpuMemUsedBytes !== undefined ? gib(hw.gpuMemUsedBytes) : undefined, hw?.gpuMemTotalBytes !== undefined ? `of ${gib(hw.gpuMemTotalBytes)}` : dashSub(true), spark(history?.gpuMemUsedBytes, { min: 0, max: hw?.gpuMemTotalBytes })),
      tile("GPU temp", hw?.gpuTempC !== undefined ? `${Math.round(hw.gpuTempC)} °C` : undefined, hw?.gpuTempC === undefined ? dashSub(true) : undefined, spark(history?.gpuTempC)),
      tile("Power", hw?.gpuPowerW !== undefined ? `${Math.round(hw.gpuPowerW)} W` : undefined, hw?.gpuPowerW === undefined ? dashSub(true) : undefined, spark(history?.gpuPowerW, { min: 0 })),
      tile("Disk read", hw?.diskReadMBs !== undefined ? `${hw.diskReadMBs.toFixed(1)} MB/s` : undefined, hw?.diskReadMBs === undefined ? dashSub(true) : undefined, spark(history?.diskReadMBs, { min: 0 })),
      tile("CPU", host?.cpuPct !== undefined ? `${Math.round(host.cpuPct)}%` : undefined, host ? (host.cpuPct === undefined ? "measuring" : `${host.threads} threads`) : undefined),
      tile("RAM", host ? gib(host.ramUsedBytes) : undefined, host ? `of ${gib(host.ramTotalBytes)}` : undefined),
    );
    const bars: HTMLElement[] = [];
    if (hw?.gpuMemUsedBytes !== undefined && hw.gpuMemTotalBytes !== undefined) bars.push(barRow("VRAM", hw.gpuMemUsedBytes, hw.gpuMemTotalBytes, `${gib(hw.gpuMemUsedBytes)} / ${gib(hw.gpuMemTotalBytes)}`));
    if (host) bars.push(barRow("RAM", host.ramUsedBytes, host.ramTotalBytes, `${gib(host.ramUsedBytes)} / ${gib(host.ramTotalBytes)}`));
    el("mon-vram").replaceChildren(...bars);

    renderEngineRequests(engine, why);
    renderProxyRequests();
  }

  function renderSlots(engine: EngineView | undefined): void {
    el("mon-slots").replaceChildren(...(engine?.slots ?? []).map((slot) => {
      const max = slot.ctx ?? engine?.context ?? 0;
      return barRow(`Slot ${slot.id}`, slot.tokens, max, `${slot.busy ? "busy" : "idle"} · ${whole.format(slot.tokens)}${max > 0 ? ` / ${whole.format(max)}` : ""}`, slot.busy);
    }));
  }

  function renderEngineRequests(engine: EngineView | undefined, why: string | undefined): void {
    const rows = engine?.kind === "strata" ? engine.requests : [];
    el("mon-eng-empty").hidden = rows.length > 0;
    el("mon-eng-empty").textContent = engine?.kind === "strata" ? "Strata has not served a request yet." : engine ? "from Strata" : `${why ?? "No engine data"}. Engine requests come from Strata.`;
    el("mon-eng-table").hidden = rows.length === 0;
    el("mon-eng-body").replaceChildren(...rows.map((request) => {
      const row = make("tr");
      const cell = (text: string, className = ""): HTMLTableCellElement => make("td", className, text);
      row.append(
        cell(request.time !== undefined ? clock.format(request.time) : "-", "mono"), cell(request.finish ?? "-"),
        cell(whole.format(request.promptTokens), "num"), cell(whole.format(request.reused), "num"), cell(whole.format(request.outputTokens), "num"),
        cell(rateText(request.prefillTokS), "num"), cell(rateText(request.decodeTokS), "num"), cell(seconds(request.durationS), "num"),
      );
      return row;
    }));
  }

  function renderProxyRequests(): void {
    const rows = deps.activity().filter((entry) => entry.provider !== undefined && LOCAL_PROVIDERS.includes(entry.provider)).slice(0, MAX_PROXY_ROWS);
    el("mon-req-empty").hidden = rows.length > 0;
    el("mon-req-table").hidden = rows.length === 0;
    el("mon-req-body").replaceChildren(...rows.map((entry) => {
      const row = make("tr");
      const bad = entry.status >= 400 || entry.error !== undefined;
      const cell = (text: string, className = ""): HTMLTableCellElement => make("td", className, text);
      const approx = entry.estimated ? "≈ " : "";
      const thinkApprox = entry.estimated || entry.reasoningEstimated ? "≈ " : "";
      const overall = entry.outputTokens !== undefined && entry.outputTokens > 0 && entry.durationMs > 0 ? `${approx}${(entry.outputTokens / (entry.durationMs / 1000)).toFixed(1)}` : "-";
      row.append(
        cell(clock.format(entry.time), "mono"), cell(entry.model ?? "-", "mono"), cell(String(entry.status), bad ? "bad" : "ok"),
        cell(entry.inputTokens !== undefined ? `${approx}${whole.format(entry.inputTokens)}` : "-", "num"),
        cell(entry.outputTokens !== undefined ? `${approx}${whole.format(entry.outputTokens)}` : "-", "num"),
        cell(entry.reasoningTokens !== undefined ? `${thinkApprox}${whole.format(entry.reasoningTokens)}` : "-", "num"),
        cell(millis(entry.durationMs), "num"), cell(overall, "num"),
      );
      return row;
    }));
  }

  function renderAbout(view: MonitorView | undefined): void {
    const local = view?.local;
    const engine = view?.engine;
    const facts = local?.profileFacts;
    const why = reason(view);
    const fromProfile = "from the profile";
    const strata = engine?.kind === "strata" ? engine.strata : undefined;

    const engineName = engine?.kind === "strata" ? `Strata${engine.version ? ` ${engine.version}` : ""}`
      : engine?.kind === "llama" ? `llama.cpp${engine.version ? ` ${engine.version}` : ""}`
        : local?.server === "gufo" ? "Gufo" : local?.server === "strata" ? "Strata" : local?.server === "llama" ? "llama.cpp" : undefined;
    const context = engine?.context ?? facts?.context;
    const images = engine?.images ?? facts?.vision;
    const speculation = strata?.drafting ?? facts?.specType;
    const profileNote = (engineValue: unknown): string | undefined => (engineValue === undefined && facts ? fromProfile : undefined);

    el("about-model").replaceChildren(
      tile("Model", local?.label ?? local?.modelId, modelSub(local)),
      tile("Engine", engineName, local?.profile && local.server === "gufo" ? `profile ${local.profile}` : undefined),
      tile("Context", context !== undefined ? `${whole.format(context)} tokens` : undefined, context !== undefined ? profileNote(engine?.context) : why ?? "no source"),
      tile("Images", images === undefined ? undefined : images ? "yes" : "no", images !== undefined ? imagesNote(engine?.images, facts?.vision) ?? profileNote(engine?.images) : why ?? "no source"),
      tile("KV cache", strata?.kv, strata?.kv !== undefined ? (strata.kvResident !== undefined ? `${whole.format(strata.kvResident)} positions resident` : undefined) : "from Strata"),
      tile("Experts in VRAM", strata?.expertSlots !== undefined ? `${whole.format(strata.expertSlots)} slots` : undefined, strata?.expertCacheMiB !== undefined ? `${whole.format(strata.expertCacheMiB)} MiB` : "from Strata"),
      tile("Speculation", speculation, speculation !== undefined ? (strata?.drafting === undefined ? fromProfile : undefined) : why ?? "no source"),
    );
    el("about-notice").textContent = !view ? "Engine not reachable. Still trying every 2 seconds." : local?.state === "none" ? "No local model loaded." : "";

    const hw = engine?.kind === "strata" ? engine.hardware : undefined;
    const host = view?.host;
    el("about-pc").replaceChildren(
      tile("GPU", hw?.gpuName, hw?.gpuName !== undefined ? (hw.gpuMemTotalBytes !== undefined ? `${gib(hw.gpuMemTotalBytes)} memory` : undefined) : "from Strata"),
      tile("CPU", host?.cpuName, host ? `${host.threads} threads` : undefined),
      tile("RAM", host ? gib(host.ramTotalBytes) : undefined),
    );
    renderConnect(view);
  }

  /** Rebuilt only when its content changes, so a "Copied" label and a focused button survive the 2 s refresh. */
  function renderConnect(view: MonitorView | undefined): void {
    if (!view) return;
    const key = JSON.stringify(view.connect);
    if (key === connectKey) return;
    connectKey = key;
    const copyRow = (label: string, value: string): HTMLElement => {
      const row = make("div", "status-line");
      const button = make("button", "small", "Copy");
      button.type = "button";
      button.onclick = () => void deps.api.copyText(value).then(() => { button.textContent = "Copied"; setTimeout(() => { button.textContent = "Copy"; }, 1200); });
      row.append(make("span", "muted", label), make("span", "mono", value), button);
      return row;
    };
    const { baseUrl, apiKeyNeeded, localModelIds } = view.connect;
    el("about-connect").replaceChildren(
      baseUrl ? copyRow("OpenAI base URL", baseUrl) : make("p", "muted", "The server is not running, so there is no address yet."),
      make("p", "note", "Anthropic-compatible URL: not served (this proxy speaks the OpenAI API: chat completions, responses, images, embeddings)."),
      make("p", "note", `API key: ${apiKeyNeeded ? "needed (the key is set on the Server page)" : "not needed"}.`),
      ...(localModelIds.length ? [make("h3", "", "Local model ids"), ...localModelIds.map((id) => copyRow("Model", id))] : [make("p", "muted", "No local model is listed yet.")]),
    );
  }

  return {
    shown(view): void { current = view; restart(); },
    hidden(): void { current = undefined; generation += 1; stopTimer(); },
  };
}
