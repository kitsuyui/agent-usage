import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaClient } from "@prisma/client";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSamplingControl, createRemoteControlReader } from "../../src/daemon/sampling-control.ts";
import { createHttpServer } from "../../src/server/http.ts";

const directory = mkdtempSync(join(tmpdir(), "agent-usage-control-test-"));
const databaseUrl = `file:${join(directory, "usage.db")}`;
let db: PrismaClient;
let server: ReturnType<typeof createHttpServer>;
let url: string;

beforeAll(() => {
  writeFileSync(join(directory, "usage.db"), "");
  const migrate = Bun.spawnSync(["bunx", "prisma", "migrate", "deploy"], {
    cwd: `${import.meta.dir}/../..`, env: { ...process.env, DATABASE_URL: databaseUrl },
  });
  if (migrate.exitCode !== 0) throw new Error(migrate.stderr.toString());
  db = new PrismaClient({ datasourceUrl: databaseUrl });
  server = createHttpServer({ db, port: 0, samplingControl: createSamplingControl(db, 900), controlToken: "operator" });
  url = `http://127.0.0.1:${server.port}`;
}, 30000);

afterAll(async () => {
  server?.stop();
  await db?.$disconnect();
  rmSync(directory, { recursive: true, force: true });
});

function write(path: string, method: string, body: unknown, extra: Record<string, string> = {}) {
  return fetch(`${url}${path}`, { method,
    headers: { "content-type": "application/json", authorization: "Bearer operator", ...extra },
    body: JSON.stringify(body),
  });
}

describe("sampling control API and remote collectors", () => {
  test("persists live settings across server and database client restarts", async () => {
    expect((await createRemoteControlReader(url)()).intervalSeconds).toBe(900);
    const response = await write("/api/sampling", "PUT", { intervalSeconds: 300 });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await createRemoteControlReader(url)()).intervalSeconds).toBe(300);
    server.stop();
    await db.$disconnect();
    db = new PrismaClient({ datasourceUrl: databaseUrl });
    server = createHttpServer({ db, port: 0, samplingControl: createSamplingControl(db, 1800), controlToken: "operator" });
    url = `http://127.0.0.1:${server.port}`;
    expect((await createRemoteControlReader(url)()).intervalSeconds).toBe(300);
  });

  test("accepts manual refresh asynchronously and exposes a unique revision", async () => {
    const first = await write("/api/sampling/refresh", "POST", {});
    expect(first.status).toBe(202);
    const previous = await createRemoteControlReader(url)();
    expect(previous.refreshRequestId).toBeString();
    expect(previous.refreshRequestedAt).toBeString();
    await write("/api/sampling/refresh", "POST", {});
    const next = await createRemoteControlReader(url)();
    expect(next.refreshRequestId).not.toBe(previous.refreshRequestId);
    await write("/api/sampling", "PUT", { intervalSeconds: 600 });
    expect((await createRemoteControlReader(url)()).refreshRequestId).toBe(next.refreshRequestId);
  });

  test("rejects unauthorized, cross-origin, malformed, and out-of-range writes", async () => {
    expect((await write("/api/sampling", "PUT", { intervalSeconds: 300 }, { authorization: "Bearer collector" })).status).toBe(401);
    expect((await write("/api/sampling", "PUT", { intervalSeconds: 300 }, { origin: "https://attacker.invalid" })).status).toBe(403);
    expect((await write("/api/sampling/refresh", "POST", {}, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await write("/api/sampling/refresh", "POST", {}, { "content-type": "text/plain" })).status).toBe(415);
    for (const intervalSeconds of [0, -1, 59, 86401, 300.5, "300", null]) {
      expect((await write("/api/sampling", "PUT", { intervalSeconds })).status).toBe(400);
    }
    expect((await write("/api/sampling", "PUT", { intervalSeconds: 300, unexpected: true })).status).toBe(400);
    const malformed = await fetch(`${url}/api/sampling`, { method: "PUT",
      headers: { "content-type": "application/json", authorization: "Bearer operator" }, body: "{" });
    expect(malformed.status).toBe(400);
    expect((await write("/api/sampling", "POST", {})).status).toBe(405);
  });

  test("works without a control token on a trusted same-origin server", async () => {
    const local = createHttpServer({ db, port: 0, samplingControl: createSamplingControl(db, 900) });
    try {
      const endpoint = `http://127.0.0.1:${local.port}/api/sampling/refresh`;
      expect((await fetch(endpoint, { method: "POST", headers: {
        "content-type": "application/json", origin: new URL(endpoint).origin,
      }, body: "{}" })).status).toBe(202);
      expect((await fetch(endpoint, { method: "POST", headers: {
        "content-type": "application/json", origin: "null",
      }, body: "{}" })).status).toBe(403);
    } finally { local.stop(); }
  });

  test("servers without control do not falsely accept commands", async () => {
    const old = createHttpServer({ db, port: 0 });
    try {
      const endpoint = `http://127.0.0.1:${old.port}/api/sampling`;
      expect((await fetch(endpoint)).status).toBe(503);
      await expect(createRemoteControlReader(`http://127.0.0.1:${old.port}`)()).rejects.toThrow(/503/);
    } finally { old.stop(); }
  });
});
