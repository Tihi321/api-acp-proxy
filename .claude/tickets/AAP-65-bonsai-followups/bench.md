# AAP-65 bench: Strix Halo ROCm flags on Ternary Bonsai 2.5 27B (2026-11-26)

Build ggml-org b12681 ROCm (ROCm 7.2 bin on PATH), port 18091 (own process, killed after each run). Common args: `-ngl 999 -fa on -c 32768 --jinja --temp 1.0 --top-p 0.95 --top-k 20 --min-p 0`; MTP rows add `--spec-type draft-mtp --spec-draft-n-max 3`. Harness `.claude/temp/bonsai65/run.mjs`, raw `results.jsonl`.
- a = current preset (`-np 1`); b = `-lm none -ub 1024 -np 1 -t 16`; c = b + `-ctk q8_0 -ctv q8_0`.
- Gen t/s: code prompt (Python ISO-8601 parser) and prose prompt (TCP congestion), 400 tokens, thinking off, 2 runs each, after a warm-up.
- Prompt t/s: first 9000 chars of src/settings.ts + "Summarize" = 2747 prompt tokens (`-ub 1024` is the knob this tests), cache_prompt off, 2 runs.
- Load = process start to /health ok.

| model | cfg | load s | gen code (2 runs) | gen prose (2 runs) | prompt t/s (2747 tok) |
|---|---|---|---|---|---|
| plain Q2_0 | a | 2.9 | 24.0 / 24.1 | 23.9 / 24.2 | 404.6 / 404.7 |
| plain Q2_0 | b | 2.9 | 24.2 / 24.2 | 24.2 / 24.2 | 394.6 / 394.3 |
| plain Q2_0 | c | 2.9 | 24.0 / 24.0 | 24.0 / 23.9 | 392.6 / 391.9 |
| MTP n3 | a | 3.2 | 49.1 / 53.7 | 35.3 / 38.7 | 401.9 / 401.4 |
| MTP n3 | b | 3.2 | 51.6 / 51.5 | 34.3 / 33.7 | 393.4 / 392.8 |
| MTP n3 | c | 3.4 | 53.0 / 49.7 | 36.3 / 34.4 | 391.9 / 391.3 |

Variance: plain gen is stable (+-0.2 t/s); MTP gen varies run to run by up to 10% (sampling at temp 1.0 changes the acceptance), so a/b/c MTP gen differences are inside noise. Prompt t/s is stable (+-0.3).

## Findings and decision
- Gen: b and c equal a for plain (24.0 to 24.2); MTP unchanged within noise.
- Prompt t/s: b is about 2.5% SLOWER than a (395 vs 405 plain, 393 vs 402 MTP); c about 3% slower. `-ub 1024` does not help on this model; the default ub 512 is as good or better.
- Load: 2.9 s in a, b and c (3.2 to 3.4 s MTP). The files were in the OS cache, so `-lm none` shows no load-time gain.
- Decision rule needs b faster on prompt t/s or load: it is not. **No code change**: the Bonsai presets keep `-np 1 --jinja <sampling>`. KV q8_0 (c) gives no speed gain either (gen equal; only memory saved); not adopted.
- Not measured: cold-cache load (first load after boot) where `-lm none` could differ.
