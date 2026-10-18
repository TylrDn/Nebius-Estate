import { ObservedResource } from '@internal/nebius-domain';
import { scopeFor } from './lib/access';
import { emptyCapacity } from './inventory/nebius';
import { capacity, overview, scopeSnapshot, serverlessReadAt } from './views';

// Followups 13 and 53: a figure is as old as the lists it is built from. The snapshot time moves on every sync, a fast
// re-sync included, while slow-tier lists are read on full syncs only and the fast re-sync reads three lists.
const all = scopeFor([{ name: 'all', principals: ['user:default/x'], permissions: ['*'], projects: ['*'] }], ['user:default/x']);
const res = (providerId: string, type: ObservedResource['type'], over: Partial<ObservedResource> = {}): ObservedResource => ({
  uid: `nebius:${providerId}`, providerId, type, name: providerId, projectId: 'project-e00mocka', labels: {}, status: 'running', refs: [], spec: {},
  source: { connector: 'nebius-inventory', kind: 'nebius-api' }, observedAt: '2026-10-13T10:00:00Z', coverageNotes: [], ...over,
});
const cap = (id: string, lastSuccess: string, over: object = {}) => ({ id, title: id, service: id.split('.')[0], connector: 'nebius-inventory', scope: 'project', path: '', method: 'GET', state: 'ok', lastSuccess, ...over }) as any;
const statuses = [{ id: 'nebius-inventory', title: 't', state: 'ok' as const, scope: '', permissions: '', services: [], staleAfterMinutes: 45, missingCoverage: [], setup: '', lastSuccess: '2026-10-13T10:05:00Z' }];
const capabilities = [
  cap('compute.instances', '2026-10-13T10:05:00Z'),
  cap('mk8s.clusters', '2026-10-13T10:05:00Z'),
  cap('mk8s.node-groups', '2026-10-13T10:05:00Z'),
  cap('compute.disks', '2026-10-13T10:00:00Z'),
  cap('vpc.networks', '2026-10-13T09:15:00Z'), // slow tier: last full sync
  cap('ai.endpoints', '2026-10-13T10:00:00Z'),
  cap('ai.jobs', '2026-10-13T10:00:30Z'),
  cap('quotas.allowances', '2026-10-13T10:00:00Z'),
  cap('billing.pricing-policies', undefined as any, { state: 'invalid-request' }), // never answered: no read time to count
];
const snap = (resources: ObservedResource[]) =>
  scopeSnapshot({ resources, coverage: [], kube: [], capabilities, capacity: emptyCapacity(), statuses, observedAt: '2026-10-13T10:05:00Z', inventoryReadAt: '2026-10-13T10:00:00Z' }, all);
const repo = { liveRoots: [], regions: { regions: {} } } as any;

describe('read times of the remaining full-sync-only figures (followup 13)', () => {
  it('the Overview\'s TTL-expired and orphan counts span every inventory list: as of the oldest list read, not the last fast re-sync', () => {
    const o = overview(snap([res('project-e00mocka', 'project'), res('vpcnetwork-e00mock', 'vpc-network')]), repo, new Date('2026-10-13T10:06:00Z'), { telemetryAllowed: true, pendingRequests: null });
    expect(o.ttlExpired.observedAt).toBe('2026-10-13T09:15:00Z');
    expect(o.orphanCandidates.observedAt).toBe('2026-10-13T09:15:00Z');
  });

  it('the Serverless lists on AI services are as of their own read, not the snapshot time', () => {
    expect(serverlessReadAt(snap([]))).toBe('2026-10-13T10:00:00Z');
  });
});

describe('Capacity: the node-group table says as of when, also when it is empty (followup 53)', () => {
  it('carries the node-group and cluster lists\' read time', () => {
    expect(capacity(snap([res('project-e00mocka', 'project')]), true).nodeGroupsObservedAt).toBe('2026-10-13T10:05:00Z');
  });
});

describe('empty states are as of the list that answered (Wave 1 verification: live empty tiles showed no time)', () => {
  // The cluster and VM lists answered at their own times, both before the last fast re-sync (10:05).
  const lists = capabilities.map((c: any) => (c.id === 'mk8s.clusters' ? cap('mk8s.clusters', '2026-10-13T10:02:00Z') : c.id === 'compute.instances' ? cap('compute.instances', '2026-10-13T10:03:00Z') : c));
  const empty = scopeSnapshot(
    { resources: [res('project-e00mocka', 'project')], coverage: [], kube: [], capabilities: lists, capacity: emptyCapacity(), statuses, monitoring: { gpus: [], observedAt: '2026-10-13T10:04:00Z' }, observedAt: '2026-10-13T10:05:00Z', inventoryReadAt: '2026-10-13T10:00:00Z' },
    all,
  );

  it('Overview: GPU demand ("No Kubernetes cluster in scope") is as of the cluster list, GPU utilisation ("No GPUs running") as of the VM list', () => {
    const o = overview(empty, repo, new Date('2026-10-13T10:06:00Z'), { telemetryAllowed: true, pendingRequests: null });
    expect(o.k8sRequestedGpus).toMatchObject({ empty: 'No Kubernetes cluster in scope', observedAt: '2026-10-13T10:02:00Z' });
    expect(o.k8sAllocatableGpus.observedAt).toBe('2026-10-13T10:02:00Z');
    expect(o.gpuUtilization).toMatchObject({ empty: 'No GPUs running', observedAt: '2026-10-13T10:03:00Z' });
  });

  it('Capacity: pod requests and utilisation, empty, carry the same read times', () => {
    const c = capacity(empty, true);
    expect(c.requests).toMatchObject({ empty: 'No Kubernetes cluster in scope', observedAt: '2026-10-13T10:02:00Z' });
    expect(c.utilization).toMatchObject({ empty: 'No GPUs running', observedAt: '2026-10-13T10:03:00Z' });
  });

  it('a list that never answered gives no time and no empty verdict', () => {
    const unread = scopeSnapshot({ resources: [res('project-e00mocka', 'project')], coverage: [], kube: [], capabilities: [], capacity: emptyCapacity(), statuses, observedAt: '2026-10-13T10:05:00Z' }, all);
    expect(overview(unread, repo, new Date('2026-10-13T10:06:00Z'), { telemetryAllowed: true, pendingRequests: null }).gpuUtilization.empty).toBeUndefined();
  });
});
