import { app, clipboard, dialog, ipcMain, net, safeStorage, shell } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ProxyController } from "../controller.js";
import type { ControllerStatus } from "../controller.js";
import { createLogger } from "../logger.js";
import { claudeRegistration } from "../providers/claude.js";
import { codexRegistration } from "../providers/codex.js";
import { createGufoRegistration, createLlamaRegistration, createStrataRegistration } from "../providers/local-openai.js";
import { LocalModelCoordinator, targetKey } from "../local-models.js";
import type { LocalModelTarget } from "../local-models.js";
import { createLocalModelHost } from "../local-host.js";
import { LOCAL_SERVER_IDS, LocalServerManager } from "../local-servers.js";
import type { LocalServerSpec } from "../local-servers.js";
import { listMcpServers } from "../mcp-servers.js";
import { LLAMA_SOURCES, defaultSettingsPath, restoreMissingLlamaPresets, restoreMissingPresets } from "../settings.js";
import type { GufoProfile, LlamaProfile, LlamaSource, SecretCodec, SettingsPatch } from "../settings.js";
import { DownloadError } from "../download.js";
import { GITHUB_POLICY, fetchReleases } from "../llama-releases.js";
import type { LlamaReleaseView } from "../llama-releases.js";
import { installLlama, probeLlamaVersion } from "../llama-install.js";
import { HF_POLICY, downloadHfFiles, listHfFiles, parseHfLink } from "../hf-models.js";
import type { HfFile, HfFileGroup } from "../hf-models.js";
import { buildLlamaArgs, checkBuild, checkLlamaFiles } from "../llama-args.js";
import { customExePatch, installPatch } from "../llama-jobs.js";
import { scanModelsDir } from "../llama-scan.js";
import { antigravityRegistration, installAntigravity, readInstallInfo } from "./antigravity.js";
import { SettingsWindow } from "./settings-window.js";
import { TrayController } from "./tray.js";
import type { ActionResult, ActivityView, FieldError, Failure, GufoProfileView, HfDownloadResult, HfListResult, InstallInfoView, InstallResult, LlamaCheckResult, LlamaInstallResult, LlamaProfileView, LlamaProgressView, LlamaReleasesResult, LlamaScanResult, LlamaStatusView, LocalServerId, OpenTarget, PickResult, SaveResult, StateView, UsageView } from "../shared/ipc.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, "..", "..");

// Settings, logs and installed agents all live next to the settings file, which the headless CLI shares
// (%APPDATA%\api-acp-proxy\settings.json, or PROXY_SETTINGS_FILE).
const settingsPath = defaultSettingsPath(process.env);
const dataDir = path.dirname(settingsPath);
app.setPath("userData", dataDir);
app.setName("ACP Proxy");

const logsDir = path.join(dataDir, "logs");
const logger = createLogger({ file: path.join(logsDir, "proxy.log"), console: !app.isPackaged });

const resolveUnpacked = (file: string): string => file.replace(/([\\/])app\.asar(?=[\\/]|$)/, "$1app.asar.unpacked");

if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  main().catch((error) => { logger.error(`Fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}`); app.exit(1); });
}

function toInstallView(info: Awaited<ReturnType<typeof readInstallInfo>> & object): InstallInfoView {
  return {
    version: info.version, url: info.url, sha256: info.sha256, command: info.command, dir: info.dir, installedAt: info.installedAt,
    ...(info.signature ? { signature: info.signature } : {}),
  };
}

/** The llama-server.exe the settings point at, and what is known about its build. `source` is `custom` for an own exe. */
function llamaBinary(llama: { binary: { mode: "managed" | "custom"; customPath?: string | undefined; customBuild?: number | undefined; installed?: { command: string; source: LlamaSource; build?: number | undefined } | undefined } }): { command?: string; source: LlamaSource | "custom"; build?: number } {
  const { binary } = llama;
  if (binary.mode === "custom") return { ...(binary.customPath ? { command: binary.customPath } : {}), source: "custom", ...(binary.customBuild !== undefined ? { build: binary.customBuild } : {}) };
  const installed = binary.installed;
  return { ...(installed ? { command: installed.command } : {}), source: installed?.source ?? "ggml-org", ...(installed?.build !== undefined ? { build: installed.build } : {}) };
}

const RELEASES_TTL_MS = 10 * 60 * 1000;
const HF_REPO = /^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/;
const isLocalServerId = (id: unknown): id is LocalServerId => typeof id === "string" && (LOCAL_SERVER_IDS as readonly string[]).includes(id);
const isLlamaSource = (value: unknown): value is LlamaSource => typeof value === "string" && (LLAMA_SOURCES as readonly string[]).includes(value);
const shortString = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max;

async function main(): Promise<void> {
  let controller: ProxyController | undefined;
  let localServers: LocalServerManager | undefined;
  let settingsWindow: SettingsWindow | undefined;
  let tray: TrayController | undefined;
  let quitting = false;
  let installing = false;

  process.on("uncaughtException", (error) => logger.error(`Uncaught exception: ${error.stack ?? error.message}`));
  process.on("unhandledRejection", (reason) => logger.error(`Unhandled rejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`));

  app.on("second-instance", () => settingsWindow?.show());
  // The app lives in the tray: closing the settings window must not quit.
  app.on("window-all-closed", () => undefined);
  if (process.platform === "darwin") app.dock?.hide();

  app.on("before-quit", (event) => {
    if (quitting) return;
    quitting = true;
    event.preventDefault();
    settingsWindow?.markQuitting();
    void (async () => {
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, 5000));
      // The model servers stop in parallel with the controller, inside the same budget, so one never outlives the app.
      try { await Promise.all([Promise.race([controller?.stop().then(() => undefined), timeout]), Promise.race([localServers?.close(), timeout])]); } catch (error) { logger.error(`Error while stopping: ${String(error)}`); }
      // The flush has its own budget: a slow drain above must not starve the usage write.
      try { await Promise.race([controller?.flushUsage(), new Promise<void>((resolve) => setTimeout(resolve, 2000))]); } catch (error) { logger.error(`Error while saving usage: ${String(error)}`); }
      tray?.destroy();
      app.exit(0);
    })();
  });

  await app.whenReady();

  const secretCodec: SecretCodec | undefined = safeStorage.isEncryptionAvailable()
    ? { encode: (plain) => safeStorage.encryptString(plain).toString("base64"), decode: (stored) => safeStorage.decryptString(Buffer.from(stored, "base64")) }
    : undefined;
  if (!secretCodec) logger.warn("OS secret storage is unavailable; API keys will be stored in plain text in the settings file.");

  const hideWindows = resolveUnpacked(path.join(here, "hide-windows.cjs"));
  // The hook is also put in NODE_OPTIONS so it reaches the agents' own node grandchildren: codex-acp starts `node codex.js`, which spawns codex.exe without windowsHide (a console window would open for it). The user's existing NODE_OPTIONS is kept and the hook appended.
  const hideWindowsOption = `--require="${hideWindows.replace(/\\/g, "/")}"`;
  const nodeOptions = [process.env.NODE_OPTIONS, hideWindowsOption].filter(Boolean).join(" ");
  const servers = new LocalServerManager({ logger: logger.child("local") });
  localServers = servers;

  // The coordinator reads the effective Gufo settings synchronously; the cache is filled before the proxy starts and after every save.
  type GufoSettings = Awaited<ReturnType<ProxyController["getSettings"]>>["effective"]["providers"]["gufo"];
  let gufoSettings: GufoSettings | undefined;
  type StrataSettings = Awaited<ReturnType<ProxyController["getSettings"]>>["effective"]["providers"]["strata"];
  let strataSettings: StrataSettings | undefined;
  type LlamaSettings = Awaited<ReturnType<ProxyController["getSettings"]>>["effective"]["providers"]["llama"];
  let llamaSettings: LlamaSettings | undefined;
  const refreshLocalSettings = async (): Promise<void> => { const providers = (await proxy.getSettings()).effective.providers; gufoSettings = providers.gufo; strataSettings = providers.strata; llamaSettings = providers.llama; };
  const localHost = createLocalModelHost(servers, {
    specFor: (target): LocalServerSpec => {
      if (target.server === "strata") {
        const strata = strataSettings;
        if (!strata) throw new Error("Settings are not loaded yet.");
        return { id: "strata", command: strata.command, args: strata.args, cwd: strata.cwd, port: strata.port };
      }
      if (target.server === "llama") {
        const llama = llamaSettings;
        if (!llama) throw new Error("Settings are not loaded yet.");
        const binary = llamaBinary(llama);
        if (!binary.command) throw new Error("Llama.cpp is not installed: download a build or choose your own llama-server.exe on the Llama.cpp page.");
        const gate = checkBuild(target.profile, { source: binary.source, ...(binary.build !== undefined ? { build: binary.build } : {}) });
        if (gate.ok === false) throw new Error(gate.message);
        const missing = checkLlamaFiles(target.profile, llama.modelsDir);
        if (missing.length > 0) throw new Error(`File not found: ${missing[0]} (put it in the models folder or download it, then pick it on the Llama.cpp page)`);
        return { id: "llama", command: binary.command, args: buildLlamaArgs(target.profile, llama.modelsDir), cwd: path.dirname(binary.command), port: llama.port, profile: target.profile.id, startTimeoutMs: target.profile.startTimeoutMs };
      }
      const settings = gufoSettings;
      if (!settings) throw new Error("Settings are not loaded yet.");
      return { id: "gufo", command: settings.command, args: target.profile.args, cwd: settings.cwd, port: settings.port, profile: target.profile.id, startTimeoutMs: target.profile.startTimeoutMs };
    },
    port: (server) => (server === "strata" ? strataSettings?.port : server === "gufo" ? gufoSettings?.port : llamaSettings?.port),
  });
  const coordinator = new LocalModelCoordinator(localHost, () => ({
    targets: [
      ...(gufoSettings?.profiles ?? []).map((profile): LocalModelTarget => ({ key: `gufo:${profile.id}`, server: "gufo", profile })),
      ...(llamaSettings?.profiles ?? []).map((profile): LocalModelTarget => ({ key: `llama:${profile.id}`, server: "llama", profile })),
      { key: "strata", server: "strata" },
    ],
    switchWaitMs: (server) => (server === "llama" ? llamaSettings?.switchWaitMs : gufoSettings?.switchWaitMs) ?? 30 * 60 * 1000,
  }));

  const proxy = new ProxyController({
    settingsPath,
    logger,
    ...(secretCodec ? { secretCodec } : {}),
    registry: [codexRegistration, antigravityRegistration, claudeRegistration, createGufoRegistration({ coordinator }), createStrataRegistration({ coordinator }), createLlamaRegistration({ coordinator })],
    ctx: {
      dataDir,
      nodeRuntime: { command: process.execPath, argsPrefix: ["--require", hideWindows], env: { ELECTRON_RUN_AS_NODE: "1", NODE_OPTIONS: nodeOptions } },
      resolveUnpacked,
      fetch: net.fetch as unknown as typeof fetch,
      openUrl: (url: string) => shell.openExternal(url),
    },
  });
  controller = proxy;

  const win = new SettingsWindow({
    htmlPath: path.join(here, "..", "renderer", "settings.html"),
    preloadPath: path.join(here, "preload.cjs"),
    iconPath: path.join(appRoot, "assets", "icon.png"),
    onConsole: (level, message, source) => logger.debug(`[renderer ${level}] ${message} (${source})`),
  });
  settingsWindow = win;

  const applyLoginItem = (enabled: boolean): void => {
    if (!app.isPackaged) return;
    try { app.setLoginItemSettings({ openAtLogin: enabled, path: process.env.PORTABLE_EXECUTABLE_FILE ?? process.execPath, args: ["--hidden"] }); }
    catch (error) { logger.warn(`Could not update launch-at-login: ${String(error)}`); }
  };

  const buildState = async (): Promise<StateView> => {
    const snapshot = await proxy.getSettings();
    const info = await readInstallInfo(dataDir).catch(() => undefined);
    return {
      status: proxy.status(),
      settings: snapshot.settings,
      effective: snapshot.effective,
      overridden: snapshot.overridden,
      settingsPath: snapshot.path,
      secretsEncrypted: Boolean(secretCodec),
      codexHome: codexHomeView(snapshot.effective.providers.codex.isolatedHome),
      mcpServers: listMcpServers(snapshot.effective.mcpServers),
      ...(info ? { antigravityInstall: toInstallView(info) } : {}),
    };
  };

  /** The folder Codex keeps its login in: the proxy's own home, or the user's CODEX_HOME / ~/.codex. */
  const codexHomeView = (isolated: boolean): StateView["codexHome"] => isolated ? { path: path.join(dataDir, "codex-home"), isolated } : { path: process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), isolated };

  let pushTimer: NodeJS.Timeout | undefined;
  const pushState = (): void => {
    if (pushTimer) return;
    pushTimer = setTimeout(() => {
      pushTimer = undefined;
      if (!win.webContents) return;
      void buildState().then((state) => win.send("proxy:state", state), (error) => logger.warn(`State push failed: ${String(error)}`));
    }, 80);
  };

  const activityViews = (): ActivityView[] => proxy.activity.list(50);
  let activityTimer: NodeJS.Timeout | undefined;
  const pushActivity = (): void => {
    if (activityTimer) return;
    activityTimer = setTimeout(() => { activityTimer = undefined; if (win.webContents) win.send("proxy:activity", activityViews()); tray?.setActivity(proxy.activity.summary()); }, 150);
  };

  const usageView = (): UsageView => proxy.usageSummary();
  let usageTimer: NodeJS.Timeout | undefined;
  const pushUsage = (): void => {
    if (usageTimer) return;
    usageTimer = setTimeout(() => { usageTimer = undefined; if (win.webContents) win.send("proxy:usage", usageView()); }, 500);
  };

  let localTimer: NodeJS.Timeout | undefined;
  const pushLocalServers = (): void => {
    if (localTimer) return;
    localTimer = setTimeout(() => { localTimer = undefined; if (win.webContents) win.send("proxy:localServers", servers.list()); }, 250);
  };
  const lastLocalState = new Map<string, string>();
  servers.on("change", (list: ReturnType<LocalServerManager["list"]>) => {
    pushLocalServers();
    for (const entry of list) {
      const before = lastLocalState.get(entry.id);
      lastLocalState.set(entry.id, entry.state);
      // Once per transition to ready, so the models of the freshly started server appear.
      if (entry.state === "ready" && before !== "ready") void proxy.refreshModels(entry.id).catch(() => undefined);
      // Also when a ready or starting server stops or fails, so the provider badge, nav dot and tray stop saying ready.
      else if ((entry.state === "stopped" || entry.state === "error") && (before === "ready" || before === "starting")) void proxy.refreshModels(entry.id).catch(() => undefined);
    }
  });

  /** `<server>/playground` in the default browser. The address comes from the server status, never from the window. */
  const openPlayground = async (): Promise<void> => {
    const baseUrl = proxy.status().server.baseUrl;
    if (!baseUrl) throw new Error("The server is not running.");
    await shell.openExternal(baseUrl.replace(/\/v1$/, "/playground"));
  };

  tray = new TrayController({
    assetsDir: path.join(appRoot, "assets"),
    login: (providerId) => void proxy.login(providerId).catch((error) => logger.warn(`Login from the tray failed: ${error instanceof Error ? error.message : String(error)}`)),
    openSettings: () => win.show(),
    openLogs: () => void shell.openPath(logsDir),
    openPlayground: () => void openPlayground().catch((error) => logger.warn(`Could not open the playground: ${error instanceof Error ? error.message : String(error)}`)),
    quit: () => app.quit(),
    start: () => void proxy.start(),
    stop: () => void proxy.stop(),
    refreshModels: () => void proxy.refreshModels().catch((error) => logger.warn(`Refresh failed: ${String(error)}`)),
  });
  proxy.on("status", (status: ControllerStatus) => { tray?.update(status); pushState(); });
  proxy.on("activity", pushActivity);
  proxy.on("usage", pushUsage);
  proxy.on("loginNeeded", (providerId: string, name: string) => tray?.loginNeeded(providerId, name));
  tray.update(proxy.status());

  // IPC: every handler refuses callers other than our own settings page.
  const handle = <A extends unknown[], R>(channel: string, run: (...args: A) => Promise<R> | R): void => {
    ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      const url = event.senderFrame?.url ?? "";
      if (!win.isOwnUrl(url)) { logger.warn(`Rejected IPC ${channel} from '${url}'`); throw new Error("Forbidden"); }
      return run(...(args as A));
    });
  };
  const failure = (error: unknown): { ok: false; message: string } => ({ ok: false, message: error instanceof Error ? error.message : String(error) });
  const action = async (run: () => Promise<unknown>): Promise<ActionResult> => { try { await run(); return { ok: true }; } catch (error) { return failure(error); } };

  handle("proxy:getState", () => buildState());
  handle("proxy:saveSettings", async (patch: unknown): Promise<SaveResult> => {
    if (typeof patch !== "object" || patch === null || Array.isArray(patch)) return { ok: false, errors: [{ path: "", message: "Invalid settings patch" }] };
    try {
      await proxy.applySettings(patch as SettingsPatch);
      await refreshLocalSettings();
      applyLoginItem((await proxy.getSettings()).effective.server.launchAtLogin);
      return { ok: true };
    } catch (error) {
      const issues = (error as { issues?: Array<{ path: Array<string | number>; message: string }> }).issues;
      if (Array.isArray(issues)) return { ok: false, errors: issues.map((issue): FieldError => ({ path: issue.path.join("."), message: issue.message })) };
      return { ok: false, errors: [{ path: "", message: failure(error).message }] };
    }
  });
  handle("proxy:startServer", () => action(() => proxy.start()));
  handle("proxy:stopServer", () => action(() => proxy.stop()));
  handle("proxy:refreshModels", (providerId?: string) => action(() => proxy.refreshModels(typeof providerId === "string" ? providerId : undefined)));
  handle("proxy:login", (providerId: string, methodId?: string): Promise<ActionResult> | ActionResult => {
    if (typeof providerId !== "string") return { ok: false, message: "Invalid provider" };
    return action(() => proxy.login(providerId, typeof methodId === "string" && methodId ? methodId : undefined));
  });
  handle("proxy:logout", (providerId: string): Promise<ActionResult> | ActionResult => {
    if (typeof providerId !== "string") return { ok: false, message: "Invalid provider" };
    return action(() => proxy.logout(providerId));
  });
  handle("proxy:localServers", () => servers.list());
  handle("proxy:startLocalServer", async (id: unknown, profileId?: unknown): Promise<ActionResult> => {
    if (!isLocalServerId(id)) return { ok: false, message: "Invalid server" };
    if (profileId !== undefined && profileId !== null && !(typeof profileId === "string" && profileId.length <= 200)) return { ok: false, message: "Invalid profile" };
    return action(async () => {
      await refreshLocalSettings();
      // All servers start through the coordinator: it queues behind in-flight requests and resolves when ready (minutes for a large model); a queued or failed switch comes back as the error message.
      if (id === "strata") { await coordinator.switchTo(targetKey("strata")); return; }
      const running = servers.list().find((candidate) => candidate.id === id)?.profile;
      if (id === "llama") {
        const profiles = llamaSettings!.profiles;
        const chosen = typeof profileId === "string" && profileId ? profileId : running ?? profiles[0]?.id;
        if (!chosen) throw new Error("No Llama.cpp profile is configured.");
        await coordinator.switchTo(targetKey("llama", chosen));
        return;
      }
      const profiles = gufoSettings!.profiles;
      const chosen = typeof profileId === "string" && profileId ? profileId : running ?? profiles.find((candidate) => candidate.kind === "llm")?.id ?? profiles[0]?.id;
      if (!chosen) throw new Error("No Gufo profile is configured.");
      await coordinator.switchTo(targetKey("gufo", chosen));
    });
  });
  handle("proxy:restoreGufoPresets", (profiles: unknown): GufoProfileView[] => Array.isArray(profiles) ? restoreMissingPresets(profiles as GufoProfile[]) : []);
  handle("proxy:restoreLlamaPresets", (profiles: unknown): LlamaProfileView[] => Array.isArray(profiles) ? restoreMissingLlamaPresets(profiles as LlamaProfile[]) as LlamaProfileView[] : []);
  handle("proxy:stopLocalServer", (id: unknown): Promise<ActionResult> | ActionResult => {
    if (!isLocalServerId(id)) return { ok: false, message: "Invalid server" };
    return action(() => servers.stop(id));
  });

  // Llama.cpp downloads: one binary job and one model job at a time, each with its own abort controller; progress goes to the settings page.
  const llamaJobs: { binary?: AbortController; model?: AbortController } = {};
  const llamaProgress = (progress: LlamaProgressView): void => { if (win.webContents) win.send("proxy:llamaProgress", progress); };
  const llamaFailure = (error: unknown): Failure => ({ ok: false, message: error instanceof Error ? error.message : String(error), ...(error instanceof DownloadError ? { code: error.code } : {}) });
  /** Runs `run` as the single job of its kind; a second one gets `download_busy`. Failures and cancellation are also pushed as progress phases. */
  const runLlamaJob = async <T,>(job: "binary" | "model", run: (signal: AbortSignal) => Promise<T>): Promise<{ ok: true; value: T } | Failure> => {
    if (llamaJobs[job]) return { ok: false, message: "A download is already running.", code: "download_busy" };
    const controller = new AbortController();
    llamaJobs[job] = controller;
    try {
      return { ok: true, value: await run(controller.signal) };
    } catch (error) {
      const result = llamaFailure(error);
      const cancelled = result.code === "download_cancelled" || controller.signal.aborted;
      if (!cancelled) logger.warn(`Llama.cpp ${job} job failed: ${result.message}`);
      llamaProgress({ job, phase: cancelled ? "cancelled" : "error", message: result.message });
      return result;
    } finally { delete llamaJobs[job]; }
  };
  const hfToken = (): string | undefined => llamaSettings?.hfToken || undefined;
  const releasesCache = new Map<LlamaSource, { at: number; releases: LlamaReleaseView[] }>();

  handle("proxy:pickDirectory", async (title: unknown, defaultPath?: unknown): Promise<PickResult> => {
    if (typeof title !== "string" || title.length === 0 || title.length > 100) return {};
    if (defaultPath !== undefined && defaultPath !== null && !(typeof defaultPath === "string" && defaultPath.length <= 1000)) return {};
    const parent = win.browserWindow;
    const options: Electron.OpenDialogOptions = { title, ...(typeof defaultPath === "string" && defaultPath ? { defaultPath } : {}), properties: ["openDirectory", "createDirectory"] };
    const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
    return result.canceled || !result.filePaths[0] ? {} : { path: result.filePaths[0] };
  });
  handle("proxy:llamaReleases", async (source: unknown, refresh?: unknown): Promise<LlamaReleasesResult> => {
    if (!isLlamaSource(source)) return { ok: false, message: "Invalid source" };
    const cached = releasesCache.get(source);
    if (cached && refresh !== true && Date.now() - cached.at < RELEASES_TTL_MS) return { ok: true, releases: cached.releases };
    try {
      const releases = await fetchReleases(source, { fetch: fetch as typeof fetch, policy: GITHUB_POLICY, signal: AbortSignal.timeout(30_000) });
      releasesCache.set(source, { at: Date.now(), releases });
      return { ok: true, releases };
    } catch (error) { return llamaFailure(error); }
  });
  handle("proxy:installLlama", async (request: unknown): Promise<LlamaInstallResult> => {
    const r = request as { source?: unknown; tag?: unknown; backend?: unknown; arch?: unknown } | null;
    if (typeof r !== "object" || r === null || !isLlamaSource(r.source) || !shortString(r.tag, 200) || !shortString(r.backend, 100) || (r.arch !== "x64" && r.arch !== "arm64")) return { ok: false, message: "Invalid install request" };
    const { source, tag, backend, arch } = r;
    await refreshLocalSettings();
    const binDir = llamaSettings!.binary.dir;
    const outcome = await runLlamaJob("binary", (signal) => installLlama({ source, tag, backend, arch, binDir, fetch: fetch as typeof fetch, signal, onProgress: llamaProgress }));
    if (!outcome.ok) return outcome;
    try {
      // Job results are saved without a proxy restart (in-flight requests keep running), patched onto what is stored now.
      await proxy.persistSettings((current) => installPatch(current.providers.llama, { source, backend, arch, info: outcome.value }));
      await refreshLocalSettings();
      pushState();
      return { ok: true, info: outcome.value };
    } catch (error) { return llamaFailure(error); }
  });
  handle("proxy:checkLlamaExecutable", async (file: unknown): Promise<LlamaCheckResult> => {
    if (!shortString(file, 1000) || !file.toLowerCase().endsWith(".exe")) return { ok: false, message: "Choose a llama-server.exe file." };
    try {
      const stat = await fs.promises.stat(file).catch(() => undefined);
      if (!stat?.isFile()) return { ok: false, message: `File not found: ${file}` };
      const probe = await probeLlamaVersion(file);
      await proxy.persistSettings((current) => customExePatch(current.providers.llama, file, probe.build));
      await refreshLocalSettings();
      pushState();
      return { ok: true, ...(probe.build !== undefined ? { build: probe.build } : {}), version: probe.text };
    } catch (error) { return llamaFailure(error); }
  });
  handle("proxy:hfListFiles", async (link: unknown): Promise<HfListResult> => {
    if (!shortString(link, 500)) return { ok: false, message: "Enter a Hugging Face link.", code: "hf_link_invalid" };
    try {
      await refreshLocalSettings();
      const ref = parseHfLink(link.trim());
      const token = hfToken();
      const listing = await listHfFiles(ref, { fetch: fetch as typeof fetch, policy: HF_POLICY, signal: AbortSignal.timeout(60_000), ...(token ? { token } : {}) });
      return { ok: true, repo: ref.repo, revision: ref.revision, ...(listing.quant ? { quant: listing.quant } : {}), groups: listing.groups };
    } catch (error) { return llamaFailure(error); }
  });
  /** Re-lists the repository (sizes and checksums come from Hugging Face, never from the renderer) and returns the entries for `wanted` paths, in order. */
  const resolveHfFiles = (groups: readonly HfFileGroup[], wanted: readonly string[]): HfFile[] => {
    const all = new Map<string, HfFile>();
    for (const group of groups) for (const file of group.files) all.set(file.path, file);
    return wanted.map((file) => {
      const found = all.get(file);
      if (!found) throw new DownloadError("hf_not_found", `File not found in the repository: ${file}`);
      return found;
    });
  };
  handle("proxy:hfDownload", async (request: unknown): Promise<HfDownloadResult> => {
    const r = request as { repo?: unknown; revision?: unknown; files?: unknown } | null;
    if (typeof r !== "object" || r === null || typeof r.repo !== "string" || !HF_REPO.test(r.repo) || !shortString(r.revision, 200)
      || !Array.isArray(r.files) || r.files.length === 0 || r.files.length > 200 || !r.files.every((file) => shortString(file, 500))) return { ok: false, message: "Invalid download request" };
    const { repo, revision } = r;
    const files = [...new Set(r.files as string[])];
    await refreshLocalSettings();
    const modelsDir = llamaSettings!.modelsDir;
    const token = hfToken();
    const outcome = await runLlamaJob("model", async (signal) => {
      const listing = await listHfFiles({ repo, revision }, { fetch: fetch as typeof fetch, policy: HF_POLICY, signal, ...(token ? { token } : {}) });
      return downloadHfFiles({ repo, revision, files: resolveHfFiles(listing.groups, files), modelsDir, fetch: fetch as typeof fetch, signal, onProgress: llamaProgress, ...(token ? { token } : {}) });
    });
    return outcome.ok ? { ok: true, paths: outcome.value } : outcome;
  });
  handle("proxy:llamaScanModels", async (): Promise<LlamaScanResult> => {
    try {
      await refreshLocalSettings();
      const modelsDir = llamaSettings!.modelsDir;
      const scan = await scanModelsDir(modelsDir);
      return { ok: true, modelsDir, ...(scan.missingDir ? { missingDir: true } : {}), ...(scan.truncated ? { truncated: true } : {}), files: scan.files };
    } catch (error) { return llamaFailure(error); }
  });
  handle("proxy:pickModelFile", async (): Promise<PickResult> => {
    // A settings read error only loses the default folder of the dialog.
    let modelsDir = "";
    try { await refreshLocalSettings(); modelsDir = llamaSettings!.modelsDir; } catch { /* dialog opens without a start folder */ }
    const parent = win.browserWindow;
    const options: Electron.OpenDialogOptions = {
      title: "Select a model file", ...(modelsDir && fs.existsSync(modelsDir) ? { defaultPath: modelsDir } : {}), properties: ["openFile"],
      filters: [{ name: "GGUF", extensions: ["gguf"] }, { name: "All files", extensions: ["*"] }],
    };
    const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
    const picked = result.canceled ? undefined : result.filePaths[0];
    if (!picked) return {};
    const relative = modelsDir ? path.relative(path.resolve(modelsDir), picked) : "";
    return { path: relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative.split(path.sep).join("/") : picked };
  });
  handle("proxy:cancelLlamaDownload", (job: unknown): void => { if (job === "binary" || job === "model") llamaJobs[job]?.abort(); });
  handle("proxy:llamaStatus", async (): Promise<LlamaStatusView> => {
    await refreshLocalSettings();
    const llama = llamaSettings!;
    const binary = llamaBinary(llama);
    const managed = llama.binary.mode === "managed";
    const installed = llama.binary.installed;
    const profiles: LlamaStatusView["profiles"] = {};
    for (const profile of llama.profiles) {
      const gate = checkBuild(profile, { source: binary.source, ...(binary.build !== undefined ? { build: binary.build } : {}) });
      profiles[profile.id] = {
        build: gate.ok === true ? "ok" : gate.ok === false ? "too_old" : "unknown",
        ...(gate.ok === true ? {} : { buildMessage: gate.message }),
        missingFiles: checkLlamaFiles(profile, llama.modelsDir),
      };
    }
    return {
      binary: {
        mode: llama.binary.mode, ...(binary.command ? { command: binary.command } : {}), source: binary.source,
        ...(managed && installed ? { tag: installed.tag, backend: installed.backend } : {}),
        ...(binary.build !== undefined ? { build: binary.build } : {}),
        exists: Boolean(binary.command && fs.existsSync(binary.command)),
      },
      profiles,
      jobs: { binary: Boolean(llamaJobs.binary), model: Boolean(llamaJobs.model) },
    };
  });
  handle("proxy:activity", () => activityViews());
  handle("proxy:clearActivity", () => { proxy.activity.clear(); });
  handle("proxy:usage", () => usageView());
  handle("proxy:resetUsage", () => action(() => proxy.resetUsage()));
  handle("proxy:planLimits", () => proxy.planLimits.list());
  handle("proxy:refreshPlanLimits", (providerId: unknown, force: unknown) => typeof providerId === "string" ? proxy.planLimits.get(providerId, force === true) : { provider: "", state: "error" as const, windows: [], message: "Invalid provider" });
  handle("proxy:openPath", async (target: unknown): Promise<ActionResult> => {
    const known: Record<OpenTarget, () => Promise<string>> = {
      codexHome: async () => { const home = codexHomeView((await proxy.getSettings()).effective.providers.codex.isolatedHome); if (home.isolated) await fs.promises.mkdir(home.path, { recursive: true }); return shell.openPath(home.path); },
      settingsFile: async () => { const error = await shell.openPath(settingsPath); if (error) shell.showItemInFolder(settingsPath); return ""; },
    };
    if (typeof target !== "string" || !Object.hasOwn(known, target)) return { ok: false, message: "Invalid target" };
    try { const error = await known[target as OpenTarget](); return error ? { ok: false, message: error } : { ok: true }; } catch (error) { return failure(error); }
  });
  handle("proxy:pickExecutable", async () => {
    const parent = win.browserWindow;
    const options: Electron.OpenDialogOptions = { title: "Select the agent executable", properties: ["openFile"], filters: [{ name: "Executables", extensions: ["exe"] }, { name: "All files", extensions: ["*"] }] };
    const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
    return result.canceled || !result.filePaths[0] ? {} : { path: result.filePaths[0] };
  });
  handle("proxy:installAntigravity", async (): Promise<InstallResult> => {
    if (installing) return { ok: false, message: "An installation is already running." };
    installing = true;
    try {
      const info = await installAntigravity({ dataDir, fetch: net.fetch as unknown as typeof fetch, logger, onProgress: (progress) => win.send("proxy:installProgress", progress) });
      await proxy.applySettings({}); // restart so the provider picks up install.json
      return { ok: true, info: toInstallView(info) };
    } catch (error) {
      logger.error(`Antigravity install failed: ${error instanceof Error ? error.message : String(error)}`);
      return failure(error);
    } finally { installing = false; }
  });
  handle("proxy:acknowledgeTerms", (providerId: unknown): Promise<ActionResult> | ActionResult => {
    if (providerId !== "antigravity" && providerId !== "claude") return { ok: false, message: "Invalid provider" };
    return action(() => proxy.applySettings({ providers: { [providerId]: { termsAcknowledgedAt: new Date().toISOString() } } }));
  });
  handle("proxy:openLogs", async () => { await shell.openPath(logsDir); });
  handle("proxy:openPlayground", (): Promise<ActionResult> => action(() => openPlayground()));
  handle("proxy:copyText", (text: unknown) => { if (typeof text === "string" && text.length <= 10_000) clipboard.writeText(text); });
  handle("proxy:openExternal", async (url: unknown): Promise<ActionResult> => {
    if (typeof url !== "string") return { ok: false, message: "Invalid URL" };
    let parsed: URL;
    try { parsed = new URL(url); } catch { return { ok: false, message: "Invalid URL" }; }
    const allowed = parsed.protocol === "https:" && (
      (parsed.origin === "https://antigravity.google" && parsed.pathname === "/terms")
      || (parsed.origin === "https://www.anthropic.com" && parsed.pathname === "/legal/consumer-terms")
      || parsed.origin === "https://accounts.google.com"
      || (parsed.origin === "https://huggingface.co" && parsed.pathname.length > 1 && !parsed.username && !parsed.password));
    if (!allowed) return { ok: false, message: "This link is not allowed." };
    return action(() => shell.openExternal(parsed.href));
  });

  await refreshLocalSettings();
  const status = await proxy.start();
  applyLoginItem((await proxy.getSettings()).effective.server.launchAtLogin);
  if (status.server.state === "error") logger.warn(`Server failed to start: ${status.server.error?.message}`);

  const hidden = process.argv.includes("--hidden") || (process.platform !== "linux" && app.getLoginItemSettings().wasOpenedAtLogin);
  if (hidden) win.ensure(); else win.show();

  setupDevControl(win);
}

/** Dev/test hook (ACP_PROXY_DEV_DIR): create `quit` to quit cleanly, `dump` to write the settings page text to `dump.txt`,
 *  `shot` to save a screenshot (`shot.png`), `eval.js` to run a script in the settings page (result in `eval.txt`). Never set in normal use. */
function setupDevControl(win: SettingsWindow): void {
  const dir = process.env.ACP_PROXY_DEV_DIR;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  setInterval(() => {
    const quit = path.join(dir, "quit");
    if (fs.existsSync(quit)) { fs.rmSync(quit, { force: true }); app.quit(); }
    const dump = path.join(dir, "dump");
    if (fs.existsSync(dump)) {
      fs.rmSync(dump, { force: true });
      const contents = win.webContents;
      if (!contents) return;
      void contents.executeJavaScript("JSON.stringify({ url: location.href, api: typeof window.proxyApi, text: document.body.innerText })")
        .then((text: string) => fs.writeFileSync(path.join(dir, "dump.txt"), text), (error: unknown) => fs.writeFileSync(path.join(dir, "dump.txt"), `ERR ${String(error)}`));
    }
    if (app.isPackaged) return; // screenshots and script injection are for `app:dev` only
    const shot = path.join(dir, "shot");
    if (fs.existsSync(shot)) {
      fs.rmSync(shot, { force: true });
      void win.webContents?.capturePage().then((image) => fs.writeFileSync(path.join(dir, "shot.png"), image.toPNG()));
    }
    const script = path.join(dir, "eval.js");
    if (fs.existsSync(script)) {
      const code = fs.readFileSync(script, "utf8");
      fs.rmSync(script, { force: true });
      void win.webContents?.executeJavaScript(code).then((value: unknown) => fs.writeFileSync(path.join(dir, "eval.txt"), String(value)), (error: unknown) => fs.writeFileSync(path.join(dir, "eval.txt"), `ERR ${String(error)}`));
    }
  }, 400).unref();
}
