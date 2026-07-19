import { captureTui } from "./tmux.ts";
import { emptySnapshot, type UsageSnapshot } from "../domain/types.ts";
import { toIsoSeconds } from "../domain/time.ts";
import type { UsageProvider } from "../providers/types.ts";

/** Captures and parses one usage snapshot for a single provider. */
export async function collectSnapshot(provider: UsageProvider): Promise<UsageSnapshot> {
  const observedAt = toIsoSeconds(new Date());
  let raw = "";
  try {
    raw = await captureTui(provider.id, provider.tui);
    const snapshot = provider.parse(raw, observedAt);
    if (!snapshot.ok) logFailure(provider.id, raw);
    return snapshot;
  } catch (error) {
    logFailure(provider.id, raw);
    return emptySnapshot(provider.id, observedAt, error instanceof Error ? error.message : String(error));
  }
}

// Diagnostic-only: the captured pane is UI chrome (window labels, percentages,
// prompts), not a secret, and this is exactly what you need to see to tell a
// stuck trust/update prompt apart from a genuinely unrecognized screen.
function logFailure(providerId: string, raw: string): void {
  console.error(`[${providerId}] capture produced no usable output; raw pane follows:\n${raw || "(empty)"}`);
}
