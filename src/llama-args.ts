import { existsSync } from "node:fs";
import path from "node:path";
import type { LlamaProfile, LlamaSource } from "./settings.js";

/** Absolute paths stay; relative ones are resolved against the models folder. */
export function resolveModelPath(modelsDir: string, file: string): string {
  return path.isAbsolute(file) ? file : path.resolve(modelsDir, file);
}

const SHARD = /^(.*)-(\d{5})-of-(\d{5})(\.gguf)$/i;

/** `x-00001-of-00003.gguf` -> the names of all 3 shards (same directory part); undefined when the name is not a shard. */
export function splitShards(file: string): string[] | undefined {
  const match = SHARD.exec(file);
  if (!match) return undefined;
  const total = Number(match[3]);
  if (!Number.isInteger(total) || total < 1) return undefined;
  const pad = (n: number): string => String(n).padStart(5, "0");
  return Array.from({ length: total }, (_, index) => `${match[1]}-${pad(index + 1)}-of-${match[3]}${match[4]}`);
}

/** Paths and the alias end up inside a cmd.exe command line: a quote would break out, `%` would expand. */
function safe(value: string, field: string): string {
  if (/["%]/.test(value)) throw new Error(`Unsupported character in ${field}: ${value}`);
  return value;
}

const quoted = (value: string, field: string): string => `"${safe(value, field)}"`;

/** The llama-server args of a profile; contains `{port}` for the launcher. */
export function buildLlamaArgs(profile: LlamaProfile, modelsDir: string): string {
  const parts: string[] = [
    `-m ${quoted(resolveModelPath(modelsDir, profile.modelFile), "modelFile")}`,
    "--host 127.0.0.1",
    "--port {port}",
    `--alias ${safe(profile.model, "model")}`,
  ];
  if (profile.ctxSize !== undefined) parts.push(`-c ${profile.ctxSize}`);
  parts.push(`-ngl ${profile.gpuLayers}`, `-fa ${profile.flashAttn}`);
  if (profile.vision && profile.mmprojFile) parts.push(`--mmproj ${quoted(resolveModelPath(modelsDir, profile.mmprojFile), "mmprojFile")}`);
  if (profile.specType !== "none") {
    parts.push(`--spec-type ${profile.specType}`);
    if (profile.draftFile) parts.push(`--spec-draft-model ${quoted(resolveModelPath(modelsDir, profile.draftFile), "draftFile")}`);
    if (profile.draftNMax !== undefined) parts.push(`--spec-draft-n-max ${profile.draftNMax}`);
    if (profile.draftNMin !== undefined) parts.push(`--spec-draft-n-min ${profile.draftNMin}`);
    if (profile.draftGpuLayers !== undefined) parts.push(`--spec-draft-ngl ${profile.draftGpuLayers}`);
  }
  const extra = profile.extraArgs.trim();
  if (extra) parts.push(extra);
  return parts.join(" ");
}

/** Absolute paths of the files the profile needs that do not exist (every shard of a split model). */
export function checkLlamaFiles(profile: LlamaProfile, modelsDir: string, exists: (p: string) => boolean = existsSync): string[] {
  const missing: string[] = [];
  const check = (file: string | undefined, shards: boolean): void => {
    if (!file) return;
    const names = (shards ? splitShards(file) : undefined) ?? [file];
    for (const name of names) {
      const full = resolveModelPath(modelsDir, name);
      if (!exists(full)) missing.push(full);
    }
  };
  check(profile.modelFile, true);
  if (profile.vision) check(profile.mmprojFile, false);
  if (profile.specType !== "none") check(profile.draftFile, true);
  return missing;
}

export type BuildCheck = { ok: true } | { ok: false; code: "llama_build_too_old"; message: string } | { ok: "unknown"; message: string };

/** Build gate: passes when the source is listed in `requires.sources` or the build is at least `requires.minBuild`. */
export function checkBuild(profile: LlamaProfile, binary: { source: LlamaSource | "custom"; build?: number }): BuildCheck {
  const requires = profile.requires;
  if (!requires || (requires.minBuild === undefined && !requires.sources?.length)) return { ok: true };
  if (binary.source !== "custom" && requires.sources?.includes(binary.source)) return { ok: true };
  if (requires.minBuild !== undefined && binary.build !== undefined && binary.build >= requires.minBuild) return { ok: true };
  const unknown = (): BuildCheck => ({ ok: "unknown", message: `The llama-server build is unknown; ${profile.label} may need a newer build.` });
  if (requires.minBuild !== undefined) {
    if (binary.build === undefined) return unknown();
    return { ok: false, code: "llama_build_too_old", message: `${profile.label} needs a newer build: b${requires.minBuild} or newer from ggml-org, or the Unsloth build (installed: ${binary.source} b${binary.build}).` };
  }
  // Sources only: an own exe may be any fork, so it only warns.
  if (binary.source === "custom") return unknown();
  return { ok: false, code: "llama_build_too_old", message: `${profile.label} needs the Unsloth build of llama.cpp.` };
}
