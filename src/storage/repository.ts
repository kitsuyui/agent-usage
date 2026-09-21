import type { PrismaClient, Sample, Window } from "@prisma/client";
import type { UsageSnapshot, UsageWindow } from "../domain/types.ts";
import { toIsoSeconds } from "../domain/time.ts";

type SampleWithWindows = Sample & { windows: Window[] };
type WindowWithSample = Window & { sample: Pick<Sample, "cliVersion"> };

/** Persists one snapshot (and its windows) as a new sample row. */
export async function recordSnapshot(db: PrismaClient, snapshot: UsageSnapshot): Promise<void> {
  const observedAt = new Date(snapshot.observedAt);
  await db.sample.create({
    data: {
      provider: snapshot.provider,
      observedAt,
      ok: snapshot.ok,
      error: snapshot.error ?? null,
      errorCode: snapshot.errorCode ?? null,
      cliVersion: snapshot.cliVersion ?? null,
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
          metric: window.metric ?? "quota",
          unit:
            window.unit ??
            (window.remainingPercent !== undefined || window.usedPercent !== undefined ? "percent" : null),
          value: window.value ?? null,
          limitValue: window.limitValue ?? null,
          remainingValue: window.remainingValue ?? null,
          usedValue: window.usedValue ?? null,
          attributesJson: window.attributes ? canonicalAttributes(window.attributes) : null,
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

export type ProviderHealthStatus = "healthy" | "failing" | "stale" | "no_data";

export interface ProviderHealth {
  provider: string;
  status: ProviderHealthStatus;
  latestOk: boolean | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  consecutiveFailures: number;
  stale: boolean;
  errorCode: string | null;
  error: string | null;
  cliVersion: string | null;
}

/** Capture health for one provider, including failures that produced no windows. */
export async function providerHealth(
  db: PrismaClient,
  provider: string,
  staleAfterSeconds = 3_600,
): Promise<ProviderHealth> {
  const [latest, lastSuccess] = await Promise.all([
    db.sample.findFirst({ where: { provider }, orderBy: { observedAt: "desc" } }),
    db.sample.findFirst({ where: { provider, ok: true }, orderBy: { observedAt: "desc" } }),
  ]);
  const consecutiveFailures =
    latest && !latest.ok
      ? await db.sample.count({
          where: {
            provider,
            ok: false,
            ...(lastSuccess ? { observedAt: { gt: lastSuccess.observedAt } } : {}),
          },
        })
      : 0;
  const stale =
    latest !== null &&
    Date.now() - latest.observedAt.getTime() > staleAfterSeconds * 1_000;
  return {
    provider,
    status: latest ? (latest.ok ? (stale ? "stale" : "healthy") : "failing") : "no_data",
    latestOk: latest?.ok ?? null,
    lastAttemptAt: latest ? toIsoSeconds(latest.observedAt) : null,
    lastSuccessAt: lastSuccess ? toIsoSeconds(lastSuccess.observedAt) : null,
    consecutiveFailures,
    stale,
    errorCode: latest?.errorCode ?? null,
    error: latest?.error ?? null,
    cliVersion: latest?.cliVersion ?? null,
  };
}

export interface HistoryQuery {
  provider?: string;
  scope?: string;
  window?: string;
  metric?: string;
  unit?: string;
  since?: string;
  until?: string;
  limit?: number;
}

export interface HistoryPoint {
  provider: string;
  seriesId: string;
  scope: string | null;
  window: string;
  windowSeconds: number | null;
  metric: string;
  unit: string | null;
  value: number | null;
  limitValue: number | null;
  remainingValue: number | null;
  usedValue: number | null;
  attributes: Record<string, string>;
  cliVersion: string | null;
  observedAt: string;
  remainingPercent: number | null;
  usedPercent: number | null;
  resetsRaw: string | null;
  resetsAt: string | null;
}

export interface ChartSeries {
  seriesId: string;
  provider: string;
  scope: string | null;
  window: string;
  windowSeconds: number | null;
  metric: string;
  unit: string | null;
  attributes: Record<string, string>;
  scale: "remaining-percent" | "value";
  points: [timestampMs: number, value: number][];
}

/** A flattened, chart-ready time series of window observations. */
export async function queryHistory(db: PrismaClient, query: HistoryQuery = {}): Promise<HistoryPoint[]> {
  const rows = await db.window.findMany({
    where: {
      ...(query.provider ? { provider: query.provider } : {}),
      ...(query.scope ? { scope: query.scope } : {}),
      ...(query.window ? { window: query.window } : {}),
      ...(query.metric ? { metric: query.metric } : {}),
      ...(query.unit ? { unit: query.unit } : {}),
      ...(query.since || query.until
        ? {
            observedAt: {
              ...(query.since ? { gte: new Date(query.since) } : {}),
              ...(query.until ? { lte: new Date(query.until) } : {}),
            },
          }
        : {}),
    },
    orderBy: { observedAt: "desc" },
    take: Math.min(query.limit ?? 2000, 100_000),
    include: { sample: { select: { cliVersion: true } } },
  });
  return rows.reverse().map(toHistoryPoint);
}

export interface NextReset {
  provider: string;
  seriesId: string;
  scope: string | null;
  window: string;
  windowSeconds: number | null;
  metric: string;
  unit: string | null;
  value: number | null;
  limitValue: number | null;
  remainingValue: number | null;
  usedValue: number | null;
  attributes: Record<string, string>;
  cliVersion: string | null;
  resetsAt: string | null;
  previousResetAt: string | null;
  cyclePace: CyclePace | null;
  remainingPercent: number | null;
  usedPercent: number | null;
}

export interface CyclePace {
  firstObservedAt: string;
  firstRemainingPercent: number;
  latestObservedAt: string;
  latestRemainingPercent: number;
}

/** The latest reset time and, when observed, its preceding reset boundary. */
export async function nextResets(db: PrismaClient): Promise<NextReset[]> {
  const snapshots = await latestSnapshots(db);
  return Promise.all(
    snapshots.flatMap((snapshot) =>
      snapshot.windows.map(async (window) => {
        const identity = resetIdentity(snapshot, window);
        const previous = await previousResetAt(db, identity, window.resetsAt, snapshot.observedAt);
        return {
          ...identity,
          seriesId: seriesId(identity),
          value: window.value ?? null,
          limitValue: window.limitValue ?? null,
          remainingValue: window.remainingValue ?? null,
          usedValue: window.usedValue ?? null,
          cliVersion: snapshot.cliVersion ?? null,
          resetsAt: window.resetsAt ?? null,
          previousResetAt: previous,
          cyclePace: await currentCyclePace(
            db,
            identity,
            previous,
            window.resetsAt,
            snapshot.observedAt,
            remainingPercentOf(window),
          ),
          remainingPercent: window.remainingPercent ?? null,
          usedPercent: window.usedPercent ?? null,
        };
      }),
    ),
  );
}

function resetIdentity(
  snapshot: UsageSnapshot,
  window: UsageWindow,
): {
  provider: string;
  scope: string | null;
  window: string;
  windowSeconds: number | null;
  metric: string;
  unit: string | null;
  attributes: Record<string, string>;
} {
  return {
    provider: snapshot.provider,
    scope: window.scope ?? null,
    window: window.window,
    windowSeconds: window.windowSeconds ?? null,
    metric: window.metric ?? "quota",
    unit: window.unit ?? null,
    attributes: window.attributes ?? {},
  };
}

function resetIdentityWhere(identity: ReturnType<typeof resetIdentity>) {
  const attributes = Object.keys(identity.attributes).length > 0
    ? { attributesJson: canonicalAttributes(identity.attributes) }
    : { OR: [{ attributesJson: null }, { attributesJson: "{}" }] };
  return {
    provider: identity.provider,
    scope: identity.scope,
    window: identity.window,
    windowSeconds: identity.windowSeconds,
    metric: identity.metric,
    unit: identity.unit,
    ...attributes,
  };
}

async function previousResetAt(
  db: PrismaClient,
  identity: ReturnType<typeof resetIdentity>,
  currentResetAt: string | undefined,
  latestObservedAt: string,
): Promise<string | null> {
  if (!currentResetAt) return null;
  const currentTime = Date.parse(currentResetAt);
  const observedTime = Date.parse(latestObservedAt);
  if (!Number.isFinite(currentTime) || !Number.isFinite(observedTime) || currentTime <= observedTime) return null;

  const row = await db.window.findFirst({
    where: {
      ...resetIdentityWhere(identity),
      resetsAt: { lte: new Date(observedTime) },
    },
    orderBy: { resetsAt: "desc" },
    select: { resetsAt: true },
  });
  return row?.resetsAt ? toIsoSeconds(row.resetsAt) : null;
}

async function currentCyclePace(
  db: PrismaClient,
  identity: ReturnType<typeof resetIdentity>,
  previousResetAt: string | null,
  currentResetAt: string | undefined,
  latestObservedAt: string,
  latestRemainingPercent: number | null,
): Promise<CyclePace | null> {
  if (!previousResetAt || !currentResetAt || latestRemainingPercent === null) return null;
  const cycleStart = Date.parse(previousResetAt);
  const currentReset = Date.parse(currentResetAt);
  const latest = Date.parse(latestObservedAt);
  if (
    !Number.isFinite(cycleStart) ||
    !Number.isFinite(currentReset) ||
    !Number.isFinite(latest) ||
    cycleStart >= latest ||
    currentReset <= latest
  ) {
    return null;
  }

  const first = await db.window.findFirst({
    where: {
      ...resetIdentityWhere(identity),
      observedAt: { gte: new Date(cycleStart), lte: new Date(latest) },
      resetsAt: { gt: new Date(cycleStart) },
    },
    orderBy: { observedAt: "asc" },
    select: { observedAt: true, remainingPercent: true, usedPercent: true },
  });
  const firstRemainingPercent = first ? remainingPercentOf(first) : null;
  if (
    !first ||
    firstRemainingPercent === null ||
    first.observedAt.getTime() >= latest ||
    !Number.isFinite(firstRemainingPercent) ||
    !Number.isFinite(latestRemainingPercent)
  ) {
    return null;
  }
  return {
    firstObservedAt: toIsoSeconds(first.observedAt),
    firstRemainingPercent,
    latestObservedAt,
    latestRemainingPercent,
  };
}

function remainingPercentOf(window: {
  remainingPercent?: number | null;
  usedPercent?: number | null;
}): number | null {
  if (window.remainingPercent !== null && window.remainingPercent !== undefined) return window.remainingPercent;
  if (window.usedPercent !== null && window.usedPercent !== undefined) return 100 - window.usedPercent;
  return null;
}

function toSnapshot(sample: SampleWithWindows): UsageSnapshot {
  return {
    schemaVersion: 1,
    observedAt: toIsoSeconds(sample.observedAt),
    provider: sample.provider,
    ok: sample.ok,
    windows: sample.windows.map(toUsageWindow),
    ...(sample.resetCredits !== null ? { resetCredits: sample.resetCredits } : {}),
    ...(sample.cliVersion !== null ? { cliVersion: sample.cliVersion } : {}),
    ...(sample.errorCode !== null ? { errorCode: sample.errorCode } : {}),
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
    metric: row.metric,
    ...(row.unit !== null ? { unit: row.unit } : {}),
    ...(row.value !== null ? { value: row.value } : {}),
    ...(row.limitValue !== null ? { limitValue: row.limitValue } : {}),
    ...(row.remainingValue !== null ? { remainingValue: row.remainingValue } : {}),
    ...(row.usedValue !== null ? { usedValue: row.usedValue } : {}),
    ...attributesFromJson(row.attributesJson),
  };
}

/** Keeps at most `maxPoints` observations per logical series while retaining
 * endpoints and local extrema. The result remains chronological. */
export function downsampleHistory(points: HistoryPoint[], maxPoints: number): HistoryPoint[] {
  if (maxPoints < 3) throw new Error("maxPoints must be at least 3");
  const grouped = new Map<string, HistoryPoint[]>();
  for (const point of points) {
    const series = grouped.get(point.seriesId);
    if (series) series.push(point);
    else grouped.set(point.seriesId, [point]);
  }
  return [...grouped.values()]
    .flatMap((series) => downsampleSeries(series, maxPoints))
    .sort((a, b) => a.observedAt.localeCompare(b.observedAt));
}

/** Groups chart-ready history without repeating series metadata for every point. */
export function chartSeriesFromHistory(points: HistoryPoint[]): ChartSeries[] {
  const grouped = new Map<string, ChartSeries>();
  for (const point of points) {
    const value = measurementValue(point);
    if (value === null) continue;
    const existing = grouped.get(point.seriesId);
    if (existing) {
      existing.points.push([new Date(point.observedAt).getTime(), value]);
      continue;
    }
    grouped.set(point.seriesId, {
      seriesId: point.seriesId,
      provider: point.provider,
      scope: point.scope,
      window: point.window,
      windowSeconds: point.windowSeconds,
      metric: point.metric,
      unit: point.unit,
      attributes: point.attributes,
      scale:
        point.remainingPercent !== null || point.usedPercent !== null
          ? "remaining-percent"
          : "value",
      points: [[new Date(point.observedAt).getTime(), value]],
    });
  }
  return [...grouped.values()];
}

function downsampleSeries(points: HistoryPoint[], maxPoints: number): HistoryPoint[] {
  if (points.length <= maxPoints) return points;
  const first = points[0]!;
  const last = points.at(-1)!;
  const interior = points.slice(1, -1);
  const bucketCount = Math.max(1, Math.floor((maxPoints - 2) / 2));
  const selected: HistoryPoint[] = [first];
  for (let bucket = 0; bucket < bucketCount; bucket += 1) {
    const start = Math.floor((bucket * interior.length) / bucketCount);
    const end = Math.floor(((bucket + 1) * interior.length) / bucketCount);
    const slice = interior.slice(start, Math.max(start + 1, end));
    const extrema = [...slice]
      .sort((a, b) => numericValue(a) - numericValue(b))
      .filter((point, index, all) => index === 0 || point !== all.at(-1))
      .slice(0, 1)
      .concat(slice.reduce((max, point) => (numericValue(point) > numericValue(max) ? point : max), slice[0]!))
      .sort((a, b) => a.observedAt.localeCompare(b.observedAt));
    for (const point of extrema) {
      if (selected.length < maxPoints - 1 && !selected.includes(point)) selected.push(point);
    }
  }
  selected.push(last);
  return selected.sort((a, b) => a.observedAt.localeCompare(b.observedAt));
}

function numericValue(point: HistoryPoint): number {
  return measurementValue(point) ?? 0;
}

function measurementValue(point: HistoryPoint): number | null {
  if (point.remainingPercent !== null) return point.remainingPercent;
  if (point.usedPercent !== null) return 100 - point.usedPercent;
  if (point.value !== null) return point.value;
  if (point.remainingValue !== null) return point.remainingValue;
  if (point.limitValue !== null && point.usedValue !== null) return point.limitValue - point.usedValue;
  if (point.usedValue !== null) return point.usedValue;
  return point.limitValue;
}

function toHistoryPoint(row: WindowWithSample): HistoryPoint {
  const attributes = parseAttributes(row.attributesJson);
  const identity = {
    provider: row.provider,
    scope: row.scope,
    window: row.window,
    windowSeconds: row.windowSeconds,
    metric: row.metric,
    unit: row.unit,
    attributes,
  };
  return {
    ...identity,
    seriesId: seriesId(identity),
    cliVersion: row.sample.cliVersion,
    observedAt: toIsoSeconds(row.observedAt),
    remainingPercent: row.remainingPercent,
    usedPercent: row.usedPercent,
    value: row.value,
    limitValue: row.limitValue,
    remainingValue: row.remainingValue,
    usedValue: row.usedValue,
    resetsRaw: row.resetsRaw,
    resetsAt: row.resetsAt ? toIsoSeconds(row.resetsAt) : null,
  };
}

function seriesId(identity: {
  provider: string;
  scope: string | null;
  window: string;
  windowSeconds: number | null;
  metric: string;
  unit: string | null;
  attributes: Record<string, string>;
}): string {
  return JSON.stringify([
    identity.provider,
    identity.scope ?? "",
    identity.window.trim().toLowerCase(),
    identity.windowSeconds,
    identity.metric.trim().toLowerCase(),
    identity.unit?.trim().toLowerCase() ?? "",
    Object.entries(identity.attributes).sort(([left], [right]) => left.localeCompare(right)),
  ]);
}

function canonicalAttributes(attributes: Record<string, string>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(attributes).sort(([left], [right]) => left.localeCompare(right))));
}

function parseAttributes(value: string | null): Record<string, string> {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  } catch {
    return {};
  }
}

function attributesFromJson(value: string | null): Pick<UsageWindow, "attributes"> {
  const attributes = parseAttributes(value);
  return Object.keys(attributes).length > 0 ? { attributes } : {};
}
