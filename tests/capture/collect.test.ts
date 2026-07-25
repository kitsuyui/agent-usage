import { describe, expect, test } from "bun:test";
import {
  captureCliVersion,
  classifyCaptureFailure,
} from "../../src/capture/collect.ts";
import type { UsageProvider } from "../../src/providers/types.ts";

const provider = (versionCommand: string[]): UsageProvider => ({
  id: "test",
  displayName: "Test",
  versionCommand,
  tui: {
    command: "true",
    readyPattern: /ready/,
    slashCommand: "/usage",
    expectedPattern: /usage/,
  },
  parse: () => {
    throw new Error("not used");
  },
});

describe("capture provenance", () => {
  test("records the first non-empty CLI version line", async () => {
    expect(await captureCliVersion(provider(["bun", "--version"]))).toMatch(/^\d+\.\d+/);
  });

  test("a missing version command does not prevent capture", async () => {
    expect(await captureCliVersion(provider(["definitely-not-an-agent-usage-command", "--version"]))).toBeUndefined();
  });

  test("classifies authentication and parse failures with stable codes", () => {
    expect(classifyCaptureFailure("401 Invalid authentication credentials")).toMatchObject({
      code: "authentication_required",
    });
    expect(classifyCaptureFailure("unrecognized new screen")).toMatchObject({
      code: "parse_failed",
    });
  });
});
