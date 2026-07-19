import { snapshotFromWindows, type UsageSnapshot, type UsageWindow } from "../../domain/types.ts";
import { usedWindow } from "../../domain/window-builder.ts";

const HEADING = /Current (session|week)(?:\s*\(([^)]+)\))?/;
const PERCENT = /(\d+)% used/;
const RESETS = /Resets ([^·]+?)\s*$/;

interface Pending {
  window: string;
  scope?: string;
  value: number;
}

/** Parses `claude`'s `/usage` TUI screen into a provider-neutral snapshot. */
export function parseClaudeUsage(raw: string, observedAt: string): UsageSnapshot {
  let current: Pending | undefined;
  const windows: UsageWindow[] = [];
  for (const line of raw.split("\n")) {
    const heading = HEADING.exec(line);
    if (heading) {
      pushCurrent(windows, current, undefined, observedAt);
      const scope = heading[2];
      current = {
        window: heading[1]!,
        value: -1,
        ...(scope && scope !== "all models" ? { scope } : {}),
      };
      continue;
    }
    const percent = PERCENT.exec(line);
    if (percent && current) {
      current.value = Number(percent[1]);
      continue;
    }
    const resets = RESETS.exec(line);
    if (resets) {
      pushCurrent(windows, current, resets[1]!.trim(), observedAt);
      current = undefined;
    }
  }
  pushCurrent(windows, current, undefined, observedAt);
  return snapshotFromWindows("claude", observedAt, windows);
}

function pushCurrent(
  windows: UsageWindow[],
  current: Pending | undefined,
  resetsRaw: string | undefined,
  observedAt: string,
): void {
  if (!current || current.value < 0) return;
  windows.push(
    usedWindow({
      window: current.window,
      usedPercent: current.value,
      observedAt,
      ...(current.scope !== undefined ? { scope: current.scope } : {}),
      ...(resetsRaw !== undefined ? { resetsRaw } : {}),
    }),
  );
}
