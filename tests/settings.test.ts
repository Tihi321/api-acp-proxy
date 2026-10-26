import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { defaultSettings, defaultSettingsPath, mergeSettings, resolveConfig, SettingsStore, type SecretCodec } from "../src/settings.js";

const dir = path.resolve(".claude/temp/settings-tests", String(process.pid));
mkdirSync(dir, { recursive: true });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });
let counter = 0;
const fresh = () => path.join(dir, `case-${counter++}`, "settings.json");
const logger = createLogger({ console: false });

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
    await store.save(mergeSettings(defaultSettings(), { server: { apiKey: "sekret" }, providers: { antigravity: { apiKey: "gem" }, claude: { apiKey: "sk-ant-key", oauthToken: "oauth-tok" } } }));
    const onDisk = readFileSync(file, "utf8");
    expect(onDisk).not.toContain("sekret");
    expect(onDisk).not.toContain("sk-ant-key");
    expect(onDisk).not.toContain("oauth-tok");
    expect(onDisk).toContain("enc:");
    const loaded = await store.load();
    expect(loaded.server.apiKey).toBe("sekret");
    expect(loaded.providers.antigravity.apiKey).toBe("gem");
    expect(loaded.providers.claude.apiKey).toBe("sk-ant-key");
    expect(loaded.providers.claude.oauthToken).toBe("oauth-tok");
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

  it("reads PROXY_REUSE_SESSIONS (off by default)", () => {
    expect(resolveConfig(defaultSettings(), {}).config.reuseSessions).toBe(false);
    const { config, overridden } = resolveConfig(defaultSettings(), { PROXY_REUSE_SESSIONS: "1" });
    expect(config.reuseSessions).toBe(true);
    expect(overridden).toEqual(["server.reuseSessions"]);
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
    expect(existsSync(dir)).toBe(true);
  });
});
