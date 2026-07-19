/** Provider-neutral shapes shared across capture, storage, and API layers. */

/** One rate-limit / usage window a provider reports (e.g. "5h", "weekly"). */
export interface UsageWindow {
  /** Provider-reported sub-scope, e.g. a specific model. Absent when the
   * provider reports one number across all models. */
  scope?: string;
  /** Provider's own label for the window (free text; see window-kinds.ts). */
  window: string;
  remainingPercent?: number;
  usedPercent?: number;
  /** Raw provider text describing when the window resets, e.g. "4h 32m". */
  resetsRaw?: string;
  /** Resolved absolute reset time, when `resetsRaw` could be parsed. */
  resetsAt?: string;
  /** Window duration in seconds, when known (see window-kinds.ts). */
  windowSeconds?: number;
}

/** One observation of a provider's available capacity at a point in time. */
export interface UsageSnapshot {
  schemaVersion: 1;
  observedAt: string;
  provider: string;
  ok: boolean;
  windows: UsageWindow[];
  /** Manual reset credits/tickets some providers report (e.g. Codex). */
  resetCredits?: number;
  error?: string;
}

export function emptySnapshot(
  provider: string,
  observedAt: string,
  error: string,
): UsageSnapshot {
  return { schemaVersion: 1, observedAt, provider, ok: false, windows: [], error };
}

export function snapshotFromWindows(
  provider: string,
  observedAt: string,
  windows: UsageWindow[],
): UsageSnapshot {
  const ok = windows.length > 0;
  return {
    schemaVersion: 1,
    observedAt,
    provider,
    ok,
    windows,
    ...(ok ? {} : { error: "provider output contained no usage windows" }),
  };
}
