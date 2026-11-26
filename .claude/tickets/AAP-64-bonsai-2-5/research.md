# AAP-64 research: PrismML Ternary Bonsai 2.5 27B GGUF (2026-11-26)

Research only; nothing downloaded or built. "Confirmed" = read on a primary page (HF card/file API, GitHub); "unverified" = secondary or not checked. Reddit refused automated fetch (thread not read).

## 1. Model and files
Confirmed (HF card https://huggingface.co/prism-ml/Ternary-Bonsai-2.5-27B-GGUF, file API /api/models/.../tree/main):
- Base Qwen3.8-27B (hybrid attention, ~75% linear / 25% full), arch tag `qwen35`, 27.36B params (24.35B LM 64 blocks, 0.47B vision tower, 2.54B embed/head). Apache-2.0. Context 262144. Thinking model by default; reasoning effort xhigh (default) or medium (`low` unsupported).
- Ternary g128 (-1/0/+1, FP16 scale per 128 weights, Hadamard-rotated), 1.76 bits/weight.
- Files (bytes): Q2_0 7,673,194,848 (7.67 GB); Q2_0-mtp 7,912,178,944; PTQ1_0 5,993,834,848 (5.99 GB); PTQ1_0-mtp 6,232,818,944; PQ2_0 7,253,354,848; PQ2_0-mtp 7,492,338,944; mmproj-BF16 931,145,856; mmproj-Q8_0 629,246,976. The "-mtp" files are single GGUFs with the draft head inside (no separate draft file). Dir `presets/llama.cpp` exists (contents not read; probably MTP launch presets).
- Sampling (card): thinking: temp 1.0, top_p 0.95, top_k 20, min_p 0, presence 0, repeat 1.0. Instruct: temp 0.7, top_p 0.8, top_k 20, min_p 0, presence 1.5. llama.cpp default min_p is 0.05, so pass `--min-p 0`. System prompt "You are a helpful assistant." Do not cap `-n` low (card uses 16384). `--chat-template-kwargs` reasoning_effort medium is used in the atomic.chat example (`--jinja`, `-fa on`, `-np 1`). No special chat-template notes on the card.
- Memory: RTX 3080 10 GB report 9.5 GB before `-np 1`, 7.8 GB after. KV ~64 KiB/token FP16 (atomic.chat estimate, unverified): 32k = 2 GiB, 131k = 8 GiB.

## 2. llama.cpp support
- Stock ggml-org runs the **Q2_0** file from build **b11556** (card). Older builds load it and print garbage. Upstream runtime support: PR #29600 (merged 2026-10-11, tested CPU/CUDA/Metal/Vulkan; HIP not mentioned); Vulkan FWHT kernels PR #29772 (merged 2026-11-05; 12-13% tg gain on Radeon 860M). Backend ops landed in separate PRs (not read).
- **PTQ1_0 and PQ2_0** need the fork https://github.com/PrismML-Eng/llama.cpp (PTQ1_0 upstream review pending). Fork releases (tags `prism-bNNNNN-<sha>`, latest prism-b12232-f702476, 2026-11-26) have Windows zips: `llama-prism-b12232-f702476-bin-win-{cpu-x64,cpu-arm64,vulkan-x64,hip-radeon-x64,cuda-12.4-x64,cuda-13.3-x64,sycl-x64}.zip`. HIP gfx targets not stated (unverified whether gfx1151 is included). Release description says "Q1_0 1-bit" support; PTQ1_0 not mentioned there.
- Card: PTQ1_0 "fastest decode on NVIDIA GPUs", PQ2_0 benchmarked on Metal. Stock Q2_0 109 t/s vs 150 on the fork in one test (card, GPU unspecified). Whether the Q2_0 path runs on HIP (gfx1151) or falls back to dense f32 / CPU: UNVERIFIED. On Vulkan it is confirmed working upstream.
- Local builds in D:\LlamaCpp\bin are b12588+ (> b11556) per the AAP-60 note, so any should load Q2_0 (not re-checked here).
- Uncensored: `AtomicChat/Ternary-Bonsai-2.5-27B-Uncensored-GGUF` (Ternary-Bonsai-2.5-27B-Uncensored-PTQ1_0.gguf, 5,993,834,848 B; needs the Prism fork, release prism-b12128-d7b2896) and a LoRA repo `AtomicChat/Ternary-Bonsai-2.5-27B-Uncensored-LoRA-GGUF` (8.67 MB adapter, scale 1.25, applied to the PTQ1_0 file). Source: atomic.chat blog (vendor numbers: refusals 0/24, MMLU 81.2% vs 80.2%). No Q2_0 uncensored file found.

## 3. Speeds (vendor card; none for AMD)
- Plain decode PTQ1_0: H100 186, RTX 4090 112, RTX 5090 163, A100 107, M5 Pro (Metal, PQ2_0) 30.2 t/s. MTP: H100 291, 4090 204, 5090 312, M4 Pro 29.2, Core Ultra SYCL 24.5.
- No Strix Halo / gfx1151 / ROCm number found. Bandwidth bound: 7.7 GB at ~256 GB/s gives an upper bound near 30 t/s plain (my estimate; Hadamard/dequant overhead unknown). Arc B580 community port 80-90 t/s (level1techs, custom branch).
- oneaiapikey blog (secondary): H100/4090 launch figures are with MTP; not independently reproduced.

## 4. App fit
Read: src/settings.ts (profiles at ~145-175, LLAMA_SOURCES = ggml-org|unsloth, LLAMA_SPEC_TYPES, requires {minBuild, sources}), src/llama-releases.ts (LLAMA_REPOS map; GGML_ASSET regex `llama-(bNNN)-bin-win-...`; buildNumber `^b(\d+)`), src/shared/gguf-names.ts.
- Q2_0 works on stock: **no new build source needed**; ggml-org Vulkan/ROCm builds are already selectable. `QUANT` matches `Q2_0` (also with the `-mtp` suffix); `ggufKind` classes `...-Q2_0-mtp.gguf` as "model" (DRAFT_NAME matches prefixes only), which is right for the embedded head.
- The mmproj file is `Ternary-Bonsai-2.5-27B-mmproj-BF16.gguf` (prefix is the model name), so `ggufKind` (`/^mmproj/i`) calls it a MODEL, not an mmproj. This is the one gguf-names fix.
- PTQ1_0 / PQ2_0: QUANT does not match them (`PTQ1_0` has no separator before `Q`). Only matters for the fork route.

### Needed changes (recommended route: Q2_0 on stock builds)
1. Built-in profile in LLAMA_PRESETS (src/settings.ts):
   - id `bonsai-2.5-27b`, label `Ternary Bonsai 2.5 27B (Q2_0, vision)`, model `bonsai-2.5-27b`, vision true
   - modelFile `prism-ml/Ternary-Bonsai-2.5-27B-GGUF/Ternary-Bonsai-2.5-27B-Q2_0.gguf`
   - mmprojFile `prism-ml/Ternary-Bonsai-2.5-27B-GGUF/Ternary-Bonsai-2.5-27B-mmproj-Q8_0.gguf`
   - ctxSize 32768, gpuLayers "all", flashAttn "on", specType "none"
   - extraArgs `-np 1 --jinja --temp 1.0 --top-p 0.95 --top-k 20 --min-p 0` (add the STRIX_HALO_ROCM flags only after measuring)
   - hf { repo `prism-ml/Ternary-Bonsai-2.5-27B-GGUF`, revision main, quant `Q2_0`, mmproj `Ternary-Bonsai-2.5-27B-mmproj-Q8_0.gguf` }
   - requires { minBuild 11556 } (no sources gate)
   An MTP preset on `-Q2_0-mtp.gguf`: how to launch the embedded head is unverified (presets/llama.cpp not read; probably `--spec-type draft-mtp` with the same file). Do not add it blind.
2. src/shared/gguf-names.ts: make the mmproj test accept `-mmproj-` anywhere, e.g. `/(^|[-_.])mmproj[-_.]/i`; one small test. Add PTQ1_0 / PQ2_0 to QUANT only for the fork route.
3. Nothing in llama-releases / llama-install for Q2_0. Fork route would need: `"prism"` in LLAMA_SOURCES, LLAMA_REPOS `PrismML-Eng/llama.cpp`, asset regex `^llama-prism-(b\d+-[0-9a-f]+)-bin-win-(cpu|vulkan|hip-radeon|cuda-[\d.]+|sycl)-(x64|arm64)\.zip$`, and a buildNumber parser for tags `prism-bNNNN-sha` (current `^b(\d+)` fails). Not recommended now: the PTQ1_0 gain is on NVIDIA and gfx1151 coverage of the HIP zip is unverified.
4. Without app change, the fork already works through binary mode "My own llama-server.exe" with a PTQ1_0 profile, `requires` omitted (same as qwen3.8-27b-dspine).

## Recommended route
1. Add the Q2_0 preset (item 1) plus the mmproj fix (item 2); no build-source work.
2. Test on an existing ggml-org Vulkan build and a ROCm gfx1151 build: load, coherent output (garbage means a too-old build), tok/s, GPU offload in the log. This answers the open ROCm question.
3. Only if Q2_0 on ROCm/Vulkan is slow or wrong, try the Prism fork Windows HIP/Vulkan zip via custom exe with PTQ1_0 (5.99 GB).

## Open questions for the user
- Include the uncensored variant (fork-only PTQ1_0; no Q2_0 build exists)? That forces the fork route.
- Vision in the default profile (mmproj-Q8_0, +0.63 GB)?
- Try the MTP file now (needs a launch test) or later?

## Sources
- https://huggingface.co/prism-ml/Ternary-Bonsai-2.5-27B-GGUF and https://huggingface.co/api/models/prism-ml/Ternary-Bonsai-2.5-27B-GGUF/tree/main
- https://github.com/ggml-org/llama.cpp/pull/29600 , https://github.com/ggml-org/llama.cpp/pull/29772
- https://github.com/PrismML-Eng/llama.cpp/releases (prism-b12232-f702476)
- https://oneaiapikey.com/resources/blog/bonsai-2-5-27b-ollama
- https://atomic.chat/blog/guides/how-to-run-bonsai-2-5-uncensored-locally
- Not read (refused): the r/LocalLLaMA thread.
