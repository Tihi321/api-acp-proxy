// Runs the three tsc projects one after another, always all of them, and exits 1 when any failed.
// No shell is involved, so it behaves the same under npm, yarn, Windows and CI.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsc = createRequire(path.join(root, "package.json")).resolve("typescript/bin/tsc");
const projects = [
  { name: "main", args: ["--noEmit"] },
  { name: "renderer", args: ["--noEmit", "-p", "tsconfig.renderer.json"] },
  { name: "tests", args: ["-p", "tsconfig.tests.json"] },
];

const results = projects.map((project) => {
  const run = spawnSync(process.execPath, [tsc, ...project.args], { cwd: root, stdio: "inherit" });
  const code = run.status ?? 1;
  return { name: project.name, code, error: run.error };
});
console.log("");
for (const { name, code, error } of results) console.log(code === 0 ? `typecheck: ${name} ok` : `typecheck: ${name} FAILED (exit ${code}${error ? `, ${error.message}` : ""})`);
process.exitCode = results.some((result) => result.code !== 0) ? 1 : 0;
