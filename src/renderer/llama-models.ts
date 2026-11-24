import { ggufStem, quantOf } from "../shared/gguf-names.js";
import type { LlamaLocalFileView, LlamaProfileView } from "../shared/ipc.js";

// Pure helpers for the "Models on disk" card and the profile file pickers (no DOM). Paths are compared case-insensitively with `\` read as `/`.

export type FileField = "modelFile" | "mmprojFile" | "draftFile";
export interface FoundFix { field: FileField; current: string; candidates: LlamaLocalFileView[] }

const norm = (value: string): string => value.replace(/\\/g, "/").toLowerCase();
const isAbsolute = (value: string): boolean => /^([A-Za-z]:|[\\/])/.test(value);
const slug = (text: string): string => text.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "model";
const FIELD_KIND = { modelFile: "model", mmprojFile: "mmproj", draftFile: "draft" } as const;
const MAX_CANDIDATES = 3;

/** The next free flag preset id: preset-<n>, counting from the list length + 1 and skipping taken ids. */
export function nextPresetId(taken: ReadonlySet<string>, count: number): string {
  let n = count + 1;
  while (taken.has(`preset-${n}`)) n++;
  return `preset-${n}`;
}

/** The `specType` for a draft file name: `dspark*` -> draft-dspark, `mtp*` -> draft-mtp, `dflash*` -> draft-dflash, `eagle*` -> draft-eagle3, else draft-simple. */
export function specTypeForDraft(name: string): string {
  const base = name.replace(/\\/g, "/").split("/").pop() ?? name;
  if (/^dspark/i.test(base)) return "draft-dspark";
  if (/^mtp/i.test(base)) return "draft-mtp";
  if (/^dflash/i.test(base)) return "draft-dflash";
  if (/^eagle/i.test(base)) return "draft-eagle3";
  return "draft-simple";
}

/** A new profile for a found model: the single mmproj / draft in the same folder is attached; id and model are unique against `taken`. */
export function profileFromFile(file: LlamaLocalFileView, files: readonly LlamaLocalFileView[], taken: ReadonlySet<string>): LlamaProfileView {
  const label = file.name.replace(/\.gguf$/i, "").replace(/-\d{5}-of-\d{5}$/i, "");
  const base = slug(label);
  let id = base;
  let n = 2;
  while (taken.has(id)) id = `${base.slice(0, 44)}-${n++}`;
  const sameFolder = (kind: LlamaLocalFileView["kind"]) => files.filter((other) => other.kind === kind && other.complete && other.folder.toLowerCase() === file.folder.toLowerCase());
  const mmprojs = sameFolder("mmproj");
  const drafts = sameFolder("draft");
  const profile: LlamaProfileView = {
    id, label: file.name.replace(/\.gguf$/i, ""), model: id, vision: false, modelFile: file.path, gpuLayers: "auto", flashAttn: "auto", specType: "none", extraArgs: "",
  };
  if (mmprojs.length === 1) { profile.mmprojFile = mmprojs[0]!.path; profile.vision = true; }
  if (drafts.length === 1) { profile.draftFile = drafts[0]!.path; profile.specType = specTypeForDraft(drafts[0]!.name); }
  return profile;
}

/** For each file field that is missing (relative, and no complete scanned entry has that path), the scanned files of the same kind, folder and stem. Fields without candidates are left out. */
export function foundFileFixes(profile: LlamaProfileView, files: readonly LlamaLocalFileView[]): FoundFix[] {
  const complete = files.filter((file) => file.complete);
  const fixes: FoundFix[] = [];
  for (const field of ["modelFile", "mmprojFile", "draftFile"] as const) {
    const current = profile[field];
    if (!current || isAbsolute(current)) continue;
    const wanted = norm(current);
    if (complete.some((file) => norm(file.path) === wanted)) continue;
    const slash = wanted.lastIndexOf("/");
    const folder = slash < 0 ? "" : wanted.slice(0, slash);
    const stem = ggufStem(current);
    const candidates = complete
      .filter((file) => file.kind === FIELD_KIND[field] && file.folder.toLowerCase() === folder && ggufStem(file.name) === stem)
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .slice(0, MAX_CANDIDATES);
    if (candidates.length > 0) fixes.push({ field, current, candidates });
  }
  return fixes;
}

/** Missing files of an edited (unsaved) profile: a relative path is present when a complete scanned entry has it; an absolute one is missing when `statusMissing` (the last status result) lists it. Mirrors the launcher: mmproj counts with vision, the draft with a spec type. */
export function draftMissingFiles(profile: LlamaProfileView, files: readonly LlamaLocalFileView[], statusMissing: readonly string[]): string[] {
  const complete = new Set(files.filter((file) => file.complete).map((file) => norm(file.path)));
  const stale = new Set(statusMissing.map(norm));
  const used = [profile.modelFile, profile.vision ? profile.mmprojFile : undefined, profile.specType !== "none" ? profile.draftFile : undefined];
  return used.filter((value): value is string => !!value && (isAbsolute(value) ? stale.has(norm(value)) : !complete.has(norm(value))));
}

/** Sets `field` to the file's path; a model fix also swaps the old quant for the new one in the label when the label contains it, and sets `hf.quant`; an mmproj or draft fix sets `hf.mmproj` / `hf.draft` to the file's name when the profile has one. */
export function applyFix(profile: LlamaProfileView, field: FileField, file: LlamaLocalFileView): LlamaProfileView {
  const next: LlamaProfileView = { ...profile, [field]: file.path };
  if (field === "modelFile") {
    const oldQuant = quantOf(profile.modelFile);
    if (oldQuant && file.quant && profile.label.includes(oldQuant)) next.label = profile.label.replace(oldQuant, file.quant);
    if (file.quant && profile.hf) next.hf = { ...profile.hf, quant: file.quant };
  } else if (profile.hf && (field === "mmprojFile" || field === "draftFile")) {
    const key = field === "mmprojFile" ? "mmproj" : "draft";
    if (profile.hf[key]) next.hf = { ...profile.hf, [key]: file.name };
  }
  return next;
}

/** Ids of the profiles that use `path` as model, mmproj or draft file. */
export function usedBy(path: string, profiles: readonly LlamaProfileView[], embeddingFile?: string): string[] {
  const wanted = norm(path);
  const ids = profiles.filter((profile) => [profile.modelFile, profile.mmprojFile, profile.draftFile].some((value) => value !== undefined && norm(value) === wanted)).map((profile) => profile.id);
  if (embeddingFile && norm(embeddingFile) === wanted) ids.push("embeddings");
  return ids;
}

/** What a profile card shows for its Start / Restart buttons (AAP-57): `mine` = this profile is starting or ready, `failed` = its last start ended in an error. */
export function profileButtons(input: { mine: boolean; failed: boolean; anyRunning: boolean; waiting: boolean }): { startLabel: string; startDisabled: boolean; showRestart: boolean; restartDisabled: boolean } {
  const { mine, failed, anyRunning, waiting } = input;
  return {
    startLabel: waiting && !mine ? "Waiting…" : anyRunning && !mine ? "Switch to this" : "Start",
    startDisabled: mine || waiting,
    showRestart: mine || failed,
    restartDisabled: waiting,
  };
}
