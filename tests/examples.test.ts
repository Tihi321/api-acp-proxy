import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { createProxyServer } from "../src/server.js";
import type { AcpLike } from "../src/acp.js";
import type { TextMessage } from "../src/api.js";
import type { ProxyConfig } from "../src/config.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const config: ProxyConfig = {
  host: "127.0.0.1",
  port: 0,
  maxBodyBytes: 1024 * 1024,
  timeoutMs: 5000,
  workRoot: ".codex/temp/example-tests",
  acpArgs: [],
  apiKey: "secret",
};

type RecordedCall = TextMessage[];
let calls: RecordedCall[] = [];
let server: ReturnType<typeof createProxyServer> | undefined;

const fake: AcpLike = {
  async generate(_model, messages, callbacks) {
    calls.push(messages.map((message) => ({ ...message })));
    const last = messages.at(-1)?.content;
    if (last === "bad request") throw new Error("synthetic request failure");
    callbacks?.onText?.("streamed response");
    return {
      text: `reply-${calls.length}`,
      stopReason: "end_turn",
      usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
    };
  },
};

async function startServer(): Promise<string> {
  server = createProxyServer(config, fake);
  await new Promise<void>((resolveListen) => server?.listen(0, config.host, resolveListen));
  const address = server.address() as AddressInfo;
  return `http://${config.host}:${address.port}`;
}

async function runExample(name: string, input = ""): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const proxyUrl = await startServer();
  return await new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [`examples/${name}.js`], {
      cwd: root,
      env: { ...process.env, PROXY_URL: proxyUrl, PROXY_API_KEY: "secret", PROXY_MODEL: "gpt-5.6-sol" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const timeout = setTimeout(() => child.kill(), 10000);
    child.once("error", reject);
    child.once("close", (code) => { clearTimeout(timeout); resolveRun({ code, stdout, stderr }); });
    child.stdin.end(input);
  });
}

afterEach(async () => {
  calls = [];
  if (server) await new Promise<void>((resolveClose) => server?.close(() => resolveClose()));
  server = undefined;
});

describe("JavaScript examples", () => {
  it("runs the basic example against the fake bridge", async () => {
    const result = await runExample("basic");
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Health: ok");
    expect(result.stdout).toContain("Models: gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna");
    expect(result.stdout).toContain("Chat: reply-1");
    expect(result.stdout).toContain("Response: reply-2");
  });

  it("prints text from both streaming examples", async () => {
    const result = await runExample("streaming");
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Chat stream:\nstreamed response");
    expect(result.stdout).toContain("Responses stream:\nstreamed response");
  });

  it("keeps successful chatbot turns, clears them, and exits", async () => {
    const result = await runExample("chatbot", "\nfirst\nsecond\n/clear\nthird\n/quit\n");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Please enter a message.");
    expect(result.stdout).toContain("Assistant: reply-1");
    expect(result.stdout).toContain("Assistant: reply-2");
    expect(result.stdout).toContain("Conversation cleared.");
    expect(result.stdout).toContain("Assistant: reply-3");
    expect(result.stdout).toContain("Goodbye.");
    expect(calls).toEqual([
      [{ role: "user", content: "first" }],
      [
        { role: "user", content: "first" },
        { role: "assistant", content: "reply-1" },
        { role: "user", content: "second" },
      ],
      [{ role: "user", content: "third" }],
    ]);
  });

  it("does not retain a failed chatbot request", async () => {
    const result = await runExample("chatbot", "first\nbad request\nthird\n/exit\n");
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("Request failed:");
    expect(calls.at(-1)).toEqual([
      { role: "user", content: "first" },
      { role: "assistant", content: "reply-1" },
      { role: "user", content: "third" },
    ]);
  });
});
