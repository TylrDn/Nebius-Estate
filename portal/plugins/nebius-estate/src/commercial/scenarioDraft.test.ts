import { scenarioSchema } from '@internal/nebius-domain';
import { footprintOrderIssues, newScenario, tabFromSearch, unknownTab } from './scenarioDraft';

describe('URL tab', () => {
  it('restores a known tab from ?tab= and falls back to the first', () => {
    expect(tabFromSearch('?tab=ratebooks', ['scenarios', 'ratebooks'] as const)).toBe('ratebooks');
    expect(tabFromSearch('?tab=nope', ['scenarios', 'ratebooks'] as const)).toBe('scenarios');
    expect(tabFromSearch('', ['scenarios', 'ratebooks'] as const)).toBe('scenarios');
  });

  it('names a ?tab= that is not a tab, so the page can say so (#72)', () => {
    expect(unknownTab('?tab=bogus', ['scenarios', 'ratebooks'] as const)).toBe('bogus');
    expect(unknownTab('?tab=ratebooks', ['scenarios', 'ratebooks'] as const)).toBeUndefined();
    expect(unknownTab('', ['scenarios', 'ratebooks'] as const)).toBeUndefined();
  });
});

describe('new scenario', () => {
  it('builds a valid scenario from the create form: one node group, minimum 0, maximum the expected count', () => {
    const s = newScenario({ name: 'Inference pilot', rateBookId: 'test-xts', currency: 'XTS', region: 'eu-north1', capacityType: 'on-demand', activeHours: 12, platform: 'gpu-h100-sxm', preset: '1gpu-16vcpu-200gb', count: 2, bootDiskGib: 200 }, '2026-10-11');
    expect(scenarioSchema.safeParse(s).success).toBe(true);
    expect(s.footprints.min.nodeGroups[0].count).toBe(0);
    expect(s.footprints.expected.nodeGroups[0]).toMatchObject({ role: 'gpu', count: 2, platform: 'gpu-h100-sxm' });
    expect(s.footprints.max.nodeGroups[0].count).toBe(2);
    expect(s.asOf).toBe('2026-10-11');
    expect(s.recipe).toBe('custom');
  });
  it('a CPU preset makes a cpu-worker group', () => {
    expect(newScenario({ name: 'x', rateBookId: 'b', currency: 'USD', region: 'eu-north1', capacityType: 'on-demand', activeHours: 1, platform: 'cpu-d3', preset: '8vcpu-32gb', count: 1, bootDiskGib: 64 }, '2026-10-11').footprints.expected.nodeGroups[0].role).toBe('cpu-worker');
  });
});

describe('footprint order (G4.7)', () => {
  const base = () => newScenario({ name: 'x', rateBookId: 'test-xts', currency: 'XTS', region: 'eu-north1', capacityType: 'on-demand', activeHours: 1, platform: 'gpu-h100-sxm', preset: '1gpu-16vcpu-200gb', count: 2, bootDiskGib: 200 }, '2026-10-11').footprints;

  it('a consistent footprint has no issue', () => {
    expect(footprintOrderIssues(base())).toEqual([]);
  });

  it('expected above maximum is named on the maximum (live: expected 4 GPUs, maximum 2, a cheaper "maximum")', () => {
    const fp = base();
    fp.expected.nodeGroups[0].count = 4;
    expect(footprintOrderIssues(fp)).toEqual([{ input: `${fp.expected.nodeGroups[0].name} max count`, text: `${fp.expected.nodeGroups[0].name}: expected 4 is above the maximum 2` }]);
  });

  it('minimum above expected is named on the minimum; storage rows are checked too', () => {
    const fp = base();
    fp.min.nodeGroups[0].count = 3;
    fp.expected.filesystemGib = 100;
    fp.max.filesystemGib = 50;
    expect(footprintOrderIssues(fp).map(i => i.input)).toEqual([`${fp.expected.nodeGroups[0].name} min count`, 'filesystemGib max']);
    expect(footprintOrderIssues(fp)[1].text).toBe('Shared filesystem GiB: expected 100 is above the maximum 50');
  });
});
