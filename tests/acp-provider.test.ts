import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AcpProvider } from "../src/acp-provider.js";
import { AcpUnavailableError, ProviderAuthRequiredError, defaultRuntimeContext, type ProviderDescriptor } from "../src/provider.js";

const fixture = fileURLToPath(new URL("./fixtures/fake-acp.mjs", import.meta.url));
const workRoot = path.resolve(".claude/temp/acp-provider-tests");
const user = [{ role: "user" as const, content: "hello" }];
const providers: AcpProvider[] = [];

function descriptor(overrides: Partial<ProviderDescriptor> = {}): ProviderDescriptor {
  return { id: "fake", displayName: "Fake", ownedBy: "fake-co", exposeUnprefixed: false, authMode: "on-demand", readOnlyMode: "optional", launch: () => ({ command: process.execPath, args: [fixture], env: { ...process.env } }), chooseAuth: () => undefined, ...overrides };
}
function make(overrides: Partial<ProviderDescriptor> = {}): AcpProvider {
  const provider = new AcpProvider(descriptor(overrides), defaultRuntimeContext(), { workRoot });
  providers.push(provider);
  return provider;
}
const fakeKeys = () => Object.keys(process.env).filter((key) => key.startsWith("FAKE_ACP_"));
beforeEach(() => { mkdirSync(workRoot, { recursive: true }); });
afterEach(async () => {
  await Promise.all(providers.splice(0).map((provider) => provider.close()));
  for (const key of fakeKeys()) delete process.env[key];
});

describe("AcpProvider", () => {
  it("discovers grouped models and reuses the listing session for the next request", async () => {
    process.env.FAKE_ACP_ECHO = "1";
    process.env.FAKE_ACP_MODELS = JSON.stringify([{ group: "g1", name: "One", options: [{ value: "a", name: "A" }, { value: "b" }] }, { group: "g2", name: "Two", options: [{ value: "c" }] }]);
    const provider = make({ warmSessions: 1 });
    expect((await provider.listModels()).map((model) => model.id)).toEqual(["a", "b", "c"]);
    expect(provider.status().models).toHaveLength(3);
    const result = await provider.generate("b", user);
    expect(result.text).toBe("echo:b:fake-session:-");
  });

  it("lists static models without starting a process", async () => {
    const provider = make({ staticModels: ["x", "y"] });
    expect((await provider.listModels()).map((model) => model.id)).toEqual(["x", "y"]);
    expect(provider.status().state).toBe("stopped");
  });

  it("tolerates a missing read-only mode only when it is not required", async () => {
    process.env.FAKE_ACP_NO_READONLY = "1";
    await expect(make({ readOnlyMode: "optional" }).generate("gpt-5.6-sol", user)).resolves.toMatchObject({ text: "fake response" });
    await expect(make({ readOnlyMode: "required" }).generate("gpt-5.6-sol", user)).rejects.toBeInstanceOf(AcpUnavailableError);
  });

  it("maps auth_required to needs_login and recovers after an explicit login", async () => {
    process.env.FAKE_ACP_REQUIRE_AUTH = "1";
    process.env.FAKE_ACP_ECHO = "1";
    process.env.FAKE_ACP_AUTH_METHODS = JSON.stringify([{ id: "oauth", name: "Google login" }]);
    const provider = make();
    await expect(provider.generate("m", user)).rejects.toBeInstanceOf(ProviderAuthRequiredError);
    expect(provider.status().state).toBe("needs_login");
    expect(provider.status().authMethods).toEqual([{ id: "oauth", name: "Google login" }]);
    await provider.login("oauth");
    expect(provider.status().state).toBe("ready");
    expect((await provider.generate("m", user)).text).toBe("echo:m:fake-session:oauth");
  });

  it("chooses the API-key method and retries session creation", async () => {
    process.env.FAKE_ACP_REQUIRE_AUTH = "1";
    process.env.FAKE_ACP_ECHO = "1";
    process.env.FAKE_ACP_AUTH_METHODS = JSON.stringify([{ id: "oauth", name: "Login" }, { id: "api-key", name: "API key" }]);
    const provider = make({ chooseAuth: (methods) => methods.find((method) => method.id === "api-key")?.id });
    expect((await provider.generate("m", user)).text).toMatch(/:api-key$/);
    expect(provider.status().state).toBe("ready");
  });

  it("applies descriptor error mapping", async () => {
    process.env.FAKE_ACP_ENTITY_NOT_FOUND = "1";
    const provider = make({ mapError: (error) => /not found/.test(String((error as Error).message)) ? new Error("mapped") : undefined });
    await expect(provider.generate("m", user)).rejects.toThrow("mapped");
  });

  it("kills grandchild processes when closed", async () => {
    const pidFile = path.join(workRoot, `grandchild-${process.pid}.pid`);
    process.env.FAKE_ACP_GRANDCHILD = pidFile;
    const provider = make();
    await provider.generate("gpt-5.6-sol", user);
    let pid = 0;
    for (let i = 0; i < 50 && !pid; i++) { try { pid = Number(readFileSync(pidFile, "utf8")); } catch { await new Promise((resolve) => setTimeout(resolve, 20)); } }
    expect(pid).toBeGreaterThan(0);
    const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
    expect(alive()).toBe(true);
    await provider.close();
    for (let i = 0; i < 50 && alive(); i++) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(alive()).toBe(false);
  });
});
