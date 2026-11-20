import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import type { Logger } from "./logger.js";
import { killProcessTree } from "./process-tree.js";
import type { LocalServerId, LocalServerStatusView } from "./shared/ipc.js";

export const LOCAL_SERVER_IDS: readonly LocalServerId[] = ["gufo", "strata"];
export const LOCAL_SERVER_NAMES: Record<LocalServerId, string> = { gufo: "Gufo", strata: "Strata" };

export interface LocalServerSpec { id: LocalServerId; command: string; args: string; cwd: string; port: number }

/** `"<command>" <args>` with every `{port}` in args replaced by the port. */
export function commandLine(spec: LocalServerSpec): string {
  const args = spec.args.split("{port}").join(String(spec.port)).trim();
  return args ? `"${spec.command}" ${args}` : `"${spec.command}"`;
}

export interface LocalServerDeps {
  spawn?(spec: LocalServerSpec, line: string): ChildProcess;
  kill?(child: ChildProcess): Promise<void>;
  probe?(port: number, signal: AbortSignal): Promise<boolean>;
  pollMs?: number;
  startTimeoutMs?: number;
  maxLogLines?: number;
  logger?: Logger;
}

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const LOG_EMIT_MS = 250;
const EXIT_WAIT_MS = 5000;
const PROBE_TIMEOUT_MS = 2000;

function defaultSpawn(spec: LocalServerSpec, line: string): ChildProcess {
  const stdio: ["ignore", "pipe", "pipe"] = ["ignore", "pipe", "pipe"];
  if (process.platform === "win32") {
    // Node refuses to spawn .bat/.cmd directly, so go through cmd.exe (hidden, no console window).
    return spawn("cmd.exe", ["/d", "/s", "/c", `"${line}"`], { cwd: spec.cwd, windowsHide: true, windowsVerbatimArguments: true, stdio, env: process.env });
  }
  return spawn("/bin/sh", ["-c", line], { cwd: spec.cwd, detached: true, stdio, env: process.env });
}

async function defaultProbe(port: number, signal: AbortSignal): Promise<boolean> {
  const timeout = AbortSignal.timeout(PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/models`, { signal: AbortSignal.any([signal, timeout]) });
    await response.body?.cancel().catch(() => undefined);
    return response.ok;
  } catch {
    return false;
  }
}

interface Run {
  child: ChildProcess;
  stopRequested: boolean;
  failure?: string;
  exited: Promise<void>;
  poll?: NodeJS.Timeout;
  timeout?: NodeJS.Timeout;
  probing: boolean;
  abort: AbortController;
  partial: Record<"stdout" | "stderr", string>;
}

interface Entry { view: LocalServerStatusView; run?: Run; logTimer?: NodeJS.Timeout; startGen: number }

export class LocalServerManager extends EventEmitter {
  private readonly entries = new Map<LocalServerId, Entry>();
  private readonly spawnFn: (spec: LocalServerSpec, line: string) => ChildProcess;
  private readonly killFn: (child: ChildProcess) => Promise<void>;
  private readonly probeFn: (port: number, signal: AbortSignal) => Promise<boolean>;
  private readonly pollMs: number;
  private readonly startTimeoutMs: number;
  private readonly maxLogLines: number;
  private readonly logger?: Logger;
  private closed = false;

  constructor(deps: LocalServerDeps = {}) {
    super();
    this.spawnFn = deps.spawn ?? defaultSpawn;
    this.killFn = deps.kill ?? killProcessTree;
    this.probeFn = deps.probe ?? defaultProbe;
    this.pollMs = deps.pollMs ?? 1000;
    this.startTimeoutMs = deps.startTimeoutMs ?? 600_000;
    this.maxLogLines = deps.maxLogLines ?? 200;
    this.logger = deps.logger;
    for (const id of LOCAL_SERVER_IDS) this.entries.set(id, { view: { id, name: LOCAL_SERVER_NAMES[id], state: "stopped", log: [] }, startGen: 0 });
  }

  list(): LocalServerStatusView[] {
    return LOCAL_SERVER_IDS.map((id) => { const view = this.entries.get(id)!.view; return { ...view, log: [...view.log] }; });
  }

  async start(spec: LocalServerSpec): Promise<void> {
    const entry = this.entries.get(spec.id);
    if (!entry) throw new Error(`Unknown local server "${String(spec.id)}".`);
    if (!spec.command.trim()) throw new Error(`${LOCAL_SERVER_NAMES[spec.id]} has no command configured.`);
    if (!spec.cwd || !existsSync(spec.cwd)) throw new Error(`Working directory does not exist: ${spec.cwd || "(empty)"}`);
    if (this.closed) return;
    if (entry.run || entry.view.state === "starting" || entry.view.state === "ready") return;
    // Claim the slot synchronously so a concurrent start of the same id is a no-op.
    entry.view = { ...entry.view, state: "starting", port: spec.port, error: undefined, pid: undefined, readyAt: undefined, startedAt: undefined, commandLine: commandLine(spec), log: [] };
    const gen = ++entry.startGen;
    this.emitChange();
    try {
      await Promise.all(LOCAL_SERVER_IDS.filter((id) => { const other = this.entries.get(id)!; return id !== spec.id && (other.run || other.view.state === "starting"); }).map((id) => this.stop(id)));
      if (await this.probeOnce(spec.port)) throw new Error(`Port ${spec.port} already answers (a server started outside the app?). Stop it first.`);
      // stop()/stopAll() during this pre-spawn phase bumped startGen: do not spawn, the state is already stopped.
      if (entry.startGen !== gen || this.closed) return;
      const line = commandLine(spec);
      let child: ChildProcess;
      try { child = this.spawnFn(spec, line); } catch (error) { throw new Error(error instanceof Error ? error.message : String(error)); }
      this.attach(entry, spec, child);
    } catch (error) {
      if (entry.startGen !== gen) return;
      if (!entry.run) entry.view = { ...entry.view, state: "stopped", error: undefined };
      this.emitChange();
      throw error;
    }
  }

  async stop(id: LocalServerId): Promise<void> {
    const entry = this.entries.get(id);
    const run = entry?.run;
    if (!entry) return;
    if (!run) {
      // A start still in its pre-spawn phase (stopping the other server, port probe): cancel it.
      if (entry.view.state === "starting") {
        entry.startGen++;
        entry.view = { ...entry.view, state: "stopped", error: undefined };
        this.emitChange();
      }
      return;
    }
    run.stopRequested = true;
    this.clearTimers(run);
    run.abort.abort();
    try { await this.killFn(run.child); } catch (error) { this.logger?.warn(`${id}: kill failed: ${error instanceof Error ? error.message : String(error)}`); }
    let waitTimer: NodeJS.Timeout | undefined;
    await Promise.race([run.exited, new Promise<void>((resolve) => { waitTimer = setTimeout(resolve, EXIT_WAIT_MS); })]);
    if (waitTimer) clearTimeout(waitTimer);
    if (entry.run === run) this.finish(entry, run, { state: "stopped" });
  }

  async stopAll(): Promise<void> {
    await Promise.all(LOCAL_SERVER_IDS.map((id) => this.stop(id)));
  }

  /** Terminal: stops everything and refuses any later start (used on quit so a late Start cannot orphan a process). */
  async close(): Promise<void> {
    this.closed = true;
    await this.stopAll();
  }

  private async probeOnce(port: number): Promise<boolean> {
    const controller = new AbortController();
    try { return await this.probeFn(port, controller.signal); } catch { return false; } finally { controller.abort(); }
  }

  private attach(entry: Entry, spec: LocalServerSpec, child: ChildProcess): void {
    let markExited!: () => void;
    const exited = new Promise<void>((resolve) => { markExited = resolve; });
    const run: Run = { child, stopRequested: false, exited, probing: false, abort: new AbortController(), partial: { stdout: "", stderr: "" } };
    entry.run = run;
    entry.view = { ...entry.view, state: "starting", pid: child.pid, startedAt: Date.now() };
    this.emitChange();

    for (const name of ["stdout", "stderr"] as const) {
      const stream = child[name];
      if (!stream) continue;
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => this.onData(entry, run, name, chunk));
      stream.on("error", () => undefined);
    }
    child.once("error", (error) => {
      if (entry.run !== run) return;
      this.finish(entry, run, { state: "error", error: error.message });
      markExited();
    });
    child.once("exit", (code, signal) => {
      markExited();
      if (entry.run !== run) return;
      this.flushPartial(entry, run);
      if (run.failure) this.finish(entry, run, { state: "error", error: run.failure });
      else if (run.stopRequested || code === 0) this.finish(entry, run, { state: "stopped" });
      else {
        const last = entry.view.log[entry.view.log.length - 1];
        this.finish(entry, run, { state: "error", error: `exited with ${code === null ? `signal ${signal}` : `code ${code}`}${last ? `: ${last}` : ""}` });
      }
    });

    run.poll = setInterval(() => {
      if (run.probing || entry.run !== run || entry.view.state !== "starting") return;
      run.probing = true;
      this.probeFn(spec.port, run.abort.signal).catch(() => false).then((ok) => {
        run.probing = false;
        if (ok && entry.run === run && entry.view.state === "starting" && !run.stopRequested) {
          if (run.poll) clearInterval(run.poll);
          if (run.timeout) clearTimeout(run.timeout);
          entry.view = { ...entry.view, state: "ready", readyAt: Date.now() };
          this.emitChange();
        }
      });
    }, this.pollMs);
    run.timeout = setTimeout(() => {
      if (entry.run !== run || entry.view.state !== "starting") return;
      run.failure = `did not answer on port ${spec.port} within ${Math.round(this.startTimeoutMs / 60000 * 10) / 10} min`;
      this.clearTimers(run);
      run.abort.abort();
      void this.killFn(child).catch(() => undefined).then(() => {
        // If the exit event never arrives, still report the failure.
        setTimeout(() => { if (entry.run === run) this.finish(entry, run, { state: "error", error: run.failure }); }, EXIT_WAIT_MS).unref();
      });
    }, this.startTimeoutMs);
  }

  private finish(entry: Entry, run: Run, patch: { state: "stopped" | "error"; error?: string }): void {
    this.clearTimers(run);
    run.abort.abort();
    if (entry.run === run) entry.run = undefined;
    entry.view = { ...entry.view, state: patch.state, error: patch.error, pid: undefined };
    if (patch.error) this.logger?.warn(`${entry.view.id}: ${patch.error}`);
    this.emitChange();
  }

  private clearTimers(run: Run): void {
    if (run.poll) clearInterval(run.poll);
    if (run.timeout) clearTimeout(run.timeout);
    run.poll = undefined;
    run.timeout = undefined;
  }

  private onData(entry: Entry, run: Run, name: "stdout" | "stderr", chunk: string): void {
    const parts = (run.partial[name] + chunk).split(/\r?\n/);
    run.partial[name] = parts.pop() ?? "";
    if (parts.length) this.pushLines(entry, parts);
  }

  private flushPartial(entry: Entry, run: Run): void {
    const rest = [run.partial.stdout, run.partial.stderr].filter((line) => line.length);
    run.partial = { stdout: "", stderr: "" };
    if (rest.length) this.pushLines(entry, rest);
  }

  private pushLines(entry: Entry, lines: string[]): void {
    const log = [...entry.view.log, ...lines.map((line) => line.replace(ANSI, ""))];
    entry.view = { ...entry.view, log: log.length > this.maxLogLines ? log.slice(log.length - this.maxLogLines) : log };
    if (entry.logTimer) return;
    entry.logTimer = setTimeout(() => { entry.logTimer = undefined; this.emitChange(); }, LOG_EMIT_MS);
    entry.logTimer.unref();
  }

  private emitChange(): void {
    this.emit("change", this.list());
  }
}
