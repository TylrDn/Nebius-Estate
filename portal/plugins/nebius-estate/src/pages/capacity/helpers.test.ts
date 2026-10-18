import type { NodeGroupCapacity, PlatformView, QuotaAllowanceView, RegionsFile } from '@internal/nebius-domain';
import { inferenceFootprint } from '@internal/nebius-domain';
import { blockedPlans, byUrgency, calculatorSizing, profileNodeCounts, quotaLineText, comparePlatforms, footprintQuotaStatus, fmtQuotaAmount, gpuModel, isGpuQuota, isUrgentQuota, matchesQuota, nodeGroupQuotaStatus, parseUnavailable, projectRegions, quotaFigures, serviceLabel, unitLabel, unplacedPlatforms, usageLevel, usagePercent, validateNodeCounts } from './helpers';

const quota = (over: Partial<QuotaAllowanceView>): QuotaAllowanceView => ({
  scope: 'project',
  projectId: 'project-e00mocka',
  name: 'compute.instance.gpu.h100',
  region: 'eu-north1',
  allocation: 'set',
  limit: 16,
  usage: 0,
  usagePercent: 0,
  unit: 'gpu',
  ...over,
});

describe('quota helpers', () => {
  it('recognises GPU quotas and never a non-GPU vCPU quota', () => {
    expect(isGpuQuota(quota({}))).toBe(true);
    expect(isGpuQuota({ name: 'compute.instance.gpu.b300', unit: undefined })).toBe(true);
    expect(isGpuQuota({ name: 'compute.instance.non-gpu.vcpu', unit: 'vcpu' })).toBe(false);
    expect(gpuModel(quota({ name: 'compute.instance.gpu.b300' }))).toBe('B300');
  });

  it('derives a percentage only when usage and a positive limit are known', () => {
    expect(usagePercent({ usage: 3, limit: 4, usagePercent: null })).toBe(75);
    expect(usagePercent({ usage: null, limit: 4, usagePercent: null })).toBeNull();
    expect(usagePercent({ usage: 0, limit: 0, usagePercent: null })).toBeNull();
  });

  it('grades usage, with a zero limit as its own state', () => {
    expect(usageLevel({ usage: 2, limit: 2, usagePercent: 100 })).toBe('over');
    expect(usageLevel({ usage: 13, limit: 16, usagePercent: null })).toBe('near');
    expect(usageLevel({ usage: 1, limit: 16, usagePercent: null })).toBe('under');
    expect(usageLevel({ usage: 0, limit: 0, usagePercent: null })).toBe('zero-limit');
    expect(usageLevel({ usage: null, limit: null, usagePercent: null })).toBe('unknown');
  });

  it('sorts the most urgent first', () => {
    const rows = [quota({ name: 'a', usagePercent: 10, usage: 1 }), quota({ name: 'b', usagePercent: 100, usage: 16 }), quota({ name: 'c', limit: 0, usagePercent: null }), quota({ name: 'd', usagePercent: 85 })];
    expect([...rows].sort(byUrgency).map(r => r.name)).toEqual(['b', 'd', 'c', 'a']);
  });

  it('searches every word across name, description, region and project name', () => {
    const q = quota({ description: 'GPUs H100' });
    expect(matchesQuota(q, 'h100 north1', 'sandbox')).toBe(true);
    expect(matchesQuota(q, 'sandbox', 'sandbox')).toBe(true);
    expect(matchesQuota(q, 'b300')).toBe(false);
  });

  it('splits "<state>: <hint>" reasons and leaves plain sentences alone', () => {
    expect(parseUnavailable('permission-denied: Refused for this identity: grant x.')).toEqual({ state: 'permission-denied', text: 'Refused for this identity: grant x.' });
    expect(parseUnavailable('Not read yet.')).toEqual({ text: 'Not read yet.' });
  });
});

describe('project placeholders and services', () => {
  const placeholder = quota({ allocation: 'inherits-tenant', limit: null, usage: 1, usagePercent: null });
  it('a placeholder uses the tenant quota: neutral, never blocked, judged against the tenant limit', () => {
    expect(usageLevel(placeholder)).toBe('inherits');
    expect(quotaFigures({ ...placeholder, tenant: { limit: 32, usage: 1, usagePercent: 3.13 } })).toMatchObject({ inherits: true, limit: 32, usage: 1, level: 'inherits' });
    expect(quotaFigures(placeholder)).toMatchObject({ inherits: true, limit: null });
    expect(usageLevel(quota({ limit: 0, usagePercent: null }))).toBe('zero-limit'); // a real project cap of 0
  });
  it('labels the service and ranks limit 0 as urgent only for Compute in a region the estate uses', () => {
    expect(serviceLabel(quota({}))).toBe('Compute VMs');
    expect(serviceLabel(quota({ name: 'msp.cloudapps.gpu.h100', service: 'msp' }))).toBe('Standalone apps');
    const zero = { ...quota({ scope: 'tenant', projectId: '', limit: 0, usagePercent: null }) };
    expect(isUrgentQuota(zero, new Set(['eu-north1']))).toBe(true);
    expect(isUrgentQuota({ ...zero, region: 'eu-north2' }, new Set(['eu-north1']))).toBe(false);
    expect(isUrgentQuota({ ...zero, name: 'msp.cloudapps.gpu.h100' }, new Set(['eu-north1']))).toBe(false);
    expect(isUrgentQuota(placeholder, new Set(['eu-north1']))).toBe(false);
  });
});

describe('node groups against the quotas their preset consumes', () => {
  const ng = (over: Partial<NodeGroupCapacity>): NodeGroupCapacity => ({ uid: 'u', cluster: 'c', name: 'ng', platform: 'cpu-d3', preset: '4vcpu-16gb', gpusPerNode: 0, nodes: 0, fixedNodeCount: 2, capacityType: 'on-demand', region: 'eu-north1', projectId: 'project-e00mocka', ...over });
  const tenant = (name: string, limit: number, usage = 0) => quota({ scope: 'tenant', projectId: '', name, limit, usage, usagePercent: null });
  const quotas = [tenant('compute.instance.non-gpu.vcpu', 0), tenant('compute.instance.gpu.h100', 32, 32), tenant('compute.instance.preemptible.count', 8, 1)];
  it('names the quota that blocks a CPU group short of its count (non-GPU vCPU limit 0)', () => {
    expect(nodeGroupQuotaStatus(ng({}), quotas)).toMatchObject({ state: 'blocked', quota: 'compute.instance.non-gpu.vcpu', missing: 2, need: 8, limit: 0 });
  });
  it('an exhausted GPU quota, a complete group, preemptible counted by VM, reservations not checked', () => {
    const gpu = ng({ platform: 'gpu-h100-sxm', preset: '1gpu-16vcpu-200gb', gpusPerNode: 1, fixedNodeCount: 1 });
    expect(nodeGroupQuotaStatus(gpu, quotas)).toMatchObject({ state: 'exhausted', quota: 'compute.instance.gpu.h100', need: 1, limit: 32, usage: 32 });
    expect(nodeGroupQuotaStatus({ ...gpu, nodes: 1 }, quotas).state).toBe('complete');
    expect(nodeGroupQuotaStatus({ ...gpu, capacityType: 'preemptible' }, quotas)).toMatchObject({ state: 'ok', quota: 'compute.instance.preemptible.count', need: 1 });
    expect(nodeGroupQuotaStatus({ ...gpu, capacityType: 'reserved' }, quotas).state).toBe('not-checked');
    expect(nodeGroupQuotaStatus(ng({ region: 'us-central1' }), quotas).state).toBe('not-checked');
  });
  it('a group scaled to zero, or with more nodes than its spec, is not "all nodes up" (F1.12)', () => {
    expect(nodeGroupQuotaStatus(ng({ fixedNodeCount: undefined, autoscaling: { min: 0, max: 2 }, capacityType: 'reserved' }), quotas)).toMatchObject({ state: 'scaled-to-zero', missing: 0 });
    expect(nodeGroupQuotaStatus(ng({ nodes: 3, fixedNodeCount: 2 }), quotas)).toMatchObject({ state: 'above', extra: 1, ceiling: 2 });
  });
});

describe('comparePlatforms', () => {
  const yaml: RegionsFile = {
    regions: {
      'eu-north1': { default: 'gpu-h100-sxm', platforms: { 'gpu-h100-sxm': { single_gpu_preset: '1gpu-16vcpu-200gb', ib_preset: '8gpu-128vcpu-1600gb' }, 'gpu-h200-sxm': { single_gpu_preset: '1gpu-16vcpu-200gb' } } },
      'eu-west2': { default: 'gpu-b300-sxm', platforms: { 'gpu-b300-sxm': { single_gpu_preset: '1gpu-24vcpu-346gb' } } },
    },
    kubernetes_versions: ['1.31'],
  } as RegionsFile;
  const live: PlatformView[] = [
    { name: 'cpu-d3', presets: [{ name: '4vcpu-16gb', gpus: 0, vcpus: 4, memoryGibibytes: 16 }], projects: ['project-e00mocka'], regions: [] },
    { name: 'gpu-h100-sxm', presets: [{ name: '1gpu-16vcpu-200gb', gpus: 1, vcpus: 16, memoryGibibytes: 200 }], projects: ['project-e00mocka'], regions: [] },
    { name: 'gpu-l40s-a', presets: [{ name: '1gpu-8vcpu-32gb', gpus: 1, vcpus: 8, memoryGibibytes: 32 }], projects: ['project-e00mocka', 'project-e00mockz'], regions: [] },
  ];
  const regions = projectRegions([quota({})], []);

  it('marks matches, missing presets, platforms missing live, and live ones absent from the yaml', () => {
    const rows = comparePlatforms(live, yaml, regions);
    const by = Object.fromEntries(rows.map(r => [r.key, r]));
    expect(by['eu-north1/gpu-h100-sxm'].check).toBe('preset-mismatch');
    expect(by['eu-north1/gpu-h100-sxm'].missingPresets).toEqual(['8gpu-128vcpu-1600gb']);
    expect(by['eu-north1/gpu-h200-sxm'].check).toBe('missing-live');
    expect(by['eu-north1/gpu-l40s-a'].check).toBe('not-in-yaml');
    expect(by['eu-west2/gpu-b300-sxm'].check).toBe('not-checked');
    expect(rows.some(r => r.platform === 'cpu-d3')).toBe(false);
  });

  it('narrows to one region and reports projects without a known region', () => {
    expect(new Set(comparePlatforms(live, yaml, regions, 'eu-west2').map(r => r.region))).toEqual(new Set(['eu-west2']));
    expect(unplacedPlatforms(live, regions)).toEqual([{ platform: 'gpu-l40s-a', projects: ['project-e00mockz'] }]);
  });
});

describe('footprint calculator inputs', () => {
  it('accepts whole numbers in order', () => {
    expect(validateNodeCounts({ min: '0', expected: '2', max: '4' })).toEqual({ counts: { min: 0, expected: 2, max: 4 }, errors: {}, notes: {} });
  });
  it('rejects fractions and anything but a whole number, on the field', () => {
    const v = validateNodeCounts({ min: '0', expected: '1.5', max: '' });
    expect(v.counts).toBeUndefined();
    expect(v.errors).toEqual({ expected: 'Enter a whole number of nodes (no decimals).', max: 'Enter a whole number of nodes.' });
  });
  it('requires minimum ≤ expected ≤ maximum', () => {
    const v = validateNodeCounts({ min: '5', expected: '1', max: '4' });
    expect(v.counts).toBeUndefined();
    expect(v.errors).toEqual({ min: 'Minimum (5) is above expected (1).' });
    expect(validateNodeCounts({ min: '0', expected: '6', max: '4' }).errors).toEqual({ max: 'Maximum (4) is below expected (6).' });
  });
  it('says when a value is clamped to the 64-node ceiling', () => {
    expect(validateNodeCounts({ min: '0', expected: '2', max: '100000' })).toEqual({ counts: { min: 0, expected: 2, max: 64 }, errors: {}, notes: { max: 'Clamped to 64 (the most nodes one node group plans here).' } });
  });
});

describe('footprint calculator quota needs: the same check as Overview and Provisioning', () => {
  const tenant = (name: string, limit: number, region = 'eu-north1') => quota({ scope: 'tenant', projectId: '', name, region, limit, usage: 0, usagePercent: null });
  const fp = { nodeGroups: [{ name: 'system', role: 'system' as const, platform: 'cpu-d3', preset: '8vcpu-32gb', count: 2, bootDiskGib: 128 }], filesystemGib: 0, extraSsdGib: 0, ioM3Gib: 0, objectStorageGib: 0, publicIps: 0 };
  it('flags the eu-north1 non-GPU vCPU limit 0', () => {
    const s = footprintQuotaStatus(fp, 'training', {}, 'eu-north1', [tenant('compute.instance.non-gpu.vcpu', 0), tenant('compute.instance.non-gpu.vcpu', 512, 'eu-west1')]);
    expect(s.state).toBe('blocked');
    expect(s.lines.map(l => [l.quota, l.state])).toEqual([['compute.instance.non-gpu.vcpu', 'blocked']]);
    expect(footprintQuotaStatus(fp, 'training', {}, 'eu-west1', [tenant('compute.instance.non-gpu.vcpu', 512, 'eu-west1')]).state).toBe('ok');
  });
  it('says when nothing could be checked (no tenant allowance for the region)', () => {
    expect(footprintQuotaStatus(fp, 'training', {}, 'eu-north2', [tenant('compute.instance.non-gpu.vcpu', 0)]).state).toBe('not-checked');
    expect(footprintQuotaStatus(fp, 'training', {}, 'eu-north1', null).state).toBe('not-checked');
  });
});

describe('quota figures read as people talk', () => {
  it('formats bytes as GiB / TiB and humanises units', () => {
    expect(fmtQuotaAmount(17_592_186_044_416, 'byte')).toBe('16 TiB');
    expect(fmtQuotaAmount(0, 'byte')).toBe('0 GiB');
    expect(fmtQuotaAmount(167_247, 'byte')).toBe('< 0.01 GiB');
    expect(fmtQuotaAmount(3, 'count')).toBe('3');
    expect(unitLabel('count')).toBe('');
    expect(unitLabel('vcpu')).toBe('vCPUs');
    expect(unitLabel('gpu')).toBe('GPUs');
  });
  it('searches every word of a multi-word query', () => {
    const q = quota({ scope: 'tenant', projectId: '', name: 'compute.instance.preemptible.count', description: 'Preemptible virtual machines', region: 'eu-north1' });
    expect(matchesQuota(q, 'eu-north1 preemptible')).toBe(true);
    expect(matchesQuota(q, 'Preemptible   EU-NORTH1')).toBe(true);
    expect(matchesQuota(q, 'eu-north2 preemptible')).toBe(false);
  });
});

describe('platforms seen per region', () => {
  it('lists only the projects located in that region', () => {
    const yaml = { regions: { 'uk-south1': { default: 'gpu-b300-sxm', platforms: { 'gpu-b300-sxm': { single_gpu_preset: '1gpu-24vcpu-346gb' } } } }, kubernetes_versions: [] } as unknown as RegionsFile;
    const live: PlatformView[] = [{ name: 'gpu-b300-sxm', presets: [{ name: '1gpu-24vcpu-346gb', gpus: 1, vcpus: 24, memoryGibibytes: 346 }], projects: ['p-uk', 'p-west2', 'p-usn1'], regions: ['eu-west2', 'us-north1', 'uk-south1'] }];
    const where = projectRegions([quota({ projectId: 'p-uk', region: 'uk-south1' }), quota({ projectId: 'p-west2', region: 'eu-west2' }), quota({ projectId: 'p-usn1', region: 'us-north1' })], []);
    expect(comparePlatforms(live, yaml, where, 'uk-south1')[0].projects).toEqual(['p-uk']);
  });
});

describe('"blocked by quota" counts the same on Overview and Capacity', () => {
  it('counts distinct live roots, whatever the number of quota lines', () => {
    const i = (plan: string, quotaName: string) => ({ plan, region: 'eu-north1', quota: quotaName, need: 1, limit: 0, usage: 0, state: 'blocked' as const, what: 'x' });
    expect(blockedPlans([i('terraform/live/sandbox/inference', 'a'), i('terraform/live/sandbox/inference', 'b'), i('terraform/live/prod/training', 'a')])).toEqual(['terraform/live/prod/training', 'terraform/live/sandbox/inference']);
    expect(blockedPlans(null)).toBeNull();
  });
});

describe('footprint calculator sizing (G2.3)', () => {
  const regions = {
    regions: { 'eu-north1': { default: 'gpu-h100-sxm', platforms: { 'gpu-h100-sxm': { single_gpu_preset: '1gpu-16vcpu-200gb' }, 'gpu-l40s-a': { single_gpu_preset: '1gpu-8vcpu-32gb' } } } },
    kubernetes_versions: ['1.36'],
  } as any;
  const root = {
    sizing: { cpu_preset: '8vcpu-32gb', cpu_node_count: 2, gpu_node_count: 1, gpu_preemptible: true },
    runProfiles: [{ name: 'l40s-gpu-only', region: 'eu-north1', vars: { cpu_node_count: 0, gpu_platform: 'gpu-l40s-a', gpu_preset: '1gpu-8vcpu-32gb', gpu_node_count: 1, gpu_preemptible: true } }],
  };

  it('without a profile: the sizing file and the region\'s default GPU platform', () => {
    const c = calculatorSizing(root, 'inference', undefined, regions, 'eu-north1');
    expect(c.sizing.cpu_node_count).toBe(2);
    expect(c.gpuPlatform).toBe('gpu-h100-sxm');
    expect(c.capacityType).toBe('preemptible');
    expect(c.profile).toBeUndefined();
  });

  it('with the l40s-gpu-only profile: no CPU node, one preemptible L40S, priced preemptible', () => {
    const c = calculatorSizing(root, 'inference', 'l40s-gpu-only', regions, 'eu-north1');
    expect(c.sizing).toMatchObject({ cpu_node_count: 0, gpu_platform: 'gpu-l40s-a', gpu_preset: '1gpu-8vcpu-32gb' });
    expect(c.gpuPlatform).toBe('gpu-l40s-a');
    expect(c.capacityType).toBe('preemptible');
    expect(c.profile?.name).toBe('l40s-gpu-only');
    const fp = inferenceFootprint(c.sizing, { regions, region: 'eu-north1' }, 1);
    expect(fp.nodeGroups.map(g => [g.platform, g.preset, g.count])).toEqual([['cpu-d3', '8vcpu-32gb', 0], ['gpu-l40s-a', '1gpu-8vcpu-32gb', 1]]);
  });
});

describe('run-profile node counts in the calculator (#27)', () => {
  it('a profile fixes the GPU node count: expected and max are its count, min no higher', () => {
    // Before: max stayed at 4 (Math.max) with l40s-gpu-only (1 node) and warned above the sandbox cap of 2.
    expect(profileNodeCounts({ min: '0', expected: '2', max: '4' }, 1)).toEqual({ min: '0', expected: '1', max: '1' });
    expect(profileNodeCounts({ min: '3', expected: '3', max: '4' }, 1)).toEqual({ min: '1', expected: '1', max: '1' });
    expect(profileNodeCounts({ min: 'x', expected: '', max: '' }, 2)).toEqual({ min: '0', expected: '2', max: '2' });
  });
});

describe('a quota line in words and units (#43)', () => {
  const ql = (name: string, need: number, limit: number, usage: number, state: 'ok' | 'blocked' | 'exceeded') => ({ quota: name, need, limit, usage, state, short: Math.max(0, usage + need - limit), what: '' });
  it('sizes in GiB / TiB, vCPU and GPUs by name, counts as numbers', () => {
    expect(quotaLineText(ql('compute.disk.size.network-ssd', 4373, 4096, 0, 'exceeded'), 'eu-north1')).toBe('in use 0 GiB + needs 4.27 TiB > limit 4 TiB in eu-north1');
    expect(quotaLineText(ql('compute.instance.non-gpu.vcpu', 16, 0, 0, 'blocked'), 'eu-north1')).toBe('needs 16 vCPU, limit 0 in eu-north1');
    expect(quotaLineText(ql('compute.instance.gpu.h100', 16, 8, 2, 'exceeded'), 'eu-north1')).toBe('in use 2 GPUs + needs 16 GPUs > limit 8 GPUs in eu-north1');
    expect(quotaLineText(ql('compute.instance.count', 3, 12, 11, 'exceeded'), 'eu-north1')).toBe('in use 11 + needs 3 > limit 12 in eu-north1');
  });
});
