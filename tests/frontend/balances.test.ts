import { describe, expect, test } from "bun:test";
import type { CreditBalance } from "../../src/domain/credit-balances.ts";
import {
  balancePace, buildBalanceSvg, expiryBreakdown, renderBalances, renderBalanceSummary, unusedExpiryPath,
  type BalanceObservation, type BalanceProvider,
} from "../../frontend/balances.ts";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-01-10T12:00:00Z");
const iso = (time: number): string => new Date(time).toISOString();
const balance = (overrides: Partial<CreditBalance> = {}): CreditBalance => ({
  id: "credit", kind: "credit", label: "Usage credits", unit: "credits", remaining: 80, expiry: { kind: "unknown" }, ...overrides,
});
const row = (time: number, value: CreditBalance | null): BalanceObservation => ({ observedAt: iso(time), ok: true, creditBalances: value ? [value] : null });
const provider = (current: CreditBalance, overrides: Partial<BalanceProvider> = {}): BalanceProvider => ({
  id: "example", displayName: "Example", latestOk: true, lastAttemptAt: iso(NOW), stale: false, creditBalances: [current], ...overrides,
});
const history = (current = balance()): BalanceObservation[] => [row(NOW - HOUR, { ...current, remaining: 100 }), row(NOW, current)];

describe("expiry accounting", () => {
  test("keeps an unlisted remainder unknown and groups dates without double counting", () => {
    const current = balance({ remaining: 4, grants: [
      { remaining: 1, expiry: { kind: "at", at: iso(NOW + HOUR) } },
      { remaining: 1, expiry: { kind: "at", at: iso(NOW + HOUR) } },
      { remaining: 1, expiry: { kind: "never" } },
    ] });
    expect(expiryBreakdown(current)).toEqual({ events: [{ at: NOW + HOUR, amount: 2 }], never: 1, unknown: 1 });
    expect(unusedExpiryPath(current, NOW, NOW + 2 * HOUR)).toEqual([
      { at: NOW, value: 4 }, { at: NOW + HOUR, value: 4 }, { at: NOW + HOUR, value: 2 }, { at: NOW + 2 * HOUR, value: 2 },
    ]);
  });
  test("does not turn inconsistent or unknown details into a claimed expiry", () => {
    expect(expiryBreakdown(balance({ remaining: 1, grants: [{ remaining: 2, expiry: { kind: "at", at: iso(NOW + HOUR) } }] }))).toEqual({ events: [], unknown: 1, never: 0 });
    expect(expiryBreakdown(balance()).events).toEqual([]);
  });
});

describe("consumption estimates", () => {
  test("uses a decreasing credit epoch and never estimates manual reset redemption", () => {
    expect(balancePace(history(), balance(), iso(NOW))?.depletedAt).toBe(NOW + 4 * HOUR);
    const resets = balance({ kind: "manual_reset", unit: "resets" });
    expect(balancePace(history(resets), resets, iso(NOW))).toBeNull();
  });
  test("cuts at replenishment rather than producing an increasing estimate", () => {
    const current = balance({ remaining: 100 });
    expect(balancePace([row(NOW - HOUR, balance({ remaining: 0 })), row(NOW, current)], current, iso(NOW))).toBeNull();
    expect(balancePace([row(NOW - 2 * HOUR, balance({ remaining: 0 })), ...history()], balance(), iso(NOW))?.depletedAt).toBe(NOW + 4 * HOUR);
  });
  test("cuts at failure, omitted balances, metadata changes, expiry, and renewal", () => {
    const current = balance();
    for (const middle of [
      { ...row(NOW - HOUR / 2, null), ok: false }, row(NOW - HOUR / 2, null),
      row(NOW - HOUR / 2, balance({ unit: "USD" })),
    ]) expect(balancePace([history()[0]!, middle, history()[1]!], current, iso(NOW))).toBeNull();
    for (const withBoundary of [
      balance({ expiry: { kind: "at", at: iso(NOW - HOUR / 2) } }),
      balance({ renewsAt: iso(NOW - HOUR / 2) }),
    ]) expect(balancePace(history(withBoundary), withBoundary, iso(NOW))).toBeNull();
  });
  test("cuts long capture gaps using the configured interval", () => {
    const rows = [row(NOW - 4 * HOUR, balance({ remaining: 100 })), row(NOW, balance())];
    expect(balancePace(rows, balance(), iso(NOW))).toBeNull();
    const svg = buildBalanceSvg(provider(balance(), { sampleIntervalSeconds: 300 }), balance(), rows, NOW, 86_400);
    expect(svg.match(/class="balance-observed"/g)).toHaveLength(2);
    expect(svg).not.toContain('class="balance-pace"');
    expect(balancePace(rows, balance(), iso(NOW), 5 * HOUR)?.depletedAt).toBe(NOW + 16 * HOUR);
  });
  test("matches a resource by id, kind and unit even when another shares its id", () => {
    const other = balance({ kind: "manual_reset", unit: "resets", remaining: 4 });
    const rows = history().map((entry) => ({ ...entry, creditBalances: [other, ...entry.creditBalances!] }));
    expect(balancePace(rows, balance(), iso(NOW))?.depletedAt).toBe(NOW + 4 * HOUR);
  });
  test("requires the latest history and provider response to agree", () => {
    expect(balancePace(history(), balance({ remaining: 70 }), iso(NOW))).toBeNull();
    expect(balancePace(history(), balance(), iso(NOW + 1))).toBeNull();
    expect(balancePace([row(NOW, balance({ remaining: 100 })), row(NOW, balance())], balance(), iso(NOW))).toBeNull();
  });
});

describe("balance rendering", () => {
  test("distinguishes zero, unlimited, unknown, unreported, failed, and stale", () => {
    const zero = balance({ remaining: 0 });
    const unlimited: CreditBalance = { id: "unlimited", kind: "credit", label: "Unlimited", unit: "credits", unlimited: true, expiry: { kind: "never" } };
    const html = renderBalanceSummary([
      provider(zero), provider(unlimited), provider(balance()),
      provider(balance(), { creditBalances: null }),
      provider(balance(), { latestOk: false, creditBalances: null }),
      provider(balance(), { stale: true }),
    ], new Map(), NOW);
    for (const text of ["0 credits", "Unlimited", "No expiry", "expiry unknown", "Balances not reported", "Current balances unavailable", "Stale · last reported"]) expect(html).toContain(text);
  });
  test("keeps known renewal distinct from unknown credit expiry", () => {
    const current = balance({ renewsAt: iso(NOW + HOUR) });
    const html = renderBalanceSummary([provider(current)], new Map([["example", history(current)]]), NOW);
    expect(html).toContain("expiry unknown");
    expect(html).toContain("Renews");
    expect(html).toContain("renewal comes before estimated depletion");
    expect(html).not.toContain("Estimated depletion:");
  });
  test("does not silently deduct past expiry or revive stale or failed balances", () => {
    const current = balance({ remaining: 2, kind: "manual_reset", unit: "resets", expiry: { kind: "at", at: iso(NOW - 1) } });
    const html = renderBalanceSummary([provider(current)], new Map([["example", history(current)]]), NOW);
    expect(html).toContain("2 resets");
    expect(html).toContain("expiry passed; awaiting a fresh observation");
    for (const p of [provider(current), provider(balance(), { stale: true }), provider(balance(), { latestOk: false, creditBalances: null })]) {
      const svg = buildBalanceSvg(p, current, history(current), NOW, 86_400);
      expect(svg).not.toContain('class="balance-unused"');
      expect(svg).not.toContain('class="balance-pace"');
    }
  });
  test("shows manual resets as stairs, no consumption forecast, and expiry calendar beyond chart horizon", () => {
    const current = balance({ kind: "manual_reset", unit: "resets", remaining: 2, grants: [
      { remaining: 1, expiry: { kind: "at", at: iso(NOW + 2 * HOUR) } },
      { remaining: 1, expiry: { kind: "at", at: iso(NOW + 100 * HOUR) } },
    ] });
    const rows = [row(NOW - HOUR, { ...current, remaining: 3 }), row(NOW, current)];
    const svg = buildBalanceSvg(provider(current), current, rows, NOW, 86_400);
    expect(svg).toContain('class="balance-observed" d="M');
    expect(svg).toMatch(/H[\d.]+V[\d.]+/);
    expect(svg).toContain('class="balance-unused"');
    expect(svg).not.toContain('class="balance-pace"');
    const html = renderBalances([provider(current)], new Map([["example", rows]]), new Set(), NOW, 86_400, "1 day");
    expect(html.match(/expires if still unused/g)).toHaveLength(2);
  });
  test("breaks history paths at failures and escapes upstream text", () => {
    const current = balance({ label: "<script>alert(1)</script>" });
    const rows = [row(NOW - 2 * HOUR, current), { ...row(NOW - HOUR, null), ok: false }, row(NOW, current)];
    const svg = buildBalanceSvg(provider(current), current, rows, NOW, 86_400);
    expect(svg.match(/class="balance-observed"/g)).toHaveLength(2);
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;script&gt;");
  });
  test("supports the bounded 100,000-row history without spreading a large array into a call", () => {
    const current = balance();
    const rows = Array.from({ length: 100_000 }, (_, index) => row(NOW - (99_999 - index) * 1000, current));
    expect(buildBalanceSvg(provider(current), current, rows, NOW, 100_000)).toContain("<svg");
  });
});
