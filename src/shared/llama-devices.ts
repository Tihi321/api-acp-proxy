// AAP-58: the GPUs `llama-server --list-devices` finds.

/** The device lines after "Available devices:" (`[]` for `(none)`); undefined when the output has no such header. */
export function parseDevices(output: string): string[] | undefined {
  const lines = output.split(/\r?\n/);
  const start = lines.findIndex((line) => /^Available devices:\s*$/.test(line));
  if (start < 0) return undefined;
  const devices: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!/^\s+\S/.test(line)) break;
    const text = line.trim();
    if (text !== "(none)") devices.push(text);
  }
  return devices;
}

// AAP-67: a ROCm/HIP build whose ggml-hip.dll fails to load starts anyway and runs on the CPU.

export const ROCM_CPU_FALLBACK = "Running on CPU: the ROCm build found no GPU. ggml-hip.dll did not load; the ROCm SDK bin folder is probably not on PATH.";

const GPU_LOG = /using device (?!CPU)\S+|^\s*-\s+(?:ROCm|HIP)\d+\s*:|offloaded [1-9]\d*\/\d+ layers to GPU|assigned to device (?!CPU)\S+/m;
const CPU_LOG = /assigned to device CPU|offloaded 0\/\d+ layers to GPU/;

/** True when a ROCm build runs on the CPU: the server log (when it has device lines) says so, else `--list-devices` found none. `gpuLayers` 0 means CPU is intended. */
export function rocmCpuFallback(input: { rocmBuild: boolean; gpuLayers: string | number; devices?: string[]; log?: string[] }): boolean {
  if (!input.rocmBuild || input.gpuLayers === 0 || input.gpuLayers === "0") return false;
  const log = (input.log ?? []).join("\n");
  if (GPU_LOG.test(log)) return false;
  if (CPU_LOG.test(log)) return true;
  return input.devices?.length === 0;
}
