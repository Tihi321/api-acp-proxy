import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import http from "node:http";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { zipSync } from "fflate";
import { installAntigravity, platformKeys, readInstallInfo, resolveRegistryEntry, safeEntryPath, type InstallProgress } from "../src/providers/antigravity-installer.js";

const root = path.resolve(".claude/temp/installer-tests", String(process.pid));
let counter = 0;
const newDir = () => { const dir = path.join(root, `d${++counter}`); mkdirSync(dir, { recursive: true }); return dir; };

let server: http.Server;
let base: string;
let zip: Uint8Array = new Uint8Array();
let registryOverride: ((archiveUrl: string) => unknown) | undefined;
let archiveHandler: ((req: http.IncomingMessage, res: http.ServerResponse) => void) | undefined;

const registryFor = (archive: string, version = "9.9.9") => ({ version: "1.0.0", agents: [{ id: "other", version: "1", distribution: {} }, { id: "antigravity-acp", version, distribution: { binary: { "windows-x86_64": { archive, cmd: "./agy_acp_server.exe" }, "linux-x86_64": { archive: archive + "-linux", cmd: "./agy_acp_server.par", args: ["--uid="] } } } }] });
const bytes = (text: string) => new TextEncoder().encode(text);

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === "/registry.json") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(registryOverride ? registryOverride(`${base}/agy.zip`) : registryFor(`${base}/agy.zip`))); return; }
    if (archiveHandler) { archiveHandler(req, res); return; }
    if (req.url === "/agy.zip") { res.setHeader("content-length", String(zip.length)); res.end(Buffer.from(zip)); return; }
    res.statusCode = 404; res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });
afterEach(() => { registryOverride = undefined; archiveHandler = undefined; });

const testOptions = { allowHttp: true, allowedHosts: ["127.0.0.1"], platformKey: "windows-x86_64", skipSignature: true };
const install = (dataDir: string, extra: Partial<Parameters<typeof installAntigravity>[0]> = {}) => installAntigravity({ dataDir, registryUrl: `${base}/registry.json`, testOptions, ...extra });

describe("installAntigravity", () => {
  it("downloads, verifies the hash, extracts atomically and writes install.json", async () => {
    zip = zipSync({ "agy_acp_server.exe": bytes("exe-bytes"), "lib/data.bin": bytes("data") });
    const dataDir = newDir();
    const phases: InstallProgress[] = [];
    const info = await install(dataDir, { onProgress: (p) => phases.push(p) });
    expect(info.version).toBe("9.9.9");
    expect(info.sha256).toBe(createHash("sha256").update(zip).digest("hex"));
    expect(info.url).toBe(`${base}/agy.zip`);
    expect(info.command).toBe(path.join(dataDir, "agents", "antigravity-acp", "9.9.9", "agy_acp_server.exe"));
    expect(info.args).toEqual([]);
    expect(readFileSync(info.command, "utf8")).toBe("exe-bytes");
    expect(readFileSync(path.join(info.dir, "lib", "data.bin"), "utf8")).toBe("data");
    expect(existsSync(path.join(dataDir, "agents", "antigravity-acp", "9.9.9.partial"))).toBe(false);
    expect(await readInstallInfo(dataDir)).toEqual(info);
    const seen = phases.map((p) => p.phase);
    expect(seen[0]).toBe("registry");
    expect(seen).toEqual(expect.arrayContaining(["download", "extract", "done"]));
    expect(phases.find((p) => p.phase === "download" && p.total)?.total).toBe(zip.length);
    expect(seen.at(-1)).toBe("done");
  });

  it("uses the injected fetch", async () => {
    zip = zipSync({ "agy_acp_server.exe": bytes("x") });
    const calls: string[] = [];
    const wrapped: typeof fetch = (input, init) => { calls.push(String(input)); return fetch(input, init); };
    await install(newDir(), { fetch: wrapped });
    expect(calls).toEqual([`${base}/registry.json`, `${base}/agy.zip`]);
  });

  it("rejects zip-slip archives and leaves nothing behind", async () => {
    zip = zipSync({ "agy_acp_server.exe": bytes("x"), "../evil.txt": bytes("evil") });
    const dataDir = newDir();
    await expect(install(dataDir)).rejects.toThrow(/Unsafe path/);
    expect(existsSync(path.join(dataDir, "agents", "antigravity-acp", "evil.txt"))).toBe(false);
    expect(existsSync(path.join(dataDir, "agents", "evil.txt"))).toBe(false);
    expect(existsSync(path.join(dataDir, "agents", "antigravity-acp", "9.9.9.partial"))).toBe(false);
    expect(await readInstallInfo(dataDir)).toBeUndefined();
  });

  it.each(["/abs.txt", "C:/windows/x.txt", "a/../../b.txt"])("rejects the unsafe member name %s", async (name) => {
    zip = zipSync({ "agy_acp_server.exe": bytes("x"), [name]: bytes("evil") });
    await expect(install(newDir())).rejects.toThrow(/Unsafe path/);
  });

  it("fails when the archive lacks the command", async () => {
    zip = zipSync({ "other.exe": bytes("x") });
    await expect(install(newDir())).rejects.toThrow(/does not contain/);
  });

  it("rejects an http registry URL", async () => {
    const dataDir = newDir();
    const spy = vi.fn(fetch);
    await expect(installAntigravity({ dataDir, registryUrl: `${base}/registry.json`, fetch: spy, testOptions: { allowedHosts: ["127.0.0.1"], platformKey: "windows-x86_64", skipSignature: true } })).rejects.toThrow(/HTTPS is required/);
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects an http archive URL from the registry before requesting it", async () => {
    registryOverride = () => registryFor("http://127.0.0.1:1/agy.zip");
    const spy = vi.fn(fetch);
    await expect(install(newDir(), { fetch: spy, testOptions: { ...testOptions, allowHttp: false, allowedHosts: ["127.0.0.1"] } })).rejects.toThrow(/HTTPS is required/);
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects a non-allowlisted host and never contacts it", async () => {
    registryOverride = () => registryFor("https://evil.example.com/agy.zip");
    const calls: string[] = [];
    const spy: typeof fetch = (input, init) => { calls.push(String(input)); return fetch(input, init); };
    await expect(install(newDir(), { fetch: spy })).rejects.toThrow(/not allowed/);
    expect(calls).toEqual([`${base}/registry.json`]);
  });

  it("rejects a redirect to a non-allowlisted host", async () => {
    archiveHandler = (_req, res) => { res.statusCode = 302; res.setHeader("location", "http://localhost:1/agy.zip"); res.end(); };
    await expect(install(newDir())).rejects.toThrow(/not allowed/);
  });

  it("follows a redirect to an allowed location", async () => {
    zip = zipSync({ "agy_acp_server.exe": bytes("redirected") });
    archiveHandler = (req, res) => {
      if (req.url === "/agy.zip") { res.statusCode = 302; res.setHeader("location", "/moved.zip"); res.end(); return; }
      res.end(Buffer.from(zip));
    };
    const info = await install(newDir());
    expect(readFileSync(info.command, "utf8")).toBe("redirected");
  });

  it("reports an HTTP error from the archive host", async () => {
    archiveHandler = (_req, res) => { res.statusCode = 500; res.end(); };
    await expect(install(newDir())).rejects.toThrow(/HTTP 500/);
  });

  it("honours an abort signal", async () => {
    archiveHandler = () => { /* never answers */ };
    const abort = new AbortController();
    const promise = install(newDir(), { signal: abort.signal });
    setTimeout(() => abort.abort(), 100);
    await expect(promise).rejects.toThrow();
  });

  it("replaces an existing install of the same version and prunes older ones", async () => {
    const dataDir = newDir();
    zip = zipSync({ "agy_acp_server.exe": bytes("old") });
    registryOverride = (url) => registryFor(url, "1.0.0");
    await install(dataDir);
    zip = zipSync({ "agy_acp_server.exe": bytes("new") });
    registryOverride = (url) => registryFor(url, "2.0.0");
    const info = await install(dataDir);
    expect(readFileSync(info.command, "utf8")).toBe("new");
    expect(existsSync(path.join(dataDir, "agents", "antigravity-acp", "1.0.0"))).toBe(false);
    expect((await readInstallInfo(dataDir))?.version).toBe("2.0.0");
  });
});

describe("registry parsing", () => {
  const real = { version: "1.0.0", agents: [{ id: "antigravity-acp", version: "1.4.0", distribution: { binary: {
    "windows-x86_64": { archive: "https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.4.0-windows-x86_64.zip", cmd: "./agy_acp_server.exe" },
    "windows-aarch64": { archive: "https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.4.0-windows-arm64.zip", cmd: "./agy_acp_server.exe" },
    "linux-x86_64": { archive: "https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.4.0-linux-x86_64.zip", cmd: "./agy_acp_server.par", args: ["--uid="] },
  } } }] };

  it("maps platforms to registry keys", () => {
    expect(platformKeys("win32", "x64")).toEqual(["windows-x86_64"]);
    expect(platformKeys("win32", "arm64")).toEqual(["windows-aarch64", "windows-arm64"]);
    expect(platformKeys("linux", "x64")).toEqual([]);
  });

  it("resolves the Windows entries", () => {
    expect(resolveRegistryEntry(real, ["windows-x86_64"])).toEqual({ version: "1.4.0", url: "https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.4.0-windows-x86_64.zip", cmd: "./agy_acp_server.exe", args: [] });
    expect(resolveRegistryEntry(real, ["windows-aarch64", "windows-arm64"]).url).toMatch(/arm64\.zip$/);
    expect(resolveRegistryEntry(real, ["linux-x86_64"]).args).toEqual(["--uid="]);
  });

  it("rejects an unsupported platform, a missing agent and a bad version", () => {
    expect(() => resolveRegistryEntry(real, [])).toThrow(/no antigravity-acp build/);
    expect(() => resolveRegistryEntry(real, ["darwin-aarch64"])).toThrow(/no antigravity-acp build/);
    expect(() => resolveRegistryEntry({ agents: [] }, ["windows-x86_64"])).toThrow(/does not list/);
    expect(() => resolveRegistryEntry({ agents: [{ ...real.agents[0], version: "../x" }] }, ["windows-x86_64"])).toThrow(/invalid agent version/);
    expect(() => resolveRegistryEntry({}, [])).toThrow(/no agents list/);
  });
});

describe("safeEntryPath", () => {
  it("accepts nested relative paths and rejects traversal", () => {
    const dir = path.resolve(root, "safe");
    expect(safeEntryPath(dir, "a/b.txt")).toBe(path.join(dir, "a", "b.txt"));
    expect(safeEntryPath(dir, "a\\b.txt")).toBe(path.join(dir, "a", "b.txt"));
    for (const bad of ["../x", "a/../../x", "/x", "\\x", "C:\\x", "D:x"]) expect(() => safeEntryPath(dir, bad)).toThrow(/Unsafe path/);
  });
});
