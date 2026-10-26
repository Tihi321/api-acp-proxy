import os from "node:os";
import path from "node:path";
import type { RequestPermissionRequest, Usage, StopReason } from "@agentclientprotocol/sdk";
import type { Message, ToolCall, ToolChoice, ToolDef } from "./api.js";
import type { McpServerSpec } from "./mcp-config.js";
import { silentLogger, type Logger } from "./logger.js";
import type { ToolBridgeHub } from "./tool-bridge.js";

/** An image the agent generated: base64 `data` as taken from the agent's update; Codex also reports the prompt it actually used. */
export interface GeneratedImage { mimeType: string; data: string; revisedPrompt?: string; }
/** `images` is set only when the request asked for generated images. `stopReason` is `"tool_calls"` when the turn is suspended on `toolCalls` (the agent waits for the client's results). */
/** A call the agent made to one of the request's remote MCP servers, built from its `tool_call` / `tool_call_update` updates. `output` is what the update carried (Antigravity: only a placeholder); `error` is set for a failed call. */
export interface McpCallResult { server: string; name: string; /** The JSON text of the arguments. */ arguments: string; output: string | null; error: string | null; status: "completed" | "failed" | "incomplete"; }
export interface GenerationResult { text: string; stopReason: StopReason | "tool_calls"; usage: Usage | null; images?: GeneratedImage[]; toolCalls?: ToolCall[]; /** The remote MCP calls the agent made during this response (only for a request with `mcpServers`). */ mcpCalls?: McpCallResult[]; }
/** `instructions` is extra prompt text kept out of the client-visible messages; `images` lets the agent generate images (its image permission is allowed for this request only). `tools` gives the agent the client's function tools through the MCP bridge (`toolChoice` and `parallelToolCalls` as the request said). */
export interface GenerateOptions { instructions?: string; images?: true; tools?: ToolDef[]; toolChoice?: ToolChoice; parallelToolCalls?: boolean; /** Remote MCP servers the agent may call inside its turn (a Responses `mcp` tool); the agent talks to them itself. */ mcpServers?: McpServerSpec[]; }
export interface GenerationCallbacks { onText?: (text: string) => void; onUsage?: (usage: Usage) => void; }

export class AcpUnavailableError extends Error {
  /** `retryAfterSeconds` becomes the `Retry-After` header of the 503 answer. */
  constructor(message: string, public readonly backendCause?: unknown, public readonly code?: string, public readonly retryAfterSeconds?: number) { super(message); this.name = "AcpUnavailableError"; }
}
export class ProviderNotInstalledError extends AcpUnavailableError {
  constructor(message: string, cause?: unknown) { super(message, cause, "provider_not_installed"); this.name = "ProviderNotInstalledError"; }
}
export class ProviderAuthRequiredError extends AcpUnavailableError {
  constructor(message: string, cause?: unknown) { super(message, cause, "provider_auth_required"); this.name = "ProviderAuthRequiredError"; }
}
export class ProviderTermsRequiredError extends AcpUnavailableError {
  constructor(message: string) { super(message, undefined, "provider_terms_required"); this.name = "ProviderTermsRequiredError"; }
}

export interface ModelInfo { id: string; name?: string; }
/** "terminal" methods cannot be passed to authenticate. */
export interface AuthMethodInfo { id: string; name: string; description?: string; type?: string; }
export type ProviderState = "disabled" | "stopped" | "starting" | "ready" | "needs_login" | "not_installed" | "terms_required" | "error";
export interface ProviderStatus { id: string; name: string; state: ProviderState; error?: string; authMethods: AuthMethodInfo[]; models: ModelInfo[]; /** Browser URL printed by the agent for an interactive login (present while a login may be pending). */ loginUrl?: string; /** Version reported by the agent in initialize.agentInfo. */ agentVersion?: string; /** Signed-in account label pushed by the agent (e.g. via _auth/status_update). */ account?: string; /** What the agent said it accepts in `initialize` (present once it has started). */ capabilities?: { image: boolean }; }

/** How to run an agent process. Under Electron this is process.execPath + ELECTRON_RUN_AS_NODE=1. */
export interface NodeRuntime { command: string; argsPrefix: string[]; env: Record<string, string>; }
export interface RuntimeContext {
  logger: Logger;
  /** Per-user writable directory (settings, model cache, installed agents). */
  dataDir: string;
  nodeRuntime: NodeRuntime;
  /** Maps a path inside app.asar to app.asar.unpacked so it can be executed. Identity when headless. */
  resolveUnpacked(file: string): string;
  fetch?: typeof fetch;
  /** Opens a URL in the user's browser (used for interactive logins). Undefined when headless. */
  openUrl?: (url: string) => void | Promise<void>;
  /** The MCP endpoint of the proxy that gives an agent the client's function tools. Without it a request with tools is a 400. */
  toolBridge?: ToolBridgeHub;
}
export function defaultRuntimeContext(overrides: Partial<RuntimeContext> = {}): RuntimeContext {
  return { logger: silentLogger, dataDir: path.join(os.tmpdir(), "api-acp-proxy"), nodeRuntime: { command: process.execPath, argsPrefix: [], env: {} }, resolveUnpacked: (file) => file, ...overrides };
}

export interface LaunchSpec { command: string; args: string[]; env?: NodeJS.ProcessEnv; cwd?: string; }
export interface PreflightResult { state: "not_installed" | "terms_required"; message: string; }

export interface ProviderDescriptor {
  id: string;
  displayName: string;
  ownedBy: string;
  /** Also expose raw model ids without the `<id>/` prefix. */
  exposeUnprefixed: boolean;
  /** Fixed model list; when set no session is needed to list models. */
  staticModels?: readonly string[];
  /** "eager" authenticates right after initialize; "on-demand" only after an auth_required error or an explicit login. */
  authMode: "eager" | "on-demand";
  readOnlyMode: "required" | "optional";
  /** Timeout for session/new (cold starts can be slow). */
  sessionTimeoutMs?: number;
  /** Number of pre-created sessions kept ready. */
  warmSessions?: number;
  /** Whether PromptResponse.usage covers only the last turn (default) or the whole session so far. */
  usageScope?: "turn" | "session";
  preflight?(ctx: RuntimeContext): Promise<PreflightResult | undefined> | PreflightResult | undefined;
  launch(ctx: RuntimeContext): LaunchSpec | Promise<LaunchSpec>;
  /** Returns the auth method id to use without user interaction, or undefined when interactive login is needed. */
  chooseAuth(methods: AuthMethodInfo[], env: NodeJS.ProcessEnv): string | undefined;
  /** Returns a message when the agent cannot log in without the user (e.g. a fresh isolated home): an eager provider then reports needs_login instead of starting an interactive login on its own. Checked only when chooseAuth returned nothing. */
  loginRequired?(methods: AuthMethodInfo[], env: NodeJS.ProcessEnv): string | undefined;
  /** Method login() uses when none was given and chooseAuth returned nothing (default: the first advertised method). */
  defaultLoginMethod?: string;
  /** Mode ids that count as the safe/read-only mode, in order of preference. Default ["read-only", "readonly"]. */
  modeCandidates?: readonly string[];
  /** stderr lines of the agent are logged at this level (default info). */
  stderrLogLevel?: "debug" | "info";
  /** Matches the interactive login URL in an agent stderr line (the URL is capture group 1, or the whole match). */
  loginUrlPattern?: RegExp;
  /** Timeout for an automatic authenticate (eager or retry). On timeout the provider becomes needs_login and leaves the request pending. Default 10000. */
  authTimeoutMs?: number;
  /** Timeout for a user-initiated login(). Default 300000. */
  loginTimeoutMs?: number;
  /** Delay before a pending user login opens the login URL in the browser. Default 3000. */
  loginOpenDelayMs?: number;
  /** Runs before each agent process is spawned (after preflight): orphan sweeps, pending cleanups. */
  beforeStart?(ctx: RuntimeContext): Promise<void> | void;
  /** Runs after the agent process tree has been killed by close(). */
  afterStop?(ctx: RuntimeContext): Promise<void> | void;
  /** Called with the id of every session the provider creates. */
  onSessionCreated?(sessionId: string): void;
  /** Called after a session was disposed, with its working directory (cleanup of agent-side leftovers). */
  onSessionDisposed?(cwd: string): Promise<void> | void;
  /** Called after a successful user-initiated login with the method that was used. */
  onLoginSuccess?(methodId: string): void;
  /** Sent as `_meta` on session/new (agent-specific session options). */
  sessionMeta?: Record<string, unknown>;
  /** Login methods shown in status().authMethods when the agent advertises none. */
  loginMethods?: AuthMethodInfo[];
  /** When present, login() runs this (e.g. a console window) instead of ACP authenticate; on success the agent is restarted. */
  externalLogin?(ctx: RuntimeContext, methodId: string): Promise<void>;
  /** Extra line appended to the generic text-only preamble of every prompt for this agent. */
  promptPreamble?: string;
  /** Translates a backend error into a proxy error (e.g. an ApiError 403). */
  mapError?(error: unknown, model: string): Error | undefined;
  /** The agent can generate images. Absent: a request for images is a 400 `model_not_capable`. */
  imageGeneration?: ImageGeneration;
  /** True for the agent's permission request for a tool of one of the session's MCP servers (`mcp.labels`: the `client` bridge and/or the request's remote servers) when `mcp.allows(server, tool)` (then answered with `allow_once`, only in a request that has tools). `tracked` holds the `tool_call` fields seen so far for the request's `toolCallId`. Absent: the agent cannot be given tools (400 `model_not_capable`). */
  allowTool?(permission: RequestPermissionRequest, tracked: TrackedToolCall | undefined, mcp: McpAccess): boolean;
  /** The MCP server (one of `labels`), tool and arguments of a tool call, from its tracked `tool_call` fields; undefined for any other call. */
  mcpTarget?(call: TrackedToolCall, labels: readonly string[]): { server: string; tool: string; arguments?: unknown } | undefined;
  /** Merged into the session `_meta` of a session that has MCP servers (Claude: `allowedTools`, so it asks no permission); `tools` is the tools the server may be asked for (absent: all). */
  mcpSessionMeta?(servers: ReadonlyArray<{ label: string; tools?: readonly string[] }>): Record<string, unknown> | undefined;
  /** How long the agent keeps one MCP `tools/call` open before it gives up (undefined: no limit). The proxy answers or drops a suspended call 30 s before that. */
  toolCallLimitMs?: number;
}

/** The fields of an ACP `tool_call` / `tool_call_update` the proxy keeps per tool call id (Codex's permission request names only the id). */
export interface TrackedToolCall { toolCallId: string; title?: string; kind?: string; status?: string; rawInput?: unknown; rawOutput?: unknown; content?: unknown; _meta?: Record<string, unknown> | null; }
/** What a session's tools may reach: the MCP server labels it has and which tools of a server the request allows. */
export interface McpAccess { labels: readonly string[]; allows(server: string, tool: string): boolean; }

export interface ImageGeneration {
  /** True for the agent's permission request for its image tool (it is then answered with the `allow_once` option, only in a request that asked for images). Absent: the agent asks no permission. */
  allow?(permission: RequestPermissionRequest): boolean;
  /** The only folder the proxy deletes a generated file from (the agent's own copy; the image itself is taken from the update). */
  imageFolder(ctx: RuntimeContext): string;
  /** Also remove the then-empty folder the file was in (Codex: `<threadId>`). */
  pruneEmptyParent?: boolean;
}

export interface Provider {
  readonly id: string;
  readonly displayName: string;
  readonly ownedBy: string;
  readonly exposeUnprefixed: boolean;
  readonly staticModels?: ModelInfo[];
  /** The agent can generate images. */
  readonly imageGeneration?: boolean;
  /** The agent can be given the client's function tools. */
  readonly toolCalling?: boolean;
  /** The agent can be given remote MCP servers (it has a permission rule and a way to name their calls). */
  readonly mcpSupport?: boolean;
  generate(model: string, messages: Message[], callbacks?: GenerationCallbacks, signal?: AbortSignal, options?: GenerateOptions): Promise<GenerationResult>;
  listModels(options?: { force?: boolean }): Promise<ModelInfo[]>;
  status(): ProviderStatus;
  login(methodId?: string): Promise<void>;
  onStatus(listener: (status: ProviderStatus) => void): () => void;
  close(): Promise<void>;
}
