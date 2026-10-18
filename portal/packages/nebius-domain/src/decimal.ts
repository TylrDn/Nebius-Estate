/**
 * Fixed-point decimal arithmetic on BigInt, 12 fractional digits.
 *
 * Money and rates never touch IEEE floats: a storage rate per GiB-hour has
 * 5+ significant fractional digits and a month of hourly FOCUS rows sums
 * thousands of them. Every operation that loses precision (mul, div) rounds
 * half-to-even at the 12th digit; toFixed rounds half-to-even at the
 * requested digit.
 */

export const DECIMAL_SCALE = 12;
const SCALE = BigInt(DECIMAL_SCALE);
const FACTOR = 10n ** SCALE;
const PATTERN = /^([+-])?(\d+)(?:\.(\d+))?$/;

export class DecimalParseError extends Error {
  constructor(input: unknown) {
    super(`Not a decimal number: ${JSON.stringify(input)}`);
    this.name = 'DecimalParseError';
  }
}

/** Integer division rounded half-to-even, for any signs. */
function divRound(n: bigint, d: bigint): bigint {
  if (d === 0n) throw new RangeError('Division by zero');
  const negative = n < 0n !== d < 0n;
  const an = n < 0n ? -n : n;
  const ad = d < 0n ? -d : d;
  let q = an / ad;
  const r = an % ad;
  const twice = r * 2n;
  if (twice > ad || (twice === ad && q % 2n === 1n)) q += 1n;
  return negative ? -q : q;
}

export class Decimal {
  static readonly ZERO = new Decimal(0n);
  static readonly ONE = new Decimal(FACTOR);

  private constructor(private readonly units: bigint) {}

  /**
   * Parses a plain decimal string ("12", "-0.0001", "+3.5"). Exponents,
   * thousands separators and blanks are rejected. Numbers are accepted only
   * when they are safe integers; pass fractional values as strings.
   */
  static from(value: string | number | bigint | Decimal): Decimal {
    if (value instanceof Decimal) return value;
    if (typeof value === 'bigint') return new Decimal(value * FACTOR);
    if (typeof value === 'number') {
      if (!Number.isSafeInteger(value)) throw new DecimalParseError(value);
      return new Decimal(BigInt(value) * FACTOR);
    }
    const m = PATTERN.exec(value.trim());
    if (!m) throw new DecimalParseError(value);
    const [, sign, whole, frac = ''] = m;
    let units: bigint;
    if (frac.length <= DECIMAL_SCALE) {
      units = BigInt(whole) * FACTOR + BigInt(frac.padEnd(DECIMAL_SCALE, '0'));
    } else {
      const extra = 10n ** BigInt(frac.length - DECIMAL_SCALE);
      units = divRound(BigInt(whole + frac), extra);
    }
    return new Decimal(sign === '-' ? -units : units);
  }

  static isValid(value: string): boolean {
    return PATTERN.test(value.trim());
  }

  static sum(values: Iterable<Decimal>): Decimal {
    let total = 0n;
    for (const v of values) total += v.units;
    return new Decimal(total);
  }

  add(other: Decimal | string | number): Decimal {
    return new Decimal(this.units + Decimal.from(other).units);
  }

  sub(other: Decimal | string | number): Decimal {
    return new Decimal(this.units - Decimal.from(other).units);
  }

  mul(other: Decimal | string | number): Decimal {
    return new Decimal(divRound(this.units * Decimal.from(other).units, FACTOR));
  }

  div(other: Decimal | string | number): Decimal {
    const d = Decimal.from(other).units;
    return new Decimal(divRound(this.units * FACTOR, d));
  }

  neg(): Decimal {
    return new Decimal(-this.units);
  }

  abs(): Decimal {
    return this.units < 0n ? this.neg() : this;
  }

  cmp(other: Decimal | string | number): -1 | 0 | 1 {
    const o = Decimal.from(other).units;
    if (this.units === o) return 0;
    return this.units < o ? -1 : 1;
  }

  eq(other: Decimal | string | number): boolean {
    return this.cmp(other) === 0;
  }

  isZero(): boolean {
    return this.units === 0n;
  }

  isNegative(): boolean {
    return this.units < 0n;
  }

  /** Rounds half-to-even to `digits` fractional digits and pads with zeros. */
  toFixed(digits: number): string {
    if (digits < 0 || digits > DECIMAL_SCALE) throw new RangeError('digits');
    const step = 10n ** BigInt(DECIMAL_SCALE - digits);
    const rounded = divRound(this.units, step);
    const negative = rounded < 0n;
    const abs = negative ? -rounded : rounded;
    const base = 10n ** BigInt(digits);
    const whole = abs / base;
    const frac = abs % base;
    const text =
      digits === 0
        ? whole.toString()
        : `${whole}.${frac.toString().padStart(digits, '0')}`;
    return negative && abs !== 0n ? `-${text}` : text;
  }

  /** Canonical string: no trailing fractional zeros, never exponent notation. */
  toString(): string {
    const full = this.toFixed(DECIMAL_SCALE);
    return full.includes('.') ? full.replace(/\.?0+$/, '') : full;
  }

  toJSON(): string {
    return this.toString();
  }

  /** Lossy; for chart geometry only, never for totals. */
  toNumber(): number {
    return Number(this.toString());
  }
}
