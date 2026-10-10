import type { CreditBalance, CreditGrant } from "../../domain/credit-balances.ts";
import { snapshotFromWindows, type UsageSnapshot, type UsageWindow } from "../../domain/types.ts";
import { isResetCreditCount } from "../../domain/reset-credits.ts";
import { registerWindowKind } from "../../domain/window-kinds.ts";
import { remainingWindow, usedWindow } from "../../domain/window-builder.ts";

const HEADING = /^\s*│?\s*([A-Za-z0-9 .-]+) limit:\s*│?\s*$/;
const LIMIT =
  /^\s*│?\s*(?:(.+?)\s+)?(5h|Weekly) limit:\s*\[[^\]]*\]\s*(\d+(?:\.\d+)?)% left \(resets ([^)]+)\)/;
const TICKETS = /You have (\d+) usage limit resets? available/;

/** Parses Codex app-server rate limits or a legacy `/status` TUI screen. */
export function parseCodexUsage(raw: string, observedAt: string): UsageSnapshot {
  const structured = parseStructuredRateLimits(raw, observedAt);
  if (structured) return structured;

  let scope = "default";
  const windows: UsageWindow[] = [];
  for (const line of raw.split("\n")) {
    const heading = HEADING.exec(line);
    if (heading) {
      scope = heading[1]!.trim();
      continue;
    }
    const limit = LIMIT.exec(line);
    if (limit) {
      const inlineScope = limit[1]?.trim();
      windows.push(
        remainingWindow({
          scope: inlineScope || scope,
          window: limit[2]!,
          remainingPercent: Number(limit[3]),
          resetsRaw: limit[4]!.trim(),
          observedAt,
        }),
      );
    }
  }
  const snapshot = snapshotFromWindows("codex", observedAt, windows);
  const tickets = TICKETS.exec(raw);
  const resetCredits = tickets ? Number(tickets[1]) : undefined;
  return isResetCreditCount(resetCredits) ? { ...snapshot, resetCredits } : snapshot;
}

type RateLimitWindow = {
  usedPercent?: unknown;
  windowDurationMins?: unknown;
  resetsAt?: unknown;
};

type RateLimitBucket = {
  limitId?: unknown;
  limitName?: unknown;
  planType?: unknown;
  primary?: RateLimitWindow | null;
  secondary?: RateLimitWindow | null;
  credits?: { hasCredits?: unknown; unlimited?: unknown; balance?: unknown } | null;
};

type RateLimitResetCredit = {
  id?: unknown;
  status?: unknown;
  expiresAt?: unknown;
};

type RateLimitResponse = {
  rateLimits?: RateLimitBucket | null;
  rateLimitsByLimitId?: Record<string, RateLimitBucket> | null;
  rateLimitResetCredits?: { availableCount?: unknown; credits?: RateLimitResetCredit[] | null } | null;
};

function parseStructuredRateLimits(raw: string, observedAt: string): UsageSnapshot | undefined {
  let response: RateLimitResponse;
  try {
    response = JSON.parse(raw) as RateLimitResponse;
  } catch {
    return undefined;
  }

  const entries = response.rateLimitsByLimitId && typeof response.rateLimitsByLimitId === "object"
    ? Object.entries(response.rateLimitsByLimitId)
    : response.rateLimits
      ? [[String(response.rateLimits.limitId ?? "codex"), response.rateLimits] as const]
      : [];
  const windows: UsageWindow[] = [];

  for (const [limitId, bucket] of entries) {
    const scope = typeof bucket.limitName === "string" && bucket.limitName
      ? bucket.limitName
      : limitId === "codex" ? "default" : limitId;
    const attributes = {
      limitId,
      ...(typeof bucket.planType === "string" ? { plan: bucket.planType } : {}),
    };
    for (const window of [bucket.primary, bucket.secondary]) {
      if (!window || typeof window.usedPercent !== "number" || typeof window.windowDurationMins !== "number") {
        continue;
      }
      const label = windowLabel(window.windowDurationMins);
      registerWindowKind(label, window.windowDurationMins * 60);
      windows.push(
        usedWindow({
          scope,
          window: label,
          usedPercent: window.usedPercent,
          observedAt,
          attributes,
          ...(typeof window.resetsAt === "number"
            ? { resetsAt: new Date(window.resetsAt * 1000).toISOString() }
            : {}),
        }),
      );
    }
  }

  const snapshot = snapshotFromWindows("codex", observedAt, windows);
  const resetCredits = response.rateLimitResetCredits?.availableCount;
  const creditBalances = creditBalancesFromResponse(entries, response.rateLimitResetCredits, resetCredits);
  const captured = snapshot.ok || creditBalances.length === 0
    ? snapshot
    : { schemaVersion: 1 as const, observedAt, provider: "codex", ok: true, windows };
  return {
    ...captured,
    ...(isResetCreditCount(resetCredits) ? { resetCredits } : {}),
    ...(creditBalances.length > 0 ? { creditBalances } : {}),
  };
}

function creditBalancesFromResponse(
  entries: readonly (readonly [string, RateLimitBucket])[],
  resetCredits: RateLimitResponse["rateLimitResetCredits"],
  availableCount: unknown,
): CreditBalance[] {
  const balances: CreditBalance[] = [];
  if (isResetCreditCount(availableCount)) {
    const grants = resetCredits?.credits === null
      ? undefined
      : resetCredits?.credits
        ?.flatMap(toAvailableResetGrant)
        .filter((grant): grant is CreditGrant => grant !== undefined);
    balances.push({
      id: "manual-reset-credits",
      kind: "manual_reset",
      label: "Manual resets",
      unit: "reset",
      remaining: availableCount,
      expiry: { kind: "unknown" },
      ...(grants !== undefined ? { grants } : {}),
    });
  }
  for (const [limitId, bucket] of entries) {
    const credits = bucket.credits;
    if (!credits) continue;
    if (credits.unlimited === true) {
      balances.push({
        id: `limit-credits:${limitId}`,
        kind: "credit",
        label: `${limitId} credits`,
        unit: "Credits",
        unlimited: true,
        expiry: { kind: "unknown" },
      });
      continue;
    }
    const remaining = numericBalance(credits.balance);
    if (remaining === undefined) continue;
    balances.push({
      id: `limit-credits:${limitId}`,
      kind: "credit",
      label: `${limitId} credits`,
      unit: "Credits",
      remaining,
      expiry: { kind: "unknown" },
    });
  }
  return balances;
}

function toAvailableResetGrant(credit: RateLimitResetCredit): CreditGrant | undefined {
  if (credit.status !== "available" || typeof credit.id !== "string" || !credit.id) return undefined;
  return {
    remaining: 1,
    expiry: expiryFromUnixSeconds(credit.expiresAt),
  };
}

function expiryFromUnixSeconds(value: unknown): CreditGrant["expiry"] {
  if (value === null) return { kind: "never" };
  if (typeof value !== "number" || !Number.isFinite(value)) return { kind: "unknown" };
  const timestamp = new Date(value * 1_000);
  return Number.isNaN(timestamp.getTime()) ? { kind: "unknown" } : { kind: "at", at: timestamp.toISOString() };
}

function numericBalance(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function windowLabel(minutes: number): string {
  if (minutes === 5 * 60) return "5h";
  if (minutes === 7 * 24 * 60) return "Weekly";
  if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}
