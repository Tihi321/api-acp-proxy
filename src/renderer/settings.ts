import type { InstallProgressView, ProviderStatusView, SaveResult, SettingsPatchView, StateView } from "../shared/ipc.js";

type Scope = "server" | "codex" | "antigravity" | "claude";
interface FieldSpec { path: string; kind: "text" | "number" | "bool" | "select"; scope: Scope; optional?: boolean }

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

const fields: FieldSpec[] = [
  { path: "server.host", kind: "text", scope: "server" },
  { path: "server.port", kind: "number", scope: "server" },
  { path: "server.apiKey", kind: "text", scope: "server", optional: true },
  { path: "server.timeoutMs", kind: "number", scope: "server" },
  { path: "server.maxBodyBytes", kind: "number", scope: "server" },
  { path: "server.modelsWaitMs", kind: "number", scope: "server" },
  { path: "server.launchAtLogin", kind: "bool", scope: "server" },
  { path: "server.ignoreSampling", kind: "bool", scope: "server" },
  { path: "server.reuseSessions", kind: "bool", scope: "server" },
  { path: "providers.codex.enabled", kind: "bool", scope: "codex" },
  { path: "providers.codex.authMethodId", kind: "select", scope: "codex", optional: true },
  { path: "providers.codex.isolatedHome", kind: "bool", scope: "codex" },
  { path: "providers.antigravity.enabled", kind: "bool", scope: "antigravity" },
  { path: "providers.antigravity.authMethodId", kind: "select", scope: "antigravity", optional: true },
  { path: "providers.antigravity.executablePath", kind: "text", scope: "antigravity", optional: true },
  { path: "providers.antigravity.apiKey", kind: "text", scope: "antigravity", optional: true },
  { path: "providers.antigravity.geminiHome", kind: "text", scope: "antigravity", optional: true },
  { path: "providers.antigravity.purgeSessions", kind: "bool", scope: "antigravity" },
  { path: "providers.claude.enabled", kind: "bool", scope: "claude" },
  { path: "providers.claude.authMethodId", kind: "select", scope: "claude", optional: true },
  { path: "providers.claude.apiKey", kind: "text", scope: "claude", optional: true },
  { path: "providers.claude.oauthToken", kind: "text", scope: "claude", optional: true },
  { path: "providers.claude.configDir", kind: "text", scope: "claude", optional: true },
  { path: "providers.claude.executablePath", kind: "text", scope: "claude", optional: true },
];

/** Shown before the provider has reported its methods (it is not running yet). */
const fallbackAuth: Record<string, Array<{ id: string; name: string }>> = {
  codex: [{ id: "chat-gpt", name: "ChatGPT account" }, { id: "api-key", name: "API key" }],
  antigravity: [{ id: "oauth-personal", name: "Log in with Google" }, { id: "oauth-business", name: "Log in with Gemini Enterprise" }, { id: "gemini-api-key", name: "Gemini API key" }, { id: "agent-platform", name: "Gemini Enterprise Agent Platform" }],
  claude: [{ id: "claude-ai-login", name: "Claude subscription" }, { id: "console-login", name: "Anthropic Console (API billing)" }],
};
const defaultAuth: Record<string, string> = { antigravity: "oauth-personal", claude: "claude-ai-login" };

const badgeClass: Record<string, string> = {
  running: "ok", ready: "ok", starting: "info", needs_login: "warn", terms_required: "warn", not_installed: "warn", error: "err", stopped: "", disabled: "",
};
const badgeText: Record<string, string> = { needs_login: "needs login", not_installed: "not installed", terms_required: "terms required" };

let state: StateView | undefined;
const dirty: Record<Scope, boolean> = { server: false, codex: false, antigravity: false, claude: false };
const loggingIn = new Set<string>();
let installing = false;

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const field = (path: string): HTMLInputElement | HTMLSelectElement => el(path);
const card = (provider: string): HTMLElement => el(`card-${provider}`);
const role = <T extends HTMLElement>(root: ParentNode, name: string): T => root.querySelector(`[data-role="${name}"]`) as T;

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
  renderFields(provider as Scope, current);
  renderAuth(provider, status, current);

  const login = role<HTMLButtonElement>(root, "login");
  const unavailable = ["disabled", "not_installed", "terms_required"].includes(providerState) || current.status.server.state !== "running";
  login.disabled = unavailable || loggingIn.has(provider);
  login.textContent = loggingIn.has(provider) ? "Waiting for login…" : "Log in";
  login.title = unavailable ? "Enable and save the provider (and start the server) first." : "";

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

function renderInstall(current: StateView): void {
  const info = current.antigravityInstall;
  el("install-info").textContent = info
    ? `Installed ${info.version} · sha256 ${info.sha256} · signature: ${info.signature ? `${info.signature.status}${info.signature.signer ? ` (${info.signature.signer})` : ""}` : "not checked"}\n${info.command}`
    : "No downloaded agent yet.";
  el<HTMLButtonElement>("install-agy").disabled = installing;
  el<HTMLButtonElement>("install-agy").textContent = info ? "Re-download from registry" : "Download from registry";
}

function render(current: StateView): void {
  state = current;
  const server = current.status.server;
  setBadge(el("server-badge"), server.state);
  setBadge(el("top-badge"), server.state);
  el("top-url").textContent = server.baseUrl ?? "";
  el("server-url").textContent = server.baseUrl ?? (server.state === "error" ? "Not listening" : "Not running");
  el("copy-url").hidden = !server.baseUrl;
  const error = server.error ? (server.error.code === "EADDRINUSE" ? `Port ${server.port} is already in use. Pick another port or stop the other program.` : server.error.message) : undefined;
  showError(el("server-error"), server.state === "error" ? error : undefined);
  const active = server.state === "running" || server.state === "starting";
  el("server-toggle").textContent = active ? "Stop" : server.state === "error" ? "Retry" : "Start";
  renderFields("server", current);
  renderProvider("codex", current);
  renderProvider("antigravity", current);
  renderProvider("claude", current);
  renderInstall(current);
  el("settings-path").textContent = current.settingsPath;
  el("secrets-note").textContent = current.secretsEncrypted ? "Secrets are encrypted with the OS keychain." : "OS secret storage unavailable: secrets are stored as plain text.";
}

async function refresh(): Promise<void> { render(await api.getState()); }

function collectPatch(scope: Scope): { patch?: SettingsPatchView; errors: Array<{ path: string; message: string }> } {
  const patch: Record<string, unknown> = {};
  const errors: Array<{ path: string; message: string }> = [];
  for (const spec of fields.filter((entry) => entry.scope === scope)) {
    if (state?.overridden.includes(spec.path)) continue;
    const input = field(spec.path);
    let value: unknown;
    if (spec.kind === "bool") value = (input as HTMLInputElement).checked;
    else if (spec.kind === "number") {
      if (input.value.trim() === "") { errors.push({ path: spec.path, message: "Required" }); continue; }
      value = Number(input.value);
      if (!Number.isFinite(value)) { errors.push({ path: spec.path, message: "Must be a number" }); continue; }
    } else {
      const text = spec.path.endsWith("apiKey") ? input.value : input.value.trim();
      if (text === "") {
        if (!spec.optional) { errors.push({ path: spec.path, message: "Required" }); continue; }
        value = null;
      } else value = text;
    }
    setPath(patch, spec.path, value);
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
    if (result.ok) { dirty[scope] = false; flash(msg, "Saved. The server was restarted."); await refresh(); }
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
  for (const spec of fields) field(spec.path).addEventListener("input", () => { dirty[spec.scope] = true; });
  for (const spec of fields) field(spec.path).addEventListener("change", () => { dirty[spec.scope] = true; });

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
    dirty.server = true;
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
  el("terms-link").onclick = (event) => { event.preventDefault(); if (termsUrl) void openExternal(termsUrl); };

  for (const provider of ["codex", "antigravity", "claude"] as const) {
    const root = card(provider);
    const msg = role<HTMLElement>(root, "msg");
    role(root, "save").onclick = () => void saveScope(provider);
    role(root, "refresh").onclick = async () => {
      const result = await api.refreshModels(provider);
      if (!result.ok) flash(msg, result.message, true);
    };
    role(root, "login").onclick = async () => {
      loggingIn.add(provider); flash(msg, provider === "claude" ? "Complete the login in the console window…" : ""); if (state) renderProvider(provider, state);
      try {
        const methodId = (field(`providers.${provider}.authMethodId`) as HTMLSelectElement).value || undefined;
        const result = await api.login(provider, methodId);
        flash(msg, result.ok ? "Signed in." : result.message, !result.ok);
      } finally { loggingIn.delete(provider); await refresh(); }
    };
    role(root, "login-url").onclick = (event) => { event.preventDefault(); const url = (event.currentTarget as HTMLElement).dataset.url; if (url) void openExternal(url, msg); };
    role(root, "copy-login").onclick = () => { const url = role<HTMLElement>(root, "login-url").dataset.url; if (url) void api.copyText(url).then(() => flash(msg, "Link copied.")); };
  }

  for (const provider of ["antigravity", "claude"] as const) {
    (field(`providers.${provider}.enabled`) as HTMLInputElement).addEventListener("change", async (event) => {
      const input = event.currentTarget as HTMLInputElement;
      if (input.checked && !await ensureTerms(provider)) input.checked = false;
    });
  }

  el("browse-exe").onclick = async () => {
    const result = await api.pickExecutable();
    if (result.path) { (field("providers.antigravity.executablePath") as HTMLInputElement).value = result.path; dirty.antigravity = true; }
  };
  el("browse-claude-exe").onclick = async () => {
    const result = await api.pickExecutable();
    if (result.path) { (field("providers.claude.executablePath") as HTMLInputElement).value = result.path; dirty.claude = true; }
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
api.onState((next) => render(next));
void refresh();
