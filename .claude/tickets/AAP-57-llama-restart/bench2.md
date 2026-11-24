# AAP-57 bench 2: speculative decoding and newer builds, Inkling-2-Mini-IQ4_NL on Strix Halo (2026-11-24)

Logs: `.claude/temp/bench2/` (srv-*.log server logs, results.jsonl raw per-run data, run.mjs harness).
Method: llama-server `-ngl 999 -fa on -c 16384 -np 1 --jinja`, port 18991, one warm-up request, then 3 prompts (Tetris, TCP congestion control, ISO-8601 parser), n_predict 512, temperature 1.0 / top-p 1.0 / top-k 0 / min-p 0 (cache_prompt false), plus the Tetris prompt once at temperature 0. "gen" = mean of the 3 temp-1.0 predicted_per_second; "t=0" = the single temperature-0 run. Acceptance = draft_n_accepted / draft_n summed over the 4 requests. Existing llama-server.exe was not running (nothing to kill). ggml-org ROCm rows ran with `C:\Program Files\AMD\ROCm\7.2\bin` on PATH; Vulkan with `GGML_VK_DISABLE_COOPMAT=1`.
Prompt t/s: the prompts are 10-20 tokens, so prompt_per_second is noise (8 to 88 here); real pp is in bench.md (llama-bench pp512 650-750 unsloth). Not usable for ranking.

## Results (gen t/s, temperature 1.0 average of 3 prompts)
| build | spec config | gen avg | t=0 (Tetris) | acceptance | note |
|---|---|---|---|---|---|
| unsloth b12649 rocm-gfx1151 | none, fa on | 32.24 / 32.54 (2 runs) | 33.3 | - | baseline, best |
| unsloth b12649 | none, fa OFF | 29.79 / 30.06 | 33.1 / 30.6 | - | fa off about 8% slower |
| ggml-org b12651 rocm (+SDK PATH) | none | 29.49 | 30.1 | - | |
| unsloth b12649 | dspark n-max 2 | 19.9 | 27.0 | 0.41 | |
| unsloth b12649 | dspark n-max 3 | 20.4 | 27.8 | 0.37 | best dspark, still -37% |
| unsloth b12649 | dspark n-max 3, draft-sampling probabilistic | 18.86 | 28.5 | 0.42 | |
| unsloth b12649 | dspark n-max 3, p-min 0.5 | 31.62 | 31.8 | none drafted | p-min 0.5 rejects every block, equals plain |
| unsloth b12649 | dspark n-max 5 | 17.03 | 27.3 | 0.21 | |
| unsloth b12649 | dspark n-max 7 | 18.48 | 21.3 | 0.19 | |
| ggml-org b12651 rocm | dspark n-max 3 | fails to load | - | - | `check_tensor_dims: tensor 'markov_w1.weight' has wrong shape; expected 256, 200058, got 256, 201024` (draft needs the unsloth fork) |
| unsloth b12649 | draft-mtp n-max 2 / 3 | fails to load | - | - | `context type MTP requested but model doesn't contain MTP layers` (the IQ4_NL GGUF has no MTP heads) |
| unsloth b12651-mix-c7059d6 rocm-gfx1151 (new) | none | 31.89 | 32.6 | - | same as b12649 |
| unsloth b12651 | dspark n-max 3 | 18.93 | 27.9 | 0.33 | |
| ggml-org b12675 rocm (new, +SDK PATH) | none | 29.54 | 30.0 | - | |
| ggml-org b12675 rocm | dspark n-max 3 | fails to load | - | - | same markov_w1 shape error |
| ggml-org b12675 vulkan (new, coopmat off) | none | 31.47 | 32.0 | - | |
Per-request acceptance for dspark n3 (b12649): 0.34 / 0.28 / 0.32 at temp 1.0; 0.58 for the temp-0 request (and 0.85 on the very first warm-up request "Hello" at temp 0). Acceptance falls at temperature 1.0 and the verify cost for the looped 26B MoE (3x layer passes, 8 of 128 experts per token, batched verify touches more experts) outweighs the accepted tokens even at 58%.

## Winner
Plain, no speculative decoding: unsloth rocm-gfx1151, flash attention on, about 32 to 33 t/s. DSpark is slower in every config tried (best 20.4 at temp 1.0, 27.8 at temp 0 against 32 to 33 plain). MTP is unavailable for this model file. Newer builds (ggml-org b12675, unsloth b12651) gave no speed change. Vulkan (31.5) ties ROCm but needs the coopmat env var; unsloth ROCm is simpler and about 2 t/s faster than ggml-org ROCm.
Caveat: run to run noise is about +-0.5 t/s; the 8% FA gap and 20 to 40% DSpark gap are well outside it.

## Exact app settings
- Source: unsloth. Version: b12649-mix-c7059d6 (already installed; the newer b12651-mix-c7059d6 is also extracted as `D:\LlamaCpp\bin\unsloth-b12651-mix-c7059d6-rocm-gfx1151` and is equivalent). Backend: rocm-gfx1151.
- Flash attention: on. Speculative decoding type: none. Draft file: empty. Draft tokens max/min: not used (empty/default). Draft GPU layers: not used. Extra arguments: none needed (remove `--spec-draft-sampling probabilistic`). Keep GPU layers all, `-np 1`, `-lm none`, `-ub 512` or 1024 as before.
- Context 16384 used in the bench; the earlier bench showed ctx 8192 to 32768 does not change tg materially, d8192 costs about 12%.

## DSpark preset
The built-in preset values (draft max 5, draft GPU layers all) should change if the preset is meant to speed things up: on this model it does not. Draft max 5 is worse than 3 (17.0 vs 20.4 at temp 1.0), and all DSpark values are slower than plain. Recommendation: remove the preset's speed claim or label DSpark experimental for Inkling-2-Mini; if kept, default to n-max 3 (not 5), draft GPU layers all, and require an unsloth build (ggml-org builds, including b12675, cannot load the Inkling DSpark draft: vocab 201024 vs 200058). Do not auto-apply `--spec-draft-p-min 0.5` (it silently disables drafting for this draft). These conclusions apply to this IQ4_NL target and Q8_0 draft at temperature 1.0 on Strix Halo; a higher-quant or different draft was not tested.

## Installed for the app
New folders under `D:\LlamaCpp\bin` (SHA-256 verified against the GitHub release digest, extracted with the app's `<source>-<tag>-<backend>` naming, no `.llama-install` record, like the other hand-placed folders): `ggml-org-b12675-rocm`, `ggml-org-b12675-vulkan`, `unsloth-b12651-mix-c7059d6-rocm-gfx1151`. Latest releases at the time: ggml-org b12675 (marked prerelease by GitHub, as all recent ggml-org builds are), unsloth b12651-mix-c7059d6. Nothing in the repo or settings.json was changed; no llama process left running (checked).
