import type { CreditBalance, CreditExpiry } from "../src/domain/credit-balances.ts";
import { escapeHtml, formatAxisTime, formatNumber } from "./format.ts";

export interface BalanceProvider {
  id: string;
  displayName: string;
  latestOk: boolean | null;
  lastAttemptAt: string | null;
  stale: boolean;
  creditBalances: CreditBalance[] | null;
  sampleIntervalSeconds?: number;
}

export interface BalanceObservation {
  observedAt: string;
  ok: boolean;
  creditBalances: CreditBalance[] | null;
}

export interface ExpiryEvent { at: number; amount: number }
export interface BalancePace { perMs: number; depletedAt: number; observedAt: number }

const timestamp = (value: string): number => Date.parse(value);
const fullDate = (at: number): string => new Date(at).toLocaleString();
const amount = (value: number, unit: string): string => `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value)} ${unit === "reset" && value !== 1 ? "resets" : unit}`;
const sameResource = (a: CreditBalance, b: CreditBalance): boolean => a.id === b.id && a.kind === b.kind && a.unit === b.unit;
const maxGap = (provider: BalanceProvider): number => provider.sampleIntervalSeconds
  ? Math.max(5 * 60_000, 3 * provider.sampleIntervalSeconds * 1000) : 2 * 3_600_000;

/** Grant details may be partial: the unlisted remainder keeps an unknown expiry. */
export function expiryBreakdown(balance: CreditBalance): { events: ExpiryEvent[]; unknown: number; never: number } {
  const total = balance.remaining ?? 0;
  const portions = balance.grants ?? [{ remaining: total, expiry: balance.expiry }];
  const byDate = new Map<number, number>();
  let unknown = 0;
  let never = 0;
  let listed = 0;
  for (const portion of portions) {
    const value = portion.remaining ?? 0;
    listed += value;
    if (portion.expiry.kind === "at") {
      const at = timestamp(portion.expiry.at);
      if (Number.isFinite(at)) byDate.set(at, (byDate.get(at) ?? 0) + value);
      else unknown += value;
    } else if (portion.expiry.kind === "never") never += value;
    else unknown += value;
  }
  // Inconsistent details cannot establish which part of the reported total expires.
  if (listed > total) return { events: [], unknown: total, never: 0 };
  unknown += total - listed;
  return {
    events: [...byDate].filter(([, value]) => value > 0).map(([at, value]) => ({ at, amount: value })).sort((a, b) => a.at - b.at),
    unknown,
    never,
  };
}

function expiryKey(expiry: CreditExpiry): string {
  return expiry.kind === "at" ? `at:${expiry.at}` : expiry.kind;
}

function signature(balance: CreditBalance): string {
  return JSON.stringify([balance.id, balance.kind, balance.unit, expiryKey(balance.expiry), balance.renewsAt,
    balance.grants?.map((grant) => expiryKey(grant.expiry)).sort()]);
}

function crossesDeadline(balance: CreditBalance, from: number, to: number): boolean {
  const dates = expiryBreakdown(balance).events.map((event) => event.at);
  if (balance.renewsAt) dates.push(timestamp(balance.renewsAt));
  return dates.some((at) => from < at && at <= to);
}

/** Estimate consumption only within an uninterrupted, decreasing credit epoch. */
export function balancePace(history: BalanceObservation[], current: CreditBalance, observedAt: string, maxGapMs = 2 * 3_600_000): BalancePace | null {
  if (current.kind !== "credit" || current.remaining === undefined || current.remaining <= 0) return null;
  const latest = history.at(-1);
  const last = latest?.creditBalances?.find((balance) => sameResource(balance, current));
  if (!latest?.ok || latest.observedAt !== observedAt || !last || last.remaining !== current.remaining || signature(last) !== signature(current)) return null;
  const end = timestamp(observedAt);
  if (!Number.isFinite(end)) return null;
  let firstAt = end;
  let firstValue = current.remaining;
  let nextAt = end;
  let nextValue = current.remaining;
  for (let index = history.length - 2; index >= 0; index--) {
    const row = history[index]!;
    const previous = row.creditBalances?.find((balance) => sameResource(balance, current));
    const at = timestamp(row.observedAt);
    if (!row.ok || !previous || previous.remaining === undefined || signature(previous) !== signature(current)
      || !Number.isFinite(at) || at >= nextAt || nextAt - at > maxGapMs || previous.remaining < nextValue
      || crossesDeadline(previous, at, nextAt)) break;
    firstAt = at;
    firstValue = previous.remaining;
    nextAt = at;
    nextValue = previous.remaining;
  }
  const perMs = (firstValue - current.remaining) / (end - firstAt);
  if (!Number.isFinite(perMs) || perMs <= 0) return null;
  const depletedAt = end + current.remaining / perMs;
  return Number.isFinite(depletedAt) ? { perMs, depletedAt, observedAt: end } : null;
}

function canProject(provider: BalanceProvider, current: CreditBalance, history: BalanceObservation[], now: number): boolean {
  if (provider.latestOk !== true || provider.stale || !provider.lastAttemptAt || current.remaining === undefined) return false;
  const latest = history.at(-1);
  const last = latest?.creditBalances?.find((balance) => sameResource(balance, current));
  if (!latest?.ok || latest.observedAt !== provider.lastAttemptAt || last?.remaining !== current.remaining
    || signature(last) !== signature(current)) return false;
  const observed = timestamp(provider.lastAttemptAt);
  if (!Number.isFinite(observed) || observed > now) return false;
  if (current.renewsAt && timestamp(current.renewsAt) <= now) return false;
  return !expiryBreakdown(current).events.some((event) => event.at <= now);
}

function expiryText(balance: CreditBalance, now: number): string {
  if (balance.unlimited) return balance.expiry.kind === "at"
    ? `Expires ${escapeHtml(fullDate(timestamp(balance.expiry.at)))}`
    : balance.expiry.kind === "never" ? "No expiry" : "Expiry unknown";
  const { events, unknown, never } = expiryBreakdown(balance);
  const parts = events.map((event) => `${escapeHtml(amount(event.amount, balance.unit))} · ${escapeHtml(fullDate(event.at))}${event.at <= now ? " (expiry passed; awaiting a fresh observation)" : ""}`);
  if (unknown > 0) parts.push(`${escapeHtml(amount(unknown, balance.unit))} · expiry unknown`);
  if (never > 0) parts.push(`${escapeHtml(amount(never, balance.unit))} · no expiry`);
  if (!parts.length) return balance.expiry.kind === "never" ? "No expiry" : "No remaining balance with a reported expiry";
  return parts.length === 1 ? parts[0]! : `<details><summary>${events.length ? `Next: ${escapeHtml(fullDate(events[0]!.at))}` : "Expiry details"} · ${parts.length} portions</summary><ul>${parts.map((part) => `<li>${part}</li>`).join("")}</ul></details>`;
}

function outlook(provider: BalanceProvider, balance: CreditBalance, history: BalanceObservation[], now: number): string {
  if (provider.stale) return "Stale observation; outlook unavailable";
  if (balance.remaining === 0) return "No balance remaining";
  if (balance.unlimited) return "Unlimited balance reported";
  const events = expiryBreakdown(balance).events;
  if (events.some((event) => event.at <= now)) return "Expiry passed; awaiting a fresh observation";
  if (balance.renewsAt && timestamp(balance.renewsAt) <= now) return "Renewal passed; awaiting a fresh observation";
  if (!canProject(provider, balance, history, now)) return "Waiting for matching history";
  if (balance.kind === "manual_reset") return "Expiry outlook assumes resets stay unused";
  const pace = balancePace(history, balance, provider.lastAttemptAt!, maxGap(provider));
  if (!pace) return "Not enough uninterrupted consumption history";
  const nextBoundary = Math.min(...events.map((event) => event.at), balance.renewsAt ? timestamp(balance.renewsAt) : Infinity);
  if (pace.depletedAt >= nextBoundary) return "A reported expiry or renewal comes before estimated depletion";
  if (pace.depletedAt <= now) return "Estimated depletion time passed; awaiting a fresh observation";
  return `Estimated depletion: ${fullDate(pace.depletedAt)} (recent pace; no replenishment)`;
}

/** Current values always come from provider health, never from an older successful row. */
export function renderBalanceSummary(providers: BalanceProvider[], history: Map<string, BalanceObservation[]>, now: number): string {
  const rows = providers.flatMap((provider) => {
    if (provider.latestOk !== true || provider.creditBalances === null) return [`<tr><td>${escapeHtml(provider.displayName)}</td><td colspan="4" class="chart-hint">${provider.latestOk === true ? "Balances not reported" : "Current balances unavailable"}</td></tr>`];
    if (provider.creditBalances.length === 0) return [`<tr><td>${escapeHtml(provider.displayName)}</td><td colspan="4">No balances reported</td></tr>`];
    return provider.creditBalances.map((balance) => `<tr>
      <td>${escapeHtml(provider.displayName)}</td><td>${escapeHtml(balance.label)}</td>
      <td class="balance-amount">${escapeHtml(balance.unlimited ? "Unlimited" : amount(balance.remaining!, balance.unit))}${provider.stale ? '<span class="balance-note">Stale · last reported</span>' : ""}</td>
      <td>${expiryText(balance, now)}${balance.renewsAt ? `<span class="balance-note">Renews ${escapeHtml(fullDate(timestamp(balance.renewsAt)))}</span>` : ""}</td>
      <td>${escapeHtml(outlook(provider, balance, history.get(provider.id) ?? [], now))}<span class="balance-note">Observed ${provider.lastAttemptAt ? escapeHtml(fullDate(timestamp(provider.lastAttemptAt))) : "time unavailable"}</span></td></tr>`);
  });
  return `<div class="table-scroll"><table class="balance-table"><thead><tr><th>Provider</th><th>Resource</th><th>Remaining</th><th>Expiry / renewal</th><th>Outlook</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
}

interface PlotPoint { at: number; value: number }

/** Expiry-only scenario: do not treat possible future redemption as observed use. */
export function unusedExpiryPath(balance: CreditBalance, observedAt: number, until: number): PlotPoint[] {
  if (balance.remaining === undefined) return [];
  const points = [{ at: observedAt, value: balance.remaining }];
  let value = balance.remaining;
  for (const event of expiryBreakdown(balance).events) {
    if (event.at <= observedAt || event.at > until) continue;
    points.push({ at: event.at, value });
    value = Math.max(0, value - event.amount);
    points.push({ at: event.at, value });
  }
  points.push({ at: until, value });
  return points;
}

function observedSegments(history: BalanceObservation[], resource: CreditBalance, maxGapMs: number): PlotPoint[][] {
  const segments: PlotPoint[][] = [];
  let segment: PlotPoint[] = [];
  for (const row of history) {
    const balance = row.creditBalances?.find((candidate) => sameResource(candidate, resource));
    if (!row.ok || balance?.remaining === undefined) {
      if (segment.length) segments.push(segment);
      segment = [];
    } else {
      const at = timestamp(row.observedAt);
      if (segment.length && at - segment.at(-1)!.at > maxGapMs) {
        segments.push(segment);
        segment = [];
      }
      segment.push({ at, value: balance.remaining });
    }
  }
  if (segment.length) segments.push(segment);
  return segments;
}

export function buildBalanceSvg(provider: BalanceProvider, resource: CreditBalance, history: BalanceObservation[], now: number, rangeSeconds: number): string {
  const from = now - rangeSeconds * 1000;
  const until = now + rangeSeconds * 1000;
  const left = 76, right = 854, top = 34, bottom = 208;
  const segments = observedSegments(history, resource, maxGap(provider)).map((segment) => segment.filter((point) => point.at >= from && point.at <= now)).filter((segment) => segment.length);
  const current = provider.latestOk === true ? provider.creditBalances?.find((balance) => sameResource(balance, resource)) : undefined;
  const project = current !== undefined && canProject(provider, current, history, now);
  const values = segments.flat().map((point) => point.value);
  const max = values.reduce((maximum, value) => Math.max(maximum, value), Math.max(1, current?.remaining ?? 0));
  const x = (at: number): number => left + (at - from) / (until - from) * (right - left);
  const y = (value: number): number => bottom - value / max * (bottom - top);
  const path = (points: PlotPoint[], steps = false): string => points.map((point, index) => index === 0
    ? `M${x(point.at).toFixed(2)},${y(point.value).toFixed(2)}`
    : steps ? `H${x(point.at).toFixed(2)}V${y(point.value).toFixed(2)}` : `L${x(point.at).toFixed(2)},${y(point.value).toFixed(2)}`).join(" ");
  const ticks = resource.kind === "manual_reset" ? [...new Set([0, Math.floor(max / 2), max])] : [0, max / 2, max];
  const grid = ticks.map((value) => `<line x1="${left}" x2="${right}" y1="${y(value)}" y2="${y(value)}" stroke="var(--border)"/><text x="${left - 10}" y="${y(value) + 4}" text-anchor="end" class="axis-label">${escapeHtml(formatNumber(value))}</text>`).join("");
  const observed = segments.map((segment) => `<path class="balance-observed" d="${path(segment, resource.kind === "manual_reset")}"/>${segment.length === 1 ? `<circle cx="${x(segment[0]!.at)}" cy="${y(segment[0]!.value)}" r="3" fill="var(--accent)"/>` : ""}`).join("");
  let overlays = "";
  if (project && current) {
    const observedAt = timestamp(provider.lastAttemptAt!);
    const events = expiryBreakdown(current).events;
    const renewedAt = current.renewsAt ? timestamp(current.renewsAt) : Infinity;
    const boundary = Math.min(until, renewedAt);
    if (events.length && boundary > observedAt) overlays += `<path class="balance-unused" d="${path(unusedExpiryPath(current, observedAt, boundary))}"/>`;
    const pace = balancePace(history, current, provider.lastAttemptAt!, maxGap(provider));
    const paceEnd = Math.min(until, renewedAt, ...events.map((event) => event.at), pace?.depletedAt ?? Infinity);
    if (pace && paceEnd > observedAt) overlays += `<path class="balance-pace" d="${path([{ at: observedAt, value: current.remaining! }, { at: paceEnd, value: Math.max(0, current.remaining! - (paceEnd - observedAt) * pace.perMs) }])}"/>`;
    for (const event of events.filter((event) => event.at <= until)) {
      overlays += `<line class="balance-expiry" x1="${x(event.at)}" x2="${x(event.at)}" y1="${top}" y2="${bottom}"><title>Expires ${escapeHtml(fullDate(event.at))}: ${escapeHtml(amount(event.amount, current.unit))} if unused</title></line><text class="balance-event" x="${x(event.at)}" y="${top - 10}" text-anchor="middle">Expiry</text>`;
    }
    if (renewedAt <= until) overlays += `<line class="balance-renewal" x1="${x(renewedAt)}" x2="${x(renewedAt)}" y1="${top}" y2="${bottom}"/><text class="axis-label" x="${x(renewedAt)}" y="${bottom + 18}" text-anchor="middle">Renews</text>`;
  }
  return `<svg class="usage-chart balance-chart" viewBox="0 0 900 256" role="img" aria-label="${escapeHtml(provider.displayName)} ${escapeHtml(resource.label)}: observed balances and conditional outlook"><title>${escapeHtml(resource.label)} (${escapeHtml(resource.unit)})</title><rect class="future-area" x="${x(now)}" y="${top}" width="${right - x(now)}" height="${bottom - top}"/>${grid}<line class="now-line" x1="${x(now)}" x2="${x(now)}" y1="${top}" y2="${bottom}"/><text class="axis-label" x="${x(now)}" y="${top - 10}" text-anchor="middle">Now</text>${observed}${overlays}<text class="axis-label" x="${left}" y="245">${escapeHtml(formatAxisTime(from))}</text><text class="axis-label" x="${right}" y="245" text-anchor="end">${escapeHtml(formatAxisTime(until))}</text></svg>`;
}

export function renderBalances(providers: BalanceProvider[], histories: Map<string, BalanceObservation[]>, errors: Set<string>, now: number, rangeSeconds: number, rangeLabel: string): string {
  const calendar = providers.flatMap((provider) => provider.latestOk === true && !provider.stale ? (provider.creditBalances ?? []).flatMap((balance) => expiryBreakdown(balance).events.filter((event) => event.at > now).map((event) => ({ ...event, provider: provider.displayName, balance }))) : []).sort((a, b) => a.at - b.at);
  const calendarHtml = calendar.length ? `<div class="balance-calendar"><h3>Upcoming expiries · if unused</h3><ol>${calendar.map((event) => `<li><time>${escapeHtml(fullDate(event.at))}</time><span>${escapeHtml(event.provider)} · ${escapeHtml(event.balance.label)} · <strong>${escapeHtml(amount(event.amount, event.balance.unit))}</strong> expires if still unused</span></li>`).join("")}</ol></div>` : "";
  const charts = providers.map((provider) => {
    if (errors.has(provider.id)) return `<p class="chart-hint">${escapeHtml(provider.displayName)}: balance history could not be loaded.</p>`;
    const history = histories.get(provider.id) ?? [];
    const resources = new Map<string, CreditBalance>();
    for (const row of history) if (row.ok) for (const resource of row.creditBalances ?? []) resources.set(JSON.stringify([resource.id, resource.unit, resource.kind]), resource);
    for (const resource of provider.creditBalances ?? []) resources.set(JSON.stringify([resource.id, resource.unit, resource.kind]), resource);
    return [...resources.values()].map((resource) => `<section class="chart-group balance-group"><h3>${escapeHtml(provider.displayName)} · ${escapeHtml(resource.label)} <span class="balance-unit">(${escapeHtml(resource.unit)})</span></h3><div class="chart-scroll" tabindex="0" role="region" aria-label="${escapeHtml(resource.label)} history">${buildBalanceSvg(provider, resource, history, now, rangeSeconds)}</div>${history.length >= 100_000 ? '<p class="chart-hint">History is limited to the latest 100,000 samples.</p>' : ""}</section>`).join("");
  }).join("");
  return `<div class="card"><h2>Balances &amp; expiry</h2><p class="chart-hint">Provider-reported balances. Expiry removes unused balances; renewal starts a new allowance. Times use your local time zone.</p>${renderBalanceSummary(providers, histories, now)}${calendarHtml}${charts}<p class="balance-key"><span class="key-observed">━ Observed</span><span class="key-pace">┄ Consumption estimate</span><span class="key-unused">┄ If balances stay unused</span></p><p class="chart-hint">All balance charts share the same dates: ${escapeHtml(rangeLabel)} of history and ${escapeHtml(rangeLabel)} of outlook. Consumption estimates stop at the next known expiry or renewal. Future replenishment is not assumed. Missing observations break the history line; stale or unavailable balances have no outlook.</p></div>`;
}
