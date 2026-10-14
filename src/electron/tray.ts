import { clipboard, Menu, nativeImage, Notification, Tray } from "electron";
import path from "node:path";
import type { ControllerStatus } from "../controller.js";

export interface TrayActions {
  assetsDir: string;
  openSettings(): void;
  openLogs(): void;
  quit(): void;
  start(): void;
  stop(): void;
  refreshModels(): void;
}

type IconKind = "idle" | "running" | "error";

const stateLabels: Record<string, string> = {
  disabled: "off", stopped: "stopped", starting: "starting", ready: "ready", needs_login: "needs login",
  not_installed: "not installed", terms_required: "terms not accepted", error: "error",
};

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

  constructor(private readonly actions: TrayActions) {
    const load = (kind: IconKind) => nativeImage.createFromPath(path.join(actions.assetsDir, `tray-${kind}.png`));
    this.icons = { idle: load("idle"), running: load("running"), error: load("error") };
    this.tray = new Tray(this.icons.idle);
    this.tray.setToolTip("ACP Proxy");
    this.tray.on("click", () => actions.openSettings());
    this.tray.on("double-click", () => actions.openSettings());
  }

  destroy(): void { if (!this.tray.isDestroyed()) this.tray.destroy(); }

  update(status: ControllerStatus): void {
    const { server } = status;
    const kind: IconKind = server.state === "error" ? "error" : server.state === "running" ? "running" : "idle";
    this.tray.setImage(this.icons[kind]);
    const tooltip = server.state === "error" ? `ACP Proxy - ${describeServerError(server)}` : server.state === "running" ? `ACP Proxy - ${server.baseUrl}` : `ACP Proxy - ${server.state}`;
    this.tray.setToolTip(tooltip.slice(0, 120));
    this.tray.setContextMenu(this.buildMenu(status));
    this.maybeNotify(status);
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
      ...status.providers.map((provider): Electron.MenuItemConstructorOptions => ({
        label: `${provider.name}: ${stateLabels[provider.state] ?? provider.state}${provider.models.length ? ` (${provider.models.length} models)` : ""}`,
        enabled: false,
      })),
      { type: "separator" },
      running
        ? { label: "Stop server", click: () => this.actions.stop() }
        : { label: "Start server", click: () => this.actions.start() },
      ...(server.state === "error" ? [{ label: "Retry", click: () => this.actions.start() } satisfies Electron.MenuItemConstructorOptions] : []),
      { label: "Open settings…", click: () => this.actions.openSettings() },
      { type: "separator" },
      { label: "Copy base URL", enabled: server.state === "running", click: () => clipboard.writeText(baseUrl) },
      { label: "Refresh models", enabled: server.state === "running", click: () => this.actions.refreshModels() },
      { label: "Open logs folder", click: () => this.actions.openLogs() },
      { type: "separator" },
      { label: "Quit", click: () => this.actions.quit() },
    ];
    return Menu.buildFromTemplate(items);
  }
}
