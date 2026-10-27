import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AcpProvider } from "../src/acp-provider.js";
import { textMessage } from "../src/api.js";
import { defaultRuntimeContext } from "../src/provider.js";
import { codexDescriptor } from "../src/providers/codex.js";
import { ProviderRouter } from "../src/router.js";

// The Codex model list comes from the agent's `model` option; the ids here are test data served by the fake agent.
const fixture = fileURLToPath(new URL("./fixtures/fake-acp.mjs", import.meta.url));
const root = path.resolve(".claude/temp/codex-models-tests", String(process.pid));
const AGENT_MODELS = ["model-one", "model-two"];

let counter = 0;
const providers: AcpProvider[] = [];
function codex(command: { acpCommand: string; acpArgs: string[] } = { acpCommand: process.execPath, acpArgs: [fixture] }): AcpProvider {
  const base = path.join(root, `t${++counter}`);
  mkdirSync(path.join(base, "work"), { recursive: true });
  // Signed in: the own home has a login file (the fake agent does not read it); without one Codex is not started to list models.
  mkdirSync(path.join(base, "data", "codex-home"), { recursive: true });
  writeFileSync(path.join(base, "data", "codex-home", "auth.json"), "{}");
  const provider = new AcpProvider(codexDescriptor(command), defaultRuntimeContext({ dataDir: path.join(base, "data") }), { workRoot: path.join(base, "work") });
  providers.push(provider);
  return provider;
}
const ids = (models: Array<{ id: string }>) => models.map((model) => model.id);

beforeEach(() => { process.env.FAKE_ACP_MODELS = JSON.stringify(AGENT_MODELS.map((value) => ({ value }))); });
afterEach(async () => {
  await Promise.all(providers.splice(0).map((provider) => provider.close()));
  delete process.env.FAKE_ACP_MODELS;
});

describe("Codex models from the agent", () => {
  it("lists what the agent offers, with and without the provider prefix, and has no fixed list", async () => {
    const provider = codex();
    expect(provider.staticModels).toBeUndefined();
    expect(provider.exposeUnprefixed).toBe(true);
    expect(provider.status().models).toEqual([]);
    const router = new ProviderRouter({ providers: [provider] });
    expect(ids(await router.listModels({ waitMs: 20_000 }))).toEqual(["model-one", "codex/model-one", "model-two", "codex/model-two"]);
    expect(ids(provider.status().models)).toEqual(AGENT_MODELS);
  });

  it("routes both spellings to the agent and rejects an id it does not offer", async () => {
    const router = new ProviderRouter({ providers: [codex()] });
    await router.listModels({ waitMs: 20_000 });
    expect((await router.generate("model-two", [textMessage("user", "hi")])).text).toBe("fake response");
    expect((await router.generate("codex/model-one", [textMessage("user", "hi")])).text).toBe("fake response");
    for (const unknown of ["gpt-5.6-sol", "codex/gpt-5.6-sol"]) {
      expect(router.hasModel(unknown)).toBe(false);
      await expect(router.generate(unknown, [textMessage("user", "hi")])).rejects.toMatchObject({ status: 404 });
    }
  });

  it("follows the agent when its list changes", async () => {
    const provider = codex();
    const router = new ProviderRouter({ providers: [provider] });
    await router.listModels({ waitMs: 20_000 });
    expect(router.hasModel("model-two")).toBe(true);
    await provider.close();
    process.env.FAKE_ACP_MODELS = JSON.stringify([{ value: "model-three" }]);
    await router.refresh("codex");
    expect(router.hasModel("model-three")).toBe(true);
    expect(router.hasModel("model-two")).toBe(false);
    expect(router.hasModel("codex/model-two")).toBe(false);
  });

  it("lets an unprefixed id through before the first discovery and rejects unknown ones afterwards", async () => {
    const router = new ProviderRouter({ providers: [codex()] });
    expect(router.hasModel("model-one")).toBe(true);
    expect(router.hasModel("someone-else/model-one")).toBe(false);
    expect(router.hasModel("codex/model-one")).toBe(true);
    await router.listModels({ waitMs: 20_000 });
    expect(router.hasModel("model-nine")).toBe(false);
    expect(router.hasModel("model-one")).toBe(true);
  });

  it("caches the list: a restart answers from the cache while the agent is not available", async () => {
    const cachePath = path.join(root, `cache-${process.pid}.json`);
    rmSync(cachePath, { force: true });
    const first = new ProviderRouter({ providers: [codex()], cachePath });
    await first.listModels({ waitMs: 20_000 });
    await first.close();
    expect(ids(JSON.parse(readFileSync(cachePath, "utf8")).providers.codex)).toEqual(AGENT_MODELS);

    const restarted = new ProviderRouter({ providers: [codex({ acpCommand: "this-command-does-not-exist-aap20", acpArgs: [] })], cachePath });
    expect(ids(restarted.knownModels("codex"))).toEqual(AGENT_MODELS);
    expect(ids(await restarted.listModels({ waitMs: 20_000 }))).toEqual(["model-one", "codex/model-one", "model-two", "codex/model-two"]);
    expect(restarted.hasModel("model-two")).toBe(true);
    expect(restarted.hasModel("model-nine")).toBe(false);
    rmSync(cachePath, { force: true });
  });
});
