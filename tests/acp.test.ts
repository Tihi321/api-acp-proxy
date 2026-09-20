import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AcpBridge, AcpUnavailableError } from "../src/acp.js";
import type { ProxyConfig } from "../src/config.js";

const node = process.execPath;
const fixture = fileURLToPath(new URL("./fixtures/fake-acp.mjs", import.meta.url));
const base: ProxyConfig = { host: "127.0.0.1", port: 0, maxBodyBytes: 1024, timeoutMs: 5000, workRoot: path.resolve(".codex/temp/acp-tests"), acpCommand: node, acpArgs: [fixture] };
const bridges: AcpBridge[] = [];
afterEach(async () => { await Promise.all(bridges.splice(0).map((bridge) => bridge.close())); });

describe("ACP bridge", () => {
  it("selects models, streams text, maps usage, and disposes sessions", async () => {
    const bridge = new AcpBridge(base); bridges.push(bridge); const chunks: string[] = [];
    const result = await bridge.generate("gpt-5.6-terra", [{ role: "user", content: "hello" }], { onText: (chunk) => chunks.push(chunk) });
    expect(chunks.join("")).toBe("fake response"); expect(result.usage?.totalTokens).toBe(3); expect(result.stopReason).toBe("end_turn");
  });
  it("cancels an abandoned request", async () => {
    const bridge = new AcpBridge({ ...base, acpArgs: [fixture], timeoutMs: 5000 }); bridges.push(bridge); const abort = new AbortController();
    process.env.FAKE_ACP_DELAY = "1";
    const promise = bridge.generate("gpt-5.6-sol", [{ role: "user", content: "hello" }], {}, abort.signal); setTimeout(() => abort.abort(), 150);
    const result = await promise; expect(result.stopReason).toBe("cancelled"); delete process.env.FAKE_ACP_DELAY;
  });
  it("rejects ACP permission requests", async () => {
    const bridge = new AcpBridge(base); bridges.push(bridge); process.env.FAKE_ACP_REQUIRE_PERMISSION = "1";
    const result = await bridge.generate("gpt-5.6-sol", [{ role: "user", content: "hello" }]);
    expect(result.text).toBe("fake response"); delete process.env.FAKE_ACP_REQUIRE_PERMISSION;
  });
  it("recovers child spawn failures as availability errors", async () => {
    const bridge = new AcpBridge({ ...base, acpCommand: path.join(path.dirname(node), "does-not-exist"), acpArgs: [] }); bridges.push(bridge);
    await expect(bridge.generate("gpt-5.6-sol", [{ role: "user", content: "hello" }])).rejects.toBeInstanceOf(AcpUnavailableError);
  });
});
