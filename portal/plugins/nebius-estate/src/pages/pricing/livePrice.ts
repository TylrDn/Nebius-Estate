import { Decimal } from '@internal/nebius-domain';
import type { LivePriceEstimate, LivePriceResponse, Money } from '@internal/nebius-domain';
import { ApiError } from '../../ui/api';

/**
 * Pure helpers for live Nebius calculator prices on the Provisioning and
 * Commercial pages. A missing figure stays missing: nothing here turns an
 * unknown price into 0.
 */

export type LivePriceState =
  | { status: 'idle'; message?: string }
  | { status: 'loading' }
  | { status: 'ready'; response: LivePriceResponse; updating?: boolean }
  | { status: 'denied'; message: string }
  | { status: 'error'; message: string };

export const CONTRACT_NEEDS_ACCESS = 'Contract prices need billing-group access';

/** A failed request as an explicit state; 403 is a permission state, not an error. */
export function failureState(e: unknown): LivePriceState {
  if (e instanceof ApiError && e.permissionDenied) {
    return { status: 'denied', message: `Live prices need nebius.commercial.rate.read (${e.message}).` };
  }
  return { status: 'error', message: e instanceof Error ? e.message : String(e) };
}

/** Marks a shown result as being refreshed for new inputs; anything else becomes "loading". */
export function pendingState(s: LivePriceState): LivePriceState {
  return s.status === 'ready' ? { ...s, updating: true } : { status: 'loading' };
}

export interface LiveTotal {
  /** Sum of the lines priced per hour; null when no line is (never a 0 stand-in). */
  hourly: Money | null;
  pricedLines: number;
  unpricedCount: number;
  /** Some lines or components are not in the hourly figure. */
  partial: boolean;
}

export function liveTotal(est: LivePriceEstimate): LiveTotal {
  const priced = est.lines.filter(l => l.hourly !== null).length;
  const hourly = priced > 0 && est.hourly ? est.hourly : null;
  return { hourly, pricedLines: priced, unpricedCount: est.unpriced.length, partial: hourly !== null && est.unpriced.length > 0 };
}

/** Whether the figure is a contract price, and the note to show when it is not. */
export function contractStatus(est: LivePriceEstimate): { contract: true } | { contract: false; note: string } {
  if (est.offer === 'contract') return { contract: true };
  return { contract: false, note: est.contractNote ? `${CONTRACT_NEEDS_ACCESS}. ${est.contractNote}` : `${CONTRACT_NEEDS_ACCESS}; list prices shown.` };
}

/**
 * How to label a figure: "contract price" (with "= list" when the
 * contract and list totals are equal, or the list figure when they differ)
 * or "list price". Never compares across currencies.
 */
export function priceBasis(est: LivePriceEstimate): { label: 'contract price' | 'list price'; sameAsList?: boolean; listHourly?: Money } {
  if (est.offer !== 'contract') return { label: 'list price' };
  const list = est.listHourly ?? undefined;
  if (!list || !est.hourly || list.currency !== est.hourly.currency) return { label: 'contract price' };
  const same = Decimal.from(list.amount).sub(est.hourly.amount).isZero();
  return same ? { label: 'contract price', sameAsList: true } : { label: 'contract price', sameAsList: false, listHourly: list };
}

/**
 * The one price-basis label every page shows, e.g. "contract price (= list)", "contract price (list 6.00 USD / h)"
 * or "list price".
 */
export function priceBasisText(est: LivePriceEstimate, fmt: (m: Money) => string): string {
  const b = priceBasis(est);
  if (b.sameAsList) return `${b.label} (= list)`;
  if (b.listHourly) return `${b.label} (list ${fmt(b.listHourly)} / h)`;
  return b.label;
}

export function timesHours(m: Money, hours: number): Money {
  return { amount: Decimal.from(m.amount).mul(String(hours)).toString(), currency: m.currency };
}

/**
 * A run's total when its lines run for different hours (G5.14): Σ line per hour × that line's hours. Null when a
 * priced line has no hours (it was merged with items of other hours), so no total is made up.
 */
export function mixedRunTotal(est: Pick<LivePriceEstimate, 'lines' | 'currency'>, lineHours: Record<string, number>): Money | null {
  let total = Decimal.ZERO;
  for (const l of est.lines) {
    if (!l.hourly) continue;
    const h = lineHours[l.key];
    if (h === undefined) return null;
    total = total.add(Decimal.from(l.hourly.amount).mul(String(h)));
  }
  return { amount: total.toString(), currency: est.lines.find(l => l.hourly)?.hourly?.currency ?? est.currency };
}

export type Comparison = { kind: 'delta'; delta: Money; percent: string | null } | { kind: 'na'; reason: string };

/** Rate book minus list price, only in the same currency (never converted). */
export function compareToList(book: Money | undefined, list: Money | null | undefined): Comparison {
  if (!book) return { kind: 'na', reason: 'No rate-book figure' };
  if (!list) return { kind: 'na', reason: 'No live list price' };
  if (book.currency !== list.currency) return { kind: 'na', reason: `${book.currency} vs ${list.currency}: not compared (never converted)` };
  const delta = Decimal.from(book.amount).sub(list.amount);
  const percent = Decimal.from(list.amount).isZero() ? null : delta.mul(100).div(list.amount).toFixed(1);
  return { kind: 'delta', delta: { amount: delta.toString(), currency: book.currency }, percent };
}

/** The ready estimate of a state, if any. */
export function estimateOf(s: LivePriceState): LivePriceEstimate | undefined {
  return s.status === 'ready' ? s.response.value ?? undefined : undefined;
}

/**
 * The hourly live figure of a state: the calculator's total, 0 for an empty footprint (known without asking,
 * F1.18), and null while loading or when no line is priced.
 */
export function liveHourly(s: LivePriceState): Money | null {
  if (s.status !== 'ready') return null;
  if (!s.response.value) return s.response.emptyFootprint ? { amount: '0', currency: s.response.emptyFootprint.currency } : null;
  return liveTotal(s.response.value).hourly;
}

/** Why one state has no figure (an error, or the backend's reason), else undefined. */
function missingReason(s: LivePriceState): string | undefined {
  if (s.status === 'error') return s.message;
  if (s.status === 'ready' && !s.response.value && !s.response.emptyFootprint) return s.response.unavailableReason;
  return undefined;
}

/**
 * The reason, when two or more footprints all lack a price for the same one (a bad region fails every request
 * alike): the panel says it once instead of in every tile (F1.17).
 */
export function sharedReason(states: LivePriceState[]): string | undefined {
  if (states.length < 2) return undefined;
  const reasons = states.map(missingReason);
  return reasons[0] && reasons.every(r => r === reasons[0]) ? reasons[0] : undefined;
}
