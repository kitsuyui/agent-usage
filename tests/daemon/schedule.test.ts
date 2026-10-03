import { describe, expect, test } from "bun:test";
import { SamplingSchedule } from "../../src/daemon/schedule.ts";
import type { SamplingConfig } from "../../src/daemon/sampling-control.ts";

const config = (intervalSeconds: number, refreshRequestId: string | null = null): SamplingConfig => ({
  intervalSeconds, refreshRequestId,
  refreshRequestedAt: refreshRequestId ? "2026-10-03T04:00:00.000Z" : null,
});

describe("live sampling schedule", () => {
  test("starts immediately and waits from capture completion", () => {
    const schedule = new SamplingSchedule(900, 1000);
    schedule.apply(config(900, "old-request"), 1000);
    expect(schedule.nextSampleAt).toBe(1000);
    schedule.completed(2000);
    expect(schedule.nextSampleAt).toBe(902000);
    schedule.apply(config(900, "old-request"), 3000);
    expect(schedule.nextSampleAt).toBe(902000);
  });

  test("shorter and longer intervals restart the waiting period", () => {
    const schedule = new SamplingSchedule(900, 0);
    schedule.apply(config(900), 0);
    schedule.completed(0);
    schedule.apply(config(300), 1000);
    expect(schedule.nextSampleAt).toBe(301000);
    schedule.apply(config(300), 2000);
    expect(schedule.nextSampleAt).toBe(301000);
    schedule.apply(config(1800), 3000);
    expect(schedule.nextSampleAt).toBe(1803000);
  });

  test("changing the interval cannot postpone an already-due capture", () => {
    const schedule = new SamplingSchedule(900, 0);
    schedule.apply(config(300), 1000);
    expect(schedule.nextSampleAt).toBe(0);
  });

  test("a refresh is not lost when the first settings read fails", () => {
    const schedule = new SamplingSchedule(900, 0);
    schedule.completed(1000);
    schedule.apply(config(900, "request-while-offline"), 2000);
    expect(schedule.nextSampleAt).toBe(2000);
    schedule.completed(3000);
    schedule.apply(config(900, "request-while-offline"), 4000);
    expect(schedule.nextSampleAt).toBe(903000);
  });

  test("manual requests coalesce, and an observed request is not replayed", () => {
    const schedule = new SamplingSchedule(900, 0);
    schedule.apply(config(900), 0);
    schedule.completed(0);
    schedule.apply(config(900, "latest-of-three"), 1000);
    expect(schedule.nextSampleAt).toBe(1000);
    schedule.completed(1500);
    schedule.apply(config(900, "latest-of-three"), 1600);
    expect(schedule.nextSampleAt).toBe(901500);
    schedule.apply(config(900, "new-request"), 2000);
    expect(schedule.nextSampleAt).toBe(2000);
  });
});
