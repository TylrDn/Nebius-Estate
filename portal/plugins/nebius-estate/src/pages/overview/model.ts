import type { BillingSummaryResponse, CostReport, GpuTelemetryView, HealthStats, LivePriceResponse, Money, OverviewResponse, SourcedMetric } from '@internal/nebius-domain';
import { exportFreshnessText, gapCounts, gapText, lagText, SPEND_EXCLUDES } from '@internal/nebius-domain';
import { fmtMoney, fmtMoneyList, fmtNumber, fmtTime } from '../../ui';
import { priceBasisText } from '../pricing/livePrice';

/**
 * Pure helpers behind the Overview page. Every function keeps "unknown"
 * distinct from zero: a missing input gives null (rendered as Unavailable or
 * "—"), never 0.
 */

/** Where to read about setting a source up (docs/portal, relative to the repository root). */
export const SETUP = {
  inventory: 'docs/portal/nebius-setup.md#read-only-nebius-identity',
  kubernetes: 'docs/portal/nebius-setup.md#kubernetes',
  telemetry: 'docs/portal/nebius-setup.md#telemetry',
  access: 'docs/portal/nebius-setup.md#access-roles',
  rateBook: 'docs/portal/nebius-setup.md#budgets-and-the-default-rate-book',
  billing: 'docs/portal/nebius-setup.md#billing-export-manual',
  livePrices: 'docs/portal/billing-and-pricing.md#live-list-prices',
} as const;

/** "docs/x.md#section" → the document viewer at that section (`/evidence?doc=docs%2Fx.md#section`). */
export function setupDocHref(doc: string): string {
  const [path, anchor] = doc.split('#');
  return `/evidence?doc=${encodeURIComponent(path)}${anchor ? `#${anchor}` : ''}`;
}

/** A missing permission is fixed by an access role, not by configuring the source. */
export function setupDocFor(reason: string | undefined, fallback: string): string {
  if (reason && /do not have nebius\.|permission-denied|needs nebius\./i.test(reason)) return SETUP.access;
  return fallback;
}

/** The page where an Unavailable is fixed, and the action in words. */
export interface FixLink {
  to: string;
  label: string;
}

/** Sources read by a connector: fixed on its card on Integrations (state, error and setup doc in one place). */
const CONNECTOR_FIX: Record<string, string> = {
  [SETUP.inventory]: 'Check the Nebius inventory on Integrations',
  [SETUP.telemetry]: 'Check GPU telemetry on Integrations',
  [SETUP.kubernetes]: 'Check Kubernetes on Integrations',
  [SETUP.livePrices]: 'Check live prices on Integrations',
};

/**
 * Exactly one primary Fix per Unavailable (W1-P24), to the page where the fix happens: a missing portal permission →
 * the access roles; no rate book → Commercial's Rate books tab; no billing export → Costs (its import); alerts → the
 * rules; a connector's source → Integrations. `query` keeps the global filter on a link inside the portal's pages.
 */
export function fixFor(reason: string | undefined, setup: string, query = ''): FixLink {
  const doc = setupDocFor(reason, setup);
  if (doc === SETUP.access) return { to: setupDocHref(SETUP.access), label: 'Ask for the portal role (access roles)' };
  if (setup === SETUP.rateBook) return { to: '/commercial?tab=ratebooks', label: 'Import or build a rate book' };
  if (setup === SETUP.billing) return { to: '/costs', label: 'Import a billing export on Costs' };
  if (setup === 'runbooks/fleet-alerts.md') return { to: '/alerts?tab=rules', label: 'Check the alert rules' };
  if (CONNECTOR_FIX[setup]) return { to: `/integrations${query}#connectors`, label: CONNECTOR_FIX[setup] };
  return { to: setupDocHref(setup), label: `Read ${setup.split('#')[0]}` };
}

/** A quota list as a count, keeping the source and reason. */
export function countOf<T>(m: SourcedMetric<T[]>): SourcedMetric {
  return { ...m, value: m.value === null ? null : m.value.length };
}

/** Scheduled (not finished, not cancelled) maintenance, soonest first. */
export function upcomingMaintenance(m: OverviewResponse['maintenances']) {
  if (m.value === null) return null;
  const at = (x: { scheduledAt?: string; startedAt?: string }) => x.scheduledAt ?? x.startedAt;
  // Undated entries last.
  return [...m.value].sort((a, b) => {
    const x = at(a);
    const y = at(b);
    if (x === y) return 0;
    if (x === undefined) return 1;
    if (y === undefined) return -1;
    return x < y ? -1 : 1;
  });
}

/** 850 ms, 12.3 s, 2.1 min — or null when not recorded. */
export function fmtDuration(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return null;
  if (ms < 1000) return `${fmtNumber(ms)} ms`;
  if (ms < 60_000) return `${fmtNumber(ms / 1000, 1)} s`;
  return `${fmtNumber(ms / 60_000, 1)} min`;
}

/** The 24 h success rate (a 0–1 ratio in HealthStats) as a percentage. */
export function successPercent(h: HealthStats | undefined): number | null {
  if (!h || h.successRate24h === null || h.successRate24h === undefined || h.runs24h === 0) return null;
  return Math.max(0, Math.min(100, h.successRate24h * 100));
}

export interface TelemetrySummary {
  gpus: number;
  temp: { reporting: number; mean: number; max: number } | null;
  power: { reporting: number; total: number; max: number } | null;
  sources: string[];
}

/** Temperature and power across the GPU series that report them; null parts when no series does. */
export function summariseTelemetry(rows: GpuTelemetryView[] | null): TelemetrySummary | null {
  if (rows === null) return null;
  const temps = rows.map(r => r.tempC).filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
  const watts = rows.map(r => r.powerW).filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
  return {
    gpus: rows.length,
    temp: temps.length ? { reporting: temps.length, mean: temps.reduce((a, b) => a + b, 0) / temps.length, max: Math.max(...temps) } : null,
    power: watts.length ? { reporting: watts.length, total: watts.reduce((a, b) => a + b, 0), max: Math.max(...watts) } : null,
    sources: [...new Set(rows.map(r => r.source))],
  };
}

/** "list price as of 2026-10-11 09:00 UTC", or "contract price (= list) as of …". */
export function priceLabel(v: NonNullable<LivePriceResponse['value']>): string {
  return `${priceBasisText(v, m => fmtMoney(m))} as of ${fmtTime(v.asOf)}`;
}

/** The live run-rate as a sourced metric: source and "as of" from the calculator response. */
export function liveRunRateMetric(r: { data?: LivePriceResponse; error?: Error }): SourcedMetric<NonNullable<LivePriceResponse['value']>> {
  const fallbackSource = 'Nebius billing calculator';
  if (r.error) return { value: null, source: fallbackSource, unavailableReason: r.error.message };
  if (!r.data) return { value: null, source: fallbackSource, unavailableReason: 'Loading…' };
  if (!r.data.value && r.data.nothingRunning) {
    // Nothing to price once the inventory has synced: a 0, not a gap to set up.
    return { value: null, source: fallbackSource, empty: `0 ${r.data.nothingRunning.currency} / h — nothing running`, unavailableReason: r.data.unavailableReason, observedAt: r.data.observedAt };
  }
  if (!r.data.value) return { value: null, source: fallbackSource, unavailableReason: r.data.unavailableReason ?? 'The calculator returned no estimate.' };
  return { value: r.data.value, source: r.data.value.source, observedAt: r.data.value.asOf, note: priceLabel(r.data.value) };
}

/** A connector's gaps in the words its state pill and the Overview line use (gapText, W1F.S3). */
export function missingSummary(items: string[]): string {
  return gapText(gapCounts(items));
}

const BILLING_SOURCE = 'Billing export (FOCUS)';

/**
 * The reported total under the spend rule budgets use (countsAsSpend: tax and credit rows left out), over the same
 * rows and filter as the total beside it. It names the rule, not a Budgets figure: Budgets shows this month for the
 * whole account, which equals this only over that month and scope. Nothing when the two are equal.
 */
export function budgetSpendLine(report: Pick<CostReport, 'totals' | 'spendTotals'>): string | undefined {
  const spend = report.spendTotals;
  if (!spend?.length) return undefined;
  const same = spend.length === report.totals.length && spend.every(m => report.totals.some(t => t.currency === m.currency && t.amount === m.amount));
  return same ? undefined : `${fmtMoneyList(spend)} ${SPEND_EXCLUDES} (the Budgets rule)`;
}

/**
 * Reported cost as a sourced metric, dated by the last exported hour (never by the end of the billing month, which
 * a month-long row such as tax pushes into the future). The lag is the API's, the same as on Costs and Budgets.
 */
export function billingMetric(r: { data?: BillingSummaryResponse; error?: Error }, now = new Date()): SourcedMetric<Money[]> {
  if (!r.data) return { value: null, source: BILLING_SOURCE, unavailableReason: r.error ? r.error.message : 'Loading…' };
  const h = r.data.health;
  if (h.imports === 0 || h.rows === 0) return { value: null, source: BILLING_SOURCE, unavailableReason: 'No billing export imported yet: import a FOCUS CSV on Costs, or set up the export pull.' };
  const through = h.exportedThrough ?? h.latestChargePeriodEnd;
  const from = h.firstUsageHour ?? h.earliestChargePeriodStart;
  // The next pull and the next export file's estimate, when known (#12).
  const next = r.data.exportPull ? exportFreshnessText(r.data.exportPull, now) : undefined;
  const lag = `${h.lagHours === undefined ? '' : ` · export lag ${lagText(h.lagHours)}`}${next ? ` · ${next}` : ''}`;
  return {
    value: r.data.report.totals,
    source: BILLING_SOURCE,
    observedAt: through,
    // With a project or region filter the selection's last usage is named apart: the lag dates the export (G1.3).
    note: r.data.selectionLastUsage
      ? `Last usage in scope ${fmtTime(r.data.selectionLastUsage)}${through ? ` · export through ${fmtTime(through)}` : ''}${lag}`
      : from && through
        ? `Usage ${fmtTime(from)} → exported through ${fmtTime(through)}${lag}`
        : undefined,
  };
}

type FilterKey = 'project' | 'region' | 'stage';

/**
 * A tile that does not follow part of the active global filter says so (G1.1): "Not filtered by stage: whole
 * account". `applied` lists the keys the tile's source does narrow by. Undefined when every active key applies.
 */
export function filterNotApplied(filter: Partial<Record<FilterKey, string>>, applied: FilterKey[]): string | undefined {
  const keys: FilterKey[] = ['project', 'region', 'stage'];
  const ignored = keys.filter(k => filter[k] && !applied.includes(k));
  if (!ignored.length) return undefined;
  const narrowed = applied.filter(k => filter[k]);
  return `Not filtered by ${ignored.join(' or ')}: ${narrowed.length ? `every ${ignored.join(' and ')} of the selected ${narrowed.join(' and ')}` : 'whole account'}`;
}

/**
 * The run-rate count in one wording for the live and the rate-book tile (W1-P10): resources priced (a calculator line
 * of N identical VMs counts N) and resources without a price, so the two tiles can be compared at a glance.
 */
export function runRateCountText(c: { priced: number; unpriced: number }): string {
  return `${c.priced} ${c.priced === 1 ? 'resource' : 'resources'} priced, ${c.unpriced} without a price`;
}
