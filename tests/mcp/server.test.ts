import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaClient } from "@prisma/client";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { createMcpServer } from "../../src/mcp/server.ts";
import { snapshotFromWindows } from "../../src/domain/types.ts";
import { remainingWindow } from "../../src/domain/window-builder.ts";
import { recordSnapshot } from "../../src/storage/repository.ts";
import { registerBuiltinProviders } from "../../src/providers/index.ts";

const ROOT = `${import.meta.dir}/../..`;
const DB_PATH = `${ROOT}/data/test-mcp.db`;
const DATABASE_URL = `file:${DB_PATH}`;

let db: PrismaClient;
let client: Client;

beforeAll(async () => {
  registerBuiltinProviders();
  mkdirSync(`${ROOT}/data`, { recursive: true });
  if (existsSync(DB_PATH)) rmSync(DB_PATH);
  const push = Bun.spawnSync(["bunx", "prisma", "db", "push", "--skip-generate", "--accept-data-loss"], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL },
  });
  if (push.exitCode !== 0) throw new Error(`prisma db push failed: ${push.stderr.toString()}`);

  db = new PrismaClient({ datasourceUrl: DATABASE_URL });
  const observedAt = "2026-07-18T09:00:00Z";
  await recordSnapshot(
    db,
    snapshotFromWindows("codex", observedAt, [
      remainingWindow({ window: "5h", remainingPercent: 70, resetsRaw: "2h 0m", observedAt }),
    ]),
  );

  const server = createMcpServer(db);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
}, 30_000);

afterAll(async () => {
  await db.$disconnect();
  if (existsSync(DB_PATH)) rmSync(DB_PATH);
});

function firstTextPayload(result: { content: { type: string; text?: string }[] }): unknown {
  const text = result.content.find((entry) => entry.type === "text")?.text;
  return text ? JSON.parse(text) : undefined;
}

describe("MCP server", () => {
  test("lists all registered tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining(["list_providers", "get_latest_usage", "get_usage_history", "get_next_resets"]),
    );
  });

  test("list_providers reports built-in providers with hasData", async () => {
    const result = await client.callTool({ name: "list_providers" });
    const payload = firstTextPayload(result as never) as { id: string; hasData: boolean }[];
    expect(payload.find((entry) => entry.id === "codex")?.hasData).toBe(true);
    expect(payload.find((entry) => entry.id === "claude")?.hasData).toBe(false);
  });

  test("get_latest_usage returns the recorded snapshot for a provider", async () => {
    const result = await client.callTool({ name: "get_latest_usage", arguments: { provider: "codex" } });
    const payload = firstTextPayload(result as never) as { provider: string }[];
    expect(payload).toHaveLength(1);
    expect(payload[0]?.provider).toBe("codex");
  });

  test("get_next_resets reflects the parsed reset time", async () => {
    const result = await client.callTool({ name: "get_next_resets" });
    const payload = firstTextPayload(result as never) as { provider: string; resetsAt: string | null }[];
    const codex = payload.find((entry) => entry.provider === "codex");
    expect(codex?.resetsAt).toBe("2026-07-18T11:00:00Z");
  });
});
