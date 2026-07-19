import { describe, expect, test } from "bun:test";
import { runDaemon } from "../../src/daemon/index.ts";

describe("runDaemon validation", () => {
  test("requires a sink unless sample is disabled", async () => {
    await expect(runDaemon({})).rejects.toThrow(/sink is required/);
  });

  test("requires an http server when sample is disabled", async () => {
    await expect(runDaemon({ sample: false })).rejects.toThrow(/nothing to do/);
  });
});
