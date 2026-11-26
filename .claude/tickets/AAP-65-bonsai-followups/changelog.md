# AAP-65 changelog
- src/shared/gguf-names.ts: `quantOf` returns `<quant>-mtp` for a file named `...-Q2_0-mtp.gguf` (tag right after the quant), so the plain and the MTP file are different groups in "Find on Hugging Face" and `repo:Q2_0` resolves to the plain file only. Draft detection (mtp- prefix, MTP/ dir) unchanged.
- src/settings.ts: bonsai-2.5-27b-mtp `hf.quant` is now `Q2_0-mtp`.
- tests/hf-models.test.ts: extended grouping test (plain and -mtp land in different groups, `:Q2_0-mtp` shorthand parses).
- Task B: ROCm flag bench (bench.md). Flags lost the decision rule, so presets are unchanged.
