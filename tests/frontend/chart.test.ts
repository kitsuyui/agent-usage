import { describe, expect, test } from "bun:test";
import {
  activeChartSeries,
  buildChartSvg,
  buildLegend,
  chartTimeDomain,
  cycleAverageTrend,
  estimatedDepletionTime,
  groupChartSeries,
  type ChartReset,
  type ChartSeries,
} from "../../frontend/chart.ts";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-09-10T00:00:00Z");

function series(overrides: Partial<ChartSeries> = {}): ChartSeries {
  return {
    seriesId: "session", provider: "example", scope: null, window: "session", windowSeconds: 5 * 60 * 60,
    metric: "quota", unit: "percent", attributes: {}, scale: "remaining-percent",
    points: [[NOW - 10 * HOUR, 100], [NOW - HOUR, 45]], ...overrides,
  };
}

function reset(seriesId: string, time: number): ChartReset {
  return { seriesId, resetsAt: new Date(time).toISOString() };
}

describe("chart reset annotations", () => {
  test("only keeps series reported by the latest provider observation", () => {
    const retired = series({ seriesId: "retired", scope: "legacy" });
    const replacement = series({ seriesId: "replacement", scope: "current" });

    expect(activeChartSeries([retired, replacement], [reset("replacement", NOW + HOUR)])).toEqual([
      replacement,
    ]);
  });

  test("keeps the last successful series visible after a failed capture", () => {
    const retired = series({ seriesId: "retired", points: [[NOW - 2 * HOUR, 70]] });
    const current = series({ seriesId: "current", points: [[NOW - 2 * HOUR, 80], [NOW - HOUR, 45]] });
    const lastSuccessfulAt = new Date(NOW - HOUR).toISOString();
    const visible = activeChartSeries([retired, current], [reset("another-provider", NOW + HOUR)], lastSuccessfulAt);

    expect(visible).toEqual([current]);
    expect(buildChartSvg(visible, "remaining-percent", [], NOW)).toContain("<polyline");
  });

  test("does not revive an old series when the last success is outside the selected range", () => {
    const old = series({ points: [[NOW - 20 * HOUR, 80]] });
    expect(activeChartSeries([old], [], new Date(NOW - HOUR).toISOString())).toEqual([]);
  });

  test("uses two past cycles and one future cycle for a known reset duration", () => {
    const resets = [reset("session", NOW + 2 * HOUR)];
    const item = series();
    const svg = buildChartSvg([item], "remaining-percent", resets, NOW, item.windowSeconds);
    const domain = chartTimeDomain([item], resets, NOW, item.windowSeconds);
    expect(domain).toEqual({ min: NOW - 10 * HOUR, max: NOW + 5 * HOUR });
    expect(svg).toContain(`data-reset-at="${NOW + 2 * HOUR}"`);
    expect(svg).toContain(">Now</text>");
    const nowLine = svg.match(/<line x1="([^"]+)" y1="[^"]+" x2="[^"]+" y2="[^"]+" class="now-line"/);
    const expectedNowX = 52 + (900 - 52 - 16) * 2 / 3;
    expect(nowLine?.[1]).toBe(String(expectedNowX));
    const polyline = svg.match(/<polyline points="([^"]*)"/)![1]!;
    expect(polyline.split(" ")).toHaveLength(2);
    expect(svg).not.toMatch(/NaN|Infinity/);
    expect(buildLegend([series()], resets, NOW)).toContain("in 2h 0m");
  });

  test("extends the current-cycle average pace without mixing an earlier cycle", () => {
    const item = series({
      points: [
        [NOW - 12 * HOUR, 15],
        [NOW - 4 * HOUR, 70],
        [NOW - HOUR, 50],
      ],
    });
    const cycle = {
      seriesId: "session",
      previousResetAt: new Date(NOW - 6 * HOUR).toISOString(),
      resetsAt: new Date(NOW + 2 * HOUR).toISOString(),
      cyclePace: {
        firstObservedAt: new Date(NOW - 6 * HOUR).toISOString(),
        firstRemainingPercent: 100,
        latestObservedAt: new Date(NOW - HOUR).toISOString(),
        latestRemainingPercent: 50,
      },
    };

    const trend = cycleAverageTrend(item, cycle, NOW);
    expect(trend).toMatchObject({
      firstObservedAt: NOW - 6 * HOUR,
      observedAt: NOW - HOUR,
      projectedValue: 20,
    });
    expect(trend?.ratePerMs).toBeCloseTo(-10 / HOUR);

    const svg = buildChartSvg([item], "remaining-percent", [cycle], NOW, item.windowSeconds);
    expect(svg).toContain(`data-previous-reset-at="${NOW - 6 * HOUR}"`);
    expect(svg).toContain(`data-average-pace-to="${NOW + 2 * HOUR}"`);
    expect(svg).toContain('class="average-pace"');
    expect(buildLegend([item], [cycle], NOW)).toContain("Cycle began");
  });

  test("does not estimate a pace until a prior reset boundary is observed", () => {
    expect(cycleAverageTrend(series(), reset("session", NOW + HOUR), NOW)).toBeNull();
    expect(buildLegend([series()], [reset("session", NOW + HOUR)], NOW)).not.toContain("Est. 0%");
  });

  test("marks a pace that reaches zero before the next reset", () => {
    const item = series({ points: [[NOW - 6 * HOUR, 100], [NOW - HOUR, 20]] });
    const cycle = {
      seriesId: "session",
      previousResetAt: new Date(NOW - 6 * HOUR).toISOString(),
      resetsAt: new Date(NOW + 2 * HOUR).toISOString(),
    };
    const svg = buildChartSvg([item], "remaining-percent", [cycle], NOW, item.windowSeconds);
    expect(svg).toContain('class="average-pace average-pace-depleting"');
    expect(svg).toContain("average pace estimates 0% at ");
    expect(svg).not.toMatch(/NaN|Infinity/);
    const legend = buildLegend([item], [cycle], NOW);
    expect(legend).toContain('datetime="2026-09-10T00:15:00.000Z"');
    expect(legend).toContain("Est. 0% · ");
  });

  test("only shows a future 0% estimate within the current reset cycle", () => {
    const base = {
      firstObservedAt: NOW - 2 * HOUR,
      firstValue: 80,
      observedAt: NOW - HOUR,
      observedValue: 40,
      resetsAt: NOW + 2 * HOUR,
      ratePerMs: -20 / HOUR,
      projectedValue: -20,
    };
    expect(estimatedDepletionTime(base, NOW)).toBe(NOW + HOUR);
    expect(estimatedDepletionTime(base, NOW - HOUR)).toBe(NOW + HOUR);
    expect(estimatedDepletionTime({ ...base, ratePerMs: 0 }, NOW)).toBeNull();
    expect(estimatedDepletionTime({ ...base, observedValue: 0 }, NOW)).toBeNull();
    expect(estimatedDepletionTime({ ...base, observedAt: NOW, resetsAt: NOW + 2 * HOUR }, NOW)).toBeNull();
    expect(estimatedDepletionTime({ ...base, ratePerMs: -10 / HOUR }, NOW)).toBeNull();
    expect(estimatedDepletionTime({ ...base, ratePerMs: -60 / HOUR }, NOW)).toBeNull();
  });

  test("a pace that stays above 0% until reset has no depletion date", () => {
    const item = series({ points: [[NOW - 6 * HOUR, 100], [NOW - HOUR, 80]] });
    const cycle = {
      seriesId: "session",
      previousResetAt: new Date(NOW - 6 * HOUR).toISOString(),
      resetsAt: new Date(NOW + 2 * HOUR).toISOString(),
    };
    expect(buildLegend([item], [cycle], NOW)).not.toContain("Est. 0%");
  });

  test("a future reset never changes the fixed cycle viewport", () => {
    const resets = [reset("session", NOW + 30 * 24 * HOUR)];
    const item = series();
    const domain = chartTimeDomain([item], resets, NOW, item.windowSeconds);
    const svg = buildChartSvg([item], "remaining-percent", resets, NOW, item.windowSeconds);
    expect(domain).toEqual({ min: NOW - 10 * HOUR, max: NOW + 5 * HOUR });
    expect(svg).toContain("beyond the visible time axis");
    expect(svg).toContain("→");
    expect(svg).not.toContain("data-reset-at=");
    expect(buildLegend([series()], resets, NOW)).toContain("in 30d 0m");
  });

  test("caps a weekly chart at a selected short range", () => {
    const weekly = series({
      seriesId: "weekly",
      window: "week",
      windowSeconds: 7 * 24 * 60 * 60,
      points: [[NOW - 20 * HOUR, 100], [NOW - HOUR, 80]],
    });
    const resets = [reset("weekly", NOW + 6 * 24 * HOUR)];
    const rangeSeconds = 15 * 60 * 60;
    const domain = chartTimeDomain([weekly], resets, NOW, weekly.windowSeconds, rangeSeconds);
    expect(domain).toEqual({ min: NOW - 10 * HOUR, max: NOW + 5 * HOUR });

    const svg = buildChartSvg([weekly], "remaining-percent", resets, NOW, weekly.windowSeconds, rangeSeconds);
    const polyline = svg.match(/<polyline points="([^"]*)"/)![1]!;
    expect(polyline.split(" ")).toHaveLength(1);
    expect(svg).toContain("beyond the visible time axis");
  });

  test("joins current resets by exact series identity, not the displayed window name", () => {
    const other = series({ seriesId: "different-duration", points: [[NOW - 2 * HOUR, 30]] });
    const resets = [reset("different-duration", NOW + HOUR)];
    const legend = buildLegend([series(), other], resets, NOW);
    const items = legend.split('class="legend-item"');
    expect(items[1]).toContain("No current reset data");
    expect(items[1]).not.toContain("Next reset");
    expect(items[2]).toContain("Next reset");
    const svg = buildChartSvg([series(), other], "remaining-percent", resets, NOW);
    expect(svg).toContain(">2 · ");
    expect(svg).not.toContain(">1 · ");
  });

  test("two series sharing a reset retain separate labels", () => {
    const group = [series(), series({ seriesId: "week", window: "week" })];
    const resets = [reset("session", NOW + HOUR), reset("week", NOW + HOUR)];
    const svg = buildChartSvg(group, "remaining-percent", resets, NOW, 5 * 60 * 60);
    expect(svg).toContain(">1 · ");
    expect(svg).toContain(">2 · ");
    const labelRows = [...svg.matchAll(/<rect x="[^"]+" y="([^"]+)" width="184"/g)].map((match) => match[1]);
    expect(new Set(labelRows).size).toBe(2);
  });

  test.each([null, "not-a-date"])("unknown reset %s creates no future marker", (resetsAt) => {
    const resets = [{ seriesId: "session", resetsAt }];
    const item = series();
    const svg = buildChartSvg([item], "remaining-percent", resets, NOW, item.windowSeconds);
    expect(svg).not.toContain('class="reset-marker"');
    expect(svg).not.toContain('class="future-area"');
    expect(buildLegend([series()], resets, NOW)).toContain("Reset time unavailable");
  });

  test("unknown reset data does not invent a Now line or pace forecast", () => {
    const item = series();
    const svg = buildChartSvg([item], "remaining-percent", [{ seriesId: item.seriesId, resetsAt: null }], NOW, item.windowSeconds);
    expect(svg).not.toContain('class="now-line"');
    expect(svg).not.toContain('class="average-pace"');
  });

  test("separates equal-scale session and weekly series by provider-reported duration", () => {
    const session = series();
    const weekly = series({ seriesId: "weekly", window: "week", windowSeconds: 7 * 24 * 60 * 60 });
    const groups = groupChartSeries([session, weekly]);
    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.cycleSeconds)).toEqual([5 * 60 * 60, 7 * 24 * 60 * 60]);
  });

  test("past reported resets are awaiting update rather than a new inferred period", () => {
    const resets = [reset("session", NOW - HOUR)];
    const svg = buildChartSvg([series()], "remaining-percent", resets, NOW);
    expect(svg).not.toContain('class="reset-marker"');
    const legend = buildLegend([series()], resets, NOW);
    expect(legend).toContain("awaiting update");
    expect(legend).not.toContain("Next reset");
  });

  test("a missing latest series does not borrow a reset from a retired or different series", () => {
    const resets = [reset("retired-series", NOW + HOUR)];
    expect(chartTimeDomain([series()], resets, NOW).max).toBe(NOW);
    expect(buildLegend([series()], resets, NOW)).toContain("No current reset data");
  });

  test("a single observation produces a finite graph, including non-percent metrics", () => {
    const item = series({ scale: "value", metric: "credits", unit: "AIC", points: [[NOW, 200]] });
    const svg = buildChartSvg([item], "credits", [reset("session", NOW + HOUR)], NOW);
    expect(svg).toContain("<polyline");
    expect(svg).not.toMatch(/NaN|Infinity/);
  });

  test("provider-controlled text is escaped in labels and accessible descriptions", () => {
    const item = series({ scope: '<script>"unsafe"</script>' });
    const resets = [reset("session", NOW + HOUR)];
    const svg = buildChartSvg([item], "remaining-percent", resets, NOW);
    const legend = buildLegend([item], resets, NOW);
    expect(svg).not.toContain("<script>");
    expect(legend).not.toContain("<script>");
    expect(svg).toContain("&lt;script&gt;&quot;unsafe&quot;");
    expect(svg).toContain('role="img"');
    expect(legend).toContain('role="listitem"');
  });

  test("sub-minute future resets are readable without showing zero minutes", () => {
    expect(buildLegend([series()], [reset("session", NOW + 30_000)], NOW)).toContain("in &lt;1m");
  });
});
