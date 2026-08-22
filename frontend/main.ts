// Dependency-free dashboard: bounded history queries, per-unit charts, and a
// next-resets table. The API downsamples each logical series before rendering.

interface ProviderInfo {
  id: string;
  displayName: string;
  hasData: boolean;
  status: "healthy" | "failing" | "stale" | "no_data";
  latestOk: boolean | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  consecutiveFailures: number;
  stale: boolean;
  errorCode: string | null;
  error: string | null;
  cliVersion: string | null;
}

interface HistoryPoint {
  provider: string;
  seriesId?: string;
  scope: string | null;
  window: string;
  windowSeconds: number | null;
  metric?: string;
  unit?: string | null;
  value?: number | null;
  limitValue?: number | null;
  remainingValue?: number | null;
  usedValue?: number | null;
  attributes?: Record<string, string>;
  cliVersion?: string | null;
  observedAt: string;
  remainingPercent: number | null;
  usedPercent: number | null;
  resetsRaw: string | null;
  resetsAt: string | null;
}

type NextReset = Omit<HistoryPoint, "observedAt" | "resetsRaw">;

interface ChartSeries {
  provider: string;
  scope: string | null;
  window: string;
  metric: string;
  unit: string | null;
  attributes: Record<string, string>;
  scale: "remaining-percent" | "value";
  points: [timestampMs: number, value: number][];
}

const PALETTE = ["#6ea8fe", "#7ee7a8", "#f2b56b", "#f28b82", "#c792ea", "#7fd4d4", "#e6a4c4", "#a3be8c"];
const REFRESH_MS = 60_000;
const MAX_POINTS_PER_SERIES = 480;
const HISTORY_LIMIT = 100_000;
const HISTORY_RANGES = {
  "10h": "10 hours",
  "14d": "14 days",
  "30d": "30 days",
  "90d": "90 days",
} as const;
type HistoryRange = keyof typeof HISTORY_RANGES;

let selectedRange: HistoryRange = initialRange();
let renderedRange: HistoryRange | null = null;

async function main(): Promise<void> {
  const rangeSelect = document.getElementById("history-range");
  if (rangeSelect instanceof HTMLSelectElement) {
    rangeSelect.value = selectedRange;
    rangeSelect.addEventListener("change", () => {
      if (!isHistoryRange(rangeSelect.value)) return;
      selectedRange = rangeSelect.value;
      const url = new URL(window.location.href);
      url.searchParams.set("range", selectedRange);
      window.history.replaceState(null, "", url);
      void refresh();
    });
  }
  await refresh();
  setInterval(() => void refresh(), REFRESH_MS);
}

async function refresh(): Promise<void> {
  const resetsEl = document.getElementById("resets");
  const chartsEl = document.getElementById("charts");
  const collectorsEl = document.getElementById("collectors");
  if (!resetsEl || !chartsEl || !collectorsEl) return;

  try {
    const [providers, resets] = await Promise.all([
      fetchJson<ProviderInfo[]>("/api/providers"),
      fetchJson<NextReset[]>("/api/usage/next-resets"),
    ]);
    renderCollectors(collectorsEl, providers);
    renderResets(resetsEl, resets);

    const withData = providers.filter((provider) => provider.hasData);
    if (renderedRange !== selectedRange || chartsEl.children.length === 0) {
      chartsEl.innerHTML = withData
        .map((provider) => card(provider.displayName, '<p class="empty-state">Loading chart data…</p>'))
        .join("");
    }
    const chartResults = await Promise.allSettled(
      withData.map(async (provider) => {
        const query = new URLSearchParams({
          provider: provider.id,
          range: selectedRange,
          limit: String(HISTORY_LIMIT),
          maxPoints: String(MAX_POINTS_PER_SERIES),
        });
        return [provider.id, await fetchJson<ChartSeries[]>(`/api/usage/chart?${query}`)] as const;
      }),
    );
    const chartsByProvider = new Map<string, ChartSeries[]>();
    const errorsByProvider = new Set<string>();
    for (const result of chartResults) {
      if (result.status === "fulfilled") {
        const [providerId, series] = result.value;
        chartsByProvider.set(providerId, series);
      } else {
        console.error(result.reason);
      }
    }
    chartResults.forEach((result, index) => {
      if (result.status === "rejected") errorsByProvider.add(withData[index]!.id);
    });
    renderCharts(chartsEl, providers, chartsByProvider, errorsByProvider, HISTORY_RANGES[selectedRange]);
    renderedRange = selectedRange;
  } catch (error) {
    console.error(error);
  }
}

function renderCollectors(container: HTMLElement, providers: ProviderInfo[]): void {
  const rows = providers
    .map(
      (provider) => `<tr>
        <td>${escapeHtml(provider.displayName)}</td>
        <td><span class="status status-${escapeHtml(provider.status)}">${escapeHtml(statusLabel(provider.status))}</span></td>
        <td><code>${escapeHtml(provider.cliVersion ?? "Unavailable")}</code></td>
        <td>${formatTimestamp(provider.lastAttemptAt)}</td>
        <td>${formatTimestamp(provider.lastSuccessAt)}</td>
        <td>${provider.consecutiveFailures || "—"}</td>
        <td class="error-detail">${escapeHtml(provider.errorCode ?? provider.error ?? "—")}</td>
      </tr>`,
    )
    .join("");
  container.innerHTML = card(
    "Collector status",
    `<div class="table-scroll"><table>
      <thead><tr><th>Provider</th><th>Status</th><th>CLI version</th><th>Last attempt</th><th>Last success</th><th>Failures</th><th>Error</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`,
  );
}

function statusLabel(status: ProviderInfo["status"]): string {
  return status === "no_data" ? "No data" : status[0]!.toUpperCase() + status.slice(1);
}

function formatTimestamp(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "—";
}

async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`request failed: ${path} (${response.status})`);
  return (await response.json()) as T;
}

function renderResets(container: HTMLElement, resets: NextReset[]): void {
  if (resets.length === 0) {
    container.innerHTML = card("Current limits", '<p class="empty-state">No data recorded yet.</p>');
    return;
  }
  const rows = resets
    .map(
      (reset) => `<tr>
        <td>${escapeHtml(reset.provider)}</td>
        <td>${escapeHtml(scopeLabel(reset))}</td>
        <td>${escapeHtml(reset.window)}</td>
        <td>${escapeHtml(metricLabel(reset))}</td>
        <td class="${remainingClass(reset)}">${escapeHtml(remainingLabel(reset))}</td>
        <td>${formatResetsAt(reset.resetsAt)}</td>
      </tr>`,
    )
    .join("");
  container.innerHTML = card(
    "Current limits",
    `<div class="table-scroll"><table>
      <thead><tr><th>Provider</th><th>Scope</th><th>Window</th><th>Metric</th><th>Remaining</th><th>Resets</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`,
  );
}

function renderCharts(
  container: HTMLElement,
  providers: ProviderInfo[],
  chartsByProvider: Map<string, ChartSeries[]>,
  errorsByProvider: Set<string>,
  rangeLabel: string,
): void {
  const withData = providers.filter((provider) => provider.hasData);
  if (withData.length === 0) {
    container.innerHTML = card("Usage history", '<p class="empty-state">No providers have recorded data yet.</p>');
    return;
  }
  container.innerHTML = withData
    .map((provider) => {
      const series = chartsByProvider.get(provider.id) ?? [];
      const groups = groupByScale(series);
      const body =
        errorsByProvider.has(provider.id)
          ? '<p class="empty-state">Chart data could not be loaded.</p>'
          : groups.size === 0
          ? '<p class="empty-state">No chartable data in this range.</p>'
          : [...groups.entries()]
              .map(([scale, group]) => {
                const svg = buildChartSvg(group, scale);
                return `<section class="chart-group">
                  <div class="chart-heading"><span>${escapeHtml(scaleLabel(group[0]!, scale))}</span><span>${escapeHtml(rangeLabel)}</span></div>
                  ${svg}
                  <div class="chart-legend">${buildLegend(group)}</div>
                </section>`;
              })
              .join("");
      return card(provider.displayName, body);
    })
    .join("");
}

function card(title: string, body: string): string {
  return `<div class="card"><h2>${escapeHtml(title)}</h2>${body}</div>`;
}

function groupByScale(series: ChartSeries[]): Map<string, ChartSeries[]> {
  const groups = new Map<string, ChartSeries[]>();
  for (const item of series) {
    if (item.points.length === 0) continue;
    const key = scaleKey(item);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return groups;
}

function scaleKey(series: ChartSeries): string {
  if (series.scale === "remaining-percent") return "remaining-percent";
  return JSON.stringify([series.metric, series.unit ?? "value"]);
}

function scaleLabel(series: ChartSeries, scale: string): string {
  if (scale === "remaining-percent") return "Quota remaining (%)";
  return `${series.metric} (${series.unit ?? "value"})`;
}

function percentRemainingOf(point: { remainingPercent: number | null; usedPercent: number | null }): number | null {
  if (point.remainingPercent !== null) return point.remainingPercent;
  if (point.usedPercent !== null) return 100 - point.usedPercent;
  return null;
}

function measurementValue(point: HistoryPoint): number | null {
  const percent = percentRemainingOf(point);
  if (percent !== null) return percent;
  if (point.value != null) return point.value;
  if (point.remainingValue != null) return point.remainingValue;
  if (point.limitValue != null && point.usedValue != null) return point.limitValue - point.usedValue;
  if (point.usedValue != null) return point.usedValue;
  return point.limitValue ?? null;
}

function seriesLabel(series: ChartSeries): string {
  const parts = [scopeLabel(series), series.window];
  const attributes = Object.entries(series.attributes)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`);
  return [...parts, ...attributes].filter((part) => part !== "—").join(" · ");
}

function buildChartSvg(series: ChartSeries[], scale: string): string {
  if (series.length === 0) return "";
  const width = 900;
  const height = 240;
  const padding = { top: 12, right: 12, bottom: 34, left: 52 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const points = series.flatMap((item) => item.points);
  const values = points.map(([, value]) => value);
  const times = points.map(([timestamp]) => timestamp);
  const minTime = Math.min(...times);
  const maxTime = Math.max(...times);
  const timeSpan = Math.max(1, maxTime - minTime);
  const percentScale = scale === "remaining-percent";
  const rawMin = percentScale ? 0 : Math.min(...values);
  const rawMax = percentScale ? 100 : Math.max(...values);
  const margin = percentScale ? 0 : Math.max(1, (rawMax - rawMin) * 0.08);
  const minValue = percentScale ? 0 : Math.min(0, rawMin - margin);
  const maxValue = percentScale ? 100 : rawMax + margin;
  const valueSpan = Math.max(1, maxValue - minValue);
  const x = (time: number): number => padding.left + ((time - minTime) / timeSpan) * plotWidth;
  const y = (value: number): number => padding.top + (1 - (value - minValue) / valueSpan) * plotHeight;
  const levels = Array.from({ length: 5 }, (_, index) => minValue + (valueSpan * index) / 4);
  const gridLines = levels
    .map(
      (level) =>
        `<line x1="${padding.left}" y1="${y(level)}" x2="${width - padding.right}" y2="${y(level)}" stroke="currentColor" stroke-opacity="0.15" />` +
        `<text x="${padding.left - 6}" y="${y(level) + 3}" text-anchor="end" font-size="9" fill="currentColor" fill-opacity="0.55">${escapeHtml(formatNumber(level))}</text>`,
    )
    .join("");

  const polylines = series
    .map((item, index) => {
      const sorted = [...item.points].sort(([left], [right]) => left - right);
      const path = sorted
        .map(([timestamp, value]) => `${x(timestamp).toFixed(1)},${y(value).toFixed(1)}`)
        .join(" ");
      return `<polyline points="${path}" fill="none" stroke="${PALETTE[index % PALETTE.length]}" stroke-width="2" stroke-linejoin="round" />`;
    })
    .join("");
  const timeLabels = `<text x="${padding.left}" y="${height - 8}" font-size="9" fill="currentColor" fill-opacity="0.55">${escapeHtml(formatAxisTime(minTime))}</text>
    <text x="${width - padding.right}" y="${height - 8}" text-anchor="end" font-size="9" fill="currentColor" fill-opacity="0.55">${escapeHtml(formatAxisTime(maxTime))}</text>`;
  return `<svg class="usage-chart" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">${gridLines}${polylines}${timeLabels}</svg>`;
}

function buildLegend(series: ChartSeries[]): string {
  return series
    .map(
      (point, index) =>
        `<span><span class="swatch" style="background:${PALETTE[index % PALETTE.length]}"></span>${escapeHtml(seriesLabel(point))}</span>`,
    )
    .join("");
}

function scopeLabel(point: { scope: string | null; attributes?: Record<string, string> }): string {
  return point.scope ?? point.attributes?.model ?? point.attributes?.tier ?? "—";
}

function metricLabel(point: { metric?: string; unit?: string | null }): string {
  const metric = point.metric ?? "quota";
  return point.unit && point.unit !== "percent" ? `${metric} (${point.unit})` : metric;
}

function remainingLabel(point: HistoryPoint | NextReset): string {
  const percent = percentRemainingOf(point);
  if (percent !== null) return `${percent.toFixed(0)}%`;
  const value = measurementValue(point as HistoryPoint);
  if (value === null) return "—";
  return `${formatNumber(value)}${point.unit ? ` ${point.unit}` : ""}`;
}

function remainingClass(point: HistoryPoint | NextReset): string {
  const percent = percentRemainingOf(point);
  return percent !== null && percent < 15 ? "remaining-low" : "remaining-ok";
}

function formatResetsAt(resetsAt: string | null): string {
  if (!resetsAt) return "—";
  const target = new Date(resetsAt);
  const diffMs = target.getTime() - Date.now();
  const absolute = target.toLocaleString();
  if (diffMs <= 0) return `${absolute} (past)`;
  const totalMinutes = Math.round(diffMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${absolute} (${hours > 0 ? `in ${hours}h ${minutes}m` : `in ${minutes}m`})`;
}

function formatAxisTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2, notation: Math.abs(value) >= 10_000 ? "compact" : "standard" }).format(value);
}

function initialRange(): HistoryRange {
  const candidate = new URL(window.location.href).searchParams.get("range");
  return candidate && isHistoryRange(candidate) ? candidate : "14d";
}

function isHistoryRange(value: string): value is HistoryRange {
  return value in HISTORY_RANGES;
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

void main();
