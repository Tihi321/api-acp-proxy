import { describe, expect, it } from "vitest";
import { buildLlamaArgs, checkBuild, checkLlamaFiles } from "../src/llama-args.js";
import { LLAMA_PRESETS, type LlamaProfile } from "../src/settings.js";

const [mini, dspark] = LLAMA_PRESETS as [LlamaProfile, LlamaProfile];

describe("llama args", () => {
  it("builds the exact args, prechecks every shard and gates on the build", () => {
    const dir = "D:\\My Models";
    const base = "D:\\My Models\\unsloth\\Inkling-2-Mini-GGUF";
    const sampling = "--temp 1.0 --top-p 1.0 --top-k 0 --min-p 0.0";
    expect(buildLlamaArgs(dspark, dir)).toBe(
      `-m "${base}\\Inkling-2-Mini-UD-Q8_K_XL.gguf" --host 127.0.0.1 --port {port} --alias inkling-2-mini-dspark -c 32768 -ngl all -fa auto`
      + ` --mmproj "${base}\\mmproj-F16.gguf" --spec-type draft-dspark`
      + ` --spec-draft-model "${base}\\dspark-Inkling-2-Mini-Q8_0.gguf" --spec-draft-n-max 3 --spec-draft-ngl 99 ${sampling}`);
    const plain = buildLlamaArgs(mini, dir);
    expect(plain).toContain("--mmproj");
    expect(plain).not.toContain("--spec-");
    expect(() => buildLlamaArgs({ ...mini, modelFile: "a%PATH%.gguf" }, dir)).toThrow("Unsupported character in modelFile");

    const sharded = { ...mini, vision: false, modelFile: "m/x-00001-of-00003.gguf" };
    const present = (p: string) => !p.endsWith("x-00002-of-00003.gguf");
    expect(checkLlamaFiles(sharded, dir, present)).toEqual([expect.stringMatching(/x-00002-of-00003\.gguf$/)]);

    expect(checkBuild(mini, { source: "ggml-org", build: 12606 })).toMatchObject({ ok: false, code: "llama_build_too_old", message: expect.stringContaining("needs a newer build") });
    expect(checkBuild(mini, { source: "ggml-org", build: 12607 })).toEqual({ ok: true });
    expect(checkBuild(mini, { source: "unsloth", build: 12588 })).toEqual({ ok: true });
    expect(checkBuild(dspark, { source: "ggml-org", build: 99999 })).toMatchObject({ ok: false, message: expect.stringContaining("Unsloth build") });
    expect(checkBuild(mini, { source: "custom" })).toMatchObject({ ok: "unknown" });
  });
});
