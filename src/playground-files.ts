import { existsSync } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerResponse } from "node:http";

/** The files of the playground page (built into dist/playground): only these are served. */
const FILES: Record<string, string> = {
  "": "playground.html",
  "playground.js": "playground.js",
  "lib.js": "lib.js",
  "playground.css": "playground.css",
};
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };

/** The page talks only to this origin and shows only its own scripts, styles and data: images. */
export const PLAYGROUND_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** dist/playground next to this module; under tsx (src/) the built copy in dist/playground. */
function playgroundDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const beside = path.join(here, "playground");
  return existsSync(path.join(beside, "playground.js")) ? beside : path.resolve(here, "..", "dist", "playground");
}

/**
 * Serves `GET /playground` and its fixed files; returns false for any other path. The page holds no data, so it needs no API key (its API calls do).
 * A file that was not built answers 404 with a hint. `dir` is where the built files are (tests pass their own).
 */
export async function servePlayground(method: string, pathname: string, response: ServerResponse, dir = playgroundDir()): Promise<boolean> {
  if (pathname !== "/playground" && !pathname.startsWith("/playground/")) return false;
  const name = pathname === "/playground" ? "" : pathname.slice("/playground/".length);
  const file = Object.hasOwn(FILES, name) ? FILES[name] : undefined;
  const send = (status: number, type: string, body: string | Buffer) => {
    response.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": PLAYGROUND_CSP, "Referrer-Policy": "no-referrer" });
    response.end(method === "HEAD" ? undefined : body);
  };
  if (method !== "GET" && method !== "HEAD") { send(405, "text/plain; charset=utf-8", "Method not allowed."); return true; }
  if (!file) { send(404, "text/plain; charset=utf-8", "Not found."); return true; }
  try { send(200, TYPES[path.extname(file)] ?? "application/octet-stream", await fsp.readFile(path.join(dir, file))); }
  catch { send(404, "text/plain; charset=utf-8", "The playground is not built; run `npm run build`."); }
  return true;
}
