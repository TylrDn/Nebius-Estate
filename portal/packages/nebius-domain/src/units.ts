import { Decimal } from './decimal';

/**
 * What a rate is charged per. Nebius prices compute per hour (billed per
 * second) and volumes per GiB per 730 hours (docs.nebius.com/compute/resources/pricing);
 * rates are normalised to per-hour before any arithmetic so that a per-second
 * and a per-month rate cannot be added by accident.
 */
export type RatePeriod = 'second' | 'hour' | 'month730';

/** What one unit of a rate counts. */
export type RateQuantity =
  | 'gpu'
  | 'vcpu'
  | 'ram_gib'
  | 'storage_gib'
  | 'instance'
  | 'ip'
  | 'unit';

export interface RateUnit {
  quantity: RateQuantity;
  per: RatePeriod;
}

export const HOURS_PER_PRICING_MONTH = 730;

export function toHourly(price: Decimal | string, per: RatePeriod): Decimal {
  const p = Decimal.from(price);
  switch (per) {
    case 'second':
      return p.mul(3600);
    case 'hour':
      return p;
    case 'month730':
      return p.div(HOURS_PER_PRICING_MONTH);
    default:
      throw new Error(`unknown rate period ${per as string}`);
  }
}

export function describeUnit(u: RateUnit): string {
  const q: Record<RateQuantity, string> = {
    gpu: 'GPU',
    vcpu: 'vCPU',
    ram_gib: 'GiB RAM',
    storage_gib: 'GiB',
    instance: 'instance',
    ip: 'IP',
    unit: 'unit',
  };
  const p: Record<RatePeriod, string> = {
    second: 'second',
    hour: 'hour',
    month730: '730 h month',
  };
  return `per ${q[u.quantity]} per ${p[u.per]}`;
}

export interface PresetShape {
  gpus: number;
  vcpus: number;
  ramGib: number;
}

/**
 * Parses a Nebius preset name: `1gpu-16vcpu-200gb`, `8gpu-128vcpu-1600gb`,
 * `8vcpu-32gb`. Returns undefined for anything else (never guesses).
 */
export function parsePreset(preset: string): PresetShape | undefined {
  const m = /^(?:(\d+)gpu-)?(\d+)vcpu-(\d+)gb$/.exec(preset);
  if (!m) return undefined;
  return { gpus: m[1] ? Number(m[1]) : 0, vcpus: Number(m[2]), ramGib: Number(m[3]) };
}
