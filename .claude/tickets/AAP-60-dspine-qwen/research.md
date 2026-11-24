# AAP-60 research: Qwen3.8-27B + Tencent DSpine draft (2026-11-24)

Research only; nothing downloaded or built. "Confirmed" = read on a primary page; "unconfirmed" = secondary/blog only.

## 1. Does it exist
Confirmed:
- Draft (safetensors): `tencent/Qwen3.8-27B-DSpine-b16` (HF API: model.safetensors + config.json, Apache-2.0, BF16, 2,025,912,064 params = ~2.0B, 4.05 GB, base_model Qwen/Qwen3.8-27B). https://huggingface.co/tencent/Qwen3.8-27B-DSpine-b16
- Also `tencent/Qwen3-8B-DSpine-b16`. Repo https://github.com/tencent/dspine (engines: SGLang 0.5.22, vLLM from main, MLX; llama.cpp NOT mentioned; params/layers not stated in README). Paper arXiv 2609.36173.
- Community GGUF of the draft: `aj9o9/Qwen3.8-27B-DSpine-b16-GGUF`: Q4_K_M 1.26 GB (recommended), Q8_0 2.20 GB, BF16 4.06 GB. https://huggingface.co/aj9o9/Qwen3.8-27B-DSpine-b16-GGUF
- "5 layers, block of 16": only in secondary blogs. The 16 matches `-b16` and `--spec-draft-n-max 15`; "5 layers" unverified (config.json not read).

Qwen3.8-27B target GGUF: `unsloth/Qwen3.8-27B-GGUF` (sizes from HF API): UD-Q4_K_M 16.56 GB, UD-Q4_K_XL 17.66, UD-Q5_K_M 19.87, UD-Q6_K 21.98, UD-Q6_K_XL 25.30, Q8_0 29.05, UD-Q8_K_XL 31.46, BF16 54.7 (2 shards), mmproj-F16 0.93, MTP/mtp-Qwen3.8-27B-Q4_0 1.37. Only UD- variants for Q4_K_M/Q6_K (no plain ones). ggml-org repo not checked.

Fit: ~100 GB visible, so every quant fits. Decode on Strix Halo is bandwidth-bound (~256 GB/s): Q6_K baseline is only 9.6 tok/s (Vulkan), so a smaller target is faster. Suggest UD-Q4_K_M (16.56 GB) first, UD-Q6_K (21.98 GB) as quality compare; Q8_0 is slowest. Draft: Q4_K_M 1.26 GB (or Q8_0 2.2 GB).

## 2. llama.cpp support
- Upstream: NOT merged. PR https://github.com/ggml-org/llama.cpp/pull/31941 "spec : add DSpine draft support" (author pratiknarola-t, branch `dspine`), open, marked ready for review 2026-11-20; maintainers (ruixiang63, am17an, CISC, ngxson) want a refactor (own dspine.cpp like dflash2/lilicorr). Adds `--spec-type draft-dspine`; `draft-dflash` also auto-detects a DSpine GGUF. Needs `--no-repack` if the target head lands in a CPU repack buffer. Author discloses AI-assisted code.
- Fork used by the GGUF card: https://github.com/Ajay9o9/llama.cpp, branch `dspine`. Windows binaries: none (Releases empty; card documents only `-DGGML_CUDA=ON`).
- Flags on that fork (card): `-m target.gguf -md draft.gguf --spec-type draft-dflash --spec-draft-n-max 15 -ngl 999 --spec-draft-ngl 999 -fa on --jinja -c 32768 -np 1 --cache-type-k q8_0 --cache-type-v q8_0 --spec-draft-type-k q8_0 --spec-draft-type-v q8_0`. Set -c manually (no auto-fit).
- Checked locally: `--spec-type` in all 8 builds in D:\LlamaCpp\bin (ggml-org b12613/b12651/b12675 rocm+vulkan, unsloth b12588/b12649/b12651) lists none, draft-simple, draft-eagle3, draft-mtp, draft-dflash, draft-dspark, draft-dflash2, draft-lilicorr, ngram-*. No draft-dspine. Per the card, stock llama.cpp refuses to load DSpine GGUFs, so draft-dflash on current builds will not work.
- Build on Windows (not tried): needs cmake, ninja, git, VS Build Tools (cmake/ninja were not on PATH in my shell; ROCm 7.2 has clang++/hipcc in C:\Program Files\AMD\ROCm\7.2\bin). Standard llama.cpp HIP recipe (generic, unverified on this branch):
  `cmake -S . -B build -G Ninja -DGGML_HIP=ON -DAMDGPU_TARGETS=gfx1151 -DCMAKE_C_COMPILER="C:/Program Files/AMD/ROCm/7.2/bin/clang.exe" -DCMAKE_CXX_COMPILER="C:/Program Files/AMD/ROCm/7.2/bin/clang++.exe" -DCMAKE_BUILD_TYPE=Release -DLLAMA_CURL=OFF` then `cmake --build build -j`. Vulkan alternative: `-DGGML_VULKAN=ON` (needs Vulkan SDK/glslc). Copy build\bin to D:\LlamaCpp\bin\dspine-<sha>-rocm. The AAP-58 note applies (ROCm bin on PATH). Effort ~1 h, moderate risk (the fork may lag master, missing newer Qwen3.8 fixes).
- The PR reports lossless parity tested on gfx1151 for both HIP and Vulkan, so both backends should run.

## 3. Speeds / caveats
- UNCONFIRMED: "~132 tok/s on consumer setups" and the r/LocalLLaMA thread; no source found. Found: 104.8 tok/s on RTX 3090 (hermes-ai, alphasignal; secondary); the GGUF card says ~125 tok/s code/math, ~90 mixed on RTX 3090 Q4_K_M (~3.2x), ahead of DFlash2. Acceptance (secondary): ~9.5 tokens/step math, 8.9 C++, 2.8 prose.
- Strix Halo: no DSpine number found. PR #31941 on GB10 (CUDA): Qwen3.8-27B Q8_0 DSpine 29.5 vs DFlash 29.6 tok/s, i.e. no gain over DFlash ("27B draft step costs more", not profiled). gfx1151 only tested for parity/acceptance on 2 prompts.
- Other AMD reports (card): R9700 ROCm best n-max 15, code 2.2x vs target MTP, tool calls 3.4x, prose/chat 4-23% slower than MTP; RX 7800 XT Vulkan best n-max 2 (47.4 vs 30.9; n-max 15 dropped to 19.1); RX 9060 XT ROCm best 6. Best n-max is hardware dependent; on bandwidth-poor Strix Halo (especially Vulkan) expect a small n-max (try 4-8).
- Caveats: strongest on code/math/tool calls, weak on prose; output may differ slightly even at temp 0; context limited by recurrent-state copies (24 GB: 64k at n-max 15); T=1 acceptance lower than T=0 (Tencent table, Qwen3-8B: 6.98 vs 7.83).
- Strix Halo baseline: Qwen3.8-27B Q6_K Vulkan 9.59 tok/s, with built-in MTP n-max 2 -> 18 tok/s (https://sleepingrobots.com/dreams/qwen38-mtp-strix-halo/); same article says ROCm 7.2.4 toolbox could not load Qwen3.8 yet (check ROCm on current builds). MTP works on stock builds today (`draft-mtp` + MTP/mtp-Qwen3.8-27B-Q4_0.gguf) and is the low-risk 2x baseline to beat.

## 4. App changes
- src/settings.ts:98-99: `LLAMA_SPEC_TYPES` is a closed z.enum, no `draft-dspine`. `LLAMA_SOURCES = ["ggml-org","unsloth"]`; `binary.mode` "custom" + `customPath` exist (settings.ts:243-250). src/llama-releases.ts: per-source repo map LLAMA_REPOS and asset regexes (unsloth `app-*-windows-*.zip`). src/llama-args.ts:43-49 emits `--spec-type X --spec-draft-model F --spec-draft-n-max N --spec-draft-n-min N --spec-draft-ngl N`.
- Works today with NO code change: binary mode "My own llama-server.exe" pointing at a self-built dspine llama-server.exe; a profile with specType `draft-dflash` (the fork auto-detects the DSpine GGUF), draftFile = the DSpine GGUF, draftNMax 4-15, draftGpuLayers "all", explicit ctxSize, extraArgs `-np 1 --cache-type-k q8_0 --cache-type-v q8_0 --spec-draft-type-k q8_0 --spec-draft-type-v q8_0 --jinja` (plus `--no-repack` if that error appears). Not verified: how AAP-58 GPU check and `requires` behave with a custom path.
- Only if upstream merges: add `"draft-dspine"` to LLAMA_SPEC_TYPES (one line) and optionally a preset. No new managed source: nobody publishes Windows gfx1151 binaries of the fork, so there is nothing to download.

## Recommended path
1. Download (~18 GB): unsloth UD-Q4_K_M (16.56 GB) + aj9o9 DSpine Q4_K_M (1.26 GB); optionally UD-Q6_K (21.98 GB) later.
2. Build Ajay9o9/llama.cpp `dspine` for gfx1151 (HIP 7.2; Vulkan if HIP fails) into D:\LlamaCpp\bin\dspine-<sha>-<backend>.
3. Add a custom-binary profile (no app change); sweep n-max 2/4/8/15 on code vs prose; compare with stock MTP (18 tok/s on Q6_K Vulkan).
4. Expect a gain mainly on code/tool calls; keep MTP for prose. Revisit when PR #31941 merges and builds ship `draft-dspine`.

## Sources
- https://github.com/tencent/dspine
- https://huggingface.co/tencent/Qwen3.8-27B-DSpine-b16
- https://huggingface.co/aj9o9/Qwen3.8-27B-DSpine-b16-GGUF
- https://github.com/ggml-org/llama.cpp/pull/31941
- https://github.com/Ajay9o9/llama.cpp/tree/dspine
- https://huggingface.co/unsloth/Qwen3.8-27B-GGUF
- https://sleepingrobots.com/dreams/qwen38-mtp-strix-halo/
- Secondary (numbers unverified): https://hermes-ai.net/news/tencent-s-dspine-pushes-qwen3-8-27b-to-104-8-tok-s-on-a-single-gpu/ , https://alphasignal.ai/news/tencent-s-dspine-pushes-qwen3-8-27b-to-104-8-tok-s-on-a-single-gpu
