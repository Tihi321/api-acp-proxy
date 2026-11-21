import fsp from "node:fs/promises";
import path from "node:path";
import { groupGgufFiles } from "./hf-models.js";
import { splitShards } from "./llama-args.js";
import { isMainline } from "./shared/gguf-names.js";
import type { LlamaLocalFileView } from "./shared/ipc.js";

export interface ScanOptions { maxDepth?: number; maxEntries?: number; maxFiles?: number }

/**
 * Lists the .gguf files under `modelsDir` and classifies them with the Hugging Face grouping rules (split shards become one row).
 * Files directly in `modelsDir` are depth 0; folders are entered down to `maxDepth` (4). Hidden entries (`.x`), symlinks and junctions
 * are skipped, and so is everything not ending in `.gguf` (`.gguf.partial` downloads). Hitting a cap stops the walk with `truncated`.
 */
export async function scanModelsDir(modelsDir: string, opts: ScanOptions = {}): Promise<{ missingDir: boolean; truncated: boolean; files: LlamaLocalFileView[] }> {
  const maxDepth = opts.maxDepth ?? 4;
  const maxEntries = opts.maxEntries ?? 20_000;
  const maxFiles = opts.maxFiles ?? 2_000;
  const rootStat = await fsp.stat(modelsDir).catch(() => undefined);
  if (!rootStat?.isDirectory()) return { missingDir: true, truncated: false, files: [] };

  const found: { type: string; path: string; size: number }[] = [];
  const stack: { dir: string; rel: string; depth: number }[] = [{ dir: modelsDir, rel: "", depth: 0 }];
  let entries = 0;
  let truncated = false;
  walk: while (stack.length > 0) {
    const { dir, rel, depth } = stack.pop()!;
    let dirents;
    try { dirents = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; } // unreadable folder: skipped silently
    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const dirent of dirents) {
      if (++entries > maxEntries) { truncated = true; break walk; }
      if (dirent.name.startsWith(".") || dirent.isSymbolicLink()) continue;
      const relPath = rel ? `${rel}/${dirent.name}` : dirent.name;
      if (dirent.isDirectory()) {
        if (depth < maxDepth) stack.push({ dir: path.join(dir, dirent.name), rel: relPath, depth: depth + 1 });
      } else if (dirent.isFile() && /\.gguf$/i.test(dirent.name)) {
        if (found.length >= maxFiles) { truncated = true; break walk; }
        const stat = await fsp.stat(path.join(dir, dirent.name)).catch(() => undefined);
        if (stat?.isFile()) found.push({ type: "file", path: relPath, size: stat.size });
      }
    }
  }

  const files: LlamaLocalFileView[] = groupGgufFiles(found).map((group) => {
    const first = group.files[0]!.path;
    const shards = group.split ? splitShards(first) : undefined;
    const filePath = shards ? shards[0]! : first;
    const slash = filePath.lastIndexOf("/");
    return {
      kind: group.kind, path: filePath, folder: slash < 0 ? "" : filePath.slice(0, slash), name: filePath.slice(slash + 1),
      ...(group.quant ? { quant: group.quant } : {}), size: group.totalSize,
      ...(shards ? { shards: shards.length } : {}), complete: group.selectable,
      ...(isMainline(filePath) ? { mainline: true } : {}),
    };
  });
  files.sort((a, b) => { const x = a.path.toLowerCase(), y = b.path.toLowerCase(); return x < y ? -1 : x > y ? 1 : 0; });
  return { missingDir: false, truncated, files };
}
