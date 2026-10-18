import knex, { Knex } from 'knex';
import { aggregateHistory, ObservedResource, summarizeDay } from '@internal/nebius-domain';
import { migrate } from '../database';
import { HistoryStore } from './HistoryStore';
import { SampleStore } from '../telemetry/SampleStore';
import { backfillHistory } from './backfill';

const vm = (status: ObservedResource['status']): ObservedResource => ({
  uid: 'nebius:computeinstance-e00mockrun', providerId: 'computeinstance-e00mockrun', type: 'compute-instance', name: 'nip-sandbox-gpu-vm', projectId: 'project-e00mocksandbox', region: 'eu-north1',
  labels: { 'nip-stage': 'sandbox' }, status, refs: [], spec: { gpus: 1, vcpus: 8 }, source: { connector: 'nebius-inventory', kind: 'nebius-api' }, observedAt: '2026-10-11T14:00:00Z', coverageNotes: [],
});
const disk: ObservedResource = { ...vm('running'), uid: 'nebius:computedisk-e00mock', providerId: 'computedisk-e00mock', type: 'compute-disk', spec: {} };

describe('daily history across the syncs of one day (G2.5)', () => {
  let db: Knex;
  beforeEach(async () => {
    db = knex({ client: 'better-sqlite3', connection: ':memory:', useNullAsDefault: true });
    await migrate(db);
  });
  afterEach(() => db.destroy());

  it('a GPU run torn down before the day\'s last sync still shows that day', async () => {
    const store = new HistoryStore(db);
    await store.mergeDays(summarizeDay([vm('running'), disk], new Date('2026-10-11T14:00:00Z'), { samples: [{ instanceId: 'computeinstance-e00mockrun', gpuUtilPercent: 70 }] }));
    await store.mergeDays(summarizeDay([disk], new Date('2026-10-11T18:30:00Z')));
    const [day] = aggregateHistory(await store.since('2026-10-11'));
    expect(day).toMatchObject({ day: '2026-10-11', gpus: 1, vcpus: 8, runningInstances: 1, resources: 1, gpuUtilMean: 70 });
    // The next day starts afresh.
    await store.mergeDays(summarizeDay([disk], new Date('2026-10-12T00:10:00Z')));
    expect(aggregateHistory(await store.since('2026-10-12'))[0]).toMatchObject({ gpus: 0, gpuUtilMean: null });
  });
});

describe('a day recorded before the per-day peak is backfilled once from the GPU sample store (#33)', () => {
  let db: Knex;
  beforeEach(async () => {
    db = knex({ client: 'better-sqlite3', connection: ':memory:', useNullAsDefault: true });
    await migrate(db);
  });
  afterEach(() => db.destroy());

  it('raises the 0-GPU day the hourly roll-ups contradict, marks it incomplete, and leaves other days alone', async () => {
    const history = new HistoryStore(db);
    const samples = new SampleStore(db);
    // Pre-G2.5 code kept only the last sync of 10-11: the run was torn down, so the day read 0 GPUs.
    await history.replaceDays(summarizeDay([disk], new Date('2026-10-11T18:30:00Z')));
    await history.replaceDays(summarizeDay([vm('running'), disk], new Date('2026-10-12T10:00:00Z'), { samples: [{ instanceId: 'computeinstance-e00mockrun', gpuUtilPercent: 30 }] }));
    const at = (iso: string) => Date.parse(iso) / 1000;
    const series = [{ key: 'gpu-e00mock-0', projectId: 'project-e00mocksandbox', instanceId: 'computeinstance-e00mockrun', node: 'n1', gpu: '0', region: 'eu-north1', stage: 'sandbox' }];
    const minutes = (iso: string, n: number, util: number) => Array.from({ length: n }, (_, i) => ({ key: 'gpu-e00mock-0', ts: at(iso) + i * 60, util }));
    await samples.write(series, [...minutes('2026-10-11T14:00:00Z', 30, 70), ...minutes('2026-10-12T10:00:00Z', 10, 30)], at('2026-10-12T12:00:00Z'));

    expect(await backfillHistory(history, samples, new Date('2026-10-12T12:00:00Z'))).toEqual(['2026-10-11']);
    const points = aggregateHistory(await history.since('2026-10-11'));
    expect(points[0]).toMatchObject({ day: '2026-10-11', gpus: 1, runningInstances: 1, resources: 1, gpuUtilMean: 70, incomplete: expect.stringMatching(/hourly GPU samples/) });
    expect(points[1]).toMatchObject({ day: '2026-10-12', gpus: 1, gpuUtilMean: 30 });
    expect(points[1].incomplete).toBeUndefined();
    // Once: a second run finds nothing to change.
    expect(await backfillHistory(history, samples, new Date('2026-10-12T12:00:00Z'))).toEqual([]);
  });

  it('leaves today unmarked when only its utilisation is missing (the first sync ran before the telemetry recorder)', async () => {
    const history = new HistoryStore(db);
    const samples = new SampleStore(db);
    await history.replaceDays(summarizeDay([vm('running'), disk], new Date('2026-10-12T10:00:00Z')));
    const at = (iso: string) => Date.parse(iso) / 1000;
    const series = [{ key: 'gpu-e00mock-0', projectId: 'project-e00mocksandbox', instanceId: 'computeinstance-e00mockrun', node: 'n1', gpu: '0', region: 'eu-north1', stage: 'sandbox' }];
    await samples.write(series, Array.from({ length: 5 }, (_, i) => ({ key: 'gpu-e00mock-0', ts: at('2026-10-12T10:01:00Z') + i * 60, util: 40 })), at('2026-10-12T10:10:00Z'));
    expect(await backfillHistory(history, samples, new Date('2026-10-12T10:10:00Z'))).toEqual([]);
    expect(aggregateHistory(await history.since('2026-10-12'))[0].incomplete).toBeUndefined();
  });

  it('does nothing without history or without samples', async () => {
    const history = new HistoryStore(db);
    const samples = new SampleStore(db);
    expect(await backfillHistory(history, samples, new Date('2026-10-12T12:00:00Z'))).toEqual([]);
    await history.replaceDays(summarizeDay([disk], new Date('2026-10-11T18:30:00Z')));
    expect(await backfillHistory(history, samples, new Date('2026-10-12T12:00:00Z'))).toEqual([]);
  });
});
