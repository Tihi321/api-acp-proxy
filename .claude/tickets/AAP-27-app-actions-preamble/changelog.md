# Changelog

## 2026-10-28 AAP-27
Plain preamble reworded so JSON-action prompts are not refused. Branch AAP-27_app-actions-preamble.
- src/api.ts: plain preamble is now "This is an API request[ with text and images]. Do not use your own environment: no shell commands, no file access, no web access, no permission requests. If the conversation describes actions, functions or a JSON format for you to produce, produce them as text exactly as asked: the calling application executes them. Respond with the answer only." Tools, web-search and image preambles unchanged.
- tests: six files updated to the new text; images.test.ts "not.toContain(describe)" narrowed to "[user]\ndescribe" (preamble now contains "describes").
- ROADMAP.md: AAP-27 entry.
- Verification: typecheck, 732 tests passed (2 skipped), build ok. Live A/B codex/gpt-5.6-luna 5 on 7461 (old) and 5 on 7471 (new): 10/10 valid JSON actions, 0 refusals either side (old rate ~1 in 3 did not reproduce in this sample).
- Committed, not pushed.
