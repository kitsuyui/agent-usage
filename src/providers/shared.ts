import type { TuiCaptureConfig } from "./types.ts";

/** Interstitial prompts seen across multiple agent CLIs on first launch. */
export const DEFAULT_INTERSTITIALS: NonNullable<TuiCaptureConfig["interstitials"]> = [
  { pattern: /Update now/, sendKeys: "2" },
  { pattern: /Do you trust the files/, sendKeys: "1" },
];
