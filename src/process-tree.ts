import { execFile, spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

/** Kills a child and all of its descendants: taskkill /T on Windows, the process group elsewhere (the child must be spawned detached). */
export async function killProcessTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (!pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      killer.once("error", () => { try { child.kill(); } catch { /* already gone */ } resolve(); });
      killer.once("close", () => resolve());
    });
    return;
  }
  try { process.kill(-pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* already gone */ } }
}

export interface OrphanSweepOptions {
  /** Directories whose executables may be swept (compared case-insensitively, path-segment aware). */
  dirs: string[];
  /** Only images with these file names (case-insensitive) are ever killed; protects shared directories. */
  imageNames: string[];
  /** Called with a human-readable line for each killed process. */
  log?: (message: string) => void;
}

/** CreatedMs is the creation time in Unix milliseconds, 0 when Windows does not report one. */
interface ProcessRow { ProcessId: number; ParentProcessId: number; ExecutablePath: string | null; CreatedMs: number; }

function listWindowsProcesses(): Promise<ProcessRow[]> {
  return new Promise((resolve) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath,@{n='CreatedMs';e={if ($_.CreationDate) { [DateTimeOffset]::new($_.CreationDate).ToUnixTimeMilliseconds() } else { 0 }}} | ConvertTo-Json -Compress"], { windowsHide: true, timeout: 20000, maxBuffer: 32 * 1024 * 1024, env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "PSModulePath")) }, (error, stdout) => {
      if (error) { resolve([]); return; }
      try {
        const parsed = JSON.parse(stdout) as ProcessRow | ProcessRow[];
        resolve(Array.isArray(parsed) ? parsed : [parsed]);
      } catch { resolve([]); }
    });
  });
}

/**
 * Best-effort cleanup of agent processes left behind by a crashed run (win32 only; elsewhere a no-op).
 * Kills a process only when its image lives under one of `dirs`, its file name is in `imageNames`, and its parent no longer exists
 * (an orphan), so a second live instance using the same install is left alone. Windows reuses pids, so a live process with the
 * parent's pid counts as the parent only when it was created no later than the child. Returns the number of process trees killed.
 */
export async function sweepOrphans(options: OrphanSweepOptions): Promise<number> {
  if (process.platform !== "win32" || !options.dirs.length) return 0;
  const rows = await listWindowsProcesses();
  if (!rows.length) return 0;
  const created = new Map(rows.map((row) => [row.ProcessId, row.CreatedMs || 0]));
  const parentAlive = (row: ProcessRow) => {
    const parentCreated = created.get(row.ParentProcessId);
    if (parentCreated === undefined) return false;
    // Unknown times keep the old, cautious answer; a parent created after its child is a reused pid.
    return !parentCreated || !row.CreatedMs || parentCreated <= row.CreatedMs;
  };
  const norm = (value: string) => path.resolve(value).toLowerCase();
  const dirs = options.dirs.map((dir) => norm(dir) + path.sep);
  const names = new Set(options.imageNames.map((name) => name.toLowerCase()));
  let killed = 0;
  for (const row of rows) {
    const image = row.ExecutablePath;
    if (!image || row.ProcessId === process.pid || parentAlive(row)) continue;
    if (!names.has(path.basename(image).toLowerCase())) continue;
    const lower = norm(image);
    if (!dirs.some((dir) => lower.startsWith(dir))) continue;
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(row.ProcessId), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      killer.once("error", () => resolve());
      killer.once("close", () => resolve());
    });
    killed++;
    options.log?.(`Killed orphaned process ${row.ProcessId} (${image}).`);
  }
  return killed;
}
