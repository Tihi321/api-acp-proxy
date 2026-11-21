import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ProxyConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { LocalOpenAiProvider } from "../src/providers/local-openai.js";
import { ProviderRouter } from "../src/router.js";
import { createProxyServer } from "../src/server.js";
import type { LlamaProfile } from "../src/settings.js";

const servers: Server[] = [];
afterEach(async () => { for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve())); });

const MODEL = "llama/nomic-embed-text-v1.5";
const chatProfile = { id: "chat", label: "Chat", model: "chat", vision: false, modelFile: "chat.gguf", gpuLayers: "auto", flashAttn: "auto", specType: "none", extraArgs: "" } as LlamaProfile;
const vector = (seed: number): number[] => Array.from({ length: 768 }, (_, index) => (index + seed) / 1000);

/** A proxy with the llama provider whose embedding server is a fake `fetch`; `upstream` sees every call to it. */
async function start(upstream: (url: string, body: { model?: string; input?: string[] }) => Response): Promise<{ base: string; calls: Array<{ url: string; body: { model?: string; input?: string[] } }> }> {
  const calls: Array<{ url: string; body: { model?: string; input?: string[] } }> = [];
  const fakeFetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    if (!url.endsWith("/v1/embeddings")) return new Response("{}", { status: 200 });
    const body = JSON.parse(String(init?.body)) as { model?: string; input?: string[] };
    calls.push({ url, body });
    return upstream(url, body);
  }) as typeof fetch;
  const provider = new LocalOpenAiProvider({
    id: "llama", displayName: "Llama.cpp", baseUrl: "http://127.0.0.1:8082/v1", logger: createLogger(), fetch: fakeFetch, profiles: [chatProfile],
    embedding: { enabled: true, model: "nomic-embed-text-v1.5", port: 8083, maxConcurrent: 2 },
  });
  const config: ProxyConfig = { host: "127.0.0.1", port: 0, maxBodyBytes: 1024 * 1024, timeoutMs: 10_000, workRoot: ".", acpArgs: [] };
  const server = createProxyServer(config, new ProviderRouter({ providers: [provider] }));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls };
}
async function post(base: string, route: string, body: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(`${base}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json().catch(() => undefined) };
}

describe("POST /v1/embeddings (llama embedding server)", () => {
  it("answers the OpenAI shape in input order and refuses what it cannot do", async () => {
    // The fake returns the second vector first to prove the proxy orders by index.
    const { base, calls } = await start((_url, body) => Response.json({ object: "list", model: body.model, data: body.input!.map((_item, index) => ({ object: "embedding", index, embedding: vector(index + 1) })).reverse(), usage: { prompt_tokens: 7, total_tokens: 7 } }));

    const one = await post(base, "/v1/embeddings", { model: MODEL, input: "search_document: The lighthouse keeper counted ships." });
    expect(one.status).toBe(200);
    expect(one.body).toMatchObject({ object: "list", model: MODEL, usage: { prompt_tokens: 7, total_tokens: 7 } });
    expect(one.body.data).toHaveLength(1);
    expect(one.body.data[0]).toMatchObject({ object: "embedding", index: 0 });
    expect(one.body.data[0].embedding).toEqual(vector(1));
    expect(calls[0]).toEqual({ url: "http://127.0.0.1:8083/v1/embeddings", body: { model: "nomic-embed-text-v1.5", input: ["search_document: The lighthouse keeper counted ships."] } });

    const two = await post(base, "/v1/embeddings", { model: MODEL, input: ["search_query: who counted ships", "search_document: Rain on the salt line."] });
    expect(two.status).toBe(200);
    expect(two.body.data.map((item: { index: number; embedding: number[] }) => [item.index, item.embedding[0]])).toEqual([[0, 0.001], [1, 0.002]]);
    expect(calls[1]!.body.input).toEqual(["search_query: who counted ships", "search_document: Rain on the salt line."]);

    const refused: Array<[string, unknown, number, string]> = [
      ["base64", { model: MODEL, input: "x", encoding_format: "base64" }, 400, "unsupported_parameter"],
      ["dimensions", { model: MODEL, input: "x", dimensions: 256 }, 400, "unsupported_parameter"],
      ["empty array", { model: MODEL, input: [] }, 400, "invalid_request"],
      ["empty item", { model: MODEL, input: ["a", ""] }, 400, "invalid_request"],
      ["too many items", { model: MODEL, input: Array.from({ length: 257 }, () => "x") }, 400, "invalid_request"],
      ["a chat model", { model: "llama/chat", input: "x" }, 400, "model_not_capable"],
      ["an unknown model", { model: "llama/nope", input: "x" }, 404, "model_not_found"],
    ];
    for (const [name, body, status, code] of refused) {
      const answer = await post(base, "/v1/embeddings", body);
      expect([name, answer.status, answer.body?.error?.code]).toEqual([name, status, code]);
    }
    expect(calls).toHaveLength(2); // nothing refused reached the embedding server

    // The embedding model is not a chat model, and it is listed as one of its own kind.
    const chat = await post(base, "/v1/chat/completions", { model: MODEL, messages: [{ role: "user", content: "hi" }] });
    expect([chat.status, chat.body.error.code]).toEqual([400, "model_not_capable"]);
    const models = await (await fetch(`${base}/v1/models`)).json() as { data: Array<{ id: string; kind?: string }> };
    expect(models.data.find((model) => model.id === MODEL)).toMatchObject({ kind: "embedding" });
    expect(models.data.find((model) => model.id === "llama/chat")).toMatchObject({ kind: "llm" });
    const health = await (await fetch(`${base}/healthz`)).json() as { providers: Record<string, { active: number; queued: number; max_concurrent: number }> };
    expect(health.providers["llama-embed"]).toMatchObject({ active: 0, queued: 0, max_concurrent: 2 });
  });

  it("answers 503 local_server_not_running when nothing listens on the embedding port", async () => {
    const { base } = await start(() => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }); });
    const answer = await post(base, "/v1/embeddings", { model: MODEL, input: "x" });
    expect([answer.status, answer.body.error.code]).toEqual([503, "local_server_not_running"]);
    expect(answer.body.error.message).toContain("Embeddings are not running");
  });
});
