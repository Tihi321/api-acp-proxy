#!/usr/bin/env node
// Raw ACP probe (no SDK): spawns an ACP agent, sends initialize, optionally authenticate, session/new, and optionally a prompt.
// Prints the authMethods, modes, configOptions, timings and (with --prompt) the reply. The whole process tree is killed on exit.
//
//   npm run probe -- <command> [agent args...] [--auth <methodId>] [--prompt "<text>"] [--timeout <ms>] [--auth-timeout <ms>]
//                    [--open-login-url] [--no-session] [--env KEY=VALUE]...
//
// Flags go before the command, or after it behind `--` ; env fallbacks: PROBE_AUTH, PROBE_PROMPT, PROBE_TIMEOUT_MS, PROBE_AUTH_TIMEOUT_MS.
// Example: npm run probe -- .claude/temp/agy-acp/agy_acp_server.exe --auth oauth-personal --prompt "Reply with exactly: pong"
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const argv = process.argv.slice(2);
const opts = { auth: process.env.PROBE_AUTH, prompt: process.env.PROBE_PROMPT, timeout: Number(process.env.PROBE_TIMEOUT_MS || 180000), authTimeout: Number(process.env.PROBE_AUTH_TIMEOUT_MS || 300000), openLoginUrl: false, session: true, env: {} };
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith("--") && (positional.length === 0 || !a.startsWith("--"))) { positional.push(a); continue; }
  if (a === "--auth") opts.auth = argv[++i];
  else if (a === "--prompt") opts.prompt = argv[++i];
  else if (a === "--timeout") opts.timeout = Number(argv[++i]);
  else if (a === "--auth-timeout") opts.authTimeout = Number(argv[++i]);
  else if (a === "--open-login-url") opts.openLoginUrl = true;
  else if (a === "--no-session") opts.session = false;
  else if (a === "--env") { const [k, ...v] = String(argv[++i]).split("="); opts.env[k] = v.join("="); }
  else positional.push(a);
}
const [cmd, ...args] = positional;
if (!cmd) { console.error("Usage: npm run probe -- <command> [args...] [--auth <id>] [--prompt <text>] [--timeout <ms>] [--auth-timeout <ms>] [--open-login-url] [--no-session] [--env K=V]"); process.exit(2); }

const t0 = Date.now();
const since = () => `[${Date.now() - t0}ms]`;
const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: { ...process.env, ...opts.env }, detached: process.platform !== "win32" });

let cleaned = false;
// Synchronous so the whole tree (bootloader, inner server, harness) is gone before this process exits.
function killTree() {
  if (cleaned || !child.pid) return;
  cleaned = true;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  else { try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* ignore */ } } }
}
process.on("exit", killTree);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { killTree(); process.exit(130); });

let buf = "";
let id = 0;
const pending = new Map();
child.on("error", (error) => { console.error(`spawn failed: ${error.message}`); process.exit(1); });
child.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { console.log("[non-json]", line.slice(0, 300)); continue; }
    if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    else if (msg.method) {
      console.log(`${since()} <- ${msg.method}`, JSON.stringify(msg.params).slice(0, 1500));
      if (msg.id !== undefined) child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "not supported by probe" } }) + "\n");
    }
  }
});
let errBytes = 0;
let opened = false;
child.stderr.on("data", (d) => {
  const m = String(d).match(/Open the following link to authenticate[^\r\n:]*:\s*(https:\/\/accounts\.google\.com\/\S+)/i);
  if (m) {
    console.log(`${since()} login URL printed by the agent: ${m[1]}`);
    if (opts.openLoginUrl && !opened) {
      opened = true;
      const opener = process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", m[1]]] : process.platform === "darwin" ? ["open", [m[1]]] : ["xdg-open", [m[1]]];
      spawn(opener[0], opener[1], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    }
  }
  errBytes += d.length;
  if (errBytes < 4000) process.stderr.write(`[stderr] ${d}`);
});
child.on("exit", (code) => console.log(`${since()} agent exit ${code}`));

const req = (method, params, timeout = opts.timeout) => new Promise((resolve) => {
  const mid = ++id; pending.set(mid, resolve);
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: mid, method, params }) + "\n");
  setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); resolve({ timeout: true }); } }, timeout);
});

let cwd;
try {
  const init = await req("initialize", { protocolVersion: 1, clientInfo: { name: "probe", version: "0" }, clientCapabilities: {} }, 60000);
  console.log(`${since()} initialize ->`, JSON.stringify(init, null, 2));
  if (opts.auth) {
    const ta = Date.now();
    const auth = await req("authenticate", { methodId: opts.auth }, opts.authTimeout);
    console.log(`[${Date.now() - ta}ms] authenticate ->`, JSON.stringify(auth));
  }
  if (opts.session) {
    cwd = mkdtempSync(path.join(os.tmpdir(), "acp-probe-"));
    const t1 = Date.now();
    const sess = await req("session/new", { cwd, mcpServers: [] });
    console.log(`[${Date.now() - t1}ms] session/new ->`, JSON.stringify(sess, null, 2).slice(0, 30000));
    if (sess.result && opts.prompt) {
      const tp = Date.now();
      const r = await req("session/prompt", { sessionId: sess.result.sessionId, prompt: [{ type: "text", text: opts.prompt }] });
      console.log(`[${Date.now() - tp}ms] session/prompt ->`, JSON.stringify(r));
      const td = Date.now();
      console.log(`[${Date.now() - td}ms] session/delete ->`, JSON.stringify(await req("session/delete", { sessionId: sess.result.sessionId }, 15000)));
    }
  }
} finally {
  killTree();
  if (cwd) rmSync(cwd, { recursive: true, force: true });
}
process.exit(0);
