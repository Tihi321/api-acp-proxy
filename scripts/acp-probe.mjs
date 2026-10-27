#!/usr/bin/env node
// Raw ACP probe (no SDK): spawns an ACP agent, sends initialize, optionally authenticate, session/new, and optionally a prompt.
// Prints the agentCapabilities, authMethods, modes, configOptions, timings and (with --prompt) the reply. The whole process tree is killed on exit.
//
//   npm run probe -- <command> [agent args...] [--auth <methodId>] [--prompt "<text>"] [--timeout <ms>] [--auth-timeout <ms>]
//                    [--open-login-url] [--no-session] [--env KEY=VALUE]... [--unset-env NAME]...
//                    [--cwd <dir>] [--keep-cwd] [--mode <id>] [--model <value>] [--meta <json>]
//                    [--mcp-url <url>]... [--image <file>] [--image-uri <url>]
//                    [--allow <regex>] [--dump <file>] [--logout] [--do-logout]
//
// Flags go before the command, or after it behind `--` ; env fallbacks: PROBE_AUTH, PROBE_PROMPT, PROBE_TIMEOUT_MS, PROBE_AUTH_TIMEOUT_MS.
//
//   --cwd <dir>         session cwd (created if missing, never deleted); default is a fresh temp dir that is deleted on exit unless --keep-cwd. The path is printed.
//   --keep-cwd          keep the default temp dir so files the agent wrote can be inspected afterwards.
//   --mode <id>         session/set_mode after session/new.
//   --model <value>     session/set_config_option for the model option (id "model" or category "model"); exact value, else the first option whose value/name contains it.
//   --meta <json>       sent as `_meta` on session/new (Claude: {"disableBuiltInTools":true,"claudeCode":{"options":{...}}}).
//   --mcp-url <url>     adds an http MCP server to session/new: { type:"http", name:"client", url, headers:[] } (client, client2, ... when repeated).
//   --image <file>      adds { type:"image", mimeType, data:<base64> } after the text block of the prompt.
//   --image-uri <url>   adds { type:"image", mimeType, uri } (no data); the MIME type comes from the extension, override with --image-mime.
//   --allow <regex>     a session/request_permission whose JSON matches is answered with its first allow_once / allow_always option; all others stay `cancelled`.
//                       The text tested is the request JSON followed by " CALL:" and the merged tool_call / tool_call_update fields of the same toolCallId (Codex's request
//                       carries only the id and kind). Every permission request is logged either way.
//   --dump <file>       appends every incoming session/update and session/request_permission (plus the answer) as JSON lines.
//   --unset-env NAME    deletes NAME from the child environment.
//   --logout            prints whether the agent advertises ACP `logout` (agentCapabilities.auth.logout); sends nothing.
//   --do-logout         ALSO sends the ACP `logout` request after initialize. This signs the agent out of whatever login it uses: only run it with an empty
//                       CODEX_HOME / CLAUDE_CONFIG_DIR / GEMINI_HOME (--env), never against your own login.
//
// Example: npm run probe -- .claude/temp/agy-acp/agy_acp_server.exe --auth oauth-personal --prompt "Reply with exactly: pong"
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const argv = process.argv.slice(2);
const opts = {
  auth: process.env.PROBE_AUTH, prompt: process.env.PROBE_PROMPT, timeout: Number(process.env.PROBE_TIMEOUT_MS || 180000), authTimeout: Number(process.env.PROBE_AUTH_TIMEOUT_MS || 300000),
  openLoginUrl: false, session: true, env: {}, unsetEnv: [], cwd: undefined, keepCwd: false, mode: undefined, model: undefined, meta: undefined, mcpUrls: [], image: undefined, imageUri: undefined, imageMime: undefined, allow: undefined, dump: undefined,
};
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
  else if (a === "--unset-env") opts.unsetEnv.push(argv[++i]);
  else if (a === "--cwd") opts.cwd = argv[++i];
  else if (a === "--keep-cwd") opts.keepCwd = true;
  else if (a === "--mode") opts.mode = argv[++i];
  else if (a === "--model") opts.model = argv[++i];
  else if (a === "--meta") opts.meta = JSON.parse(argv[++i]);
  else if (a === "--mcp-url") opts.mcpUrls.push(argv[++i]);
  else if (a === "--image") opts.image = argv[++i];
  else if (a === "--image-uri") opts.imageUri = argv[++i];
  else if (a === "--image-mime") opts.imageMime = argv[++i];
  else if (a === "--allow") opts.allow = new RegExp(argv[++i], "i");
  else if (a === "--dump") opts.dump = argv[++i];
  else if (a === "--logout") opts.logout = true;
  else if (a === "--do-logout") { opts.logout = true; opts.doLogout = true; }
  else positional.push(a);
}
const [cmd, ...args] = positional;
if (!cmd) { console.error("Usage: npm run probe -- <command> [args...] [--auth <id>] [--prompt <text>] [--timeout <ms>] [--auth-timeout <ms>] [--open-login-url] [--no-session] [--env K=V] [--unset-env NAME] [--cwd <dir>] [--keep-cwd] [--mode <id>] [--model <value>] [--meta <json>] [--mcp-url <url>] [--image <file>] [--image-uri <url>] [--allow <regex>] [--dump <file>] [--logout] [--do-logout]"); process.exit(2); }

const t0 = Date.now();
const since = () => `[${Date.now() - t0}ms]`;
const childEnv = { ...process.env, ...opts.env };
for (const name of opts.unsetEnv) delete childEnv[name];
const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: childEnv, detached: process.platform !== "win32" });

const dump = (record) => { if (opts.dump) appendFileSync(opts.dump, JSON.stringify({ t: Date.now() - t0, ...record }) + "\n"); };
if (opts.dump) mkdirSync(path.dirname(path.resolve(opts.dump)), { recursive: true });

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

const send = (message) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
// Truncates long strings (base64 image data) for the console only; the dump keeps everything.
const brief = (value, limit = 1500) => { const text = JSON.stringify(value) ?? ""; return text.length > limit ? `${text.slice(0, limit)}...(+${text.length - limit})` : text; };

// Latest tool_call / tool_call_update fields per toolCallId (no content), so --allow can match on what the permission request itself leaves out (Codex sends only the id and kind).
const calls = new Map();
const trackCall = (update) => {
  if (update?.sessionUpdate !== "tool_call" && update?.sessionUpdate !== "tool_call_update") return;
  const { content, ...rest } = update;
  calls.set(update.toolCallId, { ...calls.get(update.toolCallId), ...rest });
};

function answerPermission(msg) {
  const json = JSON.stringify(msg.params) + " CALL:" + JSON.stringify(calls.get(msg.params?.toolCall?.toolCallId) ?? null);
  const options = Array.isArray(msg.params?.options) ? msg.params.options : [];
  const allowed = opts.allow && opts.allow.test(json) ? options.find((o) => o.kind === "allow_once") ?? options.find((o) => o.kind === "allow_always") : undefined;
  const outcome = allowed ? { outcome: "selected", optionId: allowed.optionId } : { outcome: "cancelled" };
  console.log(`${since()} <- session/request_permission`, brief(msg.params, 6000));
  console.log(`${since()} -> permission answer: ${allowed ? `ALLOW ${allowed.optionId} (${allowed.kind})` : opts.allow && opts.allow.test(json) ? "matched --allow but no allow option offered: cancelled" : "cancelled"}`);
  dump({ type: "session/request_permission", id: msg.id, params: msg.params, answer: outcome });
  send({ id: msg.id, result: { outcome } });
}

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
    else if (msg.method === "session/request_permission" && msg.id !== undefined) answerPermission(msg);
    else if (msg.method) {
      if (msg.method === "session/update") { trackCall(msg.params?.update); dump({ type: "session/update", params: msg.params }); }
      console.log(`${since()} <- ${msg.method}`, brief(msg.params));
      if (msg.id !== undefined) send({ id: msg.id, error: { code: -32601, message: "not supported by probe" } });
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
  send({ id: mid, method, params });
  setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); resolve({ timeout: true }); } }, timeout);
});

const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
const mimeOf = (name) => opts.imageMime || MIME[path.extname(String(name).split("?")[0]).toLowerCase()] || "image/png";

let cwd;
let tempCwd = false;
try {
  const init = await req("initialize", { protocolVersion: 1, clientInfo: { name: "probe", version: "0" }, clientCapabilities: {} }, 60000);
  console.log(`${since()} initialize ->`, JSON.stringify(init, null, 2));
  console.log(`${since()} agentCapabilities ->`, JSON.stringify(init.result?.agentCapabilities ?? null));
  if (opts.logout) {
    const auth = init.result?.agentCapabilities?.auth;
    console.log(`${since()} ACP logout advertised: ${auth?.logout ? "yes" : "no"} (agentCapabilities.auth = ${JSON.stringify(auth ?? null)})`);
    if (opts.doLogout) console.log(`${since()} logout ->`, JSON.stringify(await req("logout", {}, 60000)));
  }
  if (opts.auth) {
    const ta = Date.now();
    const auth = await req("authenticate", { methodId: opts.auth }, opts.authTimeout);
    console.log(`[${Date.now() - ta}ms] authenticate ->`, JSON.stringify(auth));
  }
  if (opts.session) {
    if (opts.cwd) { cwd = path.resolve(opts.cwd); mkdirSync(cwd, { recursive: true }); }
    else { cwd = mkdtempSync(path.join(os.tmpdir(), "acp-probe-")); tempCwd = true; }
    console.log(`${since()} session cwd: ${cwd}${tempCwd && opts.keepCwd ? " (kept)" : ""}`);
    const mcpServers = opts.mcpUrls.map((url, n) => ({ type: "http", name: n === 0 ? "client" : `client${n + 1}`, url, headers: [] }));
    const t1 = Date.now();
    const sess = await req("session/new", { cwd, mcpServers, ...(opts.meta ? { _meta: opts.meta } : {}) });
    console.log(`[${Date.now() - t1}ms] session/new ->`, JSON.stringify(sess, null, 2).slice(0, 30000));
    const sessionId = sess.result?.sessionId;
    if (sessionId && opts.mode) console.log(`session/set_mode ${opts.mode} ->`, JSON.stringify(await req("session/set_mode", { sessionId, modeId: opts.mode }, 30000)));
    if (sessionId && opts.model) {
      const option = (sess.result.configOptions || []).find((o) => o.id === "model") ?? (sess.result.configOptions || []).find((o) => o.category === "model");
      const flat = (option?.options || []).flatMap((o) => o.options ?? [o]);
      const wanted = opts.model.toLowerCase();
      const choice = flat.find((o) => o.value === opts.model) ?? flat.find((o) => String(o.value).toLowerCase().includes(wanted) || String(o.name).toLowerCase().includes(wanted));
      if (!option || !choice) console.log(`--model ${opts.model}: no matching option (have: ${flat.map((o) => o.value).join(", ")})`);
      else console.log(`session/set_config_option ${option.id}=${choice.value} ->`, JSON.stringify(await req("session/set_config_option", { sessionId, configId: option.id, value: choice.value }, 30000)));
    }
    if (sessionId && opts.prompt) {
      const prompt = [{ type: "text", text: opts.prompt }];
      if (opts.image) prompt.push({ type: "image", mimeType: mimeOf(opts.image), data: readFileSync(opts.image).toString("base64") });
      if (opts.imageUri) prompt.push({ type: "image", mimeType: mimeOf(opts.imageUri), uri: opts.imageUri });
      dump({ type: "session/prompt", prompt: prompt.map((b) => b.type === "image" && b.data ? { ...b, data: `<${b.data.length} base64 chars>` } : b) });
      const tp = Date.now();
      const r = await req("session/prompt", { sessionId, prompt });
      console.log(`[${Date.now() - tp}ms] session/prompt ->`, JSON.stringify(r));
      dump({ type: "session/prompt result", result: r });
      const td = Date.now();
      console.log(`[${Date.now() - td}ms] session/delete ->`, JSON.stringify(await req("session/delete", { sessionId }, 15000)));
    }
  }
} finally {
  killTree();
  if (cwd && tempCwd && !opts.keepCwd) rmSync(cwd, { recursive: true, force: true });
}
process.exit(0);
