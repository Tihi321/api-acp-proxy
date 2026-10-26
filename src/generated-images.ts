import fsp from "node:fs/promises";
import path from "node:path";

/** The path an agent named for a file: a `file://C:\...` or `file:///C:/...` URI or a plain path; undefined when it is not an absolute path. */
export function toFilePath(value: string): string | undefined {
  let file = value.trim();
  if (/^file:/i.test(file)) {
    const standard = /^file:\/\/\//i.test(file);
    file = file.replace(/^file:\/\//i, "");
    if (/^\/[A-Za-z]:/.test(file)) file = file.slice(1);
    if (standard) { try { file = decodeURIComponent(file); } catch { /* keep the raw text */ } }
  }
  return file && path.isAbsolute(file) ? file : undefined;
}

/** `target` is strictly below `root` (both resolved). */
function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== "" && relative.split(path.sep)[0] !== ".." && !path.isAbsolute(relative);
}

/**
 * Deletes the file an agent reported, but only when it resolves (symlinks and junctions followed) to a regular file inside `folder`.
 * With `pruneEmptyParent`, the file's folder goes too if that is now empty (and is itself inside `folder`). Returns whether the file was deleted; never throws.
 */
export async function deleteGeneratedFile(reported: string, folder: string, options: { pruneEmptyParent?: boolean } = {}): Promise<boolean> {
  try {
    const file = toFilePath(reported);
    if (!file) return false;
    const root = await fsp.realpath(folder);
    const target = await fsp.realpath(file);
    if (!isInside(root, target) || !(await fsp.stat(target)).isFile()) return false;
    await fsp.unlink(target);
    const parent = path.dirname(target);
    if (options.pruneEmptyParent && isInside(root, parent)) await fsp.rmdir(parent).catch(() => undefined);
    return true;
  } catch { return false; }
}
