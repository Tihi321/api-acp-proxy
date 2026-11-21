import { readdirSync, rmdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Vitest global setup. After the whole run, removes what this run's tempRoot() folders left behind: a folder a suite could not
 * delete in its own afterAll (a just-killed or freshly copied .exe can stay locked for a while on Windows), then the empty
 * per-suite `<suite>-tests` folders. Only folders created since this run started are touched.
 */
export default function setup(): () => void {
  const started = Date.now() - 1000;
  return () => {
    const temp = path.resolve(".claude/temp");
    let suites: string[] = [];
    try { suites = readdirSync(temp).filter((name) => name.endsWith("-tests")); } catch { return; }
    for (const suite of suites) {
      const dir = path.join(temp, suite);
      let entries: string[] = [];
      try { entries = readdirSync(dir); } catch { continue; }
      for (const entry of entries) {
        const full = path.join(dir, entry);
        try { if (statSync(full).birthtimeMs >= started) rmSync(full, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 }); } catch { /* still locked */ }
      }
      try { rmdirSync(dir); } catch { /* not empty (older leftovers) or already gone */ }
    }
  };
}
