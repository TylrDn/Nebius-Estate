import knex, { Knex } from 'knex';
import { bucketize, bucketStarts, GpuSample, minuteOf, RANGE_SPEC } from '@internal/nebius-domain';
import { migrate } from '../database';
import { HttpClient } from '../lib/http';
import { NEBIUS_MONITORING } from '../inventory/endpoints';
import { stubNebiusApi } from '../__testUtils__/testing';
import { MetricsClient } from './MetricsClient';
import { SampleStore } from './SampleStore';
import { BACKFILL_WINDOW_SECONDS, TelemetryRecorder } from './recorder';
import { fleet } from './fleet';
import { cachedPricer } from './router';

const NOW = minuteOf(Date.parse('2026-10-11T08:00:00Z') / 1000);
const series = (key: string, projectId = 'project-e00mocklab') => ({ key, projectId, node: key, instanceId: `computeinstance-${key}` });

describe('GPU sample store', () => {
  let db: Knex;
  beforeEach(async () => {
    db = knex({ client: 'better-sqlite3', connection: ':memory:', useNullAsDefault: true });
    await migrate(db);
  });
  afterEach(() => db.destroy());

  it('keeps 1-minute samples 7 days and hourly roll-ups 90 days', async () => {
    const store = new SampleStore(db);
    const at = (ageSec: number, util: number): GpuSample => ({ key: 'g', ts: NOW - ageSec, util });
    await store.write([series('g')], [at(8 * 86_400, 1), at(6 * 86_400, 2), at(60, 3), at(0, 4)], NOW);
    expect((await store.samples(0, NOW + 60, ['g'])).map(s => s.util)).toEqual([2, 3, 4]);
    // The roll-up of the 8-day-old hour stays (90 days) after its minute samples are pruned.
    const hourly = await store.hourly(0, NOW + 3600, ['g']);
    expect(hourly.map(h => h.utilAvg)).toEqual([1, 2, 3, 4]); // 07:59 and 08:00 are different hours
    await store.write([series('g')], [], NOW + 91 * 86_400);
    expect(await store.hourly(0, NOW + 92 * 86_400, ['g'])).toEqual([]);
  });

  it('merges a re-read minute instead of duplicating it, and rolls the hour up again', async () => {
    const store = new SampleStore(db);
    await store.write([series('g')], [{ key: 'g', ts: NOW, util: 10 }], NOW);
    await store.write([series('g')], [{ key: 'g', ts: NOW, util: 30, temp: 50 }, { key: 'g', ts: NOW + 60, util: 2 }], NOW + 60);
    expect(await store.samples(NOW, NOW + 120, ['g'])).toEqual([
      { key: 'g', ts: NOW, util: 30, temp: 50, power: null, memUsed: null, memTotal: null },
      { key: 'g', ts: NOW + 60, util: 2, temp: null, power: null, memUsed: null, memTotal: null },
    ]);
    expect((await store.hourly(0, NOW + 3600, ['g']))[0]).toMatchObject({ samples: 2, idleSamples: 1, utilAvg: 16 });
  });

  it('is bounded: series beyond the cap are refused, not stored', async () => {
    const store = new SampleStore(db, { sampleDays: 7, rollupDays: 90, maxSeries: 2 });
    const r = await store.write([series('a'), series('b'), series('c')], ['a', 'b', 'c'].map(key => ({ key, ts: NOW, util: 1 })), NOW);
    expect(r).toEqual({ samples: 2, series: 2, refused: 1, evicted: 0 });
    expect((await store.stats()).series).toBe(2);
    // A week of minutes for one GPU is 10 080 rows at most.
    const week = Array.from({ length: 7 * 1440 + 30 }, (_, i) => ({ key: 'a', ts: NOW - i * 60, util: 50 }));
    await store.write([series('a')], week, NOW);
    expect((await store.stats()).samples).toBeLessThanOrEqual(7 * 1440 + 1 + 1);
  });
});

describe('GPU sample store: series cap and bounded reads', () => {
  let db: Knex;
  beforeEach(async () => {
    db = knex({ client: 'better-sqlite3', connection: ':memory:', useNullAsDefault: true });
    await migrate(db);
  });
  afterEach(() => db.destroy());

  it('counts only series seen in the 7-day window toward the cap, and evicts the oldest last_seen when full', async () => {
    const store = new SampleStore(db, { sampleDays: 7, rollupDays: 90, maxSeries: 2 });
    const one = (key: string, at: number) => store.write([series(key)], [{ key, ts: at, util: 1 }], at);
    await one('gone', NOW - 9 * 86_400);
    await one('a', NOW - 3 * 86_400);
    await one('b', NOW - 86_400);
    // 'gone' was last seen 9 days ago (8 before 'b' arrived): it does not count, so 'a' and 'b' fit.
    expect((await store.series()).map(x => x.key).sort()).toEqual(['a', 'b', 'gone']);
    // Full: a new GPU evicts the series seen longest ago (a), with its samples and roll-ups.
    expect(await one('c', NOW)).toEqual({ samples: 1, series: 2, refused: 0, evicted: 1 });
    expect((await store.series()).map(x => x.key).sort()).toEqual(['b', 'c', 'gone']);
    expect(await store.samples(0, NOW + 60, ['a'])).toEqual([]);
    expect(await store.hourly(0, NOW + 3600, ['a'])).toEqual([]);
    // Series of the same write are never evicted for each other: the surplus is refused.
    expect(await store.write([series('d'), series('e'), series('f')], ['d', 'e', 'f'].map(key => ({ key, ts: NOW + 60, util: 1 })), NOW + 60)).toMatchObject({ series: 2, refused: 1, evicted: 2 });
  });

  it('dates a series by its newest sample, not by the write, and counts only new or changed samples (G1.5)', async () => {
    const store = new SampleStore(db, { sampleDays: 7, rollupDays: 90, maxSeries: 1 });
    const old = { key: 'old', ts: NOW - 6.5 * 86_400, util: 5 };
    expect(await store.write([series('old')], [old], NOW)).toMatchObject({ samples: 1 });
    // Re-read unchanged: nothing new. A changed value counts.
    expect(await store.write([series('old')], [old], NOW + 900)).toMatchObject({ samples: 0 });
    expect(await store.write([series('old')], [{ ...old, temp: 40 }], NOW + 1800)).toMatchObject({ samples: 1 });
    // A day later the old GPU's last sample is 7.5 days old: it no longer holds the only tracked slot.
    expect(await store.write([series('new')], [{ key: 'new', ts: NOW + 86_400, util: 1 }], NOW + 86_400)).toEqual({ samples: 1, series: 1, refused: 0, evicted: 0 });
  });

  it('a re-read minute stored as a Postgres real (float4) is not counted as changed (G1.5)', async () => {
    // Sample columns are knex `float`: `real` on Postgres, so fractional DCGM readings come back at float4 precision.
    const store = new SampleStore(db);
    const sample = { key: 'p4', ts: NOW - 60, util: 37.123456789, power: 231.73456789, memUsed: 81_234.5678, memTotal: 81_559 };
    expect(await store.write([series('p4')], [sample], NOW)).toMatchObject({ samples: 1 });
    // What Postgres hands back: the shortest text of the float4 (extra_float_digits 1) or its exact value (3).
    for (const readBack of [(v: number) => Number(Math.fround(v).toPrecision(8)), (v: number) => Math.fround(v)]) {
      await db('nebius_estate_gpu_samples').where({ series_key: 'p4' }).update({ util: readBack(sample.util), power: readBack(sample.power), mem_used: readBack(sample.memUsed) });
      expect(await store.write([series('p4')], [sample], NOW + 900)).toMatchObject({ samples: 0 });
    }
    // A real change still counts.
    expect(await store.write([series('p4')], [{ ...sample, power: 232.5 }], NOW + 1800)).toMatchObject({ samples: 1 });
  });

  it('downsamples minute ranges in the database: one row per GPU and bucket, equal to bucketize', async () => {
    const store = new SampleStore(db);
    const keys = ['x', 'y', 'z'];
    const raw: GpuSample[] = [];
    for (const key of keys) {
      for (let i = 0; i < 1440; i += key === 'z' ? 7 : 1) {
        raw.push({ key, ts: NOW - i * 60, util: (i * 37 + key.charCodeAt(0)) % 100, temp: 40 + (i % 9), power: i % 3 ? 200 + (i % 50) : null, memUsed: 1000 + i, memTotal: i % 5 ? 4000 : null });
      }
    }
    await store.write(keys.map(k => series(k)), raw, NOW);
    for (const range of ['1h', '6h', '24h'] as const) {
      const spec = RANGE_SPEC[range];
      const starts = bucketStarts(range, NOW);
      const to = starts[starts.length - 1] + spec.bucketSeconds;
      const agg = await store.bucketed(starts[0], to, keys, spec.bucketSeconds);
      expect(agg.length).toBeLessThanOrEqual(keys.length * starts.length);
      for (const key of keys) {
        const want = bucketize(raw.filter(x => x.key === key), starts, spec.bucketSeconds);
        const got = store.toBuckets(agg.filter(x => x.key === key), starts, spec.bucketSeconds);
        expect(got).toEqual(want);
      }
    }
  });

  it('/fleet never loads minute samples one by one: 24 h is read downsampled, 7 d from the roll-ups', async () => {
    const store = new SampleStore(db);
    await store.write([series('g')], Array.from({ length: 1440 }, (_, i) => ({ key: 'g', ts: NOW - i * 60, util: 50 })), NOW);
    const samples = jest.spyOn(store, 'samples');
    for (const range of ['1h', '6h', '24h', '7d'] as const) {
      const f = await fleet({ store, snap: { resources: [] } as any, inScope: () => true, range, now: new Date(NOW * 1000), syncIntervalMinutes: 15, monitoringConfigured: true, price: async () => ({ hourly: null }) });
      expect(f.rows).toHaveLength(1);
    }
    expect(samples).not.toHaveBeenCalled();
  });
});

describe('telemetry recorder (sync loop extension)', () => {
  stubNebiusApi();
  let db: Knex;
  beforeEach(async () => {
    db = knex({ client: 'better-sqlite3', connection: ':memory:', useNullAsDefault: true });
    await migrate(db);
  });
  afterEach(() => db.destroy());

  const recorder = (store: SampleStore, now: Date) => {
    process.env.NEBIUS_TEST_TOKEN = 'test-token';
    const http = new HttpClient({ allowedOrigins: [NEBIUS_MONITORING], timeoutMs: 5000, authorization: async () => 'Bearer test-token' });
    return new TelemetryRecorder({
      store,
      client: () => new MetricsClient(http, NEBIUS_MONITORING),
      projects: () => ['project-e00mocksandbox', 'project-e00mocklab', 'project-e00mockstaging'],
      resources: () => [],
      maxConcurrency: 4,
      syncIntervalMinutes: 15,
      now: () => now,
    });
  };

  it('back-fills up to 7 days with query_range on its first sync, then only the gap since the newest sample', async () => {
    const store = new SampleStore(db);
    const t0 = new Date(NOW * 1000);
    const first = await recorder(store, t0).sync('2026-10-11T08:00:00Z');
    expect(first.capabilities[0]).toMatchObject({ id: 'monitoring.gpu-history', state: 'ok', connector: 'nebius-metrics-history' });
    const stats = await store.stats();
    expect(stats.series).toBe(2); // sandbox and lab GPUs; staging has none
    expect(stats.newest).toBe(NOW);
    expect(stats.oldest).toBe(NOW - 7 * 86_400 + 60);
    expect(stats.samples).toBe(2 * (7 * 1440));
    const lab = (await store.samples(NOW - 3600, NOW + 60, ['project-e00mocklab|computeinstance-e00mockb300|0'])).at(-1)!;
    expect(lab).toMatchObject({ temp: 41, power: 180, memUsed: 2048, memTotal: 274877 });
    // Two hours later (the portal was down): the gap heals on the next sync.
    const t1 = new Date((NOW + 7200) * 1000);
    await recorder(store, t1).sync('2026-10-11T10:00:00Z');
    expect((await store.stats()).newest).toBe(NOW + 7200);
    const gap = await store.samples(NOW + 60, NOW + 7200 + 60, ['project-e00mocklab|computeinstance-e00mockb300|0']);
    expect(gap).toHaveLength(120);
  });

  it('back-fills in time windows per project, never holding 7 days of samples in memory, and probes GPU-less projects once', async () => {
    const store = new SampleStore(db);
    const writes: number[] = [];
    const write = store.write.bind(store);
    jest.spyOn(store, 'write').mockImplementation(async (se, sa, at) => {
      writes.push(sa.length);
      return write(se, sa, at);
    });
    const http = new HttpClient({ allowedOrigins: [NEBIUS_MONITORING], timeoutMs: 5000, authorization: async () => 'Bearer test-token' });
    const client = new MetricsClient(http, NEBIUS_MONITORING);
    const calls: { project: string; span: number; step: number }[] = [];
    const range = client.queryRange.bind(client);
    jest.spyOn(client, 'queryRange').mockImplementation(async (project, expr, start, end, step) => {
      calls.push({ project, span: end - start, step });
      return range(project, expr, start, end, step);
    });
    const rec = new TelemetryRecorder({ store, client: () => client, projects: () => ['project-e00mocksandbox', 'project-e00mocklab', 'project-e00mockstaging'], resources: () => [], maxConcurrency: 4, syncIntervalMinutes: 15, now: () => new Date(NOW * 1000) });
    await rec.sync('2026-10-11T08:00:00Z');
    expect(BACKFILL_WINDOW_SECONDS).toBe(6 * 3600);
    // Every 1-minute read covers at most one window; each write holds one project's window.
    expect(Math.max(...calls.filter(c => c.step === 60).map(c => c.span))).toBeLessThanOrEqual(BACKFILL_WINDOW_SECONDS);
    expect(Math.max(...writes)).toBeLessThanOrEqual(BACKFILL_WINDOW_SECONDS / 60 + 1);
    // The same history as a single read would have stored.
    expect(await store.stats()).toMatchObject({ series: 2, samples: 2 * 7 * 1440, newest: NOW, oldest: NOW - 7 * 86_400 + 60 });
    // A project without GPUs costs one probe, not one call per window.
    expect(calls.filter(c => c.project === 'project-e00mockstaging')).toHaveLength(1);
  });

  it('the probe covers the whole gap: a GPU that reports only in the newest partial window is still recorded', async () => {
    // Prometheus semantics: query_range evaluates at start, start + step, … ≤ end; max_over_time(m[w]) at t looks at (t − w, t].
    const first = NOW - 2 * 3600; // the GPU came up two hours ago (verified live: such a probe once answered nothing)
    const util = (t: number) => (t >= first && t <= NOW ? 50 : undefined);
    const client = {
      queryRange: async (_p: string, expr: string, start: number, end: number, step: number) => {
        const values: [number, number][] = [];
        const over = /^max_over_time\(DCGM_FI_DEV_GPU_UTIL\[(\d+)s\]\)$/.exec(expr);
        for (let t = start; t <= end; t += step) {
          const v = over ? [...Array(Number(over[1]) / 60).keys()].map(i => util(t - i * 60)).find(x => x !== undefined) : util(t);
          if (v !== undefined) values.push([t, v]);
        }
        return values.length ? [{ metric: { instance_id: 'computeinstance-e00mocknew', gpu: '0' }, values }] : [];
      },
      query: async () => [],
    } as unknown as MetricsClient;
    const store = new SampleStore(db);
    const rec = new TelemetryRecorder({ store, client: () => client, projects: () => ['project-e00mocklab'], resources: () => [], maxConcurrency: 1, syncIntervalMinutes: 15, now: () => new Date(NOW * 1000) });
    await rec.sync('2026-10-11T08:00:00Z');
    expect((await store.stats()).samples).toBe(121);
  });

  it('a GPU that stopped reporting yesterday: no samples re-counted each sync, and it ages out of the 7-day window (G1.5)', async () => {
    const gone = NOW - 86_400;
    const util = (t: number) => (t >= gone - 3600 && t <= gone ? 50 : undefined);
    const client = {
      queryRange: async (_p: string, expr: string, start: number, end: number, step: number) => {
        const values: [number, number][] = [];
        const over = /^max_over_time\(DCGM_FI_DEV_GPU_UTIL\[(\d+)s\]\)$/.exec(expr);
        for (let t = start; t <= end; t += step) {
          const v = over ? [...Array(Number(over[1]) / 60).keys()].map(i => util(t - i * 60)).find(x => x !== undefined) : util(t);
          if (v !== undefined) values.push([t, v]);
        }
        return values.length ? [{ metric: { instance_id: 'computeinstance-e00mockgone', gpu: '0' }, values }] : [];
      },
      query: async () => [],
    } as unknown as MetricsClient;
    const store = new SampleStore(db);
    const at = (sec: number) => new TelemetryRecorder({ store, client: () => client, projects: () => ['project-e00mocklab'], resources: () => [], maxConcurrency: 1, syncIntervalMinutes: 15, now: () => new Date(sec * 1000) });
    const first = await at(NOW).sync('2026-10-11T08:00:00Z');
    expect(first.capabilities[0].items).toBe(61);
    for (const later of [NOW + 900, NOW + 1800]) {
      const next = await at(later).sync('2026-10-11T08:15:00Z');
      // The re-read five minutes before the newest sample hold nothing new: nothing is counted as written.
      expect(next.capabilities[0].items).toBe(0);
      expect(next.statuses[0].notes).toEqual(['1 GPU series seen in the last 7 days (none live now); 0 new samples written.']);
    }
    // Eight days on, its samples are pruned and it is no longer counted as seen.
    const week = await at(NOW + 8 * 86_400).sync('2026-10-19T08:00:00Z');
    expect(week.statuses[0].notes).toEqual(['0 GPU series seen in the last 7 days (none live now); 0 new samples written.']);
  });

  it('reports Nebius Monitoring as not configured instead of writing nothing silently', async () => {
    const r = new TelemetryRecorder({ store: new SampleStore(db), client: () => undefined, projects: () => [], resources: () => [], maxConcurrency: 1, syncIntervalMinutes: 15 });
    const out = await r.sync('2026-10-11T08:00:00Z');
    expect(out.statuses[0]).toMatchObject({ state: 'not-configured' });
    expect(out.capabilities[0].hint).toMatch(/Needs the Nebius connector/);
  });
});

describe('teardown: GPUs of deleted VMs on the Fleet page (walkthrough 2026-10-11)', () => {
  let db: Knex;
  beforeEach(async () => {
    db = knex({ client: 'better-sqlite3', connection: ':memory:', useNullAsDefault: true });
    await migrate(db);
  });
  afterEach(() => db.destroy());

  const named = { key: 'p|computeinstance-e00vnt|GPU-07', projectId: 'project-e00en1', instanceId: 'computeinstance-e00vnt', node: 'computeinstance-e00vnt', gpu: 'GPU-07', clusterId: 'mk8scluster-e00bzp', nodeGroupId: 'mk8snodegroup-e00rcx' };
  const names = { instanceName: 'mk8snodegroup-e00rcx-7vfm8-qg7rz', nodeGroupName: 'ng-gpu', clusterName: 'nip-sandbox-inference', projectName: 'default-project-eu-north1' };
  const res = (providerId: string, type: string, name: string, extra: object = {}) => ({ uid: `nebius:${providerId}`, providerId, type, name, projectId: 'project-e00en1', labels: {}, status: 'running', refs: [], spec: {}, ...extra }) as any;

  it('keeps the last-known names of a series when a later write has none (the resources are gone)', async () => {
    const store = new SampleStore(db);
    await store.write([{ ...named, ...names }], [{ key: named.key, ts: NOW, util: 0 }], NOW);
    await store.write([named], [{ key: named.key, ts: NOW + 60, util: 0 }], NOW + 60);
    expect((await store.series())[0]).toMatchObject(names);
  });

  it('the recorder stores the names of the VM, node group, cluster and project with each series', async () => {
    const store = new SampleStore(db);
    const client = {
      queryRange: async (_p: string, _e: string, start: number, end: number, step: number) => [{ metric: { instance_id: 'computeinstance-e00vnt', uuid: 'GPU-07', mk8s_cluster_id: 'mk8scluster-e00bzp', mk8s_node_group_id: 'mk8snodegroup-e00rcx' }, values: [[end - (end % step), 1] as [number, number]].filter(([t]) => t >= start) }],
      query: async () => [],
    } as unknown as MetricsClient;
    const resources = [res('project-e00en1', 'project', names.projectName), res('computeinstance-e00vnt', 'compute-instance', names.instanceName), res('mk8snodegroup-e00rcx', 'mk8s-node-group', names.nodeGroupName), res('mk8scluster-e00bzp', 'mk8s-cluster', names.clusterName)];
    const rec = new TelemetryRecorder({ store, client: () => client, projects: () => ['project-e00en1'], resources: () => resources, maxConcurrency: 1, syncIntervalMinutes: 15, now: () => new Date(NOW * 1000) });
    await rec.sync('2026-10-11T08:00:00Z');
    expect((await store.series())[0]).toMatchObject(names);
  });

  it('shows a deleted VM\'s GPU by its last-known names, as "not running now", and "live" only while samples are fresh', async () => {
    const store = new SampleStore(db);
    // Samples up to 19 minutes ago; the VM, node group and cluster are gone from the inventory.
    await store.write([{ ...named, ...names }], Array.from({ length: 60 }, (_, i) => ({ key: named.key, ts: NOW - 19 * 60 - i * 60, util: 0 })), NOW - 19 * 60);
    const snap = { resources: [res('project-e00en1', 'project', 'default-project-eu-north1')], statuses: [] } as any;
    const f = await fleet({ store, snap, inScope: () => true, range: '6h', now: new Date(NOW * 1000), syncIntervalMinutes: 15, monitoringConfigured: true, price: async () => ({ hourly: null }) });
    expect(f.rows[0]).toMatchObject({ ...names, runningNow: false, notRunning: 'VM no longer in the inventory (deleted)', gpuName: 'GPU 0' }); // the VM's only GPU series
    // Its node group and cluster left the inventory too: their last-known names, marked deleted (F1.40).
    expect(f.rollups.nodeGroups[0].name).toBe('ng-gpu (deleted)');
    expect(f.rollups.clusters[0].name).toBe('nip-sandbox-inference (deleted)');
    expect(f.gpus).toEqual({ inRange: 1, runningNow: 0 });
    expect(f.freshness).toMatchObject({ state: 'not-reporting', reason: expect.stringMatching(/No GPU VM runs now in the inventory: nothing has reported for 19 min/) });
  });

  it('a series stored before names were kept: inventory names where the resource exists, else the kind and id, marked deleted apart from the label (F1.40)', async () => {
    const store = new SampleStore(db);
    await store.write([named], Array.from({ length: 10 }, (_, i) => ({ key: named.key, ts: NOW - 19 * 60 - i * 60, util: 0 })), NOW - 19 * 60);
    const gone = { resources: [res('project-e00en1', 'project', 'p')], statuses: [] } as any;
    const f = await fleet({ store, snap: gone, inScope: () => true, range: '6h', now: new Date(NOW * 1000), syncIntervalMinutes: 15, monitoringConfigured: true, price: async () => ({ hourly: null }) });
    expect(f.rows[0]).toMatchObject({
      clusterName: 'Cluster mk8scluster-e00bzp',
      nodeGroupName: 'Node group mk8snodegroup-e00rcx',
      instanceName: 'VM computeinstance-e00vnt',
      deleted: { vm: true, nodeGroup: true, cluster: true },
    });
    expect(f.rollups.clusters[0].name).toBe('Cluster mk8scluster-e00bzp (deleted)');
    expect(f.rollups.nodeGroups[0].name).toBe('Node group mk8snodegroup-e00rcx (deleted)');
    const live = { resources: [res('project-e00en1', 'project', 'p'), res('mk8scluster-e00bzp', 'mk8s-cluster', 'nip-sandbox-inference')], statuses: [] } as any;
    const g = await fleet({ store, snap: live, inScope: () => true, range: '6h', now: new Date(NOW * 1000), syncIntervalMinutes: 15, monitoringConfigured: true, price: async () => ({ hourly: null }) });
    expect(g.rows[0]).toMatchObject({ clusterName: 'nip-sandbox-inference', deleted: { vm: true, nodeGroup: true } });
    expect(g.rows[0].deleted?.cluster).toBeUndefined();
    // Before the first inventory sync nothing is called deleted.
    const none = await fleet({ store, snap: { resources: [], statuses: [] } as any, inScope: () => true, range: '6h', now: new Date(NOW * 1000), syncIntervalMinutes: 15, monitoringConfigured: true, price: async () => ({ hourly: null }) });
    expect(none.rows[0].clusterName).toBe('Cluster mk8scluster-e00bzp');
    expect(none.rows[0].deleted).toBeUndefined();
    // Followup 34: the drawer links a node group only by the uid of one in the inventory; none here, before the sync.
    expect(none.rows[0].nodeGroupUid).toBeUndefined();
    expect(g.rows[0].nodeGroupUid).toBeUndefined();
    const withNg = { resources: [...live.resources, res('mk8snodegroup-e00rcx', 'mk8s-node-group', 'ng-gpu')], statuses: [] } as any;
    const h = await fleet({ store, snap: withNg, inScope: () => true, range: '6h', now: new Date(NOW * 1000), syncIntervalMinutes: 15, monitoringConfigured: true, price: async () => ({ hourly: null }) });
    expect(h.rows[0]).toMatchObject({ nodeGroupName: 'ng-gpu', nodeGroupUid: 'nebius:mk8snodegroup-e00rcx' });
  });

  it('a named VM that left the inventory is marked deleted the same way as one known only by id (F1.40)', async () => {
    const store = new SampleStore(db);
    const standalone = { key: 'p|computeinstance-e00mockvm|0', projectId: 'project-e00en1', instanceId: 'computeinstance-e00mockvm', node: 'computeinstance-e00mockvm', gpu: '0' };
    await store.write([{ ...standalone, instanceName: 'nip-sandbox-gpu-vm' }, named], [...Array.from({ length: 5 }, (_, i) => ({ key: standalone.key, ts: NOW - 30 * 60 - i * 60, util: 0 })), ...Array.from({ length: 5 }, (_, i) => ({ key: named.key, ts: NOW - 30 * 60 - i * 60, util: 0 }))], NOW - 30 * 60);
    const f = await fleet({ store, snap: { resources: [res('project-e00en1', 'project', 'p')], statuses: [] } as any, inScope: () => true, range: '6h', now: new Date(NOW * 1000), syncIntervalMinutes: 15, monitoringConfigured: true, price: async () => ({ hourly: null }) });
    const byVm = new Map(f.rows.map(r => [r.instanceId, r]));
    expect(byVm.get('computeinstance-e00mockvm')).toMatchObject({ instanceName: 'nip-sandbox-gpu-vm', deleted: { vm: true }, runningNow: false });
    expect(byVm.get('computeinstance-e00vnt')).toMatchObject({ instanceName: 'VM computeinstance-e00vnt', deleted: { vm: true }, runningNow: false });
    expect(f.rows.every(r => !/^Deleted /.test(r.instanceName ?? ''))).toBe(true);
    expect(f.rollups.nodeGroups.find(n => n.kind === 'standalone')!.name).toBe('nip-sandbox-gpu-vm (standalone VM, deleted)');
  });

  it('two runs of one VM name, both deleted, are told apart by their last sample (W1F.N4)', async () => {
    const store = new SampleStore(db);
    const run = (id: string) => ({ key: `p|${id}|0`, projectId: 'project-e00en1', instanceId: id, instanceName: 'nip-sandbox-gpu-vm', node: id, gpu: '0' });
    const a = run('computeinstance-e00mockrun1');
    const b = run('computeinstance-e00mockrun2');
    await store.write([a, b], [...Array.from({ length: 3 }, (_, i) => ({ key: a.key, ts: NOW - 4 * 3600 - i * 60, util: 0 })), ...Array.from({ length: 3 }, (_, i) => ({ key: b.key, ts: NOW - 30 * 60 - i * 60, util: 0 }))], NOW - 30 * 60);
    const f = await fleet({ store, snap: { resources: [res('project-e00en1', 'project', 'p')], statuses: [] } as any, inScope: () => true, range: '6h', now: new Date(NOW * 1000), syncIntervalMinutes: 15, monitoringConfigured: true, price: async () => ({ hourly: null }) });
    const runs = f.rollups.nodeGroups.filter(n => n.kind === 'standalone').map(n => n.name);
    expect(runs).toHaveLength(2);
    expect(new Set(runs).size).toBe(2);
    for (const n of runs) expect(n).toMatch(/^nip-sandbox-gpu-vm \(standalone VM, deleted\) · last sample \d\d-\d\d \d\d:\d\d UTC$/);
  });

  it('a running VM with a sample within one sync interval is "live" and running now', async () => {
    const store = new SampleStore(db);
    await store.write([{ ...named, ...names }], [{ key: named.key, ts: NOW - 120, util: 40 }], NOW - 120);
    const snap = { resources: [res('project-e00en1', 'project', 'p'), res('computeinstance-e00vnt', 'compute-instance', 'vm-now', { spec: { gpus: 1 } })], statuses: [] } as any;
    const f = await fleet({ store, snap, inScope: () => true, range: '1h', now: new Date(NOW * 1000), syncIntervalMinutes: 15, monitoringConfigured: true, price: async () => ({ hourly: null }) });
    expect(f.rows[0]).toMatchObject({ instanceName: 'vm-now', runningNow: true });
    expect(f.gpus).toEqual({ inRange: 1, runningNow: 1 });
    expect(f.freshness.state).toBe('live');
  });

  describe('why no GPU reports: the inventory first, then Monitoring (F1.35)', () => {
    const vmSeries = { key: 'p|computeinstance-e00mockgpuvm|0', projectId: 'project-e00mocka', instanceId: 'computeinstance-e00mockgpuvm', node: 'computeinstance-e00mockgpuvm', gpu: '0' };
    // The last sample 627 min ago; the Monitoring history connector failed in the last syncs.
    const stale = async (vms: object[]) => {
      const store = new SampleStore(db);
      await store.write([vmSeries], Array.from({ length: 5 }, (_, i) => ({ key: vmSeries.key, ts: NOW - 627 * 60 - i * 60, util: 0 })), NOW - 627 * 60);
      const snap = { resources: [{ ...res('project-e00mocka', 'project', 'lab'), projectId: 'project-e00mocka' }, ...vms], statuses: [{ id: 'nebius-metrics-history', state: 'error' }] } as any;
      return fleet({ store, snap, inScope: () => true, range: '24h', now: new Date(NOW * 1000), syncIntervalMinutes: 15, monitoringConfigured: true, price: async () => ({ hourly: null }) });
    };

    it('no GPU VM runs in the inventory: says so, never blames Monitoring for the missing samples', async () => {
      const f = await stale([{ ...res('computeinstance-e00mockgpuvm', 'compute-instance', 'gpu-vm', { status: 'stopped', spec: { gpus: 1 } }), projectId: 'project-e00mocka' }]);
      expect(f.freshness.state).toBe('not-reporting');
      expect(f.freshness.reason).toMatch(/^No GPU VM runs now in the inventory: nothing has reported for 627 min/);
      expect(f.freshness.reason).not.toMatch(/No new sample/);
    });

    it('a GPU VM runs in the inventory but no sample arrives: then Monitoring is the cause', async () => {
      const f = await stale([{ ...res('computeinstance-e00mockgpuvm', 'compute-instance', 'gpu-vm', { status: 'running', spec: { gpus: 1 } }), projectId: 'project-e00mocka' }]);
      expect(f.freshness).toMatchObject({ state: 'stale', reason: expect.stringMatching(/while 1 GPU VM runs in the inventory: the last syncs could not read Nebius Monitoring/) });
    });
  });

  describe('the global filter keeps finished runs (G2.1)', () => {
    // Two finished runs: a sandbox inference node in eu-north1 (labels stored when written) and a lab VM in uk-south1.
    // Both VMs are deleted; only the projects remain in the inventory.
    const sb = { key: 'p|computeinstance-e00mocksbx|0', projectId: 'project-e00mocksandbox', instanceId: 'computeinstance-e00mocksbx', node: 'computeinstance-e00mocksbx', gpu: '0', instanceName: 'sbx-node', region: 'eu-north1', stage: 'sandbox' };
    const lab = { key: 'p|computeinstance-e00mocklabvm|0', projectId: 'project-e00mocklab', instanceId: 'computeinstance-e00mocklabvm', node: 'computeinstance-e00mocklabvm', gpu: '0', instanceName: 'lab-vm', region: 'uk-south1', stage: 'lab' };
    const projects = [
      { ...res('project-e00mocksandbox', 'project', 'nip-sandbox'), projectId: 'project-e00mocksandbox', region: 'eu-north1' },
      { ...res('project-e00mocklab', 'project', 'nip-lab'), projectId: 'project-e00mocklab', region: 'uk-south1' },
    ];
    const write = async (store: SampleStore, xs: object[]) =>
      store.write(xs as any, [...Array.from({ length: 5 }, (_, i) => ({ key: sb.key, ts: NOW - 3 * 3600 - i * 60, util: 0 })), ...Array.from({ length: 5 }, (_, i) => ({ key: lab.key, ts: NOW - 60 * 60 - i * 60, util: 0 }))], NOW - 60 * 60);
    const run = (store: SampleStore, filter: { region?: string; stage?: string }, snapResources: object[] = projects) =>
      fleet({ store, snap: { resources: snapResources, statuses: [] } as any, inScope: () => true, filter, range: '24h', now: new Date(NOW * 1000), syncIntervalMinutes: 15, monitoringConfigured: true, price: async () => ({ hourly: null }) });

    it('a deleted VM\'s series stays visible under the region and stage it ran in, by the labels stored with it', async () => {
      const store = new SampleStore(db);
      await write(store, [sb, lab]);
      expect((await run(store, {})).rows).toHaveLength(2);
      expect((await run(store, { region: 'eu-north1' })).rows.map(r => r.instanceName)).toEqual(['sbx-node']);
      expect((await run(store, { stage: 'sandbox' })).rows.map(r => r.instanceName)).toEqual(['sbx-node']);
      expect((await run(store, { region: 'eu-north1', stage: 'sandbox' })).rows.map(r => r.instanceName)).toEqual(['sbx-node']);
      expect((await run(store, { region: 'eu-north1', stage: 'lab' })).rows).toHaveLength(0);
      expect((await run(store, { region: 'uk-south1' })).rows.map(r => r.instanceName)).toEqual(['lab-vm']);
    });

    it('freshness follows the filtered series, not the newest sample of the whole store', async () => {
      const store = new SampleStore(db);
      await write(store, [sb, lab]);
      const f = await run(store, { region: 'eu-north1' });
      // The lab VM sampled 60 min ago; the sandbox node 180 min ago.
      expect(f.freshness.lastSampleAt).toBe(new Date((NOW - 3 * 3600) * 1000).toISOString());
      expect(f.freshness.reason).toMatch(/180 min/);
      const none = await run(store, { region: 'eu-west1' });
      expect(none.rows).toHaveLength(0);
      expect(none.freshness.lastSampleAt).toBeUndefined();
      expect(none.freshness.reason).toMatch(/No GPU sample is stored for region=eu-west1/);
    });

    it('a series stored before region and stage were kept: the project\'s region, and the stage its project\'s resources carry', async () => {
      const store = new SampleStore(db);
      const legacy = (x: typeof sb) => ({ key: x.key, projectId: x.projectId, instanceId: x.instanceId, node: x.node, gpu: x.gpu, instanceName: x.instanceName });
      await write(store, [legacy(sb), legacy(lab)]);
      const sandboxNet = { ...res('vpcnetwork-e00mocksbx', 'vpc-network', 'net'), projectId: 'project-e00mocksandbox', region: 'eu-north1', labels: { 'nip-stage': 'sandbox' } };
      expect((await run(store, { region: 'eu-north1' })).rows.map(r => r.instanceName)).toEqual(['sbx-node']);
      expect((await run(store, { stage: 'sandbox' }, [...projects, sandboxNet])).rows.map(r => r.instanceName)).toEqual(['sbx-node']);
    });

    it('the recorder stores the VM\'s region and its stage (own nip-stage label or its cluster\'s) with each series', async () => {
      const store = new SampleStore(db);
      const client = {
        queryRange: async (_p: string, _e: string, start: number, end: number, step: number) => [{ metric: { instance_id: 'computeinstance-e00vnt', uuid: 'GPU-07', mk8s_cluster_id: 'mk8scluster-e00bzp', mk8s_node_group_id: 'mk8snodegroup-e00rcx' }, values: [[end - (end % step), 1] as [number, number]].filter(([t]) => t >= start) }],
        query: async () => [],
      } as unknown as MetricsClient;
      const resources = [
        { ...res('project-e00en1', 'project', 'p'), region: 'eu-north1' },
        { ...res('computeinstance-e00vnt', 'compute-instance', 'node', { labels: { 'mk8s-cluster-id': 'mk8scluster-e00bzp' } }), region: 'eu-north1' },
        { ...res('mk8scluster-e00bzp', 'mk8s-cluster', 'nip-sandbox-inference', { labels: { 'nip-stage': 'sandbox' } }), region: 'eu-north1' },
      ];
      const rec = new TelemetryRecorder({ store, client: () => client, projects: () => ['project-e00en1'], resources: () => resources, maxConcurrency: 1, syncIntervalMinutes: 15, now: () => new Date(NOW * 1000) });
      await rec.sync('2026-10-11T08:00:00Z');
      expect((await store.series())[0]).toMatchObject({ region: 'eu-north1', stage: 'sandbox' });
      // A later write after the VM is gone keeps them.
      const gone = new TelemetryRecorder({ store, client: () => client, projects: () => ['project-e00en1'], resources: () => [], maxConcurrency: 1, syncIntervalMinutes: 15, now: () => new Date((NOW + 60) * 1000) });
      await gone.sync('2026-10-11T08:01:00Z');
      expect((await store.series())[0]).toMatchObject({ region: 'eu-north1', stage: 'sandbox' });
    });
  });
});

describe('idle-cost pricing cache (G2.9)', () => {
  const vm = (id: string, status: string) => ({ providerId: id, projectId: 'project-e00mocksandbox', status, spec: { platform: 'gpu-l40s-a', preset: '1gpu-8vcpu-32gb', capacityType: 'preemptible' } }) as any;

  it('a preempted VM priced first never leaves the running VM of its shape unpriced', async () => {
    let calls = 0;
    const price = cachedPricer(async () => {
      calls++;
      return { hourly: { amount: '0.80', currency: 'XTS' } };
    });
    expect((await price(vm('computeinstance-e00mockold', 'stopped'))).reason).toMatch(/not running now/);
    expect((await price(vm('computeinstance-e00mocknew', 'running'))).hourly).toEqual({ amount: '0.80', currency: 'XTS' });
    expect((await price(vm('computeinstance-e00mocknew2', 'running'))).hourly).toEqual({ amount: '0.80', currency: 'XTS' });
    expect(calls).toBe(1);
  });
});

// Followup 53: "none in scope" and status-only service cards showed no as-of time though the inventory was current.
// Every card now carries the last success of the inventory lists it is built from.
describe('Fleet service cards: each carries its lists\' read time', () => {
  let db: Knex;
  beforeEach(async () => {
    db = knex({ client: 'better-sqlite3', connection: ':memory:', useNullAsDefault: true });
    await migrate(db);
  });
  afterEach(() => db.destroy());

  const cap = (id: string, lastSuccess: string) => ({ id, title: id, state: 'ok', lastSuccess });
  const capabilities = [
    cap('storage.buckets', '2026-10-11T07:58:00Z'),
    cap('compute.disks', '2026-10-11T07:58:10Z'),
    cap('compute.filesystems', '2026-10-11T07:44:00Z'),
    cap('msp.postgresql', '2026-10-11T07:58:20Z'),
    cap('msp.mlflow', '2026-10-11T07:58:30Z'),
  ];

  it('none in scope and status-only cards say as of when; volumes take the older of disks and filesystems', async () => {
    const store = new SampleStore(db);
    const pg = { uid: 'nebius:postgresql-e00mock', providerId: 'postgresql-e00mock', type: 'postgresql-cluster', name: 'pg', projectId: 'project-e00mocka', labels: {}, status: 'running', refs: [], spec: {} };
    const snap = { resources: [pg], statuses: [], capabilities, observedAt: '2026-10-11T07:59:59Z' } as any;
    const f = await fleet({ store, snap, inScope: () => true, range: '6h', now: new Date(NOW * 1000), syncIntervalMinutes: 15, monitoringConfigured: true, price: async () => ({ hourly: null }) });
    const by = Object.fromEntries(f.services.map(s => [s.id, s]));
    expect(by['object-storage']).toMatchObject({ state: 'none-in-scope', observedAt: '2026-10-11T07:58:00Z' });
    expect(by.volumes).toMatchObject({ state: 'none-in-scope', observedAt: '2026-10-11T07:44:00Z' });
    expect(by.postgresql).toMatchObject({ state: 'no-metrics', observedAt: '2026-10-11T07:58:20Z' });
    expect(by.mlflow).toMatchObject({ state: 'none-in-scope', observedAt: '2026-10-11T07:58:30Z' });
  });
});
