import type { UsageWindow } from "./types.ts";
import { resolveResetAt } from "./reset-time.ts";
import { windowSeconds } from "./window-kinds.ts";

export interface WindowInput {
  scope?: string;
  window: string;
  metric?: string;
  unit?: string;
  attributes?: Record<string, string>;
  resetsRaw?: string;
  /**
   * Absolute reset time, when it follows a fixed rule instead of being
   * scraped as text (e.g. Copilot's included-credits reset, which GitHub
   * documents as always 00:00 UTC on the 1st, unrelated to any on-screen
   * text). Takes precedence over `resetsRaw`-based resolution when set.
   */
  resetsAt?: string;
  observedAt: string;
}

/** Builds a window reporting how much of the quota has been *used*. */
export function usedWindow(input: WindowInput & { usedPercent: number }): UsageWindow {
  return build(input, { metric: input.metric ?? "quota", unit: input.unit ?? "percent", usedPercent: input.usedPercent });
}

/** Builds a window reporting how much of the quota *remains*. */
export function remainingWindow(input: WindowInput & { remainingPercent: number }): UsageWindow {
  return build(input, {
    metric: input.metric ?? "quota",
    unit: input.unit ?? "percent",
    remainingPercent: input.remainingPercent,
  });
}

type AbsoluteMeasurement =
  | { value: number; limitValue?: number; remainingValue?: number; usedValue?: number }
  | { value?: number; limitValue: number; remainingValue?: number; usedValue?: number }
  | { value?: number; limitValue?: number; remainingValue: number; usedValue?: number }
  | { value?: number; limitValue?: number; remainingValue?: number; usedValue: number };

/** Builds a non-percent measurement without adding provider-specific columns.
 * Use this for request, token, credit, or spend quotas. */
export function measuredWindow(
  input: WindowInput & { metric: string; unit: string } & AbsoluteMeasurement,
): UsageWindow {
  return build(input, {
    metric: input.metric,
    unit: input.unit,
    ...(input.value !== undefined ? { value: input.value } : {}),
    ...(input.limitValue !== undefined ? { limitValue: input.limitValue } : {}),
    ...(input.remainingValue !== undefined ? { remainingValue: input.remainingValue } : {}),
    ...(input.usedValue !== undefined ? { usedValue: input.usedValue } : {}),
  });
}

function build(
  input: WindowInput,
  measurement: Pick<UsageWindow, "metric" | "unit"> &
    (
      | Pick<UsageWindow, "usedPercent">
      | Pick<UsageWindow, "remainingPercent">
      | Pick<UsageWindow, "value" | "limitValue" | "remainingValue" | "usedValue">
    ),
): UsageWindow {
  const resetsAt = input.resetsAt ?? (input.resetsRaw ? resolveResetAt(input.resetsRaw, input.observedAt) : undefined);
  const seconds = windowSeconds(input.window);
  return {
    window: input.window,
    ...measurement,
    ...(input.scope !== undefined ? { scope: input.scope } : {}),
    ...(input.attributes !== undefined ? { attributes: input.attributes } : {}),
    ...(input.resetsRaw !== undefined ? { resetsRaw: input.resetsRaw } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    ...(seconds !== undefined ? { windowSeconds: seconds } : {}),
  };
}
