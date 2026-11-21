import type { StopReason, Usage } from "@agentclientprotocol/sdk";
import { ApiError, messageText, type Message } from "../api.js";
import type { ProviderRegistration } from "../controller.js";
import { STRATA_PROFILE_ID, type LocalModelCoordinator } from "../local-models.js";
import type { Logger } from "../logger.js";
import { AcpUnavailableError, type GenerateOptions, type GenerationCallbacks, type GenerationResult, type ImagePassthrough, type ModelInfo, type Provider, type ProviderState, type ProviderStatus } from "../provider.js";
import type { GufoProfile } from "../settings.js";

export interface LocalOpenAiOptions {
  id: "gufo" | "strata"; displayName: string;
  /** "http://127.0.0.1:<port>/v1" */
  baseUrl: string;
  apiKey?: string; logger: Logger;
  /** Default `globalThis.fetch`, not the Electron `net.fetch` of the runtime context (see `registration`). */
  fetch?: typeof fetch;
  /** Gufo: the models this provider offers (listed whether or not the server runs). Without profiles the upstream's own list is used (Strata). */
  profiles?: GufoProfile[];
  /** Gufo: switches/queues the single server to the profile a request names. Without it requests go straight to the upstream. */
  coordinator?: LocalModelCoordinator;
  /** Coordinator profile every request of this provider holds a lease on (Strata: `strata`); Gufo derives it from the model's profile. */
  leaseProfile?: string;
}

const DEFAULT_IMAGE_TIMEOUT_MS = 15 * 60 * 1000;
const GENERATION_FIELDS = ["prompt", "size", "steps", "seed", "negative_prompt", "guidance_scale", "n"] as const;
type WireContent = string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;

export function notRunningMessage(displayName: string): string { return `${displayName} is not running — start it from the app.`; }

const NOT_RUNNING = "local_server_not_running";
const CONNECTION_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"]);

function errorCode(error: unknown): string | undefined {
  const cause = (error as { cause?: { code?: unknown } } | undefined)?.cause;
  const code = cause?.code ?? (error as { code?: unknown } | undefined)?.code;
  return typeof code === "string" ? code : undefined;
}

/** A generic OpenAI-compatible HTTP upstream (a local llama-server style process such as Gufo or Strata); text only, no tools. */
export class LocalOpenAiProvider implements Provider {
  readonly id: string;
  readonly displayName: string;
  readonly ownedBy: string;
  readonly exposeUnprefixed = false;
  readonly staticModels?: ModelInfo[];
  private readonly profiles?: GufoProfile[];
  private readonly coordinator?: LocalModelCoordinator;
  private readonly leaseProfile?: string;
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly logger: Logger;
  private readonly fetchImpl: typeof fetch;
  private state: ProviderState = "stopped";
  private error: string | undefined;
  private models: ModelInfo[] = [];
  private readonly listeners = new Set<(status: ProviderStatus) => void>();
  private readonly inflight = new Set<AbortController>();

  constructor(options: LocalOpenAiOptions) {
    this.id = options.id; this.displayName = options.displayName; this.ownedBy = options.id;
    this.baseUrl = options.baseUrl.replace(/\/+$/, ""); this.apiKey = options.apiKey || undefined; this.logger = options.logger;
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.coordinator = options.coordinator;
    this.leaseProfile = options.leaseProfile;
    if (options.profiles) {
      this.profiles = options.profiles;
      this.staticModels = options.profiles.map((profile) => ({ id: profile.model, name: profile.label, kind: profile.kind, vision: profile.kind === "llm" && profile.vision }));
      this.models = this.staticModels;
    }
  }

  private profileOf(model: string): GufoProfile | undefined { return this.profiles?.find((profile) => profile.model === model); }

  acceptsImages(model: string): boolean { const profile = this.profileOf(model); return profile?.kind === "llm" && profile.vision; }

  supportsImageGeneration(model: string): boolean { return this.profileOf(model)?.kind === "image"; }

  requestTimeoutMs(model: string): number | undefined {
    const profile = this.profileOf(model);
    return profile?.requestTimeoutMs ?? (profile?.kind === "image" ? DEFAULT_IMAGE_TIMEOUT_MS : undefined);
  }

  /** Checks the request against the model's profile, then waits for the coordinator to make that profile ready. All 400s come before any switch is started. */
  async prepareModel(model: string, messages: Message[] | undefined, signal: AbortSignal): Promise<{ release(): void } | undefined> {
    const profile = this.profileOf(model);
    if (messages) {
      if (profile?.kind === "image") throw new ApiError(400, "model_not_capable", `The model '${this.id}/${model}' generates images; it does not answer chat requests.`, "model");
      if (messages.some((message) => message.parts.some((part) => part.type === "image")) && !(profile?.kind === "llm" && profile.vision)) throw new ApiError(400, "unsupported_content", `The model '${this.id}/${model}' does not accept image input.`, "messages");
    } else if (profile && profile.kind !== "image") throw new ApiError(400, "model_not_capable", `The model '${this.id}/${model}' does not generate images.`, "model");
    const leaseId = profile?.id ?? this.leaseProfile;
    if (!leaseId || !this.coordinator) return undefined;
    return this.coordinator.acquire(leaseId, signal);
  }

  status(): ProviderStatus {
    return { id: this.id, name: this.displayName, state: this.state, ...(this.error ? { error: this.error } : {}), authMethods: [], models: this.models, capabilities: { image: false }, features: { imageGeneration: false, tools: false, mcp: false, webSearch: false } };
  }

  onStatus(listener: (status: ProviderStatus) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }

  private setState(state: ProviderState, error?: string): void {
    if (this.state === state && this.error === error) return;
    this.state = state; this.error = error;
    const status = this.status();
    for (const listener of this.listeners) { try { listener(status); } catch { /* a listener must not break the provider */ } }
  }

  private headers(json: boolean): Record<string, string> {
    return { ...(json ? { "content-type": "application/json" } : {}), accept: json ? "text/event-stream" : "application/json", ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) };
  }

  private notRunning(cause: unknown): AcpUnavailableError {
    const message = notRunningMessage(this.displayName);
    this.setState("stopped", message);
    return new AcpUnavailableError(message, cause, NOT_RUNNING);
  }

  async listModels(): Promise<ModelInfo[]> {
    const controller = new AbortController(); this.inflight.add(controller);
    const timer = setTimeout(() => controller.abort(), 5000);
    let response: Response;
    try { response = await this.fetchImpl(`${this.baseUrl}/models`, { headers: this.headers(false), signal: controller.signal }); }
    catch (error) { const unavailable = this.notRunning(error); if (this.profiles) return this.models; throw unavailable; }
    finally { clearTimeout(timer); this.inflight.delete(controller); }
    if (!response.ok) { await response.body?.cancel().catch(() => undefined); if (this.profiles) return this.models; throw new AcpUnavailableError(`${this.displayName} answered HTTP ${response.status}`, undefined, "upstream_error"); }
    if (this.profiles) { await response.body?.cancel().catch(() => undefined); this.setState("ready"); return this.models; }
    const body = await response.json().catch(() => undefined) as { data?: Array<{ id?: unknown }> } | undefined;
    this.models = (body?.data ?? []).flatMap((entry) => typeof entry.id === "string" ? [{ id: entry.id }] : []);
    this.setState("ready");
    return this.models;
  }

  async generate(model: string, messages: Message[], callbacks?: GenerationCallbacks, signal?: AbortSignal, options?: GenerateOptions): Promise<GenerationResult> {
    const wire: Array<{ role: "system" | "user" | "assistant"; content: WireContent }> = [];
    const vision = this.acceptsImages(model);
    if (options?.instructions) wire.push({ role: "system", content: options.instructions });
    for (const message of messages) {
      const images = vision ? message.parts.flatMap((part) => part.type === "image" ? [{ type: "image_url" as const, image_url: { url: `data:${part.mimeType};base64,${part.data}` } }] : []) : [];
      wire.push({ role: message.role === "developer" ? "system" : message.role === "tool" ? "user" : message.role, content: images.length ? [{ type: "text", text: messageText(message) }, ...images] : messageText(message) });
    }

    const controller = new AbortController(); this.inflight.add(controller);
    const onAbort = (): void => controller.abort();
    if (signal?.aborted) controller.abort(); else signal?.addEventListener("abort", onAbort, { once: true });
    let text = ""; let reasoning = ""; let usage: Usage | null = null; let finish: string | undefined;
    const cancelled = (): GenerationResult => ({ text, stopReason: "cancelled", usage: null, ...(reasoning ? { reasoning } : {}) });
    try {
      let response: Response;
      try { response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, { method: "POST", headers: this.headers(true), body: JSON.stringify({ model, messages: wire, stream: true, stream_options: { include_usage: true }, ...(options?.maxOutputTokens !== undefined ? { max_tokens: options.maxOutputTokens } : {}) }), signal: controller.signal }); }
      catch (error) { if (controller.signal.aborted) return cancelled(); throw this.notRunning(error); }
      if (!response.ok) {
        const raw = await response.text().catch(() => "");
        let detail = raw.slice(0, 300);
        try { const parsed = JSON.parse(raw) as { error?: { message?: unknown } | string }; const upstream = typeof parsed.error === "string" ? parsed.error : parsed.error?.message; if (typeof upstream === "string") detail = upstream; } catch { /* not JSON: use the body */ }
        throw new AcpUnavailableError(`${this.displayName} answered HTTP ${response.status}: ${detail}`, undefined, "upstream_error");
      }
      this.setState("ready");
      const handle = (payload: string): void => {
        if (!payload || payload === "[DONE]") return;
        let chunk: { choices?: Array<{ delta?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown }; finish_reason?: string | null }>; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } } | null; error?: { message?: unknown } | string };
        try { chunk = JSON.parse(payload); } catch { return; }
        if (chunk.error) { const detail = typeof chunk.error === "string" ? chunk.error : String(chunk.error.message ?? "unknown error"); throw new AcpUnavailableError(`${this.displayName} answered HTTP ${response.status}: ${detail}`, undefined, "upstream_error"); }
        const choice = chunk.choices?.[0];
        const thought = choice?.delta?.reasoning_content ?? choice?.delta?.reasoning;
        if (typeof thought === "string" && thought) { reasoning += thought; callbacks?.onReasoning?.(thought); }
        const delta = choice?.delta?.content;
        if (typeof delta === "string" && delta) { text += delta; callbacks?.onText?.(delta); }
        if (choice?.finish_reason) finish = choice.finish_reason;
        if (chunk.usage) {
          const inputTokens = chunk.usage.prompt_tokens ?? 0; const outputTokens = chunk.usage.completion_tokens ?? 0;
          usage = { inputTokens, outputTokens, totalTokens: chunk.usage.total_tokens ?? inputTokens + outputTokens, ...(typeof chunk.usage.completion_tokens_details?.reasoning_tokens === "number" ? { thoughtTokens: chunk.usage.completion_tokens_details.reasoning_tokens } : {}) };
          callbacks?.onUsage?.(usage);
        }
      };
      try {
        const reader = response.body?.getReader();
        if (reader) {
          const decoder = new TextDecoder(); let buffer = "";
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let newline: number;
            while ((newline = buffer.indexOf("\n")) >= 0) {
              const line = buffer.slice(0, newline).replace(/\r$/, ""); buffer = buffer.slice(newline + 1);
              if (line.startsWith("data:")) handle(line.slice(5).trim());
            }
          }
          buffer += decoder.decode();
          if (buffer.startsWith("data:")) handle(buffer.slice(5).trim());
        }
      } catch (error) {
        if (controller.signal.aborted) return cancelled();
        if (error instanceof AcpUnavailableError) throw error;
        if (CONNECTION_CODES.has(errorCode(error) ?? "")) throw this.notRunning(error);
        throw new AcpUnavailableError(`${this.displayName} stream failed: ${error instanceof Error ? error.message : String(error)}`, error, "upstream_error");
      }
      if (controller.signal.aborted) return cancelled();
      const stopReason: StopReason = finish === "length" ? "max_tokens" : "end_turn";
      return { text, stopReason, usage, ...(reasoning ? { reasoning } : {}) };
    } finally {
      signal?.removeEventListener("abort", onAbort);
      this.inflight.delete(controller);
      this.logger.debug(`${model}: ${text.length} chars, ${reasoning.length} reasoning chars`);
    }
  }

  /** Forwards an image request to the Gufo image server (Node fetch, bearer key, the request's signal). Upstream 401/403 -> 502 `local_upstream_auth`, 404 -> 502, 413 -> 413, other 4xx -> 400 `invalid_request`, 5xx -> 502 `upstream_error`, no connection -> 503 `local_server_not_running`. */
  async generateImage(model: string, request: ImagePassthrough, signal: AbortSignal): Promise<{ status: number; body: unknown }> {
    const profile = this.profileOf(model);
    if (profile?.kind !== "image") throw new ApiError(400, "model_not_capable", `The model '${this.id}/${model}' does not generate images.`, "model");
    const format = request.fields.response_format;
    if (format !== undefined && format !== "b64_json") throw new ApiError(400, "invalid_request", "Only response_format 'b64_json' is supported.", "response_format");
    const size = request.fields.size;
    if (size !== undefined && !(typeof size === "string" && /^\d+x\d+$/.test(size))) throw new ApiError(400, "invalid_request", "size must look like 1024x1024.", "size");
    const authorization: Record<string, string> = this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {};
    let init: RequestInit;
    let path: string;
    if (request.kind === "generations") {
      const body: Record<string, unknown> = { model: profile.model };
      for (const key of GENERATION_FIELDS) if (request.fields[key] !== undefined) body[key] = request.fields[key];
      if (format !== undefined) body.response_format = format;
      path = "/images/generations";
      init = { method: "POST", headers: { "content-type": "application/json", accept: "application/json", ...authorization }, body: JSON.stringify(body) };
    } else {
      const form = new FormData();
      form.append("model", profile.model);
      for (const key of [...GENERATION_FIELDS, "response_format"]) { const value = request.fields[key]; if (value !== undefined) form.append(key, value); }
      for (const file of request.files) form.append(file.field, new Blob([file.data as BlobPart], { type: file.type }), file.name);
      path = "/images/edits";
      init = { method: "POST", headers: { accept: "application/json", ...authorization }, body: form };
    }
    const controller = new AbortController(); this.inflight.add(controller);
    const forward = (): void => controller.abort();
    if (signal.aborted) controller.abort(); else signal.addEventListener("abort", forward, { once: true });
    try {
      let response: Response;
      try { response = await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, signal: controller.signal }); }
      catch (error) { if (controller.signal.aborted) throw error; throw this.notRunning(error); }
      const raw = await response.text();
      let parsed: unknown;
      try { parsed = JSON.parse(raw); } catch { /* not JSON */ }
      if (!response.ok) {
        const error = (parsed as { error?: { message?: unknown } | string } | undefined)?.error;
        const detail = typeof error === "string" ? error : typeof error?.message === "string" ? error.message : raw.slice(0, 300);
        const status = response.status;
        if (status === 401 || status === 403) throw new ApiError(502, "local_upstream_auth", `${this.displayName} rejected the request (HTTP ${status}); check the ${this.displayName} API key in Settings.${detail ? ` ${detail}` : ""}`);
        if (status === 404) throw new ApiError(502, "upstream_error", `${this.displayName} answered HTTP 404: endpoint or model not found${detail ? ` (${detail})` : ""}.`);
        if (status === 413) throw new ApiError(413, "invalid_request", detail || `${this.displayName} answered HTTP 413: the request is too large.`);
        if (status >= 400 && status < 500) throw new ApiError(400, "invalid_request", detail || `${this.displayName} answered HTTP ${status}`);
        throw new ApiError(502, "upstream_error", `${this.displayName} answered HTTP ${response.status}: ${detail}`);
      }
      this.setState("ready");
      const data = (parsed as { data?: unknown } | undefined)?.data;
      if (!Array.isArray(data) || !data.length || !data.every((entry) => typeof (entry as { b64_json?: unknown } | undefined)?.b64_json === "string")) throw new ApiError(502, "upstream_error", `${this.displayName} answered without image data.`);
      const object = parsed as Record<string, unknown>;
      return { status: 200, body: { ...object, created: typeof object.created === "number" ? object.created : Math.floor(Date.now() / 1000), output_format: "png" } };
    } finally {
      signal.removeEventListener("abort", forward);
      this.inflight.delete(controller);
    }
  }

  async login(): Promise<void> { /* a local server has no login */ }

  async close(): Promise<void> {
    for (const controller of this.inflight) controller.abort();
    this.inflight.clear(); this.listeners.clear();
  }
}

export interface GufoHost { coordinator?: LocalModelCoordinator }

function registration(id: "gufo" | "strata", displayName: string, host: GufoHost = {}): ProviderRegistration {
  return {
    id, displayName,
    // Node's global fetch on purpose, not ctx.fetch (Electron net.fetch): Strata refuses a POST that carries a browser Origin header.
    create: ({ providerSettings, ctx }) => new LocalOpenAiProvider({ id, displayName, baseUrl: `http://127.0.0.1:${providerSettings.port as number}/v1`, ...(typeof providerSettings.apiKey === "string" && providerSettings.apiKey ? { apiKey: providerSettings.apiKey } : {}), logger: ctx.logger.child(id), ...(id === "gufo" && Array.isArray(providerSettings.profiles) ? { profiles: providerSettings.profiles as GufoProfile[] } : {}), ...(host.coordinator ? { coordinator: host.coordinator, ...(id === "strata" ? { leaseProfile: STRATA_PROFILE_ID } : {}) } : {}) }),
  };
}

/** Gufo with its profiles; `host.coordinator` (the app) switches the single server to the model a request names. */
export function createGufoRegistration(host: GufoHost = {}): ProviderRegistration { return registration("gufo", "Gufo", host); }
export const gufoRegistration: ProviderRegistration = createGufoRegistration();
/** Strata; `host.coordinator` (the app) makes each request hold a lease on the `strata` profile so a Gufo switch cannot kill it mid-generation. */
export function createStrataRegistration(host: GufoHost = {}): ProviderRegistration { return registration("strata", "Strata", host); }
export const strataRegistration: ProviderRegistration = createStrataRegistration();
