import { ObservedResource } from '@internal/nebius-domain';
import { scopeFor } from './lib/access';
import { emptyCapacity } from './inventory/nebius';
import { mapKubeObjects } from './inventory/kubernetes';
import { scopeSnapshot, soperatorClusterIds, workloads } from './views';

const all = scopeFor([{ name: 'all', principals: ['user:default/x'], permissions: ['*'], projects: ['*'] }], ['user:default/x']);
const res = (providerId: string, type: ObservedResource['type'], over: Partial<ObservedResource> = {}): ObservedResource => ({
  uid: `nebius:${providerId}`, providerId, type, name: providerId, projectId: 'project-e00mocka', labels: {}, status: 'running', refs: [], spec: {},
  source: { connector: 'nebius-inventory', kind: 'nebius-api' }, observedAt: '2026-10-13T10:00:00Z', coverageNotes: [], ...over,
});
const empty = { deployments: [], statefulsets: [], replicasets: [], jobs: [], pods: [], pvcs: [], events: [] };

// Followup 18: the Workloads page listed no namespaces and no node state; a cordoned, deleting or NotReady node was invisible.
describe('mapKubeObjects: node state', () => {
  const node = (name: string, over: Record<string, any> = {}) => ({ metadata: { name, ...(over.metadata ?? {}) }, spec: over.spec ?? {}, status: { allocatable: {}, ...(over.status ?? {}) } });
  const ready = (status: string) => ({ conditions: [{ type: 'MemoryPressure', status: 'False' }, { type: 'Ready', status }] });

  it('reads Ready from the node condition, cordoned from spec.unschedulable, deleting from metadata.deletionTimestamp', () => {
    const c = mapKubeObjects(
      'c',
      {
        ...empty,
        namespaces: [],
        nodes: [
          node('ok', { status: ready('True') }),
          node('down', { status: ready('False') }),
          node('unknown', { status: ready('Unknown') }),
          node('drained', { spec: { unschedulable: true }, status: ready('True') }),
          node('going', { metadata: { deletionTimestamp: '2026-10-13T09:58:00Z' }, status: ready('True') }),
          node('silent'),
        ],
      },
      { observedAt: 'now' },
    );
    expect(c.nodes.map(n => [n.name, n.ready, n.cordoned, n.deleting])).toEqual([
      ['ok', true, false, false],
      ['down', false, false, false],
      ['unknown', false, false, false],
      ['drained', true, true, false],
      ['going', true, false, true],
      ['silent', undefined, false, false],
    ]);
  });
});

describe('workloads(): namespaces, nodes, the Soperator card and the as-of time', () => {
  const kube = (name: string, mk8sClusterId: string, over: object = {}) =>
    ({
      name, mk8sClusterId, observedAt: '2026-10-13T09:59:00Z', namespaces: ['default', 'inference'], pvcs: [], events: [], workloads: [],
      nodes: [
        { name: 'n0', nodeGroupId: 'mk8snodegroup-e00mockgpu', allocatable: { 'nvidia.com/gpu': '1' }, ready: true, cordoned: false, deleting: false },
        { name: 'n1', allocatable: {}, ready: false, cordoned: true, deleting: false },
      ],
      ...over,
    }) as any;
  const snap = (resources: ObservedResource[], k: any[]) =>
    scopeSnapshot({ resources, coverage: [], kube: k, capabilities: [], capacity: emptyCapacity(), statuses: [], observedAt: '2026-10-13T10:00:00Z', inventoryReadAt: '2026-10-13T10:00:00Z' }, all);
  const inf = res('mk8scluster-e00mockinf', 'mk8s-cluster', { name: 'nip-sandbox-inference' });

  it('lists each cluster\'s namespaces and nodes with their state and GPUs', () => {
    const w = workloads(snap([inf], [kube('nip-sandbox-inference', 'mk8scluster-e00mockinf')]));
    expect(w.clusters[0].namespaces).toEqual(['default', 'inference']);
    expect(w.clusters[0].nodes).toEqual([
      { name: 'n0', nodeGroupId: 'mk8snodegroup-e00mockgpu', gpus: 1, ready: true, cordoned: false, deleting: false },
      { name: 'n1', gpus: 0, ready: false, cordoned: true, deleting: false },
    ]);
  });

  it('names no Soperator cluster when none is in scope, so the page hides the card', () => {
    expect(workloads(snap([inf], [kube('nip-sandbox-inference', 'mk8scluster-e00mockinf')])).soperatorClusters).toEqual([]);
  });

  it('finds a Soperator cluster by its nip-stack label, its name, or a soperator namespace in its Kubernetes snapshot', () => {
    const byLabel = res('mk8scluster-e00mocks1', 'mk8s-cluster', { name: 'slurm-a', labels: { 'nip-stack': 'soperator' } });
    const byName = res('mk8scluster-e00mocks2', 'mk8s-cluster', { name: 'nip-sandbox-soperator', status: 'provisioning' });
    const byNs = kube('nip-sandbox-inference', 'mk8scluster-e00mockinf', { namespaces: ['default', 'soperator-system'] });
    expect(workloads(snap([inf, byLabel, byName], [byNs])).soperatorClusters).toEqual(['nip-sandbox-inference', 'nip-sandbox-soperator', 'slurm-a']);
    // Their cluster ids, for the docs coverage of Slurm (W1-P26); a cluster with nothing Soperator about it is not one.
    expect(soperatorClusterIds(snap([inf, byLabel, byName], [byNs]))).toEqual(['mk8scluster-e00mockinf', 'mk8scluster-e00mocks1', 'mk8scluster-e00mocks2']);
    expect(soperatorClusterIds(snap([inf], [kube('nip-sandbox-inference', 'mk8scluster-e00mockinf')]))).toEqual([]);
  });

  it('gives the inventory\'s read time, so "No Kubernetes cluster in scope" says as of when', () => {
    expect(workloads(snap([], [])).inventoryObservedAt).toBe('2026-10-13T10:00:00Z');
  });

  it('the empty state is as of the cluster list\'s own last read, not the last full sync (followup 53)', () => {
    const s = scopeSnapshot(
      { resources: [], coverage: [], kube: [], capabilities: [{ id: 'mk8s.clusters', title: 'Managed Kubernetes clusters', state: 'ok', lastSuccess: '2026-10-13T09:30:00Z' } as any], capacity: emptyCapacity(), statuses: [], observedAt: '2026-10-13T10:05:00Z', inventoryReadAt: '2026-10-13T10:00:00Z' },
      all,
    );
    expect(workloads(s).inventoryObservedAt).toBe('2026-10-13T09:30:00Z');
  });
});
