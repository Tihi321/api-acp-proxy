import { contextBridge, ipcRenderer } from "electron";
import type { ProxyApi, StateView, InstallProgressView } from "../shared/ipc.js";

// Sandboxed preload: only `electron` may be required at runtime, so this file has no other runtime imports.
const invoke = <T,>(channel: string, ...args: unknown[]): Promise<T> => ipcRenderer.invoke(channel, ...args) as Promise<T>;
const subscribe = <T,>(channel: string, callback: (payload: T) => void): (() => void) => {
  const listener = (_event: Electron.IpcRendererEvent, payload: T): void => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => { ipcRenderer.removeListener(channel, listener); };
};

const api: ProxyApi = {
  getState: () => invoke("proxy:getState"),
  saveSettings: (patch) => invoke("proxy:saveSettings", patch),
  startServer: () => invoke("proxy:startServer"),
  stopServer: () => invoke("proxy:stopServer"),
  refreshModels: (providerId) => invoke("proxy:refreshModels", providerId),
  login: (providerId, methodId) => invoke("proxy:login", providerId, methodId),
  pickExecutable: () => invoke("proxy:pickExecutable"),
  installAntigravity: () => invoke("proxy:installAntigravity"),
  onInstallProgress: (callback) => subscribe<InstallProgressView>("proxy:installProgress", callback),
  acknowledgeAntigravityTerms: () => invoke("proxy:acknowledgeAntigravityTerms"),
  openLogs: () => invoke("proxy:openLogs"),
  copyText: (text) => invoke("proxy:copyText", text),
  openExternal: (url) => invoke("proxy:openExternal", url),
  onState: (callback) => subscribe<StateView>("proxy:state", callback),
};
contextBridge.exposeInMainWorld("proxyApi", api);
