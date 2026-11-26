// File-name rules for .gguf files (quant, shard, mmproj, draft). One rule set shared by the Hugging Face listing, the models-folder scanner
// and the renderer. Pure: no node imports (src/shared is compiled by both tsconfigs).

export type GgufKind = "model" | "mmproj" | "draft";

export const QUANT = /(?:^|[-_./])((?:UD-)?(?:I?Q\d(?:_[A-Z0-9]+)*|BF16|F16|F32|MXFP4(?:_MOE)?))(?=[-_./]|$)/i;
export const SHARD = /-(\d{5})-of-(\d{5})\.gguf$/i;
export const DRAFT_NAME = /^(dspark|mtp|dflash|eagle3?)[-_]/i;
export const DRAFT_DIR = /^(dspark|mtp)$/i;

export function quantOf(file: string): string | undefined {
  const stripped = file.replace(/\.gguf(?:_file)?$/i, "").replace(/-\d{5}-of-\d{5}$/i, "");
  const base = stripped.slice(stripped.lastIndexOf("/") + 1);
  const hit = QUANT.exec(base) ?? QUANT.exec(stripped);
  if (!hit?.[1]) return undefined;
  // AAP-65: an "-mtp" tag right after the quant (`X-Q2_0-mtp.gguf`, MTP head inside) is its own quant, so it never clashes with the plain file.
  const text = QUANT.exec(base) ? base : stripped;
  return /^[-_]mtp$/i.test(text.slice(hit.index + hit[0].length)) ? `${hit[1]}-mtp` : hit[1];
}

/** undefined = not a model file to list (not .gguf / .gguf_file, or imatrix*). `path` is posix, relative. */
export function ggufKind(path: string): GgufKind | undefined {
  if (!/\.gguf(?:_file)?$/i.test(path)) return undefined;
  const parts = path.split("/");
  const name = parts[parts.length - 1] ?? path;
  if (/^imatrix/i.test(name)) return undefined;
  if (/(?:^|[-_.])mmproj(?:[-_.]|$)/i.test(name)) return "mmproj";
  return DRAFT_NAME.test(name) || parts.slice(0, -1).some((dir) => DRAFT_DIR.test(dir)) ? "draft" : "model";
}

/** A "mainline_support" folder in the path. */
export function isMainline(path: string): boolean {
  return path.split("/").slice(0, -1).some((dir) => dir.toLowerCase() === "mainline_support");
}

/** Base name without `.gguf`, shard suffix and quant token (and the separator before it), lower-cased: `Inkling-2-Mini-Q8_0.gguf` -> `inkling-2-mini`. */
export function ggufStem(path: string): string {
  const stripped = path.replace(/\\/g, "/").replace(/\.gguf(?:_file)?$/i, "").replace(/-\d{5}-of-\d{5}$/i, "");
  const base = stripped.slice(stripped.lastIndexOf("/") + 1);
  const match = QUANT.exec(base);
  const stem = match ? base.slice(0, match.index) + base.slice(match.index + match[0].length) : base;
  return stem.toLowerCase();
}
