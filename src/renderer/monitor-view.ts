import type { ActivityView, EngineView, MonitorView, ProxyApi } from "../shared/ipc.js";

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
const GB = 1024 ** 3;

const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
};
const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const gb = (bytes: number): string => `${(bytes / GB).toFixed(1)} GB`;
const seconds = (value: number): string => (value >= 10 ? `${value.toFixed(0)} s` : `${value.toFixed(1)} s`);
const millis = (ms: number): string => (ms >= 1000 ? seconds(ms / 1000) : `${ms} ms`);
const rateText = (value: number | undefined): string => (value === undefined ? "-" : value.toFixed(1));

/** A `.stat` tile. A missing value is a dash (never a guess) with the reason underneath. */
function tile(label: string, value: string | undefined, sub?: string): HTMLElement {
  const node = make("div", "stat");
  const valueNode = make("div", value === undefined ? "stat-value dash" : "stat-value", value ?? "-");
  node.append(make("div", "stat-label", label), valueNode);
  if (sub) node.append(make("div", "stat-sub", sub));
  return node;
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

  const active = (): boolean => current !== undefined && document.visibilityState === "visible";
  const stopTimer = (): void => { if (timer !== undefined) { clearTimeout(timer); timer = undefined; } };

  async function tick(): Promise<void> {
    stopTimer();
    if (!active()) return;
    const mine = generation;
    let view: MonitorView | undefined;
    try { view = await deps.api.getMonitor(); } catch { view = undefined; }
    if (mine !== generation || !active()) return;
    // A render error (for example a time the clock cannot format) keeps the last rendered state; the next poll is always scheduled.
    try { render(view); } catch { /* keep the last state */ }
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
    if (local.label) return local.modelId;
    if (local.state === "none") return "No local model loaded";
    if (local.modelId === undefined) return local.server === "strata" ? "provider is off in the proxy" : "model id unknown";
    return undefined;
  }

  /** Why the engine tiles have no numbers. */
  function reason(view: MonitorView | undefined): string | undefined {
    if (!view) return "Engine not reachable";
    if (view.engine) return undefined;
    if (view.local.state === "none") return "No local model loaded";
    if (view.engineError) return view.engineError === "not reachable" ? "Engine not reachable" : `Engine: ${view.engineError}`;
    if (view.local.server === "gufo") return "No status source for Gufo";
    if (view.local.state === "starting") return "Starting";
    return "No engine data";
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
      tile("State", local && local.state !== "none" ? local.state : undefined, local?.error),
      tile("Engine", engine ? (engine.state === "unknown" ? undefined : engine.state) : undefined, engine ? undefined : why),
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
    el("mon-engine").replaceChildren(
      tile("Decode", fromStrata(speed?.decodeTokS !== undefined ? `${rateText(speed.decodeTokS)} t/s` : undefined), !speed && noRequest ? "no request yet" : dashSub(true)),
      tile("Prefill", fromStrata(speed?.prefillTokS !== undefined ? `${rateText(speed.prefillTokS)} t/s` : undefined), !speed && noRequest ? "no request yet" : dashSub(true)),
      tile("Prompt reused", fromStrata(reuse && !reuseEmpty ? `${whole.format(reuse.reused)} of ${whole.format(reuse.prompt)}` : undefined), reuse && !reuseEmpty && engine?.kind === "strata" ? `${reuse.prompt > 0 ? Math.round((100 * reuse.reused) / reuse.prompt) : 0}% over ${reuse.requests} requests` : noRequest ? "no request yet" : dashSub(true)),
      tile("Context", engine?.context !== undefined ? `${whole.format(engine.context)} tokens` : undefined, engine?.context !== undefined ? undefined : dashSub(false)),
      tile("Slots busy", engine && engine.slots.length ? `${busySlots} / ${engine.slots.length}` : undefined, engine?.slots.length ? undefined : dashSub(false)),
    );
    renderSlots(engine);

    const hw = engine?.kind === "strata" ? engine.hardware : undefined;
    const host = view?.host;
    el("mon-hw").replaceChildren(
      tile("GPU load", hw?.gpuUtilPct !== undefined ? `${Math.round(hw.gpuUtilPct)}%` : undefined, hw?.gpuUtilPct === undefined ? dashSub(true) : hw.gpuName),
      tile("VRAM", hw?.gpuMemUsedBytes !== undefined ? gb(hw.gpuMemUsedBytes) : undefined, hw?.gpuMemTotalBytes !== undefined ? `of ${gb(hw.gpuMemTotalBytes)}` : dashSub(true)),
      tile("GPU temp", hw?.gpuTempC !== undefined ? `${Math.round(hw.gpuTempC)} °C` : undefined, hw?.gpuTempC === undefined ? dashSub(true) : undefined),
      tile("Power", hw?.gpuPowerW !== undefined ? `${Math.round(hw.gpuPowerW)} W` : undefined, hw?.gpuPowerW === undefined ? dashSub(true) : undefined),
      tile("Disk read", hw?.diskReadMBs !== undefined ? `${hw.diskReadMBs.toFixed(1)} MB/s` : undefined, hw?.diskReadMBs === undefined ? dashSub(true) : undefined),
      tile("CPU", host?.cpuPct !== undefined ? `${Math.round(host.cpuPct)}%` : undefined, host ? (host.cpuPct === undefined ? "measuring" : `${host.threads} threads`) : undefined),
      tile("RAM", host ? gb(host.ramUsedBytes) : undefined, host ? `of ${gb(host.ramTotalBytes)}` : undefined),
    );
    const bars: HTMLElement[] = [];
    if (hw?.gpuMemUsedBytes !== undefined && hw.gpuMemTotalBytes !== undefined) bars.push(barRow("VRAM", hw.gpuMemUsedBytes, hw.gpuMemTotalBytes, `${gb(hw.gpuMemUsedBytes)} / ${gb(hw.gpuMemTotalBytes)}`));
    if (host) bars.push(barRow("RAM", host.ramUsedBytes, host.ramTotalBytes, `${gb(host.ramUsedBytes)} / ${gb(host.ramTotalBytes)}`));
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
      const overall = entry.outputTokens !== undefined && entry.outputTokens > 0 && entry.durationMs > 0 ? `${approx}${(entry.outputTokens / (entry.durationMs / 1000)).toFixed(1)}` : "-";
      row.append(
        cell(clock.format(entry.time), "mono"), cell(entry.model ?? "-", "mono"), cell(String(entry.status), bad ? "bad" : "ok"),
        cell(entry.inputTokens !== undefined ? `${approx}${whole.format(entry.inputTokens)}` : "-", "num"),
        cell(entry.outputTokens !== undefined ? `${approx}${whole.format(entry.outputTokens)}` : "-", "num"),
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
      tile("Images", images === undefined ? undefined : images ? "yes" : "no", images !== undefined ? profileNote(engine?.images) : why ?? "no source"),
      tile("KV cache", strata?.kv, strata?.kv !== undefined ? (strata.kvResident !== undefined ? `${whole.format(strata.kvResident)} positions resident` : undefined) : "from Strata"),
      tile("Experts in VRAM", strata?.expertSlots !== undefined ? `${whole.format(strata.expertSlots)} slots` : undefined, strata?.expertCacheMiB !== undefined ? `${whole.format(strata.expertCacheMiB)} MiB` : "from Strata"),
      tile("Speculation", speculation, speculation !== undefined ? (strata?.drafting === undefined ? fromProfile : undefined) : why ?? "no source"),
    );
    el("about-notice").textContent = !view ? "Engine not reachable. Still trying every 2 seconds." : local?.state === "none" ? "No local model loaded." : "";

    const hw = engine?.kind === "strata" ? engine.hardware : undefined;
    const host = view?.host;
    el("about-pc").replaceChildren(
      tile("GPU", hw?.gpuName, hw?.gpuName !== undefined ? (hw.gpuMemTotalBytes !== undefined ? `${gb(hw.gpuMemTotalBytes)} memory` : undefined) : "from Strata"),
      tile("CPU", host?.cpuName, host ? `${host.threads} threads` : undefined),
      tile("RAM", host ? gb(host.ramTotalBytes) : undefined),
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
