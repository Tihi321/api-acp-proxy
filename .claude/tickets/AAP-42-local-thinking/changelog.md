# Changelog

## 2026-11-21 AAP-42 local thinking switch
Chat requests to Gufo, Strata and Llama.cpp now forward `reasoning_effort` and `chat_template_kwargs` upstream.
- Repo api-acp-proxy, branch AAP-42_local-thinking (from master a52e270).
- src/provider.ts: GenerateOptions gains reasoningEffort, chatTemplateKwargs. src/api.ts: normalizeChat reads a non-empty-string reasoning_effort and a plain-object chat_template_kwargs (wrong types ignored, no 400); NormalizedRequest carries them. src/server.ts: chat handler passes them into GenerateOptions (Responses unchanged). src/providers/local-openai.ts: upstream body adds them when set. ACP providers ignore them.
- tests/local-openai.test.ts: one table-driven test (both set, neither set, wrong types).
- README.md: "Thinking switch" bullet in the local-provider list; ROADMAP.md: [x] row added.
- Deviation: plan line numbers had moved (local-openai.ts body at :166 still; others shifted); README placed after the "Token limit" bullet (~:142). Third test row (wrong types) added.
- Verification: `npm test` 42 files passed, 511 tests passed, 1 skipped; `npm run typecheck` clean; `npm run build` ok.
- Not run: live check against Strata (reasoning_content absent, header) UNTESTED.
- Commit status: uncommitted.
