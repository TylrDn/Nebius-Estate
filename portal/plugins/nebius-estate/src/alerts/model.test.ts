import type { AlertView } from '@internal/nebius-domain';
import { inClusterReason } from '@internal/nebius-domain';
import { BrowserNotifier, clearedBeforeFiring, docsLink, forLabel, forText, ruleReasonShort, newlyFiring, runbookLink, scopeText, seenKey, sinceOf, subjectText } from './model';

const alert = (over: Partial<AlertView>): AlertView => ({
  id: 'a1', ruleId: 'f#R', ruleName: 'GpuHot', severity: 'critical', source: 'nebius', state: 'firing', labels: {}, activeAt: '2026-10-11T08:00:00Z', firedAt: '2026-10-11T08:05:00Z',
  lastEvalAt: '2026-10-11T08:05:00Z', value: 90, query: 'q', summary: 's', description: '', ruleFor: '5 min', links: [], ...over,
});

describe('Alerts view helpers', () => {
  it('name what an alert is about (VM, GPU, node group, cluster, project), with ids as secondary text', () => {
    const a = alert({
      labels: { instance_id: 'computeinstance-e00vnt', uuid: 'GPU-0000mock-b4af', project: 'project-e00ekw' },
      projectId: 'project-e00ekw',
      subject: { instanceId: 'computeinstance-e00vnt', instanceName: 'mk8snodegroup-e00rcx-qg7rz', gpu: 'GPU 0', gpuUuid: 'GPU-0000mock-b4af', nodeGroupId: 'mk8snodegroup-e00rcx', nodeGroupName: 'ng-gpu', clusterId: 'mk8scluster-e00bzp', clusterName: 'nip-sandbox-inference', projectId: 'project-e00ekw', projectName: 'default-project-eu-north1' },
    });
    expect(subjectText(a)).toEqual({ primary: 'mk8snodegroup-e00rcx-qg7rz · GPU 0 · ng-gpu · nip-sandbox-inference', project: 'default-project-eu-north1', ids: 'computeinstance-e00vnt · GPU-0000mock-b4af · project-e00ekw' });
    // Without a subject (stored before names were kept): the labels, and the project id.
    expect(subjectText(alert({ labels: { node_group_name: 'gpu', quota: 'q' }, projectId: 'project-e00x' }))).toEqual({ primary: 'gpu · q', project: 'project-e00x', ids: undefined });
  });

  it('leave out of the scope what the summary already says (#64)', () => {
    const cap = alert({ summary: 'vpc.allocation.count in eu-north1 is capped at 13 for this project (tenant limit 1,000)', labels: { quota: 'vpc.allocation.count', region: 'eu-north1', project: 'project-e00x' }, projectId: 'project-e00x', subject: { projectId: 'project-e00x', projectName: 'nbis-labs' } });
    expect(subjectText(cap)).toEqual({ primary: '', project: 'nbis-labs', ids: 'project-e00x' });
    const ng = alert({ summary: 'Node group gpu cannot reach its size: compute.instance.gpu.l40s in eu-north1', labels: { node_group_name: 'gpu', quota: 'compute.instance.gpu.l40s', region: 'eu-north1', cluster: 'mk8scluster-e00x' }, projectId: 'project-e00x' });
    expect(subjectText(ng).primary).toBe('mk8scluster-e00x');
    // Whole tokens only: a GPU index "0" is not "shown" by "10.0.0.0/24", nor a quota by a longer one.
    expect(scopeText({ gpu: '0', quota: 'compute.instance.gpu' }, 'subnet 10.0.0.0/24 is full of compute.instance.gpu.l40s')).toBe('compute.instance.gpu · 0');
  });

  it('say which time the "since" column shows: firing since for firing alerts, holding since for pending ones', () => {
    const a = alert({ activeAt: '2026-10-11T07:52:00Z', firedAt: '2026-10-11T08:52:10Z', resolvedAt: '2026-10-11T11:11:00Z' });
    expect(sinceOf(a, 'firing')).toEqual({ header: 'Firing since', at: '2026-10-11T08:52:10Z', title: 'Holding since 2026-10-11 07:52 UTC; firing since 2026-10-11 08:52 UTC' });
    expect(sinceOf(alert({ state: 'pending', firedAt: undefined, activeAt: '2026-10-11T07:52:00Z' }), 'pending')).toMatchObject({ header: 'Holding since', at: '2026-10-11T07:52:00Z' });
    expect(sinceOf(a, 'resolved')).toMatchObject({ header: 'Resolved', at: '2026-10-11T11:11:00Z' });
  });

  it('say what an alert is about from its labels', () => {
    expect(scopeText({ node_group_name: 'gpu', quota: 'compute.instance.gpu.l40s', region: 'eu-north1', project: 'p' })).toBe('gpu · compute.instance.gpu.l40s · eu-north1');
    expect(scopeText({})).toBe('whole estate');
  });

  it('open relative runbook links in the document viewer, and only http(s)/mailto outside it', () => {
    expect(runbookLink('runbooks/fleet-alerts.md', 'incident.md#escalating-to-nebius-support')).toBe('/evidence?doc=runbooks%2Fincident.md');
    expect(runbookLink('runbooks/fleet-alerts.md', '../docs/slo.md')).toBe('/evidence?doc=docs%2Fslo.md');
    expect(runbookLink('runbooks/x.md', 'https://docs.nebius.com/observability/logs/query-language#limitations')).toBe('https://docs.nebius.com/observability/logs/query-language#limitations');
    // eslint-disable-next-line no-script-url
    expect(runbookLink('runbooks/x.md', 'javascript:alert(1)')).toBe('#');
  });

  it('keep only https documentation links (the rule file is data)', () => {
    expect(docsLink('https://docs.nebius.com/compute/monitoring/virtual-machines#gpu-monitoring-metrics')).toBe('https://docs.nebius.com/compute/monitoring/virtual-machines#gpu-monitoring-metrics');
    // eslint-disable-next-line no-script-url
    expect(docsLink('javascript:alert(1)')).toBeUndefined();
    // eslint-disable-next-line no-script-url
    expect(docsLink('JavaScript:alert(1)')).toBeUndefined();
    expect(docsLink('http://docs.nebius.com/x')).toBeUndefined();
    expect(docsLink('data:text/html,<script>1</script>')).toBeUndefined();
    expect(docsLink('//evil.example/x')).toBeUndefined();
    expect(docsLink(undefined)).toBeUndefined();
  });

  it('notify each firing episode once, never muted or pending ones', () => {
    const a = alert({});
    const seen = new Set<string>();
    expect(newlyFiring([a, alert({ id: 'p', state: 'pending' }), alert({ id: 'm', muted: { id: 'n', alertId: 'm', kind: 'mute', userRef: 'u', createdAt: '' } })], seen)).toEqual([a]);
    seen.add(seenKey(a));
    expect(newlyFiring([a], seen)).toEqual([]);
    expect(newlyFiring([alert({ firedAt: '2026-10-11T09:00:00Z' })], seen)).toHaveLength(1);
  });

  it('notify through the Notification API only when the user granted it', async () => {
    const created: { title: string; body?: string }[] = [];
    class FakeNotification {
      static permission = 'granted';
      onclick?: () => void;
      constructor(title: string, o: { body?: string }) {
        created.push({ title, body: o.body });
      }
    }
    (window as any).Notification = FakeNotification;
    await new BrowserNotifier(() => undefined).notify([{ alertId: 'a', ruleName: 'GpuHot', severity: 'critical', state: 'firing', summary: 'GPU at 90 °C', at: '', link: '/alerts?alert=a' }]);
    expect(created).toEqual([{ title: 'Critical: GpuHot', body: 'GPU at 90 °C' }]);
    FakeNotification.permission = 'denied';
    await new BrowserNotifier(() => undefined).notify([{ alertId: 'b', ruleName: 'X', severity: 'info', state: 'firing', summary: '', at: '', link: '' }]);
    expect(created).toHaveLength(1);
    delete (window as any).Notification;
  });
});

describe('rules table readability', () => {
  it('shortens the in-cluster reason to the metrics it needs; the explanation is said once (footer)', () => {
    const reason = "Needs in-cluster Prometheus: kube_deployment_status_replicas_available, vllm:num_requests_running are scraped inside a cluster (kube-state-metrics, kubelet or vLLM) and not published by Nebius Monitoring. This rule runs in the cluster's Prometheus when Alertmanager is enabled (modules/o11y, runbooks/alerting.md).";
    expect(ruleReasonShort(reason)).toBe('Needs kube_deployment_status_replicas_available, vllm:num_requests_running');
    expect(ruleReasonShort('2 project(s) could not be queried')).toBe('2 project(s) could not be queried');
    // G3.13: the reason no longer claims Nebius Monitoring never has them (kube_* reach the ingested Prometheus with the agent).
    const now = inClusterReason(['kube_node_labels']);
    expect(now).not.toMatch(/not published by Nebius Monitoring|does not publish/);
    expect(now).toMatch(/not in the service-provider metrics the portal reads/);
    expect(now).toMatch(/ingested Prometheus.*k8s\.cluster\.id/);
    expect(ruleReasonShort(now)).toBe('Needs kube_node_labels');
  });

  it('reads a rule duration in the words the rest of the portal uses', () => {
    expect(forText('0m')).toBe('at once');
    expect(forText('15m')).toBe('15 min');
    expect(forText('1h')).toBe('1 h');
    expect(forText('1h30m')).toBe('1 h 30 min');
  });
});

describe('live audit G3 alerts helpers', () => {
  it('one wording for a rule\'s hold: 0 is "at once" (G3.9)', () => {
    expect(forLabel(0)).toBe('at once');
    expect(forLabel(600)).toBe('10 min');
    expect(forLabel(3600)).toBe('1 h');
  });

  it('a resolved alert that never fired is "cleared before firing" (G3.12)', () => {
    expect(clearedBeforeFiring({ state: 'resolved', firedAt: undefined } as any)).toBe(true);
    expect(clearedBeforeFiring({ state: 'resolved', firedAt: '2026-10-12T04:20:00Z' } as any)).toBe(false);
    expect(clearedBeforeFiring({ state: 'pending', firedAt: undefined } as any)).toBe(false);
  });
});
