import { describe, expect, test } from "bun:test";
import { buildChartSvg, buildLegend, chartTimeDomain, type ChartReset, type ChartSeries } from "../../frontend/chart.ts";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-09-10T00:00:00Z");

function series(overrides: Partial<ChartSeries> = {}): ChartSeries {
  return {
    seriesId: "session", provider: "example", scope: null, window: "session",
    metric: "quota", unit: "percent", attributes: {}, scale: "remaining-percent",
    points: [[NOW - 10 * HOUR, 100], [NOW - HOUR, 45]], ...overrides,
  };
}

function reset(seriesId: string, time: number): ChartReset {
  return { seriesId, resetsAt: new Date(time).toISOString() };
}

describe("chart reset annotations", () => {
  test("places a nearby next reset on the time axis without projecting future usage", () => {
    const resets = [reset("session", NOW + 2 * HOUR)];
    const svg = buildChartSvg([series()], "remaining-percent", resets, NOW);
    const domain = chartTimeDomain([series()], resets, NOW);
    expect(domain.min).toBe(NOW - 10 * HOUR);
    expect(domain.max).toBeGreaterThan(NOW + 2 * HOUR);
    expect(svg).toContain(`data-reset-at="${NOW + 2 * HOUR}"`);
    expect(svg).toContain(">Now</text>");
    const polyline = svg.match(/<polyline points="([^"]*)"/)![1]!;
    expect(polyline.split(" ")).toHaveLength(2);
    expect(svg).not.toMatch(/NaN|Infinity/);
    expect(buildLegend([series()], resets, NOW)).toContain("in 2h 0m");
  });

  test("a distant reset keeps at least two-thirds of the time axis for history", () => {
    const resets = [reset("session", NOW + 30 * 24 * HOUR)];
    const domain = chartTimeDomain([series()], resets, NOW);
    const svg = buildChartSvg([series()], "remaining-percent", resets, NOW);
    expect(domain.max).toBe(NOW + 5 * HOUR);
    expect(svg).toContain("beyond the visible time axis");
    expect(svg).toContain("→");
    expect(svg).not.toContain("data-reset-at=");
    expect(buildLegend([series()], resets, NOW)).toContain("in 30d 0m");
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
    const svg = buildChartSvg(group, "remaining-percent", resets, NOW);
    expect(svg).toContain(">1 · ");
    expect(svg).toContain(">2 · ");
    const labelRows = [...svg.matchAll(/<rect x="[^"]+" y="([^"]+)" width="184"/g)].map((match) => match[1]);
    expect(new Set(labelRows).size).toBe(2);
  });

  test.each([null, "not-a-date"])("unknown reset %s creates no future marker", (resetsAt) => {
    const resets = [{ seriesId: "session", resetsAt }];
    const svg = buildChartSvg([series()], "remaining-percent", resets, NOW);
    expect(svg).not.toContain('class="reset-marker"');
    expect(svg).not.toContain('class="future-area"');
    expect(buildLegend([series()], resets, NOW)).toContain("Reset time unavailable");
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
