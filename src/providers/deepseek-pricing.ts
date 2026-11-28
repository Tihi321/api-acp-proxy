import type { Usage } from "@agentclientprotocol/sdk";

/** USD per 1M tokens. */
export interface TokenPrices { hit: number; miss: number; output: number }

/** Checked 2026-11-28 at api-docs.deepseek.com. Peak = Mon-Fri 01:00-04:00 and 06:00-10:00 UTC; Chinese public holidays are ignored (a weekday holiday is priced as a normal weekday). */
export const DEEPSEEK_PRICES: Record<string, { offPeak: TokenPrices; peak: TokenPrices }> = {
  "deepseek-flash": { offPeak: { hit: 0.003, miss: 0.15, output: 0.6 }, peak: { hit: 0.006, miss: 0.3, output: 1.2 } },
  "deepseek-v4-pro": { offPeak: { hit: 0.022, miss: 0.66, output: 1.98 }, peak: { hit: 0.044, miss: 1.32, output: 3.96 } },
};

/** Older ids that DeepSeek prices as the flash model. */
export const DEEPSEEK_PRICE_ALIASES: Record<string, string> = { "deepseek-v4-flash": "deepseek-flash", "deepseek-v4-flash-vision-exp": "deepseek-flash" };

/** Peak windows as [start hour, end hour) in UTC, Monday to Friday. */
export const DEEPSEEK_PEAK_WINDOWS_UTC: ReadonlyArray<[startHour: number, endHour: number]> = [[1, 4], [6, 10]];

export function isDeepSeekPeak(at: Date): boolean {
  const day = at.getUTCDay();
  if (day < 1 || day > 5) return false;
  const hour = at.getUTCHours();
  return DEEPSEEK_PEAK_WINDOWS_UTC.some(([start, end]) => hour >= start && hour < end);
}

/** The price in USD of one call: cache hit tokens, cache miss tokens (`usage.inputTokens` is the prompt without the cached part) and output tokens (reasoning included). Undefined for a model without a price. */
export function deepseekCostUsd(model: string, usage: Usage, at: Date): number | undefined {
  const row = DEEPSEEK_PRICES[DEEPSEEK_PRICE_ALIASES[model] ?? model];
  if (!row) return undefined;
  const price = isDeepSeekPeak(at) ? row.peak : row.offPeak;
  const count = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
  return (count(usage.cachedReadTokens) * price.hit + count(usage.inputTokens) * price.miss + count(usage.outputTokens) * price.output) / 1e6;
}
