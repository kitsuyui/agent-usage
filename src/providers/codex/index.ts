import type { UsageProvider } from "../types.ts";
import { DEFAULT_INTERSTITIALS } from "../shared.ts";
import { parseCodexUsage } from "./parse.ts";

export const codexProvider: UsageProvider = {
  id: "codex",
  displayName: "Codex CLI",
  tui: {
    command: "codex",
    readyPattern: /›\s/,
    slashCommand: "/status",
    expectedPattern: /% left/,
    interstitials: DEFAULT_INTERSTITIALS,
  },
  parse: parseCodexUsage,
};

export { parseCodexUsage } from "./parse.ts";
