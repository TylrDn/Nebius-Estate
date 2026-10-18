import { MLFLOW_UNPRICED, inventoryLines } from '../commercial/calculator';
import { mapManagedCluster } from './nebius-mappers';

// Live run 2026-10-11 (R12 ml-services): a public PostgreSQL cluster showed as private, because the
// PostgreSQL API carries the flag in spec.config.public_access; MLflow carries it in spec.public_access.
describe('managed clusters: public endpoint flag', () => {
  const ctx = { projectId: 'project-e00mocksandbox', observedAt: '2026-10-11T18:30:00Z' };

  it('reads PostgreSQL public access from spec.config', () => {
    const pg = mapManagedCluster('postgresql-cluster')(
      { metadata: { id: 'postgresql-e00mock', name: 'nip-sandbox-pg' }, spec: { networkId: 'vpcnetwork-e00mock', config: { publicAccess: true } }, status: { phase: 'PHASE_RUNNING' } },
      ctx,
    );
    expect(pg.spec.public).toBe(true);
    const snake = mapManagedCluster('postgresql-cluster')({ metadata: { id: 'postgresql-e00mock2' }, spec: { config: { public_access: false } }, status: {} }, ctx);
    expect(snake.spec.public).toBe(false);
  });

  it('still reads MLflow public access from spec', () => {
    const ml = mapManagedCluster('mlflow-cluster')({ metadata: { id: 'mlflow-e00mock' }, spec: { publicAccess: true }, status: { phase: 'PHASE_RUNNING' } }, ctx);
    expect(ml.spec.public).toBe(true);
  });
});

// The Overview run-rate left managed databases out (2026-10-11). The billing calculator prices a
// PostgreSQL create request from its template (verified live, hosts multiply); it answers HTTP 500
// for MLflow, which is listed as running but unpriced instead of being left out silently.
describe('managed clusters: what the live run-rate prices', () => {
  const ctx = { projectId: 'project-e00mocksandbox', observedAt: '2026-10-11T18:30:00Z' };
  const template = { resources: { platform: 'cpu-e2', preset: '2vcpu-8gb' }, disk: { type: 'network-ssd', size_gibibytes: '96' }, hosts: { count: '2' } };

  it('reads the PostgreSQL template (camelCase or snake_case) into platform, preset, disk and hosts', () => {
    const pg = mapManagedCluster('postgresql-cluster')({ metadata: { id: 'postgresql-e00mock', name: 'nip-sandbox-pg' }, spec: { config: { template } }, status: { phase: 'PHASE_RUNNING' } }, ctx);
    expect(pg.spec).toMatchObject({ platform: 'cpu-e2', preset: '2vcpu-8gb', diskType: 'network-ssd', sizeGib: 96, fixedNodeCount: 2 });
  });

  it('prices a running PostgreSQL cluster with its template; MLflow and a cluster without a template are named as unpriced', () => {
    const map = mapManagedCluster('postgresql-cluster');
    const pg = map({ metadata: { id: 'postgresql-e00mock', name: 'nip-sandbox-pg' }, spec: { config: { template } }, status: { phase: 'PHASE_RUNNING' } }, ctx);
    const bare = map({ metadata: { id: 'postgresql-e00mock2', name: 'nip-sandbox-bare' }, spec: {}, status: { phase: 'PHASE_RUNNING' } }, ctx);
    const stopped = map({ metadata: { id: 'postgresql-e00mock3', name: 'nip-sandbox-stopped' }, spec: { config: { template } }, status: { phase: 'PHASE_STOPPING' } }, ctx);
    const ml = mapManagedCluster('mlflow-cluster')({ metadata: { id: 'mlflow-e00mock', name: 'nip-sandbox-tracking' }, spec: {}, status: { phase: 'PHASE_RUNNING' } }, ctx);
    const { lines, unpriced } = inventoryLines([pg, bare, stopped, ml]);
    const [line] = lines.get('project-e00mocksandbox')!;
    expect(lines.get('project-e00mocksandbox')).toHaveLength(1);
    expect(line.spec).toEqual({
      '@type': 'type.googleapis.com/nebius.msp.postgresql.v1alpha1.CreateClusterRequest',
      metadata: { parentId: 'project-e00mocksandbox', name: 'estimate' },
      spec: { config: { template: { resources: { platform: 'cpu-e2', preset: '2vcpu-8gb' }, disk: { type: 'network-ssd', sizeGibibytes: '96' }, hosts: { count: '2' } } } },
    });
    expect(line.description).toBe('Managed PostgreSQL cpu-e2 · 2vcpu-8gb, 96 GiB, 2 hosts');
    expect(unpriced.get('project-e00mocksandbox')).toEqual([
      'Managed PostgreSQL nip-sandbox-bare: the API answer has no resource template to price',
      `Managed MLflow nip-sandbox-tracking: ${MLFLOW_UNPRICED}`,
    ]);
  });
});

// Live 2026-10-12 (followup 23): after R12 was deleted the portal still priced PostgreSQL (0.149 USD/h) from an old read.
describe('managed clusters: the live run-rate prices only what the latest inventory sync read', () => {
  const template = { resources: { platform: 'cpu-e2', preset: '2vcpu-8gb' }, disk: { type: 'network-ssd', size_gibibytes: '96' }, hosts: { count: '1' } };
  const at = (observedAt: string, name: string) =>
    mapManagedCluster('postgresql-cluster')({ metadata: { id: `postgresql-${name}`, name }, spec: { config: { template } }, status: { phase: 'PHASE_RUNNING' } }, { projectId: 'project-e00mocksandbox', observedAt, capability: 'msp.postgresql' } as any);

  it('a resource last read before the latest sync is named unpriced with its last-seen time, never priced', () => {
    const { lines, unpriced } = inventoryLines([at('2026-10-12T20:18:00Z', 'pg-now'), at('2026-10-12T19:12:00Z', 'pg-old')], '2026-10-12T20:18:00Z');
    expect(lines.get('project-e00mocksandbox')).toHaveLength(1);
    expect(unpriced.get('project-e00mocksandbox')).toEqual(['Managed PostgreSQL pg-old: last seen 2026-10-12 19:12 UTC, not in the latest inventory sync; not priced']);
  });
});
