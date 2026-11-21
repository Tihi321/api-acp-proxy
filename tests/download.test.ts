import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import { DownloadError, downloadResumable } from "../src/download.js";

const root = path.resolve(".claude/temp/download-tests");
const content = Buffer.alloc(300_000, "resumable-fixture-");
const sha = createHash("sha256").update(content).digest("hex");

describe("downloadResumable", () => {
  const servers: http.Server[] = [];
  afterAll(() => { for (const server of servers) server.close(); fs.rmSync(root, { recursive: true, force: true }); });

  it("resumes after a cancel, keeps the token off the CDN hop, and refuses bad checksums and hosts", async () => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });
    const seen: Array<{ url: string; range?: string; authorization?: string; host?: string }> = [];
    const server = http.createServer((req, res) => {
      seen.push({ url: req.url ?? "", ...(req.headers.range ? { range: req.headers.range } : {}), ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}) });
      const port = (server.address() as AddressInfo).port;
      if (req.url === "/resolve/f") { res.writeHead(302, { location: `http://localhost:${port}/cdn/f` }).end(); return; }
      if (req.url === "/resolve/evil") { res.writeHead(302, { location: "http://evil.example.com/x" }).end(); return; }
      if (req.url !== "/cdn/f") { res.writeHead(404).end(); return; }
      const match = /^bytes=(\d+)-$/.exec(req.headers.range ?? "");
      const start = match ? Number(match[1]) : 0;
      res.writeHead(match ? 206 : 200, { "content-length": content.length - start, ...(match ? { "content-range": `bytes ${start}-${content.length - 1}/${content.length}` } : {}) });
      // Two chunks, the second delayed, so the first read can abort the transfer.
      const half = start + Math.ceil((content.length - start) / 2);
      res.write(content.subarray(start, half));
      setTimeout(() => res.end(content.subarray(half)), 150);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const policy = { hosts: ["127.0.0.1", "localhost"], allowHttp: true };
    const headersFor = (url: URL) => (url.hostname === "127.0.0.1" ? { authorization: "Bearer secret" } : {});
    const file = path.join(root, "out", "f.bin");
    const url = `http://127.0.0.1:${port}/resolve/f`;
    const base = { fetch, url, file, policy, headersFor };

    const controller = new AbortController();
    await expect(downloadResumable({ ...base, signal: controller.signal, onProgress: () => controller.abort() })).rejects.toMatchObject({ code: "download_cancelled" });
    const partialSize = fs.statSync(`${file}.partial`).size;
    expect(partialSize).toBeGreaterThan(0);
    expect(partialSize).toBeLessThan(content.length);

    seen.length = 0;
    const result = await downloadResumable({ ...base, expectedSize: content.length, expectedSha256: sha });
    expect(result).toEqual({ sha256: sha, bytes: content.length });
    expect(fs.readFileSync(file).equals(content)).toBe(true);
    expect(fs.existsSync(`${file}.partial`)).toBe(false);
    expect(seen.filter((entry) => entry.url === "/cdn/f").map((entry) => entry.range)).toEqual([`bytes=${partialSize}-`]);
    expect(seen.filter((entry) => entry.url === "/resolve/f").every((entry) => entry.authorization === "Bearer secret")).toBe(true);
    expect(seen.filter((entry) => entry.url === "/cdn/f").every((entry) => entry.authorization === undefined)).toBe(true);

    const other = path.join(root, "out", "g.bin");
    await expect(downloadResumable({ ...base, file: other, expectedSha256: "0".repeat(64) })).rejects.toMatchObject({ code: "download_checksum_mismatch" });
    expect(fs.existsSync(`${other}.partial`)).toBe(false);
    expect(fs.existsSync(other)).toBe(false);

    const bad = downloadResumable({ ...base, url: `http://127.0.0.1:${port}/resolve/evil`, file: path.join(root, "out", "h.bin") });
    await expect(bad).rejects.toBeInstanceOf(DownloadError);
    await expect(bad).rejects.toMatchObject({ code: "download_host_not_allowed" });
  });
});
