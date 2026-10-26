import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AcpProvider, type AcpProviderOptions } from "../src/acp-provider.js";
import { buildPrompt, normalizeChat, normalizeResponses, textMessage } from "../src/api.js";
import type { ProxyConfig } from "../src/config.js";
import { ProxyController } from "../src/controller.js";
import { createLogger } from "../src/logger.js";
import { defaultRuntimeContext, type ProviderDescriptor } from "../src/provider.js";
import { antigravityDescriptor } from "../src/providers/antigravity.js";
import { claudeDescriptor } from "../src/providers/claude.js";
import { codexDescriptor } from "../src/providers/codex.js";
import { ProviderRouter } from "../src/router.js";
import { createProxyServer } from "../src/server.js";
import { ToolBridgeHub } from "../src/tool-bridge.js";

// Every Antigravity provider start runs the Windows orphan sweep, which is slow.
vi.setConfig({ testTimeout: 30_000 });

const fixture = fileURLToPath(new URL("./fixtures/fake-acp.mjs", import.meta.url));
const root = path.resolve(".claude/temp/tool-calling-tests", String(process.pid));

let counter = 0;
const servers: Server[] = [];
const providers: AcpProvider[] = [];
const controllers: ProxyController[] = [];
interface Dirs { base: string; dataDir: string; workRoot: string; log: string; hub: ToolBridgeHub }

function dirs(keepaliveMs = 30): Dirs {
  const base = path.join(root, `t${++counter}`);
  const d: Dirs = { base, dataDir: path.join(base, "data"), workRoot: path.join(base, "work"), log: path.join(base, "requests.log"), hub: new ToolBridgeHub({ keepaliveMs }) };
  const agentDir = path.join(d.dataDir, "agents", "antigravity-acp");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(path.join(agentDir, "install.json"), JSON.stringify({ version: "1.0.0", url: "x", sha256: "x", command: process.execPath, args: [fixture], dir: agentDir, installedAt: new Date().toISOString() }));
  process.env.FAKE_ACP_LOG = d.log;
  return d;
}
const ctxFor = (d: Dirs) => defaultRuntimeContext({ dataDir: d.dataDir, toolBridge: d.hub });
const opts = (d: Dirs, extra: Partial<AcpProviderOptions> = {}): AcpProviderOptions => ({ workRoot: d.workRoot, toolBatchMs: 40, ...extra });
function agy(d: Dirs, extra: Partial<AcpProviderOptions> = {}, overrides: Partial<ProviderDescriptor> = {}): AcpProvider {
  const ctx = ctxFor(d);
  const provider = new AcpProvider(antigravityDescriptor(ctx, { env: {}, settings: { termsAcknowledgedAt: "2026-01-01T00:00:00Z", geminiHome: path.join(d.base, "gemini") }, overrides: { warmSessions: 0, ...overrides } }), ctx, opts(d, extra));
  providers.push(provider);
  return provider;
}
function codex(d: Dirs, extra: Partial<AcpProviderOptions> = {}, overrides: Partial<ProviderDescriptor> = {}): AcpProvider {
  const provider = new AcpProvider({ ...codexDescriptor({ acpCommand: process.execPath, acpArgs: [fixture] }, { isolatedHome: true }), ...overrides }, ctxFor(d), opts(d, extra));
  providers.push(provider);
  return provider;
}
function claude(d: Dirs, extra: Partial<AcpProviderOptions> = {}, overrides: Partial<ProviderDescriptor> = {}): AcpProvider {
  const descriptor = claudeDescriptor({ termsAcknowledgedAt: "2026-01-01T00:00:00Z", configDir: path.join(d.base, "claude") }, {}, { warmSessions: 0, launch: () => ({ command: process.execPath, args: [fixture], env: { ...process.env } }), ...overrides });
  const provider = new AcpProvider(descriptor, ctxFor(d), opts(d, extra));
  providers.push(provider);
  return provider;
}
/** A provider that cannot be given tools (no permission rule). */
function noTools(d: Dirs): AcpProvider {
  const descriptor: ProviderDescriptor = { id: "claude", displayName: "Claude", ownedBy: "anthropic", exposeUnprefixed: false, staticModels: ["haiku"], authMode: "on-demand", readOnlyMode: "optional", launch: () => ({ command: process.execPath, args: [fixture], env: { ...process.env } }), chooseAuth: () => undefined };
  const provider = new AcpProvider(descriptor, ctxFor(d), opts(d));
  providers.push(provider);
  return provider;
}
async function start(d: Dirs, list: AcpProvider[], config: Partial<ProxyConfig> = {}): Promise<string> {
  const full: ProxyConfig = { host: "127.0.0.1", port: 0, maxBodyBytes: 20 * 1024 * 1024, timeoutMs: 25_000, workRoot: d.workRoot, acpArgs: [], apiKey: "secret", ...config };
  const server = createProxyServer(full, new ProviderRouter({ providers: list }), { toolBridge: d.hub });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function send(base: string, route: string, body: unknown, headers: Record<string, string> = { authorization: "Bearer secret" }): Promise<{ status: number; body: any; raw: string }> {
  const response = await fetch(`${base}${route}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const raw = await response.text();
  let parsed: any; try { parsed = JSON.parse(raw); } catch { parsed = undefined; }
  return { status: response.status, body: parsed, raw };
}
const sse = (raw: string) => raw.split("\n\n").flatMap((block) => { const data = block.split("\n").filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("\n"); return data && data !== "[DONE]" ? [JSON.parse(data) as any] : []; });
const readLog = (d: Dirs) => (existsSync(d.log) ? readFileSync(d.log, "utf8").trim().split("\n").filter(Boolean) : []).map((line) => JSON.parse(line) as { method: string; params: any });
const mcpLog = (d: Dirs, phase?: string) => readLog(d).filter((entry) => entry.method === "mcp" && (!phase || entry.params.phase === phase)).map((entry) => entry.params);
const requests = (d: Dirs, method: string) => readLog(d).filter((entry) => entry.method === method).map((entry) => entry.params);
const promptTexts = (d: Dirs): string[] => requests(d, "session/prompt").map((params) => params.prompt.map((block: any) => block.text ?? "").join(""));
const permissionAnswers = (d: Dirs) => readLog(d).filter((entry) => entry.method === "permission_response").map((entry) => entry.params.outcome);
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, ms = 5000): Promise<void> { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error("timed out waiting"); await wait(20); } }

const AGY_MODEL = "antigravity/gemini-3.8-flash-low";
const CODEX_MODEL = "codex/gpt-5.6-sol";
const CLAUDE_MODEL = "claude/haiku";
const weatherParameters = { type: "object", properties: { city: { type: "string" } }, required: ["city"] };
const addParameters = { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] };
const chatTools = [
  { type: "function", function: { name: "get_weather", description: "Weather of a city", parameters: weatherParameters } },
  { type: "function", function: { name: "add", description: "Adds two numbers", parameters: addParameters } },
];
const responsesTools = [
  { type: "function", name: "get_weather", description: "Weather of a city", parameters: weatherParameters },
  { type: "function", name: "add", description: "Adds two numbers", parameters: addParameters },
];
const question = { role: "user", content: "What is the weather in Paris and what is 1 + 2?" };
const chat = (model: string, extra: Record<string, unknown> = {}) => ({ model, messages: [question], tools: chatTools, ...extra });
/** The chat messages that answer a tool-calling reply: its assistant message, then one tool message per call. */
const chatFollowUp = (reply: any, results: string[], history: unknown[] = [question]) => {
  const message = reply.choices[0].message;
  return [...history, { role: "assistant", content: message.content, tool_calls: message.tool_calls }, ...message.tool_calls.map((call: any, index: number) => ({ role: "tool", tool_call_id: call.id, content: results[index] }))];
};

beforeEach(() => { mkdirSync(root, { recursive: true }); });
afterEach(async () => {
  await Promise.all(controllers.splice(0).map((controller) => controller.stop()));
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); })));
  await Promise.all(providers.splice(0).map((provider) => provider.close()));
  for (const key of Object.keys(process.env)) if (key.startsWith("FAKE_ACP_")) delete process.env[key];
});

describe("chat tool calls", () => {
  it("returns the call, resumes the same session with the result, and answers over the SSE bridge (Antigravity)", async () => {
    const d = dirs();
    Object.assign(process.env, { FAKE_ACP_AGY: "1", FAKE_ACP_MCP: "agy" });
    const base = await start(d, [agy(d)]);
    const first = await send(base, "/v1/chat/completions", chat(AGY_MODEL));
    expect(first.status).toBe(200);
    const message = first.body.choices[0].message;
    expect(first.body.choices[0].finish_reason).toBe("tool_calls");
    expect(message.content).toBe("Let me check. ");
    expect(message.tool_calls).toHaveLength(1);
    expect(message.tool_calls[0]).toMatchObject({ type: "function", function: { name: "get_weather", arguments: JSON.stringify({ city: "Paris" }) } });
    expect(message.tool_calls[0].id).toMatch(/^call_[0-9a-f]{24}$/);
    expect(permissionAnswers(d)).toEqual([{ outcome: "selected", optionId: "allow" }]);
    // The session was made with the bridge at the address the server listens on, never taken from the warm pool.
    const created = requests(d, "session/new");
    expect(created).toHaveLength(1);
    expect(created[0].mcpServers).toEqual([{ type: "http", name: "client", url: expect.stringMatching(new RegExp(`^http://127\\.0\\.0\\.1:${new URL(base).port}/mcp/[A-Za-z0-9_-]{43}$`)), headers: [] }]);
    // The agent's handshake worked against the bridge, including the reconnect with a new initialize.
    expect(mcpLog(d, "server/discover")[0]).toMatchObject({ status: 200, code: -32601 });
    expect(mcpLog(d, "GET")[0].status).toBe(405);
    expect(mcpLog(d, "initialize").map((entry) => entry.protocolVersion)).toEqual(["2025-11-25", "2025-11-25"]);
    expect(mcpLog(d, "tools/list")[0].tools).toEqual([{ name: "get_weather", readOnlyHint: true }, { name: "add", readOnlyHint: true }]);
    const text = promptTexts(d)[0]!;
    expect(text).toContain("MCP server named \"client\"");
    expect(text).not.toContain("Do not call any tool");

    const second = await send(base, "/v1/chat/completions", chat(AGY_MODEL, { messages: chatFollowUp(first.body, ["18 C, sunny"]) }));
    expect(second.status).toBe(200);
    expect(second.body.choices[0]).toMatchObject({ finish_reason: "stop", message: { content: "got: 18 C, sunny" } });
    expect(second.body.choices[0].message).not.toHaveProperty("tool_calls");
    // One session, one prompt: the held call was answered, nothing started again.
    expect(requests(d, "session/new")).toHaveLength(1);
    expect(requests(d, "session/prompt")).toHaveLength(1);
    const reply = mcpLog(d, "tools/call")[0];
    expect(reply).toMatchObject({ status: 200, contentType: "text/event-stream", isError: false, text: "18 C, sunny" });
    expect(reply.keepalives).toBeGreaterThanOrEqual(1);
  });

  it("streams the text before the call, the call, and then the rest of the turn into the resuming request (Codex)", async () => {
    const d = dirs();
    Object.assign(process.env, { FAKE_ACP_MCP: "codex" });
    const base = await start(d, [codex(d)]);
    const first = await send(base, "/v1/chat/completions", chat(CODEX_MODEL, { stream: true }));
    const chunks = sse(first.raw);
    expect(chunks[0].choices[0].delta).toEqual({ role: "assistant" });
    expect(chunks.filter((chunk) => chunk.choices[0]?.delta?.content).map((chunk) => chunk.choices[0].delta.content).join("")).toBe("Let me check. ");
    const callChunk = chunks.find((chunk) => chunk.choices[0]?.delta?.tool_calls);
    expect(callChunk.choices[0].delta.tool_calls).toEqual([{ index: 0, id: expect.stringMatching(/^call_/), type: "function", function: { name: "get_weather", arguments: JSON.stringify({ city: "Paris" }) } }]);
    expect(chunks[chunks.length - 1].choices[0]).toMatchObject({ delta: {}, finish_reason: "tool_calls" });
    // Codex's approval request has only the id: it is matched to the tracked tool_call of the client server.
    expect(permissionAnswers(d)).toEqual([{ outcome: "selected", optionId: "allow_once" }]);
    expect(mcpLog(d, "initialize").map((entry) => entry.protocolVersion)).toEqual(["2025-06-18"]);

    const reply = { choices: [{ message: { content: "Let me check. ", tool_calls: callChunk.choices[0].delta.tool_calls.map(({ index: _index, ...call }: any) => call) } }] };
    const second = await send(base, "/v1/chat/completions", chat(CODEX_MODEL, { stream: true, messages: chatFollowUp(reply, ["rain"]) }));
    const tail = sse(second.raw);
    expect(tail.filter((chunk) => chunk.choices[0]?.delta?.content).map((chunk) => chunk.choices[0].delta.content).join("")).toBe("got: rain");
    expect(tail[tail.length - 1].choices[0].finish_reason).toBe("stop");
    expect(requests(d, "session/prompt")).toHaveLength(1);
  });

  it("returns parallel calls together and resumes with all results (Claude, no permission with allowedTools)", async () => {
    const d = dirs();
    Object.assign(process.env, { FAKE_ACP_CLAUDE: "1", FAKE_ACP_MCP: "claude" });
    const base = await start(d, [claude(d)]);
    const first = await send(base, "/v1/chat/completions", chat(CLAUDE_MODEL));
    const calls = first.body.choices[0].message.tool_calls;
    expect(calls.map((call: any) => call.function.name).sort()).toEqual(["add", "get_weather"]);
    expect(new Set(calls.map((call: any) => call.id)).size).toBe(2);
    expect(first.body.choices[0].finish_reason).toBe("tool_calls");
    // allowedTools merged into the static session meta; no permission request came.
    const meta = requests(d, "session/new")[0]._meta;
    expect(meta).toEqual({ disableBuiltInTools: true, claudeCode: { options: { tools: [], persistSession: false, settingSources: [], allowedTools: ["mcp__client__*"] } } });
    expect(permissionAnswers(d)).toEqual([]);
    const results = calls.map((call: any) => call.function.name === "add" ? "3" : "18 C");
    const second = await send(base, "/v1/chat/completions", chat(CLAUDE_MODEL, { messages: chatFollowUp(first.body, results) }));
    expect(second.body.choices[0]).toMatchObject({ finish_reason: "stop" });
    expect(second.body.choices[0].message.content).toBe("got: 18 C | 3");
    expect(requests(d, "session/prompt")).toHaveLength(1);
  });

  it("asks for the Claude permission only without allowedTools, and allows only the client server", async () => {
    const d = dirs();
    Object.assign(process.env, { FAKE_ACP_CLAUDE: "1", FAKE_ACP_MCP: "claude", FAKE_ACP_MCP_STRAY: "1" });
    const base = await start(d, [claude(d, {}, { mcpSessionMeta: undefined })]);
    const first = await send(base, "/v1/chat/completions", chat(CLAUDE_MODEL));
    expect(first.body.choices[0].message.tool_calls).toHaveLength(2);
    expect(requests(d, "session/new")[0]._meta.claudeCode.options).not.toHaveProperty("allowedTools");
    expect(permissionAnswers(d)).toEqual([{ outcome: "cancelled" }, { outcome: "selected", optionId: "allow-once" }, { outcome: "selected", optionId: "allow-once" }]);
    expect(mcpLog(d, "stray")).toEqual([{ phase: "stray", toolCallId: "stray-1", allowed: false }]);
  });

  it("returns only the first call with parallel_tool_calls false and tells the agent to call one tool at a time", async () => {
    const d = dirs();
    Object.assign(process.env, { FAKE_ACP_CLAUDE: "1", FAKE_ACP_MCP: "claude" });
    const base = await start(d, [claude(d)]);
    const first = await send(base, "/v1/chat/completions", chat(CLAUDE_MODEL, { parallel_tool_calls: false }));
    const calls = first.body.choices[0].message.tool_calls;
    expect(calls).toHaveLength(1);
    expect(calls[0].function.name).toBe("get_weather");
    expect(promptTexts(d)[0]).toContain("Call one tool at a time.");
    const second = await send(base, "/v1/chat/completions", chat(CLAUDE_MODEL, { parallel_tool_calls: false, messages: chatFollowUp(first.body, ["18 C"]) }));
    expect(second.body.choices[0].message.content).toMatch(/^got: 18 C \| Call one tool at a time\./);
    const refused = mcpLog(d, "tools/call").find((entry) => entry.tool === "add");
    expect(refused).toMatchObject({ isError: true });
  });

  it("walks several rounds: a second call after the first result is a new suspension of the same turn", async () => {
    const d = dirs();
    Object.assign(process.env, { FAKE_ACP_MCP: "codex", FAKE_ACP_MCP_CALLS: JSON.stringify([[{ name: "get_weather", arguments: { city: "Paris" } }], [{ name: "add", arguments: { a: 1, b: 2 } }]]) });
    const base = await start(d, [codex(d)]);
    const first = await send(base, "/v1/chat/completions", chat(CODEX_MODEL));
    expect(first.body.choices[0].message.tool_calls[0].function.name).toBe("get_weather");
    const history1 = chatFollowUp(first.body, ["18 C"]);
    const second = await send(base, "/v1/chat/completions", chat(CODEX_MODEL, { messages: history1 }));
    expect(second.body.choices[0].finish_reason).toBe("tool_calls");
    expect(second.body.choices[0].message.content).toBeNull();
    expect(second.body.choices[0].message.tool_calls[0].function).toEqual({ name: "add", arguments: JSON.stringify({ a: 1, b: 2 }) });
    const third = await send(base, "/v1/chat/completions", chat(CODEX_MODEL, { messages: chatFollowUp(second.body, ["3"], history1) }));
    expect(third.body.choices[0]).toMatchObject({ finish_reason: "stop", message: { content: "got: 18 C | 3" } });
    expect(requests(d, "session/new")).toHaveLength(1);
    expect(requests(d, "session/prompt")).toHaveLength(1);
  });

  it("treats a tool call whose agent never calls a tool as a plain answer", async () => {
    const d = dirs();
    Object.assign(process.env, { FAKE_ACP_AGY: "1" });
    const base = await start(d, [agy(d)]);
    const result = await send(base, "/v1/chat/completions", chat(AGY_MODEL));
    expect(result.body.choices[0]).toMatchObject({ finish_reason: "stop", message: { content: "fake response" } });
    expect(result.body.choices[0].message).not.toHaveProperty("tool_calls");
    // the session still had the bridge
    expect(requests(d, "session/new")[0].mcpServers).toHaveLength(1);
  });
});

describe("output limits", () => {
  it("cuts the text at max_tokens, cancels the turn and drops the session", async () => {
    const d = dirs();
    Object.assign(process.env, { FAKE_ACP_MCP: "codex", FAKE_ACP_MCP_TEXT: "Let me check the weather for you, please wait a moment." });
    const base = await start(d, [codex(d)]);
    const result = await send(base, "/v1/chat/completions", chat(CODEX_MODEL, { max_tokens: 2 }));
    expect(result.status).toBe(200);
    expect(result.body.choices[0]).toMatchObject({ finish_reason: "length", message: { content: "Let me c" } });
    await until(() => requests(d, "session/cancel").length > 0 && requests(d, "session/delete").length > 0);
    expect(result.body.choices[0].message).not.toHaveProperty("tool_calls");
  });
});

describe("Responses function calls", () => {
  it("returns a function_call item after the message, and resumes from the echoed output items", async () => {
    const d = dirs();
    Object.assign(process.env, { FAKE_ACP_AGY: "1", FAKE_ACP_MCP: "agy" });
    const base = await start(d, [agy(d)]);
    const input = [{ role: "user", content: "What is the weather in Paris?" }];
    const first = await send(base, "/v1/responses", { model: AGY_MODEL, input, tools: responsesTools });
    expect(first.status).toBe(200);
    expect(first.body.status).toBe("completed");
    expect(first.body.output.map((item: any) => item.type)).toEqual(["message", "function_call"]);
    expect(first.body.output[0].content[0].text).toBe("Let me check. ");
    const call = first.body.output[1];
    expect(call).toMatchObject({ type: "function_call", status: "completed", name: "get_weather", arguments: JSON.stringify({ city: "Paris" }) });
    expect(call.call_id).toMatch(/^call_/);
    expect(call.id).toMatch(/^fc-/);
    const second = await send(base, "/v1/responses", { model: AGY_MODEL, input: [...input, ...first.body.output, { type: "function_call_output", call_id: call.call_id, output: "sunny" }], tools: responsesTools });
    expect(second.status).toBe(200);
    expect(second.body.output.map((item: any) => item.type)).toEqual(["message"]);
    expect(second.body.output[0].content[0].text).toBe("got: sunny");
    expect(requests(d, "session/new")).toHaveLength(1);
  });

  it("streams output_item.added, the argument events and output_item.done for each call, with no message when the agent said nothing", async () => {
    const d = dirs();
    Object.assign(process.env, { FAKE_ACP_MCP: "codex", FAKE_ACP_MCP_TEXT: "" });
    const base = await start(d, [codex(d)]);
    const first = await send(base, "/v1/responses", { model: CODEX_MODEL, input: "weather in Paris?", stream: true, tools: responsesTools });
    const events = sse(first.raw);
    expect(events.map((event) => event.type)).toEqual(["response.created", "response.output_item.added", "response.function_call_arguments.delta", "response.function_call_arguments.done", "response.output_item.done", "response.completed"]);
    expect(events[1]).toMatchObject({ output_index: 0, item: { type: "function_call", status: "in_progress", arguments: "", name: "get_weather" } });
    expect(events[2]).toMatchObject({ output_index: 0, delta: JSON.stringify({ city: "Paris" }) });
    expect(events[3]).toMatchObject({ output_index: 0, name: "get_weather", arguments: JSON.stringify({ city: "Paris" }) });
    const item = events[4].item;
    expect(item).toMatchObject({ type: "function_call", status: "completed", call_id: expect.stringMatching(/^call_/) });
    expect(events[5].response.output).toEqual([item]);
    const second = await send(base, "/v1/responses", { model: CODEX_MODEL, stream: true, tools: responsesTools, input: [{ role: "user", content: "weather in Paris?" }, { type: "function_call", call_id: item.call_id, name: item.name, arguments: item.arguments }, { type: "function_call_output", call_id: item.call_id, output: "sunny" }] });
    const tail = sse(second.raw);
    expect(tail.map((event) => event.type)).toEqual(["response.created", "response.output_item.added", "response.content_part.added", "response.output_text.delta", "response.output_text.done", "response.content_part.done", "response.output_item.done", "response.completed"]);
    expect(tail[3].delta).toBe("got: sunny");
    expect(requests(d, "session/new")).toHaveLength(1);
  });

  it("streams the message item with its text first, then the call at the next index", async () => {
    const d = dirs();
    Object.assign(process.env, { FAKE_ACP_MCP: "codex" });
    const base = await start(d, [codex(d)]);
    const first = await send(base, "/v1/responses", { model: CODEX_MODEL, input: "weather in Paris?", stream: true, tools: responsesTools });
    const events = sse(first.raw);
    expect(events.map((event) => event.type)).toEqual(["response.created", "response.output_item.added", "response.content_part.added", "response.output_text.delta", "response.output_text.done", "response.content_part.done", "response.output_item.done", "response.output_item.added", "response.function_call_arguments.delta", "response.function_call_arguments.done", "response.output_item.done", "response.completed"]);
    expect(events[7].output_index).toBe(1);
    expect(events[11].response.output.map((item: any) => item.type)).toEqual(["message", "function_call"]);
  });
});

describe("resume and fallback", () => {
  it("starts a fresh session with the whole history as text when the ids are unknown", async () => {
    const d = dirs();
    Object.assign(process.env, { FAKE_ACP_AGY: "1" });
    const base = await start(d, [agy(d)]);
    const messages = [question, { role: "assistant", content: null, tool_calls: [{ id: "call_unknown", type: "function", function: { name: "get_weather", arguments: "{\"city\":\"Paris\"}" } }] }, { role: "tool", tool_call_id: "call_unknown", content: "18 C" }];
    const result = await send(base, "/v1/chat/completions", chat(AGY_MODEL, { messages }));
    expect(result.body.choices[0].message.content).toBe("fake response");
    const text = promptTexts(d)[0]!;
    expect(text).toContain("[user]\nWhat is the weather in Paris and what is 1 + 2?\n\n[assistant]\n[tool call call_unknown] get_weather {\"city\":\"Paris\"}\n\n[tool result call_unknown]\n18 C");
    expect(requests(d, "session/new")).toHaveLength(1);
  });

  it("does not resume when a result is missing, the history was edited, or the tools changed", async () => {
    const d = dirs();
    Object.assign(process.env, { FAKE_ACP_MCP: "codex" });
    const base = await start(d, [codex(d)]);
    const first = await send(base, "/v1/chat/completions", chat(CODEX_MODEL));
    const good = chatFollowUp(first.body, ["18 C"]);
    // edited first message
    const edited = await send(base, "/v1/chat/completions", chat(CODEX_MODEL, { messages: [{ role: "user", content: "something else" }, ...good.slice(1)] }));
    expect(edited.body.choices[0].finish_reason).toBe("tool_calls");
    expect(requests(d, "session/new")).toHaveLength(2);
    // other tools
    const retooled = await send(base, "/v1/chat/completions", chat(CODEX_MODEL, { messages: good, tools: chatTools.slice(0, 1) }));
    expect(retooled.body.choices[0].finish_reason).toBe("tool_calls");
    expect(requests(d, "session/new")).toHaveLength(3);
    // the original is still waiting and resumes fine
    const resumed = await send(base, "/v1/chat/completions", chat(CODEX_MODEL, { messages: good }));
    expect(resumed.body.choices[0].message.content).toBe("got: 18 C");
    expect(requests(d, "session/new")).toHaveLength(3);
  });

  it("with tool_choice none gives the agent no bridge and sends the tool history as text", async () => {
    const d = dirs();
    Object.assign(process.env, { FAKE_ACP_MCP: "codex" });
    const base = await start(d, [codex(d)]);
    const messages = [question, { role: "assistant", content: "ok", tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: "{}" } }] }, { role: "tool", tool_call_id: "call_1", content: "18 C" }];
    const result = await send(base, "/v1/chat/completions", chat(CODEX_MODEL, { messages, tool_choice: "none" }));
    expect(result.status).toBe(200);
    expect(requests(d, "session/new")[0].mcpServers).toEqual([]);
    expect(mcpLog(d)).toEqual([]);
    const text = promptTexts(d)[0]!;
    expect(text).toContain("[assistant]\nok\n[tool call call_1] get_weather {}");
    expect(text).toContain("[tool result call_1]\n18 C");
    expect(text).toContain("This is a text-only API request.");
    expect(result.body.choices[0].message.content).toBe("no mcp server");
  });

  it("adds an instruction line for tool_choice required and for a named function", async () => {
    const d = dirs();
    Object.assign(process.env, { FAKE_ACP_AGY: "1" });
    const base = await start(d, [agy(d)]);
    await send(base, "/v1/chat/completions", chat(AGY_MODEL, { tool_choice: "required" }));
    await send(base, "/v1/chat/completions", chat(AGY_MODEL, { tool_choice: { type: "function", function: { name: "add" } } }));
    const [required, named] = promptTexts(d);
    expect(required).toContain("You must call one of the client tools before you answer.");
    expect(named).toContain("You must call the client tool \"add\" before you answer.");
  });
});

describe("timeouts", () => {
  it("gives up a suspended turn at the smaller of the setting and the agent's limit, then falls back to text", async () => {
    const d = dirs();
    Object.assign(process.env, { FAKE_ACP_AGY: "1", FAKE_ACP_MCP: "agy" });
    const base = await start(d, [agy(d, { toolCallMarginMs: 0, toolResultTimeoutMs: 600_000 }, { toolCallLimitMs: 400 })]);
    const first = await send(base, "/v1/chat/completions", chat(AGY_MODEL));
    expect(first.body.choices[0].finish_reason).toBe("tool_calls");
    await until(() => requests(d, "session/cancel").length > 0);
    // the held call got an error result, the turn was cancelled and the session deleted
    await until(() => mcpLog(d, "tools/call").length > 0);
    expect(mcpLog(d, "tools/call")[0]).toMatchObject({ isError: true, text: "The client did not return the tool result in time." });
    await until(() => requests(d, "session/delete").length > 0);
    const late = await send(base, "/v1/chat/completions", chat(AGY_MODEL, { messages: chatFollowUp(first.body, ["18 C"]) }));
    expect(late.status).toBe(200);
    expect(requests(d, "session/new")).toHaveLength(2);
    expect(promptTexts(d)[1]).toContain("[tool result " + first.body.choices[0].message.tool_calls[0].id + "]\n18 C");
  });

  it("uses the configured setting when it is the smaller one (Claude has no limit of its own)", async () => {
    const d = dirs();
    Object.assign(process.env, { FAKE_ACP_CLAUDE: "1", FAKE_ACP_MCP: "claude", FAKE_ACP_MCP_CALLS: JSON.stringify([[{ name: "get_weather", arguments: { city: "Paris" } }]]) });
    const base = await start(d, [claude(d, { toolResultTimeoutMs: 250 })]);
    const first = await send(base, "/v1/chat/completions", chat(CLAUDE_MODEL));
    expect(first.body.choices[0].finish_reason).toBe("tool_calls");
    await until(() => requests(d, "session/cancel").length > 0);
    const late = await send(base, "/v1/chat/completions", chat(CLAUDE_MODEL, { messages: chatFollowUp(first.body, ["18 C"]) }));
    expect(requests(d, "session/new")).toHaveLength(2);
    expect(late.body.choices[0].finish_reason).toBe("tool_calls");
  });

  it("keeps the agents' own limits in the descriptors", () => {
    expect(codexDescriptor({ acpArgs: [] }).toolCallLimitMs).toBe(300_000);
    expect(antigravityDescriptor(defaultRuntimeContext(), { env: {}, settings: {} }).toolCallLimitMs).toBe(180_000);
    expect(claudeDescriptor({}, {}).toolCallLimitMs).toBeUndefined();
  });

  it("sets the Claude idle timeout env so a held call is not cut at 300 s", async () => {
    const spec = await claudeDescriptor({}, {}).launch(defaultRuntimeContext({ resolveUnpacked: (file) => file }));
    expect(spec.env).toMatchObject({ CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT: "0" });
  });

  it("counts suspended turns against the retained-session cap", async () => {
    const d = dirs();
    Object.assign(process.env, { FAKE_ACP_MCP: "codex" });
    const base = await start(d, [codex(d, { retainedSessions: 1 })]);
    const a = await send(base, "/v1/chat/completions", chat(CODEX_MODEL, { messages: [{ role: "user", content: "A" }] }));
    expect(a.body.choices[0].finish_reason).toBe("tool_calls");
    const b = await send(base, "/v1/chat/completions", chat(CODEX_MODEL, { messages: [{ role: "user", content: "B" }] }));
    expect(b.body.choices[0].finish_reason).toBe("tool_calls");
    // A was given up to make room: its held call failed and its session was cancelled.
    await until(() => mcpLog(d, "tools/call").length > 0);
    expect(mcpLog(d, "tools/call")[0]).toMatchObject({ isError: true });
    expect(requests(d, "session/cancel")).toHaveLength(1);
    const aFollowUp = await send(base, "/v1/chat/completions", chat(CODEX_MODEL, { messages: chatFollowUp(a.body, ["x"], [{ role: "user", content: "A" }]) }));
    expect(aFollowUp.body.choices[0].finish_reason).toBe("tool_calls");
    expect(requests(d, "session/new")).toHaveLength(3);
  });
});

describe("session reuse", () => {
  it("keeps the session after a normal end of a tool conversation and continues it with the new message only", async () => {
    const d = dirs();
    Object.assign(process.env, { FAKE_ACP_MCP: "codex", FAKE_ACP_MCP_ONCE: "1" });
    const base = await start(d, [codex(d, { reuseSessions: true })]);
    const first = await send(base, "/v1/chat/completions", chat(CODEX_MODEL));
    const history = chatFollowUp(first.body, ["18 C"]);
    const second = await send(base, "/v1/chat/completions", chat(CODEX_MODEL, { messages: history }));
    const answer = second.body.choices[0].message.content;
    expect(answer).toBe("got: 18 C");
    const third = await send(base, "/v1/chat/completions", chat(CODEX_MODEL, { messages: [...history, { role: "assistant", content: answer }, { role: "user", content: "thanks" }] }));
    expect(third.body.choices[0].message.content).toBe("again");
    expect(requests(d, "session/new")).toHaveLength(1);
    expect(requests(d, "session/prompt")).toHaveLength(2);
    expect(promptTexts(d)[1]).toContain("[user]\nthanks");
    expect(promptTexts(d)[1]).not.toContain("tool result");
  });

  it("does not hand a kept tool session to a request without tools, or a plain session to one with tools", async () => {
    const d = dirs();
    Object.assign(process.env, { FAKE_ACP_MCP: "codex", FAKE_ACP_MCP_ONCE: "1" });
    const base = await start(d, [codex(d, { reuseSessions: true })]);
    const first = await send(base, "/v1/chat/completions", chat(CODEX_MODEL));
    const history = chatFollowUp(first.body, ["18 C"]);
    const second = await send(base, "/v1/chat/completions", chat(CODEX_MODEL, { messages: history }));
    const next = [...history, { role: "assistant", content: second.body.choices[0].message.content }, { role: "user", content: "thanks" }];
    const plain = await send(base, "/v1/chat/completions", { model: CODEX_MODEL, messages: next });
    expect(plain.status).toBe(200);
    expect(requests(d, "session/new")).toHaveLength(2);
    expect(requests(d, "session/new")[1].mcpServers).toEqual([]);
  });
});

describe("permissions", () => {
  it("Codex: allows only an approval whose tracked call belongs to the client server", async () => {
    const d = dirs();
    Object.assign(process.env, { FAKE_ACP_MCP: "codex", FAKE_ACP_MCP_STRAY: "1" });
    const base = await start(d, [codex(d)]);
    const result = await send(base, "/v1/chat/completions", chat(CODEX_MODEL));
    expect(result.body.choices[0].finish_reason).toBe("tool_calls");
    // an id the agent never reported, a call of another server, then the real one
    expect(permissionAnswers(d)).toEqual([{ outcome: "cancelled" }, { outcome: "cancelled" }, { outcome: "selected", optionId: "allow_once" }]);
    expect(mcpLog(d, "stray").map((entry) => entry.allowed)).toEqual([false, false]);
  });

  it("Antigravity: allows only the client server's tool and never allow_always", async () => {
    const d = dirs();
    Object.assign(process.env, { FAKE_ACP_AGY: "1", FAKE_ACP_MCP: "agy", FAKE_ACP_MCP_STRAY: "1" });
    const base = await start(d, [agy(d)]);
    const result = await send(base, "/v1/chat/completions", chat(AGY_MODEL));
    expect(result.body.choices[0].finish_reason).toBe("tool_calls");
    expect(permissionAnswers(d)).toEqual([{ outcome: "cancelled" }, { outcome: "selected", optionId: "allow" }]);
  });

  it("a request without tools still cancels every permission", async () => {
    const d = dirs();
    Object.assign(process.env, { FAKE_ACP_AGY: "1", FAKE_ACP_REQUIRE_PERMISSION: "1" });
    const base = await start(d, [agy(d)]);
    const result = await send(base, "/v1/chat/completions", { model: AGY_MODEL, messages: [question] });
    expect(result.status).toBe(200);
    expect(permissionAnswers(d)).toEqual([{ outcome: "cancelled" }]);
  });
});

describe("requests without tools", () => {
  it("build the same prompt, session and answer as before", async () => {
    const d = dirs();
    Object.assign(process.env, { FAKE_ACP_MCP: "codex" });
    const base = await start(d, [codex(d)]);
    const result = await send(base, "/v1/chat/completions", { model: CODEX_MODEL, messages: [{ role: "user", content: "hi" }] });
    expect(result.body.choices[0]).toMatchObject({ finish_reason: "stop", message: { content: "no mcp server" } });
    expect(requests(d, "session/new")[0].mcpServers).toEqual([]);
    expect(promptTexts(d)[0]).toBe("This is a text-only API request. Do not use tools, run commands, access files, or ask for permissions. Respond with the answer only.\n\n[user]\nhi");
  });

  it("do not use the warm session for a tools request, and do use it afterwards", async () => {
    const d = dirs();
    Object.assign(process.env, { FAKE_ACP_MCP: "codex" });
    const base = await start(d, [codex(d, {}, { warmSessions: 1 })]);
    const plain = { model: CODEX_MODEL, messages: [{ role: "user", content: "hi" }] };
    // The first plain request makes its own session and then refills the warm pool.
    expect((await send(base, "/v1/chat/completions", plain)).status).toBe(200);
    await until(() => requests(d, "session/new").length >= 2);
    await wait(100);
    const tools = await send(base, "/v1/chat/completions", chat(CODEX_MODEL));
    expect(tools.body.choices[0].finish_reason).toBe("tool_calls");
    expect((await send(base, "/v1/chat/completions", plain)).status).toBe(200);
    const created = requests(d, "session/new");
    expect(created.map((params) => params.mcpServers.length)).toEqual([0, 0, 1, 0]);
    // plain: the first session; tools: a new one (the third); plain again: the warm one (the second)
    expect(requests(d, "session/prompt").map((params) => params.sessionId)).toEqual(["fake-session", "fake-session-3", "fake-session-2"]);
  });
});

describe("the tool bridge endpoint", () => {
  async function bridgeServer(d: Dirs) {
    const base = await start(d, []);
    const session = d.hub.create([{ name: "echo", description: "Echoes", inputSchema: { type: "object", properties: { q: { type: "string" } } } }]);
    const url = session.url.replace(/^http:\/\/[^/]+/, base);
    const post = (body: unknown, target = url) => fetch(target, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify(body) });
    return { base, session, url, post };
  }

  it("answers initialize, ping and tools/list as JSON and marks the tools read-only, without an API key", async () => {
    const d = dirs();
    const { post, session } = await bridgeServer(d);
    const init = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {} } });
    expect(init.status).toBe(200);
    expect(init.headers.get("content-type")).toContain("application/json");
    expect(await init.json()).toMatchObject({ id: 1, result: { protocolVersion: "2025-11-25", capabilities: { tools: {} } } });
    expect(await (await post({ jsonrpc: "2.0", id: 2, method: "ping" })).json()).toMatchObject({ id: 2, result: {} });
    const list = await (await post({ jsonrpc: "2.0", id: 3, method: "tools/list" })).json();
    expect(list.result.tools).toEqual([{ name: "echo", description: "Echoes", inputSchema: { type: "object", properties: { q: { type: "string" } } }, annotations: { readOnlyHint: true } }]);
    expect(session.url).toMatch(/\/mcp\/[A-Za-z0-9_-]{43}$/);
  });

  it("answers unknown methods with -32601, notifications with 202, GET with 405 and DELETE with 200", async () => {
    const d = dirs();
    const { post, url } = await bridgeServer(d);
    expect(await (await post({ jsonrpc: "2.0", id: 1, method: "server/discover", params: {} })).json()).toMatchObject({ id: 1, error: { code: -32601 } });
    expect((await post({ jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
    expect((await fetch(url, { method: "GET" })).status).toBe(405);
    expect((await fetch(url, { method: "DELETE" })).status).toBe(200);
    expect((await post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "nope", arguments: {} } })).status).toBe(200);
  });

  it("answers an unknown token with 404", async () => {
    const d = dirs();
    const { base, post } = await bridgeServer(d);
    expect((await post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, `${base}/mcp/not-a-token`)).status).toBe(404);
    expect((await fetch(`${base}/mcp/not-a-token`, { method: "GET" })).status).toBe(404);
    expect((await fetch(`${base}/mcp/`, { method: "POST", body: "{}" })).status).toBe(404);
  });

  it("answers tools/call as SSE: a keepalive at once, more while it waits, then one message event", async () => {
    const d = dirs(25);
    const { post, session } = await bridgeServer(d);
    const calls: Array<{ id: string; arguments: string }> = [];
    session.onCall = (call) => calls.push(call);
    const response = await post({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "echo", arguments: { q: "hi" } } });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toBe(": keepalive\n\n");
    await until(() => calls.length === 1);
    expect(calls[0]).toMatchObject({ arguments: JSON.stringify({ q: "hi" }), id: expect.stringMatching(/^call_/) });
    await wait(120);
    session.openCalls()[0]!.settle("echo: hi");
    let rest = "";
    for (;;) { const { done, value } = await reader.read(); if (done) break; rest += new TextDecoder().decode(value); }
    expect((rest.match(/: keepalive/g) ?? []).length).toBeGreaterThanOrEqual(2);
    const event = rest.split("\n\n").find((block) => block.startsWith("event: message"))!;
    expect(JSON.parse(event.split("\n")[1]!.slice(6))).toEqual({ jsonrpc: "2.0", id: 7, result: { content: [{ type: "text", text: "echo: hi" }] } });
  });

  it("keeps its state across new connections and initializes (a reconnecting agent finds the same tools)", async () => {
    const d = dirs();
    const { post } = await bridgeServer(d);
    for (let attempt = 0; attempt < 2; attempt++) {
      await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } });
      const list = await (await post({ jsonrpc: "2.0", id: 2, method: "tools/list" })).json();
      expect(list.result.tools.map((tool: any) => tool.name)).toEqual(["echo"]);
    }
  });

  it("answers a call with an error when no request is waiting for it", async () => {
    const d = dirs();
    const { post } = await bridgeServer(d);
    const response = await post({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "echo", arguments: {} } });
    const raw = await response.text();
    expect(raw).toContain("\"isError\":true");
  });

  it("always gives the agents a loopback address, whatever the proxy binds", () => {
    const hub = new ToolBridgeHub();
    expect(hub.ready).toBe(false);
    expect(() => hub.create([])).toThrow(/not listening/);
    for (const [address, host] of [["0.0.0.0", "127.0.0.1"], ["::", "127.0.0.1"], ["127.0.0.1", "127.0.0.1"], ["::1", "[::1]"]] as const) {
      hub.setAddress(address, 4321);
      expect(hub.create([]).url.startsWith(`http://${host}:4321/mcp/`)).toBe(true);
    }
  });

  it("is reachable at the port the controller really listens on (port 0)", async () => {
    const dir = path.join(root, `controller-${++counter}`);
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "settings.json");
    writeFileSync(file, JSON.stringify({ version: 1, server: { host: "127.0.0.1", port: 0, workRoot: path.join(dir, "work") }, providers: { codex: { acpCommand: process.execPath, acpArgs: [fixture] } } }));
    process.env.FAKE_ACP_MCP = "codex";
    process.env.FAKE_ACP_LOG = path.join(dir, "requests.log");
    const controller = new ProxyController({ settingsPath: file, env: {}, logger: createLogger({ console: false }) });
    controllers.push(controller);
    const status = await controller.start();
    expect(status.server.state).toBe("running");
    const body = { model: "gpt-5.6-sol", messages: [question], tools: chatTools };
    const result = await send(status.server.baseUrl!, "/chat/completions", body, {});
    expect(result.body.choices[0].finish_reason).toBe("tool_calls");
    const created = readFileSync(process.env.FAKE_ACP_LOG, "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((entry) => entry.method === "session/new");
    expect(created[0].params.mcpServers[0].url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${status.server.port}/mcp/`));
  });
});

describe("request parsing", () => {
  const base = { model: "gpt-5.6-sol" };
  const user = { role: "user", content: "hi" };

  it("accepts chat tools, tool_choice, parallel_tool_calls, assistant tool calls with null content and tool messages", async () => {
    const parsed = await normalizeChat({ ...base, messages: [user, { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: "{\"city\":\"Paris\"}" } }] }, { role: "tool", tool_call_id: "call_1", content: [{ type: "text", text: "18 C" }] }], tools: chatTools, tool_choice: { type: "function", function: { name: "add" } }, parallel_tool_calls: false });
    expect(parsed.functionTools).toEqual([{ name: "get_weather", description: "Weather of a city", parameters: weatherParameters }, { name: "add", description: "Adds two numbers", parameters: addParameters }]);
    expect(parsed.toolChoice).toEqual({ name: "add" });
    expect(parsed.parallelToolCalls).toBe(false);
    expect(parsed.conversation[1]).toEqual({ role: "assistant", parts: [], toolCalls: [{ id: "call_1", name: "get_weather", arguments: "{\"city\":\"Paris\"}" }] });
    expect(parsed.conversation[2]).toEqual({ role: "tool", toolCallId: "call_1", parts: [{ type: "text", text: "18 C" }] });
  });

  it("drops the tools for tool_choice none and treats auto as the default", async () => {
    expect((await normalizeChat({ ...base, messages: [user], tools: chatTools, tool_choice: "none" })).functionTools).toBeUndefined();
    const auto = await normalizeChat({ ...base, messages: [user], tools: chatTools });
    expect(auto.toolChoice).toBe("auto");
    expect(auto.parallelToolCalls).toBeUndefined();
  });

  it("rejects what it cannot do, with the parameter named", async () => {
    const rejects = async (body: Record<string, unknown>, code: string, param: string) => await expect(normalizeChat({ ...base, messages: [user], ...body })).rejects.toMatchObject({ status: 400, code, param });
    await rejects({ tools: [{ type: "web_search" }] }, "unsupported_parameter", "tools");
    await rejects({ tools: [] }, "unsupported_parameter", "tools");
    await rejects({ tools: [chatTools[0], chatTools[0]] }, "invalid_request", "tools");
    await rejects({ tools: [{ type: "function", function: { name: "bad name" } }] }, "invalid_request", "tools");
    await rejects({ tool_choice: "auto" }, "unsupported_parameter", "tool_choice");
    await rejects({ tools: chatTools, tool_choice: { type: "function", function: { name: "missing" } } }, "invalid_request", "tool_choice");
    await rejects({ tools: chatTools, tool_choice: "sometimes" }, "unsupported_parameter", "tool_choice");
    await rejects({ tools: chatTools, modalities: ["text", "image"] }, "unsupported_parameter", "tools");
    await rejects({ functions: [{ name: "f" }] }, "unsupported_parameter", "functions");
    await expect(normalizeChat({ ...base, messages: [{ role: "tool", content: "x" }] })).rejects.toMatchObject({ code: "invalid_request", param: "messages" });
    await expect(normalizeChat({ ...base, messages: [{ role: "assistant", content: null }] })).rejects.toMatchObject({ code: "invalid_request", param: "messages" });
    await expect(normalizeChat({ ...base, messages: [{ role: "user", content: "x", tool_calls: [] }] })).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("accepts Responses function tools, function_call and function_call_output items and our own echoed message items", async () => {
    const parsed = await normalizeResponses({ ...base, input: [
      { role: "user", content: "hi" },
      { id: "msg-1", type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: "Let me check. ", annotations: [] }] },
      { id: "fc-1", type: "function_call", status: "completed", call_id: "call_1", name: "get_weather", arguments: "{}" },
      { type: "function_call", call_id: "call_2", name: "add", arguments: "{}" },
      { type: "function_call_output", call_id: "call_1", output: "18 C" },
      { type: "function_call_output", call_id: "call_2", output: [{ type: "input_text", text: "3" }] },
    ], tools: responsesTools, tool_choice: "required", parallel_tool_calls: true });
    expect(parsed.conversation).toEqual([
      { role: "user", parts: [{ type: "text", text: "hi" }] },
      { role: "assistant", parts: [{ type: "text", text: "Let me check. " }], toolCalls: [{ id: "call_1", name: "get_weather", arguments: "{}" }, { id: "call_2", name: "add", arguments: "{}" }] },
      { role: "tool", toolCallId: "call_1", parts: [{ type: "text", text: "18 C" }] },
      { role: "tool", toolCallId: "call_2", parts: [{ type: "text", text: "3" }] },
    ]);
    expect(parsed.toolChoice).toBe("required");
    expect(parsed.parallelToolCalls).toBe(true);
    expect((await normalizeResponses({ ...base, input: [{ type: "function_call", call_id: "c", name: "f", arguments: "{}" }], tools: responsesTools })).conversation).toEqual([{ role: "assistant", parts: [], toolCalls: [{ id: "c", name: "f", arguments: "{}" }] }]);
  });

  it("rejects Responses tool combinations it cannot do", async () => {
    const rejects = async (body: Record<string, unknown>, param: string) => await expect(normalizeResponses({ ...base, input: "x", ...body })).rejects.toMatchObject({ status: 400, code: "unsupported_parameter", param });
    await rejects({ tools: [{ type: "image_generation" }, responsesTools[0]] }, "tools");
    await rejects({ tools: [{ type: "file_search" }] }, "tools");
    await rejects({ tool_choice: "auto" }, "tool_choice");
    await rejects({ parallel_tool_calls: true }, "parallel_tool_calls");
    await rejects({ tools: responsesTools, tool_choice: { type: "image_generation" } }, "tool_choice");
  });

  it("serializes tool calls and results for the text fallback, and leaves other messages byte for byte", () => {
    const messages = [textMessage("user", "hi"), { role: "assistant" as const, parts: [{ type: "text" as const, text: "Checking" }], toolCalls: [{ id: "call_1", name: "get_weather", arguments: "{\"city\":\"Paris\"}" }] }, { role: "tool" as const, toolCallId: "call_1", parts: [{ type: "text" as const, text: "18 C" }] }];
    const [block] = buildPrompt(messages);
    expect((block as { text: string }).text.split("\n\n").slice(1)).toEqual(["[user]\nhi", "[assistant]\nChecking\n[tool call call_1] get_weather {\"city\":\"Paris\"}", "[tool result call_1]\n18 C"]);
    expect(buildPrompt([textMessage("user", "hi")], undefined, undefined, false, { choice: "auto" })).toEqual([{ type: "text", text: expect.stringContaining("MCP server named \"client\"") }]);
  });
});

describe("providers that cannot take tools", () => {
  it("answer 400 model_not_capable before streaming starts", async () => {
    const d = dirs();
    const base = await start(d, [noTools(d)]);
    for (const stream of [false, true]) {
      const result = await send(base, "/v1/chat/completions", chat("claude/haiku", { stream }));
      expect(result.status).toBe(400);
      expect(result.body.error).toMatchObject({ code: "model_not_capable", param: "model" });
    }
    const responses = await send(base, "/v1/responses", { model: "claude/haiku", input: "x", tools: responsesTools, stream: true });
    expect(responses.status).toBe(400);
    expect(responses.body.error.code).toBe("model_not_capable");
  });
});
