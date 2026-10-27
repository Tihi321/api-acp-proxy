// Copies non-TypeScript runtime files into dist: renderer and playground html/css, the CommonJS hide-windows hook and the icons.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const copies = [];

for (const dir of ["renderer", "playground"]) {
  for (const file of fs.readdirSync(path.join(root, "src", dir))) {
    if (/\.(html|css)$/.test(file)) copies.push([path.join("src", dir, file), path.join("dist", dir, file)]);
  }
}
copies.push([path.join("src", "electron", "hide-windows.cjs"), path.join("dist", "electron", "hide-windows.cjs")]);

for (const [from, to] of copies) {
  fs.mkdirSync(path.dirname(path.join(root, to)), { recursive: true });
  fs.copyFileSync(path.join(root, from), path.join(root, to));
}
// Icons are referenced at runtime from <app>/assets (see src/electron/main.ts), so they are packaged from assets/ as-is.
if (!fs.existsSync(path.join(root, "assets", "tray-idle.png"))) throw new Error("assets/ is missing; run `node scripts/make-icons.mjs`.");
console.log(`copied ${copies.length} static files`);
