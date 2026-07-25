import type { UsageProvider } from "../types.ts";
import { DEFAULT_INTERSTITIALS } from "../shared.ts";
import { parseClaudeUsage } from "./parse.ts";

export const claudeProvider: UsageProvider = {
  id: "claude",
  displayName: "Claude Code",
  versionCommand: ["claude", "--version"],
  tui: {
    command: "claude",
    readyPattern: /Claude Code v\d/,
    slashCommand: "/usage",
    expectedPattern: /% used/,
    interstitials: DEFAULT_INTERSTITIALS,
  },
  parse: parseClaudeUsage,
};

export { parseClaudeUsage } from "./parse.ts";
