import { describe, expect, it } from "vitest";
import { CHARS_PER_TOKEN, chatUsage, estimateTokens, openAiUsage, responsesUsage } from "../src/usage.js";

describe("usage", () => {
  it("estimates about 4 characters per token, rounding up", () => {
    expect(CHARS_PER_TOKEN).toBe(4); expect(estimateTokens("")).toBe(0); expect(estimateTokens("abcd")).toBe(1); expect(estimateTokens("abcde")).toBe(2);
  });
  it("maps codex-style usage (input excludes cached) and reasoning tokens", () => {
    const result = { text: "x", stopReason: "end_turn" as const, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 35, cachedReadTokens: 20, thoughtTokens: 3 } };
    expect(openAiUsage(result, "p")).toEqual({ prompt: 30, completion: 5, total: 35, cached: 20, reasoning: 3 });
    expect(chatUsage(result, "p")).toEqual({ prompt_tokens: 30, completion_tokens: 5, total_tokens: 35, prompt_tokens_details: { cached_tokens: 20 }, completion_tokens_details: { reasoning_tokens: 3 } });
    expect(responsesUsage(result, "p")).toEqual({ input_tokens: 30, input_tokens_details: { cached_tokens: 20 }, output_tokens: 5, output_tokens_details: { reasoning_tokens: 3 }, total_tokens: 35 });
  });
  it("maps claude-style usage with cache read and write", () => {
    const result = { text: "x", stopReason: "end_turn" as const, usage: { inputTokens: 4, outputTokens: 6, totalTokens: 20, cachedReadTokens: 7, cachedWriteTokens: 3 } };
    expect(openAiUsage(result, "p")).toEqual({ prompt: 14, completion: 6, total: 20, cached: 7, reasoning: 0 });
  });
  it("estimates from the prompt and the returned text when the agent reports nothing", () => {
    expect(openAiUsage({ text: "12345678", stopReason: "end_turn", usage: null }, "abcdefghi")).toEqual({ prompt: 3, completion: 2, total: 5, cached: 0, reasoning: 0 });
  });
});
