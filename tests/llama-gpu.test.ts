import { describe, expect, it } from "vitest";
import { llamaChildEnv, type RocmFs } from "../src/llama-rocm-path.js";
import { parseDevices, rocmCpuFallback } from "../src/shared/llama-devices.js";

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

// Real `-v` log excerpts of the PrismML b12232 HIP build (AAP-67): without the ROCm SDK on PATH and with it. Default verbosity prints neither.
const CPU_LOG = [
  "0.00.038.215 I cmn  common_param: device_info:",
  "0.00.038.223 I cmn  common_param:   - CPU     : AMD RYZEN AI MAX+ 395 w/ Radeon 8060S           (65174 MiB, 50351 MiB free)",
  "0.00.280.891 D load_tensors: layer   0 assigned to device CPU, is_swa = 0",
];
const ROCM_LOG = [
  "0.00.049.823 I cmn  common_param: device_info:",
  "0.00.172.649 I cmn  common_param:   - ROCm0   : AMD Radeon(TM) 8060S Graphics (102129 MiB, 101968 MiB free)",
  "0.00.243.469 I llama_prepare_model_devices: using device ROCm0 (AMD Radeon(TM) 8060S Graphics) (0000:c5:00.0) - 101968 MiB free",
  "0.00.460.559 D load_tensors: layer   0 assigned to device ROCm0, is_swa = 0",
];

describe("ROCm build that silently runs on the CPU (AAP-67)", () => {
  it("warns for a ROCm build with no GPU in the log or the device list, and only then", () => {
    expect(rocmCpuFallback({ rocmBuild: true, gpuLayers: "all", log: CPU_LOG, devices: ["ROCm0: x"] })).toBe(true);
    expect(rocmCpuFallback({ rocmBuild: true, gpuLayers: "all", devices: [] })).toBe(true);
    expect(rocmCpuFallback({ rocmBuild: true, gpuLayers: "all", log: ROCM_LOG, devices: [] })).toBe(false);
    expect(rocmCpuFallback({ rocmBuild: true, gpuLayers: "all", log: ["srv load_model: loading model"] })).toBe(false);
    expect(rocmCpuFallback({ rocmBuild: true, gpuLayers: 0, log: CPU_LOG, devices: [] })).toBe(false);
    expect(rocmCpuFallback({ rocmBuild: false, gpuLayers: "all", log: CPU_LOG, devices: [] })).toBe(false);
  });
});
