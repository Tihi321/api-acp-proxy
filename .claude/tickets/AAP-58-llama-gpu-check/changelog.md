# AAP-58 llama GPU check

- src/llama-rocm-path.ts (new): `llamaChildEnv` puts the AMD ROCm SDK bin (HIP_PATH, else newest C:\Program Files\AMD\ROCm\<ver>) first on the PATH of a build that has ggml-hip.dll but no hipblas.dll. Injectable fs.
- src/local-servers.ts: llama and embed spawn with that env; one info line in proxy.log.
- src/shared/llama-devices.ts (new): `parseDevices` for `--list-devices` output.
- src/electron/main.ts: `llamaDevices` (cached by exe, mtime, PATH fix); `LlamaStatusView.devices` in src/shared/ipc.ts.
- src/renderer/llama-view.ts, settings.html: "GPU: ..." line in the build section; "No GPU found" warning there and on profiles with GPU layers other than 0.
- tests/llama-gpu.test.ts: parser on the two real outputs; SDK path helper.
- README: GPU check paragraph.
- Verified for real: ggml-org b12651 ROCm `--list-devices` prints (none) with the app env and ROCm0 with the helper's env.
