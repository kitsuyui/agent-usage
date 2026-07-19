// Minimal, dependency-free dashboard: fetches the HTTP API and renders a
// hand-rolled SVG line chart per provider plus a next-resets table.

interface ProviderInfo {
  id: string;
  displayName: string;
  hasData: boolean;
}

interface HistoryPoint {
  provider: string;
  scope: string | null;
  window: string;
  windowSeconds: number | null;
  observedAt: string;
  remainingPercent: number | null;
  usedPercent: number | null;
  resetsRaw: string | null;
  resetsAt: string | null;
}

interface NextReset {
  provider: string;
  scope: string | null;
  window: string;
  windowSeconds: number | null;
  resetsAt: string | null;
  remainingPercent: number | null;
  usedPercent: number | null;
}

const PALETTE = ["#6ea8fe", "#7ee7a8", "#f2b56b", "#f28b82", "#c792ea", "#7fd4d4", "#e6a4c4", "#a3be8c"];
const REFRESH_MS = 60_000;

async function main(): Promise<void> {
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
      withData.map(
        async (provider) =>
          [provider.id, await fetchJson<HistoryPoint[]>(`/api/usage/history?provider=${encodeURIComponent(provider.id)}`)] as const,
      ),
    );
    renderCharts(chartsEl, providers, new Map(historyEntries));
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
    container.innerHTML = card("Next resets", '<p class="empty-state">No data recorded yet.</p>');
    return;
  }
  const rows = resets
    .map((reset) => {
      const percent = percentRemainingOf(reset);
      const percentClass = percent !== null && percent < 15 ? "remaining-low" : "remaining-ok";
      const percentLabel = percent !== null ? `${percent.toFixed(0)}%` : "—";
      return `<tr>
        <td>${escapeHtml(reset.provider)}</td>
        <td>${escapeHtml(reset.scope ?? "—")}</td>
        <td>${escapeHtml(reset.window)}</td>
        <td class="${percentClass}">${percentLabel}</td>
        <td>${formatResetsAt(reset.resetsAt)}</td>
      </tr>`;
    })
    .join("");
  container.innerHTML = card(
    "Next resets",
    `<table>
      <thead><tr><th>Provider</th><th>Scope</th><th>Window</th><th>Remaining</th><th>Resets</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`,
  );
}

function renderCharts(container: HTMLElement, providers: ProviderInfo[], historyByProvider: Map<string, HistoryPoint[]>): void {
  const withData = providers.filter((provider) => provider.hasData);
  if (withData.length === 0) {
    container.innerHTML = card("Usage history", '<p class="empty-state">No providers have recorded data yet.</p>');
    return;
  }
  container.innerHTML = withData
    .map((provider) => {
      const points = historyByProvider.get(provider.id) ?? [];
      const svg = buildChartSvg(points);
      const body = svg
        ? `${svg}<div class="chart-legend">${buildLegend(points)}</div>`
        : '<p class="empty-state">Not enough data to chart yet.</p>';
      return card(provider.displayName, body);
    })
    .join("");
}

function card(title: string, body: string): string {
  return `<div class="card"><h2>${escapeHtml(title)}</h2>${body}</div>`;
}

function percentRemainingOf(point: { remainingPercent: number | null; usedPercent: number | null }): number | null {
  if (point.remainingPercent !== null) return point.remainingPercent;
  if (point.usedPercent !== null) return 100 - point.usedPercent;
  return null;
}

function seriesKey(point: HistoryPoint): string {
  return [point.provider, point.scope ?? "", point.window].join(":");
}

function seriesLabel(key: string): string {
  const [, scope, windowLabel] = key.split(":");
  return scope ? `${scope} · ${windowLabel}` : (windowLabel ?? key);
}

function buildChartSvg(points: HistoryPoint[]): string {
  const usable = points.filter((point) => percentRemainingOf(point) !== null);
  if (usable.length === 0) return "";

  const width = 900;
  const height = 220;
  const padding = { top: 12, right: 12, bottom: 20, left: 30 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;

  const times = usable.map((point) => new Date(point.observedAt).getTime());
  const minTime = Math.min(...times);
  const maxTime = Math.max(...times);
  const timeSpan = Math.max(1, maxTime - minTime);

  const x = (time: number): number => padding.left + ((time - minTime) / timeSpan) * plotWidth;
  const y = (percent: number): number => padding.top + (1 - percent / 100) * plotHeight;

  const series = new Map<string, HistoryPoint[]>();
  for (const point of usable) {
    const key = seriesKey(point);
    const list = series.get(key);
    if (list) list.push(point);
    else series.set(key, [point]);
  }

  const gridLines = [0, 25, 50, 75, 100]
    .map(
      (level) =>
        `<line x1="${padding.left}" y1="${y(level)}" x2="${width - padding.right}" y2="${y(level)}" stroke="currentColor" stroke-opacity="0.15" />` +
        `<text x="${padding.left - 4}" y="${y(level) + 3}" text-anchor="end" font-size="9" fill="currentColor" fill-opacity="0.55">${level}</text>`,
    )
    .join("");

  const polylines = [...series.values()]
    .map((list, index) => {
      const color = PALETTE[index % PALETTE.length];
      const sorted = [...list].sort((a, b) => new Date(a.observedAt).getTime() - new Date(b.observedAt).getTime());
      const path = sorted
        .map((point) => {
          const percent = percentRemainingOf(point);
          return percent === null ? "" : `${x(new Date(point.observedAt).getTime()).toFixed(1)},${y(percent).toFixed(1)}`;
        })
        .filter(Boolean)
        .join(" ");
      return `<polyline points="${path}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" />`;
    })
    .join("");

  return `<svg class="usage-chart" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">${gridLines}${polylines}</svg>`;
}

function buildLegend(points: HistoryPoint[]): string {
  const keys = [...new Set(points.map(seriesKey))];
  return keys
    .map((key, index) => {
      const color = PALETTE[index % PALETTE.length];
      return `<span><span class="swatch" style="background:${color}"></span>${escapeHtml(seriesLabel(key))}</span>`;
    })
    .join("");
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
  const relative = hours > 0 ? `in ${hours}h ${minutes}m` : `in ${minutes}m`;
  return `${absolute} (${relative})`;
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
