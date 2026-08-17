import { describe, expect, test } from "bun:test";
import { buildTmuxCommand } from "../../src/capture/tmux.ts";

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
