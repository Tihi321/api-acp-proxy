---
status: in-progress
request: creative-hub/REQ-0030
repos: [api-acp-proxy]
branch: AAP-45_fix-hf-quant
updated: 2026-11-22
---

# AAP-45 "Use found files" keeps the profile's Hugging Face quant in line with the chosen model file

Hub ticket: creative-hub HUB-41 (`C:\projects\Personal\creative-hub\.claude\tickets\HUB-41-pixel-agent-and-small-ideas\plan.md`), request REQ-0030. The user said "new small ideas, build them now". Checked on master 9cb0544 (2026-11-22).

Do not touch the user's `%APPDATA%\api-acp-proxy\settings.json`, and do not restart or rebuild the running proxy. The working tree has two uncommitted files of another ticket (`.claude/tickets/AAP-43-local-embeddings/events.jsonl`, `plan.md`): leave them out of this branch's commits.

## Scope

`applyFix` (`src/renderer/llama-models.ts:72-80`), behind the Llama.cpp page's "Use found files" buttons (`src/renderer/llama-view.ts:583-592`), sets the file field and, for a model file, swaps the old quant for the new one in the label. It never touches `profile.hf.quant`, so after a fix the profile says e.g. label "Inkling 2 Mini (IQ4_NL, vision)" with `hf.quant: "Q8_0"` (the user's own settings show exactly that, HUB-40 triage idea 29). `hf.quant` is what "Find on Hugging Face" puts in the link (`llama-view.ts:398`, `${hf.repo}:${hf.quant}`). Candidates come only from the same folder as the old path (`foundFileFixes`, `:44-62`), so `hf.repo` stays right; only the quant goes stale. Smallest fix: a model fix also sets `hf.quant` to the chosen file's quant when the profile has `hf`.

## Out of scope

- `hf.mmproj` / `hf.draft` after an mmproj or draft fix (not asked; see the hub plan's extra ideas).
- Fixing the user's saved profiles (they change only when the user presses the button again and saves).
- Any other file.

## Files to touch (verified)

**`src/renderer/llama-models.ts:72-80`**. Old:
```ts
/** Sets `field` to the file's path; a model fix also swaps the old quant for the new one in the label when the label contains it. */
export function applyFix(profile: LlamaProfileView, field: FileField, file: LlamaLocalFileView): LlamaProfileView {
  const next: LlamaProfileView = { ...profile, [field]: file.path };
  if (field === "modelFile") {
    const oldQuant = quantOf(profile.modelFile);
    if (oldQuant && file.quant && profile.label.includes(oldQuant)) next.label = profile.label.replace(oldQuant, file.quant);
  }
  return next;
}
```
New:
```ts
/** Sets `field` to the file's path; a model fix also swaps the old quant for the new one in the label when the label contains it, and sets the Hugging Face quant to the file's. */
export function applyFix(profile: LlamaProfileView, field: FileField, file: LlamaLocalFileView): LlamaProfileView {
  const next: LlamaProfileView = { ...profile, [field]: file.path };
  if (field === "modelFile") {
    const oldQuant = quantOf(profile.modelFile);
    if (oldQuant && file.quant && profile.label.includes(oldQuant)) next.label = profile.label.replace(oldQuant, file.quant);
    if (file.quant && profile.hf) next.hf = { ...profile.hf, quant: file.quant };
  }
  return next;
}
```

**`tests/llama-models.test.ts:22-24`** (first test, "offers the found quant for a missing preset file and applies it"): after `expect(fixed.label).toBe("Inkling 2 Mini (IQ4_NL, vision)");` add
```ts
    expect(fixed.hf).toEqual({ ...preset.hf, quant: "IQ4_NL" });
    expect(preset.hf?.quant).toBe("Q8_0"); // the preset itself is not changed
```
No new test.

**`ROADMAP.md`**, a checked item after `:41` (AAP-44):
"- [x] Found files keep the Hugging Face quant (AAP-45; creative-hub HUB-41): \"Use found files\" for a profile's model also sets `hf.quant` to the chosen file's quant, so the label, the file and \"Find on Hugging Face\" agree."

## Tasks for workers

One task: the edits above. Commands (Bash; Node under fnm): `export PATH="/c/Users/Infplane/AppData/Roaming/fnm/aliases/default:$PATH"`, then in `C:\projects\Personal\api-acp-proxy`: `yarn test`, `yarn typecheck` (the repo has no lint script). Do not run `yarn build` on the branch: the desktop proxy the hub starts runs from this repo's build output (HUB-38 L1), so a branch build would be what the next proxy start runs. The user builds after the merge.

## Acceptance criteria

| # | criterion | proof |
|---|---|---|
| P1 | a model fix sets `hf.quant`; the preset object stays as it was | `yarn test tests/llama-models.test.ts` |
| P2 | an mmproj fix leaves `hf` as it was | the last test of the file (`applyFix(applyFix(preset, "modelFile", ...), "mmprojFile", ...)`) still passes; read the code |
| P3 | the rest green | `yarn test`, `yarn typecheck` exit 0 |

## UNTESTED

- The Llama.cpp page in the desktop app (Electron renderer): the button press and save. Left to the user's next use of the page.
