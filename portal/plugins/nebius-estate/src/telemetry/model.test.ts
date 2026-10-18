import { FleetGpuRow } from '@internal/nebius-domain';
import { bucketLabel, fmtGpuHours, nodeGroupDrill, logsRangeFor, fmtMetric, fmtRate, gpuLabel, groupByReason, groupRows, heatClass, lastOf, meanOf, powerMax, rowLabels, rowState } from './model';

const row = (over: Partial<FleetGpuRow>): FleetGpuRow => ({ key: Math.random().toString(), projectId: 'p', node: 'n', idleMinutes: 0, samples: 1, runningNow: true, values: { util: [], temp: [], power: [], mem: [] }, ...over });

describe('Fleet view helpers', () => {
  it('colour a cell on ten steps, and "not observed" is its own class, never the low end', () => {
    expect(heatClass('util', 0, 1)).toBe('ne-heat-c0');
    expect(heatClass('util', 55, 1)).toBe('ne-heat-c5');
    expect(heatClass('util', 100, 1)).toBe('ne-heat-c9');
    expect(heatClass('temp', 88, 1)).toBe('ne-heat-c9');
    expect(heatClass('util', null, 1)).toBe('ne-heat-cnone');
  });

  it('format values with units and say "not observed" instead of a dash or zero', () => {
    expect(fmtMetric('util', 63.46)).toBe('63.5 %');
    expect(fmtMetric('temp', 54)).toBe('54 °C');
    expect(fmtMetric('power', 310.2)).toBe('310 W');
    expect(fmtMetric('mem', null)).toBe('not observed');
    expect(fmtRate(1536, 'B/s')).toBe('1.5 KiB/s');
    expect(fmtRate(2.5, 'req/s')).toBe('2.5 req/s');
    expect(fmtRate(null, 'B/s')).toBe('no series');
  });

  it('group GPUs by cluster and node group, standalone VMs last', () => {
    const groups = groupRows([
      row({ instanceName: 'bench', projectName: 'lab' }),
      row({ nodeGroupId: 'ng1', nodeGroupName: 'gpu', clusterName: 'inference', instanceName: 'vm-1' }),
      row({ nodeGroupId: 'ng1', nodeGroupName: 'gpu', clusterName: 'inference', instanceName: 'vm-2' }),
    ]);
    expect(groups.map(g => [g.title, g.rows.length])).toEqual([
      ['inference › gpu', 2],
      ['Standalone VMs · lab', 1],
    ]);
  });

  it('marks a deleted cluster and node group in the group title the same way for names and ids (F1.40)', () => {
    const groups = groupRows([
      row({ nodeGroupId: 'ng1', nodeGroupName: 'Node group ng1', clusterId: 'c1', clusterName: 'Cluster c1', deleted: { vm: true, nodeGroup: true, cluster: true } }),
      row({ nodeGroupId: 'ng2', nodeGroupName: 'gpu', clusterName: 'inference', deleted: { vm: true } }),
      row({ instanceName: 'gpu-vm', projectName: 'lab', deleted: { vm: true } }),
    ]);
    expect(groups.map(g => g.title)).toEqual(['Cluster c1 (deleted) › Node group ng1 (deleted)', 'inference › gpu', 'Standalone VMs · lab']);
  });

  it('one state per GPU row: deleted, not running or running, worded the same for every VM (F1.40)', () => {
    expect(rowState(row({ runningNow: false, deleted: { vm: true }, notRunning: 'VM no longer in the inventory (deleted)' }))).toBe('deleted');
    expect(rowState(row({ runningNow: false, notRunning: 'VM is stopped' }))).toBe('not running');
    expect(rowState(row({ runningNow: true }))).toBeUndefined();
  });

  it('label GPUs, buckets and summaries', () => {
    expect(gpuLabel({ instanceName: 'vm', node: 'x', gpu: 'GPU-0000mock-b4af' })).toBe('vm · GPU-0000mock'); // the short UUID, as in its alerts (gpuName)
    expect(gpuLabel({ node: 'host', gpu: '0' })).toBe('host · GPU 0');
    expect(bucketLabel('2026-10-11T08:15:00.000Z', '6h')).toBe('08:15');
    expect(bucketLabel('2026-10-11T08:00:00.000Z', '7d')).toBe('10-11 08:00');
    expect(meanOf([null, 10, 20])).toBe(15);
    expect(meanOf([null])).toBeNull();
    expect(lastOf([1, 2, null])).toBe(2);
    expect(powerMax([row({ values: { util: [], temp: [], power: [100, null, 300], mem: [] } })])).toBe(300);
  });

  it('labels a GPU by its VM name and the same GPU name as its alerts', () => {
    expect(gpuLabel(row({ instanceName: 'mk8snodegroup-e00rcx-qg7rz', node: 'computeinstance-e00vnt', gpu: 'GPU-0000mock-b4af', gpuName: 'GPU 0' }))).toBe('mk8snodegroup-e00rcx-qg7rz · GPU 0');
    expect(gpuLabel(row({ node: 'n', gpu: '1' }))).toBe('n · GPU 1');
  });
});

describe('groupByReason', () => {
  it('says each reason once, with the VMs it covers', () => {
    const r = 'The VM is not in the current inventory.';
    expect(groupByReason([{ name: 'a', reason: r }, { name: 'b', reason: 'Other.' }, { name: 'c', reason: r }])).toEqual([
      { reason: r, names: ['a', 'c'] },
      { reason: 'Other.', names: ['b'] },
    ]);
  });

  it('tells apart GPU rows and node groups that read the same, by their last sample (W1F.N4)', () => {
    const a = row({ key: 'a', instanceId: 'computeinstance-e00mockrun1', instanceName: 'gpu-vm', gpu: '0', lastSampleAt: '2026-10-11T14:20:00Z', deleted: { vm: true } });
    const b = row({ key: 'b', instanceId: 'computeinstance-e00mockrun2', instanceName: 'gpu-vm', gpu: '0', lastSampleAt: '2026-10-12T09:05:00Z', deleted: { vm: true } });
    const c = row({ key: 'c', instanceName: 'other', gpu: '0' });
    const labels = rowLabels([a, b, c]);
    expect([labels.get('a'), labels.get('b'), labels.get('c')]).toEqual(['gpu-vm · GPU 0 · last sample 10-11 14:20 UTC', 'gpu-vm · GPU 0 · last sample 10-12 09:05 UTC', 'other · GPU 0']);
    const groups = groupRows([
      row({ nodeGroupId: 'ng-old', nodeGroupName: 'gpu', clusterName: 'inference', lastSampleAt: '2026-10-11T14:20:00Z', deleted: { nodeGroup: true } }),
      row({ nodeGroupId: 'ng-new', nodeGroupName: 'gpu', clusterName: 'inference', lastSampleAt: '2026-10-12T09:05:00Z', deleted: { nodeGroup: true } }),
    ]);
    expect(new Set(groups.map(g => g.title)).size).toBe(2);
    expect(groups.map(g => g.title).every(t => /· last sample/.test(t))).toBe(true);
  });
});

describe('Fleet drill-down and idle figures (G2.6, G2.15)', () => {
  const now = Date.parse('2026-10-12T15:59:00Z');
  it('opens Logs on a range that reaches back to the GPU\'s last sample', () => {
    expect(logsRangeFor('2026-10-12T15:30:00Z', '24h', now)).toBe('1h');
    expect(logsRangeFor('2026-10-12T12:00:00Z', '24h', now)).toBe('6h');
    expect(logsRangeFor('2026-10-11T18:03:00Z', '24h', now)).toBe('24h');
    expect(logsRangeFor('2026-10-09T18:03:00Z', '7d', now)).toBe('7d');
    // 7 d is read from the hourly roll-ups and carries no last sample: the Fleet range.
    expect(logsRangeFor(undefined, '7d', now)).toBe('7d');
    expect(logsRangeFor(undefined, '6h', now)).toBe('6h');
  });

  it('one precision for idle GPU-hours everywhere: 2 decimals below 1 GPU-hour, 1 above', () => {
    expect(fmtGpuHours(0.25)).toBe('0.25');
    expect(fmtGpuHours(0)).toBe('0');
    expect(fmtGpuHours(1.26)).toBe('1.3');
    expect(fmtGpuHours(12)).toBe('12');
  });
});

// Followup 34: the GPU drawer linked "Node group in the Explorer" for a node group that was deleted; the Explorer then
// said it could not be loaded.
describe('nodeGroupDrill', () => {
  it('links a node group that is in the inventory, by its Explorer uid', () => {
    expect(nodeGroupDrill(row({ nodeGroupId: 'mk8snodegroup-e00mockinfgpu', nodeGroupUid: 'nebius:mk8snodegroup-e00mockinfgpu' }))).toEqual({ uid: 'nebius:mk8snodegroup-e00mockinfgpu' });
  });
  it('before the first sync, or in a project that was not listed, a node group not in the inventory is not linked', () => {
    expect(nodeGroupDrill(row({ nodeGroupId: 'mk8snodegroup-e00mockinfgpu' }))).toEqual({ note: 'Node group not in the current inventory, so the Explorer has nothing to open.' });
  });
  it('says a deleted node group is not in the Explorer instead of linking it', () => {
    expect(nodeGroupDrill(row({ nodeGroupId: 'mk8snodegroup-e00mockgone', deleted: { nodeGroup: true } }))).toEqual({ note: 'Node group deleted; not in the Explorer.' });
  });
  it('a standalone VM has no node group to open', () => {
    expect(nodeGroupDrill(row({}))).toBeUndefined();
  });
});
