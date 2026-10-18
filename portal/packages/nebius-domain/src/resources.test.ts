import { attributeWithParents, buildResourceGraph, findOrphanCandidates, lifecycleLabel, ObservedResource } from './resources';

const res = (over: Partial<ObservedResource>): ObservedResource =>
  ({
    uid: `nebius:${over.providerId}`,
    name: over.providerId,
    labels: {},
    status: 'running',
    refs: [],
    spec: {},
    source: { connector: 'nebius', kind: 'nebius-api' },
    observedAt: '2026-10-12T00:00:00Z',
    coverageNotes: [],
    ...over,
  }) as ObservedResource;

describe('explorer graph and status words (F1.21)', () => {
  const resources = [
    res({ providerId: 'project-e00mocka', type: 'project', name: 'nip-sandbox', region: 'eu-north1', projectId: 'project-e00mocka' }),
    res({ providerId: 'project-e00mockb', type: 'project', name: 'nip-staging', region: 'eu-north1', projectId: 'project-e00mockb' }),
    res({ providerId: 'computedisk-e00mock1', type: 'compute-disk', projectId: 'project-e00mocka', region: 'eu-north1' }),
    res({ providerId: 'computedisk-e00mock2', type: 'compute-disk', projectId: 'project-e00mockb', region: 'eu-north1' }),
  ];

  it('names the project a region node belongs to: two projects in eu-north1 are two different groups', () => {
    const regions = buildResourceGraph(resources).nodes.filter(n => n.kind === 'region');
    expect(regions.map(n => [n.label, n.sublabel])).toEqual([
      ['eu-north1', 'nip-sandbox'],
      ['eu-north1', 'nip-staging'],
    ]);
  });

  it('a project node carries the project resource, so a click opens it (W1F.S4)', () => {
    const projects = buildResourceGraph(resources).nodes.filter(n => n.kind === 'project');
    expect(projects.map(n => [n.label, n.uid])).toEqual([
      ['nip-sandbox', 'nebius:project-e00mocka'],
      ['nip-staging', 'nebius:project-e00mockb'],
    ]);
  });

  it('gives container types no lifecycle status, and says "ready" for what holds data rather than runs', () => {
    // A project reads "active" (its API state), never "running" (F1.44); unknown or other states show nothing.
    expect(lifecycleLabel('project', 'running')).toBe('active');
    expect(lifecycleLabel('project', 'unknown')).toBeUndefined();
    expect(lifecycleLabel('tenant', 'running')).toBeUndefined();
    expect(lifecycleLabel('k8s-namespace', 'running')).toBeUndefined();
    expect(lifecycleLabel('compute-disk', 'running')).toBe('ready');
    expect(lifecycleLabel('storage-bucket', 'running')).toBe('ready');
    expect(lifecycleLabel('compute-disk', 'deleting')).toBe('deleting');
    expect(lifecycleLabel('compute-instance', 'running')).toBe('running');
    expect(lifecycleLabel('mk8s-node-group', 'running')).toBe('running');
  });
});

describe('a subnet and pool a deleted managed service left behind (G1.10)', () => {
  const old = '2026-10-11T18:05:29Z';
  const now = new Date('2026-10-12T15:00:00Z');
  const place = { projectId: 'project-e00mocksbx', region: 'eu-north1', createdAt: old };
  const net = res({ ...place, providerId: 'vpcnetwork-e00mocknet', type: 'vpc-network' });
  const subnet = res({ ...place, providerId: 'vpcsubnet-e00mockmanaged', type: 'vpc-subnet', labels: { managed: 'true' }, refs: [{ relation: 'parent', target: net.providerId }] });
  const pool = res({ ...place, providerId: 'vpcpool-e00mockauto', type: 'vpc-pool', labels: { managed: 'true' } });
  const pg = res({ ...place, providerId: 'postgresql-e00mockpg', type: 'postgresql-cluster', refs: [{ relation: 'in-network', target: net.providerId }] });

  it('is attributed to a Nebius managed service, not "unattributed"', () => {
    const a = attributeWithParents(subnet, new Map([[subnet.providerId, subnet]]));
    expect(a.attributed).toBe(false);
    expect(a.managed).toBe('a Nebius managed service (label managed=true)');
  });

  it('is an orphan candidate while no managed service runs in its network, and not once one does', () => {
    const gone = findOrphanCandidates([net, subnet, pool], now);
    expect(gone.map(c => c.uid)).toEqual([subnet.uid, pool.uid]);
    expect(gone[0].reasons[0]).toMatch(/managed=true.*no managed service.*scripts\/leftovers\.sh/);
    expect(findOrphanCandidates([net, subnet, pool, pg], now)).toEqual([]);
  });
});


describe('an unlabelled pool takes the attribution of the subnet or network it is assigned to (#29)', () => {
  const place = { projectId: 'project-e00mockstg', region: 'eu-north1' };
  const subnet = res({ ...place, providerId: 'vpcsubnet-e00mockwl', name: 'nip-staging-workload', type: 'vpc-subnet', labels: { 'nip-stage': 'staging', 'nip-stack': 'network', 'nip-owner': 'platform' } });
  const pool = res({ ...place, providerId: 'vpcpool-e00mockauto', name: 'auto-subnet-pool', type: 'vpc-pool', refs: [{ relation: 'pool-of', target: subnet.providerId }] });
  const all = new Map([subnet, pool].map(r => [r.providerId, r]));

  it('inherits stage, stack and owner from its subnet, and says so', () => {
    expect(attributeWithParents(pool, all)).toMatchObject({ attributed: true, stage: 'staging', stack: 'network', owner: 'platform', inheritedFrom: 'subnet nip-staging-workload' });
  });

  it('its own labels win; a pool of a managed subnet is managed; a pool assigned to nothing stays unattributed', () => {
    const own = res({ ...pool, labels: { 'nip-stack': 'own' } });
    expect(attributeWithParents(own, all)).toMatchObject({ stack: 'own' });
    const managedSubnet = res({ ...subnet, labels: { managed: 'true' } });
    expect(attributeWithParents(pool, new Map([managedSubnet, pool].map(r => [r.providerId, r])))).toMatchObject({ attributed: false, managed: 'a Nebius managed service (label managed=true)' });
    const free = res({ ...pool, refs: [] });
    const freeA = attributeWithParents(free, new Map([[free.providerId, free]]));
    expect(freeA.attributed).toBe(false);
    expect(freeA.managed).toBeUndefined();
  });
});

describe('the graph names the tenant, not its raw id (#26)', () => {
  const disk = res({ providerId: 'computedisk-e00mockt', type: 'compute-disk', projectId: 'project-e00mocka', tenantId: 'tenant-e00mocktest', region: 'eu-north1' });
  it('"Tenant" when the snapshot has no tenant resource, with the id as hover text', () => {
    const t = buildResourceGraph([disk]).nodes.find(n => n.kind === 'tenant')!;
    expect(t).toMatchObject({ label: 'Tenant', hint: 'tenant-e00mocktest' });
  });
  it('the tenant resource name when the snapshot has it', () => {
    const tenant = res({ providerId: 'tenant-e00mocktest', type: 'tenant', name: 'acme-ai' });
    expect(buildResourceGraph([tenant, disk]).nodes.find(n => n.kind === 'tenant')).toMatchObject({ label: 'acme-ai', hint: 'tenant-e00mocktest' });
  });
});
