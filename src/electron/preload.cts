import { contextBridge, ipcRenderer } from "electron";
import type { ProxyApi, StateView, InstallProgressView, ActivityView, UsageView, LocalServerStatusView, LlamaProgressView } from "../shared/ipc.js";

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
  getUsage: () => invoke("proxy:usage"),
  resetUsage: () => invoke("proxy:resetUsage"),
  onUsage: (callback) => subscribe<UsageView>("proxy:usage", callback),
  getPlanLimits: () => invoke("proxy:planLimits"),
  refreshPlanLimits: (providerId, force) => invoke("proxy:refreshPlanLimits", providerId, force),
  getLocalServers: () => invoke("proxy:localServers"),
  startLocalServer: (id, profileId) => invoke("proxy:startLocalServer", id, profileId),
  restoreGufoPresets: (profiles) => invoke("proxy:restoreGufoPresets", profiles),
  stopLocalServer: (id) => invoke("proxy:stopLocalServer", id),
  onLocalServers: (callback) => subscribe<LocalServerStatusView[]>("proxy:localServers", callback),
  openPath: (target) => invoke("proxy:openPath", target),
  pickExecutable: () => invoke("proxy:pickExecutable"),
  installAntigravity: () => invoke("proxy:installAntigravity"),
  onInstallProgress: (callback) => subscribe<InstallProgressView>("proxy:installProgress", callback),
  acknowledgeTerms: (providerId) => invoke("proxy:acknowledgeTerms", providerId),
  openLogs: () => invoke("proxy:openLogs"),
  openPlayground: () => invoke("proxy:openPlayground"),
  copyText: (text) => invoke("proxy:copyText", text),
  openExternal: (url) => invoke("proxy:openExternal", url),
  onState: (callback) => subscribe<StateView>("proxy:state", callback),
  pickDirectory: (title, defaultPath) => invoke("proxy:pickDirectory", title, defaultPath),
  llamaReleases: (source, refresh) => invoke("proxy:llamaReleases", source, refresh),
  installLlama: (request) => invoke("proxy:installLlama", request),
  checkLlamaExecutable: (path) => invoke("proxy:checkLlamaExecutable", path),
  hfListFiles: (link) => invoke("proxy:hfListFiles", link),
  hfDownload: (request) => invoke("proxy:hfDownload", request),
  downloadProfileModels: (profileId) => invoke("proxy:downloadProfileModels", profileId),
  cancelLlamaDownload: (job) => invoke("proxy:cancelLlamaDownload", job),
  restoreLlamaPresets: (profiles) => invoke("proxy:restoreLlamaPresets", profiles),
  llamaStatus: () => invoke("proxy:llamaStatus"),
  onLlamaProgress: (callback) => subscribe<LlamaProgressView>("proxy:llamaProgress", callback),
};
contextBridge.exposeInMainWorld("proxyApi", api);
