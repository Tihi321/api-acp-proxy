import { ApiError } from "./api.js";
import { QueueAbortedError } from "./limiter.js";
import type { GufoProfile } from "./settings.js";

/** Strata takes part in the coordinator as a profile of its own, so Gufo and Strata never kill each other mid-request. */
export const STRATA_PROFILE_ID = "strata";
export type LocalModelTarget = GufoProfile | { id: typeof STRATA_PROFILE_ID };

export interface LocalModelHost {
  /** Current launcher state of whichever local server (Gufo profile or `strata`) is starting or ready. */
  current(): { profile?: string; state: "stopped" | "starting" | "ready" | "error"; error?: string };
  /** Stop-if-different + start; resolves when spawned. */
  start(target: LocalModelTarget): Promise<void>;
  /** Rejects when the launcher goes to error/stopped. */
  waitReady(profile: string, signal: AbortSignal): Promise<void>;
}

export interface LocalModelCoordinatorDeps {
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

interface Waiter {
  profile: string;
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
 * Serializes access to the single Gufo process: a FIFO queue of requests per profile, a switch only starts when the active
 * profile has no in-flight request, and a request that waits longer than `switchWaitMs` gets 503 `local_model_busy`.
 * Callers admitted while their profile is still starting count as in-flight, so nobody switches away from a model being loaded.
 */
export class LocalModelCoordinator {
  private readonly queue: Waiter[] = [];
  private readonly inflight = new Map<string, number>();
  private starting?: { profile: string; promise: Promise<void> };
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly host: LocalModelHost, private readonly getSettings: () => { profiles: GufoProfile[]; switchWaitMs: number }, deps: LocalModelCoordinatorDeps = {}) {
    this.setTimer = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  /** Resolves with a release when the profile is ready and the caller counts as in-flight. */
  acquire(profileId: string, signal: AbortSignal): Promise<{ release(): void }> {
    return this.enqueue(profileId, true, signal).then((release) => ({ release }));
  }

  /** Settings Start button: same queue, no in-flight lease; resolves when ready. */
  switchTo(profileId: string): Promise<void> {
    return this.enqueue(profileId, false).then((release) => release());
  }

  private enqueue(profileId: string, lease: boolean, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new QueueAbortedError());
    if (!this.target(profileId)) return Promise.reject(new ApiError(404, "model_not_found", `Unknown Gufo profile '${profileId}'.`));
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { profile: profileId, lease, resolve, reject, signal };
      const waitMs = this.getSettings().switchWaitMs;
      waiter.timer = this.setTimer(() => {
        if (!this.remove(waiter)) return;
        this.detach(waiter);
        const seconds = Math.max(1, Math.round(waitMs / 1000));
        reject(new ApiError(503, "local_model_busy", `The local model server is busy with another model; waited ${seconds} s for '${profileId}'. Try again later.`, undefined, { retryAfterSeconds: Math.min(seconds, 60) }));
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

  private target(id: string): LocalModelTarget | undefined {
    return id === STRATA_PROFILE_ID ? { id: STRATA_PROFILE_ID } : this.getSettings().profiles.find((profile) => profile.id === id);
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

  private activeProfile(): string | undefined {
    if (this.starting) return this.starting.profile;
    const current = this.host.current();
    return current.state === "starting" || current.state === "ready" ? current.profile : undefined;
  }

  /** Admits queue heads in FIFO order: the active profile joins at once, another profile only when the active one is idle. */
  private pump(): void {
    while (this.queue.length) {
      const head = this.queue[0]!;
      const active = this.activeProfile();
      // A profile still starting is never switched away from, even with nobody in flight yet (a leaver must not kill a half-loaded model).
      if (active !== undefined && head.profile !== active && ((this.inflight.get(active) ?? 0) > 0 || this.starting !== undefined || this.host.current().state === "starting")) return;
      this.queue.shift();
      this.detach(head);
      this.admit(head);
    }
  }

  private admit(waiter: Waiter): void {
    const profile = this.target(waiter.profile);
    if (!profile) { waiter.reject(new ApiError(404, "model_not_found", `Unknown Gufo profile '${waiter.profile}'.`)); return; }
    this.inflight.set(profile.id, (this.inflight.get(profile.id) ?? 0) + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.inflight.set(profile.id, Math.max(0, (this.inflight.get(profile.id) ?? 1) - 1));
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
    this.ensureReady(profile).then(
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
        waiter.reject(error instanceof ApiError ? error : new ApiError(503, "local_model_start_failed", `Could not start the local model '${profile.id}': ${messageOf(error)}`, undefined, { retryAfterSeconds: 30 }));
      },
    );
  }

  private ensureReady(profile: LocalModelTarget): Promise<void> {
    if (this.starting?.profile === profile.id) return this.starting.promise;
    const current = this.host.current();
    if (current.profile === profile.id && current.state === "ready") return Promise.resolve();
    // Never cancelled by a leaver: this signal is not tied to any request.
    const never = new AbortController().signal;
    if (current.profile === profile.id && current.state === "starting") return this.host.waitReady(profile.id, never);
    const entry: { profile: string; promise: Promise<void> } = { profile: profile.id, promise: Promise.resolve() };
    entry.promise = this.host.start(profile).then(() => this.host.waitReady(profile.id, never));
    this.starting = entry;
    const clear = () => { if (this.starting === entry) { this.starting = undefined; this.pump(); } };
    entry.promise.then(clear, clear);
    return entry.promise;
  }
}
