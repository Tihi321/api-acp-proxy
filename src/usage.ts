import type { GenerationResult } from "./provider.js";

export const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number { return Math.ceil(text.length / CHARS_PER_TOKEN); }

export interface OpenAiUsage { prompt: number; completion: number; total: number; cached: number; reasoning: number; }

/** Agent-reported usage when present (OpenAI `prompt` includes cached tokens), otherwise an estimate from the prompt and returned text. */
export function openAiUsage(result: GenerationResult, promptText: string): OpenAiUsage {
  const usage = result.usage;
  if (!usage) { const prompt = estimateTokens(promptText); const completion = estimateTokens(result.text); return { prompt, completion, total: prompt + completion, cached: 0, reasoning: 0 }; }
  const prompt = usage.inputTokens + (usage.cachedReadTokens ?? 0) + (usage.cachedWriteTokens ?? 0);
  return { prompt, completion: usage.outputTokens, total: prompt + usage.outputTokens, cached: usage.cachedReadTokens ?? 0, reasoning: usage.thoughtTokens ?? 0 };
}

export function chatUsage(result: GenerationResult, promptText: string): Record<string, unknown> {
  const u = openAiUsage(result, promptText);
  return { prompt_tokens: u.prompt, completion_tokens: u.completion, total_tokens: u.total, prompt_tokens_details: { cached_tokens: u.cached }, completion_tokens_details: { reasoning_tokens: u.reasoning } };
}

export function responsesUsage(result: GenerationResult, promptText: string): Record<string, unknown> {
  const u = openAiUsage(result, promptText);
  return { input_tokens: u.prompt, input_tokens_details: { cached_tokens: u.cached }, output_tokens: u.completion, output_tokens_details: { reasoning_tokens: u.reasoning }, total_tokens: u.total };
}
