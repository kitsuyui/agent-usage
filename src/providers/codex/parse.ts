import { snapshotFromWindows, type UsageSnapshot, type UsageWindow } from "../../domain/types.ts";
import { remainingWindow } from "../../domain/window-builder.ts";

const HEADING = /^\s*│?\s*([A-Za-z0-9 .-]+) limit:\s*│?\s*$/;
const LIMIT = /(5h|Weekly) limit:\s*\[[^\]]*\]\s*(\d+)% left \(resets ([^)]+)\)/;
const TICKETS = /You have (\d+) usage limit resets available/;

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
      windows.push(
        remainingWindow({
          scope,
          window: limit[1]!,
          remainingPercent: Number(limit[2]),
          resetsRaw: limit[3]!.trim(),
          observedAt,
        }),
      );
    }
  }
  const snapshot = snapshotFromWindows("codex", observedAt, windows);
  const tickets = TICKETS.exec(raw);
  return tickets ? { ...snapshot, resetCredits: Number(tickets[1]) } : snapshot;
}
