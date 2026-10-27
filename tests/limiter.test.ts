import { describe, expect, it } from "vitest";
import { ConcurrencyLimiter, QueueAbortedError } from "../src/limiter.js";
import { ApiError } from "../src/api.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("ConcurrencyLimiter", () => {
  it("runs at most `limit` at once and starts the others in FIFO order", async () => {
    const limiter = new ConcurrencyLimiter({ limit: 2 });
    const started: number[] = [];
    const releases: Array<() => void> = [];
    const jobs = [0, 1, 2, 3, 4].map((n) => limiter.acquire().then((release) => { started.push(n); releases.push(release); }));
    await tick();
    expect(started).toEqual([0, 1]);
    expect(limiter.stats()).toMatchObject({ active: 2, queued: 3 });
    releases[0]!(); await tick();
    expect(started).toEqual([0, 1, 2]);
    releases[1]!(); releases[2]!(); await tick();
    expect(started).toEqual([0, 1, 2, 3, 4]);
    expect(limiter.stats()).toMatchObject({ active: 2, queued: 0 });
    releases[3]!(); releases[4]!(); await Promise.all(jobs);
    expect(limiter.stats().active).toBe(0);
  });

  it("ignores a second release of the same slot", async () => {
    const limiter = new ConcurrencyLimiter({ limit: 1 });
    const release = await limiter.acquire();
    const second = limiter.acquire();
    release(); release();
    const next = await second;
    expect(limiter.stats().active).toBe(1);
    next();
    expect(limiter.stats().active).toBe(0);
  });

  it("is unlimited with limit 0", async () => {
    const limiter = new ConcurrencyLimiter({ limit: 0 });
    await Promise.all(Array.from({ length: 50 }, () => limiter.acquire()));
    expect(limiter.stats()).toMatchObject({ active: 50, queued: 0 });
  });

  it("removes a queued waiter whose signal aborts, and keeps the others queued", async () => {
    const limiter = new ConcurrencyLimiter({ limit: 1 });
    const first = await limiter.acquire();
    const controller = new AbortController();
    const dropped = limiter.acquire(controller.signal);
    const kept = limiter.acquire();
    controller.abort();
    await expect(dropped).rejects.toBeInstanceOf(QueueAbortedError);
    expect(limiter.stats().queued).toBe(1);
    first();
    (await kept)();
    expect(limiter.stats()).toMatchObject({ active: 0, queued: 0 });
  });

  it("rejects at once when the signal is already aborted", async () => {
    const limiter = new ConcurrencyLimiter({ limit: 1 });
    const controller = new AbortController(); controller.abort();
    await expect(limiter.acquire(controller.signal)).rejects.toBeInstanceOf(QueueAbortedError);
    expect(limiter.stats().active).toBe(0);
  });

  it("answers 429 when the queue is full", async () => {
    const limiter = new ConcurrencyLimiter({ limit: 1, maxQueue: 1 });
    await limiter.acquire();
    void limiter.acquire();
    const full = await limiter.acquire().catch((error) => error);
    expect(full).toBeInstanceOf(ApiError);
    expect(full).toMatchObject({ status: 429, code: "provider_queue_full" });
  });

  it("reports waits", async () => {
    const waits: number[] = [];
    const limiter = new ConcurrencyLimiter({ limit: 1, onWait: (position) => waits.push(position) });
    await limiter.acquire();
    void limiter.acquire(); void limiter.acquire();
    expect(waits).toEqual([1, 2]);
  });
});
