import { contextBridge, ipcRenderer } from "electron";
import type { ProxyApi, StateView, InstallProgressView, ActivityView } from "../shared/ipc.js";

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
  logout: (providerId) => invoke("proxy:logout", providerId),
  getActivity: () => invoke("proxy:activity"),
  clearActivity: () => invoke("proxy:clearActivity"),
  onActivity: (callback) => subscribe<ActivityView[]>("proxy:activity", callback),
  openPath: (target) => invoke("proxy:openPath", target),
  pickExecutable: () => invoke("proxy:pickExecutable"),
  installAntigravity: () => invoke("proxy:installAntigravity"),
  onInstallProgress: (callback) => subscribe<InstallProgressView>("proxy:installProgress", callback),
  acknowledgeTerms: (providerId) => invoke("proxy:acknowledgeTerms", providerId),
  openLogs: () => invoke("proxy:openLogs"),
  copyText: (text) => invoke("proxy:copyText", text),
  openExternal: (url) => invoke("proxy:openExternal", url),
  onState: (callback) => subscribe<StateView>("proxy:state", callback),
};
contextBridge.exposeInMainWorld("proxyApi", api);
