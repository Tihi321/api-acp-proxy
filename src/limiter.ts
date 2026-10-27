import { ApiError } from "./api.js";

/** Thrown by `acquire` when the caller's signal aborted while it waited in the queue. */
export class QueueAbortedError extends Error {
  constructor() { super("The request was cancelled while it waited in the queue."); this.name = "QueueAbortedError"; }
}

export interface LimiterStats { active: number; queued: number; limit: number; maxQueue: number; }
export interface LimiterOptions {
  /** Requests that may run at once; 0 = unlimited. */
  limit: number;
  /** Requests that may wait; 0 = unlimited. A full queue answers 429. */
  maxQueue?: number;
  /** Called when a request has to wait (`position` is 1 for the next one to run). */
  onWait?: (position: number, stats: LimiterStats) => void;
}

interface Waiter { grant: () => void; }

/** A counting semaphore with a FIFO queue. Slots are handed to waiters directly, so ordering is strict. */
export class ConcurrencyLimiter {
  private activeCount = 0;
  private readonly queue: Waiter[] = [];
  constructor(private readonly options: LimiterOptions) {}

  stats(): LimiterStats { return { active: this.activeCount, queued: this.queue.length, limit: this.options.limit, maxQueue: this.options.maxQueue ?? 0 }; }

  /** Resolves with an idempotent `release` once a slot is free. Rejects with `QueueAbortedError` when `signal` aborts first, and with a 429 `ApiError` when the queue is full. */
  acquire(signal?: AbortSignal): Promise<() => void> {
    const { limit, maxQueue = 0 } = this.options;
    if (signal?.aborted) return Promise.reject(new QueueAbortedError());
    if (limit <= 0 || (this.activeCount < limit && this.queue.length === 0)) { this.activeCount++; return Promise.resolve(this.releaser()); }
    if (maxQueue > 0 && this.queue.length >= maxQueue) return Promise.reject(new ApiError(429, "provider_queue_full", `Too many requests are waiting for this provider (${this.queue.length} queued, ${this.activeCount} running). Try again later.`));
    return new Promise((resolve, reject) => {
      const onAbort = () => { const index = this.queue.indexOf(waiter); if (index >= 0) this.queue.splice(index, 1); reject(new QueueAbortedError()); };
      const waiter: Waiter = { grant: () => { signal?.removeEventListener("abort", onAbort); this.activeCount++; resolve(this.releaser()); } };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.queue.push(waiter);
      this.options.onWait?.(this.queue.length, this.stats());
    });
  }

  private releaser(): () => void {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.activeCount--;
      this.drain();
    };
  }

  private drain(): void {
    const { limit } = this.options;
    while (this.queue.length && (limit <= 0 || this.activeCount < limit)) this.queue.shift()!.grant();
  }
}
