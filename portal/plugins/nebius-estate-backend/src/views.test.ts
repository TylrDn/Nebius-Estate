import { ObservedResource, summarizeDay } from '@internal/nebius-domain';
import { scopeFor } from './lib/access';
import { EstateSnapshot } from './inventory/types';
import { emptyCapacity, mapQuotaAllowance } from './inventory/nebius';
import { allowanceCheck, capacity, emptyScopeReason, filterResources, gpuSchedulingChecks, graph, instancesListed, kubeStaleReason, narrowSnapshot, overview, plannedQuotaIssues, quotaCheckFor, resourceViews, scopeSnapshot, workloads } from './views';

const res = (providerId: string, projectId: string, type: ObservedResource['type'] = 'mk8s-cluster'): ObservedResource => ({
  uid: `nebius:${providerId}`, providerId, type, name: providerId, projectId, labels: {}, status: 'running', refs: [], spec: {},
  source: { connector: 'nebius-inventory', kind: 'nebius-api' }, observedAt: '2026-10-10T12:00:00Z', coverageNotes: [],
});
const cluster = (name: string, mk8sClusterId?: string, node = `${name}-node`) =>
  ({ name, mk8sClusterId, observedAt: '2026-10-10T12:00:00Z', nodes: [{ name: node, allocatable: {} }], namespaces: [], workloads: [], pvcs: [], events: [] }) as any;

describe('scopeSnapshot', () => {
  const snap: EstateSnapshot = {
    resources: [res('mk8scluster-e00mocka', 'project-e00mocka'), res('mk8scluster-e00mockb', 'project-e00mockb')],
    coverage: [{ connector: 'nebius-inventory', services: [], partial: true, note: 'project-e00mockb: vpc.networks (403) unavailable' }],
    kube: [cluster('a', 'mk8scluster-e00mocka'), cluster('b', 'mk8scluster-e00mockb'), cluster('unmapped')],
    telemetry: { source: 'prometheus', query: 'q', observedAt: '2026-10-10T12:00:00Z', samples: [{ node: 'a-node', gpuUtilPercent: 50 }, { node: 'b-node', gpuUtilPercent: 90 }] },
    capabilities: [],
    capacity: emptyCapacity(),
    statuses: [{ id: 'nebius-inventory', title: 't', state: 'ok', scope: 'project-e00mocka, project-e00mockb', permissions: '', services: [], staleAfterMinutes: 0, missingCoverage: [], setup: '' }],
  };
  const roles = [{ name: 'a', principals: ['user:default/a'], permissions: ['*'], projects: ['project-e00mocka'] }];

  it('keeps Kubernetes clusters and telemetry only through an in-scope MK8s cluster', () => {
    const s = scopeSnapshot(snap, scopeFor(roles, ['user:default/a']));
    expect(s.kube.map(c => c.name)).toEqual(['a']); // an unmapped cluster is visible to unrestricted callers only
    expect(s.telemetry?.samples.map(x => x.node)).toEqual(['a-node']);
  });

  it('masks other projects in connector scopes and coverage notes', () => {
    const s = scopeSnapshot(snap, scopeFor(roles, ['user:default/a']));
    expect(s.statuses[0].scope).toBe('project-e00mocka, project-…');
    expect(s.coverage[0].note).toBe('project-…: vpc.networks (403) unavailable');
  });
});

describe('project quota placeholders draw on the tenant quota', () => {
  const q = (o: object) => ({ name: 'compute.instance.gpu.l40s', region: 'eu-north1', usage: 0, usagePercent: null, ...o }) as any;
  const snap: EstateSnapshot = {
    resources: [res('mk8scluster-e00mocka', 'project-e00mocka')], coverage: [], kube: [], capabilities: [], statuses: [],
    capacity: {
      ...emptyCapacity(),
      quotas: [
        q({ scope: 'tenant', projectId: '', allocation: 'set', limit: 32, usage: 1 }),
        q({ scope: 'project', projectId: 'project-e00mocka', allocation: 'inherits-tenant', limit: null, usage: 1 }),
        q({ scope: 'project', projectId: 'project-e00mocka', allocation: 'inherits-tenant', limit: null, region: 'us-central1' }),
      ],
    },
  };
  it('joins each placeholder to the tenant allowance of its quota and region (unrestricted callers)', () => {
    const s = scopeSnapshot(snap, scopeFor([{ name: 'all', principals: ['user:default/x'], permissions: ['*'], projects: ['*'] }], ['user:default/x']));
    const [, here, elsewhere] = s.capacity.quotas;
    expect(here.tenant).toEqual({ limit: 32, usage: 1, usagePercent: 3.13 });
    expect(elsewhere.tenant).toBeUndefined(); // no tenant allowance read for that region: unknown, never 0
  });
  it('a restricted caller sees placeholders without tenant figures', () => {
    const s = scopeSnapshot(snap, scopeFor([{ name: 'a', principals: ['user:default/a'], permissions: ['*'], projects: ['project-e00mocka'] }], ['user:default/a']));
    expect(s.capacity.quotas.every(x => x.scope === 'project' && x.tenant === undefined)).toBe(true);
  });
  it('a tenant usage below what its projects report takes their sum, for the tenant row and the placeholders (F1.11)', () => {
    const vcpu = (o: object) => q({ name: 'compute.instance.non-gpu.vcpu', unit: 'vcpu', ...o });
    const s = scopeSnapshot(
      { ...snap, capacity: { ...emptyCapacity(), quotas: [vcpu({ scope: 'tenant', projectId: '', allocation: 'set', limit: 0, usage: 0 }), vcpu({ scope: 'project', projectId: 'project-e00mocka', allocation: 'inherits-tenant', limit: null, usage: 48 })] } },
      scopeFor([{ name: 'all', principals: ['user:default/x'], permissions: ['*'], projects: ['*'] }], ['user:default/x']),
    );
    const [tenant, placeholder] = s.capacity.quotas;
    expect(tenant).toMatchObject({ usage: 48, limit: 0, reportedUsage: 0 });
    expect(placeholder.tenant).toEqual({ limit: 0, usage: 48, usagePercent: null });
  });
  it('a project filter keeps the tenant allowances (they bind every project)', () => {
    const s = scopeSnapshot(snap, scopeFor([{ name: 'all', principals: ['user:default/x'], permissions: ['*'], projects: ['*'] }], ['user:default/x']));
    expect(narrowSnapshot(s, { project: 'project-e00mocka' }).capacity.quotas.filter(x => x.scope === 'tenant')).toHaveLength(1);
  });
});

describe('allowance check: real project caps against the tenant quota', () => {
  const q = (o: object) => ({ region: 'eu-west2', usage: 0, usagePercent: null, ...o }) as any;
  const snap: EstateSnapshot = {
    resources: [res('mk8scluster-e00mocka', 'project-e00mocka')], coverage: [], kube: [], capabilities: [], statuses: [],
    capacity: {
      ...emptyCapacity(),
      quotas: [
        q({ scope: 'tenant', projectId: '', name: 'compute.instance.count', allocation: 'set', limit: 12 }),
        q({ scope: 'tenant', projectId: '', name: 'vpc.allocation.count', allocation: 'set', limit: 1000 }),
        q({ scope: 'tenant', projectId: '', name: 'dns.zone.count', allocation: 'set', limit: 100 }),
        q({ scope: 'project', projectId: 'project-e00mocka', name: 'compute.instance.count', allocation: 'set', limit: 22 }),
        q({ scope: 'project', projectId: 'project-e00mocka', name: 'vpc.allocation.count', allocation: 'set', limit: 13 }),
        q({ scope: 'project', projectId: 'project-e00mocka', name: 'dns.zone.count', allocation: 'set', limit: 0 }),
        q({ scope: 'project', projectId: 'project-e00mocka', name: 'mk8s.cluster.count', allocation: 'inherits-tenant', limit: null }),
      ],
    },
  };
  const everyone = scopeFor([{ name: 'all', principals: ['user:default/x'], permissions: ['*'], projects: ['*'] }], ['user:default/x']);
  const own = scopeFor([{ name: 'a', principals: ['user:default/a'], permissions: ['*'], projects: ['project-e00mocka'] }], ['user:default/a']);

  it('lists caps above (no effect), below and at 0 for unrestricted callers, on Capacity too', () => {
    const v = allowanceCheck(scopeSnapshot(snap, everyone));
    expect(v.value?.map(f => `${f.kind}:${f.name}`)).toEqual(['zero-cap:dns.zone.count', 'caps-below:vpc.allocation.count', 'no-effect:compute.instance.count']);
    expect(v.note).toMatch(/placeholder/);
    expect(capacity(scopeSnapshot(snap, everyone), false).allowanceCheck?.value).toHaveLength(3);
  });

  it('is unavailable to project-scoped callers and without tenant allowances (never "all fine")', () => {
    expect(allowanceCheck(scopeSnapshot(snap, own))).toMatchObject({ value: null, unavailableReason: expect.stringMatching(/every project/) });
    const noTenant = { ...snap, capacity: { ...snap.capacity, quotas: snap.capacity.quotas.filter(x => x.scope === 'project') } };
    expect(allowanceCheck(scopeSnapshot(noTenant, everyone))).toMatchObject({ value: null, unavailableReason: expect.stringMatching(/tenant/) });
  });
});

describe('a stage filter narrows quotas, caps and maintenance to the projects and regions it keeps (G1.2)', () => {
  const at = (r: ObservedResource, region: string, labels: Record<string, string> = {}) => ({ ...r, region, labels });
  const q = (o: object) => ({ usage: 0, usagePercent: null, name: 'compute.instance.gpu.h200', ...o }) as any;
  const snap: EstateSnapshot = {
    resources: [
      at(res('project-e00mocksbx', 'project-e00mocksbx', 'project'), 'eu-north1'),
      at(res('project-e00mocklab', 'project-e00mocklab', 'project'), 'uk-south1'),
      at(res('computeinstance-e00mocksbx', 'project-e00mocksbx', 'compute-instance'), 'eu-north1', { 'nip-stage': 'sandbox' }),
      at(res('computedisk-e00mocklab', 'project-e00mocklab', 'compute-disk'), 'uk-south1'),
    ],
    coverage: [], kube: [], capabilities: [], statuses: [],
    capacity: {
      ...emptyCapacity(),
      quotas: [
        q({ scope: 'tenant', projectId: '', region: 'eu-north1', allocation: 'set', limit: 16 }),
        q({ scope: 'tenant', projectId: '', region: 'uk-south1', allocation: 'set', limit: 16 }),
        q({ scope: 'project', projectId: 'project-e00mocksbx', region: 'eu-north1', allocation: 'inherits-tenant', limit: null }),
        q({ scope: 'project', projectId: 'project-e00mocklab', region: 'uk-south1', allocation: 'set', limit: 8 }),
      ],
      capacityAllowances: [{ projectId: 'project-e00mocklab', region: 'uk-south1' } as any],
      maintenances: [{ projectId: 'project-e00mocklab', id: 'm1' } as any],
    },
  };
  const everyone = scopeFor([{ name: 'all', principals: ['user:default/x'], permissions: ['*'], projects: ['*'] }], ['user:default/x']);

  it('drops the other projects\' caps and the other regions\' tenant quotas', () => {
    const all = scopeSnapshot(snap, everyone);
    expect(allowanceCheck(all).value).toHaveLength(1); // the lab cap below the tenant limit
    const sandbox = narrowSnapshot(all, { stage: 'sandbox' });
    expect(sandbox.capacity.quotas.map(x => `${x.scope}:${x.projectId}:${x.region}`)).toEqual(['tenant::eu-north1', 'project:project-e00mocksbx:eu-north1']);
    expect(allowanceCheck(sandbox).value).toEqual([]);
    expect(sandbox.capacity.capacityAllowances).toEqual([]);
    expect(sandbox.capacity.maintenances).toEqual([]);
    // A region filter keeps behaving as before.
    expect(allowanceCheck(narrowSnapshot(all, { region: 'eu-north1' })).value).toEqual([]);
    expect(narrowSnapshot(all, { region: 'uk-south1' }).capacity.maintenances).toHaveLength(1);
  });
});

describe('no tenant allowances: the message names the real cause (F1.33)', () => {
  const tenantCap = (state: string, hint?: string) => ({ id: 'quotas.allowances.tenant', title: 'Quota allowances (tenant)', service: 'quotas', connector: 'nebius-inventory', scope: 'tenant', path: '/quotas/v1/quota-allowances', method: 'GET', state, hint }) as any;
  const placeholder = { scope: 'project', projectId: 'project-e00mocka', name: 'compute.instance.gpu.l40s', region: 'eu-north1', allocation: 'inherits-tenant', limit: null, usage: 0, usagePercent: null } as any;
  const snap = (state: string, hint?: string): EstateSnapshot => ({
    resources: [res('project-e00mocka', 'project-e00mocka', 'project')], coverage: [], kube: [], statuses: [],
    capabilities: [tenantCap(state, hint), { ...tenantCap('ok'), id: 'quotas.allowances', scope: 'project' }],
    capacity: { ...emptyCapacity(), quotas: [placeholder] },
  });
  const everyone = scopeFor([{ name: 'all', principals: ['user:default/x'], permissions: ['*'], projects: ['*'] }], ['user:default/x']);
  const fp = { nodeGroups: [{ name: 'gpu', role: 'gpu', platform: 'gpu-l40s-d', preset: '1gpu-16vcpu-96gb', count: 1, bootDiskGib: 0 }], filesystemGib: 0, extraSsdGib: 0, ioM3Gib: 0, objectStorageGib: 0, publicIps: 0 } as any;

  it('without a tenant id: provisioning step 2, the Overview count and the Capacity footnote say so, not "needs a tenant-level read role"', () => {
    const s = scopeSnapshot(snap('not-configured', 'No tenant id: set nebiusEstate.nebius.tenantId, or read one project first.'), everyone);
    const check = quotaCheckFor(s.capacity.quotas, fp, 'eu-north1', 'on-demand', false, s.capabilities);
    expect(check.reason).toMatch(/tenant id is not known/);
    expect(check.reason).not.toMatch(/tenant-level read role/);
    expect(capacity(s, false).tenantQuotasGap).toMatch(/tenant id is not known/);
    const repo = { liveRoots: [], regions: { regions: {} } } as any;
    const near = overview(s, repo, new Date('2026-10-12T06:00:00Z'), { telemetryAllowed: false, pendingRequests: 0 }).quotasNearLimit;
    expect(near.unavailableReason).toMatch(/tenant id is not known/);
    expect(near.unavailableReason).not.toMatch(/read role/);
  });

  it('a refused tenant list still names the role; one that did not answer says so', () => {
    const denied = scopeSnapshot(snap('permission-denied'), everyone);
    expect(quotaCheckFor(denied.capacity.quotas, fp, 'eu-north1', 'on-demand', false, denied.capabilities).reason).toMatch(/tenant-level read role/);
    const down = scopeSnapshot(snap('unreachable'), everyone);
    expect(capacity(down, false).tenantQuotasGap).toMatch(/did not answer/);
  });

  it('a project-scoped caller is told tenant data is for callers who see every project, not that the list is empty', () => {
    const own = scopeFor([{ name: 'a', principals: ['user:default/a'], permissions: ['*'], projects: ['project-e00mocka'] }], ['user:default/a']);
    const s = scopeSnapshot(snap('ok'), own);
    expect(capacity(s, false).tenantQuotasGap).toMatch(/callers who can see every project/);
    const repo = { liveRoots: [], regions: { regions: {} } } as any;
    const near = overview(s, repo, new Date('2026-10-12T06:00:00Z'), { telemetryAllowed: false, pendingRequests: 0 }).quotasNearLimit;
    expect(near.unavailableReason).toMatch(/callers who can see every project/);
    expect(near.unavailableReason).not.toMatch(/empty/);
  });
});

describe('orphan candidates and attribution of resources Managed Kubernetes creates', () => {
  const now = new Date('2026-10-11T07:00:00Z');
  const repo = { liveRoots: [], recipes: [], platforms: [] } as any;
  const mk8s = { 'mk8s-cluster-id': 'mk8scluster-e00mockinf', 'mk8s-node-group-id': 'mk8snodegroup-e00mockinfgpu' };
  const base = (over: Partial<ObservedResource>): ObservedResource => ({ ...res('x', 'project-e00mocka', 'compute-disk'), ...over });
  const clusterRes = base({ uid: 'nebius:mk8scluster-e00mockinf', providerId: 'mk8scluster-e00mockinf', name: 'nip-sandbox-inference', type: 'mk8s-cluster', labels: { 'nip-stage': 'sandbox', 'nip-env': 'inference' } });
  const ng = base({ uid: 'nebius:mk8snodegroup-e00mockinfgpu', providerId: 'mk8snodegroup-e00mockinfgpu', type: 'mk8s-node-group', refs: [{ relation: 'parent', target: 'mk8scluster-e00mockinf' }] });
  const nodeVm = base({ uid: 'nebius:computeinstance-e00mockngnode0', providerId: 'computeinstance-e00mockngnode0', type: 'compute-instance', labels: mk8s, refs: [{ relation: 'member-of', target: 'mk8snodegroup-e00mockinfgpu' }], createdAt: '2026-10-11T06:11:00Z' });
  const managedBoot = base({ uid: 'nebius:d1', providerId: 'd1', labels: mk8s, spec: { attachments: 0, managedBy: 'mk8snodegroup-e00mockinfgpu' }, createdAt: '2026-10-10T06:11:00Z' });
  const provisioning = base({ uid: 'nebius:d2', providerId: 'd2', status: 'provisioning', spec: { attachments: 0 }, createdAt: '2026-10-09T00:00:00Z' });
  const young = base({ uid: 'nebius:d3', providerId: 'd3', spec: { attachments: 0 }, createdAt: '2026-10-11T06:50:00Z' });
  const loose = base({ uid: 'nebius:d4', providerId: 'd4', spec: { attachments: 0 }, createdAt: '2026-10-11T05:00:00Z' });
  const oldLoose = base({ uid: 'nebius:d5', providerId: 'd5', spec: { attachments: 0 }, createdAt: '2026-10-01T00:00:00Z' });
  const all = [clusterRes, ng, nodeVm, managedBoot, provisioning, young, loose, oldLoose];

  it('never flags managed, provisioning or young disks; a fresh condition needs two consecutive syncs', () => {
    const once = Object.fromEntries(resourceViews(all, repo, now, { all, orphanStreaks: { 'nebius:d4': 1, 'nebius:d5': 1 } }).map(v => [v.providerId, v]));
    expect(once.d1.orphanReasons).toBeUndefined();
    expect(once.d2).toMatchObject({ orphanReasons: undefined, orphanNote: 'provisioning: not evaluated until it settles' });
    expect(once.d3).toMatchObject({ orphanReasons: undefined, orphanNote: 'recently created — not evaluated yet' });
    expect(once.d4).toMatchObject({ orphanReasons: undefined, orphanNote: expect.stringMatching(/on the last sync only/) });
    expect(once.d5.orphanReasons).toEqual(['disk has no attachments']); // long-standing: a restart does not hide it
    const twice = Object.fromEntries(resourceViews(all, repo, now, { all, orphanStreaks: { 'nebius:d4': 2 } }).map(v => [v.providerId, v]));
    expect(twice.d4.orphanReasons).toEqual(['disk has no attachments']);
  });

  it('a node-group VM and its disk take the attribution of their cluster, and are not unattributed', () => {
    const views = Object.fromEntries(resourceViews(all, repo, now, { all }).map(v => [v.providerId, v]));
    expect(views['computeinstance-e00mockngnode0'].attribution).toMatchObject({ attributed: true, stage: 'sandbox', stack: 'inference', inheritedFrom: 'cluster nip-sandbox-inference' });
    expect(views.d1.attribution.inheritedFrom).toBe('cluster nip-sandbox-inference');
    expect(views['mk8snodegroup-e00mockinfgpu'].attribution.inheritedFrom).toBe('cluster nip-sandbox-inference');
    expect(filterResources(all, { attribution: 'unattributed' }).map(r => r.providerId)).toEqual(['d2', 'd3', 'd4', 'd5']);
    expect(filterResources(all, { stage: 'sandbox' }).map(r => r.providerId)).toEqual(['mk8scluster-e00mockinf', 'mk8snodegroup-e00mockinfgpu', 'computeinstance-e00mockngnode0', 'd1']);
  });
});

describe('GPU VMs a cluster does not advertise', () => {
  const r = (providerId: string, type: ObservedResource['type'], over: Partial<ObservedResource> = {}): ObservedResource => ({ ...res(providerId, 'project-e00mocka', type), ...over });
  const resources = [
    r('mk8scluster-e00c', 'mk8s-cluster', { name: 'nip-sandbox-inference' }),
    r('mk8snodegroup-e00g', 'mk8s-node-group', { name: 'ng-gpu', refs: [{ relation: 'parent', target: 'mk8scluster-e00c' }] }),
    r('computeinstance-e00v', 'compute-instance', { spec: { gpus: 1, platform: 'gpu-l40s-a' }, refs: [{ relation: 'member-of', target: 'mk8snodegroup-e00g' }] }),
  ];
  const kube = (gpu: string) => [{ name: 'nip-sandbox-inference', mk8sClusterId: 'mk8scluster-e00c', observedAt: '2026-10-11T07:00:00Z', nodes: [{ name: 'n', instanceId: 'computeinstance-e00v', allocatable: { 'nvidia.com/gpu': gpu } }], namespaces: [], workloads: [], pvcs: [], events: [] }] as any;
  it('names the cluster whose GPU VMs advertise 0 allocatable GPUs', () => {
    expect(gpuSchedulingChecks(resources, kube('0'))).toEqual([{ cluster: 'nip-sandbox-inference', clusterId: 'mk8scluster-e00c', nodeGroups: ['ng-gpu'], gpuVms: 1, gpus: 1, allocatable: 0 }]);
  });
  it('says nothing when the GPUs are advertised, or when the cluster was not read', () => {
    expect(gpuSchedulingChecks(resources, kube('1'))).toEqual([]);
    expect(gpuSchedulingChecks(resources, [])).toEqual([]);
  });
});

describe('one definition of "planned resources blocked by quota"', () => {
  const regionsYaml = {
    regions: {
      'eu-north1': { default: 'gpu-h100-sxm', platforms: { 'gpu-h100-sxm': { single_gpu_preset: '1gpu-16vcpu-200gb', ib_preset: '8gpu-128vcpu-1600gb', fabric: 'fabric-3' }, 'gpu-l40s-a': { single_gpu_preset: '1gpu-8vcpu-32gb' } } },
      'eu-north2': { default: 'gpu-h200-sxm', platforms: { 'gpu-h200-sxm': { single_gpu_preset: '1gpu-16vcpu-200gb', ib_preset: '8gpu-128vcpu-1600gb', fabric: 'fabric-7' } } },
      'uk-south1': { default: 'gpu-b300-sxm', platforms: { 'gpu-b300-sxm': { single_gpu_preset: '1gpu-24vcpu-346gb', ib_preset: '8gpu-192vcpu-2768gb', fabric: 'fabric-9' } } },
    },
    kubernetes_versions: ['1.36'],
  };
  const root = (stage: string, stack: 'inference' | 'training' | 'gpu-vm', sizing: object = {}) => ({ stage, stack, path: `terraform/live/${stage}/${stack}`, sizingFile: 'x', sizing, hasPlanTests: false });
  const repo = { liveRoots: [root('sandbox', 'inference', { gpu_preemptible: true }), root('sandbox', 'training'), root('staging', 'inference')], regions: regionsYaml, stages: { stages: {} } } as any;
  // A run profile names the region the staging inference runs target (platform/profiles/<stack>/<name>.json).
  const profiled = { ...repo, liveRoots: [repo.liveRoots[0], repo.liveRoots[1], { ...repo.liveRoots[2], runRegions: ['eu-north1'] }] };
  const t = (name: string, region: string, limit: number) => ({ scope: 'tenant', allocation: 'set', projectId: '', name, region, limit, usage: 0, usagePercent: null }) as any;
  const quotas = ['eu-north1', 'eu-north2', 'uk-south1'].flatMap(r => [
    t('compute.instance.non-gpu.vcpu', r, r === 'uk-south1' ? 512 : 0),
    t('compute.instance.count', r, r === 'eu-north2' ? 0 : 100),
    t('compute.instance.preemptible.count', r, r === 'eu-north2' ? 0 : 8),
  ]);
  const project = (id: string, region: string) => ({ ...res(id, id, 'project'), region });
  // The sandbox inference root is applied in eu-north1 (its cluster carries the nip-* labels).
  const applied = { ...res('mk8scluster-e00live', 'project-e00en1'), region: 'eu-north1', labels: { 'nip-stage': 'sandbox', 'nip-stack': 'inference' } };
  // Its CPU node group as observed (2 × 8vcpu-32gb): an applied root is checked by what runs (G2.2).
  const nodeGroup = (id: string, spec: ObservedResource['spec']): ObservedResource => ({ ...res(id, 'project-e00en1', 'mk8s-node-group'), region: 'eu-north1', refs: [{ relation: 'parent', target: 'mk8scluster-e00live' }], spec });
  const cpuGroup = nodeGroup('mk8snodegroup-e00livecpu', { platform: 'cpu-d3', preset: '8vcpu-32gb', fixedNodeCount: 2, capacityType: 'on-demand' });
  const snap: EstateSnapshot = {
    resources: [project('project-e00en1', 'eu-north1'), project('project-e00uks1', 'uk-south1'), applied, cpuGroup, { ...res('d-uk', 'project-e00uks1', 'compute-disk'), region: 'uk-south1' }],
    coverage: [], kube: [], capabilities: [], statuses: [], capacity: { ...emptyCapacity(), quotas },
  };
  const all = scopeSnapshot(snap, scopeFor([{ name: 'all', principals: ['user:default/x'], permissions: ['*'], projects: ['*'] }], ['user:default/x']));
  const plans = (v: ReturnType<typeof plannedQuotaIssues>) => [...new Set((v.value ?? []).map(i => `${i.plan}@${i.region}`))].sort();

  it('checks each live root against the region its runs target: where it runs, else its run profile; else region unknown, never blocked (F1.38)', () => {
    const v = plannedQuotaIssues(all, profiled, {}, all.resources);
    expect(plans(v)).toEqual(['terraform/live/sandbox/inference@eu-north1', 'terraform/live/staging/inference@eu-north1']);
    expect(v.value!.every(i => i.quota === 'compute.instance.non-gpu.vcpu' && i.state === 'blocked')).toBe(true);
    expect(v.value!.find(i => i.plan === 'terraform/live/sandbox/inference')?.regionBasis).toBe('observed');
    expect(v.value!.find(i => i.plan === 'terraform/live/staging/inference')?.regionBasis).toBe('profile');
    // Neither applied nor in a run profile: not checked against a fallback region, and said so.
    expect(v.note).toMatch(/Region unknown \(not applied, no run profile\), not checked: sandbox\/training\./);
    expect(v.note).not.toMatch(/else eu-north1/);
    // The finding: every root blocked through the eu-north1 fallback.
    expect(plans(plannedQuotaIssues(all, repo, {}, all.resources))).toEqual(['terraform/live/sandbox/inference@eu-north1']);
  });

  describe('run profiles and applied roots (G2.2)', () => {
    const l40s = { name: 'l40s-gpu-only', region: 'eu-north1', vars: { cpu_node_count: 0, gpu_platform: 'gpu-l40s-a', gpu_preset: '1gpu-8vcpu-32gb', gpu_node_count: 1, gpu_preemptible: true } };
    const tfvars = { cpu_preset: '8vcpu-32gb', cpu_node_count: 2, gpu_node_count: 1, gpu_preemptible: true };

    it('a root not applied yet is checked with its run profile\'s vars over the sizing file, and named by profile', () => {
      const r = { ...root('staging', 'inference', tfvars), runRegions: ['eu-north1'], runProfiles: [l40s] };
      const v = plannedQuotaIssues(all, { ...repo, liveRoots: [r] }, {}, all.resources);
      // One preemptible L40S and no CPU node: no non-GPU vCPU, 1 of 8 preemptible VMs.
      expect(v.value).toEqual([]);
      expect(v.note).toMatch(/Checked: staging\/inference \(eu-north1, profile l40s-gpu-only\)/);
      const cpu = { name: 'with-cpu-nodes', region: 'eu-north1', vars: { cpu_node_count: 2 } };
      const w = plannedQuotaIssues(all, { ...repo, liveRoots: [{ ...r, runProfiles: [l40s, cpu] }] }, {}, all.resources);
      expect(w.value!.map(i => [i.plan, i.profile, i.quota, i.need, i.regionBasis])).toEqual([['terraform/live/staging/inference', 'with-cpu-nodes', 'compute.instance.non-gpu.vcpu', 16, 'profile']]);
    });

    it('an applied root is checked by its observed node groups, not the sizing file', () => {
      const gpuOnly = { ...snap, resources: [...snap.resources.filter(x => x !== cpuGroup), nodeGroup('mk8snodegroup-e00livegpu', { platform: 'gpu-l40s-a', preset: '1gpu-8vcpu-32gb', gpus: 1, fixedNodeCount: 1, capacityType: 'preemptible' })] };
      const s2 = scopeSnapshot(gpuOnly, scopeFor([{ name: 'all', principals: ['user:default/x'], permissions: ['*'], projects: ['*'] }], ['user:default/x']));
      const v = plannedQuotaIssues(s2, { ...repo, liveRoots: [{ ...root('sandbox', 'inference', tfvars), runRegions: ['eu-north1'], runProfiles: [l40s] }] }, {}, s2.resources);
      expect(v.value).toEqual([]);
      expect(v.note).toMatch(/sandbox\/inference \(eu-north1, as observed: 1 × 1gpu-8vcpu-32gb\)/);
      // The observed CPU group (2 × 8vcpu-32gb) against limit 0 is still blocked, on the observed basis.
      const b = plannedQuotaIssues(all, { ...repo, liveRoots: [root('sandbox', 'inference', { cpu_node_count: 0 })] }, {}, all.resources);
      expect(b.value!.map(i => [i.quota, i.need, i.regionBasis])).toEqual([['compute.instance.non-gpu.vcpu', 16, 'observed']]);
    });

    it('checks gpu-vm roots too (R10), with their profile', () => {
      const vm = { ...root('sandbox', 'gpu-vm', {}), runRegions: ['eu-north1'], runProfiles: [{ name: 'l40s-preemptible', region: 'eu-north1', vars: { platform: 'gpu-l40s-a', preset: '1gpu-8vcpu-32gb', preemptible: true } }] };
      const v = plannedQuotaIssues(all, { ...repo, liveRoots: [vm] }, {}, all.resources);
      expect(v.value).toEqual([]);
      expect(v.note).toMatch(/sandbox\/gpu-vm \(eu-north1, profile l40s-preemptible\)/);
      // On-demand H100 by default (no profile): GPU quota not listed here, so nothing is called blocked.
      const noQuota = { ...all, capacity: { ...all.capacity, quotas: all.capacity.quotas.map(q => (q.name === 'compute.instance.preemptible.count' ? { ...q, limit: 0 } : q)) } };
      const z = plannedQuotaIssues(noQuota, { ...repo, liveRoots: [vm] }, {}, all.resources);
      expect(z.value!.map(i => [i.plan, i.profile, i.quota, i.state])).toEqual([['terraform/live/sandbox/gpu-vm', 'l40s-preemptible', 'compute.instance.preemptible.count', 'blocked']]);
    });
  });

  it('respects the global filter: region, project (its region) and stage', () => {
    const north2 = plannedQuotaIssues(narrowSnapshot(all, { region: 'eu-north2' }), profiled, { region: 'eu-north2' }, all.resources);
    // The applied root runs in eu-north1 and staging/inference's run profile targets eu-north1: neither is in this
    // scope. sandbox/training has no run profile: region unknown whatever the filter, never checked in the filter's region.
    expect(plans(north2)).toEqual([]);
    expect(north2.note).toMatch(/Region unknown \(not applied, no run profile\), not checked: sandbox\/training\./);
    expect(north2.note).not.toMatch(/staging\/inference \(eu-north2\)/);
    // The filter's region is the one the profile names: checked there, on the profile's basis.
    const north1 = plannedQuotaIssues(narrowSnapshot(all, { region: 'eu-north1' }), profiled, { region: 'eu-north1' }, all.resources);
    expect(plans(north1)).toEqual(['terraform/live/sandbox/inference@eu-north1', 'terraform/live/staging/inference@eu-north1']);
    expect(north1.value!.find(i => i.plan === 'terraform/live/staging/inference')?.regionBasis).toBe('profile');
    const en1 = plannedQuotaIssues(narrowSnapshot(all, { project: 'project-e00en1' }), profiled, { project: 'project-e00en1' }, all.resources);
    expect(plans(en1)).toEqual(['terraform/live/sandbox/inference@eu-north1', 'terraform/live/staging/inference@eu-north1']);
    const uk = plannedQuotaIssues(narrowSnapshot(all, { project: 'project-e00uks1' }), repo, { project: 'project-e00uks1' }, all.resources);
    expect(uk.value).toEqual([]); // uk-south1 has room
    const staging = plannedQuotaIssues(narrowSnapshot(all, { stage: 'staging' }), profiled, { stage: 'staging' }, all.resources);
    expect(plans(staging)).toEqual(['terraform/live/staging/inference@eu-north1']);
  });

  it('narrowing the scope never raises the blocked count (F1.38 review)', () => {
    const blocked = (f: { region?: string; project?: string; stage?: string }) => plans(plannedQuotaIssues(narrowSnapshot(all, f), profiled, f, all.resources));
    const none = blocked({});
    for (const f of [{ region: 'eu-north1' }, { region: 'eu-north2' }, { region: 'uk-south1' }, { project: 'project-e00en1' }, { project: 'project-e00uks1' }, { stage: 'sandbox' }, { stage: 'staging' }]) {
      const b = blocked(f);
      expect(b.length).toBeLessThanOrEqual(none.length);
      expect(b.every(x => none.includes(x))).toBe(true);
    }
  });

  it('a stage filter narrows the tenant list to the stage\'s regions, yet checks a planned root profiled elsewhere (G1.2)', () => {
    const ukProfile = { ...repo, liveRoots: [{ ...repo.liveRoots[1], runRegions: ['eu-north2'] }] };
    const sandbox = narrowSnapshot(all, { stage: 'sandbox' });
    expect([...new Set(sandbox.capacity.quotas.map(x => x.region))]).toEqual(['eu-north1']);
    const v = plannedQuotaIssues(sandbox, ukProfile, { stage: 'sandbox' }, all.resources, all.capacity.quotas);
    expect(plans(v)).toEqual(['terraform/live/sandbox/training@eu-north2']);
  });

  it('a filtered region without tenant allowance rows says so, not "unavailable … ok" (review)', () => {
    const north3 = { ...all, capacity: { ...all.capacity, quotas: [] }, capabilities: [{ id: 'quotas.allowances.tenant', state: 'ok' } as any] };
    const v = plannedQuotaIssues(north3, profiled, { region: 'eu-west1' }, all.resources);
    expect(v.unavailableReason).toBe('No tenant quota allowance listed for eu-west1');
    expect(v.unavailableReason).not.toMatch(/: ok/);
  });

  it('a project filter with a region the project is not in says the filter selects nothing, not "no allowance" (G2.10)', () => {
    const f = { project: 'project-e00uks1', region: 'eu-north1' };
    const narrowed = narrowSnapshot(all, f);
    const why = emptyScopeReason(all, narrowed, f);
    expect(why).toBe('The filter selects nothing: project-e00uks1 is not in eu-north1 (its region: uk-south1).');
    const withCap = { ...narrowed, capabilities: [{ id: 'quotas.allowances.tenant', state: 'ok' } as any] };
    const c = capacity(withCap, false, { repo: profiled, filter: f, all: all.resources, emptyScope: why });
    expect(c.emptyScope).toBe(why);
    expect(c.plannedQuotaIssues?.unavailableReason).toBe(why);
    expect(c.allowanceCheck?.unavailableReason).toBe(why);
    const o = overview(withCap, profiled, new Date('2026-10-12T12:00:00Z'), { telemetryAllowed: false, pendingRequests: null, emptyScope: why, filter: f, all: all.resources });
    expect(o.plannedQuotaIssues?.unavailableReason).toBe(why);
    // Without a filter to blame, an answered tenant list never prints its state ("…cannot be compared: ok.").
    expect(capacity(withCap, false).allowanceCheck?.unavailableReason).toBe('No tenant quota allowances read, so project caps cannot be compared.');
  });

  it('GET /capacity carries the same check as the Overview for the same scope', () => {
    const narrowed = narrowSnapshot(all, { region: 'eu-north2' });
    const c = capacity(narrowed, false, { repo, filter: { region: 'eu-north2' }, all: all.resources });
    expect(c.plannedQuotaIssues).toEqual(plannedQuotaIssues(narrowed, repo, { region: 'eu-north2' }, all.resources));
  });

  it('a region filter names the block groups it hides, so an allowance on one is not read as an API gap (F1.10)', () => {
    const bg = (id: string, region: string) => ({ id, name: id, region, limit: 8, usage: 8 });
    const withGroups = { ...all, capacity: { ...all.capacity, capacityBlockGroups: [bg('cbg-north', 'eu-north1'), bg('cbg-uk', 'uk-south1')] } };
    const narrowed = narrowSnapshot(withGroups, { region: 'uk-south1' });
    const c = capacity(narrowed, false, { repo, filter: { region: 'uk-south1' }, all: withGroups.resources, allBlockGroups: withGroups.capacity.capacityBlockGroups });
    expect(c.capacityBlockGroups.value!.map(g => g.id)).toEqual(['cbg-uk']);
    expect(c.blockGroupsOutsideFilter).toEqual([{ id: 'cbg-north', name: 'cbg-north', region: 'eu-north1' }]);
    // No filter, or a caller who cannot read the tenant list: nothing to name.
    expect(capacity(withGroups, false, { repo, all: withGroups.resources, allBlockGroups: withGroups.capacity.capacityBlockGroups }).blockGroupsOutsideFilter).toBeUndefined();
  });

  it('a project filter keeps only the tenant allowances of that project\'s regions', () => {
    const q = narrowSnapshot(all, { project: 'project-e00uks1' }).capacity.quotas;
    expect([...new Set(q.map(x => x.region))]).toEqual(['uk-south1']);
  });

  it('flags a live-shaped tenant quota at 7 of 8 (API fraction 0.875) as at 80 % or more', () => {
    const live = mapQuotaAllowance({ metadata: { name: 'compute.instance.preemptible.count' }, spec: { region: 'eu-north1', limit: '8' }, status: { usage: '7', usagePercentage: 0.875 } }, '');
    const low = mapQuotaAllowance({ metadata: { name: 'compute.instance.count' }, spec: { region: 'eu-north1', limit: '8' }, status: { usage: '1', usagePercentage: 0.125 } }, '');
    const s = { ...all, capacity: { ...all.capacity, quotas: [live, low] } };
    const o = overview(s, repo, new Date('2026-10-11T08:00:00Z'), { telemetryAllowed: false, pendingRequests: null });
    expect(o.quotasNearLimit.value?.map(q => [q.name, q.usagePercent])).toEqual([['compute.instance.preemptible.count', 87.5]]);
  });
});

describe('run, TTL, stack and owner inherited from the cluster / node group (live shapes, 2026-10-11)', () => {
  const now = new Date('2026-10-11T11:00:00Z'); // after the 10:44 TTL
  const repo = { liveRoots: [], recipes: [], platforms: [] } as any;
  const ttl = '2026-10-11T10:44:28Z';
  const nip = { 'nip-env': 'inference', 'nip-owner': 'platform', 'nip-region': 'eu-north1', 'nip-stack': 'inference', 'nip-stage': 'sandbox' };
  const r = (providerId: string, type: ObservedResource['type'], over: Partial<ObservedResource> = {}): ObservedResource => ({ ...res(providerId, 'project-e00en1', type), region: 'eu-north1', ...over });
  const mk8sCluster = r('mk8scluster-e00bzp', 'mk8s-cluster', { name: 'nip-sandbox-inference', labels: { ...nip, 'nip-run': 'portal-populate-2026-10-11', 'nip-ttl-expires': ttl } });
  const ng = r('mk8snodegroup-e00rcx', 'mk8s-node-group', { name: 'nip-sandbox-inference-ng-gpu', labels: { ...nip, 'nip-run': 'portal-populate-2026-10-11', 'nip-ttl-expires': ttl }, refs: [{ relation: 'parent', target: 'mk8scluster-e00bzp' }] });
  // The node VM carries the node group's template labels but not nip-run / nip-ttl-expires.
  const vm = r('computeinstance-e00vnt', 'compute-instance', { labels: { 'mk8s-cluster-id': 'mk8scluster-e00bzp', 'mk8s-node-group-id': 'mk8snodegroup-e00rcx', ...nip }, refs: [{ relation: 'member-of', target: 'mk8snodegroup-e00rcx' }], spec: { gpus: 1 } });
  const pvc = r('computedisk-e00pcz', 'compute-disk', {
    name: 'pvc-e2ffa1c5-72b9-4a9c-86a3-a56b8353d5d4',
    labels: { CSIVolumeName: 'pvc-e2ffa1c5', 'compute.csi.nebius.com/cluster': 'true', 'compute.csi.nebius.com/cluster-id': 'mk8scluster-e00bzp', 'k8s.io/mk8scluster-e00bzp': 'owned', 'kubernetes.io/created-for/pvc/name': 'prometheus-server' },
    refs: [{ relation: 'attached-to', target: 'computeinstance-e00vnt' }],
    spec: { attachments: 1 },
  });
  const ip = r('vpcallocation-e00ebh', 'vpc-allocation', { name: 'mk8snodegroup-e00rcx-7vfm8-qg7rz-private-address', refs: [{ relation: 'assigned-to', target: 'computeinstance-e00vnt' }] });
  const loneIp = r('vpcallocation-e00lone', 'vpc-allocation', { name: 'my-ip', refs: [] });
  const all = [mk8sCluster, ng, vm, pvc, ip, loneIp];
  const views = Object.fromEntries(resourceViews(all, repo, now, { all }).map(v => [v.providerId, v]));

  it('the node VM takes run and TTL from its node group, so its TTL is expired with the cluster', () => {
    expect(views['computeinstance-e00vnt'].attribution).toMatchObject({ stack: 'inference', owner: 'platform', run: 'portal-populate-2026-10-11', ttlExpires: ttl, inheritedFrom: 'node group nip-sandbox-inference-ng-gpu' });
    expect(views['computeinstance-e00vnt'].ttl).toMatchObject({ state: 'expired', expiresAt: ttl });
  });

  it('the CSI PVC disk and the node IP allocations inherit from the cluster and are not unattributed', () => {
    expect(views['computedisk-e00pcz'].attribution).toMatchObject({ attributed: true, run: 'portal-populate-2026-10-11', ttlExpires: ttl, inheritedFrom: 'cluster nip-sandbox-inference' });
    expect(views['vpcallocation-e00ebh'].attribution).toMatchObject({ attributed: true, stack: 'inference', ttlExpires: ttl });
    expect(views['vpcallocation-e00ebh'].ttl.state).toBe('expired');
    expect(filterResources(all, { attribution: 'unattributed' }).map(x => x.providerId)).toEqual(['vpcallocation-e00lone']);
  });

  it('the TTL-expired count covers every resource of the expired run', () => {
    expect(Object.values(views).filter(v => v.ttl.state === 'expired').map(v => v.providerId).sort()).toEqual(['computedisk-e00pcz', 'computeinstance-e00vnt', 'mk8scluster-e00bzp', 'mk8snodegroup-e00rcx', 'vpcallocation-e00ebh']);
    expect(summarizeDay(all, now).reduce((a, x) => a + x.ttlExpired, 0)).toBe(5);
  });
});

describe('overview tiles agree while the inventory is starting', () => {
  it('does not report GPU utilisation of "1 GPU" next to "GPUs on running VMs: unavailable"', () => {
    const s = scopeSnapshot(
      {
        resources: [], coverage: [], kube: [], capabilities: [], capacity: emptyCapacity(),
        statuses: [{ id: 'nebius-inventory', title: 't', state: 'starting', scope: '', permissions: '', services: [], staleAfterMinutes: 0, missingCoverage: [], setup: '' }],
        monitoring: { observedAt: '2026-10-11T08:00:00Z', gpus: [{ node: 'n', gpu: '0', instanceId: 'computeinstance-x', projectId: 'p', utilPercent: 0, source: 'Nebius Monitoring' }] } as any,
      },
      scopeFor([{ name: 'all', principals: ['user:default/x'], permissions: ['*'], projects: ['*'] }], ['user:default/x']),
    );
    const o = overview(s, { liveRoots: [], regions: { regions: {} } } as any, new Date('2026-10-11T08:05:00Z'), { telemetryAllowed: true, pendingRequests: null });
    expect(o.gpuInventory.value).toBeNull();
    expect(o.gpuUtilization.value).toBeNull();
    expect(o.gpuUtilization.unavailableReason).toMatch(/inventory/);
  });
});

describe('teardown: a cluster that is deleting, and a VM that left the inventory (walkthrough 2026-10-11 10:56)', () => {
  const now = new Date('2026-10-11T10:59:00Z');
  const repo = { liveRoots: [], regions: { regions: {} } } as any;
  const r = (providerId: string, type: ObservedResource['type'], over: Partial<ObservedResource> = {}): ObservedResource => ({ ...res(providerId, 'project-e00en1', type), observedAt: '2026-10-11T10:56:17Z', ...over });
  const project = r('project-e00en1', 'project', { name: 'default-project-eu-north1' });
  const deleting = r('mk8scluster-e00bzp', 'mk8s-cluster', { name: 'nip-sandbox-inference', status: 'deleting' });
  const ng = r('mk8snodegroup-e00rcx', 'mk8s-node-group', { name: 'ng-gpu', status: 'deleting', refs: [{ relation: 'parent', target: 'mk8scluster-e00bzp' }] });
  const live = r('mk8scluster-e00live', 'mk8s-cluster', { name: 'nip-staging-training' });
  // The last good Kubernetes snapshot of the deleting cluster (18 min old) and a current one of another cluster.
  const kubeOf = (name: string, id: string, gpus: string, over: object = {}) =>
    ({
      name, mk8sClusterId: id, observedAt: '2026-10-11T10:41:00Z', namespaces: ['vllm'], pvcs: [], events: [],
      nodes: [{ name: `${name}-node`, allocatable: { 'nvidia.com/gpu': gpus } }],
      workloads: [{ namespace: 'vllm', name: `${name}-vllm`, kind: 'Deployment', requests: { 'nvidia.com/gpu': gpus }, limits: {}, nodeSelector: {}, tolerations: [], pods: [{ name: 'p', phase: 'Running', node: `${name}-node` }] }],
      ...over,
    }) as any;
  // Nebius Monitoring still answers for the deleted VM for a few minutes after it is gone.
  const gone = { node: 'computeinstance-e00vnt', gpu: 'GPU-0000mock', instanceId: 'computeinstance-e00vnt', projectId: 'project-e00en1', utilPercent: 0, tempC: 27, powerW: 34, source: 'Nebius Monitoring' };
  const statuses = [{ id: 'nebius-inventory', title: 't', state: 'ok' as const, scope: '', permissions: '', services: [], staleAfterMinutes: 45, missingCoverage: [], setup: '', lastSuccess: '2026-10-11T10:56:17Z' }];
  const all = scopeFor([{ name: 'all', principals: ['user:default/x'], permissions: ['*'], projects: ['*'] }], ['user:default/x']);
  const scoped = (kube: any[]) =>
    scopeSnapshot(
      { resources: [project, deleting, ng, live], coverage: [], kube, capabilities: [], capacity: emptyCapacity(), statuses, observedAt: '2026-10-11T10:56:17Z', monitoring: { observedAt: '2026-10-11T10:56:00Z', gpus: [gone] } },
      all,
    );

  it('names why a cluster\'s Kubernetes figures are not current (shared helper)', () => {
    expect(kubeStaleReason(kubeOf('nip-sandbox-inference', 'mk8scluster-e00bzp', '1', { stale: true }), [deleting])).toBe('Cluster is being deleted (inventory 10:56 UTC)');
    expect(kubeStaleReason(kubeOf('x', 'mk8scluster-e00gone', '1', { stale: true }), [deleting])).toBe('Cluster no longer exists in the inventory');
    expect(kubeStaleReason(kubeOf('nip-staging-training', 'mk8scluster-e00live', '2'), [live])).toBeUndefined();
  });

  it('keeps the deleting cluster out of the current Kubernetes tiles, with the reason, and drops the gone VM\'s GPU series', () => {
    const o = overview(scoped([kubeOf('nip-sandbox-inference', 'mk8scluster-e00bzp', '1', { stale: true })]), repo, now, { telemetryAllowed: true, pendingRequests: null });
    expect(o.gpuInventory.value?.gpus).toBe(0);
    expect(o.k8sAllocatableGpus).toMatchObject({ value: null, empty: 'No running Kubernetes cluster', unavailableReason: expect.stringContaining('nip-sandbox-inference: Cluster is being deleted (inventory 10:56 UTC)') });
    expect(o.k8sRequestedGpus).toMatchObject({ value: null, empty: 'No running Kubernetes cluster' });
    expect(o.gpuTelemetry.value).toEqual([]);
    expect(o.gpuUtilization).toMatchObject({ value: null, empty: 'No GPUs running' });
    // Capacity's "Measured utilisation (DCGM)" says the same (walkthrough 3).
    const c = capacity(scoped([kubeOf('nip-sandbox-inference', 'mk8scluster-e00bzp', '1', { stale: true })]), true);
    expect(c.utilization).toMatchObject({ value: null, empty: 'No GPUs running' });
  });

  it('counts only current clusters when one is deleting and another runs, and says what it left out', () => {
    const o = overview(scoped([kubeOf('nip-sandbox-inference', 'mk8scluster-e00bzp', '1', { stale: true }), kubeOf('nip-staging-training', 'mk8scluster-e00live', '2')]), repo, now, { telemetryAllowed: true, pendingRequests: null });
    expect(o.k8sAllocatableGpus).toMatchObject({ value: 2, note: expect.stringContaining('Not counted: nip-sandbox-inference (Cluster is being deleted (inventory 10:56 UTC))') });
    expect(o.k8sRequestedGpus.value).toBe(2);
    const c = capacity(scoped([kubeOf('nip-sandbox-inference', 'mk8scluster-e00bzp', '1', { stale: true }), kubeOf('nip-staging-training', 'mk8scluster-e00live', '2')]), true);
    expect(c.requests.value).toEqual({ requestedGpus: 2, pendingGpuPods: 0 });
  });

  it('exposes the reason on Workloads, and the graph draws no workloads of the deleting cluster', () => {
    const s = scoped([kubeOf('nip-sandbox-inference', 'mk8scluster-e00bzp', '1', { stale: true })]);
    const w = workloads(s);
    expect(w.clusters[0]).toMatchObject({ name: 'nip-sandbox-inference', staleReason: 'Cluster is being deleted (inventory 10:56 UTC)', error: expect.stringContaining('Cluster is being deleted (inventory 10:56 UTC)') });
    expect(graph(s, {}).nodes.filter(n => n.type?.startsWith('k8s-'))).toEqual([]);
    expect(graph(scoped([kubeOf('nip-staging-training', 'mk8scluster-e00live', '2')]), {}).nodes.some(n => n.type === 'k8s-workload')).toBe(true);
  });

  it('GPUs requested by pods count live pods only, never Succeeded or Failed ones (G2.8)', () => {
    const k = kubeOf('nip-staging-training', 'mk8scluster-e00live', '1');
    // A finished GPU Job, and a pod left Failed after its preemptible node was reclaimed, beside the live replacement.
    k.workloads[0].pods = [
      { name: 'done', phase: 'Succeeded', node: 'n' },
      { name: 'reclaimed', phase: 'Failed', node: 'n', reason: 'NodeShutdown' },
      { name: 'live', phase: 'Running', node: 'n' },
      { name: 'waiting', phase: 'Pending', node: null },
    ];
    expect(capacity(scoped([k]), true).requests.value).toEqual({ requestedGpus: 2, pendingGpuPods: 1 });
    expect(overview(scoped([k]), repo, now, { telemetryAllowed: true, pendingRequests: null }).k8sRequestedGpus.value).toBe(2);
  });

  it('GPUs present counts running standalone GPU VMs only, as the Overview does; the card shows each VM\'s status (G2.7)', () => {
    const vm = (id: string, status: ObservedResource['status']) => r(id, 'compute-instance', { name: id, status, spec: { gpus: 1, platform: 'gpu-l40s-a', preset: '1gpu-8vcpu-32gb', capacityType: 'preemptible' } });
    const s = scopeSnapshot(
      { resources: [project, vm('computeinstance-e00mockrun', 'running'), vm('computeinstance-e00mockstart', 'provisioning'), vm('computeinstance-e00mockdel', 'deleting')], coverage: [], kube: [], capabilities: [], capacity: emptyCapacity(), statuses, observedAt: '2026-10-11T10:56:17Z' },
      all,
    );
    const c = capacity(s, true);
    expect(c.gpusPresent.value).toBe(1);
    expect(c.standaloneGpuVms.map(v => [v.name, v.status])).toEqual([
      ['computeinstance-e00mockrun', 'running'],
      ['computeinstance-e00mockstart', 'provisioning'],
      ['computeinstance-e00mockdel', 'deleting'],
    ]);
    expect(overview(s, repo, now, { telemetryAllowed: true, pendingRequests: null }).gpuInventory.value?.gpus).toBe(1);
  });

  it('sums pod restarts and lists waiting reasons on each workload', () => {
    const k = kubeOf('nip-staging-training', 'mk8scluster-e00live', '1');
    k.workloads[0].pods = [
      { name: 'a', phase: 'Running', node: 'n', restarts: 5, waiting: ['CrashLoopBackOff'] },
      { name: 'b', phase: 'Running', node: 'n', restarts: 3, waiting: ['CrashLoopBackOff'] },
      { name: 'c', phase: 'Running', node: 'n' },
    ];
    const row = workloads(scoped([k])).workloads[0];
    expect(row).toMatchObject({ restarts: 8, podIssues: ['CrashLoopBackOff'] });
  });

  it('passes a Job\'s outcome through to its row (followup 16)', () => {
    const k = kubeOf('nip-staging-training', 'mk8scluster-e00live', '1');
    k.workloads[0] = { ...k.workloads[0], kind: 'Job', job: { outcome: 'failed', reason: 'BackoffLimitExceeded', failedPods: 1 } };
    expect(workloads(scoped([k])).workloads[0].job).toEqual({ outcome: 'failed', reason: 'BackoffLimitExceeded', failedPods: 1 });
  });

  it('never calls a VM gone where its project\'s VM list was refused', () => {
    const cap = (perProject: any[]) => [{ id: 'compute.instances', title: 'VMs', service: 'compute', connector: 'nebius-inventory', scope: 'project', path: '', method: 'GET', state: 'permission-denied', perProject }] as any;
    const refused = scopeSnapshot({ resources: [project, deleting, ng, live], coverage: [], kube: [], capacity: emptyCapacity(), statuses, capabilities: cap([{ id: 'project-e00en1', state: 'permission-denied' }, { id: 'project-e00other', state: 'ok' }]), monitoring: { observedAt: '2026-10-11T10:56:00Z', gpus: [gone] } }, all);
    expect(instancesListed(refused)('project-e00en1')).toBe(false);
    expect(instancesListed(refused)('project-e00other')).toBe(true);
    expect(overview(refused, repo, now, { telemetryAllowed: true, pendingRequests: null }).gpuTelemetry.value).toHaveLength(1);
  });

  it('says "nothing running" instead of a setup gap once the inventory has synced', () => {
    const empty = scopeSnapshot({ resources: [project], coverage: [], kube: [], capabilities: [], capacity: emptyCapacity(), statuses, monitoring: { observedAt: '2026-10-11T10:56:00Z', gpus: [] } }, all);
    const o = overview(empty, repo, now, { telemetryAllowed: true, pendingRequests: null });
    expect(o.gpuUtilization).toMatchObject({ value: null, empty: 'No GPUs running' });
    expect(o.k8sAllocatableGpus).toMatchObject({ value: null, empty: 'No Kubernetes cluster in scope' });
    // Only a deleting cluster in scope, never connected: nothing runs, nothing to set up.
    const onlyDeleting = scopeSnapshot({ resources: [project, deleting], coverage: [], kube: [], capabilities: [], capacity: emptyCapacity(), statuses }, all);
    expect(overview(onlyDeleting, repo, now, { telemetryAllowed: true, pendingRequests: null }).k8sRequestedGpus).toMatchObject({ value: null, empty: 'No running Kubernetes cluster', unavailableReason: 'nip-sandbox-inference: Cluster is being deleted (inventory 10:56 UTC).' });
  });
});

// Live 2026-10-12 (followup 13): quota cards stamped the snapshot time, not when quotas were last read.
describe('capacity cards carry their own source time', () => {
  const capStatus = (id: string, lastSuccess?: string, state: 'ok' | 'unreachable' = 'ok') =>
    ({ id, title: id, service: 'quotas', connector: 'nebius-inventory', scope: id.endsWith('.tenant') ? 'tenant' : 'project', path: '/quotas/v1/quota-allowances', method: 'GET', state, lastSuccess }) as any;
  const q = (o: object) => ({ name: 'compute.instance.gpu.l40s', region: 'eu-north1', usage: 0, usagePercent: null, allocation: 'set', limit: 4, ...o }) as any;
  const snapAt = (caps: any[]): EstateSnapshot => ({
    resources: [res('mk8scluster-e00mocka', 'project-e00mocka')], coverage: [], kube: [], statuses: [], capabilities: caps, observedAt: '2026-10-12T20:18:00Z',
    capacity: { ...emptyCapacity(), quotas: [q({ scope: 'tenant', projectId: '' }), q({ scope: 'project', projectId: 'project-e00mocka' })] },
  });
  const all = scopeFor([{ name: 'all', principals: ['user:default/x'], permissions: ['*'], projects: ['*'] }], ['user:default/x']);

  it('quotas show the oldest last success of the quota lists, not the snapshot time', () => {
    const c = capacity(scopeSnapshot(snapAt([capStatus('quotas.allowances', '2026-10-12T19:46:00Z'), capStatus('quotas.allowances.tenant', '2026-10-12T19:12:00Z')]), all), false);
    expect(c.quotas.observedAt).toBe('2026-10-12T19:12:00Z');
  });

  it('a quota list that failed this time keeps its last success as the card time and says the data is from then', () => {
    const c = capacity(scopeSnapshot(snapAt([{ ...capStatus('quotas.allowances', '2026-10-12T19:46:00Z', 'unreachable'), stale: true }, capStatus('quotas.allowances.tenant', '2026-10-12T20:18:00Z')]), all), false);
    expect(c.quotas.observedAt).toBe('2026-10-12T19:46:00Z');
    expect(c.quotas.note).toMatch(/last read 2026-10-12 19:46 UTC/);
  });

  it('capacity allowances and platforms use their own list time too', () => {
    const s = snapAt([capStatus('capacity.allowances', '2026-10-12T18:00:00Z'), capStatus('compute.platforms', '2026-10-12T17:00:00Z')]);
    s.capacity.platforms = [{ name: 'gpu-x', presets: [], projects: ['project-e00mocka'], regions: ['eu-north1'] }];
    s.capacity.capacityAllowances = [{ projectId: 'project-e00mocka', name: 'a', limit: 1, usage: 0, usagePercent: 0 }];
    const c = capacity(scopeSnapshot(s, all), false);
    expect(c.capacityAllowances.observedAt).toBe('2026-10-12T18:00:00Z');
    expect(c.platforms.observedAt).toBe('2026-10-12T17:00:00Z');
  });

  const repo = { liveRoots: [], regions: { regions: {} } } as any;
  const ov = (s: EstateSnapshot) => overview(scopeSnapshot(s, all), repo, new Date('2026-10-12T20:20:00Z'), { telemetryAllowed: false, pendingRequests: null });

  it('the Overview quota tiles and the allowance check use the quota lists\' read time, not the snapshot time', () => {
    const s = snapAt([capStatus('quotas.allowances', '2026-10-12T19:46:00Z'), capStatus('quotas.allowances.tenant', '2026-10-12T19:12:00Z')]);
    s.capacity.quotas = [q({ scope: 'tenant', projectId: '', usage: 4, usagePercent: 100 }), q({ scope: 'project', projectId: 'project-e00mocka', allocation: 'inherits-tenant', limit: null })];
    const o = ov(s);
    expect(o.quotasNearLimit.observedAt).toBe('2026-10-12T19:12:00Z');
    expect(o.quotasAboveLimit?.observedAt).toBe('2026-10-12T19:12:00Z');
    expect(o.allowanceCheck?.observedAt).toBe('2026-10-12T19:12:00Z');
    expect(o.plannedQuotaIssues.observedAt).toBe('2026-10-12T19:12:00Z');
  });

  it('a failed quota read shows on the Overview tiles as on the Capacity card', () => {
    const s = snapAt([{ ...capStatus('quotas.allowances', '2026-10-12T19:46:00Z', 'unreachable'), stale: true }, capStatus('quotas.allowances.tenant', '2026-10-12T20:18:00Z')]);
    s.capacity.quotas = [q({ scope: 'tenant', projectId: '', usage: 4, usagePercent: 100 })];
    const o = ov(s);
    expect(o.quotasNearLimit.observedAt).toBe('2026-10-12T19:46:00Z');
    expect(o.quotasNearLimit.note).toMatch(/latest read failed; last read 2026-10-12 19:46 UTC/);
    expect(o.quotasAboveLimit?.note).toMatch(/latest read failed/);
  });

  it('maintenances (Overview tile and Capacity card) use the maintenance list\'s read time', () => {
    const s = snapAt([{ ...capStatus('maintenance.maintenances', '2026-10-12T19:30:00Z'), service: 'maintenance' }]);
    expect(ov(s).maintenances.observedAt).toBe('2026-10-12T19:30:00Z');
    expect(capacity(scopeSnapshot(s, all), false).maintenances?.observedAt).toBe('2026-10-12T19:30:00Z');
  });
});

describe('resources not read by the latest inventory sync', () => {
  it('are marked with the time they were last seen', () => {
    const fresh = { ...res('postgresqlcluster-e00a', 'project-e00mocka', 'postgresql-cluster'), observedAt: '2026-10-12T20:18:00Z' };
    const old = { ...res('dnszone-e00a', 'project-e00mocka', 'dns-zone'), observedAt: '2026-10-12T19:00:00Z' };
    const kube = { ...res('k8s-x', 'project-e00mocka', 'k8s-namespace'), source: { connector: 'kubernetes:x', kind: 'kubernetes-api' as const }, observedAt: '2026-10-12T19:00:00Z' };
    const repo = { liveRoots: [], recipes: [] } as any;
    const v = resourceViews([fresh, old, kube], repo, new Date('2026-10-12T20:20:00Z'), { inventoryReadAt: '2026-10-12T20:18:00Z' });
    expect(v.map(r => r.lastSeen)).toEqual([undefined, '2026-10-12T19:00:00Z', undefined]);
  });
});
