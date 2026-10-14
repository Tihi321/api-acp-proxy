import { describe, expect, it } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { sweepOrphans } from "../src/process-tree.js";

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe.skipIf(process.platform !== "win32")("sweepOrphans", () => {
  it("kills an orphaned agent image under the given directory and leaves other processes alone", async () => {
    const dir = path.resolve(".claude/temp/sweep-test", String(process.pid));
    mkdirSync(dir, { recursive: true });
    const image = path.join(dir, "agy_acp_server.exe");
    copyFileSync(process.execPath, image);
    // The parent starts the image and exits, which leaves the image without a live parent.
    const parentCode = `const { spawn } = require("node:child_process"); const c = spawn(${JSON.stringify(image)}, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" }); console.log(c.pid); c.unref();`;
    const pid = Number(execFileSync(process.execPath, ["-e", parentCode]).toString().trim());
    expect(alive(pid)).toBe(true);
    const bystander = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    try {
      const killed = await sweepOrphans({ dirs: [dir], imageNames: ["agy_acp_server.exe"] });
      expect(killed).toBe(1);
      for (let i = 0; i < 50 && alive(pid); i++) await new Promise((resolve) => setTimeout(resolve, 50));
      expect(alive(pid)).toBe(false);
      expect(alive(bystander.pid!)).toBe(true);
    } finally { bystander.kill(); }
  }, 30000);

  it("does nothing for an empty directory list", async () => {
    expect(await sweepOrphans({ dirs: [], imageNames: ["agy_acp_server.exe"] })).toBe(0);
  });
});
