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

/** Keeps the API request bounded by the range selected in the dashboard. */
export function historyQueryRange(selected: HistoryRange): string {
  return selected;
}

export function historyRangeLabel(selected: HistoryRange): string {
  return HISTORY_RANGES[selected].label;
}
