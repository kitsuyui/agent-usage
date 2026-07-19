import { describe, expect, test } from "bun:test";
import { nextUtcMonthStart, resolveResetAt } from "../../src/domain/reset-time.ts";

const OBSERVED = "2026-07-18T10:00:00.000Z";

describe("resolveResetAt", () => {
  test("relative offset: '3h 20m'", () => {
    expect(resolveResetAt("3h 20m", OBSERVED)).toBe("2026-07-18T13:20:00Z");
  });

  test("strips a trailing timezone parenthetical", () => {
    expect(resolveResetAt("3h 20m (Asia/Tokyo)", OBSERVED)).toBe("2026-07-18T13:20:00Z");
  });

  test("same-day clock time still ahead of observed", () => {
    // Local time zone in this environment is used for wall-clock parsing;
    // pick an observed time comfortably mid-morning UTC and a clock time
    // that is unambiguously later the same local day in most zones.
    const observed = new Date(OBSERVED);
    const laterSameDay = new Date(observed.getTime() + 60 * 60 * 1000);
    const hh = String(laterSameDay.getHours()).padStart(2, "0");
    const mm = String(laterSameDay.getMinutes()).padStart(2, "0");
    const resolved = resolveResetAt(`${hh}:${mm}`, OBSERVED);
    expect(resolved).toBeDefined();
    expect(new Date(resolved!).getTime()).toBeGreaterThan(observed.getTime());
  });

  test("returns undefined for unrecognized text", () => {
    expect(resolveResetAt("sometime soon", OBSERVED)).toBeUndefined();
  });

  test("dated clock: 'HH:MM on DD Mon' resolves within a day of the named date", () => {
    const resolved = resolveResetAt("05:14 on 20 Jul", OBSERVED);
    expect(resolved).toBeDefined();
    const resolvedDate = new Date(resolved!);
    expect(resolvedDate.getUTCMonth()).toBe(6); // July
    expect([19, 20]).toContain(resolvedDate.getUTCDate());
  });

  test("named date with explicit year and time", () => {
    const resolved = resolveResetAt("Jul 21, 2027 at 3pm", OBSERVED);
    expect(resolved).toBeDefined();
    const resolvedDate = new Date(resolved!);
    expect(resolvedDate.getUTCFullYear()).toBe(2027);
  });
});

describe("nextUtcMonthStart", () => {
  test("mid-month rolls to the 1st of the following month", () => {
    expect(nextUtcMonthStart("2026-07-18T10:00:00Z")).toBe("2026-08-01T00:00:00Z");
  });

  test("December rolls into January of the next year", () => {
    expect(nextUtcMonthStart("2026-12-15T23:59:59Z")).toBe("2027-01-01T00:00:00Z");
  });

  test("observed exactly at a month boundary still rolls to the next one", () => {
    expect(nextUtcMonthStart("2026-08-01T00:00:00Z")).toBe("2026-09-01T00:00:00Z");
  });
});
