import readline from "node:readline";
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

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
//   FAKE_ACP_CLAUDE=1                mimic claude-agent-acp: modes default/acceptEdits/plan/auto/bypassPermissions (no read-only), no authMethods
//   FAKE_ACP_PROMPT_AUTH=1           session/prompt fails with -32000 (not logged in)
//   FAKE_ACP_PROMPT_ERROR=<json>     session/prompt fails with that {code, message[, data]}, e.g. {"code":-32603,"message":"Failed to refresh OAuth token: ..."}
//   FAKE_ACP_AUTH_STATUS=<kind>      push an _auth/status_update notification {authStatus:{kind,label}} right after initialize (label "Fake account" unless kind is none)
//   FAKE_ACP_CUMULATIVE=1            report usage cumulatively per session (inputTokens 2 * turns so far, outputTokens turns), like claude-agent-acp
//   FAKE_ACP_IMAGE=1                 advertise promptCapabilities.image; answer "<text> images:<n>" with n = the image blocks of the prompt; an image block without data fails with -32602
//   FAKE_ACP_IMAGE_GEN=agy|codex     every prompt generates an image like that agent does (spike section 3). agy: tool_call, then a permission request with the options
//                                    allow_always / allow / deny; allowed (allow or allow_always) -> writes a JPEG to <GEMINI_HOME>/antigravity-acp/brain/<sessionId>/ and completes with inline data,
//                                    uri and rawOutput.imagePath; cancelled or denied -> the call fails and nothing is written. codex: no permission; writes a PNG to
//                                    <CODEX_HOME>/generated_images/thread-<sessionId>/ and completes with a "Revised prompt:" text block and an image block (data also in rawOutput.result).
//   FAKE_ACP_IMAGE_GEN_OPTIONS=always-only   agy offers only the allow_always option
//   FAKE_ACP_IMAGE_GEN_OUTSIDE=<file>        write the image to <file> and report that path (outside the agent's image folder; the folder itself is still created)
//   FAKE_ACP_IMAGE_GEN_BYTES=<n>     pad the image to n bytes (a 2300000-byte codex image makes a ~6 MB update line)
//   FAKE_ACP_IMAGE_GEN_NONE=1        no tool call at all: the agent only answers "I cannot generate that image."
//   FAKE_ACP_LOG=<file>              append every request as a JSON line {method, params}; permission answers as {method: "permission_response", params: <the response result>}
const env = process.env;
const pending = new Map();
const models = new Map();
let sessionCount = 0;
let authedWith;
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const agy = env.FAKE_ACP_AGY === "1";
const claude = env.FAKE_ACP_CLAUDE === "1";
const fail = (id, code, message, data) => send({ jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } });
const turns = new Map();
const finish = (id, reason = "end_turn", sessionId) => {
  const n = env.FAKE_ACP_CUMULATIVE === "1" ? turns.get(sessionId) ?? 1 : 1;
  send({ jsonrpc: "2.0", id, result: { stopReason: reason, usage: { inputTokens: 2 * n, outputTokens: n, totalTokens: 3 * n } } });
};
const imageCounts = new Map();
const waiters = new Map();
const TINY_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const TINY_JPEG = Buffer.from("/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=", "base64");
const update = (sessionId, body) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: body } });
/** Writes the image (padded when asked) and returns its path: in the agent's folder, or at FAKE_ACP_IMAGE_GEN_OUTSIDE. */
const writeImage = (dir, name, bytes) => {
  const padded = Number(env.FAKE_ACP_IMAGE_GEN_BYTES || 0) > bytes.length ? Buffer.concat([bytes, Buffer.alloc(Number(env.FAKE_ACP_IMAGE_GEN_BYTES) - bytes.length, 0x61)]) : bytes;
  mkdirSync(dir, { recursive: true });
  const target = env.FAKE_ACP_IMAGE_GEN_OUTSIDE || path.join(dir, name);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, padded);
  return { file: target, data: padded.toString("base64") };
};
const sayDone = (sessionId, id, text) => {
  if (!pending.has(sessionId)) return;
  pending.delete(sessionId);
  update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
  finish(id, "end_turn", sessionId);
};
const generateImage = (sessionId, id) => {
  const toolCallId = `imgcall-${sessionId}`;
  if (env.FAKE_ACP_IMAGE_GEN_NONE === "1") { setTimeout(() => sayDone(sessionId, id, "I cannot generate that image."), 20); return; }
  if (env.FAKE_ACP_IMAGE_GEN === "codex") {
    update(sessionId, { sessionUpdate: "tool_call", toolCallId, kind: "other", title: "Image generation", status: "in_progress", rawInput: { id: toolCallId } });
    const written = writeImage(path.join(env.CODEX_HOME ?? "", "generated_images", `thread-${sessionId}`), `${toolCallId}.png`, TINY_PNG);
    setTimeout(() => {
      update(sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: "completed", content: [
        { type: "content", content: { type: "text", text: "Revised prompt: a cartoon dolphin leaping from the sea" } },
        { type: "content", content: { type: "image", data: written.data, mimeType: "image/png", uri: written.file } },
      ], rawOutput: { status: "completed", revisedPrompt: "a cartoon dolphin leaping from the sea", result: written.data, savedPath: written.file } });
      sayDone(sessionId, id, "Here is your image.");
    }, 20);
    return;
  }
  const input = { AspectRatio: "4:3", ImageName: "dolphin", Prompt: "a cartoon dolphin" };
  update(sessionId, { sessionUpdate: "tool_call", toolCallId, title: "Run generate_image?", kind: "other", status: "pending", rawInput: input });
  const options = [{ optionId: "allow_always", name: "Allow Always", kind: "allow_always" }, { optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }];
  const requestId = 9100 + Math.floor(Math.random() * 100000);
  waiters.set(requestId, (result) => {
    const allowed = result?.outcome?.outcome === "selected" && ["allow", "allow_always"].includes(result.outcome.optionId);
    if (!allowed) { update(sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: "failed", rawOutput: "Rejected by user" }); sayDone(sessionId, id, "The image tool was denied."); return; }
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId, kind: "other", status: "in_progress", title: "Running generate_image", rawInput: { prompt: input.Prompt, image_name: input.ImageName, aspect_ratio: input.AspectRatio } });
    const written = writeImage(path.join(env.GEMINI_HOME ?? "", "antigravity-acp", "brain", sessionId), `dolphin_${Date.now()}.jpg`, TINY_JPEG);
    setTimeout(() => {
      update(sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: "completed", content: [{ type: "content", content: { type: "image", data: written.data, mimeType: "image/jpeg", uri: "file://" + written.file } }], rawOutput: { imageName: "dolphin", imagePath: written.file, prompt: input.Prompt, aspectRatio: input.AspectRatio } });
      sayDone(sessionId, id, "Here is your cartoon dolphin.");
    }, 20);
  });
  send({ jsonrpc: "2.0", id: requestId, method: "session/request_permission", params: { sessionId, toolCall: { toolCallId, kind: "other", status: "pending", title: "Run generate_image?", rawInput: input }, options: env.FAKE_ACP_IMAGE_GEN_OPTIONS === "always-only" ? options.slice(0, 1) : options } });
};
const promptDone = (sessionId, id) => {
  const text = (env.FAKE_ACP_ECHO === "1" ? `echo:${models.get(sessionId) ?? ""}:${sessionId}:${authedWith ?? "-"}` : "fake response") + (env.FAKE_ACP_IMAGE === "1" ? ` images:${imageCounts.get(sessionId) ?? 0}` : "");
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
  finish(id, "end_turn", sessionId);
};
if (env.FAKE_ACP_GRANDCHILD) {
  const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  writeFileSync(env.FAKE_ACP_GRANDCHILD, String(grandchild.pid));
}
const defaultModels = [{ value: "gpt-5.6-sol" }, { value: "gpt-5.6-terra" }, { value: "gpt-5.6-luna" }];
const newSession = (id) => {
  const sessionId = sessionCount++ === 0 ? "fake-session" : `fake-session-${sessionCount}`;
  const modes = claude ? { currentModeId: "default", availableModes: ["default", "acceptEdits", "plan", "auto", "bypassPermissions"].map((id) => ({ id, name: id })) } : agy ? { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }, { id: "auto_edit", name: "Auto edit" }, { id: "yolo", name: "Yolo" }] } : env.FAKE_ACP_NO_READONLY === "1" ? { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }] } : { currentModeId: "read-only", availableModes: [{ id: "read-only", name: "Read only" }] };
  const options = env.FAKE_ACP_MODELS ? JSON.parse(env.FAKE_ACP_MODELS) : defaultModels;
  const respond = () => send({ jsonrpc: "2.0", id, result: { sessionId, modes, configOptions: [{ id: "model", name: "Model", category: "model", type: "select", currentValue: "gpt-5.6-sol", options }] } });
  const delay = Number(env.FAKE_ACP_SESSION_DELAY_MS || 0);
  if (delay > 0) setTimeout(respond, delay); else respond();
};
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line); const { id, method, params = {} } = message;
  if (!method) {
    if (env.FAKE_ACP_LOG && message.result?.outcome) appendFileSync(env.FAKE_ACP_LOG, JSON.stringify({ method: "permission_response", params: message.result }) + "\n");
    const waiter = waiters.get(id);
    if (waiter) { waiters.delete(id); waiter(message.result); }
    return;
  }
  if (env.FAKE_ACP_LOG) appendFileSync(env.FAKE_ACP_LOG, JSON.stringify({ method, params }) + "\n");
  if (method === "initialize") {
    send({ jsonrpc: "2.0", id, result: { protocolVersion: 1, agentCapabilities: { ...(env.FAKE_ACP_IMAGE === "1" ? { promptCapabilities: { image: true } } : {}), sessionCapabilities: agy ? { list: {}, resume: {} } : { delete: true } }, agentInfo: agy ? { name: "antigravity-acp", title: "Google Antigravity", version: "1.3.0" } : { name: "fake", version: "1" }, ...(env.FAKE_ACP_AUTH_METHODS ? { authMethods: JSON.parse(env.FAKE_ACP_AUTH_METHODS) } : {}) } });
    const kind = env.FAKE_ACP_AUTH_STATUS;
    if (kind) send({ jsonrpc: "2.0", method: "_auth/status_update", params: { authStatus: { kind, label: kind === "none" ? "Not logged in" : "Fake account" } } });
  }
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
    const images = (params.prompt ?? []).filter((block) => block.type === "image");
    if (env.FAKE_ACP_IMAGE === "1" && images.some((block) => typeof block.data !== "string" || !block.data)) { fail(id, -32602, "Invalid params: image data: expected string, received undefined"); return; }
    imageCounts.set(sessionId, images.length);
    pending.set(sessionId, id);
    turns.set(sessionId, (turns.get(sessionId) ?? 0) + 1);
    const run = () => {
      if (!pending.has(sessionId)) return;
      if (env.FAKE_ACP_PROMPT_AUTH === "1") { pending.delete(sessionId); fail(id, -32000, "Authentication required"); return; }
      if (env.FAKE_ACP_PROMPT_ERROR) { pending.delete(sessionId); const e = JSON.parse(env.FAKE_ACP_PROMPT_ERROR); fail(id, e.code, e.message, e.data); return; }
      if (env.FAKE_ACP_ENTITY_NOT_FOUND === "1") { pending.delete(sessionId); fail(id, -32603, "Requested entity was not found"); return; }
      if (env.FAKE_ACP_IMAGE_GEN) { generateImage(sessionId, id); return; }
      if (env.FAKE_ACP_REQUIRE_PERMISSION === "1") send({ jsonrpc: "2.0", id: 9001, method: "session/request_permission", params: { sessionId, toolCall: { toolCallId: "tool", title: "run command", kind: "execute", status: "pending", content: [] }, options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] } });
      setTimeout(() => { if (pending.has(sessionId)) { pending.delete(sessionId); promptDone(sessionId, id); } }, 20);
    };
    if (env.FAKE_ACP_DELAY === "1") setTimeout(run, 500); else run();
  }
});
