import { escapeHtml, formatAxisTime, formatNumber, scopeLabel } from "./format.ts";

export interface ChartSeries {
  seriesId: string;
  provider: string;
  scope: string | null;
  window: string;
  /** Provider-reported duration persisted with this series; never inferred from its label. */
  windowSeconds: number | null;
  metric: string;
  unit: string | null;
  attributes: Record<string, string>;
  scale: "remaining-percent" | "value";
  points: [timestampMs: number, value: number][];
}

export interface ChartReset {
  seriesId: string;
  resetsAt: string | null;
  previousResetAt?: string | null;
  cyclePace?: {
    firstObservedAt: string;
    firstRemainingPercent: number;
    latestObservedAt: string;
    latestRemainingPercent: number;
  } | null;
}

export interface CycleAverageTrend {
  firstObservedAt: number;
  firstValue: number;
  observedAt: number;
  observedValue: number;
  resetsAt: number;
  ratePerMs: number;
  projectedValue: number;
}

const PALETTE = ["#6ea8fe", "#7ee7a8", "#f2b56b", "#f28b82", "#c792ea", "#7fd4d4", "#e6a4c4", "#a3be8c"];
const HOUR = 3_600_000;

export interface ChartGroup {
  scale: string;
  cycleSeconds: number | null;
  series: ChartSeries[];
}

/**
 * Keeps the dashboard focused on buckets in the latest provider observation.
 * Historical series remain available from the API, but a removed or replaced
 * provider bucket must not look like a current limit merely because it has
 * observations inside the selected history range.
 */
export function activeChartSeries(series: ChartSeries[], currentWindows: ChartReset[]): ChartSeries[] {
  const currentIds = new Set(currentWindows.map((window) => window.seriesId));
  return series.filter((item) => currentIds.has(item.seriesId));
}

export function seriesLabel(series: ChartSeries): string {
  const attributes = Object.entries(series.attributes)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`);
  return [scopeLabel(series), series.window, ...attributes].filter((part) => part !== "—").join(" · ");
}

function resetTime(reset: ChartReset | undefined): number | null {
  if (!reset?.resetsAt) return null;
  const time = Date.parse(reset.resetsAt);
  return Number.isFinite(time) ? time : null;
}

function previousResetTime(reset: ChartReset | undefined): number | null {
  if (!reset?.previousResetAt) return null;
  const time = Date.parse(reset.previousResetAt);
  return Number.isFinite(time) ? time : null;
}

function absoluteResetTime(time: number): string {
  return new Date(time).toLocaleString([], {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short",
  });
}

function countdown(time: number, now: number): string {
  if (time - now < 60_000) return "in <1m";
  const totalMinutes = Math.ceil((time - now) / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  return `in ${[days ? `${days}d` : "", hours ? `${hours}h` : "", `${minutes}m`].filter(Boolean).join(" ")}`;
}

function resetDescription(reset: ChartReset | undefined, now: number): string {
  const time = resetTime(reset);
  if (time === null) return reset ? "Reset time unavailable" : "No current reset data";
  if (time <= now) return `Reported reset ${absoluteResetTime(time)} · awaiting update`;
  const previous = previousResetTime(reset);
  const cycleStart = previous !== null && previous < now ? `Cycle began ${absoluteResetTime(previous)} · ` : "";
  return `${cycleStart}Next reset ${absoluteResetTime(time)} · ${countdown(time, now)}`;
}

/**
 * A single, transparent pace estimate: net change between the first and last
 * observations in the currently observed reset cycle. It deliberately does
 * not infer a boundary from a nominal duration.
 */
export function cycleAverageTrend(
  series: ChartSeries,
  reset: ChartReset | undefined,
  now: number,
): CycleAverageTrend | null {
  if (series.scale !== "remaining-percent") return null;
  const previous = previousResetTime(reset);
  const next = resetTime(reset);
  if (previous === null || next === null || previous >= next || next <= now) return null;

  const reportedPace = reset?.cyclePace;
  if (reportedPace) {
    const firstObservedAt = Date.parse(reportedPace.firstObservedAt);
    const observedAt = Date.parse(reportedPace.latestObservedAt);
    if (
      Number.isFinite(firstObservedAt) &&
      Number.isFinite(observedAt) &&
      Number.isFinite(reportedPace.firstRemainingPercent) &&
      Number.isFinite(reportedPace.latestRemainingPercent) &&
      firstObservedAt >= previous &&
      firstObservedAt < observedAt &&
      observedAt <= now &&
      observedAt < next
    ) {
      const ratePerMs = (reportedPace.latestRemainingPercent - reportedPace.firstRemainingPercent) /
        (observedAt - firstObservedAt);
      return {
        firstObservedAt,
        firstValue: reportedPace.firstRemainingPercent,
        observedAt,
        observedValue: reportedPace.latestRemainingPercent,
        resetsAt: next,
        ratePerMs,
        projectedValue: reportedPace.latestRemainingPercent + ratePerMs * (next - observedAt),
      };
    }
  }

  const points = [...series.points]
    .sort(([left], [right]) => left - right)
    .filter(([time]) => time >= previous && time <= now && time < next);
  if (points.length < 2) return null;
  const first = points[0]!;
  const latest = points.at(-1)!;
  const elapsed = latest[0] - first[0];
  if (elapsed <= 0) return null;

  const ratePerMs = (latest[1] - first[1]) / elapsed;
  return {
    firstObservedAt: first[0],
    firstValue: first[1],
    observedAt: latest[0],
    observedValue: latest[1],
    resetsAt: next,
    ratePerMs,
    projectedValue: latest[1] + ratePerMs * (next - latest[0]),
  };
}

function trendValueAt(trend: CycleAverageTrend, time: number): number {
  return trend.observedValue + trend.ratePerMs * (time - trend.observedAt);
}

function visibleTrendEnd(
  trend: CycleAverageTrend,
  maxTime: number,
  minValue: number,
  maxValue: number,
): { time: number; value: number } {
  let time = Math.min(trend.resetsAt, maxTime);
  let value = trendValueAt(trend, time);
  if (trend.ratePerMs < 0 && value < minValue) {
    time = trend.observedAt + (minValue - trend.observedValue) / trend.ratePerMs;
    value = minValue;
  } else if (trend.ratePerMs > 0 && value > maxValue) {
    time = trend.observedAt + (maxValue - trend.observedValue) / trend.ratePerMs;
    value = maxValue;
  }
  return { time, value };
}

/**
 * Groups comparable measurements by both scale and provider-reported duration.
 * A percentage left in a five-hour session is not comparable to a weekly one.
 */
export function groupChartSeries(series: ChartSeries[]): ChartGroup[] {
  const groups = new Map<string, ChartGroup>();
  for (const item of series) {
    if (item.points.length === 0) continue;
    const scale = item.scale === "remaining-percent"
      ? "remaining-percent"
      : JSON.stringify([item.metric, item.unit ?? "value"]);
    const cycleSeconds = item.windowSeconds && item.windowSeconds > 0 ? item.windowSeconds : null;
    const key = JSON.stringify([scale, cycleSeconds]);
    const group = groups.get(key);
    if (group) group.series.push(item);
    else groups.set(key, { scale, cycleSeconds, series: [item] });
  }
  return [...groups.values()];
}

function hasCurrentCycleContext(
  series: ChartSeries[],
  resets: ChartReset[],
  now: number,
  cycleSeconds: number | null | undefined,
): cycleSeconds is number {
  if (!cycleSeconds || cycleSeconds <= 0) return false;
  const byId = new Map(resets.map((reset) => [reset.seriesId, reset]));
  return series.every((item) => {
    const next = resetTime(byId.get(item.seriesId));
    return next !== null && next > now;
  });
}

/**
 * A known reset cycle is intentionally rendered as two cycles of context and
 * one cycle of runway. That makes Now land at the same 2/3 position in every
 * cycle chart, instead of letting an unrelated future reset change its x-axis.
 */
export function chartTimeDomain(
  series: ChartSeries[],
  resets: ChartReset[],
  now: number,
  cycleSeconds?: number | null,
  rangeSeconds?: number,
): { min: number; max: number } {
  if (rangeSeconds && rangeSeconds > 0) {
    const durationMs = rangeSeconds * 1_000;
    const pastMs = durationMs * 2 / 3;
    return { min: now - pastMs, max: now + (durationMs - pastMs) };
  }
  if (hasCurrentCycleContext(series, resets, now, cycleSeconds)) {
    const durationMs = cycleSeconds * 1_000;
    return { min: now - 2 * durationMs, max: now + durationMs };
  }

  const times = series.flatMap((item) => item.points.map(([time]) => time));
  if (times.length === 0) return { min: now - HOUR, max: now };
  const min = Math.min(...times);
  const byId = new Map(resets.map((reset) => [reset.seriesId, reset]));
  const upcoming = series
    .map((item) => resetTime(byId.get(item.seriesId)))
    .filter((time): time is number => time !== null && time > now);
  const max = Math.max(...times, now, ...upcoming);
  return max > min ? { min, max } : { min: min - HOUR / 2, max: max + HOUR / 2 };
}

export function buildChartSvg(
  series: ChartSeries[],
  scale: string,
  resets: ChartReset[],
  now: number,
  cycleSeconds?: number | null,
  rangeSeconds?: number,
): string {
  const { min: minTime, max: maxTime } = chartTimeDomain(series, resets, now, cycleSeconds, rangeSeconds);
  const visibleSeries = series
    .map((item) => ({
      ...item,
      points: item.points.filter(([time]) => time >= minTime && time <= maxTime),
    }))
    .filter((item) => item.points.length > 0);
  const points = visibleSeries.flatMap((item) => item.points);
  if (points.length === 0) return "";
  const byId = new Map(resets.map((reset) => [reset.seriesId, reset]));
  const hasCycleContext = hasCurrentCycleContext(series, resets, now, cycleSeconds);
  const showCycleContext = hasCycleContext &&
    (!rangeSeconds || rangeSeconds >= (cycleSeconds! * 3));
  const upcoming = series.flatMap((item, index) => {
    const time = resetTime(byId.get(item.seriesId));
    return time !== null && time > now ? [{ item, index, time }] : [];
  });
  const width = 900;
  const padding = { top: 30 + upcoming.length * 24, right: 16, bottom: 34, left: 52 };
  const plotHeight = 194;
  const height = padding.top + plotHeight + padding.bottom;
  const plotWidth = width - padding.left - padding.right;
  const timeSpan = Math.max(1, maxTime - minTime);
  const values = points.map(([, value]) => value);
  const percentScale = scale === "remaining-percent";
  const rawMin = percentScale ? 0 : Math.min(...values);
  const rawMax = percentScale ? 100 : Math.max(...values);
  const margin = percentScale ? 0 : Math.max(1, (rawMax - rawMin) * 0.08);
  const minValue = percentScale ? 0 : Math.min(0, rawMin - margin);
  const maxValue = percentScale ? 100 : rawMax + margin;
  const valueSpan = Math.max(1, maxValue - minValue);
  const x = (time: number): number => padding.left + ((time - minTime) / timeSpan) * plotWidth;
  const y = (value: number): number => padding.top + (1 - (value - minValue) / valueSpan) * plotHeight;
  const plotBottom = padding.top + plotHeight;
  const plotRight = width - padding.right;
  const levels = Array.from({ length: 5 }, (_, index) => minValue + (valueSpan * index) / 4);
  const grid = levels.map((level) =>
    `<line x1="${padding.left}" y1="${y(level)}" x2="${plotRight}" y2="${y(level)}" stroke="currentColor" stroke-opacity="0.15" />` +
    `<text x="${padding.left - 8}" y="${y(level) + 4}" text-anchor="end" class="axis-label">${escapeHtml(formatNumber(level))}</text>`,
  ).join("");
  const future = maxTime <= now || upcoming.length === 0 ? "" :
    `<rect x="${x(now)}" y="${padding.top}" width="${plotRight - x(now)}" height="${plotHeight}" class="future-area" />` +
    `<line x1="${x(now)}" y1="${padding.top}" x2="${x(now)}" y2="${plotBottom}" class="now-line" />` +
    `<text x="${x(now)}" y="${padding.top - 10}" text-anchor="middle" class="axis-label">Now</text>`;
  const resetLines = upcoming.map(({ index, time }) => time > maxTime ? "" :
    `<line data-reset-at="${time}" x1="${x(time)}" y1="${padding.top}" x2="${x(time)}" y2="${plotBottom}" stroke="${PALETTE[index % PALETTE.length]}" stroke-width="1.5" stroke-dasharray="5 5" />`,
  ).join("");
  const previousResetLines = upcoming.map(({ item, index }) => {
    const time = previousResetTime(byId.get(item.seriesId));
    if (time === null || time < minTime || time > maxTime) return "";
    return `<line data-previous-reset-at="${time}" x1="${x(time)}" y1="${padding.top}" x2="${x(time)}" y2="${plotBottom}" class="previous-reset-line" stroke="${PALETTE[index % PALETTE.length]}" />`;
  }).join("");
  const resetLabels = upcoming.map(({ item, index, time }, lane) => {
    const outside = time > maxTime;
    const markerX = outside ? plotRight : x(time);
    const labelWidth = 184;
    const labelX = Math.min(plotRight - labelWidth, Math.max(padding.left, markerX - labelWidth / 2));
    const labelY = 6 + lane * 24;
    const text = `${index + 1} · ${formatAxisTime(time)}${outside ? " →" : ""}`;
    const description = `${seriesLabel(item)}: ${resetDescription(byId.get(item.seriesId), now)}${outside ? "; beyond the visible time axis" : ""}`;
    return `<g class="reset-marker" aria-label="${escapeHtml(description)}">
      <title>${escapeHtml(description)}</title>
      ${outside ? "" : `<path d="M${markerX},${labelY + 20} V${padding.top}" stroke="${PALETTE[index % PALETTE.length]}" stroke-opacity="0.4" fill="none" />`}
      <rect x="${labelX}" y="${labelY}" width="${labelWidth}" height="20" rx="4" class="reset-label-bg" stroke="${PALETTE[index % PALETTE.length]}" />
      <text x="${labelX + 8}" y="${labelY + 14}" class="reset-label">${escapeHtml(text)}</text>
    </g>`;
  }).join("");
  const polylines = visibleSeries.map((item, index) => {
    const sorted = [...item.points].sort(([left], [right]) => left - right);
    const path = sorted.map(([timestamp, value]) => `${x(timestamp).toFixed(1)},${y(value).toFixed(1)}`).join(" ");
    return `<polyline points="${path}" fill="none" stroke="${PALETTE[index % PALETTE.length]}" stroke-width="2" stroke-linejoin="round" />`;
  }).join("");
  const averagePaceLines = !showCycleContext ? "" : visibleSeries.map((item, index) => {
    const trend = cycleAverageTrend(item, byId.get(item.seriesId), now);
    if (!trend) return "";
    const end = visibleTrendEnd(trend, maxTime, minValue, maxValue);
    if (end.time <= trend.observedAt) return "";
    const depletes = trend.projectedValue <= 0 ? " average-pace-depleting" : "";
    return `<line data-average-pace-to="${trend.resetsAt}" x1="${x(trend.observedAt).toFixed(1)}" y1="${y(trend.observedValue).toFixed(1)}" x2="${x(end.time).toFixed(1)}" y2="${y(end.value).toFixed(1)}" class="average-pace${depletes}" stroke="${PALETTE[index % PALETTE.length]}" />`;
  }).join("");
  const timeLabels = `<text x="${padding.left}" y="${height - 8}" class="axis-label">${escapeHtml(formatAxisTime(minTime))}</text>
    <text x="${plotRight}" y="${height - 8}" text-anchor="end" class="axis-label">${escapeHtml(formatAxisTime(maxTime))}</text>`;
  const description = series.map((item) => {
    const trend = cycleAverageTrend(item, byId.get(item.seriesId), now);
    const pace = !trend
      ? ""
      : trend.projectedValue <= 0
      ? "; average pace reaches zero by the next reset"
      : `; average pace projects ${formatNumber(trend.projectedValue)}% remaining at the next reset`;
    return `${seriesLabel(item)}: ${resetDescription(byId.get(item.seriesId), now)}${pace}`;
  }).join(". ");
  return `<svg class="usage-chart" role="img" aria-label="Usage history, resets, and current-cycle average pace" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
    <title>Usage history, resets, and current-cycle average pace</title><desc>${escapeHtml(description)}</desc>
    ${future}${grid}${previousResetLines}${resetLines}${polylines}${averagePaceLines}${resetLabels}${timeLabels}
  </svg>`;
}

export function buildLegend(series: ChartSeries[], resets: ChartReset[], now: number): string {
  const byId = new Map(resets.map((reset) => [reset.seriesId, reset]));
  return series.map((item, index) => {
    const reset = byId.get(item.seriesId);
    const time = resetTime(reset);
    const detail = escapeHtml(resetDescription(reset, now));
    return `<div class="legend-item" role="listitem">
      <span class="legend-series"><span class="swatch" style="background:${PALETTE[index % PALETTE.length]}" aria-hidden="true">${index + 1}</span>${escapeHtml(seriesLabel(item))}</span>
      <span class="reset-detail${time !== null && time > now ? " reset-upcoming" : ""}">${detail}</span>
    </div>`;
  }).join("");
}
