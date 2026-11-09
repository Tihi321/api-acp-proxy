// IPC contract between the Electron main process and the settings renderer. Types only: this file must stay
// free of runtime code and of imports from core modules so the renderer (DOM lib) can compile it.

export type ProviderState = "disabled" | "stopped" | "starting" | "ready" | "needs_login" | "not_installed" | "terms_required" | "error";
export type ServerState = "stopped" | "starting" | "running" | "error";

export interface AuthMethodView { id: string; name: string; description?: string; type?: string }
export interface ModelView { id: string; name?: string }
export interface ProviderStatusView {
  id: string;
  name: string;
  state: ProviderState;
  error?: string;
  authMethods: AuthMethodView[];
  models: ModelView[];
  loginUrl?: string;
  agentVersion?: string;
  /** Signed-in identity label, when the agent reports one. */
  account?: string;
  /** What the agent accepts in `initialize` (present once it has started). */
  capabilities?: { image: boolean };
  /** What the proxy can do through this provider. */
  features?: { imageGeneration: boolean; tools: boolean; mcp: boolean; webSearch: boolean };
  /** Where the agent keeps its login; `shared` means the user's own folder of the tool (~/.codex, ~/.claude, ~/.gemini). */
  loginHome?: { path: string; shared: boolean };
}
export interface StatusView {
  server: { state: ServerState; host: string; port: number; baseUrl?: string; error?: { code?: string; message: string } };
  providers: ProviderStatusView[];
  overridden: string[];
  settingsPath: string;
}

export interface SettingsView {
  server: {
    host: string; port: number; apiKey?: string; maxBodyBytes: number; timeoutMs: number; modelsWaitMs: number;
    workRoot?: string; launchAtLogin: boolean; toolResultTimeoutMs: number; maxConcurrent: number; maxQueue: number;
  };
  providers: {
    codex: { enabled: boolean; authMethodId?: string; isolatedHome?: boolean; maxConcurrent?: number };
    antigravity: {
      enabled: boolean; executablePath?: string; geminiHome?: string; apiKey?: string; authMethodId?: string;
      termsAcknowledgedAt?: string; purgeSessions?: boolean; lastAuthMethodId?: string; maxConcurrent?: number;
    };
    claude: {
      enabled: boolean; apiKey?: string; oauthToken?: string; configDir?: string; executablePath?: string; authMethodId?: string;
      termsAcknowledgedAt?: string; maxConcurrent?: number;
    };
  };
}
/** Deep partial; `null` clears an optional field (same contract as the core SettingsPatch). */
export type SettingsPatchView = {
  server?: { [K in keyof SettingsView["server"]]?: SettingsView["server"][K] | null };
  providers?: {
    codex?: { [K in keyof SettingsView["providers"]["codex"]]?: SettingsView["providers"]["codex"][K] | null };
    antigravity?: { [K in keyof SettingsView["providers"]["antigravity"]]?: SettingsView["providers"]["antigravity"][K] | null };
    claude?: { [K in keyof SettingsView["providers"]["claude"]]?: SettingsView["providers"]["claude"][K] | null };
  };
};

export interface InstallInfoView {
  version: string; url: string; sha256: string; command: string; dir: string; installedAt: string;
  signature?: { status: string; signer?: string };
}
export interface InstallProgressView { phase: "registry" | "download" | "extract" | "verify" | "done"; received?: number; total?: number; message?: string }

/** A configured MCP server (`settings.mcpServers`) as the window shows it: no headers, no env, no query string and no arguments, which can hold secrets. */
export interface McpServerView { label: string; transport: "http" | "sse" | "stdio"; /** http/sse: the URL without credentials and query; stdio: the command. */ target: string }
/** One request of the activity log: metadata only. */
export interface ActivityView {
  time: number; endpoint: string; model?: string; provider?: string; stream: boolean;
  /** `images`, `imageGeneration`, `tools`, `mcp`, `search`. */
  features: string[];
  durationMs: number; status: number; error?: string; inputTokens?: number; outputTokens?: number;
  /** Names of the dropped sampling fields (never values). */
  ignoredParams?: string[];
  /** True when the token counts are an estimate (about 4 characters per token; the agent reported none). */
  estimated?: boolean;
}
/** One provider's (or the total's) counts over a range. `estimated`: requests whose token counts are the chars/4 estimate. */
export interface UsageCountsView { requests: number; errors: number; inputTokens: number; outputTokens: number; estimated: number }
export type UsageRangeKey = "today" | "last7" | "last30" | "allTime";
export interface UsageProviderView { id: string; today: UsageCountsView; last7: UsageCountsView; last30: UsageCountsView; allTime: UsageCountsView }
/** One local day; `byProvider` has an entry for every provider of `UsageView.providers` (zeros included). */
export interface UsageDayView { day: string /* YYYY-MM-DD, local */; byProvider: Record<string, UsageCountsView> }
export interface UsageView {
  generatedAt: number;
  /** Today's local day key, YYYY-MM-DD. */
  today: string;
  /** First day counted since the store was created or last reset (YYYY-MM-DD); absent when nothing was ever counted. */
  since?: string;
  /** Requested provider ids first, in the requested order, then any other id found in the data (sorted). */
  providers: UsageProviderView[];
  total: Record<UsageRangeKey, UsageCountsView>;
  /** Exactly 30 entries, oldest first, the last one is today; days without data are zero-filled. */
  days: UsageDayView[];
}

export interface PlanLimitWindowView {
  /** As the agent names it: "5h limit", "Weekly limit", "5-hour limit", "Weekly · all models", ... */
  label: string;
  /** 0-100, percent USED (Codex "% left" is converted). */
  usedPercent: number;
  /** Epoch ms, only when known exactly (the Claude push hint). */
  resetsAt?: number;
  /** The agent's own reset wording, e.g. "15:00", "09:30 on 12 Nov", "Nov 8, 3:00 PM GMT+1". */
  resetText?: string;
}
/** `idle`: never fetched. `ok`: windows parsed. `no_data`: the agent answered but has no limits (API key logins, "data not available yet"). `unparsed`: answer not understood, `raw` holds it (redacted). `unsupported`: the provider cannot report limits. `unavailable`: provider off, not installed, terms pending or server stopped. `needs_login`: not probed because the provider needs login. `error`: the probe failed (`message`). */
export type PlanLimitsState = "idle" | "ok" | "no_data" | "unparsed" | "unsupported" | "unavailable" | "needs_login" | "error";
/** Claude's pushed `_claude/rateLimit` (one window per event). `utilization` normalised to 0-100, `resetsAt` to epoch ms. */
export interface RateLimitHintView { status: "allowed" | "allowed_warning" | "rejected"; rateLimitType?: string; utilization?: number; resetsAt?: number; at: number }
export interface PlanLimitsView {
  provider: string;
  state: PlanLimitsState;
  windows: PlanLimitWindowView[];
  /** "ChatGPT plus", "API key", "Claude max": never an email. */
  plan?: string;
  /** Codex credits line, e.g. "unlimited". */
  credits?: string;
  /** Epoch ms of the probe's answer (ok, no_data, unparsed, error). */
  fetchedAt?: number;
  /** Only for `unparsed`: the reply with emails, cost lines and session/directory lines removed, at most 4000 characters. */
  raw?: string;
  message?: string;
  hint?: RateLimitHintView;
}

export interface StateView {
  status: StatusView;
  /** Stored settings (what is in the file). */
  settings: SettingsView;
  /** Settings with environment overrides applied; used to display disabled, overridden fields. */
  effective: SettingsView;
  overridden: string[];
  settingsPath: string;
  antigravityInstall?: InstallInfoView;
  /** True when secrets are encrypted at rest (safeStorage). */
  secretsEncrypted: boolean;
  /** The folder Codex keeps its login in: the proxy's own home (`isolated`) or the user's ~/.codex. */
  codexHome: { path: string; isolated: boolean };
  /** `settings.mcpServers`, read-only. */
  mcpServers: McpServerView[];
}

export interface FieldError { path: string; message: string }
export type SaveResult = { ok: true } | { ok: false; errors: FieldError[] };
export type ActionResult = { ok: true } | { ok: false; message: string };
export type InstallResult = { ok: true; info: InstallInfoView } | { ok: false; message: string };
export type PickResult = { path?: string };
export type OpenTarget = "codexHome" | "settingsFile";

export interface ProxyApi {
  getState(): Promise<StateView>;
  saveSettings(patch: SettingsPatchView): Promise<SaveResult>;
  startServer(): Promise<ActionResult>;
  stopServer(): Promise<ActionResult>;
  refreshModels(providerId?: string): Promise<ActionResult>;
  login(providerId: string, methodId?: string): Promise<ActionResult>;
  logout(providerId: string): Promise<ActionResult>;
  getActivity(): Promise<ActivityView[]>;
  clearActivity(): Promise<void>;
  onActivity(callback: (entries: ActivityView[]) => void): () => void;
  openPath(target: OpenTarget): Promise<ActionResult>;
  pickExecutable(): Promise<PickResult>;
  installAntigravity(): Promise<InstallResult>;
  onInstallProgress(callback: (progress: InstallProgressView) => void): () => void;
  acknowledgeTerms(providerId: "antigravity" | "claude"): Promise<ActionResult>;
  openLogs(): Promise<void>;
  /** Opens the playground page (`<server>/playground`) in the default browser. */
  openPlayground(): Promise<ActionResult>;
  copyText(text: string): Promise<void>;
  openExternal(url: string): Promise<ActionResult>;
  onState(callback: (state: StateView) => void): () => void;
  getUsage(): Promise<UsageView>;
  /** Sets every total back to zero and rewrites usage.json. */
  resetUsage(): Promise<ActionResult>;
  onUsage(callback: (usage: UsageView) => void): () => void;
  /** Cached plan limits, one per registered provider; never probes. */
  getPlanLimits(): Promise<PlanLimitsView[]>;
  /** Probes unless a value younger than 60 s exists and `force` is not true. */
  refreshPlanLimits(providerId: string, force?: boolean): Promise<PlanLimitsView>;
}

declare global {
  interface Window { proxyApi: ProxyApi }
}
