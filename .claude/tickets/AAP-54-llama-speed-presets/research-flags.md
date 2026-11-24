# AAP-54 research: llama-server speed flags for Inkling 2 Mini on Strix Halo (2026-11-24)

Confidence note: no source benchmarks Inkling 2 Mini on Strix Halo. Everything below is inferred from other models/hardware reports plus this build's --help. Treat it as a starting point and benchmark (section 6).

## 1. Machine and builds (checked locally)
- CPU: AMD Ryzen AI Max+ 395, 16 cores / 32 threads. GPU: Radeon 8060S (driver 32.0.12079.1014).
- OS-visible RAM: 63.6 GB (Win32_ComputerSystem), NOT 128 GB. The 17.6 GB IQ4_NL + 0.35 GB mmproj + KV fit easily; do not assume 128 GB when sizing ctx.
- Builds in D:\LlamaCpp\bin: ggml-org-b12613-rocm, ggml-org-b12651-rocm (build 12651, commit f5e6915c2), unsloth-b12588-mix-...-rocm-gfx1151, unsloth-b12649-mix-c7059d6-rocm-gfx1151 (build 12649, commit 189f431bf).
- No Vulkan build is present in D:\LlamaCpp\bin (only ROCm folders). Comparing Vulkan needs a new download.
- I ran only `llama-server.exe --help` / `--version`. No model was loaded.

## 2. Model facts
- Source: https://huggingface.co/ggml-org/Inkling-2-Mini-GGUF
- Architecture `inkling2_loop`: looped MoE, 26B params, 24 layers, 128 routed experts, 8 active per token. Layers 6-17 are a loop core run 3x per token (48 layer evaluations, 24 layers of weights); each pass has its own KV + conv cache. The card does not state active params in B. IQ4_NL = 4-bit experts in layers 0-19, Q8_0 elsewhere.
- Consequence: it is MoE, so `-ngl all` with everything on the iGPU is right on unified memory. --n-cpu-moe / -ot are NOT needed (they only help when VRAM is too small; on Strix Halo VRAM and RAM are the same pool). Keep them unset.
- The loop keeps separate KV per pass, so KV per token is larger than a 24-layer model suggests.

## 3. Flags present in this build (checked with --help, both ggml-org b12651 and unsloth b12649)
Present in both: -fa/--flash-attn [on|off|auto], -b (default 2048), -ub (default 512), -ctk/-ctv, -np, -cb/--cont-batching, -t/-tb, mmap options (--mmap/--no-mmap/--mlock, direct-io group), -fit/-fitt/-fitc, -cmoe, -ncmoe, -ot, --no-host, --op-offload/--no-op-offload, --no-warmup, --poll, -kvu/--kv-unified, -cram/--cache-ram, -ctxcp, --mmproj, --mmproj-offload, --image-min-tokens/--image-max-tokens, --sleep-idle-seconds.

Speculative flags (identical in both builds): `--spec-type none,draft-simple,draft-eagle3,draft-mtp,draft-dflash,draft-dspark,draft-dflash2,draft-lilicorr,ngram-*`. So draft-dspark and draft-mtp exist in the ggml-org build too, not only Unsloth's. Also --spec-draft-model/-md, --spec-draft-n-max (default 3), --spec-draft-n-min (0), --spec-draft-p-min (0.00), --spec-draft-p-split (0.10), --spec-draft-ngl/-ngld (default auto), --spec-draft-n-ubatch, -ctkd/-ctvd, --spec-draft-sampling {greedy,probabilistic} (default greedy), --spec-draft-device/-devd, --spec-default.
Removed (they error): --draft, --draft-max, --draft-min, --spec-ngram-size-*. Use --spec-draft-n-max / --spec-draft-n-min.
Whether the Unsloth build is needed for the dspark draft GGUF is unverified (the ggml-org build lists draft-dspark too).

## 4. Recommended flag sets

### 4a. Plain (no speculative decoding)
```
llama-server -m Inkling-2-Mini-IQ4_NL.gguf --mmproj mmproj-Q8_0.gguf --jinja
  -c 32768 -ngl all -fa on --no-mmap -ub 1024 -b 2048 -np 1 -t 16
  --temp 1.0 --top-p 1.0 --top-k 0 --min-p 0.0
```
Optional: `-ctk q8_0 -ctv q8_0` only if memory is tight (see below).

| Flag | Why | Source / confidence |
|---|---|---|
| `-ngl all` | Unified memory gives the GPU full bandwidth (~2x the CPU path). Keep. | kyuz0 https://raw.githubusercontent.com/kyuz0/strixhalo-homelab/HEAD/AI/llamacpp-performance.md (high) |
| `-fa on` instead of auto | kyuz0 recommends `-fa 1` for real-world/long context. Auto may resolve to off if the arch lacks a FA kernel, so set on and compare with off. | same (medium, benchmark) |
| `--no-mmap` | kyuz0: always disable mmap; "catastrophically slower" on ROCm when loading to GPU with mmap. Affects load time, not steady tg. visorcraft found mmap/no-mmap negligible (conflict; low risk either way). `-dio` is the fallback if loads hang. | kyuz0; https://raw.githubusercontent.com/visorcraft/strix-halo-llm-perf/main/README.md |
| `-ub 1024` (try 512/1024/2048) | Larger ub can raise prompt processing at long context, costs peak memory. visorcraft found batch size negligible, so this is a pp tweak at most, not gen. | kyuz0 + visorcraft (medium-low) |
| `-ctk q8_0 -ctv q8_0` | Halves KV memory (loop model has 3 passes of KV). Quantized V needs FA on. Can be slightly slower than f16 on ROCm, so it is a memory trade, not a speed gain. At ctx 32768 it is not needed for speed. | llama.cpp --help (uncertain, benchmark) |
| `-np 1` | One slot gives full ctx. Cont-batching is on by default. Raise only for concurrent requests. | --help (high) |
| `-t 16` | Physical cores. With -ngl all the CPU does little. | general (low) |
| keep warmup on | The first HIP run is much slower; warm up before measuring. | visorcraft (medium) |
| `--n-cpu-moe`, `-ot` | Leave unset; all weights fit on the iGPU pool. | analysis (high) |
| `--mlock` | Skip; with unified memory and --no-mmap it adds nothing. | analysis (medium) |

ROCm env vars: `ROCBLAS_USE_HIPBLASLT=1` made no measurable difference in kyuz0's runs (pp512 651.9 vs 650.6, tg128 63.95 vs 64.17). Not worth setting. rocWMMA flash attention (`-DGGML_HIP_ROCWMMA_FATTN=ON`) is a build-time option kyuz0 recommends; whether the shipped b12651 build has it is unknown.

ROCm vs Vulkan (matters most for gen speed):
- Vulkan RADV usually wins token generation on Strix Halo and holds up at long context; ROCm tends to win prompt processing. kyuz0 (Qwen3-30B-A3B Q4_K_XL): Vulkan RADV tg128 85.1 vs ROCm 64.2 (untuned); at depth 130560 RADV 12.5 vs ROCm 5.0 (untuned), 13.3 with lhl's tuned ROCm branch. visorcraft: Vulkan RADV for interactive serving, ROCm for batch/prefill. Phoronix: Vulkan ahead of ROCm 7.0 on Strix Halo for Qwen3-8B. https://www.phoronix.com/review/amd-rocm-7-strix-halo/3 , https://www.phoronix.com/review/lemonade-vulkan-rocm/2
- Counter-evidence: a Level1Techs user measured ROCm faster at empty context (46 vs 32 tok/s, 35B MoE with MTP) and 37.5 vs 28.9 at full context. https://forum.level1techs.com/t/strix-halo-llm-inference-notes/249466/9
- So Vulkan RADV is the best candidate to beat current ROCm tg. Unverified for Inkling 2 (the Vulkan backend must support its loop/conv-cache ops). Most cited numbers are Linux; Windows drivers differ.

### 4b. DSpark (target + Q8_0 draft)
```
llama-server -m Inkling-2-Mini-IQ4_NL.gguf --mmproj mmproj-Q8_0.gguf --jinja
  -c 32768 -ngl all -fa on --no-mmap -np 1
  --spec-type draft-dspark --spec-draft-model dspark-Inkling-2-Mini-Q8_0.gguf
  --spec-draft-ngl all --spec-draft-n-max 5 --spec-draft-p-min 0
  --temp 1.0 --top-p 1.0 --top-k 0 --min-p 0.0
```
| Flag | Why | Source / confidence |
|---|---|---|
| `--spec-type draft-dspark` + `--spec-draft-model` | Required. The docs say dspark currently supports only drafts with a Qwen3 backbone; check the Inkling draft loads in your build (docs may be stale). | https://github.com/ggml-org/llama.cpp/blob/master/docs/speculative.md |
| `--spec-draft-n-max` 3 -> try 5 and 7 | The docs example uses 7; value is clamped to the draft's trained block size. The Small DSpark card evaluates block size 7 with mean acceptance length ~3.7-3.8 (Small, SGLang, not Mini). With acc_len that high, n-max above 3 can pay off. Benchmark 3/5/7. | docs above; https://huggingface.co/Anbeeld/Inkling-Small-DSpark-GGUF (medium) |
| `--spec-draft-p-min` 0 -> 0.1-0.3 | Above 0 it truncates a block at the first position whose predicted acceptance (confidence head) is below the threshold; needs a draft with a confidence head (unknown for the Mini draft). Keep 0 if unsupported. | docs above (medium-low) |
| `--spec-draft-ngl all` | Draft is small; keep on GPU. | --help (high) |
| `--spec-draft-sampling probabilistic` (try) | Default greedy. At temp 1.0 probabilistic with rejection sampling can raise acceptance. | --help (low) |
| `-np 1` | Draft gains shrink with several active slots; docs do not cover slot interplay. | analysis (medium) |
| `-fa on` | The dspark docs example uses `-fa on --jinja`. | docs above (high) |

There is no separate draft ctx flag; the draft context follows -c (`-ctkd/-ctvd` set draft KV type; `--spec-draft-n-ubatch` only saves VRAM). Because the target is a looped model (3x layer passes per verify), low acceptance can make DSpark slower than plain; compare with 4a. No source gives measured Mini DSpark speedups.

### 4c. MTP (model's own heads)
```
(same base as 4a) --spec-type draft-mtp --spec-draft-n-max 3
```
- Needs a GGUF containing the MTP heads. The ggml-org IQ4_NL card does not mention MTP. Verify in the load log before relying on it. Support for Inkling 2 Mini MTP in b12651 is unconfirmed; no source found.
- Other-model evidence: +12% on a 35B MoE (Metal, draft 3-4), ~2x on a 27B dense (Strix Halo), mixed on 35B MoE. https://bayesiansapien.github.io/cere-bro/inference-efficiency/2026-05-17-mtp-llama-cpp-merge-strix-halo-benchmarks , https://dev.to/someoddcodeguy/llamacpps-new-mtp-on-macos-4ea0 . MoE targets gain far less than dense; Inkling Mini is MoE (8 of 128 experts), so expect a small gain; start with n-max 2-3.
- Risk: one report says sending image input with MTP enabled crashed llama.cpp. Do not combine with --mmproj until tested.
- `--spec-type` accepts a comma list, but combining DSpark and MTP is untested.

## 5. Sampling (separate from speed)
- Unsloth (Inkling 2 Small guide, same family): temperature 1.0, top-p 1.0, top-k 0, min-p 0.0, with `--jinja`; reasoning set via `--chat-template-kwargs '{"reasoning_effort":"high"}'`. https://unsloth.ai/docs/models/inkling-2
- The ggml-org Mini card lists NO sampling values; it only documents reasoning_effort (none, minimal, low, medium, high [default], xhigh, max, or a number 0.0-0.99). https://huggingface.co/ggml-org/Inkling-2-Mini-GGUF
- The current "--temp 1.0 --top-p 1.0 --top-k 0 --min-p 0.0" matches Unsloth's guidance for the family. Lowering reasoning_effort is likely the biggest real latency lever (fewer thinking tokens), larger than any flag above.
- Draft acceptance is better at lower temperature; the DSpark Small eval used T=0 and T=1.0 with top-p 0.95.

## 6. What to benchmark (user can run)
From D:\LlamaCpp\bin\ggml-org-b12651-rocm (check `llama-bench --help` for exact flag spellings; model path is a placeholder):
```
llama-bench.exe -m <Inkling-2-Mini-IQ4_NL.gguf> -ngl 99 -fa 0,1 -ub 512,1024,2048 -mmp 0,1 -p 512 -n 128 -r 3
llama-bench.exe -m <same> -ngl 99 -fa 1 -ctk f16,q8_0 -ctv f16,q8_0 -p 512 -n 128 -d 0,8192,30000 -r 2
```
Repeat with a Vulkan build of the same release (RADV; set `AMD_VULKAN_ICD=RADV` if several ICDs exist) to compare tg.
Speculative: llama-bench does not run drafts. Use llama-server with a fixed prompt, read the eval tokens/s and draft acceptance lines in the log, sweeping `--spec-draft-n-max` 2,3,5,7 and p-min 0/0.2 at temp 1.0, versus 4a.

Open questions: (1) does -fa auto already resolve to on (load log)? (2) does Vulkan support inkling2_loop ops? (3) does the Mini dspark draft have a confidence head? (4) is MTP in the IQ4_NL file? (5) is rocWMMA FA compiled into the b12651 ROCm build? (6) real RAM (Windows reports 63.6 GB) and the iGPU memory split in BIOS/Adrenalin.

## Sources
- https://huggingface.co/ggml-org/Inkling-2-Mini-GGUF
- https://unsloth.ai/docs/models/inkling-2
- https://github.com/ggml-org/llama.cpp/blob/master/docs/speculative.md
- https://huggingface.co/Anbeeld/Inkling-Small-DSpark-GGUF
- https://raw.githubusercontent.com/kyuz0/strixhalo-homelab/HEAD/AI/llamacpp-performance.md
- https://raw.githubusercontent.com/visorcraft/strix-halo-llm-perf/main/README.md
- https://forum.level1techs.com/t/strix-halo-llm-inference-notes/249466/9
- https://www.phoronix.com/review/amd-rocm-7-strix-halo/3 , https://www.phoronix.com/review/lemonade-vulkan-rocm/2
- https://bayesiansapien.github.io/cere-bro/inference-efficiency/2026-05-17-mtp-llama-cpp-merge-strix-halo-benchmarks
- https://dev.to/someoddcodeguy/llamacpps-new-mtp-on-macos-4ea0
