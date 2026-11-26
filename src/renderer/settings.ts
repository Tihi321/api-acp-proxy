import { nextExpiryDelay, usageLimitLine } from "./usage-limit-line.js";
import { mcpAddCommand, mcpEndpointUrl } from "./mcp-command.js";
import { initUsageView } from "./usage-view.js";
import { initLlamaView } from "./llama-view.js";
import { fields, fieldValue, type Scope } from "./settings-fields.js";
import { initMonitorView } from "./monitor-view.js";
import type { ActivityView, GufoProfileView, InstallProgressView, LocalServerId, LocalServerStatusView, ProviderStatusView, SaveResult, SettingsPatchView, StateView } from "../shared/ipc.js";

const api = window.proxyApi;
type TermsProvider = "antigravity" | "claude";
/** Terms dialog content per provider (rendered with textContent only). */
const termsText: Record<TermsProvider, { title: string; paragraphs: string[]; url: string; link: string }> = {
  antigravity: {
    title: "Before you enable Antigravity",
    paragraphs: [
      "Google's Antigravity Terms (clause 6) prohibit using third-party software to access the service. Routing an OpenAI-compatible API through Antigravity may be treated as powering a non-Antigravity product, and accounts have been suspended for this.",
      "This app uses the official Antigravity ACP server, but you use it at your own risk.",
    ],
    url: "https://antigravity.google/terms",
    link: "Read Google's Antigravity terms",
  },
  claude: {
    title: "Before you enable Claude",
    paragraphs: [
      "Using a Claude subscription through third-party tooling may conflict with Anthropic's Consumer Terms and usage policy. Routing an OpenAI-compatible API through your subscription could put your account at risk.",
      "This app uses Anthropic's official Claude Agent SDK via the ACP adapter, but you use it at your own risk.",
    ],
    url: "https://www.anthropic.com/legal/consumer-terms",
    link: "Read Anthropic's Consumer Terms",
  },
};
let termsUrl = "";

/** Shown before the provider has reported its methods (it is not running yet). */
const fallbackAuth: Record<string, Array<{ id: string; name: string }>> = {
  codex: [{ id: "chat-gpt", name: "ChatGPT account" }, { id: "api-key", name: "API key" }],
  antigravity: [{ id: "oauth-personal", name: "Log in with Google" }, { id: "oauth-business", name: "Log in with Gemini Enterprise" }, { id: "gemini-api-key", name: "Gemini API key" }, { id: "agent-platform", name: "Gemini Enterprise Agent Platform" }],
  // Subscription only by default (settings `authPolicy`): the Console (API billing) login is offered by the running provider only under "any".
  claude: [{ id: "claude-ai-login", name: "Claude subscription" }],
};
const defaultAuth: Record<string, string> = { antigravity: "oauth-personal", claude: "claude-ai-login" };

const badgeClass: Record<string, string> = {
  running: "ok", ready: "ok", starting: "info", needs_login: "warn", terms_required: "warn", not_installed: "warn", error: "err", stopped: "", disabled: "",
};
const badgeText: Record<string, string> = { needs_login: "needs login", not_installed: "not installed", terms_required: "terms required" };

/** The tool a provider's shared login folder belongs to (named in the log-out confirmation). */
const toolName: Record<string, string> = { codex: "Codex (the Codex app and CLI)", antigravity: "Google Antigravity and the Gemini tools", claude: "Claude Code" };
const providerOrder = ["codex", "claude", "antigravity"] as const;
/** The local servers that have a page; `embed` (the embedding server) is a card of the Llama.cpp page. */
type PageServerId = Exclude<LocalServerId, "embed">;
const localOrder: readonly PageServerId[] = ["gufo", "strata", "llama"];
const views = ["overview", "usage", "requests", "monitor", "about", "server", "codex", "claude", "antigravity", "gufo", "strata", "llama"] as const;
type ViewName = (typeof views)[number];
const VIEW_KEY = "acp-proxy.view";
const featureChips: Array<{ label: string; on: (status: ProviderStatusView) => boolean }> = [
  { label: "images in", on: (status) => status.capabilities?.image === true },
  { label: "image generation", on: (status) => status.features?.imageGeneration === true },
  { label: "tools", on: (status) => status.features?.tools === true },
  { label: "MCP", on: (status) => status.features?.mcp === true },
  { label: "web search", on: (status) => status.features?.webSearch === true },
];

let state: StateView | undefined;
let activity: ActivityView[] = [];
const dirty: Record<Scope, boolean> = { server: false, codex: false, antigravity: false, claude: false, gufo: false, strata: false, llama: false };
/** Launcher state of the local model servers, in the order gufo, strata, llama. */
let localServers: LocalServerStatusView[] = [];
const usage = initUsageView({ api, showView: (name) => showView(name) });
const llama = initLlamaView({
  api,
  markDirty: (value) => markDirty("llama", value),
  isDirty: () => dirty.llama,
  save: async () => { await saveScope("llama"); return !dirty.llama; },
  refresh: () => refresh(),
  setBadge,
});
const monitor = initMonitorView({ api, showView: (name) => showView(name), activity: () => activity });
const loggingIn = new Set<string>();
const loggingOut = new Set<string>();
let installing = false;

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const field = (path: string): HTMLInputElement | HTMLSelectElement => el(path);
const card = (provider: string): HTMLElement => el(`card-${provider}`);
const role = <T extends HTMLElement>(root: ParentNode, name: string): T => root.querySelector(`[data-role="${name}"]`) as T;

const navItem = (name: string): HTMLElement | null => document.querySelector<HTMLElement>(`.nav-item[data-view="${name}"]`);

/** Sets the unsaved-edits flag of a scope and its marker in the sidebar. */
function markDirty(scope: Scope, value: boolean): void {
  dirty[scope] = value;
  const item = navItem(scope);
  if (!item) return;
  item.classList.toggle("is-dirty", value);
  if (value) item.title = "Unsaved changes"; else item.removeAttribute("title");
}

/** Shows one view, marks its sidebar item and remembers the choice. */
function showView(name: string): void {
  const target: ViewName = (views as readonly string[]).includes(name) ? (name as ViewName) : "overview";
  for (const section of document.querySelectorAll<HTMLElement>("section.view")) section.hidden = section.dataset.view !== target;
  for (const item of document.querySelectorAll<HTMLElement>(".nav-item")) {
    if (item.dataset.view === target) item.setAttribute("aria-current", "page"); else item.removeAttribute("aria-current");
  }
  try { localStorage.setItem(VIEW_KEY, target); } catch { /* storage unavailable: the choice is not remembered */ }
  if (target === "usage") usage.shown();
  if (target === "llama") llama.shown();
  if (target === "monitor" || target === "about") monitor.shown(target); else monitor.hidden();
}

function storedView(): ViewName {
  try {
    const value = localStorage.getItem(VIEW_KEY);
    if (value && (views as readonly string[]).includes(value)) return value as ViewName;
  } catch { /* storage unavailable */ }
  return "overview";
}

function getPath(root: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((value, key) => (typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined), root);
}
function setPath(root: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split(".");
  let target = root;
  for (const key of keys.slice(0, -1)) target = (target[key] ??= {}) as Record<string, unknown>;
  target[keys[keys.length - 1]!] = value;
}
function setBadge(node: HTMLElement, value: string): void {
  node.className = `badge ${badgeClass[value] ?? ""}`.trim();
  node.textContent = badgeText[value] ?? value;
}
function flash(node: HTMLElement, text: string, bad = false): void {
  node.textContent = text;
  node.classList.toggle("bad", bad);
}
function showError(node: HTMLElement, text: string | undefined): void {
  node.textContent = text ?? "";
  node.hidden = !text;
}

function renderFields(scope: Scope, current: StateView): void {
  for (const spec of fields.filter((entry) => entry.scope === scope)) {
    const input = field(spec.path);
    const overridden = current.overridden.includes(spec.path);
    input.disabled = overridden;
    const note = document.querySelector<HTMLElement>(`[data-note-for="${spec.path}"]`);
    if (note) note.textContent = overridden ? "Overridden by an environment variable." : "";
    if (dirty[scope] && !overridden) continue;
    const value = getPath(overridden ? current.effective : current.settings, spec.path);
    if (spec.kind === "bool") (input as HTMLInputElement).checked = value === true;
    else if (spec.kind === "select") continue; // filled by renderAuth
    else input.value = value === undefined || value === null ? "" : String(value);
  }
}

function renderAuth(provider: string, status: ProviderStatusView | undefined, current: StateView): void {
  const select = field(`providers.${provider}.authMethodId`) as HTMLSelectElement;
  const methods = (status?.authMethods.filter((method) => method.type !== "terminal") ?? []).map((method) => ({ id: method.id, name: method.name }));
  const options = methods.length ? methods : fallbackAuth[provider] ?? [];
  const keep = dirty[provider as Scope] ? select.value : "";
  const stored = (getPath(current.effective, `providers.${provider}.authMethodId`) as string | undefined) ?? defaultAuth[provider] ?? "";
  const wanted = keep || stored;
  select.replaceChildren();
  if (!defaultAuth[provider]) select.append(new Option("Automatic", ""));
  for (const option of options) select.append(new Option(`${option.name} (${option.id})`, option.id));
  select.value = options.some((option) => option.id === wanted) || wanted === "" ? wanted : select.options[0]?.value ?? "";
}

function renderProvider(provider: string, current: StateView): void {
  const root = card(provider);
  const status = current.status.providers.find((entry) => entry.id === provider);
  const providerState = status?.state ?? "disabled";
  setBadge(role(root, "badge"), providerState);
  role(root, "version").textContent = status?.agentVersion ? `v${status.agentVersion}` : "";
  showError(role(root, "error"), providerState === "error" || status?.error ? status?.error : undefined);
  const limitLine = usageLimitLine(status?.exhaustedUntil, Date.now());
  const limitNode = role(root, "usage-limit");
  limitNode.textContent = limitLine ?? ""; limitNode.hidden = !limitLine;
  renderFields(provider as Scope, current);
  renderAuth(provider, status, current);

  const login = role<HTMLButtonElement>(root, "login");
  const unavailable = ["disabled", "not_installed", "terms_required"].includes(providerState) || current.status.server.state !== "running";
  const signedIn = !unavailable && isSignedIn(status);
  login.disabled = unavailable || signedIn || loggingIn.has(provider);
  login.textContent = loginLabel(provider, signedIn);
  login.title = unavailable ? "Enable and save the provider (and start the server) first." : signedIn ? SIGNED_IN_HINT : "";

  const accountNode = root.querySelector<HTMLElement>('[data-role="account"]');
  if (accountNode) { accountNode.textContent = status?.account ? `Signed in as ${status.account}` : ""; accountNode.hidden = !status?.account; }

  const link = role<HTMLElement>(root, "login-link");
  const url = status?.loginUrl;
  link.hidden = !url;
  const anchor = role<HTMLAnchorElement>(root, "login-url");
  anchor.textContent = url ?? "";
  anchor.dataset.url = url ?? "";

  const models = status?.models ?? [];
  role(root, "model-count").textContent = models.length ? `(${models.length})` : "";
  const list = role<HTMLElement>(root, "models");
  list.replaceChildren(...(models.length ? models.map((model) => Object.assign(document.createElement("li"), { textContent: model.id, title: model.name ?? "" })) : [Object.assign(document.createElement("li"), { className: "empty", textContent: providerState === "ready" || providerState === "needs_login" ? "No models discovered yet." : "No models (provider not running)." })]));
}

/** Fields, provider badge and models of a local model server page (no login or terms parts). */
function renderLocal(id: PageServerId, current: StateView): void {
  const root = card(id);
  if (id === "gufo" && !dirty.gufo) {
    const gufo = current.settings.providers.gufo;
    gufoDraft = gufo.profiles.map((profile) => ({ ...profile }));
    el<HTMLInputElement>("gufo-switch-wait").value = String(Math.round(gufo.switchWaitMs / 60000));
    renderProfiles();
  }
  if (id === "llama" && !dirty.llama) llama.load(current.settings.providers.llama);
  const status = current.status.providers.find((entry) => entry.id === id);
  const providerState = status?.state ?? "disabled";
  setBadge(role(root, "badge"), providerState);
  renderFields(id, current);
  const models = status?.models ?? [];
  role(root, "model-count").textContent = models.length ? `(${models.length})` : "";
  const list = role<HTMLElement>(root, "models");
  list.replaceChildren(...(models.length ? models.map((model) => Object.assign(document.createElement("li"), { textContent: model.id, title: model.name ?? "" })) : [Object.assign(document.createElement("li"), { className: "empty", textContent: providerState === "ready" ? "No models discovered yet." : "No models (server not running)." })]));
}

const LOG_LINES_SHOWN = 50;
const timeOfDay = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** Launcher badge, Start/Stop, error, process info and log of both local model servers. */
function renderLocalServers(list: LocalServerStatusView[]): void {
  localServers = list;
  for (const server of list) {
    if (server.id === "embed") { llama.setEmbedLauncher(server); continue; }
    const root = card(server.id);
    setBadge(role(root, "server-badge"), server.state);
    const startButton = root.querySelector<HTMLButtonElement>('[data-role="start"]');
    if (startButton) startButton.disabled = server.state === "starting" || server.state === "ready";
    if (server.id === "gufo") {
      const label = server.profile ? gufoDraft.find((profile) => profile.id === server.profile)?.label ?? server.profile : undefined;
      if (label && server.state !== "stopped") role<HTMLElement>(root, "server-badge").textContent = server.state === "ready" ? `Gufo: ${label}` : `Gufo: ${label} (${server.state})`;
      updateProfileButtons();
    }
    if (server.id === "llama") {
      const label = server.profile ? state?.settings.providers.llama.profiles.find((profile) => profile.id === server.profile)?.label ?? server.profile : undefined;
      if (label && server.state !== "stopped") role<HTMLElement>(root, "server-badge").textContent = server.state === "ready" ? `Llama.cpp: ${label}` : `Llama.cpp: ${label} (${server.state})`;
      llama.setLauncher(server);
    }
    role<HTMLButtonElement>(root, "stop").disabled = server.state === "stopped";
    showError(role(root, "error"), server.state === "error" ? server.error : undefined);
    const info = [
      server.pid !== undefined ? `pid ${server.pid}` : "",
      server.port !== undefined ? `port ${server.port}` : "",
      server.readyAt !== undefined ? `ready ${timeOfDay.format(server.readyAt)}` : "",
    ].filter(Boolean).join(" · ");
    role(root, "server-info").textContent = server.commandLine ? `${info ? `${info} · ` : ""}${server.commandLine}` : info;
    const log = role<HTMLElement>(root, "log");
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 24;
    log.textContent = server.log.slice(-LOG_LINES_SHOWN).join("\n");
    if (atBottom) log.scrollTop = log.scrollHeight;
  }
  for (const id of localOrder) setNavDot(id, localDotState(id));
}

/** The profiles being edited on the Gufo page (a copy of the saved ones until the user saves). */
let gufoDraft: GufoProfileView[] = [];
/** Profiles whose Start/Switch request is still waiting for the coordinator (a switch can queue or take minutes). */
const startingProfiles = new Set<string>();

const minutesText = (ms: number | undefined): string => ms === undefined ? "" : String(Math.round(ms / 6000) / 10);

function profileField(labelText: string, input: HTMLElement): HTMLLabelElement {
  const label = make("label", "field");
  label.append(make("span", "", labelText), input);
  return label;
}

function profileCard(profile: GufoProfileView, index: number): HTMLElement {
  const root = make("div", "profile");
  root.dataset.index = String(index);
  const edited = (apply: (value: string) => void) => (event: Event): void => { apply((event.currentTarget as HTMLInputElement).value); markDirty("gufo", true); };
  const text = (value: string, apply: (value: string) => void): HTMLInputElement => {
    const input = make("input"); input.type = "text"; input.autocomplete = "off"; input.spellcheck = false; input.value = value;
    input.addEventListener("input", edited(apply));
    return input;
  };
  const minutes = (value: number | undefined, apply: (ms: number | undefined) => void): HTMLInputElement => {
    const input = make("input"); input.type = "number"; input.min = "0"; input.step = "any"; input.value = minutesText(value);
    input.addEventListener("input", edited((raw) => { const number = Number(raw); apply(raw.trim() === "" || !Number.isFinite(number) || number <= 0 ? undefined : Math.round(number * 60000)); }));
    return input;
  };

  const head = make("div", "profile-head");
  head.append(make("strong", "", profile.label || profile.id || "(new profile)"));
  const badge = make("span", "badge"); badge.dataset.role = "profile-badge";
  const start = make("button", "primary small", "Start"); start.type = "button"; start.dataset.role = "profile-start";
  start.onclick = () => void startGufoProfile(profile.id);
  const remove = make("button", "small", "Remove"); remove.type = "button";
  remove.onclick = () => { gufoDraft.splice(index, 1); markDirty("gufo", true); renderProfiles(); };
  head.append(badge, start, remove);

  const kind = make("select");
  for (const value of ["llm", "image"] as const) kind.append(Object.assign(document.createElement("option"), { value, textContent: value === "llm" ? "Chat (llm)" : "Image" }));
  kind.value = profile.kind;
  const vision = make("input"); vision.type = "checkbox"; vision.checked = profile.vision; vision.disabled = profile.kind === "image";
  vision.addEventListener("change", () => { profile.vision = vision.checked; markDirty("gufo", true); });
  kind.addEventListener("change", () => { profile.kind = kind.value as GufoProfileView["kind"]; if (profile.kind === "image") profile.vision = false; markDirty("gufo", true); renderProfiles(); });
  const visionLabel = make("label", "switch"); visionLabel.append(vision, make("span", "", "Accepts images (vision)"));

  const args = make("textarea"); args.rows = 3; args.spellcheck = false; args.value = profile.args;
  args.addEventListener("input", edited((value) => { profile.args = value; }));

  const grid = make("div", "grid");
  grid.append(
    profileField("Label", text(profile.label, (value) => { profile.label = value; })),
    profileField("Profile id (a-z, 0-9, . _ -)", text(profile.id, (value) => { profile.id = value; })),
    profileField("Model id (exposed as gufo/<model>)", text(profile.model, (value) => { profile.model = value; })),
    profileField("Kind", kind),
    profileField("Start timeout (minutes, empty = 30)", minutes(profile.startTimeoutMs, (ms) => { profile.startTimeoutMs = ms; })),
    profileField(`Request timeout (minutes, empty = ${profile.kind === "image" ? "15" : "server default"})`, minutes(profile.requestTimeoutMs, (ms) => { profile.requestTimeoutMs = ms; })),
  );
  const argsField = profileField("Arguments", args);
  argsField.classList.add("wide");
  root.append(head, grid, visionLabel, argsField);
  return root;
}

function renderProfiles(): void {
  const host = el("gufo-profiles");
  host.replaceChildren(...(gufoDraft.length ? gufoDraft.map(profileCard) : [make("p", "note", "No profiles. Add one or restore the presets.")]));
  updateProfileButtons();
}

/** Start / Switch buttons and the running marker of each profile card, from the launcher state. */
function updateProfileButtons(): void {
  const server = localServers.find((entry) => entry.id === "gufo");
  const anyRunning = server !== undefined && (server.state === "starting" || server.state === "ready");
  for (const node of document.querySelectorAll<HTMLElement>("#gufo-profiles .profile")) {
    const profile = gufoDraft[Number(node.dataset.index)];
    if (!profile) continue;
    const mine = server !== undefined && server.profile === profile.id && anyRunning;
    const waiting = startingProfiles.has(profile.id);
    const start = role<HTMLButtonElement>(node, "profile-start");
    start.disabled = mine || waiting;
    start.textContent = waiting && !mine ? "Waiting…" : anyRunning && !mine ? "Switch to this" : "Start";
    const badge = role<HTMLElement>(node, "profile-badge");
    badge.hidden = !mine;
    if (mine && server) setBadge(badge, server.state);
  }
}

/** Starts or switches to a Gufo profile through the coordinator; unsaved edits are saved first. */
async function startGufoProfile(profileId: string): Promise<void> {
  const msg = role<HTMLElement>(card("gufo"), "msg");
  flash(msg, "");
  if (dirty.gufo) {
    await saveScope("gufo");
    if (dirty.gufo) return; // the save failed; its message is shown
  }
  startingProfiles.add(profileId);
  updateProfileButtons();
  flash(msg, "Starting or switching… a large model can take many minutes.");
  try {
    const result = await api.startLocalServer("gufo", profileId);
    flash(msg, result.ok ? "" : result.message, !result.ok);
  } finally { startingProfiles.delete(profileId); updateProfileButtons(); }
}

/** The provider state of a local server, overridden by the launcher while it starts or failed. */
function localDotState(id: PageServerId): string {
  const launcher = localServers.find((entry) => entry.id === id)?.state;
  if (launcher === "starting" || launcher === "error") return launcher;
  return state?.status.providers.find((entry) => entry.id === id)?.state ?? "disabled";
}

/** Starts a local server; unsaved edits of its page are saved first so the launcher reads them. */
async function startLocal(id: PageServerId): Promise<void> {
  const msg = role<HTMLElement>(card(id), "msg");
  flash(msg, "");
  if (dirty[id]) {
    await saveScope(id);
    if (dirty[id]) return; // the save failed; its message is shown
  }
  const result = await api.startLocalServer(id);
  if (!result.ok) flash(msg, result.message, true);
}

async function stopLocal(id: PageServerId): Promise<void> {
  const result = await api.stopLocalServer(id);
  if (!result.ok) flash(role<HTMLElement>(card(id), "msg"), result.message, true);
}

const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] => { const node = document.createElement(tag); if (className) node.className = className; if (text) node.textContent = text; return node; };

/** The agent is up and signed in (it answered `initialize` and did not ask for a login). */
const isSignedIn = (status: ProviderStatusView | undefined): boolean => status?.state === "ready";
const SIGNED_IN_HINT = "Already signed in. Log out first to sign in with another account or method.";
/** "Logged in" while signed in, so the button does not look like a login is still needed. */
const loginLabel = (provider: string, signedIn: boolean): string => loggingIn.has(provider) ? "Waiting for login…" : signedIn ? "Logged in" : "Log in";

/** Whether Log in / Log out can do anything now: the provider is on and usable, and the server runs. */
const providerUsable = (status: ProviderStatusView | undefined, current: StateView): boolean => !["disabled", "not_installed", "terms_required"].includes(status?.state ?? "disabled") && current.status.server.state === "running";

/** The short line under a provider's name in the overview. */
function describeSignIn(status: ProviderStatusView | undefined, current: StateView): string {
  if (!status || status.state === "disabled") return "Off. Turn it on on its page.";
  if (current.status.server.state !== "running") return "The server is not running.";
  if (status.state === "needs_login") return status.error ?? "Not signed in.";
  if (status.state === "error" || status.state === "not_installed" || status.state === "terms_required") return status.error ?? "";
  if (status.account) return `Signed in as ${status.account}`;
  if (status.state === "stopped") return "Starts on the first request.";
  if (status.state === "starting") return "Starting…";
  return "Ready.";
}

function renderOverview(current: StateView): void {
  const server = current.status.server;
  el("ov-url").textContent = server.baseUrl ?? (server.state === "error" ? "Not listening" : "Not running");
  el("ov-copy").hidden = !server.baseUrl;
  el("ov-playground").hidden = !server.baseUrl;
  el("ov-mcp-url").textContent = server.baseUrl ? mcpEndpointUrl(server.baseUrl) : server.state === "error" ? "Not listening" : "Not running";
  el("ov-mcp-copy").hidden = !server.baseUrl;
  const rows = providerOrder.map((id) => {
    const status = current.status.providers.find((entry) => entry.id === id);
    const usable = providerUsable(status, current);
    const row = make("li", "ov-row");
    const head = make("div", "ov-head");
    head.append(make("strong", "", status?.name ?? id));
    const badge = make("span", "badge");
    setBadge(badge, status?.state ?? "disabled");
    head.append(badge);
    if (status?.agentVersion) head.append(make("span", "muted mono", `v${status.agentVersion}`));
    const actions = make("div", "ov-actions");
    const signedIn = usable && isSignedIn(status);
    const login = make("button", "small", loginLabel(id, signedIn));
    login.type = "button";
    login.disabled = !usable || signedIn || loggingIn.has(id) || loggingOut.has(id);
    login.title = !usable ? "Enable and save the provider (and start the server) first." : signedIn ? SIGNED_IN_HINT : "Sign in with the method picked on its page.";
    login.onclick = () => void startLogin(id);
    const logout = make("button", "small", loggingOut.has(id) ? "Logging out…" : "Log out");
    logout.type = "button";
    logout.disabled = !usable || status?.state === "needs_login" || loggingOut.has(id) || loggingIn.has(id);
    logout.title = status?.state === "needs_login" ? "Not signed in." : "";
    logout.onclick = () => void startLogout(id);
    const settingsButton = make("button", "small", "Settings");
    settingsButton.type = "button";
    settingsButton.title = `Open the ${status?.name ?? id} page`;
    settingsButton.onclick = () => showView(id);
    actions.append(login, logout, settingsButton);
    head.append(actions);
    row.append(head, make("p", "ov-line muted", describeSignIn(status, current)));
    const limitLine = usageLimitLine(status?.exhaustedUntil, Date.now());
    if (limitLine) row.append(make("p", "ov-line usage-limit", limitLine));
    const chips = make("ul", "chips");
    const count = status?.models.length ?? 0;
    if (status && usable) for (const chip of featureChips) if (chip.on(status)) chips.append(make("li", "", chip.label));
    if (count) chips.append(make("li", "count", `${count} model${count === 1 ? "" : "s"}`));
    if (chips.childElementCount) row.append(chips);
    if (status?.loginHome) row.append(make("p", "ov-home muted small-text", `Login kept in ${status.loginHome.path}${status.loginHome.shared ? " (your own folder, shared with the tool)" : ""}`));
    return row;
  });
  el("ov-providers").replaceChildren(...rows);
  const servers = current.mcpServers;
  el("ov-mcp-count").textContent = servers.length ? `(${servers.length})` : "";
  el("ov-mcp").replaceChildren(...(servers.length ? servers.map((entry) => {
    const item = make("li", "ov-mcp-item");
    item.append(make("strong", "", entry.label), make("span", "badge", entry.transport), make("span", "mono muted", entry.target));
    return item;
  }) : [make("li", "muted", "None configured.")]));
  el("codex-home-path").textContent = current.codexHome.path + (current.codexHome.isolated ? "" : " (your own folder)");
}

const clock = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const ENDPOINT_LABELS: Record<string, string> = { "GET /v1/models": "models", "POST /v1/chat/completions": "chat", "POST /v1/responses": "responses", "POST /v1/images/generations": "images", "MCP ask_model": "MCP ask", "MCP generate_image": "MCP image" };
const FEATURE_LABELS: Record<string, string> = { images: "image in", imageGeneration: "image out", tools: "tools", mcp: "MCP", search: "search" };

function renderActivity(): void {
  const shown = activity.slice(0, 20);
  el("act-empty").hidden = shown.length > 0;
  el("act-table").hidden = shown.length === 0;
  el<HTMLButtonElement>("act-clear").disabled = shown.length === 0;
  el("act-summary").textContent = shown.length ? `last ${shown.length}` : "";
  el("act-body").replaceChildren(...shown.map((entry) => {
    const row = make("tr");
    const bad = entry.status >= 400 || entry.error !== undefined;
    const cell = (text: string, className = ""): HTMLTableCellElement => make("td", className, text);
    const hasTokens = entry.inputTokens !== undefined || entry.outputTokens !== undefined;
    const tokenCell = cell(hasTokens ? `${entry.estimated ? "≈ " : ""}${entry.inputTokens ?? 0} in / ${entry.outputTokens ?? 0} out${entry.reasoningTokens !== undefined ? ` (${entry.reasoningEstimated && !entry.estimated ? "≈ " : ""}${entry.reasoningTokens} thinking)` : ""}` : "-", "num");
    if (hasTokens && entry.estimated) tokenCell.title = "Estimated: about 4 characters per token";
    row.append(
      cell(clock.format(entry.time), "mono"),
      cell(`${ENDPOINT_LABELS[entry.endpoint] ?? entry.endpoint}${entry.stream ? " (stream)" : ""}`),
      cell(entry.model ?? "-", "mono"),
      cell([...entry.features.map((feature) => FEATURE_LABELS[feature] ?? feature), ...(entry.ignoredParams?.length ? [`ignored: ${entry.ignoredParams.join(", ")}`] : [])].join(", ") || "-"),
      cell(entry.durationMs >= 1000 ? `${(entry.durationMs / 1000).toFixed(1)} s` : `${entry.durationMs} ms`, "num"),
      cell(entry.error ? `${entry.status} ${entry.error}` : String(entry.status), bad ? "bad" : "ok"),
      tokenCell,
    );
    return row;
  }));
}

function renderInstall(current: StateView): void {
  const info = current.antigravityInstall;
  el("install-info").textContent = info
    ? `Installed ${info.version} · sha256 ${info.sha256} · signature: ${info.signature ? `${info.signature.status}${info.signature.signer ? ` (${info.signature.signer})` : ""}` : "not checked"}\n${info.command}`
    : "No downloaded agent yet.";
  el<HTMLButtonElement>("install-agy").disabled = installing;
  el<HTMLButtonElement>("install-agy").textContent = info ? "Re-download from registry" : "Download from registry";
}

/** One timer: re-reads the state just after the earliest reset time, so the line goes away with the window left open (the controller forgets the mark on that read). */
let expiryTimer: ReturnType<typeof setTimeout> | undefined;

function render(current: StateView): void {
  state = current;
  if (expiryTimer !== undefined) clearTimeout(expiryTimer);
  const delay = nextExpiryDelay(current.status.providers, Date.now());
  expiryTimer = delay === undefined ? undefined : setTimeout(() => void refresh(), delay + 1000);
  const server = current.status.server;
  setBadge(el("server-badge"), server.state);
  setBadge(el("top-badge"), server.state);
  el("top-url").textContent = server.baseUrl ?? ""; el("top-url").title = server.baseUrl ?? "";
  el("server-url").textContent = server.baseUrl ?? (server.state === "error" ? "Not listening" : "Not running");
  el("copy-url").hidden = !server.baseUrl;
  const error = server.error ? (server.error.code === "EADDRINUSE" ? `Port ${server.port} is already in use. Pick another port or stop the other program.` : server.error.message) : undefined;
  showError(el("server-error"), server.state === "error" ? error : undefined);
  const active = server.state === "running" || server.state === "starting";
  el("server-toggle").textContent = active ? "Stop" : server.state === "error" ? "Retry" : "Start";
  renderFields("server", current);
  renderProvider("codex", current);
  renderProvider("claude", current);
  renderProvider("antigravity", current);
  for (const id of localOrder) renderLocal(id, current);
  renderOverview(current);
  renderInstall(current);
  el("settings-path").textContent = current.settingsPath;
  el("secrets-note").textContent = current.secretsEncrypted ? "Secrets are encrypted with the OS keychain." : "OS secret storage unavailable: secrets are stored as plain text.";
  el("settings-path").title = current.settingsPath;
  setNavDot("server", server.state);
  for (const id of providerOrder) setNavDot(id, current.status.providers.find((entry) => entry.id === id)?.state ?? "disabled");
  for (const id of localOrder) setNavDot(id, localDotState(id));
  usage.setState(current);
}

/** Colors a sidebar item's status dot like the badge of the same state. */
function setNavDot(name: string, value: string): void {
  const dot = navItem(name)?.querySelector<HTMLElement>('[data-role="nav-dot"]');
  if (dot) dot.className = `nav-dot ${badgeClass[value] ?? ""}`.trim();
}

async function refresh(): Promise<void> { render(await api.getState()); }

/** Signs a provider in with the method picked in its card; progress shows on the overview and on the card. */
async function startLogin(provider: string): Promise<void> {
  const msg = role<HTMLElement>(card(provider), "msg");
  loggingIn.add(provider); flash(msg, provider === "claude" ? "Complete the login in the console window…" : ""); flash(el("ov-msg"), "");
  if (state) render(state);
  try {
    const methodId = (field(`providers.${provider}.authMethodId`) as HTMLSelectElement).value || undefined;
    const result = await api.login(provider, methodId);
    flash(msg, result.ok ? "Signed in." : result.message, !result.ok);
    flash(el("ov-msg"), result.ok ? `Signed in to ${state?.status.providers.find((entry) => entry.id === provider)?.name ?? provider}.` : result.message, !result.ok);
  } finally { loggingIn.delete(provider); await refresh(); }
}

/** What a log-out does, in words, for the confirmation. */
function logoutText(provider: string, status: ProviderStatusView | undefined): { title: string; paragraphs: string[] } {
  const name = status?.name ?? provider;
  const home = status?.loginHome;
  const paragraphs: string[] = [];
  if (home?.shared) paragraphs.push(`This signs you out of ${toolName[provider] ?? name} on this computer, not only in the proxy: the proxy uses the login that tool keeps in ${home.path}.`);
  else paragraphs.push(`This removes the login the proxy keeps for ${name}${home ? ` in ${home.path}` : ""}. A login you made yourself in ${name} elsewhere is not touched.`);
  paragraphs.push("Kept and warm agent sessions are dropped, and requests to this provider fail with a login error until you log in again.");
  if (provider !== "codex") paragraphs.push("An API key or token saved in these settings stays.");
  return { title: `Log out of ${name}?`, paragraphs };
}

function confirmLogout(provider: string, status: ProviderStatusView | undefined): Promise<boolean> {
  const dialog = el<HTMLDialogElement>("logout-dialog");
  const text = logoutText(provider, status);
  el("logout-title").textContent = text.title;
  el("logout-body").replaceChildren(...text.paragraphs.map((paragraph) => Object.assign(document.createElement("p"), { textContent: paragraph })));
  return new Promise((resolve) => {
    const finish = (confirmed: boolean): void => { el("logout-confirm").onclick = null; el("logout-cancel").onclick = null; dialog.oncancel = null; dialog.close(); resolve(confirmed); };
    el("logout-confirm").onclick = () => finish(true);
    el("logout-cancel").onclick = () => finish(false);
    dialog.oncancel = (event) => { event.preventDefault(); finish(false); };
    dialog.showModal();
  });
}

async function startLogout(provider: string): Promise<void> {
  const status = state?.status.providers.find((entry) => entry.id === provider);
  if (!await confirmLogout(provider, status)) return;
  const msg = role<HTMLElement>(card(provider), "msg");
  loggingOut.add(provider); flash(msg, ""); flash(el("ov-msg"), "");
  if (state) render(state);
  try {
    const result = await api.logout(provider);
    flash(msg, result.ok ? "Logged out." : result.message, !result.ok);
    flash(el("ov-msg"), result.ok ? `Logged out of ${status?.name ?? provider}.` : result.message, !result.ok);
  } finally { loggingOut.delete(provider); await refresh(); }
}

function collectPatch(scope: Scope): { patch?: SettingsPatchView; errors: Array<{ path: string; message: string }> } {
  const patch: Record<string, unknown> = {};
  const errors: Array<{ path: string; message: string }> = [];
  for (const spec of fields.filter((entry) => entry.scope === scope)) {
    if (state?.overridden.includes(spec.path)) continue;
    const input = field(spec.path);
    if (spec.kind === "bool") { setPath(patch, spec.path, (input as HTMLInputElement).checked); continue; }
    const result = fieldValue(spec, input.value);
    if ("error" in result) { errors.push({ path: spec.path, message: result.error }); continue; }
    setPath(patch, spec.path, result.value);
  }
  if (scope === "gufo") {
    const wait = el<HTMLInputElement>("gufo-switch-wait");
    const waitMinutes = Number(wait.value);
    if (wait.value.trim() === "" || !Number.isFinite(waitMinutes) || waitMinutes <= 0) errors.push({ path: "providers.gufo.switchWaitMs", message: "Enter the wait in minutes" });
    else setPath(patch, "providers.gufo.switchWaitMs", Math.round(waitMinutes * 60000));
    setPath(patch, "providers.gufo.profiles", gufoDraft.map((profile) => ({ ...profile, label: profile.label.trim(), id: profile.id.trim(), model: profile.model.trim(), vision: profile.kind === "llm" && profile.vision })));
  }
  if (scope === "llama") {
    const collected = llama.collect();
    errors.push(...collected.errors);
    if (collected.switchWaitMs !== undefined) setPath(patch, "providers.llama.switchWaitMs", collected.switchWaitMs);
    // `binary` and `profiles` are replaced as whole values.
    setPath(patch, "providers.llama.binary", collected.binary);
    setPath(patch, "providers.llama.profiles", collected.profiles);
    setPath(patch, "providers.llama.flagPresets", collected.flagPresets);
    setPath(patch, "providers.llama.embedding.modelFile", collected.embeddingModelFile);
  }
  return { patch: patch as SettingsPatchView, errors };
}

function showErrors(scope: Scope, errors: Array<{ path: string; message: string }>): void {
  const root = scope === "server" ? card("server") : card(scope);
  for (const node of root.querySelectorAll<HTMLElement>("[data-error-for]")) node.textContent = "";
  const general: string[] = [];
  for (const error of errors) {
    const node = root.querySelector<HTMLElement>(`[data-error-for="${error.path}"]`);
    if (node) node.textContent = error.message; else general.push(error.path ? `${error.path}: ${error.message}` : error.message);
  }
  if (scope === "llama") llama.revealErrors(errors);
  showError(scope === "server" ? el("server-general-error") : role(root, "general-error"), general.join("\n") || undefined);
}

async function saveScope(scope: Scope): Promise<void> {
  const root = scope === "server" ? card("server") : card(scope);
  const msg = scope === "server" ? el("server-msg") : role<HTMLElement>(root, "msg");
  const button = scope === "server" ? el<HTMLButtonElement>("server-save") : role<HTMLButtonElement>(root, "save");
  flash(msg, "");
  if (scope === "antigravity" || scope === "claude") {
    const enabled = field(`providers.${scope}.enabled`) as HTMLInputElement;
    if (enabled.checked && !await ensureTerms(scope)) { enabled.checked = false; return; }
  }
  const { patch, errors } = collectPatch(scope);
  showErrors(scope, errors);
  if (errors.length || !patch) return;
  button.disabled = true;
  try {
    const result: SaveResult = await api.saveSettings(patch);
    if (result.ok) { markDirty(scope, false); flash(msg, "Saved. The server was restarted."); await refresh(); }
    else { showErrors(scope, result.errors); flash(msg, "Could not save.", true); }
  } catch (error) { flash(msg, error instanceof Error ? error.message : String(error), true); }
  finally { button.disabled = false; }
}

// Terms modal
function ensureTerms(provider: TermsProvider): Promise<boolean> {
  if (state?.effective.providers[provider].termsAcknowledgedAt) return Promise.resolve(true);
  const dialog = el<HTMLDialogElement>("terms-dialog");
  const text = termsText[provider];
  el("terms-title").textContent = text.title;
  el("terms-body").replaceChildren(...text.paragraphs.map((paragraph) => Object.assign(document.createElement("p"), { textContent: paragraph })));
  el("terms-link").textContent = text.link;
  termsUrl = text.url;
  return new Promise((resolve) => {
    const finish = (accepted: boolean): void => {
      el("terms-accept").onclick = null; el("terms-cancel").onclick = null; dialog.oncancel = null;
      dialog.close();
      resolve(accepted);
    };
    el("terms-accept").onclick = () => {
      void api.acknowledgeTerms(provider).then(async (result) => {
        if (!result.ok) { flash(role(card(provider), "msg"), result.message, true); finish(false); return; }
        await refresh();
        finish(true);
      });
    };
    el("terms-cancel").onclick = () => finish(false);
    dialog.oncancel = (event) => { event.preventDefault(); finish(false); };
    dialog.showModal();
  });
}

async function openExternal(url: string, msg?: HTMLElement): Promise<void> {
  const result = await api.openExternal(url);
  if (!result.ok && msg) flash(msg, result.message, true);
}

function wire(): void {
  // Dirty tracking: any edit inside a card marks that card unsaved so state pushes do not overwrite it.
  for (const spec of fields) field(spec.path).addEventListener("input", () => markDirty(spec.scope, true));
  for (const spec of fields) field(spec.path).addEventListener("change", () => markDirty(spec.scope, true));
  for (const item of document.querySelectorAll<HTMLElement>(".nav-item")) item.addEventListener("click", () => showView(item.dataset.view ?? "overview"));

  el("server-save").onclick = () => void saveScope("server");
  el("server-toggle").onclick = async () => {
    const text = el("server-toggle").textContent;
    const result = text === "Stop" ? await api.stopServer() : await api.startServer();
    if (!result.ok) flash(el("server-msg"), result.message, true);
  };
  el("copy-url").onclick = () => { const url = state?.status.server.baseUrl; if (url) void api.copyText(url).then(() => { el("copy-url").textContent = "Copied"; setTimeout(() => { el("copy-url").textContent = "Copy"; }, 1200); }); };
  el("server-key-show").onclick = () => {
    const input = field("server.apiKey") as HTMLInputElement;
    input.type = input.type === "password" ? "text" : "password";
    el("server-key-show").textContent = input.type === "password" ? "Show" : "Hide";
  };
  el("server-key-gen").onclick = () => {
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    const key = `sk-acp-${btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
    const input = field("server.apiKey") as HTMLInputElement;
    input.value = key; input.type = "text"; el("server-key-show").textContent = "Hide";
    markDirty("server", true);
  };
  el("agy-key-show").onclick = () => {
    const input = field("providers.antigravity.apiKey") as HTMLInputElement;
    input.type = input.type === "password" ? "text" : "password";
    el("agy-key-show").textContent = input.type === "password" ? "Show" : "Hide";
  };
  el("claude-key-show").onclick = () => {
    const input = field("providers.claude.apiKey") as HTMLInputElement;
    input.type = input.type === "password" ? "text" : "password";
    el("claude-key-show").textContent = input.type === "password" ? "Show" : "Hide";
  };
  el("claude-token-show").onclick = () => {
    const input = field("providers.claude.oauthToken") as HTMLInputElement;
    input.type = input.type === "password" ? "text" : "password";
    el("claude-token-show").textContent = input.type === "password" ? "Show" : "Hide";
  };
  el("open-logs").onclick = () => void api.openLogs();
  el("ov-playground").onclick = () => void api.openPlayground().then((result) => { if (result.ok) return; const button = el("ov-playground"); button.textContent = "Could not open"; button.title = result.message; setTimeout(() => { button.textContent = "Open playground"; }, 2000); });
  el("ov-copy").onclick = () => { const url = state?.status.server.baseUrl; if (url) void api.copyText(url).then(() => { el("ov-copy").textContent = "Copied"; setTimeout(() => { el("ov-copy").textContent = "Copy"; }, 1200); }); };
  el("ov-mcp-copy").onclick = () => { const url = state?.status.server.baseUrl; if (url) void api.copyText(mcpAddCommand(url, Boolean(state?.effective.server.apiKey))).then(() => { el("ov-mcp-copy").textContent = "Copied"; setTimeout(() => { el("ov-mcp-copy").textContent = "Copy command"; }, 1200); }); };
  el("open-settings-file").onclick = async () => { const result = await api.openPath("settingsFile"); if (!result.ok) flash(el("ov-msg"), result.message, true); };
  el("open-codex-home").onclick = async () => { const result = await api.openPath("codexHome"); if (!result.ok) flash(role(card("codex"), "msg"), result.message, true); };
  el("act-clear").onclick = () => void api.clearActivity().then(() => { activity = []; renderActivity(); });
  el("terms-link").onclick = (event) => { event.preventDefault(); if (termsUrl) void openExternal(termsUrl); };

  for (const provider of ["codex", "antigravity", "claude"] as const) {
    const root = card(provider);
    const msg = role<HTMLElement>(root, "msg");
    role(root, "save").onclick = () => void saveScope(provider);
    role(root, "refresh").onclick = async () => {
      const result = await api.refreshModels(provider);
      if (!result.ok) flash(msg, result.message, true);
    };
    role(root, "login").onclick = () => void startLogin(provider);
    role(root, "login-url").onclick = (event) => { event.preventDefault(); const url = (event.currentTarget as HTMLElement).dataset.url; if (url) void openExternal(url, msg); };
    role(root, "copy-login").onclick = () => { const url = role<HTMLElement>(root, "login-url").dataset.url; if (url) void api.copyText(url).then(() => flash(msg, "Link copied.")); };
  }

  for (const provider of ["antigravity", "claude"] as const) {
    (field(`providers.${provider}.enabled`) as HTMLInputElement).addEventListener("change", async (event) => {
      const input = event.currentTarget as HTMLInputElement;
      if (input.checked && !await ensureTerms(provider)) input.checked = false;
    });
  }

  for (const id of localOrder) {
    const root = card(id);
    const msg = role<HTMLElement>(root, "msg");
    role(root, "save").onclick = () => void saveScope(id);
    role(root, "refresh").onclick = async () => {
      const result = await api.refreshModels(id);
      if (!result.ok) flash(msg, result.message, true);
    };
    const startButton = root.querySelector<HTMLButtonElement>('[data-role="start"]');
    if (startButton) startButton.onclick = () => void startLocal(id);
    role(root, "stop").onclick = () => void stopLocal(id);
    if (id === "llama") continue; // no API key; its token button is wired by llama-view
    el(`${id}-key-show`).onclick = () => {
      const input = field(`providers.${id}.apiKey`) as HTMLInputElement;
      input.type = input.type === "password" ? "text" : "password";
      el(`${id}-key-show`).textContent = input.type === "password" ? "Show" : "Hide";
    };
  }

  el("gufo-switch-wait").addEventListener("input", () => markDirty("gufo", true));
  el("gufo-add-profile").onclick = () => {
    const taken = new Set(gufoDraft.map((profile) => profile.id));
    let n = gufoDraft.length + 1;
    while (taken.has(`profile-${n}`)) n++;
    gufoDraft.push({ id: `profile-${n}`, label: `Profile ${n}`, model: `profile-${n}`, kind: "llm", vision: false, args: "serve llm --model <id> --port {port}" });
    markDirty("gufo", true);
    renderProfiles();
  };
  el("gufo-restore-presets").onclick = async () => {
    const restored = await api.restoreGufoPresets(gufoDraft);
    const added = restored.length - gufoDraft.length;
    gufoDraft = restored;
    if (added > 0) markDirty("gufo", true);
    renderProfiles();
    flash(el("gufo-profiles-msg"), added > 0 ? `Added ${added} preset${added === 1 ? "" : "s"}. Save to keep them.` : "All presets are present.");
  };
  el("browse-exe").onclick = async () => {
    const result = await api.pickExecutable();
    if (result.path) { (field("providers.antigravity.executablePath") as HTMLInputElement).value = result.path; markDirty("antigravity", true); }
  };
  el("browse-claude-exe").onclick = async () => {
    const result = await api.pickExecutable();
    if (result.path) { (field("providers.claude.executablePath") as HTMLInputElement).value = result.path; markDirty("claude", true); }
  };
  el("install-agy").onclick = async () => {
    installing = true; el("install-text").textContent = "Starting…"; showError(role(card("antigravity"), "general-error"), undefined);
    if (state) renderInstall(state);
    try {
      const result = await api.installAntigravity();
      if (result.ok) el("install-text").textContent = `Installed version ${result.info.version}.`;
      else { el("install-text").textContent = ""; showError(role(card("antigravity"), "general-error"), result.message); }
    } finally { installing = false; el("install-progress").hidden = true; await refresh(); }
  };
  api.onInstallProgress((progress: InstallProgressView) => {
    const bar = el<HTMLProgressElement>("install-progress");
    const labels: Record<string, string> = { registry: "Reading registry…", download: "Downloading…", extract: "Extracting…", verify: "Verifying…", done: "Done." };
    bar.hidden = progress.phase === "done";
    if (progress.phase === "download" && progress.total) { bar.max = progress.total; bar.value = progress.received ?? 0; } else bar.removeAttribute("value");
    const mb = (bytes: number): string => (bytes / 1048576).toFixed(1);
    el("install-text").textContent = progress.message ?? (progress.phase === "download" && progress.total ? `Downloading… ${mb(progress.received ?? 0)} / ${mb(progress.total)} MB` : labels[progress.phase] ?? progress.phase);
  });
}

wire();
showView(storedView());
api.onState((next) => render(next));
api.onLocalServers(renderLocalServers);
void api.getLocalServers().then(renderLocalServers);
api.onActivity((next) => { activity = next; renderActivity(); });
void api.getActivity().then((entries) => { activity = entries; renderActivity(); });
void refresh();
