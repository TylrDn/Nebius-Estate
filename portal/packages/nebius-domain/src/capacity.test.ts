import type { QuotaAllowanceView } from './api';
import { ALLOWANCE_VERDICT, checkAllowances, nearLimitCheck, nearLimitText, checkAvailability, fmtQuotaAmount, checkPlannedFootprint, checkQuotas, effectiveQuota, gpuQuotaModel, nodeCountState, plannedQuotaOptions, quotaRequirements, reconcileTenantUsage, reservationElsewhereText, reservationEvidence, reservationGapText, usageAboveLimitText } from './capacity';

const fp = {
  nodeGroups: [
    { name: 'system', role: 'system' as const, platform: 'cpu-d3', preset: '8vcpu-32gb', count: 2, bootDiskGib: 100 },
    { name: 'gpu', role: 'gpu' as const, platform: 'gpu-h100-sxm', preset: '1gpu-16vcpu-200gb', count: 1, bootDiskGib: 200 },
  ],
  filesystemGib: 1024,
  extraSsdGib: 0,
  ioM3Gib: 0,
  objectStorageGib: 0,
  publicIps: 1,
};

describe('quota checks of a planned footprint', () => {
  it('derives the allowances a footprint draws on, by the names the quotas API uses', () => {
    expect(gpuQuotaModel('gpu-l40s-a')).toBe('l40s');
    expect(quotaRequirements(fp)).toEqual([
      { quota: 'compute.instance.non-gpu.vcpu', need: 16, what: '2 × 8vcpu-32gb system' },
      { quota: 'compute.instance.gpu.h100', need: 1, what: '1 × 1gpu-16vcpu-200gb gpu' },
      { quota: 'compute.instance.count', need: 3, what: '3 VMs' },
      { quota: 'compute.disk.size.network-ssd', need: 400, what: '400 GiB of boot and extra disks' },
      { quota: 'compute.filesystem.size.network-ssd', need: 1024, what: '1024 GiB of shared filesystems' },
    ]);
    // Names as the live API lists them (2026-10-11); a GPU cluster when the plan forms one.
    expect(quotaRequirements(fp, { gpuCluster: true }).at(-1)).toEqual({ quota: 'compute.gpucluster.count', need: 1, what: 'GPU cluster (InfiniBand fabric)' });
  });

  it('G5.3: a provisioned recipe that creates a Managed Kubernetes cluster checks mk8s.cluster.count (limit 2 in eu-north1 live)', () => {
    expect(quotaRequirements(fp, { mk8sClusters: 1 })).toContainEqual({ quota: 'mk8s.cluster.count', need: 1, what: 'Managed Kubernetes cluster' });
    expect(quotaRequirements(fp).map(r => r.quota)).not.toContain('mk8s.cluster.count'); // planned roots: the cluster may exist already
    const used = checkQuotas(fp, 'eu-north1', [{ name: 'mk8s.cluster.count', region: 'eu-north1', limit: 2, usage: 2 }], { mk8sClusters: 1 });
    expect(used.lines).toEqual([expect.objectContaining({ quota: 'mk8s.cluster.count', state: 'exceeded', short: 1 })]);
    // Without such an allowance it is listed as not checked, never assumed within limits.
    expect(checkQuotas(fp, 'eu-north1', [], { mk8sClusters: 1 }).unchecked.map(u => u.quota)).toContain('mk8s.cluster.count');
  });

  it('a limit of 0 blocks, usage + need over the limit exceeds, and a missing allowance is not assumed ok', () => {
    const quotas = [
      { name: 'compute.instance.non-gpu.vcpu', region: 'eu-north1', limit: 0, usage: 0 },
      { name: 'compute.instance.gpu.h100', region: 'eu-north1', limit: 32, usage: 2 },
      { name: 'compute.instance.count', region: 'eu-north1', limit: 12, usage: 11 },
      { name: 'compute.disk.size.network-ssd', region: 'eu-north1', limit: 20 * 2 ** 40, usage: 0, unit: 'byte' },
      { name: 'compute.instance.gpu.h100', region: 'us-central1', limit: 0, usage: 0 },
    ];
    const r = checkQuotas(fp, 'eu-north1', quotas);
    expect(r.lines.map(l => [l.quota, l.state])).toEqual([
      ['compute.instance.non-gpu.vcpu', 'blocked'],
      ['compute.instance.gpu.h100', 'ok'],
      ['compute.instance.count', 'exceeded'],
      ['compute.disk.size.network-ssd', 'ok'],
    ]);
    expect(r.lines.find(l => l.quota === 'compute.disk.size.network-ssd')!.limit).toBe(20 * 1024); // bytes read as GiB
    expect(checkQuotas(fp, 'eu-north1', quotas.slice(1)).unchecked.map(u => u.quota)).toEqual(['compute.instance.non-gpu.vcpu', 'compute.filesystem.size.network-ssd']);
  });
});

describe('capacity type and quota semantics', () => {
  it('preemptible GPU VMs draw on compute.instance.preemptible.count, not the GPU quota (regular VMs only)', () => {
    const req = quotaRequirements(fp, { capacityType: 'preemptible' });
    expect(req.find(r => r.quota === 'compute.instance.gpu.h100')).toBeUndefined();
    expect(req.find(r => r.quota === 'compute.instance.preemptible.count')).toEqual({ quota: 'compute.instance.preemptible.count', need: 1, what: '1 × 1gpu-16vcpu-200gb gpu (preemptible)' });
    // System nodes stay on-demand.
    expect(req.find(r => r.quota === 'compute.instance.non-gpu.vcpu')?.need).toBe(16);
  });

  it('reserved GPU VMs draw on their reservation, not the GPU quota', () => {
    expect(quotaRequirements(fp, { capacityType: 'reserved' }).map(r => r.quota)).not.toContain('compute.instance.gpu.h100');
  });

  it('reports how far short each line is', () => {
    const r = checkQuotas(fp, 'eu-north1', [
      { name: 'compute.instance.count', region: 'eu-north1', limit: 12, usage: 11 },
      { name: 'compute.instance.non-gpu.vcpu', region: 'eu-north1', limit: 0, usage: 0 },
    ]);
    expect(r.lines.find(l => l.quota === 'compute.instance.count')).toMatchObject({ state: 'exceeded', short: 2 });
    expect(r.lines.find(l => l.quota === 'compute.instance.non-gpu.vcpu')).toMatchObject({ state: 'blocked', short: 16 });
  });

  it('a project placeholder is judged against the tenant allowance it draws on; a real project cap against itself', () => {
    const base = { scope: 'project' as const, projectId: 'p', name: 'compute.instance.gpu.l40s', region: 'eu-north1', usage: 1, usagePercent: null };
    expect(effectiveQuota({ ...base, allocation: 'inherits-tenant', limit: null, tenant: { limit: 32, usage: 1, usagePercent: null } })).toEqual({ basis: 'tenant', limit: 32, usage: 1 });
    expect(effectiveQuota({ ...base, allocation: 'inherits-tenant', limit: null })).toEqual({ basis: 'tenant-unknown', limit: null, usage: 1 });
    expect(effectiveQuota({ ...base, allocation: 'set', limit: 0 })).toEqual({ basis: 'project', limit: 0, usage: 1 });
    expect(effectiveQuota({ ...base, scope: 'tenant', projectId: '', allocation: 'set', limit: 32 })).toEqual({ basis: 'tenant', limit: 32, usage: 1 });
  });
});

describe('one definition of "blocked by quota" for planned footprints', () => {
  const tenant = (name: string, limit: number, region = 'eu-north1') => ({ scope: 'tenant' as const, name, region, limit, usage: 0 });
  it('takes the capacity type and GPU-cluster need from the stack and its sizing', () => {
    expect(plannedQuotaOptions('inference', { gpu_preemptible: true })).toEqual({ capacityType: 'preemptible', gpuCluster: false });
    expect(plannedQuotaOptions('training', {})).toEqual({ capacityType: 'on-demand', gpuCluster: true });
    expect(plannedQuotaOptions('soperator', {})).toEqual({ capacityType: 'on-demand', gpuCluster: false });
  });
  it('checks tenant allowances of the given region only, and flags a non-GPU vCPU limit 0', () => {
    const quotas = [tenant('compute.instance.non-gpu.vcpu', 0), tenant('compute.instance.non-gpu.vcpu', 512, 'eu-north2'), { scope: 'project' as const, name: 'compute.instance.non-gpu.vcpu', region: 'eu-north1', limit: 64, usage: 0 }];
    const r = checkPlannedFootprint(fp, 'inference', {}, 'eu-north1', quotas);
    expect(r.lines).toEqual([expect.objectContaining({ quota: 'compute.instance.non-gpu.vcpu', state: 'blocked', limit: 0, need: 16 })]);
    expect(checkPlannedFootprint(fp, 'inference', {}, 'eu-north2', quotas).lines).toEqual([expect.objectContaining({ quota: 'compute.instance.non-gpu.vcpu', state: 'ok' })]);
  });
});

describe('availability (capacity advisor) for a request', () => {
  const row = (fabric: string, onDemand: object, preemptible?: object, region = 'eu-north1') => ({ region, fabric, platform: 'gpu-h100-sxm', preset: '8gpu-128vcpu-1600gb', gpus: 8, onDemand, preemptible });
  const advice = [
    row('fabric-3', { level: 'LOW'.toLowerCase(), available: 0, limit: 4 }, { level: 'high', available: 6, limit: 8 }),
    row('fabric-4', { level: 'medium', available: 1, limit: 4 }),
    row('fabric-2', { level: 'high', available: 3, limit: 4 }, undefined, 'us-central1'),
  ];
  const want = { region: 'eu-north1', platform: 'gpu-h100-sxm', preset: '8gpu-128vcpu-1600gb', fabric: 'fabric-3', capacityType: 'on-demand' as const, requested: 2 };
  it('flags a request the advisor cannot meet and names options with room', () => {
    const c = checkAvailability(advice, want);
    expect(c).toMatchObject({ state: 'short', level: 'low', available: 0, limit: 4 });
    expect(c.message).toContain('0 available vs 2 requested');
    expect(c.alternatives).toEqual([
      { region: 'us-central1', fabric: 'fabric-2', capacityType: 'on-demand', level: 'high', available: 3 },
      { region: 'eu-north1', fabric: 'fabric-3', capacityType: 'preemptible', level: 'high', available: 6 },
    ]);
  });
  it('passes a request that fits, and never checks reservations against advice', () => {
    expect(checkAvailability(advice, { ...want, capacityType: 'preemptible' }).state).toBe('ok');
    expect(checkAvailability(advice, { ...want, capacityType: 'reserved' }).state).toBe('not-applicable');
    expect(checkAvailability(advice, { ...want, platform: 'gpu-b300-sxm' }).state).toBe('no-advice');
  });
});

describe('project allowances against the tenant quota (the 2026-10-11 eu-west2 incident)', () => {
  const q = (scope: 'tenant' | 'project', name: string, limit: number | null, extra: Partial<QuotaAllowanceView> = {}): QuotaAllowanceView => ({
    scope, projectId: scope === 'tenant' ? '' : 'project-e00a', name, region: 'eu-west2', allocation: limit === null ? 'inherits-tenant' : 'set', limit, usage: 0, usagePercent: null, ...extra,
  });
  const tenant = [q('tenant', 'compute.instance.count', 12), q('tenant', 'vpc.allocation.count', 1000), q('tenant', 'dns.zone.count', 100), q('tenant', 'mk8s.cluster.count', 2), q('tenant', 'compute.instance.gpu.b300', 0)];

  it('reads caps above the tenant limit as no effect, below as a cap, 0 as a block; equal caps and placeholders are fine', () => {
    const projects = [
      q('project', 'compute.instance.count', 22),
      q('project', 'vpc.allocation.count', 13, { description: 'Allocations' }),
      q('project', 'dns.zone.count', 0),
      q('project', 'mk8s.cluster.count', 2),
      q('project', 'compute.instance.gpu.b300', 0),
      q('project', 'compute.instance.gpu.h100', null),
    ];
    const out = checkAllowances([...tenant, ...projects])!;
    expect(out.map(f => [f.name, f.kind, f.projectLimit, f.tenantLimit])).toEqual([
      ['dns.zone.count', 'zero-cap', 0, 100],
      ['vpc.allocation.count', 'caps-below', 13, 1000],
      ['compute.instance.count', 'no-effect', 22, 12],
    ]);
    expect(out[1]).toMatchObject({ projectId: 'project-e00a', region: 'eu-west2', description: 'Allocations' });
    expect(ALLOWANCE_VERDICT['caps-below']).toMatch(/Intended\?/);
  });

  it('matches by quota and region, and cannot judge without tenant allowances (null, never "all fine")', () => {
    expect(checkAllowances([q('tenant', 'vpc.allocation.count', 1000, { region: 'eu-north1' }), q('project', 'vpc.allocation.count', 13)])).toEqual([]);
    expect(checkAllowances([q('project', 'vpc.allocation.count', 13)])).toBeNull();
  });
});

describe('fmtQuotaAmount', () => {
  it('reads byte quotas as GiB / TiB, as GPU & Capacity shows them, and counts as grouped numbers', () => {
    expect(fmtQuotaAmount(1649267441664, 'bytes')).toBe('1.5 TiB');
    expect(fmtQuotaAmount(5497558138880, 'byte')).toBe('5 TiB');
    expect(fmtQuotaAmount(53687091200, 'bytes')).toBe('50 GiB');
    expect(fmtQuotaAmount(1000, 'count')).toBe('1,000');
    expect(fmtQuotaAmount(13, undefined)).toBe('13');
  });
});

describe('one count of quotas near their limit, for Overview and Capacity (F1.4)', () => {
  const t = (name: string, limit: number, usage: number) => ({ scope: 'tenant' as const, allocation: 'set' as const, projectId: '', name, region: 'eu-north1', limit, usage, usagePercent: limit ? (100 * usage) / limit : null });
  const p = (name: string, limit: number | null, usage: number) => ({ scope: 'project' as const, allocation: limit === null ? ('inherits-tenant' as const) : ('set' as const), projectId: 'project-e00x', name, region: 'eu-north1', limit, usage, usagePercent: limit ? (100 * usage) / limit : null });

  it('judges the tenant allowances when they were read: every one counts, limit 0 apart', () => {
    const c = nearLimitCheck([t('a', 12, 9), t('b', 0, 0), t('c', 8, 7), t('d', 32, 2), p('a', 4, 4), p('e', null, 1)]);
    expect(c.level).toBe('tenant');
    expect(c.judged).toBe(4);
    expect(c.zeroLimit).toBe(1);
    expect(c.near.map(q => q.name)).toEqual(['c']);
    expect(nearLimitText(c)).toBe('1 at ≥ 80 % · 4 tenant quotas with a limit (1 at limit 0)');
  });

  it('falls back to real project caps (placeholders have no limit of their own) and words a zero plainly', () => {
    const c = nearLimitCheck([p('a', 4, 1), p('e', null, 1), p('f', 0, 0)]);
    expect(c).toMatchObject({ level: 'project', judged: 2, zeroLimit: 1, near: [] });
    expect(nearLimitText(c)).toBe('0 at ≥ 80 % · 2 project quotas with a limit (1 at limit 0)');
    expect(nearLimitText(nearLimitCheck([t('a', 12, 1)]))).toBe('0 at ≥ 80 % · 1 tenant quota with a limit');
  });
});

describe('tenant usage reconciled with the projects beneath it (F1.11)', () => {
  const t = (name: string, limit: number, usage: number): QuotaAllowanceView => ({ scope: 'tenant', projectId: '', name, region: 'eu-north1', allocation: 'set', limit, usage, usagePercent: limit ? (100 * usage) / limit : null, unit: 'vcpu' });
  const p = (project: string, name: string, usage: number, region = 'eu-north1'): QuotaAllowanceView => ({ scope: 'project', projectId: project, name, region, allocation: 'inherits-tenant', limit: null, usage, usagePercent: null, unit: 'vcpu' });

  it('a tenant figure below what its projects report takes their sum, keeps what it reported, and is over a limit of 0', () => {
    const out = reconcileTenantUsage([t('compute.instance.non-gpu.vcpu', 0, 0), p('project-e00a', 'compute.instance.non-gpu.vcpu', 48), p('project-e00b', 'compute.instance.non-gpu.vcpu', 8, 'eu-west1')]);
    expect(out[0]).toMatchObject({ usage: 48, limit: 0, usagePercent: null, reportedUsage: 0 });
    // Another region is another quota; project rows are left as they are.
    expect(out.slice(1)).toEqual([p('project-e00a', 'compute.instance.non-gpu.vcpu', 48), p('project-e00b', 'compute.instance.non-gpu.vcpu', 8, 'eu-west1')]);
    expect(usageAboveLimitText(out[0])).toBe('48 in use against a limit of 0: the projects report 48, the tenant 0.');
  });

  it('keeps a tenant figure at or above its projects, and recomputes the share when it changes', () => {
    const same = [t('compute.instance.gpu.h100', 32, 2), p('project-e00a', 'compute.instance.gpu.h100', 2)];
    expect(reconcileTenantUsage(same)).toEqual(same);
    const raised = reconcileTenantUsage([t('compute.instance.count', 12, 9), p('project-e00a', 'compute.instance.count', 6), p('project-e00b', 'compute.instance.count', 6)]);
    expect(raised[0]).toMatchObject({ usage: 12, usagePercent: 100, reportedUsage: 9 });
    expect(usageAboveLimitText(raised[0])).toBeUndefined(); // at the limit, not above it
    expect(usageAboveLimitText(same[0])).toBeUndefined();
  });

  it('counts a quota in use above its limit on both pages, apart from the near-limit count', () => {
    const c = nearLimitCheck(reconcileTenantUsage([t('compute.instance.non-gpu.vcpu', 0, 0), t('compute.instance.count', 12, 1), p('project-e00a', 'compute.instance.non-gpu.vcpu', 48)]));
    expect(c).toMatchObject({ judged: 2, zeroLimit: 1, near: [] });
    expect(c.aboveLimit.map(q => q.name)).toEqual(['compute.instance.non-gpu.vcpu']);
    // The worst state leads; the Overview, which has a row of its own for it, leaves it out of the near-limit words.
    expect(nearLimitText(c)).toBe('1 in use above its limit · 0 at ≥ 80 % · 2 tenant quotas with a limit (1 at limit 0)');
    expect(nearLimitText(c, false)).toBe('0 at ≥ 80 % · 2 tenant quotas with a limit (1 at limit 0)');
  });
});

describe('observed nodes against the node group spec (F1.12)', () => {
  const g = (nodes: number, spec: { fixedNodeCount?: number; autoscaling?: { min: number; max: number } }) => ({ nodes, ...spec });

  it('says complete only when the count is within the spec and at least one node is up', () => {
    expect(nodeCountState(g(2, { fixedNodeCount: 2 }))).toEqual({ state: 'complete', target: 2, missing: 0, extra: 0 });
    expect(nodeCountState(g(1, { autoscaling: { min: 0, max: 2 } }))).toMatchObject({ state: 'complete' });
  });

  it('a group scaled to zero is not "all nodes up"; more nodes than the spec allows is a mismatch; fewer is short', () => {
    expect(nodeCountState(g(0, { autoscaling: { min: 0, max: 2 } }))).toEqual({ state: 'scaled-to-zero', target: 0, missing: 0, extra: 0 });
    expect(nodeCountState(g(3, { fixedNodeCount: 2 }))).toEqual({ state: 'above', target: 2, ceiling: 2, missing: 0, extra: 1 });
    expect(nodeCountState(g(5, { autoscaling: { min: 1, max: 4 } }))).toMatchObject({ state: 'above', ceiling: 4, extra: 1 });
    expect(nodeCountState(g(0, { fixedNodeCount: 3 }))).toEqual({ state: 'short', target: 3, missing: 3, extra: 0 });
    expect(nodeCountState(g(4, {}))).toEqual({ state: 'unknown', missing: 0, extra: 0 });
  });
});

describe('reservations: the block-group list against the allowances and node groups that use one (F1.10)', () => {
  const allowance = { name: 'h100-reserved-eu-north1', capacityBlockGroupId: 'capacityblockgroup-e00mockh100' };
  const reservedGroup = { name: 'nip-staging-training-gpu', capacityType: 'reserved' as const };

  it('an empty list beside an allowance on a block group and a reserved node group is a gap, explained', () => {
    const e = reservationEvidence([], [allowance], [reservedGroup, { name: 'cpu', capacityType: 'on-demand' as const }]);
    expect(e).toEqual({ listed: 0, unlisted: [{ id: 'capacityblockgroup-e00mockh100', allowances: ['h100-reserved-eu-north1'] }], elsewhere: [], reservedNodeGroups: ['nip-staging-training-gpu'], inUse: true });
    expect(reservationGapText(e)).toBe(
      'The reservation list shows none, yet capacity allowance h100-reserved-eu-north1 names reservation capacityblockgroup-e00mockh100 and node group nip-staging-training-gpu runs as reserved. An allowance names it; the list does not show it, and the API does not say why.',
    );
  });

  it('a listed block group is not a gap; with nothing using a reservation there is nothing to explain', () => {
    const listed = reservationEvidence([{ id: 'capacityblockgroup-e00mockh100' }], [allowance], [reservedGroup]);
    expect(listed).toMatchObject({ listed: 1, unlisted: [], inUse: true });
    expect(reservationGapText(listed)).toBeUndefined();
    const none = reservationEvidence([], [], [{ name: 'cpu', capacityType: 'on-demand' }]);
    expect(none).toEqual({ listed: 0, unlisted: [], elsewhere: [], reservedNodeGroups: [], inUse: false });
    expect(reservationGapText(none)).toBeUndefined();
    // Not read: the list cannot contradict anything; the users of a reservation still count.
    expect(reservationEvidence(null, [allowance], [])).toMatchObject({ listed: null, unlisted: [{ id: 'capacityblockgroup-e00mockh100' }], inUse: true });
    expect(reservationGapText(reservationEvidence(null, [allowance], []))).toBeUndefined();
  });

  it('words several users of several reservations', () => {
    const e = reservationEvidence([], [allowance, { name: 'b', capacityBlockGroupId: 'cbg-2' }, { name: 'c', capacityBlockGroupId: 'cbg-2' }], [reservedGroup, { name: 'ng-2', capacityType: 'reserved' }]);
    expect(reservationGapText(e)).toBe(
      'The reservation list shows none, yet capacity allowances h100-reserved-eu-north1, b and c name reservations capacityblockgroup-e00mockh100 and cbg-2 and node groups nip-staging-training-gpu and ng-2 run as reserved. Allowances name them; the list does not show them, and the API does not say why.',
    );
  });

  it('a reserved node group alone: the list does not show its reservation', () => {
    expect(reservationGapText(reservationEvidence([], [], [reservedGroup]))).toBe(
      'The reservation list shows none, yet node group nip-staging-training-gpu runs as reserved. The list does not show its reservation, and the API does not say why.',
    );
  });

  it('under a region filter, a block group the filter hides is not a gap: it is named with its region', () => {
    const hidden = [{ id: 'capacityblockgroup-e00mockh100', name: 'h100-north', region: 'eu-north1' }];
    const e = reservationEvidence([], [allowance], [], { region: 'uk-south1', hidden });
    expect(e).toMatchObject({ listed: 0, unlisted: [], elsewhere: [{ id: 'capacityblockgroup-e00mockh100', region: 'eu-north1', allowances: ['h100-reserved-eu-north1'] }], region: 'uk-south1' });
    expect(reservationGapText(e)).toBeUndefined();
    expect(reservationElsewhereText(e)).toBe(
      'Capacity allowance h100-reserved-eu-north1 names reservation capacityblockgroup-e00mockh100, which is in eu-north1, outside the region filter (uk-south1).',
    );
    expect(reservationElsewhereText(reservationEvidence([], [allowance], []))).toBeUndefined();
  });

  it('under a region filter, a block group no region lists says so, and says the filter is on', () => {
    const e = reservationEvidence([], [allowance], [], { region: 'uk-south1', hidden: [] });
    expect(reservationGapText(e)).toBe(
      'The reservation list shows none in uk-south1, yet capacity allowance h100-reserved-eu-north1 names reservation capacityblockgroup-e00mockh100. An allowance names it; the list shows it in no region, and the API does not say why.',
    );
  });
});
