# AAP-67 ROCm CPU fallback warning

- Real check (prism b12232 HIP, Bonsai PTQ1_0, port 18092): default verbosity prints no device lines at all, so a log-only check cannot see the fallback. With `-v`: no ROCm on PATH gives `device_info: - CPU` and `layer N assigned to device CPU`; with ROCm on PATH `- ROCm0 :`, `using device ROCm0`, `assigned to device ROCm0`.
- src/shared/llama-devices.ts: `rocmCpuFallback` (pure) and `ROCM_CPU_FALLBACK`. Log with GPU evidence = no warning; log with CPU-only evidence = warning; otherwise `--list-devices` empty = warning. gpuLayers 0 and non-ROCm builds never warn.
- src/llama-rocm-path.ts: `isRocmBuild` (ggml-hip.dll next to llama-server).
- src/shared/ipc.ts, src/electron/main.ts: `LlamaStatusView.rocmBuild`.
- src/renderer/llama-view.ts: the profile warning and the "GPU:" line show the ROCm text for ROCm builds (instead of the generic "No GPU found"); the running profile's log is checked too.
- tests/llama-gpu.test.ts: one test with the real excerpts.
