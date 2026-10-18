import type { AlertInstance } from '@internal/nebius-domain';
import { alertInFilter, alertLinks, alertView } from './router';

const SUMMARY = 'GPU {{ $labels.gpu }}{{ $labels.uuid }} on {{ $labels.Hostname }}{{ $labels.instance_id }} is throttling under load';
const UUID = 'GPU-0000mock-b4af-4c4e-9d0b-1f2e3d4c5b6a';
const rule = { id: 'gpu-health.yaml#GpuThrottling', file: 'gpu-health.yaml', group: 'g', name: 'GpuThrottling', expr: 'x', forSeconds: 300, severity: 'warning', summary: SUMMARY, description: '', checks: [], labels: {}, source: 'nebius', metrics: [] } as any;
const old = (over: Partial<AlertInstance>): AlertInstance => ({
  id: '0123456789abcdef', ruleId: rule.id, ruleName: rule.name, severity: 'warning', source: 'nebius', state: 'resolved',
  labels: { uuid: UUID, instance_id: 'computeinstance-e00vnt' }, projectId: 'project-e00ekw', activeAt: '2026-10-10T08:00:00Z', resolvedAt: '2026-10-10T09:00:00Z',
  lastEvalAt: '2026-10-10T09:00:00Z', value: 1, query: 'q', ...over,
});
const names = new Map([['project-e00ekw', 'default-project-eu-north1']]);
const now = new Date('2026-10-11T12:00:00Z');

describe('alerts stored before the naming change (walkthrough 3)', () => {
  it('title from the stored subject when present: VM name and GPU index, never the UUID', () => {
    const v = alertView(old({ subject: { instanceId: 'computeinstance-e00vnt', instanceName: 'gpu-vm-a', gpu: 'GPU 0', gpuUuid: UUID, projectId: 'project-e00ekw' } }), rule, [], now, names);
    expect(v.summary).toBe('GPU 0 on gpu-vm-a is throttling under load');
  });

  it('without a subject: a short GPU id, never the full UUID', () => {
    const v = alertView(old({}), rule, [], now, names);
    expect(v.summary).toBe('GPU-0000mock on computeinstance-e00vnt is throttling under load');
    expect(v.summary).not.toContain(UUID);
  });

  it('names the project from the inventory when the stored subject has no project name', () => {
    expect(alertView(old({}), rule, [], now, names).subject).toMatchObject({ projectId: 'project-e00ekw', projectName: 'default-project-eu-north1' });
    expect(alertView(old({ subject: { instanceId: 'computeinstance-e00vnt', projectId: 'project-e00ekw' } }), rule, [], now, names).subject).toMatchObject({ projectName: 'default-project-eu-north1' });
    // An alert's own title (set at evaluation) is kept as it is.
    expect(alertView(old({ title: 'Budget b1 crossed 80 %' }), rule, [], now, names).summary).toBe('Budget b1 crossed 80 %');
  });
});

describe('the global filter on alerts: region and stage, not project only (G1.2)', () => {
  const r = (providerId: string, type: string, projectId: string, region: string, labels: Record<string, string> = {}) =>
    ({ uid: `nebius:${providerId}`, providerId, type, name: providerId, projectId, region, labels, status: 'running', refs: [], spec: {}, source: { connector: 'nebius-inventory', kind: 'nebius-api' }, observedAt: '', coverageNotes: [] }) as any;
  const resources = [
    r('project-e00mocksbx', 'project', 'project-e00mocksbx', 'eu-north1'),
    r('project-e00mocklab', 'project', 'project-e00mocklab', 'uk-south1'),
    r('computeinstance-e00mocksbx', 'compute-instance', 'project-e00mocksbx', 'eu-north1', { 'nip-stage': 'sandbox' }),
    r('computeinstance-e00mocklab', 'compute-instance', 'project-e00mocklab', 'uk-south1'),
  ];
  const cap = old({ labels: { quota: 'compute.instance.gpu.b300', region: 'uk-south1' }, projectId: 'project-e00mocklab', state: 'firing' });
  const vm = old({ labels: { instance_id: 'computeinstance-e00mocksbx' }, projectId: 'project-e00mocksbx', state: 'firing' });
  const tenantWide = old({ labels: { connector: 'billing' }, projectId: undefined, state: 'firing' });

  it('drops alerts of another region or of a project the stage does not keep', () => {
    expect(alertInFilter(cap, { region: 'eu-north1' }, resources)).toBe('out');
    expect(alertInFilter(cap, { region: 'uk-south1' }, resources)).toBe('in');
    expect(alertInFilter(cap, { stage: 'sandbox' }, resources)).toBe('out');
    expect(alertInFilter(vm, { stage: 'sandbox' }, resources)).toBe('in'); // region from the VM in the inventory
    expect(alertInFilter(vm, { region: 'uk-south1' }, resources)).toBe('out');
    expect(alertInFilter(cap, { project: 'project-e00mocksbx' }, resources)).toBe('out');
    expect(alertInFilter(cap, {}, resources)).toBe('in');
  });

  it('places a project alert with an empty region label in its project\'s region (G3.2)', () => {
    // The allowance signal writes `region: f.region ?? ''`: an empty label must not keep a uk-south1 project's alert under eu-west1.
    const capNoRegion = old({ labels: { quota: 'compute.instance.gpu.b300', region: '' }, projectId: 'project-e00mocklab', state: 'firing' });
    expect(alertInFilter(capNoRegion, { region: 'eu-west1' }, resources)).toBe('out');
    expect(alertInFilter(capNoRegion, { region: 'uk-south1' }, resources)).toBe('in');
    expect(alertInFilter(capNoRegion, { stage: 'sandbox' }, resources)).toBe('out');
  });

  it('keeps an alert with no region under a region or stage filter, and says so', () => {
    expect(alertInFilter(tenantWide, { region: 'eu-north1' }, resources)).toBe('region-unknown');
    expect(alertInFilter(tenantWide, { stage: 'sandbox' }, resources)).toBe('region-unknown');
  });
});

describe('alert links for a VM that is gone, and a Logs range that reaches the alert (G3.8)', () => {
  const gpuRule = { metrics: ['DCGM_FI_DEV_GPU_UTIL'] };
  const idle = (over: Partial<AlertInstance>) => old({ ruleName: 'GpuIdle', resourceUid: 'nebius:computeinstance-e00vnt', ...over });

  it('drops the Explorer link and marks the Fleet link when the VM is no longer in the inventory', () => {
    const gone = alertLinks(idle({}), gpuRule, { present: () => false, now });
    expect(gone.map(l => l.label)).toEqual(['GPU on the Fleet heat map (VM deleted)', 'Serial-console logs of this VM']);
    const here = alertLinks(idle({}), gpuRule, { present: id => id === 'computeinstance-e00vnt', now });
    expect(here.map(l => l.label)).toEqual(['Open in Explorer', 'GPU on the Fleet heat map', 'Serial-console logs of this VM']);
  });

  it('opens Logs on the smallest range covering the alert since it became active (7 d at most)', () => {
    const logs = (activeAt: string) => alertLinks(idle({ activeAt }), gpuRule, { present: () => true, now }).find(l => l.label.startsWith('Serial'))!.to;
    expect(logs('2026-10-11T11:30:00Z')).toBe('/logs?project=project-e00ekw&bucket=sp_serial&resource=computeinstance-e00vnt&range=1h');
    expect(logs('2026-10-11T07:51:00Z')).toBe('/logs?project=project-e00ekw&bucket=sp_serial&resource=computeinstance-e00vnt&range=6h');
    expect(logs('2026-10-10T08:00:00Z')).toBe('/logs?project=project-e00ekw&bucket=sp_serial&resource=computeinstance-e00vnt&range=7d');
    expect(logs('2026-09-01T08:00:00Z')).toMatch(/&range=7d$/);
    expect(alertLinks(old({ labels: { cluster: 'mk8scluster-e00x' }, activeAt: '2026-10-11T10:59:00Z' }), undefined, { now }).find(l => l.label === 'Control-plane errors')!.to).toBe('/logs?project=project-e00ekw&preset=control-plane-errors&range=6h');
  });

  it('alertView passes the inventory lookup through', () => {
    const v = alertView(idle({}), { ...rule, metrics: ['DCGM_FI_DEV_GPU_UTIL'] }, [], now, names, () => false);
    expect(v.links.map(l => l.label)).not.toContain('Open in Explorer');
  });
});
