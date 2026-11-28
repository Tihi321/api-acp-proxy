import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { ProxyConfig } from "./config.js";
import { silentLogger, type Logger } from "./logger.js";
import { HEADER_NAME, MCP_LABEL, plainValue } from "./mcp-config.js";
import { BRIDGE_SERVER_NAME } from "./tool-bridge.js";

const nonNegative = (fallback: number) => z.number().int().min(0).default(fallback);
const positive = (fallback: number) => z.number().int().positive().default(fallback);

const localBase = (defaults: { port: number; command: string; cwd: string }) => ({
  enabled: z.boolean().default(true),
  /** 127.0.0.1:<port> is where the proxy sends requests and where the launcher probes /v1/models. `{port}` in `args` is replaced with it. */
  port: z.number().int().min(1).max(65535).default(defaults.port),
  command: z.string().default(defaults.command),
  cwd: z.string().default(defaults.cwd),
  apiKey: z.string().optional(),
  maxConcurrent: z.number().int().min(0).default(1),
});

/** A local OpenAI-compatible model server (Strata) that the desktop app can start itself. */
const localProviderSchema = (defaults: { port: number; command: string; args: string; cwd: string }) => z.object({
  ...localBase(defaults),
  /** One command-line string, passed to cmd.exe as written after the quoted command. */
  args: z.string().default(defaults.args),
}).default({});

/** Ollama (AAP-69): a server that manages itself, so no launcher fields; the proxy only talks to its OpenAI-compatible `/v1`. */
export const OLLAMA_DEFAULT_URL = "http://127.0.0.1:11434";
const ollamaProviderSchema = z.object({
  enabled: z.boolean().default(true),
  /** Where Ollama listens; a trailing `/` or `/v1` is ignored. */
  baseUrl: z.string().trim().refine((value) => { try { return /^https?:$/.test(new URL(value).protocol); } catch { return false; } }, "must be an http:// or https:// URL").default(OLLAMA_DEFAULT_URL),
  apiKey: z.string().optional(),
  maxConcurrent: z.number().int().min(0).default(1),
  /** Prompt limit in characters for every model (0 = no limit; absent = the model's context length x 4, read from Ollama). */
  maxPromptChars: z.number().int().min(0).optional(),
}).default({});

/** DeepSeek (AAP-70): the official cloud API, paid per token; the key is encrypted at rest and `PROXY_DEEPSEEK_API_KEY` overrides it. */
export const DEEPSEEK_DEFAULT_URL = "https://api.deepseek.com";
const deepseekProviderSchema = z.object({
  enabled: z.boolean().default(false),
  /** The API root; a trailing `/` or `/v1` is ignored. `https:` only, except `http:` for localhost (tests, fakes). */
  baseUrl: z.string().trim().refine((value) => {
    try { const url = new URL(value); return url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)); } catch { return false; }
  }, "must be an https:// URL (http:// only for localhost)").default(DEEPSEEK_DEFAULT_URL),
  apiKey: z.string().optional(),
  maxConcurrent: z.number().int().min(0).default(4),
  /** Prompt limit in characters for every model (0 = no limit; absent = the model's context length x 4). */
  maxPromptChars: z.number().int().min(0).optional(),
}).default({});

/** Fields shared by the Gufo and Llama.cpp profiles. */
const profileBase = z.object({
  /** Slug, unique in the list. */
  id: z.string().regex(/^[a-z0-9._-]{1,48}$/, "A profile id is 1 to 48 characters of a-z, 0-9, '.', '_' or '-'."),
  label: z.string().min(1),
  /** The id exposed as <provider>/<model> and sent upstream; unique in the list. */
  model: z.string().min(1),
  /** llm only: accepts image parts. */
  vision: z.boolean().default(false),
  startTimeoutMs: z.number().int().positive().optional(),
  requestTimeoutMs: z.number().int().positive().optional(),
});

/** One Gufo model: the launcher runs `args`, the proxy exposes it as `gufo/<model>`. */
const gufoProfileSchema = profileBase.extend({
  kind: z.enum(["llm", "image"]),
  /** One command-line string, {port} replaced; passed to cmd.exe as written after the quoted command. */
  args: z.string(),
});
export type GufoProfile = z.infer<typeof gufoProfileSchema>;

const GUFO_DEFAULT_ARGS = "serve llm --model qwen27-q4 --speculative dflash2 --dflash-model D:\\Gufo\\models\\qwen27-q4\\Qwen3.8-27B-DFlash2-Q4_K_M.gguf --port {port} --context 32768";
const imagePreset = (id: string, label: string): GufoProfile => ({ id, label, model: id, kind: "image", vision: false, args: `serve image --model ${id} --served-model-name ${id} --port {port} --max-request-bytes 67108864` });
/** The built-in Gufo profiles (editable; paths follow the D:\Gufo\models\<id> layout, flags beyond the first are inferred and unrun). */
export const GUFO_PRESETS: readonly GufoProfile[] = [
  { id: "qwen27-q4", label: "Qwen3.8 27B (Q4)", model: "Qwen3.8-27B", kind: "llm", vision: false, args: GUFO_DEFAULT_ARGS },
  { id: "flash-next-q4", label: "Qwen3.8 Flash-Next (Q4, vision)", model: "flash-next-q4", kind: "llm", vision: true, args: "serve llm --model flash-next-q4 --served-model-name flash-next-q4 --speculative mtp --mtp-model D:\\Gufo\\models\\flash-next-q4\\MTP\\mtp-Qwen3.8-Flash-Next-shared-Q8_0.gguf --mmproj D:\\Gufo\\models\\flash-next-q4\\mmproj-BF16.gguf --port {port} --context 32768 --max-request-bytes 33554432" },
  { id: "deepseek4", label: "DeepSeek V4 Flash", model: "deepseek4", kind: "llm", vision: false, args: "serve llm --model deepseek4 --served-model-name deepseek4 --speculative dspark --dspark-model D:\\Gufo\\models\\deepseek4\\DeepSeek-V4-Flash-DSpark-support-0731.gguf --port {port} --context 16384" },
  imagePreset("qwen-image-2.1", "Qwen-Image 2.1"),
  imagePreset("qwen-image-2.1-turbo", "Qwen-Image 2.1 Turbo"),
];
const clonePresets = (): GufoProfile[] => GUFO_PRESETS.map((preset) => ({ ...preset }));

/** `profiles` plus the presets whose id is absent (the Settings "Restore missing presets" action). Pure. */
export function restoreMissingPresets(profiles: readonly GufoProfile[]): GufoProfile[] {
  const have = new Set(profiles.map((profile) => profile.id));
  const models = new Set(profiles.map((profile) => profile.model));
  return [...profiles.map((profile) => ({ ...profile })), ...clonePresets().filter((preset) => !have.has(preset.id) && !models.has(preset.model))];
}

/** Settings written before profiles existed: no `profiles` -> the presets, and a stored `args` becomes the args of `qwen27-q4`. Runs at every parse; stored `profiles` always win. */
function migrateGufo(input: unknown): unknown {
  const raw = isPlain(input) ? input : {};
  if (Array.isArray(raw.profiles)) return raw;
  const profiles = clonePresets();
  const qwen27 = profiles.find((profile) => profile.id === "qwen27-q4");
  if (typeof raw.args === "string" && qwen27) qwen27.args = raw.args;
  return { ...raw, profiles };
}

const gufoProviderSchema = z.preprocess(migrateGufo, z.object({
  ...localBase({ port: 8081, command: "D:\\Gufo\\gufo.cmd", cwd: "D:\\Gufo" }),
  /** How long a request waits for a busy Gufo (another model running a request) before it gets 503 local_model_busy. */
  switchWaitMs: z.number().int().positive().default(30 * 60 * 1000),
  profiles: z.array(gufoProfileSchema).default([]).superRefine((profiles, ctx) => {
    profiles.forEach((profile, index) => { if (profile.id === "strata") ctx.addIssue({ code: "custom", path: [index, "id"], message: "The profile id 'strata' is reserved for the Strata server." }); });
    for (const key of ["id", "model"] as const) {
      const seen = new Set<string>();
      profiles.forEach((profile, index) => {
        if (seen.has(profile[key])) ctx.addIssue({ code: "custom", path: [index, key], message: `Duplicate profile ${key} '${profile[key]}'.` });
        seen.add(profile[key]);
      });
    }
  }),
}).default({} as never));

export const LLAMA_SOURCES = ["ggml-org", "unsloth"] as const;
export type LlamaSource = (typeof LLAMA_SOURCES)[number];
export const LLAMA_SPEC_TYPES = ["none", "draft-simple", "draft-eagle3", "draft-mtp", "draft-dflash", "draft-dspark", "draft-dflash2",
  "draft-lilicorr", "ngram-simple", "ngram-map-k", "ngram-map-k4v", "ngram-mod", "ngram-cache"] as const;
const layers = z.union([z.enum(["auto", "all"]), z.number().int().min(0)]);

/** One llama.cpp model: structured fields that generate the llama-server args; the proxy exposes it as `llama/<model>`. Always an llm. */
const llamaProfileSchema = profileBase.extend({
  /** Relative to `modelsDir` or absolute; the first shard of a split model. */
  modelFile: z.string().min(1),
  mmprojFile: z.string().min(1).optional(),
  ctxSize: z.number().int().positive().optional(),
  gpuLayers: layers.default("auto"),
  flashAttn: z.enum(["auto", "on", "off"]).default("auto"),
  specType: z.enum(LLAMA_SPEC_TYPES).default("none"),
  draftFile: z.string().min(1).optional(),
  draftNMax: z.number().int().positive().optional(),
  draftNMin: z.number().int().min(0).optional(),
  draftGpuLayers: layers.optional(),
  /** Appended verbatim after the generated flags. */
  extraArgs: z.string().default(""),
  /** Where "Find on Hugging Face" points (the download card is filled with this repository and quant). */
  hf: z.object({
    repo: z.string().min(1),
    revision: z.string().min(1).default("main"),
    quant: z.string().min(1),
    mmproj: z.string().optional(),
    draft: z.string().optional(),
  }).optional(),
  requires: z.object({
    minBuild: z.number().int().positive().optional(),
    sources: z.array(z.enum(LLAMA_SOURCES)).optional(),
  }).optional(),
}).refine((profile) => !profile.vision || !!profile.mmprojFile, { path: ["mmprojFile"], message: "A vision profile needs an mmproj file." });
export type LlamaProfile = z.infer<typeof llamaProfileSchema>;

const INKLING_SAMPLING = "--temp 1.0 --top-p 1.0 --top-k 0 --min-p 0.0";
/** AAP-54 Strix Halo ROCm speed flags (research-flags.md 4a): no mmap (slow ROCm loads), larger ubatch (prefill), one slot (full ctx), 16 physical cores. AAP-55: current llama-server builds have no `--no-mmap`; `-lm none` (--load-mode: no special loading mode, so no mmap) replaces it. */
const STRIX_HALO_ROCM = "-lm none -ub 1024 -np 1 -t 16";
/** AAP-55: rewrites the standalone token `--no-mmap` (rejected by current llama-server builds) to `-lm none`. Pure and idempotent; touches nothing else. */
export const migrateNoMmap = (args: string): string => args.replace(/(^|\s)--no-mmap(?=\s|$)/g, "$1-lm none");
const migrateStored = (list: unknown, field: "extraArgs" | "args"): unknown => Array.isArray(list)
  ? list.map((item) => isPlain(item) && typeof item[field] === "string" ? { ...item, [field]: migrateNoMmap(item[field]) } : item)
  : list;
/** The built-in llama.cpp profiles (editable; the exact file names are inferred; pick the files you have, or use "Use found files"). */
export const LLAMA_PRESETS: readonly LlamaProfile[] = [
  {
    id: "inkling-2-mini", label: "Inkling 2 Mini (Q8_0, vision)", model: "inkling-2-mini", vision: true,
    modelFile: "ggml-org/Inkling-2-Mini-GGUF/Inkling-2-Mini-Q8_0.gguf", mmprojFile: "ggml-org/Inkling-2-Mini-GGUF/mmproj-Inkling-2-Mini-BF16.gguf",
    ctxSize: 32768, gpuLayers: "all", flashAttn: "on", specType: "none", extraArgs: `${STRIX_HALO_ROCM} ${INKLING_SAMPLING}`,
    hf: { repo: "ggml-org/Inkling-2-Mini-GGUF", revision: "main", quant: "Q8_0", mmproj: "mmproj-Inkling-2-Mini-BF16.gguf" },
    requires: { minBuild: 12607, sources: ["unsloth"] },
  },
  // AAP-59: experimental. On Strix Halo (Inkling 2 Mini IQ4_NL, temp 1.0) DSpark measured about 20 t/s against about 33 t/s plain (bench2.md); draft max 3 was the best of 2/3/5/7 (20.4 vs 17.0 at 5, acceptance 0.37 vs 0.21). Needs the Unsloth build (ggml-org cannot load the draft).
  {
    id: "inkling-2-mini-dspark", label: "Inkling 2 Mini DSpark (Unsloth build, experimental)", model: "inkling-2-mini-dspark", vision: true,
    modelFile: "unsloth/Inkling-2-Mini-GGUF/Inkling-2-Mini-UD-Q8_K_XL.gguf", mmprojFile: "unsloth/Inkling-2-Mini-GGUF/mmproj-F16.gguf",
    ctxSize: 32768, gpuLayers: "all", flashAttn: "on", specType: "draft-dspark", draftFile: "unsloth/Inkling-2-Mini-GGUF/dspark-Inkling-2-Mini-Q8_0.gguf",
    draftNMax: 3, draftGpuLayers: "all", extraArgs: `${STRIX_HALO_ROCM} ${INKLING_SAMPLING}`,
    hf: { repo: "unsloth/Inkling-2-Mini-GGUF", revision: "main", quant: "UD-Q8_K_XL", mmproj: "mmproj-F16.gguf", draft: "dspark-Inkling-2-Mini-Q8_0.gguf" },
    requires: { sources: ["unsloth"] },
  },
  // AAP-60: DSpine (Tencent) on Qwen3.8-27B, measured on Strix Halo (bench.md): 31.9 t/s average at temp 1.0 against 12.9 plain, draft max 15 (the DSpine block is 16, so 15 is the most; the speed rises up to it). It needs a custom llama.cpp fork build (Ajay9o9/llama.cpp, branch dspine, commit 4703b7d): set the binary to "My own llama-server.exe". The fork has no `draft-dspine` spec type; `draft-dflash` picks the DSpine GGUF up. `requires` stays off on purpose: it cannot say "this fork", and a `sources` gate would block exactly the custom exe this needs (it only warns "unknown" there).
  {
    id: "qwen3.8-27b-dspine", label: "Qwen 3.8-27B DSpine (code; custom dspine fork build)", model: "qwen3.8-27b-dspine", vision: false,
    modelFile: "unsloth/Qwen3.8-27B-GGUF/Qwen3.8-27B-UD-Q4_K_M.gguf", ctxSize: 16384, gpuLayers: "all", flashAttn: "on",
    specType: "draft-dflash", draftFile: "aj9o9/Qwen3.8-27B-DSpine-b16-GGUF/Qwen3.8-27B-DSpine-b16-Q4_K_M.gguf",
    draftNMax: 15, draftGpuLayers: "all", extraArgs: "-np 1 --jinja",
    hf: { repo: "unsloth/Qwen3.8-27B-GGUF", revision: "main", quant: "UD-Q4_K_M", draft: "Qwen3.8-27B-DSpine-b16-Q4_K_M.gguf" },
  },
  // AAP-60: stock MTP on Qwen3.8-27B (bench.md): draft max 3 averaged 23.8 t/s at temp 1.0 (plain 12.7 to 12.9); prose drops to about 14, so max 2 is the prose-safe value. Ran on the Unsloth b12651 rocm-gfx1151 build and on ggml-org b12675 (Vulkan), hence minBuild 12651 for any source.
  {
    id: "qwen3.8-27b-mtp", label: "Qwen 3.8-27B MTP", model: "qwen3.8-27b-mtp", vision: false,
    modelFile: "unsloth/Qwen3.8-27B-GGUF/Qwen3.8-27B-UD-Q4_K_M.gguf", ctxSize: 16384, gpuLayers: "all", flashAttn: "on",
    specType: "draft-mtp", draftFile: "unsloth/Qwen3.8-27B-GGUF/MTP/mtp-Qwen3.8-27B-Q4_0.gguf",
    draftNMax: 3, draftGpuLayers: "all", extraArgs: "-np 1 --jinja",
    hf: { repo: "unsloth/Qwen3.8-27B-GGUF", revision: "main", quant: "UD-Q4_K_M", draft: "MTP/mtp-Qwen3.8-27B-Q4_0.gguf" },
    requires: { minBuild: 12651 },
  },
  // AAP-64: PrismML Ternary Bonsai 2.5 27B (Qwen3.8-27B base, ternary Q2_0, 7.7 GB). Stock llama.cpp runs Q2_0 from build b11556 on (older builds print garbage). Sampling is the vendor thinking-mode set (temp 1.0, top-p 0.95, top-k 20, min-p 0; llama.cpp defaults min-p to 0.05). Measured speeds: .claude/tickets/AAP-64-bonsai-2-5/bench.md.
  {
    id: "bonsai-2.5-27b", label: "Bonsai 2.5 27B (ternary Q2_0)", model: "bonsai-2.5-27b", vision: true,
    modelFile: "prism-ml/Ternary-Bonsai-2.5-27B-GGUF/Ternary-Bonsai-2.5-27B-Q2_0.gguf", mmprojFile: "prism-ml/Ternary-Bonsai-2.5-27B-GGUF/Ternary-Bonsai-2.5-27B-mmproj-Q8_0.gguf",
    ctxSize: 32768, gpuLayers: "all", flashAttn: "on", specType: "none", extraArgs: "-np 1 --jinja --temp 1.0 --top-p 0.95 --top-k 20 --min-p 0",
    hf: { repo: "prism-ml/Ternary-Bonsai-2.5-27B-GGUF", revision: "main", quant: "Q2_0", mmproj: "Ternary-Bonsai-2.5-27B-mmproj-Q8_0.gguf" },
    requires: { minBuild: 11556 },
  },
  // AAP-64: the same model from the "-mtp" GGUF, which carries its draft head inside (no draft file). MTP draft max 3 gave 45 t/s average on ROCm and 38 on Vulkan against 24 / 23 plain; prose is the slowest prompt (35 t/s at max 3; max 2 gives 36.6, max 4 34.3), so 3 is the middle. See bench.md.
  {
    id: "bonsai-2.5-27b-mtp", label: "Bonsai 2.5 27B MTP (ternary Q2_0)", model: "bonsai-2.5-27b-mtp", vision: true,
    modelFile: "prism-ml/Ternary-Bonsai-2.5-27B-GGUF/Ternary-Bonsai-2.5-27B-Q2_0-mtp.gguf", mmprojFile: "prism-ml/Ternary-Bonsai-2.5-27B-GGUF/Ternary-Bonsai-2.5-27B-mmproj-Q8_0.gguf",
    ctxSize: 32768, gpuLayers: "all", flashAttn: "on", specType: "draft-mtp", draftNMax: 3, extraArgs: "-np 1 --jinja --temp 1.0 --top-p 0.95 --top-k 20 --min-p 0",
    hf: { repo: "prism-ml/Ternary-Bonsai-2.5-27B-GGUF", revision: "main", quant: "Q2_0-mtp", mmproj: "Ternary-Bonsai-2.5-27B-mmproj-Q8_0.gguf" },
    requires: { minBuild: 11556 },
  },
];
const cloneLlamaPresets = (): LlamaProfile[] => structuredClone(LLAMA_PRESETS) as LlamaProfile[];

/** `profiles` plus the presets whose id and model are absent (same rule as `restoreMissingPresets`). Pure. */
export function restoreMissingLlamaPresets(profiles: readonly LlamaProfile[]): LlamaProfile[] {
  const have = new Set(profiles.map((profile) => profile.id));
  const models = new Set(profiles.map((profile) => profile.model));
  return [...structuredClone(profiles) as LlamaProfile[], ...cloneLlamaPresets().filter((preset) => !have.has(preset.id) && !models.has(preset.model))];
}

const llamaFlagPresetSchema = z.object({
  id: z.string().regex(/^[a-z0-9._-]{1,48}$/, "A flag preset id is 1 to 48 characters of a-z, 0-9, '.', '_' or '-'."),
  label: z.string().min(1, "A flag preset needs a name."),
  /** Copied into a profile's extraArgs when applied; never referenced by a profile. */
  args: z.string(),
});
export type LlamaFlagPreset = z.infer<typeof llamaFlagPresetSchema>;
/** The built-in flag presets (AAP-54): only flags no profile field generates, so the command line never carries a flag twice. */
export const LLAMA_FLAG_PRESETS: readonly LlamaFlagPreset[] = [
  { id: "strix-halo-rocm", label: "Strix Halo ROCm speed", args: `${STRIX_HALO_ROCM} ${INKLING_SAMPLING}` },
  { id: "strix-halo-rocm-kv-q8", label: "Strix Halo ROCm speed, KV cache q8_0 (less memory, needs Flash attention on)", args: `${STRIX_HALO_ROCM} -ctk q8_0 -ctv q8_0 ${INKLING_SAMPLING}` },
  { id: "inkling-sampling", label: "Inkling sampling only (the old default)", args: INKLING_SAMPLING },
];
const cloneLlamaFlagPresets = (): LlamaFlagPreset[] => structuredClone(LLAMA_FLAG_PRESETS) as LlamaFlagPreset[];

/** `presets` plus the built-in flag presets whose id is absent. Pure. */
export function restoreMissingLlamaFlagPresets(presets: readonly LlamaFlagPreset[]): LlamaFlagPreset[] {
  const have = new Set(presets.map((preset) => preset.id));
  return [...structuredClone(presets) as LlamaFlagPreset[], ...cloneLlamaFlagPresets().filter((preset) => !have.has(preset.id))];
}

const llamaInstallInfoSchema = z.object({
  source: z.enum(LLAMA_SOURCES),
  tag: z.string(),
  build: z.number().int().optional(),
  backend: z.string(),
  arch: z.enum(["x64", "arm64"]),
  assetName: z.string(),
  sha256: z.string(),
  runtimeAssetName: z.string().optional(),
  command: z.string(),
  dir: z.string(),
  installedAt: z.string(),
});
export type LlamaInstallInfo = z.infer<typeof llamaInstallInfoSchema>;

/** The embedding server (nomic-embed-text-v1.5 by default): its own small llama-server beside the chat model, started on the first `POST /v1/embeddings`. */
const llamaEmbeddingSchema = z.object({
  enabled: z.boolean().default(false),
  /** 127.0.0.1:<port>; must differ from the Gufo, Strata and Llama.cpp ports. */
  port: z.number().int().min(1).max(65535).default(8083),
  /** The id exposed as `llama/<model>` and passed as `--alias`. */
  model: z.string().min(1).default("nomic-embed-text-v1.5"),
  /** Relative to `modelsDir` or absolute. */
  modelFile: z.string().min(1).default("nomic-ai/nomic-embed-text-v1.5-GGUF/nomic-embed-text-v1.5.Q4_K_M.gguf"),
  /** Context per request in tokens; the server gets `-c` = ctxSize x maxConcurrent (llama-server splits `-c` across the `-np` slots). */
  ctxSize: positive(2048),
  gpuLayers: layers.default("all"),
  /** Requests that run at once (`-np`); more wait in a FIFO queue. */
  maxConcurrent: positive(4),
  /** Appended verbatim after the generated flags. */
  extraArgs: z.string().default(""),
  /** Expected vector length; a different one is refused (502). 0 = not checked. nomic-embed-text-v1.5 gives 768. */
  dimensions: z.number().int().min(0).default(768),
}).default({});
export type LlamaEmbedding = z.infer<typeof llamaEmbeddingSchema>;

const llamaProviderSchema = z.preprocess((input) => {
  const raw = isPlain(input) ? input : {};
  return {
    ...raw,
    profiles: Array.isArray(raw.profiles) ? migrateStored(raw.profiles, "extraArgs") : cloneLlamaPresets(),
    flagPresets: Array.isArray(raw.flagPresets) ? migrateStored(raw.flagPresets, "args") : cloneLlamaFlagPresets(),
  };
}, z.object({
  enabled: z.boolean().default(true),
  /** 127.0.0.1:<port>: where the proxy sends requests and the launcher probes /v1/models; always passed as `--port`. */
  port: z.number().int().min(1).max(65535).default(8082),
  maxConcurrent: z.number().int().min(0).default(1),
  /** How long a request waits for a busy local server before it gets 503 local_model_busy. */
  switchWaitMs: z.number().int().positive().default(30 * 60 * 1000),
  modelsDir: z.string().default("D:\\LlamaCpp\\models"),
  /** Hugging Face token (secret; encrypted at rest like apiKey). */
  hfToken: z.string().optional(),
  binary: z.object({
    mode: z.enum(["managed", "custom"]).default("managed"),
    /** Managed installs go to <dir>/<source>-<tag>-<backend>/. */
    dir: z.string().default("D:\\LlamaCpp\\bin"),
    source: z.enum(LLAMA_SOURCES).default("ggml-org"),
    backend: z.string().default("rocm"),
    arch: z.enum(["x64", "arm64"]).default("x64"),
    /** Mode custom: full path of llama-server.exe. */
    customPath: z.string().optional(),
    customBuild: z.number().int().optional(),
    installed: llamaInstallInfoSchema.optional(),
  }).default({}),
  embedding: llamaEmbeddingSchema,
  profiles: z.array(llamaProfileSchema).default([]).superRefine((profiles, ctx) => {
    for (const key of ["id", "model"] as const) {
      const seen = new Set<string>();
      profiles.forEach((profile, index) => {
        if (seen.has(profile[key])) ctx.addIssue({ code: "custom", path: [index, key], message: `Duplicate profile ${key} '${profile[key]}'.` });
        seen.add(profile[key]);
      });
    }
  }),
  /** Named sets of extra arguments (AAP-54); applying one copies `args` into a profile's `extraArgs`. Seeded with the built-ins only when absent. */
  flagPresets: z.array(llamaFlagPresetSchema).default([]).superRefine((presets, ctx) => {
    const seen = new Set<string>();
    presets.forEach((preset, index) => {
      if (seen.has(preset.id)) ctx.addIssue({ code: "custom", path: [index, "id"], message: `Duplicate flag preset id '${preset.id}'.` });
      seen.add(preset.id);
    });
  }),
}).default({} as never));

const mcpLabel = z.string().regex(MCP_LABEL, "An MCP server label is 1 to 64 letters, digits, '_' or '-'.").refine((label) => label !== BRIDGE_SERVER_NAME, `The MCP server label '${BRIDGE_SERVER_NAME}' is reserved for the proxy's own tool bridge.`);
const mcpHttpUrl = z.string().url().refine((value) => /^https?:\/\//i.test(value), "An MCP server url must be http or https.");
const mcpHeaders = z.record(z.string().regex(HEADER_NAME, "Not a valid header name."), z.string().refine(plainValue, "A header value cannot contain line breaks."));
/** A remote server (`url`, http unless `transport` says sse) or a local command (stdio). Stdio servers can only be configured here, never by a request. */
const mcpServerSchema = z.union([
  z.object({ url: mcpHttpUrl, headers: mcpHeaders.optional(), transport: z.enum(["http", "sse"]).optional() }).strict(),
  z.object({ command: z.string().min(1), args: z.array(z.string()).optional(), env: z.record(z.string().min(1), z.string()).optional() }).strict(),
]);
export type McpServerSetting = z.infer<typeof mcpServerSchema>;
const mcpEntryIssue = (error: z.ZodError): string => { const issue = error.issues[0]; return issue ? `${issue.path.length ? `${issue.path.join(".")}: ` : ""}${issue.message}` : "invalid entry"; };

/** The valid entries of a hand-written `mcpServers` value. An invalid entry (or a value that is not an object) is dropped with a warning naming the label and the first issue; it never invalidates the rest of the settings. */
export function sanitizeMcpServers(raw: unknown, logger: Logger = silentLogger): Settings["mcpServers"] {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) { logger.warn("Ignoring 'mcpServers' in the settings file: it must be an object of label to server."); return {}; }
  const kept: Settings["mcpServers"] = {};
  for (const [label, entry] of Object.entries(raw)) {
    const checkedLabel = mcpLabel.safeParse(label);
    if (!checkedLabel.success) { logger.warn(`Ignoring the MCP server '${label}' in the settings file: ${mcpEntryIssue(checkedLabel.error)}`); continue; }
    const checked = mcpServerSchema.safeParse(entry);
    if (checked.success) kept[label] = checked.data;
    else logger.warn(`Ignoring the MCP server '${label}' in the settings file: ${mcpEntryIssue(checked.error)}`);
  }
  return kept;
}

export const settingsSchema = z.object({
  version: z.literal(1).default(1),
  server: z.object({
    host: z.string().min(1).default("127.0.0.1"),
    port: z.number().int().min(0).max(65535).default(8787),
    apiKey: z.string().optional(),
    maxBodyBytes: positive(20 * 1024 * 1024),
    timeoutMs: positive(5 * 60 * 1000),
    modelsWaitMs: positive(3000),
    workRoot: z.string().optional(),
    launchAtLogin: z.boolean().default(false),
    /** Keep agent sessions across the turns of a conversation. */
    reuseSessions: z.boolean().default(false),
    /** List the unprefixed ids (`gpt-x` next to `codex/gpt-x`) in /v1/models. Requests with an unprefixed id are routed either way. */
    listBareAliases: z.boolean().default(true),
    /** How long a turn that called a client tool waits for the tool result before the agent turn is cancelled (the agents' own limits can be shorter). */
    toolResultTimeoutMs: positive(10 * 60 * 1000),
    /** Requests that run at once per provider; more wait in a FIFO queue. 0 = unlimited. */
    maxConcurrent: nonNegative(4),
    /** Requests that may wait per provider; a full queue answers 429. 0 = unlimited. */
    maxQueue: nonNegative(0),
    /** How long a provider that hit its usage limit stays refused when its reset time is unknown, in the past or over 31 days away. */
    usageLimitCooldownMinutes: positive(60),
  }).default({}),
  providers: z.object({
    codex: z.object({
      enabled: z.boolean().default(true),
      authMethodId: z.string().optional(),
      acpCommand: z.string().optional(),
      acpArgs: z.array(z.string()).default([]),
      /** Run Codex with its own CODEX_HOME (`<dataDir>/codex-home`: no user skills, plugins or MCP servers; needs its own login). Off keeps ~/.codex. */
      isolatedHome: z.boolean().default(true),
      /** Overrides `server.maxConcurrent` for this provider (0 = unlimited; absent = the global value). */
      maxConcurrent: z.number().int().min(0).optional(),
      /** Limit on the prompt text in characters; longer prompts are refused with a 400 (0 = unlimited; absent = the provider default: 180000 for Antigravity, none for Codex and Claude). */
      maxPromptChars: z.number().int().min(0).optional(),
      /** Opt-in: a regular expression (case-insensitive) matched against the error of a failed turn; a match marks the provider as having hit its usage limit. Absent: off. */
      usageLimitPattern: z.string().refine((value) => { try { new RegExp(value); return true; } catch { return false; } }, "must be a valid regular expression").optional(),
    }).default({}),
    antigravity: z.object({
      enabled: z.boolean().default(false),
      executablePath: z.string().optional(),
      geminiHome: z.string().optional(),
      apiKey: z.string().optional(),
      authMethodId: z.string().optional(),
      termsAcknowledgedAt: z.string().optional(),
      /** Delete the conversation files of proxy-created sessions after the agent stops. */
      purgeSessions: z.boolean().default(true),
      /** Auth method of the last successful login (written by the provider, not the UI). */
      lastAuthMethodId: z.string().optional(),
      maxConcurrent: z.number().int().min(0).optional(),
      /** Limit on the prompt text in characters; longer prompts are refused with a 400 (0 = unlimited; absent = the provider default: 180000 for Antigravity, none for Codex and Claude). */
      maxPromptChars: z.number().int().min(0).optional(),
      /** Opt-in: a regular expression (case-insensitive) matched against the error of a failed turn; a match marks the provider as having hit its usage limit. Absent: off. */
      usageLimitPattern: z.string().refine((value) => { try { new RegExp(value); return true; } catch { return false; } }, "must be a valid regular expression").optional(),
    }).default({}),
    claude: z.object({
      enabled: z.boolean().default(false),
      /** "subscription" (also when absent): never an API key; `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` are removed from the agent's environment, an `apiKey` setting refuses the start and the Console login is hidden. "any": the old behaviour. */
      authPolicy: z.enum(["subscription", "any"]).optional(),
      apiKey: z.string().optional(),
      oauthToken: z.string().optional(),
      configDir: z.string().optional(),
      executablePath: z.string().optional(),
      authMethodId: z.string().optional(),
      termsAcknowledgedAt: z.string().optional(),
      maxConcurrent: z.number().int().min(0).optional(),
      /** Limit on the prompt text in characters; longer prompts are refused with a 400 (0 = unlimited; absent = the provider default: 180000 for Antigravity, none for Codex and Claude). */
      maxPromptChars: z.number().int().min(0).optional(),
      /** Opt-in: a regular expression (case-insensitive) matched against the error of a failed turn; a match marks the provider as having hit its usage limit. Absent: off. */
      usageLimitPattern: z.string().refine((value) => { try { new RegExp(value); return true; } catch { return false; } }, "must be a valid regular expression").optional(),
    }).default({}),
    gufo: gufoProviderSchema,
    llama: llamaProviderSchema,
    strata: localProviderSchema({ port: 8080, command: "D:\\Strata\\terminal\\run-unsloth-ud-iq4_xs.bat", args: "", cwd: "D:\\Strata" }),
    ollama: ollamaProviderSchema,
    deepseek: deepseekProviderSchema,
  }).default({}),
  /** MCP servers a Responses request may name by `server_label` (JSON only, no settings-window editor). Headers and env are stored as written. */
  mcpServers: z.record(mcpLabel, mcpServerSchema).default({}),
}).superRefine((settings, ctx) => {
  const { gufo, strata, llama } = settings.providers;
  const taken = new Map<number, string>([[gufo.port, "Gufo"], [strata.port, "Strata"], [llama.port, "Llama.cpp"]]);
  if (settings.server.port !== 0) taken.set(settings.server.port, "proxy server");
  const clash = llama.embedding.enabled ? taken.get(llama.embedding.port) : undefined;
  if (clash) ctx.addIssue({ code: "custom", path: ["providers", "llama", "embedding", "port"], message: `The embedding port ${llama.embedding.port} is already the ${clash} port.` });
});

export type Settings = z.infer<typeof settingsSchema>;
/** Deep partial; `null` clears an optional field. */
export type SettingsPatch = { [K in keyof Settings]?: Settings[K] extends object ? { [P in keyof Settings[K]]?: Settings[K][P] extends object ? { [Q in keyof Settings[K][P]]?: Settings[K][P][Q] | null } : Settings[K][P] | null } : Settings[K] };
/** Settings for one provider, keyed by provider id in `Settings.providers`. */
export type ProviderSettings = { enabled: boolean } & Record<string, unknown>;

export interface SecretCodec { encode(plain: string): string; decode(stored: string): string; }
const SECRET_PREFIX = "enc:";

export function defaultSettings(): Settings { return settingsSchema.parse({}); }

export function defaultSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PROXY_SETTINGS_FILE) return path.resolve(env.PROXY_SETTINGS_FILE);
  const base = process.platform === "win32" ? env.APPDATA || path.join(os.homedir(), "AppData", "Roaming")
    : process.platform === "darwin" ? path.join(os.homedir(), "Library", "Application Support")
    : env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "api-acp-proxy", "settings.json");
}

function isPlain(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

export function mergeSettings(current: Settings, patch: SettingsPatch): Settings {
  const merge = (base: Record<string, unknown>, change: Record<string, unknown>, where = ""): Record<string, unknown> => {
    const out = { ...base };
    for (const [key, value] of Object.entries(change)) {
      if (value === undefined) continue;
      const here = where ? `${where}.${key}` : key;
      if (value === null) delete out[key];
      // providers.llama.binary is replaced as a whole value (contract C1), so omitted keys are cleared.
      else if (here === "providers.llama.binary") out[key] = value;
      else if (isPlain(value) && isPlain(out[key])) out[key] = merge(out[key] as Record<string, unknown>, value, here);
      else out[key] = value;
    }
    return out;
  };
  return settingsSchema.parse(merge(current as unknown as Record<string, unknown>, patch as Record<string, unknown>));
}

function mapSecrets(settings: Settings, map: (value: string) => string | undefined): Settings {
  const copy = structuredClone(settings);
  const holders: Array<[Record<string, unknown>, string]> = [[copy.server, "apiKey"], [copy.providers.antigravity, "apiKey"], [copy.providers.claude, "apiKey"], [copy.providers.claude, "oauthToken"], [copy.providers.gufo, "apiKey"], [copy.providers.strata, "apiKey"], [copy.providers.ollama, "apiKey"], [copy.providers.deepseek, "apiKey"], [copy.providers.llama, "hfToken"]];
  for (const [holder, key] of holders) {
    const value = holder[key];
    if (typeof value !== "string") continue;
    const mapped = map(value);
    if (mapped === undefined) delete holder[key]; else holder[key] = mapped;
  }
  return copy;
}

/** JSON settings file: created with defaults when missing, corrupt files are moved to `.bak-<ts>`, writes are atomic. */
export class SettingsStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(readonly file: string, private readonly codec?: SecretCodec, private readonly logger: Logger = silentLogger) {}

  async load(): Promise<Settings> {
    let raw: string;
    try { raw = await fs.readFile(this.file, "utf8"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const settings = defaultSettings();
      await this.save(settings);
      return settings;
    }
    try {
      const json: unknown = JSON.parse(raw.replace(/^﻿/, ""));
      // `mcpServers` is hand-edited: its entries are checked one by one below, so a typo there does not reset the file.
      const loose = isPlain(json) ? json : undefined;
      const parsed = settingsSchema.parse(loose ? { ...loose, mcpServers: undefined } : json);
      if (loose) parsed.mcpServers = sanitizeMcpServers(loose.mcpServers, this.logger);
      return mapSecrets(parsed, (value) => {
        if (!value.startsWith(SECRET_PREFIX)) return value;
        try { return this.codec ? this.codec.decode(value.slice(SECRET_PREFIX.length)) : undefined; } catch { this.logger.warn("A stored secret could not be decrypted and was dropped."); return undefined; }
      });
    } catch (error) {
      const backup = `${this.file}.bak-${Date.now()}`;
      await fs.rename(this.file, backup).catch(() => undefined);
      this.logger.warn(`Settings file is invalid (${error instanceof Error ? error.message.split("\n")[0] : String(error)}); moved to ${backup} and defaults were restored.`);
      const settings = defaultSettings();
      await this.save(settings);
      return settings;
    }
  }

  save(settings: Settings): Promise<void> {
    const run = async () => {
      const parsed = settingsSchema.parse(settings);
      const encoded = mapSecrets(parsed, (value) => this.codec && !value.startsWith(SECRET_PREFIX) ? SECRET_PREFIX + this.codec.encode(value) : value);
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp-${process.pid}-${Date.now()}`;
      await fs.writeFile(tmp, JSON.stringify(encoded, null, 2) + "\n", "utf8");
      for (let attempt = 0; ; attempt++) {
        try { await fs.rename(tmp, this.file); return; } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (attempt >= 4 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) { await fs.rm(tmp, { force: true }).catch(() => undefined); throw error; }
          await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
        }
      }
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }
}

export interface ResolvedConfig {
  config: ProxyConfig;
  /** Settings with environment overrides applied. */
  settings: Settings;
  providers: Record<string, ProviderSettings>;
  /** Dotted setting paths currently forced by environment variables, e.g. "server.port". */
  overridden: string[];
}

function parseInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}
function parseNonNegative(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}
function parseBool(value: string | undefined): boolean | undefined {
  if (value === undefined || value === "") return undefined;
  const lower = value.toLowerCase();
  if (["1", "true", "yes", "on"].includes(lower)) return true;
  if (["0", "false", "no", "off"].includes(lower)) return false;
  return undefined;
}

/** Precedence: environment variable, then settings file, then defaults. */
export function resolveConfig(settings: Settings, env: NodeJS.ProcessEnv = process.env): ResolvedConfig {
  const effective = structuredClone(settings);
  const overridden: string[] = [];
  const apply = <T>(key: string, value: T | undefined, set: (value: T) => void) => { if (value !== undefined) { set(value); overridden.push(key); } };
  const { server, providers } = effective;
  apply("server.host", env.PROXY_HOST || undefined, (v) => { server.host = v; });
  apply("server.port", parseInt(env.PROXY_PORT), (v) => { server.port = v; });
  apply("server.apiKey", env.PROXY_API_KEY || undefined, (v) => { server.apiKey = v; });
  apply("server.maxBodyBytes", parseInt(env.PROXY_MAX_BODY_BYTES), (v) => { server.maxBodyBytes = v; });
  apply("server.timeoutMs", parseInt(env.PROXY_TIMEOUT_MS), (v) => { server.timeoutMs = v; });
  apply("server.modelsWaitMs", parseInt(env.PROXY_MODELS_WAIT_MS), (v) => { server.modelsWaitMs = v; });
  apply("server.workRoot", env.PROXY_WORK_ROOT || undefined, (v) => { server.workRoot = v; });
  apply("server.reuseSessions", parseBool(env.PROXY_REUSE_SESSIONS), (v) => { server.reuseSessions = v; });
  apply("server.listBareAliases", parseBool(env.PROXY_LIST_BARE_ALIASES), (v) => { server.listBareAliases = v; });
  apply("server.toolResultTimeoutMs", parseInt(env.PROXY_TOOL_RESULT_TIMEOUT_MS), (v) => { server.toolResultTimeoutMs = v; });
  apply("server.maxConcurrent", parseNonNegative(env.PROXY_MAX_CONCURRENT), (v) => { server.maxConcurrent = v; });
  apply("server.maxQueue", parseNonNegative(env.PROXY_MAX_QUEUE), (v) => { server.maxQueue = v; });
  apply("server.usageLimitCooldownMinutes", parseInt(env.PROXY_USAGE_LIMIT_COOLDOWN_MINUTES), (v) => { server.usageLimitCooldownMinutes = v; });
  apply("providers.codex.maxConcurrent", parseNonNegative(env.PROXY_CODEX_MAX_CONCURRENT), (v) => { providers.codex.maxConcurrent = v; });
  apply("providers.codex.maxPromptChars", parseNonNegative(env.PROXY_CODEX_MAX_PROMPT_CHARS), (v) => { providers.codex.maxPromptChars = v; });
  apply("providers.antigravity.maxConcurrent", parseNonNegative(env.PROXY_ANTIGRAVITY_MAX_CONCURRENT), (v) => { providers.antigravity.maxConcurrent = v; });
  apply("providers.antigravity.maxPromptChars", parseNonNegative(env.PROXY_ANTIGRAVITY_MAX_PROMPT_CHARS), (v) => { providers.antigravity.maxPromptChars = v; });
  apply("providers.claude.maxConcurrent", parseNonNegative(env.PROXY_CLAUDE_MAX_CONCURRENT), (v) => { providers.claude.maxConcurrent = v; });
  apply("providers.claude.maxPromptChars", parseNonNegative(env.PROXY_CLAUDE_MAX_PROMPT_CHARS), (v) => { providers.claude.maxPromptChars = v; });
  apply("providers.codex.enabled", parseBool(env.PROXY_CODEX_ENABLED), (v) => { providers.codex.enabled = v; });
  apply("providers.codex.isolatedHome", parseBool(env.PROXY_CODEX_ISOLATED_HOME), (v) => { providers.codex.isolatedHome = v; });
  apply("providers.codex.acpCommand", env.PROXY_ACP_COMMAND || undefined, (v) => { providers.codex.acpCommand = v; });
  apply("providers.codex.acpArgs", env.PROXY_ACP_ARGS ? env.PROXY_ACP_ARGS.split(" ").filter(Boolean) : undefined, (v) => { providers.codex.acpArgs = v; });
  apply("providers.antigravity.enabled", parseBool(env.PROXY_ANTIGRAVITY_ENABLED), (v) => { providers.antigravity.enabled = v; });
  apply("providers.antigravity.executablePath", env.PROXY_ANTIGRAVITY_COMMAND || undefined, (v) => { providers.antigravity.executablePath = v; });
  apply("providers.antigravity.termsAcknowledgedAt", parseBool(env.PROXY_ANTIGRAVITY_ACCEPT_TERMS) ? providers.antigravity.termsAcknowledgedAt ?? new Date().toISOString() : undefined, (v) => { providers.antigravity.termsAcknowledgedAt = v; });
  apply("providers.claude.enabled", parseBool(env.PROXY_CLAUDE_ENABLED), (v) => { providers.claude.enabled = v; });
  apply("providers.claude.executablePath", env.PROXY_CLAUDE_EXECUTABLE || undefined, (v) => { providers.claude.executablePath = v; });
  apply("providers.claude.termsAcknowledgedAt", parseBool(env.PROXY_CLAUDE_ACCEPT_TERMS) ? providers.claude.termsAcknowledgedAt ?? new Date().toISOString() : undefined, (v) => { providers.claude.termsAcknowledgedAt = v; });
  apply("providers.deepseek.apiKey", env.PROXY_DEEPSEEK_API_KEY || undefined, (v) => { providers.deepseek.apiKey = v; });
  const config: ProxyConfig = {
    host: server.host,
    port: server.port,
    apiKey: server.apiKey || undefined,
    maxBodyBytes: server.maxBodyBytes,
    timeoutMs: server.timeoutMs,
    modelsWaitMs: server.modelsWaitMs,
    reuseSessions: server.reuseSessions,
    listBareAliases: server.listBareAliases,
    toolResultTimeoutMs: server.toolResultTimeoutMs,
    maxConcurrent: server.maxConcurrent,
    maxQueue: server.maxQueue,
    usageLimitCooldownMinutes: server.usageLimitCooldownMinutes,
    mcpServers: effective.mcpServers,
    workRoot: server.workRoot || path.join(os.tmpdir(), "codex-subscription-proxy"),
    acpCommand: providers.codex.acpCommand || undefined,
    acpArgs: providers.codex.acpArgs,
  };
  return { config, settings: effective, providers: providers as unknown as Record<string, ProviderSettings>, overridden };
}
