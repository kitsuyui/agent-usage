import { join, normalize } from "node:path";
import type { PrismaClient } from "@prisma/client";
import { toUsageSnapshot, usageSnapshotSchema } from "../domain/snapshot-schema.ts";
import { listProviders } from "../providers/index.ts";
import {
  chartSeriesFromHistory,
  distinctProviders,
  downsampleHistory,
  type HistoryQuery,
  latestSnapshot,
  latestSnapshots,
  nextResets,
  providerHealth,
  queryHistory,
  recordSnapshot,
} from "../storage/repository.ts";

const PUBLIC_DIR = normalize(join(import.meta.dir, "..", "..", "frontend"));
export const DEFAULT_HTTP_HOST = "127.0.0.1";

export interface HttpServerOptions {
  /**
   * Interface or hostname to bind. Defaults to loopback; remote access must
   * opt in explicitly, for example with `0.0.0.0`.
   */
  host?: string;
  port: number;
  db: PrismaClient;
  /**
   * Shared-secret bearer token required on `POST /api/usage/samples`. Omit
   * to accept ingest requests unauthenticated — fine for a trusted network;
   * put a proper auth layer (reverse proxy, VPN, ...) in front otherwise.
   */
  ingestToken?: string;
  /** A successful collector becomes stale after this many seconds. */
  staleAfterSeconds?: number;
}

/** Starts the HTTP API (and static frontend) server. */
export function createHttpServer(options: HttpServerOptions) {
  const { db, port, ingestToken, staleAfterSeconds } = options;
  return Bun.serve({
    hostname: resolveHttpHost(options.host),
    port,
    async fetch(request) {
      const url = new URL(request.url);
      try {
        if (url.pathname === "/health") return json({ status: "ok" });
        if (url.pathname === "/api/providers") {
          return json(await providersPayload(db, staleAfterSeconds));
        }
        if (url.pathname === "/api/usage/latest") {
          return json(await latestPayload(db, url.searchParams.get("provider")));
        }
        if (url.pathname === "/api/usage/history") {
          const parsed = parseHistoryQuery(url.searchParams);
          const points = await queryHistory(db, parsed.query);
          return json(parsed.maxPoints ? downsampleHistory(points, parsed.maxPoints) : points);
        }
        if (url.pathname === "/api/usage/chart") {
          const parsed = parseHistoryQuery(url.searchParams);
          if (!parsed.query.provider) throw new BadRequestError("provider is required");
          const points = await queryHistory(db, parsed.query);
          const sampled = parsed.maxPoints ? downsampleHistory(points, parsed.maxPoints) : points;
          return json(chartSeriesFromHistory(sampled));
        }
        if (url.pathname === "/api/usage/next-resets") return json(await nextResets(db));
        if (url.pathname === "/api/usage/samples" && request.method === "POST") {
          return await ingestSample(db, request, ingestToken);
        }
        if (url.pathname.startsWith("/api/")) return json({ error: "not found" }, 404);
        return await serveStatic(url.pathname);
      } catch (error) {
        if (error instanceof BadRequestError) return json({ error: error.message }, 400);
        return json({ error: error instanceof Error ? error.message : String(error) }, 500);
      }
    },
  });
}

export function resolveHttpHost(value: string | undefined): string {
  return value?.trim() || DEFAULT_HTTP_HOST;
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

async function providersPayload(db: PrismaClient, staleAfterSeconds?: number) {
  const withData = new Set(await distinctProviders(db));
  return Promise.all(
    listProviders().map(async (provider) => ({
      id: provider.id,
      displayName: provider.displayName,
      hasData: withData.has(provider.id),
      ...(await providerHealth(db, provider.id, staleAfterSeconds)),
    })),
  );
}

async function latestPayload(db: PrismaClient, provider: string | null) {
  if (provider) {
    const snapshot = await latestSnapshot(db, provider);
    return snapshot ? [snapshot] : [];
  }
  return latestSnapshots(db);
}

interface ParsedHistoryQuery {
  query: HistoryQuery;
  maxPoints?: number;
}

const RANGE_PATTERN = /^(\d+)(m|h|d|w)$/;
const RANGE_UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 } as const;

function parseHistoryQuery(params: URLSearchParams): ParsedHistoryQuery {
  const provider = params.get("provider");
  const scope = params.get("scope");
  const windowLabel = params.get("window");
  const metric = params.get("metric");
  const unit = params.get("unit");
  const since = params.get("since");
  const until = params.get("until");
  const range = params.get("range");
  if (since && range) throw new BadRequestError("since and range cannot be combined");
  const parsedUntil = until ? parseTimestamp(until, "until") : undefined;
  const parsedSince = since
    ? parseTimestamp(since, "since").toISOString()
    : range
      ? new Date((parsedUntil?.getTime() ?? Date.now()) - parseRangeMs(range)).toISOString()
      : undefined;
  const limit = parseInteger(params.get("limit"), "limit", 1, 100_000);
  const maxPoints = parseInteger(params.get("maxPoints"), "maxPoints", 3, 2_000);
  return {
    query: {
      ...(provider ? { provider } : {}),
      ...(scope ? { scope } : {}),
      ...(windowLabel ? { window: windowLabel } : {}),
      ...(metric ? { metric } : {}),
      ...(unit ? { unit } : {}),
      ...(parsedSince ? { since: parsedSince } : {}),
      ...(parsedUntil ? { until: parsedUntil.toISOString() } : {}),
      ...(limit !== undefined ? { limit } : {}),
    },
    ...(maxPoints !== undefined ? { maxPoints } : {}),
  };
}

function parseRangeMs(value: string): number {
  const match = RANGE_PATTERN.exec(value.trim().toLowerCase());
  if (!match) throw new BadRequestError("range must use a positive duration such as 10h, 14d, or 4w");
  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new BadRequestError("range must be positive");
  return amount * RANGE_UNIT_MS[match[2] as keyof typeof RANGE_UNIT_MS];
}

function parseTimestamp(value: string, name: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new BadRequestError(`${name} must be an ISO-8601 timestamp`);
  return parsed;
}

function parseInteger(
  value: string | null,
  name: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === null) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new BadRequestError(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

class BadRequestError extends Error {}

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
