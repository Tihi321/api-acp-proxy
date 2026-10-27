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
}

declare global {
  interface Window { proxyApi: ProxyApi }
}
