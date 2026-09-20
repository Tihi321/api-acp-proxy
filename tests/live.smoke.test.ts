import { describe, expect, it } from "vitest";

describe.skipIf(!process.env.RUN_LIVE_SMOKE)("live ACP smoke", () => {
  it("generates through the running local proxy", async () => {
    const baseUrl = process.env.PROXY_SMOKE_URL || "http://127.0.0.1:8787";
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (process.env.PROXY_API_KEY) headers.authorization = `Bearer ${process.env.PROXY_API_KEY}`;
    const response = await fetch(`${baseUrl}/v1/responses`, { method: "POST", headers, body: JSON.stringify({ model: "gpt-5.6-sol", input: "Reply with the word hello." }) });
    expect(response.ok).toBe(true);
    const body = await response.json() as { output?: Array<{ content?: Array<{ text?: string }> }> };
    expect(body.output?.[0]?.content?.[0]?.text).toBeTruthy();
  }, 300_000);
});
