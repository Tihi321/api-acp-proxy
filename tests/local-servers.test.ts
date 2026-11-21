import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalServerManager, type LocalServerSpec } from "../src/local-servers.js";
import type { LocalServerId, LocalServerState } from "../src/shared/ipc.js";

const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) continue;
    if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    else { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }
  }
});

describe("LocalServerManager", () => {
  it("runs one server at a time, keeps the log and stops everything", async () => {
    const ports: Record<number, LocalServerId> = { 18081: "gufo", 18080: "strata", 18082: "llama" };
    const manager = new LocalServerManager({
      pollMs: 20,
      spawn: () => {
        const child = spawn(process.execPath, ["-e", "console.log('up'); setInterval(() => {}, 1000)"], { stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
        children.push(child);
        return child;
      },
      probe: async (port) => manager.list().find((s) => s.id === ports[port])!.log.includes("up"),
    });
    const state = (id: LocalServerId) => manager.list().find((s) => s.id === id)!;
    const waitFor = async (id: LocalServerId, wanted: LocalServerState) => {
      const deadline = Date.now() + 10_000;
      while (state(id).state !== wanted) {
        if (Date.now() > deadline) throw new Error(`${id} stayed ${state(id).state}, wanted ${wanted}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    const cwd = path.resolve(".");
    const spec = (id: LocalServerId, port: number): LocalServerSpec => ({ id, command: process.execPath, args: "--port {port}", cwd, port });

    expect(manager.list().map((s) => s.id)).toEqual(["gufo", "strata", "llama"]);
    await manager.start(spec("gufo", 18081));
    await waitFor("gufo", "ready");
    const gufoChild = children[0];
    expect(state("gufo").pid).toBe(gufoChild.pid);
    expect(state("gufo").commandLine).toContain("--port 18081");

    await manager.start(spec("strata", 18080));
    expect(state("gufo").state).toBe("stopped");
    expect(gufoChild.exitCode !== null || gufoChild.signalCode !== null).toBe(true);
    await waitFor("strata", "ready");
    expect(state("gufo").log).toContain("up");

    await manager.start(spec("llama", 18082));
    expect(state("strata").state).toBe("stopped");
    await waitFor("llama", "ready");
    await manager.start(spec("gufo", 18081));
    await waitFor("gufo", "ready");
    expect(state("llama").state).toBe("stopped");

    await manager.stopAll();
    expect(manager.list().map((s) => s.state)).toEqual(["stopped", "stopped", "stopped"]);
    expect(children.every((child) => child.exitCode !== null || child.signalCode !== null)).toBe(true);
  });

  it("does not spawn when stopped or shut down during the pre-spawn probe", async () => {
    let spawned = 0;
    const manager = new LocalServerManager({ spawn: () => { spawned++; throw new Error("must not spawn"); }, probe: () => new Promise((resolve) => setTimeout(() => resolve(false), 100)) });
    const spec: LocalServerSpec = { id: "gufo", command: process.execPath, args: "", cwd: path.resolve("."), port: 18082 };
    for (const cancel of [() => manager.stop("gufo"), () => manager.stopAll()]) {
      const pending = manager.start(spec);
      expect(manager.list()[0].state).toBe("starting");
      await cancel();
      await pending;
      expect(manager.list()[0].state).toBe("stopped");
    }
    expect(spawned).toBe(0);
  });

  it("keeps starts one at a time (newer wins) and refuses to start after close", async () => {
    const spawned: string[] = [];
    const manager = new LocalServerManager({ spawn: (spec) => { spawned.push(spec.id); throw new Error("stop here"); }, probe: () => new Promise((resolve) => setTimeout(() => resolve(false), 100)) });
    const spec = (id: LocalServerId, port: number): LocalServerSpec => ({ id, command: process.execPath, args: "", cwd: path.resolve("."), port });
    const strata = manager.start(spec("strata", 18083));
    const gufo = manager.start(spec("gufo", 18082));
    expect(manager.list().find((s) => s.id === "strata")!.state).toBe("stopped");
    await strata;
    await expect(gufo).rejects.toThrow("stop here");
    expect(spawned).toEqual(["gufo"]);

    const pending = manager.start(spec("gufo", 18082));
    await manager.close();
    await pending;
    await manager.start(spec("strata", 18083));
    expect(spawned).toEqual(["gufo"]);
    expect(manager.list().every((s) => s.state === "stopped")).toBe(true);
  });

  it("switches gufo profiles (stop, wait for the port, start), ignores the same profile and prechecks model files", async () => {
    const events: string[] = [];
    const answering = { count: 0 }; // polls left in which the port still answers after a kill
    let up = false;
    const manager = new LocalServerManager({
      pollMs: 10,
      releasePollMs: 10,
      spawn: (spec) => {
        events.push(`spawn:${spec.profile}`);
        const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
        children.push(child);
        up = true;
        return child;
      },
      kill: async (child) => { events.push("kill"); up = false; answering.count = 3; child.kill(); },
      probe: async () => { if (answering.count > 0) { answering.count--; events.push("probe-busy"); return true; } return up; },
    });
    const view = () => manager.list().find((s) => s.id === "gufo")!;
    const waitReady = async () => { const deadline = Date.now() + 10_000; while (view().state !== "ready") { if (Date.now() > deadline) throw new Error(`stayed ${view().state}`); await new Promise((r) => setTimeout(r, 10)); } };
    const spec = (profile: string, args = "--port {port}"): LocalServerSpec => ({ id: "gufo", command: process.execPath, args, cwd: path.resolve("."), port: 18081, profile });

    await manager.start(spec("A"));
    await waitReady();
    await manager.start(spec("A"));
    expect(events).toEqual(["spawn:A"]);

    await manager.start(spec("B"));
    await waitReady();
    expect(view().profile).toBe("B");
    expect(events).toEqual(["spawn:A", "kill", "probe-busy", "probe-busy", "probe-busy", "spawn:B"]);
    expect(children[0].exitCode !== null || children[0].signalCode !== null).toBe(true);

    const missing = path.resolve("definitely-missing", "model.gguf");
    await expect(manager.start(spec("C", `--model "${missing}" --port {port}`))).rejects.toThrow("File not found");
    expect(view().profile).toBe("B");
    await expect(manager.start(spec("D", `-m "${missing}" --port {port}`))).rejects.toThrow("File not found");
    await expect(manager.start(spec("E", `--model "${process.execPath}" --spec-draft-model "${missing}" --port {port}`))).rejects.toThrow("File not found");
    expect(view().profile).toBe("B");
    await manager.stopAll();
  });

  it("lets the latest start of a server win and tells the replaced one", async () => {
    const spawned: string[] = [];
    const manager = new LocalServerManager({ spawn: (spec) => { spawned.push(spec.profile ?? ""); throw new Error("stop here"); }, probe: () => new Promise((resolve) => setTimeout(() => resolve(false), 50)) });
    const spec = (profile: string): LocalServerSpec => ({ id: "gufo", command: process.execPath, args: "", cwd: path.resolve("."), port: 18084, profile });
    const first = manager.start(spec("A"));
    const second = manager.start(spec("B"));
    await expect(first).rejects.toThrow("replaced by a newer start");
    await expect(second).rejects.toThrow("stop here");
    expect(spawned).toEqual(["B"]);
  });
});
