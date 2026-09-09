import { escapeHtml, formatAxisTime, formatNumber, scopeLabel } from "./format.ts";

export interface ChartSeries {
  seriesId: string;
  provider: string;
  scope: string | null;
  window: string;
  metric: string;
  unit: string | null;
  attributes: Record<string, string>;
  scale: "remaining-percent" | "value";
  points: [timestampMs: number, value: number][];
}

export interface ChartReset {
  seriesId: string;
  resetsAt: string | null;
}

const PALETTE = ["#6ea8fe", "#7ee7a8", "#f2b56b", "#f28b82", "#c792ea", "#7fd4d4", "#e6a4c4", "#a3be8c"];
const HOUR = 3_600_000;

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
  return `Next reset ${absoluteResetTime(time)} · ${countdown(time, now)}`;
}

/** Keep nearby resets on the time axis without letting a distant reset squash the history. */
export function chartTimeDomain(series: ChartSeries[], resets: ChartReset[], now: number): { min: number; max: number } {
  const times = series.flatMap((item) => item.points.map(([time]) => time));
  const min = Math.min(now - HOUR, ...times);
  const byId = new Map(resets.map((reset) => [reset.seriesId, reset]));
  const upcoming = series.map((item) => resetTime(byId.get(item.seriesId))).filter((time): time is number => time !== null && time > now);
  const futureBudget = (now - min) / 2;
  const max = upcoming.length === 0
    ? now
    : Math.min(now + futureBudget, Math.max(...upcoming) + futureBudget * 0.08);
  return { min, max };
}

export function buildChartSvg(series: ChartSeries[], scale: string, resets: ChartReset[], now: number): string {
  const points = series.flatMap((item) => item.points);
  if (points.length === 0) return "";
  const byId = new Map(resets.map((reset) => [reset.seriesId, reset]));
  const upcoming = series.flatMap((item, index) => {
    const time = resetTime(byId.get(item.seriesId));
    return time !== null && time > now ? [{ item, index, time }] : [];
  });
  const width = 900;
  const padding = { top: 30 + upcoming.length * 24, right: 16, bottom: 34, left: 52 };
  const plotHeight = 194;
  const height = padding.top + plotHeight + padding.bottom;
  const plotWidth = width - padding.left - padding.right;
  const { min: minTime, max: maxTime } = chartTimeDomain(series, resets, now);
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
  const future = upcoming.length === 0 ? "" :
    `<rect x="${x(now)}" y="${padding.top}" width="${plotRight - x(now)}" height="${plotHeight}" class="future-area" />` +
    `<line x1="${x(now)}" y1="${padding.top}" x2="${x(now)}" y2="${plotBottom}" class="now-line" />` +
    `<text x="${x(now)}" y="${padding.top - 10}" text-anchor="middle" class="axis-label">Now</text>`;
  const resetLines = upcoming.map(({ index, time }) => time > maxTime ? "" :
    `<line data-reset-at="${time}" x1="${x(time)}" y1="${padding.top}" x2="${x(time)}" y2="${plotBottom}" stroke="${PALETTE[index % PALETTE.length]}" stroke-width="1.5" stroke-dasharray="5 5" />`,
  ).join("");
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
  const polylines = series.map((item, index) => {
    const sorted = [...item.points].sort(([left], [right]) => left - right);
    const path = sorted.map(([timestamp, value]) => `${x(timestamp).toFixed(1)},${y(value).toFixed(1)}`).join(" ");
    return `<polyline points="${path}" fill="none" stroke="${PALETTE[index % PALETTE.length]}" stroke-width="2" stroke-linejoin="round" />`;
  }).join("");
  const timeLabels = `<text x="${padding.left}" y="${height - 8}" class="axis-label">${escapeHtml(formatAxisTime(minTime))}</text>
    <text x="${plotRight}" y="${height - 8}" text-anchor="end" class="axis-label">${escapeHtml(formatAxisTime(maxTime))}</text>`;
  const description = series.map((item) => `${seriesLabel(item)}: ${resetDescription(byId.get(item.seriesId), now)}`).join(". ");
  return `<svg class="usage-chart" role="img" aria-label="Usage history and reported next resets" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
    <title>Usage history and reported next resets</title><desc>${escapeHtml(description)}</desc>
    ${future}${grid}${resetLines}${polylines}${resetLabels}${timeLabels}
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
