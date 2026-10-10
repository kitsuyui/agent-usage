export interface CollectorResetStatus {
  latestOk: boolean | null;
  stale: boolean;
  resetCredits: number | null;
}

/** A current count is only meaningful when the most recent collection succeeded. */
export function manualResetsLabel(provider: CollectorResetStatus): string {
  if (provider.latestOk !== true) return "Unavailable";
  if (provider.resetCredits === null) return "Not reported";
  return `${provider.resetCredits} available${provider.stale ? " (stale)" : ""}`;
}
