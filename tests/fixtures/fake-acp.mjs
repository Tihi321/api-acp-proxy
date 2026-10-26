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
//   FAKE_ACP_MCP=claude|agy|codex    every prompt uses the MCP server of session/new (the tool bridge) like that agent: its handshake (claude/agy: server/discover -> -32601, initialize 2025-11-25,
//                                    GET -> 405, tools/list; codex: initialize 2025-06-18), its tool_call updates and permission request shape (claude sends none when the session _meta has allowedTools),
//                                    then tools/call (answered as SSE, read to the end; all calls of a round at once for claude, one after another for agy and codex; agy re-initializes before its first call),
//                                    and finally answers "got: <result texts joined by ' | '>". Each step is logged as {method: "mcp", params: {phase, ...}} into FAKE_ACP_LOG.
//   FAKE_ACP_MCP_CALLS=<json>        rounds of calls: [[{"name":"get_weather","arguments":{"city":"Paris"}}, ...], ...] (default: one round with get_weather, and add too for claude)
//   FAKE_ACP_MCP_TEXT=<text>         text sent before the first call of a prompt (default "Let me check. ", empty for none)
//   FAKE_ACP_MCP_ONCE=1              only the first prompt of a session calls tools; later prompts answer "again"
//   FAKE_ACP_MCP_STRAY=1             before the real calls send permission requests that must not be allowed (another MCP server; codex: an unknown id and a tracked call of another server)
//   FAKE_ACP_REMOTE=claude|agy|codex  every prompt also calls tools of the remote MCP servers named in session/new (the http or sse entries other than the bridge) like that agent: its tool_call updates, its permission
//                                    request shape (claude sends none for a tool covered by the session _meta allowedTools), then tools/call straight to the server's url with the entry's headers (plain JSON reply),
//                                    and the completed update in that agent's shape (agy: only a placeholder). Without FAKE_ACP_MCP the prompt ends with "got: <result texts joined by ' | '>"; with it the remote
//                                    results come first in the same turn. Logged as {method: "mcp", params: {phase: "remote-permission" | "remote-call" | "remote-missing", ...}}.
//   FAKE_ACP_REMOTE_CALLS=<json>     [{"server":"docs","name":"echo","arguments":{"q":"hi"}}, ...] (default: echo on every remote server)
//   FAKE_ACP_REMOTE_FAIL=1           the remote tools/call answers an error: the completed update becomes a failed one
//   FAKE_ACP_MCP_CAPS=<json>         agentCapabilities.mcpCapabilities (default {"http":true,"sse":true})
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
const mcpSessions = new Map();
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
const logMcp = (params) => { if (env.FAKE_ACP_LOG) appendFileSync(env.FAKE_ACP_LOG, JSON.stringify({ method: "mcp", params }) + "\n"); };
let rpcCounter = 0;
let mcpCallCounter = 0;
const mcpPost = async (url, body, headers = {}) => {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify(body) });
  const raw = await response.text();
  const data = raw.split("\n").filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("\n");
  let parsed; try { parsed = JSON.parse(data || raw); } catch { parsed = undefined; }
  return { status: response.status, body: parsed, keepalives: (raw.match(/: keepalive/g) || []).length, contentType: response.headers.get("content-type") ?? "" };
};
const rpc = (url, method, params, headers) => mcpPost(url, { jsonrpc: "2.0", id: ++rpcCounter, method, params }, headers);
const handshake = async (kind, url) => {
  if (kind !== "codex") {
    const discover = await rpc(url, "server/discover", { protocolVersion: "2026-07-28" }, { "mcp-method": "server/discover" });
    logMcp({ phase: "server/discover", status: discover.status, code: discover.body?.error?.code });
  }
  const init = await rpc(url, "initialize", { protocolVersion: kind === "codex" ? "2025-06-18" : "2025-11-25", capabilities: {}, clientInfo: { name: "fake-" + kind, version: "1" } });
  logMcp({ phase: "initialize", status: init.status, protocolVersion: init.body?.result?.protocolVersion });
  const initialized = await mcpPost(url, { jsonrpc: "2.0", method: "notifications/initialized" });
  logMcp({ phase: "notifications/initialized", status: initialized.status });
  if (kind !== "codex") { const get = await fetch(url, { method: "GET", headers: { accept: "text/event-stream" } }); await get.text(); logMcp({ phase: "GET", status: get.status }); }
  const list = await rpc(url, "tools/list", {});
  logMcp({ phase: "tools/list", status: list.status, tools: (list.body?.result?.tools ?? []).map((tool) => ({ name: tool.name, readOnlyHint: tool.annotations?.readOnlyHint === true })) });
};
const askPermission = (sessionId, params, options) => new Promise((resolve) => {
  const requestId = 9500 + Math.floor(Math.random() * 1000000);
  waiters.set(requestId, resolve);
  send({ jsonrpc: "2.0", id: requestId, method: "session/request_permission", params: { sessionId, ...params, options } });
});
/** The remote MCP servers of a session (http / sse entries with a url, other than the bridge) called like the given agent does; returns their result texts. */
const runRemote = async (kind, sessionId, alive) => {
  const state = mcpSessions.get(sessionId);
  const allowedTools = state.meta?.claudeCode?.options?.allowedTools ?? [];
  const servers = (state.servers ?? []).filter((server) => server.name !== "client" && server.url);
  const calls = env.FAKE_ACP_REMOTE_CALLS ? JSON.parse(env.FAKE_ACP_REMOTE_CALLS) : servers.map((server) => ({ server: server.name, name: "echo", arguments: { q: "hi" } }));
  const texts = [];
  for (const call of calls) {
    const server = servers.find((entry) => entry.name === call.server);
    if (!server) { logMcp({ phase: "remote-missing", server: call.server }); texts.push("missing"); continue; }
    const toolCallId = `remote-${++mcpCallCounter}`;
    const title = kind === "claude" ? `mcp__${call.server}__${call.name}` : kind === "agy" ? `${call.server}_${call.name}` : `mcp.${call.server}.${call.name}`;
    const tracked = kind === "claude" ? { title, kind: "other", rawInput: {}, _meta: { claudeCode: { toolName: title } } }
      : kind === "agy" ? { title, kind: "other", rawInput: { arguments: call.arguments, ...call.arguments }, _meta: { mcp: { tool: call.name, server: call.server }, is_mcp_tool_call: true } }
      : { title, kind: "execute", rawInput: { server: call.server, tool: call.name, arguments: call.arguments }, _meta: { is_mcp_tool_call: true } };
    update(sessionId, { sessionUpdate: "tool_call", toolCallId, status: "pending", ...tracked });
    if (kind === "claude") update(sessionId, { sessionUpdate: "tool_call_update", toolCallId, rawInput: call.arguments, _meta: { claudeCode: { toolName: title } } });
    let allowed = true;
    if (kind === "claude") {
      if (!allowedTools.includes(`mcp__${call.server}__*`) && !allowedTools.includes(title)) allowed = wasAllowed(await askPermission(sessionId, { toolCall: { toolCallId, title, kind: "other", status: "pending", rawInput: call.arguments, _meta: { claudeCode: { toolName: title, mcpServer: { name: call.server, source: "dynamic" } } } } }, claudeOptions));
    } else if (kind === "agy") allowed = wasAllowed(await askPermission(sessionId, { toolCall: { toolCallId, title, kind: "other", status: "pending", rawInput: tracked.rawInput, _meta: tracked._meta } }, agyOptions));
    else allowed = wasAllowed(await askPermission(sessionId, { toolCall: { toolCallId, kind: "execute", status: "pending" }, _meta: { is_mcp_tool_approval: true } }, codexOptions));
    if (!alive()) return texts;
    logMcp({ phase: "remote-permission", server: call.server, tool: call.name, allowed });
    if (!allowed) { update(sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: "failed", rawOutput: "Rejected by user" }); texts.push("denied"); continue; }
    const headers = Object.fromEntries((server.headers ?? []).map((header) => [header.name, header.value]));
    await rpc(server.url, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-" + kind, version: "1" } }, headers);
    const reply = await rpc(server.url, "tools/call", { name: call.name, arguments: call.arguments }, headers);
    const failed = env.FAKE_ACP_REMOTE_FAIL === "1" || reply.body?.error !== undefined || reply.body?.result?.isError === true;
    const text = reply.body?.result?.content?.[0]?.text ?? reply.body?.error?.message ?? "";
    logMcp({ phase: "remote-call", server: call.server, tool: call.name, status: reply.status, text });
    if (!alive()) return texts;
    if (failed) update(sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: "failed", ...(kind === "codex" ? { rawOutput: { result: null, error: { message: text || "tool failed" } } } : { rawOutput: text || "tool failed" }) });
    else update(sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: "completed",
      ...(kind === "agy" ? { content: [{ type: "content", content: { type: "text", text: `Call ${call.server} ${call.name} tool` } }], rawOutput: `Call ${call.server} ${call.name} tool` }
        : kind === "claude" ? { rawOutput: [{ type: "text", text }], content: [{ type: "content", content: { type: "text", text } }] }
        : { rawOutput: { result: { content: [{ type: "text", text }], structuredContent: null, _meta: null }, error: null } }) });
    texts.push(text);
  }
  return texts;
};
const claudeOptions = [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }, { optionId: "allow-with-updates", name: "Always allow", kind: "allow_always" }, { optionId: "reject", name: "Reject", kind: "reject_once" }];
const agyOptions = [{ optionId: "allow_always", name: "Allow Always", kind: "allow_always" }, { optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }];
const codexOptions = [{ optionId: "allow_once", name: "Allow", kind: "allow_once" }, { optionId: "allow_session", name: "Allow for session", kind: "allow_always" }, { optionId: "allow_always", name: "Always", kind: "allow_always" }, { optionId: "cancel", name: "Cancel", kind: "reject_once" }];
const wasAllowed = (result) => result?.outcome?.outcome === "selected" && ["allow-once", "allow", "allow_once"].includes(result.outcome.optionId);
/** Permission requests that are not for the bridge's tools; each is logged with the proxy's answer. */
const strayPermissions = async (kind, sessionId) => {
  const shapes = kind === "claude" ? [{ toolCall: { toolCallId: "stray-1", title: "mcp__other__thing", kind: "other", status: "pending", _meta: { claudeCode: { toolName: "mcp__other__thing", mcpServer: { name: "other", source: "dynamic" } } } }, options: claudeOptions }]
    : kind === "agy" ? [{ toolCall: { toolCallId: "stray-1", title: "other_thing", kind: "other", status: "pending", _meta: { mcp: { tool: "thing", server: "other" }, is_mcp_tool_call: true } }, options: agyOptions }]
    : [{ toolCall: { toolCallId: "stray-unknown", kind: "execute", status: "pending" }, _meta: { is_mcp_tool_approval: true }, options: codexOptions }, { toolCall: { toolCallId: "stray-other", kind: "execute", status: "pending" }, _meta: { is_mcp_tool_approval: true }, options: codexOptions, track: { toolCallId: "stray-other", kind: "execute", title: "mcp.other.thing", rawInput: { server: "other", tool: "thing" }, _meta: { is_mcp_tool_call: true } } }];
  for (const shape of shapes) {
    if (shape.track) update(sessionId, { sessionUpdate: "tool_call", status: "in_progress", ...shape.track });
    const result = await askPermission(sessionId, { toolCall: shape.toolCall, ...(shape._meta ? { _meta: shape._meta } : {}) }, shape.options);
    logMcp({ phase: "stray", toolCallId: shape.toolCall.toolCallId, allowed: wasAllowed(result) });
  }
};
const runMcp = async (sessionId, promptId) => {
  const kind = env.FAKE_ACP_MCP;
  const state = mcpSessions.get(sessionId);
  const alive = () => pending.get(sessionId) === promptId;
  state.prompts++;
  if (!state.url) { sayDone(sessionId, promptId, "no mcp server"); return; }
  if (env.FAKE_ACP_MCP_ONCE === "1" && state.prompts > 1) { sayDone(sessionId, promptId, "again"); return; }
  const before = env.FAKE_ACP_MCP_TEXT ?? "Let me check. ";
  if (before) update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: before } });
  const allowedTools = state.meta?.claudeCode?.options?.allowedTools;
  const remote = env.FAKE_ACP_REMOTE ? await runRemote(env.FAKE_ACP_REMOTE, sessionId, alive) : [];
  if (!alive()) return;
  if (!state.ready) { await handshake(kind, state.url); state.ready = true; if (!alive()) return; }
  if (env.FAKE_ACP_MCP_STRAY === "1") { await strayPermissions(kind, sessionId); if (!alive()) return; }
  const weather = { name: "get_weather", arguments: { city: "Paris" } };
  const rounds = env.FAKE_ACP_MCP_CALLS ? JSON.parse(env.FAKE_ACP_MCP_CALLS) : [kind === "claude" ? [weather, { name: "add", arguments: { a: 1, b: 2 } }] : [weather]];
  const texts = [...remote];
  const callOne = async (call) => {
    const slot = texts.length; texts.push("");
    const toolCallId = `mcpcall-${++mcpCallCounter}`;
    const title = kind === "claude" ? `mcp__client__${call.name}` : kind === "agy" ? `client_${call.name}` : `mcp.client.${call.name}`;
    const tracked = kind === "claude" ? { title, kind: "other", _meta: { claudeCode: { toolName: title } } }
      : kind === "agy" ? { title, kind: "other", rawInput: { arguments: call.arguments, ...call.arguments }, _meta: { mcp: { tool: call.name, server: "client" }, is_mcp_tool_call: true } }
      : { title, kind: "execute", rawInput: { server: "client", tool: call.name, arguments: call.arguments }, _meta: { is_mcp_tool_call: true } };
    update(sessionId, { sessionUpdate: "tool_call", toolCallId, status: "pending", ...tracked });
    let allowed = true;
    if (kind === "claude" && !(allowedTools ?? []).includes("mcp__client__*")) {
      const result = await askPermission(sessionId, { toolCall: { toolCallId, title, kind: "other", status: "pending", rawInput: call.arguments, _meta: { claudeCode: { toolName: title, mcpServer: { name: "client", source: "dynamic" } } } } }, claudeOptions);
      allowed = wasAllowed(result);
    } else if (kind === "agy") {
      allowed = wasAllowed(await askPermission(sessionId, { toolCall: { toolCallId, title, kind: "other", status: "pending", rawInput: tracked.rawInput, _meta: tracked._meta } }, agyOptions));
    } else if (kind === "codex") {
      allowed = wasAllowed(await askPermission(sessionId, { toolCall: { toolCallId, kind: "execute", status: "pending" }, _meta: { is_mcp_tool_approval: true } }, codexOptions));
    }
    if (!alive()) return;
    logMcp({ phase: "permission", tool: call.name, allowed });
    if (!allowed) { update(sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: "failed", rawOutput: "Rejected by user" }); texts[slot] = "denied"; return; }
    if (kind === "agy" && !state.reconnected) { state.reconnected = true; await handshake("agy", state.url); }
    logMcp({ phase: "tools/call sent", tool: call.name });
    const reply = await rpc(state.url, "tools/call", { name: call.name, arguments: call.arguments, _meta: kind === "codex" ? { callId: toolCallId } : kind === "claude" ? { "claudecode/toolUseId": toolCallId } : {} });
    const text = reply.body?.result?.content?.[0]?.text ?? reply.body?.error?.message ?? "";
    logMcp({ phase: "tools/call", tool: call.name, status: reply.status, contentType: reply.contentType, keepalives: reply.keepalives, isError: reply.body?.result?.isError === true, text });
    if (alive()) update(sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: "completed", ...(kind === "agy" ? { content: [{ type: "content", content: { type: "text", text: `Call client ${call.name} tool` } }] } : { rawOutput: { text } }) });
    texts[slot] = text;
  };
  for (const round of rounds) {
    if (kind === "claude") await Promise.all(round.map(callOne)); else for (const call of round) await callOne(call);
    if (!alive()) return;
  }
  sayDone(sessionId, promptId, `got: ${texts.join(" | ")}`);
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
const newSession = (id, params = {}) => {
  const sessionId = sessionCount++ === 0 ? "fake-session" : `fake-session-${sessionCount}`;
  mcpSessions.set(sessionId, { url: (params.mcpServers ?? []).find((server) => server.name === "client")?.url, servers: params.mcpServers ?? [], meta: params._meta, prompts: 0 });
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
    send({ jsonrpc: "2.0", id, result: { protocolVersion: 1, agentCapabilities: { ...(env.FAKE_ACP_IMAGE === "1" ? { promptCapabilities: { image: true } } : {}), mcpCapabilities: env.FAKE_ACP_MCP_CAPS ? JSON.parse(env.FAKE_ACP_MCP_CAPS) : { http: true, sse: true }, sessionCapabilities: agy ? { list: {}, resume: {} } : { delete: true } }, agentInfo: agy ? { name: "antigravity-acp", title: "Google Antigravity", version: "1.3.0" } : { name: "fake", version: "1" }, ...(env.FAKE_ACP_AUTH_METHODS ? { authMethods: JSON.parse(env.FAKE_ACP_AUTH_METHODS) } : {}) } });
    const kind = env.FAKE_ACP_AUTH_STATUS;
    if (kind) send({ jsonrpc: "2.0", method: "_auth/status_update", params: { authStatus: { kind, label: kind === "none" ? "Not logged in" : "Fake account" } } });
  }
  else if (method === "authenticate") {
    if (agy || env.FAKE_ACP_AUTH_URL === "1") process.stderr.write("Open the following link to authenticate the ACP server: https://accounts.google.com/o/oauth2/v2/auth?client_id=fake&redirect_uri=http%3A%2F%2F127.0.0.1%3A1%2F\n");
    const done = () => { authedWith = params.methodId; send({ jsonrpc: "2.0", id, result: {} }); };
    const authDelay = Number(env.FAKE_ACP_AUTH_DELAY_MS || 0);
    if (authDelay > 0) setTimeout(done, authDelay); else done();
  }
  else if (method === "session/new") { if (env.FAKE_ACP_REQUIRE_AUTH === "1" && !authedWith) fail(id, -32000, "Authentication required", agy ? { message: "No authentication method selected. Either call the `authenticate` method (supports oauth-personal, gemini-api-key, agent-platform)" } : undefined); else newSession(id, params); }
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
      if (env.FAKE_ACP_REMOTE && !env.FAKE_ACP_MCP) {
        const kind = env.FAKE_ACP_REMOTE;
        const before = env.FAKE_ACP_MCP_TEXT ?? "Let me check. ";
        if (before) update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: before } });
        runRemote(kind, sessionId, () => pending.get(sessionId) === id).then((texts) => { if (pending.get(sessionId) === id) sayDone(sessionId, id, `got: ${texts.join(" | ")}`); }).catch((error) => { logMcp({ phase: "error", message: String(error?.message ?? error) }); sayDone(sessionId, id, "mcp error: " + String(error?.message ?? error)); });
        return;
      }
      if (env.FAKE_ACP_MCP) { runMcp(sessionId, id).catch((error) => { logMcp({ phase: "error", message: String(error?.message ?? error) }); sayDone(sessionId, id, "mcp error: " + String(error?.message ?? error)); }); return; }
      if (env.FAKE_ACP_REQUIRE_PERMISSION === "1") send({ jsonrpc: "2.0", id: 9001, method: "session/request_permission", params: { sessionId, toolCall: { toolCallId: "tool", title: "run command", kind: "execute", status: "pending", content: [] }, options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] } });
      setTimeout(() => { if (pending.has(sessionId)) { pending.delete(sessionId); promptDone(sessionId, id); } }, 20);
    };
    if (env.FAKE_ACP_DELAY === "1") setTimeout(run, 500); else run();
  }
});
