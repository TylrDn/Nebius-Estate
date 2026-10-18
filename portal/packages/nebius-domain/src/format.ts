/**
 * One way to write a number, shared by the pages, the backend's alert texts and the budget signals (W1F.S6): thousands
 * grouped ("1,159.69"), and a space before every unit ("37.8 %", "54 °C", "13 h", "4.83 XTS / h"). Never converts
 * currencies.
 */
import { Decimal } from './decimal';
import type { Money } from './money';

export function fmtNumber(n: number | null | undefined, digits = 0): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return n.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

/** Money with explicit currency; never converts. Negative amounts keep their sign. */
export function fmtMoney(m: Money | undefined, digits = 2): string {
  if (!m) return '—';
  const d = Decimal.from(m.amount);
  const [whole, frac] = d.abs().toFixed(digits).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${d.isNegative() ? '−' : ''}${grouped}${frac ? `.${frac}` : ''} ${m.currency}`;
}

export const fmtPercent = (n: number, digits = 1): string => `${fmtNumber(n, digits)} %`;

export const fmtCelsius = (n: number, digits = 0): string => `${fmtNumber(n, digits)} °C`;

export const fmtPerHour = (m: Money, digits = 2): string => `${fmtMoney(m, digits)} / h`;

/** A budget threshold as entered: "50 %", or an amount in the budget's currency ("1,500 XTS"). */
export function fmtThreshold(entered: string, unit: 'percent' | 'amount' | string, currency: string): string {
  const n = Number(entered);
  const value = Number.isFinite(n) ? fmtNumber(n, 2) : entered;
  return unit === 'percent' ? `${value} %` : `${value} ${currency}`;
}

/** "1,159.69 of 1,500.00 XTS": a part of a whole in one currency, the currency said once; two currencies say both. */
export function fmtMoneyOf(part: Money, whole: Money, digits = 2): string {
  if (part.currency !== whole.currency) return `${fmtMoney(part, digits)} of ${fmtMoney(whole, digits)}`;
  return `${fmtMoney(part, digits).slice(0, -(part.currency.length + 1))} of ${fmtMoney(whole, digits)}`;
}
