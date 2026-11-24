# AAP-59 changelog

- src/settings.ts: DSpark profile draftNMax 5 -> 3, label "(Unsloth build, experimental)", comment with the bench numbers; removed built-in flag preset dspark-probabilistic (saved user presets untouched).
- src/renderer/settings.html: backend hint rewritten from the benchmark.
- README.md: DSpark notes, three built-in flag presets, "Measured on Strix Halo" list.
- tests/llama-args.test.ts, tests/settings.test.ts: assertions updated (failed before the source change: 3 tests).
- Added .claude/tickets/AAP-57-llama-restart/bench2.md.
