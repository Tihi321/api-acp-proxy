import { describe, expect, it } from "vitest";
import { buildEmbeddingArgs, buildLlamaArgs, checkBuild, checkEmbeddingFiles, checkLlamaFiles, embeddingServerKey } from "../src/llama-args.js";
import { LLAMA_PRESETS, defaultSettings, type LlamaProfile } from "../src/settings.js";

const [mini, dspark] = LLAMA_PRESETS as [LlamaProfile, LlamaProfile];

describe("llama args", () => {
  it("builds the exact args, prechecks every shard and gates on the build", () => {
    const dir = "D:\\My Models";
    const base = "D:\\My Models\\unsloth\\Inkling-2-Mini-GGUF";
    const sampling = "--temp 1.0 --top-p 1.0 --top-k 0 --min-p 0.0";
    expect(buildLlamaArgs(dspark, dir)).toBe(
      `-m "${base}\\Inkling-2-Mini-UD-Q8_K_XL.gguf" --host 127.0.0.1 --port {port} --alias inkling-2-mini-dspark --metrics -c 32768 -ngl all -fa on`
      + ` --mmproj "${base}\\mmproj-F16.gguf" --spec-type draft-dspark`
      + ` --spec-draft-model "${base}\\dspark-Inkling-2-Mini-Q8_0.gguf" --spec-draft-n-max 3 --spec-draft-ngl all -lm none -ub 1024 -np 1 -t 16 ${sampling}`);
    for (const preset of [mini, dspark]) expect(buildLlamaArgs(preset, dir)).not.toMatch(/(^|\s)--draft(-max|-min)?(\s|$)/);
    expect(buildLlamaArgs({ ...dspark, extraArgs: "--metrics --temp 1.0" }, dir).match(/--metrics/g)).toHaveLength(1);
    const plain = buildLlamaArgs(mini, dir);
    expect(plain).toContain("--mmproj");
    expect(plain).toContain("-fa on");
    expect(plain).toContain("-lm none -ub 1024 -np 1 -t 16 --temp 1.0");
    expect(plain).not.toContain("--spec-");
    expect(() => buildLlamaArgs({ ...mini, modelFile: "a%PATH%.gguf" }, dir)).toThrow("Unsupported character in modelFile");
    const embedding = defaultSettings().providers.llama.embedding;
    expect(buildEmbeddingArgs({ ...embedding, extraArgs: "--verbose" }, dir)).toBe(
      `-m "${dir}\\nomic-ai\\nomic-embed-text-v1.5-GGUF\\nomic-embed-text-v1.5.Q4_K_M.gguf" --host 127.0.0.1 --port {port} --alias nomic-embed-text-v1.5 --embedding --pooling mean`
      + " -c 8192 -b 2048 -ub 2048 -ngl all -np 4 --verbose");
    expect(checkEmbeddingFiles(embedding, dir, () => false)).toHaveLength(1);
    // AAP-44: what changes the command line (or switches the server off) changes the key.
    const key = embeddingServerKey(embedding, dir);
    expect(embeddingServerKey({ ...embedding }, dir)).toBe(key);
    for (const changed of [{ modelFile: "other.gguf" }, { port: 9000 }, { ctxSize: 1024 }, { enabled: !embedding.enabled }]) expect(embeddingServerKey({ ...embedding, ...changed }, dir)).not.toBe(key);

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
