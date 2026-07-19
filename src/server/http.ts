import { join, normalize } from "node:path";
import type { PrismaClient } from "@prisma/client";
import { toUsageSnapshot, usageSnapshotSchema } from "../domain/snapshot-schema.ts";
import { listProviders } from "../providers/index.ts";
import {
  distinctProviders,
  type HistoryQuery,
  latestSnapshot,
  latestSnapshots,
  nextResets,
  queryHistory,
  recordSnapshot,
} from "../storage/repository.ts";

const PUBLIC_DIR = normalize(join(import.meta.dir, "..", "..", "frontend"));

export interface HttpServerOptions {
  port: number;
  db: PrismaClient;
  /**
   * Shared-secret bearer token required on `POST /api/usage/samples`. Omit
   * to accept ingest requests unauthenticated — fine for a trusted network;
   * put a proper auth layer (reverse proxy, VPN, ...) in front otherwise.
   */
  ingestToken?: string;
}

/** Starts the HTTP API (and static frontend) server. */
export function createHttpServer(options: HttpServerOptions) {
  const { db, port, ingestToken } = options;
  return Bun.serve({
    port,
    async fetch(request) {
      const url = new URL(request.url);
      try {
        if (url.pathname === "/health") return json({ status: "ok" });
        if (url.pathname === "/api/providers") return json(await providersPayload(db));
        if (url.pathname === "/api/usage/latest") {
          return json(await latestPayload(db, url.searchParams.get("provider")));
        }
        if (url.pathname === "/api/usage/history") {
          return json(await queryHistory(db, parseHistoryQuery(url.searchParams)));
        }
        if (url.pathname === "/api/usage/next-resets") return json(await nextResets(db));
        if (url.pathname === "/api/usage/samples" && request.method === "POST") {
          return await ingestSample(db, request, ingestToken);
        }
        if (url.pathname.startsWith("/api/")) return json({ error: "not found" }, 404);
        return await serveStatic(url.pathname);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 500);
      }
    },
  });
}

async function ingestSample(db: PrismaClient, request: Request, ingestToken: string | undefined): Promise<Response> {
  if (ingestToken && request.headers.get("authorization") !== `Bearer ${ingestToken}`) {
    return json({ error: "unauthorized" }, 401);
  }
  const body: unknown = await request.json().catch(() => undefined);
  const result = usageSnapshotSchema.safeParse(body);
  if (!result.success) {
    return json({ error: "invalid snapshot", details: result.error.flatten() }, 400);
  }
  await recordSnapshot(db, toUsageSnapshot(result.data));
  return json({ status: "recorded" }, 201);
}

async function providersPayload(db: PrismaClient) {
  const withData = new Set(await distinctProviders(db));
  return listProviders().map((provider) => ({
    id: provider.id,
    displayName: provider.displayName,
    hasData: withData.has(provider.id),
  }));
}

async function latestPayload(db: PrismaClient, provider: string | null) {
  if (provider) {
    const snapshot = await latestSnapshot(db, provider);
    return snapshot ? [snapshot] : [];
  }
  return latestSnapshots(db);
}

function parseHistoryQuery(params: URLSearchParams): HistoryQuery {
  const provider = params.get("provider");
  const windowLabel = params.get("window");
  const since = params.get("since");
  const until = params.get("until");
  const limit = Number(params.get("limit"));
  return {
    ...(provider ? { provider } : {}),
    ...(windowLabel ? { window: windowLabel } : {}),
    ...(since ? { since } : {}),
    ...(until ? { until } : {}),
    ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}),
  };
}

async function serveStatic(pathname: string): Promise<Response> {
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const filePath = normalize(join(PUBLIC_DIR, relative));
  if (!filePath.startsWith(PUBLIC_DIR)) return new Response("not found", { status: 404 });
  const file = Bun.file(filePath);
  if (await file.exists()) return new Response(file);
  return new Response("not found", { status: 404 });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}
