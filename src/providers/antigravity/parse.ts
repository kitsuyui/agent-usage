import { snapshotFromWindows, type UsageSnapshot, type UsageWindow } from "../../domain/types.ts";
import { remainingWindow } from "../../domain/window-builder.ts";

const SCOPE = /^[A-Z][A-Z ]+MODELS$/;
const WINDOW = /^(Weekly|Daily|Monthly|5h)\s+Limit/;
const PERCENT = /\]\s*([0-9.]+)%\s*$/;
const RESETS = /Refreshes in ([^·]+?)\s*$/;

/** Parses `agy`'s `/usage` TUI screen into a provider-neutral snapshot. */
export function parseAntigravityUsage(raw: string, observedAt: string): UsageSnapshot {
  let scope: string | undefined;
  let windowLabel = "Weekly";
  const windows: UsageWindow[] = [];
  for (const rawLine of raw.split("\n")) {
    const line = rawLine.trim();
    const scopeMatch = SCOPE.exec(line);
    if (scopeMatch) {
      scope = line;
      continue;
    }
    const windowMatch = WINDOW.exec(line);
    if (windowMatch) {
      windowLabel = windowMatch[1]!;
      continue;
    }
    const percentMatch = PERCENT.exec(line);
    if (percentMatch && scope) {
      windows.push(
        remainingWindow({
          scope,
          window: windowLabel,
          remainingPercent: Number(percentMatch[1]),
          observedAt,
        }),
      );
      continue;
    }
    const resetsMatch = RESETS.exec(line);
    const lastIndex = windows.length - 1;
    const last = windows[lastIndex];
    if (resetsMatch && last) {
      windows[lastIndex] = remainingWindow({
        window: last.window,
        remainingPercent: last.remainingPercent ?? 0,
        resetsRaw: resetsMatch[1]!.trim(),
        observedAt,
        ...(last.scope !== undefined ? { scope: last.scope } : {}),
      });
    }
  }
  return snapshotFromWindows("antigravity", observedAt, windows);
}
