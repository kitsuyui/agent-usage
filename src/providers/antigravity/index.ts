import type { UsageProvider } from "../types.ts";
import { DEFAULT_INTERSTITIALS } from "../shared.ts";
import { parseAntigravityUsage } from "./parse.ts";

export const antigravityProvider: UsageProvider = {
  id: "antigravity",
  displayName: "Antigravity",
  tui: {
    command: "agy",
    readyPattern: /shortcuts/,
    slashCommand: "/usage",
    expectedPattern: /Refreshes in|Quota available/,
    interstitials: DEFAULT_INTERSTITIALS,
  },
  parse: parseAntigravityUsage,
};

export { parseAntigravityUsage } from "./parse.ts";
