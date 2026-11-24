import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

// AAP-58: the official ggml-org ROCm build imports hipblas.dll / rocblas.dll but does not ship them. Without them the HIP backend
// fails to load silently and llama-server runs on the CPU. The AMD ROCm SDK has them; put its bin folder on the child's PATH.

export interface RocmFs { exists(file: string): boolean; readdir(dir: string): string[] }
const realFs: RocmFs = { exists: existsSync, readdir: (dir) => { try { return readdirSync(dir); } catch { return []; } } };
const SDK_ROOT = "C:\\Program Files\\AMD\\ROCm";

const versionParts = (name: string): number[] => name.split(".").map((part) => Number.parseInt(part, 10) || 0);
const newestFirst = (a: string, b: string): number => {
  const [left, right] = [versionParts(a), versionParts(b)];
  for (let i = 0; i < Math.max(left.length, right.length); i++) if ((left[i] ?? 0) !== (right[i] ?? 0)) return (right[i] ?? 0) - (left[i] ?? 0);
  return 0;
};

/** The ROCm SDK `bin` folder that has hipblas.dll: `%HIP_PATH%\bin`, else the newest `C:\Program Files\AMD\ROCm\<version>\bin`. */
export function findRocmSdkBin(env: NodeJS.ProcessEnv, fs: RocmFs = realFs): string | undefined {
  const candidates: string[] = [];
  if (env.HIP_PATH) candidates.push(path.win32.join(env.HIP_PATH, "bin"));
  for (const version of fs.readdir(SDK_ROOT).sort(newestFirst)) candidates.push(path.win32.join(SDK_ROOT, version, "bin"));
  return candidates.find((dir) => fs.exists(path.win32.join(dir, "hipblas.dll")));
}

/** The environment to start the llama-server `command` with. `added` is the folder put first on PATH (the build has ggml-hip.dll but no hipblas.dll). `env` itself is never changed. */
export function llamaChildEnv(command: string, env: NodeJS.ProcessEnv, fs: RocmFs = realFs): { env: NodeJS.ProcessEnv; added?: string } {
  const dir = path.win32.dirname(command);
  if (!fs.exists(path.win32.join(dir, "ggml-hip.dll")) || fs.exists(path.win32.join(dir, "hipblas.dll"))) return { env };
  const added = findRocmSdkBin(env, fs);
  if (!added) return { env };
  const key = Object.keys(env).find((name) => name.toLowerCase() === "path") ?? "Path";
  return { env: { ...env, [key]: env[key] ? `${added};${env[key]}` : added }, added };
}
