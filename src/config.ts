import os from "node:os";
import path from "node:path";

export const MODEL_IDS = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"] as const;
export type ModelId = (typeof MODEL_IDS)[number];

export interface ProxyConfig {
  host: string;
  port: number;
  apiKey?: string;
  maxBodyBytes: number;
  timeoutMs: number;
  workRoot: string;
  acpCommand?: string;
  acpArgs: string[];
}

function positiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ProxyConfig {
  return {
    host: env.PROXY_HOST || "127.0.0.1",
    port: positiveInt(env.PROXY_PORT, 8787),
    apiKey: env.PROXY_API_KEY || undefined,
    maxBodyBytes: positiveInt(env.PROXY_MAX_BODY_BYTES, 1024 * 1024),
    timeoutMs: positiveInt(env.PROXY_TIMEOUT_MS, 5 * 60 * 1000),
    workRoot: env.PROXY_WORK_ROOT || path.join(os.tmpdir(), "codex-subscription-proxy"),
    acpCommand: env.PROXY_ACP_COMMAND || undefined,
    acpArgs: env.PROXY_ACP_ARGS ? env.PROXY_ACP_ARGS.split(" ").filter(Boolean) : [],
  };
}
