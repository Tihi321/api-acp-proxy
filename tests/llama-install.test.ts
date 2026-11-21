import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { zipSync } from "fflate";
import { afterAll, describe, expect, it } from "vitest";
import { DownloadError } from "../src/download.js";
import { installLlama } from "../src/llama-install.js";
import { buildNumber, fetchReleases, parseReleases } from "../src/llama-releases.js";

const root = path.resolve(".claude/temp/llama-install-tests");
const asset = (name: string, size = 10) => ({ name, size, digest: `sha256:${"a".repeat(64)}`, browser_download_url: `https://github.com/x/y/releases/download/t/${name}` });

describe("llama.cpp releases and install", () => {
  const servers: http.Server[] = [];
  afterAll(() => { for (const server of servers) server.close(); fs.rmSync(root, { recursive: true, force: true }); });

  it("parses releases for both sources and lists /releases?per_page=20, never /releases/latest", async () => {
    const ggml = [
      { tag_name: "b99999", draft: true, published_at: "2026-11-22T00:00:00Z", assets: [asset("llama-b99999-bin-win-cpu-x64.zip")] },
      { tag_name: "v1.0.0", draft: false, published_at: "2026-11-13T00:00:00Z", assets: [{ name: "nightly-tag.txt", size: 1, browser_download_url: "https://github.com/x/nightly-tag.txt" }] },
      { tag_name: "b12606", draft: false, published_at: "2026-11-21T10:28:00Z", assets: [
        asset("llama-b12606-bin-win-cpu-x64.zip"), asset("llama-b12606-bin-win-cpu-arm64.zip"), asset("llama-b12606-bin-win-vulkan-x64.zip"),
        asset("llama-b12606-bin-win-rocm-10.0-x64.zip"), asset("llama-b12606-bin-win-cuda-12.4-x64.zip"), asset("llama-b12606-bin-win-cuda-13.5-x64.zip"),
        asset("cudart-llama-bin-win-cuda-12.4-x64.zip"), asset("cudart-llama-bin-win-cuda-13.5-x64.zip"), asset("llama-b12606-bin-win-sycl-x64.zip"),
      ] },
    ];
    const unsloth = [{ tag_name: "b12588-mix-c0c3de8", draft: false, published_at: "2026-11-20T00:00:00Z", assets: [
      asset("app-b12588-mix-c0c3de8-windows-x64-rocm-gfx1151.zip"), asset("app-b12588-mix-c0c3de8-windows-x64-cuda12-portable.zip"), { name: "llama-prebuilt-sha256.json", size: 1, browser_download_url: "https://github.com/x/s.json" },
    ] }];

    const releases = parseReleases("ggml-org", ggml);
    expect(releases.map((release) => release.tag)).toEqual(["b12606"]);
    const x64 = releases[0]!.assets.filter((entry) => entry.arch === "x64");
    expect(x64.map((entry) => entry.backend)).toEqual(["cpu", "vulkan", "rocm", "cuda-12", "cuda-13", "sycl"]);
    expect(x64.find((entry) => entry.backend === "cuda-12")!.runtime!.name).toBe("cudart-llama-bin-win-cuda-12.4-x64.zip");
    expect(x64.find((entry) => entry.backend === "cuda-13")!.runtime!.name).toBe("cudart-llama-bin-win-cuda-13.5-x64.zip");
    expect(x64.find((entry) => entry.backend === "rocm")!.runtime).toBeUndefined();
    const unslothReleases = parseReleases("unsloth", unsloth);
    expect(unslothReleases[0]!.assets.map((entry) => entry.backend)).toEqual(["rocm-gfx1151", "cuda12-portable"]);
    expect(unslothReleases[0]!.build).toBe(12588);
    expect(buildNumber("b12588-mix-c0c3de8")).toBe(12588);

    const urls: string[] = [];
    const fake = (async (url: string) => { urls.push(String(url)); return new Response(JSON.stringify(ggml), { status: 200 }); }) as unknown as typeof fetch;
    await fetchReleases("ggml-org", { fetch: fake });
    expect(urls).toEqual(["https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=20"]);
    expect(urls.some((url) => url.includes("/releases/latest"))).toBe(false);
  });

  it("installs a verified zip into <binDir>/<source>-<tag>-<backend> and cleans up on a wrong digest", async () => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });
    const zip = Buffer.from(zipSync({ "bin/llama-server.exe": new TextEncoder().encode("exe"), "bin/ggml-rocm.dll": new TextEncoder().encode("dll") }));
    const good = createHash("sha256").update(zip).digest("hex");
    let digest = good;
    const server = http.createServer((req, res) => {
      const port = (server.address() as AddressInfo).port;
      if (req.url === "/repos/ggml-org/llama.cpp/releases/tags/b12606") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ tag_name: "b12606", draft: false, published_at: "2026-11-21T00:00:00Z", assets: [
          { name: "llama-b12606-bin-win-rocm-10.0-x64.zip", size: zip.length, digest: `sha256:${digest}`, browser_download_url: `http://127.0.0.1:${port}/dl/rocm.zip` }] }));
      } else if (req.url === "/dl/rocm.zip") res.writeHead(200, { "content-length": zip.length }).end(zip);
      else res.writeHead(404).end();
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const apiBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const binDir = path.join(root, "bin");
    const base = { source: "ggml-org" as const, tag: "b12606", backend: "rocm", arch: "x64" as const, binDir, fetch, apiBase, policy: { hosts: ["127.0.0.1"], allowHttp: true }, statfs: (async () => ({ bavail: 1e9, bsize: 4096 })) as unknown as typeof fs.promises.statfs };

    const info = await installLlama(base);
    const finalDir = path.join(binDir, "ggml-org-b12606-rocm");
    expect(info.command).toBe(path.join(finalDir, "bin", "llama-server.exe"));
    expect(info.dir).toBe(path.join(finalDir, "bin"));
    expect(info).toMatchObject({ build: 12606, backend: "rocm", sha256: good });
    expect(fs.existsSync(path.join(finalDir, "bin", "ggml-rocm.dll"))).toBe(true);

    fs.rmSync(finalDir, { recursive: true });
    digest = "0".repeat(64);
    await expect(installLlama(base)).rejects.toSatisfy((error) => error instanceof DownloadError && error.code === "download_checksum_mismatch");
    expect(fs.readdirSync(binDir)).toEqual([]);
  });
});
