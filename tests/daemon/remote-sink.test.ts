import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaClient } from "@prisma/client";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { createHttpServer } from "../../src/server/http.ts";
import { createRemoteSink } from "../../src/daemon/remote-sink.ts";
import { snapshotFromWindows } from "../../src/domain/types.ts";
import { remainingWindow } from "../../src/domain/window-builder.ts";
import { latestSnapshot } from "../../src/storage/repository.ts";

const ROOT = `${import.meta.dir}/../..`;
const DB_PATH = `${ROOT}/data/test-remote-sink.db`;
const DATABASE_URL = `file:${DB_PATH}`;

let db: PrismaClient;
let server: ReturnType<typeof createHttpServer>;
let baseUrl: string;

beforeAll(() => {
  mkdirSync(`${ROOT}/data`, { recursive: true });
  if (existsSync(DB_PATH)) rmSync(DB_PATH);
  const push = Bun.spawnSync(["bunx", "prisma", "db", "push", "--skip-generate", "--accept-data-loss"], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL },
  });
  if (push.exitCode !== 0) throw new Error(`prisma db push failed: ${push.stderr.toString()}`);

  db = new PrismaClient({ datasourceUrl: DATABASE_URL });
  server = createHttpServer({ db, port: 0, ingestToken: "collector-token" });
  baseUrl = `http://localhost:${server.port}`;
}, 30_000);

afterAll(async () => {
  server.stop();
  await db.$disconnect();
  if (existsSync(DB_PATH)) rmSync(DB_PATH);
});

describe("createRemoteSink", () => {
  test("pushes a snapshot to the server's ingest endpoint", async () => {
    const sink = createRemoteSink({ url: baseUrl, token: "collector-token" });
    const observedAt = "2026-07-18T12:00:00Z";
    const snapshot = snapshotFromWindows("codex", observedAt, [
      remainingWindow({ window: "5h", remainingPercent: 80, observedAt }),
    ]);

    await sink.record(snapshot);

    const stored = await latestSnapshot(db, "codex");
    expect(stored?.observedAt).toBe(observedAt);
    expect(stored?.windows[0]?.remainingPercent).toBe(80);
  });

  test("rejects with a descriptive error when the token is wrong", async () => {
    const sink = createRemoteSink({ url: baseUrl, token: "wrong-token" });
    const snapshot = snapshotFromWindows("codex", "2026-07-18T13:00:00Z", []);
    await expect(sink.record(snapshot)).rejects.toThrow(/ingest request failed: 401/);
  });
});
