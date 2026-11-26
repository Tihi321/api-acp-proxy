import path from "node:path";
import { describe, expect, it } from "vitest";
import { groupGgufFiles, hfLocalPath, parseHfLink } from "../src/hf-models.js";

describe("hf-models", () => {
  it("parses every link form and rejects other hosts", () => {
    expect(parseHfLink("https://huggingface.co/unsloth/Inkling-2-Mini-GGUF")).toEqual({ repo: "unsloth/Inkling-2-Mini-GGUF", revision: "main" });
    expect(parseHfLink("https://huggingface.co/o/r/blob/main/Q4_K_M/x-00001-of-00003.gguf")).toEqual({ repo: "o/r", revision: "main", path: "Q4_K_M/x-00001-of-00003.gguf" });
    expect(parseHfLink("https://huggingface.co/o/r/resolve/dev/x.gguf?download=true")).toEqual({ repo: "o/r", revision: "dev", path: "x.gguf" });
    expect(parseHfLink("https://hf.co/o/r/tree/main/Q8_0")).toEqual({ repo: "o/r", revision: "main", path: "Q8_0" });
    expect(parseHfLink("unsloth/Inkling-2-Mini-GGUF:q8_k_xl")).toEqual({ repo: "unsloth/Inkling-2-Mini-GGUF", revision: "main", quant: "q8_k_xl" });
    expect(() => parseHfLink("https://example.com/a/b")).toThrow(expect.objectContaining({ code: "hf_link_invalid" }));
  });

  it("groups GGUF files and guards local paths", () => {
    const file = (p: string, size: number) => ({ type: "file", path: p, size, lfs: { oid: "ab".repeat(32), size } });
    const groups = groupGgufFiles([
      file("Q4_K_M/x-Q4_K_M-00001-of-00003.gguf", 10), file("Q4_K_M/x-Q4_K_M-00002-of-00003.gguf", 20), file("Q4_K_M/x-Q4_K_M-00003-of-00003.gguf", 30),
      file("Q6_K/x-Q6_K-00001-of-00003.gguf", 1), file("Q6_K/x-Q6_K-00003-of-00003.gguf", 1),
      file("mmproj-BF16.gguf", 5), file("dspark-Inkling-2-Mini-Q8_0.gguf", 7), file("imatrix.gguf", 9), file("README.md", 1),
      file("Mainline_Support/Inkling-2-Mini-UD-Q4_K_XL.gguf_file", 11),
    ]);
    const split = groups.find((group) => group.quant === "Q4_K_M");
    expect(split).toMatchObject({ kind: "model", split: true, totalSize: 60, selectable: true, label: "Q4_K_M" });
    expect(split?.files.map((f) => f.size)).toEqual([10, 20, 30]);
    expect(groups.find((group) => group.quant === "Q6_K")).toMatchObject({ label: "Q6_K (incomplete)", selectable: false });
    expect(groups.find((group) => group.kind === "mmproj")).toMatchObject({ quant: "BF16" });
    expect(groups.find((group) => group.kind === "draft")).toMatchObject({ quant: "Q8_0" });
    expect(groups.some((group) => group.files.some((f) => f.path.includes("imatrix")))).toBe(false);
    // AAP-65: the MTP file of a repo is its own quant; `:Q2_0` must pick the plain file.
    const mtp = groupGgufFiles([file("B-Q2_0.gguf", 7), file("B-Q2_0-mtp.gguf", 8), file("mtp-B-Q4_0.gguf", 3)]);
    expect(mtp.map((group) => [group.kind, group.quant])).toEqual([["model", "Q2_0"], ["model", "Q2_0-mtp"], ["draft", "Q4_0"]]);
    expect(parseHfLink("o/r:Q2_0-mtp")).toMatchObject({ quant: "Q2_0-mtp" });
    const mainline = groups.find((group) => group.label.endsWith("(mainline)"));
    expect(mainline?.label).toBe("UD-Q4_K_XL (mainline)");
    expect(mainline?.files[0]?.saveAs.endsWith(".gguf")).toBe(true);
    expect(groups).toHaveLength(5);

    const dir = path.resolve(".claude/temp/hf-models-tests");
    expect(hfLocalPath(dir, "o/r", "Q4_K_M/x.gguf")).toBe(path.join(dir, "o", "r", "Q4_K_M", "x.gguf"));
    expect(() => hfLocalPath(dir, "o/r", "../evil.gguf")).toThrow();
  });
});
