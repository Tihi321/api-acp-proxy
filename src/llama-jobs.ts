import type { LlamaInstallInfo, LlamaProfile, LlamaSource, Settings, SettingsPatch } from "./settings.js";

// Settings patches written when a llama.cpp job (install, exe check, profile model download) completes. Each is built from the settings
// stored at completion and touches only the fields the job owns, so edits saved on the Llama.cpp page during a long download are kept.
// `binary` is always sent whole (contract C1: mergeSettings replaces providers.llama.binary as a whole value).

type LlamaSettings = Settings["providers"]["llama"];

/** After a managed install: the new build is installed and selected; the folder and the own-exe fields stay as saved now. */
export function installPatch(current: LlamaSettings, job: { source: LlamaSource; backend: string; arch: "x64" | "arm64"; info: LlamaInstallInfo }): SettingsPatch {
  return { providers: { llama: { binary: { ...current.binary, mode: "managed", source: job.source, backend: job.backend, arch: job.arch, installed: job.info } } } };
}

/** After checking an own llama-server.exe: it is selected, with its build when `--version` gave one (an old build number is dropped otherwise). */
export function customExePatch(current: LlamaSettings, file: string, build: number | undefined): SettingsPatch {
  const { customBuild: _old, ...binary } = current.binary;
  return { providers: { llama: { binary: { ...binary, mode: "custom", customPath: file, ...(build !== undefined ? { customBuild: build } : {}) } } } };
}

/** What a profile model download produced. */
export interface ProfileFiles { modelFile: string; mmprojFile?: string; draftFile?: string }

/** After a profile model download: the file fields of that one profile; every other field and profile stays as saved now. Empty when the profile was removed meanwhile. */
export function profileFilesPatch(current: LlamaSettings, profileId: string, files: ProfileFiles): SettingsPatch {
  if (!current.profiles.some((profile) => profile.id === profileId)) return {};
  const profiles = current.profiles.map((profile): LlamaProfile => {
    if (profile.id !== profileId) return profile;
    return { ...profile, modelFile: files.modelFile, ...(files.mmprojFile ? { mmprojFile: files.mmprojFile } : {}), ...(files.draftFile ? { draftFile: files.draftFile } : {}) };
  });
  return { providers: { llama: { profiles } } };
}
