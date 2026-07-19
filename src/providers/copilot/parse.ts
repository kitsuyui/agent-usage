import { snapshotFromWindows, type UsageSnapshot, type UsageWindow } from "../../domain/types.ts";
import { nextUtcMonthStart } from "../../domain/reset-time.ts";
import { usedWindow } from "../../domain/window-builder.ts";

const PLAN_PERCENT = /Plan[^\n]*?(\d+(?:\.\d+)?)% used/;

/**
 * Parses `copilot`'s `/usage` TUI screen into a provider-neutral snapshot.
 *
 * Unlike the other providers, this screen never shows a reset time —
 * GitHub's docs state the included AI-credit allowance always resets at
 * 00:00:00 UTC on the 1st of the month regardless of subscription date, so
 * that's computed directly rather than scraped (see `nextUtcMonthStart`).
 */
export function parseCopilotUsage(raw: string, observedAt: string): UsageSnapshot {
  const match = PLAN_PERCENT.exec(raw);
  const windows: UsageWindow[] = [];
  if (match) {
    windows.push(
      usedWindow({
        window: "monthly",
        usedPercent: Number(match[1]),
        observedAt,
        resetsAt: nextUtcMonthStart(observedAt),
      }),
    );
  }
  return snapshotFromWindows("copilot", observedAt, windows);
}
