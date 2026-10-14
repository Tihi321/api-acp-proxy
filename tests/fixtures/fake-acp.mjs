import readline from "node:readline";
import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";

// Switches (all optional, defaults reproduce the original single-provider fake):
//   FAKE_ACP_DELAY=1                 prompts take 500 ms before answering
//   FAKE_ACP_REQUIRE_PERMISSION=1    send a session/request_permission during the prompt
//   FAKE_ACP_AUTH_METHODS=<json>     authMethods returned by initialize, e.g. [{"id":"api-key","name":"API key"}]
//   FAKE_ACP_REQUIRE_AUTH=1          session/new fails with -32000 until authenticate was called
//   FAKE_ACP_MODELS=<json>           model option values (flat, or groups with an options array)
//   FAKE_ACP_NO_READONLY=1           advertise only a non-read-only mode
//   FAKE_ACP_SESSION_DELAY_MS=<n>    delay session/new
//   FAKE_ACP_ENTITY_NOT_FOUND=1      prompts fail with "Requested entity was not found"
//   FAKE_ACP_ECHO=1                  answer "echo:<model>:<sessionId>:<authMethod>" instead of "fake response"
//   FAKE_ACP_GRANDCHILD=<file>       spawn a long-lived grandchild and write its pid to <file>
//   FAKE_ACP_AGY=1                   mimic agy_acp_server: modes default/auto_edit/yolo (no read-only), agentInfo 1.3.0, no delete capability,
//                                    session/delete -> -32601, -32000 errors carry a data object, authenticate prints the login URL to stderr
//   FAKE_ACP_AUTH_DELAY_MS=<n>       delay the authenticate response (simulates a pending interactive OAuth flow)
//   FAKE_ACP_LOG=<file>              append every request as a JSON line {method, params}
const env = process.env;
const pending = new Map();
const models = new Map();
let sessionCount = 0;
let authedWith;
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const agy = env.FAKE_ACP_AGY === "1";
const fail = (id, code, message, data) => send({ jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } });
const finish = (id, reason = "end_turn") => send({ jsonrpc: "2.0", id, result: { stopReason: reason, usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } } });
const promptDone = (sessionId, id) => {
  const text = env.FAKE_ACP_ECHO === "1" ? `echo:${models.get(sessionId) ?? ""}:${sessionId}:${authedWith ?? "-"}` : "fake response";
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
  finish(id);
};
if (env.FAKE_ACP_GRANDCHILD) {
  const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  writeFileSync(env.FAKE_ACP_GRANDCHILD, String(grandchild.pid));
}
const defaultModels = [{ value: "gpt-5.6-sol" }, { value: "gpt-5.6-terra" }, { value: "gpt-5.6-luna" }];
const newSession = (id) => {
  const sessionId = sessionCount++ === 0 ? "fake-session" : `fake-session-${sessionCount}`;
  const modes = agy ? { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }, { id: "auto_edit", name: "Auto edit" }, { id: "yolo", name: "Yolo" }] } : env.FAKE_ACP_NO_READONLY === "1" ? { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }] } : { currentModeId: "read-only", availableModes: [{ id: "read-only", name: "Read only" }] };
  const options = env.FAKE_ACP_MODELS ? JSON.parse(env.FAKE_ACP_MODELS) : defaultModels;
  const respond = () => send({ jsonrpc: "2.0", id, result: { sessionId, modes, configOptions: [{ id: "model", name: "Model", category: "model", type: "select", currentValue: "gpt-5.6-sol", options }] } });
  const delay = Number(env.FAKE_ACP_SESSION_DELAY_MS || 0);
  if (delay > 0) setTimeout(respond, delay); else respond();
};
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line); const { id, method, params = {} } = message;
  if (!method) return;
  if (env.FAKE_ACP_LOG) appendFileSync(env.FAKE_ACP_LOG, JSON.stringify({ method, params }) + "\n");
  if (method === "initialize") send({ jsonrpc: "2.0", id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: agy ? { list: {}, resume: {} } : { delete: true } }, agentInfo: agy ? { name: "antigravity-acp", title: "Google Antigravity", version: "1.3.0" } : { name: "fake", version: "1" }, ...(env.FAKE_ACP_AUTH_METHODS ? { authMethods: JSON.parse(env.FAKE_ACP_AUTH_METHODS) } : {}) } });
  else if (method === "authenticate") {
    if (agy || env.FAKE_ACP_AUTH_URL === "1") process.stderr.write("Open the following link to authenticate the ACP server: https://accounts.google.com/o/oauth2/v2/auth?client_id=fake&redirect_uri=http%3A%2F%2F127.0.0.1%3A1%2F\n");
    const done = () => { authedWith = params.methodId; send({ jsonrpc: "2.0", id, result: {} }); };
    const authDelay = Number(env.FAKE_ACP_AUTH_DELAY_MS || 0);
    if (authDelay > 0) setTimeout(done, authDelay); else done();
  }
  else if (method === "session/new") { if (env.FAKE_ACP_REQUIRE_AUTH === "1" && !authedWith) fail(id, -32000, "Authentication required", agy ? { message: "No authentication method selected. Either call the `authenticate` method (supports oauth-personal, gemini-api-key, agent-platform)" } : undefined); else newSession(id); }
  else if (method === "session/set_config_option") { models.set(params.sessionId, params.value); send({ jsonrpc: "2.0", id, result: { configOptions: [] } }); }
  else if (method === "session/delete" && agy) fail(id, -32601, "Method not found");
  else if (method === "session/set_mode" || method === "session/delete") send({ jsonrpc: "2.0", id, result: { configOptions: [] } });
  else if (method === "session/cancel") { const p = pending.get(params.sessionId); if (p !== undefined) { pending.delete(params.sessionId); finish(p, "cancelled"); } }
  else if (method === "session/prompt") {
    const sessionId = params.sessionId;
    pending.set(sessionId, id);
    const run = () => {
      if (!pending.has(sessionId)) return;
      if (env.FAKE_ACP_ENTITY_NOT_FOUND === "1") { pending.delete(sessionId); fail(id, -32603, "Requested entity was not found"); return; }
      if (env.FAKE_ACP_REQUIRE_PERMISSION === "1") send({ jsonrpc: "2.0", id: 9001, method: "session/request_permission", params: { sessionId, toolCall: { toolCallId: "tool", title: "run command", kind: "execute", status: "pending", content: [] }, options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] } });
      setTimeout(() => { if (pending.has(sessionId)) { pending.delete(sessionId); promptDone(sessionId, id); } }, 20);
    };
    if (env.FAKE_ACP_DELAY === "1") setTimeout(run, 500); else run();
  }
});
