import { describe, expect, it } from "vitest";
import { fetchEngine, localState, mapLlama, mapStrataMetrics, type MonitorFetch } from "../src/local-monitor.js";
import type { LocalServerStatusView } from "../src/shared/ipc.js";

// Samples recorded on 2026-11-22 (Strata 0.1.52 /metrics, llama-server b12613 /props and /slots), trimmed, plus planted text that must never come through.
const strataRequest = (n: number) => ({
  id: `req-${n}`, projection: "SECRET-TEXT", time: 1795359100 + n, duration_s: 0.5, finish: "stop", prompt_tokens: 16, reused: 0, output_tokens: 2,
  prompt_total: 16, prompt_read: 16, prompt_ms: 358.6, decode_ms: 122.2, decode_tok_s: 16.4,
});
const strataMetrics = (extra: Record<string, unknown> = {}) => ({
  engine: { model: "SECRET-TEXT", version: "0.1.52", context: 131072, images: true, kv: "int8", kv_resident: 32768, expert_slots: 24576, expert_cache_mib: 56762, drafting: "mtp", ...extra },
  live: { state: "idle", queued: 0, extra: "SECRET-TEXT", slots: [{ slot: 0, state: "idle", held_tokens: 0, note: "SECRET-TEXT" }, { slot: 1, state: "generating", held_tokens: 900 }] },
  totals: { requests: 1, prompt_tokens: 16, reused: 0, output_tokens: 2, prompt_ms: 358.6, decode_ms: 122.2, extra: "SECRET-TEXT" },
  // Oldest first, 13 entries: only the newest 12 are kept.
  requests: Array.from({ length: 13 }, (_, n) => strataRequest(n)),
  hardware: { gpu_util: 3, gpu_temp: 36, gpu_power: 25, gpu_mem_used: 67903684608, gpu_mem_total: 68719476736, cpu: 7.5, disk_read_mb: 0.39, extra: "SECRET-TEXT" },
  hardware_static: { gpu_name: "AMD Radeon(TM) 8060S Graphics", cpu_name: "AMD RYZEN AI MAX+ 395", threads: 32, extra: "SECRET-TEXT" },
});
const llamaProps = { build_info: "b12613-362ac9297", model_alias: "SECRET-TEXT", total_slots: 2, modalities: { vision: false } };
const llamaSlots = [
  { id: 0, n_ctx: 4096, is_processing: true, n_prompt_tokens: 120, prompt: "SECRET-TEXT", params: { stop: ["SECRET-TEXT"] }, next_token: { text: "SECRET-TEXT" } },
  { id: 1, n_ctx: 4096, is_processing: false, n_prompt_tokens: 0 },
];

const entry = (id: LocalServerStatusView["id"], state: LocalServerStatusView["state"]): LocalServerStatusView => ({ id, name: id, state, log: [] });
const answer = (body: unknown, status = 200): ReturnType<MonitorFetch> => Promise.resolve({ ok: status < 300, status, json: async () => body });

describe("local model monitor", () => {
  it("maps Strata's metrics to counts and timings, newest requests first, never text", () => {
    const view = mapStrataMetrics(strataMetrics());
    expect(view).toMatchObject({
      kind: "strata", version: "0.1.52", state: "idle", context: 131072, images: true,
      slots: [{ id: 0, busy: false, tokens: 0 }, { id: 1, busy: true, tokens: 900 }],
      speed: { decodeTokS: 16.4, prefillTokS: 44.6 }, reuse: { reused: 0, prompt: 16, requests: 1 },
      strata: { kv: "int8", kvResident: 32768, expertSlots: 24576, expertCacheMiB: 56762, drafting: "mtp" },
      hardware: { gpuName: "AMD Radeon(TM) 8060S Graphics", gpuUtilPct: 3, gpuMemUsedBytes: 67903684608, gpuMemTotalBytes: 68719476736, gpuTempC: 36, gpuPowerW: 25, diskReadMBs: 0.39 },
    });
    expect(view.requests).toHaveLength(12);
    expect(view.requests[0]).toMatchObject({ time: 1795359112000, prefillTokS: 44.6, decodeTokS: 16.4 });
    expect(view.requests.at(-1)?.time).toBe(1795359101000);
    expect(JSON.stringify(view)).not.toContain("SECRET");
    // A time that is not a plausible epoch in ms (here seconds read as 1e16 ms) is dropped; the row stays.
    const odd = mapStrataMetrics({ ...strataMetrics(), requests: [{ ...strataRequest(0), time: 1e13 }] });
    expect(odd.requests).toHaveLength(1);
    expect(odd.requests[0]).not.toHaveProperty("time");
  });

  it("maps llama-server's props and slots, busy when a slot processes, never text", () => {
    const view = mapLlama(llamaProps, llamaSlots);
    expect(view).toMatchObject({
      kind: "llama", version: "b12613-362ac9297", state: "busy", images: false, context: 8192,
      slots: [{ id: 0, busy: true, tokens: 120, ctx: 4096 }, { id: 1, busy: false, tokens: 0, ctx: 4096 }],
    });
    expect(JSON.stringify(view)).not.toContain("SECRET");
  });

  it("keeps keys in the request header, reports an unreachable port and does not call Gufo", async () => {
    const seen: Array<{ url: string; headers?: Record<string, string> }> = [];
    // The fake server echoes the key it received in a field the mapper must not copy.
    const echo: MonitorFetch = (url, init) => { seen.push({ url, ...(init.headers ? { headers: init.headers } : {}) }); return answer(strataMetrics({ note: init.headers?.["Authorization"] })); };
    const ok = await fetchEngine("strata", 8080, "KEY-VALUE-123", echo);
    expect(seen).toEqual([{ url: "http://127.0.0.1:8080/metrics", headers: { Authorization: "Bearer KEY-VALUE-123" } }]);
    expect(ok.engine?.kind).toBe("strata");
    expect(JSON.stringify(ok)).not.toContain("KEY-VALUE-123");

    const down = await fetchEngine("llama", 8082, undefined, () => Promise.reject(new Error("ECONNREFUSED")));
    expect(down).toEqual({ error: "not reachable" });
    expect(await fetchEngine("strata", 8080, "k", () => answer({}, 401))).toEqual({ error: "HTTP 401" });

    let calls = 0;
    expect(await fetchEngine("gufo", 8081, "k", () => { calls += 1; return answer({}); })).toEqual({});
    expect(calls).toBe(0);
  });

  it("says no local model is loaded when only the embedding server runs", () => {
    expect(localState([entry("gufo", "stopped"), entry("strata", "stopped"), entry("llama", "stopped"), entry("embed", "ready")])).toEqual({ state: "none" });
    expect(localState([entry("strata", "ready"), entry("embed", "ready")])).toMatchObject({ server: "strata", state: "ready" });
  });
});
