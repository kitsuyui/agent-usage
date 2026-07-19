import { registerProvider } from "./registry.ts";
import { claudeProvider } from "./claude/index.ts";
import { codexProvider } from "./codex/index.ts";
import { antigravityProvider } from "./antigravity/index.ts";
import { copilotProvider } from "./copilot/index.ts";

export { registerProvider, getProvider, listProviders } from "./registry.ts";
export type { UsageProvider, TuiCaptureConfig } from "./types.ts";

let registered = false;

/**
 * Registers the built-in providers (claude, codex, antigravity, copilot).
 *
 * A new agent CLI is added by writing a `UsageProvider` (TUI capture config +
 * a `parse` function) and calling `registerProvider` — no changes needed
 * anywhere else in the collector, storage, HTTP, or MCP layers.
 */
export function registerBuiltinProviders(): void {
  if (registered) return;
  registered = true;
  registerProvider(claudeProvider);
  registerProvider(codexProvider);
  registerProvider(antigravityProvider);
  registerProvider(copilotProvider);
}
