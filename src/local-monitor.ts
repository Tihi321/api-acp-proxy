// Read-only monitor of the local model the proxy holds (AAP-47). Plain Node, no Electron import.
// Privacy: the mappers WHITELIST fields. Only numbers, booleans and a few short enum-like strings are copied; nothing else
// from the engine's answer (prompts, answers, model paths, ids) ever reaches the window.
import os from "node:os";
import type { EngineRequestView, EngineSlotView, EngineView, LocalServerStatusView, MonitorView } from "./shared/ipc.js";

export const MAX_ENGINE_REQUESTS = 12;
const MAX_TEXT = 64;
const STATES: readonly EngineView["state"][] = ["idle", "reading", "generating", "queued", "unloaded", "busy", "error"];

type Obj = Record<string, unknown>;
const obj = (value: unknown): Obj | undefined => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Obj) : undefined);
const num = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
const bool = (value: unknown): boolean | undefined => (typeof value === "boolean" ? value : undefined);
const text = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value.slice(0, MAX_TEXT) : undefined);
const round1 = (value: number): number => Math.round(value * 10) / 10;
/** Defined entries only, so the view carries no `undefined` keys. */
const compact = <T extends object>(value: T): T => Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
const rate = (tokens: number | undefined, ms: number | undefined): number | undefined => (tokens !== undefined && ms !== undefined && ms > 0 && tokens > 0 ? round1(tokens / (ms / 1000)) : undefined);

/** Strata's `GET /metrics` as the view: counts, timings and hardware only. */
export function mapStrataMetrics(json: unknown): EngineView {
  const root = obj(json) ?? {};
  const engine = obj(root["engine"]) ?? {};
  const live = obj(root["live"]) ?? {};
  const totals = obj(root["totals"]);
  const hardware = obj(root["hardware"]);
  const hardwareStatic = obj(root["hardware_static"]);
  const rawState = text(live["state"]);
  const state = STATES.find((candidate) => candidate === rawState) ?? "unknown";

  const slots: EngineSlotView[] = (Array.isArray(live["slots"]) ? live["slots"] : []).flatMap((entry): EngineSlotView[] => {
    const slot = obj(entry);
    const id = num(slot?.["slot"]);
    if (!slot || id === undefined) return [];
    return [{ id, busy: slot["state"] !== "idle", tokens: num(slot["held_tokens"]) ?? 0 }];
  });

  const requests: EngineRequestView[] = (Array.isArray(root["requests"]) ? root["requests"] : []).flatMap((entry): EngineRequestView[] => {
    const request = obj(entry);
    const time = num(request?.["time"]);
    if (!request || time === undefined) return [];
    return [compact({
      time: Math.round(time * 1000), durationS: num(request["duration_s"]) ?? 0, finish: text(request["finish"]),
      promptTokens: num(request["prompt_tokens"]) ?? 0, reused: num(request["reused"]) ?? 0, outputTokens: num(request["output_tokens"]) ?? 0,
      prefillTokS: rate(num(request["prompt_read"]), num(request["prompt_ms"])), decodeTokS: num(request["decode_tok_s"]),
    })];
  }).sort((a, b) => b.time - a.time).slice(0, MAX_ENGINE_REQUESTS);

  const promptTokens = num(totals?.["prompt_tokens"]);
  const reused = num(totals?.["reused"]);
  const speed = compact({
    decodeTokS: rate(num(totals?.["output_tokens"]), num(totals?.["decode_ms"])),
    prefillTokS: rate(promptTokens !== undefined && reused !== undefined ? promptTokens - reused : undefined, num(totals?.["prompt_ms"])),
  });
  const strata = compact({
    kv: text(engine["kv"]), kvResident: num(engine["kv_resident"]), expertSlots: num(engine["expert_slots"]),
    expertCacheMiB: num(engine["expert_cache_mib"]), drafting: text(engine["drafting"]),
  });
  const hw = compact({
    gpuName: text(hardwareStatic?.["gpu_name"]), gpuUtilPct: num(hardware?.["gpu_util"]), gpuMemUsedBytes: num(hardware?.["gpu_mem_used"]),
    gpuMemTotalBytes: num(hardware?.["gpu_mem_total"]), gpuTempC: num(hardware?.["gpu_temp"]), gpuPowerW: num(hardware?.["gpu_power"]),
    diskReadMBs: num(hardware?.["disk_read_mb"]),
  });
  return compact({
    kind: "strata" as const, version: text(engine["version"]), state, context: num(engine["context"]), images: bool(engine["images"]), slots,
    speed: Object.keys(speed).length ? speed : undefined,
    reuse: promptTokens !== undefined && reused !== undefined ? { reused, prompt: promptTokens, requests: num(totals?.["requests"]) ?? 0 } : undefined,
    strata: Object.keys(strata).length ? strata : undefined,
    hardware: Object.keys(hw).length ? hw : undefined,
    requests,
  });
}

/** llama-server's `GET /props` and `GET /slots` as the view. `/slots` fields `prompt`, `params` and `next_token` are never read. */
export function mapLlama(props: unknown, slotsJson: unknown): EngineView {
  const root = obj(props) ?? {};
  const modalities = obj(root["modalities"]);
  const rawSlots = Array.isArray(slotsJson) ? slotsJson : undefined;
  const slots: EngineSlotView[] = (rawSlots ?? []).flatMap((entry): EngineSlotView[] => {
    const slot = obj(entry);
    const id = num(slot?.["id"]);
    if (!slot || id === undefined) return [];
    return [compact({ id, busy: slot["is_processing"] === true, tokens: num(slot["n_prompt_tokens"]) ?? 0, ctx: num(slot["n_ctx"]) })];
  });
  const count = slots.length || num(root["total_slots"]) || 0;
  const perSlot = slots[0]?.ctx;
  const build = text(root["build_info"]);
  return compact({
    kind: "llama" as const, version: build, state: rawSlots === undefined ? ("unknown" as const) : slots.some((slot) => slot.busy) ? ("busy" as const) : ("idle" as const),
    context: perSlot !== undefined && count > 0 ? perSlot * count : undefined, images: bool(modalities?.["vision"]), slots, requests: [] as EngineRequestView[],
  });
}

/** The minimal fetch the monitor needs (global `fetch` fits). */
export type MonitorFetch = (url: string, init: { headers?: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
type Read = { json: unknown } | { error: string };

async function readJson(fetchImpl: MonitorFetch, url: string, headers: Record<string, string>, timeoutMs: number): Promise<Read> {
  let response: Awaited<ReturnType<MonitorFetch>>;
  try { response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) }); } catch { return { error: "not reachable" }; }
  if (!response.ok) return { error: `HTTP ${response.status}` };
  try { return { json: await response.json() }; } catch { return { error: "unexpected answer" }; }
}

/** Reads the status endpoints of the loaded server on 127.0.0.1 (GET only). The key, when there is one, goes in the request header and nowhere else. Gufo: no known endpoint, no request. */
export async function fetchEngine(server: "gufo" | "strata" | "llama", port: number, apiKey: string | undefined, fetchImpl: MonitorFetch, timeoutMs = 1500): Promise<{ engine?: EngineView; error?: string }> {
  if (server === "gufo") return {};
  const base = `http://127.0.0.1:${port}`;
  if (server === "strata") {
    const read = await readJson(fetchImpl, `${base}/metrics`, apiKey ? { Authorization: `Bearer ${apiKey}` } : {}, timeoutMs);
    if ("error" in read) return { error: read.error };
    const root = obj(read.json);
    if (!root || (!obj(root["engine"]) && !obj(root["live"]))) return { error: "unexpected answer" };
    return { engine: mapStrataMetrics(read.json) };
  }
  const [props, slots] = await Promise.all([readJson(fetchImpl, `${base}/props`, {}, timeoutMs), readJson(fetchImpl, `${base}/slots`, {}, timeoutMs)]);
  if ("error" in props) return { error: props.error };
  if (!obj(props.json)) return { error: "unexpected answer" };
  return { engine: mapLlama(props.json, "json" in slots ? slots.json : undefined) };
}

/** Returns a function giving the CPU load in percent since its previous call (undefined on the first call). */
export function cpuSampler(read: () => os.CpuInfo[] = os.cpus): () => number | undefined {
  let previous: { idle: number; total: number } | undefined;
  return () => {
    let idle = 0;
    let total = 0;
    for (const cpu of read()) { const t = cpu.times; idle += t.idle; total += t.user + t.nice + t.sys + t.idle + t.irq; }
    const before = previous;
    previous = { idle, total };
    if (!before || total <= before.total) return undefined;
    return round1(100 * (1 - (idle - before.idle) / (total - before.total)));
  };
}

/** This PC, from Node's `os`. */
export function hostView(cpuPct: number | undefined): MonitorView["host"] {
  const cpus = os.cpus();
  const total = os.totalmem();
  return compact({ cpuName: cpus[0]?.model?.trim() ?? "unknown", threads: cpus.length, cpuPct, ramUsedBytes: total - os.freemem(), ramTotalBytes: total });
}

/** The `--context N` of a Gufo profile's arguments, when it has one. */
export function contextFromArgs(args: string): number | undefined {
  const match = /--context[ =](\d+)/.exec(args);
  return match ? Number(match[1]) : undefined;
}

/** Which exclusive server the monitor shows: the one starting or ready, else the newest one in error, else none. `embed` never counts. */
export function localState(list: readonly LocalServerStatusView[]): MonitorView["local"] {
  const exclusive = list.filter((entry): entry is LocalServerStatusView & { id: "gufo" | "strata" | "llama" } => entry.id !== "embed");
  const active = exclusive.find((entry) => entry.state === "starting" || entry.state === "ready");
  const failed = [...exclusive].filter((entry) => entry.state === "error").sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))[0];
  const chosen = active ?? failed;
  if (!chosen) return { state: "none" };
  return compact({
    server: chosen.id, state: chosen.state as "starting" | "ready" | "error", profile: chosen.profile, port: chosen.port,
    startedAt: chosen.startedAt, readyAt: chosen.readyAt, error: chosen.error,
  });
}
