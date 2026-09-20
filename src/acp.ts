import { createRequire } from "node:module";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { client, methods, ndJsonStream, type ClientConnection, type ClientContext } from "@agentclientprotocol/sdk";
import type { SessionNotification, SessionUpdate, StopReason, Usage } from "@agentclientprotocol/sdk";
import type { ModelId, ProxyConfig } from "./config.js";
import { serializePrompt, type TextMessage } from "./api.js";

export interface GenerationResult { text: string; stopReason: StopReason; usage: Usage | null; }
export interface GenerationCallbacks { onText?: (text: string) => void; onUsage?: (usage: Usage) => void; }

export class AcpUnavailableError extends Error {
  constructor(message: string, public readonly backendCause?: unknown) { super(message); this.name = "AcpUnavailableError"; }
}

type SessionHandler = (update: SessionUpdate) => void;

/** Long-lived ACP v1 connection with disposable sessions per generation. */
export class AcpBridge {
  private child?: ChildProcessWithoutNullStreams;
  private connection?: ClientConnection;
  private agent?: ClientContext;
  private startPromise?: Promise<void>;
  private readonly handlers = new Map<string, SessionHandler>();

  constructor(private readonly config: ProxyConfig) {}

  private async start(): Promise<void> {
    if (this.agent && this.connection && !this.connection.signal.aborted) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = (async () => {
      await mkdir(this.config.workRoot, { recursive: true });
      if (this.child) this.child.kill();
      const require = createRequire(import.meta.url);
      const entry = require.resolve("@agentclientprotocol/codex-acp/dist/index.js");
      const command = this.config.acpCommand || process.execPath;
      const args = this.config.acpCommand ? this.config.acpArgs : [entry, ...this.config.acpArgs];
      let configuredCodex: Record<string, unknown> = {};
      try { configuredCodex = process.env.CODEX_CONFIG ? JSON.parse(process.env.CODEX_CONFIG) as Record<string, unknown> : {}; } catch { /* invalid user config is ignored in favor of safe defaults */ }
      const env = { ...process.env, INITIAL_AGENT_MODE: "read-only", CODEX_CONFIG: JSON.stringify({ ...configuredCodex, approval_policy: "never", sandbox_mode: "read-only", features: { ...(configuredCodex.features as Record<string, unknown> || {}), multi_agent: false } }) };
      const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env });
      this.child = child;
      const childFailure = new Promise<never>((_, reject) => child.once("error", reject));
      child.stderr.on("data", (chunk) => process.stderr.write(`[codex-acp] ${String(chunk)}`));
      const stream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>);
      const app = client({ name: "codex-subscription-proxy" });
      app.onRequest(methods.client.session.requestPermission, async () => ({ outcome: { outcome: "cancelled" } }));
      app.onNotification(methods.client.session.update, ({ params }) => {
        this.handlers.get(params.sessionId)?.(params.update);
      });
      const connection = app.connect(stream);
      this.connection = connection;
      this.agent = connection.agent;
      child.once("exit", () => { if (this.child === child) { this.connection = undefined; this.agent = undefined; this.child = undefined; } });
      try {
        const initialized = await Promise.race([this.agent.request(methods.agent.initialize, { protocolVersion: 1, clientInfo: { name: "codex-subscription-proxy", version: "0.1.0" }, clientCapabilities: {} }), childFailure]);
        const preferredAuth = process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY ? "api-key" : "chat-gpt";
        if (initialized.authMethods?.some((method) => method.id === preferredAuth)) await this.agent.request(methods.agent.authenticate, { methodId: preferredAuth });
      } catch (error) {
        connection.close(error);
        child.kill();
        throw new AcpUnavailableError("Unable to initialize the Codex ACP backend.", error);
      }
    })().finally(() => { this.startPromise = undefined; });
    return this.startPromise;
  }

  private async stop(): Promise<void> {
    this.connection?.close();
    this.child?.kill();
    this.connection = undefined;
    this.agent = undefined;
    this.child = undefined;
  }

  async generate(model: ModelId, messages: TextMessage[], callbacks: GenerationCallbacks = {}, signal?: AbortSignal): Promise<GenerationResult> {
    await this.start();
    const agent = this.agent;
    if (!agent) throw new AcpUnavailableError("Codex ACP backend is unavailable.");
    const cwd = await mkdtemp(path.join(this.config.workRoot, "request-"));
    let sessionId: string | undefined;
    let aborted = false;
    const abort = async () => {
      if (aborted || !sessionId) return;
      aborted = true;
      try { await agent.notify(methods.agent.session.cancel, { sessionId }); } catch { /* connection may already be gone */ }
    };
    signal?.addEventListener("abort", abort, { once: true });
    let text = "";
    let usage: Usage | null = null;
    try {
      const session = await agent.request(methods.agent.session.new, { cwd, mcpServers: [] });
      const sid = session.sessionId;
      sessionId = sid;
      const handler: SessionHandler = (update) => {
        if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
          text += update.content.text;
          callbacks.onText?.(update.content.text);
        }
      };
      this.handlers.set(sid, handler);
      const modelOption = (session.configOptions || []).find((option) => option.category === "model" || option.id.toLowerCase().includes("model"));
      if (!modelOption) throw new AcpUnavailableError("The Codex ACP backend did not advertise a model configuration option.");
      await agent.request(methods.agent.session.setConfigOption, { sessionId: sid, configId: modelOption.id, value: model });
      const readOnly = session.modes?.availableModes.find((mode) => mode.id === "read-only" || mode.id === "readonly");
      if (!readOnly) throw new AcpUnavailableError("The Codex ACP backend did not advertise a read-only mode.");
      await agent.request(methods.agent.session.setMode, { sessionId: sid, modeId: readOnly.id });
      const promptPromise = agent.request(methods.agent.session.prompt, { sessionId: sid, prompt: [{ type: "text", text: serializePrompt(messages) }] });
      const result = await promptPromise;
      if (result.usage) usage = result.usage;
      return { text, stopReason: result.stopReason, usage };
    } catch (error) {
      if (aborted) throw new AcpUnavailableError("The request was cancelled.", error);
      throw new AcpUnavailableError("The Codex ACP backend failed to process the request.", error);
    } finally {
      signal?.removeEventListener("abort", abort);
      if (sessionId) {
        this.handlers.delete(sessionId);
        try { await agent.request(methods.agent.session.delete, { sessionId }); } catch { /* best effort cleanup */ }
      }
      await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async close(): Promise<void> { await this.stop(); }
}

export interface AcpLike { generate(model: ModelId, messages: TextMessage[], callbacks?: GenerationCallbacks, signal?: AbortSignal): Promise<GenerationResult>; close?(): Promise<void>; }
