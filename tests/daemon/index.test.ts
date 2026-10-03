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

// Exercise the daemon with a synthetic machine-readable provider, never a real agent CLI.
test("requests during capture coalesce into one follow-up capture without overlap", async () => {
  const { registerProvider } = await import("../../src/providers/index.ts");
  const { snapshotFromWindows } = await import("../../src/domain/types.ts");
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let started!: () => void;
  const firstStarted = new Promise<void>((resolve) => { started = resolve; });
  let completed!: () => void;
  const secondDone = new Promise<void>((resolve) => { completed = resolve; });
  let count = 0;
  let active = 0;
  let maxActive = 0;
  let requestId: string | null = null;
  registerProvider({
    id: "sampling-test", displayName: "Sampling test", versionCommand: ["bun", "--version"],
    async capture() {
      active++;
      maxActive = Math.max(maxActive, active);
      count++;
      if (count === 1) { started(); await firstGate; }
      active--;
      return "test";
    },
    parse(_raw, observedAt) { return snapshotFromWindows("sampling-test", observedAt, [{ window: "test" }]); },
  });
  let records = 0;
  const daemon = runDaemon({
    intervalSeconds: 900, providerId: "sampling-test",
    sink: { async record() { if (++records === 2) completed(); } },
    readSamplingConfig: async () => ({ intervalSeconds: 300, refreshRequestId: requestId,
      refreshRequestedAt: requestId ? "2026-10-03T04:00:00.000Z" : null }),
  });
  try {
    await firstStarted;
    requestId = "one";
    requestId = "two";
    requestId = "three";
    releaseFirst();
    await secondDone;
    expect(count).toBe(2);
    expect(maxActive).toBe(1);
  } finally {
    releaseFirst();
    process.emit("SIGTERM");
    await daemon;
  }
});
