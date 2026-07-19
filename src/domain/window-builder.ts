import type { UsageWindow } from "./types.ts";
import { resolveResetAt } from "./reset-time.ts";
import { windowSeconds } from "./window-kinds.ts";

interface WindowInput {
  scope?: string;
  window: string;
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
  return build(input, { usedPercent: input.usedPercent });
}

/** Builds a window reporting how much of the quota *remains*. */
export function remainingWindow(input: WindowInput & { remainingPercent: number }): UsageWindow {
  return build(input, { remainingPercent: input.remainingPercent });
}

function build(
  input: WindowInput,
  percent: Pick<UsageWindow, "usedPercent"> | Pick<UsageWindow, "remainingPercent">,
): UsageWindow {
  const resetsAt = input.resetsAt ?? (input.resetsRaw ? resolveResetAt(input.resetsRaw, input.observedAt) : undefined);
  const seconds = windowSeconds(input.window);
  return {
    window: input.window,
    ...percent,
    ...(input.scope !== undefined ? { scope: input.scope } : {}),
    ...(input.resetsRaw !== undefined ? { resetsRaw: input.resetsRaw } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    ...(seconds !== undefined ? { windowSeconds: seconds } : {}),
  };
}
