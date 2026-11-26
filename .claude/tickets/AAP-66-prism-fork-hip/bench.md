# AAP-66 bench: Prism fork HIP build prism-b12232 (f70247610) on gfx1151 (2026-11-26)

Harness: .claude/temp/bonsai66/run.mjs (from bonsai65; results in all.out, srv-*.log). Same settings as AAP-64 bench plus `-np 1`; ROCm 7.2 bin prepended to PATH. 2 runs each (max_tokens 400, thinking off). PP = real prompt t/s on a 2747-token prompt (settings.ts excerpt). Acceptance = draft_accepted/draft_n per request (code, prose, code, prose).

## PATH
Without the ROCm 7.2 bin on PATH the exe starts but ggml-hip.dll fails to load silently: model "loads" in 3 s and runs on CPU at 8.7 t/s. The zip has no amdhip64 etc. So the ROCm PATH fix is required. With PATH the GPU runs (27 t/s, load ~3 s with mmap).

## Results (gen t/s, runs 1/2)
| config (fork prism-b12232, HIP) | code | prose | PP t/s | acceptance | output |
|---|---|---|---|---|---|
| PTQ1_0 plain | 27.5 / 27.1 | 27.3 / 27.1 | 284 | - | ok |
| PTQ1_0-mtp n3 | 25.8 / 27.9 | 19.1 / 18.1 | 275 | .69 .42 .76 .38 | ok |
| PTQ1_0-mtp n3 p-min 0.1 | 25.7 / 30.0 | 18.8 / 17.9 | 275 | .69 .40 .84 .37 | ok |
| PTQ1_0-mtp n4 | 11.3 / 13.0 | 8.4 / 7.5 | 276 | .55 .35 .67 .28 | ok (very slow) |
| Q2_0 plain | 22.0 / 21.5 | 22.5 / 22.2 | 410 | - | ok |
| Q2_0-mtp n3 | 43.7 / 47.0 | 32.9 / 33.4 | 388-393 | .62 .36 .63 .41 | ok |
Load 2.7-3.2 s for all (mmap, warm file cache). Reference stock ggml-org b12681 ROCm Q2_0: plain 24.0, MTP n3 45-51 code / ~35 prose, PP ~405.

## Vision
Fork HIP, PTQ1_0 plain + mmproj-Q8_0, red-circle image: "The image displays a solid red circle centered on a white background." (24.7 t/s). Works. Not tested with MTP files.

## Conclusions
- PTQ1_0 plain is ~13% faster in decode than Q2_0 plain (27.2 vs 22) but prompt processing is ~30% slower (284 vs 410) and the file is 1.7 GB smaller.
- MTP on PTQ1_0 does not pay on gfx1151: it is flat on code, 30% slower on prose, and n4 collapses. The fork's Q2_0-mtp (about 45/33) is about equal to stock b12681 Q2_0-mtp (45-51/35), so the fork gives no gain there. Best overall remains stock Q2_0-mtp n3 (about 45 code); best on the fork is PTQ1_0 plain at 27, only useful if PP matters less than size.
- Not tested: PQ2_0, KV q8_0, p-min on Q2_0, longer-context behaviour.
