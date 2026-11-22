import { describe, expect, it } from "vitest";
import { fetchEngine, llamaAlias, localState, mapLlama, mapStrataMetrics, MAX_METRICS_BYTES, type MonitorFetch } from "../src/local-monitor.js";
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
  // 65 points, oldest first: only the newest 60 are kept; index 10 (text) and 20 (null) fall inside them. Unknown and unread series carry text.
  history: {
    gpu_util: Array.from({ length: 65 }, (_, n) => (n === 10 ? "SECRET-TEXT" : n === 20 ? null : n)), gpu_temp: Array.from({ length: 60 }, () => 36),
    secret_series: ["SECRET-TEXT"], cpu: ["SECRET-TEXT", 7.5],
  },
  conversation_cache: {
    enabled: true, budget_mib: 1536, slots: 4, parked: 0, bytes: 0, evictions: 0, parks: 0, restores: 0, last_event: "SECRET-TEXT", last_tokens: null, last_at: null,
    refused: {}, refused_total: 0, last_refused: null, requests: 1, requests_reused: 0, reused_tokens: 0, prompt_tokens: 16, last_reused: 0, last_prompt: 16,
  },
});
const llamaProps = { build_info: "b12613-362ac9297", model_alias: "inkling-2-mini", total_slots: 2, modalities: { vision: false } };
const llamaSlots = [
  { id: 0, n_ctx: 4096, is_processing: true, n_prompt_tokens: 120, prompt: "SECRET-TEXT", params: { stop: ["SECRET-TEXT"] }, next_token: { text: "SECRET-TEXT" } },
  { id: 1, n_ctx: 4096, is_processing: false, n_prompt_tokens: 0 },
];
// Synthetic numbers in the format of llama-server's /metrics (no server with --metrics ran when this was written); gauges are 0 so only the counters can give a speed.
const llamaMetrics = [
  "# HELP llamacpp:prompt_tokens_total Number of prompt tokens processed, excluding cached tokens",
  "# TYPE llamacpp:prompt_tokens_total counter",
  "llamacpp:prompt_tokens_total 446",
  "llamacpp:prompt_tokens_cached_total 0",
  "llamacpp:prompt_seconds_total 0.5",
  "llamacpp:tokens_predicted_total SECRET-TEXT",
  "llamacpp:tokens_predicted_total 120",
  "llamacpp:tokens_predicted_seconds_total 2.4",
  "llamacpp:prompt_tokens_seconds 0",
  "llamacpp:predicted_tokens_seconds 0",
  "# HELP llamacpp:secret SECRET-TEXT",
  'llamacpp:secret{prompt="SECRET-TEXT"} 1',
  'llamacpp:spec_decode_num_accepted_tokens_per_pos_total{position="0"} 3',
  "",
].join("\n");

const entry = (id: LocalServerStatusView["id"], state: LocalServerStatusView["state"]): LocalServerStatusView => ({ id, name: id, state, log: [] });
const answer = (body: unknown, status = 200): ReturnType<MonitorFetch> => Promise.resolve({ ok: status < 300, status, json: async () => body, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) });

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
    expect(Object.keys(view.history ?? {})).toEqual(["gpuUtilPct", "gpuTempC"]);
    expect(view.history?.gpuUtilPct).toHaveLength(60);
    expect(view.history?.gpuUtilPct?.slice(0, 2)).toEqual([5, 6]);
    expect([view.history?.gpuUtilPct?.[5], view.history?.gpuUtilPct?.[15]]).toEqual([null, null]);
    expect(view.history?.gpuTempC).toHaveLength(60);
    expect(view.conversationCache).toEqual({ enabled: true, slots: 4, parked: 0, bytes: 0, budgetMiB: 1536, restores: 0, evictions: 0, requests: 1, requestsReused: 0, reusedTokens: 0 });
    expect(JSON.stringify(view)).not.toContain("SECRET");
    // A time that is not a plausible epoch in ms (here seconds read as 1e16 ms) is dropped; the row stays.
    const odd = mapStrataMetrics({ ...strataMetrics(), requests: [{ ...strataRequest(0), time: 1e13 }] });
    expect(odd.requests).toHaveLength(1);
    expect(odd.requests[0]).not.toHaveProperty("time");
  });

  it("maps llama-server's props and slots, busy when a slot processes, never text", () => {
    const view = mapLlama(llamaProps, llamaSlots, llamaMetrics);
    expect(view).toMatchObject({
      kind: "llama", version: "b12613-362ac9297", state: "busy", images: false, context: 4096, speed: { decodeTokS: 50, prefillTokS: 892 },
      slots: [{ id: 0, busy: true, tokens: 120, ctx: 4096 }, { id: 1, busy: false, tokens: 0, ctx: 4096 }],
    });
    expect(view.speedMissing).toBeUndefined();
    expect(JSON.stringify(view)).not.toContain("SECRET");
    expect(JSON.stringify(mapLlama(llamaProps, llamaSlots, llamaMetrics))).not.toContain("inkling-2-mini");
    expect(mapLlama(llamaProps, llamaSlots)).toMatchObject({ speedMissing: "no-metrics" });
    expect(mapLlama(llamaProps, llamaSlots)).not.toHaveProperty("speed");
    const idle = mapLlama(llamaProps, llamaSlots, "llamacpp:prompt_tokens_total 0\nllamacpp:prompt_seconds_total 0\nllamacpp:tokens_predicted_total 0\nllamacpp:tokens_predicted_seconds_total 0\n");
    expect(idle).toMatchObject({ speedMissing: "no-request" });
    expect(idle).not.toHaveProperty("speed");
    const hostile = mapLlama(llamaProps, llamaSlots, "llamacpp:tokens_predicted_total 1e308\nllamacpp:tokens_predicted_seconds_total 1e-10\n");
    expect(hostile.speed?.decodeTokS).toBeUndefined();
    expect(JSON.stringify(hostile)).not.toMatch(/Infinity|null/);
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

    const asked: string[] = [];
    const llamaFetch = (metricsFlag: boolean, metricsBody: string): MonitorFetch => (url) => {
      asked.push(url);
      return url.endsWith("/props") ? answer({ ...llamaProps, endpoint_metrics: metricsFlag }) : url.endsWith("/slots") ? answer(llamaSlots) : answer(metricsBody);
    };
    const withSpeed = await fetchEngine("llama", 8082, undefined, llamaFetch(true, llamaMetrics));
    expect(asked).toContain("http://127.0.0.1:8082/metrics");
    expect(withSpeed.engine?.speed?.decodeTokS).toBe(50);
    asked.length = 0;
    const off = await fetchEngine("llama", 8082, undefined, llamaFetch(false, llamaMetrics));
    expect(asked.some((url) => url.endsWith("/metrics"))).toBe(false);
    expect(off.engine?.speedMissing).toBe("no-metrics");
    const huge = await fetchEngine("llama", 8082, undefined, llamaFetch(true, "x".repeat(MAX_METRICS_BYTES + 1)));
    expect(huge.engine?.speedMissing).toBe("metrics-unread");
    expect(withSpeed.alias).toBe("inkling-2-mini");
    expect(llamaAlias({ model_alias: "C:\\models\\x.gguf" })).toBeUndefined();
    // A /metrics body that never ends is cancelled once it passes the cap, never read to its end.
    let cancelled = false;
    const endless: MonitorFetch = (url) => {
      if (!url.endsWith("/metrics")) return llamaFetch(true, "")(url, { signal: AbortSignal.timeout(1000) });
      const body = { getReader: () => ({ read: async () => ({ done: false, value: new Uint8Array(16 * 1024) }), cancel: async () => { cancelled = true; } }) };
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}), text: () => Promise.reject(new Error("text() must not be used")), body });
    };
    expect((await fetchEngine("llama", 8082, undefined, endless)).engine?.speedMissing).toBe("metrics-unread");
    expect(cancelled).toBe(true);
    // Something else on the port (no total_slots, no default_generation_settings in /props) is not shown as a model.
    expect(await fetchEngine("llama", 8082, undefined, () => answer({ status: "ok" }))).toEqual({ error: "unexpected answer" });

    let calls = 0;
    expect(await fetchEngine("gufo", 8081, "k", () => { calls += 1; return answer({}); })).toEqual({});
    expect(calls).toBe(0);
  });

  it("says no local model is loaded when only the embedding server runs", () => {
    expect(localState([entry("gufo", "stopped"), entry("strata", "stopped"), entry("llama", "stopped"), entry("embed", "ready")])).toEqual({ state: "none" });
    expect(localState([entry("strata", "ready"), entry("embed", "ready")])).toMatchObject({ server: "strata", state: "ready" });
  });
});
