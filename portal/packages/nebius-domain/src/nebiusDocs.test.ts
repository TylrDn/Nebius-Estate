import { readFileSync } from 'fs';
import { resolve } from 'path';
import { DOCS_SECTIONS, docsCoverage, docsSection, docsUrl, recipeKeyPages } from './nebiusDocs';

const catalog = JSON.parse(readFileSync(resolve(__dirname, '../../../../docs/reference/nebius-docs.json'), 'utf8'));
const sections = Object.entries(catalog.sections as Record<string, { pages: number; reference_only: boolean }>).map(([name, s]) => ({ name, pages: s.pages, referenceOnly: s.reference_only }));
const cap = (id: string, state = 'ok') => ({ id, state } as any);

describe('coverage stated against the Nebius docs catalog (W1-P26)', () => {
  it('classifies every section of the committed catalog: a new docs section fails here before it reads as covered', () => {
    expect(sections.length).toBeGreaterThan(20);
    expect(sections.filter(s => !DOCS_SECTIONS[s.name]).map(s => s.name)).toEqual([]);
  });

  it('says how many service sections are read, and names each one not read with its reason and impact', () => {
    const caps = ['compute.instances', 'capacity.allowances', 'mk8s.clusters', 'vpc.networks', 'storage.buckets', 'registry.registries', 'msp.postgresql', 'msp.mlflow', 'ai.endpoints', 'tunnel.tunnels', 'kms.symmetric-keys', 'mysterybox.secrets', 'iam.projects', 'quotas.allowances', 'billing.calculator', 'monitoring.gpu', 'audit.events.list', 'k8s.cluster:mk8scluster-e00mockinf'].map(id => cap(id));
    const { rows, summary } = docsCoverage(sections, [...caps, cap('logs.labels', 'unreachable')], { soperatorClusterIds: ['mk8scluster-e00mockinf'] });
    expect(summary).toBe('Reads 17 of 18 service sections of the Nebius docs catalog; not read: applications.');
    const apps = rows.find(r => r.section === 'applications')!;
    expect(apps).toMatchObject({ state: 'not-read', reason: 'The portal makes no call for applications.' });
    expect(apps.impact).toMatch(/Standalone applications are not listed/);
    // Observability counts as read while Monitoring answers, with the failing logs call among its calls.
    expect(rows.find(r => r.section === 'observability')!.calls).toEqual({ ok: 1, total: 2, ids: ['monitoring.gpu', 'logs.labels'] });
    expect(rows.find(r => r.section === 'cli')!.state).toBe('reference');
  });

  it('a service whose calls all fail, or that has no call here, is not counted as read', () => {
    const { rows, summary } = docsCoverage(
      sections.filter(s => ['vpc', 'kms', 'cli'].includes(s.name)),
      [cap('vpc.networks', 'permission-denied'), cap('vpc.subnets', 'permission-denied')],
    );
    expect(rows.find(r => r.section === 'vpc')).toMatchObject({ state: 'failing', reason: 'Called, none answered at the last sync (permission denied).' });
    expect(rows.find(r => r.section === 'kms')).toMatchObject({ state: 'not-read' });
    // A call that answered in a drifted shape still reads the service.
    expect(docsCoverage(sections.filter(s => s.name === 'tunnels'), [cap('tunnel.tunnels', 'schema-drift')]).rows[0].state).toBe('read');
    expect(summary).toBe('Reads 0 of 2 service sections of the Nebius docs catalog; not read: kms, vpc.');
  });

  it('Slurm (Soperator) is read only through a Soperator cluster\'s own call, never through any Managed Kubernetes cluster', () => {
    const slurm = sections.filter(s => s.name === 'slurm-soperator');
    const k8s = [cap('k8s.cluster:mk8scluster-e00mockinf'), cap('k8s.cluster:mk8scluster-e00mocktrn'), cap('k8s.cluster:mk8scluster-e00mocksop', 'waiting')];
    // No Soperator cluster in scope: not read, though two other clusters answer.
    expect(docsCoverage(slurm, k8s).rows[0]).toMatchObject({ state: 'not-read', calls: { ok: 0, total: 0, ids: [] }, reason: 'No Soperator cluster in scope.' });
    expect(docsCoverage(slurm, k8s, { soperatorClusterIds: [] }).rows[0].state).toBe('not-read');
    // A Soperator cluster still provisioning: called, not answering; the other clusters' answers do not count.
    expect(docsCoverage(slurm, k8s, { soperatorClusterIds: ['mk8scluster-e00mocksop'] }).rows[0]).toMatchObject({ state: 'failing', calls: { ok: 0, total: 1, ids: ['k8s.cluster:mk8scluster-e00mocksop'] } });
    expect(docsCoverage(slurm, [...k8s.slice(0, 2), cap('k8s.cluster:mk8scluster-e00mocksop')], { soperatorClusterIds: ['mk8scluster-e00mocksop'] }).rows[0]).toMatchObject({ state: 'read', calls: { ok: 1, total: 1 } });
    // Kubernetes itself still counts every cluster.
    expect(docsCoverage(sections.filter(s => s.name === 'kubernetes'), k8s).rows[0].calls).toMatchObject({ ok: 2, total: 3 });
  });

  it('paths, sections and URLs', () => {
    expect(docsSection('/compute/clusters/gpu')).toBe('compute');
    expect(docsSection('/')).toBe('/');
    expect(docsUrl('/overview/quotas', 'change-quotas')).toBe('https://docs.nebius.com/overview/quotas#change-quotas');
    // Recipes link the key pages that name them (the committed catalog).
    expect(recipeKeyPages(catalog.key_pages, 'R3').map((k: { path: string }) => k.path)).toEqual(expect.arrayContaining(['/compute/clusters/gpu', '/kubernetes']));
    expect(recipeKeyPages([{ path: '/a', why: 'x (R12)' }], 'R1')).toEqual([]);
  });
});
