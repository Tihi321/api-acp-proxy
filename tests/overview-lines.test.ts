import { describe, expect, it } from "vitest";
import { localProviderLine, overviewFocusTarget, todayUsageLine } from "../src/renderer/overview-lines.js";
import type { LocalServerStatusView, ProviderStatusView, UsageCountsView } from "../src/shared/ipc.js";

const counts = (patch: Partial<UsageCountsView>): UsageCountsView => ({ requests: 0, errors: 0, inputTokens: 0, outputTokens: 0, estimated: 0, cachedTokens: 0, reasoningTokens: 0, costUsd: 0, ...patch });
const status = (state: ProviderStatusView["state"], error?: string): ProviderStatusView => ({ id: "x", name: "X", state, models: [], authMethods: [], ...(error ? { error } : {}) }) as unknown as ProviderStatusView;
const launcher = (id: LocalServerStatusView["id"], state: LocalServerStatusView["state"], port?: number): LocalServerStatusView => ({ id, name: id, state, log: [], ...(port ? { port } : {}) });

describe("overview lines", () => {
  it("builds the Today line and the state line of the local rows", () => {
    expect(todayUsageLine(counts({ requests: 3, inputTokens: 900, outputTokens: 300, errors: 1, costUsd: 0.0004224 }), String)).toBe("Today: 3 requests · 1200 tokens · 1 error · $0.00042");
    expect(todayUsageLine(counts({ requests: 0 }))).toBeUndefined();
    const base = { serverRunning: true, ollamaUrl: "http://localhost:11434" };
    expect(localProviderLine({ ...base, id: "gufo", status: status("ready"), launcher: launcher("gufo", "ready", 8090), profileLabel: "Qwen 27B" })).toBe("Running Qwen 27B on port 8090.");
    expect(localProviderLine({ ...base, id: "strata", status: status("stopped"), launcher: launcher("strata", "stopped") })).toBe("Stopped. Start it on its page.");
    expect(localProviderLine({ ...base, id: "ollama", status: status("ready") })).toBe("Reachable at http://localhost:11434.");
    expect(localProviderLine({ ...base, id: "ollama", status: status("stopped", "Ollama is not running or not reachable at x") })).toBe("Ollama is not running or not reachable at x");
    expect(localProviderLine({ ...base, id: "llama", status: status("disabled") })).toBe("Off. Turn it on on its page.");
  });

  it("keeps focus on the same enabled button, falls back to the row's Settings button, else none", () => {
    const buttons = [{ key: "codex:login", disabled: true }, { key: "codex:logout", disabled: false }, { key: "codex:settings", disabled: false }];
    expect(overviewFocusTarget("codex:logout", buttons)).toBe("codex:logout");
    expect(overviewFocusTarget("codex:login", buttons)).toBe("codex:settings");
    expect(overviewFocusTarget(undefined, buttons)).toBeUndefined();
  });
});
