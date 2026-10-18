import type { BillingSummaryResponse, CostDimension, CostGroup, CostMetric, ExportHealth, Money } from '@internal/nebius-domain';
import { Decimal, SPEND_EXCLUDES } from '@internal/nebius-domain';
import { fmtMoney, fmtMoneyList, fmtNumber, fmtTime } from '../ui/format';

/**
 * Display rounding for a breakdown: each row rounded on its own, exactly as fmtMoney rounds money on every other
 * page, so a project reads the same here and on Budgets (F1.2). Rows may then differ from the rounded total by a
 * cent or two; the exact amounts stay in the tooltip and the CSV export.
 */
export function roundedShares(amounts: Money[], total: string): { display: string; percent: number | null }[] {
  const whole = Decimal.from(total);
  return amounts.map(a => ({
    display: fmtMoney(a),
    percent: whole.isZero() ? null : Math.round(Decimal.from(a.amount).div(whole).mul(1000).toNumber()) / 10,
  }));
}

/**
 * A billed-cost row that holds tax or credit rows reads differently from its budget, which leaves them out: the
 * row says what its budget counts, with the rule (F1.48). Nothing when the two agree or for another metric.
 */
export function costGroupSpendLine(metric: CostMetric, g: Pick<CostGroup, 'spendTotals'>): string | undefined {
  if (metric !== 'BilledCost' || !g.spendTotals) return undefined;
  return g.spendTotals.length ? `${fmtMoneyList(g.spendTotals)} ${SPEND_EXCLUDES} (the Budgets rule)` : `none of it counts as spend (${SPEND_EXCLUDES}: the Budgets rule)`;
}

/** Resource types by Nebius id prefix, as the billing export's ResourceId carries them. */
const RESOURCE_TYPES: [string, string][] = [
  ['computeinstance-', 'VM'],
  ['computedisk-', 'disk'],
  ['computefilesystem-', 'filesystem'],
  ['vpcallocation-', 'IP address'],
  ['storagebucket-', 'bucket'],
  ['mk8scluster-', 'Kubernetes cluster'],
  ['mk8snodegroup-', 'node group'],
  ['postgresqlcluster-', 'PostgreSQL'],
  ['mlflowcluster-', 'MLflow'],
  ['registry-', 'registry'],
];

/**
 * "name (id)" labels show the name, with the id as the tooltip. Rows the export carries under a raw id get a
 * readable name: the contract row (tax and other contract-level charges) and buckets by their inventory name.
 */
export function costGroupLabel(dimension: string, g: { key: string; label: string }, names?: ReadonlyMap<string, string>): { text: string; title?: string } {
  const suffix = ` (${g.key})`;
  if ((dimension === 'project' || dimension === 'resource') && g.label.endsWith(suffix) && g.label.length > suffix.length) {
    const name = g.label.slice(0, -suffix.length);
    // A node-group VM and its boot disk share a name: the type from the id prefix tells them apart (#47).
    const type = dimension === 'resource' ? RESOURCE_TYPES.find(([prefix]) => g.key.startsWith(prefix))?.[1] : undefined;
    return { text: type ? `${name} · ${type}` : name, title: g.key };
  }
  if (g.label === g.key && /^contract-[a-z0-9]+$/.test(g.key)) return { text: 'Tax / contract-level', title: g.key };
  if (g.label === g.key && /^storagebucket-[a-z0-9]+$/.test(g.key)) {
    const name = names?.get(g.key);
    return { text: name ?? `Object Storage bucket ${g.key}`, title: g.key };
  }
  return { text: g.label, title: undefined };
}

/** The label column's sort key: the text the row shows (G4.13), "unattributed" for a row without a value. */
export function costGroupSortText(dimension: string, g: { key: string; label: string; unattributed: boolean }, names?: ReadonlyMap<string, string>): string {
  return g.unattributed ? 'unattributed' : costGroupLabel(dimension, g, names).text;
}

/** Daily columns on a real day axis: every day from the first to the last, a day without rows is a gap (null). */
export function dailyPoints(groups: BillingSummaryResponse['daily']['groups']): { label: string; value: number | null; display: string }[] {
  const single = groups.filter(g => g.totals.length === 1 && /^\d{4}-\d{2}-\d{2}$/.test(g.key));
  const byDay = new Map(single.map(g => [g.key, g]));
  if (!single.length) return [];
  const days = [...byDay.keys()].sort();
  const out: { label: string; value: number | null; display: string }[] = [];
  const last = Date.parse(`${days[days.length - 1]}T00:00:00Z`);
  for (let t = Date.parse(`${days[0]}T00:00:00Z`); t <= last; t += 86_400_000) {
    const day = new Date(t).toISOString().slice(0, 10);
    const g = byDay.get(day);
    out.push(g ? { label: day, value: Decimal.from(g.totals[0].amount).toNumber(), display: fmtMoney(g.totals[0]) } : { label: day, value: null, display: 'no rows' });
  }
  return out;
}

/** The daily chart's footer: days drawn and days with rows; the negative-bar note only when a bar is below zero (#71). */
export function dailyChartFooter(points: { value: number | null }[], withRows: number): string {
  const days = `${fmtNumber(points.length)} ${points.length === 1 ? 'day' : 'days'}, ${fmtNumber(withRows)} with rows`;
  return points.some(p => p.value !== null && p.value < 0) ? `${days} · negative bars are credits or adjustments` : days;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar day as YYYY-MM-DD (2026-02-31 is not one). */
function isDay(v: string): boolean {
  if (!DAY.test(v)) return false;
  const t = Date.parse(`${v}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === v;
}

/** `?from=YYYY-MM-DD&to=YYYY-MM-DD` from a deep link; a malformed date is dropped (and named by ignoredRange). */
export function rangeFromSearch(params: URLSearchParams): { from: string; to: string } {
  const read = (k: string) => {
    const v = params.get(k) ?? '';
    return isDay(v) ? v : '';
  };
  return { from: read('from'), to: read('to') };
}

/** Range values in a link that are not dates, so the page can say they were not applied. */
export function ignoredRange(params: URLSearchParams): { key: 'from' | 'to'; value: string }[] {
  return (['from', 'to'] as const).flatMap(key => {
    const value = params.get(key);
    return value && !isDay(value) ? [{ key, value }] : [];
  });
}

/**
 * The Costs empty state: no rows imported at all, or none in the chosen range while imports exist
 * (then the health strip still describes the export). Undefined when the range holds rows.
 */
export function costsEmptyState(o: {
  rows: number;
  rowsAnyRange: number;
  /** Rows imported whatever the project or region (G4.1). */
  importedRows?: number;
  /** The project / region filter in words, when one is set. */
  selection?: string;
  pull: BillingSummaryResponse['exportPull'];
  range: { from: string; to: string };
}): { title?: string; text: string } {
  if (o.rows > 0) return { text: '' };
  const n = (x: number) => `${x.toLocaleString('en-US')} ${x === 1 ? 'row' : 'rows'}`;
  if (o.rowsAnyRange > 0) {
    const span = `${o.range.from || 'the start'} to ${o.range.to || 'now'}`;
    return {
      title: 'No billed rows in this range',
      text: `The imports hold ${n(o.rowsAnyRange)}, none from ${span} (UTC, the end exclusive). Widen the range or clear the dates.`,
    };
  }
  // The filter selects nothing, while other projects' rows exist: not an empty export (G4.1).
  if (o.selection && (o.importedRows ?? 0) > 0) {
    return {
      title: `No billed rows for ${o.selection}`,
      text: `The imports hold ${n(o.importedRows!)} for other projects or regions, none for ${o.selection}. The export lists a project once it has billed usage; pick another project or region, or clear the filter.`,
    };
  }
  return { title: 'No billing data imported', text: `${emptyCostsText(o.pull)} The portal never creates exports for you.` };
}

/**
 * The Completeness tile: the hours the export spans and how many hold usage rows. FOCUS periodic exports carry rows
 * only for hours with usage, so an hour without rows is not a gap; a whole day without rows is named, as idle or
 * not exported, because the export alone cannot tell which (docs/portal/billing-and-pricing.md#export-completeness).
 */
export function coverageTile(c: ExportHealth['coverage'], ranged = false): { label: string; value: string; unit: string; reason: string } {
  // A chosen range does not narrow it (the backend reports the whole export's coverage): said on the tile (W1F.S2).
  const label = ranged ? 'Completeness (whole export)' : 'Completeness';
  const scope = ranged ? 'Not limited to the chosen range. ' : '';
  if (!c) return { label, value: '—', unit: '', reason: 'No usage rows yet.' };
  const n = c.daysWithoutUsage.length;
  const days = n
    ? ` ${n} ${n === 1 ? 'day' : 'days'} without any row (${c.daysWithoutUsage.slice(0, 3).join(', ')}${n > 3 ? ', …' : ''}): idle, or not exported.`
    : '';
  // Plain words (F1.42): "12 of 91 h with usage", not "91 h covered" beside "12 h with usage rows".
  return {
    label,
    value: `${c.hoursWithUsage} of ${c.spanHours}`,
    unit: 'h with usage',
    reason: `${scope}The export spans ${fmtTime(c.from)} → ${fmtTime(c.through)}. An hour without usage has no row in a FOCUS export, so it is not a gap.${days}`,
  };
}

/**
 * The Data tile: the active rows, and where they come from. In a chosen range it counts the range's rows against all
 * imported ones, as the empty state does ("0 rows in this range · 1,767 rows in the imports in all"), never "0 active
 * rows from 0 import(s) ·" with a stray separator for a currency list that is empty (W1F.S2).
 */
export function dataTile(h: Pick<ExportHealth, 'activeRows' | 'imports' | 'currencies'>, o: { ranged: boolean; rowsAnyRange: number }): { value: string; unit: string; reason: string } {
  const n = (x: number) => x.toLocaleString('en-US');
  const source = o.ranged ? `${n(o.rowsAnyRange)} ${o.rowsAnyRange === 1 ? 'row' : 'rows'} in the imports in all` : `from ${n(h.imports)} ${h.imports === 1 ? 'import' : 'imports'}`;
  return {
    value: n(h.activeRows),
    unit: o.ranged ? `${h.activeRows === 1 ? 'row' : 'rows'} in this range` : 'active rows',
    reason: [source, 'superseded rows are deleted on import', h.currencies.join(', ')].filter(Boolean).join(' · '),
  };
}

/** A rejection from an import made before NULL was read as empty says so, instead of contradicting the import rules. */
export function rejectReason(message: string): string {
  return /invalid decimal "NULL"/i.test(message) ? `${message}: imported before the NULL fix; re-import to apply` : message;
}

/** The range is [from, to) in UTC days. */
export function rangeError(from: string, to: string): string | undefined {
  return from && to && to <= from ? '“To” must be after “From”.' : undefined;
}

export function importPeriodText(s: { accepted: number; rejected: number; periodStart?: string; periodEnd?: string }): string | undefined {
  if (s.accepted > 0) return undefined;
  return s.rejected ? 'No row accepted: see the reasons' : 'Header only: no usage in this period';
}

/** The empty Costs page, worded from the export pull's state. */
export function emptyCostsText(pull: BillingSummaryResponse['exportPull']): string {
  const manual = 'You can also import a FOCUS CSV below.';
  if (!pull || pull.state === 'not-configured') {
    return `Import a FOCUS CSV below, or configure the export pull (Billing → Export → Periodic export to a bucket, then the NEBIUS_BILLING_EXPORT_* variables; docs/portal/billing-and-pricing.md#billing-export-pull).`;
  }
  if (pull.state === 'permission-denied' || pull.state === 'error') {
    return `The export pull cannot read the bucket ${pull.scope}${pull.note ? ` (${pull.note})` : ''}: check its access key on Integrations. ${manual}`;
  }
  return `Export pull configured; waiting for the first files (Nebius writes hourly) in ${pull.scope}. ${manual}`;
}

/**
 * The end of the reporting period: the last exported hour of the rows shown (the open billing period ends in the
 * future). With a range or a project / region filter it is that selection's last hour, never the whole export's,
 * which the lag tile describes (G4.2); a range without rows says so.
 */
export function periodEndText(h: Pick<ExportHealth, 'activeRows' | 'latestChargePeriodEnd'>, o: { through?: string; narrowed: boolean }): string {
  if (o.narrowed && !h.activeRows) return 'no rows in this range';
  if (o.through) return o.narrowed ? `through ${fmtTime(o.through)} (last hour shown)` : `exported through ${fmtTime(o.through)}`;
  return h.latestChargePeriodEnd ? fmtTime(h.latestChargePeriodEnd) : '';
}

/** The rows charged for more than a day that the daily chart leaves out, in words (G4.10). */
export function dailyExcludedNote(x: BillingSummaryResponse['dailyExcluded']): string | undefined {
  if (!x?.rows) return undefined;
  const cats = x.categories.length > 1 ? `${x.categories.slice(0, -1).join(', ')} and ${x.categories[x.categories.length - 1]}` : x.categories[0];
  const one = x.rows === 1;
  return `${x.rows} month-long ${cats} ${one ? 'row' : 'rows'} (${fmtMoneyList(x.totals)}) ${one ? 'is' : 'are'} not drawn per day; the totals include ${one ? 'it' : 'them'}.`;
}

/** A FOCUS column name in words ("BilledCost" -> "Billed cost"); the column name stays in the tooltip and the metric switch. */
export function costMetricLabel(m: string): string {
  return m.replace(/([a-z])([A-Z])/g, (_x, a: string, b: string) => `${a} ${b.toLowerCase()}`);
}

/**
 * The imports listed before "Show all": the newest from each importer (the scheduled export pull, each person), so
 * every source's latest file shows; the history of near-identical files is one click away. `items` are newest first.
 */
export function latestPerImporter<T extends { importedBy: string }>(items: T[]): T[] {
  return items.filter((it, i) => items.findIndex(x => x.importedBy === it.importedBy) === i);
}

/**
 * Whether a cost report answers the breakdown asked for. useGet keeps the previous reply on screen while it refetches,
 * so for a moment after a tab or metric change the old rows would sit under the new heading (resources listed "by
 * project"); those are shown as loading instead.
 */
export function reportShows(report: { metric: CostMetric; dimension: CostDimension } | undefined, metric: CostMetric, dimension: CostDimension | string): boolean {
  return Boolean(report && report.metric === metric && report.dimension === dimension);
}
