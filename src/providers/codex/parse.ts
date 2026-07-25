import { snapshotFromWindows, type UsageSnapshot, type UsageWindow } from "../../domain/types.ts";
import { remainingWindow } from "../../domain/window-builder.ts";

const HEADING = /^\s*│?\s*([A-Za-z0-9 .-]+) limit:\s*│?\s*$/;
const LIMIT =
  /^\s*│?\s*(?:(.+?)\s+)?(5h|Weekly) limit:\s*\[[^\]]*\]\s*(\d+(?:\.\d+)?)% left \(resets ([^)]+)\)/;
const TICKETS = /You have (\d+) usage limit resets? available/;

/** Parses `codex`'s `/status` TUI screen into a provider-neutral snapshot. */
export function parseCodexUsage(raw: string, observedAt: string): UsageSnapshot {
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
  return tickets ? { ...snapshot, resetCredits: Number(tickets[1]) } : snapshot;
}
