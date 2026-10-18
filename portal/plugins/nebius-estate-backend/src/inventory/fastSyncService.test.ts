import { mockServices } from '@backstage/backend-test-utils';
import { ConfigReader } from '@backstage/config';
import knexFactory from 'knex';
import { resolve } from 'path';
import { migrate } from '../database';
import { HealthStore } from '../health/HealthStore';
import { readEstateConfig } from '../lib/config';
import { HostLimiter } from '../lib/http';
import { KUBE_TEST_ENDPOINT, TEST_DATA, testConfig } from '../__testUtils__/testing';
import { kubeStaleReason } from '../views';
import { NEBIUS_API, NEBIUS_LOGGING, NEBIUS_MONITORING } from './endpoints';
import { InventoryService } from './InventoryService';

/**
 * The fast re-sync end to end on the backend: the e2e stub's fixtures (the same REST shapes the Playwright suite
 * serves) move a cluster PROVISIONING → RUNNING → DELETING → gone across syncs, driven by the scheduler's own timer.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const stub: { handle: (m: string, u: string, h: Record<string, string>, b?: unknown) => { status: number; body?: unknown; raw?: Buffer; contentType?: string }; estate: any } = require(resolve(TEST_DATA, 'stubApi.js'));

const SOP = 'mk8scluster-e00mocksop';
const CLUSTERS = '/mk8s/v1/clusters';
const GROUPS = '/mk8s/v1/node-groups';
const original = JSON.stringify({ lists: stub.estate.lists, kube: stub.estate.kube });

describe('lifecycle-aware fast re-sync (InventoryService)', () => {
  let calls: string[];
  let hold: { path: string; release?: () => void; waiting?: Promise<void> } | undefined;
  let spy: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers({
      now: new Date('2026-10-11T12:30:00Z'),
      // Only the scheduler's timers and the clock are fake; I/O and the limiter's clock run normally.
      doNotFake: ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval'],
    });
    calls = [];
    hold = undefined;
    const o = JSON.parse(original);
    stub.estate.lists = o.lists;
    stub.estate.kube = o.kube;
    // Start from one changing cluster only: the legacy cluster being torn down is already gone.
    stub.estate.lists[CLUSTERS]['project-e00mocklegacy'] = [];
    delete stub.estate.lists[GROUPS]['mk8scluster-e00mockgone'];
    spy = jest.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (![NEBIUS_API, NEBIUS_MONITORING, NEBIUS_LOGGING, KUBE_TEST_ENDPOINT].includes(url.origin)) throw new Error(`unexpected outbound call to ${url.origin}`);
      calls.push(url.pathname);
      if (hold && url.pathname === hold.path) await hold.waiting;
      const r = stub.handle(init?.method ?? 'GET', url.pathname + url.search, Object.fromEntries(new Headers(init?.headers).entries()), init?.body ? JSON.parse(String(init.body)) : undefined);
      if (r.raw) return new Response(r.raw, { status: r.status, headers: { 'content-type': r.contentType ?? 'application/octet-stream' } });
      return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
    });
  });
  afterEach(() => {
    spy.mockRestore();
    jest.useRealTimers();
    const o = JSON.parse(original);
    stub.estate.lists = o.lists;
    stub.estate.kube = o.kube;
  });

  async function service(nebius: Record<string, unknown> = {}) {
    const base = (testConfig() as any).nebiusEstate.nebius;
    const cfg = readEstateConfig(new ConfigReader(testConfig({ nebius: { ...base, ...nebius } }) as any));
    const svc = new InventoryService(cfg, mockServices.logger.mock());
    const db = knexFactory({ client: 'better-sqlite3', connection: ':memory:', useNullAsDefault: true });
    await migrate(db);
    svc.useHealthStore(new HealthStore(db));
    // Normal cadence: the scheduled task's next run at 12:45 (it is not run in these tests).
    svc.setSchedule(15 * 60_000, 15 * 60_000);
    await svc.start();
    await svc.ready();
    return { svc, db };
  }
  /** Lets the timer fire, then waits for the sync it started (if any) to finish. */
  async function advance(ms: number, svc: InventoryService) {
    await jest.advanceTimersByTimeAsync(ms);
    while ((svc as any).running) await new Promise(r => setImmediate(r));
  }
  const status = (svc: InventoryService, id: string) => svc.snapshot().statuses.find(s => s.id === id);
  const cluster = (project: string, id: string) => stub.estate.lists[CLUSTERS][project].find((c: any) => c.metadata.id === id);

  it('PROVISIONING → RUNNING connects on the fast sync; DELETING shows after one fast sync; gone → retired, and fast re-syncs stop', async () => {
    const { svc, db } = await service();
    try {
      expect(status(svc, `mk8s:${SOP}`)).toMatchObject({ state: 'waiting', notes: ['Cluster is PROVISIONING; it is connected automatically once RUNNING.'] });
      const inv = () => status(svc, 'nebius-inventory')!;
      // "Next run in 2 min (a cluster is provisioning)": the inventory and the discovered clusters' connectors.
      expect(inv().health).toMatchObject({ nextRunAt: '2026-10-11T12:32:00.000Z', nextRunReason: 'a cluster is provisioning' });
      expect(status(svc, `mk8s:${SOP}`)!.health).toMatchObject({ nextRunReason: 'a cluster is provisioning' });
      // Connectors a fast re-sync does not run keep the normal cadence.
      expect(status(svc, 'nebius-monitoring')!.health).toMatchObject({ nextRunAt: '2026-10-11T12:45:00.000Z' });
      expect(status(svc, 'nebius-monitoring')!.health!.nextRunReason).toBeUndefined();

      // 12:39 RUNNING; a node group is still provisioning (the fast cadence goes on).
      cluster('project-e00mocklab', SOP).status.state = 'RUNNING';
      stub.estate.lists[GROUPS][SOP][0].status.state = 'PROVISIONING';
      stub.estate.kube[SOP] = stub.estate.kube['mk8scluster-e00mockinf'];
      calls = [];
      await advance(119_000, svc);
      expect(calls).toEqual([]);
      await advance(1_000, svc);
      // Connected on that fast sync.
      expect(status(svc, `mk8s:${SOP}`)).toMatchObject({ state: 'ok' });
      expect(svc.snapshot().kube.find(k => k.mk8sClusterId === SOP)).toMatchObject({ observedAt: '2026-10-11T12:32:00.000Z' });
      expect(svc.snapshot().kube.find(k => k.mk8sClusterId === SOP)!.stale).toBeFalsy();
      // Core tier only: the changing lists (VMs, clusters, node groups) and the clusters' Kubernetes APIs.
      const apiPaths = [...new Set(calls.filter(p => !p.startsWith('/k8s/')))].sort();
      expect(apiPaths.filter(p => !p.startsWith('/iam/v2/projects/'))).toEqual(['/compute/v1/instances', CLUSTERS, GROUPS]);
      expect(calls.some(p => p.startsWith(`/k8s/${SOP}/`))).toBe(true);
      expect(inv().health).toMatchObject({ nextRunReason: 'a node group is provisioning' });
      // The stub refuses some slow-tier lists: their last errors still stand (as their data does).
      expect(inv()).toMatchObject({ state: 'permission-denied', lastSuccess: '2026-10-11T12:32:00.000Z' });

      // Teardown starts: shown as being deleted after one fast sync, not after the next 15-minute run.
      cluster('project-e00mocklab', SOP).status.state = 'DELETING';
      await advance(120_000, svc);
      const kube = svc.snapshot().kube.find(k => k.mk8sClusterId === SOP)!;
      expect(kubeStaleReason(kube, svc.snapshot().resources)).toBe('Cluster is being deleted (inventory 12:34 UTC)');
      expect(status(svc, `mk8s:${SOP}`)).toMatchObject({ state: 'waiting', notes: ['Cluster is DELETING; not connected.'] });
      expect(inv().health).toMatchObject({ nextRunReason: 'a cluster is being deleted and a node group is provisioning' });

      // Gone between two fast syncs: retired at once; nothing changes any more → the fast cadence stops.
      stub.estate.lists[CLUSTERS]['project-e00mocklab'] = stub.estate.lists[CLUSTERS]['project-e00mocklab'].filter((c: any) => c.metadata.id !== SOP);
      delete stub.estate.lists[GROUPS][SOP];
      await advance(120_000, svc);
      expect(status(svc, `mk8s:${SOP}`)).toMatchObject({ state: 'disabled', notes: [expect.stringMatching(/^Retired: cluster nip-sandbox-soperator no longer exists/)] });
      expect(inv().health!.nextRunReason).toBeUndefined();
      expect(inv().health!.nextRunAt).toBe('2026-10-11T12:45:00.000Z');
      calls = [];
      await advance(30 * 60_000, svc);
      expect(calls).toEqual([]);
    } finally {
      await svc.stop();
      await db.destroy();
    }
  }, 60_000);

  it('caps fast re-syncs at fastSyncMax in a row, then says so on the inventory connector and keeps the normal cadence', async () => {
    const { svc, db } = await service({ fastSyncMax: 2 });
    try {
      for (let i = 0; i < 2; i++) await advance(120_000, svc);
      expect(calls.filter(p => p === CLUSTERS)).toHaveLength(4 * 3); // 4 projects × (start-up + 2 fast)
      const inv = status(svc, 'nebius-inventory')!;
      expect(inv.health!.nextRunReason).toBeUndefined();
      expect(inv.notes).toEqual(['Fast re-sync paused after 2 syncs in a row while a cluster is provisioning; back to the normal cadence (every 15 min) until nothing is changing state.']);
      calls = [];
      await advance(30 * 60_000, svc);
      expect(calls).toEqual([]);
    } finally {
      await svc.stop();
      await db.destroy();
    }
  }, 60_000);

  it('respects the single-sync lock and the "Sync now" cooldown: a fast sync due during a running sync joins it', async () => {
    const { svc, db } = await service();
    try {
      // 12:31:40 a manual sync starts; one of its lists answers slowly.
      await advance(100_000, svc);
      let release!: () => void;
      hold = { path: '/compute/v1/disks', waiting: new Promise<void>(r => (release = r)) };
      calls = [];
      const manual = svc.syncAll('nebius-inventory');
      // 12:32 the fast sync is due, but a sync started 20 s ago: deferred to the end of the cooldown (12:32:40).
      await jest.advanceTimersByTimeAsync(20_000);
      expect(status(svc, 'nebius-inventory')!.health!.nextRunAt).toBe('2026-10-11T12:32:40.000Z');
      // 12:32:40 it fires while the manual sync still runs: it joins that sync instead of a second wave.
      await jest.advanceTimersByTimeAsync(40_000);
      expect(calls.filter(p => p === CLUSTERS)).toHaveLength(4);
      release();
      await manual;
      expect(calls.filter(p => p === CLUSTERS)).toHaveLength(4);
      // The finished sync re-arms the fast re-sync from its own end.
      expect(status(svc, 'nebius-inventory')!.health).toMatchObject({ nextRunAt: '2026-10-11T12:34:40.000Z', nextRunReason: expect.stringMatching(/^a cluster is provisioning/) });
    } finally {
      await svc.stop();
      await db.destroy();
    }
  }, 60_000);

  it('shares the per-host rate limiters with every other sync (no limiter of its own)', async () => {
    const run = jest.spyOn(HostLimiter.prototype, 'run');
    const { svc, db } = await service();
    try {
      const before = new Set(run.mock.contexts);
      const limiters = (svc as any).limiters.size;
      run.mockClear();
      await advance(120_000, svc);
      expect(run.mock.contexts.length).toBeGreaterThan(0);
      expect(run.mock.contexts.every(c => before.has(c))).toBe(true);
      expect((svc as any).limiters.size).toBe(limiters);
    } finally {
      run.mockRestore();
      await svc.stop();
      await db.destroy();
    }
  }, 60_000);
});
