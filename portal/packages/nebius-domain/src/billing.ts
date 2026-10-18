import { z } from 'zod';
import { Decimal } from './decimal';
import { Money, MoneyBag } from './money';
import { parseCsv } from './csv';
import { lagHours } from './time';

/**
 * Nebius billing export ingestion (FOCUS 1.2 CSV, hourly detail:
 * https://docs.nebius.com/signup-billing/usage/export and /focus-fields).
 *
 * Rules this module enforces:
 *  - Four cost columns, four meanings. BilledCost (invoiced), EffectiveCost
 *    (amortised, after discounts), ListCost (public list), ContractedCost
 *    (negotiated). A report picks ONE metric; they are never added together.
 *  - Credits, adjustments, corrections, taxes and negative values are kept as
 *    rows; nothing is netted or dropped.
 *  - Currencies are never combined (MoneyBag).
 *  - Re-imports of an hour replace that hour for the same billing account and
 *    attributed project (supersession), so a re-export or an overlapping file
 *    never double counts, and a one-project file never touches other projects.
 *    A row whose x_ProjectId and x_ContainerId disagree is refused.
 *  - Tags: since 2026-09-21 the export's Tags column carries the cost
 *    allocation labels of Compute billable resources (map<string,string>; the
 *    text encoding is not documented, so parseTags is defensive). A label
 *    breakdown uses the row's own tag first and falls back to joining
 *    ResourceId to inventory labels (rows without tags, e.g. non-Compute);
 *    every group says which source its value came from.
 */

export const COST_METRICS = ['BilledCost', 'EffectiveCost', 'ListCost', 'ContractedCost'] as const;
export type CostMetric = (typeof COST_METRICS)[number];

export const COST_METRIC_DESCRIPTIONS: Record<CostMetric, string> = {
  BilledCost: 'What the invoice charges for the row (FOCUS BilledCost).',
  EffectiveCost: 'Amortised cost after discounts and commitments (FOCUS EffectiveCost).',
  ListCost: 'Public list price × quantity (FOCUS ListCost); not what was paid.',
  ContractedCost: 'Negotiated contract price × quantity (FOCUS ContractedCost).',
};

export const FOCUS_REQUIRED_COLUMNS = [
  'BilledCost',
  'BillingCurrency',
  'ChargePeriodStart',
  'ChargePeriodEnd',
  'ChargeCategory',
] as const;

export const FOCUS_KNOWN_COLUMNS = [
  'BilledCost', 'BillingAccountId', 'BillingAccountName', 'BillingAccountType', 'BillingCurrency',
  'BillingPeriodStart', 'BillingPeriodEnd', 'ChargeCategory', 'ChargeClass', 'ChargeDescription',
  'ChargeFrequency', 'ChargePeriodStart', 'ChargePeriodEnd', 'CommitmentDiscountCategory',
  'CommitmentDiscountId', 'CommitmentDiscountName', 'CommitmentDiscountQuantity',
  'CommitmentDiscountStatus', 'CommitmentDiscountType', 'CommitmentDiscountUnit', 'ConsumedQuantity',
  'ConsumedUnit', 'ContractedCost', 'ContractedUnitPrice', 'EffectiveCost', 'InvoiceIssuerName',
  'ListCost', 'ListUnitPrice', 'PricingCategory', 'PricingCurrency',
  'PricingCurrencyContractedUnitPrice', 'PricingCurrencyEffectiveCost', 'PricingCurrencyListUnitPrice',
  'PricingQuantity', 'PricingUnit', 'ProviderName', 'PublisherName', 'RegionId', 'RegionName',
  'ResourceId', 'ResourceName', 'ResourceType', 'ServiceCategory', 'ServiceName', 'SkuId', 'SkuMeter',
  'SkuPriceDetails', 'SkuPriceId', 'Tags', 'x_ContainerId', 'x_ContainerName', 'x_TrialId',
  'x_ContractPriceId', 'x_UsageBasedDiscountIds', 'x_TenantId', 'x_TenantName', 'x_ProjectId',
  'x_ProjectName',
] as const;

/**
 * Nebius extension columns of the export (verified on the live export, 2026-10-11). Stored on every
 * row; '' when the column is absent or holds the literal NULL the export writes for "no value".
 */
export const FOCUS_EXTENSION_FIELDS = {
  tenantId: 'x_TenantId',
  tenantName: 'x_TenantName',
  projectId: 'x_ProjectId',
  projectName: 'x_ProjectName',
  trialId: 'x_TrialId',
  contractPriceId: 'x_ContractPriceId',
  usageBasedDiscountIds: 'x_UsageBasedDiscountIds',
} as const;
export type FocusExtensionField = keyof typeof FOCUS_EXTENSION_FIELDS;

export interface BillingRecord {
  /** Content identity used for exact-duplicate detection. */
  key: string;
  /** Supersession slot: billing account × attributed project (x_ProjectId, else x_ContainerId) × charge-period start. */
  slot: string;
  billingAccountId: string;
  billingPeriodStart: string;
  billingPeriodEnd: string;
  chargePeriodStart: string;
  chargePeriodEnd: string;
  chargeCategory: string;
  chargeClass: string;
  chargeDescription: string;
  serviceName: string;
  serviceCategory: string;
  regionId: string;
  resourceId: string;
  resourceName: string;
  resourceType: string;
  skuId: string;
  skuPriceId: string;
  pricingQuantity: string | null;
  pricingUnit: string;
  /** Nebius extension: the container (project) the charge belongs to. */
  containerId: string;
  containerName: string;
  /** Nebius extensions (x_TenantId … x_UsageBasedDiscountIds); '' when not exported. */
  tenantId: string;
  tenantName: string;
  /** x_ProjectId / x_ProjectName: the project, ahead of x_ContainerId for attribution. */
  projectId: string;
  projectName: string;
  /** x_TrialId: set when the row is drawn from a trial or promo credit. */
  trialId: string;
  contractPriceId: string;
  usageBasedDiscountIds: string;
  currency: string;
  costs: Record<CostMetric, string | null>;
  tagsRaw: string;
}

export interface StoredBillingRecord extends BillingRecord {
  importId: string;
  importedAt: string;
  supersededBy?: string;
}

export interface NormalizeResult {
  records: BillingRecord[];
  errors: { row: number; message: string }[];
  missingColumns: string[];
  unknownColumns: string[];
}

function iso(s: string | undefined): string {
  if (!s) return '';
  const t = Date.parse(s);
  return Number.isNaN(t) ? '' : new Date(t).toISOString();
}

/** The export writes the literal NULL for an empty value (seen on the live export, 2026-10-11). */
const isNull = (s: string | undefined) => s === undefined || s.trim() === '' || s.trim().toUpperCase() === 'NULL';

/** An extension column's value: trimmed, '' for absent or NULL. */
const extValue = (s: string | undefined) => (isNull(s) ? '' : s!.trim());

function dec(raw: string | undefined): string | null {
  if (isNull(raw)) return null;
  const s = raw!.trim();
  if (!Decimal.isValid(s)) throw new Error(`invalid decimal ${JSON.stringify(s)}`);
  return Decimal.from(s).toString();
}

export function normalizeFocusCsv(text: string): NormalizeResult {
  const parsed = parseCsv(text);
  const missingColumns = FOCUS_REQUIRED_COLUMNS.filter(c => !parsed.header.includes(c));
  const known = new Set<string>(FOCUS_KNOWN_COLUMNS);
  const unknownColumns = parsed.header.filter(h => !known.has(h));
  const errors: NormalizeResult['errors'] = parsed.errors.map(e => ({ row: e.line, message: e.message }));
  if (missingColumns.length) return { records: [], errors, missingColumns, unknownColumns };

  const records: BillingRecord[] = [];
  parsed.rows.forEach((raw, idx) => {
    // The export writes the literal NULL for "no value" in any column: read it as empty everywhere.
    const row: Record<string, string> = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, isNull(v) ? '' : v]));
    try {
      const currency = (row.BillingCurrency ?? '').trim().toUpperCase();
      if (!/^[A-Z]{3}$/.test(currency)) throw new Error(`invalid BillingCurrency ${JSON.stringify(row.BillingCurrency)}`);
      const chargePeriodStart = iso(row.ChargePeriodStart);
      const chargePeriodEnd = iso(row.ChargePeriodEnd);
      if (!chargePeriodStart || !chargePeriodEnd) throw new Error('invalid ChargePeriodStart/End');
      const costs = {
        BilledCost: dec(row.BilledCost),
        EffectiveCost: dec(row.EffectiveCost),
        ListCost: dec(row.ListCost),
        ContractedCost: dec(row.ContractedCost),
      };
      if (costs.BilledCost === null) throw new Error('BilledCost is empty');
      const rec: Omit<BillingRecord, 'key' | 'slot'> = {
        billingAccountId: row.BillingAccountId ?? '',
        billingPeriodStart: iso(row.BillingPeriodStart),
        billingPeriodEnd: iso(row.BillingPeriodEnd),
        chargePeriodStart,
        chargePeriodEnd,
        chargeCategory: row.ChargeCategory ?? '',
        chargeClass: row.ChargeClass ?? '',
        chargeDescription: row.ChargeDescription ?? '',
        serviceName: row.ServiceName ?? '',
        serviceCategory: row.ServiceCategory ?? '',
        regionId: row.RegionId ?? '',
        resourceId: row.ResourceId ?? '',
        resourceName: row.ResourceName ?? '',
        resourceType: row.ResourceType ?? '',
        skuId: row.SkuId ?? '',
        skuPriceId: row.SkuPriceId ?? '',
        pricingQuantity: dec(row.PricingQuantity),
        pricingUnit: row.PricingUnit ?? '',
        containerId: row.x_ContainerId ?? '',
        containerName: row.x_ContainerName ?? '',
        ...(Object.fromEntries(Object.entries(FOCUS_EXTENSION_FIELDS).map(([field, column]) => [field, extValue(row[column])])) as Record<FocusExtensionField, string>),
        currency,
        costs,
        tagsRaw: row.Tags ?? '',
      };
      if (rec.projectId && rec.containerId && rec.projectId !== rec.containerId) {
        // Attribution (scope checks, reports) and supersession must name one project; a row naming two is refused.
        throw new Error(`x_ProjectId ${rec.projectId} and x_ContainerId ${rec.containerId} disagree: the row cannot be attributed to one project`);
      }
      const key = [
        rec.billingAccountId, rec.chargePeriodStart, rec.chargePeriodEnd, rec.chargeCategory,
        rec.chargeClass, rec.chargeDescription, rec.resourceId, rec.skuId, rec.skuPriceId,
        rec.pricingQuantity ?? '', rec.currency, costs.BilledCost, costs.EffectiveCost ?? '',
        costs.ListCost ?? '', costs.ContractedCost ?? '', rec.containerId,
      ].join('\u001f');
      records.push({ ...rec, key, slot: billingSlot(rec) });
    } catch (e) {
      errors.push({ row: idx + 2, message: (e as Error).message });
    }
  });
  return { records, errors, missingColumns, unknownColumns };
}

/**
 * The supersession slot of a row: billing account × attributed project (the same id scope checks and
 * reports use) × charge-period start.
 */
export function billingSlot(r: Pick<BillingRecord, 'billingAccountId' | 'projectId' | 'projectName' | 'containerId' | 'containerName' | 'chargePeriodStart'>): string {
  return [r.billingAccountId, attributedProject(r).id, r.chargePeriodStart].join('\u001f');
}

/** The project a row is attributed to: x_ProjectId first, then x_ContainerId ('' when neither is set). */
export function attributedProject(r: Pick<BillingRecord, 'projectId' | 'projectName' | 'containerId' | 'containerName'>): { id: string; name: string } {
  if (r.projectId) return { id: r.projectId, name: r.projectName || r.containerName };
  return { id: r.containerId, name: r.containerName };
}

/**
 * Fills the extension fields of a row stored before they were parsed. Only what the stored row
 * implies is derived: the project from a container that is a project; the trial and tenant fields stay
 * '' until the file is imported again (re-importing an hour supersedes the old rows). Idempotent.
 */
export function withFocusExtensions<T extends Omit<BillingRecord, FocusExtensionField> & Partial<Pick<BillingRecord, FocusExtensionField>>>(stored: T): T & BillingRecord {
  // Rows stored before NULL was read as empty: clear it from every text field (costs were never stored as NULL).
  const r = Object.fromEntries(Object.entries(stored).map(([k, v]) => [k, typeof v === 'string' && v.trim().toUpperCase() === 'NULL' ? '' : v])) as T;
  const containerIsProject = /^project-[a-z0-9]+$/.test(r.containerId ?? '');
  return {
    ...r,
    tenantId: r.tenantId ?? '',
    tenantName: r.tenantName ?? '',
    projectId: r.projectId ?? (containerIsProject ? r.containerId : ''),
    projectName: r.projectName ?? (containerIsProject ? r.containerName : ''),
    trialId: r.trialId ?? '',
    contractPriceId: r.contractPriceId ?? '',
    usageBasedDiscountIds: r.usageBasedDiscountIds ?? '',
  };
}

export interface IngestSummary {
  importId: string;
  accepted: number;
  duplicatesInFile: number;
  supersededRows: number;
  supersededImports: string[];
  rejected: number;
  periodStart?: string;
  periodEnd?: string;
  currencies: string[];
}

/** Drops exact duplicate rows inside one file. */
export function dedupeFile(incoming: BillingRecord[]): { fresh: BillingRecord[]; duplicatesInFile: number } {
  const seen = new Set<string>();
  const fresh: BillingRecord[] = [];
  for (const r of incoming) {
    if (seen.has(r.key)) continue;
    seen.add(r.key);
    fresh.push(r);
  }
  return { fresh, duplicatesInFile: incoming.length - fresh.length };
}

export function ingestSummary(
  importId: string,
  fresh: BillingRecord[],
  counts: { duplicatesInFile: number; supersededRows: number; supersededImports: string[]; rejected: number },
): IngestSummary {
  // The hours the file's usage covers: a month-long row (tax) would stretch the span to its whole month (#68).
  const hourly = fresh.filter(r => !spansMoreThanADay(r));
  const spanRows = hourly.length ? hourly : fresh;
  const starts = spanRows.map(r => r.chargePeriodStart).sort();
  const ends = spanRows.map(r => r.chargePeriodEnd).sort();
  return {
    importId,
    accepted: fresh.length,
    ...counts,
    periodStart: starts[0],
    periodEnd: ends[ends.length - 1],
    currencies: [...new Set(fresh.map(r => r.currency))].sort(),
  };
}

/**
 * In-memory ledger with supersession: the reference model of the rules. The
 * backend applies the same rules in SQL with dedupeFile and ingestSummary.
 */
export class BillingLedger {
  private records: StoredBillingRecord[] = [];

  all(): StoredBillingRecord[] {
    return this.records;
  }

  active(): StoredBillingRecord[] {
    return this.records.filter(r => !r.supersededBy);
  }

  ingest(importId: string, importedAt: string, incoming: BillingRecord[], rejected = 0): IngestSummary {
    const { fresh, duplicatesInFile } = dedupeFile(incoming);
    const slots = new Set(fresh.map(r => r.slot));
    let supersededRows = 0;
    const supersededImports = new Set<string>();
    for (const r of this.records) {
      if (!r.supersededBy && slots.has(r.slot)) {
        r.supersededBy = importId;
        supersededRows++;
        supersededImports.add(r.importId);
      }
    }
    this.records.push(...fresh.map(r => ({ ...r, importId, importedAt })));
    return ingestSummary(importId, fresh, { duplicatesInFile, supersededRows, supersededImports: [...supersededImports], rejected });
  }
}

/* ------------------------------------------------------------- aggregation */

export type CostDimension =
  | 'project'
  | 'service'
  | 'region'
  | 'resource'
  | 'chargeCategory'
  | 'day'
  | `label:${string}`;

export interface CostFilter {
  from?: string;
  to?: string;
  projects?: string[];
  regions?: string[];
  services?: string[];
}

export interface CostGroup {
  key: string;
  label: string;
  totals: Money[];
  rows: number;
  /** True when the dimension value is missing on the row (unattributed). */
  unattributed: boolean;
  /** For a label breakdown: where the value came from (the row's Tags, the inventory join, or both across rows). */
  labelSource?: 'tags' | 'inventory' | 'mixed';
  /** Rows of the group drawn from a trial or promo credit (x_TrialId set). */
  creditFundedRows?: number;
  /**
   * The group's rows that count as spend (countsAsSpend), when tax or credit rows make it differ from `totals`:
   * what a budget for this project counts (F1.48). Absent when the two are the same.
   */
  spendTotals?: Money[];
}

export interface CostReport {
  metric: CostMetric;
  dimension: CostDimension;
  groups: CostGroup[];
  totals: Money[];
  /** The same metric over the rows that count as spend (countsAsSpend): what Budgets measure against. */
  spendTotals?: Money[];
  /** Rows with no value for the chosen metric (excluded, counted). */
  rowsWithoutMetric: number;
  rowsByCategory: Record<string, number>;
  attributionNote?: string;
  /** Rows (and their cost in this metric) drawn from a trial or promo credit: x_TrialId is set. */
  creditFunded?: { rows: number; totals: Money[] };
}

export const UNATTRIBUTED = '(unattributed)';
/**
 * The group of tax rows that carry no value for the dimension (contract-level VAT has no project, region, service or
 * resource): named, not "unattributed", on every tab (G4.13).
 */
export const TAX_GROUP_KEY = '(tax / contract-level)';

/** Labels known for a resource id, from the inventory join (the fallback for rows without Tags). */
export type LabelLookup = (resourceId: string) => Record<string, string> | undefined;

/**
 * Parses the FOCUS Tags cell (map<string,string>; encoding undocumented):
 * a JSON object first, then `k=v` / `k:v` pairs separated by `,` or `;`.
 * Anything else, and an empty map, is treated as no tags (the raw text stays on the row).
 */
export function parseTags(raw: string): Record<string, string> | undefined {
  const text = raw.trim();
  if (!text || text === '{}') return undefined;
  if (text.startsWith('{')) {
    try {
      const obj = JSON.parse(text);
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return undefined;
      const out: Record<string, string> = Object.create(null);
      for (const [k, v] of Object.entries(obj)) if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = String(v);
      return Object.keys(out).length ? out : undefined;
    } catch {
      return undefined;
    }
  }
  const out: Record<string, string> = Object.create(null);
  for (const part of text.split(/[,;]/)) {
    if (!part.trim()) continue;
    const m = /^\s*([^=:\s]+)\s*[=:]\s*(.*?)\s*$/.exec(part);
    if (!m) return undefined;
    out[m[1]] = m[2];
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Spend, as budgets count it: every row but tax and credit rows (console budgets exclude VAT; a credit row is the
 * credit itself, not spend). Adjustments count. The reported total (every row) and this figure sit side by side on
 * the Overview, labelled with SPEND_EXCLUDES, so the two numbers never read as one disagreeing with the other.
 */
export function countsAsSpend(r: Pick<StoredBillingRecord, 'chargeCategory'>): boolean {
  return !/^(tax|credit)$/i.test(r.chargeCategory);
}

export const SPEND_EXCLUDES = 'excl. tax and credits';

export function filterRecords(records: StoredBillingRecord[], f: CostFilter): StoredBillingRecord[] {
  return records.filter(r => {
    if (r.supersededBy) return false;
    if (f.from && r.chargePeriodStart < f.from) return false;
    if (f.to && r.chargePeriodStart >= f.to) return false;
    if (f.projects?.length && !f.projects.includes(attributedProject(r).id)) return false;
    if (f.regions?.length && !f.regions.includes(r.regionId)) return false;
    if (f.services?.length && !f.services.includes(r.serviceName)) return false;
    return true;
  });
}

export function aggregateCosts(
  records: StoredBillingRecord[],
  metric: CostMetric,
  dimension: CostDimension,
  filter: CostFilter = {},
  labels?: LabelLookup,
): CostReport {
  const rows = filterRecords(records, filter);
  const groups = new Map<string, { label: string; bag: MoneyBag; spend: MoneyBag; excluded: boolean; rows: number; unattributed: boolean; sources: Set<'tags' | 'inventory'>; credit: number }>();
  const credit = { rows: 0, bag: new MoneyBag() };
  const sourceRows = { tags: 0, inventory: 0, none: 0 };
  const total = new MoneyBag();
  const spend = new MoneyBag();
  const rowsByCategory: Record<string, number> = {};
  let rowsWithoutMetric = 0;

  for (const r of rows) {
    rowsByCategory[r.chargeCategory || '(none)'] = (rowsByCategory[r.chargeCategory || '(none)'] ?? 0) + 1;
    const amount = r.costs[metric];
    if (amount === null) {
      rowsWithoutMetric++;
      continue;
    }
    const { key, label, source } = dimensionValue(r, dimension, labels);
    const unattributed = key === UNATTRIBUTED;
    const g = groups.get(key) ?? { label, bag: new MoneyBag(), spend: new MoneyBag(), excluded: false, rows: 0, unattributed, sources: new Set(), credit: 0 };
    if (source) g.sources.add(source);
    if (r.trialId) {
      g.credit++;
      credit.rows++;
      credit.bag.add(amount, r.currency);
    }
    sourceRows[source ?? 'none']++;
    g.bag.add(amount, r.currency);
    g.rows++;
    groups.set(key, g);
    total.add(amount, r.currency);
    if (countsAsSpend(r)) {
      spend.add(amount, r.currency);
      g.spend.add(amount, r.currency);
    } else g.excluded = true;
  }

  const out: CostGroup[] = [...groups.entries()].map(([key, g]) => ({
    key,
    label: g.label,
    totals: g.bag.toList(),
    rows: g.rows,
    unattributed: g.unattributed,
    ...(g.sources.size ? { labelSource: g.sources.size > 1 ? ('mixed' as const) : [...g.sources][0] } : {}),
    ...(g.credit ? { creditFundedRows: g.credit } : {}),
    // Only when it differs (G4.12): a 0.00 tax row leaves the figure unchanged and adds no second line.
    ...(g.excluded && !sameMoney(g.bag, g.spend) ? { spendTotals: g.spend.toList() } : {}),
  }));
  out.sort((a, b) => {
    if (dimension === 'day') return a.key.localeCompare(b.key);
    const av = a.totals[0] ? Decimal.from(a.totals[0].amount) : Decimal.ZERO;
    const bv = b.totals[0] ? Decimal.from(b.totals[0].amount) : Decimal.ZERO;
    return bv.cmp(av);
  });
  return {
    metric,
    dimension,
    groups: out,
    totals: total.toList(),
    spendTotals: spend.toList(),
    rowsWithoutMetric,
    rowsByCategory,
    ...(credit.rows ? { creditFunded: { rows: credit.rows, totals: credit.bag.toList() } } : {}),
    attributionNote: dimension.startsWith('label:')
      ? `Label values: ${sourceRows.tags} row(s) from the export's own Tags (cost allocation labels, Compute resources), ${sourceRows.inventory} from joining ResourceId to the current inventory (rows without that tag), ${sourceRows.none} without the label.`
      : undefined,
  };
}

/** The same amount in every currency of either bag (a currency missing from one counts as zero). */
function sameMoney(a: MoneyBag, b: MoneyBag): boolean {
  return [...new Set([...a.currencies(), ...b.currencies()])].every(c => a.get(c).cmp(b.get(c)) === 0);
}

function dimensionValue(
  r: StoredBillingRecord,
  d: CostDimension,
  labels?: LabelLookup,
): { key: string; label: string; source?: 'tags' | 'inventory' } {
  const contractTax = (d === 'project' || d === 'service' || d === 'region' || d === 'resource') && /^tax$/i.test(r.chargeCategory);
  const pick = (key: string, label?: string) =>
    key ? { key, label: label || key } : contractTax ? { key: TAX_GROUP_KEY, label: `Tax / contract-level (no ${d})` } : { key: UNATTRIBUTED, label: UNATTRIBUTED };
  switch (d) {
    case 'project': {
      const p = attributedProject(r);
      return pick(p.id, p.name ? `${p.name} (${p.id})` : p.id);
    }
    case 'service':
      return pick(r.serviceName);
    case 'region':
      return pick(r.regionId);
    case 'resource':
      return pick(r.resourceId, r.resourceName ? `${r.resourceName} (${r.resourceId})` : r.resourceId);
    case 'chargeCategory':
      return pick(r.chargeClass ? `${r.chargeCategory} / ${r.chargeClass}` : r.chargeCategory);
    case 'day':
      return pick(r.chargePeriodStart.slice(0, 10));
    default: {
      const labelKey = d.slice('label:'.length);
      const tagged = parseTags(r.tagsRaw ?? '')?.[labelKey];
      if (tagged) return { ...pick(tagged), source: 'tags' };
      const joined = r.resourceId ? labels?.(r.resourceId)?.[labelKey] : undefined;
      return joined ? { ...pick(joined), source: 'inventory' } : pick('');
    }
  }
}

/* ---------------------------------------------------------- export health */

export interface ExportHealth {
  rows: number;
  activeRows: number;
  imports: number;
  earliestChargePeriodStart?: string;
  /** The newest charge-period start: the last row a [from, to) range on charge-period start includes (F1.19). */
  latestChargePeriodStart?: string;
  /** The end of the newest charge period: the reporting period (a month-long row ends at the next month), not freshness. */
  latestChargePeriodEnd?: string;
  /**
   * The last exported hour: the newest end among usage rows (charge periods of one hour or less; the newest hour
   * may end early, at the export's data end), else the newest start + 1 h. Freshness and lag are dated by this.
   */
  exportedThrough?: string;
  /** The first hour with a usage row, floored to the hour (month-long rows such as tax are not usage). */
  firstUsageHour?: string;
  /** Whole hours between `exportedThrough` and `now` (the domain's one rounding rule, `lagHours` in time.ts). */
  lagHours?: number;
  /**
   * What the usage rows cover, instead of a missing-hour count: FOCUS periodic exports only hold rows for hours with
   * usage, so an hour or a day without rows is idle or missing and the export alone cannot tell which
   * (docs/portal/billing-and-pricing.md#export-completeness). Undefined without a usage row.
   */
  coverage?: ExportCoverage;
  currencies: string[];
  billingPeriods: string[];
}

export interface ExportCoverage {
  /** The first usage hour (floored). */
  from: string;
  /** The last exported moment (`exportedThrough`). */
  through: string;
  /** Hour slots from `from` up to `through` (a partial last hour counts). */
  spanHours: number;
  /** Distinct hour slots (floored, across accounts) holding at least one usage row. */
  hoursWithUsage: number;
  /** Whole UTC days strictly between the first and the last usage day with no usage row: idle, or missing. */
  daysWithoutUsage: string[];
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Coverage of the usage rows: hour slots are floored, so a row starting 15:48:47 is the 15:00 slot. */
function exportCoverage(usage: Pick<BillingRecord, 'chargePeriodStart'>[], through: string | undefined): ExportCoverage | undefined {
  if (!usage.length || !through) return undefined;
  const slots = new Set(usage.map(r => Math.floor(Date.parse(r.chargePeriodStart) / HOUR_MS) * HOUR_MS));
  const from = minOf([...slots]);
  const last = maxOf([...slots]);
  const days = new Set([...slots].map(t => Math.floor(t / DAY_MS)));
  const daysWithoutUsage: string[] = [];
  for (let d = Math.floor(from / DAY_MS) + 1; d < Math.floor(last / DAY_MS); d++) {
    if (!days.has(d)) daysWithoutUsage.push(new Date(d * DAY_MS).toISOString().slice(0, 10));
  }
  return {
    from: new Date(from).toISOString(),
    through,
    spanHours: Math.max(1, Math.ceil((Date.parse(through) - from) / HOUR_MS)),
    hoursWithUsage: slots.size,
    daysWithoutUsage,
  };
}

/** A usage row: a charge period of one hour or less (month-long rows such as tax or subscriptions are not). */
function isUsageHour(r: Pick<BillingRecord, 'chargePeriodStart' | 'chargePeriodEnd'>): boolean {
  const span = Date.parse(r.chargePeriodEnd) - Date.parse(r.chargePeriodStart);
  return span > 0 && span <= HOUR_MS;
}

/**
 * A row charged for more than a day (a month-long tax or subscription row): it belongs to no single day, so a day
 * axis leaves it out and says so, while totals keep it (G4.10).
 */
export function spansMoreThanADay(r: Pick<BillingRecord, 'chargePeriodStart' | 'chargePeriodEnd'>): boolean {
  return Date.parse(r.chargePeriodEnd) - Date.parse(r.chargePeriodStart) > DAY_MS;
}

/**
 * The last exported hour of a set of rows: the newest end among usage rows (the newest hour can end early, at the
 * export's data end), else the newest start + 1 h. Never a month-long row's end, which lies in the future.
 */
export function exportedThrough(rows: Pick<BillingRecord, 'chargePeriodStart' | 'chargePeriodEnd'>[]): string | undefined {
  const usage = rows.filter(isUsageHour);
  if (usage.length) return new Date(maxOf(usage.map(r => Date.parse(r.chargePeriodEnd)))).toISOString();
  const starts = rows.map(r => Date.parse(r.chargePeriodStart)).filter(Number.isFinite);
  return starts.length ? new Date(maxOf(starts) + HOUR_MS).toISOString() : undefined;
}

/** Max / min without spreading (exports can hold more rows than a call takes arguments). */
function maxOf(xs: number[]): number {
  return xs.reduce((a, b) => (b > a ? b : a), -Infinity);
}
function minOf(xs: number[]): number {
  return xs.reduce((a, b) => (b < a ? b : a), Infinity);
}

/**
 * Export health from the active (non-superseded) rows, plus the counts of
 * all stored rows and imports for the same selection.
 */
export function exportHealth(active: StoredBillingRecord[], stored: { rows: number; imports: number }, now: Date): ExportHealth {
  const starts = active.map(r => r.chargePeriodStart).sort();
  const ends = active.map(r => r.chargePeriodEnd).sort();
  const latest = ends[ends.length - 1];
  const through = exportedThrough(active);
  const usage = active.filter(isUsageHour);
  const coverage = exportCoverage(usage, through);
  return {
    rows: stored.rows,
    activeRows: active.length,
    imports: stored.imports,
    earliestChargePeriodStart: starts[0],
    latestChargePeriodStart: starts[starts.length - 1],
    latestChargePeriodEnd: latest,
    exportedThrough: through,
    firstUsageHour: coverage?.from,
    lagHours: lagHours(through, now),
    coverage,
    currencies: [...new Set(active.map(r => r.currency))].sort(),
    billingPeriods: [...new Set(active.map(r => r.billingPeriodStart.slice(0, 7)).filter(Boolean))].sort(),
  };
}

/**
 * The date range a Costs view applies, as UTC days [from, to): the ends the user chose, and for an empty end the
 * day of the first row and the day after the last (rows are selected on charge-period start). Shown in the date
 * fields so an empty field never hides the range in force (F1.19); `*Implicit` marks an end the rows set.
 */
export function effectiveRange(
  h: Pick<ExportHealth, 'earliestChargePeriodStart' | 'latestChargePeriodStart'>,
  chosen: { from: string; to: string },
): { from: string; to: string; fromImplicit: boolean; toImplicit: boolean } {
  const dayOf = (at?: string) => (at ? new Date(at).toISOString().slice(0, 10) : '');
  const dayAfter = (at?: string) => (at ? new Date(Date.parse(`${dayOf(at)}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10) : '');
  return {
    from: chosen.from || dayOf(h.earliestChargePeriodStart),
    to: chosen.to || dayAfter(h.latestChargePeriodStart),
    fromImplicit: !chosen.from,
    toImplicit: !chosen.to,
  };
}

/* ----------------------------------------------------------------- budgets */

/**
 * Budgets are advisory: a figure to compare reported cost against. They do
 * not cap spend (docs/cost.md: "Budgets notify, quotas stop"), and Nebius
 * console budgets are configured in the console, not here.
 */
export const budgetSchema = z.object({
  id: z.string(),
  scope: z.object({ project: z.string().optional() }),
  amount: z.string().refine(s => Decimal.isValid(s)),
  currency: z.string().regex(/^[A-Z]{3}$/),
  period: z.string().regex(/^\d{4}-\d{2}$/),
  source: z.string(),
});
export type Budget = z.infer<typeof budgetSchema>;

export interface BudgetStatus extends Budget {
  reported: string;
  percent: number | null;
  state: 'under' | 'near' | 'over' | 'no-data';
  /** The state in words; for no-data, why (spend in another currency, or nothing reported for the period yet). */
  statusText: string;
  basis: 'BilledCost';
  note: string;
  /** The end of the newest counted charge period: "billing through" on the row (W1-P22). */
  billedThrough?: string;
}

/** Charge-period range [from, to) of a budget period (YYYY-MM). */
export function budgetPeriodRange(period: string): { from: string; to: string } {
  const start = new Date(`${period}-01T00:00:00.000Z`);
  const end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + 1);
  return { from: start.toISOString(), to: end.toISOString() };
}

export function budgetStatus(b: Budget, records: StoredBillingRecord[]): BudgetStatus {
  let total = Decimal.ZERO;
  let rows = 0;
  let through = '';
  const others = new Set<string>();
  for (const r of records) {
    if (r.supersededBy || !countsAsSpend(r)) continue;
    if (!r.billingPeriodStart.startsWith(b.period)) continue;
    if (b.scope.project && attributedProject(r).id !== b.scope.project) continue;
    if (r.currency !== b.currency) {
      others.add(r.currency);
      continue;
    }
    total = total.add(r.costs.BilledCost ?? '0');
    rows++;
    if (r.chargePeriodEnd > through) through = r.chargePeriodEnd;
  }
  const amount = Decimal.from(b.amount);
  const percent = amount.isZero() ? null : Math.round(total.div(amount).mul(100).toNumber() * 10) / 10;
  const state = rows === 0 ? 'no-data' : percent === null ? 'under' : percent >= 100 ? 'over' : percent >= 80 ? 'near' : 'under';
  return {
    ...b,
    reported: total.toString(),
    percent,
    state,
    statusText:
      state === 'no-data'
        ? others.size
          ? `No data: spend is in ${[...others].sort().join(', ')}, this budget in ${b.currency}`
          : `No spend reported for ${b.period} yet`
        : state === 'over'
          ? 'Over the amount'
          : state === 'near'
            ? '80 % of the amount or more'
            : 'Under 80 % of the amount',
    basis: 'BilledCost',
    ...(through ? { billedThrough: through } : {}),
    note: `Advisory: reported BilledCost to date in this currency, ${SPEND_EXCLUDES}, vs. the recorded budget. Not a spend cap; data lags the export.`,
  };
}

/** When the next export file is expected, from the times the last files arrived in the bucket (#12). */
export interface ExportCadence {
  expectedAt: string;
  intervalMinutes: number;
  /** How many arrivals the estimate is made from. */
  files: number;
  /** The expected time has passed without a newer file. */
  late: boolean;
}

/**
 * The next export file's expected time (#12): the newest arrival plus the mean interval of the last arrivals (bucket
 * LastModified times). Nebius writes the periodic export about once an hour (docs signup-billing/usage/export,
 * periodic export); this is an estimate from what was observed, never a promise. Undefined when the cadence cannot be
 * observed: fewer than three arrivals, an interval outside 15 min–6 h, or intervals that are not regular.
 */
export function exportCadence(arrivals: string[], now: Date): ExportCadence | undefined {
  const times = [...new Set(arrivals.map(a => Date.parse(a)).filter(t => !Number.isNaN(t)))].sort((a, b) => b - a).slice(0, 12);
  if (times.length < 3) return undefined;
  const gaps = times.slice(1).map((t, i) => (times[i] - t) / 60_000);
  const interval = Math.round((times[0] - times[times.length - 1]) / 60_000 / gaps.length);
  if (interval < 15 || interval > 360 || gaps.some(g => g < interval * 0.5 || g > interval * 1.5)) return undefined;
  const expected = times[0] + interval * 60_000;
  return { expectedAt: new Date(expected).toISOString(), intervalMinutes: interval, files: times.length, late: expected < now.getTime() };
}

/**
 * "next pull 21:45 UTC · next export file expected ≈ 22:16 UTC (estimate …)" for the freshness lines of Costs, Budgets
 * and the Overview (#12). Each part only when known; undefined when neither is.
 */
export function exportFreshnessText(f: { nextRunAt?: string; nextFile?: ExportCadence }, now: Date): string | undefined {
  const at = (t: string) => {
    const d = new Date(t).toISOString();
    return `${d.slice(0, 10) === now.toISOString().slice(0, 10) ? '' : `${d.slice(0, 10)} `}${d.slice(11, 16)} UTC`;
  };
  const parts: string[] = [];
  if (f.nextRunAt) parts.push(`next pull ${at(f.nextRunAt)}`);
  if (f.nextFile) {
    const basis = `(estimate from the last ${f.nextFile.files} arrivals; Nebius writes the periodic export about hourly)`;
    parts.push(f.nextFile.late ? `next export file was expected ≈ ${at(f.nextFile.expectedAt)}, not arrived yet ${basis}` : `next export file expected ≈ ${at(f.nextFile.expectedAt)} ${basis}`);
  }
  return parts.length ? parts.join(' · ') : undefined;
}
