import type { UsageProvider } from "../types.ts";
import { captureCodexRateLimits } from "./capture.ts";
import { parseCodexUsage } from "./parse.ts";

export const codexProvider: UsageProvider = {
  id: "codex",
  displayName: "Codex CLI",
  versionCommand: ["codex", "--version"],
  capture: captureCodexRateLimits,
  parse: parseCodexUsage,
};

export { parseCodexUsage } from "./parse.ts";
