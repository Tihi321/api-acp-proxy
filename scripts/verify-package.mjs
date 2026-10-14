// Verifies the unpacked Windows build (release/win-unpacked): runs codex-acp exactly the way the app does
// (ACP Proxy.exe with ELECTRON_RUN_AS_NODE=1), performs an ACP `initialize` handshake and checks that the native
// codex binary resolves from app.asar.unpacked. Exit code 0 on success. Usage: node scripts/verify-package.mjs [unpackedDir]
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const unpackedDir = path.resolve(process.argv[2] ?? path.join(root, "release", "win-unpacked"));
const exe = path.join(unpackedDir, "ACP Proxy.exe");
const unpacked = path.join(unpackedDir, "resources", "app.asar.unpacked");
const entry = path.join(unpacked, "node_modules", "@agentclientprotocol", "codex-acp", "dist", "index.js");
const hook = path.join(unpacked, "dist", "electron", "hide-windows.cjs");

const failures = [];
const check = (ok, message) => { console.log(`${ok ? "ok  " : "FAIL"} ${message}`); if (!ok) failures.push(message); };

check(fs.existsSync(exe), `exe present: ${exe}`);
check(fs.existsSync(path.join(unpackedDir, "resources", "app.asar")), "resources/app.asar present");
check(fs.existsSync(entry), "codex-acp entry is unpacked");
check(fs.existsSync(hook), "hide-windows.cjs is unpacked");
if (failures.length) process.exit(1);

// The native binary must resolve from the unpacked tree (not from inside app.asar).
let nativeBinary;
try {
  const requireFromCodex = createRequire(path.join(unpacked, "node_modules", "@openai", "codex", "package.json"));
  const platformPackage = path.dirname(requireFromCodex.resolve("@openai/codex-win32-x64/package.json"));
  nativeBinary = path.join(platformPackage, "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe");
  check(fs.existsSync(nativeBinary) && !nativeBinary.includes("app.asar" + path.sep), `native codex resolves from the unpacked tree: ${nativeBinary}`);
} catch (error) {
  check(false, `native codex package does not resolve from the unpacked tree: ${error.message}`);
}
if (nativeBinary && fs.existsSync(nativeBinary)) {
  try {
    const version = execFileSync(nativeBinary, ["--version"], { encoding: "utf8", windowsHide: true, timeout: 20000 }).trim();
    check(/codex/i.test(version), `codex.exe --version -> ${version}`);
  } catch (error) { check(false, `codex.exe --version failed: ${error.message}`); }
}

const killTree = (pid) => { try { execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }); } catch { /* already gone */ } };

const handshake = await new Promise((resolve) => {
  const child = spawn(exe, ["--require", hook, entry], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let out = "", err = "", done = false;
  const finish = (result) => { if (done) return; done = true; clearTimeout(timer); killTree(child.pid); resolve({ ...result, stderr: err.slice(0, 600) }); };
  const timer = setTimeout(() => finish({ error: "timeout after 30 s without an initialize response" }), 30000);
  child.on("error", (error) => finish({ error: error.message }));
  child.on("exit", (code) => finish({ error: `agent exited early (code ${code})` }));
  child.stderr.on("data", (chunk) => { err += chunk; });
  child.stdout.on("data", (chunk) => {
    out += chunk;
    for (const line of out.split("\n")) {
      if (!line.trim().startsWith("{")) continue;
      try { const message = JSON.parse(line); if (message.id === 1) finish(message.error ? { error: JSON.stringify(message.error) } : { result: message.result }); } catch { /* partial line */ }
    }
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "verify-package", version: "0.0.0" } } }) + "\n");
});

if (handshake.error) { check(false, `ACP initialize failed: ${handshake.error}${handshake.stderr ? `\n${handshake.stderr}` : ""}`); }
else {
  const methods = handshake.result.authMethods ?? [];
  check(Array.isArray(methods) && methods.length > 0, `ACP initialize ok; agent ${handshake.result.agentInfo?.name ?? "?"} ${handshake.result.agentInfo?.version ?? ""}`);
  console.log(`authMethods: ${JSON.stringify(methods.map((method) => method.id))}`);
}

if (failures.length) { console.error(`\nverify-package FAILED (${failures.length})`); process.exit(1); }
console.log("\nverify-package passed");
