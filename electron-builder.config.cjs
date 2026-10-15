"use strict";
// electron-builder configuration (a .cjs file because the package is ESM).
// asarUnpack is computed: codex-acp and claude-agent-acp are spawned as child processes under ELECTRON_RUN_AS_NODE, so their
// entry points, whole runtime dependency trees and the native codex / claude binaries must live on disk, not inside app.asar.
const fs = require("node:fs");
const path = require("node:path");

const root = __dirname;

function findPackage(name, fromDir) {
  for (let dir = fromDir; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "node_modules", ...name.split("/"));
    if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
    if (path.dirname(dir) === dir) return undefined;
  }
}

/** Transitive closure of dependencies + optionalDependencies (those installed on this machine), as package dirs relative to the project. */
function runtimeClosure(entryName) {
  const seen = new Set();
  const queue = [findPackage(entryName, root)];
  while (queue.length) {
    const dir = queue.pop();
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    for (const name of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies })) {
      const found = findPackage(name, dir);
      if (found) queue.push(found);
    }
  }
  return [...seen].map((dir) => path.relative(root, dir).split(path.sep).join("/")).sort();
}

const agentClosure = ["@agentclientprotocol/codex-acp", "@agentclientprotocol/claude-agent-acp"].flatMap((name) => (findPackage(name, root) ? runtimeClosure(name) : []));

module.exports = {
  appId: "dev.selak.acp-proxy",
  productName: "ACP Proxy",
  copyright: "Tihomir Selak",
  directories: { output: "release", buildResources: "build" },
  npmRebuild: false,
  asar: true,
  files: ["dist/**/*", "!dist/**/*.map", "!dist/**/*.d.ts", "assets/**/*", "package.json"],
  asarUnpack: [
    "node_modules/@agentclientprotocol/**",
    "node_modules/@openai/**",
    "node_modules/@anthropic-ai/**",
    "dist/electron/hide-windows.cjs",
    ...[...new Set(agentClosure)].map((dir) => `${dir}/**`),
  ],
  extraMetadata: { main: "dist/electron/main.js" },
  win: {
    icon: "build/icon.ico",
    target: [{ target: "nsis", arch: ["x64"] }, { target: "portable", arch: ["x64"] }],
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    artifactName: "ACP-Proxy-Setup-${version}-${arch}.${ext}",
  },
  portable: { artifactName: "ACP-Proxy-Portable-${version}-${arch}.${ext}" },
  // The runAsNode fuse is intentionally left at the Electron default (enabled): agents run as `ACP Proxy.exe` with ELECTRON_RUN_AS_NODE=1.
};
