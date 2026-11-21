import { execFile } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import { downloadToFile, extractZip, guardedFetch, safeEntryPath, type HostPolicy } from "../download.js";
import { silentLogger, type Logger } from "../logger.js";

export const ANTIGRAVITY_REGISTRY_URL = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
export const ANTIGRAVITY_AGENT_ID = "antigravity-acp";
export const ALLOWED_HOSTS: readonly string[] = ["cdn.agentclientprotocol.com", "dl.google.com"];
const MAX_EXTRACTED_BYTES = 2 * 1024 * 1024 * 1024;

export { safeEntryPath };

/** Maps the installer's test knobs to a download host policy. */
function policyFor(test: InstallerTestOptions | undefined): HostPolicy {
  return { hosts: test?.allowedHosts ?? ALLOWED_HOSTS, ...(test?.allowHttp ? { allowHttp: true } : {}) };
}

export interface InstallProgress { phase: "registry" | "download" | "extract" | "verify" | "done"; received?: number; total?: number; message?: string }
export interface InstallInfo { version: string; url: string; sha256: string; command: string; args: string[]; dir: string; installedAt: string; signature?: { status: string; signer?: string } }

/** Knobs that exist for tests only; production code must not set them. */
export interface InstallerTestOptions {
  allowedHosts?: readonly string[];
  allowHttp?: boolean;
  /** Registry platform key, e.g. "windows-x86_64"; defaults to the current platform. */
  platformKey?: string;
  /** Skips the Authenticode check. */
  skipSignature?: boolean;
}

export interface InstallOptions {
  dataDir: string;
  fetch?: typeof fetch;
  logger?: Logger;
  onProgress?: (p: InstallProgress) => void;
  registryUrl?: string;
  signal?: AbortSignal;
  testOptions?: InstallerTestOptions;
}

interface BinaryEntry { archive: string; cmd: string; args?: string[] }
export interface RegistryEntry { version: string; url: string; cmd: string; args: string[] }

/** `<dataDir>/agents/antigravity-acp` */
export function agentsDir(dataDir: string): string { return path.join(dataDir, "agents", ANTIGRAVITY_AGENT_ID); }
const installFile = (dataDir: string) => path.join(agentsDir(dataDir), "install.json");

export async function readInstallInfo(dataDir: string): Promise<InstallInfo | undefined> {
  try {
    const parsed = JSON.parse(await fsp.readFile(installFile(dataDir), "utf8")) as Partial<InstallInfo>;
    if (typeof parsed.command !== "string" || typeof parsed.version !== "string") return undefined;
    return { version: parsed.version, url: String(parsed.url ?? ""), sha256: String(parsed.sha256 ?? ""), command: parsed.command, args: Array.isArray(parsed.args) ? parsed.args.map(String) : [], dir: String(parsed.dir ?? path.dirname(parsed.command)), installedAt: String(parsed.installedAt ?? ""), ...(parsed.signature ? { signature: parsed.signature } : {}) };
  } catch { return undefined; }
}

/** Registry platform keys to try for this machine, most specific first. */
export function platformKeys(platform: string = process.platform, arch: string = process.arch): string[] {
  if (platform === "win32" && arch === "x64") return ["windows-x86_64"];
  if (platform === "win32" && arch === "arm64") return ["windows-aarch64", "windows-arm64"];
  return [];
}

/** Picks the antigravity-acp binary distribution for a platform key from a parsed registry document. */
export function resolveRegistryEntry(registry: unknown, platformKeyCandidates: string[]): RegistryEntry {
  const agents = (registry as { agents?: unknown } | null)?.agents;
  if (!Array.isArray(agents)) throw new Error("The ACP registry response has no agents list.");
  const agent = agents.find((entry) => (entry as { id?: unknown } | null)?.id === ANTIGRAVITY_AGENT_ID) as { version?: unknown; distribution?: { binary?: Record<string, BinaryEntry> } } | undefined;
  if (!agent) throw new Error(`The ACP registry does not list '${ANTIGRAVITY_AGENT_ID}'.`);
  const binary = agent.distribution?.binary;
  const key = platformKeyCandidates.find((candidate) => binary?.[candidate]);
  const entry = key ? binary?.[key] : undefined;
  if (!entry || typeof entry.archive !== "string" || typeof entry.cmd !== "string") throw new Error(`The ACP registry has no ${ANTIGRAVITY_AGENT_ID} build for this platform (${platformKeyCandidates.join(", ") || `${process.platform}-${process.arch}`}).`);
  if (typeof agent.version !== "string" || !/^[A-Za-z0-9._+-]+$/.test(agent.version)) throw new Error("The ACP registry returned an invalid agent version.");
  return { version: agent.version, url: entry.archive, cmd: entry.cmd, args: Array.isArray(entry.args) ? entry.args.map(String) : [] };
}

/** Windows PowerShell 5.1 cannot load its modules when it inherits the PSModulePath of PowerShell 7, so that variable is dropped. */
function powershellEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  delete env.PSModulePath;
  return env;
}

function checkSignature(file: string): Promise<{ status: string; signer?: string }> {
  const script = "$s = Get-AuthenticodeSignature -LiteralPath $env:AGY_FILE; @{ status = [string]$s.Status; signer = if ($s.SignerCertificate) { $s.SignerCertificate.Subject } else { $null } } | ConvertTo-Json -Compress";
  return new Promise((resolve) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 60000, env: powershellEnv({ AGY_FILE: file }) }, (error, stdout) => {
      if (error) { resolve({ status: "Unknown", signer: `signature check failed: ${error.message}` }); return; }
      try {
        const parsed = JSON.parse(stdout) as { status?: string; signer?: string | null };
        resolve({ status: parsed.status || "Unknown", ...(parsed.signer ? { signer: parsed.signer } : {}) });
      } catch { resolve({ status: "Unknown" }); }
    });
  });
}

/** Downloads the Antigravity ACP server from the ACP registry into `<dataDir>/agents/antigravity-acp/<version>` and records it in install.json. */
export async function installAntigravity(opts: InstallOptions): Promise<InstallInfo> {
  const log = (opts.logger ?? silentLogger).child("antigravity-installer");
  const fetchImpl = opts.fetch ?? fetch;
  const test = opts.testOptions;
  const emit = (progress: InstallProgress) => { try { opts.onProgress?.(progress); } catch { /* progress listeners must not break the install */ } };
  const base = agentsDir(opts.dataDir);
  await fsp.mkdir(base, { recursive: true });

  emit({ phase: "registry", message: "Fetching the ACP registry" });
  const registryResponse = await guardedFetch(fetchImpl, opts.registryUrl ?? ANTIGRAVITY_REGISTRY_URL, policyFor(test), { ...(opts.signal ? { signal: opts.signal } : {}) });
  const entry = resolveRegistryEntry(await registryResponse.json(), test?.platformKey ? [test.platformKey] : platformKeys());
  log.info(`Installing ${ANTIGRAVITY_AGENT_ID} ${entry.version} from ${entry.url}`);

  const zipFile = path.join(base, `.download-${entry.version}-${process.pid}.zip`);
  const partial = path.join(base, `${entry.version}.partial`);
  const finalDir = path.join(base, entry.version);
  try {
    emit({ phase: "download", received: 0, message: entry.url });
    const response = await guardedFetch(fetchImpl, entry.url, policyFor(test), { ...(opts.signal ? { signal: opts.signal } : {}) });
    const { sha256 } = await downloadToFile(response, zipFile, { onProgress: (received, total) => emit({ phase: "download", received, ...(total ? { total } : {}) }), ...(opts.signal ? { signal: opts.signal } : {}) });

    emit({ phase: "extract", received: 0 });
    await fsp.rm(partial, { recursive: true, force: true });
    let lastExtractEmit = 0;
    await extractZip(zipFile, partial, { maxBytes: MAX_EXTRACTED_BYTES, onProgress: (received, total) => { const now = Date.now(); if (received >= total || now - lastExtractEmit > 100) { lastExtractEmit = now; emit({ phase: "extract", received, total }); } } });
    const command = safeEntryPath(partial, entry.cmd);
    if (!await fsp.access(command).then(() => true, () => false)) throw new Error(`The archive does not contain '${entry.cmd}'.`);

    await fsp.rm(finalDir, { recursive: true, force: true });
    await fsp.rename(partial, finalDir);
    const installedCommand = path.join(finalDir, path.relative(partial, command));

    emit({ phase: "verify", message: "Checking the Authenticode signature" });
    let signature: InstallInfo["signature"];
    if (process.platform === "win32" && !test?.skipSignature) {
      signature = await checkSignature(installedCommand);
      if (signature.status !== "Valid" || !/CN=Google LLC/i.test(signature.signer ?? "")) log.warn(`Unexpected Authenticode result for ${installedCommand}: ${signature.status} ${signature.signer ?? ""}`.trim());
      else log.info(`Authenticode signature is valid (${signature.signer}).`);
    }

    const info: InstallInfo = { version: entry.version, url: entry.url, sha256, command: installedCommand, args: entry.args, dir: finalDir, installedAt: new Date().toISOString(), ...(signature ? { signature } : {}) };
    const tmp = `${installFile(opts.dataDir)}.tmp-${process.pid}`;
    await fsp.writeFile(tmp, JSON.stringify(info, null, 2) + "\n");
    await fsp.rename(tmp, installFile(opts.dataDir));

    // Older versions are no longer referenced; removal is best effort (a running server may still lock its files).
    for (const name of await fsp.readdir(base).catch(() => [] as string[])) {
      if (name !== entry.version && !name.startsWith(".") && name !== "install.json" && !name.includes(".tmp-")) await fsp.rm(path.join(base, name), { recursive: true, force: true }).catch(() => undefined);
    }
    emit({ phase: "done", message: `Installed ${entry.version}` });
    return info;
  } catch (error) {
    await fsp.rm(partial, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  } finally {
    await fsp.rm(zipFile, { force: true }).catch(() => undefined);
  }
}
