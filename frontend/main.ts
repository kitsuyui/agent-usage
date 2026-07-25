// Dependency-free dashboard: bounded history queries, per-unit charts, and a
// next-resets table. The API downsamples each logical series before rendering.

interface ProviderInfo {
  id: string;
  displayName: string;
  hasData: boolean;
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
  observedAt: string;
  remainingPercent: number | null;
  usedPercent: number | null;
  resetsRaw: string | null;
  resetsAt: string | null;
}

type NextReset = Omit<HistoryPoint, "observedAt" | "resetsRaw">;

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
  if (!resetsEl || !chartsEl) return;

  try {
    const [providers, resets] = await Promise.all([
      fetchJson<ProviderInfo[]>("/api/providers"),
      fetchJson<NextReset[]>("/api/usage/next-resets"),
    ]);
    renderResets(resetsEl, resets);

    const withData = providers.filter((provider) => provider.hasData);
    const historyEntries = await Promise.all(
      withData.map(async (provider) => {
        const query = new URLSearchParams({
          provider: provider.id,
          range: selectedRange,
          limit: String(HISTORY_LIMIT),
          maxPoints: String(MAX_POINTS_PER_SERIES),
        });
        return [provider.id, await fetchJson<HistoryPoint[]>(`/api/usage/history?${query}`)] as const;
      }),
    );
    renderCharts(chartsEl, providers, new Map(historyEntries), HISTORY_RANGES[selectedRange]);
  } catch (error) {
    console.error(error);
  }
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
  historyByProvider: Map<string, HistoryPoint[]>,
  rangeLabel: string,
): void {
  const withData = providers.filter((provider) => provider.hasData);
  if (withData.length === 0) {
    container.innerHTML = card("Usage history", '<p class="empty-state">No providers have recorded data yet.</p>');
    return;
  }
  container.innerHTML = withData
    .map((provider) => {
      const points = historyByProvider.get(provider.id) ?? [];
      const groups = groupByScale(points);
      const body =
        groups.size === 0
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

function groupByScale(points: HistoryPoint[]): Map<string, HistoryPoint[]> {
  const groups = new Map<string, HistoryPoint[]>();
  for (const point of points) {
    if (measurementValue(point) === null) continue;
    const key = scaleKey(point);
    const group = groups.get(key);
    if (group) group.push(point);
    else groups.set(key, [point]);
  }
  return groups;
}

function scaleKey(point: HistoryPoint): string {
  if (percentRemainingOf(point) !== null) return "remaining-percent";
  return JSON.stringify([point.metric ?? "quota", point.unit ?? "value"]);
}

function scaleLabel(point: HistoryPoint, scale: string): string {
  if (scale === "remaining-percent") return "Quota remaining (%)";
  return `${point.metric ?? "Usage"} (${point.unit ?? "value"})`;
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

function seriesKey(point: HistoryPoint): string {
  return (
    point.seriesId ??
    JSON.stringify([
      point.provider,
      point.scope ?? "",
      point.window.toLowerCase(),
      point.windowSeconds,
      point.metric ?? "quota",
      point.unit ?? "",
      Object.entries(point.attributes ?? {}).sort(([left], [right]) => left.localeCompare(right)),
    ])
  );
}

function seriesLabel(point: HistoryPoint): string {
  const parts = [scopeLabel(point), point.window];
  const attributes = Object.entries(point.attributes ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`);
  return [...parts, ...attributes].filter((part) => part !== "—").join(" · ");
}

function buildChartSvg(points: HistoryPoint[], scale: string): string {
  if (points.length === 0) return "";
  const width = 900;
  const height = 240;
  const padding = { top: 12, right: 12, bottom: 34, left: 52 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const values = points.map(measurementValue).filter((value): value is number => value !== null);
  const times = points.map((point) => new Date(point.observedAt).getTime());
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

  const series = new Map<string, HistoryPoint[]>();
  for (const point of points) {
    const key = seriesKey(point);
    const list = series.get(key);
    if (list) list.push(point);
    else series.set(key, [point]);
  }
  const polylines = [...series.values()]
    .map((list, index) => {
      const sorted = [...list].sort((a, b) => a.observedAt.localeCompare(b.observedAt));
      const path = sorted
        .map((point) => {
          const value = measurementValue(point);
          return value === null ? "" : `${x(new Date(point.observedAt).getTime()).toFixed(1)},${y(value).toFixed(1)}`;
        })
        .filter(Boolean)
        .join(" ");
      return `<polyline points="${path}" fill="none" stroke="${PALETTE[index % PALETTE.length]}" stroke-width="2" stroke-linejoin="round" />`;
    })
    .join("");
  const timeLabels = `<text x="${padding.left}" y="${height - 8}" font-size="9" fill="currentColor" fill-opacity="0.55">${escapeHtml(formatAxisTime(minTime))}</text>
    <text x="${width - padding.right}" y="${height - 8}" text-anchor="end" font-size="9" fill="currentColor" fill-opacity="0.55">${escapeHtml(formatAxisTime(maxTime))}</text>`;
  return `<svg class="usage-chart" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">${gridLines}${polylines}${timeLabels}</svg>`;
}

function buildLegend(points: HistoryPoint[]): string {
  const representatives = new Map<string, HistoryPoint>();
  for (const point of points) representatives.set(seriesKey(point), point);
  return [...representatives.values()]
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
