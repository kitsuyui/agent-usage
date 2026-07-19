import type { PrismaClient, Sample, Window } from "@prisma/client";
import type { UsageSnapshot, UsageWindow } from "../domain/types.ts";
import { toIsoSeconds } from "../domain/time.ts";

type SampleWithWindows = Sample & { windows: Window[] };

/** Persists one snapshot (and its windows) as a new sample row. */
export async function recordSnapshot(db: PrismaClient, snapshot: UsageSnapshot): Promise<void> {
  const observedAt = new Date(snapshot.observedAt);
  await db.sample.create({
    data: {
      provider: snapshot.provider,
      observedAt,
      ok: snapshot.ok,
      error: snapshot.error ?? null,
      resetCredits: snapshot.resetCredits ?? null,
      windows: {
        create: snapshot.windows.map((window) => ({
          scope: window.scope ?? null,
          window: window.window,
          windowSeconds: window.windowSeconds ?? null,
          remainingPercent: window.remainingPercent ?? null,
          usedPercent: window.usedPercent ?? null,
          resetsRaw: window.resetsRaw ?? null,
          resetsAt: window.resetsAt ? new Date(window.resetsAt) : null,
          provider: snapshot.provider,
          observedAt,
        })),
      },
    },
  });
}

/** Provider ids that have at least one recorded sample, alphabetically. */
export async function distinctProviders(db: PrismaClient): Promise<string[]> {
  const rows = await db.sample.findMany({
    distinct: ["provider"],
    select: { provider: true },
    orderBy: { provider: "asc" },
  });
  return rows.map((row) => row.provider);
}

/** The most recently recorded snapshot for one provider, if any. */
export async function latestSnapshot(db: PrismaClient, provider: string): Promise<UsageSnapshot | undefined> {
  const sample = await db.sample.findFirst({
    where: { provider },
    orderBy: { observedAt: "desc" },
    include: { windows: true },
  });
  return sample ? toSnapshot(sample) : undefined;
}

/** The most recently recorded snapshot for every provider that has data. */
export async function latestSnapshots(db: PrismaClient): Promise<UsageSnapshot[]> {
  const providers = await distinctProviders(db);
  const snapshots = await Promise.all(providers.map((provider) => latestSnapshot(db, provider)));
  return snapshots.filter((snapshot): snapshot is UsageSnapshot => snapshot !== undefined);
}

export interface HistoryQuery {
  provider?: string;
  window?: string;
  since?: string;
  until?: string;
  limit?: number;
}

export interface HistoryPoint {
  provider: string;
  scope: string | null;
  window: string;
  windowSeconds: number | null;
  observedAt: string;
  remainingPercent: number | null;
  usedPercent: number | null;
  resetsRaw: string | null;
  resetsAt: string | null;
}

/** A flattened, chart-ready time series of window observations. */
export async function queryHistory(db: PrismaClient, query: HistoryQuery = {}): Promise<HistoryPoint[]> {
  const rows = await db.window.findMany({
    where: {
      ...(query.provider ? { provider: query.provider } : {}),
      ...(query.window ? { window: query.window } : {}),
      ...(query.since || query.until
        ? {
            observedAt: {
              ...(query.since ? { gte: new Date(query.since) } : {}),
              ...(query.until ? { lte: new Date(query.until) } : {}),
            },
          }
        : {}),
    },
    orderBy: { observedAt: "asc" },
    take: query.limit ?? 2000,
  });
  return rows.map((row) => ({
    provider: row.provider,
    scope: row.scope,
    window: row.window,
    windowSeconds: row.windowSeconds,
    observedAt: toIsoSeconds(row.observedAt),
    remainingPercent: row.remainingPercent,
    usedPercent: row.usedPercent,
    resetsRaw: row.resetsRaw,
    resetsAt: row.resetsAt ? toIsoSeconds(row.resetsAt) : null,
  }));
}

export interface NextReset {
  provider: string;
  scope: string | null;
  window: string;
  windowSeconds: number | null;
  resetsAt: string | null;
  remainingPercent: number | null;
  usedPercent: number | null;
}

/** The latest known reset time for every window of every provider with data. */
export async function nextResets(db: PrismaClient): Promise<NextReset[]> {
  const snapshots = await latestSnapshots(db);
  return snapshots.flatMap((snapshot) =>
    snapshot.windows.map((window) => ({
      provider: snapshot.provider,
      scope: window.scope ?? null,
      window: window.window,
      windowSeconds: window.windowSeconds ?? null,
      resetsAt: window.resetsAt ?? null,
      remainingPercent: window.remainingPercent ?? null,
      usedPercent: window.usedPercent ?? null,
    })),
  );
}

function toSnapshot(sample: SampleWithWindows): UsageSnapshot {
  return {
    schemaVersion: 1,
    observedAt: toIsoSeconds(sample.observedAt),
    provider: sample.provider,
    ok: sample.ok,
    windows: sample.windows.map(toUsageWindow),
    ...(sample.resetCredits !== null ? { resetCredits: sample.resetCredits } : {}),
    ...(sample.error !== null ? { error: sample.error } : {}),
  };
}

function toUsageWindow(row: Window): UsageWindow {
  return {
    window: row.window,
    ...(row.scope !== null ? { scope: row.scope } : {}),
    ...(row.remainingPercent !== null ? { remainingPercent: row.remainingPercent } : {}),
    ...(row.usedPercent !== null ? { usedPercent: row.usedPercent } : {}),
    ...(row.resetsRaw !== null ? { resetsRaw: row.resetsRaw } : {}),
    ...(row.resetsAt !== null ? { resetsAt: toIsoSeconds(row.resetsAt) } : {}),
    ...(row.windowSeconds !== null ? { windowSeconds: row.windowSeconds } : {}),
  };
}
