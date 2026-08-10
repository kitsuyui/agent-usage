import { describe, expect, test } from "bun:test";
import { parseClaudeUsage } from "../../src/providers/claude/parse.ts";
import { parseCodexUsage } from "../../src/providers/codex/parse.ts";
import { parseAntigravityUsage } from "../../src/providers/antigravity/parse.ts";
import { parseCopilotUsage } from "../../src/providers/copilot/parse.ts";

const OBSERVED = "2026-07-18T10:00:00.000Z";

describe("parseClaudeUsage", () => {
  test("extracts a used-percent window with its reset time", () => {
    const raw = "Current session\n4% used\nResets 10:30pm (Asia/Tokyo)";
    const snapshot = parseClaudeUsage(raw, OBSERVED);
    expect(snapshot.ok).toBe(true);
    expect(snapshot.provider).toBe("claude");
    expect(snapshot.windows).toHaveLength(1);
    expect(snapshot.windows[0]).toMatchObject({
      window: "session",
      usedPercent: 4,
      windowSeconds: 5 * 60 * 60,
    });
    expect(snapshot.windows[0]?.resetsAt).toBeDefined();
  });

  test("captures a model scope in parentheses", () => {
    const raw = "Current week (Opus 4.8)\n61% used\nResets Jul 21";
    const snapshot = parseClaudeUsage(raw, OBSERVED);
    expect(snapshot.windows[0]).toMatchObject({ scope: "Opus 4.8", window: "week", usedPercent: 61 });
  });

  test("parses the current Claude screen including a model-specific weekly quota", () => {
    const raw = [
      "Current session",
      "0% used",
      "Resets 10:30pm (Asia/Tokyo)",
      "Current week (all models)",
      "0% used",
      "Resets Jul 28",
      "Current week (Fable)",
      "0% used",
      "Resets Jul 28",
    ].join("\n");
    const snapshot = parseClaudeUsage(raw, OBSERVED);
    expect(snapshot.windows).toHaveLength(3);
    expect(snapshot.windows[2]).toMatchObject({ scope: "Fable", window: "week", usedPercent: 0 });
  });

  test("no windows found yields ok: false", () => {
    const snapshot = parseClaudeUsage("nothing usage-shaped here", OBSERVED);
    expect(snapshot.ok).toBe(false);
    expect(snapshot.windows).toHaveLength(0);
    expect(snapshot.error).toBeDefined();
  });
});

describe("parseCodexUsage", () => {
  test("parses machine-readable app-server rate limits", () => {
    const raw = JSON.stringify({
      rateLimitsByLimitId: {
        codex: {
          limitId: "codex",
          limitName: null,
          planType: "pro",
          primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1786320000 },
          secondary: { usedPercent: 21, windowDurationMins: 10080, resetsAt: 1786834843 },
        },
        codex_bengalfox: {
          limitId: "codex_bengalfox",
          limitName: "GPT-5.3-Codex-Spark",
          primary: { usedPercent: 6, windowDurationMins: 10080, resetsAt: 1786894779 },
          secondary: null,
        },
      },
      rateLimitResetCredits: { availableCount: 1 },
    });
    const snapshot = parseCodexUsage(raw, OBSERVED);
    expect(snapshot.ok).toBe(true);
    expect(snapshot.resetCredits).toBe(1);
    expect(snapshot.windows).toHaveLength(3);
    expect(snapshot.windows[0]).toMatchObject({
      scope: "default",
      window: "5h",
      usedPercent: 12,
      windowSeconds: 5 * 60 * 60,
      resetsAt: "2026-08-10T00:00:00.000Z",
      attributes: { limitId: "codex", plan: "pro" },
    });
    expect(snapshot.windows[2]).toMatchObject({
      scope: "GPT-5.3-Codex-Spark",
      window: "Weekly",
      usedPercent: 6,
    });
  });

  test("extracts a scoped weekly window", () => {
    const raw = "GPT models limit:\nWeekly limit: [####] 58% left (resets 13:21 on 20 Jul)";
    const snapshot = parseCodexUsage(raw, OBSERVED);
    expect(snapshot.provider).toBe("codex");
    expect(snapshot.windows).toHaveLength(1);
    expect(snapshot.windows[0]).toMatchObject({
      scope: "GPT models",
      window: "Weekly",
      remainingPercent: 58,
      windowSeconds: 7 * 24 * 60 * 60,
    });
  });

  test("falls back to a default scope without a heading line", () => {
    const raw = "5h limit: [##] 90% left (resets 3h 20m)";
    const snapshot = parseCodexUsage(raw, OBSERVED);
    expect(snapshot.windows[0]).toMatchObject({ scope: "default", window: "5h", remainingPercent: 90 });
  });

  test("extracts inline scopes from the current status layout", () => {
    const raw = [
      "│  Weekly limit:                       [████████████████░░░░] 79% left (resets 02:48 on 29 Jul)  │",
      "│  GPT-5.3-Codex-Spark Weekly limit:   [██████████████████░░] 88% left (resets 04:58 on 29 Jul)  │",
    ].join("\n");
    const snapshot = parseCodexUsage(raw, OBSERVED);
    expect(snapshot.windows).toHaveLength(2);
    expect(snapshot.windows[0]).toMatchObject({
      scope: "default",
      window: "Weekly",
      remainingPercent: 79,
    });
    expect(snapshot.windows[1]).toMatchObject({
      scope: "GPT-5.3-Codex-Spark",
      window: "Weekly",
      remainingPercent: 88,
    });
  });

  test("records reset-credit tickets when reported", () => {
    expect(parseCodexUsage("You have 1 usage limit reset available", OBSERVED).resetCredits).toBe(1);
    expect(parseCodexUsage("You have 2 usage limit resets available", OBSERVED).resetCredits).toBe(2);
  });
});

describe("parseAntigravityUsage", () => {
  test("extracts a percent window and back-fills its reset time", () => {
    const raw = "GEMINI MODELS\nWeekly Limit\n[####] 46.51%\nRefreshes in 6h 49m";
    const snapshot = parseAntigravityUsage(raw, OBSERVED);
    expect(snapshot.provider).toBe("antigravity");
    expect(snapshot.windows).toHaveLength(1);
    expect(snapshot.windows[0]).toMatchObject({
      scope: "GEMINI MODELS",
      window: "Weekly",
      remainingPercent: 46.51,
      resetsRaw: "6h 49m",
    });
    expect(snapshot.windows[0]?.resetsAt).toBe("2026-07-18T16:49:00Z");
  });

  test("ignores percent lines before any scope heading", () => {
    const raw = "[####] 50%\nRefreshes in 1h 0m";
    const snapshot = parseAntigravityUsage(raw, OBSERVED);
    expect(snapshot.windows).toHaveLength(0);
  });
});

describe("parseCopilotUsage", () => {
  // Captured verbatim from `copilot`'s real `/usage` screen (v1.0.71).
  const raw = [
    "   Changes    +0 -0",
    "   AI Credits 0 (7s)",
    "   Plan       ■■■■■■■■■■■■■■■■■■■■ 0% used",
    "              0 / 200 AIC",
  ].join("\n");

  test("extracts the monthly plan usage with a computed UTC month-boundary reset", () => {
    const snapshot = parseCopilotUsage(raw, OBSERVED);
    expect(snapshot.provider).toBe("copilot");
    expect(snapshot.windows).toHaveLength(2);
    expect(snapshot.windows[0]).toMatchObject({ window: "monthly", usedPercent: 0 });
    expect(snapshot.windows[1]).toMatchObject({
      window: "monthly",
      metric: "credits",
      unit: "AIC",
      usedValue: 0,
      limitValue: 200,
      remainingValue: 200,
    });
    // No resetsRaw is present in the source text — the reset time is a fixed
    // rule (00:00 UTC on the 1st), not scraped.
    expect(snapshot.windows[0]?.resetsRaw).toBeUndefined();
    expect(snapshot.windows[0]?.resetsAt).toBe("2026-08-01T00:00:00Z");
  });

  test("handles a non-zero usage percentage", () => {
    const busy = raw.replace("0% used", "37.5% used");
    const snapshot = parseCopilotUsage(busy, OBSERVED);
    expect(snapshot.windows[0]?.usedPercent).toBe(37.5);
  });

  test("no windows found yields ok: false", () => {
    const snapshot = parseCopilotUsage("nothing usage-shaped here", OBSERVED);
    expect(snapshot.ok).toBe(false);
    expect(snapshot.windows).toHaveLength(0);
  });
});
