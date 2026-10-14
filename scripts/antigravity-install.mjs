#!/usr/bin/env node
// Installs the Google Antigravity ACP server from the ACP registry.
//
//   npm run antigravity:install -- [--data-dir <dir>] [--registry-url <url>]
//
// Default data dir is the one the proxy uses (the folder of settings.json: %APPDATA%\api-acp-proxy, or PROXY_SETTINGS_FILE's folder).
// The installer is loaded from the compiled output (dist/providers/antigravity-installer.js) when it exists (run `npm run build` first),
// otherwise straight from the TypeScript source through tsx.
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
if (args.includes("--help") || args.includes("-h")) {
  console.log("Usage: npm run antigravity:install -- [--data-dir <dir>] [--registry-url <url>]");
  process.exit(0);
}

const dist = path.join(root, "dist", "providers", "antigravity-installer.js");
let installer;
let settings;
if (existsSync(dist)) {
  installer = await import(pathToFileURL(dist).href);
  settings = await import(pathToFileURL(path.join(root, "dist", "settings.js")).href);
} else {
  const { register } = await import("tsx/esm/api");
  register();
  installer = await import(pathToFileURL(path.join(root, "src", "providers", "antigravity-installer.ts")).href);
  settings = await import(pathToFileURL(path.join(root, "src", "settings.ts")).href);
}

const dataDir = path.resolve(flag("--data-dir") ?? path.dirname(settings.defaultSettingsPath()));
let lastLine = "";
const onProgress = (p) => {
  let line = p.phase;
  if (p.phase === "download" && p.received !== undefined) line += p.total ? ` ${(p.received / 1048576).toFixed(1)} / ${(p.total / 1048576).toFixed(1)} MB (${Math.floor((p.received / p.total) * 100)}%)` : ` ${(p.received / 1048576).toFixed(1)} MB`;
  else if (p.message) line += ` ${p.message}`;
  if ((p.phase === "download" || p.phase === "extract") && p.received !== undefined) {
    if (p.phase === "extract") line = `extract ${p.total ? Math.floor((p.received / p.total) * 100) : 0}%`;
    process.stdout.write(`\r${line}   `); lastLine = p.phase; return;
  }
  if (lastLine === "download" || lastLine === "extract") process.stdout.write("\n");
  lastLine = p.phase;
  console.log(line);
};
const logger = { debug() {}, info: (m) => console.log(m), warn: (m) => console.warn(`WARN ${m}`), error: (m) => console.error(m), child() { return logger; }, recent: () => [], subscribe: () => () => {} };

console.log(`Installing into ${dataDir}`);
try {
  const info = await installer.installAntigravity({ dataDir, onProgress, logger, ...(flag("--registry-url") ? { registryUrl: flag("--registry-url") } : {}) });
  console.log(JSON.stringify(info, null, 2));
} catch (error) {
  console.error(`Install failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
