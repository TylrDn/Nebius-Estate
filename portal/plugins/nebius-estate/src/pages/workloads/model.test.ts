import type { WorkloadsResponse, WorkloadSummary } from '@internal/nebius-domain';
import { nodeBadges, nodeSummary, staleReason, uniqueTolerations, workloadHealth } from './model';

const w = (over: Partial<WorkloadSummary>): WorkloadSummary => ({
  cluster: 'c',
  namespace: 'inference',
  name: 'vllm',
  kind: 'Deployment',
  replicas: 1,
  readyReplicas: 1,
  gpuRequest: 1,
  requests: {},
  limits: {},
  pendingPods: 0,
  schedulingMessages: [],
  nodeSelector: {},
  tolerations: [],
  uid: 'k8s:c:Deployment:inference/vllm',
  ...over,
});
type Ev = WorkloadsResponse['events'][number];
const ev = (involved: string, reason: string, message: string, over: Partial<Ev> = {}): Ev => ({ cluster: 'c', namespace: 'inference', involved, reason, message, type: 'Warning', lastSeen: '2026-10-11T10:22:06Z', ...over });

const crash = [
  ev('Pod/vllm-648655c887-8bxm4', 'Unhealthy', 'Startup probe failed: Get "http://10.0.24.17:8000/health": dial tcp: connect: connection refused'),
  ev('Pod/vllm-648655c887-8bxm4', 'BackOff', 'Back-off restarting failed container vllm in pod vllm-648655c887-8bxm4_inference(4627)'),
];

describe('workloadHealth', () => {
  it('a crash-looping pod is not "scheduled": CrashLoopBackOff and the failing startup probe, from the events', () => {
    const h = workloadHealth(w({ readyReplicas: 0 }), crash, [w({ readyReplicas: 0 })]);
    expect(h.tone).toBe('danger');
    expect(h.label).toBe('CrashLoopBackOff');
    expect(h.details).toContain('not ready: startup probe failing');
  });

  it('prefers pod status (restarts, waiting reason) when the backend reports it', () => {
    const h = workloadHealth(w({ readyReplicas: 0, restarts: 7, podIssues: ['CrashLoopBackOff'] }), [], []);
    expect(h).toMatchObject({ tone: 'danger', label: 'CrashLoopBackOff' });
    expect(h.details).toContain('7 restarts');
  });

  it('does not take another workload\'s events whose name starts the same', () => {
    const other = [ev('Pod/vllm-qwen-7d9f-a1', 'BackOff', 'Back-off restarting failed container')];
    const all = [w({ readyReplicas: 0 }), w({ name: 'vllm-qwen', uid: 'q' })];
    expect(workloadHealth(all[0], other, all).label).not.toBe('CrashLoopBackOff');
    expect(workloadHealth(all[1], other, all).label).toBe('ready'); // fully ready: old events are history, not state
  });

  it('pending pods stay the scheduling story; a not-ready workload without a reason says so', () => {
    expect(workloadHealth(w({ pendingPods: 1, readyReplicas: 0 }), [], [])).toMatchObject({ tone: 'warn', label: '1 pending' });
    expect(workloadHealth(w({ replicas: 2, readyReplicas: 1 }), [], [])).toMatchObject({ tone: 'warn', label: 'not ready (1/2)' });
    expect(workloadHealth(w({}), [], [])).toMatchObject({ tone: 'ok', label: 'ready' });
  });
});

// Followup 16: a failed Job read amber "not ready (0/1)".
describe('workloadHealth: Jobs', () => {
  const job = (over: Partial<WorkloadSummary>) => w({ kind: 'Job', name: 'smoke', replicas: 1, readyReplicas: 0, uid: 'k8s:c:Job:inference/smoke', ...over });

  it('a failed Job is red "failed (<reason>)" with its failed pods', () => {
    const h = workloadHealth(job({ job: { outcome: 'failed', reason: 'BackoffLimitExceeded', failedPods: 2 } }), [], []);
    expect(h).toEqual({ tone: 'danger', label: 'failed (BackoffLimitExceeded)', details: ['2 failed pods'] });
  });

  it('a failed Job with no reason still reads "failed", and outranks a waiting reason', () => {
    expect(workloadHealth(job({ job: { outcome: 'failed' }, podIssues: ['ImagePullBackOff'] }), [], [])).toMatchObject({ tone: 'danger', label: 'failed' });
  });

  it('a complete Job is "complete", not "not ready"', () => {
    expect(workloadHealth(job({ readyReplicas: 1, job: { outcome: 'complete' } }), [], [])).toMatchObject({ tone: 'ok', label: 'complete' });
    expect(workloadHealth(job({ readyReplicas: 0, replicas: 0, job: { outcome: 'complete' } }), [], [])).toMatchObject({ tone: 'ok', label: 'complete' });
  });

  it('a running Job that has failed pods says so while it retries', () => {
    expect(workloadHealth(job({ job: { outcome: 'running', failedPods: 1 } }), [], [])).toEqual({ tone: 'warn', label: 'not ready (0/1)', details: ['1 failed pod, retrying'] });
  });
});

describe('uniqueTolerations', () => {
  it('lists a toleration repeated per container once', () => {
    expect(uniqueTolerations(['CriticalAddonsOnly:*', 'node.cilium.io/agent-not-ready:*', 'node.cilium.io/agent-not-ready:*'])).toEqual(['CriticalAddonsOnly:*', 'node.cilium.io/agent-not-ready:*']);
  });
});

describe('staleReason', () => {
  const cluster = { name: 'nip-sandbox-inference', configured: true, error: 'Showing the last successful snapshot (stale).' };
  const res = (status: string) => [{ type: 'mk8s-cluster', name: 'nip-sandbox-inference', status, observedAt: '2026-10-11T10:56:17Z' }] as any;
  it('uses the reason the backend gives, before looking at the inventory', () => {
    expect(staleReason({ ...cluster, staleReason: 'Cluster is being deleted (inventory 10:56 UTC)' }, undefined)).toBe('Cluster is being deleted (inventory 10:56 UTC)');
  });
  it('says the cluster is being deleted, from the inventory', () => {
    expect(staleReason(cluster, res('deleting'))).toBe('Cluster is being deleted (inventory 2026-10-11 10:56 UTC).');
  });
  it('says the cluster is gone when the inventory no longer lists it', () => {
    expect(staleReason(cluster, [])).toMatch(/no longer in the inventory/);
  });
  it('says nothing extra for a running cluster or a fresh snapshot', () => {
    expect(staleReason(cluster, res('running'))).toBeUndefined();
    expect(staleReason({ ...cluster, error: undefined }, res('deleting'))).toBeUndefined();
    expect(staleReason(cluster, undefined)).toBeUndefined();
  });
});

// Followup 18: node state on the Workloads page.
describe('node state', () => {
  const n = (over: object) => ({ name: 'n', gpus: 0, cordoned: false, deleting: false, ...over });
  it('one badge per state, worst first; Ready alone when nothing else applies', () => {
    expect(nodeBadges(n({ ready: true }))).toEqual([{ tone: 'ok', label: 'Ready' }]);
    expect(nodeBadges(n({ ready: false }))).toEqual([{ tone: 'danger', label: 'NotReady' }]);
    expect(nodeBadges(n({ ready: true, cordoned: true }))).toEqual([{ tone: 'warn', label: 'cordoned' }]);
    expect(nodeBadges(n({ ready: false, cordoned: true, deleting: true }))).toEqual([
      { tone: 'warn', label: 'deleting' },
      { tone: 'danger', label: 'NotReady' },
      { tone: 'warn', label: 'cordoned' },
    ]);
    expect(nodeBadges(n({}))).toEqual([{ tone: 'neutral', label: 'Ready not reported' }]);
  });
  it('summarises a cluster\'s nodes: the count, then each state that is not Ready', () => {
    expect(nodeSummary([n({ ready: true }), n({ ready: true })])).toBe('2 nodes, all Ready');
    expect(nodeSummary([n({ ready: true }), n({ ready: false }), n({ ready: true, cordoned: true }), n({ ready: true, deleting: true })])).toBe('4 nodes · 1 NotReady · 1 cordoned · 1 deleting');
    expect(nodeSummary([n({})])).toBe('1 node · 1 Ready not reported');
    expect(nodeSummary([])).toBe('No nodes');
  });
});
