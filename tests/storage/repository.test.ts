import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaClient } from "@prisma/client";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import {
  distinctProviders,
  latestSnapshot,
  nextResets,
  queryHistory,
  recordSnapshot,
} from "../../src/storage/repository.ts";
import { snapshotFromWindows } from "../../src/domain/types.ts";
import { remainingWindow, usedWindow } from "../../src/domain/window-builder.ts";

const ROOT = `${import.meta.dir}/../..`;
const DB_PATH = `${ROOT}/data/test-storage.db`;
const DATABASE_URL = `file:${DB_PATH}`;

let db: PrismaClient;

beforeAll(() => {
  mkdirSync(`${ROOT}/data`, { recursive: true });
  if (existsSync(DB_PATH)) rmSync(DB_PATH);
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

  test("an unknown provider has no latest snapshot", async () => {
    expect(await latestSnapshot(db, "nonexistent")).toBeUndefined();
  });
});
