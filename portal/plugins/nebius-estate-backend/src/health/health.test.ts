import { connectorStateFromHealth, HealthStore, healthOf, percentile } from './HealthStore';
import { migrate } from '../database';
import knexFactory from 'knex';

describe('connector health', () => {
  const now = new Date('2026-10-11T12:00:00Z');
  const at = (minAgo: number) => new Date(now.getTime() - minAgo * 60_000).toISOString();

  it('derives success rate, p50/p95, the failure streak and recent runs (newest first)', () => {
    const runs = [
      { at: at(1), ok: false, durationMs: 900, errorClass: 'unreachable' },
      { at: at(16), ok: false, durationMs: 800, errorClass: 'unreachable' },
      { at: at(31), ok: true, durationMs: 300 },
      { at: at(46), ok: true, durationMs: 200 },
      { at: at(25 * 60), ok: true, durationMs: 100 }, // older than 24 h: not in the rate
    ];
    const h = healthOf(runs, now, at(-14));
    expect(h).toMatchObject({ runs24h: 4, successRate24h: 0.5, p50Ms: 300, p95Ms: 900, lastDurationMs: 900, consecutiveFailures: 2, nextRunAt: at(-14) });
    expect(h.recentRuns.map(r => r.durationMs)).toEqual([900, 800, 300, 200, 100]);
    expect(healthOf([], now)).toMatchObject({ runs24h: 0, successRate24h: null, p50Ms: null, consecutiveFailures: 0 });
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
  });

  it('leaves not-configured and waiting runs out of the rate, the percentiles and the streak; counts failures in 24 h', () => {
    const runs = [
      { at: at(1), ok: true, durationMs: 300 },
      { at: at(16), ok: false, durationMs: 0, errorClass: 'not-configured' },
      { at: at(31), ok: false, durationMs: 0, errorClass: 'waiting' },
      { at: at(46), ok: false, durationMs: 700, errorClass: 'unreachable' },
      { at: at(61), ok: true, durationMs: 200 },
    ];
    const h = healthOf(runs, now);
    expect(h).toMatchObject({ runs24h: 3, successRate24h: 0.667, p50Ms: 300, consecutiveFailures: 0, failures24h: 1, lastFailureAt: at(46) });
    expect(h.recentRuns).toHaveLength(5); // still drawn, as neutral ticks
    expect(healthOf([{ at: at(1), ok: false, durationMs: 0, errorClass: 'not-configured' }], now)).toMatchObject({ runs24h: 0, successRate24h: null, p50Ms: null, consecutiveFailures: 0, failures24h: 0 });
  });

  it('a subject that is not set up now has no current rate or streak, even after earlier failures', () => {
    const runs = [
      { at: at(1), ok: false, durationMs: 0, errorClass: 'not-configured' },
      { at: at(16), ok: false, durationMs: 0, errorClass: 'not-found' },
      { at: at(31), ok: false, durationMs: 0, errorClass: 'not-found' },
    ];
    expect(healthOf(runs, now)).toMatchObject({ runs24h: 0, successRate24h: null, consecutiveFailures: 0, p50Ms: null, lastFailureAt: at(16) });
  });

  it('leaves cached answers out of the latency percentiles (a cache hit is not a 0 ms call), but counts them as successes', () => {
    const runs = [
      { at: at(1), ok: true, durationMs: 0, errorClass: 'cached' },
      { at: at(16), ok: true, durationMs: 1, errorClass: 'cached' },
      { at: at(31), ok: true, durationMs: 420 },
      { at: at(46), ok: true, durationMs: 380 },
    ];
    expect(healthOf(runs, now)).toMatchObject({ runs24h: 4, successRate24h: 1, p50Ms: 380, p95Ms: 420, consecutiveFailures: 0 });
  });

  it('a connector that answers but succeeded under 90 % of its runs in 24 h is "degraded", not "ok"', () => {
    const h = (rate: number, runs = 66) => ({ runs24h: runs, successRate24h: rate, p50Ms: 1, p95Ms: 1, consecutiveFailures: 0, recentRuns: [] });
    expect(connectorStateFromHealth('ok', h(0.576))).toBe('degraded');
    expect(connectorStateFromHealth('ok', h(0.95))).toBe('ok');
    expect(connectorStateFromHealth('ok', h(0.5, 1))).toBe('degraded');
    expect(connectorStateFromHealth('error', h(0.5))).toBe('error');
    expect(connectorStateFromHealth('ok', undefined)).toBe('ok');
    expect(connectorStateFromHealth('ok', { ...h(0), runs24h: 0, successRate24h: null })).toBe('ok');
  });

  it('counts every run of the last 24 h, not only the newest 200 it keeps for the streak and the chart (F1.31)', async () => {
    const db = knexFactory({ client: 'better-sqlite3', connection: ':memory:', useNullAsDefault: true });
    await migrate(db);
    const store = new HealthStore(db, 7);
    // 250 runs in 24 h (fast re-syncs while something changes state): the 20 failures are the oldest 20.
    const rows = Array.from({ length: 250 }, (_, i) => ({ kind: 'connector' as const, subject: 'nebius-inventory', at: new Date(now.getTime() - (i + 1) * 5 * 60_000).toISOString(), ok: i < 230, durationMs: 100, errorClass: i < 230 ? undefined : 'degraded' }));
    // Neutral runs (not set up) are not counted; runs older than 24 h are not either.
    rows.push({ kind: 'connector', subject: 'nebius-inventory', at: new Date(now.getTime() - 25 * 3_600_000).toISOString(), ok: false, durationMs: 1, errorClass: 'degraded' });
    await store.record(rows, now);
    await store.record([{ kind: 'connector', subject: 'prometheus', at: at(1), ok: false, durationMs: 0, errorClass: 'not-configured' }], now);
    const stats = await store.stats('connector', now);
    expect(stats.get('nebius-inventory')).toMatchObject({ runs24h: 250, failures24h: 20, successRate24h: 0.92, consecutiveFailures: 0 });
    expect(stats.get('nebius-inventory')!.recentRuns).toHaveLength(20);
    expect(stats.get('prometheus')).toMatchObject({ runs24h: 0, successRate24h: null });
    await db.destroy();
  });

  it('stores runs and prunes them after the retention window', async () => {
    const db = knexFactory({ client: 'better-sqlite3', connection: ':memory:', useNullAsDefault: true });
    await migrate(db);
    const store = new HealthStore(db, 7);
    await store.record([{ kind: 'capability', subject: 'quotas.allowances', at: new Date(now.getTime() - 8 * 86_400_000).toISOString(), ok: true, durationMs: 50 }], new Date(now.getTime() - 8 * 86_400_000));
    await store.record([{ kind: 'capability', subject: 'quotas.allowances', at: at(1), ok: false, durationMs: 120, errorClass: 'permission-denied', httpStatus: 403 }], now);
    const runs = await store.runs('capability', now);
    expect(runs.get('quotas.allowances')).toEqual([{ at: at(1), ok: false, durationMs: 120, errorClass: 'permission-denied', httpStatus: 403, items: undefined }]);
    await db.destroy();
  });
});
