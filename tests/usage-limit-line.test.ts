import { describe, expect, it } from "vitest";
import { nextExpiryDelay, usageLimitLine } from "../src/renderer/usage-limit-line.js";

describe("usage limit line", () => {
  const at = (day: number, hour: number, minute: number) => new Date(2026, 10, day, hour, minute);
  const now = at(26, 9, 0).getTime();

  it("shows the local time, adds the date on another day, and shows nothing without a future time", () => {
    expect(usageLimitLine(at(26, 11, 7).toISOString(), now)).toBe("usage limit until 11:07");
    expect(usageLimitLine(at(29, 11, 7).toISOString(), now)).toBe("usage limit until 2026-11-29 11:07");
    expect(usageLimitLine(undefined, now)).toBeUndefined();
    expect(usageLimitLine("garbage", now)).toBeUndefined();
    expect(usageLimitLine(at(26, 8, 0).toISOString(), now)).toBeUndefined();
    expect(nextExpiryDelay([{}, { exhaustedUntil: at(29, 11, 7).toISOString() }, { exhaustedUntil: at(26, 11, 7).toISOString() }], now)).toBe(at(26, 11, 7).getTime() - now);
    expect(nextExpiryDelay([{}, { exhaustedUntil: at(26, 8, 0).toISOString() }, { exhaustedUntil: "garbage" }], now)).toBeUndefined();
  });
});
