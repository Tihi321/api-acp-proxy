import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import type { Logger } from "./logger.js";
import { killProcessTree } from "./process-tree.js";
import type { LocalServerId, LocalServerStatusView } from "./shared/ipc.js";

export const LOCAL_SERVER_IDS: readonly LocalServerId[] = ["gufo", "strata", "llama"];
export const LOCAL_SERVER_NAMES: Record<LocalServerId, string> = { gufo: "Gufo", strata: "Strata", llama: "Llama.cpp" };

export interface LocalServerSpec { id: LocalServerId; command: string; args: string; cwd: string; port: number; profile?: string; startTimeoutMs?: number }

/** `"<command>" <args>` with every `{port}` in args replaced by the port. */
export function commandLine(spec: LocalServerSpec): string {
  const args = spec.args.split("{port}").join(String(spec.port)).trim();
  return args ? `"${spec.command}" ${args}` : `"${spec.command}"`;
}

const PATH_FLAGS = /(?:^|\s)(?:-m|-md|-mm|--(?:model|model-draft|spec-draft-model|mtp-model|dspark-model|dflash-model|mmproj))\s+("[^"]*"|\S+)/g;

/** Throws when a model-file flag in the args points at a path (drive letter or leading `/`) that does not exist. IDs are not checked. */
function checkModelFiles(spec: LocalServerSpec): void {
  const args = spec.args.split("{port}").join(String(spec.port));
  for (const match of args.matchAll(PATH_FLAGS)) {
    const value = (match[1] ?? "").replace(/^"|"$/g, "");
    if (/^([A-Za-z]:|\/)/.test(value) && !existsSync(value)) throw new Error(`File not found: ${value} (is the model installed?)`);
  }
}

export interface LocalServerDeps {
  spawn?(spec: LocalServerSpec, line: string): ChildProcess;
  kill?(child: ChildProcess): Promise<void>;
  probe?(port: number, signal: AbortSignal): Promise<boolean>;
  pollMs?: number;
  /** Port-release wait after stopping a server: poll interval and ceiling. */
  releasePollMs?: number;
  releaseTimeoutMs?: number;
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

interface Entry { view: LocalServerStatusView; run?: Run; logTimer?: NodeJS.Timeout; startGen: number; /** Generation of the latest start() claim; a stop() bumps startGen without it. */ claimGen: number }

/** A start that a later start() of the same server replaced before it spawned. */
class SupersededError extends Error {}

export class LocalServerManager extends EventEmitter {
  private readonly entries = new Map<LocalServerId, Entry>();
  private readonly spawnFn: (spec: LocalServerSpec, line: string) => ChildProcess;
  private readonly killFn: (child: ChildProcess) => Promise<void>;
  private readonly probeFn: (port: number, signal: AbortSignal) => Promise<boolean>;
  private readonly pollMs: number;
  private readonly startTimeoutMs: number;
  private readonly releasePollMs: number;
  private readonly releaseTimeoutMs: number;
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
    this.releasePollMs = deps.releasePollMs ?? 500;
    this.releaseTimeoutMs = deps.releaseTimeoutMs ?? 30_000;
    this.maxLogLines = deps.maxLogLines ?? 200;
    this.logger = deps.logger;
    for (const id of LOCAL_SERVER_IDS) this.entries.set(id, { view: { id, name: LOCAL_SERVER_NAMES[id], state: "stopped", log: [] }, startGen: 0, claimGen: 0 });
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
    checkModelFiles(spec);
    let stoppedAny = false;
    const hadPrevious = Boolean(entry.run) || entry.view.state === "starting" || entry.view.state === "ready";
    if (hadPrevious && entry.view.profile === spec.profile) return;
    // Claim the generation before awaiting anything: the latest start() wins, an earlier one still in flight is superseded.
    const gen = ++entry.startGen;
    entry.claimGen = gen;
    if (hadPrevious) {
      stoppedAny = true;
      // A previous start still before its spawn has no run: the bump above already cancelled it.
      if (entry.run) await this.stop(spec.id);
      if (this.cancelled(entry, gen, spec)) return;
    }
    entry.view = { ...entry.view, state: "starting", port: spec.port, profile: spec.profile, error: undefined, pid: undefined, readyAt: undefined, startedAt: undefined, commandLine: commandLine(spec), log: [] };
    this.emitChange();
    try {
      await Promise.all(LOCAL_SERVER_IDS.filter((id) => { const other = this.entries.get(id)!; return id !== spec.id && (other.run || other.view.state === "starting"); }).map((id) => {
        stoppedAny = true;
        return this.stop(id);
      }));
      // The new server needs spec.port: after stopping a server of ours, give the port time to free up instead of refusing.
      if (stoppedAny) await this.waitPortReleased(spec.port, () => entry.startGen !== gen || this.closed);
      if (this.cancelled(entry, gen, spec)) return;
      if (await this.probeOnce(spec.port)) throw new Error(`Port ${spec.port} already answers (a server started outside the app?). Stop it first.`);
      // stop()/stopAll() during this pre-spawn phase bumped startGen: do not spawn, the state is already stopped.
      if (this.cancelled(entry, gen, spec)) return;
      const line = commandLine(spec);
      let child: ChildProcess;
      try { child = this.spawnFn(spec, line); } catch (error) { throw new Error(error instanceof Error ? error.message : String(error)); }
      this.attach(entry, spec, child);
    } catch (error) {
      if (error instanceof SupersededError) throw error;
      if (entry.startGen !== gen) return;
      if (!entry.run) entry.view = { ...entry.view, state: "stopped", error: undefined };
      this.emitChange();
      throw error;
    }
  }

  /** True when this start must not spawn; a replacement by a newer start() throws instead of returning silently. */
  private cancelled(entry: Entry, gen: number, spec: LocalServerSpec): boolean {
    if (this.closed) return true;
    if (entry.startGen === gen) return false;
    if (entry.claimGen !== gen) throw new SupersededError(`${LOCAL_SERVER_NAMES[spec.id]} start for '${spec.profile ?? spec.id}' was replaced by a newer start.`);
    return true;
  }

  /** True when the app owns no process for this server and its port already answers: a server started outside the app, which is never adopted, stopped or replaced. */
  async answersExternally(id: LocalServerId, port: number): Promise<boolean> {
    const entry = this.entries.get(id);
    if (!entry || entry.run || entry.view.state === "starting" || entry.view.state === "ready") return false;
    return this.probeOnce(port);
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

  /** Polls until nothing answers on the port (or `cancelled()`); throws after the ceiling. */
  private async waitPortReleased(port: number, cancelled: () => boolean): Promise<void> {
    const deadline = Date.now() + this.releaseTimeoutMs;
    while (await this.probeOnce(port)) {
      if (cancelled()) return;
      if (Date.now() >= deadline) throw new Error(`port ${port} still in use after the previous server stopped`);
      await new Promise<void>((resolve) => setTimeout(resolve, this.releasePollMs));
    }
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
    const timeoutMs = spec.startTimeoutMs ?? this.startTimeoutMs;
    run.timeout = setTimeout(() => {
      if (entry.run !== run || entry.view.state !== "starting") return;
      run.failure = `did not answer on port ${spec.port} within ${Math.round(timeoutMs / 60000 * 10) / 10} min`;
      this.clearTimers(run);
      run.abort.abort();
      void this.killFn(child).catch(() => undefined).then(() => {
        // If the exit event never arrives, still report the failure.
        setTimeout(() => { if (entry.run === run) this.finish(entry, run, { state: "error", error: run.failure }); }, EXIT_WAIT_MS).unref();
      });
    }, timeoutMs);
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
