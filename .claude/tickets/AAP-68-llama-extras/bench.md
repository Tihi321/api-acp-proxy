# AAP-68 bench: Bonsai 2.5 27B (Q2_0) with thinking ON (2026-11-26)

Build ggml-org b12681 ROCm (ROCm 7.2 on PATH), port 18091, own process per row. Args as AAP-65 (`-ngl 999 -fa on -c 32768 --jinja --temp 1.0 --top-p 0.95 --top-k 20 --min-p 0`), MTP rows add `--spec-type draft-mtp --spec-draft-n-max N`. Requests have no `enable_thinking:false`, `max_tokens` 2048, `cache_prompt:false`, 2 runs each. Harness `.claude/temp/bonsai68/run.mjs`. Reasoning/answer token split is estimated from the character share of `reasoning_content` vs `content`.

| Profile | Prompt | gen t/s (2 runs) | MTP acceptance | Tokens reasoning / answer | Answer completed |
|---|---|---|---|---|---|
| plain | code | 23.6, 23.5 | - | 2048 / 0 (both) | no (length) |
| plain | prose | 23.5, 23.4 | - | ~65 / ~290 | yes |
| mtp n3 | code | 35.1, 35.7 | 0.39, 0.42 | 2048 / 0 (both) | no (length) |
| mtp n3 | prose | 35.2, 33.6 | 0.40, 0.37 | ~60 / ~320 | yes |
| mtp n2 | code | 36.4, 34.5 | 0.52, 0.47 | 2048 / 0 | no |
| mtp n2 | prose | 38.2, 33.8 | 0.56, 0.46 | ~80 / ~340 | yes |
| mtp n4 | code | 34.1, 32.6 | 0.35, 0.32 | 2048 / 0 | no |
| mtp n4 | prose | 30.2, 31.4 | 0.27, 0.31 | ~95 / ~315 | yes |

## Findings
- Plain decode is the same with thinking on (23.5). MTP n3 gives about 35 t/s (1.5x), against 45-51 code / ~35 prose (about 2x code) with thinking off: acceptance falls from the thinking-off level to about 0.4 on reasoning text, so the code gain shrinks; prose is unchanged.
- The code prompt spends the whole 2048 tokens thinking and never answers: a coding answer with thinking on needs a much larger `max_tokens` (the budget was not enough, so completion on code was not measured). Prose thinks briefly (~60-100 tokens) and completes.
- n2 is level with n3 (code 35.5 vs 35.4, prose 36.0 vs 34.4, inside the run-to-run spread); n4 is worse. No clear and consistent gain from another n-max, so **no preset change**.
