import { z } from 'zod';
import { attributedProject, BudgetStatus, countsAsSpend, ExportCadence, SPEND_EXCLUDES, StoredBillingRecord } from './billing';
import { Decimal } from './decimal';
import { Money, MoneyBag } from './money';
import { fmtMoney, fmtMoneyOf, fmtNumber, fmtThreshold } from './format';

/**
 * Budgets and credits the owner tracks (Budgets & credits page).
 *
 * Nebius AI Cloud has no API for budgets, the balance or promo credits, and Token Factory has no
 * usage or balance API (checked 2026-10-11). So the owner enters each budget, mirroring the console
 * (Billing → Budgets: name, Daily/Monthly/Quarterly/Yearly period aligned to 00:00 UTC calendar
 * boundaries, all usage or conditions on region/project/service/product, amount, thresholds), and each
 * credit. They are local data, labelled "entered by you", stored in the portal database.
 *
 * Spend comes from the best source available, labelled per part:
 *  - actual: FOCUS export rows (BilledCost, tax and credit rows excluded: countsAsSpend);
 *  - estimate: the live run-rate × the hours since the last exported hour;
 *  - entered: Token Factory spend the owner copies from its Usage tab.
 * Forecasts use the burn rate since the first observed spend. Currencies are never combined.
 */

export const BUDGET_PERIODS = ['daily', 'monthly', 'quarterly', 'yearly'] as const;
export type BudgetPeriod = (typeof BUDGET_PERIODS)[number];

export const SPEND_PROVIDERS = ['ai-cloud', 'token-factory'] as const;
export type SpendProvider = (typeof SPEND_PROVIDERS)[number];

export const SPEND_PROVIDER_LABELS: Record<SpendProvider, string> = { 'ai-cloud': 'Nebius AI Cloud', 'token-factory': 'Token Factory' };

/** Where each budget mirrors from, and where credits and Token Factory usage are read by hand. */
export const CONSOLE_LINKS = { billing: 'https://console.nebius.com/billing', tokenFactory: 'https://tokenfactory.nebius.com' } as const;

/** A credit expiring within this many days raises a warning. */
export const CREDIT_EXPIRY_WARNING_DAYS = 14;

/** A forecast needs this much burn history before it alerts: a few hours of spend extrapolated over a month is noise. */
export const FORECAST_MIN_HOURS = 24;

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

const decimalText = z
  .string()
  .trim()
  .refine(s => Decimal.isValid(s), 'a plain decimal number such as 25 or 25.50');
const positive = decimalText.refine(s => Decimal.isValid(s) && Decimal.from(s).cmp(0) > 0, 'greater than 0');
const nonNegative = decimalText.refine(s => Decimal.isValid(s) && !Decimal.from(s).isNegative(), '0 or more');
const currency = z.string().trim().toUpperCase().pipe(z.string().regex(/^[A-Z]{3}$/, 'a three-letter currency code')).default('USD');
export const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'a date (YYYY-MM-DD)')
  // zod runs this even when the pattern failed: an empty or malformed text is an invalid Date, not a throw.
  .refine(s => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, 'not a calendar date');
const conditions = (re: RegExp, what: string) => z.array(z.string().trim().regex(re, what)).max(50).default([]);

/** Console scope: no condition is "All usage"; with several, a row must match all of them. */
export const budgetScopeSchema = z.object({
  regions: conditions(/^[a-z]{2}-[a-z]+\d$/, 'a region id such as eu-north1'),
  projects: conditions(/^project-[a-z0-9]+$/, 'a project id (project-…)'),
  /** FOCUS ServiceName, e.g. Compute, Object Storage (case-insensitive). */
  services: conditions(/^[^\n]{1,80}$/, 'a service name'),
  /** A SKU id or the product name (FOCUS SkuId or ChargeDescription), case-insensitive. */
  products: conditions(/^[^\n]{1,120}$/, 'a SKU id or product name'),
});
export type BudgetScope = z.infer<typeof budgetScopeSchema>;

export const budgetInputSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    provider: z.enum(SPEND_PROVIDERS).default('ai-cloud'),
    period: z.enum(BUDGET_PERIODS),
    scope: budgetScopeSchema.default({ regions: [], projects: [], services: [], products: [] }),
    amount: positive,
    currency,
    thresholds: z.object({ unit: z.enum(['percent', 'absolute']), values: z.array(positive).min(1).max(10) }).default({ unit: 'percent', values: ['50', '80', '100'] }),
    note: z.string().trim().max(500).optional(),
  })
  .superRefine((b, c) => {
    const s = b.scope;
    if (b.provider === 'token-factory' && s.regions.length + s.projects.length + s.services.length + s.products.length > 0) {
      c.addIssue({ code: 'custom', path: ['scope'], message: 'conditions are AI Cloud console fields; a Token Factory budget tracks all of its spend' });
    }
  });
export type BudgetInput = z.infer<typeof budgetInputSchema>;

export const creditInputSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    provider: z.enum(SPEND_PROVIDERS),
    amount: positive,
    currency,
    appliedOn: dateOnly,
    /** Valid through the end of this day (UTC); none = no expiry known. */
    expiresOn: dateOnly.optional(),
    note: z.string().trim().max(500).optional(),
  })
  .refine(c => !c.expiresOn || c.expiresOn >= c.appliedOn, { path: ['expiresOn'], message: 'the expiry is before the applied date' });
export type CreditInput = z.infer<typeof creditInputSchema>;

/** Token Factory spend on one day, copied from its Usage tab (no usage API exists). */
export const spendEntryInputSchema = z.object({
  provider: z.literal('token-factory'),
  date: dateOnly,
  amount: nonNegative,
  currency,
  note: z.string().trim().max(500).optional(),
});
export type SpendEntryInput = z.infer<typeof spendEntryInputSchema>;

/** The form fields a plain-words message can name (the budget scope's lists by their own name). */
export type FormField = 'name' | 'provider' | 'period' | 'amount' | 'currency' | 'thresholds' | 'regions' | 'projects' | 'services' | 'products' | 'scope' | 'appliedOn' | 'expiresOn' | 'date' | 'note';

const PLAIN: Record<FormField, string> = {
  name: 'Enter a name (up to 80 characters).',
  provider: 'Pick a provider from the list.',
  period: 'Pick a time period from the list.',
  amount: 'Enter an amount greater than 0, such as 100 or 99.50.',
  currency: 'Enter a three-letter currency code, such as USD.',
  thresholds: 'Enter 1 to 10 thresholds above 0, separated by commas, such as 50, 80, 100.',
  regions: 'Enter region ids such as eu-north1, separated by commas.',
  projects: 'Pick projects from the list.',
  services: 'Enter service names of up to 80 characters, separated by ;, such as Compute.',
  products: 'Enter SKU ids or product names of up to 120 characters, separated by ;.',
  scope: 'Conditions are for AI Cloud budgets; a Token Factory budget tracks all of its spend.',
  appliedOn: 'Pick the date the credit applies from.',
  expiresOn: 'Pick a date, or leave it empty for no expiry.',
  date: 'Pick the day of the spend.',
  note: 'Keep the note to 500 characters.',
};

/**
 * Client-side check of a budget, credit or spend form against the same schema the route applies, as one
 * plain-words message per field (never the schema's own wording). Empty when the input would be accepted.
 */
export function formIssues(kind: 'budget' | 'credit' | 'spend', input: unknown): Partial<Record<FormField, string>> {
  const schema = kind === 'budget' ? budgetInputSchema : kind === 'credit' ? creditInputSchema : spendEntryInputSchema;
  const r = schema.safeParse(input);
  const out: Partial<Record<FormField, string>> = {};
  if (r.success) return out;
  for (const issue of r.error.issues) {
    const [top, sub] = issue.path.map(String);
    const field = (top === 'scope' && sub ? sub : top) as FormField;
    if (!(field in PLAIN) || out[field]) continue;
    if (field === 'expiresOn' && issue.code === 'custom') out.expiresOn = 'The expiry is before the applied date.';
    else if (field === 'amount' && kind === 'spend') out.amount = 'Enter the spend of that day as 0 or more, such as 12.40.';
    else out[field] = PLAIN[field];
  }
  return out;
}

/** Stored with the user who last saved it (team-ready: every row carries its owner). */
interface Stored {
  id: string;
  createdBy: string;
  updatedAt: string;
}
export type BudgetRecord = BudgetInput & Stored;
export type CreditRecord = CreditInput & Stored;
export type SpendEntryRecord = SpendEntryInput & Stored;

/* ------------------------------------------------------------------ inputs */

export interface RunRateQuote {
  /** Spend per hour of the running inventory in scope. */
  hourly: Money;
  asOf: string;
  source: string;
  /** Running resources in scope the calculator could not price: not in `hourly`, so every figure built on it says so. */
  unpriced?: number;
}

/** Everything a budget or credit is measured against; the backend builds it, the rest is pure. */
export interface SpendContext {
  now: Date;
  /** Active FOCUS rows covering at least the periods evaluated. */
  rows: StoredBillingRecord[];
  /** Over all imported rows: the first exported hour and the end of the newest one. */
  coverage: { earliestStart?: string; latestEnd?: string };
  /** Live run-rate for the scope evaluated (whole account for credits and the summary). */
  runRate?: RunRateQuote;
  runRateUnavailable?: string;
  /** The run-rate is unavailable because nothing in scope runs (after an inventory read): a fact, not a failure (#69). */
  nothingRunning?: boolean;
  entries: SpendEntryRecord[];
}

/* ------------------------------------------------------------------ output */

export type SpendSource = 'focus-export' | 'live-run-rate' | 'token-factory-entries';

export const SPEND_SOURCE_LABELS: Record<SpendSource, string> = {
  'focus-export': `FOCUS export, ${SPEND_EXCLUDES} (actual)`,
  'live-run-rate': 'Live run-rate since the last exported hour (estimate)',
  'token-factory-entries': 'Token Factory spend entered by you',
};

export interface SpendPart {
  source: SpendSource;
  kind: 'actual' | 'estimate' | 'entered';
  amount: Money;
  /** How fresh the figure is: the end of the newest exported hour, the run-rate time, or the newest entry date. */
  asOf?: string;
  note: string;
  /**
   * The figure rests on an assumption, not on what the export says: an AI Cloud credit drawn from all spend because
   * the export marks no row as credit-funded (x_TrialId empty; G4.9).
   */
  assumed?: true;
}

export interface ThresholdView {
  /** The value as entered (percent or absolute). */
  entered: string;
  value: Money;
  percent: number | null;
  /** Crossed by the actual spend, only by the projection (actual + estimate), or not at all. */
  crossed: 'actual' | 'estimate' | false;
}

export type BudgetState = 'ok' | 'at-threshold' | 'over' | 'no-data';

export interface BudgetView extends BudgetRecord {
  window: { start: string; end: string };
  /** `total` adds the estimate to `actual` (export rows and entered spend); Used is `actual`. */
  spend: { parts: SpendPart[]; total: Money; actual: Money };
  /** Used: the actual against the amount. The status and every threshold crossing count the actual only. */
  percent: number | null;
  /**
   * The actual plus the live run-rate estimate since the last exported hour, shown and alerted apart from Used;
   * null when no estimate was added.
   */
  projection: { total: Money; estimate: Money; percent: number | null; over: boolean; text: string } | null;
  burnRate: { perDay: Money; since: string } | null;
  /** The average-burn period end as the forecast signal reads it (no minimum history; the signal applies its own). */
  forecast: { periodEnd: Money; percent: number | null; overAmount: boolean } | null;
  /**
   * The two forecast lines shown (W1-P20): at this period's average burn (needs a day of spend), and if nothing new
   * runs (spend so far plus the live run-rate to the period end). Each is withheld with its reason when it cannot be made.
   */
  forecasts: { averageBurn: ForecastLine; nothingNew: ForecastLine };
  /** Each entered threshold, evaluated. */
  thresholdStates: ThresholdView[];
  status: BudgetState;
  statusText: string;
  /** Why a figure is missing or partial (no export yet, other currencies, no estimate). */
  notes: string[];
}

/**
 * `unverified`: nothing the credit's provider spends is known since it applied (no Token Factory spend entered in its
 * validity, or no AI Cloud export rows), so "left" is only an upper bound (#36); an expiry warning still takes precedence,
 * and `remainingAtMost` is set on every unverified credit, whatever its status. `exhausting`: the current burn uses it
 * up within CREDIT_EXPIRY_WARNING_DAYS (W1-P21).
 */
export type ForecastLine = { periodEnd: Money; percent: number | null; overAmount: boolean; text: string } | { withheld: string };

export type CreditStatus = 'ok' | 'expiring' | 'exhausting' | 'expired' | 'used-up' | 'not-started' | 'unverified';

export interface CreditView extends CreditRecord {
  used: { parts: SpendPart[]; total: Money };
  remaining: Money;
  percentUsed: number;
  burnRate: { perDay: Money; since: string } | null;
  /** Date the credit runs out at the current burn rate (UTC); null when not burning or used up. */
  exhaustsOn: string | null;
  /** null without an expiry date or an exhaustion date. */
  exhaustsBeforeExpiry: boolean | null;
  daysToExpiry: number | null;
  status: CreditStatus;
  statusText: string;
  notes: string[];
  /** Set when no spend is known for the credit (`unverified`): `remaining` is at most this, never a measured figure (#36). */
  remainingAtMost?: true;
}

/**
 * The tone of a credit wherever it is shown (W1-P21): green only for an active credit with a known expiry; a missing
 * expiry, an unverified, expired or not yet started credit is grey; one expiring, running out or used up is amber.
 */
export function creditTone(c: Pick<CreditView, 'status' | 'expiresOn'>): 'ok' | 'warn' | 'neutral' | 'info' {
  switch (c.status) {
    case 'ok':
      return c.expiresOn ? 'ok' : 'neutral';
    case 'expiring':
    case 'exhausting':
    case 'used-up':
      return 'warn';
    case 'not-started':
      return 'info';
    default:
      return 'neutral';
  }
}

/* ------------------------------------------------------------------- dates */

const iso = (ms: number) => new Date(ms).toISOString();
const dayStart = (date: string) => Date.parse(`${date}T00:00:00.000Z`);
const todayOf = (now: Date) => now.toISOString().slice(0, 10);

/** The current period: starts at 00:00 UTC, aligned to the calendar (quarters on Jan/Apr/Jul/Oct 1). */
export function periodWindow(period: BudgetPeriod, now: Date): { start: string; end: string } {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  const at = (yy: number, mm: number, dd = 1) => iso(Date.UTC(yy, mm, dd));
  switch (period) {
    case 'daily':
      return { start: at(y, m, d), end: at(y, m, d + 1) };
    case 'monthly':
      return { start: at(y, m), end: at(y, m + 1) };
    case 'quarterly': {
      const q = m - (m % 3);
      return { start: at(y, q), end: at(y, q + 3) };
    }
    default:
      return { start: at(y, 0), end: at(y + 1, 0) };
  }
}

/* --------------------------------------------------------------- matching */

const lower = (xs: string[]) => new Set(xs.map(x => x.toLowerCase()));

/** Console budgets exclude VAT; credit rows are the credit itself, not spend (countsAsSpend, shared with Costs). */
const isSpendRow = countsAsSpend;

function scopeMatcher(scope: BudgetScope) {
  const regions = new Set(scope.regions);
  const projects = new Set(scope.projects);
  const services = lower(scope.services);
  const products = lower(scope.products);
  return (r: StoredBillingRecord) =>
    (!regions.size || regions.has(r.regionId)) &&
    (!projects.size || projects.has(attributedProject(r).id)) &&
    (!services.size || services.has(r.serviceName.toLowerCase())) &&
    (!products.size || products.has(r.skuId.toLowerCase()) || products.has(r.chargeDescription.toLowerCase()));
}

/** The live run-rate prices running Compute (VMs, disks, filesystems); it cannot stand in for other services. */
export function runRateCovers(scope: BudgetScope): boolean {
  return !scope.products.length && scope.services.every(s => s.toLowerCase() === 'compute');
}

/* ----------------------------------------------------------------- helpers */

/**
 * The currencies spend is in when none of it is in the budget's own: amounts are never converted, so such a
 * budget has no data (not 0 %). Empty when the budget's currency is among them or nothing was seen yet.
 */
function otherCurrencies(seen: Iterable<string>, cur: string): string[] {
  const all = new Set(seen);
  return all.size && !all.has(cur) ? [...all].sort() : [];
}
const mismatchNote = (others: string[], cur: string) =>
  `Spend in this scope is in ${others.join(', ')}; this budget is in ${cur}. Edit the budget's currency to ${others[0]} to measure it: amounts are never converted.`;

const percentOf = (part: Decimal, whole: Decimal) => (whole.isZero() ? null : Math.round(part.div(whole).mul(100).toNumber() * 10) / 10);
const m = (amount: Decimal, cur: string): Money => ({ amount: amount.toString(), currency: cur });
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
/** What a run-rate leaves out, as a clause: running resources without a price are not zero, they are unknown. */
const unpricedClause = (r: RunRateQuote) => (r.unpriced ? `${plural(r.unpriced, 'running resource')} without a price ${r.unpriced === 1 ? 'is' : 'are'} not in it` : '');

/** Hours of the estimate: from the end of the newest exported hour (or the window start) to now (or the window end). */
function estimate(ctx: SpendContext, from: number, to: number, cur: string, notes: string[]): SpendPart | undefined {
  if (!ctx.runRate) {
    if (ctx.runRateUnavailable) notes.push(`No live estimate added: ${ctx.runRateUnavailable}`);
    return undefined;
  }
  if (!ctx.coverage.latestEnd) {
    notes.push('No live estimate added: no export rows yet to continue from.');
    return undefined;
  }
  if (ctx.runRate.hourly.currency !== cur) {
    notes.push(`No live estimate added: the run-rate is in ${ctx.runRate.hourly.currency}, the budget in ${cur}.`);
    return undefined;
  }
  const start = Math.max(from, Date.parse(ctx.coverage.latestEnd));
  const end = Math.min(to, ctx.now.getTime());
  if (end <= start) return undefined;
  const hours = Decimal.from(end - start).div(HOUR_MS);
  return {
    source: 'live-run-rate',
    kind: 'estimate',
    amount: m(Decimal.from(ctx.runRate.hourly.amount).mul(hours), cur),
    asOf: ctx.runRate.asOf || undefined,
    note: `${ctx.runRate.hourly.amount} ${cur} / h (${ctx.runRate.source}) × ${fmtNumber(hours.toNumber(), 1)} h since ${iso(start)}. Running Compute, and managed PostgreSQL unless the budget is for Compute, at list or contract price; usage-based charges and MLflow are not included.${ctx.runRate.unpriced ? ` ${unpricedClause(ctx.runRate)[0].toUpperCase()}${unpricedClause(ctx.runRate).slice(1)}.` : ''}`,
  };
}

function burn(total: Decimal, since: number, now: Date, cur: string): { perDay: Money; since: string } | null {
  const elapsed = now.getTime() - since;
  if (elapsed < HOUR_MS || total.isZero()) return null;
  return { perDay: m(total.mul(DAY_MS).div(elapsed), cur), since: iso(since) };
}

/* ----------------------------------------------------------------- budgets */

export function evaluateBudget(b: BudgetRecord, ctx: SpendContext): BudgetView {
  const window = periodWindow(b.period, ctx.now);
  const from = Date.parse(window.start);
  const to = Date.parse(window.end);
  const cur = b.currency;
  const notes: string[] = [];
  const parts: SpendPart[] = [];
  let firstSpend: number | undefined;
  let others: string[] = [];

  if (b.provider === 'token-factory') {
    others = otherCurrencies(ctx.entries.filter(e => e.provider === 'token-factory').map(e => e.currency), cur);
  } else {
    const match = scopeMatcher(b.scope);
    const seen = ctx.rows.filter(r => !r.supersededBy && isSpendRow(r) && match(r)).map(r => r.currency);
    others = otherCurrencies(runRateCovers(b.scope) && ctx.runRate ? [...seen, ctx.runRate.hourly.currency] : seen, cur);
  }

  if (others.length) {
    notes.push(mismatchNote(others, cur));
  } else if (b.provider === 'token-factory') {
    const entries = ctx.entries.filter(e => e.provider === 'token-factory' && dayStart(e.date) >= from && dayStart(e.date) < to);
    const same = entries.filter(e => e.currency === cur);
    if (same.length !== entries.length) notes.push(`${entries.length - same.length} entr${entries.length - same.length === 1 ? 'y' : 'ies'} in other currencies not counted.`);
    if (!ctx.entries.some(e => e.provider === 'token-factory')) notes.push('No Token Factory spend entered yet: copy it from the Usage tab of the Token Factory console.');
    else {
      const newest = same.map(e => e.date).sort().pop();
      parts.push({
        source: 'token-factory-entries',
        kind: 'entered',
        amount: m(Decimal.sum(same.map(e => Decimal.from(e.amount))), cur),
        asOf: newest,
        note: `${same.length} ${same.length === 1 ? 'entry' : 'entries'} entered by you from the Token Factory Usage tab (no usage API exists).`,
      });
      firstSpend = same.map(e => dayStart(e.date)).sort((x, y) => x - y)[0];
    }
  } else {
    const match = scopeMatcher(b.scope);
    const rows = ctx.rows.filter(r => !r.supersededBy && isSpendRow(r) && match(r) && Date.parse(r.chargePeriodStart) >= from && Date.parse(r.chargePeriodStart) < to);
    const same = rows.filter(r => r.currency === cur);
    if (same.length !== rows.length) notes.push(`${rows.length - same.length} row(s) in other currencies not counted (no exchange-rate policy).`);
    if (!ctx.coverage.latestEnd) notes.push('No billing export rows imported yet: configure the export pull or import a FOCUS CSV on Costs.');
    else {
      parts.push({
        source: 'focus-export',
        kind: 'actual',
        amount: m(Decimal.sum(same.map(r => Decimal.from(r.costs.BilledCost ?? '0'))), cur),
        asOf: ctx.coverage.latestEnd,
        note: `${plural(same.length, 'row')} of BilledCost in this period and scope, ${SPEND_EXCLUDES} (console budgets exclude VAT). Exports run hours behind.`,
      });
      // Since the budget's own first spend row (G4.3): the export's earliest start can be a month-long tax row at
      // 00:00 on the 1st, which spread the spend over days without any and put the forecast too low. Without a row
      // the only spend is the live estimate, which runs from the last exported hour.
      const firstRow = same.reduce<number | undefined>((a, r) => {
        const t = Date.parse(r.chargePeriodStart);
        return a === undefined || t < a ? t : a;
      }, undefined);
      firstSpend = firstRow ?? Date.parse(ctx.coverage.latestEnd);
    }
    if (runRateCovers(b.scope)) {
      const e = estimate(ctx, from, to, cur, notes);
      if (e) parts.push(e);
    } else if (ctx.runRate) {
      notes.push('No live estimate added: the run-rate covers Compute and managed PostgreSQL only, and this budget has a service or product condition other than Compute.');
    }
  }

  const total = Decimal.sum(parts.map(p => Decimal.from(p.amount.amount)));
  const actual = Decimal.sum(parts.filter(p => p.kind !== 'estimate').map(p => Decimal.from(p.amount.amount)));
  const amount = Decimal.from(b.amount);
  const thresholdStates: ThresholdView[] = b.thresholds.values.map(v => {
    const value = b.thresholds.unit === 'percent' ? amount.mul(v).div(100) : Decimal.from(v);
    return {
      entered: v,
      value: m(value, cur),
      percent: percentOf(value, amount),
      crossed: actual.cmp(value) >= 0 ? 'actual' : total.cmp(value) >= 0 ? 'estimate' : false,
    };
  });
  const rate = firstSpend === undefined ? null : burn(total, Math.max(from, firstSpend), ctx.now, cur);
  const remainingDays = Decimal.from(Math.max(0, to - ctx.now.getTime())).div(DAY_MS);
  const periodEnd = rate ? total.add(Decimal.from(rate.perDay.amount).mul(remainingDays)) : undefined;
  const line = (end: Decimal, text: string): ForecastLine => ({ periodEnd: m(end, cur), percent: percentOf(end, amount), overAmount: end.cmp(amount) >= 0, text });
  const noRows = b.provider === 'token-factory' ? (ctx.entries.some(e => e.provider === 'token-factory') ? undefined : 'no Token Factory spend entered yet') : ctx.coverage.latestEnd ? undefined : 'no billing export rows yet';
  const burnHours = firstSpend === undefined ? 0 : (ctx.now.getTime() - Math.max(from, firstSpend)) / HOUR_MS;
  const averageBurn: ForecastLine = noRows
    ? { withheld: noRows }
    : others.length
      ? { withheld: `spend is in ${others.join(', ')}, this budget in ${cur}` }
      : burnHours < FORECAST_MIN_HOURS
        ? { withheld: `less than a day of spend in this period (${Math.max(0, Math.round(burnHours))} h)` }
        : rate && periodEnd
          ? line(periodEnd, `at this period's average burn (${fmtMoney(rate.perDay)} a day)`)
          : { withheld: 'no spend in this period yet' };
  const remainingHours = Decimal.from(Math.max(0, to - ctx.now.getTime())).div(HOUR_MS);
  const nothingNew: ForecastLine =
    b.provider === 'token-factory'
      ? { withheld: 'Token Factory has no run-rate: only the spend you enter' }
      : noRows
        ? { withheld: noRows }
        : others.length
          ? { withheld: `spend is in ${others.join(', ')}, this budget in ${cur}` }
          : !runRateCovers(b.scope)
            ? { withheld: 'the run-rate covers Compute and managed PostgreSQL only, and this budget has another service or product condition' }
            : ctx.runRate && ctx.runRate.hourly.currency === cur
              ? line(total.add(Decimal.from(ctx.runRate.hourly.amount).mul(remainingHours)), `if nothing new runs (${fmtMoney(ctx.runRate.hourly)} / h running now${ctx.runRate.unpriced ? `; ${unpricedClause(ctx.runRate)}` : ''})`)
              : ctx.nothingRunning
                ? line(total, 'if nothing new runs (nothing running now)')
                : { withheld: ctx.runRate ? `the run-rate is in ${ctx.runRate.hourly.currency}, the budget in ${cur}` : `no live run-rate${ctx.runRateUnavailable ? `: ${ctx.runRateUnavailable}` : ''}` };
  const noData = parts.length === 0;
  const over = actual.cmp(amount) >= 0;
  const status: BudgetState = noData ? 'no-data' : over ? 'over' : thresholdStates.some(t => t.crossed === 'actual') ? 'at-threshold' : 'ok';
  const crossed = thresholdStates.filter(t => t.crossed === 'actual');
  const unitOf = (t: ThresholdView) => `${t.entered}${b.thresholds.unit === 'percent' ? ' %' : ` ${cur}`}`;
  const estimated = parts.filter(p => p.kind === 'estimate');
  const projectedOnly = thresholdStates.filter(t => t.crossed === 'estimate');
  const projection: BudgetView['projection'] = estimated.length
    ? {
        total: m(total, cur),
        estimate: m(Decimal.sum(estimated.map(p => Decimal.from(p.amount.amount))), cur),
        percent: percentOf(total, amount),
        over: total.cmp(amount) >= 0,
        text: !over && total.cmp(amount) >= 0
          ? 'Projected over the amount with the live estimate'
          : projectedOnly.length
            ? `Projected to cross ${unitOf(projectedOnly[projectedOnly.length - 1])} with the live estimate`
            : 'No further threshold with the live estimate',
      }
    : null;
  return {
    ...b,
    window,
    spend: { parts, total: m(total, cur), actual: m(actual, cur) },
    percent: noData ? null : percentOf(actual, amount),
    projection: noData ? null : projection,
    burnRate: rate,
    forecast: periodEnd ? { periodEnd: m(periodEnd, cur), percent: percentOf(periodEnd, amount), overAmount: periodEnd.cmp(amount) >= 0 } : null,
    forecasts: { averageBurn, nothingNew },
    thresholdStates,
    status,
    statusText:
      status === 'no-data'
        ? others.length
          ? `No data: spend is in ${others.join(', ')}, this budget in ${cur}`
          : 'No spend data for this budget yet'
        : status === 'over'
          ? 'Over the amount'
          : status === 'at-threshold'
            ? `Threshold ${unitOf(crossed[crossed.length - 1])} crossed`
            : 'Within every threshold',
    notes,
  };
}

/* ----------------------------------------------------------------- credits */

interface SpendItem {
  at: number;
  amount: Decimal;
  currency: string;
  part: 'actual' | 'estimate' | 'entered';
}

/** Valid from 00:00 UTC of appliedOn through the end of expiresOn. */
const validity = (c: CreditRecord) => ({ from: dayStart(c.appliedOn), to: c.expiresOn ? dayStart(c.expiresOn) + DAY_MS : Infinity });

/**
 * Each credit draws the spend of its provider and currency inside its validity window. Spend is
 * allocated in time order to the earliest-applied credit that is valid and not used up, so two
 * credits never count the same spend.
 */
export function evaluateCredits(credits: CreditRecord[], ctx: SpendContext): CreditView[] {
  const order = [...credits].sort((a, b) => a.appliedOn.localeCompare(b.appliedOn) || (a.expiresOn ?? '9999').localeCompare(b.expiresOn ?? '9999') || a.id.localeCompare(b.id));
  const earliest = order.length ? Math.min(...order.map(c => validity(c).from)) : 0;
  const now = ctx.now.getTime();

  // AI Cloud spend items: rows marked x_TrialId when the export marks any (drawn from a trial or promo credit), else all spend rows.
  const cloudRows = ctx.rows.filter(r => !r.supersededBy && isSpendRow(r) && Date.parse(r.chargePeriodStart) >= earliest);
  const marked = cloudRows.some(r => r.trialId);
  const cloudNote = marked
    ? 'Rows marked x_TrialId in the export (drawn from trial or promo credit).'
    : `The export marks no row as credit-funded (x_TrialId empty): all spend since the credit was applied, ${SPEND_EXCLUDES}.`;
  const items: Record<string, SpendItem[]> = {
    'ai-cloud': cloudRows
      .filter(r => !marked || r.trialId)
      .map(r => ({ at: Date.parse(r.chargePeriodStart), amount: Decimal.from(r.costs.BilledCost ?? '0'), currency: r.currency, part: 'actual' as const })),
    'token-factory': ctx.entries.filter(e => e.provider === 'token-factory').map(e => ({ at: dayStart(e.date), amount: Decimal.from(e.amount), currency: e.currency, part: 'entered' as const })),
  };
  if (ctx.runRate && ctx.coverage.latestEnd && Date.parse(ctx.coverage.latestEnd) < now) {
    const hours = Decimal.from(now - Date.parse(ctx.coverage.latestEnd)).div(HOUR_MS);
    items['ai-cloud'].push({ at: now - 1, amount: Decimal.from(ctx.runRate.hourly.amount).mul(hours), currency: ctx.runRate.hourly.currency, part: 'estimate' });
  }

  const state = new Map(order.map(c => [c.id, { left: Decimal.from(c.amount), used: { actual: Decimal.ZERO, estimate: Decimal.ZERO, entered: Decimal.ZERO }, first: undefined as number | undefined, newest: undefined as number | undefined }]));
  for (const provider of SPEND_PROVIDERS) {
    for (const item of items[provider].filter(i => i.amount.cmp(0) > 0).sort((a, b) => a.at - b.at)) {
      let rest = item.amount;
      for (const c of order) {
        if (rest.isZero()) break;
        const v = validity(c);
        const s = state.get(c.id)!;
        if (c.provider !== provider || c.currency !== item.currency || item.at < v.from || item.at >= v.to || s.left.isZero()) continue;
        const take = rest.cmp(s.left) <= 0 ? rest : s.left;
        s.left = s.left.sub(take);
        s.used[item.part] = s.used[item.part].add(take);
        s.first = Math.min(s.first ?? item.at, item.at);
        if (item.part !== 'estimate') s.newest = Math.max(s.newest ?? item.at, item.at);
        rest = rest.sub(take);
      }
    }
  }

  const today = dayStart(todayOf(ctx.now));
  return credits.map(c => {
    const s = state.get(c.id)!;
    const cur = c.currency;
    const notes: string[] = [];
    const parts: SpendPart[] = [];
    const v = validity(c);
    // Export rows exist, but none in the credit's validity: what was drawn from it is as unknown as with no rows at all.
    const { earliestStart, latestEnd } = ctx.coverage;
    const exportInValidity = Boolean(latestEnd && Date.parse(latestEnd) > v.from && (!earliestStart || Date.parse(earliestStart) < v.to));
    if (c.provider === 'ai-cloud') {
      if (!latestEnd) notes.push('No billing export rows imported yet: spend against this credit is unknown.');
      else if (!exportInValidity && Date.parse(latestEnd) <= v.from) notes.push(`The billing export ends ${latestEnd.slice(0, 10)}, before this credit applied on ${c.appliedOn}: spend against it is unknown.`);
      if (latestEnd) {
        parts.push({ source: 'focus-export', kind: 'actual', amount: m(s.used.actual, cur), asOf: ctx.coverage.latestEnd, note: cloudNote, ...(marked ? {} : { assumed: true as const }) });
        // Said beside the figure, not only in its tooltip: otherwise "Used up" reads as if Nebius reported it (G4.9).
        if (!marked) notes.push(`${cloudNote} Check the balance in the console (Billing).`);
      }
      if (!s.used.estimate.isZero()) parts.push({ source: 'live-run-rate', kind: 'estimate', amount: m(s.used.estimate, cur), asOf: ctx.runRate?.asOf, note: 'Live run-rate since the last exported hour.' });
      else if (ctx.runRateUnavailable) notes.push(`No live estimate added: ${ctx.runRateUnavailable}`);
    } else {
      parts.push({ source: 'token-factory-entries', kind: 'entered', amount: m(s.used.entered, cur), asOf: s.newest === undefined ? undefined : iso(s.newest).slice(0, 10), note: 'Spend entered by you from the Token Factory Usage tab (no usage or balance API exists).' });
      if (!ctx.entries.some(e => e.provider === 'token-factory')) notes.push('No Token Factory spend entered yet: add it from the Usage tab to track this credit.');
    }
    const used = Decimal.sum(parts.map(p => Decimal.from(p.amount.amount)));
    const amount = Decimal.from(c.amount);
    const remaining = amount.sub(used);
    const rate = s.first === undefined ? null : burn(used, Math.max(v.from, s.first), ctx.now, cur);
    const daysLeft = rate && remaining.cmp(0) > 0 ? remaining.div(rate.perDay.amount).toNumber() : null;
    const exhaustsOn = daysLeft === null ? null : iso(now + daysLeft * DAY_MS).slice(0, 10);
    const daysToExpiry = c.expiresOn ? Math.round((dayStart(c.expiresOn) - today) / DAY_MS) : null;
    // Nothing known about what was drawn since it applied: "25 of 25 left" would read as measured (#36).
    const unverified =
      c.provider === 'token-factory'
        ? !ctx.entries.some(e => e.provider === 'token-factory' && dayStart(e.date) >= v.from && dayStart(e.date) < v.to)
        : !exportInValidity;
    // Runs out within the warning window at a burn of at least a day (a few hours extrapolated is noise; W1-P21).
    const exhausting =
      daysLeft !== null && rate !== null && now - Date.parse(rate.since) >= FORECAST_MIN_HOURS * HOUR_MS && daysLeft <= CREDIT_EXPIRY_WARNING_DAYS && (!exhaustsOn || !c.expiresOn || exhaustsOn <= c.expiresOn);
    const status: CreditStatus =
      today < v.from
        ? 'not-started'
        : daysToExpiry !== null && daysToExpiry < 0
          ? 'expired'
          : remaining.cmp(0) <= 0
            ? 'used-up'
            : exhausting
              ? 'exhausting'
              : daysToExpiry !== null && daysToExpiry <= CREDIT_EXPIRY_WARNING_DAYS
                ? 'expiring'
                : unverified
                  ? 'unverified'
                  : 'ok';
    const statusText = {
      'not-started': `Applies from ${c.appliedOn}`,
      expired: `Expired on ${c.expiresOn}${remaining.cmp(0) > 0 ? ` with ${unverified ? 'up to ' : ''}${remaining.toFixed(2)} ${cur} unused` : ''}`,
      unverified: c.provider === 'token-factory' ? 'Unverified: no spend entered' : latestEnd ? 'Unverified: no billing export rows since it applied' : 'Unverified: no billing export rows',
      'used-up': 'Used up',
      exhausting: `Runs out about ${exhaustsOn} at the current burn`,
      expiring: daysToExpiry === 0 ? 'Expires today' : `Expires in ${plural(daysToExpiry ?? 0, 'day')}`,
      ok: c.expiresOn ? `Valid until ${c.expiresOn}` : 'Active · no expiry entered',
    }[status];
    return {
      ...c,
      used: { parts, total: m(used, cur) },
      remaining: m(remaining.cmp(0) < 0 ? Decimal.ZERO : remaining, cur),
      percentUsed: Math.min(100, percentOf(used, amount) ?? 0),
      burnRate: rate,
      exhaustsOn,
      exhaustsBeforeExpiry: exhaustsOn && c.expiresOn ? exhaustsOn <= c.expiresOn : null,
      daysToExpiry,
      status,
      statusText,
      notes,
      ...(unverified ? { remainingAtMost: true as const } : {}),
    };
  });
}

/**
 * The Costs view of a budget (W1-P23): its period as the range, its project and region when it has one of each (the
 * global filter takes one); every condition Costs cannot apply is named, so the link never reads as the same scope.
 * Null for a Token Factory budget (its spend is entered here, not in the billing export).
 */
export function budgetCostsLink(b: Pick<BudgetView, 'provider' | 'scope' | 'window'>): { href: string; notApplied: string[] } | null {
  if (b.provider !== 'ai-cloud') return null;
  const q = new URLSearchParams();
  const notApplied: string[] = [];
  if (b.scope.projects.length === 1) q.set('project', b.scope.projects[0]);
  else if (b.scope.projects.length > 1) notApplied.push(`${b.scope.projects.length} projects (Costs filters one)`);
  if (b.scope.regions.length === 1) q.set('region', b.scope.regions[0]);
  else if (b.scope.regions.length > 1) notApplied.push(`${b.scope.regions.length} regions (Costs filters one)`);
  if (b.scope.services.length) notApplied.push(`service ${b.scope.services.join(', ')}`);
  if (b.scope.products.length) notApplied.push(`product ${b.scope.products.join(', ')}`);
  q.set('from', b.window.start.slice(0, 10));
  q.set('to', b.window.end.slice(0, 10));
  return { href: `/costs?${q.toString()}`, notApplied };
}

/* ---------------------------------------------------------------- summary */

export interface AccountSummary {
  /** Spend in the current calendar month (UTC) by source, per currency. */
  monthToDate: (SpendPart & { label: string })[];
  /** The headline: what was spent this month (export rows and entered spend, no estimate), per currency. */
  monthSpent: Money[];
  /** Spent plus the live run-rate estimate since the last exported hour; null when no estimate was added. */
  monthProjected: { total: Money[]; estimate: Money[] } | null;
  /** Why there is no projected line. */
  projectedUnavailable?: string;
  month: { start: string; end: string };
  /** Remaining credit per provider, per currency (credits that are valid now); `atMost` when an unverified credit is in it (#36). */
  creditRemaining: { provider: SpendProvider; remaining: Money[]; atMost?: true }[];
  /** Entered budgets and the read-only ones from the configuration, counted together and apart. */
  budgets: BudgetCounts;
  credits: { total: number; expiringSoon: number };
  exportThrough?: string;
  /**
   * The currency spend is in, per provider (the newest export row or the run-rate; the newest entry), for the
   * default of a new budget or credit; null when nothing was seen yet.
   */
  spendCurrency: Record<SpendProvider, string | null>;
}

export interface BudgetCounts {
  total: number;
  entered: number;
  fromConfig: number;
  over: number;
  atThreshold: number;
  noData: number;
}

/** "1 entered by you", or "0 entered by you (1 from config)" when the configuration adds any. */
export const trackedText = (c: Pick<BudgetCounts, 'entered' | 'fromConfig'>) => `${c.entered} entered by you${c.fromConfig ? ` (${c.fromConfig} from config)` : ''}`;

const sumParts = (parts: SpendPart[]) => {
  const bag = new MoneyBag();
  for (const p of parts) bag.add(p.amount.amount, p.amount.currency);
  return bag.toList();
};

const lowerFirst = (x: string) => (/^[A-Z][a-z]/.test(x) ? x[0].toLowerCase() + x.slice(1) : x);

/**
 * Why the month has no projected line, as the end of a sentence (#69): nothing running is a fact with the time it
 * holds since (the last exported hour), not a mid-sentence "No running VMs…" that read as a failure.
 */
function projectedReason(ctx: SpendContext, notes: string[]): string {
  if (ctx.nothingRunning && ctx.coverage.latestEnd) {
    const t = ctx.coverage.latestEnd;
    const sameDay = t.slice(0, 10) === ctx.now.toISOString().slice(0, 10);
    return `nothing running to estimate since ${sameDay ? '' : `${t.slice(0, 10)} `}${t.slice(11, 16)} UTC`;
  }
  if (ctx.nothingRunning) return 'nothing running to estimate';
  if (ctx.runRate) return notes.length ? `no live run-rate estimate: ${lowerFirst(notes[0].replace(/^No live estimate added: /, ''))}` : 'the export covers the month so far: nothing to estimate';
  return ctx.runRateUnavailable ? `no live run-rate estimate: ${lowerFirst(ctx.runRateUnavailable.replace(/\.$/, ''))}` : 'no live run-rate estimate';
}

export function accountSummary(ctx: SpendContext, budgets: BudgetView[], credits: CreditView[], configBudgets: BudgetStatus[] = []): AccountSummary {
  const month = periodWindow('monthly', ctx.now);
  const from = Date.parse(month.start);
  const to = Date.parse(month.end);
  const rows = ctx.rows.filter(r => !r.supersededBy && isSpendRow(r) && Date.parse(r.chargePeriodStart) >= from && Date.parse(r.chargePeriodStart) < to);
  const fallback = ctx.runRate?.hourly.currency ?? rows[0]?.currency ?? 'USD';
  const out: AccountSummary['monthToDate'] = [];
  const actual = new MoneyBag();
  for (const r of rows) actual.add(r.costs.BilledCost ?? '0', r.currency);
  const actualList = actual.toList();
  for (const a of actualList.length ? actualList : ctx.coverage.latestEnd ? [{ amount: '0', currency: fallback }] : []) {
    out.push({ source: 'focus-export', kind: 'actual', label: SPEND_SOURCE_LABELS['focus-export'], amount: a, asOf: ctx.coverage.latestEnd, note: `BilledCost this month, ${SPEND_EXCLUDES}.` });
  }
  const notes: string[] = [];
  const e = estimate(ctx, from, to, ctx.runRate?.hourly.currency ?? fallback, notes);
  if (e) out.push({ ...e, label: SPEND_SOURCE_LABELS['live-run-rate'] });
  const entered = new MoneyBag();
  const tf = ctx.entries.filter(x => x.provider === 'token-factory' && dayStart(x.date) >= from && dayStart(x.date) < to);
  for (const x of tf) entered.add(x.amount, x.currency);
  const enteredList = entered.toList();
  const newest = tf.map(x => x.date).sort().pop();
  for (const a of enteredList.length ? enteredList : [{ amount: '0', currency: fallback }]) {
    out.push({ source: 'token-factory-entries', kind: 'entered', label: SPEND_SOURCE_LABELS['token-factory-entries'], amount: a, asOf: newest, note: tf.length ? `${tf.length} entries this month.` : 'Nothing entered this month.' });
  }
  const estimates = out.filter(p => p.kind === 'estimate');
  const newestRow = ctx.rows.filter(r => !r.supersededBy && isSpendRow(r)).sort((a, b) => b.chargePeriodStart.localeCompare(a.chargePeriodStart))[0];
  const newestEntry = ctx.entries.filter(x => x.provider === 'token-factory').sort((a, b) => b.date.localeCompare(a.date))[0];
  const remaining = new Map<SpendProvider, MoneyBag>();
  const atMost = new Set<SpendProvider>();
  for (const c of credits.filter(x => x.status !== 'expired' && x.status !== 'not-started')) {
    const bag = remaining.get(c.provider) ?? new MoneyBag();
    bag.add(c.remaining.amount, c.remaining.currency);
    remaining.set(c.provider, bag);
    if (c.remainingAtMost) atMost.add(c.provider);
  }
  return {
    monthToDate: out,
    monthSpent: sumParts(out.filter(p => p.kind !== 'estimate')),
    monthProjected: estimates.length ? { total: sumParts(out), estimate: sumParts(estimates) } : null,
    projectedUnavailable: estimates.length ? undefined : projectedReason(ctx, notes),
    month,
    creditRemaining: SPEND_PROVIDERS.filter(p => remaining.has(p)).map(p => ({ provider: p, remaining: remaining.get(p)!.toList(), ...(atMost.has(p) ? { atMost: true as const } : {}) })),
    budgets: {
      total: budgets.length + configBudgets.length,
      entered: budgets.length,
      fromConfig: configBudgets.length,
      over: budgets.filter(b => b.status === 'over').length + configBudgets.filter(b => b.state === 'over').length,
      atThreshold: budgets.filter(b => b.status === 'at-threshold').length + configBudgets.filter(b => b.state === 'near').length,
      noData: budgets.filter(b => b.status === 'no-data').length + configBudgets.filter(b => b.state === 'no-data').length,
    },
    credits: { total: credits.length, expiringSoon: credits.filter(c => c.status === 'expiring').length },
    exportThrough: ctx.coverage.latestEnd,
    spendCurrency: { 'ai-cloud': newestRow?.currency ?? ctx.runRate?.hourly.currency ?? null, 'token-factory': newestEntry?.currency ?? null },
  };
}

/* ---------------------------------------------------------------- signals */

/**
 * A budget or credit condition worth an alert, with its guided fix. Produced by `budgetSignals`;
 * the alert rule engine (alerts/) turns these into alerts. Ids are stable across evaluations, so a
 * signal that keeps firing is the same alert.
 */
export interface BudgetSignal {
  /** `budget:<id>:threshold:<entered value>`, `budget:<id>:projected:<…>`, `budget:<id>:forecast:<…>`, `credit:<id>:expiry` or `credit:<id>:exhausting`. */
  id: string;
  /** Threshold and over: the actual only. Projected: actual + live estimate, apart. Forecast: the burn rate to period end. Exhausting: a credit's burn uses it up soon. */
  kind: 'budget-threshold' | 'budget-over' | 'budget-projected' | 'budget-forecast' | 'credit-expiring' | 'credit-exhausting';
  severity: 'info' | 'warning' | 'critical';
  subject: { type: 'budget' | 'credit'; id: string; name: string; provider: SpendProvider };
  title: string;
  /** The evidence: what was measured against what. */
  /** `forecast`: the value is the period-end forecast at the current burn rate, not spend. */
  evidence: { value: Money; threshold?: Money; basis: 'actual' | 'estimate' | 'entered' | 'date' | 'forecast'; asOf?: string; expiresOn?: string; daysToExpiry?: number };
  fix: {
    meaning: string;
    /** Read-only checks to run. */
    checks: string[];
    /** What a fix would change (done by a person, outside the portal). */
    action: string;
    /** Repository runbook path and anchor. */
    runbook: string;
    /** docs.nebius.com page and anchor (checked by `make docs-links`). */
    docs: string;
  };
}

export const BUDGET_RUNBOOK = 'runbooks/finance.md#budget-or-credit-signal';
const BUDGET_DOCS = 'https://docs.nebius.com/signup-billing/budgets#how-to-check-a-budget-status';
const PAYG_DOCS = 'https://docs.nebius.com/signup-billing/billing-models/payg#how-to-stop-being-charged';


const PERIOD_END: Record<BudgetPeriod, string> = { daily: 'day-end', monthly: 'month-end', quarterly: 'quarter-end', yearly: 'year-end' };

/**
 * The forecast warning of one budget: the highest threshold its period-end forecast reaches that spend to date has
 * not crossed yet. Nothing when there is no burn rate, less than a day of it, or the amount is already spent.
 */
function forecastSignal(b: BudgetView, now: Date): BudgetSignal | undefined {
  if (!b.forecast || !b.burnRate || b.status === 'over' || b.status === 'no-data') return undefined;
  if (now.getTime() - Date.parse(b.burnRate.since) < FORECAST_MIN_HOURS * HOUR_MS) return undefined;
  const end = Decimal.from(b.forecast.periodEnd.amount);
  const t = [...b.thresholdStates].reverse().find(x => !x.crossed && end.cmp(x.value.amount) >= 0);
  if (!t) return undefined;
  const label = fmtThreshold(t.entered, b.thresholds.unit, b.currency);
  const reachesAmount = end.cmp(b.amount) >= 0;
  const by = PERIOD_END[b.period];
  const fmt = (x: Money) => fmtMoney(x);
  return {
    id: `budget:${b.id}:forecast:${t.entered}`,
    kind: 'budget-forecast',
    severity: reachesAmount ? 'warning' : 'info',
    subject: { type: 'budget', id: b.id, name: b.name, provider: b.provider },
    title: `Budget “${b.name}” is forecast to reach ${label} by ${by} (${fmtMoneyOf(b.forecast.periodEnd, { amount: b.amount, currency: b.currency })})`,
    evidence: { value: b.forecast.periodEnd, threshold: t.value, basis: 'forecast', asOf: b.spend.parts[0]?.asOf },
    fix: {
      meaning: `At the burn rate since ${b.burnRate.since.slice(0, 10)} (${fmt(b.burnRate.perDay)} a day), spend in the ${b.period} period reaches ${fmt(b.forecast.periodEnd)} by ${b.window.end.slice(0, 10)}, past the ${label} threshold; spent so far: ${fmt(b.spend.actual)}. A forecast, not a charge: nothing has crossed yet, and budgets notify; they never stop spend.`,
      checks: [
        b.provider === 'token-factory'
          ? 'Open the Token Factory Usage tab: which models and keys drive the recent spend?'
          : 'Open Costs and break this period down by service and resource: what drives the burn rate?',
        'Is the rate temporary (a test or training run that ends soon) or something left running? Check Estate Explorer (TTL expired, orphan candidates) and Fleet (idle GPUs).',
        'Compare with the console: Billing → Budgets shows the same budget with its own data, updated every few hours.',
      ],
      action: reachesAmount
        ? 'Stop or scale down what is not needed before the amount is reached, or raise the budget after approval. A quota decrease is the only hard stop.'
        : 'Confirm the rate is expected; otherwise stop or scale down what is not needed before the threshold is reached.',
      runbook: BUDGET_RUNBOOK,
      docs: BUDGET_DOCS,
    },
  };
}

/**
 * Whether a budget's projection warns: the actual plus the live estimate crosses a threshold the actual has not, or
 * goes over the amount while the actual is under it (also when no threshold names 100 %). The Projected badge on
 * Budgets and the budget-projected alert share this test.
 */
export function projectionWarns(b: Pick<BudgetView, 'projection' | 'thresholdStates' | 'status'>): boolean {
  if (!b.projection || b.status === 'no-data') return false;
  return (b.projection.over && b.status !== 'over') || b.thresholdStates.some(t => t.crossed === 'estimate');
}

/**
 * The projected warning of one budget: the highest threshold the actual plus the live run-rate estimate reaches
 * that the actual has not. Its own alert, never a threshold crossing: the estimate is not spend.
 */
function projectedSignal(b: BudgetView): BudgetSignal | undefined {
  if (!b.projection || !projectionWarns(b)) return undefined;
  const crossed = [...b.thresholdStates].reverse().find(x => x.crossed === 'estimate');
  // Over the amount with the estimate while the actual is under it: a warning even when no threshold names 100 %.
  const t = crossed && Decimal.from(crossed.value.amount).cmp(b.amount) >= 0 ? crossed : b.projection.over && b.status !== 'over' ? undefined : crossed;
  const label = t ? (fmtThreshold(t.entered, b.thresholds.unit, b.currency)) : 'its amount';
  const reachesAmount = !t || Decimal.from(t.value.amount).cmp(b.amount) >= 0;
  const fmt = (x: Money) => fmtMoney(x);
  const estimatePart = b.spend.parts.find(x => x.kind === 'estimate');
  return {
    id: `budget:${b.id}:projected:${t ? t.entered : 'amount'}`,
    kind: 'budget-projected',
    severity: reachesAmount ? 'warning' : 'info',
    subject: { type: 'budget', id: b.id, name: b.name, provider: b.provider },
    title: `Budget “${b.name}” is ${reachesAmount ? 'projected to be over its amount' : `projected to cross ${label}`} with the live estimate (${fmtMoneyOf(b.projection.total, { amount: b.amount, currency: b.currency })}; spent ${fmt(b.spend.actual)})`,
    evidence: { value: b.projection.total, threshold: t ? t.value : { amount: b.amount, currency: b.currency }, basis: 'estimate', asOf: estimatePart?.asOf ?? b.spend.parts[0]?.asOf },
    fix: {
      meaning: `Spent so far: ${fmt(b.spend.actual)}. The live run-rate since the last exported hour adds ${fmt(b.projection.estimate)}, which would reach ${label} of ${fmtMoney({ amount: b.amount, currency: b.currency })}. A projection, not spend: the export confirms or corrects it within hours. Budgets notify; they never stop spend.`,
      checks: [
        'Open Fleet and Estate Explorer: what is running now, and is it meant to be (TTL expired, orphan candidates, idle GPUs)?',
        'Check the run-rate source on Budgets & credits (list or contract price) and the export lag on Costs.',
        'Compare with the console: Billing → Budgets shows the same budget with its own data, updated every few hours.',
      ],
      action: reachesAmount
        ? 'Stop or scale down what is not needed before the export confirms the amount, or raise the budget after approval. A quota decrease is the only hard stop.'
        : 'Confirm the running workload is expected; otherwise stop or scale down what is not needed.',
      runbook: BUDGET_RUNBOOK,
      docs: BUDGET_DOCS,
    },
  };
}

/**
 * Threshold crossings by the actual, thresholds only the projection crosses, period-end forecasts that will cross a threshold spend has not reached yet, and credit
 * expiry warnings (≤ 14 days), from evaluated budgets and credits. Pure.
 */
export function budgetSignals(state: { budgets: BudgetView[]; credits: CreditView[] }, now: Date): BudgetSignal[] {
  const out: BudgetSignal[] = [];
  for (const b of state.budgets) {
    for (const t of b.thresholdStates) {
      if (t.crossed !== 'actual') continue;
      const over = Decimal.from(t.value.amount).cmp(b.amount) >= 0;
      const label = fmtThreshold(t.entered, b.thresholds.unit, b.currency);
      out.push({
        id: `budget:${b.id}:threshold:${t.entered}`,
        kind: over ? 'budget-over' : 'budget-threshold',
        severity: over ? 'critical' : 'warning',
        subject: { type: 'budget', id: b.id, name: b.name, provider: b.provider },
        title: `Budget “${b.name}” ${over ? 'is over its amount' : `crossed ${label}`}`,
        evidence: { value: b.spend.actual, threshold: t.value, basis: b.provider === 'token-factory' ? 'entered' : 'actual', asOf: b.spend.parts[0]?.asOf },
        fix: {
          meaning: `Spend in the ${b.period} period from ${b.window.start.slice(0, 10)} reached ${label} of ${fmtMoney({ amount: b.amount, currency: b.currency })}. Budgets notify; they never stop spend.`,
          checks: [
            b.provider === 'token-factory'
              ? 'Open the Token Factory Usage tab and check which models and keys spend.'
              : 'Open Costs and break the period down by project, service and resource; check the export lag.',
            'Compare with the console: Billing → Budgets shows the same budget with its own data, updated every few hours.',
            'Look for leftovers: GPU VMs or disks nobody uses (Estate Explorer, orphan candidates).',
          ],
          action: over
            ? 'Stop or delete what is not needed, or raise the budget after approval. A quota decrease is the only hard stop.'
            : 'Confirm the spend is expected; otherwise stop or delete what is not needed.',
          runbook: BUDGET_RUNBOOK,
          docs: over ? PAYG_DOCS : BUDGET_DOCS,
        },
      });
    }
    const p = projectedSignal(b);
    if (p) out.push(p);
    const f = forecastSignal(b, now);
    if (f) out.push(f);
  }
  for (const c of state.credits) {
    if (c.status === 'exhausting' && c.exhaustsOn && c.burnRate) {
      const days = Math.max(0, Math.round((dayStart(c.exhaustsOn) - dayStart(todayOf(now))) / DAY_MS));
      out.push({
        id: `credit:${c.id}:exhausting`,
        kind: 'credit-exhausting',
        severity: days <= 3 ? 'critical' : 'warning',
        subject: { type: 'credit', id: c.id, name: c.name, provider: c.provider },
        title: `Credit “${c.name}” runs out about ${c.exhaustsOn} at the current burn (${fmtMoney(c.burnRate.perDay)} a day), ${fmtMoney(c.remaining)} left`,
        evidence: { value: c.remaining, basis: 'forecast', asOf: c.used.parts[0]?.asOf, ...(c.expiresOn ? { expiresOn: c.expiresOn } : {}) },
        fix: {
          meaning: `At the burn since ${c.burnRate.since.slice(0, 10)} (${fmtMoney(c.burnRate.perDay)} a day), the ${SPEND_PROVIDER_LABELS[c.provider]} credit's ${fmtMoney(c.remaining)} runs out about ${c.exhaustsOn}${c.expiresOn ? `, before it expires on ${c.expiresOn}` : ''}. After that the same use is charged. A forecast from the spend drawn so far, not a balance read from Nebius.`,
          checks: [
            c.provider === 'token-factory' ? 'Check the balance in the Token Factory console (no API exists), and which models and keys drive the spend.' : 'Check the balance and credits in the console: Billing; break the spend down on Costs.',
            'Update the credit and the entered spend here if the console shows different figures.',
          ],
          action: 'Confirm the spend is expected and budgeted for once the credit is gone; otherwise reduce it before then.',
          runbook: BUDGET_RUNBOOK,
          docs: BUDGET_DOCS,
        },
      });
      continue;
    }
    if (c.status !== 'expiring' || c.daysToExpiry === null) continue;
    out.push({
      id: `credit:${c.id}:expiry`,
      kind: 'credit-expiring',
      severity: c.daysToExpiry <= 3 ? 'critical' : 'warning',
      subject: { type: 'credit', id: c.id, name: c.name, provider: c.provider },
      title: `Credit “${c.name}” ${c.daysToExpiry === 0 ? 'expires today' : `expires in ${plural(c.daysToExpiry, 'day')}`} with ${c.remainingAtMost ? 'up to ' : ''}${c.remaining.amount} ${c.currency} left`,
      evidence: { value: c.remaining, basis: 'date', expiresOn: c.expiresOn, daysToExpiry: c.daysToExpiry, asOf: now.toISOString() },
      fix: {
        meaning: `${c.remaining.amount} ${c.currency} of the ${SPEND_PROVIDER_LABELS[c.provider]} credit is unused and expires on ${c.expiresOn}. Unused credit is not paid out.`,
        checks: [
          c.provider === 'token-factory' ? 'Check the balance in the Token Factory console (no API exists).' : 'Check the balance and credits in the console: Billing.',
          'Update the credit and the entered spend here if the console shows different figures.',
        ],
        action: 'Plan the work that uses it before the expiry date, or accept that it lapses.',
        runbook: BUDGET_RUNBOOK,
        docs: BUDGET_DOCS,
      },
    });
  }
  return out;
}

/* --------------------------------------------------------------- response */

/** GET /budgets: every budget and credit evaluated on the backend clock, with the account summary and signals. */
export interface BudgetsResponse {
  generatedAt: string;
  budgets: BudgetView[];
  credits: CreditView[];
  entries: SpendEntryRecord[];
  summary: AccountSummary;
  signals: BudgetSignal[];
  canEdit: boolean;
  /** Set when the caller sees only some projects: spend outside them is not counted. */
  scopeNote?: string;
  links: typeof CONSOLE_LINKS;
  /**
   * Budgets still set in the deprecated `nebiusEstate.budgets` config key, measured against reported
   * BilledCost of their month. Shown read-only on this page; never stored in the database.
   */
  configBudgets: BudgetStatus[];
  /** Set when any config budget is shown: where they come from and how to move them. */
  configBudgetsNote?: string;
  /** The export pull's next run and the next export file's estimate, beside "export through" (#12). */
  exportFreshness?: { nextRunAt?: string; nextFile?: ExportCadence };
}

/** One budget on the Overview glance: the same state as on Budgets & credits, entered and config alike. */
export interface BudgetGlanceRow {
  key: string;
  name: string;
  /** null when the budget has no data; `reason` then says why (never "no spend" when spend is in another currency). */
  percent: number | null;
  reason?: string;
  amount: Money;
  tone: 'danger' | 'warn' | 'ok' | 'neutral';
}

export function budgetGlance(d: Pick<BudgetsResponse, 'budgets' | 'configBudgets'>): BudgetGlanceRow[] {
  const row = (key: string, name: string, noData: boolean, percent: number | null, reason: string, amount: Money, tone: BudgetGlanceRow['tone']): BudgetGlanceRow =>
    noData ? { key, name, percent: null, reason, amount, tone: 'neutral' } : { key, name, percent, amount, tone };
  return [
    ...d.budgets.map(b =>
      row(b.id, b.name, b.status === 'no-data', b.percent, b.statusText, { amount: b.amount, currency: b.currency }, b.status === 'over' ? 'danger' : b.status === 'at-threshold' ? 'warn' : 'ok'),
    ),
    ...d.configBudgets.map(b =>
      row(`config:${b.id}`, `${b.id} (config)`, b.state === 'no-data', b.percent, b.statusText, { amount: b.amount, currency: b.currency }, b.state === 'over' ? 'danger' : b.state === 'near' ? 'warn' : 'ok'),
    ),
  ];
}

/** One tracked credit on the Overview glance (G1.18): what is left and its expiry, in the words of Budgets & credits. */
export interface CreditGlanceRow {
  key: string;
  name: string;
  text: string;
  tone: 'warn' | 'ok' | 'neutral';
}

export function creditGlance(credits: CreditView[]): CreditGlanceRow[] {
  return credits.map(c => {
    const tone = creditTone(c);
    // An unverified credit's "left" is at most its amount, said so (#36); its expiry is still worth naming.
    const left = c.remainingAtMost ? `≤ ${fmtMoney(c.remaining)} of ${fmtMoney({ amount: c.amount, currency: c.currency })} left (${c.provider === 'token-factory' ? 'no spend entered' : 'no billing export rows'})` : `${fmtMoney(c.remaining)} of ${fmtMoney({ amount: c.amount, currency: c.currency })} left`;
    const when = c.status === 'ok' || c.status === 'unverified' ? (c.expiresOn ? `expires ${c.expiresOn}` : 'no expiry entered') : c.statusText;
    return { key: c.id, name: c.name, text: `${left} · ${when}`, tone: tone === 'info' ? 'neutral' : tone };
  });
}

export const CONFIG_BUDGETS_NOTE =
  `From app-config: nebiusEstate.budgets is deprecated. These rows are read-only and measured against reported BilledCost of their month, ${SPEND_EXCLUDES} as every budget here; add each as a budget here and remove the key from the configuration.`;
