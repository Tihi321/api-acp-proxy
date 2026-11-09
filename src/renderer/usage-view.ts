import type { PlanLimitsView, ProviderStatusView, ProxyApi, RateLimitHintView, StateView, UsageCountsView, UsageRangeKey, UsageView } from "../shared/ipc.js";

export interface UsageViewDeps { api: ProxyApi; showView(name: string): void; }
export interface UsageViewHandle {
  /** The Usage view became visible: refetch usage; for providers in state "ready" whose plan limits are `idle` or older than 60 s, call refreshPlanLimits(id, false). */
  shown(): void;
  /** Called on every state push: provider names and states (enables or disables Refresh, labels). */
  setState(state: StateView): void;
}

type Metric = "requests" | "tokens";
const RANGE_KEY = "acp-proxy.usageRange";
const METRIC_KEY = "acp-proxy.usageMetric";
const RANGES: readonly UsageRangeKey[] = ["today", "last7", "last30", "allTime"];
const KNOWN_SERIES = ["codex", "claude", "antigravity"];
const STALE_MS = 60_000;

const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const full = new Intl.NumberFormat();
const clock = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const dateTime = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const dayLong = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short" });
const dayShort = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });

const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
};
const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

function readStored(key: string): string | undefined {
  try { return localStorage.getItem(key) ?? undefined; } catch { return undefined; }
}
function writeStored(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* storage unavailable: the choice is not remembered */ }
}

const seriesClass = (id: string): string => `series-${KNOWN_SERIES.includes(id) ? id : "other"}`;
const swatch = (id: string): HTMLSpanElement => make("span", `legend-swatch ${seriesClass(id)}`);
const parseDay = (day: string): Date => { const [year, month, date] = day.split("-").map(Number); return new Date(year ?? 1970, (month ?? 1) - 1, date ?? 1); };
const totalTokens = (counts: UsageCountsView): number => counts.inputTokens + counts.outputTokens;
const approxNote = (counts: UsageCountsView): string => `${full.format(counts.estimated)} of ${full.format(counts.requests)} requests have estimated token counts (about 4 characters per token)`;

/** Provider ids in the display order: Codex, Claude, Antigravity, then the rest as given. */
function orderIds(ids: readonly string[]): string[] {
  const known = KNOWN_SERIES.filter((id) => ids.includes(id));
  return [...known, ...ids.filter((id) => !KNOWN_SERIES.includes(id))];
}

/** A `.stat` tile; `approx` prefixes the value with a muted "≈ ". */
function stat(label: string, value: string, options: { sub?: string; title?: string; approx?: boolean } = {}): HTMLElement {
  const tile = make("div", "stat");
  if (options.title) tile.title = options.title;
  const valueNode = make("div", "stat-value");
  if (options.approx) valueNode.append(make("span", "approx", "≈ "));
  valueNode.append(document.createTextNode(value));
  tile.append(make("div", "stat-label", label), valueNode);
  if (options.sub) tile.append(make("div", "stat-sub", options.sub));
  return tile;
}

function tokenTile(label: string, tokens: number, counts: UsageCountsView): HTMLElement {
  const estimated = counts.estimated > 0;
  return stat(label, compact.format(tokens), { approx: estimated, title: estimated ? `${full.format(tokens)}\n${approxNote(counts)}` : full.format(tokens) });
}

function hintLine(hint: RateLimitHintView, name: string): string {
  const types: Record<string, string> = { five_hour: "5-hour window", seven_day: "weekly window" };
  const statuses: Record<RateLimitHintView["status"], string> = { allowed: "within the limit", allowed_warning: "near the limit", rejected: "limit reached" };
  const parts = [`${hint.rateLimitType ? types[hint.rateLimitType] ?? hint.rateLimitType : "rate limit"} ${statuses[hint.status]}`];
  if (hint.utilization !== undefined) parts.push(`${hint.utilization}% used`);
  if (hint.resetsAt !== undefined) parts.push(`resets ${dateTime.format(hint.resetsAt)}`);
  return `${name} reported at ${clock.format(hint.at)}: ${parts.join(", ")}`;
}

export function initUsageView(deps: UsageViewDeps): UsageViewHandle {
  const { api, showView } = deps;
  let usage: UsageView | undefined;
  let limits: PlanLimitsView[] = [];
  let names = new Map<string, string>();
  let states = new Map<string, ProviderStatusView["state"]>();
  const pending = new Set<string>();
  let range: UsageRangeKey = (RANGES as readonly string[]).includes(readStored(RANGE_KEY) ?? "") ? (readStored(RANGE_KEY) as UsageRangeKey) : "today";
  let metric: Metric = readStored(METRIC_KEY) === "tokens" ? "tokens" : "requests";
  let resetError = "";

  const nameOf = (id: string): string => names.get(id) ?? id;

  function renderOverviewStrip(): void {
    const strip = el("ov-usage");
    if (!usage) { strip.replaceChildren(); return; }
    const today = usage.total.today;
    strip.replaceChildren(
      stat("Requests", compact.format(today.requests), { title: full.format(today.requests) }),
      tokenTile("Tokens", totalTokens(today), today),
      stat("Errors", compact.format(today.errors), { title: full.format(today.errors) }),
    );
  }

  function renderStats(): void {
    const stats = el("usage-stats");
    if (!usage) { stats.replaceChildren(); return; }
    const counts = usage.total[range];
    const rate = counts.requests ? `${((counts.errors / counts.requests) * 100).toFixed(counts.errors / counts.requests >= 0.1 ? 0 : 1)}% error rate` : "no requests";
    stats.replaceChildren(
      stat("Requests", compact.format(counts.requests), { title: full.format(counts.requests) }),
      tokenTile("Input tokens", counts.inputTokens, counts),
      tokenTile("Output tokens", counts.outputTokens, counts),
      stat("Errors", compact.format(counts.errors), { sub: rate, title: full.format(counts.errors) }),
    );
  }

  function numberCell(value: number, estimated = false, className = ""): HTMLTableCellElement {
    const cell = make("td", `num ${className}`.trim());
    if (estimated) cell.append(make("span", "approx", "≈ "));
    cell.append(document.createTextNode(full.format(value)));
    return cell;
  }

  function renderTable(): void {
    const body = el("usage-body");
    const foot = el("usage-foot");
    if (!usage) { body.replaceChildren(); foot.replaceChildren(); return; }
    const rows = orderIds(usage.providers.map((entry) => entry.id)).map((id) => {
      const counts = usage!.providers.find((entry) => entry.id === id)![range];
      const row = make("tr", counts.requests === 0 ? "is-zero" : "");
      const first = make("td");
      first.append(swatch(id), document.createTextNode(nameOf(id)));
      row.append(first, numberCell(counts.requests), numberCell(counts.errors, false, counts.errors > 0 ? "bad" : ""), numberCell(counts.inputTokens, counts.estimated > 0), numberCell(counts.outputTokens, counts.estimated > 0));
      if (counts.estimated > 0) row.title = approxNote(counts);
      return row;
    });
    body.replaceChildren(...rows);
    const total = usage.total[range];
    const totalRow = make("tr", "total");
    totalRow.append(make("td", "", "All providers"), numberCell(total.requests), numberCell(total.errors, false, total.errors > 0 ? "bad" : ""), numberCell(total.inputTokens, total.estimated > 0), numberCell(total.outputTokens, total.estimated > 0));
    foot.replaceChildren(totalRow);
  }

  function renderChart(): void {
    const chart = el("usage-chart");
    const legend = el("usage-legend");
    chart.setAttribute("aria-label", `${metric === "tokens" ? "Tokens" : "Requests"} per day, last 30 days`);
    if (!usage) { chart.replaceChildren(); legend.replaceChildren(); return; }
    const ids = orderIds(usage.providers.map((entry) => entry.id));
    legend.replaceChildren(...ids.map((id) => { const item = make("li"); item.append(swatch(id), document.createTextNode(nameOf(id))); return item; }));
    const valueOf = (counts: UsageCountsView | undefined): number => !counts ? 0 : metric === "tokens" ? totalTokens(counts) : counts.requests;
    const dayTotals = usage.days.map((day) => ids.reduce((sum, id) => sum + valueOf(day.byProvider[id]), 0));
    const max = Math.max(0, ...dayTotals);
    if (max === 0) {
      chart.replaceChildren(make("p", "empty-state", metric === "tokens" ? "No tokens in the last 30 days." : "No requests in the last 30 days."));
      return;
    }
    const bars = make("div", "chart-bars");
    const axis = make("div", "chart-axis");
    const last = usage.days.length - 1;
    usage.days.forEach((day, index) => {
      const column = make("div", "chart-day");
      const parts: string[] = [];
      let topSegment: HTMLElement | undefined;
      for (const id of ids) {
        const value = valueOf(day.byProvider[id]);
        if (value === 0) continue;
        const segment = make("div", `chart-seg ${seriesClass(id)}`);
        segment.style.height = `${(value / max) * 100}%`;
        column.append(segment);
        topSegment = segment;
        parts.push(`${nameOf(id)} ${full.format(value)}`);
      }
      topSegment?.classList.add("is-top");
      column.title = `${dayLong.format(parseDay(day.day))} · ${parts.length ? parts.join(" · ") : metric === "tokens" ? "no tokens" : "no requests"}`;
      bars.append(column);
      const tick = make("div", "chart-tick");
      const fromToday = last - index;
      if (index === last) tick.append(make("span", "", "Today"));
      else if (index === 0 || (fromToday % 7 === 0 && index > 1)) tick.append(make("span", "", dayShort.format(parseDay(day.day))));
      axis.append(tick);
    });
    chart.replaceChildren(bars, axis);
  }

  function renderNote(): void {
    const note = el("usage-note");
    if (resetError) { note.className = "note msg bad"; note.textContent = resetError; return; }
    note.className = "note";
    const since = usage?.since ? `Counted by this proxy since ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(parseDay(usage.since))}. ` : "";
    note.textContent = `${since}Recent requests' Clear does not change these totals. ≈ marks estimates (about 4 characters per token) for answers where the agent reported no usage.`;
  }

  function renderControls(): void {
    for (const button of el("usage-range").querySelectorAll<HTMLButtonElement>("button")) button.setAttribute("aria-pressed", String(button.dataset.range === range));
    for (const button of el("usage-metric").querySelectorAll<HTMLButtonElement>("button")) button.setAttribute("aria-pressed", String(button.dataset.metric === metric));
  }

  function renderUsage(): void {
    renderControls();
    renderOverviewStrip();
    renderStats();
    renderTable();
    renderChart();
    renderNote();
  }

  function windowBadge(view: PlanLimitsView, name: string): HTMLElement {
    const badge = make("span", "badge");
    const highest = Math.max(0, ...view.windows.map((entry) => entry.usedPercent));
    if (view.hint?.status === "rejected" || highest >= 100) { badge.classList.add("err"); badge.textContent = "limit reached"; }
    else if (highest >= 75) { badge.classList.add("warn"); badge.textContent = "near limit"; }
    else if (view.state === "ok") { badge.classList.add("ok"); badge.textContent = "current"; }
    else {
      const labels: Record<string, string> = { idle: "not checked", no_data: "no limits", unparsed: "unreadable", unsupported: "not available", unavailable: "unavailable", needs_login: "needs login", error: "error" };
      badge.textContent = labels[view.state] ?? view.state;
    }
    badge.title = name;
    return badge;
  }

  function limitBody(view: PlanLimitsView, name: string): HTMLElement[] {
    const nodes: HTMLElement[] = [];
    const meta = (text: string): HTMLElement => make("p", "limit-meta", text);
    switch (view.state) {
      case "ok": {
        for (const entry of view.windows) {
          const item = make("div", "limit-window");
          const head = make("div", "limit-window-head");
          head.append(make("span", "", entry.label), make("span", "limit-percent", `${Math.round(entry.usedPercent * 10) / 10}% used`));
          const meter = make("div", "meter");
          const fill = make("div", `meter-fill${entry.usedPercent >= 90 ? " is-err" : entry.usedPercent >= 75 ? " is-warn" : ""}`);
          fill.style.width = `${Math.max(0, Math.min(100, entry.usedPercent))}%`;
          meter.append(fill);
          item.append(head, meter);
          const reset = entry.resetText ?? (entry.resetsAt !== undefined ? dateTime.format(entry.resetsAt) : undefined);
          if (reset) item.append(make("div", "limit-meta", `Resets ${reset}`));
          nodes.push(item);
        }
        if (view.fetchedAt !== undefined) nodes.push(meta(`Checked at ${clock.format(view.fetchedAt)}`));
        if (view.credits) nodes.push(meta(`Credits: ${view.credits}`));
        break;
      }
      case "idle": nodes.push(meta("Not checked yet.")); break;
      case "no_data":
        nodes.push(meta("The agent has no plan limits for this account (an API key login has none)."));
        if (view.plan) nodes.push(meta(`Plan: ${view.plan}`));
        break;
      case "unparsed": {
        nodes.push(meta("Could not read the agent's answer. Here it is as the agent sent it:"));
        const details = make("details");
        details.open = true;
        details.append(make("summary", "", "Answer"), make("pre", "limit-raw", view.raw ?? ""));
        nodes.push(details);
        break;
      }
      case "needs_login": {
        nodes.push(meta(view.message ?? `Log in to ${name} to see its plan limits.`));
        const open = make("button", "small link-button", `Open ${name}`);
        open.type = "button";
        open.onclick = () => showView(view.provider);
        nodes.push(open);
        break;
      }
      default: nodes.push(meta(view.message ?? (view.state === "unsupported" ? "Plan limits are not available for this provider." : "No answer."))); break;
    }
    if (view.hint) nodes.push(meta(hintLine(view.hint, name)));
    return nodes;
  }

  function renderLimits(): void {
    const byId = new Map(limits.map((entry) => [entry.provider, entry]));
    const cards = orderIds(limits.map((entry) => entry.provider)).map((id) => {
      const view = byId.get(id)!;
      const name = nameOf(id);
      const card = make("div", "limit-card");
      const head = make("div", "limit-head");
      head.append(make("strong", "", name), windowBadge(view, name));
      if (view.plan) head.append(make("span", "muted", view.plan));
      if (view.state !== "unsupported") {
        const providerState = states.get(id);
        const waiting = pending.has(id);
        const refresh = make("button", "small push", waiting ? "Checking…" : "Refresh");
        refresh.type = "button";
        refresh.disabled = waiting || (providerState !== "ready" && providerState !== "stopped");
        if (!waiting && refresh.disabled) refresh.title = "Turn the provider on, sign in and start the server first.";
        refresh.onclick = () => void refreshOne(id, true);
        head.append(refresh);
      }
      card.append(head, ...limitBody(view, name));
      return card;
    });
    el("limits-list").replaceChildren(...cards);
    const anyReady = limits.some((entry) => entry.state !== "unsupported" && states.get(entry.provider) === "ready");
    el<HTMLButtonElement>("limits-refresh-all").disabled = !anyReady || limits.some((entry) => pending.has(entry.provider));
  }

  function storeLimits(view: PlanLimitsView): void {
    const index = limits.findIndex((entry) => entry.provider === view.provider);
    if (index >= 0) limits[index] = view; else limits.push(view);
  }

  async function refreshOne(id: string, force: boolean): Promise<void> {
    if (pending.has(id)) return;
    pending.add(id);
    renderLimits();
    try {
      storeLimits(await api.refreshPlanLimits(id, force));
    } catch (error) {
      storeLimits({ provider: id, state: "error", windows: [], message: error instanceof Error ? error.message : String(error) });
    } finally {
      pending.delete(id);
      renderLimits();
    }
  }

  async function loadUsage(): Promise<void> {
    try { usage = await api.getUsage(); renderUsage(); } catch { /* the next push renders it */ }
  }

  async function loadLimits(): Promise<void> {
    try { limits = await api.getPlanLimits(); renderLimits(); } catch { /* shown as empty */ }
  }

  function confirmReset(): void {
    const dialog = el<HTMLDialogElement>("reset-usage-dialog");
    const finish = (confirmed: boolean): void => {
      el("reset-usage-confirm").onclick = null; el("reset-usage-cancel").onclick = null; dialog.oncancel = null;
      dialog.close();
      if (!confirmed) return;
      void api.resetUsage().then((result) => {
        resetError = result.ok ? "" : result.message;
        renderNote();
        if (result.ok) void loadUsage();
      }, (error: unknown) => { resetError = error instanceof Error ? error.message : String(error); renderNote(); });
    };
    el("reset-usage-confirm").onclick = () => finish(true);
    el("reset-usage-cancel").onclick = () => finish(false);
    dialog.oncancel = (event) => { event.preventDefault(); finish(false); };
    dialog.showModal();
  }

  for (const button of el("usage-range").querySelectorAll<HTMLButtonElement>("button")) {
    button.addEventListener("click", () => {
      const next = button.dataset.range as UsageRangeKey;
      if (!RANGES.includes(next)) return;
      range = next; writeStored(RANGE_KEY, range); renderControls(); renderStats(); renderTable();
    });
  }
  for (const button of el("usage-metric").querySelectorAll<HTMLButtonElement>("button")) {
    button.addEventListener("click", () => {
      metric = button.dataset.metric === "tokens" ? "tokens" : "requests";
      writeStored(METRIC_KEY, metric); renderControls(); renderChart();
    });
  }
  el("usage-reset").addEventListener("click", confirmReset);
  el("ov-usage-open").addEventListener("click", () => showView("usage"));
  el("limits-refresh-all").addEventListener("click", () => {
    for (const entry of limits) if (entry.state !== "unsupported" && states.get(entry.provider) === "ready") void refreshOne(entry.provider, true);
  });

  api.onUsage((next) => { usage = next; renderUsage(); });
  renderControls();
  void loadUsage();
  void loadLimits();

  return {
    shown(): void {
      void loadUsage();
      void api.getPlanLimits().then((current) => {
        limits = current;
        renderLimits();
        const now = Date.now();
        for (const entry of current) {
          if (entry.state === "unsupported" || states.get(entry.provider) !== "ready") continue;
          if (entry.state === "idle" || entry.fetchedAt === undefined || now - entry.fetchedAt > STALE_MS) void refreshOne(entry.provider, false);
        }
      }, () => { /* limits stay as they were */ });
    },
    setState(current: StateView): void {
      names = new Map(current.status.providers.map((entry) => [entry.id, entry.name]));
      states = new Map(current.status.providers.map((entry) => [entry.id, entry.state]));
      renderTable();
      renderChart();
      renderLimits();
    },
  };
}
