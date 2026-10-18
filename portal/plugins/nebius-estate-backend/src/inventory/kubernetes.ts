import { request } from 'https';
import { FetchFn, HttpClient, redact } from '../lib/http';
import { sumKubeQuantities } from '@internal/nebius-domain';
import { KubeCluster, KubeWorkload } from './types';

/**
 * Read-only Kubernetes connector for clusters listed in app-config only
 * (no user-supplied URLs, no kubeconfig upload). Uses a bearer token from an
 * environment variable and, optionally, a CA bundle file. Lists: namespaces,
 * nodes, deployments, statefulsets, replicasets, jobs, pods, PVCs, events.
 * The token needs get/list on those kinds and nothing else
 * (docs/portal/nebius-setup.md#kubernetes).
 */

const MAX_RESPONSE_BYTES = 50 * 1024 * 1024;

/** fetch-compatible HTTPS client that can pin a CA bundle (global fetch cannot). */
export function nodeHttpsFetch(ca?: Buffer): FetchFn {
  return (url, init) =>
    new Promise<Response>((resolveP, reject) => {
      const headers: Record<string, string> = {};
      new Headers(init.headers).forEach((v, k) => {
        headers[k] = v;
      });
      const req = request(
        url,
        { method: init.method ?? 'GET', headers, ca, signal: init.signal ?? undefined, rejectUnauthorized: true },
        res => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (c: Buffer) => {
            size += c.length;
            if (size > MAX_RESPONSE_BYTES) req.destroy(new Error('response too large'));
            else chunks.push(c);
          });
          res.on('end', () => {
            const h = new Headers();
            for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) h.set(k, Array.isArray(v) ? v.join(', ') : String(v));
            resolveP(new Response(Buffer.concat(chunks), { status: res.statusCode ?? 502, headers: h }));
          });
          res.on('error', reject);
        },
      );
      req.on('error', reject);
      if (typeof init.body === 'string') req.write(init.body);
      req.end();
    });
}

type Json = Record<string, any>;

async function listAll(http: HttpClient, base: string, path: string, max = 20): Promise<Json[]> {
  const out: Json[] = [];
  let cont: string | undefined;
  for (let i = 0; i < max; i++) {
    const q = new URLSearchParams({ limit: '500' });
    if (cont) q.set('continue', cont);
    const res = await http.request<{ items?: Json[]; metadata?: { continue?: string } }>(`${base}${path}?${q.toString()}`);
    out.push(...(res.items ?? []));
    cont = res.metadata?.continue || undefined;
    if (!cont) break;
  }
  return out;
}

/** Requests or limits summed over the pod's containers as Kubernetes quantities ("100m" + "250m" = "350m"; followup 17). */
function sumRequests(podSpec: Json | undefined, field: 'requests' | 'limits'): Record<string, string> {
  const byKey: Record<string, string[]> = {};
  for (const c of (podSpec?.containers ?? []) as Json[]) {
    for (const [k, v] of Object.entries((c.resources?.[field] ?? {}) as Record<string, string>)) (byKey[k] ??= []).push(String(v));
  }
  return Object.fromEntries(Object.entries(byKey).map(([k, vs]) => [k, sumKubeQuantities(vs)]));
}

/**
 * A Job's outcome from its status (batch/v1 JobStatus): a Failed or Complete condition whose status is "True" ends it;
 * status.failed counts failed pods, also while it retries (followup 16).
 */
export function jobOutcome(status: Json | undefined): KubeWorkload['job'] {
  const conditions = (status?.conditions ?? []) as Json[];
  const ended = (type: string) => conditions.find(c => c.type === type && String(c.status) === 'True');
  const failedPods = Number(status?.failed) || 0;
  const failed = ended('Failed');
  if (failed) return { outcome: 'failed', ...(failed.reason ? { reason: String(failed.reason) } : {}), ...(failedPods ? { failedPods } : {}) };
  if (ended('Complete')) return { outcome: 'complete' };
  return { outcome: 'running', ...(failedPods ? { failedPods } : {}) };
}

function tolerations(podSpec: Json | undefined): string[] {
  return ((podSpec?.tolerations ?? []) as Json[]).map(t => `${t.key ?? '*'}${t.value ? `=${t.value}` : ''}:${t.effect ?? '*'}`);
}

/** Extracts an exact Nebius instance id from node.spec.providerID, if one is present. */
export function instanceIdFromProviderId(providerId: string | undefined): string | undefined {
  return /\b(computeinstance-[a-z0-9]+)\b/.exec(providerId ?? '')?.[1];
}

const NODE_GROUP_ID = /^mk8snodegroup-[a-z0-9]+$/;

/** The MK8s node group of a node: the documented label `nebius.com/node-group-id`, else any label value that is exactly a node-group id. */
export function nodeGroupIdFromLabels(labels: Record<string, string> | undefined): string | undefined {
  const documented = labels?.['nebius.com/node-group-id'];
  if (documented && NODE_GROUP_ID.test(documented)) return documented;
  return Object.values(labels ?? {}).find(v => typeof v === 'string' && NODE_GROUP_ID.test(v));
}

/** A node's state (followup 18): the Ready condition, cordoned (spec.unschedulable), deleting (metadata.deletionTimestamp). */
function nodeState(n: Json): { ready?: boolean; cordoned: boolean; deleting: boolean } {
  const cond = ((n.status?.conditions ?? []) as Json[]).find(c => c.type === 'Ready');
  return { ...(cond ? { ready: String(cond.status) === 'True' } : {}), cordoned: n.spec?.unschedulable === true, deleting: Boolean(n.metadata?.deletionTimestamp) };
}

export function mapKubeObjects(
  name: string,
  objs: { nodes: Json[]; namespaces: Json[]; deployments: Json[]; statefulsets: Json[]; replicasets: Json[]; jobs: Json[]; pods: Json[]; pvcs: Json[]; events: Json[] },
  opts: { mk8sClusterId?: string; dashboardUrl?: string; namespaces?: string[]; observedAt: string },
): KubeCluster {
  const nsAllowed = (ns: string) => !opts.namespaces?.length || opts.namespaces.includes(ns);
  const rsOwner = new Map<string, string>();
  for (const rs of objs.replicasets) {
    const owner = (rs.metadata?.ownerReferences ?? []).find((o: Json) => o.kind === 'Deployment');
    if (owner) rsOwner.set(`${rs.metadata.namespace}/${rs.metadata.name}`, owner.name);
  }
  const workloads = new Map<string, KubeWorkload>();
  const add = (kind: string, o: Json) => {
    const ns = o.metadata?.namespace;
    if (!nsAllowed(ns)) return;
    const tpl = o.spec?.template?.spec;
    workloads.set(`${kind}/${ns}/${o.metadata.name}`, {
      namespace: ns,
      name: o.metadata.name,
      kind,
      replicas: o.spec?.replicas ?? (kind === 'Job' ? o.spec?.parallelism : undefined),
      readyReplicas: o.status?.readyReplicas ?? (kind === 'Job' ? o.status?.succeeded : undefined) ?? 0,
      requests: sumRequests(tpl, 'requests'),
      limits: sumRequests(tpl, 'limits'),
      nodeSelector: tpl?.nodeSelector ?? {},
      tolerations: tolerations(tpl),
      pods: [],
      ...(kind === 'Job' ? { job: jobOutcome(o.status) } : {}),
    });
  };
  objs.deployments.forEach(o => add('Deployment', o));
  objs.statefulsets.forEach(o => add('StatefulSet', o));
  objs.jobs.forEach(o => add('Job', o));

  for (const p of objs.pods) {
    const ns = p.metadata?.namespace;
    if (!nsAllowed(ns)) continue;
    const owner = (p.metadata?.ownerReferences ?? [])[0] as Json | undefined;
    let key: string | undefined;
    if (owner?.kind === 'ReplicaSet') {
      const dep = rsOwner.get(`${ns}/${owner.name}`);
      if (dep) key = `Deployment/${ns}/${dep}`;
    } else if (owner?.kind === 'StatefulSet' || owner?.kind === 'Job') {
      key = `${owner.kind}/${ns}/${owner.name}`;
    }
    const sched = ((p.status?.conditions ?? []) as Json[]).find(c => c.type === 'PodScheduled' && c.status === 'False');
    const pvc = ((p.spec?.volumes ?? []) as Json[]).find(v => v.persistentVolumeClaim)?.persistentVolumeClaim?.claimName;
    const statuses = [...((p.status?.initContainerStatuses ?? []) as Json[]), ...((p.status?.containerStatuses ?? []) as Json[])];
    const waiting = [...new Set(statuses.map(cs => cs.state?.waiting?.reason).filter((r): r is string => typeof r === 'string' && r.length > 0))];
    const pod = {
      name: p.metadata.name,
      phase: p.status?.phase ?? 'Unknown',
      node: p.spec?.nodeName ?? null,
      message: sched?.message,
      pvc,
      restarts: statuses.length ? statuses.reduce((n, cs) => n + (Number(cs.restartCount) || 0), 0) : undefined,
      waiting: waiting.length ? waiting : undefined,
    };
    const w = key ? workloads.get(key) : undefined;
    if (w) w.pods.push(pod);
  }

  return {
    name,
    mk8sClusterId: opts.mk8sClusterId,
    observedAt: opts.observedAt,
    dashboardUrl: opts.dashboardUrl ?? null,
    nodes: objs.nodes.map(n => ({
      name: n.metadata.name,
      // MK8s names a node after its VM id; providerID carries it too.
      instanceId: instanceIdFromProviderId(n.spec?.providerID) ?? (/^computeinstance-[a-z0-9]+$/.test(n.metadata?.name ?? '') ? n.metadata.name : undefined),
      nodeGroupId: nodeGroupIdFromLabels(n.metadata?.labels),
      allocatable: (n.status?.allocatable ?? {}) as Record<string, string>,
      ...nodeState(n),
    })),
    namespaces: objs.namespaces.map(n => n.metadata.name).filter(nsAllowed),
    workloads: [...workloads.values()],
    pvcs: objs.pvcs.filter(p => nsAllowed(p.metadata?.namespace)).map(p => ({
      namespace: p.metadata.namespace,
      name: p.metadata.name,
      storageClass: p.spec?.storageClassName,
      capacity: p.status?.capacity?.storage,
      volume: p.spec?.volumeName ?? null,
    })),
    events: objs.events
      .filter(e => nsAllowed(e.metadata?.namespace) && e.type === 'Warning')
      .slice(-200)
      .map(e => ({
        namespace: e.metadata.namespace,
        involved: `${e.involvedObject?.kind}/${e.involvedObject?.name}`,
        reason: e.reason ?? '',
        type: e.type ?? '',
        message: String(e.message ?? '').slice(0, 500),
        lastSeen: e.lastTimestamp ?? e.eventTime ?? e.metadata?.creationTimestamp ?? '',
      })),
  };
}

export class KubernetesConnector {
  constructor(
    private readonly cluster: { name: string; url: string; mk8sClusterId?: string; dashboardUrl?: string; namespaces?: string[] },
    private readonly http: HttpClient,
  ) {}

  async sync(now = new Date()): Promise<KubeCluster> {
    const b = this.cluster.url;
    try {
      const [nodes, namespaces, deployments, statefulsets, replicasets, jobs, pods, pvcs, events] = await Promise.all([
        listAll(this.http, b, '/api/v1/nodes'),
        listAll(this.http, b, '/api/v1/namespaces'),
        listAll(this.http, b, '/apis/apps/v1/deployments'),
        listAll(this.http, b, '/apis/apps/v1/statefulsets'),
        listAll(this.http, b, '/apis/apps/v1/replicasets'),
        listAll(this.http, b, '/apis/batch/v1/jobs'),
        listAll(this.http, b, '/api/v1/pods'),
        listAll(this.http, b, '/api/v1/persistentvolumeclaims'),
        listAll(this.http, b, '/api/v1/events'),
      ]);
      return mapKubeObjects(this.cluster.name, { nodes, namespaces, deployments, statefulsets, replicasets, jobs, pods, pvcs, events }, {
        mk8sClusterId: this.cluster.mk8sClusterId,
        dashboardUrl: this.cluster.dashboardUrl,
        namespaces: this.cluster.namespaces,
        observedAt: now.toISOString(),
      });
    } catch (e) {
      return {
        name: this.cluster.name, mk8sClusterId: this.cluster.mk8sClusterId, dashboardUrl: this.cluster.dashboardUrl ?? null,
        error: redact((e as Error).message), nodes: [], namespaces: [], workloads: [], pvcs: [], events: [],
      };
    }
  }
}
