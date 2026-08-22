import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaClient } from "@prisma/client";
import { closeSync, existsSync, mkdirSync, openSync, rmSync } from "node:fs";
import {
  chartSeriesFromHistory,
  downsampleHistory,
  distinctProviders,
  latestSnapshot,
  nextResets,
  providerHealth,
  queryHistory,
  recordSnapshot,
} from "../../src/storage/repository.ts";
import { emptySnapshot, snapshotFromWindows } from "../../src/domain/types.ts";
import { measuredWindow, remainingWindow, usedWindow } from "../../src/domain/window-builder.ts";

const ROOT = `${import.meta.dir}/../..`;
const DB_PATH = `${ROOT}/data/test-storage.db`;
const DATABASE_URL = `file:${DB_PATH}`;

let db: PrismaClient;

beforeAll(() => {
  mkdirSync(`${ROOT}/data`, { recursive: true });
  if (existsSync(DB_PATH)) rmSync(DB_PATH);
  closeSync(openSync(DB_PATH, "w"));
  const result = Bun.spawnSync(["bunx", "prisma", "db", "push", "--skip-generate", "--accept-data-loss"], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL },
  });
  if (result.exitCode !== 0) {
    throw new Error(`prisma db push failed: ${result.stderr.toString()}`);
  }
  db = new PrismaClient({ datasourceUrl: DATABASE_URL });
}, 30_000);

afterAll(async () => {
  await db.$disconnect();
  if (existsSync(DB_PATH)) rmSync(DB_PATH);
});

describe("repository", () => {
  test("records and retrieves the latest snapshot per provider", async () => {
    const observedAt = "2026-07-18T10:00:00Z";
    await recordSnapshot(
      db,
      snapshotFromWindows("claude", observedAt, [usedWindow({ window: "session", usedPercent: 12, observedAt })]),
    );
    const later = "2026-07-18T11:00:00Z";
    await recordSnapshot(
      db,
      snapshotFromWindows("claude", later, [usedWindow({ window: "session", usedPercent: 30, observedAt: later })]),
    );

    const latest = await latestSnapshot(db, "claude");
    expect(latest?.observedAt).toBe(later);
    expect(latest?.windows[0]?.usedPercent).toBe(30);
  });

  test("lists distinct providers and aggregates next resets", async () => {
    const observedAt = "2026-07-18T12:00:00Z";
    await recordSnapshot(
      db,
      snapshotFromWindows("codex", observedAt, [
        remainingWindow({ window: "5h", remainingPercent: 80, resetsRaw: "2h 0m", observedAt }),
      ]),
    );

    const providers = await distinctProviders(db);
    expect(providers).toContain("claude");
    expect(providers).toContain("codex");

    const resets = await nextResets(db);
    const codexReset = resets.find((entry) => entry.provider === "codex");
    expect(codexReset?.resetsAt).toBe("2026-07-18T14:00:00Z");
  });

  test("queries history filtered by provider and window", async () => {
    const points = await queryHistory(db, { provider: "claude", window: "session" });
    expect(points.length).toBeGreaterThanOrEqual(2);
    expect(points.every((point) => point.provider === "claude")).toBe(true);
  });

  test("records capture provenance and reports consecutive failures", async () => {
    const successAt = "2026-07-25T08:00:00Z";
    const success = snapshotFromWindows("health-test", successAt, [
      usedWindow({ window: "session", usedPercent: 10, observedAt: successAt }),
    ]);
    await recordSnapshot(db, { ...success, cliVersion: "tool 1.2.3" });
    await recordSnapshot(
      db,
      {
        ...emptySnapshot(
          "health-test",
          "2026-07-25T08:15:00Z",
          "provider authentication is required",
          "authentication_required",
        ),
        cliVersion: "tool 1.2.4",
      },
    );
    await recordSnapshot(
      db,
      {
        ...emptySnapshot(
          "health-test",
          "2026-07-25T08:30:00Z",
          "provider authentication is required",
          "authentication_required",
        ),
        cliVersion: "tool 1.2.4",
      },
    );

    expect(await latestSnapshot(db, "health-test")).toMatchObject({
      ok: false,
      errorCode: "authentication_required",
      cliVersion: "tool 1.2.4",
    });
    expect(await providerHealth(db, "health-test", 60 * 60 * 24 * 365)).toMatchObject({
      status: "failing",
      lastSuccessAt: successAt,
      consecutiveFailures: 2,
      errorCode: "authentication_required",
      cliVersion: "tool 1.2.4",
    });
    const [point] = await queryHistory(db, { provider: "health-test" });
    expect(point?.cliVersion).toBe("tool 1.2.3");
  });

  test("marks an old successful collector as stale", async () => {
    expect(await providerHealth(db, "claude", 1)).toMatchObject({
      status: "stale",
      stale: true,
      latestOk: true,
    });
  });

  test("a bounded history query returns the newest points in chronological order", async () => {
    for (const hour of [1, 2, 3]) {
      const observedAt = `2026-07-19T0${hour}:00:00Z`;
      await recordSnapshot(
        db,
        snapshotFromWindows("bounded", observedAt, [
          usedWindow({ window: "session", usedPercent: hour * 10, observedAt }),
        ]),
      );
    }

    const points = await queryHistory(db, { provider: "bounded", limit: 2 });
    expect(points.map((point) => point.observedAt)).toEqual([
      "2026-07-19T02:00:00Z",
      "2026-07-19T03:00:00Z",
    ]);
  });

  test("stores open-ended model and pricing measurements without a schema enum", async () => {
    const observedAt = "2026-07-20T00:00:00Z";
    await recordSnapshot(
      db,
      snapshotFromWindows("pricing-source", observedAt, [
        measuredWindow({
          window: "effective",
          metric: "price",
          unit: "USD/million_tokens",
          value: 1.25,
          attributes: { model: "future-model", category: "input", tier: "standard" },
          observedAt,
        }),
      ]),
    );

    const [point] = await queryHistory(db, { provider: "pricing-source", metric: "price" });
    expect(point).toMatchObject({
      value: 1.25,
      unit: "USD/million_tokens",
      attributes: { model: "future-model", category: "input", tier: "standard" },
    });
  });

  test("downsamples each series independently while retaining endpoints and extrema", () => {
    const points = Array.from({ length: 20 }, (_, index) => ({
      provider: "test",
      seriesId: "series-a",
      scope: null,
      window: "daily",
      windowSeconds: 86_400,
      metric: "requests",
      unit: "request",
      value: index === 10 ? 1_000 : index,
      limitValue: null,
      remainingValue: null,
      usedValue: null,
      attributes: {},
      cliVersion: null,
      observedAt: `2026-07-21T${String(index).padStart(2, "0")}:00:00Z`,
      remainingPercent: null,
      usedPercent: null,
      resetsRaw: null,
      resetsAt: null,
    }));

    const sampled = downsampleHistory(points, 6);
    expect(sampled.length).toBeLessThanOrEqual(6);
    expect(sampled[0]?.observedAt).toBe(points[0]?.observedAt);
    expect(sampled.at(-1)?.observedAt).toBe(points.at(-1)?.observedAt);
    expect(sampled.some((point) => point.value === 1_000)).toBe(true);
  });

  test("groups chart history without repeating metadata for every point", () => {
    const points = [
      {
        provider: "test",
        seriesId: "series-a",
        scope: "default",
        window: "daily",
        windowSeconds: 86_400,
        metric: "quota",
        unit: "percent",
        value: null,
        limitValue: null,
        remainingValue: null,
        usedValue: null,
        attributes: { plan: "pro" },
        cliVersion: "tool 1.0.0",
        observedAt: "2026-07-21T00:00:00Z",
        remainingPercent: null,
        usedPercent: 25,
        resetsRaw: "1h",
        resetsAt: "2026-07-21T01:00:00Z",
      },
      {
        provider: "test",
        seriesId: "series-a",
        scope: "default",
        window: "daily",
        windowSeconds: 86_400,
        metric: "quota",
        unit: "percent",
        value: null,
        limitValue: null,
        remainingValue: null,
        usedValue: null,
        attributes: { plan: "pro" },
        cliVersion: "tool 1.0.1",
        observedAt: "2026-07-21T01:00:00Z",
        remainingPercent: 70,
        usedPercent: null,
        resetsRaw: "2h",
        resetsAt: "2026-07-21T03:00:00Z",
      },
    ];

    expect(chartSeriesFromHistory(points)).toEqual([
      {
        provider: "test",
        scope: "default",
        window: "daily",
        metric: "quota",
        unit: "percent",
        attributes: { plan: "pro" },
        scale: "remaining-percent",
        points: [
          [Date.parse("2026-07-21T00:00:00Z"), 75],
          [Date.parse("2026-07-21T01:00:00Z"), 70],
        ],
      },
    ]);
  });

  test("an unknown provider has no latest snapshot", async () => {
    expect(await latestSnapshot(db, "nonexistent")).toBeUndefined();
  });
});
