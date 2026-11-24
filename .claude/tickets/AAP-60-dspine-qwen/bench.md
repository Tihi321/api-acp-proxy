# AAP-60 bench: Qwen3.8-27B (UD-Q4_K_M) with MTP and Tencent DSpine on Strix Halo (2026-11-24)

Logs/scripts: `.claude/temp/dspine/` (run.mjs harness, chain.sh, srv-*.log, results.jsonl, build-hip.bat/log).
Method as AAP-57 bench2: llama-server `-ngl 999 -fa on -c 16384 -np 1 --jinja`, warm-up, 3 prompts (a Tetris code, b TCP prose, c ISO-8601 code), n_predict 512, temp 1.0 (top-p 1, top-k 0, min-p 0) then the same 3 at temp 0. Gen = predicted_per_second. Acceptance = draft_n_accepted/draft_n over all 6 requests. No llama-server was running at start; none left running.

## Downloads (HF, sizes match the HF API byte for byte)
- D:\LlamaCpp\models\unsloth\Qwen3.8-27B-GGUF\Qwen3.8-27B-UD-Q4_K_M.gguf (16,564,259,744 B)
- D:\LlamaCpp\models\unsloth\Qwen3.8-27B-GGUF\MTP\mtp-Qwen3.8-27B-Q4_0.gguf (1,369,590,656 B; the MTP heads are a separate file, passed with `-md`)
- D:\LlamaCpp\models\aj9o9\Qwen3.8-27B-DSpine-b16-GGUF\Qwen3.8-27B-DSpine-b16-Q4_K_M.gguf (1,257,892,896 B) and ...-Q8_0.gguf (2,201,447,456 B; not benchmarked)
(sha256 not compared: HF gives lfs oids only in the tree listing, which I did not check against local hashes; sizes match.)

## Build of the fork (worked first try)
Installed with winget: Kitware.CMake 4.4.4, Ninja-build.Ninja (not on PATH of old shells; script adds them). VS 2022 BuildTools + Windows SDK 10.0.26100 were already present (needed by ROCm clang).
`git clone --depth 1 --branch dspine https://github.com/Ajay9o9/llama.cpp D:\LlamaCpp\src\llama.cpp-dspine` -> commit 4703b7d "dflash : add DSpine draft model support" (2026-11-08).
build-hip.bat (run as `cmd //c`): vcvars64.bat; PATH += CMake, WinGet Links, `C:\Program Files\AMD\ROCm\7.2\bin`; HIP_PATH=C:\Program Files\AMD\ROCm\7.2;
`cmake -S . -B build-hip -G Ninja -DGGML_HIP=ON -DAMDGPU_TARGETS=gfx1151 -DCMAKE_C_COMPILER="C:/Program Files/AMD/ROCm/7.2/bin/clang.exe" -DCMAKE_CXX_COMPILER="C:/Program Files/AMD/ROCm/7.2/bin/clang++.exe" -DCMAKE_BUILD_TYPE=Release -DLLAMA_CURL=OFF -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF -DGGML_NATIVE=OFF`
`cmake --build build-hip -j 16 --target llama-server llama-cli` (342 steps, a few minutes).
Copied build-hip\bin\* to `D:\LlamaCpp\bin\dspine-fork-4703b7d-rocm-gfx1151` (llama-server.exe, llama-cli.exe, ggml*.dll, llama*.dll, mtmd.dll). It needs `C:\Program Files\AMD\ROCm\7.2\bin` on PATH at run time (hipblas/rocblas/amdhip64 are not copied). `--list-devices`: ROCm0 AMD Radeon(TM) 8060S, 102129 MiB. `--spec-type` list has NO draft-dspine (same list as stock: ... draft-dflash, draft-dspark, draft-dflash2, draft-lilicorr ...); the DSpine GGUF is picked up by `draft-dflash` (log: "adding speculative implementation 'draft-dflash2'", block_size=16, n_extract=5). Vulkan fork build not needed.
Stock ROCm 7.2 loads Qwen3.8 fine (unsloth gfx1151 build, and the fork); the load issue from the blog did not occur.

## Results (gen t/s; code = a,c average, prose = b; acc = acceptance)
Per-prompt temp-1.0 values listed as a/b/c; t=0 as a/b/c.
| build | config | t=1.0 avg | a/b/c at t=1.0 | t=0 avg | a/b/c at t=0 | acc |
|---|---|---|---|---|---|---|
| unsloth b12651 rocm-gfx1151 | plain | 12.9 | 12.9/12.9/12.9 | 12.97 | 13.0/12.9/13.0 | - |
| ggml-org b12675 vulkan (coopmat off) | plain | 12.66 | 12.7/12.7/12.7 | 12.78 | 12.8 | - |
| fork 4703b7d rocm | plain | 12.58 | 12.6 | 12.71 | 12.7 | - |
| unsloth rocm | MTP n1 | 19.29 | 21.5/16.1/20.3 | 21.6 | 22.7/21.1/21.0 | 0.795 |
| unsloth rocm | MTP n2 | 23.04 | 27.5/17.0/24.6 | 27.39 | 29.4/26.5/26.2 | 0.701 |
| unsloth rocm | MTP n3 | 23.81 | 31.8/14.2/25.5 | 29.61 | 33.7/27.5/27.7 | 0.563 |
| vulkan | MTP n1 | 18.21 | 18.5/17.2/18.9 | 20.69 | 21.5/20.1/20.5 | 0.79 |
| vulkan | MTP n2 | 20.57 | 22.1/16.8/22.8 | 26.03 | 27.6/25.1/25.4 | 0.686 |
| vulkan | MTP n3 | 22.82 | 30.8/14.1/23.6 | 29.04 | 33.0/26.2/27.9 | 0.58 |
| fork rocm | DSpine n2 | 21.45 | 26.7/15.1/22.5 | 26.25 | 28.4/24.2/26.1 | 0.65 |
| fork rocm | DSpine n4 | 23.98 | 30.0/14.6/27.4 | 33.83 | 39.8/27.5/34.2 | 0.477 |
| fork rocm | DSpine n8 | 29.76 | 44.7/15.8/28.8 | 39.12 | 52.7/26.4/38.2 | 0.41 |
| fork rocm | DSpine n15 | **31.86** | 47.6/18.7/29.3 | **42.36** | 62.7/25.2/39.2 | 0.218 |
Per-request acceptance for DSpine n15: 0.37/0.10/0.20 (t=1.0), 0.51/0.16/0.28 (t=0). Acceptance is a draft-token fraction, so it is low at n15 even when tokens/step is high.

## Findings
- Plain Qwen3.8-27B UD-Q4_K_M is only ~12.9 t/s on this machine (bandwidth bound), identical on ROCm and Vulkan.
- Stock MTP (draft-mtp, MTP Q4_0 file via `-md`) is the best stock option: n3 is 23.8 (t=1) / 29.6 (t=0), up to 31.8 on code, but prose drops to 14 at n3 (n2 prose 17.0). ROCm is a bit faster than Vulkan at n1/n2.
- DSpine on the fork at n-max 15 is best overall: 31.9 t/s at t=1.0 (2.5x plain), 42.4 at t=0 (3.3x); code 47.6 and 62.7 on the Tetris prompt; ISO parser 29 / 39; prose 18.7 / 25.2 (still above plain 12.9, and above MTP prose 14 to 17). n-max rises monotonically 2 -> 15, so 16-ish is the cap (block 16). No n-max above 15 exists. Sweeping n-max did not show a peak; 15 is the limit.
- vs Inkling 2 Mini (~33 t/s plain): DSpine n15 averages 31.9 at t=1.0 (47.6 on Tetris-style code but 18.7 on prose), i.e. about equal on a mixed mean for a much larger dense model; on code Qwen3.8+DSpine beats Inkling (47.6 vs ~33). Prose is clearly slower (18.7 vs ~33). Inkling stays the better prose/general model for speed.
- Not tried: DSpine Q8_0 draft, KV q8_0 cache types, target quants other than UD-Q4_K_M, Vulkan fork build, ctx larger than 16384 (recurrent-state copies cost memory with n-max 15), tokens-per-step statistics.

## Exact app settings for the winning Qwen setup (DSpine n15)
- Binary: mode "My own llama-server.exe", path `D:\LlamaCpp\bin\dspine-fork-4703b7d-rocm-gfx1151\llama-server.exe`. Needs `C:\Program Files\AMD\ROCm\7.2\bin` on the PATH of the app process (the app's AAP-58 logic adds the ROCm SDK dir for ROCm builds lacking hipblas; unverified for custom paths). Alternative that does not rely on this: copy hipblas.dll, rocblas.dll (+ rocblas\library), amdhip64_7.dll and dependencies next to the exe.
- Profile: model file `D:\LlamaCpp\models\unsloth\Qwen3.8-27B-GGUF\Qwen3.8-27B-UD-Q4_K_M.gguf`; draft file `D:\LlamaCpp\models\aj9o9\Qwen3.8-27B-DSpine-b16-GGUF\Qwen3.8-27B-DSpine-b16-Q4_K_M.gguf`; specType `draft-dflash`; draftNMax 15; draftGpuLayers all; GPU layers all (999); flashAttn on; ctxSize 16384 (set explicitly); extra args `-np 1 --jinja` (bench used exactly these; the card's `--cache-type-k/v q8_0` and `--spec-draft-type-k/v q8_0` options were NOT tested here).
- Equivalent command line used: `llama-server -m <UD-Q4_K_M> -md <DSpine Q4_K_M> --spec-type draft-dflash --spec-draft-n-max 15 --spec-draft-ngl all -ngl 999 -fa on -c 16384 -np 1 --jinja`.
- For prose-heavy use, or to stay on managed builds: unsloth b12651 rocm-gfx1151 managed source, specType `draft-mtp`, draft file `...\MTP\mtp-Qwen3.8-27B-Q4_0.gguf`, draftNMax 2 (prose-safe: 23.0 avg t=1.0, 17 on prose) or 3 (best code, 23.8 avg).
