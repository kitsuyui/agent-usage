import type { UsageProvider } from "../types.ts";
import { DEFAULT_INTERSTITIALS } from "../shared.ts";
import { parseCopilotUsage } from "./parse.ts";

export const copilotProvider: UsageProvider = {
  id: "copilot",
  displayName: "GitHub Copilot CLI",
  tui: {
    command: "copilot",
    readyPattern: /\/ commands · \? help/,
    slashCommand: "/usage",
    expectedPattern: /\d+ \/ \d+ AIC/,
    interstitials: DEFAULT_INTERSTITIALS,
  },
  parse: parseCopilotUsage,
};

export { parseCopilotUsage } from "./parse.ts";
