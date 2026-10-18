import type { ObservedResource, WorkloadsResponse, WorkloadSummary } from '@internal/nebius-domain';
import { fmtTime } from '../../ui/format';

type WorkloadEvent = WorkloadsResponse['events'][number];
type Cluster = WorkloadsResponse['clusters'][number];

/** The pod-name suffix each controller appends: <deploy>-<rs hash>-<pod hash>, <sts>-<ordinal>, <job>-<hash>. */
const POD_SUFFIX: Record<string, RegExp> = {
  Deployment: /^[a-z0-9]+-[a-z0-9]+$/,
  StatefulSet: /^\d+$/,
  Job: /^[a-z0-9]+$/,
};

/** The workload a pod belongs to, by its name: the longest workload name that leaves a suffix of the controller's shape. */
export function ownerOfPod(pod: string, cluster: string, namespace: string, workloads: WorkloadSummary[]): WorkloadSummary | undefined {
  return workloads
    .filter(x => x.cluster === cluster && x.namespace === namespace && pod.startsWith(`${x.name}-`))
    .filter(x => (POD_SUFFIX[x.kind] ?? /^[a-z0-9-]+$/).test(pod.slice(x.name.length + 1)))
    .sort((a, b) => b.name.length - a.name.length)[0];
}

/** What a warning event says about a pod right now, if anything: "CrashLoopBackOff" or "not ready: startup probe failing". */
function eventIssue(e: WorkloadEvent): string | undefined {
  if (e.reason === 'BackOff' && /restarting failed container/i.test(e.message)) return 'CrashLoopBackOff';
  if (e.reason === 'BackOff' && /pulling image/i.test(e.message)) return 'ImagePullBackOff';
  const probe = /^(Startup|Readiness|Liveness) probe failed/i.exec(e.message);
  if (e.reason === 'Unhealthy' && probe) {
    const kind = probe[1].toLowerCase();
    return kind === 'liveness' ? 'liveness probe failing' : `not ready: ${kind} probe failing`;
  }
  return undefined;
}

export interface WorkloadHealth {
  tone: 'ok' | 'warn' | 'danger';
  /** The row's badge: "ready", "2 pending", "CrashLoopBackOff", "not ready (0/1)", "failed (BackoffLimitExceeded)", "complete". */
  label: string;
  /** Lines under the badge: restarts, probe failures, scheduling messages. */
  details: string[];
}

/**
 * The health a workload row shows, from pod status when the backend reports it (restarts, waiting reasons) and
 * otherwise from its pods' warning events. Events only count while the workload is not fully ready: once it is,
 * they are history.
 */
export function workloadHealth(w: WorkloadSummary, events: WorkloadEvent[], all: WorkloadSummary[]): WorkloadHealth {
  const notReady = w.replicas !== undefined && (w.readyReplicas ?? 0) < w.replicas;
  const fromEvents = notReady
    ? events
        .filter(e => e.cluster === w.cluster && e.namespace === w.namespace && e.involved.startsWith('Pod/'))
        .filter(e => ownerOfPod(e.involved.slice(4), e.cluster, e.namespace, all.length ? all : [w])?.uid === w.uid)
        .map(eventIssue)
        .filter((x): x is string => Boolean(x))
    : [];
  const issues = [...new Set([...(w.podIssues ?? []), ...fromEvents])];
  const restarts = w.restarts ? [`${w.restarts} restart${w.restarts === 1 ? '' : 's'}`] : [];
  // A Job's own conditions say whether it ended (followup 16): failed is red whatever its pods wait for; complete is done.
  const failedPods = w.job?.failedPods ? `${w.job.failedPods} failed pod${w.job.failedPods === 1 ? '' : 's'}` : undefined;
  if (w.job?.outcome === 'failed') return { tone: 'danger', label: w.job.reason ? `failed (${w.job.reason})` : 'failed', details: [...(failedPods ? [failedPods] : []), ...restarts, ...issues] };
  if (w.job?.outcome === 'complete') return { tone: 'ok', label: 'complete', details: restarts };
  if (failedPods) restarts.push(`${failedPods}, retrying`);
  const headline = issues.find(i => /BackOff|Err|OOM/.test(i));
  if (headline) return { tone: 'danger', label: headline, details: [...restarts, ...issues.filter(i => i !== headline)] };
  if (w.pendingPods) return { tone: 'warn', label: `${w.pendingPods} pending`, details: [...restarts, ...issues, ...w.schedulingMessages] };
  if (issues.length) return { tone: 'warn', label: issues[0], details: [...restarts, ...issues.slice(1)] };
  if (notReady) return { tone: 'warn', label: `not ready (${w.readyReplicas ?? 0}/${w.replicas})`, details: restarts };
  return { tone: 'ok', label: w.replicas === undefined ? 'scheduled' : 'ready', details: restarts };
}

/** The same toleration repeats once per container in the pod spec; it is one constraint. */
export const uniqueTolerations = (t: string[]) => [...new Set(t)];

/**
 * Why a cluster's snapshot is stale: the backend's `staleReason`, else from the inventory: being deleted, or gone. `undefined` when the snapshot is
 * fresh, the inventory has not loaded, or the inventory shows nothing unusual.
 */
export function staleReason(c: Pick<Cluster, 'name' | 'error' | 'staleReason'>, resources: Pick<ObservedResource, 'type' | 'name' | 'status' | 'observedAt'>[] | undefined): string | undefined {
  if (c.staleReason) return c.staleReason;
  if (!c.error || !resources) return undefined;
  const r = resources.find(x => x.type === 'mk8s-cluster' && x.name === c.name);
  if (!r) return 'Cluster is no longer in the inventory (deleted).';
  if (r.status === 'deleting') return `Cluster is being deleted (inventory ${fmtTime(r.observedAt)}).`;
  if (r.status === 'error' || r.status === 'stopped') return `Cluster is ${r.status} in the inventory (${fmtTime(r.observedAt)}).`;
  return undefined;
}

type ClusterNode = Cluster['nodes'][number];
type NodeBadge = { tone: 'ok' | 'warn' | 'danger' | 'neutral'; label: string };

/** A node's state badges (followup 18): deleting, NotReady, cordoned; Ready only when none applies. */
export function nodeBadges(n: Pick<ClusterNode, 'ready' | 'cordoned' | 'deleting'>): NodeBadge[] {
  const out: NodeBadge[] = [];
  if (n.deleting) out.push({ tone: 'warn', label: 'deleting' });
  if (n.ready === false) out.push({ tone: 'danger', label: 'NotReady' });
  if (n.cordoned) out.push({ tone: 'warn', label: 'cordoned' });
  if (out.length) return out;
  return [n.ready ? { tone: 'ok', label: 'Ready' } : { tone: 'neutral', label: 'Ready not reported' }];
}

/** "3 nodes · 1 NotReady · 1 cordoned", or "2 nodes, all Ready". */
export function nodeSummary(nodes: Pick<ClusterNode, 'ready' | 'cordoned' | 'deleting'>[]): string {
  if (!nodes.length) return 'No nodes';
  const count = `${nodes.length} node${nodes.length === 1 ? '' : 's'}`;
  const states = ['NotReady', 'cordoned', 'deleting', 'Ready not reported']
    .map(label => [label, nodes.filter(x => nodeBadges(x).some(b => b.label === label)).length] as const)
    .filter(([, k]) => k > 0)
    .map(([label, k]) => `${k} ${label}`);
  return states.length ? [count, ...states].join(' · ') : `${count}, all Ready`;
}
