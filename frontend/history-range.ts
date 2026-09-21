export const HISTORY_RANGES = {
  "15h": { label: "15 hours", seconds: 15 * 60 * 60 },
  "21d": { label: "21 days", seconds: 21 * 24 * 60 * 60 },
  "90d": { label: "90 days", seconds: 90 * 24 * 60 * 60 },
} as const;

export type HistoryRange = keyof typeof HISTORY_RANGES;

const LEGACY_HISTORY_RANGES: Record<string, HistoryRange> = {
  "10h": "15h",
  "14d": "21d",
  "30d": "90d",
};

/** Keeps old dashboard links useful while making the cycle-based views canonical. */
export function normalizeHistoryRange(value: string | null): HistoryRange | null {
  if (!value) return null;
  if (value in HISTORY_RANGES) return value as HistoryRange;
  return LEGACY_HISTORY_RANGES[value] ?? null;
}

/**
 * Fetch enough history for the largest current cycle as well as the chosen
 * view. A weekly chart must retain its two-cycle context even when the user
 * has selected the short session view.
 */
export function historyQueryRange(selected: HistoryRange, longestCycleSeconds: number | null): string {
  const minimumSeconds = longestCycleSeconds && longestCycleSeconds > 0 ? longestCycleSeconds * 3 : 0;
  const seconds = Math.max(HISTORY_RANGES[selected].seconds, minimumSeconds);
  if (seconds % (24 * 60 * 60) === 0) return `${seconds / (24 * 60 * 60)}d`;
  return `${seconds / (60 * 60)}h`;
}

export function cycleViewLabel(cycleSeconds: number | null): string {
  if (!cycleSeconds || cycleSeconds <= 0) return "Observed history";
  const seconds = cycleSeconds * 3;
  return seconds % (24 * 60 * 60) === 0
    ? `Three cycles (${seconds / (24 * 60 * 60)} days)`
    : `Three cycles (${seconds / (60 * 60)} hours)`;
}
