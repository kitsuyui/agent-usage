import { describe, expect, test } from "bun:test";
import {
  historyQueryRange,
  historyRangeLabel,
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

  test.each(aliases)("maps %s to the canonical view %s", (input, expected) => {
    expect(normalizeHistoryRange(input)).toBe(expected);
  });

  test("rejects unknown values", () => {
    expect(normalizeHistoryRange("14d-ish")).toBeNull();
  });

  test("keeps the API request within the selected view", () => {
    expect(historyQueryRange("15h")).toBe("15h");
    expect(historyQueryRange("21d")).toBe("21d");
  });

  test("labels each chart with the selected view", () => {
    expect(historyRangeLabel("15h")).toBe("15 hours");
    expect(historyRangeLabel("21d")).toBe("21 days");
  });
});
