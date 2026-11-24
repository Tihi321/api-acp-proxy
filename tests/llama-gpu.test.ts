import { describe, expect, it } from "vitest";
import { llamaChildEnv, type RocmFs } from "../src/llama-rocm-path.js";
import { parseDevices } from "../src/shared/llama-devices.js";

// Real `llama-server.exe --list-devices` output (AAP-58): ggml-org b12651 ROCm (no hipblas.dll) and unsloth b12649 gfx1151.
const NONE = "Available devices:\r\n  (none)\r\n";
const ROCM = "Available devices:\r\n  ROCm0: AMD Radeon(TM) 8060S Graphics (110230 MiB, 110074 MiB free)\r\n";

describe("llama-server --list-devices (AAP-58)", () => {
  it("parses a device list, an empty list and unreadable output", () => {
    expect(parseDevices(ROCM)).toEqual(["ROCm0: AMD Radeon(TM) 8060S Graphics (110230 MiB, 110074 MiB free)"]);
    expect(parseDevices(NONE)).toEqual([]);
    expect(parseDevices("error: unknown argument")).toBeUndefined();
  });
});

const slash = (p: string): string => p.split("\\").join("/");
const fsOf = (files: string[], dirs: Record<string, string[]> = {}): RocmFs => ({
  exists: (p) => files.includes(slash(p)),
  readdir: (p) => dirs[slash(p)] ?? [],
});

describe("AMD ROCm SDK on PATH for a ROCm build without hipblas.dll (AAP-58)", () => {
  const exe = "D:/Llama/ggml-org-rocm/llama-server.exe";
  const env = { Path: "C:\\Windows" };
  const build = ["D:/Llama/ggml-org-rocm/ggml-hip.dll"];

  it("changes nothing when the build ships hipblas.dll or is not a HIP build", () => {
    expect(llamaChildEnv(exe, env, fsOf([...build, "D:/Llama/ggml-org-rocm/hipblas.dll", "C:/ROCm/bin/hipblas.dll"])).added).toBeUndefined();
    expect(llamaChildEnv(exe, { ...env, HIP_PATH: "C:\\ROCm" }, fsOf(["C:/ROCm/bin/hipblas.dll"])).added).toBeUndefined();
  });

  it("prepends HIP_PATH bin, else the newest installed SDK, else nothing", () => {
    const viaHip = llamaChildEnv(exe, { ...env, HIP_PATH: "C:\\ROCm\\" }, fsOf([...build, "C:/ROCm/bin/hipblas.dll"]));
    expect(viaHip.added).toBe("C:\\ROCm\\bin");
    expect(viaHip.env.Path).toBe("C:\\ROCm\\bin;C:\\Windows");
    expect(env.Path).toBe("C:\\Windows");
    const root = "C:/Program Files/AMD/ROCm";
    const newest = llamaChildEnv(exe, env, fsOf([...build, `${root}/6.4/bin/hipblas.dll`, `${root}/7.2/bin/hipblas.dll`], { [root]: ["6.4", "7.2", "7.10"] }));
    expect(newest.added).toBe("C:\\Program Files\\AMD\\ROCm\\7.2\\bin");
    expect(llamaChildEnv(exe, env, fsOf(build)).added).toBeUndefined();
  });
});
