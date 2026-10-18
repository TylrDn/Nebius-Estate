import { Decimal } from './decimal';

/** ISO 4217 code (`XTS`, reserved for testing, is what the test data uses). */
export type CurrencyCode = string;

export interface Money {
  /** Decimal string; never a float. */
  amount: string;
  currency: CurrencyCode;
}

export class CurrencyMismatchError extends Error {
  constructor(readonly expected: CurrencyCode, readonly actual: CurrencyCode) {
    super(
      `Currency mismatch: ${actual} cannot be combined with ${expected} without an explicit exchange-rate policy`,
    );
    this.name = 'CurrencyMismatchError';
  }
}

export function money(amount: Decimal | string | number, currency: CurrencyCode): Money {
  return { amount: Decimal.from(amount).toString(), currency };
}

export function addMoney(a: Money, b: Money): Money {
  if (a.currency !== b.currency) throw new CurrencyMismatchError(a.currency, b.currency);
  return money(Decimal.from(a.amount).add(b.amount), a.currency);
}

/**
 * Per-currency accumulator. Totals in different currencies stay separate:
 * there is no exchange-rate policy in this product, so nothing converts.
 */
export class MoneyBag {
  private readonly totals = new Map<CurrencyCode, Decimal>();

  add(amount: Decimal | string, currency: CurrencyCode): this {
    const prev = this.totals.get(currency) ?? Decimal.ZERO;
    this.totals.set(currency, prev.add(Decimal.from(amount)));
    return this;
  }

  currencies(): CurrencyCode[] {
    return [...this.totals.keys()].sort();
  }

  get(currency: CurrencyCode): Decimal {
    return this.totals.get(currency) ?? Decimal.ZERO;
  }

  /** The single total, or a CurrencyMismatchError when the bag holds several currencies. */
  single(): Money | undefined {
    const cs = this.currencies();
    if (cs.length === 0) return undefined;
    if (cs.length > 1) throw new CurrencyMismatchError(cs[0], cs[1]);
    return money(this.get(cs[0]), cs[0]);
  }

  toList(): Money[] {
    return this.currencies().map(c => money(this.get(c), c));
  }
}
