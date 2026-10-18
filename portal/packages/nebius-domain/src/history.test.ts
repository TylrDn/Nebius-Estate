import { aggregateHistory, backfillFromTelemetry, DailySummaryRow, HISTORY_INCOMPLETE, historyFooter, mergeDayRows, summarizeDay, telemetryDayRows } from './history';
import type { GpuHourly, GpuSeries } from './telemetry';
import { ObservedResource } from './resources';

const base = { labels: {}, refs: [], spec: {}, source: { connector: 't', kind: 'nebius-api' as const }, observedAt: 'x', coverageNotes: [] };
const vm = (id: string, project: string, extra: Partial<ObservedResource> = {}): ObservedResource => ({
  ...base, uid: `t:${id}`, providerId: id, type: 'compute-instance', name: id, projectId: project, region: 'r1', status: 'running', ...extra,
});

describe('summarizeDay', () => {
  it('summarises per project / region / stage, counting only running instances for capacity', () => {
    const rows = summarizeDay(
      [
        vm('a', 'p1', { labels: { 'nip-stage': 'sandbox', 'nip-ttl-expires': '2026-10-09T00:00:00Z' }, spec: { gpus: 1, vcpus: 16 } }),
        vm('b', 'p1', { labels: { 'nip-stage': 'sandbox' }, status: 'stopped', spec: { gpus: 1, vcpus: 16 } }),
        vm('c', 'p2', { spec: { vcpus: 8 } }),
        { ...base, uid: 't:d', providerId: 'd', type: 'compute-disk', name: 'd', projectId: 'p2', region: 'r1', status: 'running', spec: { attachments: 0 } },
        { ...base, uid: 't:p1', providerId: 'p1', type: 'project', name: 'p1', projectId: 'p1', status: 'running' },
      ],
      new Date('2026-10-10T12:00:00Z'),
      { samples: [{ instanceId: 'a', gpuUtilPercent: 50 }, { gpuUtilPercent: 99 }] },
    );
    const p1 = rows.find(r => r.projectId === 'p1')!;
    const p2 = rows.find(r => r.projectId === 'p2')!;
    expect(p1).toMatchObject({ day: '2026-10-10', stage: 'sandbox', resources: 2, runningInstances: 1, gpus: 1, vcpus: 16, ttlExpired: 1, gpuUtilSum: 50, gpuUtilSamples: 1 });
    expect(p2).toMatchObject({ stage: '', resources: 2, runningInstances: 1, vcpus: 8, orphanCandidates: 1, gpuUtilSamples: 0 });
    expect(rows).toHaveLength(2); // project resources themselves are not counted
  });
});

describe('aggregateHistory', () => {
  const row = (day: string, projectId: string, gpus: number, util?: [number, number]): DailySummaryRow => ({
    day, projectId, region: 'r1', stage: 's', resources: 1, runningInstances: 1, gpus, vcpus: 0, ttlExpired: 0, orphanCandidates: 0, gpuUtilSum: util?.[0] ?? 0, gpuUtilSamples: util?.[1] ?? 0,
  });

  it('sums per day, filters, keeps gaps and weights utilisation by samples', () => {
    const rows = [row('2026-10-02', 'p1', 1, [60, 1]), row('2026-10-02', 'p2', 8, [20, 3]), row('2026-10-01', 'p1', 2)];
    const all = aggregateHistory(rows);
    expect(all.map(p => [p.day, p.gpus, p.gpuUtilMean])).toEqual([
      ['2026-10-01', 2, null],
      ['2026-10-02', 9, 20],
    ]);
    expect(aggregateHistory(rows, { project: 'p2' }).map(p => p.day)).toEqual(['2026-10-02']);
  });
});

describe('a day keeps its GPU runs after teardown (G2.5)', () => {
  const row = (over: Partial<DailySummaryRow>): DailySummaryRow => ({ day: '2026-10-11', projectId: 'project-e00mocksandbox', region: 'eu-north1', stage: 'sandbox', resources: 10, runningInstances: 0, gpus: 0, vcpus: 0, ttlExpired: 0, orphanCandidates: 0, gpuUtilSum: 0, gpuUtilSamples: 0, ...over });

  it('a sync after the run was torn down keeps the day\'s maximum GPUs, vCPUs and running VMs, and the mean utilisation', () => {
    // 14:00 sync: one L40S running at 80 %; 18:30 sync: torn down.
    const during = [row({ resources: 14, runningInstances: 1, gpus: 1, vcpus: 8, gpuUtilSum: 80, gpuUtilSamples: 1 })];
    const after = [row({ resources: 10 })];
    const merged = mergeDayRows(during, after);
    expect(merged).toEqual([row({ resources: 10, runningInstances: 1, gpus: 1, vcpus: 8, gpuUtilSum: 80, gpuUtilSamples: 1 })]);
    expect(aggregateHistory(merged)[0]).toMatchObject({ gpus: 1, gpuUtilMean: 80 });
  });

  it('a key no longer seen keeps its maxima but no longer counts toward the last state', () => {
    const staging = row({ stage: 'staging', resources: 3, runningInstances: 1, gpus: 1, vcpus: 8, ttlExpired: 1, orphanCandidates: 1 });
    const merged = mergeDayRows([staging, row({})], [row({ resources: 9 })]);
    expect(merged.find(r => r.stage === 'staging')).toMatchObject({ resources: 0, ttlExpired: 0, orphanCandidates: 0, gpus: 1, runningInstances: 1 });
    expect(merged.find(r => r.stage === 'sandbox')).toMatchObject({ resources: 9 });
  });

  it('utilisation samples of every sync of the day are averaged', () => {
    const merged = mergeDayRows([row({ gpus: 1, gpuUtilSum: 100, gpuUtilSamples: 1 })], [row({ gpus: 1, gpuUtilSum: 20, gpuUtilSamples: 1 })]);
    expect(aggregateHistory(merged)[0].gpuUtilMean).toBe(60);
  });
});

describe('days recorded before the per-day peak are backfilled from GPU telemetry (#33)', () => {
  const day = (d: string, h: number) => Date.parse(`${d}T${String(h).padStart(2, '0')}:00:00Z`) / 1000;
  const series = (key: string, over: Partial<GpuSeries> = {}): GpuSeries => ({ key, projectId: 'project-e00mocksandbox', instanceId: 'computeinstance-e00mockrun', node: 'n1', region: 'eu-north1', stage: 'sandbox', ...over });
  const hour = (key: string, at: number, util: number | null, samples = 60): GpuHourly => ({ key, hour: at, samples, idleSamples: 0, utilAvg: util, utilMax: util, tempAvg: null, tempMax: null, powerAvg: null, memUsedAvg: null, memTotal: null });
  const row = (over: Partial<DailySummaryRow>): DailySummaryRow => ({ day: '2026-10-11', projectId: 'project-e00mocksandbox', region: 'eu-north1', stage: 'sandbox', resources: 10, runningInstances: 0, gpus: 0, vcpus: 0, ttlExpired: 0, orphanCandidates: 0, gpuUtilSum: 0, gpuUtilSamples: 0, ...over });

  it('counts the GPUs and VMs that reported in each UTC day, with the sample-weighted utilisation', () => {
    const rows = telemetryDayRows(
      [series('g0'), series('g1'), series('g2', { instanceId: 'computeinstance-e00mockother' })],
      [hour('g0', day('2026-10-11', 9), 80), hour('g0', day('2026-10-11', 10), 40, 30), hour('g1', day('2026-10-11', 9), null), hour('g2', day('2026-10-12', 1), 10), hour('g1', day('2026-10-12', 2), 50, 0)],
    );
    expect(rows.find(r => r.day === '2026-10-11')).toMatchObject({ gpus: 2, runningInstances: 1, gpuUtilSum: 80 * 60 + 40 * 30, gpuUtilSamples: 90, region: 'eu-north1', stage: 'sandbox' });
    // An hour with no samples is not a GPU present.
    expect(rows.find(r => r.day === '2026-10-12')).toMatchObject({ gpus: 1, runningInstances: 1, gpuUtilSamples: 60 });
  });

  it('takes the day\'s peak from the busiest hour: GPUs replaced during the day are not counted twice', () => {
    const vmA = series('a0', { instanceId: 'computeinstance-e00mocka', node: 'na' });
    const vmB = series('b0', { instanceId: 'computeinstance-e00mockb', node: 'nb' });
    // A in the morning, B in the afternoon, never running together: the peak is 1 GPU on 1 VM.
    const sequential = telemetryDayRows([vmA, vmB], [hour('a0', day('2026-10-11', 9), 50), hour('b0', day('2026-10-11', 15), 50)]);
    expect(sequential).toEqual([expect.objectContaining({ gpus: 1, runningInstances: 1, gpuUtilSamples: 120 })]);
    const stored = [row({ gpus: 1, runningInstances: 1, vcpus: 16, gpuUtilSum: 100, gpuUtilSamples: 2 })];
    expect(backfillFromTelemetry(stored, sequential)).toEqual({ rows: [], days: [] });
    // Both running in the same hour: the peak is 2, and a day that recorded 1 is raised to 2.
    const overlapping = telemetryDayRows([vmA, vmB], [hour('a0', day('2026-10-11', 9), 50), hour('b0', day('2026-10-11', 9), 50), hour('b0', day('2026-10-11', 15), 50)]);
    const out = backfillFromTelemetry(stored, overlapping);
    expect(out.days).toEqual(['2026-10-11']);
    expect(aggregateHistory(out.rows)[0]).toMatchObject({ gpus: 2, runningInstances: 2, incomplete: HISTORY_INCOMPLETE });
  });

  it('the peak hour is per project: two keys of one project peaking in different hours are not added up', () => {
    const north = series('n0', { instanceId: 'computeinstance-e00mockn', node: 'nn' });
    const south = series('s0', { instanceId: 'computeinstance-e00mocks', node: 'ns', region: 'uk-south1' });
    const rows = telemetryDayRows([north, south], [hour('n0', day('2026-10-11', 9), 50), hour('s0', day('2026-10-11', 15), 50)]);
    expect(rows.reduce((a, r) => a + r.gpus, 0)).toBe(1);
    expect(rows.reduce((a, r) => a + r.gpuUtilSamples, 0)).toBe(120);
  });

  it('today is not marked for utilisation alone: the first sync of a fresh start runs before the telemetry recorder', () => {
    const tel = telemetryDayRows([series('g0')], [hour('g0', day('2026-10-11', 9), 70)]);
    const stored = [row({ gpus: 1, runningInstances: 1 })];
    expect(backfillFromTelemetry(stored, tel, '2026-10-11')).toEqual({ rows: [], days: [] });
    // A past day without utilisation is still filled, and a GPU today's syncs missed is still raised.
    expect(backfillFromTelemetry(stored, tel, '2026-10-12').days).toEqual(['2026-10-11']);
    expect(backfillFromTelemetry([row({})], tel, '2026-10-11').rows[0]).toMatchObject({ gpus: 1, gpuUtilSamples: 0, telemetryBackfill: true });
  });

  it('raises a recorded day that shows 0 GPUs while telemetry saw them, and marks it incomplete', () => {
    const stored = [row({ resources: 12 }), row({ day: '2026-10-10', gpus: 1, runningInstances: 1, vcpus: 8, gpuUtilSum: 70, gpuUtilSamples: 1 })];
    const tel = telemetryDayRows([series('g0')], [hour('g0', day('2026-10-11', 9), 70), hour('g0', day('2026-10-10', 9), 70)]);
    const out = backfillFromTelemetry(stored, tel);
    expect(out.days).toEqual(['2026-10-11']); // 10-10 already counted its GPU: unchanged
    expect(out.rows).toEqual([row({ resources: 12, gpus: 1, runningInstances: 1, gpuUtilSum: 70 * 60, gpuUtilSamples: 60, telemetryBackfill: true })]);
    const points = aggregateHistory([...out.rows, stored[1]]);
    expect(points.find(p => p.day === '2026-10-11')).toMatchObject({ gpus: 1, gpuUtilMean: 70, vcpus: 0, incomplete: HISTORY_INCOMPLETE });
    expect(points.find(p => p.day === '2026-10-10')?.incomplete).toBeUndefined();
  });

  it('never adds a day the portal did not record, never lowers a day, and is idempotent', () => {
    const tel = telemetryDayRows([series('g0')], [hour('g0', day('2026-10-09', 9), 70), hour('g0', day('2026-10-11', 9), 70)]);
    const stored = [row({ gpus: 2, runningInstances: 2, gpuUtilSum: 30, gpuUtilSamples: 1 })];
    expect(backfillFromTelemetry(stored, tel)).toEqual({ rows: [], days: [] });
    const once = backfillFromTelemetry([row({})], tel);
    expect(backfillFromTelemetry(once.rows, tel)).toEqual({ rows: [], days: [] });
  });

  it('compares per project, so a series written without its region or stage is not counted twice', () => {
    // The day row counted the GPU under eu-north1/sandbox; the series has no region or stage.
    const tel = telemetryDayRows([series('g0', { region: undefined, stage: undefined })], [hour('g0', day('2026-10-11', 9), 70)]);
    expect(backfillFromTelemetry([row({ gpus: 1, runningInstances: 1, gpuUtilSum: 70, gpuUtilSamples: 1 })], tel).rows).toEqual([]);
    // When the day missed it, the deficit lands on the project's row of that day: the totals match telemetry once.
    const out = backfillFromTelemetry([row({})], tel);
    expect(out.rows).toHaveLength(1);
    expect(aggregateHistory(out.rows)[0]).toMatchObject({ gpus: 1, runningInstances: 1 });
  });

  it('a project the day did not record at all gets a row of its own with what telemetry saw', () => {
    const tel = telemetryDayRows([series('g0', { projectId: 'project-e00mocklab', region: 'uk-south1', stage: 'lab' })], [hour('g0', day('2026-10-11', 9), 70)]);
    const out = backfillFromTelemetry([row({})], tel);
    expect(out.rows).toHaveLength(2);
    expect(out.rows.find(r => r.projectId === 'project-e00mocklab')).toMatchObject({ region: 'uk-south1', stage: 'lab', gpus: 1, runningInstances: 1, resources: 0, vcpus: 0, telemetryBackfill: true });
    expect(aggregateHistory(out.rows, { project: 'project-e00mocksandbox' })[0].incomplete).toBeUndefined();
  });

  it('a later sync of a backfilled day keeps the mark', () => {
    const merged = mergeDayRows([row({ gpus: 1, telemetryBackfill: true })], [row({})]);
    expect(merged[0]).toMatchObject({ gpus: 1, telemetryBackfill: true });
  });
});

describe('historyFooter (#33)', () => {
  it('adds why points are hollow only when a day is marked', () => {
    expect(historyFooter({ source: 'S', note: 'N', points: [{}] })).toBe('S. N');
    expect(historyFooter({ source: 'S', note: 'N', points: [{}, { incomplete: HISTORY_INCOMPLETE }] })).toBe(`S. N Hollow points: ${HISTORY_INCOMPLETE}`);
  });
});
