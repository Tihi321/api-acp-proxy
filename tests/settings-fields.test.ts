import { describe, expect, it } from "vitest";
import { fields, fieldValue } from "../src/renderer/settings-fields.js";
import { defaultSettings, mergeSettings } from "../src/settings.js";

const spec = (path: string) => fields.find((f) => f.path === path)!;

describe("settings page fields", () => {
  it("an empty Strata Arguments saves and clears to the default; Command stays required", () => {
    expect(fieldValue(spec("providers.strata.args"), "")).toEqual({ value: null });
    expect(fieldValue(spec("providers.strata.args"), "  --x {port}  ")).toEqual({ value: "--x {port}" });
    expect(fieldValue(spec("providers.strata.command"), "")).toEqual({ error: "Required" });
    const withArgs = mergeSettings(defaultSettings(), { providers: { strata: { args: "--x" } } });
    expect(mergeSettings(withArgs, { providers: { strata: { args: null } } }).providers.strata.args).toBe("");
  });
});
