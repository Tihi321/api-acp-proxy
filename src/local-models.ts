import { ApiError } from "./api.js";
import { QueueAbortedError } from "./limiter.js";
import type { GufoProfile, LlamaProfile } from "./settings.js";
import type { LocalServerId } from "./shared/ipc.js";

/** Strata takes part in the coordinator as a target of its own, so the local servers never kill each other mid-request. */
export const STRATA_PROFILE_ID = "strata";
/** Coordinator keys are namespaced (`gufo:<id>`, `llama:<id>`, `strata`) so profiles of different servers may share an id. */
export type LocalModelTarget =
  | { key: `gufo:${string}`; server: "gufo"; profile: GufoProfile }
  | { key: `llama:${string}`; server: "llama"; profile: LlamaProfile }
  | { key: "strata"; server: "strata" };
export const targetKey = (server: LocalServerId, profileId?: string): string => (server === "strata" ? "strata" : `${server}:${profileId}`);

export interface LocalModelHost {
  /** Current launcher state of whichever local server is starting or ready; `key` is the target key (`gufo:<id>`, `llama:<id>`, `strata`). */
  current(): { key?: string; state: "stopped" | "starting" | "ready" | "error"; error?: string };
  /** Stop-if-different + start; resolves when spawned. */
  start(target: LocalModelTarget): Promise<void>;
  /** True when the app owns no process for the target's server and its port already answers (a server started outside the app): requests pass straight through, nothing is started or stopped. Optional. */
  external?(target: LocalModelTarget): Promise<boolean>;
  /** Rejects when the launcher goes to error/stopped. */
  waitReady(key: string, signal: AbortSignal): Promise<void>;
}

export interface LocalModelCoordinatorDeps {
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

export interface LocalModelCoordinatorSettings {
  targets: readonly LocalModelTarget[];
  switchWaitMs(server: LocalServerId): number;
}

interface Waiter {
  key: string;
  /** `switchTo` waiters take no lease after they are ready. */
  lease: boolean;
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  timer?: unknown;
  signal?: AbortSignal;
  onAbort?: () => void;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Serializes access to the single local server process (Gufo, Strata or Llama.cpp): a FIFO queue of requests per target key, a switch only
 * starts when the active target has no in-flight request, and a request that waits longer than `switchWaitMs` gets 503 `local_model_busy`.
 * Callers admitted while their target is still starting count as in-flight, so nobody switches away from a model being loaded.
 */
export class LocalModelCoordinator {
  private readonly queue: Waiter[] = [];
  private readonly inflight = new Map<string, number>();
  private starting?: { key: string; promise: Promise<void> };
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly host: LocalModelHost, private readonly getSettings: () => LocalModelCoordinatorSettings, deps: LocalModelCoordinatorDeps = {}) {
    this.setTimer = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  /** Resolves with a release when the target is ready and the caller counts as in-flight. */
  acquire(key: string, signal: AbortSignal): Promise<{ release(): void }> {
    return this.enqueue(key, true, signal).then((release) => ({ release }));
  }

  /** Settings Start button: same queue, no in-flight lease; resolves when ready. */
  switchTo(key: string): Promise<void> {
    return this.enqueue(key, false).then((release) => release());
  }

  private enqueue(key: string, lease: boolean, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new QueueAbortedError());
    const target = this.target(key);
    if (!target) return Promise.reject(new ApiError(404, "model_not_found", `Unknown local model '${key}'.`));
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { key, lease, resolve, reject, signal };
      const waitMs = this.getSettings().switchWaitMs(target.server);
      waiter.timer = this.setTimer(() => {
        if (!this.remove(waiter)) return;
        this.detach(waiter);
        const seconds = Math.max(1, Math.round(waitMs / 1000));
        reject(new ApiError(503, "local_model_busy", `The local model server is busy with another model; waited ${seconds} s for '${key}'. Try again later.`, undefined, { retryAfterSeconds: Math.min(seconds, 60) }));
        this.pump();
      }, waitMs);
      if (signal) {
        waiter.onAbort = () => {
          if (!this.remove(waiter)) return;
          this.detach(waiter);
          reject(new QueueAbortedError());
          this.pump();
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.queue.push(waiter);
      this.pump();
    });
  }

  private target(key: string): LocalModelTarget | undefined {
    return this.getSettings().targets.find((target) => target.key === key);
  }

  private remove(waiter: Waiter): boolean {
    const index = this.queue.indexOf(waiter);
    if (index < 0) return false;
    this.queue.splice(index, 1);
    return true;
  }

  private detach(waiter: Waiter): void {
    if (waiter.timer !== undefined) this.clearTimer(waiter.timer);
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
  }

  private activeKey(): string | undefined {
    if (this.starting) return this.starting.key;
    const current = this.host.current();
    return current.state === "starting" || current.state === "ready" ? current.key : undefined;
  }

  /** Admits queue heads in FIFO order: the active target joins at once, another target only when the active one is idle. */
  private pump(): void {
    while (this.queue.length) {
      const head = this.queue[0]!;
      const active = this.activeKey();
      // A target still starting is never switched away from, even with nobody in flight yet (a leaver must not kill a half-loaded model).
      if (active !== undefined && head.key !== active && ((this.inflight.get(active) ?? 0) > 0 || this.starting !== undefined || this.host.current().state === "starting")) return;
      this.queue.shift();
      this.detach(head);
      this.admit(head);
    }
  }

  private admit(waiter: Waiter): void {
    const target = this.target(waiter.key);
    if (!target) { waiter.reject(new ApiError(404, "model_not_found", `Unknown local model '${waiter.key}'.`)); return; }
    this.inflight.set(target.key, (this.inflight.get(target.key) ?? 0) + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.inflight.set(target.key, Math.max(0, (this.inflight.get(target.key) ?? 1) - 1));
      this.pump();
    };
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      release();
      waiter.reject(new QueueAbortedError());
    };
    waiter.signal?.addEventListener("abort", onAbort, { once: true });
    this.ensureReady(target, waiter.lease).then(
      () => {
        if (settled) return;
        settled = true;
        waiter.signal?.removeEventListener("abort", onAbort);
        if (waiter.lease) waiter.resolve(release);
        else { release(); waiter.resolve(() => undefined); }
      },
      (error) => {
        if (settled) return;
        settled = true;
        waiter.signal?.removeEventListener("abort", onAbort);
        release();
        waiter.reject(error instanceof ApiError ? error : new ApiError(503, "local_model_start_failed", `Could not start the local model '${target.key}': ${messageOf(error)}`, undefined, { retryAfterSeconds: 30 }));
      },
    );
  }

  private async ensureReady(target: LocalModelTarget, lease: boolean): Promise<void> {
    if (this.starting?.key === target.key) return this.starting.promise;
    const current = this.host.current();
    if (current.key === target.key && current.state === "ready") return;
    // A request (not the Settings Start button) to a server the app does not own goes straight upstream, as before AAP-37.
    if (lease && this.host.external && !this.starting && await this.host.external(target).catch(() => false)) return;
    return this.startAndWait(target, current);
  }

  private startAndWait(target: LocalModelTarget, current: ReturnType<LocalModelHost["current"]>): Promise<void> {
    if (this.starting?.key === target.key) return this.starting.promise;
    // Never cancelled by a leaver: this signal is not tied to any request.
    const never = new AbortController().signal;
    if (current.key === target.key && current.state === "starting") return this.host.waitReady(target.key, never);
    const entry: { key: string; promise: Promise<void> } = { key: target.key, promise: Promise.resolve() };
    entry.promise = this.host.start(target).then(() => this.host.waitReady(target.key, never));
    this.starting = entry;
    const clear = () => { if (this.starting === entry) { this.starting = undefined; this.pump(); } };
    entry.promise.then(clear, clear);
    return entry.promise;
  }
}
