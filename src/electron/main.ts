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
import { listMcpServers } from "../mcp-servers.js";
import { defaultSettingsPath } from "../settings.js";
import type { SecretCodec, SettingsPatch } from "../settings.js";
import { antigravityRegistration, installAntigravity, readInstallInfo } from "./antigravity.js";
import { SettingsWindow } from "./settings-window.js";
import { TrayController } from "./tray.js";
import type { ActionResult, ActivityView, FieldError, InstallInfoView, InstallResult, OpenTarget, SaveResult, StateView } from "../shared/ipc.js";

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

async function main(): Promise<void> {
  let controller: ProxyController | undefined;
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
      try { await Promise.race([controller?.stop().then(() => undefined), timeout]); } catch (error) { logger.error(`Error while stopping: ${String(error)}`); }
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
  const proxy = new ProxyController({
    settingsPath,
    logger,
    ...(secretCodec ? { secretCodec } : {}),
    registry: [codexRegistration, antigravityRegistration, claudeRegistration],
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
  handle("proxy:activity", () => activityViews());
  handle("proxy:clearActivity", () => { proxy.activity.clear(); });
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
      || parsed.origin === "https://accounts.google.com");
    if (!allowed) return { ok: false, message: "This link is not allowed." };
    return action(() => shell.openExternal(parsed.href));
  });

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
