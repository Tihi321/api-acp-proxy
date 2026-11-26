# AAP-64 changelog: Ternary Bonsai 2.5 27B built-in profiles

- `src/settings.ts`: two built-in llama.cpp presets (LLAMA_PRESETS): `bonsai-2.5-27b` ("Bonsai 2.5 27B (ternary Q2_0)", Q2_0 + mmproj-Q8_0, vision, ctx 32768, all layers, flash attention on, no speculation, `-np 1 --jinja --temp 1.0 --top-p 0.95 --top-k 20 --min-p 0`, requires minBuild 11556) and `bonsai-2.5-27b-mtp` (the `-Q2_0-mtp.gguf` file, `draft-mtp`, draft max 3, no draft file because the head is inside the model, same sampling). Measured in bench.md: plain 24 t/s, MTP n3 45 t/s on ROCm.
- `src/shared/gguf-names.ts`: `ggufKind` classes a file as mmproj when "mmproj" is a whole word anywhere in the file name (e.g. `Ternary-Bonsai-2.5-27B-mmproj-Q8_0.gguf`), not only at the start.
- Tests: `tests/llama-scan.test.ts` (that mmproj name is classified mmproj), `tests/settings.test.ts` (preset ids / count updated for the two new presets).
- Files: research.md, bench.md, this file.
