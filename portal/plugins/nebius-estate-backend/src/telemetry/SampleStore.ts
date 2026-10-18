import { Knex } from 'knex';
import { BucketAggregate, bucketizeAggregates, GpuHourly, GpuSample, GpuSeries, hourOf, IDLE_UTIL_PERCENT, MAX_TRACKED_GPUS, ROLLUP_RETENTION_DAYS, rollupHourly, SAMPLE_RETENTION_DAYS } from '@internal/nebius-domain';

/**
 * GPU sample store in the portal database: 1-minute samples for 7 days and hourly roll-ups for 90
 * days, per GPU series. Bounded: at most MAX_TRACKED_GPUS series seen within the 7-day sample window
 * (rows ≤ that × 10 080 minutes, + 2 160 hourly rows each); when full, a new GPU evicts the series
 * seen longest ago (never one of the same write). Older rows are pruned on every write.
 */
const SERIES = 'nebius_estate_gpu_series';
const SAMPLES = 'nebius_estate_gpu_samples';
const HOURLY = 'nebius_estate_gpu_hourly';
const CHUNK = 150;

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function toSample(r: any): GpuSample {
  return { key: r.series_key, ts: Number(r.ts), util: num(r.util), temp: num(r.temp), power: num(r.power), memUsed: num(r.mem_used), memTotal: num(r.mem_total) };
}

export class SampleStore {
  constructor(
    private readonly db: Knex,
    private readonly limits = { sampleDays: SAMPLE_RETENTION_DAYS, rollupDays: ROLLUP_RETENTION_DAYS, maxSeries: MAX_TRACKED_GPUS },
  ) {}

  /**
   * Records the series and their samples, then rolls up the hours they touch and prunes. Returns what
   * was kept: samples new or changed (an unchanged re-read minute is not counted), series tracked in the sample
   * window, new series refused, series evicted.
   */
  async write(series: GpuSeries[], samples: GpuSample[], nowSec: number): Promise<{ samples: number; series: number; refused: number; evicted: number }> {
    return this.db.transaction(async trx => {
      // Only series seen within the sample window count toward the cap; older ones keep their roll-ups.
      const windowStart = nowSec - this.limits.sampleDays * 86_400;
      const active = await trx(SERIES).where('last_seen', '>=', windowStart).select('series_key', 'last_seen');
      const known = new Set(active.map(r => r.series_key as string));
      const incoming = new Set(series.map(s => s.key));
      const fresh = series.filter(s => !known.has(s.key));
      let room = this.limits.maxSeries - known.size;
      const evict: string[] = [];
      if (fresh.length > room) {
        // Full: evict the series seen longest ago, never one this write reports.
        const candidates = active.filter(r => !incoming.has(r.series_key)).sort((a, b) => Number(a.last_seen) - Number(b.last_seen));
        for (const c of candidates.slice(0, fresh.length - Math.max(0, room))) evict.push(c.series_key);
        room += evict.length;
      }
      for (let i = 0; i < evict.length; i += CHUNK) {
        const keys = evict.slice(i, i + CHUNK);
        await trx(SAMPLES).whereIn('series_key', keys).delete();
        await trx(HOURLY).whereIn('series_key', keys).delete();
        await trx(SERIES).whereIn('series_key', keys).delete();
      }
      const evicted = new Set(evict);
      const accepted = new Set([...[...known].filter(k => !evicted.has(k)), ...fresh.slice(0, Math.max(0, room)).map(s => s.key)]);
      const offered = samples.filter(s => accepted.has(s.key));
      // Only new or changed minutes are written and counted (G1.5): the five minutes re-read before the newest sample
      // are usually already stored, and an idle GPU's old minutes must not read as "samples written" every sync.
      const stored = new Map<string, GpuSample>();
      if (offered.length) {
        const lo = Math.min(...offered.map(x => x.ts));
        const hi = Math.max(...offered.map(x => x.ts));
        const keys = [...new Set(offered.map(x => x.key))];
        for (let i = 0; i < keys.length; i += CHUNK) {
          for (const r of await trx(SAMPLES).whereIn('series_key', keys.slice(i, i + CHUNK)).andWhere('ts', '>=', lo).andWhere('ts', '<=', hi)) {
            const x = toSample(r);
            stored.set(`${x.key}\u001f${x.ts}`, x);
          }
        }
      }
      const FIELDS = ['util', 'temp', 'power', 'memUsed', 'memTotal'] as const;
      // The sample columns are `real` (float4) on Postgres: compare at float4 precision, or every fractional reading
      // re-read from the store would count as changed and be rewritten each sync.
      const same = (a: number | null, b: number | null) => (a === null || b === null ? a === b : Math.fround(a) === Math.fround(b));
      const keep = offered.filter(x => {
        const was = stored.get(`${x.key}\u001f${x.ts}`);
        return !was || FIELDS.some(f => !same(x[f] ?? null, was[f] ?? null));
      });
      // A series is dated by its newest sample, not by the write: a GPU that stopped reporting ages out of the
      // 7-day window and the tracked-GPU cap (G1.5). The stored date never moves back.
      const newest = new Map<string, number>();
      for (const x of offered) newest.set(x.key, Math.max(newest.get(x.key) ?? 0, x.ts));
      const rows = series.filter(x => accepted.has(x.key)).map(x => ({
        series_key: x.key, project_id: x.projectId, instance_id: x.instanceId ?? null, node: x.node, gpu: x.gpu ?? null,
        cluster_id: x.clusterId ?? null, node_group_id: x.nodeGroupId ?? null, last_seen: newest.get(x.key) ?? (known.has(x.key) ? 0 : nowSec),
        instance_name: x.instanceName ?? null, node_group_name: x.nodeGroupName ?? null, cluster_name: x.clusterName ?? null, project_name: x.projectName ?? null,
        region: x.region ?? null, stage: x.stage ?? null,
      }));
      // Names are last-known: a write without them (the resources are gone) keeps the stored ones.
      const keepName = (col: string) => trx.raw(`coalesce(excluded.${col}, ${SERIES}.${col})`);
      const merge = {
        project_id: trx.raw('excluded.project_id'), instance_id: trx.raw('excluded.instance_id'), node: trx.raw('excluded.node'), gpu: trx.raw('excluded.gpu'),
        cluster_id: trx.raw('excluded.cluster_id'), node_group_id: trx.raw('excluded.node_group_id'),
        last_seen: trx.raw(`case when excluded.last_seen > ${SERIES}.last_seen then excluded.last_seen else ${SERIES}.last_seen end`),
        instance_name: keepName('instance_name'), node_group_name: keepName('node_group_name'), cluster_name: keepName('cluster_name'), project_name: keepName('project_name'),
        region: keepName('region'), stage: keepName('stage'),
      };
      for (let i = 0; i < rows.length; i += CHUNK) await trx(SERIES).insert(rows.slice(i, i + CHUNK)).onConflict('series_key').merge(merge);
      const sampleRows = keep.map(x => ({ series_key: x.key, ts: x.ts, util: x.util ?? null, temp: x.temp ?? null, power: x.power ?? null, mem_used: x.memUsed ?? null, mem_total: x.memTotal ?? null }));
      for (let i = 0; i < sampleRows.length; i += CHUNK) await trx(SAMPLES).insert(sampleRows.slice(i, i + CHUNK)).onConflict(['series_key', 'ts']).merge();
      // Roll up every hour these samples touch, from all samples of that hour (late arrivals included).
      const hours = [...new Set(keep.map(s => hourOf(s.ts)))];
      if (hours.length) {
        const lo = Math.min(...hours);
        const hi = Math.max(...hours) + 3600;
        const keys = [...new Set(keep.map(s => s.key))];
        const all: GpuSample[] = [];
        for (let i = 0; i < keys.length; i += CHUNK) {
          all.push(...(await trx(SAMPLES).whereIn('series_key', keys.slice(i, i + CHUNK)).andWhere('ts', '>=', lo).andWhere('ts', '<', hi)).map(toSample));
        }
        const rolled = rollupHourly(all).map(h => ({
          series_key: h.key, hour: h.hour, samples: h.samples, idle_samples: h.idleSamples, util_avg: h.utilAvg, util_max: h.utilMax,
          temp_avg: h.tempAvg, temp_max: h.tempMax, power_avg: h.powerAvg, mem_used_avg: h.memUsedAvg, mem_total: h.memTotal,
        }));
        for (let i = 0; i < rolled.length; i += CHUNK) await trx(HOURLY).insert(rolled.slice(i, i + CHUNK)).onConflict(['series_key', 'hour']).merge();
      }
      await trx(SAMPLES).where('ts', '<', nowSec - this.limits.sampleDays * 86_400).delete();
      await trx(HOURLY).where('hour', '<', nowSec - this.limits.rollupDays * 86_400).delete();
      await trx(SERIES).where('last_seen', '<', nowSec - this.limits.rollupDays * 86_400).delete();
      return { samples: keep.length, series: accepted.size, refused: series.length - series.filter(s => accepted.has(s.key)).length, evicted: evict.length };
    });
  }

  /** Series with a sample in the 7-day sample window (the ones the tracked-GPU cap counts). */
  async seriesInWindow(nowSec: number): Promise<number> {
    const r = await this.db(SERIES).where('last_seen', '>=', nowSec - this.limits.sampleDays * 86_400).count('* as n').first();
    return Number(r?.n ?? 0);
  }

  /** Newest stored sample (seconds), per project; undefined when the project has none. */
  async newestPerProject(): Promise<Map<string, number>> {
    const rows = await this.db(SAMPLES).join(SERIES, `${SERIES}.series_key`, `${SAMPLES}.series_key`).groupBy(`${SERIES}.project_id`).select(`${SERIES}.project_id as project`).max(`${SAMPLES}.ts as ts`);
    return new Map(rows.map(r => [String(r.project), Number(r.ts)]));
  }

  async series(): Promise<GpuSeries[]> {
    return (await this.db(SERIES).select()).map(r => ({
      key: r.series_key, projectId: r.project_id, instanceId: r.instance_id ?? undefined, node: r.node, gpu: r.gpu ?? undefined,
      clusterId: r.cluster_id ?? undefined, nodeGroupId: r.node_group_id ?? undefined,
      instanceName: r.instance_name ?? undefined, nodeGroupName: r.node_group_name ?? undefined, clusterName: r.cluster_name ?? undefined, projectName: r.project_name ?? undefined,
      region: r.region ?? undefined, stage: r.stage ?? undefined,
    }));
  }

  async samples(fromSec: number, toSec: number, keys: string[]): Promise<GpuSample[]> {
    const out: GpuSample[] = [];
    for (let i = 0; i < keys.length; i += CHUNK) {
      out.push(...(await this.db(SAMPLES).whereIn('series_key', keys.slice(i, i + CHUNK)).andWhere('ts', '>=', fromSec).andWhere('ts', '<', toSec).orderBy('ts')).map(toSample));
    }
    return out;
  }

  /**
   * Minute samples downsampled in the database: one row per GPU and bucket of `bucketSeconds` (sums,
   * counts, idle minutes, newest sample), so a range read is bounded by GPUs × buckets, not minutes.
   */
  async bucketed(fromSec: number, toSec: number, keys: string[], bucketSeconds: number): Promise<BucketAggregate[]> {
    if (![fromSec, toSec, bucketSeconds].every(Number.isSafeInteger) || bucketSeconds <= 0) throw new Error('bucketed: integer bounds and bucket width expected');
    // Integers checked above are inlined: the same expression must appear in SELECT and GROUP BY.
    const bucket = `(ts - ${fromSec}) / ${bucketSeconds}`;
    const out: BucketAggregate[] = [];
    for (let i = 0; i < keys.length; i += CHUNK) {
      const rows = await this.db(SAMPLES)
        .whereIn('series_key', keys.slice(i, i + CHUNK))
        .andWhere('ts', '>=', fromSec)
        .andWhere('ts', '<', toSec)
        .groupBy('series_key')
        .groupByRaw(bucket)
        .select('series_key', this.db.raw(`${bucket} as b`))
        .select(
          this.db.raw('count(*) as n'),
          this.db.raw(`sum(case when util < ${IDLE_UTIL_PERCENT} then 1 else 0 end) as idle`),
          this.db.raw('sum(util) as util_sum'), this.db.raw('count(util) as util_n'),
          this.db.raw('sum(temp) as temp_sum'), this.db.raw('count(temp) as temp_n'),
          this.db.raw('sum(power) as power_sum'), this.db.raw('count(power) as power_n'),
          this.db.raw('sum(case when mem_used is not null and mem_total > 0 then (mem_used * 1.0 / mem_total) * 100 end) as mem_sum'),
          this.db.raw('sum(case when mem_used is not null and mem_total > 0 then 1 else 0 end) as mem_n'),
          this.db.raw('max(ts) as newest'),
        );
      out.push(
        ...rows.map((r: any) => ({
          key: r.series_key, bucket: Number(r.b), samples: Number(r.n), idle: Number(r.idle),
          util: [Number(r.util_sum ?? 0), Number(r.util_n)], temp: [Number(r.temp_sum ?? 0), Number(r.temp_n)],
          power: [Number(r.power_sum ?? 0), Number(r.power_n)], mem: [Number(r.mem_sum ?? 0), Number(r.mem_n)], newest: Number(r.newest),
        }) as BucketAggregate),
      );
    }
    return out;
  }

  /** The per-bucket values of one GPU from its aggregates (the same shape and rounding as bucketize). */
  toBuckets(aggs: BucketAggregate[], starts: number[], _bucketSeconds: number) {
    return bucketizeAggregates(aggs, starts.length);
  }

  async hourly(fromSec: number, toSec: number, keys: string[]): Promise<GpuHourly[]> {
    const out: GpuHourly[] = [];
    for (let i = 0; i < keys.length; i += CHUNK) {
      const rows = await this.db(HOURLY).whereIn('series_key', keys.slice(i, i + CHUNK)).andWhere('hour', '>=', fromSec).andWhere('hour', '<', toSec).orderBy('hour');
      out.push(
        ...rows.map(r => ({
          key: r.series_key, hour: Number(r.hour), samples: Number(r.samples), idleSamples: Number(r.idle_samples), utilAvg: num(r.util_avg), utilMax: num(r.util_max),
          tempAvg: num(r.temp_avg), tempMax: num(r.temp_max), powerAvg: num(r.power_avg), memUsedAvg: num(r.mem_used_avg), memTotal: num(r.mem_total),
        })),
      );
    }
    return out;
  }

  /** Oldest and newest sample of the given series (the Fleet freshness under a filter). */
  async extent(keys: string[]): Promise<{ oldest?: number; newest?: number }> {
    let oldest: number | undefined;
    let newest: number | undefined;
    for (let i = 0; i < keys.length; i += CHUNK) {
      const r = await this.db(SAMPLES).whereIn('series_key', keys.slice(i, i + CHUNK)).min('ts as oldest').max('ts as newest').first();
      const lo = num(r?.oldest);
      const hi = num(r?.newest);
      if (lo !== null) oldest = Math.min(oldest ?? lo, lo);
      if (hi !== null) newest = Math.max(newest ?? hi, hi);
    }
    return { oldest, newest };
  }

  /** Oldest and newest sample, and row counts (for freshness and the bounded-size test). */
  async stats(): Promise<{ oldest?: number; newest?: number; samples: number; hourly: number; series: number }> {
    const s = await this.db(SAMPLES).min('ts as oldest').max('ts as newest').count('* as n').first();
    const h = await this.db(HOURLY).count('* as n').first();
    const g = await this.db(SERIES).count('* as n').first();
    return { oldest: num(s?.oldest) ?? undefined, newest: num(s?.newest) ?? undefined, samples: Number(s?.n ?? 0), hourly: Number(h?.n ?? 0), series: Number(g?.n ?? 0) };
  }
}
