import { defaultSettings, resolveConfig, type McpServerSetting } from "./settings.js";

export type ModelId = string;

export interface ProxyConfig {
  host: string;
  port: number;
  apiKey?: string;
  maxBodyBytes: number;
  timeoutMs: number;
  workRoot: string;
  acpCommand?: string;
  acpArgs: string[];
  /** How long /v1/models waits for slow providers before answering from cache. */
  modelsWaitMs?: number;
  /** Drop sampling fields (temperature, top_p, penalties, seed) instead of rejecting the request. */
  ignoreSampling?: boolean;
  /** Keep an agent session after a completed turn and continue it when the next request extends the same conversation. */
  reuseSessions?: boolean;
  /** How long a turn suspended on a tool call waits for the client's result (shorter for agents that give up sooner). */
  toolResultTimeoutMs?: number;
  /** `settings.mcpServers`: the MCP servers a Responses request may name by label. */
  mcpServers?: Record<string, McpServerSetting>;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ProxyConfig {
  return resolveConfig(defaultSettings(), env).config;
}
