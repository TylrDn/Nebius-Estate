import { readFileSync } from 'fs';
import { resolve } from 'path';
import { markdownAnchors, parseSignalExpr } from '@internal/nebius-domain';
import { REPO_ROOT } from '../__testUtils__/testing';
import { RepoReader } from '../repo/RepoReader';
import { loadRules } from './engine';
import { SIGNALS } from './signals';

/**
 * One source of rules: platform/alerts/*.yaml (also loaded by in-cluster Prometheus) and the portal's
 * platform/alerts/portal/*.yaml. Every rule must lead to a guided fix: a runbook section that exists
 * in this repository and a docs.nebius.com page and section that exist in the docs catalog.
 */
const catalog = JSON.parse(readFileSync(resolve(REPO_ROOT, 'docs/reference/nebius-docs.json'), 'utf8')) as { pages: Record<string, { headings?: { anchor: string }[] }> };

describe('alert rules (platform/alerts)', () => {
  const repo = new RepoReader(REPO_ROOT);

  it('parse without problems, from both directories', async () => {
    const { rules, problems } = await loadRules(repo);
    expect(problems).toEqual([]);
    expect(new Set(rules.map(r => r.file.replace(/\/[^/]+$/, '')))).toEqual(new Set(['platform/alerts', 'platform/alerts/portal']));
  });

  it('every rule names a runbook section that exists in this repository', async () => {
    const { rules } = await loadRules(repo);
    const problems: string[] = [];
    for (const r of rules) {
      const m = /^([a-z0-9/._-]+\.md)#([a-z0-9-]+)$/.exec(r.runbook ?? '');
      if (!m) {
        problems.push(`${r.id}: annotations.runbook must be <repo path>.md#<anchor>, got "${r.runbook ?? ''}"`);
        continue;
      }
      let md: string;
      try {
        md = await repo.read(m[1]);
      } catch {
        problems.push(`${r.id}: ${m[1]} is not in the repository (or not readable through the portal's document viewer)`);
        continue;
      }
      if (!markdownAnchors(md).includes(m[2])) problems.push(`${r.id}: ${m[1]} has no section #${m[2]}`);
    }
    expect(problems).toEqual([]);
  });

  it('every rule names a docs.nebius.com page and section that exist in docs/reference/nebius-docs.json', async () => {
    const { rules } = await loadRules(repo);
    const problems: string[] = [];
    for (const r of rules) {
      const m = /^https:\/\/docs\.nebius\.com(\/[A-Za-z0-9_\-./]*)#([A-Za-z0-9_-]+)$/.exec(r.docs ?? '');
      if (!m) {
        problems.push(`${r.id}: annotations.docs must be https://docs.nebius.com/<page>#<anchor>, got "${r.docs ?? ''}"`);
        continue;
      }
      const page = catalog.pages[m[1]];
      if (!page) problems.push(`${r.id}: ${m[1]} is not a page in the docs catalog`);
      else if (!(page.headings ?? []).some(h => h.anchor === m[2])) problems.push(`${r.id}: ${m[1]} has no section #${m[2]}`);
    }
    expect(problems).toEqual([]);
  });

  it('cover what only the portal sees, with expressions the signal evaluator accepts', async () => {
    const { rules } = await loadRules(repo);
    const portal = rules.filter(r => r.file.startsWith('platform/alerts/portal/'));
    expect(portal.map(r => r.name).sort()).toEqual(['ConnectorFailing', 'GpuHot', 'GpuIdle', 'GpuVmNoAllocatableGpus', 'MaintenanceScheduled', 'PreemptibleNodeLost', 'ProjectAllowanceBelowTenant', 'QuotaBlocksNodeGroup', 'TtlExpiresSoon']);
    expect(portal.find(r => r.name === 'GpuIdle')).toMatchObject({ expr: 'DCGM_FI_DEV_GPU_UTIL < 5', forSeconds: 3600, source: 'nebius' });
    expect(portal.find(r => r.name === 'GpuHot')).toMatchObject({ expr: 'DCGM_FI_DEV_GPU_TEMP >= 85', forSeconds: 300, source: 'nebius' });
    const signals = new Set<string>(Object.values(SIGNALS));
    for (const r of portal.filter(x => x.source === 'portal')) {
      const e = parseSignalExpr(r.expr);
      expect(e).toBeDefined();
      expect(signals.has(e!.metric)).toBe(true);
    }
    expect(new Set(portal.filter(r => r.source === 'portal').map(r => parseSignalExpr(r.expr)!.metric))).toEqual(signals);
  });

  it('list rules on kube-state-metrics, kubelet and vLLM as needing in-cluster Prometheus (never dropped)', async () => {
    const { rules } = await loadRules(repo);
    const inCluster = rules.filter(r => r.source === 'in-cluster').map(r => r.name).sort();
    expect(inCluster).toEqual(
      expect.arrayContaining(['GpuNodeNotReady', 'GpuMetricsMissing', 'VllmNoReplicasReady', 'VllmHighE2eLatency', 'VllmRequestsQueueing', 'VllmPodRestarting', 'PodsPendingOnGpu', 'GpuCapacityExhausted', 'PrometheusStorageAlmostFull']),
    );
    expect(rules.find(r => r.name === 'GpuXidError')?.source).toBe('nebius');
    expect(rules.find(r => r.name === 'SharedFilesystemAlmostFull')?.source).toBe('nebius');
  });

  it('evaluate GpuThermalOrPowerThrottling against Nebius Monitoring: the old throttle name is only an `or` alternative (G3.1)', async () => {
    const { rules } = await loadRules(repo);
    const r = rules.find(x => x.name === 'GpuThermalOrPowerThrottling');
    expect(r?.expr).toContain('DCGM_FI_DEV_CLOCKS_EVENT_REASONS or DCGM_FI_DEV_CLOCK_THROTTLE_REASONS');
    expect(r?.source).toBe('nebius');
  });
});
