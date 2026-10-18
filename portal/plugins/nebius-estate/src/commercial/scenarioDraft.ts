import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { Scenario } from '@internal/nebius-domain';

/** The tab named by `?tab=` when it is one of `tabs`, else the first. */
export function tabFromSearch<T extends string>(search: string, tabs: readonly T[]): T {
  const v = new URLSearchParams(search).get('tab');
  return (tabs as readonly string[]).includes(v ?? '') ? (v as T) : tabs[0];
}

/** The `?tab=` value when it names no tab (the page falls back to the first and says so, as Evidence does; #72). */
export function unknownTab(search: string, tabs: readonly string[]): string | undefined {
  const v = new URLSearchParams(search).get('tab');
  return v && !tabs.includes(v) ? v : undefined;
}

/** A tab kept in the URL (`?tab=`): it is restored on load and shareable; the global filter stays. */
export function useUrlTab<T extends string>(tabs: readonly T[]): [T, (t: T) => void] {
  const [params, setParams] = useSearchParams();
  const tab = tabFromSearch(`?${params.toString()}`, tabs);
  const set = useCallback(
    (t: T) =>
      setParams(
        prev => {
          const next = new URLSearchParams(prev);
          if (t === tabs[0]) next.delete('tab');
          else next.set('tab', t);
          return next;
        },
        { replace: true },
      ),
    [setParams, tabs],
  );
  return [tab, set];
}

export interface NewScenarioInput {
  name: string;
  rateBookId: string;
  currency: string;
  region: string;
  capacityType: Scenario['capacityType'];
  activeHours: number;
  platform: string;
  preset: string;
  count: number;
  bootDiskGib: number;
}

/**
 * A first scenario from the create form: one node group (minimum 0, expected and maximum = count),
 * no storage. Everything else is edited in the scenario workspace afterwards.
 */
export function newScenario(i: NewScenarioInput, today: string): Scenario {
  const group = (count: number) => ({
    name: i.preset.includes('gpu') ? 'gpu' : 'workers',
    role: i.preset.includes('gpu') ? ('gpu' as const) : ('cpu-worker' as const),
    platform: i.platform.trim(),
    preset: i.preset.trim(),
    count,
    bootDiskGib: i.bootDiskGib,
  });
  const fp = (count: number) => ({ nodeGroups: [group(count)], filesystemGib: 0, extraSsdGib: 0, ioM3Gib: 0, objectStorageGib: 0, publicIps: 0 });
  return {
    name: i.name.trim(),
    recipe: 'custom',
    region: i.region.trim(),
    currency: i.currency.trim().toUpperCase(),
    rateBookId: i.rateBookId,
    capacityType: i.capacityType,
    asOf: today,
    runtime: { activeHours: i.activeHours, warmupHours: 0, teardownHours: 0 },
    monthlyHours: 730,
    footprints: { min: fp(0), expected: fp(i.count), max: fp(i.count) },
    discountRuleIds: [],
    commitments: [],
    quoteValidityDays: 14,
  };
}

/** The footprint storage rows, in the order and words the Scenario inputs table shows them. */
export const STORAGE_ROWS = [
  ['filesystemGib', 'Shared filesystem GiB'],
  ['extraSsdGib', 'Network SSD GiB'],
  ['ioM3Gib', 'IO_M3 GiB'],
  ['objectStorageGib', 'Object Storage GiB'],
] as const;

/**
 * Footprint rows out of order (G4.7): a minimum above the expected count, or an expected count above the maximum,
 * which made a "maximum" quote cheaper than the "expected" one. `input` is the offending field's accessible name in
 * the Scenario inputs table.
 */
export function footprintOrderIssues(fp: Scenario['footprints']): { input: string; text: string }[] {
  const out: { input: string; text: string }[] = [];
  const check = (name: string, input: (k: 'min' | 'max') => string, min: number, expected: number, max: number) => {
    if (min > expected) out.push({ input: input('min'), text: `${name}: minimum ${min} is above the expected ${expected}` });
    if (expected > max) out.push({ input: input('max'), text: `${name}: expected ${expected} is above the maximum ${max}` });
  };
  fp.expected.nodeGroups.forEach((g, gi) =>
    check(g.name, k => `${g.name} ${k} count`, fp.min.nodeGroups[gi]?.count ?? 0, g.count, fp.max.nodeGroups[gi]?.count ?? 0),
  );
  for (const [f, label] of STORAGE_ROWS) check(label, k => `${f} ${k}`, fp.min[f] ?? 0, fp.expected[f] ?? 0, fp.max[f] ?? 0);
  return out;
}
