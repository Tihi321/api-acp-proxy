import { ApiError, contextTooLong, type Message } from "../api.js";
import type { ProviderRegistration } from "../controller.js";
import { AcpUnavailableError, ProviderAuthRequiredError, type GenerateOptions, type GenerationCallbacks, type GenerationResult, type ModelInfo, type ProviderStatus } from "../provider.js";
import { DEEPSEEK_DEFAULT_URL } from "../settings.js";
import { UsageLimitError } from "../usage-limit.js";
import { CONTEXT_ERROR, LocalOpenAiProvider, type LocalOpenAiOptions, type WireMessage } from "./local-openai.js";

/** The models offered while `/models` cannot be read (no key, no network): the flash model sees images, the pro model is text only. */
export const DEEPSEEK_MODELS: ModelInfo[] = [{ id: "deepseek-flash", name: "DeepSeek V4.1 Flash", vision: true }, { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", vision: false }];
/** The context size of both models in tokens, used when `/models` does not state one. */
export const DEEPSEEK_CONTEXT_TOKENS = 1_048_576;

const AUTH_MESSAGE = "DeepSeek API key missing or rejected — enter a valid key in Settings > DeepSeek and save.";
const UNREACHABLE_MESSAGE = "DeepSeek API is not reachable — check the network and the base URL in Settings > DeepSeek.";
const BALANCE_MESSAGE = "DeepSeek has hit its usage limit: insufficient balance. Top up at platform.deepseek.com.";
const REFRESH_MS = 60_000;
const CONTEXT_FIELDS = ["context_length", "context_window", "max_context_length"] as const;

/** The API root without a trailing `/` and without `/v1` (DeepSeek's endpoints live at the root). */
export function deepseekBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "").replace(/\/v1$/, "").replace(/\/+$/, "");
}

/** The official DeepSeek API (AAP-70): the local-openai chat path with a key, typed errors, a balance probe and the model's context as the prompt limit. */
export class DeepSeekProvider extends LocalOpenAiProvider {
  private balance: string | undefined;
  private availability: UsageLimitError | null | undefined;
  private readonly deepseekContexts = new Map<string, number>();
  private listedAt = 0;

  constructor(options: Omit<LocalOpenAiOptions, "id" | "displayName">) {
    super({ ...options, id: "deepseek", displayName: "DeepSeek" });
    this.models = DEEPSEEK_MODELS; this.listed = true;
    if (!this.apiKey) this.setState("needs_login", AUTH_MESSAGE);
  }

  protected override contextTokens(model: string): number | undefined { return this.deepseekContexts.get(model) ?? DEEPSEEK_CONTEXT_TOKENS; }

  protected override chatBody(model: string, wire: WireMessage[], options?: GenerateOptions): Record<string, unknown> {
    const body = super.chatBody(model, wire, options);
    delete body.chat_template_kwargs; // llama-server only
    return body;
  }

  protected override httpError(status: number, detail: string, response: Response): Error {
    if (status === 401 || status === 403) { this.setState("needs_login", AUTH_MESSAGE); return new ProviderAuthRequiredError(AUTH_MESSAGE); }
    if (status === 402) return new UsageLimitError(BALANCE_MESSAGE, "balance");
    if (status === 429) {
      const seconds = Number(response.headers.get("retry-after"));
      return new ApiError(429, "rate_limit_exceeded", `DeepSeek is rate limiting requests (HTTP 429); retry shortly. ${detail}`, undefined, { retryAfterSeconds: Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : 10 });
    }
    if (status === 400 || status === 422) return CONTEXT_ERROR.test(detail) ? contextTooLong(this.displayName, detail) : new ApiError(400, "invalid_request", `DeepSeek rejected the request (HTTP ${status}): ${detail}`);
    return super.httpError(status, detail, response);
  }

  protected override unreachable(cause: unknown): AcpUnavailableError {
    this.setState("error", UNREACHABLE_MESSAGE);
    return new AcpUnavailableError(UNREACHABLE_MESSAGE, cause, "provider_unreachable");
  }

  override async generate(model: string, messages: Message[], callbacks?: GenerationCallbacks, signal?: AbortSignal, options?: GenerateOptions): Promise<GenerationResult> {
    if (!this.apiKey) throw new ProviderAuthRequiredError(AUTH_MESSAGE);
    const result = await super.generate(model, messages, callbacks, signal, options);
    if (result.stopReason !== "cancelled") this.availability = null;
    return result;
  }

  /** One authenticated GET with a 5 s timeout; undefined when there was no answer. */
  private async get(path: string): Promise<{ status: number; body: unknown } | { failure: unknown }> {
    const controller = new AbortController(); this.inflight.add(controller);
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, { headers: this.headers(false), signal: controller.signal });
      const body = response.ok ? await response.json().catch(() => undefined) as unknown : (await response.body?.cancel().catch(() => undefined), undefined);
      return { status: response.status, body };
    } catch (error) { return { failure: error }; }
    finally { clearTimeout(timer); this.inflight.delete(controller); }
  }

  override async listModels(options?: { force?: boolean }): Promise<ModelInfo[]> {
    if (!this.apiKey) { this.models = DEEPSEEK_MODELS; this.listed = true; return this.models; }
    if (options?.force !== true && Date.now() - this.listedAt < REFRESH_MS) return this.models;
    const [list, balance] = await Promise.all([this.get("/models"), this.get("/user/balance")]);
    if ("status" in balance && balance.status === 200) this.readBalance(balance.body);
    if ("failure" in list) { this.unreachable(list.failure); return this.models; }
    if (list.status === 401 || list.status === 403) { this.setState("needs_login", AUTH_MESSAGE); throw new ProviderAuthRequiredError(AUTH_MESSAGE); }
    if (list.status !== 200) return this.models;
    const data = (list.body as { data?: Array<Record<string, unknown>> } | undefined)?.data;
    if (!Array.isArray(data)) return this.models;
    this.models = data.flatMap((entry) => {
      if (typeof entry.id !== "string") return [];
      const field = CONTEXT_FIELDS.map((name) => entry[name]).find((value): value is number => typeof value === "number" && value > 0);
      if (field !== undefined) this.deepseekContexts.set(entry.id, field);
      return [{ id: entry.id, vision: DEEPSEEK_MODELS.find((known) => known.id === entry.id)?.vision ?? false }];
    });
    this.listed = true; this.listedAt = Date.now();
    this.setState("ready");
    return this.models;
  }

  private readBalance(body: unknown): void {
    const parsed = body as { is_available?: unknown; balance_infos?: Array<{ total_balance?: unknown; currency?: unknown }> } | undefined;
    if (!parsed || typeof parsed.is_available !== "boolean") return;
    const infos = Array.isArray(parsed.balance_infos) ? parsed.balance_infos.filter((info) => typeof info.total_balance === "string" && typeof info.currency === "string") : [];
    this.balance = infos.length ? infos.map((info) => `${info.total_balance as string} ${info.currency as string}`).join(" + ") : undefined;
    this.availability = parsed.is_available ? null : new UsageLimitError(BALANCE_MESSAGE, "balance");
  }

  usageLimitState(): UsageLimitError | null | undefined { return this.availability; }

  override status(): ProviderStatus { return { ...super.status(), ...(this.balance ? { balance: this.balance } : {}) }; }
}

export const deepseekRegistration: ProviderRegistration = {
  id: "deepseek", displayName: "DeepSeek",
  create: ({ providerSettings, ctx }) => new DeepSeekProvider({
    baseUrl: deepseekBaseUrl(typeof providerSettings.baseUrl === "string" ? providerSettings.baseUrl : DEEPSEEK_DEFAULT_URL),
    ...(typeof providerSettings.apiKey === "string" && providerSettings.apiKey ? { apiKey: providerSettings.apiKey } : {}),
    ...(typeof providerSettings.maxPromptChars === "number" ? { maxPromptChars: providerSettings.maxPromptChars } : {}),
    logger: ctx.logger.child("deepseek"),
  }),
};
