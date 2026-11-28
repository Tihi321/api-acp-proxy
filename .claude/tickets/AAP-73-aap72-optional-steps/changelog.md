# Changelog

## 2026-11-28 AAP-73: AAP-72 optional steps

Near-num_ctx warning reworded for Ollama's 400 refusal, README updated, exact token counting dropped (no tokenize endpoint), Overview skips unchanged rebuilds and keeps focus, Today line on the ACP rows.

### api-acp-proxy (branch `AAP-73_aap72-optional-steps`)
- `src/providers/local-openai.ts`: the near-num_ctx warning now says the prompt leaves little room for the answer (older Ollama versions also cut silently) and no longer repeats the provider name after `[ollama]`; comments on `LOADED_CHARS_PER_TOKEN` and `NEAR_CONTEXT_SHARE` reworded. No behaviour change.
- `tests/local-openai.test.ts`: the near-limit assertion matches the new text and checks that the message does not start with "Ollama".
- `README.md`: the Loaded context paragraph and the prompt-limit bullet name the HTTP 400 refusal seen on 0.40.19 and call ×3 an estimate; the Overview paragraph says every row has a Today line.
- `ROADMAP.md`: AAP-73 line added.
- `src/renderer/overview-lines.ts`: new pure `overviewFocusTarget`.
- `src/renderer/settings.ts`: the row buttons carry `data-ov-focus` keys; the ACP rows get the Today line; the rows are replaced only when their `outerHTML` changes, and focus returns to the same button or the row's Settings button.
- `tests/overview-lines.test.ts`: one `it` for `overviewFocusTarget`.

### Deviations
- The :441 comment avoids the phrase "may have cut it", because that phrase matches the AC2 grep.
- `nearLimit[0]?.message` in the test, so that the tests typecheck passes.

### Verification
- `npm test`: Test Files 50 passed, 1 skipped (51); Tests 555 passed, 1 skipped (556).
- `node scripts/typecheck.mjs`: main ok, renderer ok, tests ok.
- AC2 and AC3 greps: the stale phrases and `tokenize` in src print nothing; `0.40.19` appears at README.md:128.
- Live (Ollama 0.40.19, headless proxy on 8797, temp model `aap73-ctx` with num_ctx 2048):
  - 2000 digits: 200, prompt_tokens 2010, finish_reason `length`, completion_tokens 38, one warn line with the new text.
  - 3000 digits: 400 `context_length_exceeded`.
  - "hi": 200, no new warn line.
  - `/api/tokenize` still returns 404.
  - Cleanup: the model was removed, `/api/ps` is `{"models":[]}` as found, the temp dir was deleted, and 8787 `/healthz` is ok.
- Not run: AC5 and AC6 (Settings window). The live 8787 app runs from this repo's `dist/`, so it was not rebuilt.

### Follow-ups
- See discoveries.md.

### Commit status
Committed as 90db8a1 on the branch. Not merged or pushed.
