import { mkdirSync } from "node:fs";
import path from "node:path";

/** Creates a fresh, empty, unique temp directory for one test file run (pids are reused on Windows). */
export function tempRoot(suite: string): string {
  const unique = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const dir = path.resolve(".claude/temp", `${suite}-tests`, unique);
  mkdirSync(dir, { recursive: true });
  return dir;
}
