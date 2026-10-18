import { NebiusCalculator } from '../commercial/calculator';
import { HttpClient } from './http';
import { LruTtlCache, TokenBucketLimiter } from './limits';

describe('LruTtlCache', () => {
  it('evicts the least recently used entry beyond its size and expires entries after the TTL', () => {
    let now = 0;
    const c = new LruTtlCache<string, number>({ max: 2, ttlMs: 1000, now: () => now });
    c.set('a', 1);
    c.set('b', 2);
    expect(c.get('a')).toBe(1); // a is now the most recent
    c.set('c', 3);
    expect([c.get('a'), c.get('b'), c.get('c')]).toEqual([1, undefined, 3]);
    expect(c.size).toBe(2);
    now = 1001;
    expect(c.get('a')).toBeUndefined();
    expect(c.size).toBe(1);
  });
});

describe('TokenBucketLimiter', () => {
  it('allows a burst per key, then refuses with the seconds until the next token, and refills', () => {
    let now = 0;
    const l = new TokenBucketLimiter({ capacity: 3, refillPerSecond: 0.5, maxKeys: 2, now: () => now });
    expect([l.take('u'), l.take('u'), l.take('u')]).toEqual([0, 0, 0]);
    expect(l.take('u')).toBe(2); // retry after 2 s
    expect(l.take('v')).toBe(0); // per user
    now = 2000;
    expect(l.take('u')).toBe(0);
    // Bounded memory: at most maxKeys buckets; the oldest is dropped (a full bucket again).
    l.take('w');
    expect(l.size).toBe(2);
  });
});

describe('NebiusCalculator cache', () => {
  it('is bounded in size', async () => {
    const fetch = jest.fn(async () => new Response(JSON.stringify({ resourceCosts: [{ aggregationUnit: { unit: 'hour', unitType: 'UNIT_TYPE_TIME_BASED' }, general: { total: { cost: '1' } } }] }), { status: 200 }));
    const http = new HttpClient({ allowedOrigins: ['https://api.nebius.cloud'], timeoutMs: 1000, fetch, allowPostPaths: ['/billing/v1/calculator/estimate-batch'] });
    const calc = new NebiusCalculator(http, { currency: 'xts', ttlMs: 60_000, cacheMax: 3 });
    for (let i = 0; i < 5; i++) await calc.estimate([{ key: `k${i}`, description: 'd', count: 1, spec: { i } }], 'project-e00mock', []);
    expect(calc.cacheSize).toBe(3);
    await calc.estimate([{ key: 'k4', description: 'd', count: 1, spec: { i: 4 } }], 'project-e00mock', []);
    expect(fetch).toHaveBeenCalledTimes(5); // the newest is still cached
  });
});
