# AAP-64 bench: Ternary Bonsai 2.5 27B (Q2_0) on Strix Halo gfx1151 (2026-11-26)

Harness: `.claude/temp/bonsai/run.mjs` (logs `srv-*.log`, `results.jsonl`). llama-server on port 18090 (my own process, killed after each run; the user's other servers were not touched; only ollama was running, idle).
Args: `-m <gguf> [--mmproj] -ngl 999 -fa on -c 32768 -np 1 --jinja --temp 1.0 --top-p 0.95 --top-k 20 --min-p 0`; requests via `/v1/chat/completions` (temp 1.0, top-p 0.95, top-k 20, min-p 0, max_tokens 600, thinking off via `enable_thinking:false`, cache_prompt false), after a warm-up. Prompts: a) Python ISO-8601 parser with tests (code), b) TCP congestion control (prose), c) single-file HTML Tetris (code). Gen = timings.predicted_per_second. PP = timings.prompt_per_second on these SHORT prompts (about 20-30 tokens), so it is not a real prompt-processing speed; treat as indicative only.

## Downloads (HF, sizes match the HF API byte for byte)
D:\LlamaCpp\models\prism-ml\Ternary-Bonsai-2.5-27B-GGUF\ (= `prism-ml/Ternary-Bonsai-2.5-27B-GGUF/...` relative to the app's models folder)
- Ternary-Bonsai-2.5-27B-Q2_0.gguf 7,673,194,848 B
- Ternary-Bonsai-2.5-27B-Q2_0-mtp.gguf 7,912,178,944 B
- Ternary-Bonsai-2.5-27B-mmproj-Q8_0.gguf 629,246,976 B

## Builds (newest local)
- ROCm: ggml-org b12681 `ggml-org-b12681-rocm` (ggml-hip.dll; needs the ROCm 7.2 SDK bin on PATH, as in AAP-58). Loaded and ran on the GPU (ROCm0 gfx1151).
- Vulkan: ggml-org b12681 `ggml-org-b12681-vulkan`, default settings (no GGML_VK_DISABLE_COOPMAT). No download needed.

## Results (gen t/s, a/b/c = code/prose/code)
| backend | build | config | gen avg | a/b/c | pp t/s (short prompts) | acceptance | output OK? |
|---|---|---|---|---|---|---|---|
| ROCm | b12681 | plain Q2_0 | 23.9 | 23.9/23.9/23.9 | ~105 | - | yes |
| Vulkan | b12681 | plain Q2_0 | 23.3 | 23.3/23.3/23.3 | ~113 | - | yes |
| ROCm | b12681 | MTP n2 | 43.2 | 48.2/36.6/44.8 | ~101 | 0.658 | yes |
| ROCm | b12681 | MTP n3 | 45.3 | 53.1/35.4/47.5 | ~101 | 0.581 | yes |
| ROCm | b12681 | MTP n4 | 46.7 | 56.8/34.3/49.0 | ~100 | 0.540 | yes |
| Vulkan | b12681 | MTP n3 | 38.1 | 45.1/28.5/40.6 | ~117 | 0.528 | yes |
Plain ROCm was run twice (23.9 both times; the first run had the MTP download still running). "Output OK" = coherent code and English prose, no garbage on either backend; the plain Q2_0 file loads and runs on stock b12681 for both (ROCm is not a dense fallback: 24 t/s, near the 7.7 GB / bandwidth bound).

## MTP
The `-mtp` GGUF has the draft head inside: `-m ...-Q2_0-mtp.gguf --spec-type draft-mtp --spec-draft-n-max N` (no `-md`, no draft file). Log: "creating MTP draft context against the target model". On ROCm MTP gives 1.8x (n2), 1.9x (n3), 1.95x (n4) over plain. Prose is the weak case and gets slightly worse with a larger n (36.6 / 35.4 / 34.3), code gets better (48 / 53 / 57). n3 chosen for the preset (same compromise as qwen3.8-27b-mtp). ROCm is faster than Vulkan with MTP (45.3 vs 38.1); plain is equal within 3%. Not tried: n5+, KV q8_0, thinking mode on, PTQ1_0/PQ2_0 (fork only).

## Vision
ROCm b12681 plain Q2_0 + mmproj-Q8_0, image `.claude/temp/aap11/red-circle.png` (a red circle on white), prompt "Describe this image in one sentence.": "A red circle is displayed against a plain white background." (23.8 t/s). Works. Vision with the MTP file or on Vulkan was not tested.
