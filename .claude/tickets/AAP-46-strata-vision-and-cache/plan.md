---
status: in-progress
request: creative-hub/REQ-0030
repos: [api-acp-proxy]
branch: AAP-46_strata-vision-and-cache
updated: 2026-11-22
---

# AAP-46 Strata takes images when it says it can, local cached tokens are passed through, and "Use found files" keeps hf.mmproj / hf.draft

Hub ticket: creative-hub HUB-42 (`C:\projects\Personal\creative-hub\.claude\tickets\HUB-42-pending-ideas-and-proxy-monitor\plan.md`, triage rows P7, P16, P17), request REQ-0030. Checked on master ce7817f (2026-11-22).

Do not touch the user's `%APPDATA%\api-acp-proxy\settings.json`. The desktop proxy the hub uses runs from this repo's `dist/` and is running: run `yarn test` and `yarn typecheck` only; no `yarn build`, no restart (the hub's K1 builds after the merge with the user's go-ahead). The working tree has two uncommitted files of AAP-43 (`.claude/tickets/AAP-43-local-embeddings/events.jsonl`, `plan.md`): leave them out of every commit.

Commands (Bash: `export PATH="/c/Users/Infplane/AppData/Roaming/fnm/aliases/default:$PATH"` first): test `yarn test`; typecheck `yarn typecheck`; build `yarn build` (not in this ticket); there is no lint script.

## Scope

1. **Strata images (P16).** Strata has no profile, so `prepareModel` refuses any image for it (`src/providers/local-openai.ts:149`, `!(profile?.kind === "llm" && profile.vision)`), and `generate` drops images for it (`acceptsImages`, `:127`, used at `:196`). Strata says it takes images: `GET http://127.0.0.1:8080/v1/models` answers (read 2026-11-22) `{"object":"list","data":[{"id":"qwen3.8-flash-next-unsloth-ud-iq4_xs", ..., "architecture":{"input_modalities":["text","image"],"output_modalities":["text"]}}]}`. For a provider without profiles, take `vision` from that upstream field.
2. **Cached tokens (P17).** The stream parser keeps `prompt_tokens`, `completion_tokens` and reasoning only (`:221` type, `:232`). Strata puts its reused prompt tokens in `usage.prompt_tokens_details.cached_tokens` (Strata's `terminal/serve/server.py:6184`); llama-server sends the same field in recent builds. `src/usage.ts:13` treats `inputTokens` as the uncached part and adds `cachedReadTokens`, so: `cachedReadTokens = cached`, `inputTokens = prompt_tokens - cached`. The client's `prompt_tokens` stays the same; `prompt_tokens_details.cached_tokens` stops being 0.
3. **hf.mmproj / hf.draft (P7).** `applyFix` (`src/renderer/llama-models.ts:72-80`) updates `hf.quant` for a model fix (AAP-45) but leaves `hf.mmproj` / `hf.draft` naming the old file after an mmproj or draft fix. `hf.mmproj` and `hf.draft` are file names (presets `src/settings.ts:139,147`).

## Out of scope

- Any Strata or Pixel setting; Gufo/llama profiles (their `vision` stays from the profile).
- The non-streamed path, if any, beyond the same usage mapping (the worker applies the same mapping wherever `prompt_tokens` is read in `local-openai.ts`, and lists those places in the changelog).
- The Monitor page (AAP-47).

## Files to touch (verified)

**`src/providers/local-openai.ts`**
- `listModels` (`:181-188`), the branch for a provider without profiles: today `this.models = (body?.data ?? []).flatMap((entry) => typeof entry.id === "string" ? [{ id: entry.id }] : []);`. New: also read `entry.architecture?.input_modalities`; when it is an array containing `"image"`, the entry gets `vision: true` (no `vision` key otherwise). Widen the `body` cast type accordingly.
- `acceptsImages(model)` (`:127`): `profile?.kind === "llm" && profile.vision` when a profile exists; without profiles (`!this.profiles`), `this.models.some((m) => m.id === model && m.vision === true)`.
- `prepareModel` (`:149`): replace the inline test `!(profile?.kind === "llm" && profile.vision)` with `!this.acceptsImages(model)` (same result for Gufo and Llama).
- Stream usage (`:221`, `:231-232`): add `prompt_tokens_details?: { cached_tokens?: number }` to the chunk usage type; `const cached = Math.max(0, Math.min(inputTotal, chunk.usage.prompt_tokens_details?.cached_tokens ?? 0))` where `inputTotal = chunk.usage.prompt_tokens ?? 0`; `usage = { inputTokens: inputTotal - cached, outputTokens, totalTokens: ..., ...(cached ? { cachedReadTokens: cached } : {}), ...thought }`. Check the `Usage` type has `cachedReadTokens` (it is in `USAGE_FIELDS`, `src/acp-provider.ts:130`).

**`src/renderer/llama-models.ts:72-80`** `applyFix`, after the `if (field === "modelFile") { ... }` block add:
```ts
  else if (profile.hf && (field === "mmprojFile" || field === "draftFile")) {
    const key = field === "mmprojFile" ? "mmproj" : "draft";
    if (profile.hf[key]) next.hf = { ...profile.hf, [key]: file.name };
  }
```
(An unset `hf.mmproj` / `hf.draft` stays unset.) Update the function's doc comment: "... a model fix also swaps the old quant in the label and sets `hf.quant`; an mmproj or draft fix sets `hf.mmproj` / `hf.draft` to the file's name when the profile has one."

**`README.md`**, section "Local model servers (Gufo, Strata, Llama.cpp)" (line 119): one sentence: "Strata takes images when its `/v1/models` lists `image` in `architecture.input_modalities` (AAP-46); usage passes `prompt_tokens_details.cached_tokens` through from the local server."

**`ROADMAP.md`**, a new line after line 42 (the AAP-45 line), before the open `- [ ] Llama.cpp follow-ups`:
`- [x] Strata images and local cached tokens (AAP-46; creative-hub HUB-42; live check UNTESTED, hub K1/K3/K4): Strata takes image parts when its /v1/models says it reads images; usage reports the local server's cached prompt tokens; "Use found files" for an mmproj or draft also updates hf.mmproj / hf.draft.`

## Tests (test-discipline: three assertions in existing files, reusing their fakes)

- `tests/local-openai.test.ts`, next to "sends image parts to a vision profile only, refuses them elsewhere before any switch, ..." (`:199`): one test with the existing fake upstream for `strata`: its `/models` answers one id with `architecture.input_modalities: ["text","image"]`; after `listModels`, a chat with an image part is forwarded (the upstream body has an `image_url` part), and with `["text"]` the same request gets 400 `unsupported_content`.
- `tests/local-openai.test.ts`, next to "forwards upstream reasoning_content ... with the upstream usage" (`:74`): the fake's final usage chunk carries `prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 80 }`; the client's usage has `prompt_tokens` 100 and `prompt_tokens_details.cached_tokens` 80.
- `tests/llama-models.test.ts`, after the AAP-45 assertions (`:22-26`): `expect(applyFix(preset, "mmprojFile", mmproj).hf).toEqual({ ...preset.hf, mmproj: mmproj.name })` with the file's existing `mmproj` fixture.

## Tasks for workers

One worker, in this order: the three code changes, the three tests, README and ROADMAP, then `yarn test` and `yarn typecheck`. Output: one commit on `AAP-46_strata-vision-and-cache` (`AAP-46: Strata images from /v1/models, local cached tokens, hf.mmproj/draft on found files`), a `changelog.md` in this folder with the test count.

## Acceptance criteria

| # | criterion | proof |
|---|---|---|
| A1 | an image to Strata is forwarded when its `/v1/models` lists `image`, refused otherwise | the new local-openai test |
| A2 | cached tokens from a local server reach the client's usage | the new usage test |
| A3 | an mmproj fix sets `hf.mmproj` | the new llama-models assertion |
| A4 | Gufo and Llama behave as before | `yarn test` (the existing tests at `:199`, `:223`, `:250` pass unchanged) |
| A5 | types hold | `yarn typecheck` |

## UNTESTED

- A real image request to Strata and real cached numbers (hub K1 step 6, K3, K4, after `yarn build` and a proxy restart).
