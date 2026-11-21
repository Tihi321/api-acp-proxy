import { describe, expect, it } from "vitest";
import type { HfFileGroup } from "../src/hf-models.js";
import { autoMmproj, profileFilesPatch } from "../src/llama-jobs.js";
import { defaultSettings, LLAMA_PRESETS, mergeSettings, type LlamaProfile } from "../src/settings.js";

const [mini] = LLAMA_PRESETS as [LlamaProfile];
const textOnly: LlamaProfile = { ...mini, id: "text", model: "text", vision: false, mmprojFile: undefined, hf: { repo: "o/r", revision: "main", quant: "Q4_K_M" } };
const file = (name: string) => ({ path: name, saveAs: name, size: 1 });
const groups: HfFileGroup[] = [
  { kind: "model", label: "Q4_K_M", quant: "Q4_K_M", files: [file("m-Q4_K_M.gguf")], totalSize: 1, split: false, selectable: true },
  { kind: "mmproj", label: "BF16", files: [file("mmproj-m-BF16.gguf")], totalSize: 1, split: false, selectable: true },
  { kind: "mmproj", label: "F16", files: [file("mmproj-m-F16.gguf")], totalSize: 1, split: false, selectable: true },
];

describe("llama job completion", () => {
  it("patches only the downloaded profile's file fields onto the settings saved at completion, and fills vision from an auto-picked mmproj", () => {
    // During the download the user edited the context size on the page and saved.
    const atStart = mergeSettings(defaultSettings(), { providers: { llama: { profiles: [mini, textOnly] } } });
    const saved = mergeSettings(atStart, { providers: { llama: { profiles: [mini, { ...textOnly, ctxSize: 4096 }] } } });

    const picked = autoMmproj(textOnly, groups);
    expect(picked?.path).toBe("mmproj-m-F16.gguf");
    expect(autoMmproj(mini, groups)).toBeUndefined(); // the profile names its own mmproj: never replaced

    const done = mergeSettings(saved, profileFilesPatch(saved.providers.llama, "text", { modelFile: "o/r/m-Q4_K_M.gguf", mmprojFile: "o/r/mmproj-m-F16.gguf", autoMmproj: true }));
    expect(done.providers.llama.profiles[1]).toMatchObject({ ctxSize: 4096, modelFile: "o/r/m-Q4_K_M.gguf", mmprojFile: "o/r/mmproj-m-F16.gguf", vision: true });
    expect(done.providers.llama.profiles[0]).toEqual(saved.providers.llama.profiles[0]);

    // An mmproj the user set during the download wins over the auto-picked one.
    const userSet = mergeSettings(saved, { providers: { llama: { profiles: [mini, { ...textOnly, mmprojFile: "mine.gguf" }] } } });
    const kept = mergeSettings(userSet, profileFilesPatch(userSet.providers.llama, "text", { modelFile: "o/r/m-Q4_K_M.gguf", mmprojFile: "o/r/mmproj-m-F16.gguf", autoMmproj: true }));
    expect(kept.providers.llama.profiles[1]).toMatchObject({ mmprojFile: "mine.gguf", vision: false });
  });
});
