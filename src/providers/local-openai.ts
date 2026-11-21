import type { StopReason, Usage } from "@agentclientprotocol/sdk";
import { messageText, type Message } from "../api.js";
import type { ProviderRegistration } from "../controller.js";
import type { Logger } from "../logger.js";
import { AcpUnavailableError, type GenerateOptions, type GenerationCallbacks, type GenerationResult, type ModelInfo, type Provider, type ProviderState, type ProviderStatus } from "../provider.js";

export interface LocalOpenAiOptions {
  id: "gufo" | "strata"; displayName: string;
  /** "http://127.0.0.1:<port>/v1" */
  baseUrl: string;
  apiKey?: string; logger: Logger;
  /** Default `globalThis.fetch`, not the Electron `net.fetch` of the runtime context (see `registration`). */
  fetch?: typeof fetch;
}

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
    catch (error) { throw this.notRunning(error); }
    finally { clearTimeout(timer); this.inflight.delete(controller); }
    if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw new AcpUnavailableError(`${this.displayName} answered HTTP ${response.status}`, undefined, "upstream_error"); }
    const body = await response.json().catch(() => undefined) as { data?: Array<{ id?: unknown }> } | undefined;
    this.models = (body?.data ?? []).flatMap((entry) => typeof entry.id === "string" ? [{ id: entry.id }] : []);
    this.setState("ready");
    return this.models;
  }

  async generate(model: string, messages: Message[], callbacks?: GenerationCallbacks, signal?: AbortSignal, options?: GenerateOptions): Promise<GenerationResult> {
    const wire: Array<{ role: "system" | "user" | "assistant"; content: string }> = [];
    if (options?.instructions) wire.push({ role: "system", content: options.instructions });
    for (const message of messages) wire.push({ role: message.role === "developer" ? "system" : message.role === "tool" ? "user" : message.role, content: messageText(message) });

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

  async login(): Promise<void> { /* a local server has no login */ }

  async close(): Promise<void> {
    for (const controller of this.inflight) controller.abort();
    this.inflight.clear(); this.listeners.clear();
  }
}

function registration(id: "gufo" | "strata", displayName: string): ProviderRegistration {
  return {
    id, displayName,
    // Node's global fetch on purpose, not ctx.fetch (Electron net.fetch): Strata refuses a POST that carries a browser Origin header.
    create: ({ providerSettings, ctx }) => new LocalOpenAiProvider({ id, displayName, baseUrl: `http://127.0.0.1:${providerSettings.port as number}/v1`, ...(typeof providerSettings.apiKey === "string" && providerSettings.apiKey ? { apiKey: providerSettings.apiKey } : {}), logger: ctx.logger.child(id) }),
  };
}

export const gufoRegistration: ProviderRegistration = registration("gufo", "Gufo");
export const strataRegistration: ProviderRegistration = registration("strata", "Strata");
