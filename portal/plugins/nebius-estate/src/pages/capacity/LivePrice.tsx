import { useEffect, useMemo, useState } from 'react';
import type { Footprint, LivePriceResponse } from '@internal/nebius-domain';
import { fmtMoney, fmtTime, useBackend, useMeta } from '../../ui';
import { priceBasisText } from '../pricing/livePrice';
import { readableInputError } from '../provisioning/validate';

const NEEDED = ['nebius.commercial.scenario.read', 'nebius.commercial.rate.read'];

export interface LivePrices {
  /** Per footprint key; absent while loading or when not attempted. */
  results?: Record<string, LivePriceResponse>;
  /** Why no price is shown at all (permission, request failure). */
  reason?: string;
  loading: boolean;
  /** Set while `results` are cached figures for these same footprints, shown until the fresh reply arrives. */
  cachedAt?: string;
}

/** Earlier replies for exactly these footprints (same body), so a revisit shows figures at once. */
export type PriceCache = { at: string; results: Record<string, LivePriceResponse> };

const CACHE_KEY = 'ne-live-price-cache';
const CACHE_MAX = 20;
const memoryCache = new Map<string, PriceCache>();

function cacheGet(body: string): PriceCache | undefined {
  if (memoryCache.has(body)) return memoryCache.get(body);
  try {
    const stored = JSON.parse(window.sessionStorage.getItem(CACHE_KEY) ?? '{}') as Record<string, PriceCache>;
    return stored[body];
  } catch {
    return undefined;
  }
}

function cachePut(body: string, results: Record<string, LivePriceResponse>) {
  const entry = { at: new Date().toISOString(), results };
  memoryCache.set(body, entry);
  try {
    const stored = JSON.parse(window.sessionStorage.getItem(CACHE_KEY) ?? '{}') as Record<string, PriceCache>;
    stored[body] = entry;
    const keys = Object.keys(stored);
    for (const k of keys.slice(0, Math.max(0, keys.length - CACHE_MAX))) delete stored[k];
    window.sessionStorage.setItem(CACHE_KEY, JSON.stringify(stored));
  } catch {
    /* storage unavailable: the in-memory cache still serves this page load */
  }
}

type PriceState = { body?: string; results?: Record<string, LivePriceResponse>; error?: string };

/**
 * What the price column shows for the footprints in `body`. A reply belongs to the footprints it was asked
 * for: while the footprints differ from the last reply's, nothing is shown but "pricing…" — never the previous
 * footprint's prices. `invalid`: the inputs do not describe a footprint yet (shown instead of a price).
 */
export function livePricesView(state: PriceState, body: string, allowed: boolean | undefined, metaError?: string, invalid?: string, cached?: PriceCache): LivePrices {
  if (metaError) return { loading: false, reason: `Permissions could not be read: ${metaError}` };
  if (allowed === undefined) return { loading: true };
  if (!allowed) return { loading: false, reason: `Live prices need ${NEEDED.join(' and ')} (portal permissions).` };
  if (invalid) return { loading: false, reason: invalid };
  if (state.body !== body) return cached ? { loading: true, results: cached.results, cachedAt: cached.at } : { loading: true };
  if (state.error) return { loading: false, reason: `The pricing request failed: ${readableInputError(state.error)}` };
  return { loading: false, results: state.results };
}

/**
 * Prices each footprint with the Nebius billing calculator (POST /pricing/footprint), debounced while the inputs
 * change. Skipped with a reason when the caller lacks the permissions the route enforces, or when `invalid`
 * says the inputs are not a footprint yet.
 */
export function useLivePrices(footprints: { k: string; fp: Footprint }[], region: string, invalid?: string, capacityType?: 'on-demand' | 'preemptible'): LivePrices {
  const call = useBackend();
  const meta = useMeta();
  const allowed = meta.data ? NEEDED.every(p => meta.data!.permissions[p]) : undefined;
  // The GPU groups' capacity type (G2.3): a preemptible run is priced preemptible; system nodes stay on-demand.
  const body = useMemo(() => JSON.stringify(footprints.map(f => ({ k: f.k, body: { footprint: f.fp, region, ...(capacityType ? { capacityType } : {}) } }))), [footprints, region, capacityType]);
  const [state, setState] = useState<PriceState>({});

  useEffect(() => {
    if (!allowed || invalid) return undefined;
    let cancelled = false;
    const timer = setTimeout(() => {
      const items = JSON.parse(body) as { k: string; body: unknown }[];
      Promise.all(
        items.map(i =>
          call<LivePriceResponse>('/pricing/footprint', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(i.body) }).then(r => [i.k, r] as const),
        ),
      )
        .then(pairs => {
          const results = Object.fromEntries(pairs);
          cachePut(body, results);
          if (!cancelled) setState({ body, results });
        })
        .catch((e: Error) => !cancelled && setState({ body, error: e.message }));
    }, 500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [call, body, allowed, invalid]);

  // The calculator takes seconds on a first ask; figures for these same footprints from earlier in the session show meanwhile.
  const cached = useMemo(() => cacheGet(body), [body]);
  return livePricesView(state, body, allowed, meta.error?.message, invalid, cached);
}

/** One cell: the hourly list price, or "none" with the reason in the tooltip and accessible name. */
export function LivePriceCell({ prices, k }: { prices: LivePrices; k: string }) {
  const r = prices.results?.[k];
  if (prices.loading && !r) return <span className="ne-faint">pricing…</span>;
  if (!r) return <span className="ne-faint">none</span>;
  if (!r.value) return <span className="ne-faint" title={r.unavailableReason}>none</span>;
  if (!r.value.hourly) return <span className="ne-faint" title="The calculator reports usage-based pricing only for this footprint.">usage-based</span>;
  return <span>{fmtMoney(r.value.hourly)}</span>;
}

/** Below the table: the price basis (contract or list), as of, source and pricing project, unpriced lines, or the reason there is none. */
export function LivePriceNote({ prices, keys, name = id => id }: { prices: LivePrices; keys: string[]; name?: (projectId: string) => string }) {
  if (prices.reason) return <p className="ne-cap-price-note ne-muted">No live price: {prices.reason}</p>;
  if (!prices.results) return <p className="ne-cap-price-note ne-faint" role="status">Asking the Nebius billing calculator for prices…</p>;
  const all = keys.map(k => prices.results![k]).filter(Boolean);
  const priced = all.find(r => r.value)?.value;
  const reasons = [...new Set(all.filter(r => !r.value).map(r => r.unavailableReason ?? 'no reason given'))];
  const unpriced = [...new Set(all.flatMap(r => r.value?.unpriced ?? []))];
  return (
    <div className="ne-cap-price-note ne-muted" role="status">
      {prices.cachedAt ? <p className="ne-faint">Cached figures from {fmtTime(prices.cachedAt)}; refreshing from the calculator…</p> : null}
      {priced ? (
        <p>
          Live column: <strong>{priceBasisText(priced, m => fmtMoney(m))}</strong> per hour from the {priced.source}, as of <strong>{fmtTime(priced.asOf)}</strong>, priced in project{' '}
          <span title={priced.projectId}>{name(priced.projectId)}</span>. Not a quote.
          {priced.contractNote ? <> {priced.contractNote}</> : null}
        </p>
      ) : null}
      {unpriced.length ? <p>Not priced by the calculator: {unpriced.join('; ')}.</p> : null}
      {reasons.length ? <p>No live price{priced ? ' for some footprints' : ''}: {reasons.join(' ')}</p> : null}
    </div>
  );
}
