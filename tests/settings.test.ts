import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { defaultSettings, defaultSettingsPath, LLAMA_PRESETS, mergeSettings, resolveConfig, restoreMissingLlamaFlagPresets, restoreMissingLlamaPresets, restoreMissingPresets, SettingsStore, settingsSchema, type SecretCodec } from "../src/settings.js";
import { tempRoot } from "./helpers/temp-root.js";

const dir = tempRoot("settings");
mkdirSync(dir, { recursive: true });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });
let counter = 0;
const fresh = () => path.join(dir, `case-${counter++}`, "settings.json");
const logger = createLogger({ console: false });

describe("local provider settings", () => {
  it("keeps and defaults the gufo and strata keys", () => {
    const parsed = settingsSchema.parse({ providers: { gufo: { port: 9000 } } });
    expect(parsed.providers.gufo.port).toBe(9000);
    expect(parsed.providers.gufo.command).toBe("D:\\Gufo\\gufo.cmd");
    expect(parsed.providers.gufo.profiles[0]?.args).toContain("--port {port}");
    expect(parsed.providers.strata.port).toBe(8080);
    expect(parsed.providers.strata.command).toBe("D:\\Strata\\terminal\\run-unsloth-ud-iq4_xs.bat");
    expect(mergeSettings(defaultSettings(), { providers: { strata: { args: "--x" } } }).providers.strata.args).toBe("--x");
    const llama = settingsSchema.parse({}).providers.llama;
    expect([llama.port, llama.binary.backend, llama.binary.source, llama.binary.mode, llama.modelsDir, llama.binary.dir]).toEqual([8082, "rocm", "ggml-org", "managed", "D:\\LlamaCpp\\models", "D:\\LlamaCpp\\bin"]);
    expect(llama.profiles.map((p) => [p.id, p.requires])).toEqual([["inkling-2-mini", { minBuild: 12607, sources: ["unsloth"] }], ["inkling-2-mini-dspark", { sources: ["unsloth"] }]]);
    expect(llama.profiles[1]).toMatchObject({ specType: "draft-dspark", draftNMax: 5, draftGpuLayers: "all", flashAttn: "on", vision: true });
    const vision = { id: "v", label: "V", model: "v", modelFile: "v.gguf", vision: true };
    expect(() => settingsSchema.parse({ providers: { llama: { profiles: [vision] } } })).toThrow(/mmproj/);
    expect(settingsSchema.parse({ providers: { llama: { profiles: [{ ...vision, mmprojFile: "m.gguf" }] } } }).providers.llama.profiles[0]).toMatchObject({ gpuLayers: "auto", flashAttn: "auto", specType: "none", extraArgs: "" });
    expect(restoreMissingLlamaPresets(llama.profiles.slice(0, 1))).toHaveLength(2);
    // AAP-43: the embedding server is off by default and its port may not be another local server's.
    expect(llama.embedding).toEqual({ enabled: false, port: 8083, model: "nomic-embed-text-v1.5", modelFile: "nomic-ai/nomic-embed-text-v1.5-GGUF/nomic-embed-text-v1.5.Q4_K_M.gguf", ctxSize: 2048, gpuLayers: "all", maxConcurrent: 4, extraArgs: "", dimensions: 768 });
    expect(mergeSettings(defaultSettings(), { providers: { llama: { embedding: { enabled: true, port: 9000 } as never } } }).providers.llama.embedding).toMatchObject({ enabled: true, port: 9000, ctxSize: 2048 });
    for (const port of [8080, 8081, 8082, 8787]) expect(() => settingsSchema.parse({ providers: { llama: { embedding: { enabled: true, port } } } })).toThrow(/embedding port/);
    // Port 0 (a free port is picked) is not compared with the embedding port.
    expect(settingsSchema.parse({ server: { port: 0 }, providers: { llama: { embedding: { enabled: true, port: 8787 } } } }).providers.llama.embedding.port).toBe(8787);
    // A file from before the ticket (a chat server on 8083, no embedding key) still loads; only an enabled embedding server must not share the port.
    expect(settingsSchema.parse({ providers: { gufo: { port: 8083 } } }).providers.gufo.port).toBe(8083);
    expect(() => settingsSchema.parse({ providers: { gufo: { port: 8083 }, llama: { embedding: { enabled: true } } } })).toThrow(/embedding port 8083/);
  });
});

describe("llama flag presets", () => {
  it("seeds the flag presets once, keeps the user's lists and never rewrites a stored profile", () => {
    const seeded = settingsSchema.parse({}).providers.llama.flagPresets;
    expect(seeded.map((p) => p.id)).toEqual(["strix-halo-rocm", "strix-halo-rocm-kv-q8", "dspark-probabilistic", "inkling-sampling"]);
    for (const preset of seeded) {
      expect(preset.args.endsWith("--temp 1.0 --top-p 1.0 --top-k 0 --min-p 0.0")).toBe(true);
      expect(preset.args).not.toMatch(/(^|\s)(-fa|-ngl|-c|--spec-draft-n-max|--spec-draft-ngl|--draft-max)(\s|$)/);
    }
    const parse = (flagPresets: unknown) => settingsSchema.parse({ providers: { llama: { flagPresets } } }).providers.llama.flagPresets;
    expect(parse([])).toEqual([]);
    const mine = [{ id: "mine", label: "Mine", args: "-t 8" }];
    expect(parse(mine)).toEqual(mine);
    expect(() => parse([...mine, ...mine])).toThrow(/Duplicate flag preset id/);
    const restored = restoreMissingLlamaFlagPresets([{ id: "mine", label: "Mine", args: "" }]);
    expect(restored).toHaveLength(5);
    expect(restored[0]?.id).toBe("mine");
    const old = { ...LLAMA_PRESETS[1]!, flashAttn: "auto" as const, draftNMax: 3, draftGpuLayers: 99 };
    const stored = settingsSchema.parse({ providers: { llama: { profiles: [old] } } }).providers.llama.profiles;
    expect(stored[0]).toMatchObject({ flashAttn: "auto", draftNMax: 3, draftGpuLayers: 99 });
    expect(restoreMissingLlamaPresets([LLAMA_PRESETS[0]!, stored[0]!])).toEqual([LLAMA_PRESETS[0], stored[0]]);
  });
});

describe("llama --no-mmap migration (AAP-55)", () => {
  it("rewrites the removed --no-mmap token in stored profiles and flag presets, idempotently, and nothing else", () => {
    const parse = () => settingsSchema.parse({ providers: { llama: {
      profiles: [{ ...LLAMA_PRESETS[0]!, extraArgs: "--no-mmap -ub 1024 --temp 1.0 --no-mmap-like" }],
      flagPresets: [{ id: "old", label: "Old", args: "-t 16  --no-mmap  -np 1" }],
    } } }).providers.llama;
    const once = parse();
    expect(once.profiles[0]!.extraArgs).toBe("-lm none -ub 1024 --temp 1.0 --no-mmap-like");
    expect(once.flagPresets[0]!.args).toBe("-t 16  -lm none  -np 1");
    expect(settingsSchema.parse({ providers: { llama: once } }).providers.llama).toEqual(once);
    for (const preset of [...LLAMA_PRESETS, ...settingsSchema.parse({}).providers.llama.flagPresets]) expect(JSON.stringify(preset)).not.toContain("--no-mmap");
  });
});

describe("gufo profiles", () => {
  it("builds presets, migrates the old args, keeps stored profiles and rejects duplicate models", () => {
    const presets = settingsSchema.parse({}).providers.gufo.profiles;
    expect(presets.map((p) => [p.id, p.model, p.kind])).toEqual([
      ["qwen27-q4", "Qwen3.8-27B", "llm"], ["flash-next-q4", "flash-next-q4", "llm"], ["deepseek4", "deepseek4", "llm"],
      ["qwen-image-2.1", "qwen-image-2.1", "image"], ["qwen-image-2.1-turbo", "qwen-image-2.1-turbo", "image"],
    ]);
    const migrated = settingsSchema.parse({ providers: { gufo: { args: "serve llm --model X --port {port}" } } }).providers.gufo.profiles;
    expect(migrated).toHaveLength(5);
    expect(migrated.find((p) => p.id === "qwen27-q4")?.args).toBe("serve llm --model X --port {port}");
    expect(migrated.filter((p) => p.id !== "qwen27-q4")).toEqual(presets.filter((p) => p.id !== "qwen27-q4"));
    const two = [{ id: "a", label: "A", model: "a", kind: "llm", args: "x" }, { id: "b", label: "B", model: "b", kind: "image", args: "y" }];
    expect(settingsSchema.parse({ providers: { gufo: { profiles: two } } }).providers.gufo.profiles.map((p) => p.id)).toEqual(["a", "b"]);
    expect(restoreMissingPresets(settingsSchema.parse({ providers: { gufo: { profiles: two } } }).providers.gufo.profiles)).toHaveLength(7);
    expect(() => settingsSchema.parse({ providers: { gufo: { profiles: [two[0], { ...two[1], model: "a" }] } } })).toThrow(/Duplicate profile model/);
    expect(() => settingsSchema.parse({ providers: { gufo: { profiles: [{ ...two[0], id: "strata" }] } } })).toThrow(/reserved/);
  });
});

describe("SettingsStore", () => {
  it("writes defaults when the file is missing", async () => {
    const file = fresh();
    const settings = await new SettingsStore(file).load();
    expect(settings).toEqual(defaultSettings());
    expect(settings.providers.codex.enabled).toBe(true);
    expect(settings.providers.antigravity.enabled).toBe(false);
    expect(settings.providers.claude).toEqual({ enabled: false });
    expect(JSON.parse(readFileSync(file, "utf8")).version).toBe(1);
  });

  it("backs up a corrupt or invalid file and restores defaults", async () => {
    for (const content of ["{ not json", JSON.stringify({ version: 2 }), JSON.stringify({ server: { port: "x" } })]) {
      const file = fresh();
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, content);
      const settings = await new SettingsStore(file, undefined, logger).load();
      expect(settings).toEqual(defaultSettings());
      const backups = readdirSync(path.dirname(file)).filter((name) => name.includes(".bak-"));
      expect(backups).toHaveLength(1);
      expect(readFileSync(path.join(path.dirname(file), backups[0]!), "utf8")).toBe(content);
      expect(JSON.parse(readFileSync(file, "utf8")).version).toBe(1);
    }
  });

  describe("mcpServers", () => {
    const backups = (file: string) => readdirSync(path.dirname(file)).filter((name) => name.includes(".bak-"));
    const write = (content: string) => { const file = fresh(); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, content); return file; };
    const warnings = (log: ReturnType<typeof createLogger>) => log.recent().filter((entry) => entry.level === "warn").map((entry) => entry.message);

    it("keeps the valid entries and the other settings, drops invalid entries with a warning, and leaves the file as written", async () => {
      const content = JSON.stringify({
        version: 1,
        server: { port: 9001, apiKey: "k" },
        providers: { claude: { enabled: true, termsAcknowledgedAt: "2026-01-01T00:00:00Z" } },
        mcpServers: {
          docs: { url: "https://docs.example/mcp", headers: { A: "1" } },
          client: { url: "https://x.example/mcp" },
          "bad label": { url: "https://x.example/mcp" },
          mixed: { url: "https://x.example/mcp", command: "node" },
          lines: { url: "https://x.example/mcp", headers: { "X-A": "a\nb" } },
          files: { command: "node", args: ["f.js"] },
        },
      }, null, 1);
      const file = write(content);
      const log = createLogger({ console: false });
      const settings = await new SettingsStore(file, undefined, log).load();
      expect(settings.server.port).toBe(9001);
      expect(settings.server.apiKey).toBe("k");
      expect(settings.providers.claude).toEqual({ enabled: true, termsAcknowledgedAt: "2026-01-01T00:00:00Z" });
      expect(settings.mcpServers).toEqual({ docs: { url: "https://docs.example/mcp", headers: { A: "1" } }, files: { command: "node", args: ["f.js"] } });
      const warned = warnings(log);
      expect(warned).toHaveLength(4);
      for (const label of ["client", "bad label", "mixed", "lines"]) expect(warned.some((message) => message.includes(`'${label}'`))).toBe(true);
      expect(backups(file)).toEqual([]);
      expect(readFileSync(file, "utf8")).toBe(content);
    });

    it("ignores a non-object mcpServers and still loads the other settings", async () => {
      for (const value of ["docs", ["a"], 5, null]) {
        const file = write(JSON.stringify({ server: { port: 9002 }, mcpServers: value }));
        const log = createLogger({ console: false });
        const settings = await new SettingsStore(file, undefined, log).load();
        expect(settings.server.port).toBe(9002);
        expect(settings.mcpServers).toEqual({});
        expect(warnings(log)).toHaveLength(value === null ? 0 : 1);
        expect(backups(file)).toEqual([]);
      }
    });

    it("still moves a genuinely corrupt file aside", async () => {
      const content = "{ \"mcpServers\": { oops";
      const file = write(content);
      const settings = await new SettingsStore(file, undefined, logger).load();
      expect(settings).toEqual(defaultSettings());
      expect(backups(file)).toHaveLength(1);
      expect(readFileSync(path.join(path.dirname(file), backups(file)[0]!), "utf8")).toBe(content);
    });
  });

  it("saves atomically, even concurrently, leaving no temp files", async () => {
    const file = fresh();
    const store = new SettingsStore(file);
    await store.load();
    await Promise.all(Array.from({ length: 10 }, (_, index) => store.save(mergeSettings(defaultSettings(), { server: { port: 9000 + index } }))));
    expect(JSON.parse(readFileSync(file, "utf8")).server.port).toBe(9009);
    expect(readdirSync(path.dirname(file))).toEqual(["settings.json"]);
  });

  it("encodes secrets with the codec and decodes them on load", async () => {
    const file = fresh();
    const codec: SecretCodec = { encode: (plain) => Buffer.from(plain).toString("base64"), decode: (stored) => Buffer.from(stored, "base64").toString() };
    const store = new SettingsStore(file, codec);
    await store.save(mergeSettings(defaultSettings(), { server: { apiKey: "sekret" }, providers: { antigravity: { apiKey: "gem" }, claude: { apiKey: "sk-ant-key", oauthToken: "oauth-tok" }, llama: { hfToken: "hf_tok" } } }));
    const onDisk = readFileSync(file, "utf8");
    expect(onDisk).not.toContain("hf_tok");
    expect(JSON.parse(onDisk).providers.llama.hfToken).toMatch(/^enc:/);
    expect(onDisk).not.toContain("sekret");
    expect(onDisk).not.toContain("sk-ant-key");
    expect(onDisk).not.toContain("oauth-tok");
    expect(onDisk).toContain("enc:");
    const loaded = await store.load();
    expect(loaded.server.apiKey).toBe("sekret");
    expect(loaded.providers.antigravity.apiKey).toBe("gem");
    expect(loaded.providers.claude.apiKey).toBe("sk-ant-key");
    expect(loaded.providers.claude.oauthToken).toBe("oauth-tok");
    expect(loaded.providers.llama.hfToken).toBe("hf_tok");
    expect((await new SettingsStore(file, undefined, logger).load()).server.apiKey).toBeUndefined();
  });
});

describe("resolveConfig", () => {
  it("applies env over settings over defaults and tracks overrides", () => {
    const settings = mergeSettings(defaultSettings(), { server: { port: 1234, host: "0.0.0.0" } });
    const { config, providers, overridden } = resolveConfig(settings, { PROXY_PORT: "9999", PROXY_API_KEY: "k", PROXY_CODEX_ENABLED: "0", PROXY_ANTIGRAVITY_ENABLED: "1", PROXY_ACP_COMMAND: "node", PROXY_ACP_ARGS: "a  b", PROXY_MODELS_WAIT_MS: "50" });
    expect(config).toMatchObject({ host: "0.0.0.0", port: 9999, apiKey: "k", acpCommand: "node", acpArgs: ["a", "b"], modelsWaitMs: 50 });
    expect(providers.codex?.enabled).toBe(false);
    expect(providers.antigravity?.enabled).toBe(true);
    expect([...overridden].sort()).toEqual(["providers.antigravity.enabled", "providers.codex.acpArgs", "providers.codex.acpCommand", "providers.codex.enabled", "server.apiKey", "server.modelsWaitMs", "server.port"]);
  });

  it("reads PROXY_TOOL_RESULT_TIMEOUT_MS (10 minutes by default)", () => {
    expect(resolveConfig(defaultSettings(), {}).config.toolResultTimeoutMs).toBe(600_000);
    const { config, overridden } = resolveConfig(defaultSettings(), { PROXY_TOOL_RESULT_TIMEOUT_MS: "90000" });
    expect(config.toolResultTimeoutMs).toBe(90_000);
    expect(overridden).toEqual(["server.toolResultTimeoutMs"]);
  });

  it("reads PROXY_REUSE_SESSIONS (off by default)", () => {
    expect(resolveConfig(defaultSettings(), {}).config.reuseSessions).toBe(false);
    const { config, overridden } = resolveConfig(defaultSettings(), { PROXY_REUSE_SESSIONS: "1" });
    expect(config.reuseSessions).toBe(true);
    expect(overridden).toEqual(["server.reuseSessions"]);
  });

  it("lists bare aliases by default; PROXY_LIST_BARE_ALIASES=0 turns it off", () => {
    expect(resolveConfig(defaultSettings(), {}).config.listBareAliases).toBe(true);
    const { config, overridden } = resolveConfig(defaultSettings(), { PROXY_LIST_BARE_ALIASES: "0" });
    expect(config.listBareAliases).toBe(false);
    expect(overridden).toEqual(["server.listBareAliases"]);
  });

  it("runs Codex in an isolated home by default; PROXY_CODEX_ISOLATED_HOME overrides it", () => {
    expect(defaultSettings().providers.codex.isolatedHome).toBe(true);
    expect(resolveConfig(defaultSettings(), {}).providers.codex?.isolatedHome).toBe(true);
    const off = resolveConfig(defaultSettings(), { PROXY_CODEX_ISOLATED_HOME: "0" });
    expect(off.providers.codex?.isolatedHome).toBe(false);
    expect(off.overridden).toEqual(["providers.codex.isolatedHome"]);
    const stored = mergeSettings(defaultSettings(), { providers: { codex: { isolatedHome: false } } });
    expect(resolveConfig(stored, {}).providers.codex?.isolatedHome).toBe(false);
    expect(resolveConfig(stored, { PROXY_CODEX_ISOLATED_HOME: "true" }).providers.codex?.isolatedHome).toBe(true);
    expect(resolveConfig(defaultSettings(), { PROXY_CODEX_ISOLATED_HOME: "maybe" }).overridden).toEqual([]);
  });

  it("ignores invalid env values and keeps the settings value", () => {
    const { config, overridden } = resolveConfig(mergeSettings(defaultSettings(), { server: { port: 4321 } }), { PROXY_PORT: "nope", PROXY_CODEX_ENABLED: "maybe" });
    expect(config.port).toBe(4321);
    expect(overridden).toEqual([]);
  });

  it("acknowledges the Antigravity terms from the environment", () => {
    const { settings, overridden } = resolveConfig(defaultSettings(), { PROXY_ANTIGRAVITY_ACCEPT_TERMS: "1", PROXY_ANTIGRAVITY_COMMAND: "C:\\agy.exe" });
    expect(settings.providers.antigravity.termsAcknowledgedAt).toBeTruthy();
    expect(settings.providers.antigravity.executablePath).toBe("C:\\agy.exe");
    expect(overridden).toContain("providers.antigravity.termsAcknowledgedAt");
  });

  it("applies the Claude environment overrides", () => {
    const { settings, overridden } = resolveConfig(defaultSettings(), { PROXY_CLAUDE_ENABLED: "1", PROXY_CLAUDE_ACCEPT_TERMS: "true", PROXY_CLAUDE_EXECUTABLE: "C:\claude.exe" });
    expect(settings.providers.claude).toMatchObject({ enabled: true, executablePath: "C:\claude.exe" });
    expect(settings.providers.claude.termsAcknowledgedAt).toBeTruthy();
    expect([...overridden].sort()).toEqual(["providers.claude.enabled", "providers.claude.executablePath", "providers.claude.termsAcknowledgedAt"]);
  });

  it("keeps loadConfig backward compatible", () => {
    expect(loadConfig({})).toMatchObject({ host: "127.0.0.1", port: 8787, maxBodyBytes: 20 * 1024 * 1024, timeoutMs: 300000, acpArgs: [] });
    expect(loadConfig({ PROXY_PORT: "1", PROXY_API_KEY: "" }).apiKey).toBeUndefined();
  });
});

describe("helpers", () => {
  it("honours PROXY_SETTINGS_FILE", () => {
    expect(defaultSettingsPath({ PROXY_SETTINGS_FILE: path.join(dir, "x.json") })).toBe(path.join(dir, "x.json"));
    expect(defaultSettingsPath({ APPDATA: "C:\\Roaming", XDG_CONFIG_HOME: "/cfg" })).toMatch(/api-acp-proxy[\\/]settings\.json$/);
  });

  it("merges patches deeply and clears fields with null", () => {
    const base = mergeSettings(defaultSettings(), { providers: { antigravity: { geminiHome: "/g", enabled: true } } });
    const next = mergeSettings(base, { providers: { antigravity: { geminiHome: null } } });
    expect(next.providers.antigravity).toEqual({ enabled: true, purgeSessions: true });
    expect(next.providers.codex.enabled).toBe(true);
    expect(() => mergeSettings(base, { server: { port: -1 } })).toThrow();
    const withBuild = mergeSettings(defaultSettings(), { providers: { llama: { binary: { ...defaultSettings().providers.llama.binary, mode: "custom", customPath: "a.exe", customBuild: 5 } } } });
    expect(withBuild.providers.llama.binary.customBuild).toBe(5);
    const replaced = mergeSettings(withBuild, { providers: { llama: { binary: { ...withBuild.providers.llama.binary, customPath: "b.exe", customBuild: undefined } } } });
    expect(replaced.providers.llama.binary.customPath).toBe("b.exe");
    expect(replaced.providers.llama.binary.customBuild).toBeUndefined();
    expect(existsSync(dir)).toBe(true);
  });
});
