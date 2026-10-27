import { afterAll, afterEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { ActivityLog } from "../src/activity.js";
import type { AcpLike } from "../src/acp.js";
import type { ProxyConfig } from "../src/config.js";
import { PLAYGROUND_CSP, servePlayground } from "../src/playground-files.js";
import { chatTitle, curlFor, formatMs, groupModels, isHttpUrl, parseSseLines } from "../src/playground/lib.js";
import { createProxyServer } from "../src/server.js";

describe("playground helpers", () => {
  it("groups models by provider and shows an unprefixed twin once, prefixed", () => {
    const ids = ["gpt-6-luna", "codex/gpt-6-luna", "gpt-5.6-terra", "codex/gpt-5.6-terra", "antigravity/gemini-4-argon", "solo"];
    expect(groupModels(ids)).toEqual([
      { provider: "codex", models: ["codex/gpt-6-luna", "codex/gpt-5.6-terra"] },
      { provider: "antigravity", models: ["antigravity/gemini-4-argon"] },
      { provider: "other", models: ["solo"] },
    ]);
    expect(groupModels([])).toEqual([]);
  });

  it("parses SSE data lines across chunk boundaries", () => {
    const first = parseSseLines('data: {"a":1}\n\ndata: {"b"');
    expect(first).toEqual({ events: ['{"a":1}'], rest: 'data: {"b"' });
    const second = parseSseLines(`${first.rest}:2}\r\n\r\ndata: [DONE]\n\n`);
    expect(second).toEqual({ events: ['{"b":2}', "[DONE]"], rest: "" });
    expect(parseSseLines(": comment\nevent: x\n").events).toEqual([]);
  });

  it("builds a curl command without the key and with shell-safe quoting", () => {
    const body = { model: "codex/gpt-6-luna", messages: [{ role: "user", content: "it's" }] };
    const withKey = curlFor("http://127.0.0.1:8787/v1", body, true);
    expect(withKey).toContain("'http://127.0.0.1:8787/v1/chat/completions'");
    expect(withKey).toContain('Authorization: Bearer $ACP_PROXY_KEY');
    expect(withKey).toContain(`it'\\''s`);
    expect(curlFor("http://127.0.0.1:8787/v1", body, false)).not.toContain("Authorization");
  });

  it("titles, times and links", () => {
    expect(chatTitle("  hello\n  world ")).toBe("hello world");
    expect(chatTitle("")).toBe("New chat");
    expect(chatTitle("x".repeat(60), 10)).toBe(`${"x".repeat(9)}…`);
    expect(formatMs(850)).toBe("850 ms");
    expect(formatMs(3240)).toBe("3.2 s");
    expect(formatMs(65_000)).toBe("1 min 5 s");
    expect(isHttpUrl("https://example.com/a")).toBe(true);
    expect(isHttpUrl("javascript:alert(1)")).toBe(false);
    expect(isHttpUrl("not a url")).toBe(false);
  });
});

const root = path.resolve(".claude/temp/playground-tests", String(process.pid));
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

let servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); })));
  servers = [];
});
async function listen(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}
function get(port: number, pathname: string, method = "GET"): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: pathname, method }, (res) => {
      const chunks: Buffer[] = []; res.on("data", (chunk) => chunks.push(Buffer.from(chunk))); res.on("end", () => resolve({ status: res.statusCode || 0, headers: res.headers, text: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject); req.end();
  });
}

describe("serving the playground", () => {
  it("serves the page and its fixed files with a strict CSP, and nothing else", async () => {
    const dir = path.join(root, "built");
    mkdirSync(dir, { recursive: true });
    for (const [name, body] of [["playground.html", "<!doctype html>page"], ["playground.js", "js"], ["lib.js", "lib"], ["playground.css", "css"], ["secret.txt", "no"]]) writeFileSync(path.join(dir, name), body);
    const port = await listen(createServer((req, res) => { void servePlayground(req.method ?? "GET", new URL(req.url ?? "/", "http://x").pathname, res, dir).then((handled) => { if (!handled) { res.writeHead(418); res.end(); } }); }));
    const page = await get(port, "/playground");
    expect(page).toMatchObject({ status: 200, text: "<!doctype html>page" });
    expect(page.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(page.headers["content-security-policy"]).toBe(PLAYGROUND_CSP);
    expect(page.headers["x-content-type-options"]).toBe("nosniff");
    expect(page.headers["cache-control"]).toBe("no-store");
    expect(await get(port, "/playground/playground.js")).toMatchObject({ status: 200, text: "js" });
    expect((await get(port, "/playground/playground.css")).headers["content-type"]).toBe("text/css; charset=utf-8");
    expect((await get(port, "/playground/secret.txt")).status).toBe(404);
    expect((await get(port, "/playground/../package.json")).status).not.toBe(200);
    expect((await get(port, "/playground", "POST")).status).toBe(405);
    expect((await get(port, "/v1/models")).status).toBe(418); // not ours
  });

  it("answers before the API key check and is not logged as activity", async () => {
    const config: ProxyConfig = { host: "127.0.0.1", port: 0, maxBodyBytes: 100_000, timeoutMs: 5000, workRoot: path.join(root, "work"), acpArgs: [], apiKey: "secret" };
    const bridge: AcpLike = { generate: async () => ({ text: "", stopReason: "end_turn" }), hasModel: () => true, listModels: async () => [] };
    const activity = new ActivityLog();
    const port = await listen(createProxyServer(config, bridge, { activity }));
    const missing = await get(port, "/playground/unknown.js");
    expect(missing.status).toBe(404);
    expect(missing.headers["content-security-policy"]).toBe(PLAYGROUND_CSP);
    expect((await get(port, "/v1/models")).status).toBe(401);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(activity.list().map((entry) => entry.endpoint)).toEqual(["GET /v1/models"]);
  });
});
