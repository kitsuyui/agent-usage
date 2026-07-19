import type { UsageSnapshot } from "../domain/types.ts";

/** How to drive a provider's interactive TUI to reveal its usage/quota screen. */
export interface TuiCaptureConfig {
  /** Shell command that launches the provider's interactive CLI. */
  command: string;
  /** Tested against the captured pane; matches once the CLI is ready for input. */
  readyPattern: RegExp;
  /** Slash command sent once ready, e.g. "/usage". */
  slashCommand: string;
  /** Tested against the captured pane; matches once the usage screen has rendered. */
  expectedPattern: RegExp;
  /** Known interstitial prompts to auto-dismiss while waiting for `readyPattern`. */
  interstitials?: { pattern: RegExp; sendKeys: string }[];
}

/** A pluggable source of rate-limit/usage data for one agent CLI. */
export interface UsageProvider {
  id: string;
  displayName: string;
  tui: TuiCaptureConfig;
  /** Turns one captured TUI screen into a provider-neutral snapshot. */
  parse(raw: string, observedAt: string): UsageSnapshot;
}
