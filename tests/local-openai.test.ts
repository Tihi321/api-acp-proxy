import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import OpenAI from "openai";
import type { ProxyConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { LocalOpenAiProvider } from "../src/providers/local-openai.js";
import { ProviderRouter } from "../src/router.js";
import { createProxyServer } from "../src/server.js";

const config: ProxyConfig = { host: "127.0.0.1", port: 0, maxBodyBytes: 1024 * 1024, timeoutMs: 5000, workRoot: ".claude/temp/local-openai-tests", acpArgs: [] };
mkdirSync(path.resolve(config.workRoot), { recursive: true });
const logger = createLogger({ console: false });

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }))); });

async function listen(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}
async function serve(router: ProviderRouter): Promise<string> { return `http://127.0.0.1:${await listen(createProxyServer(config, router))}/v1`; }

describe("LocalOpenAiProvider", () => {
  it("streams a gufo/ model through the proxy with the upstream usage and lists only the prefixed id", async () => {
    const upstream = createServer((request, response) => {
      if (request.method === "GET" && request.url === "/v1/models") { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ data: [{ id: "Qwen3.8-27B" }] })); return; }
      if (request.method === "POST" && request.url === "/v1/chat/completions") {
        response.setHeader("content-type", "text/event-stream");
        const delta = (content: string) => ({ choices: [{ delta: { content } }] });
        for (const chunk of [delta("Hel"), delta("lo"), delta("!"), { choices: [{ delta: {}, finish_reason: "stop" }] }, { choices: [], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }]) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
        response.end("data: [DONE]\n\n"); return;
      }
      response.statusCode = 404; response.end();
    });
    const port = await listen(upstream);
    const router = new ProviderRouter({ providers: [new LocalOpenAiProvider({ id: "gufo", displayName: "Gufo", baseUrl: `http://127.0.0.1:${port}/v1`, logger })] });
    const client = new OpenAI({ baseURL: await serve(router), apiKey: "test" });

    const stream = await client.chat.completions.create({ model: "gufo/Qwen3.8-27B", messages: [{ role: "user", content: "hi" }], stream: true, stream_options: { include_usage: true } });
    let text = ""; let completionTokens: number | undefined;
    for await (const chunk of stream) { text += chunk.choices[0]?.delta?.content ?? ""; if (chunk.usage) completionTokens = chunk.usage.completion_tokens; }
    expect(text).toBe("Hello!");
    expect(completionTokens).toBe(3);

    const listed = (await client.models.list()).data.map((model) => model.id);
    expect(listed).toContain("gufo/Qwen3.8-27B");
    expect(listed).not.toContain("Qwen3.8-27B");
  });

  it("answers 503 local_server_not_running when the upstream port is closed", async () => {
    const probe = createServer();
    const port = await listen(probe);
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    servers.length = 0;
    const router = new ProviderRouter({ providers: [new LocalOpenAiProvider({ id: "strata", displayName: "Strata", baseUrl: `http://127.0.0.1:${port}/v1`, logger })] });
    const base = await serve(router);

    const res = await fetch(`${base}/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "strata/any", messages: [{ role: "user", content: "hi" }] }) });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: "local_server_not_running", message: "Strata is not running — start it from the app." } });
  });
});
