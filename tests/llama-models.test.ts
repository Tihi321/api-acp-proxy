import { describe, expect, it } from "vitest";
import { applyFix, draftMissingFiles, foundFileFixes, profileFromFile } from "../src/renderer/llama-models.js";
import { LLAMA_PRESETS } from "../src/settings.js";
import type { LlamaLocalFileView, LlamaProfileView } from "../src/shared/ipc.js";

const folder = "ggml-org/Inkling-2-Mini-GGUF";
const file = (kind: LlamaLocalFileView["kind"], name: string, quant: string, where = folder): LlamaLocalFileView =>
  ({ kind, path: `${where}/${name}`, folder: where, name, quant, size: 1, complete: true });
const model = file("model", "Inkling-2-Mini-IQ4_NL.gguf", "IQ4_NL");
const mmproj = file("mmproj", "mmproj-Inkling-2-Mini-Q8_0.gguf", "Q8_0");
const preset = LLAMA_PRESETS.find((p) => p.id === "inkling-2-mini") as LlamaProfileView;

describe("llama-models", () => {
  it("offers the found quant for a missing preset file and applies it", () => {
    const other = file("model", "Other-Model-Q8_0.gguf", "Q8_0");
    const fixes = foundFileFixes(preset, [model, mmproj, other]);
    expect(fixes.map((f) => [f.field, f.candidates.map((c) => c.name)])).toEqual([
      ["modelFile", ["Inkling-2-Mini-IQ4_NL.gguf"]],
      ["mmprojFile", ["mmproj-Inkling-2-Mini-Q8_0.gguf"]],
    ]);
    expect(foundFileFixes({ ...preset, modelFile: "D:\\m\\Inkling-2-Mini-Q8_0.gguf", mmprojFile: undefined }, [model])).toEqual([]);
    const fixed = applyFix(preset, "modelFile", model);
    expect(fixed.modelFile).toBe(model.path);
    expect(fixed.label).toBe("Inkling 2 Mini (IQ4_NL, vision)");
  });

  it("creates a profile from a found model with the single mmproj and leaves an ambiguous one out", () => {
    const profile = profileFromFile(model, [model, mmproj], new Set(["inkling-2-mini-iq4_nl"]));
    expect(profile).toMatchObject({ id: "inkling-2-mini-iq4_nl-2", modelFile: model.path, mmprojFile: mmproj.path, vision: true, gpuLayers: "auto" });
    const second = file("mmproj", "mmproj-Inkling-2-Mini-BF16.gguf", "BF16");
    const ambiguous = profileFromFile(model, [model, mmproj, second], new Set());
    expect(ambiguous.mmprojFile).toBeUndefined();
    expect(ambiguous.vision).toBe(false);
  });

  it("computes the missing files of a draft profile from the scan, keeping the status result for absolute paths", () => {
    expect(draftMissingFiles({ ...preset, modelFile: model.path, vision: false }, [model], [])).toEqual([]);
    expect(draftMissingFiles({ ...preset, modelFile: "x/gone.gguf", vision: false }, [model], [])).toEqual(["x/gone.gguf"]);
    expect(draftMissingFiles({ ...preset, modelFile: "D:/m/a.gguf", vision: false }, [], ["d:/m/a.gguf"])).toEqual(["D:/m/a.gguf"]);
  });
});
