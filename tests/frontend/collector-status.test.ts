import { describe, expect, test } from "bun:test";
import { manualResetsLabel } from "../../frontend/collector-status.ts";

describe("manualResetsLabel", () => {
  test("preserves a zero count", () => {
    expect(manualResetsLabel({ latestOk: true, stale: false, resetCredits: 0 })).toBe("0 available");
  });

  test("distinguishes a missing count from an unavailable latest capture", () => {
    expect(manualResetsLabel({ latestOk: true, stale: false, resetCredits: null })).toBe("Not reported");
    expect(manualResetsLabel({ latestOk: false, stale: false, resetCredits: null })).toBe("Unavailable");
    expect(manualResetsLabel({ latestOk: null, stale: false, resetCredits: null })).toBe("Unavailable");
  });

  test("marks a stale reported count", () => {
    expect(manualResetsLabel({ latestOk: true, stale: true, resetCredits: 3 })).toBe("3 available (stale)");
  });
});
