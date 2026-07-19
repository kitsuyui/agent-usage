/**
 * Resolves the free-text "resets" strings agent CLIs print (e.g. "4h 32m",
 * "Resets 9pm", "Jul 21 at 3pm") into an absolute ISO-8601 UTC timestamp.
 *
 * Providers report these relative to the wall-clock time the CLI was run in,
 * so parsing has to happen in local time (matching how a human reads "9pm")
 * before converting to UTC for storage.
 */

import { toIsoSeconds } from "./time.ts";

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

const TRAILING_PAREN = /\s*\([^)]*\)\s*$/;
const AFTER = /^(\d+)h\s*(\d+)m$/;
const DATED = /^(\d{1,2}):(\d{2}) on (\d{1,2}) ([A-Z][a-z]{2})$/;
const CLOCK = /^(\d{1,2}):(\d{2})$/;
const SHORT_CLOCK = /^(\d{1,2})(?::(\d{2}))?(am|pm)$/i;
const NAMED_DATE =
  /^([A-Z][a-z]{2})\s+(\d{1,2})(?:,\s*(\d{4}))?(?:\s+at\s+(\d{1,2})(?::(\d{2}))?(am|pm))?$/;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The next 00:00:00 UTC on the 1st of a calendar month, strictly after
 * `observedAtIso`. Use for providers with a fixed (not scraped) reset rule —
 * e.g. GitHub Copilot's included AI credits, which GitHub's docs state reset
 * "at 00:00:00 UTC on the first day of each calendar month" regardless of
 * subscription billing date: https://docs.github.com/en/copilot/concepts/billing/usage-based-billing-for-individuals
 */
export function nextUtcMonthStart(observedAtIso: string): string {
  const observed = new Date(observedAtIso);
  const next = new Date(Date.UTC(observed.getUTCFullYear(), observed.getUTCMonth() + 1, 1, 0, 0, 0));
  return toIsoSeconds(next);
}

/** Resolves a provider's raw "resets" text to an ISO-8601 UTC timestamp. */
export function resolveResetAt(raw: string, observedAtIso: string): string | undefined {
  const observed = new Date(observedAtIso);
  if (Number.isNaN(observed.getTime())) return undefined;
  const value = raw.trim().replace(TRAILING_PAREN, "").trim();
  return (
    resetAfter(value, observed) ??
    resetDated(value, observed) ??
    resetClock(value, observed) ??
    resetShortClock(value, observed) ??
    resetNamedDate(value, observed)
  );
}

function resetAfter(value: string, observed: Date): string | undefined {
  const match = AFTER.exec(value);
  if (!match) return undefined;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return toIso(new Date(observed.getTime() + hours * 3_600_000 + minutes * 60_000));
}

function resetDated(value: string, observed: Date): string | undefined {
  const match = DATED.exec(value);
  if (!match) return undefined;
  const month = monthNumber(match[4]!);
  if (month === undefined) return undefined;
  let result = localDate(observed.getFullYear(), month, Number(match[3]), Number(match[1]), Number(match[2]));
  if (result < new Date(observed.getTime() - DAY_MS)) {
    result = localDate(observed.getFullYear() + 1, month, Number(match[3]), Number(match[1]), Number(match[2]));
  }
  return toIso(result);
}

function resetClock(value: string, observed: Date): string | undefined {
  const match = CLOCK.exec(value);
  if (!match) return undefined;
  let result = localDate(
    observed.getFullYear(),
    observed.getMonth() + 1,
    observed.getDate(),
    Number(match[1]),
    Number(match[2]),
  );
  if (result <= observed) result = new Date(result.getTime() + DAY_MS);
  return toIso(result);
}

function resetShortClock(value: string, observed: Date): string | undefined {
  const match = SHORT_CLOCK.exec(value);
  if (!match) return undefined;
  const hour = hour24(Number(match[1]), match[3]!);
  const minute = match[2] ? Number(match[2]) : 0;
  let result = localDate(observed.getFullYear(), observed.getMonth() + 1, observed.getDate(), hour, minute);
  if (result <= observed) result = new Date(result.getTime() + DAY_MS);
  return toIso(result);
}

function resetNamedDate(value: string, observed: Date): string | undefined {
  const match = NAMED_DATE.exec(value);
  if (!match) return undefined;
  const month = monthNumber(match[1]!);
  if (month === undefined) return undefined;
  const day = Number(match[2]);
  const explicitYear = match[3] ? Number(match[3]) : undefined;
  const year = explicitYear ?? observed.getFullYear();
  const hour = match[4] ? hour24(Number(match[4]), match[6] ?? "am") : 0;
  const minute = match[5] ? Number(match[5]) : 0;
  let result = localDate(year, month, day, hour, minute);
  if (explicitYear === undefined && result < new Date(observed.getTime() - DAY_MS)) {
    result = localDate(year + 1, result.getMonth() + 1, result.getDate(), result.getHours(), result.getMinutes());
  }
  return toIso(result);
}

function hour24(hour12: number, suffix: string): number {
  return (hour12 % 12) + (suffix.toLowerCase() === "pm" ? 12 : 0);
}

function monthNumber(name: string): number | undefined {
  const index = MONTHS.indexOf(name);
  return index === -1 ? undefined : index + 1;
}

// Note: unlike the Rust reference this ports, this treats an overflowing
// calendar date (e.g. day 31 in a 30-day month) as rolling into the next
// month rather than rejecting the parse — providers only ever emit valid
// calendar dates, so this only affects malformed input.
function localDate(year: number, month1based: number, day: number, hour: number, minute: number): Date {
  return new Date(year, month1based - 1, day, hour, minute, 0, 0);
}

const toIso = toIsoSeconds;
