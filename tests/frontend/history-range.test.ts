import { describe, expect, test } from "bun:test";
import {
  cycleViewLabel,
  historyQueryRange,
  normalizeHistoryRange,
  type HistoryRange,
} from "../../frontend/history-range.ts";

describe("history range aliases", () => {
  const aliases: [string, HistoryRange][] = [
    ["10h", "15h"],
    ["14d", "21d"],
    ["30d", "90d"],
    ["15h", "15h"],
    ["21d", "21d"],
    ["90d", "90d"],
  ];

  test.each(aliases)("maps %s to the cycle-context view %s", (input, expected) => {
    expect(normalizeHistoryRange(input)).toBe(expected);
  });

  test("rejects unknown values", () => {
    expect(normalizeHistoryRange("14d-ish")).toBeNull();
  });

  test("retains enough history for the longest current cycle", () => {
    expect(historyQueryRange("15h", 7 * 24 * 60 * 60)).toBe("21d");
    expect(historyQueryRange("21d", 5 * 60 * 60)).toBe("21d");
  });

  test("labels each chart by its own three-cycle context", () => {
    expect(cycleViewLabel(5 * 60 * 60)).toBe("Three cycles (15 hours)");
    expect(cycleViewLabel(7 * 24 * 60 * 60)).toBe("Three cycles (21 days)");
  });
});
