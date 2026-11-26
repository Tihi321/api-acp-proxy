import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { scanModelsDir } from "../src/llama-scan.js";
import { tempRoot } from "./helpers/temp-root.js";

const root = tempRoot("llama-scan");
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function put(dir: string, rel: string, bytes = 1): void {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(bytes));
}

describe("scanModelsDir", () => {
  it("classifies models, mmproj, drafts and split models", async () => {
    const dir = path.join(root, "classify");
    const inkling = "ggml-org/Inkling-2-Mini-GGUF";
    put(dir, `${inkling}/Inkling-2-Mini-IQ4_NL.gguf`, 10);
    put(dir, `${inkling}/mmproj-Inkling-2-Mini-Q8_0.gguf`, 4);
    for (const n of [1, 2, 3]) put(dir, `o/r/Q4_K_M/x-0000${n}-of-00003.gguf`, 5);
    put(dir, "p/q/Q8_0/y-00002-of-00003.gguf", 7);
    put(dir, "p/q/Q8_0/y-00003-of-00003.gguf", 7);
    put(dir, "dspark-x-Q8_0.gguf", 2);
    put(dir, "imatrix.gguf");
    put(dir, "t/Ternary-Bonsai-2.5-27B-mmproj-Q8_0.gguf", 3);

    const scan = await scanModelsDir(dir);
    expect(scan).toMatchObject({ missingDir: false, truncated: false });
    expect(scan.files.map((f) => f.path)).toEqual([
      "dspark-x-Q8_0.gguf",
      `${inkling}/Inkling-2-Mini-IQ4_NL.gguf`,
      `${inkling}/mmproj-Inkling-2-Mini-Q8_0.gguf`,
      "o/r/Q4_K_M/x-00001-of-00003.gguf",
      "p/q/Q8_0/y-00001-of-00003.gguf",
      "t/Ternary-Bonsai-2.5-27B-mmproj-Q8_0.gguf",
    ]);
    const by = (name: string) => scan.files.find((f) => f.name === name)!;
    expect(by("dspark-x-Q8_0.gguf")).toMatchObject({ kind: "draft", folder: "", quant: "Q8_0", size: 2, complete: true });
    expect(by("Inkling-2-Mini-IQ4_NL.gguf")).toMatchObject({ kind: "model", folder: inkling, quant: "IQ4_NL", size: 10, complete: true });
    expect(by("mmproj-Inkling-2-Mini-Q8_0.gguf")).toMatchObject({ kind: "mmproj", quant: "Q8_0", size: 4 });
    expect(by("Ternary-Bonsai-2.5-27B-mmproj-Q8_0.gguf")).toMatchObject({ kind: "mmproj", quant: "Q8_0" });
    expect(by("x-00001-of-00003.gguf")).toMatchObject({ kind: "model", shards: 3, size: 15, complete: true });
    expect(by("y-00001-of-00003.gguf")).toMatchObject({ kind: "model", shards: 3, size: 14, complete: false });
  });

  it("respects depth, hidden, partial, junction, missing-folder and cap bounds", async () => {
    const dir = path.join(root, "bounds");
    put(dir, ".cache/x.gguf");
    put(dir, "m.gguf.partial");
    put(dir, "a/b/c/d/deep4.gguf");
    put(dir, "a/b/c/d/e/deep5.gguf");
    put(path.join(root, "outside"), "linked.gguf");
    fs.symlinkSync(path.join(root, "outside"), path.join(dir, "link"), "junction");

    const scan = await scanModelsDir(dir);
    expect(scan.files.map((f) => f.path)).toEqual(["a/b/c/d/deep4.gguf"]);
    expect(await scanModelsDir(path.join(root, "nope"))).toEqual({ missingDir: true, truncated: false, files: [] });

    put(dir, "two.gguf");
    expect(await scanModelsDir(dir, { maxFiles: 1 })).toMatchObject({ truncated: true });
  });
});
