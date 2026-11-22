import { describe, expect, it } from "vitest";
import { gib, sparkGeometry, speedSub, type SpeedSubInput } from "../src/renderer/monitor-format.js";

describe("Monitor formatting", () => {
  it("shows sizes in GiB (1024^3)", () => {
    expect(gib(67_884_810_240)).toBe("63.2 GiB");
    expect(gib(68_719_476_736)).toBe("64.0 GiB");
  });

  it("draws runs as lines, a single reading between gaps as a dot, and flat series at the scale's edge", () => {
    expect(sparkGeometry([1, null, 2, 3], { min: 0, max: 4 })).toEqual({ lines: ["58,8.00 59,4.00"], dots: ["55.5,12.00 56.5,12.00"] });
    expect(sparkGeometry([0, 0, 0], { min: 0 })?.lines).toEqual(["57,16.00 58,16.00 59,16.00"]);
    expect(sparkGeometry([100, 100], { min: 0, max: 100 })?.lines).toEqual(["58,0.00 59,0.00"]);
    expect(sparkGeometry([5, 5])?.lines).toEqual(["58,8.00 59,8.00"]);
    expect(sparkGeometry([null, 7])).toBeUndefined();
    // A dot at the newest or oldest slot stays inside the 0..59 viewBox, still 1 unit long.
    expect(sparkGeometry([1, 2, null, 3], { min: 0, max: 4 })).toEqual({ lines: ["56,12.00 57,8.00"], dots: ["58,4.00 59,4.00"] });
  });

  it("gives every empty speed tile its reason", () => {
    const base: SpeedSubInput = { llama: false, value: undefined, haveSpeed: false, missingText: "no prompt read yet", noRequest: false, external: false, fallback: undefined };
    const rows: [string, Partial<SpeedSubInput>, string | undefined][] = [
      ["Strata decode without prefill", { haveSpeed: true }, "no prompt read yet"],
      ["Llama metrics read failed", { llama: true, speedMissing: "metrics-unread" }, "speed not read this time"],
      ["Llama with a value", { llama: true, value: 50, haveSpeed: true }, "average since the model started"],
      ["Llama outside, no --metrics", { llama: true, speedMissing: "no-metrics", external: true }, "start llama-server with --metrics for speed"],
      ["Strata before any request", { noRequest: true }, "no request yet"],
      ["no engine", { fallback: "Engine not reachable" }, "Engine not reachable"],
    ];
    for (const [name, patch, expected] of rows) expect(speedSub({ ...base, ...patch }), name).toBe(expected);
  });
});
