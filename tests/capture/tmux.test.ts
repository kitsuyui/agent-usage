import { describe, expect, test } from "bun:test";
import { buildTmuxCommand, captureTui, type TmuxResult } from "../../src/capture/tmux.ts";

describe("tmux capture isolation", () => {
  test("uses a dedicated socket and ignores user tmux configuration", () => {
    expect(buildTmuxCommand(["list-sessions"], "agent-usage-test")).toEqual([
      "tmux",
      "-L",
      "agent-usage-test",
      "-f",
      "/dev/null",
      "list-sessions",
    ]);
  });
});

const success: TmuxResult = { stdout: "", stderr: "", exitCode: 0 };

describe("TUI readiness", () => {
  test("does not expose raw tmux stderr when launch fails", async () => {
    const stderrSentinel = "private-account-context@example.invalid";
    const runTmux = async (args: string[]): Promise<TmuxResult> => (
      args[0] === "new-session"
        ? { stdout: "", stderr: stderrSentinel, exitCode: 42 }
        : success
    );

    await expect(captureTui("test", {
      command: "test-cli",
      readyPattern: /ready/,
      slashCommand: "/usage",
      expectedPattern: /usage/,
    }, { runTmux })).rejects.toThrow('provider "test" TUI failed to launch (exit code 42)');

    try {
      await captureTui("test", {
        command: "test-cli",
        readyPattern: /ready/,
        slashCommand: "/usage",
        expectedPattern: /usage/,
      }, { runTmux });
    } catch (error) {
      expect(error).not.toHaveProperty("message", expect.stringContaining(stderrSentinel));
    }
  });

  test("waits through a delayed healthy startup before sending the usage command", async () => {
    const calls: string[][] = [];
    let captures = 0;
    const runTmux = async (args: string[]): Promise<TmuxResult> => {
      calls.push(args);
      if (args[0] === "capture-pane") {
        captures += 1;
        return { ...success, stdout: captures < 3 ? "loading" : captures === 3 ? "ready" : "usage" };
      }
      if (args[0] === "list-panes") return { ...success, stdout: "0" };
      return success;
    };

    await expect(captureTui("test", {
      command: "test-cli",
      readyPattern: /ready/,
      slashCommand: "/usage",
      expectedPattern: /usage/,
    }, {
      pollAttempts: 4,
      pollIntervalMs: 0,
      expectedAttempts: 1,
      sleep: async () => {},
      runTmux,
    })).resolves.toBe("usage");

    const captureIndexes = calls
      .map((args, index) => args[0] === "capture-pane" ? index : -1)
      .filter((index) => index >= 0);
    expect(calls.findIndex((args) => args.includes("/usage"))).toBeGreaterThan(captureIndexes[2] ?? -1);
  });

  test("does not send a slash command when startup never becomes ready and cleans up", async () => {
    const calls: string[][] = [];
    const runTmux = async (args: string[]): Promise<TmuxResult> => {
      calls.push(args);
      if (args[0] === "capture-pane") return { ...success, stdout: "still loading" };
      if (args[0] === "list-panes") return { ...success, stdout: "0" };
      return success;
    };

    await expect(captureTui("test", {
      command: "test-cli",
      readyPattern: /ready/,
      slashCommand: "/usage",
      expectedPattern: /usage/,
    }, {
      pollAttempts: 2,
      pollIntervalMs: 0,
      sleep: async () => {},
      runTmux,
    })).rejects.toThrow('provider "test" TUI did not become ready before startup timeout');

    expect(calls.some((args) => args.includes("/usage"))).toBe(false);
    expect(calls.filter((args) => args[0] === "kill-session")).toHaveLength(2);
  });
});
