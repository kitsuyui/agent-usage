import { describe, expect, test } from "bun:test";
import { usageSnapshotSchema } from "../../src/domain/snapshot-schema.ts";

const base = {
  schemaVersion: 1,
  observedAt: "2026-07-18T09:00:00.000Z",
  provider: "example",
  ok: true,
  windows: [],
};

describe("credit balance snapshot validation", () => {
  test("accepts explicit expiry states and an unlimited balance", () => {
    const result = usageSnapshotSchema.safeParse({
      ...base,
      creditBalances: [
        {
          id: "monthly",
          kind: "credit",
          label: "Monthly credits",
          unit: "credit",
          remaining: 2.5,
          expiry: { kind: "at", at: "2026-08-01T00:00:00.000Z" },
          renewsAt: "2026-08-01T00:00:00.000Z",
          grants: [
            { remaining: 1, expiry: { kind: "never" } },
            { remaining: 1.5, expiry: { kind: "unknown" } },
          ],
        },
        {
          id: "included",
          kind: "credit",
          label: "Included credits",
          unit: "credit",
          unlimited: true,
          expiry: { kind: "never" },
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  test("rejects unreported, contradictory, or invalid balances", () => {
    const invalidBalances = [
      { remaining: undefined, unlimited: undefined },
      { remaining: 1, unlimited: true },
      { remaining: -1 },
      { remaining: 1, expiry: { kind: "at", at: "not-a-date" } },
    ];
    for (const amount of invalidBalances) {
      expect(usageSnapshotSchema.safeParse({
        ...base,
        creditBalances: [{
          id: "credit",
          kind: "credit",
          label: "Credits",
          unit: "credit",
          expiry: { kind: "unknown" },
          ...amount,
        }],
      }).success).toBe(false);
    }
  });

  test("rejects duplicate resource identities but permits different units", () => {
    const balance = {
      id: "included",
      kind: "credit" as const,
      label: "Included credits",
      unit: "credit",
      remaining: 1,
      expiry: { kind: "unknown" as const },
    };
    expect(usageSnapshotSchema.safeParse({
      ...base,
      creditBalances: [balance, balance],
    }).success).toBe(false);
    expect(usageSnapshotSchema.safeParse({
      ...base,
      creditBalances: [balance, { ...balance, unit: "token" }],
    }).success).toBe(true);
  });
});
