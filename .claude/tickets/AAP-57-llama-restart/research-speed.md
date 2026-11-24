# AAP-57 research: why Inkling 2 Mini generates only ~7.8 tok/s on Strix Halo ROCm

## Question
Why does llama.cpp ggml-org b12651 ROCm run Inkling-2-Mini-IQ4_NL at ~7.8 tok/s on Ryzen AI Max+ 395 / Radeon 8060S (gfx1151), Windows 11, and what should be tried, in order?

## Answer
NOT proven from the server log: no llama-server output was available (see "Evidence gap"). The diagnosis below is inferred.
- 7.8 tok/s is far below what memory bandwidth allows (rough ceiling 40-60 tok/s, inferred), so the run is bound by kernels/launch overhead/compute, not by bandwidth or by CPU fallback of weights.
- Most likely cause: the ROCm HIP backend on Windows is slow for this model's MoE graph (IQ4_NL mul_mat_id kernels + 48 layer evaluations because of the 3x loop = many small kernels, no graph capture benefit on HIP). Vulkan RADV is the documented faster backend for generation on Strix Halo (+30% on Qwen3-30B-A3B, research-flags.md sec 4a).
- Possible secondary causes (not checkable without the load log): `-fa auto` resolving to off (KV/attention on slow path), or part of the graph (loop/conv-cache ops) scheduled on CPU.
- `--spec-draft-sampling probabilistic` does nothing with spec type none (confirmed from the profile, research-flags.md:21 shows it only acts with a spec type). Remove it; it is harmless noise.
- Try, in order: (1) read the load log for the 5 lines below; (2) `-fa on`; (3) Vulkan build of the same release; (4) llama-bench A/B; (5) different quantisation/other build only if 1-4 do not help; (6) lower reasoning_effort for real-world latency.

## Evidence gap (confirmed)
- llama-server stdout/stderr is NOT written to disk by the app. `src/local-servers.ts:321-336` (onData/pushLines) keeps only the last `maxLogLines` lines in memory (`entry.view.log`) and emits them to the UI. `proxy.log` contains only app lines for llama: the failed starts `2026-11-24T10:59:56.879Z WARN [local] llama: exited with code 1: error: invalid argument: --no-mmap` (proxy.log:17059..17101, before the AAP-55 fix) and `2026-11-24T11:33:41.644Z DEBUG [llama] inkling-2-mini: 376 chars, 6196 reasoning chars` (proxy.log:17181). No device list, offload count, buffer sizes, FA result or timing lines exist in any file (grepped "tokens per second", "eval time": no hits; no *.log under D:\LlamaCpp).
- At the time of this research no llama-server was running: no `llama-server.exe` process (tasklist, Get-Process), nothing listening on 8082 (netstat), `/health` returned HTTP 000. So `/props`, `/slots`, `/metrics` could not be read. The provider port is 8082 (settings.json providers.llama.port, confirmed).
- Consequence: the user must copy the log from the app's local-server log view, or the app should persist it (suggestion in "What the plan needs").

## What was confirmed locally
- CPU: Ryzen AI Max+ 395, 16 cores / 32 threads (Win32_Processor). `-t 16` matches physical cores.
- GPU: AMD Radeon 8060S, driver 32.0.12079.1014. Win32_VideoController.AdapterRAM = 4293918720 (about 4 GB) is the 32-bit WMI cap, NOT the real VRAM split; useless for the BIOS split. The registry qwMemorySize query returned nothing. Perf counters (idle, llama not running): dedicated usage 0.83 GB, shared 0.52 GB. BIOS UMA split therefore still unknown. Physical RAM 63.65 GB (Win32_ComputerSystem).
- Build: D:\LlamaCpp\bin\ggml-org-b12651-rocm, `ggml-hip.dll` is 1.19 GB and contains `gfx1151` strings (also gfx1150/1152/1100/1200...), so native gfx1151 kernels are compiled in; no "no kernel for gfx1151" fallback is expected (inferred from strings only; not a proof of per-op coverage).
- Model dir: D:\LlamaCpp\models\ggml-org\Inkling-2-Mini-GGUF.
- Provider flag presets (settings.json): `strix-halo-rocm`, `...-kv-q8`, `dspark-probabilistic`, `inkling-sampling`. The profile in use carries `--spec-draft-sampling probabilistic` from the dspark preset although spec is none.

## Path through the code
Not a code bug. App relevance only: flags are passed by the app from the profile (ctx, -ngl, -fa, extra args) to `llama-server.exe` spawned in `src/local-servers.ts` (spawn ~line 250, streams read at 255). Log is memory-only (321-336).

## Reproduction
Not reproduced; speed reported by the user (~7.8 tok/s). I did not send completions (instructed not to).

## Reasoning about expected speed (inferred)
- Bandwidth: Strix Halo LPDDR5X-8000, 256-bit, about 215 GB/s peak (about 120-200 achieved by llama.cpp on GPU; kyuz0 sources in research-flags.md).
- Per token the model reads the 8 active experts per layer plus attention/shared weights. Layers 6-17 (12 of 24) run 3x; if the 3 passes route to different experts, those layers read about 3x. Rough guess: 2-4 GB read per token -> a bandwidth ceiling of roughly 40-80 tok/s. Observed 7.8 is 5-10x under that, pointing to launch overhead / poorly optimised MoE kernels, or partly CPU execution.
- Comparable: Qwen3-30B-A3B Q4_K_XL on Strix Halo, ROCm tg128 about 64 tok/s, Vulkan RADV about 85 (kyuz0, research-flags.md:51). Inkling Mini does about 2.4x the layer evaluations of a 24-layer model per token (12 layers x3 + 12 layers = 48 vs 24: 2x), so 25-35 tok/s would be the "equivalent" expectation; 7.8 is still 3-4x lower. Quant IQ4_NL (non-K) MoE kernels on HIP are less optimised than Q4_K (inferred, no benchmark found).
- Another contributor: the 3x loop also means 3 KV + conv caches; with `-fa` off, attention over ctx up to 32768 per pass adds cost, but at short context this is small.
- mmproj: the vision encoder is not used for text generation, no effect on tg.
- Reasoning: output is dominated by reasoning tokens (log: "376 chars, 6196 reasoning chars"), so at 7.8 tok/s one answer takes minutes. Lowering reasoning_effort cuts wall time more than any flag.

## What to try, in order (with expected effect)
1. Capture the load log (no cost). Look for: `ggml_cuda_init: found 1 ROCm devices` / `Device 0: AMD Radeon 8060S Graphics, gfx1151`; `offloaded 25/25 layers to GPU` (or N/M); `ROCm0 model buffer size = ~17 GB` vs `CPU_Mapped model buffer size` (anything big on CPU = the problem); `KV buffer` on ROCm0 vs CPU; `flash_attn = ` (auto resolved: enabled/disabled); `graph splits = N` (a large number, e.g. >2-3, means ops fall back to CPU, which explains 7.8 tok/s); the `eval time = ... tokens per second` line per request. Expected: pinpoints which of the causes below applies.
2. `-fa on` (instead of auto). Expected: 0 to +20% if auto resolved to off; no change otherwise. Quick, restart only.
3. Download a Vulkan build of the same release (ggml-org win-vulkan x64) as a new managed binary, same flags, `-ngl all -fa on`. If the Vulkan backend lacks ops for inkling2_loop, graph splits will be high and it will be slow; check. Expected on Strix Halo: +20-40% tg vs ROCm (kyuz0/Phoronix), maybe more for IQ4_NL since Vulkan IQ4_NL mat-vec is well optimised (inferred). Biggest candidate.
4. A/B with llama-bench for a faster signal (from the research-flags.md sec 6 list): `llama-bench.exe -m <gguf> -ngl 99 -fa 0,1 -ub 512,1024 -p 512 -n 128 -r 3` on ROCm and Vulkan.
5. Env vars (low value): `ROCBLAS_USE_HIPBLASLT=1` no measurable change (kyuz0). `HSA_ENABLE_SDMA=0` is sometimes suggested on Windows/APU for odd transfers: unverified. `GGML_CUDA_FORCE_MMQ`-type switches only affect prompt processing. Do not expect gains here.
6. Check BIOS UMA frame buffer size and Windows "shared GPU memory" use: a very small dedicated VRAM (e.g. 0.5-4 GB) with the rest as GTT is normal on Strix Halo and works for HIP on Windows, but if the 17.6 GB model buffer lands in a path that is copied or pageable, speed suffers. Check with Task Manager GPU memory while loaded. Expected: informative only.
7. Drop `--spec-draft-sampling probabilistic` (no effect with spec none). Keep `-lm none` (no mmap; fine). Keep `-ub 1024`, `-np 1`, `-t 16`: these do not drive tg.
8. Speculative decoding: only if a compatible draft model loads; MoE+loop targets gain less (research-flags.md sec 4b/4c). Not a fix for a kernel-bound baseline.
9. Reduce reasoning_effort (`--chat-template-kwargs '{"reasoning_effort":"low"}'` or per request) to cut the number of generated tokens: perceived latency down by 2-10x regardless of tok/s.
10. Build-level: an Unsloth gfx1151-specific ROCm build exists locally (unsloth-b12649-mix-c7059d6-rocm-gfx1151, unsloth-b12588-...). Try it with the same flags; it may carry rocWMMA FA / tuned kernels (inferred from the folder name, not verified). Cheap A/B.

## What the plan needs
- Short term: user runs steps 1-3; the director needs the load log text to decide. No code change required for speed itself.
- Possible app change (optional, separate ticket): persist llama-server stdout/stderr of the latest start to a file (e.g. `%APPDATA%\api-acp-proxy\logs\llama-server.log`, truncated per start) next to proxy.log, because today the log lives in memory only (src/local-servers.ts:321-336) and was lost for diagnosis. Also remove `--spec-draft-sampling` from the dspark preset only when spec type is none? (a UX/warning idea, not needed).
- Could add a benchmark/preset for Vulkan once a Vulkan binary is installable (binary.backend supports `vulkan`? not checked in src/llama-install.ts).

## Risks
- Vulkan on Windows for this architecture is untested; may lack inkling2_loop ops and fall back to CPU.
- Switching the managed binary changes the shared installed build used by the embedding server (port 8083) too (settings.json: embedding enabled, same binary dir). Confirm before swapping (inferred from settings, not checked in code).
- Numbers from kyuz0/visorcraft/Phoronix are mostly Linux and other models; Windows driver 32.0.12079 may behave differently.

## Open questions
1. What does the load log say (devices, offload counts, buffers, flash_attn, graph splits, eval tok/s)? Not obtainable now: server stopped and logs not persisted.
2. Real BIOS UMA split (dedicated VRAM size)?
3. Does the Vulkan backend in current releases support inkling2_loop?
4. Is 7.8 tok/s measured at short or at long context (speed drops at depth)?
5. Does generation fall when the 3 passes are routed to different experts each (bandwidth), vs kernel-bound? A llama-bench run would split the two.
