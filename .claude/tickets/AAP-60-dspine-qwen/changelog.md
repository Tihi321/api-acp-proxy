# AAP-60 changelog

- `src/settings.ts`: two built-in llama profiles after the Inkling ones.
  - `qwen3.8-27b-dspine`: Qwen3.8-27B UD-Q4_K_M + DSpine b16 Q4_K_M draft, `draft-dflash`, draft max 15, ctx 16384, `-np 1 --jinja`. No `requires` (needs the custom dspine fork exe; a gate cannot name a fork and a `sources` gate would only warn "unknown" for an own exe).
  - `qwen3.8-27b-mtp`: same target + `MTP/mtp-Qwen3.8-27B-Q4_0.gguf`, `draft-mtp`, draft max 3, `requires {minBuild 12651, sources [unsloth]}` (the builds it ran on).
  - The draftNMax schema has no upper limit, so nothing was raised.
- `tests/llama-args.test.ts`: exact generated args of both profiles plus the custom-exe build check, in the existing test.
- `tests/settings.test.ts`: preset ids/requires, restore counts (restore adds both for existing users), restore-keeps-stored check.
- `README.md`: two preset rows, measured Qwen numbers, how to point at the fork exe, AAP-58 PATH note.
- `research.md`, `bench.md`: committed.
