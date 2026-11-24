# AAP-57 bench: Inkling-2-Mini-IQ4_NL on Strix Halo (2026-11-24)

Logs and raw tables: `.claude/temp/bench/` (load-*.log, completion-*.json, bench-*-main.md / -depth.md).

## Root cause (proven from the load log)
The ggml-org b12651 ROCm build runs the model ENTIRELY ON THE CPU in the user's setup.
- `-lv 4` load log (load-rocm2.log): device list contains only `CPU : AMD RYZEN AI MAX+ 395`; `CPU_Mapped model buffer` 4.2 GB + `CPU_REPACK` 10.9 GB; `CPU KV buffer`; `graph splits = 1`. The "offloaded 49/49 layers to GPU" line is misleading, there is no GPU device.
- Why: `ggml-hip.dll` imports `hipblas.dll` (and amdhip64_7.dll). The official ggml-org win-rocm-10.0 zip (checked: 56 files, no hipblas/rocblas) does not ship hipblas/rocblas. They exist only in the system ROCm SDK (`C:\Program Files\AMD\ROCm\7.2\bin`, HIP_PATH is set) which is NOT on PATH. The DLL fails to load silently, llama.cpp falls back to CPU. `llama-bench --list-devices` -> `(none)`.
- With `C:\Program Files\AMD\ROCm\7.2\bin` on PATH the same build loads `ROCm0: AMD Radeon(TM) 8060S Graphics (102129 MiB)` and runs ~30 tok/s.
- The unsloth gfx1151 builds bundle hipblas/rocblas/hipblaslt, so they find the GPU with no PATH change.
- Same ggml-org zip for b12613 also has 56 files (same layout, no blas DLLs); not run.

## Results (llama-bench -ngl 999 -p 512 -n 128 -r 3; model 16.41 GiB, 26.07 B params)
| build / backend | fa | ub | pp512 t/s | tg128 t/s | tg128 @ d8192 |
|---|---|---|---|---|---|
| ggml-org b12651 ROCm, as the app runs it (CPU fallback; server, not bench) | on | 512 | n/a | 11.6 (server) | n/a |
| ggml-org b12651 ROCm + system ROCm 7.2 on PATH | 0 | 512 | 590.3 | 29.58 | - |
| same | 1 | 512 | 598.0 | 30.43 | 25.52 (fa 1) |
| same | 0 | 1024 | 586.1 | 29.51 | - |
| same | 1 | 1024 | 595.4 | 30.45 | - |
| unsloth b12649 ROCm gfx1151 (self-contained) | 0 | 512 | 752.7 | 31.42 | - |
| same | 1 | 512 | 657.5 | 32.52 | 28.58 (fa 1, ub default) |
| same | 0 | 1024 | 749.7 | 31.45 | - |
| same | 1 | 1024 | 653.6 | 34.74 +-2.15 (noisy) | - |
| ggml-org b12651 Vulkan, default | any | any | CRASH | CRASH | CRASH |
| ggml-org b12651 Vulkan, `GGML_VK_DISABLE_COOPMAT=1` | 0 | 512 | 472.3 | 32.90 | - |
| same | 1 | 512 | 488.5 | 32.88 | 28.44 (fa 1) |
| same | 0 | 1024 | 470.5 | 32.92 | - |
| same | 1 | 1024 | 486.1 | 32.91 | - |

unsloth b12649 depth run: tg128 32.69, @d8192 28.58. unsloth b12588 not benchmarked (b12649 is newer). `-mmp 0` not run: the app already uses `-lm none`, and load is not part of tg. Thread-count check skipped: the GPU is doing the work.

## Server measurements (llama-server, -ngl 999 -fa on -c 8192 -np 1, 256 tokens, short prompt)
| build | device | predicted_per_second | note |
|---|---|---|---|
| ggml-org b12651 ROCm, no PATH (like the app) | CPU only | 11.63 (11.49 on rerun) | the user's 7.8 is the same CPU path at ctx 32768 / more reasoning load |
| unsloth b12649 ROCm gfx1151 | ROCm0 | 33.30 | ROCm0 model buffer 16330 MiB, ROCm_Host 469 MiB, KV on ROCm0, flash_attn enabled, offloaded 25/25 |
| ggml-org b12651 Vulkan, coopmat off | Vulkan0 | 32.49 | Vulkan0 model buffer 16330 MiB, Vulkan_Host 469 MiB, offloaded 49/49, graph splits 2, flash_attn enabled |
| ggml-org b12651 Vulkan, default | Vulkan0 | crash | process dies at the warm-up run, exit 0xC0000409 (stack-buffer-overrun / abort), no message printed. Matrix-core (KHR_coopmat) shader path of the AMD proprietary driver is the trigger |
(prompt_per_second values are meaningless here, 12 prompt tokens.)

Load-log facts for the working runs: unified memory shows ~100 GB free to the GPU (ROCm 110074 MiB, Vulkan 92973 MiB free), so no VRAM limit; `-fa on` resolves to enabled; no unsupported-op or fallback warnings; the only warnings are `special_eos_id is not in special_eog_ids` (tokenizer config) and CORS/no API key. Note llama-server defaults to 4 slots without `-np`; `-np 1` is already set in the profile.

## Winner and recommendation
1. Best: unsloth-b12649-mix-c7059d6-rocm-gfx1151, `-ngl all` (or 999), `-fa on`, `-ub 1024` or 512, `-np 1`, `-lm none`. About 33 tok/s generation, pp512 about 650-750, d8192 about 28.6. No env change needed. Roughly 4x the user's current speed.
2. Equal alternative for tg: ggml-org b12651 ROCm if `C:\Program Files\AMD\ROCm\7.2\bin` is added to PATH of the spawned llama-server (30-30.5 tg, pp 595). Slightly slower than unsloth.
3. Vulkan ggml-org b12651 (folder `D:\LlamaCpp\bin\ggml-org-b12651-vulkan`, extracted and ready) is a tie on tg (32.9) but slower pp (~480) and crashes unless env `GGML_VK_DISABLE_COOPMAT=1` is set. Not recommended; ROCm unsloth is simpler.
- Flash attention: `-fa on` gives +1-3 % tg on ROCm, no change on Vulkan; pp is 12 % lower with FA on unsloth (657 vs 753). For tg-bound chat keep `-fa on`.
- ub 512 vs 1024: no measurable difference.
- Extra args: drop `--spec-draft-sampling probabilistic` (no effect with spec none); no other flags needed.

## Surprises / notes
- "offloaded 49/49 layers to GPU" appears even when no GPU backend loaded; only the device list and buffer names (CPU_Mapped, CPU_REPACK) reveal the CPU fallback. The app should flag it (e.g. warn when the log lacks a ROCm/CUDA/Vulkan buffer, or when a ROCm folder has no hipblas.dll).
- Layer count: ggml-org log says 49 layers (loop expanded), unsloth log says 25/25.
- The earlier research assumption (ROCm kernels slow) was wrong; the GPU was never used.
- Nothing in the repo or in `%APPDATA%\api-acp-proxy\settings.json` was changed. No llama process left running (checked).
- The app names install folders `<source>-<tag>-<backend>` (src/llama-install.ts:57), so the Vulkan folder is `ggml-org-b12651-vulkan` and the app can select it. Its `.llama-install` record file was not created (same as the other hand-placed folders; the app handles that, src/llama-install.ts:64).
