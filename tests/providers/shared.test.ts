import { describe, expect, test } from "bun:test";
import { DEFAULT_INTERSTITIALS } from "../../src/providers/shared.ts";

describe("provider interstitials", () => {
  test("accepts the current Claude Code trust prompt", () => {
    const prompt = "Quick safety check: Is this a project you created or one you trust?";
    const match = DEFAULT_INTERSTITIALS.find((entry) => entry.pattern.test(prompt));

    expect(match?.sendKeys).toBe("1");
  });
});
