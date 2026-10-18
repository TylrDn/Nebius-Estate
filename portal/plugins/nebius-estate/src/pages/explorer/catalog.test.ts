import { RESOURCE_TYPES, RELATIONS } from '@internal/nebius-domain';
import type { ResourceView } from '@internal/nebius-domain';
import { attributionView, drawerStatus, keyFields, lookupPointer, matchesTypeFilter, partialCoverageSentences, RELATION_LABELS, relationLabels, SERVICE_GROUPS, serviceOf, shortSummary, ttlText } from './catalog';

const res = (over: Partial<ResourceView>): ResourceView =>
  ({
    uid: `nebius:${over.providerId ?? 'x'}`,
    providerId: 'x',
    type: 'compute-instance',
    name: 'x',
    labels: {},
    status: 'running',
    refs: [],
    spec: {},
    source: { connector: 'nebius-inventory', kind: 'nebius-api' },
    observedAt: '2026-10-11T00:00:00Z',
    coverageNotes: [],
    attribution: { attributed: false, platformDefault: false },
    ttl: { state: 'none' },
    ...over,
  }) as ResourceView;

describe('explorer catalog', () => {
  it('puts every resource type in exactly one service group', () => {
    const listed = SERVICE_GROUPS.flatMap(g => g.types);
    expect([...listed].sort()).toEqual([...RESOURCE_TYPES].sort());
    expect(new Set(listed).size).toBe(listed.length);
  });

  it('labels every relation both ways', () => {
    for (const r of RELATIONS) expect(RELATION_LABELS[r].out && RELATION_LABELS[r].in).toBeTruthy();
  });

  it('filters by one type or by a whole service', () => {
    expect(matchesTypeFilter('vpc-allocation', '')).toBe(true);
    expect(matchesTypeFilter('vpc-allocation', 'vpc-allocation')).toBe(true);
    expect(matchesTypeFilter('vpc-allocation', 'svc:network')).toBe(true);
    expect(matchesTypeFilter('secret', 'svc:network')).toBe(false);
    expect(serviceOf('postgresql-cluster').id).toBe('data');
  });

  it('labels a relation from either side', () => {
    const ip = res({ providerId: 'vpcallocation-1', type: 'vpc-allocation', refs: [{ relation: 'assigned-to', target: 'computeinstance-1' }] });
    const vm = res({ providerId: 'computeinstance-1' });
    expect(relationLabels(ip, vm)).toEqual(['IP assigned to']);
    expect(relationLabels(vm, ip)).toEqual(['has IP allocation']);
    expect(relationLabels(vm, undefined)).toEqual([]);
  });

  it('points at read-only lookups, and never at secret payloads', () => {
    const p = lookupPointer(res({ type: 'secret', providerId: 'mbsec-1', name: 's' }));
    expect(p.rest).toBe('GET /mysterybox/v1/secrets/mbsec-1');
    expect(p.cli).toBe('nebius mysterybox secret get --id mbsec-1');
    expect(p.note).toMatch(/metadata only/i);
    expect(`${p.rest} ${p.cli}`).not.toMatch(/payload/);
    expect(lookupPointer(res({ type: 'k8s-pod', name: 'p', source: { connector: 'k8s', kind: 'kubernetes-api' } })).rest).toBeUndefined();
  });

  it('shows type-specific fields from spec and refs, omitting absent ones', () => {
    const names: Record<string, string> = { 'vpcnetwork-1': 'default-network', 'vpcsubnet-1': 'default-subnet' };
    const resolve = (id: string) => names[id];
    const rt = res({ type: 'vpc-route-table', refs: [{ relation: 'in-network', target: 'vpcnetwork-1' }, { relation: 'routes', target: 'vpcsubnet-1' }], spec: { platformDefault: true } });
    expect(keyFields(rt, resolve)).toEqual([
      ['Network', 'default-network'],
      ['Routes subnets', '1: default-subnet'],
      ['Project default', 'yes (status.default)'],
    ]);
    expect(keyFields(res({ type: 'kms-key', spec: {} }), resolve)).toEqual([]);
    expect(keyFields(res({ type: 'vpc-allocation', spec: { public: true, summary: '203.0.113.7/32 · public' } }), resolve)).toContainEqual(['Assigned to', 'not assigned to an instance']);
    expect(shortSummary(res({ type: 'secret' }))).toBe('metadata only');
  });
});

describe('TTL text', () => {
  it('formats the expiry like every other time on the page, never raw ISO', () => {
    expect(ttlText({ state: 'active', expiresAt: '2026-10-11T10:44:28Z', hoursLeft: 1 })).toBe('2026-10-11 10:44 UTC (active)');
    expect(ttlText({ state: 'expired', expiresAt: '2026-10-11T10:44:28Z' } as any)).toBe('2026-10-11 10:44 UTC (expired)');
    expect(ttlText({ state: 'none' })).toBe('none');
    expect(ttlText({ state: 'invalid', raw: 'soon' })).toBe('invalid: soon');
  });
});

describe('partial coverage callout (W1F.S7)', () => {
  it('one sentence per project, each ending in a full stop', () => {
    const coverage = [
      { connector: 'nebius-inventory', project: { id: 'project-e00mocklegacy', name: 'legacy-research' }, services: [], partial: true, note: 'vpc.networks (403), storage.buckets (403) unavailable' },
      { connector: 'nebius-inventory', project: { id: 'project-e00mocklab' }, services: [], partial: true, note: 'iam.projects unavailable.' },
      { connector: 'nebius-inventory', project: { id: 'project-e00mocksandbox', name: 'nip-sandbox' }, services: [], partial: false },
    ];
    expect(partialCoverageSentences(coverage)).toEqual(['legacy-research: vpc.networks (403), storage.buckets (403) unavailable.', 'project-e00mocklab: iam.projects unavailable.']);
  });
});

describe('attributionView: one wording for the table and the drawer (#46)', () => {
  const managed = 'a Nebius managed service (label managed=true)';
  it('a subnet a managed service created reads "managed" in both, with who manages it, never "unattributed"', () => {
    const v = attributionView(res({ type: 'vpc-subnet', labels: { managed: 'true' }, attribution: { attributed: false, platformDefault: false, managed } }));
    expect(v).toMatchObject({ kind: 'managed', chip: 'managed', sentence: `Managed by ${managed}: not ours to attribute.` });
    // #45: the chip is one short word; who manages it is its hover text.
    expect(v.kind === 'managed' && v.title).toContain(managed);
  });

  it('attributed (own or inherited), a project, a platform default, a service without labels, plainly unattributed', () => {
    expect(attributionView(res({ attribution: { attributed: true, platformDefault: false, stage: 'sandbox', stack: 'inference' } }))).toEqual({ kind: 'attributed', text: 'sandbox / inference' });
    expect(attributionView(res({ attribution: { attributed: true, platformDefault: false, stage: 'sandbox', inheritedFrom: 'cluster c' } }))).toEqual({ kind: 'attributed', text: 'sandbox / no stack', via: 'cluster c' });
    expect(attributionView(res({ type: 'project' })).kind).toBe('project');
    expect(attributionView(res({ type: 'vpc-subnet', attribution: { attributed: false, platformDefault: true } })).kind).toBe('default');
    expect(attributionView(res({ type: 'mlflow-cluster' }))).toMatchObject({ kind: 'unattributed', note: 'the service keeps no labels' });
    expect(attributionView(res({ type: 'storage-bucket' }))).toMatchObject({ kind: 'unattributed', sentence: 'No nip-* labels: unattributed (never inferred from the name).' });
  });
});

describe('attributionView: an unlabelled pool says why (#29)', () => {
  it('a pool assigned to no subnet or network says so, only when the API said so, and never that nothing uses it', () => {
    const v = attributionView(res({ type: 'vpc-pool', refs: [], spec: { assignmentRead: true } }));
    expect(v).toMatchObject({ kind: 'unattributed', note: 'assigned to no subnet or network' });
    // Allocations (ipv4_*.pool_id) and child pools (source_pool_id) can draw from a pool directly; neither is read here.
    expect(v).toMatchObject({ sentence: 'No nip-* labels, and assigned to no subnet or network (status.assignment); allocations or child pools may still use it directly (pool_id / source_pool_id are not read here).' });
    expect((v as { sentence: string }).sentence).not.toMatch(/nothing draws/);
    // No status.assignment in the answer: nothing is claimed about it.
    expect(attributionView(res({ type: 'vpc-pool', refs: [] }))).toEqual({ kind: 'unattributed', sentence: 'No nip-* labels: unattributed (never inferred from the name).' });
  });
  it('a pool whose subnet is unattributed too says which subnet', () => {
    expect(attributionView(res({ type: 'vpc-pool', refs: [{ relation: 'pool-of', target: 'vpcsubnet-e00x' }] }))).toMatchObject({ kind: 'unattributed', sentence: expect.stringMatching(/assigned to vpcsubnet-e00x, which has no nip-\* labels either/) });
  });
});

describe('drawerStatus (#56: a project read "active — ACTIVE")', () => {
  it('leaves out the API state when it only repeats the status word', () => {
    expect(drawerStatus(res({ type: 'project', status: 'running', statusDetail: 'ACTIVE' }))).toBe('active');
    expect(drawerStatus(res({ type: 'compute-instance', status: 'running', statusDetail: 'RUNNING' }))).toBe('running');
  });
  it('keeps an API state that says more, and shows a container API state as such', () => {
    expect(drawerStatus(res({ type: 'compute-instance', status: 'error', statusDetail: 'ERROR: boot disk not found' }))).toBe('error — ERROR: boot disk not found');
    expect(drawerStatus(res({ type: 'tenant', status: 'running', statusDetail: 'ACTIVE' }))).toBe('API state ACTIVE');
    expect(drawerStatus(res({ type: 'tenant', status: 'running' }))).toBeUndefined();
  });
});
