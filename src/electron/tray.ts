import { clipboard, Menu, nativeImage, Notification, Tray } from "electron";
import path from "node:path";
import { describeActivity } from "../activity.js";
import type { ControllerStatus } from "../controller.js";

export interface TrayActions {
  assetsDir: string;
  openSettings(): void;
  openLogs(): void;
  /** Opens the playground page in the browser. */
  openPlayground(): void;
  quit(): void;
  start(): void;
  stop(): void;
  refreshModels(): void;
  /** Starts the sign-in of a provider (the tray's "Log in to X" item). */
  login(providerId: string): void;
}

type IconKind = "idle" | "running" | "warn" | "error";

const stateLabels: Record<string, string> = {
  disabled: "off", stopped: "stopped", starting: "starting", ready: "ready", needs_login: "needs login",
  not_installed: "not installed", terms_required: "terms not accepted", error: "error",
};

/** One tray menu line per provider: "Claude: ready - me@example.com (3 models)". */
export function describeProvider(provider: ControllerStatus["providers"][number]): string {
  return `${provider.name}: ${stateLabels[provider.state] ?? provider.state}${provider.account ? ` - ${provider.account}` : ""}${provider.models.length ? ` (${provider.models.length} models)` : ""}`;
}

/** Text for the error line, e.g. "Port 8787 in use". */
export function describeServerError(status: ControllerStatus["server"]): string {
  if (status.error?.code === "EADDRINUSE") return `Port ${status.port} in use`;
  if (status.error?.code === "EACCES") return `No permission to use port ${status.port}`;
  return status.error?.message ?? "Server error";
}

export class TrayController {
  private readonly tray: Tray;
  private readonly icons: Record<IconKind, Electron.NativeImage>;
  private notifiedKey?: string;
  private status?: ControllerStatus;
  private summary: { today: number; lastAt?: number } = { today: 0 };
  /** Providers a request hit while they needed login (one notification each, and the warning icon, until they are signed in). */
  private readonly hit = new Set<string>();

  constructor(private readonly actions: TrayActions) {
    const load = (kind: IconKind) => nativeImage.createFromPath(path.join(actions.assetsDir, `tray-${kind}.png`));
    this.icons = { idle: load("idle"), running: load("running"), warn: load("warn"), error: load("error") };
    // "last 2 min ago" ages on its own.
    setInterval(() => this.refresh(), 30_000).unref();
    this.tray = new Tray(this.icons.idle);
    this.tray.setToolTip("ACP Proxy");
    this.tray.on("click", () => actions.openSettings());
    this.tray.on("double-click", () => actions.openSettings());
  }

  destroy(): void { if (!this.tray.isDestroyed()) this.tray.destroy(); }

  update(status: ControllerStatus): void {
    this.status = status;
    for (const id of [...this.hit]) if (status.providers.find((provider) => provider.id === id)?.state !== "needs_login") this.hit.delete(id);
    this.refresh();
    this.maybeNotify(status);
  }

  /** The request log changed (the tooltip says how many requests came in today and when the last one did). */
  setActivity(summary: { today: number; lastAt?: number }): void { this.summary = summary; this.refresh(); }

  /** A request hit a provider that needs login: one notification (and the warning icon) until it is signed in. */
  loginNeeded(providerId: string, name: string): void {
    if (this.hit.has(providerId)) return;
    this.hit.add(providerId);
    this.refresh();
    if (!Notification.isSupported()) return;
    const notification = new Notification({ title: "ACP Proxy", body: `${name} needs login. Click to open the settings and log in.` });
    notification.on("click", () => this.actions.openSettings());
    notification.show();
  }

  private refresh(): void {
    const status = this.status;
    if (!status || this.tray.isDestroyed()) return;
    const { server } = status;
    // Green while running; the warning tint only after a request ran into a provider that needs login.
    const kind: IconKind = server.state === "error" ? "error" : server.state === "running" ? (this.hit.size ? "warn" : "running") : "idle";
    this.tray.setImage(this.icons[kind]);
    const head = server.state === "error" ? `ACP Proxy - ${describeServerError(server)}` : server.state === "running" ? `ACP Proxy - ${server.baseUrl}` : `ACP Proxy - ${server.state}`;
    const needing = status.providers.filter((provider) => provider.state === "needs_login").map((provider) => provider.name);
    this.tray.setToolTip([head, describeActivity(this.summary), ...(needing.length ? [`Needs login: ${needing.join(", ")}`] : [])].join("\n").slice(0, 127));
    this.tray.setContextMenu(this.buildMenu(status));
  }

  private maybeNotify(status: ControllerStatus): void {
    const { server } = status;
    if (server.state !== "error") { if (server.state !== "starting") this.notifiedKey = undefined; return; }
    const key = `${server.error?.code ?? "error"}:${server.port}`;
    if (this.notifiedKey === key) return;
    this.notifiedKey = key;
    if (!Notification.isSupported()) return;
    const notification = new Notification({ title: "ACP Proxy", body: `${describeServerError(server)}. Open settings to pick another port, or retry from the tray menu.` });
    notification.on("click", () => this.actions.openSettings());
    notification.show();
  }

  private buildMenu(status: ControllerStatus): Menu {
    const { server } = status;
    const header = server.state === "running" ? `Running - ${server.baseUrl}` : server.state === "error" ? describeServerError(server) : `Server ${server.state}`;
    const baseUrl = server.baseUrl ?? `http://${server.host}:${server.port}/v1`;
    const running = server.state === "running" || server.state === "starting";
    const items: Electron.MenuItemConstructorOptions[] = [
      { label: header, enabled: false },
      ...status.providers.map((provider): Electron.MenuItemConstructorOptions => ({ label: describeProvider(provider), enabled: false })),
      { type: "separator" },
      { label: describeActivity(this.summary), enabled: false },
      ...status.providers.filter((provider) => provider.state === "needs_login").map((provider): Electron.MenuItemConstructorOptions => ({ label: `Log in to ${provider.name}`, enabled: server.state === "running", click: () => this.actions.login(provider.id) })),
      { type: "separator" },
      running
        ? { label: "Stop server", click: () => this.actions.stop() }
        : { label: "Start server", click: () => this.actions.start() },
      ...(server.state === "error" ? [{ label: "Retry", click: () => this.actions.start() } satisfies Electron.MenuItemConstructorOptions] : []),
      { label: "Open settings…", click: () => this.actions.openSettings() },
      { type: "separator" },
      { label: "Open playground", enabled: server.state === "running", click: () => this.actions.openPlayground() },
      { label: "Copy base URL", enabled: server.state === "running", click: () => clipboard.writeText(baseUrl) },
      { label: "Refresh models", enabled: server.state === "running", click: () => this.actions.refreshModels() },
      { label: "Open logs folder", click: () => this.actions.openLogs() },
      { type: "separator" },
      { label: "Quit", click: () => this.actions.quit() },
    ];
    return Menu.buildFromTemplate(items);
  }
}
