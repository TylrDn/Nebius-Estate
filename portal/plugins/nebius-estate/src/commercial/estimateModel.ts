import type { RateQuantity } from '@internal/nebius-domain';

const UNIT: Record<RateQuantity, string> = { gpu: 'GPU', vcpu: 'vCPU', ram_gib: 'GiB RAM', storage_gib: 'GiB', instance: 'instance', ip: 'IP', unit: 'unit' };

/** Trailing zeros off, keeping at least two decimals. */
const trim = (s: string) => {
  if (!s.includes('.')) return `${s}.00`;
  const t = s.replace(/0+$/, '');
  const decimals = t.length - t.indexOf('.') - 1;
  return decimals < 2 ? t + '0'.repeat(2 - decimals) : t;
};

/**
 * A per-hour unit rate with its unit (#70): four significant digits below 1 (a boot disk's 0.000164 per GiB-hour
 * read 0.0002 at six decimals and lost its digits), up to four decimals above; never in exponent notation.
 */
export function fmtUnitRate(rate: string, quantity: RateQuantity): string {
  const n = Number(rate);
  let text: string;
  if (!Number.isFinite(n)) text = rate;
  else if (Math.abs(n) >= 1 || n === 0) text = trim(n.toFixed(4));
  else {
    const digits = Math.min(20, Math.max(2, 3 - Math.floor(Math.log10(Math.abs(n)))));
    text = trim(n.toFixed(digits));
  }
  return `${text} / ${UNIT[quantity]}`;
}
