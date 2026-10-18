import { ObservedResource } from '@internal/nebius-domain';
import { FAST_SYNC_LISTS, FastSync, transitionalReason, transitionalResources } from './fastSync';
import { CATALOG } from './nebius-catalog';

const res = (type: ObservedResource['type'], name: string, apiState?: string): ObservedResource => ({
  uid: `nebius:${name}`, providerId: name, type, name, labels: {}, status: 'unknown', apiState, refs: [], spec: {},
  source: { connector: 'nebius-inventory', kind: 'nebius-api' }, observedAt: '2026-10-11T12:00:00Z', coverageNotes: [],
});

describe('transitional resources (what keeps the fast re-sync going)', () => {
  it('counts MK8s clusters and node groups PROVISIONING / DELETING / UPDATING and VMs CREATING / STARTING / STOPPING / DELETING / UPDATING', () => {
    const resources = [
      res('mk8s-cluster', 'c-prov', 'PROVISIONING'),
      res('mk8s-cluster', 'c-run', 'RUNNING'),
      res('mk8s-node-group', 'ng-del', 'DELETING'),
      res('compute-instance', 'vm-stopping', 'STOPPING'),
      res('compute-instance', 'vm-stopped', 'STOPPED'),
      res('compute-instance', 'vm-starting', 'STARTING'),
      // Not part of the fast tier: a disk being created waits for the normal cadence.
      res('compute-disk', 'disk-creating', 'CREATING'),
      res('compute-instance', 'vm-unknown'),
    ];
    expect(transitionalResources(resources).map(t => `${t.name}:${t.state}`)).toEqual(['c-prov:PROVISIONING', 'ng-del:DELETING', 'vm-starting:STARTING', 'vm-stopping:STOPPING']);
  });

  it('reads only Nebius inventory items (a Kubernetes-side object is not a Nebius lifecycle)', () => {
    const k = { ...res('mk8s-cluster', 'k', 'PROVISIONING'), source: { connector: 'kubernetes:x', kind: 'kubernetes-api' as const } };
    expect(transitionalResources([k])).toEqual([]);
  });

  it('says what is changing in plain words', () => {
    expect(transitionalReason(transitionalResources([res('mk8s-cluster', 'a', 'PROVISIONING')]))).toBe('a cluster is provisioning');
    expect(transitionalReason(transitionalResources([res('mk8s-cluster', 'a', 'DELETING')]))).toBe('a cluster is being deleted');
    expect(transitionalReason(transitionalResources([res('compute-instance', 'a', 'STARTING'), res('compute-instance', 'b', 'STARTING')]))).toBe('2 VMs are starting');
    expect(transitionalReason(transitionalResources([res('compute-instance', 'v', 'STOPPING'), res('mk8s-node-group', 'n', 'PROVISIONING'), res('mk8s-cluster', 'a', 'DELETING')]))).toBe(
      'a cluster is being deleted, a node group is provisioning and 1 more',
    );
    expect(transitionalReason([])).toBeUndefined();
  });

  it('the fast tier is the lists whose state is changing: VMs, clusters, node groups; every other catalog list is skipped', () => {
    expect([...FAST_SYNC_LISTS].sort()).toEqual(['compute.instances', 'mk8s.clusters', 'mk8s.node-groups']);
    for (const id of FAST_SYNC_LISTS) expect(CATALOG.find(d => d.id === id)?.tier).toBe('core');
  });
});

describe('FastSync scheduler', () => {
  beforeEach(() => jest.useFakeTimers({ now: new Date('2026-10-11T12:39:00Z') }));
  afterEach(() => jest.useRealTimers());

  const provisioning = [{ uid: 'nebius:c', type: 'mk8s-cluster' as const, name: 'c', state: 'PROVISIONING' }];

  function make(over: Partial<ConstructorParameters<typeof FastSync>[0]> = {}) {
    const runs: number[] = [];
    let last: number | undefined;
    const fs: FastSync = new FastSync({
      intervalMs: 120_000, max: 3, cooldownMs: 60_000,
      run: async () => {
        runs.push(Date.now());
        last = Date.now();
      },
      lastAttemptAt: () => last,
      ...over,
    });
    return { fs, runs, setLast: (t: number) => (last = t) };
  }

  it('transitional → a fast sync after the short interval; settled → nothing scheduled (normal cadence)', async () => {
    const { fs, runs } = make();
    fs.settle(provisioning, false);
    expect(fs.status()).toEqual({ dueAt: '2026-10-11T12:41:00.000Z', reason: 'a cluster is provisioning', streak: 0 });
    await jest.advanceTimersByTimeAsync(119_000);
    expect(runs).toHaveLength(0);
    await jest.advanceTimersByTimeAsync(1_000);
    expect(runs).toEqual([Date.parse('2026-10-11T12:41:00Z')]);
    // The run's own sync settles the scheduler: nothing transitional any more → stop at once.
    fs.settle([], true);
    expect(fs.status()).toEqual({ streak: 0 });
    await jest.advanceTimersByTimeAsync(3_600_000);
    expect(runs).toHaveLength(1);
  });

  it('caps fast re-syncs at N in a row, then falls back to the normal cadence and says so; settling resets the count', async () => {
    const { fs, runs } = make();
    fs.settle(provisioning, false);
    for (let i = 1; i <= 3; i++) {
      await jest.advanceTimersByTimeAsync(120_000);
      expect(runs).toHaveLength(i);
      fs.settle(provisioning, true);
    }
    expect(fs.status()).toEqual({ capped: { after: 3, reason: 'a cluster is provisioning' }, streak: 3 });
    await jest.advanceTimersByTimeAsync(3_600_000);
    expect(runs).toHaveLength(3);
    // A scheduled (normal) sync that still sees it changing does not restart the fast cadence.
    fs.settle(provisioning, false);
    expect(fs.status().capped).toBeDefined();
    // Settled: the count resets; the next change gets fast re-syncs again.
    fs.settle([], false);
    fs.settle(provisioning, false);
    expect(fs.status()).toEqual({ dueAt: expect.any(String), reason: 'a cluster is provisioning', streak: 0 });
    await jest.advanceTimersByTimeAsync(120_000);
    expect(runs).toHaveLength(4);
  });

  it('respects the sync-now cooldown: a sync that started less than a minute ago defers the fast one', async () => {
    const { fs, runs, setLast } = make();
    fs.settle(provisioning, false);
    // "Sync now" of another connector 100 s later (it does not re-settle the inventory's schedule).
    await jest.advanceTimersByTimeAsync(100_000);
    setLast(Date.now());
    await jest.advanceTimersByTimeAsync(20_000);
    expect(runs).toHaveLength(0);
    expect(fs.status().dueAt).toBe(new Date(Date.now() + 40_000).toISOString());
    await jest.advanceTimersByTimeAsync(40_000);
    expect(runs).toHaveLength(1);
  });

  it('a newer sync re-arms the timer from its own end (one pending fast sync at most)', async () => {
    const { fs, runs } = make();
    fs.settle(provisioning, false);
    await jest.advanceTimersByTimeAsync(90_000);
    fs.settle(provisioning, false); // e.g. the scheduled run finished
    await jest.advanceTimersByTimeAsync(90_000);
    expect(runs).toHaveLength(0);
    await jest.advanceTimersByTimeAsync(30_000);
    expect(runs).toHaveLength(1);
  });

  it('is off when the interval is 0, and stop() cancels a pending fast sync', async () => {
    const off = make({ intervalMs: 0 });
    off.fs.settle(provisioning, false);
    expect(off.fs.status()).toEqual({ streak: 0 });
    const on = make();
    on.fs.settle(provisioning, false);
    on.fs.stop();
    await jest.advanceTimersByTimeAsync(600_000);
    expect(on.runs).toHaveLength(0);
    on.fs.settle(provisioning, false);
    expect(on.fs.status().dueAt).toBeUndefined();
  });

  it('re-arms when the run joined a sync that did not read the inventory (nothing settled)', async () => {
    const { fs, runs } = make();
    fs.settle(provisioning, false);
    await jest.advanceTimersByTimeAsync(120_000);
    expect(runs).toHaveLength(1);
    // Cooldown: the run itself is the last attempt, so the retry waits the full interval.
    await jest.advanceTimersByTimeAsync(120_000);
    expect(runs).toHaveLength(2);
  });

  it('a failed fast run is logged, not thrown', async () => {
    const warn = jest.fn();
    const { fs } = make({ run: async () => Promise.reject(new Error('boom')), logger: { warn } });
    fs.settle(provisioning, false);
    await jest.advanceTimersByTimeAsync(120_000);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/fast re-sync failed: boom/));
  });
});
