import { describe, expect, it } from "vitest";
import { deepseekCostUsd, isDeepSeekPeak } from "../src/providers/deepseek-pricing.js";

describe("DeepSeek pricing", () => {
  it("prices peak and off-peak by UTC weekday window, aliases legacy ids and skips unknown models", () => {
    // 2026-11-30 is a Monday, 2026-12-04 a Friday, 2026-12-05 a Saturday.
    expect(isDeepSeekPeak(new Date(Date.UTC(2026, 10, 30, 1, 0)))).toBe(true);
    expect(isDeepSeekPeak(new Date(Date.UTC(2026, 10, 30, 4, 0)))).toBe(false);
    expect(isDeepSeekPeak(new Date(Date.UTC(2026, 11, 4, 9, 59)))).toBe(true);
    expect(isDeepSeekPeak(new Date(Date.UTC(2026, 11, 5, 2, 0)))).toBe(false);

    const usage = { inputTokens: 600, cachedReadTokens: 400, outputTokens: 200, totalTokens: 1200 };
    const peak = new Date(Date.UTC(2026, 11, 1, 2, 0));
    const offPeak = new Date(Date.UTC(2026, 11, 1, 5, 0));
    expect(deepseekCostUsd("deepseek-flash", usage, peak)).toBeCloseTo(0.0004224, 10);
    expect(deepseekCostUsd("deepseek-flash", usage, offPeak)).toBeCloseTo(0.0002112, 10);
    expect(deepseekCostUsd("deepseek-v4-flash", usage, peak)).toBeCloseTo(0.0004224, 10);
    expect(deepseekCostUsd("deepseek-v4-flash-vision-exp", usage, offPeak)).toBeCloseTo(0.0002112, 10);
    expect(deepseekCostUsd("not-a-model", usage, peak)).toBeUndefined();
  });
});
