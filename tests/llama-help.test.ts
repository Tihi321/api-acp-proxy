import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseHelpFlags, unknownFlags } from "../src/shared/llama-help.js";

const help = readFileSync(new URL("./fixtures/llama-server-help.txt", import.meta.url), "utf8");

describe("llama-server --help flags (AAP-56)", () => {
  const known = parseHelpFlags(help);

  it("lists short flags, long flags and aliases, and not the removed --no-mmap", () => {
    for (const flag of ["-lm", "--load-mode", "-fa", "--flash-attn", "-ngl", "--n-gpu-layers", "-ub", "--temp", "--temperature", "--spec-draft-n-max", "--no-perf", "-nkvo", "--no-kv-offload"]) expect(known.has(flag), flag).toBe(true);
    expect(known.has("--no-mmap")).toBe(false);
  });

  it("names the extra-argument flags the build does not know, ignoring values, negative numbers and quoted paths", () => {
    expect(unknownFlags('--no-mmap -ub 1024 --top-k -1 --mmproj "C:/a b/x.gguf" --foo=1 --no-mmap', known)).toEqual(["--no-mmap", "--foo"]);
  });
});
