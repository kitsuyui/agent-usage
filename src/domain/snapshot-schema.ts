import { z } from "zod";
import type { UsageSnapshot, UsageWindow } from "./types.ts";

/** Validates a `UsageSnapshot` received over the wire (the ingest endpoint's request body). */
export const usageWindowSchema = z.object({
  scope: z.string().optional(),
  window: z.string(),
  remainingPercent: z.number().optional(),
  usedPercent: z.number().optional(),
  resetsRaw: z.string().optional(),
  resetsAt: z.string().optional(),
  windowSeconds: z.number().optional(),
});

export const usageSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  observedAt: z.string(),
  provider: z.string().min(1),
  ok: z.boolean(),
  windows: z.array(usageWindowSchema),
  resetCredits: z.number().optional(),
  error: z.string().optional(),
});

type ParsedSnapshot = z.infer<typeof usageSnapshotSchema>;
type ParsedWindow = z.infer<typeof usageWindowSchema>;

/**
 * Zod's `.optional()` output type allows an explicit `undefined` value for
 * present-but-unset keys; our domain types (under `exactOptionalPropertyTypes`)
 * require the key to be entirely absent instead. This bridges the two.
 */
export function toUsageSnapshot(parsed: ParsedSnapshot): UsageSnapshot {
  return {
    schemaVersion: parsed.schemaVersion,
    observedAt: parsed.observedAt,
    provider: parsed.provider,
    ok: parsed.ok,
    windows: parsed.windows.map(toUsageWindow),
    ...(parsed.resetCredits !== undefined ? { resetCredits: parsed.resetCredits } : {}),
    ...(parsed.error !== undefined ? { error: parsed.error } : {}),
  };
}

function toUsageWindow(parsed: ParsedWindow): UsageWindow {
  return {
    window: parsed.window,
    ...(parsed.scope !== undefined ? { scope: parsed.scope } : {}),
    ...(parsed.remainingPercent !== undefined ? { remainingPercent: parsed.remainingPercent } : {}),
    ...(parsed.usedPercent !== undefined ? { usedPercent: parsed.usedPercent } : {}),
    ...(parsed.resetsRaw !== undefined ? { resetsRaw: parsed.resetsRaw } : {}),
    ...(parsed.resetsAt !== undefined ? { resetsAt: parsed.resetsAt } : {}),
    ...(parsed.windowSeconds !== undefined ? { windowSeconds: parsed.windowSeconds } : {}),
  };
}
