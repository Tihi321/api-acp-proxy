import { afterAll, afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AcpProvider } from "../src/acp-provider.js";
import { ProxyController, type ProviderRegistration } from "../src/controller.js";
import { createLogger } from "../src/logger.js";
import { parseClaudeUsage, parseCodexStatus, redactLimitsText } from "../src/plan-limits.js";
import { codexDescriptor } from "../src/providers/codex.js";
import { defaultSettings, mergeSettings } from "../src/settings.js";

const fixture = fileURLToPath(new URL("./fixtures/fake-acp.mjs", import.meta.url));
const root = path.resolve(".claude/temp/plan-limits-tests", String(process.pid));
mkdirSync(root, { recursive: true });
let counter = 0;
const controllers: ProxyController[] = [];
afterEach(async () => {
  await Promise.all(controllers.splice(0).map((controller) => controller.stop()));
  for (const key of Object.keys(process.env)) if (key.startsWith("FAKE_ACP_")) delete process.env[key];
});
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

const codexSample = [
  "**Model:** gpt-6-luna",
  "**Directory:** C:\\Temp\\request-abc",
  "**Approval:** never",
  "**Sandbox:** read-only",
  "**Account:** ChatGPT plus (someone@example.com)",
  "**Session:** `019a-test`",
  "",
  "**Token usage:** data not available yet",
  "**Context window:** data not available yet",
  "**5h limit:** 66% left (resets 15:00)",
  "**Weekly limit:** 91% left (resets 09:30 on 12 Nov)",
  "**Credits:** unlimited",
].join("  \n");
const claudeSample = [
  "## Usage", "", "> Claude max subscription usage", "", "### Limits", "",
  "**5-hour limit** — **34%** · Resets Nov 8, 3:00 PM GMT+1", "", "`███████░░░░░░░░░░░░░`", "",
  "**Weekly · all models** — **12%** · Resets Nov 12, 9:00 AM GMT+1", "", "`██░░░░░░░░░░░░░░░░░░`", "",
  "**Weekly · Opus** — **0%**", "", "`░░░░░░░░░░░░░░░░░░░░`", "",
  "---", "", "### This session", "", "| Cost | API time | Active |", "|:--|:--|:--|", "| $0.42 | 3s | 5s |",
].join("\n");

describe("plan limit parsers", () => {
  it("parses Codex /status into used percentages, plan and credits, without the e-mail", () => {
    const parsed = parseCodexStatus(codexSample);
    expect(parsed).toEqual({
      windows: [{ label: "5h limit", usedPercent: 34, resetText: "15:00" }, { label: "Weekly limit", usedPercent: 9, resetText: "09:30 on 12 Nov" }],
      plan: "ChatGPT plus",
      credits: "unlimited",
    });
    expect(JSON.stringify(parsed)).not.toContain("someone@example.com");
    const noData = codexSample.split("  \n").slice(0, -3).concat("**Limits:** data not available yet").join("  \n");
    expect(parseCodexStatus(noData)?.windows).toEqual([]);
    expect(parseCodexStatus("hello")).toBeUndefined();
  });

  it("parses Claude /usage windows and plan, and redaction drops the cost and e-mail", () => {
    expect(parseClaudeUsage(claudeSample)).toEqual({
      windows: [
        { label: "5-hour limit", usedPercent: 34, resetText: "Nov 8, 3:00 PM GMT+1" },
        { label: "Weekly · all models", usedPercent: 12, resetText: "Nov 12, 9:00 AM GMT+1" },
        { label: "Weekly · Opus", usedPercent: 0 },
      ],
      plan: "Claude max",
    });
    expect(parseClaudeUsage("## Usage")?.windows).toEqual([]);
    expect(parseClaudeUsage("some garbage")).toBeUndefined();
    const redacted = redactLimitsText(`${claudeSample}\nme@example.com`);
    expect(redacted).not.toContain("$0.42");
    expect(redacted).not.toContain("me@example.com");
  });
});

describe("plan limit probe", () => {
  function make(signedIn: boolean, log: string): ProxyController {
    const dir = path.join(root, `case-${counter++}`);
    mkdirSync(dir, { recursive: true });
    if (signedIn) { mkdirSync(path.join(dir, "codex-home"), { recursive: true }); writeFileSync(path.join(dir, "codex-home", "auth.json"), "{}"); }
    process.env.FAKE_ACP_SLASH = JSON.stringify({ "/status": codexSample });
    process.env.FAKE_ACP_LOG = log;
    const registration: ProviderRegistration = {
      id: "codex",
      displayName: "Codex",
      planLimits: true,
      create: ({ config, ctx }) => new AcpProvider({ ...codexDescriptor({ acpCommand: undefined, acpArgs: [] }), launch: () => ({ command: process.execPath, args: [fixture], env: { ...process.env } }) }, ctx, { workRoot: config.workRoot }),
    };
    const file = path.join(dir, "settings.json");
    writeFileSync(file, JSON.stringify(mergeSettings(defaultSettings(), { server: { port: 0, workRoot: path.join(dir, "work") } })));
    const controller = new ProxyController({ settingsPath: file, env: {}, logger: createLogger({ console: false }), registry: [registration], signedIn });
    controllers.push(controller);
    return controller;
  }
  const logged = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { method: string; params: { prompt?: unknown } }) : []);

  it("probes in a throwaway session that is neither logged as activity nor counted, and caches the answer", async () => {
    const log = path.join(root, "probe.log");
    const controller = make(true, log);
    await controller.start();
    const first = await controller.planLimits.get("codex");
    expect(first.state).toBe("ok");
    expect(first.windows).toEqual([{ label: "5h limit", usedPercent: 34, resetText: "15:00" }, { label: "Weekly limit", usedPercent: 9, resetText: "09:30 on 12 Nov" }]);
    await controller.planLimits.get("codex");
    const prompts = logged(log).filter((entry) => entry.method === "session/prompt");
    expect(prompts.map((entry) => entry.params.prompt)).toEqual([[{ type: "text", text: "/status" }]]);
    expect(logged(log).some((entry) => entry.method === "session/set_config_option")).toBe(false);
    expect(controller.activity.list()).toEqual([]);
    expect(controller.usageSummary().total.allTime.requests).toBe(0);
    expect((await controller.planLimits.get("antigravity")).state).toBe("unsupported");
    // A provider that needs login is not probed.
    const loggedOut = path.join(root, "needs-login.log");
    const other = make(false, loggedOut);
    await other.start();
    expect((await other.planLimits.get("codex", true)).state).toBe("needs_login");
    expect(logged(loggedOut).some((entry) => entry.method === "session/prompt")).toBe(false);
  });
});
