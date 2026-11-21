import { describe, expect, it } from "vitest";
import { ApiError } from "../src/api.js";
import { QueueAbortedError } from "../src/limiter.js";
import { LocalModelCoordinator, type LocalModelHost } from "../src/local-models.js";
import type { GufoProfile } from "../src/settings.js";

const profile = (id: string): GufoProfile => ({ id, label: id, model: id, kind: "llm", args: `serve llm --model ${id} --port {port}`, vision: false });
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function fakeHost() {
  let state: ReturnType<LocalModelHost["current"]> = { profile: "A", state: "ready" };
  const starts: string[] = [];
  const waiters: Array<() => void> = [];
  let failNextStart: string | undefined;
  const host: LocalModelHost = {
    current: () => state,
    start: async (target) => {
      starts.push(target.id);
      if (failNextStart) { const message = failNextStart; failNextStart = undefined; state = { profile: target.id, state: "error", error: message }; throw new Error(message); }
      state = { profile: target.id, state: "starting" };
    },
    waitReady: () => new Promise<void>((resolve) => waiters.push(resolve)),
  };
  return { host, starts, markReady: () => { state = { ...state, state: "ready" }; waiters.splice(0).forEach((resolve) => resolve()); }, failNext: (message: string) => { failNextStart = message; } };
}

describe("LocalModelCoordinator", () => {
  it("serializes profile switches: no switch while in flight, FIFO fairness, bounded wait, abort leaves the queue, start failures reject waiters", async () => {
    const { host, starts, markReady, failNext } = fakeHost();
    const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
    const coordinator = new LocalModelCoordinator(host, () => ({ profiles: ["A", "B", "C"].map(profile), switchWaitMs: 1000 }), {
      setTimeout: (fn, ms) => { const timer = { fn, ms, cleared: false }; timers.push(timer); return timer; },
      clearTimeout: (handle) => { (handle as { cleared: boolean }).cleared = true; },
    });
    const outcome = <T>(promise: Promise<T>) => { const box: { value?: T; error?: unknown } = {}; promise.then((value) => { box.value = value; }, (error) => { box.error = error; }); return box; };

    const a1 = await coordinator.acquire("A", new AbortController().signal);
    const b1 = outcome(coordinator.acquire("B", new AbortController().signal));
    const aborter = new AbortController();
    const b2 = outcome(coordinator.acquire("B", aborter.signal));
    const a2 = outcome(coordinator.acquire("A", new AbortController().signal));
    await flush();
    expect(starts).toEqual([]);
    expect(b1.value).toBeUndefined();
    expect(a2.value).toBeUndefined();

    aborter.abort();
    await flush();
    expect(b2.error).toBeInstanceOf(QueueAbortedError);
    expect(starts).toEqual([]);

    a1.release();
    await flush();
    expect(starts).toEqual(["B"]);
    expect(b1.value).toBeUndefined();
    markReady();
    await flush();
    expect(b1.value).toBeDefined();
    expect(a2.value).toBeUndefined();
    expect(starts).toEqual(["B"]);

    const waitTimer = timers.find((timer) => !timer.cleared && timer.ms === 1000)!;
    waitTimer.fn();
    await flush();
    expect(a2.error).toBeInstanceOf(ApiError);
    expect(a2.error).toMatchObject({ status: 503, code: "local_model_busy" });
    expect((a2.error as ApiError).retryAfterSeconds).toBeGreaterThan(0);

    b1.value!.release();
    failNext("File not found: D:\\x.gguf");
    const c1 = outcome(coordinator.acquire("C", new AbortController().signal));
    const c2 = outcome(coordinator.acquire("C", new AbortController().signal));
    await flush();
    expect(starts).toEqual(["B", "C"]);
    for (const failed of [c1, c2]) expect(failed.error).toMatchObject({ status: 503, code: "local_model_start_failed", message: expect.stringContaining("File not found") });
  });
});
