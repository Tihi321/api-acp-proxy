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
  /** ISO UTC time the provider's usage limit resets; present only while the router holds it exhausted. */
  exhaustedUntil?: string;
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
    codex: { enabled: boolean; authMethodId?: string; isolatedHome?: boolean; maxConcurrent?: number; maxPromptChars?: number };
    antigravity: {
      enabled: boolean; executablePath?: string; geminiHome?: string; apiKey?: string; authMethodId?: string;
      termsAcknowledgedAt?: string; purgeSessions?: boolean; lastAuthMethodId?: string; maxConcurrent?: number; maxPromptChars?: number;
    };
    claude: {
      enabled: boolean; apiKey?: string; oauthToken?: string; configDir?: string; executablePath?: string; authMethodId?: string;
      termsAcknowledgedAt?: string; maxConcurrent?: number; maxPromptChars?: number;
    };
    gufo: GufoProviderSettingsView;
    strata: LocalProviderSettingsView;
    llama: LlamaProviderSettingsView;
  };
}
export interface LocalProviderSettingsView { enabled: boolean; port: number; command: string; args: string; cwd: string; apiKey?: string; maxConcurrent?: number }
/** One Gufo model profile (see `GufoProfile` in settings.ts); `SettingsPatchView` replaces `profiles` as a whole array. */
export interface GufoProfileView { id: string; label: string; model: string; kind: "llm" | "image"; args: string; vision: boolean; startTimeoutMs?: number; requestTimeoutMs?: number }
export interface GufoProviderSettingsView { enabled: boolean; port: number; command: string; cwd: string; apiKey?: string; maxConcurrent?: number; switchWaitMs: number; profiles: GufoProfileView[] }
export type LlamaSourceView = "ggml-org" | "unsloth";
export type LlamaLayersView = "auto" | "all" | number;
/** One llama.cpp model profile (see `LlamaProfile` in settings.ts); `SettingsPatchView` replaces `profiles` as a whole array. */
export interface LlamaProfileView {
  id: string; label: string; model: string; vision: boolean; modelFile: string; mmprojFile?: string; ctxSize?: number;
  gpuLayers: LlamaLayersView; flashAttn: "auto" | "on" | "off"; specType: string; draftFile?: string; draftNMax?: number; draftNMin?: number;
  draftGpuLayers?: LlamaLayersView; extraArgs: string;
  hf?: { repo: string; revision: string; quant: string; mmproj?: string; draft?: string };
  requires?: { minBuild?: number; sources?: LlamaSourceView[] };
  startTimeoutMs?: number; requestTimeoutMs?: number;
}
/** What the main process saved after an install (see `LlamaInstallInfo` in settings.ts). */
export interface LlamaInstallInfoView {
  source: LlamaSourceView; tag: string; build?: number; backend: string; arch: "x64" | "arm64"; assetName: string; sha256: string;
  runtimeAssetName?: string; command: string; dir: string; installedAt: string;
}
export interface LlamaBinarySettingsView {
  mode: "managed" | "custom"; dir: string; source: LlamaSourceView; backend: string; arch: "x64" | "arm64";
  customPath?: string; customBuild?: number; installed?: LlamaInstallInfoView;
}
/** `SettingsPatchView` replaces `profiles` and `binary` as whole values. */
export interface LlamaProviderSettingsView {
  enabled: boolean; port: number; maxConcurrent?: number; switchWaitMs: number; modelsDir: string; hfToken?: string;
  binary: LlamaBinarySettingsView; profiles: LlamaProfileView[];
}
export type LocalServerId = "gufo" | "strata" | "llama";
export type LocalServerState = "stopped" | "starting" | "ready" | "error";
export interface LocalServerStatusView {
  id: LocalServerId;
  name: string;                 // "Gufo" | "Strata"
  state: LocalServerState;
  port?: number;                // of the last start
  profile?: string;             // gufo: id of the profile of the last start (filled by the launcher, T2)
  pid?: number;                 // while the process lives
  startedAt?: number;           // epoch ms of the last spawn
  readyAt?: number;             // epoch ms the probe first answered 200
  error?: string;               // set in state "error"
  commandLine?: string;         // what was run (no secrets: apiKey is never put on the command line)
  log: string[];                // last lines, oldest first, at most 200, ANSI codes stripped
}
/** Deep partial; `null` clears an optional field (same contract as the core SettingsPatch). */
export type SettingsPatchView = {
  server?: { [K in keyof SettingsView["server"]]?: SettingsView["server"][K] | null };
  providers?: {
    codex?: { [K in keyof SettingsView["providers"]["codex"]]?: SettingsView["providers"]["codex"][K] | null };
    antigravity?: { [K in keyof SettingsView["providers"]["antigravity"]]?: SettingsView["providers"]["antigravity"][K] | null };
    claude?: { [K in keyof SettingsView["providers"]["claude"]]?: SettingsView["providers"]["claude"][K] | null };
    gufo?: { [K in keyof GufoProviderSettingsView]?: GufoProviderSettingsView[K] | null };
    strata?: { [K in keyof LocalProviderSettingsView]?: LocalProviderSettingsView[K] | null };
    llama?: { [K in keyof LlamaProviderSettingsView]?: LlamaProviderSettingsView[K] | null };
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

/** Same list as `DownloadErrorCode` in download.ts (C5); repeated because shared types import no Node modules. */
export type DownloadErrorCodeView = "download_host_not_allowed" | "download_http_error" | "download_checksum_mismatch" | "download_size_mismatch"
  | "download_cancelled" | "download_disk_space" | "download_busy" | "hf_link_invalid" | "hf_auth_required" | "hf_terms_required" | "hf_not_found"
  | "llama_release_not_found" | "llama_asset_not_found" | "llama_no_digest" | "llama_server_missing" | "llama_build_too_old";
export type Failure = { ok: false; message: string; code?: DownloadErrorCodeView };
export interface LlamaProgressView { job: "binary" | "model"; phase: "release" | "download" | "verify" | "extract" | "done" | "error" | "cancelled"; file?: string; received?: number; total?: number; message?: string }
export interface LlamaAssetView {
  name: string; size: number; sha256?: string; url: string; backend: string; arch: "x64" | "arm64";
  runtime?: { name: string; size: number; sha256?: string; url: string };
}
export interface LlamaReleaseView { source: LlamaSourceView; tag: string; build?: number; publishedAt: string; assets: LlamaAssetView[] }
export interface HfFileView { path: string; size: number; sha256?: string; saveAs: string }
export interface HfFileGroupView { kind: "model" | "mmproj" | "draft"; label: string; quant?: string; files: HfFileView[]; totalSize: number; split: boolean }
export interface LlamaStatusView {
  binary: { mode: "managed" | "custom"; command?: string; source: LlamaSourceView | "custom"; tag?: string; build?: number; backend?: string; exists: boolean };
  profiles: Record<string, { build: "ok" | "too_old" | "unknown"; buildMessage?: string; missingFiles: string[] }>;
  /** Running jobs. */
  jobs: { binary: boolean; model: boolean };
}
export type LlamaReleasesResult = { ok: true; releases: LlamaReleaseView[] } | Failure;
export type LlamaInstallResult = { ok: true; info: LlamaInstallInfoView } | Failure;
export type LlamaCheckResult = { ok: true; build?: number; version: string } | Failure;
export type HfListResult = { ok: true; repo: string; revision: string; quant?: string; groups: HfFileGroupView[] } | Failure;
export type HfDownloadResult = { ok: true; paths: string[] } | Failure;
export type ProfileModelsResult = { ok: true; profile: LlamaProfileView } | Failure;

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
  /** The local servers, in the order gufo, strata, llama. */
  getLocalServers(): Promise<LocalServerStatusView[]>;
  /** Gufo: switches to `profileId` (default: the running or first llm profile) through the coordinator, so it may queue behind a busy model; resolves when the model is ready (can take many minutes) or fails with the reason. Progress arrives through `onLocalServers`. Strata: resolves once spawned. */
  startLocalServer(id: LocalServerId, profileId?: string): Promise<ActionResult>;
  /** `profiles` plus the built-in presets whose id is absent (pure; the renderer cannot import the settings module). */
  restoreGufoPresets(profiles: GufoProfileView[]): Promise<GufoProfileView[]>;
  stopLocalServer(id: LocalServerId): Promise<ActionResult>;
  onLocalServers(callback: (servers: LocalServerStatusView[]) => void): () => void;
  /** Folder picker (`openDirectory`, `createDirectory`). */
  pickDirectory(title: string, defaultPath?: string): Promise<PickResult>;
  llamaReleases(source: LlamaSourceView, refresh?: boolean): Promise<LlamaReleasesResult>;
  /** On success main saves `binary.installed`, `mode = "managed"`, source, backend and arch. */
  installLlama(request: { source: LlamaSourceView; tag: string; backend: string; arch: "x64" | "arm64" }): Promise<LlamaInstallResult>;
  /** On success main saves `binary.customPath`, `binary.customBuild` and `mode = "custom"`. */
  checkLlamaExecutable(path: string): Promise<LlamaCheckResult>;
  hfListFiles(link: string): Promise<HfListResult>;
  /** `files` are paths from the listing; main re-lists to get sizes and checksums. */
  hfDownload(request: { repo: string; revision: string; files: string[] }): Promise<HfDownloadResult>;
  /** Downloads the files of `profile.hf` and writes the real relative paths back into the stored profile. */
  downloadProfileModels(profileId: string): Promise<ProfileModelsResult>;
  cancelLlamaDownload(job: "binary" | "model"): Promise<void>;
  /** `profiles` plus the built-in llama presets whose id and model are absent (pure). */
  restoreLlamaPresets(profiles: LlamaProfileView[]): Promise<LlamaProfileView[]>;
  llamaStatus(): Promise<LlamaStatusView>;
  onLlamaProgress(callback: (progress: LlamaProgressView) => void): () => void;
}

declare global {
  interface Window { proxyApi: ProxyApi }
}
