import { describe, expect, it } from "vitest";
import { ApiError } from "../src/api.js";
import { QueueAbortedError } from "../src/limiter.js";
import { LocalModelCoordinator, type LocalModelHost, type LocalModelTarget } from "../src/local-models.js";
import { LLAMA_PRESETS, type GufoProfile } from "../src/settings.js";

const profile = (id: string): GufoProfile => ({ id, label: id, model: id, kind: "llm", args: `serve llm --model ${id} --port {port}`, vision: false });
const gufoTarget = (id: string): LocalModelTarget => ({ key: `gufo:${id}`, server: "gufo", profile: profile(id) });
const strataTarget: LocalModelTarget = { key: "strata", server: "strata" };
const settings = (ids: string[], switchWaitMs = 1000) => () => ({ targets: [...ids.map(gufoTarget), strataTarget], switchWaitMs: () => switchWaitMs });
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function fakeHost() {
  let state: ReturnType<LocalModelHost["current"]> = { key: "gufo:A", state: "ready" };
  const starts: string[] = [];
  const waiters: Array<() => void> = [];
  let failNextStart: string | undefined;
  const host: LocalModelHost = {
    current: () => state,
    start: async (target) => {
      starts.push(target.key);
      if (failNextStart) { const message = failNextStart; failNextStart = undefined; state = { key: target.key, state: "error", error: message }; throw new Error(message); }
      state = { key: target.key, state: "starting" };
    },
    waitReady: () => new Promise<void>((resolve) => waiters.push(resolve)),
  };
  return { host, starts, markReady: () => { state = { ...state, state: "ready" }; waiters.splice(0).forEach((resolve) => resolve()); }, failNext: (message: string) => { failNextStart = message; } };
}

describe("LocalModelCoordinator", () => {
  it("serializes profile switches: no switch while in flight, FIFO fairness, bounded wait, abort leaves the queue, start failures reject waiters", async () => {
    const { host, starts, markReady, failNext } = fakeHost();
    const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
    const coordinator = new LocalModelCoordinator(host, settings(["A", "B", "C"]), {
      setTimeout: (fn, ms) => { const timer = { fn, ms, cleared: false }; timers.push(timer); return timer; },
      clearTimeout: (handle) => { (handle as { cleared: boolean }).cleared = true; },
    });
    const outcome = <T>(promise: Promise<T>) => { const box: { value?: T; error?: unknown } = {}; promise.then((value) => { box.value = value; }, (error) => { box.error = error; }); return box; };

    const a1 = await coordinator.acquire("gufo:A", new AbortController().signal);
    const b1 = outcome(coordinator.acquire("gufo:B", new AbortController().signal));
    const aborter = new AbortController();
    const b2 = outcome(coordinator.acquire("gufo:B", aborter.signal));
    const a2 = outcome(coordinator.acquire("gufo:A", new AbortController().signal));
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
    expect(starts).toEqual(["gufo:B"]);
    expect(b1.value).toBeUndefined();
    markReady();
    await flush();
    expect(b1.value).toBeDefined();
    expect(a2.value).toBeUndefined();
    expect(starts).toEqual(["gufo:B"]);

    const waitTimer = timers.find((timer) => !timer.cleared && timer.ms === 1000)!;
    waitTimer.fn();
    await flush();
    expect(a2.error).toBeInstanceOf(ApiError);
    expect(a2.error).toMatchObject({ status: 503, code: "local_model_busy" });
    expect((a2.error as ApiError).retryAfterSeconds).toBeGreaterThan(0);

    b1.value!.release();
    failNext("File not found: D:\\x.gguf");
    const c1 = outcome(coordinator.acquire("gufo:C", new AbortController().signal));
    const c2 = outcome(coordinator.acquire("gufo:C", new AbortController().signal));
    await flush();
    expect(starts).toEqual(["gufo:B", "gufo:C"]);
    for (const failed of [c1, c2]) expect(failed.error).toMatchObject({ status: 503, code: "local_model_start_failed", message: expect.stringContaining("File not found") });
  });

  it("never switches away from a profile that is still starting, and treats strata as a profile", async () => {
    const { host, starts, markReady } = fakeHost();
    const coordinator = new LocalModelCoordinator(host, settings(["A", "B"]));
    const leaver = new AbortController();
    const first = coordinator.acquire("gufo:B", leaver.signal).catch((error) => error);
    await flush();
    expect(starts).toEqual(["gufo:B"]);
    const waitingForA = coordinator.acquire("gufo:A", new AbortController().signal);
    leaver.abort();
    await flush();
    expect(await first).toBeInstanceOf(QueueAbortedError);
    expect(starts).toEqual(["gufo:B"]);
    markReady();
    await flush();
    expect(starts).toEqual(["gufo:B", "gufo:A"]);
    markReady();
    const lease = await waitingForA;

    const strata = coordinator.acquire("strata", new AbortController().signal);
    await flush();
    expect(starts).toEqual(["gufo:B", "gufo:A"]);
    lease.release();
    await flush();
    expect(starts).toEqual(["gufo:B", "gufo:A", "strata"]);
    markReady();
    (await strata).release();
  });

  it("passes requests straight through to a server started outside the app, but the Settings Start still starts", async () => {
    const { host, starts } = fakeHost();
    const coordinator = new LocalModelCoordinator({ ...host, current: () => ({ state: "stopped" }), external: async () => true }, settings(["A"]));
    const lease = await coordinator.acquire("gufo:A", new AbortController().signal);
    lease.release();
    expect(starts).toEqual([]);
    void coordinator.switchTo("gufo:A").catch(() => undefined);
    await flush();
    expect(starts).toEqual(["gufo:A"]);
  });

  it("namespaces keys: the same id on gufo and llama never collides, switching across servers waits for the lease and unknown keys are 404", async () => {
    const { host, starts, markReady } = fakeHost();
    const llama: LocalModelTarget = { key: "llama:same", server: "llama", profile: structuredClone(LLAMA_PRESETS[0]!) };
    const started: LocalModelTarget[] = [];
    const coordinator = new LocalModelCoordinator({ ...host, start: async (target) => { started.push(target); await host.start(target); } }, () => ({ targets: [gufoTarget("same"), llama, strataTarget], switchWaitMs: () => 1000 }));
    const gufoPending = coordinator.acquire("gufo:same", new AbortController().signal);
    await flush();
    markReady();
    const gufo = await gufoPending;
    started.length = 0;
    starts.length = 0;
    const llamaLease = coordinator.acquire("llama:same", new AbortController().signal);
    await flush();
    expect(started).toEqual([]);
    gufo.release();
    await flush();
    expect(started.map((target) => target.server)).toEqual(["llama"]);
    expect(starts).toEqual(["llama:same"]);
    markReady();
    (await llamaLease).release();
    await expect(coordinator.acquire("llama:nope", new AbortController().signal)).rejects.toMatchObject({ status: 404, code: "model_not_found", message: "Unknown local model 'llama:nope'." });
  });
});
