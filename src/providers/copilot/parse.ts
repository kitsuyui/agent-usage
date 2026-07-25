import { snapshotFromWindows, type UsageSnapshot, type UsageWindow } from "../../domain/types.ts";
import { nextUtcMonthStart } from "../../domain/reset-time.ts";
import { measuredWindow, usedWindow } from "../../domain/window-builder.ts";

const PLAN_PERCENT = /Plan[^\n]*?(\d+(?:\.\d+)?)% used/;
const AI_CREDITS = /(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s+AIC/;

/**
 * Parses `copilot`'s `/usage` TUI screen into a provider-neutral snapshot.
 *
 * Unlike the other providers, this screen never shows a reset time —
 * GitHub's docs state the included AI-credit allowance always resets at
 * 00:00:00 UTC on the 1st of the month regardless of subscription date, so
 * that's computed directly rather than scraped (see `nextUtcMonthStart`).
 */
export function parseCopilotUsage(raw: string, observedAt: string): UsageSnapshot {
  const percentMatch = PLAN_PERCENT.exec(raw);
  const creditMatch = AI_CREDITS.exec(raw);
  const windows: UsageWindow[] = [];
  const resetsAt = nextUtcMonthStart(observedAt);
  if (percentMatch) {
    windows.push(
      usedWindow({
        window: "monthly",
        usedPercent: Number(percentMatch[1]),
        observedAt,
        resetsAt,
      }),
    );
  }
  if (creditMatch) {
    const usedValue = Number(creditMatch[1]);
    const limitValue = Number(creditMatch[2]);
    windows.push(
      measuredWindow({
        window: "monthly",
        metric: "credits",
        unit: "AIC",
        usedValue,
        limitValue,
        remainingValue: Math.max(0, limitValue - usedValue),
        observedAt,
        resetsAt,
      }),
    );
  }
  return snapshotFromWindows("copilot", observedAt, windows);
}
