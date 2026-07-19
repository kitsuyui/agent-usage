/**
 * Maps a provider's free-text window label to a duration in seconds.
 *
 * Kept as a mutable registry (not an enum) so a new provider's window shape
 * never requires touching this file's callers — see `registerWindowKind`.
 */

const durationsBySeconds: Record<string, number> = {
  "5h": 5 * 60 * 60,
  session: 5 * 60 * 60,
  daily: 24 * 60 * 60,
  day: 24 * 60 * 60,
  weekly: 7 * 24 * 60 * 60,
  week: 7 * 24 * 60 * 60,
  monthly: 30 * 24 * 60 * 60,
  month: 30 * 24 * 60 * 60,
};

/** Registers (or overrides) a window label's duration, e.g. for a new provider. */
export function registerWindowKind(label: string, seconds: number): void {
  durationsBySeconds[label.toLowerCase()] = seconds;
}

/** Resolves a provider's window label to a duration in seconds, if known. */
export function windowSeconds(label: string): number | undefined {
  return durationsBySeconds[label.toLowerCase()];
}
