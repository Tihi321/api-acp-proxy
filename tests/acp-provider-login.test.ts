import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AcpProvider } from "../src/acp-provider.js";
import { defaultRuntimeContext, type ProviderDescriptor } from "../src/provider.js";
import { textMessage } from "../src/api.js";

const fixture = fileURLToPath(new URL("./fixtures/fake-acp.mjs", import.meta.url));
const workRoot = path.resolve(".claude/temp/acp-provider-login-tests");
const user = [textMessage("user", "hello")];
const providers: AcpProvider[] = [];

function make(overrides: Partial<ProviderDescriptor> = {}): AcpProvider {
  const descriptor: ProviderDescriptor = { id: "fake", displayName: "Fake", ownedBy: "fake-co", exposeUnprefixed: false, authMode: "on-demand", readOnlyMode: "optional", launch: () => ({ command: process.execPath, args: [fixture], env: { ...process.env } }), chooseAuth: () => undefined, ...overrides };
  const provider = new AcpProvider(descriptor, defaultRuntimeContext(), { workRoot });
  providers.push(provider);
  return provider;
}
beforeEach(() => { mkdirSync(workRoot, { recursive: true }); });
afterEach(async () => {
  await Promise.all(providers.splice(0).map((provider) => provider.close()));
  for (const key of Object.keys(process.env)) if (key.startsWith("FAKE_ACP_")) delete process.env[key];
});

describe("AcpProvider abort handling", () => {
  it("returns cancelled when the abort lands during session creation", async () => {
    process.env.FAKE_ACP_SESSION_DELAY_MS = "400";
    const abort = new AbortController();
    const promise = make().generate("m", user, {}, abort.signal);
    setTimeout(() => abort.abort(), 100);
    await expect(promise).resolves.toEqual({ text: "", stopReason: "cancelled", usage: null });
  });

  it("returns cancelled when the abort lands while the agent is still starting", async () => {
    const abort = new AbortController();
    const promise = make().generate("m", user, {}, abort.signal);
    abort.abort();
    await expect(promise).resolves.toMatchObject({ stopReason: "cancelled" });
  });

  it("returns cancelled for a signal that was already aborted", async () => {
    const result = await make().generate("m", user, {}, AbortSignal.abort());
    expect(result).toMatchObject({ stopReason: "cancelled", text: "" });
  });
});

describe("AcpProvider mode candidates", () => {
  it("only picks candidates from the descriptor", async () => {
    process.env.FAKE_ACP_AGY = "1";
    // Default candidates (read-only/readonly) are absent in the agy-style fake, so a required read-only mode fails.
    await expect(make({ readOnlyMode: "required" }).generate("m", user)).rejects.toThrow(/read-only mode/);
    await expect(make({ readOnlyMode: "required", modeCandidates: ["read-only", "default"] }).generate("m", user)).resolves.toMatchObject({ text: "fake response" });
  });
});

describe("AcpProvider login URL hook", () => {
  it("captures the URL from stderr through loginUrlPattern", async () => {
    Object.assign(process.env, { FAKE_ACP_AUTH_URL: "1", FAKE_ACP_AUTH_METHODS: JSON.stringify([{ id: "oauth", name: "Login" }]) });
    const provider = make({ loginUrlPattern: /(https:\/\/accounts\.google\.com\/\S+)/ });
    const urls: Array<string | undefined> = [];
    provider.onStatus((status) => urls.push(status.loginUrl));
    await provider.login("oauth");
    expect(urls.some((url) => url?.startsWith("https://accounts.google.com/"))).toBe(true);
    expect(provider.status().loginUrl).toBeUndefined();
  });
});
