import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { AcpProvider, type AcpProviderOptions } from "../src/acp-provider.js";
import { normalizeChat, normalizeResponses } from "../src/api.js";
import type { ProxyConfig } from "../src/config.js";
import { resolveMcpServers } from "../src/mcp-servers.js";
import { defaultRuntimeContext, type McpAccess, type ProviderDescriptor } from "../src/provider.js";
import { antigravityDescriptor } from "../src/providers/antigravity.js";
import { claudeDescriptor } from "../src/providers/claude.js";
import { codexDescriptor } from "../src/providers/codex.js";
import { ProviderRouter } from "../src/router.js";
import { createProxyServer } from "../src/server.js";
import { defaultSettings, resolveConfig, settingsSchema } from "../src/settings.js";
import { ToolBridgeHub } from "../src/tool-bridge.js";

// Every Antigravity provider start runs the Windows orphan sweep, which is slow.
vi.setConfig({ testTimeout: 30_000 });

const fixture = fileURLToPath(new URL("./fixtures/fake-acp.mjs", import.meta.url));
const root = path.resolve(".claude/temp/mcp-servers-tests", String(process.pid));

let counter = 0;
const servers: Server[] = [];
const providers: AcpProvider[] = [];
interface Dirs { base: string; dataDir: string; workRoot: string; log: string; hub: ToolBridgeHub }

function dirs(): Dirs {
  const base = path.join(root, `t${++counter}`);
  const d: Dirs = { base, dataDir: path.join(base, "data"), workRoot: path.join(base, "work"), log: path.join(base, "requests.log"), hub: new ToolBridgeHub({ keepaliveMs: 30 }) };
  const agentDir = path.join(d.dataDir, "agents", "antigravity-acp");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(path.join(agentDir, "install.json"), JSON.stringify({ version: "1.0.0", url: "x", sha256: "x", command: process.execPath, args: [fixture], dir: agentDir, installedAt: new Date().toISOString() }));
  process.env.FAKE_ACP_LOG = d.log;
  return d;
}
const ctxFor = (d: Dirs) => defaultRuntimeContext({ dataDir: d.dataDir, toolBridge: d.hub });
const opts = (d: Dirs, extra: Partial<AcpProviderOptions> = {}): AcpProviderOptions => ({ workRoot: d.workRoot, toolBatchMs: 40, ...extra });
function agy(d: Dirs, extra: Partial<AcpProviderOptions> = {}): AcpProvider {
  const ctx = ctxFor(d);
  const provider = new AcpProvider(antigravityDescriptor(ctx, { env: {}, settings: { termsAcknowledgedAt: "2026-01-01T00:00:00Z", geminiHome: path.join(d.base, "gemini") }, overrides: { warmSessions: 0 } }), ctx, opts(d, extra));
  providers.push(provider);
  return provider;
}
function codex(d: Dirs, extra: Partial<AcpProviderOptions> = {}): AcpProvider {
  const provider = new AcpProvider(codexDescriptor({ acpCommand: process.execPath, acpArgs: [fixture] }, { isolatedHome: true }), ctxFor(d), opts(d, extra));
  providers.push(provider);
  return provider;
}
function claude(d: Dirs, extra: Partial<AcpProviderOptions> = {}): AcpProvider {
  const descriptor = claudeDescriptor({ termsAcknowledgedAt: "2026-01-01T00:00:00Z", configDir: path.join(d.base, "claude") }, {}, { warmSessions: 0, launch: () => ({ command: process.execPath, args: [fixture], env: { ...process.env } }) });
  const provider = new AcpProvider(descriptor, ctxFor(d), opts(d, extra));
  providers.push(provider);
  return provider;
}
/** A provider that cannot be given tools or MCP servers (no permission rule). */
function plain(d: Dirs): AcpProvider {
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
async function send(base: string, route: string, body: unknown): Promise<{ status: number; body: any; raw: string }> {
  const response = await fetch(`${base}${route}`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer secret" }, body: JSON.stringify(body) });
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

/** A tiny remote MCP server (Streamable HTTP, plain JSON replies, one `echo` tool) that records what it was sent. */
interface RemoteMcp { url: string; seen: Array<{ method: string; headers: Record<string, string | string[] | undefined>; params: any }>; calls(): Array<{ name: string; arguments: any; headers: Record<string, string | string[] | undefined> }> }
async function remoteMcp(): Promise<RemoteMcp> {
  const seen: RemoteMcp["seen"] = [];
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      if (request.method !== "POST") { response.writeHead(405).end(); return; }
      const body = JSON.parse(raw);
      seen.push({ method: body.method, headers: request.headers, params: body.params });
      if (body.id === undefined) { response.writeHead(202).end(); return; }
      const reply = (result: unknown) => response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
      if (body.method === "initialize") reply({ protocolVersion: body.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "remote", version: "1" } });
      else if (body.method === "tools/list") reply({ tools: [{ name: "echo", inputSchema: { type: "object" } }, { name: "secret", inputSchema: { type: "object" } }] });
      else if (body.method === "tools/call") reply({ content: [{ type: "text", text: `${body.params.name}: ${body.params.arguments?.q ?? ""}` }] });
      else response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "nope" } }));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, seen, calls: () => seen.filter((entry) => entry.method === "tools/call").map((entry) => ({ name: entry.params.name, arguments: entry.params.arguments, headers: entry.headers })) };
}

const AGY_MODEL = "antigravity/gemini-3.8-flash-low";
const CODEX_MODEL = "codex/gpt-5.6-sol";
const CLAUDE_MODEL = "claude/haiku";
const never = "never";
const mcpTool = (extra: Record<string, unknown> = {}) => ({ type: "mcp", server_label: "docs", require_approval: never, ...extra });
const ask = (model: string, tools: unknown[], extra: Record<string, unknown> = {}) => ({ model, input: "Use the echo tool.", tools, ...extra });

beforeEach(() => { mkdirSync(root, { recursive: true }); });
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); })));
  await Promise.all(providers.splice(0).map((provider) => provider.close()));
  for (const key of Object.keys(process.env)) if (key.startsWith("FAKE_ACP_")) delete process.env[key];
});

describe("remote servers reach session/new", () => {
  it("passes a URL from the request with its headers, and the Claude allowedTools (Claude)", async () => {
    const d = dirs();
    const remote = await remoteMcp();
    Object.assign(process.env, { FAKE_ACP_CLAUDE: "1", FAKE_ACP_REMOTE: "claude" });
    const base = await start(d, [claude(d)]);
    const reply = await send(base, "/v1/responses", ask(CLAUDE_MODEL, [mcpTool({ server_url: remote.url, headers: { Authorization: "Bearer xyz", "X-Team": "a" }, server_description: "Docs" })]));
    expect(reply.status).toBe(200);
    const created = requests(d, "session/new");
    expect(created).toHaveLength(1);
    expect(created[0].mcpServers).toEqual([{ type: "http", name: "docs", url: remote.url, headers: [{ name: "Authorization", value: "Bearer xyz" }, { name: "X-Team", value: "a" }] }]);
    // No bridge in a session without function tools, and Claude is told which tools need no permission.
    expect(created[0]._meta.claudeCode.options.allowedTools).toEqual(["mcp__docs__*"]);
    expect(created[0]._meta.claudeCode.options.tools).toEqual([]);
    expect(permissionAnswers(d)).toEqual([]);
    const call = remote.calls();
    expect(call).toHaveLength(1);
    expect(call[0]).toMatchObject({ name: "echo", arguments: { q: "hi" } });
    expect(call[0]!.headers.authorization).toBe("Bearer xyz");
    expect(call[0]!.headers["x-team"]).toBe("a");
    expect(reply.body.output.map((item: any) => item.type)).toEqual(["mcp_call", "message"]);
    expect(reply.body.output[0]).toEqual({ id: expect.stringMatching(/^mcp-/), type: "mcp_call", server_label: "docs", name: "echo", arguments: JSON.stringify({ q: "hi" }), output: "echo: hi", error: null, status: "completed" });
    expect(reply.body.output[1].content[0].text).toBe("Let me check. got: echo: hi");
    const text = promptTexts(d)[0]!;
    expect(text).toContain("MCP server named \"docs\"");
    expect(text).not.toContain("\"client\"");
  });

  it("takes a label from the settings without a server_url, and its configured headers (Antigravity)", async () => {
    const d = dirs();
    const remote = await remoteMcp();
    Object.assign(process.env, { FAKE_ACP_AGY: "1", FAKE_ACP_REMOTE: "agy" });
    const base = await start(d, [agy(d)], { mcpServers: { docs: { url: remote.url, headers: { "X-Api-Key": "k1" } } } });
    const reply = await send(base, "/v1/responses", ask(AGY_MODEL, [mcpTool()]));
    expect(reply.status).toBe(200);
    expect(requests(d, "session/new")[0].mcpServers).toEqual([{ type: "http", name: "docs", url: remote.url, headers: [{ name: "X-Api-Key", value: "k1" }] }]);
    expect(remote.calls()[0]!.headers["x-api-key"]).toBe("k1");
    expect(permissionAnswers(d)).toEqual([{ outcome: "selected", optionId: "allow" }]);
    // Antigravity's completed update carries only a placeholder, which is what the item reports.
    expect(reply.body.output[0]).toMatchObject({ type: "mcp_call", server_label: "docs", name: "echo", arguments: JSON.stringify({ q: "hi" }), output: "Call docs echo tool", error: null, status: "completed" });
    expect(reply.body.output[1].content[0].text).toBe("Let me check. got: echo: hi");
  });

  it("passes a stdio entry from the settings with args and env (Codex)", async () => {
    const d = dirs();
    const base = await start(d, [codex(d)], { mcpServers: { files: { command: "node", args: ["server.js", "--ro"], env: { TOKEN: "t1" } } } });
    const reply = await send(base, "/v1/responses", ask(CODEX_MODEL, [mcpTool({ server_label: "files" })]));
    expect(reply.status).toBe(200);
    expect(requests(d, "session/new")[0].mcpServers).toEqual([{ name: "files", command: "node", args: ["server.js", "--ro"], env: [{ name: "TOKEN", value: "t1" }] }]);
    // The agent made no call: no item.
    expect(reply.body.output.map((item: any) => item.type)).toEqual(["message"]);
  });

  it("passes an sse server from the settings as type sse to an agent that accepts it, and refuses it for Codex", async () => {
    const d = dirs();
    const base = await start(d, [claude(d), codex(d)], { mcpServers: { legacy: { url: "http://127.0.0.1:9/sse", transport: "sse" } } });
    Object.assign(process.env, { FAKE_ACP_CLAUDE: "1" });
    const ok = await send(base, "/v1/responses", ask(CLAUDE_MODEL, [mcpTool({ server_label: "legacy" })]));
    expect(ok.status).toBe(200);
    expect(requests(d, "session/new")[0].mcpServers).toEqual([{ type: "sse", name: "legacy", url: "http://127.0.0.1:9/sse", headers: [] }]);
    delete process.env.FAKE_ACP_CLAUDE;
    // Codex says it has no sse support at initialize.
    process.env.FAKE_ACP_MCP_CAPS = JSON.stringify({ http: true, sse: false });
    const refused = await send(base, "/v1/responses", ask(CODEX_MODEL, [mcpTool({ server_label: "legacy" })]));
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatchObject({ code: "unsupported_parameter", param: "tools" });
    expect(refused.body.error.message).toContain("SSE");
    // The same agent still takes an http server.
    const http = await send(base, "/v1/responses", ask(CODEX_MODEL, [mcpTool({ server_url: "http://127.0.0.1:9/mcp" })]));
    expect(http.status).toBe(200);
  });

  it("keeps a plain request as it was: no MCP servers, the text-only preamble, no output items", async () => {
    const d = dirs();
    Object.assign(process.env, { FAKE_ACP_CLAUDE: "1" });
    const base = await start(d, [claude(d)], { mcpServers: { docs: { url: "http://127.0.0.1:9/mcp" } } });
    const reply = await send(base, "/v1/responses", { model: CLAUDE_MODEL, input: "hello" });
    expect(reply.status).toBe(200);
    expect(reply.body.output.map((item: any) => item.type)).toEqual(["message"]);
    expect(requests(d, "session/new")[0].mcpServers).toEqual([]);
    expect(requests(d, "session/new")[0]._meta.claudeCode.options).not.toHaveProperty("allowedTools");
    expect(promptTexts(d)[0]).toContain("This is a text-only API request.");
    const chat = await send(base, "/v1/chat/completions", { model: CLAUDE_MODEL, messages: [{ role: "user", content: "hello" }] });
    expect(chat.status).toBe(200);
  });

  it("never keeps or reuses a session that has remote servers", async () => {
    const d = dirs();
    const remote = await remoteMcp();
    Object.assign(process.env, { FAKE_ACP_AGY: "1", FAKE_ACP_REMOTE: "agy" });
    const base = await start(d, [agy(d, { reuseSessions: true })]);
    const tools = [mcpTool({ server_url: remote.url })];
    const first = await send(base, "/v1/responses", ask(AGY_MODEL, tools));
    const second = await send(base, "/v1/responses", { model: AGY_MODEL, tools, input: [{ role: "user", content: "Use the echo tool." }, { role: "assistant", content: "got: echo: hi" }, { role: "user", content: "again" }] });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(requests(d, "session/new")).toHaveLength(2);
    expect(requests(d, "session/delete").length).toBe(2);
  });
});

describe("what a request may ask for", () => {
  const model = CLAUDE_MODEL;
  async function expect400(body: unknown, code: string, message?: RegExp, config: Partial<ProxyConfig> = {}): Promise<void> {
    const d = dirs();
    Object.assign(process.env, { FAKE_ACP_CLAUDE: "1" });
    const base = await start(d, [claude(d)], config);
    const reply = await send(base, "/v1/responses", body);
    expect(reply.status, reply.raw).toBe(400);
    expect(reply.body.error.code).toBe(code);
    if (message) expect(reply.body.error.message).toMatch(message);
    expect(requests(d, "session/new")).toHaveLength(0);
  }
  const url = "http://127.0.0.1:9/mcp";

  it("rejects a stdio server in a request", async () => {
    await expect400(ask(model, [{ type: "mcp", server_label: "files", command: "node", args: ["x.js"], require_approval: never }]), "unsupported_parameter", /settings/);
  });

  it("rejects a missing or non-never approval, and accepts never and { never: { tool_names } }", async () => {
    await expect400(ask(model, [{ type: "mcp", server_label: "docs", server_url: url }]), "unsupported_parameter", /approval flow for MCP tools is not supported.*require_approval: "never"/);
    await expect400(ask(model, [mcpTool({ server_url: url, require_approval: "always" })]), "unsupported_parameter");
    await expect400(ask(model, [mcpTool({ server_url: url, require_approval: { always: { tool_names: ["echo"] } } })]), "unsupported_parameter");
    await expect400(ask(model, [mcpTool({ server_url: url, require_approval: { never: { tool_names: ["echo"] }, always: { tool_names: ["x"] } } })]), "unsupported_parameter");
    const parsed = await normalizeResponses(ask(model, [mcpTool({ server_url: url, require_approval: { never: { tool_names: ["echo", "echo", "ls"] } } })]), () => true);
    expect(parsed.mcpTools).toEqual([{ label: "docs", url, neverTools: ["echo", "ls"] }]);
    expect((await normalizeResponses(ask(model, [mcpTool({ server_url: url })]), () => true)).mcpTools).toEqual([{ label: "docs", url }]);
  });

  it("rejects the reserved label, a bad label and duplicate labels", async () => {
    await expect400(ask(model, [mcpTool({ server_label: "client", server_url: url })]), "invalid_request", /reserved/);
    await expect400(ask(model, [mcpTool({ server_label: "my docs", server_url: url })]), "invalid_request", /server_label/);
    await expect400(ask(model, [mcpTool({ server_url: url }), mcpTool({ server_url: url })]), "invalid_request", /unique/);
  });

  it("rejects a server_url that reuses a configured label, a label that is not configured and headers on a configured one", async () => {
    const config = { mcpServers: { docs: { url: "http://127.0.0.1:9/configured" }, files: { command: "node" } } };
    await expect400(ask(model, [mcpTool({ server_url: url })]), "invalid_request", /configured in the proxy's settings/, config);
    await expect400(ask(model, [mcpTool({ server_label: "nothing" })]), "invalid_request", /needs a server_url/, config);
    await expect400(ask(model, [mcpTool({ headers: { Authorization: "x" } })]), "invalid_request", /takes no headers/, config);
    // A stdio server of the settings is not an HTTP URL a request could point elsewhere either.
    await expect400(ask(model, [mcpTool({ server_label: "files", server_url: url })]), "invalid_request", /configured in the proxy's settings/, config);
  });

  it("rejects bad URLs, headers, filters and connectors", async () => {
    await expect400(ask(model, [mcpTool({ server_url: "file:///etc/passwd" })]), "unsupported_parameter", /http or https/);
    await expect400(ask(model, [mcpTool({ server_url: "not a url" })]), "invalid_request", /valid URL/);
    await expect400(ask(model, [mcpTool({ server_url: url, headers: { "X-A": "a\r\nInjected: 1" } })]), "invalid_request", /headers/);
    await expect400(ask(model, [mcpTool({ server_url: url, headers: { "bad name": "a" } })]), "invalid_request", /headers/);
    await expect400(ask(model, [mcpTool({ server_url: url, allowed_tools: [] })]), "invalid_request", /allowed_tools/);
    await expect400(ask(model, [mcpTool({ server_url: url, allowed_tools: ["a*"] })]), "invalid_request", /allowed_tools/);
    await expect400(ask(model, [mcpTool({ server_url: url, allowed_tools: ["a"], require_approval: { never: { tool_names: ["b"] } } })]), "invalid_request", /both/);
    await expect400(ask(model, [{ type: "mcp", server_label: "x", connector_id: "connector_gmail", require_approval: never }]), "unsupported_parameter", /connector/);
    await expect400(ask(model, [mcpTool({ server_url: url, authorization: "tok" })]), "unsupported_parameter", /authorization/);
  });

  it("rejects mcp tools with the image tool, in chat, and for a provider that cannot take them", async () => {
    await expect400(ask(model, [mcpTool({ server_url: url }), { type: "image_generation" }]), "unsupported_parameter", /image_generation/);
    const d = dirs();
    Object.assign(process.env, { FAKE_ACP_CLAUDE: "1" });
    const base = await start(d, [claude(d)]);
    const chat = await send(base, "/v1/chat/completions", { model, messages: [{ role: "user", content: "hi" }], tools: [mcpTool({ server_url: url })] });
    expect(chat.status).toBe(400);
    expect(chat.body.error.code).toBe("unsupported_parameter");
    const d2 = dirs();
    const base2 = await start(d2, [plain(d2)]);
    const incapable = await send(base2, "/v1/responses", ask(CLAUDE_MODEL, [mcpTool({ server_url: url })], { stream: true }));
    expect(incapable.status).toBe(400);
    expect(incapable.body.error.code).toBe("model_not_capable");
    expect(requests(d2, "session/new")).toHaveLength(0);
  });

  it("combines allowed_tools with the never list, and a tool_choice of none drops the servers", async () => {
    const parsed = await normalizeResponses({ model, input: "x", tools: [mcpTool({ server_url: url, allowed_tools: { tool_names: ["a", "b"] }, require_approval: { never: { tool_names: ["b", "c"] } } })] }, () => true);
    expect(resolveMcpServers(parsed.mcpTools!)[0]!.allowedTools).toEqual(["b"]);
    const none = await normalizeResponses({ model, input: "x", tool_choice: "none", tools: [{ type: "function", name: "f" }, mcpTool({ server_url: url })] }, () => true);
    expect(none.mcpTools).toBeUndefined();
    expect(none.functionTools).toBeUndefined();
    await expect(normalizeChat({ model, messages: [{ role: "user", content: "x" }], tools: [mcpTool({ server_url: url })] }, () => true)).rejects.toMatchObject({ status: 400, code: "unsupported_parameter" });
  });

  it("resolves a request against the settings", () => {
    const settings = { docs: { url: "https://docs.example/mcp", headers: { A: "1" } }, old: { url: "https://old.example/sse", transport: "sse" as const }, files: { command: "node", args: ["f.js"], env: { K: "v" } } };
    const specs = resolveMcpServers([{ label: "docs" }, { label: "old", neverTools: ["a"] }, { label: "files" }, { label: "web", url: "https://web.example/mcp", headers: { H: "v" }, allowedTools: ["x"] }], settings);
    expect(specs).toEqual([
      { label: "docs", transport: "http", url: "https://docs.example/mcp", headers: [{ name: "A", value: "1" }], args: [], env: [] },
      { label: "old", transport: "sse", url: "https://old.example/sse", headers: [], args: [], env: [], allowedTools: ["a"] },
      { label: "files", transport: "stdio", command: "node", headers: [], args: ["f.js"], env: [{ name: "K", value: "v" }] },
      { label: "web", transport: "http", url: "https://web.example/mcp", headers: [{ name: "H", value: "v" }], args: [], env: [], allowedTools: ["x"] },
    ]);
  });
});

describe("the settings", () => {
  it("defaults to no servers and accepts http, sse and stdio entries", () => {
    expect(defaultSettings().mcpServers).toEqual({});
    const parsed = settingsSchema.parse({ mcpServers: { docs: { url: "https://docs.example/mcp", headers: { Authorization: "Bearer t" } }, old: { url: "http://localhost:1/sse", transport: "sse" }, files: { command: "npx", args: ["-y", "x"], env: { A: "1" } } } });
    expect(Object.keys(parsed.mcpServers)).toEqual(["docs", "old", "files"]);
    expect(resolveConfig(parsed, {}).config.mcpServers).toEqual(parsed.mcpServers);
  });

  it("rejects the reserved and malformed labels, both url and command, and non-http URLs", () => {
    const bad = (mcpServers: unknown) => expect(() => settingsSchema.parse({ mcpServers })).toThrow();
    bad({ client: { url: "https://x.example/mcp" } });
    bad({ "bad label": { url: "https://x.example/mcp" } });
    bad({ docs: { url: "https://x.example/mcp", command: "node" } });
    bad({ docs: { url: "ftp://x.example/mcp" } });
    bad({ docs: { url: "https://x.example/mcp", transport: "websocket" } });
    bad({ docs: { command: "" } });
    bad({ docs: { url: "https://x.example/mcp", headers: { "X-A": "a\nb" } } });
    bad({ docs: {} });
  });
});

describe("output items", () => {
  it("streams output_item.added, the mcp_call events and output_item.done before the message", async () => {
    const d = dirs();
    const remote = await remoteMcp();
    Object.assign(process.env, { FAKE_ACP_REMOTE: "codex" });
    const base = await start(d, [codex(d)]);
    const reply = await send(base, "/v1/responses", ask(CODEX_MODEL, [mcpTool({ server_url: remote.url })], { stream: true }));
    const events = sse(reply.raw);
    expect(events.map((event) => event.type)).toEqual(["response.created", "response.output_item.added", "response.mcp_call.in_progress", "response.mcp_call.completed", "response.output_item.done", "response.output_item.added", "response.content_part.added", "response.output_text.delta", "response.output_text.done", "response.content_part.done", "response.output_item.done", "response.completed"]);
    expect(events[1]).toMatchObject({ output_index: 0, item: { type: "mcp_call", status: "in_progress", server_label: "docs", name: "echo", output: null, error: null } });
    expect(events[2]).toMatchObject({ output_index: 0, item_id: events[1].item.id });
    const item = events[4].item;
    expect(item).toMatchObject({ type: "mcp_call", status: "completed", output: "echo: hi", error: null, arguments: JSON.stringify({ q: "hi" }) });
    expect(events[5]).toMatchObject({ output_index: 1, item: { type: "message" } });
    expect(events[7].delta).toBe("Let me check. got: echo: hi");
    expect(events[11].response.output.map((entry: any) => entry.type)).toEqual(["mcp_call", "message"]);
    expect(events[11].response.output[0]).toEqual(item);
    // Codex reports the result in rawOutput.result.content.
    expect(item.output).toBe("echo: hi");
  });

  it("reports a failed call with its error and a response.mcp_call.failed event", async () => {
    const d = dirs();
    const remote = await remoteMcp();
    Object.assign(process.env, { FAKE_ACP_REMOTE: "codex", FAKE_ACP_REMOTE_FAIL: "1" });
    const base = await start(d, [codex(d)]);
    const plainReply = await send(base, "/v1/responses", ask(CODEX_MODEL, [mcpTool({ server_url: remote.url })]));
    expect(plainReply.body.output[0]).toMatchObject({ type: "mcp_call", status: "failed", output: null, error: "echo: hi" });
    const streamed = await send(base, "/v1/responses", ask(CODEX_MODEL, [mcpTool({ server_url: remote.url })], { stream: true }));
    expect(sse(streamed.raw).map((event) => event.type)).toContain("response.mcp_call.failed");
  });

  it("builds one item per call from Claude's updates, in order, with the output of each", async () => {
    const d = dirs();
    const remote = await remoteMcp();
    Object.assign(process.env, { FAKE_ACP_CLAUDE: "1", FAKE_ACP_REMOTE: "claude", FAKE_ACP_REMOTE_CALLS: JSON.stringify([{ server: "docs", name: "echo", arguments: { q: "one" } }, { server: "docs", name: "secret", arguments: { q: "two" } }]) });
    const base = await start(d, [claude(d)]);
    const reply = await send(base, "/v1/responses", ask(CLAUDE_MODEL, [mcpTool({ server_url: remote.url })]));
    expect(reply.body.output.filter((item: any) => item.type === "mcp_call").map((item: any) => [item.name, item.arguments, item.output])).toEqual([["echo", '{"q":"one"}', "echo: one"], ["secret", '{"q":"two"}', "secret: two"]]);
    expect(reply.body.output[2].content[0].text).toBe("Let me check. got: echo: one | secret: two");
  });

  it("accepts the mcp_call items of an earlier response in the input and leaves them out of the prompt", async () => {
    const parsed = await normalizeResponses({ model: CLAUDE_MODEL, input: [{ role: "user", content: "hi" }, { type: "mcp_list_tools", id: "mcpl_1", server_label: "docs", tools: [] }, { type: "mcp_call", id: "mcp_1", server_label: "docs", name: "echo", arguments: "{}", output: "x", error: null, status: "completed" }, { role: "assistant", content: "done" }, { role: "user", content: "more" }] }, () => true);
    expect(parsed.conversation.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
  });
});

describe("permissions", () => {
  const cases = [
    { name: "Claude", model: CLAUDE_MODEL, env: { FAKE_ACP_CLAUDE: "1", FAKE_ACP_REMOTE: "claude" }, make: claude },
    { name: "Antigravity", model: AGY_MODEL, env: { FAKE_ACP_AGY: "1", FAKE_ACP_REMOTE: "agy" }, make: agy },
    { name: "Codex", model: CODEX_MODEL, env: { FAKE_ACP_REMOTE: "codex" }, make: codex },
  ] as const;
  const secretCalls = JSON.stringify([{ server: "docs", name: "echo", arguments: { q: "ok" } }, { server: "docs", name: "secret", arguments: { q: "no" } }]);

  for (const { name, model, env, make } of cases) {
    it(`${name}: allows only the allowed tool of the named server and cancels the others`, async () => {
      const d = dirs();
      const remote = await remoteMcp();
      Object.assign(process.env, env, { FAKE_ACP_REMOTE_CALLS: secretCalls });
      const base = await start(d, [make(d)]);
      const reply = await send(base, "/v1/responses", ask(model, [mcpTool({ server_url: remote.url, allowed_tools: ["echo"] })]));
      expect(reply.status).toBe(200);
      // The agent's own session setting and the proxy's rule agree: only echo ran.
      expect(remote.calls().map((call) => call.name)).toEqual(["echo"]);
      expect(mcpLog(d, "remote-permission").map((entry) => [entry.tool, entry.allowed])).toEqual([["echo", true], ["secret", false]]);
      if (name === "Claude") expect(requests(d, "session/new")[0]._meta.claudeCode.options.allowedTools).toEqual(["mcp__docs__echo"]);
      expect(reply.body.output.filter((item: any) => item.type === "mcp_call").map((item: any) => [item.name, item.status])).toEqual([["echo", "completed"], ["secret", "failed"]]);
      expect(reply.body.output.find((item: any) => item.name === "secret").error).toBe("Rejected by user");
      const answers = permissionAnswers(d);
      expect(answers[answers.length - 1]).toEqual({ outcome: "cancelled" });
      expect(answers.slice(0, -1).every((answer) => answer.outcome === "selected")).toBe(true);
    });
  }

  it("Codex: require_approval { never: { tool_names } } limits the tools like allowed_tools", async () => {
    const d = dirs();
    const remote = await remoteMcp();
    Object.assign(process.env, { FAKE_ACP_REMOTE: "codex", FAKE_ACP_REMOTE_CALLS: secretCalls });
    const base = await start(d, [codex(d)]);
    const reply = await send(base, "/v1/responses", ask(CODEX_MODEL, [mcpTool({ server_url: remote.url, require_approval: { never: { tool_names: ["echo"] } } })]));
    expect(reply.status).toBe(200);
    expect(remote.calls().map((call) => call.name)).toEqual(["echo"]);
    expect(permissionAnswers(d)).toEqual([{ outcome: "selected", optionId: "allow_once" }, { outcome: "cancelled" }]);
    expect(promptTexts(d)[0]).toContain("From the MCP server \"docs\" use only these tools: echo.");
  });

  it("Claude: lists every allowed tool, and a server with no filter gets the wildcard", async () => {
    const d = dirs();
    const remote = await remoteMcp();
    Object.assign(process.env, { FAKE_ACP_CLAUDE: "1", FAKE_ACP_REMOTE: "claude", FAKE_ACP_REMOTE_CALLS: "[]" });
    const base = await start(d, [claude(d)]);
    await send(base, "/v1/responses", ask(CLAUDE_MODEL, [mcpTool({ server_url: remote.url, allowed_tools: ["echo", "secret"] }), mcpTool({ server_label: "other", server_url: remote.url })]));
    expect(requests(d, "session/new")[0]._meta.claudeCode.options.allowedTools).toEqual(["mcp__docs__echo", "mcp__docs__secret", "mcp__other__*"]);
    expect(requests(d, "session/new")[0].mcpServers.map((server: any) => server.name)).toEqual(["docs", "other"]);
  });

  describe("the descriptors' rules", () => {
    const access = (labels: string[], allowed: Record<string, string[] | undefined> = {}): McpAccess => ({ labels, allows: (server, tool) => labels.includes(server) && (allowed[server] === undefined || allowed[server]!.includes(tool)) });
    const request = (toolCall: Record<string, unknown>, meta?: Record<string, unknown>) => ({ sessionId: "s", toolCall: { toolCallId: "c1", ...toolCall }, options: [], ...(meta ? { _meta: meta } : {}) }) as unknown as RequestPermissionRequest;

    it("Claude: the server and the tool of the permission must be allowed", () => {
      const rule = claudeDescriptor({}, {}).allowTool!;
      const permission = (server: string, tool: string) => request({ title: `mcp__${server}__${tool}`, _meta: { claudeCode: { toolName: `mcp__${server}__${tool}`, mcpServer: { name: server } } } });
      expect(rule(permission("docs", "echo"), undefined, access(["docs"]))).toBe(true);
      expect(rule(permission("docs", "echo"), undefined, access(["client"]))).toBe(false);
      expect(rule(permission("other", "echo"), undefined, access(["docs"]))).toBe(false);
      expect(rule(permission("docs", "secret"), undefined, access(["docs"], { docs: ["echo"] }))).toBe(false);
      expect(rule(permission("docs", "secret"), undefined, access(["docs", "client"], { docs: ["echo"] }))).toBe(false);
      expect(rule(permission("client", "get_weather"), undefined, access(["docs", "client"], { docs: ["echo"] }))).toBe(true);
      // The server name and the tool name must agree.
      expect(rule(request({ title: "mcp__other__echo", _meta: { claudeCode: { toolName: "mcp__other__echo", mcpServer: { name: "docs" } } } }), undefined, access(["docs"]))).toBe(false);
      expect(rule(request({ title: "Bash" }), undefined, access(["docs"]))).toBe(false);
    });

    it("Antigravity: _meta.mcp names the server and tool, and the call flag is needed", () => {
      const rule = antigravityDescriptor(defaultRuntimeContext(), { env: {}, settings: {} }).allowTool!;
      const permission = (server: string, tool: string, flag = true) => request({ title: `${server}_${tool}`, _meta: { mcp: { server, tool }, ...(flag ? { is_mcp_tool_call: true } : {}) } });
      expect(rule(permission("docs", "echo"), undefined, access(["docs"]))).toBe(true);
      expect(rule(permission("docs", "echo", false), undefined, access(["docs"]))).toBe(false);
      expect(rule(permission("other", "echo"), undefined, access(["docs"]))).toBe(false);
      expect(rule(permission("docs", "secret"), undefined, access(["docs"], { docs: ["echo"] }))).toBe(false);
      expect(rule(request({ title: "run_command", kind: "execute" }), undefined, access(["docs"]))).toBe(false);
    });

    it("Codex: the tracked call names the server and tool, and the approval flag is needed", () => {
      const rule = codexDescriptor({ acpArgs: [] }).allowTool!;
      const approval = request({ kind: "execute", status: "pending" }, { is_mcp_tool_approval: true });
      const tracked = (server: string, tool: string) => ({ toolCallId: "c1", kind: "execute", rawInput: { server, tool, arguments: {} } });
      expect(rule(approval, tracked("docs", "echo"), access(["docs"]))).toBe(true);
      expect(rule(approval, tracked("other", "echo"), access(["docs"]))).toBe(false);
      expect(rule(approval, tracked("docs", "secret"), access(["docs"], { docs: ["echo"] }))).toBe(false);
      expect(rule(approval, undefined, access(["docs"]))).toBe(false);
      expect(rule(approval, { toolCallId: "c1", kind: "execute", rawInput: { command: "ls" } }, access(["docs"]))).toBe(false);
      expect(rule(request({ kind: "execute" }), tracked("docs", "echo"), access(["docs"]))).toBe(false);
    });
  });
});

describe("a function tool and an mcp tool in one request", () => {
  it("gives the session both servers, runs the remote call inside the turn and suspends on the client's call", async () => {
    const d = dirs();
    const remote = await remoteMcp();
    Object.assign(process.env, { FAKE_ACP_AGY: "1", FAKE_ACP_MCP: "agy", FAKE_ACP_REMOTE: "agy", FAKE_ACP_MCP_STRAY: "1" });
    const base = await start(d, [agy(d)]);
    const tools = [{ type: "function", name: "get_weather", description: "Weather", parameters: { type: "object", properties: { city: { type: "string" } } } }, mcpTool({ server_url: remote.url })];
    const input = [{ role: "user", content: "Weather in Paris, and echo hi." }];
    const first = await send(base, "/v1/responses", { model: AGY_MODEL, input, tools });
    expect(first.status, first.raw).toBe(200);
    const created = requests(d, "session/new");
    expect(created).toHaveLength(1);
    expect(created[0].mcpServers.map((server: any) => [server.type, server.name])).toEqual([["http", "client"], ["http", "docs"]]);
    expect(created[0].mcpServers[1].url).toBe(remote.url);
    expect(first.body.output.map((item: any) => item.type)).toEqual(["mcp_call", "message", "function_call"]);
    expect(first.body.output[0]).toMatchObject({ server_label: "docs", name: "echo", output: "Call docs echo tool", status: "completed" });
    // Both servers are allowed, a stray request for another server is not.
    expect(mcpLog(d, "stray")).toEqual([{ phase: "stray", toolCallId: "stray-1", allowed: false }]);
    expect(mcpLog(d, "remote-permission")).toEqual([{ phase: "remote-permission", server: "docs", tool: "echo", allowed: true }]);
    expect(promptTexts(d)[0]).toContain("MCP servers named \"client\", \"docs\"");
    const call = first.body.output.find((item: any) => item.type === "function_call");
    const second = await send(base, "/v1/responses", { model: AGY_MODEL, tools, input: [...input, ...first.body.output, { type: "function_call_output", call_id: call.call_id, output: "sunny" }] });
    expect(second.status, second.raw).toBe(200);
    // The remote call is not reported twice, and the same session finished the turn.
    expect(second.body.output.map((item: any) => item.type)).toEqual(["message"]);
    expect(second.body.output[0].content[0].text).toBe("got: echo: hi | sunny");
    expect(requests(d, "session/new")).toHaveLength(1);
    expect(requests(d, "session/prompt")).toHaveLength(1);
    expect(remote.calls()).toHaveLength(1);
  });

  it("streams the mcp_call items first, then the message and the function call", async () => {
    const d = dirs();
    const remote = await remoteMcp();
    Object.assign(process.env, { FAKE_ACP_MCP: "codex", FAKE_ACP_REMOTE: "codex" });
    const base = await start(d, [codex(d)]);
    const tools = [{ type: "function", name: "get_weather", parameters: { type: "object" } }, mcpTool({ server_url: remote.url })];
    const reply = await send(base, "/v1/responses", { model: CODEX_MODEL, input: "Weather?", tools, stream: true });
    const events = sse(reply.raw);
    expect(events.map((event) => event.type)).toEqual(["response.created", "response.output_item.added", "response.mcp_call.in_progress", "response.mcp_call.completed", "response.output_item.done", "response.output_item.added", "response.content_part.added", "response.output_text.delta", "response.output_text.done", "response.content_part.done", "response.output_item.done", "response.output_item.added", "response.function_call_arguments.delta", "response.function_call_arguments.done", "response.output_item.done", "response.completed"]);
    expect(events[11].output_index).toBe(2);
    expect(events[15].response.output.map((item: any) => item.type)).toEqual(["mcp_call", "message", "function_call"]);
  });

  it("reuses a resumed session only for the same servers", async () => {
    const d = dirs();
    const remote = await remoteMcp();
    Object.assign(process.env, { FAKE_ACP_MCP: "codex", FAKE_ACP_REMOTE: "codex" });
    const base = await start(d, [codex(d)]);
    const fn = { type: "function", name: "get_weather", parameters: { type: "object" } };
    const input = [{ role: "user", content: "Weather?" }];
    const first = await send(base, "/v1/responses", { model: CODEX_MODEL, input, tools: [fn, mcpTool({ server_url: remote.url })] });
    const call = first.body.output.find((item: any) => item.type === "function_call");
    // The same function tool with another server list is another tool set: no resume, a new session with the history as text.
    const other = await send(base, "/v1/responses", { model: CODEX_MODEL, tools: [fn, mcpTool({ server_label: "else", server_url: remote.url })], input: [...input, ...first.body.output, { type: "function_call_output", call_id: call.call_id, output: "sunny" }] });
    expect(other.status).toBe(200);
    expect(requests(d, "session/new")).toHaveLength(2);
    const same = await send(base, "/v1/responses", { model: CODEX_MODEL, tools: [fn, mcpTool({ server_url: remote.url })], input: [...input, ...first.body.output, { type: "function_call_output", call_id: call.call_id, output: "sunny" }] });
    expect(same.body.output[0].content[0].text).toContain("sunny");
    expect(requests(d, "session/new")).toHaveLength(2);
  });
});
