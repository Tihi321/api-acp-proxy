import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

/** The name of the MCP server the agent is given; the agents name its tools `mcp__client__<tool>`, `client_<tool>` or `mcp.client.<tool>`. */
export const BRIDGE_SERVER_NAME = "client";
const DEFAULT_KEEPALIVE_MS = 20_000;
const MAX_BODY_BYTES = 8 * 1024 * 1024;

/** A function tool of the client's request, as the bridge lists it over MCP. */
export interface BridgeTool { name: string; description?: string; inputSchema?: unknown; }
/** A `tools/call` held open until the client sends the result; `id` is what the client sees (`call_<random>`). */
export interface HeldCall {
  id: string;
  name: string;
  /** The JSON text of the call's arguments. */
  arguments: string;
  /** The agent's connection for this call went away (its own timeout); `settle` is then a no-op. */
  closed: boolean;
  /** Answers the call: the SSE stream gets one `message` event with the result and ends. */
  settle(text: string, isError?: boolean): void;
}

const callId = (): string => `call_${randomBytes(12).toString("hex")}`;
const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

function sendJson(response: ServerResponse, status: number, payload?: unknown, headers: Record<string, string> = {}): void {
  if (payload === undefined) { response.writeHead(status, headers).end(); return; }
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers }).end(JSON.stringify(payload));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) { size += Buffer.byteLength(chunk); if (size > MAX_BODY_BYTES) throw new Error("too large"); chunks.push(Buffer.from(chunk)); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** One agent session's view of the client's tools: a minimal MCP server whose state lives under its token, so a reconnecting agent finds it again. */
export class BridgeSession {
  /** The agent's `tools/call`s arrive here (set by the provider while a request is being served). */
  onCall?: (call: HeldCall) => void;
  private readonly open = new Map<string, HeldCall>();
  private disposed = false;

  constructor(readonly token: string, readonly url: string, readonly tools: BridgeTool[], private readonly hub: ToolBridgeHub, private readonly keepaliveMs: number) {}

  /** The calls the agent has open (answered or not yet). */
  openCalls(): HeldCall[] { return [...this.open.values()]; }

  /** Answers every still-open call with an error and forgets the token. */
  dispose(message = "The tool bridge was closed."): void {
    if (this.disposed) return;
    this.disposed = true;
    this.hub.remove(this.token);
    for (const call of [...this.open.values()]) call.settle(message, true);
  }

  /** Runs one JSON-RPC message that is not a `tools/call`; undefined for a notification. */
  private reply(message: { id?: unknown; method?: unknown; params?: unknown }): unknown {
    if (message.id === undefined || message.id === null) return undefined;
    const id = message.id;
    const params = (message.params ?? {}) as { protocolVersion?: unknown };
    switch (message.method) {
      case "initialize": return { jsonrpc: "2.0", id, result: { protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: BRIDGE_SERVER_NAME, version: "1.0.0" } } };
      case "ping": return { jsonrpc: "2.0", id, result: {} };
      // Every tool is read-only: that is what lets Claude run parallel calls, and the proxy never runs the tools itself.
      case "tools/list": return { jsonrpc: "2.0", id, result: { tools: this.tools.map((tool) => ({ name: tool.name, ...(tool.description ? { description: tool.description } : {}), inputSchema: tool.inputSchema ?? { type: "object", properties: {} }, annotations: { readOnlyHint: true } })) } };
      default: return rpcError(id, -32601, `Method not found: ${String(message.method)}`);
    }
  }

  /** `tools/call`: 200 `text/event-stream` with a keepalive comment at once and then every `keepaliveMs`, and one `message` event with the result once the call is settled. */
  private startCall(response: ServerResponse, rpcId: unknown, params: { name?: unknown; arguments?: unknown }): void {
    if (typeof params.name !== "string" || !this.tools.some((tool) => tool.name === params.name)) { sendJson(response, 200, rpcError(rpcId, -32602, `Unknown tool: ${String(params.name)}`)); return; }
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    response.write(": keepalive\n\n");
    const timer = setInterval(() => { if (!response.writableEnded) response.write(": keepalive\n\n"); }, this.keepaliveMs);
    timer.unref?.();
    const call: HeldCall = { id: callId(), name: params.name, arguments: JSON.stringify(params.arguments ?? {}), closed: false, settle: (text, isError) => {
      if (!this.open.delete(call.id)) return;
      clearInterval(timer);
      if (call.closed || response.writableEnded) return;
      response.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: rpcId, result: { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) } })}\n\n`);
    } };
    this.open.set(call.id, call);
    response.once("close", () => { clearInterval(timer); if (this.open.delete(call.id)) call.closed = true; });
    if (this.onCall) this.onCall(call); else call.settle("No request is waiting for this tool call.", true);
  }

  /** Handles one POST: plain JSON for everything except `tools/call`. */
  async post(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let body: unknown;
    try { body = await readJson(request); } catch { sendJson(response, 400, rpcError(null, -32700, "Parse error")); return; }
    if (!Array.isArray(body) && body && typeof body === "object" && (body as { method?: unknown }).method === "tools/call" && (body as { id?: unknown }).id !== undefined) {
      const message = body as { id: unknown; params?: { name?: unknown; arguments?: unknown } };
      this.startCall(response, message.id, message.params ?? {});
      return;
    }
    const messages = Array.isArray(body) ? body : [body];
    const replies = messages.flatMap((message) => {
      if (!message || typeof message !== "object") return [rpcError(null, -32600, "Invalid Request")];
      const typed = message as { id?: unknown; method?: unknown };
      if (typed.method === "tools/call") return typed.id === undefined ? [] : [rpcError(typed.id, -32600, "tools/call cannot be sent in a batch")];
      const reply = this.reply(typed);
      return reply === undefined ? [] : [reply];
    });
    if (!replies.length) sendJson(response, 202);
    else sendJson(response, 200, Array.isArray(body) ? replies : replies[0]);
  }
}

/** The MCP endpoint `/mcp/<token>` of the proxy: one session per agent session, found by its token (the token is the credential). */
export class ToolBridgeHub {
  private readonly sessions = new Map<string, BridgeSession>();
  private origin?: string;

  constructor(private readonly options: { keepaliveMs?: number } = {}) {}

  /** Remembers where the proxy listens: always a loopback address for a wildcard bind, since the agents run on the same machine. */
  setAddress(address: string, port: number): void {
    const host = address === "0.0.0.0" || address === "::" || address === "" ? "127.0.0.1" : address.includes(":") ? `[${address}]` : address;
    this.origin = `http://${host}:${port}`;
  }

  get ready(): boolean { return this.origin !== undefined; }

  /** A new session for these tools; throws before the proxy listens. */
  create(tools: BridgeTool[]): BridgeSession {
    if (!this.origin) throw new Error("The proxy is not listening yet, so it has no address for the tool bridge.");
    const token = randomBytes(32).toString("base64url");
    const session = new BridgeSession(token, `${this.origin}/mcp/${token}`, tools, this, this.options.keepaliveMs ?? DEFAULT_KEEPALIVE_MS);
    this.sessions.set(token, session);
    return session;
  }

  remove(token: string): void { this.sessions.delete(token); }

  /** Routes `/mcp/<token>`; false when the path is not ours. An unknown token is a 404. */
  async handle(request: IncomingMessage, response: ServerResponse, pathname: string): Promise<boolean> {
    if (pathname !== "/mcp" && !pathname.startsWith("/mcp/")) return false;
    const session = this.sessions.get(pathname.slice("/mcp/".length).replace(/\/+$/, ""));
    if (!session) { sendJson(response, 404, { error: { message: "Not found.", type: "invalid_request_error", code: "not_found", param: null } }); return true; }
    const method = request.method || "GET";
    if (method === "POST") await session.post(request, response);
    else if (method === "DELETE") sendJson(response, 200);
    else sendJson(response, 405, undefined, { Allow: "POST, DELETE" });
    return true;
  }

  /** Disposes every session (the server is closing). */
  closeAll(): void { for (const session of [...this.sessions.values()]) session.dispose(); }
}
