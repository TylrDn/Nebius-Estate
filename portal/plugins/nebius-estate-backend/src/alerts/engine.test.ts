import knex, { Knex } from 'knex';
import { mockServices } from '@backstage/backend-test-utils';
import { AlertNotification, BudgetSignal } from '@internal/nebius-domain';
import { migrate } from '../database';
import { REPO_ROOT } from '../__testUtils__/testing';
import { RepoReader } from '../repo/RepoReader';
import { emptyCapacity } from '../inventory/nebius';
import { EstateSnapshot } from '../inventory/types';
import { MetricsClient } from '../telemetry/MetricsClient';
import { AlertStore } from './AlertStore';
import { AlertEngine, loadRules, NotifierRegistry } from './engine';
import { withNames } from './subject';
import { guidedFix, scopeRuleStatuses } from './router';
import { allocatableZero, allowanceBelowTenant, connectorFailing, maintenance, quotaBlocked, SignalBuilder, ttlExpiresSoon } from './signals';

const T0 = Date.parse('2026-10-11T08:00:00Z');
const project = 'project-e00mocklab';

const vm = (id: string, extra: Record<string, unknown> = {}) => ({
  uid: `nebius:${id}`, providerId: id, type: 'compute-instance' as const, name: id.replace('computeinstance-', ''), projectId: project, region: 'eu-north1', labels: {}, status: 'running' as const,
  refs: [], spec: { gpus: 1, platform: 'gpu-l40s-d', preset: '1gpu-16vcpu-96gb' }, source: { connector: 'nebius-inventory', kind: 'nebius-api' as const }, observedAt: '', coverageNotes: [], ...extra,
});

function snapshot(over: Partial<EstateSnapshot> = {}): EstateSnapshot {
  return { resources: [], coverage: [], kube: [], statuses: [{ id: 'nebius-inventory', title: 'Nebius inventory', state: 'ok', scope: '', permissions: '', services: [], staleAfterMinutes: 45, missingCoverage: [], setup: '' }], capabilities: [], capacity: emptyCapacity(), ...over };
}

/** A Monitoring client that answers every rule from fixed series (no network). */
function fakeMetrics(series: Record<string, { labels: Record<string, string>; value: number; heldMinutes: number }[]>, nowMs: () => number): MetricsClient {
  return {
    query: async (_p: string, expr: string) => (series[expr] ?? []).map(s => ({ metric: s.labels, value: s.value, ts: nowMs() / 1000 })),
    queryRange: async (_p: string, expr: string, _start: number, end: number) =>
      (series[expr] ?? []).map(s => ({ metric: s.labels, values: Array.from({ length: s.heldMinutes + 1 }, (_, i) => [end - (s.heldMinutes - i) * 60, s.value] as [number, number]) })),
    metricNames: async () => [],
  } as unknown as MetricsClient;
}

describe('alert engine', () => {
  let db: Knex;
  beforeEach(async () => {
    db = knex({ client: 'better-sqlite3', connection: ':memory:', useNullAsDefault: true });
    await migrate(db);
  });
  afterEach(() => db.destroy());

  function engine(snap: () => EstateSnapshot, series: Parameters<typeof fakeMetrics>[0], now: { t: number }, sent: AlertNotification[] = []) {
    const notifiers = new NotifierRegistry();
    notifiers.register({ channel: 'webhook', notify: async e => void sent.push(...e) });
    const store = new AlertStore(db);
    return {
      store,
      engine: new AlertEngine({
        store, repo: new RepoReader(REPO_ROOT), inventory: { snapshot: snap, now: () => new Date(now.t) }, metrics: () => fakeMetrics(series, () => now.t), projects: () => [project],
        maxConcurrency: 2, logger: mockServices.logger.mock(), notifiers,
      }),
    };
  }

  it('fires GpuIdle within one evaluation when history shows an hour below 5 %, then resolves it', async () => {
    const now = { t: T0 };
    const labels = { __name__: 'DCGM_FI_DEV_GPU_UTIL', instance_id: 'computeinstance-e00mockb300', uuid: 'GPU-1' };
    const series = { 'DCGM_FI_DEV_GPU_UTIL < 5': [{ labels, value: 1, heldMinutes: 70 }] };
    const sent: AlertNotification[] = [];
    const { engine: e, store } = engine(() => snapshot(), series, now, sent);
    await e.evaluate();
    const idle = (await store.all()).find(a => a.ruleName === 'GpuIdle')!;
    expect(idle).toMatchObject({ state: 'firing', projectId: project, resourceUid: 'nebius:computeinstance-e00mockb300', activeAt: new Date(T0 - 70 * 60_000).toISOString() });
    expect(idle.labels).toEqual({ instance_id: 'computeinstance-e00mockb300', uuid: 'GPU-1', project });
    expect(sent.find(n => n.alertId === idle.id)).toMatchObject({ state: 'firing', summary: 'GPU-1 on computeinstance-e00mockb300 idle for an hour', link: `/alerts?alert=${idle.id}` });
    series['DCGM_FI_DEV_GPU_UTIL < 5'] = [];
    now.t += 15 * 60_000;
    await e.evaluate();
    expect(await store.get(idle.id)).toMatchObject({ state: 'resolved', resolvedAt: new Date(now.t).toISOString() });
    expect((await store.history(idle.id)).map(h => `${h.from}>${h.to}`)).toEqual(['firing>resolved', 'inactive>firing']);
  });

  it('names the GPU by its VM and index (ids as secondary), and resolves as soon as the VM leaves the inventory', async () => {
    const now = { t: T0 };
    const labels = { __name__: 'DCGM_FI_DEV_GPU_UTIL', instance_id: 'computeinstance-e00vnt', uuid: 'GPU-0000mock-0000-4000-8000-000000000001', mk8s_node_group_id: 'mk8snodegroup-e00rcx', mk8s_cluster_id: 'mk8scluster-e00bzp' };
    const series = { 'DCGM_FI_DEV_GPU_UTIL < 5': [{ labels, value: 0, heldMinutes: 70 }] };
    const projectRes = { ...vm(project), type: 'project' as const, name: 'mock-lab', projectId: project };
    const ngRes = { ...vm('mk8snodegroup-e00rcx'), type: 'mk8s-node-group' as const, name: 'ng-gpu' };
    const clusterRes = { ...vm('mk8scluster-e00bzp'), type: 'mk8s-cluster' as const, name: 'nip-sandbox-inference' };
    const node = vm('computeinstance-e00vnt', { name: 'mk8snodegroup-e00rcx-7vfm8-qg7rz' });
    let resources: any[] = [projectRes, ngRes, clusterRes, node];
    const sent: AlertNotification[] = [];
    const { engine: e, store } = engine(() => snapshot({ resources }), series, now, sent);
    await e.evaluate();
    const idle = (await store.all()).find(a => a.ruleName === 'GpuIdle')!;
    expect(idle).toMatchObject({ state: 'firing', title: 'GPU 0 on mk8snodegroup-e00rcx-7vfm8-qg7rz idle for an hour' });
    expect(idle.subject).toEqual({ instanceId: 'computeinstance-e00vnt', instanceName: 'mk8snodegroup-e00rcx-7vfm8-qg7rz', gpu: 'GPU 0', gpuUuid: 'GPU-0000mock-0000-4000-8000-000000000001', nodeGroupId: 'mk8snodegroup-e00rcx', nodeGroupName: 'ng-gpu', clusterId: 'mk8scluster-e00bzp', clusterName: 'nip-sandbox-inference', projectId: project, projectName: 'mock-lab' });
    expect(sent.find(n => n.alertId === idle.id)?.summary).toBe('GPU 0 on mk8snodegroup-e00rcx-7vfm8-qg7rz idle for an hour');
    // The VM is deleted; Monitoring still answers for it for a few minutes: the alert resolves on this evaluation.
    resources = [projectRes, ngRes, clusterRes];
    now.t += 15 * 60_000;
    await e.evaluate();
    const after = (await store.get(idle.id))!;
    expect(after).toMatchObject({ state: 'resolved', subject: { instanceName: 'mk8snodegroup-e00rcx-7vfm8-qg7rz' } }); // the last-known names stay
    expect(after.evidence).toMatch(/left the inventory/);
  });

  it('resolves a deleted VM\'s alerts on a fast sync, without querying Monitoring', async () => {
    const now = { t: T0 };
    const labels = { __name__: 'DCGM_FI_DEV_GPU_UTIL', instance_id: 'computeinstance-e00gone', uuid: 'GPU-9' };
    const series = { 'DCGM_FI_DEV_GPU_UTIL < 5': [{ labels, value: 0, heldMinutes: 70 }] };
    const keep = vm('computeinstance-e00keep');
    let resources: any[] = [vm('computeinstance-e00gone'), keep];
    const sent: AlertNotification[] = [];
    const { engine: e, store } = engine(() => snapshot({ resources }), series, now, sent);
    await e.evaluate();
    const idle = (await store.all()).find(a => a.ruleName === 'GpuIdle')!;
    expect(idle.state).toBe('firing');
    // The VM is deleted; a fast sync (no Monitoring) resolves its alert now.
    resources = [keep];
    now.t += 2 * 60_000;
    series['DCGM_FI_DEV_GPU_UTIL < 5'] = undefined as any; // any Monitoring query would throw
    const { resolved } = await e.resolveGoneVms();
    expect(resolved).toBe(1);
    expect(await store.get(idle.id)).toMatchObject({ state: 'resolved', resolvedAt: new Date(now.t).toISOString(), evidence: expect.stringMatching(/left the inventory/) });
    expect(sent.filter(n => n.alertId === idle.id).map(n => n.state)).toEqual(['firing', 'resolved']);
    // Nothing left to resolve: a second call changes nothing.
    expect((await e.resolveGoneVms()).resolved).toBe(0);
  });

  it('keeps GpuHot pending until it has held 5 minutes, across evaluations', async () => {
    const now = { t: T0 };
    const series = { 'DCGM_FI_DEV_GPU_TEMP >= 85': [{ labels: { instance_id: 'computeinstance-x' }, value: 88, heldMinutes: 1 }] };
    const { engine: e, store } = engine(() => snapshot(), series, now);
    await e.evaluate();
    expect((await store.all()).find(a => a.ruleName === 'GpuHot')?.state).toBe('pending');
    now.t += 15 * 60_000;
    await e.evaluate();
    expect((await store.all()).find(a => a.ruleName === 'GpuHot')?.state).toBe('firing');
  });

  it('never resolves an alert because a query failed', async () => {
    const now = { t: T0 };
    const series = { 'DCGM_FI_DEV_GPU_TEMP >= 85': [{ labels: { instance_id: 'computeinstance-x' }, value: 90, heldMinutes: 10 }] };
    const { engine: e, store } = engine(() => snapshot(), series, now);
    await e.evaluate();
    (e as any).d.metrics = () => ({ query: async () => { throw new Error('GET … → 503 after 4 attempts'); }, queryRange: async () => [] });
    now.t += 15 * 60_000;
    await e.evaluate();
    expect((await store.all()).find(a => a.ruleName === 'GpuHot')?.state).toBe('firing');
    expect(e.status().rules.find(r => r.name === 'GpuHot')).toMatchObject({ status: 'error', reason: expect.stringMatching(/kept as they were/) });
  });

  it('a portal signal whose input is missing is unknown: its alert keeps its state and since-times, and never re-fires (F1.34)', async () => {
    const now = { t: T0 };
    const t = (name: string, limit: number) => ({ scope: 'tenant' as const, projectId: '', name, region: 'eu-west2', allocation: 'set' as const, limit, usage: 0, usagePercent: null });
    const p = (name: string, limit: number) => ({ scope: 'project' as const, projectId: project, name, region: 'eu-west2', allocation: 'set' as const, limit, usage: 0, usagePercent: null });
    const withTenant = { ...emptyCapacity(), quotas: [t('dns.zone.count', 100), p('dns.zone.count', 0)] };
    const tenantCap = (state: string) => ({ id: 'quotas.allowances.tenant', title: 'Quota allowances (tenant)', service: 'quotas', connector: 'nebius-inventory', scope: 'tenant', path: '/quotas/v1/quota-allowances', method: 'GET', state }) as any;
    let snap = snapshot({ capacity: withTenant, capabilities: [tenantCap('ok')] });
    const sent: AlertNotification[] = [];
    const { engine: e, store } = engine(() => snap, {}, now, sent);
    await e.evaluate();
    const fired = (await store.all()).find(a => a.ruleName === 'ProjectAllowanceBelowTenant')!;
    expect(fired).toMatchObject({ state: 'firing' });

    // The live failure: a project read failed, the tenant id was lost, the tenant list was not called.
    now.t += 15 * 60_000;
    snap = snapshot({ capacity: { ...emptyCapacity(), quotas: [p('dns.zone.count', 0)] }, capabilities: [tenantCap('not-configured')] });
    await e.evaluate();
    expect(await store.get(fired.id)).toMatchObject({ state: 'firing', activeAt: fired.activeAt, firedAt: fired.firedAt });
    expect(e.status().rules.find(r => r.name === 'ProjectAllowanceBelowTenant')).toMatchObject({ reason: expect.stringMatching(/1 alert kept as it was: .*tenant id is not known/) });

    // Data back, condition still holding: the same alert, same since-times, no new firing.
    now.t += 15 * 60_000;
    snap = snapshot({ capacity: withTenant, capabilities: [tenantCap('ok')] });
    await e.evaluate();
    expect(await store.get(fired.id)).toMatchObject({ state: 'firing', activeAt: fired.activeAt, firedAt: fired.firedAt });
    expect((await store.history(fired.id)).map(h => `${h.from}>${h.to}`)).toEqual(['inactive>firing']);
    expect(sent.filter(n => n.alertId === fired.id).map(n => n.state)).toEqual(['firing']);

    // Known and no longer holding: resolved.
    now.t += 15 * 60_000;
    snap = snapshot({ capacity: { ...emptyCapacity(), quotas: [t('dns.zone.count', 100)] }, capabilities: [tenantCap('ok')] });
    await e.evaluate();
    expect(await store.get(fired.id)).toMatchObject({ state: 'resolved' });
  });

  it('a pending alert whose input is unknown stays pending: its `for` time does not run out on old data (F1.34 review)', async () => {
    const now = { t: T0 };
    const gpuVm = vm('computeinstance-g', { spec: { gpus: 1 } });
    const cluster = (read: boolean) => ({ name: 'c', mk8sClusterId: 'mk8scluster-1', observedAt: 'x', ...(read ? {} : { stale: true }), nodes: [{ name: 'node-g', instanceId: 'computeinstance-g', allocatable: { cpu: '16' } }], namespaces: [], workloads: [], pvcs: [], events: [] });
    let snap = snapshot({ resources: [gpuVm], kube: [cluster(true)] as any });
    const { engine: e, store } = engine(() => snap, {}, now);
    await e.evaluate();
    const pending = (await store.all()).find(a => a.ruleName === 'GpuVmNoAllocatableGpus')!;
    expect(pending).toMatchObject({ state: 'pending' });
    // The cluster is not read; 20 min pass, more than the rule's 15 min `for`.
    snap = snapshot({ resources: [gpuVm], kube: [cluster(false)] as any });
    now.t += 20 * 60_000;
    await e.evaluate();
    expect(await store.get(pending.id)).toMatchObject({ state: 'pending', activeAt: pending.activeAt });
    expect((await store.history(pending.id)).map(h => `${h.from}>${h.to}`)).toEqual(['inactive>pending']);
  });

  it('PreemptibleNodeLost is kept, not resolved, while the inventory sync failed in part (F1.34)', async () => {
    const now = { t: T0 };
    const pre = vm('computeinstance-p', { spec: { gpus: 1, capacityType: 'preemptible' } });
    const inv = (state: 'ok' | 'degraded') => [{ id: 'nebius-inventory', title: 'Nebius inventory', state, scope: '', permissions: '', services: [], staleAfterMinutes: 45, missingCoverage: [], setup: '' }];
    let snap = snapshot({ resources: [pre] });
    const { engine: e, store } = engine(() => snap, {}, now);
    await e.evaluate();
    snap = snapshot({ resources: [{ ...pre, status: 'stopped' as const }] });
    now.t += 15 * 60_000;
    await e.evaluate();
    const lost = (await store.all()).find(a => a.ruleName === 'PreemptibleNodeLost')!;
    expect(lost.state).toBe('firing');
    snap = snapshot({ resources: [{ ...pre, status: 'stopped' as const }], statuses: inv('degraded') as any });
    now.t += 15 * 60_000;
    await e.evaluate();
    expect(await store.get(lost.id)).toMatchObject({ state: 'firing', activeAt: lost.activeAt, firedAt: lost.firedAt });
  });

  it('lists in-cluster rules with the reason instead of dropping them', async () => {
    const { engine: e } = engine(() => snapshot(), {}, { t: T0 });
    await e.evaluate();
    expect(e.status().rules.find(r => r.name === 'VllmNoReplicasReady')).toMatchObject({ status: 'needs-in-cluster', reason: expect.stringMatching(/^Needs in-cluster Prometheus: kube_deployment_status_replicas_available/) });
  });
});

describe('budget and credit signals as alerts (source budgets)', () => {
  let db: Knex;
  beforeEach(async () => {
    db = knex({ client: 'better-sqlite3', connection: ':memory:', useNullAsDefault: true });
    await migrate(db);
  });
  afterEach(() => db.destroy());

  const credit: BudgetSignal = {
    id: 'credit:c1:expiry', kind: 'credit-expiring', severity: 'critical', subject: { type: 'credit', id: 'c1', name: 'TF promo', provider: 'token-factory' },
    title: 'Credit “TF promo” expires in 2 days with 20 USD left', evidence: { value: { amount: '20', currency: 'USD' }, basis: 'date', expiresOn: '2026-10-13', daysToExpiry: 2 },
    fix: { meaning: 'Unused credit is not paid out.', checks: ['Check the balance in the Token Factory console.'], action: 'Plan the work that uses it.', runbook: 'runbooks/finance.md#budget-or-credit-signal', docs: 'https://docs.nebius.com/signup-billing/budgets#how-to-check-a-budget-status' },
  };

  it('a budget rule with no budget defined says so instead of "evaluated"; a credit rule with credits is evaluated (#65)', async () => {
    const store = new AlertStore(db);
    const e = new AlertEngine({ store, repo: new RepoReader(REPO_ROOT), inventory: { snapshot: () => snapshot(), now: () => new Date(T0) }, metrics: () => undefined, projects: () => [], maxConcurrency: 1, logger: mockServices.logger.mock(), notifiers: new NotifierRegistry() });
    e.useBudgetSignals(async () => [credit], async () => ({ budgets: 0, credits: 1 }));
    await e.evaluate();
    const rules = e.status().rules;
    for (const id of ['budgets#budget-threshold', 'budgets#budget-over', 'budgets#budget-projected', 'budgets#budget-forecast']) {
      expect(rules.find(r => r.id === id)).toMatchObject({ status: 'not-configured', reason: 'No budgets defined: add one on Budgets & credits.' });
    }
    expect(rules.find(r => r.id === 'budgets#credit-expiring')).toMatchObject({ status: 'evaluated', firing: 1 });
    e.useBudgetSignals(async () => [], async () => ({ budgets: 1, credits: 0 }));
    await e.evaluate();
    expect(e.status().rules.find(r => r.id === 'budgets#credit-exhausting')).toMatchObject({ status: 'not-configured', reason: 'No credits entered: add one on Budgets & credits.' });
    expect(e.status().rules.find(r => r.id === 'budgets#budget-over')).toMatchObject({ status: 'evaluated' });
  });

  it('fire with the signal, carry its severity, title and guided fix, and resolve when it goes away', async () => {
    const store = new AlertStore(db);
    const now = { t: T0 };
    const signals: BudgetSignal[] = [credit];
    const e = new AlertEngine({ store, repo: new RepoReader(REPO_ROOT), inventory: { snapshot: () => snapshot(), now: () => new Date(now.t) }, metrics: () => undefined, projects: () => [], maxConcurrency: 1, logger: mockServices.logger.mock(), notifiers: new NotifierRegistry() });
    e.useBudgetSignals(async () => signals);
    await e.evaluate();
    const a = (await store.all()).find(x => x.source === 'budgets')!;
    expect(a).toMatchObject({ ruleId: 'budgets#credit-expiring', ruleName: 'CreditExpiring', state: 'firing', severity: 'critical', title: credit.title, labels: { signal: 'credit:c1:expiry', name: 'TF promo', subject: 'credit' }, value: 20 });
    expect(a.fix?.runbook).toBe('runbooks/finance.md#budget-or-credit-signal');
    expect(e.status().rules.find(r => r.id === 'budgets#credit-expiring')).toMatchObject({ status: 'evaluated', firing: 1, source: 'budgets' });
    // The guided fix comes from the signal itself, with the runbook section rendered from the repository.
    const g = await guidedFix(new RepoReader(REPO_ROOT), a, undefined);
    expect(g).toMatchObject({ meaning: 'Unused credit is not paid out.', checks: ['Check the balance in the Token Factory console.'], fix: 'Plan the work that uses it.', docs: credit.fix.docs, readOnly: true });
    expect(g.runbook?.markdown).toBeDefined();
    signals.length = 0;
    now.t += 15 * 60_000;
    await e.evaluate();
    expect(await store.get(a.id)).toMatchObject({ state: 'resolved' });
  });

  it('a budget forecast signal fires as BudgetForecast, with its own severity and a runbook section that renders', async () => {
    const store = new AlertStore(db);
    const forecast: BudgetSignal = {
      id: 'budget:b1:forecast:100', kind: 'budget-forecast', severity: 'warning', subject: { type: 'budget', id: 'b1', name: 'Lab', provider: 'ai-cloud' },
      title: 'Budget “Lab” is forecast to reach 100 % by month-end (25.83 of 20.00 USD)',
      evidence: { value: { amount: '25.83', currency: 'USD' }, threshold: { amount: '20', currency: 'USD' }, basis: 'forecast' },
      fix: { meaning: 'At the burn rate…', checks: ['Open Costs.'], action: 'Stop what is not needed.', runbook: 'runbooks/finance.md#budget-or-credit-signal', docs: 'https://docs.nebius.com/signup-billing/budgets#how-to-check-a-budget-status' },
    };
    const e = new AlertEngine({ store, repo: new RepoReader(REPO_ROOT), inventory: { snapshot: () => snapshot(), now: () => new Date(T0) }, metrics: () => undefined, projects: () => [], maxConcurrency: 1, logger: mockServices.logger.mock(), notifiers: new NotifierRegistry() });
    e.useBudgetSignals(async () => [forecast]);
    await e.evaluate();
    const a = (await store.all()).find(x => x.source === 'budgets')!;
    expect(a).toMatchObject({ ruleId: 'budgets#budget-forecast', ruleName: 'BudgetForecast', state: 'firing', severity: 'warning', title: forecast.title });
    expect(a.evidence).toMatch(/25\.83 USD against 20 USD \(forecast\)/);
    expect(e.status().rules.find(r => r.id === 'budgets#budget-forecast')).toMatchObject({ status: 'evaluated', firing: 1, source: 'budgets' });
    const g = await guidedFix(new RepoReader(REPO_ROOT), a, undefined);
    expect(g.runbook?.markdown).toMatch(/budget-forecast/);
  });

  it('a projected budget signal fires as BudgetProjected, apart from the actual crossings, with its runbook row (F1.47)', async () => {
    const store = new AlertStore(db);
    const projected: BudgetSignal = {
      id: 'budget:b1:projected:100', kind: 'budget-projected', severity: 'warning', subject: { type: 'budget', id: 'b1', name: 'Lab', provider: 'ai-cloud' },
      title: 'Budget “Lab” is projected to be over its amount with the live estimate (235.64 USD of 100 USD; spent 3.24 USD)',
      evidence: { value: { amount: '235.64', currency: 'USD' }, threshold: { amount: '100', currency: 'USD' }, basis: 'estimate' },
      fix: { meaning: 'A projection, not spend.', checks: ['Open Fleet.'], action: 'Stop what is not needed.', runbook: 'runbooks/finance.md#budget-or-credit-signal', docs: 'https://docs.nebius.com/signup-billing/budgets#how-to-check-a-budget-status' },
    };
    const e = new AlertEngine({ store, repo: new RepoReader(REPO_ROOT), inventory: { snapshot: () => snapshot(), now: () => new Date(T0) }, metrics: () => undefined, projects: () => [], maxConcurrency: 1, logger: mockServices.logger.mock(), notifiers: new NotifierRegistry() });
    e.useBudgetSignals(async () => [projected]);
    await e.evaluate();
    const a = (await store.all()).find(x => x.source === 'budgets')!;
    expect(a).toMatchObject({ ruleId: 'budgets#budget-projected', ruleName: 'BudgetProjected', state: 'firing', severity: 'warning' });
    expect(e.status().rules.find(r => r.id === 'budgets#budget-over')).toMatchObject({ firing: 0 });
    const g = await guidedFix(new RepoReader(REPO_ROOT), a, undefined);
    expect(g.runbook?.markdown).toMatch(/budget-projected/);
  });

  it('a credit running out fires as CreditExhausting, with its runbook row (W1-P21)', async () => {
    const store = new AlertStore(db);
    const exhausting: BudgetSignal = {
      id: 'credit:c1:exhausting', kind: 'credit-exhausting', severity: 'warning', subject: { type: 'credit', id: 'c1', name: 'TF promo', provider: 'token-factory' },
      title: 'Credit “TF promo” runs out about 2026-10-20 at the current burn (2.00 USD a day), 18.00 USD left',
      evidence: { value: { amount: '18', currency: 'USD' }, basis: 'forecast' },
      fix: { meaning: 'A forecast.', checks: ['Check the balance.'], action: 'Confirm the spend.', runbook: 'runbooks/finance.md#budget-or-credit-signal', docs: 'https://docs.nebius.com/signup-billing/budgets#how-to-check-a-budget-status' },
    };
    const e = new AlertEngine({ store, repo: new RepoReader(REPO_ROOT), inventory: { snapshot: () => snapshot(), now: () => new Date(T0) }, metrics: () => undefined, projects: () => [], maxConcurrency: 1, logger: mockServices.logger.mock(), notifiers: new NotifierRegistry() });
    e.useBudgetSignals(async () => [exhausting]);
    await e.evaluate();
    const a = (await store.all()).find(x => x.source === 'budgets')!;
    expect(a).toMatchObject({ ruleId: 'budgets#credit-exhausting', ruleName: 'CreditExhausting', state: 'firing', severity: 'warning' });
    const g = await guidedFix(new RepoReader(REPO_ROOT), a, undefined);
    expect(g.runbook?.markdown).toMatch(/credit-exhausting/);
  });

  it('a budget write re-evaluates its alerts at once; a deleted budget resolves them with the reason (W1-P19)', async () => {
    const store = new AlertStore(db);
    const now = { t: T0 };
    const threshold: BudgetSignal = {
      id: 'budget:b1:threshold:50', kind: 'budget-threshold', severity: 'warning', subject: { type: 'budget', id: 'b1', name: 'Lab', provider: 'ai-cloud' },
      title: 'Budget “Lab” crossed 50 %', evidence: { value: { amount: '12', currency: 'USD' }, threshold: { amount: '10', currency: 'USD' }, basis: 'actual' },
      fix: { meaning: 'Spend reached 50 %.', checks: ['Open Costs.'], action: 'Confirm the spend.', runbook: 'runbooks/finance.md#budget-or-credit-signal', docs: 'https://docs.nebius.com/signup-billing/budgets#how-to-check-a-budget-status' },
    };
    const other = { ...credit, id: 'credit:c2:expiry', subject: { ...credit.subject, id: 'c2' } };
    const signals: BudgetSignal[] = [threshold, other];
    const sent: AlertNotification[] = [];
    const notifiers = new NotifierRegistry();
    notifiers.register({ channel: 'webhook', notify: async x => void sent.push(...x) });
    const e = new AlertEngine({ store, repo: new RepoReader(REPO_ROOT), inventory: { snapshot: () => snapshot(), now: () => new Date(now.t) }, metrics: () => undefined, projects: () => [], maxConcurrency: 1, logger: mockServices.logger.mock(), notifiers });
    e.useBudgetSignals(async () => signals);
    await e.evaluate();
    const fired = (await store.all()).find(x => x.ruleId === 'budgets#budget-threshold')!;
    expect(fired.state).toBe('firing');
    // The budget is deleted a minute later: no sync runs, its alert resolves now, said why; the other stays open.
    signals.splice(0, 1);
    now.t += 60_000;
    expect(await e.reevaluateBudgets({ deleted: { type: 'budget', id: 'b1' } })).toEqual({ resolved: 1, fired: 0 });
    expect(await store.get(fired.id)).toMatchObject({ state: 'resolved', resolvedAt: new Date(now.t).toISOString() });
    expect((await store.get(fired.id))!.evidence).toMatch(/Resolved: budget deleted\.$/);
    expect((await store.all()).find(x => x.ruleId === 'budgets#credit-expiring')?.state).toBe('firing');
    expect(sent.filter(x => x.alertId === fired.id).map(x => x.state)).toEqual(['firing', 'resolved']);
    // A write that crosses a threshold fires at once too.
    signals.push(threshold);
    expect(await e.reevaluateBudgets()).toEqual({ resolved: 0, fired: 1 });
  });

  it('keep budget alerts as they were when the signals cannot be read', async () => {
    const store = new AlertStore(db);
    const e = new AlertEngine({ store, repo: new RepoReader(REPO_ROOT), inventory: { snapshot: () => snapshot(), now: () => new Date(T0) }, metrics: () => undefined, projects: () => [], maxConcurrency: 1, logger: mockServices.logger.mock(), notifiers: new NotifierRegistry() });
    e.useBudgetSignals(async () => [credit]);
    await e.evaluate();
    e.useBudgetSignals(async () => {
      throw new Error('database locked');
    });
    await e.evaluate();
    expect((await store.all()).find(x => x.source === 'budgets')?.state).toBe('firing');
    expect(e.status().rules.find(r => r.id === 'budgets#credit-expiring')?.reason).toMatch(/kept as they were/);
  });
});

describe('portal signals', () => {
  it('quota blocking a node group: missing nodes the tenant quota of the region cannot hold', () => {
    const ng = { ...vm('mk8snodegroup-gpu'), type: 'mk8s-node-group' as const, uid: 'nebius:mk8snodegroup-gpu', name: 'gpu', refs: [{ relation: 'parent' as const, target: 'mk8scluster-1' }], spec: { platform: 'gpu-l40s-d', preset: '1gpu-16vcpu-96gb', fixedNodeCount: 2 } };
    const capacity = { ...emptyCapacity(), quotas: [{ scope: 'tenant' as const, projectId: '', name: 'compute.instance.gpu.l40s', region: 'eu-north1', allocation: 'set' as const, limit: 0, usage: 0, usagePercent: null }, { scope: 'tenant' as const, projectId: '', name: 'compute.instance.count', region: 'eu-north1', allocation: 'set' as const, limit: 100, usage: 3, usagePercent: 3 }] };
    const s = quotaBlocked(snapshot({ resources: [ng, vm('computeinstance-n1', { refs: [{ relation: 'member-of', target: 'mk8snodegroup-gpu' }] })], capacity }));
    expect(s).toEqual([expect.objectContaining({ labels: expect.objectContaining({ quota: 'compute.instance.gpu.l40s', node_group: 'mk8snodegroup-gpu', region: 'eu-north1' }), value: 1, resourceUid: 'nebius:mk8snodegroup-gpu' })]);
    expect(s[0].evidence).toMatch(/1 of 2 node\(s\).*limit 0/);
    expect(quotaBlocked(snapshot({ resources: [ng], capacity: emptyCapacity() }))).toEqual([]); // tenant allowances not read: not evaluated
  });

  it('project allowance below the tenant quota: caps below and caps of 0, never caps above or placeholders', () => {
    const t = (name: string, limit: number) => ({ scope: 'tenant' as const, projectId: '', name, region: 'eu-west2', allocation: 'set' as const, limit, usage: 0, usagePercent: null });
    const p = (name: string, limit: number | null) => ({ scope: 'project' as const, projectId: project, name, region: 'eu-west2', allocation: limit === null ? ('inherits-tenant' as const) : ('set' as const), limit, usage: 0, usagePercent: null, description: `desc ${name}` });
    const capacity = { ...emptyCapacity(), quotas: [t('vpc.allocation.count', 1000), t('dns.zone.count', 100), t('compute.instance.count', 12), t('mk8s.cluster.count', 2), p('vpc.allocation.count', 13), p('dns.zone.count', 0), p('compute.instance.count', 22), p('mk8s.cluster.count', null)] };
    const s = allowanceBelowTenant(snapshot({ capacity }));
    expect(s.map(x => [x.labels.quota, x.labels.kind, x.value])).toEqual([['dns.zone.count', 'zero-cap', 100], ['vpc.allocation.count', 'caps-below', 987]]);
    expect(s[1]).toMatchObject({ metric: 'nebius_estate_project_allowance_below_tenant', projectId: project, labels: expect.objectContaining({ project, region: 'eu-west2', project_limit: '13', tenant_limit: '1000' }) });
    expect(s[1].evidence).toMatch(/13.*1,000.*Intended\?/); // amounts read as on GPU & Capacity (grouped), not raw
    expect(allowanceBelowTenant(snapshot({ capacity: { ...capacity, quotas: capacity.quotas.filter(q => q.scope === 'project') } }))).toEqual([]); // no tenant list: not evaluated
  });

  it('project allowance below the tenant quota: byte quotas read as TiB in the title and evidence; the labels (the alert identity) stay raw', async () => {
    const q = (scope: 'tenant' | 'project', limit: number) => ({ scope, projectId: scope === 'tenant' ? '' : project, name: 'compute.filesystem.size.network-ssd', region: 'eu-north1', allocation: 'set' as const, limit, usage: 0, usagePercent: null, unit: 'bytes', description: 'Shared filesystems' });
    const capacity = { ...emptyCapacity(), quotas: [q('tenant', 5497558138880), q('project', 1649267441664)] };
    const [s] = allowanceBelowTenant(snapshot({ capacity }));
    expect(s.labels).toMatchObject({ project_limit: '1649267441664', tenant_limit: '5497558138880' });
    expect(s.display).toEqual({ project_limit: '1.5 TiB', tenant_limit: '5 TiB' });
    expect(s.evidence).toMatch(/project cap 1\.5 TiB, tenant limit 5 TiB/);
    // #42: the value is the cut, in the quota's unit.
    expect(s.value).toBe(3848290697216);
    expect(s.valueKind).toEqual({ quotaUnit: 'bytes', meaning: 'below the tenant limit' });
    // The title the engine stores, from the rule's own summary in platform/alerts/portal/fleet.yaml.
    const rule = (await loadRules(new RepoReader(REPO_ROOT))).rules.find(r => r.name === 'ProjectAllowanceBelowTenant')!;
    const [a] = withNames([{ labels: s.labels, display: s.display, value: s.value, projectId: s.projectId }], rule.summary, new Map());
    expect(a.title).toBe('compute.filesystem.size.network-ssd in eu-north1 is capped at 1.5 TiB for this project (tenant limit 5 TiB)');
    expect(a.labels.project_limit).toBe('1649267441664');
  });

  it('connector failing, GPU VM with 0 allocatable GPUs, maintenance', () => {
    const snap = snapshot({
      statuses: [
        { id: 'nebius-logging', title: 'Logs', state: 'error', error: 'timeout', scope: '', permissions: '', services: [], staleAfterMinutes: 45, missingCoverage: [], setup: '' },
        { id: 'prometheus', title: 'External Prometheus', state: 'not-needed', scope: '', permissions: '', services: [], staleAfterMinutes: 0, missingCoverage: [], setup: '' },
      ],
      resources: [vm('computeinstance-g')],
      kube: [{ name: 'c', mk8sClusterId: 'mk8scluster-1', observedAt: 'x', nodes: [{ name: 'node-g', instanceId: 'computeinstance-g', allocatable: { cpu: '16' } }], namespaces: [], workloads: [], pvcs: [], events: [] }],
      capacity: { ...emptyCapacity(), maintenances: [{ id: 'm1', name: 'control plane update', projectId: project, state: 'STATE_SCHEDULED', scheduledAt: new Date(T0 + 3 * 3_600_000).toISOString(), affected: ['computeinstance-g'] }, { id: 'm2', name: 'old', projectId: project, state: 'STATE_FINISHED', affected: [] }] },
    });
    expect(connectorFailing(snap).map(s => s.labels.connector)).toEqual(['nebius-logging']);
    expect(allocatableZero(snap)).toEqual([expect.objectContaining({ labels: expect.objectContaining({ node: 'node-g', instance_id: 'computeinstance-g' }), value: 1 })]);
    expect(maintenance(snap, new Date(T0)).map(m => [m.labels.maintenance, m.value])).toEqual([['m1', 3]]);
    // #42: each value says what it counts.
    expect(connectorFailing(snap)[0].valueKind).toEqual({ meaning: 'failed syncs in a row' });
    expect(allocatableZero(snap)[0].valueKind).toEqual({ unit: 'GPUs', meaning: 'on the VM, none allocatable' });
    expect(maintenance(snap, new Date(T0))[0].valueKind).toEqual({ unit: 'h', meaning: 'until it starts' });
  });

  it('TTL near expiry (#19): one series per running root, its hours to the earliest TTL; nothing for an expired, stopped or unlabelled root', async () => {
    const labels = (ttl: string, extra: Record<string, string> = {}) => ({ 'nip-stage': 'sandbox', 'nip-stack': 'inference', 'nip-run': 'r1', 'nip-ttl-expires': ttl, ...extra });
    const soon = '2026-10-11T11:30:00Z'; // T0 + 3.5 h
    const snap = snapshot({
      resources: [
        vm('computeinstance-a', { labels: labels(soon) }),
        vm('computeinstance-b', { labels: labels('2026-10-11T20:00:00Z') }),
        // A disk of the same root does not run; it does not make a root "running" on its own.
        { ...vm('computedisk-c', { labels: labels('2026-10-11T09:00:00Z') }), type: 'compute-disk' as const },
        vm('computeinstance-old', { labels: labels('2026-10-11T07:00:00Z', { 'nip-stack': 'training' }) }), // already expired
        vm('computeinstance-stopped', { status: 'stopped' as const, labels: labels(soon, { 'nip-stack': 'data' }) }),
        vm('computeinstance-nolabel'),
      ],
    });
    const s = ttlExpiresSoon(snap, new Date(T0));
    expect(s).toEqual([
      expect.objectContaining({
        metric: 'nebius_estate_ttl_expires_hours',
        labels: { project, stage: 'sandbox', stack: 'inference', run: 'r1' },
        display: { ttl_expires: '2026-10-11 11:30 UTC', run_note: ' (run r1)' },
        value: 3.5,
        valueKind: { unit: 'h', meaning: 'until its TTL' },
        projectId: project,
      }),
    ]);
    expect(s[0].evidence).toMatch(/2 running resources of sandbox\/inference \(run r1\).*nip-ttl-expires 2026-10-11 11:30 UTC.*a, b/);
    // The title the engine stores, from the rule's own summary.
    const rule = (await loadRules(new RepoReader(REPO_ROOT))).rules.find(r => r.name === 'TtlExpiresSoon')!;
    const [a] = withNames([{ labels: s[0].labels, display: s[0].display, value: s[0].value }], rule.summary, new Map());
    expect(a.title).toBe('sandbox/inference (run r1) reaches its TTL in 3 h (2026-10-11 11:30 UTC)');
  });

  it('preemptible node lost: a VM running at the last sync and gone now; never on the first sync after a restart', () => {
    const b = new SignalBuilder();
    const pre = vm('computeinstance-p', { spec: { gpus: 1, capacityType: 'preemptible' } });
    expect(b.signals(snapshot({ resources: [pre] }), new Date(T0)).filter(s => s.metric === 'nebius_estate_preemptible_node_lost')).toEqual([]);
    const lost = b.signals(snapshot({ resources: [] }), new Date(T0)).filter(s => s.metric === 'nebius_estate_preemptible_node_lost');
    expect(lost).toEqual([expect.objectContaining({ labels: expect.objectContaining({ instance_id: 'computeinstance-p' }), evidence: expect.stringMatching(/gone now/) })]);
    expect(b.signals(snapshot({ resources: [{ ...pre, status: 'stopped' }] }), new Date(T0)).filter(s => s.metric === 'nebius_estate_preemptible_node_lost')).toHaveLength(1);
  });
});

describe('teardown: alerts of resources that were deleted on purpose (walkthrough 2026-10-11)', () => {
  const T = new Date('2026-10-11T10:56:22Z');
  const projectRes = { ...vm('project-e00en1'), type: 'project' as const, uid: 'nebius:project-e00en1', providerId: 'project-e00en1', name: 'default-project-eu-north1', projectId: 'project-e00en1' };
  const cluster = (status: 'running' | 'deleting') => ({ ...vm('mk8scluster-e00bzp'), type: 'mk8s-cluster' as const, uid: 'nebius:mk8scluster-e00bzp', name: 'nip-sandbox-inference', status, labels: { 'nip-stage': 'sandbox', 'nip-stack': 'inference', 'nip-ttl-expires': '2026-10-11T10:44:28Z' } });
  const ng = (status: 'running' | 'deleting') => ({ ...vm('mk8snodegroup-e00rcx'), type: 'mk8s-node-group' as const, uid: 'nebius:mk8snodegroup-e00rcx', name: 'ng-gpu', status, refs: [{ relation: 'parent' as const, target: 'mk8scluster-e00bzp' }] });
  const node = (over: Record<string, unknown> = {}) => vm('computeinstance-e00vnt', { name: 'mk8snodegroup-e00rcx-7vfm8-qg7rz', spec: { gpus: 1, capacityType: 'preemptible', platform: 'gpu-l40s-a', preset: '1gpu-8vcpu-32gb' }, refs: [{ relation: 'member-of', target: 'mk8snodegroup-e00rcx' }], ...over });
  const lost = (b: SignalBuilder, resources: any[], now = T) => b.signals(snapshot({ resources }), now).filter(s => s.metric === 'nebius_estate_preemptible_node_lost');

  it('PreemptibleNodeLost stays quiet when the node group or cluster is deleting or gone', () => {
    const b = new SignalBuilder();
    lost(b, [cluster('running'), ng('running'), node()], new Date('2026-10-11T10:30:00Z')); // before the TTL: no inherited expiry yet
    expect(lost(b, [cluster('deleting'), ng('deleting')], new Date('2026-10-11T10:40:00Z'))).toEqual([]);
    const c = new SignalBuilder();
    lost(c, [cluster('running'), ng('running'), node()], new Date('2026-10-11T10:30:00Z'));
    expect(lost(c, [], new Date('2026-10-11T10:40:00Z'))).toEqual([]); // cluster and node group gone with it
  });

  it('PreemptibleNodeLost stays quiet when the VM\'s effective TTL (inherited from its cluster) has passed', () => {
    const b = new SignalBuilder();
    lost(b, [cluster('running'), ng('running'), node()], new Date('2026-10-11T10:40:00Z'));
    expect(lost(b, [cluster('running'), ng('running')], T)).toEqual([]); // 10:56 > TTL 10:44:28
    expect(lost(b, [cluster('running'), ng('running'), node({ status: 'stopped' })], T)).toEqual([]);
  });

  it('PreemptibleNodeLost still fires for a reclaimed node of a running group before its TTL', () => {
    const b = new SignalBuilder();
    lost(b, [cluster('running'), ng('running'), node()], new Date('2026-10-11T10:30:00Z'));
    expect(lost(b, [cluster('running'), ng('running')], new Date('2026-10-11T10:35:00Z'))).toHaveLength(1);
  });

  it('ConnectorFailing never counts the connector of a cluster that is deleting or gone', () => {
    const st = (id: string) => ({ id, title: `Kubernetes — ${id}`, state: 'error' as const, error: 'x', scope: '', permissions: '', services: [], staleAfterMinutes: 45, missingCoverage: [], setup: '' });
    const snap = snapshot({ resources: [projectRes, cluster('deleting')], statuses: [st('mk8s:mk8scluster-e00bzp'), st('mk8s:mk8scluster-e00gone'), st('nebius-logging')] });
    expect(connectorFailing(snap).map(s => s.labels.connector)).toEqual(['nebius-logging']);
  });
});

describe('rule statuses per caller scope', () => {
  const rule = (over: Record<string, unknown> = {}) => ({ id: 'f#R', name: 'R', file: 'f', group: 'g', severity: 'warning' as const, source: 'nebius' as const, expr: 'x', for: '5m', forSeconds: 300, summary: 's', status: 'evaluated' as const, firing: 3, pending: 1, ...over });
  const alert = (projectId: string | undefined, state: 'firing' | 'pending' | 'resolved') => ({ id: `${projectId}-${state}`, ruleId: 'f#R', ruleName: 'R', severity: 'warning' as const, source: 'nebius' as const, state, labels: {}, activeAt: '', lastEvalAt: '', value: 1, query: 'x', projectId });
  const names = new Map([['project-e00mocklab', 'mock-lab'], ['project-e00mocksandbox', 'mock-sandbox']]);
  const sandbox = { all: false, projects: new Set(['project-e00mocksandbox']) };

  it('masks out-of-scope project ids and names in reasons, and counts only alerts in scope', () => {
    const reason = '2 project(s) could not be queried (their alerts are kept as they were): mock-lab: timeout on project-e00mocklab; mock-sandbox: 503';
    const [r] = scopeRuleStatuses([rule({ reason })], [alert('project-e00mocklab', 'firing'), alert('project-e00mocklab', 'firing'), alert('project-e00mocksandbox', 'firing'), alert('project-e00mocklab', 'pending')].filter(a => a.projectId === 'project-e00mocksandbox'), sandbox, names);
    expect(r.reason).not.toMatch(/mock-lab|e00mocklab/);
    expect(r.reason).toContain('mock-sandbox: 503');
    expect(r).toMatchObject({ firing: 1, pending: 0 });
    // An unrestricted caller sees the reason as it is.
    const [all] = scopeRuleStatuses([rule({ reason })], [alert('project-e00mocklab', 'firing')], { all: true, projects: new Set() }, names);
    expect(all.reason).toBe(reason);
    expect(all).toMatchObject({ firing: 1, pending: 0 });
  });
});
