import { describe, expect, test } from "bun:test";
import { exchangeRateLimits } from "../../src/providers/codex/capture.ts";

async function* neverResponds(): AsyncGenerator<{ id?: number }> {
  await new Promise<void>(() => {});
}

describe("Codex app-server timeouts", () => {
  test("labels a delayed initialization separately", async () => {
    const writes: string[] = [];
    await expect(exchangeRateLimits(
      { write: (data: string) => writes.push(data) },
      neverResponds(),
      { startupTimeoutMs: 1 },
    )).rejects.toThrow("codex app-server initialization timed out");
    expect(writes).toHaveLength(1);
  });

  test("labels a delayed usage response separately after initialization", async () => {
    const writes: string[] = [];
    async function* initializedThenWait(): AsyncGenerator<{ id?: number; result?: unknown }> {
      yield { id: 0, result: {} };
      await new Promise<void>(() => {});
    }

    await expect(exchangeRateLimits(
      { write: (data: string) => writes.push(data) },
      initializedThenWait(),
      { usageTimeoutMs: 1 },
    )).rejects.toThrow("codex app-server usage request timed out");
    expect(writes).toHaveLength(3);
    expect(writes[2]).toContain("account/rateLimits/read");
  });
});
