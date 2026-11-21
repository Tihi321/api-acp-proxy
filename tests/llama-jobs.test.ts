import { describe, expect, it } from "vitest";
import { profileFilesPatch } from "../src/llama-jobs.js";
import { defaultSettings, LLAMA_PRESETS, mergeSettings, type LlamaProfile } from "../src/settings.js";

const [mini] = LLAMA_PRESETS as [LlamaProfile];
const textOnly: LlamaProfile = { ...mini, id: "text", model: "text", vision: false, mmprojFile: undefined, hf: { repo: "o/r", revision: "main", quant: "Q4_K_M" } };

describe("llama job completion", () => {
  it("patches only the downloaded profile's file fields onto the settings saved at completion", () => {
    // During the download the user edited the context size on the page and saved.
    const atStart = mergeSettings(defaultSettings(), { providers: { llama: { profiles: [mini, textOnly] } } });
    const saved = mergeSettings(atStart, { providers: { llama: { profiles: [mini, { ...textOnly, ctxSize: 4096 }] } } });

    const done = mergeSettings(saved, profileFilesPatch(saved.providers.llama, "text", { modelFile: "o/r/m-Q4_K_M.gguf" }));
    expect(done.providers.llama.profiles[1]).toMatchObject({ ctxSize: 4096, modelFile: "o/r/m-Q4_K_M.gguf" });
    expect(done.providers.llama.profiles[0]).toEqual(saved.providers.llama.profiles[0]);
  });
});
