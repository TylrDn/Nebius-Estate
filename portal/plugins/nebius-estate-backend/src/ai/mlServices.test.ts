import { ObservedResource } from '@internal/nebius-domain';
import { mlServices } from './mlServices';

// Followup 20: AI services showed no container registry or MLflow; R12 (ml-services) creates both.
describe('AI services: container registries and MLflow', () => {
  const res = (providerId: string, type: ObservedResource['type'], over: Partial<ObservedResource> = {}): ObservedResource => ({
    uid: `nebius:${providerId}`, providerId, type, name: providerId, projectId: 'project-e00mocka', region: 'eu-north1', labels: {}, status: 'running', refs: [], spec: {},
    source: { connector: 'nebius-inventory', kind: 'nebius-api' }, observedAt: '2026-10-13T10:00:00Z', coverageNotes: [], ...over,
  });
  const cap = (id: string, state: string, lastSuccess?: string) => ({ id, title: id === 'msp.mlflow' ? 'Managed MLflow clusters' : 'Container registries', state, lastSuccess, hint: state === 'ok' ? undefined : 'grant viewer' }) as any;

  it('lists registries and MLflow clusters with an Explorer uid, their own read time and the lists\' state', () => {
    const snap = {
      resources: [
        res('registry-e00mockr', 'container-registry', { name: 'nip-sandbox-images', spec: { summary: '12 images' } }),
        res('mlflowcluster-e00mockm', 'mlflow-cluster', { name: 'nip-lab-tracking', statusDetail: 'PHASE_RUNNING', spec: { public: false } }),
        res('postgresql-e00mockp', 'postgresql-cluster'),
      ],
      capabilities: [cap('registry.registries', 'ok', '2026-10-13T10:00:00Z'), cap('msp.mlflow', 'ok', '2026-10-13T09:59:00Z')],
      observedAt: '2026-10-13T10:05:00Z',
    };
    expect(mlServices(snap)).toEqual({
      registries: [{ uid: 'nebius:registry-e00mockr', name: 'nip-sandbox-images', projectId: 'project-e00mocka', region: 'eu-north1', status: 'running', detail: '12 images' }],
      mlflow: [{ uid: 'nebius:mlflowcluster-e00mockm', name: 'nip-lab-tracking', projectId: 'project-e00mocka', region: 'eu-north1', status: 'PHASE_RUNNING', detail: 'private endpoint' }],
      observedAt: '2026-10-13T09:59:00Z',
      listed: 'all',
    });
  });

  it('says which list did not answer, so an empty table is not read as "none"', () => {
    const v = mlServices({ resources: [], capabilities: [cap('registry.registries', 'ok', '2026-10-13T10:00:00Z'), cap('msp.mlflow', 'permission-denied')], observedAt: '2026-10-13T10:05:00Z' });
    expect(v.listed).toBe('partial');
    expect(v.note).toBe('Managed MLflow clusters: permission denied (grant viewer)');
  });

  it('a list with no capability record yet is not read: the page never says "none" on one list\'s answer', () => {
    const v = mlServices({ resources: [], capabilities: [cap('registry.registries', 'ok', '2026-10-13T10:00:00Z')], observedAt: '2026-10-13T10:05:00Z' });
    expect(v.listed).toBe('partial');
    expect(v.note).toBe('Managed MLflow clusters: not read yet');
  });
});
