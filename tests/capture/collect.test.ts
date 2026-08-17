import { describe, expect, spyOn, test } from "bun:test";
import {
  captureCliVersion,
  classifyCaptureFailure,
  collectSnapshot,
} from "../../src/capture/collect.ts";
import { emptySnapshot } from "../../src/domain/types.ts";
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

  test("classifies billing statistics without quota windows separately", () => {
    expect(classifyCaptureFailure("API Usage Billing\nCurrent session\nTokens: 123")).toEqual({
      code: "usage_windows_unavailable",
      message: "provider returned usage statistics without rate-limit windows",
    });
  });

  test("does not write captured pane contents to failure logs", async () => {
    const raw = "API Usage Billing\nuser@example.invalid\n/Users/example/private-project";
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    const captureProvider: UsageProvider = {
      id: "claude",
      displayName: "Claude Code",
      versionCommand: ["true"],
      capture: async () => raw,
      parse: (_raw, observedAt) =>
        emptySnapshot("claude", observedAt, "provider output contained no usage windows"),
    };

    try {
      const snapshot = await collectSnapshot(captureProvider);

      expect(snapshot.errorCode).toBe("usage_windows_unavailable");
      expect(consoleError).toHaveBeenCalledWith(
        "[claude] capture failed (usage_windows_unavailable): provider returned usage statistics without rate-limit windows",
      );
      expect(consoleError).not.toHaveBeenCalledWith(expect.stringContaining("user@example.invalid"));
      expect(consoleError).not.toHaveBeenCalledWith(expect.stringContaining("/Users/example"));
    } finally {
      consoleError.mockRestore();
    }
  });
});
