import { Knex } from 'knex';
import { ConnectorStatus, HealthStats, SyncRun } from '@internal/nebius-domain';

/**
 * Connector health: every sync run of a connector and of each API capability,
 * kept `retentionDays` (default 7) in the portal database. Stats are derived on
 * read: 24 h success rate, p50/p95 duration, consecutive failures, recent runs.
 */
const TABLE = 'nebius_estate_sync_runs';

export interface RunRow extends SyncRun {
  kind: 'connector' | 'capability';
  subject: string;
}

export function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

/** An ok run answered from the connector's cache (no call made): out of the latency percentiles. */
export const CACHED = 'cached';

/** Under this share of successful runs in 24 h, a connector that answers now is "degraded", not "ok". */
export const DEGRADED_BELOW = 0.9;

/** A connector's state with its recent health: one that answers now but failed too often in 24 h reads "degraded". */
export function connectorStateFromHealth(state: ConnectorStatus['state'], h: HealthStats | undefined): ConnectorStatus['state'] {
  if (state !== 'ok' || !h || !h.runs24h || h.successRate24h === null || h.successRate24h === undefined) return state;
  return h.successRate24h < DEGRADED_BELOW ? 'degraded' : state;
}

/** Runs that say nothing about health: not set up, or waiting for a target that is not ready yet. */
export const NEUTRAL_RUN_CLASSES = new Set(['not-configured', 'waiting', 'optional', 'starting', 'not-needed']);
const counts = (r: SyncRun) => !NEUTRAL_RUN_CLASSES.has(r.errorClass ?? '');

/**
 * Stats from a subject's runs (any order). Not-configured and waiting runs are kept in `recentRuns` (drawn as
 * neutral ticks) but left out of the rate, the percentiles, the failure streak and the failure count.
 */
export function healthOf(runs: SyncRun[], now: Date, nextRunAt?: string, totals?: { runs: number; ok: number }): HealthStats {
  const newest = [...runs].sort((a, b) => b.at.localeCompare(a.at));
  // Not set up (or waiting) now: earlier outcomes say nothing about the current state, so no rate or streak.
  const idleNow = newest.length > 0 && !counts(newest[0]);
  const scored = idleNow ? [] : newest.filter(counts);
  const since = new Date(now.getTime() - 86_400_000).toISOString();
  const day = scored.filter(r => r.at >= since);
  // A cached answer (no call made) says nothing about latency: it counts as a success, not as a 0 ms call.
  const durations = day.filter(r => r.errorClass !== CACHED).map(r => r.durationMs).sort((a, b) => a - b);
  let consecutiveFailures = 0;
  for (const r of scored) {
    if (r.ok) break;
    consecutiveFailures++;
  }
  // `runs` may be the newest few only (HealthStore keeps 200 per subject); `totals` counts every run of the 24 h.
  const count = idleNow ? { runs: 0, ok: 0 } : totals ?? { runs: day.length, ok: day.filter(r => r.ok).length };
  return {
    runs24h: count.runs,
    successRate24h: count.runs ? Math.round((count.ok / count.runs) * 1000) / 1000 : null,
    p50Ms: percentile(durations, 50),
    p95Ms: percentile(durations, 95),
    lastDurationMs: scored[0]?.durationMs,
    consecutiveFailures,
    failures24h: count.runs - count.ok,
    lastFailureAt: newest.filter(counts).find(r => !r.ok)?.at,
    nextRunAt,
    recentRuns: newest.slice(0, 20),
  };
}

export class HealthStore {
  constructor(private readonly db: Knex, private readonly retentionDays = 7) {}

  async record(rows: RunRow[], now = new Date()): Promise<void> {
    if (!rows.length) return;
    const cutoff = new Date(now.getTime() - this.retentionDays * 86_400_000).toISOString();
    await this.db.transaction(async trx => {
      for (let i = 0; i < rows.length; i += 200) {
        await trx(TABLE).insert(
          rows.slice(i, i + 200).map(r => ({
            kind: r.kind, subject: r.subject, started_at: r.at, duration_ms: Math.max(0, Math.round(r.durationMs)), ok: r.ok,
            error_class: r.errorClass ?? null, http_status: r.httpStatus ?? null, items: r.items ?? null,
          })),
        );
      }
      await trx(TABLE).where('started_at', '<', cutoff).delete();
    });
  }

  /**
   * Health per subject: the streak, percentiles and chart from the newest runs (runs()), the 24 h counts from every
   * run of the 24 h (a subject can run more than the 200 runs() keeps, e.g. while fast re-syncs run).
   */
  async stats(kind: RunRow['kind'], now = new Date()): Promise<Map<string, HealthStats>> {
    const since = new Date(now.getTime() - 86_400_000).toISOString();
    const [runs, grouped] = await Promise.all([
      this.runs(kind, now),
      this.db(TABLE)
        .where({ kind })
        .andWhere('started_at', '>=', since)
        .andWhere(q => q.whereNull('error_class').orWhereNotIn('error_class', [...NEUTRAL_RUN_CLASSES]))
        .groupBy('subject')
        // `ok` is a boolean column: PostgreSQL does not sum booleans, SQLite stores 0/1; CASE works on both.
        .select<{ subject: string; runs: number | string; ok: number | string | null }[]>('subject', this.db.raw('count(*) as runs'), this.db.raw('sum(case when ok then 1 else 0 end) as ok')),
    ]);
    const totals = new Map(grouped.map(c => [String(c.subject), { runs: Number(c.runs), ok: Number(c.ok ?? 0) }]));
    return new Map([...runs.entries()].map(([subject, list]) => [subject, healthOf(list, now, undefined, totals.get(subject) ?? { runs: 0, ok: 0 })]));
  }

  /** Runs per subject over the window needed for stats (24 h, plus the last 20 runs for streaks). */
  async runs(kind: RunRow['kind'], now = new Date()): Promise<Map<string, SyncRun[]>> {
    const since = new Date(now.getTime() - this.retentionDays * 86_400_000).toISOString();
    const rows = await this.db(TABLE).where({ kind }).andWhere('started_at', '>=', since).orderBy('started_at', 'desc').limit(20_000);
    const out = new Map<string, SyncRun[]>();
    for (const r of rows) {
      const list = out.get(r.subject) ?? [];
      if (list.length >= 200) continue;
      list.push({ at: r.started_at, ok: Boolean(r.ok), durationMs: r.duration_ms, errorClass: r.error_class ?? undefined, httpStatus: r.http_status ?? undefined, items: r.items ?? undefined });
      out.set(r.subject, list);
    }
    return out;
  }
}
