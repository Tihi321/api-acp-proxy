# Discoveries AAP-38

- 2026-11-21 implement: logout tests fail intermittently (4 of 15) when the full suite runs under load; they pass alone and on a full rerun (tests/logout.test.ts) - suggested: make the ACP call-count assertions wait for idle instead of timing
- 2026-11-21 implementer: image-generation tests failed once (8) while a typecheck ran in parallel, green on rerun (tests/image-generation.test.ts) - suggested: same load-timing review as the logout tests
- 2026-11-21 implementer: the "too old" build message suggests ggml-org or Unsloth even when the binary is a custom exe ("installed: custom b...") (src/llama-args.ts:81) - suggested: a custom-exe wording for that case
- 2026-11-21 implementer: a ggml-org Windows asset whose backend is not in the regex list is dropped from the picker without notice (src/llama-releases.ts:18) - suggested: log or show unmatched win assets
- 2026-11-21 implementer: the llama server badge shows the saved profile label while the Gufo badge reads the unsaved draft (src/renderer/settings.ts:222) - suggested: make both read the same source
- 2026-11-21 implementer: STRATA_PROFILE_ID is now only a compat alias of targetKey("strata") (src/local-models.ts:7) - suggested: drop it and use targetKey("strata") in local-openai.ts
