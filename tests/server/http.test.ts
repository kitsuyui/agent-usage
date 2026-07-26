import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaClient } from "@prisma/client";
import { closeSync, existsSync, mkdirSync, openSync, rmSync } from "node:fs";
import { createHttpServer, resolveHttpHost } from "../../src/server/http.ts";
import { emptySnapshot, snapshotFromWindows } from "../../src/domain/types.ts";
import { usedWindow } from "../../src/domain/window-builder.ts";
import { recordSnapshot } from "../../src/storage/repository.ts";
import { registerBuiltinProviders } from "../../src/providers/index.ts";

const ROOT = `${import.meta.dir}/../..`;
const DB_PATH = `${ROOT}/data/test-http.db`;
const DATABASE_URL = `file:${DB_PATH}`;

let db: PrismaClient;
let server: ReturnType<typeof createHttpServer>;
let baseUrl: string;

beforeAll(async () => {
  registerBuiltinProviders();
  mkdirSync(`${ROOT}/data`, { recursive: true });
  if (existsSync(DB_PATH)) rmSync(DB_PATH);
  closeSync(openSync(DB_PATH, "w"));
  const push = Bun.spawnSync(["bunx", "prisma", "db", "push", "--skip-generate", "--accept-data-loss"], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL },
  });
  if (push.exitCode !== 0) throw new Error(`prisma db push failed: ${push.stderr.toString()}`);

  db = new PrismaClient({ datasourceUrl: DATABASE_URL });
  const observedAt = "2026-07-18T09:00:00Z";
  await recordSnapshot(
    db,
    {
      ...snapshotFromWindows("claude", observedAt, [
        usedWindow({ window: "session", usedPercent: 20, observedAt }),
      ]),
      cliVersion: "claude 2.1.212",
    },
  );
  await recordSnapshot(db, {
    ...emptySnapshot(
      "antigravity",
      "2026-07-18T09:05:00Z",
      "provider authentication is required",
      "authentication_required",
    ),
    cliVersion: "1.1.7",
  });

  server = createHttpServer({ db, port: 0, staleAfterSeconds: 60 * 60 * 24 * 365 * 10 });
  baseUrl = `http://localhost:${server.port}`;
}, 30_000);

afterAll(async () => {
  server.stop();
  await db.$disconnect();
  if (existsSync(DB_PATH)) rmSync(DB_PATH);
});

describe("HTTP API", () => {
  test("binds to loopback by default and requires an explicit remote host", () => {
    expect(server.hostname).toBe("127.0.0.1");
    expect(resolveHttpHost(undefined)).toBe("127.0.0.1");
    expect(resolveHttpHost("  ")).toBe("127.0.0.1");
    expect(resolveHttpHost("0.0.0.0")).toBe("0.0.0.0");
  });

  test("GET /health", async () => {
    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  test("GET /api/providers lists the registry with hasData flags", async () => {
    const response = await fetch(`${baseUrl}/api/providers`);
    const body = (await response.json()) as {
      id: string;
      hasData: boolean;
      status: string;
      errorCode: string | null;
      cliVersion: string | null;
    }[];
    const ids = body.map((entry) => entry.id);
    expect(ids).toEqual(expect.arrayContaining(["claude", "codex", "antigravity", "copilot"]));
    expect(body.find((entry) => entry.id === "claude")?.hasData).toBe(true);
    expect(body.find((entry) => entry.id === "codex")?.hasData).toBe(false);
    expect(body.find((entry) => entry.id === "copilot")?.hasData).toBe(false);
    expect(body.find((entry) => entry.id === "claude")).toMatchObject({
      status: "healthy",
      cliVersion: "claude 2.1.212",
    });
    expect(body.find((entry) => entry.id === "antigravity")).toMatchObject({
      status: "failing",
      errorCode: "authentication_required",
      cliVersion: "1.1.7",
    });
  });

  test("GET /api/usage/latest?provider=claude returns the recorded snapshot", async () => {
    const response = await fetch(`${baseUrl}/api/usage/latest?provider=claude`);
    const body = (await response.json()) as { provider: string }[];
    expect(body).toHaveLength(1);
    expect(body[0]?.provider).toBe("claude");
  });

  test("GET /api/usage/history filters by provider", async () => {
    const response = await fetch(`${baseUrl}/api/usage/history?provider=claude`);
    const body = (await response.json()) as { provider: string }[];
    expect(body.length).toBeGreaterThan(0);
    expect(body.every((point) => point.provider === "claude")).toBe(true);
  });

  test("GET /api/usage/history accepts a relative range anchored by until", async () => {
    const response = await fetch(
      `${baseUrl}/api/usage/history?provider=claude&until=2026-07-18T10:00:00Z&range=2h&maxPoints=10`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { observedAt: string }[];
    expect(body.map((point) => point.observedAt)).toEqual(["2026-07-18T09:00:00Z"]);
  });

  test("GET /api/usage/history rejects conflicting and malformed bounds", async () => {
    const conflict = await fetch(
      `${baseUrl}/api/usage/history?since=2026-07-18T08:00:00Z&range=10h`,
    );
    expect(conflict.status).toBe(400);

    const malformed = await fetch(`${baseUrl}/api/usage/history?range=forever`);
    expect(malformed.status).toBe(400);
  });

  test("GET /api/usage/next-resets returns an array", async () => {
    const response = await fetch(`${baseUrl}/api/usage/next-resets`);
    expect(Array.isArray(await response.json())).toBe(true);
  });

  test("unknown /api/* route returns 404 JSON", async () => {
    const response = await fetch(`${baseUrl}/api/does-not-exist`);
    expect(response.status).toBe(404);
  });

  test("serves the static frontend index", async () => {
    const response = await fetch(`${baseUrl}/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("<title>Agent Usage</title>");
  });

  test("404s a static path that doesn't exist under the frontend directory", async () => {
    const response = await fetch(`${baseUrl}/does-not-exist.js`);
    expect(response.status).toBe(404);
  });

  test("POST /api/usage/samples records a snapshot when no ingest token is configured", async () => {
    const observedAt = "2026-07-18T10:00:00Z";
    const snapshot = snapshotFromWindows("codex", observedAt, [
      usedWindow({ window: "5h", usedPercent: 10, observedAt }),
    ]);
    const response = await fetch(`${baseUrl}/api/usage/samples`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(snapshot),
    });
    expect(response.status).toBe(201);

    const stored = await fetch(`${baseUrl}/api/usage/latest?provider=codex`);
    const body = (await stored.json()) as { provider: string; observedAt: string }[];
    expect(body[0]?.observedAt).toBe(observedAt);
  });

  test("POST /api/usage/samples rejects a malformed body", async () => {
    const response = await fetch(`${baseUrl}/api/usage/samples`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ not: "a snapshot" }),
    });
    expect(response.status).toBe(400);
  });
});

describe("HTTP API ingest auth", () => {
  const AUTH_DB_PATH = `${ROOT}/data/test-http-auth.db`;
  const AUTH_DATABASE_URL = `file:${AUTH_DB_PATH}`;
  let authDb: PrismaClient;
  let authServer: ReturnType<typeof createHttpServer>;
  let authBaseUrl: string;

  beforeAll(() => {
    if (existsSync(AUTH_DB_PATH)) rmSync(AUTH_DB_PATH);
    closeSync(openSync(AUTH_DB_PATH, "w"));
    const push = Bun.spawnSync(["bunx", "prisma", "db", "push", "--skip-generate", "--accept-data-loss"], {
      cwd: ROOT,
      env: { ...process.env, DATABASE_URL: AUTH_DATABASE_URL },
    });
    if (push.exitCode !== 0) throw new Error(`prisma db push failed: ${push.stderr.toString()}`);

    authDb = new PrismaClient({ datasourceUrl: AUTH_DATABASE_URL });
    authServer = createHttpServer({ db: authDb, port: 0, ingestToken: "secret-token" });
    authBaseUrl = `http://localhost:${authServer.port}`;
  }, 30_000);

  afterAll(async () => {
    authServer.stop();
    await authDb.$disconnect();
    if (existsSync(AUTH_DB_PATH)) rmSync(AUTH_DB_PATH);
  });

  const sampleSnapshot = () =>
    snapshotFromWindows("antigravity", "2026-07-18T11:00:00Z", [
      usedWindow({ window: "Weekly", usedPercent: 5, observedAt: "2026-07-18T11:00:00Z" }),
    ]);

  test("rejects an ingest request with no token", async () => {
    const response = await fetch(`${authBaseUrl}/api/usage/samples`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(sampleSnapshot()),
    });
    expect(response.status).toBe(401);
  });

  test("rejects an ingest request with the wrong token", async () => {
    const response = await fetch(`${authBaseUrl}/api/usage/samples`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer wrong" },
      body: JSON.stringify(sampleSnapshot()),
    });
    expect(response.status).toBe(401);
  });

  test("accepts an ingest request with the correct token", async () => {
    const response = await fetch(`${authBaseUrl}/api/usage/samples`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer secret-token" },
      body: JSON.stringify(sampleSnapshot()),
    });
    expect(response.status).toBe(201);
  });

  test("read endpoints stay open even when an ingest token is configured", async () => {
    const response = await fetch(`${authBaseUrl}/api/providers`);
    expect(response.status).toBe(200);
  });
});
