import { z } from 'zod';

/**
 * Discovered (observed) resources. This model is deliberately separate from
 * the repository's desired configuration (repo.ts), from telemetry
 * (telemetry.ts) and from billing (billing.ts): an inventory snapshot says
 * what existed when a connector looked, nothing more.
 */

export const RESOURCE_TYPES = [
  'tenant',
  'project',
  'mk8s-cluster',
  'mk8s-node-group',
  'compute-instance',
  'compute-disk',
  'compute-filesystem',
  'gpu-cluster',
  'vpc-network',
  'vpc-subnet',
  'storage-bucket',
  'vpc-allocation',
  'vpc-security-group',
  'vpc-route-table',
  'vpc-pool',
  'disk-snapshot',
  'nvl-instance-group',
  'container-registry',
  'postgresql-cluster',
  'mlflow-cluster',
  'ai-endpoint',
  'ai-job',
  'ai-devlab',
  'storage-transfer',
  'tunnel',
  'kms-key',
  'secret',
  'dns-zone',
  'k8s-namespace',
  'k8s-workload',
  'k8s-pod',
  'k8s-pvc',
] as const;
export type ResourceType = (typeof RESOURCE_TYPES)[number];

export const RESOURCE_TYPE_LABELS: Record<ResourceType, string> = {
  tenant: 'Tenant',
  project: 'Project',
  'mk8s-cluster': 'Managed Kubernetes cluster',
  'mk8s-node-group': 'Node group',
  'compute-instance': 'VM / node',
  'compute-disk': 'Disk',
  'compute-filesystem': 'Shared filesystem',
  'gpu-cluster': 'GPU cluster (fabric)',
  'vpc-network': 'VPC network',
  'vpc-subnet': 'Subnet',
  'storage-bucket': 'Object Storage bucket',
  'vpc-allocation': 'IP allocation',
  'vpc-security-group': 'Security group',
  'vpc-route-table': 'Route table',
  'vpc-pool': 'IP pool',
  'disk-snapshot': 'Disk snapshot',
  'nvl-instance-group': 'NVLink instance group',
  'container-registry': 'Container registry',
  'postgresql-cluster': 'Managed PostgreSQL',
  'mlflow-cluster': 'Managed MLflow',
  'ai-endpoint': 'Serverless endpoint',
  'ai-job': 'Serverless job',
  'ai-devlab': 'DevLab',
  'storage-transfer': 'Object Storage transfer',
  tunnel: 'Tunnel',
  'kms-key': 'KMS key',
  secret: 'Secret (metadata only)',
  'dns-zone': 'DNS zone',
  'k8s-namespace': 'Namespace',
  'k8s-workload': 'Workload',
  'k8s-pod': 'Pod',
  'k8s-pvc': 'PersistentVolumeClaim',
};

export const LIFECYCLE_STATUSES = [
  'running',
  'provisioning',
  'pending',
  'stopped',
  'deleting',
  'error',
  'succeeded',
  'unknown',
] as const;
export type LifecycleStatus = (typeof LIFECYCLE_STATUSES)[number];

/** Types that group other resources: a lifecycle status on them says nothing (F1.21). */
const CONTAINER_TYPES = new Set<ResourceType>(['tenant', 'project', 'k8s-namespace']);
/** Types that run (compute, managed services, jobs, pods); the rest hold data or configuration. */
const RUNNING_TYPES = new Set<ResourceType>([
  'mk8s-cluster', 'mk8s-node-group', 'compute-instance', 'nvl-instance-group', 'postgresql-cluster', 'mlflow-cluster',
  'ai-endpoint', 'ai-job', 'ai-devlab', 'storage-transfer', 'tunnel', 'k8s-workload', 'k8s-pod',
]);

/**
 * The status word a page shows for a resource: "active" for a project in its API state ACTIVE (F1.44) and nothing
 * else for a container (a project is not "running"), "ready" for a disk, bucket or network whose API state (READY,
 * ACTIVE) folds to running, the lifecycle status otherwise.
 */
export function lifecycleLabel(type: ResourceType | undefined, status: LifecycleStatus | undefined): string | undefined {
  if (type === 'project' && status === 'running') return 'active';
  if (!status || (type && CONTAINER_TYPES.has(type))) return undefined;
  if (status === 'running' && type && !RUNNING_TYPES.has(type)) return 'ready';
  return status;
}

/** Relationship kinds, each backed by an explicit field in the source data. */
export const RELATIONS = [
  'parent', // API parent_id (project → cluster, cluster → node group)
  'member-of', // instance → node group (node-group id in a Kubernetes node label)
  'attached-to', // disk → instance (read_write_attachments)
  'mounted-by', // filesystem → instance (instance spec.filesystems)
  'in-fabric', // instance → gpu cluster (spec.gpu_cluster.id)
  'in-subnet', // instance / cluster → subnet
  'runs-on', // pod → node (spec.nodeName, matched to a node's provider id)
  'owned-by', // pod → workload (ownerReferences)
  'bound-to', // pvc → disk (pv.spec.csi.volumeHandle)
  'in-namespace', // k8s object → namespace
  'in-cluster', // namespace → mk8s cluster (configured mapping, not inferred)
  'assigned-to', // IP allocation → instance (status.assignment.networkInterface.instanceId)
  'in-network', // security group / route table / managed cluster → network (spec.networkId)
  'routes', // route table → subnet (status.assignment.subnets)
  'snapshot-of', // disk snapshot → disk (spec.sourceDiskId)
  'backed-by', // serverless endpoint / job / devlab → instance (status.instances[].computeInstanceId)
  'managed-by', // node VM / disk created by Managed Kubernetes → its node group or cluster (labels mk8s-node-group-id / mk8s-cluster-id)
  'secured-by', // instance → security group (spec.network_interfaces[].security_groups[].id)
  'pool-of', // pool → the subnets and networks it is assigned to (status.assignment.subnets / networks)
] as const;
export type Relation = (typeof RELATIONS)[number];

export const resourceRefSchema = z.object({
  relation: z.enum(RELATIONS),
  /** providerId (or k8s uid) of the target. */
  target: z.string().min(1),
});
export type ResourceRef = z.infer<typeof resourceRefSchema>;

export const resourceSpecSchema = z
  .object({
    platform: z.string(),
    preset: z.string(),
    gpus: z.number().int().nonnegative(),
    vcpus: z.number().int().nonnegative(),
    ramGib: z.number().nonnegative(),
    sizeGib: z.number().nonnegative(),
    diskType: z.string(),
    fixedNodeCount: z.number().int().nonnegative(),
    autoscaling: z.object({
      min: z.number().int().nonnegative(),
      max: z.number().int().nonnegative(),
    }),
    capacityType: z.enum(['on-demand', 'preemptible', 'reserved', 'unknown']),
    reservationPolicy: z.string(),
    k8sVersion: z.string(),
    fabric: z.string(),
    attachments: z.number().int().nonnegative(),
    /** Kubernetes: summed container requests, verbatim quantities. */
    requests: z.record(z.string(), z.string()),
    limits: z.record(z.string(), z.string()),
    replicas: z.number().int().nonnegative(),
    readyReplicas: z.number().int().nonnegative(),
    workloadKind: z.string(),
    nodeSelector: z.record(z.string(), z.string()),
    tolerations: z.array(z.string()),
    schedulingMessage: z.string(),
    /** A network or subnet Nebius creates with the project (`status.default`): not ours to attribute. */
    platformDefault: z.boolean(),
    /** One-line, non-secret description for resource kinds without dedicated fields (e.g. "AES_256", "12 images"). */
    summary: z.string(),
    /** Public IP allocation / public endpoint. */
    public: z.boolean(),
    /** Disk: the service that manages it (status.managedBy), e.g. a Managed Kubernetes node group. */
    managedBy: z.string(),
    /** Pool: the answer carried status.assignment, so its subnets and networks (pool-of refs) are known (#29). */
    assignmentRead: z.boolean(),
  })
  .partial();

export const SOURCE_KINDS = ['nebius-api', 'kubernetes-api'] as const;

export const observedResourceSchema = z.object({
  /** Stable portal id: `<connector>:<providerId>`. */
  uid: z.string().min(1),
  providerId: z.string().min(1),
  type: z.enum(RESOURCE_TYPES),
  name: z.string(),
  tenantId: z.string().optional(),
  projectId: z.string().optional(),
  region: z.string().optional(),
  labels: z.record(z.string(), z.string()).default({}),
  status: z.enum(LIFECYCLE_STATUSES),
  statusDetail: z.string().optional(),
  /** The provider's own state, upper case as the API reports it (e.g. STOPPING), where `status` folds it. */
  apiState: z.string().optional(),
  createdAt: z.string().optional(),
  refs: z.array(resourceRefSchema).default([]),
  spec: resourceSpecSchema.default({}),
  source: z.object({
    connector: z.string(),
    kind: z.enum(SOURCE_KINDS),
    endpoint: z.string().optional(),
    /** The connector capability (API list) that observed it. */
    capability: z.string().optional(),
  }),
  observedAt: z.string(),
  coverageNotes: z.array(z.string()).default([]),
});
export type ObservedResource = z.infer<typeof observedResourceSchema>;

/* ---------------------------------------------------------------- labels */

/** Labels this repository's stacks set (docs/cost.md "Required labels"). */
export const NIP_LABELS = {
  /** Stack name (nip-stack is the new key; nip-env is deprecated and read as a fallback). */
  stack: 'nip-stack',
  env: 'nip-env',
  owner: 'nip-owner',
  run: 'nip-run',
  ttl: 'nip-ttl-expires',
  region: 'nip-region',
  stage: 'nip-stage',
  /** Optional: `foundation` on foundation-root objects (docs/naming.md). */
  layer: 'nip-layer',
  /** Optional: `workload`, `nat` or `bastion` on R7 security groups; `gpu-vm-access` on R10's (docs/naming.md). */
  purpose: 'nip-purpose',
  /** Optional: `apply` or `plan` on R13 federated credentials (docs/naming.md). */
  ciJob: 'nip-ci-job',
} as const;

export interface Attribution {
  attributed: boolean;
  /** Nebius-created project default (network, subnet): never flagged as unattributed or orphaned. */
  platformDefault: boolean;
  stage?: string;
  stack?: string;
  owner?: string;
  run?: string;
  ttlExpires?: string;
  /** Repository live root these labels point at, when it exists. */
  liveRoot?: string;
  /** Labels inherited from a parent (e.g. "cluster nip-sandbox-inference" for a node-group VM). */
  inheritedFrom?: string;
  /** Created and owned by a Nebius service (e.g. Managed Kubernetes) whose parent is not stated: not unattributed. */
  managed?: string;
}

/**
 * Resource types whose service does not keep labels, so they stay unattributed (names are never used:
 * docs/naming.md). Shown next to the "unattributed" badge so the reader knows it is not a tagging miss.
 */
export const UNLABELLABLE: Partial<Record<ResourceType, string>> = {
  'mlflow-cluster': 'Managed MLflow keeps no labels: a cluster created with nip-* labels came back with none (live run 2026-10-11), so it cannot be attributed. Its name and project identify it.',
};

/** Labels Managed Kubernetes puts on the VMs and disks it creates for a node group. */
export const MK8S_LABELS = { cluster: 'mk8s-cluster-id', nodeGroup: 'mk8s-node-group-id' } as const;

type Linked = Pick<ObservedResource, 'type' | 'refs'> & { labels?: Record<string, string> };

/** The cluster a CSI-created disk belongs to: `compute.csi.nebius.com/cluster-id`, or the `k8s.io/<mk8scluster-…>` ownership label. */
export function csiCluster(labels: Record<string, string> | undefined): string | undefined {
  if (!labels) return undefined;
  const id = labels['compute.csi.nebius.com/cluster-id'];
  if (id?.startsWith('mk8scluster-')) return id;
  const key = Object.keys(labels).find(k => /^k8s\.io\/mk8scluster-[a-z0-9]+$/.test(k));
  return key?.slice('k8s.io/'.length);
}

/** The node VM an IP allocation is assigned to, when Managed Kubernetes created that VM (it carries mk8s-* labels). */
function assignedNode(r: Linked, byId: ReadonlyMap<string, Linked>): Linked | undefined {
  if (r.type !== 'vpc-allocation') return undefined;
  const vm = byId.get(r.refs.find(x => x.relation === 'assigned-to')?.target ?? '');
  return vm?.labels?.[MK8S_LABELS.cluster] || vm?.labels?.[MK8S_LABELS.nodeGroup] ? vm : undefined;
}

/**
 * The MK8s cluster behind a resource Managed Kubernetes created (node VM, boot disk, CSI volume, a node's IP
 * allocation) or a node group, from explicit fields only: the mk8s-* labels, the CSI labels, the node group's
 * parent, or the VM an allocation is assigned to.
 */
export function managingCluster(r: Linked, byId: ReadonlyMap<string, Linked>): string | undefined {
  const direct = r.labels?.[MK8S_LABELS.cluster];
  if (direct) return direct;
  const managedBy = r.refs.find(x => x.relation === 'managed-by' && x.target.startsWith('mk8scluster-'))?.target;
  if (managedBy) return managedBy;
  const parentOf = (ng: Pick<ObservedResource, 'refs'> | undefined) => ng?.refs.find(x => x.relation === 'parent')?.target;
  if (r.type === 'mk8s-node-group') return parentOf(r);
  const csi = r.type === 'compute-disk' ? csiCluster(r.labels) : undefined;
  if (csi) return csi;
  const node = assignedNode(r, byId);
  if (node) return managingCluster(node, byId);
  const ng = r.labels?.[MK8S_LABELS.nodeGroup];
  return ng ? parentOf(byId.get(ng)) : undefined;
}

/** The node group behind a node VM, its boot disk or its IP allocation (labels, managed-by or member-of). */
export function managingNodeGroup(r: Linked, byId: ReadonlyMap<string, Linked>): string | undefined {
  if (r.type === 'mk8s-node-group') return undefined;
  const label = r.labels?.[MK8S_LABELS.nodeGroup];
  if (label) return label;
  const ref = r.refs.find(x => (x.relation === 'managed-by' || x.relation === 'member-of') && x.target.startsWith('mk8snodegroup-'))?.target;
  if (ref) return ref;
  const node = assignedNode(r, byId);
  return node ? managingNodeGroup(node, byId) : undefined;
}

const INHERITED = ['stage', 'stack', 'owner', 'run', 'ttlExpires'] as const;

/** The attribution of a resource labelled `managed=true` by the Nebius managed service that created it. */
export const MANAGED_SERVICE = 'a Nebius managed service (label managed=true)';
/** Managed services that create a subnet and pool of their own. */
const SERVICES_WITH_NETWORK: ResourceType[] = ['postgresql-cluster', 'mlflow-cluster', 'ai-endpoint'];

/**
 * Attribution with inheritance. A resource Managed Kubernetes created for a cluster (node VM, boot disk, CSI
 * volume, a node's IP allocation) takes every nip-* value it lacks — stage, stack, owner, run, TTL — from its
 * node group, then its cluster (which our stacks label), and says so. Its own labels always win.
 */
export function attributeWithParents(
  r: ObservedResource,
  all: ReadonlyMap<string, ObservedResource>,
  liveRoots: ReadonlySet<string> = new Set(),
): Attribution {
  const own = attribute(r, liveRoots);
  if (own.platformDefault) return own;
  // `managed=true` is what a Nebius managed service (PostgreSQL, MLflow, an endpoint) puts on the subnet and pool it
  // creates (live 2026-10-11): owned by the service, not unattributed (G1.10).
  const managed = r.labels?.['nebius.com/managed-by'] === 'mk8s' ? 'Managed Kubernetes' : r.labels?.managed === 'true' ? MANAGED_SERVICE : undefined;
  // A pool carries no labels of its own when Nebius created it for a subnet given inline CIDRs; the subnet or network
  // it is assigned to (status.assignment) is the explicit owner (#29).
  const assignedTo = r.type === 'vpc-pool' ? r.refs.filter(x => x.relation === 'pool-of').map(x => x.target) : [];
  const sources = [managingNodeGroup(r, all), managingCluster(r, all), ...assignedTo]
    .map(id => (id && id !== r.providerId ? all.get(id) : undefined))
    .filter((x): x is ObservedResource => !!x);
  const viaPool = (src: ObservedResource) => (src.type === 'vpc-subnet' ? 'subnet' : src.type === 'vpc-network' ? 'network' : undefined);
  const managedSource = managed ? undefined : sources.find(src => viaPool(src) && src.labels?.managed === 'true');
  const merged: Attribution = { ...own };
  let from: string | undefined;
  for (const src of sources) {
    const a = attribute(src, liveRoots);
    if (!a.attributed) continue;
    for (const k of INHERITED) {
      if (merged[k] === undefined && a[k] !== undefined) {
        merged[k] = a[k];
        from ??= `${viaPool(src) ?? (src.type === 'mk8s-node-group' ? 'node group' : 'cluster')} ${src.name}`;
      }
    }
  }
  if (!from) {
    const by = managed ?? (managedSource ? MANAGED_SERVICE : undefined);
    return own.attributed || !by ? own : { ...own, managed: by };
  }
  const root = merged.stage && merged.stack ? `terraform/live/${merged.stage}/${merged.stack}` : undefined;
  return { ...merged, attributed: Boolean(merged.stack || merged.stage || merged.owner), liveRoot: root && liveRoots.has(root) ? root : undefined, inheritedFrom: from };
}

/** The TTL that applies to a resource: its own nip-ttl-expires, else the one it inherits (attributeWithParents). */
export function effectiveTtl(a: Pick<Attribution, 'ttlExpires'>, now: Date): TtlState {
  return ttlState({ labels: a.ttlExpires ? { [NIP_LABELS.ttl]: a.ttlExpires } : {} }, now);
}

/** "2026-10-11 10:56 UTC" from an ISO time, as the portal shows times everywhere (never raw ISO). */
export function fmtUtc(iso: string | undefined): string | undefined {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? `${new Date(t).toISOString().slice(0, 16).replace('T', ' ')} UTC` : undefined;
}

/**
 * When a cloud-inventory resource was last read, if that predates the latest inventory sync (its list was not read
 * or failed then): it may no longer exist, so it is shown as "last seen" and never priced. Otherwise undefined.
 */
export function lastSeenBefore(r: { source?: { connector: string }; observedAt?: string }, inventoryReadAt: string | undefined): string | undefined {
  if (!inventoryReadAt || !r.observedAt || r.source?.connector !== 'nebius-inventory') return undefined;
  const t = Date.parse(r.observedAt);
  const at = Date.parse(inventoryReadAt);
  return Number.isFinite(t) && Number.isFinite(at) && t < at ? r.observedAt : undefined;
}

/** The reason a resource the latest inventory sync did not read is left out of a run-rate. */
export function lastSeenReason(observedAt: string): string {
  return `last seen ${fmtUtc(observedAt)}, not in the latest inventory sync`;
}

/** "10:56 UTC" from an ISO time (the clock time other portal texts give next to a date). */
export function fmtUtcClock(iso: string | undefined): string | undefined {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? `${new Date(t).toISOString().slice(11, 16)} UTC` : undefined;
}

/**
 * Why a cluster's Kubernetes figures are not current, when its lifecycle explains it: "Cluster is being deleted
 * (inventory 10:56 UTC)", or "Cluster no longer exists in the inventory". Undefined while the cluster is in the
 * inventory and not deleting. Shared by the API (Overview, Capacity, Workloads, graph) and pages that hold the
 * cluster resource.
 */
export function clusterLifecycleReason(cluster: Pick<ObservedResource, 'status' | 'observedAt'> | undefined, opts: { inventorySynced: boolean }): string | undefined {
  if (!cluster) return opts.inventorySynced ? 'Cluster no longer exists in the inventory' : undefined;
  if (cluster.status !== 'deleting') return undefined;
  const at = fmtUtcClock(cluster.observedAt);
  return `Cluster is being deleted${at ? ` (inventory ${at})` : ''}`;
}

/**
 * Attribution comes only from the nip-* labels the stacks write; a resource
 * without them is unattributed, whatever its name looks like.
 */
export function attribute(
  r: Pick<ObservedResource, 'labels'> & { spec?: ObservedResource['spec'] },
  liveRoots: ReadonlySet<string> = new Set(),
): Attribution {
  const l = r.labels ?? {};
  const platformDefault = r.spec?.platformDefault === true;
  const stage = l[NIP_LABELS.stage];
  const stack = l[NIP_LABELS.stack] ?? l[NIP_LABELS.env];
  const attributed = Boolean(stack || stage || l[NIP_LABELS.owner]);
  const root = stage && stack ? `terraform/live/${stage}/${stack}` : undefined;
  return {
    attributed,
    platformDefault,
    stage,
    stack,
    owner: l[NIP_LABELS.owner],
    run: l[NIP_LABELS.run],
    ttlExpires: l[NIP_LABELS.ttl],
    liveRoot: root && liveRoots.has(root) ? root : undefined,
  };
}

export type TtlState =
  | { state: 'none' }
  | { state: 'invalid'; raw: string }
  | { state: 'active'; expiresAt: string; hoursLeft: number }
  | { state: 'expired'; expiresAt: string; hoursOver: number };

const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

export function ttlState(r: Pick<ObservedResource, 'labels'>, now: Date): TtlState {
  const raw = r.labels?.[NIP_LABELS.ttl];
  if (!raw) return { state: 'none' };
  if (!RFC3339_UTC.test(raw)) return { state: 'invalid', raw };
  const t = Date.parse(raw);
  if (Number.isNaN(t)) return { state: 'invalid', raw };
  const diffH = (t - now.getTime()) / 3_600_000;
  return diffH >= 0
    ? { state: 'active', expiresAt: raw, hoursLeft: Math.floor(diffH) }
    : { state: 'expired', expiresAt: raw, hoursOver: Math.floor(-diffH) };
}

/* ------------------------------------------------------- orphan candidates */

export interface OrphanCandidate {
  uid: string;
  reasons: string[];
}

/** A resource younger than this is not evaluated (attachments and parents settle during provisioning). */
export const ORPHAN_GRACE_MINUTES = 30;

/** Why a resource is not evaluated for orphan rules right now, if it is not. */
export function orphanExemption(r: Pick<ObservedResource, 'createdAt' | 'status'>, now?: Date): string | undefined {
  if (r.status === 'provisioning' || r.status === 'deleting') return `${r.status}: not evaluated until it settles`;
  if (now && r.createdAt) {
    const age = (now.getTime() - Date.parse(r.createdAt)) / 60_000;
    if (Number.isFinite(age) && age < ORPHAN_GRACE_MINUTES) return 'recently created — not evaluated yet';
  }
  return undefined;
}

/**
 * Orphan *candidates* for a person to review; nothing in this product deletes
 * them. Every rule reads an explicit field, never a name pattern:
 *  - a disk with zero attachments and no managing service (status.managedBy),
 *  - a labelled resource whose `parent` target is not in the snapshot,
 *  - a GPU cluster that no instance references,
 *  - a subnet or pool labelled `managed=true` while no managed service (PostgreSQL, MLflow, endpoint) runs in its
 *    network or, for a pool, its project and region: probably left by a deleted service (G1.10).
 * Resources younger than ORPHAN_GRACE_MINUTES or provisioning/deleting are not evaluated.
 * The views show a candidate only after it was one on two consecutive syncs.
 * Expired TTLs are reported separately (ttlState), not as orphans.
 */
export function findOrphanCandidates(resources: ObservedResource[], now?: Date): OrphanCandidate[] {
  const ids = new Set(resources.map(r => r.providerId));
  const fabricUsers = new Set(
    resources.flatMap(r => r.refs.filter(x => x.relation === 'in-fabric').map(x => x.target)),
  );
  const services = resources.filter(r => SERVICES_WITH_NETWORK.includes(r.type));
  const serviceNetworks = new Set(services.flatMap(r => r.refs.filter(x => x.relation === 'in-network').map(x => x.target)));
  const servicePlaces = new Set(services.map(r => `${r.projectId}|${r.region}`));
  const out: OrphanCandidate[] = [];
  for (const r of resources) {
    if (r.spec.platformDefault) continue; // created and owned by the platform with the project
    // Young or transitional resources are not judged: a node's boot disk is attached minutes after it is created.
    if (orphanExemption(r, now)) continue;
    const reasons: string[] = [];
    if (r.type === 'compute-disk' && r.spec.attachments === 0 && !r.spec.managedBy) {
      reasons.push('disk has no attachments');
    }
    const parent = r.refs.find(x => x.relation === 'parent');
    if (parent && !ids.has(parent.target) && attribute(r).attributed) {
      reasons.push(`parent ${parent.target} is not in this snapshot`);
    }
    if (r.type === 'gpu-cluster' && !fabricUsers.has(r.providerId)) {
      reasons.push('no instance in this snapshot is placed in this GPU cluster');
    }
    if ((r.type === 'vpc-subnet' || r.type === 'vpc-pool') && r.labels.managed === 'true') {
      const network = r.refs.find(x => x.relation === 'parent' || x.relation === 'in-network')?.target;
      if (!(network && serviceNetworks.has(network)) && !servicePlaces.has(`${r.projectId}|${r.region}`)) {
        reasons.push('labelled managed=true (created by a Nebius managed service) but no managed service (PostgreSQL, MLflow, endpoint) runs in its network: probably left by a deleted one; confirm with scripts/leftovers.sh before relying on it');
      }
    }
    if (reasons.length) out.push({ uid: r.uid, reasons });
  }
  return out;
}

/* ------------------------------------------------------------------ graph */

export interface GraphNode {
  id: string;
  kind: 'tenant' | 'project' | 'region' | 'resource';
  label: string;
  /** A region node is one project's resources in that region: the project's name (F1.21). */
  sublabel?: string;
  /** Hover text: the raw id behind a named container node (the tenant, #26). */
  hint?: string;
  type?: ResourceType;
  status?: LifecycleStatus;
  depth: number;
  uid?: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  relation: Relation | 'contains';
}

export interface ResourceGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** References whose target is not in the snapshot (shown, never guessed). */
  unresolved: { from: string; relation: Relation; target: string }[];
}

const DEPTH: Partial<Record<ResourceType, number>> = {
  'mk8s-cluster': 3,
  'gpu-cluster': 3,
  'vpc-network': 3,
  'storage-bucket': 3,
  'compute-filesystem': 3,
  'vpc-subnet': 4,
  'mk8s-node-group': 4,
  'k8s-namespace': 4,
  'compute-instance': 5,
  'k8s-workload': 5,
  'compute-disk': 6,
  'k8s-pod': 6,
  'k8s-pvc': 7,
  'vpc-security-group': 4,
  'vpc-route-table': 4,
  'vpc-pool': 3,
  'vpc-allocation': 6,
  'disk-snapshot': 7,
  'nvl-instance-group': 3,
  'container-registry': 3,
  'postgresql-cluster': 4,
  'mlflow-cluster': 4,
  'ai-endpoint': 3,
  'ai-job': 3,
  'ai-devlab': 3,
  'storage-transfer': 3,
  tunnel: 3,
  'kms-key': 3,
  secret: 3,
  'dns-zone': 3,
};

/**
 * Builds the explorer graph from explicit fields only:
 *  - tenant → project → region grouping from tenantId / projectId / region,
 *  - every other edge from a resource's refs whose target is present.
 * Containment edges for a resource are added only when it has no parent ref
 * that already places it below another resource.
 */
/** Relations that place a resource below another one (instead of under its region). */
const PLACEMENT = new Set<Relation>(['parent', 'in-namespace', 'in-cluster', 'member-of', 'attached-to', 'owned-by', 'in-network', 'snapshot-of', 'assigned-to']);

export function buildResourceGraph(resources: ObservedResource[]): ResourceGraph {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const unresolved: ResourceGraph['unresolved'] = [];
  const byProvider = new Map(resources.map(r => [r.providerId, r]));

  const ensure = (n: GraphNode) => {
    if (!nodes.has(n.id)) nodes.set(n.id, n);
    return n.id;
  };

  for (const r of resources) {
    if (r.type === 'tenant' || r.type === 'project') continue;
    ensure({
      id: r.uid,
      kind: 'resource',
      label: r.name || r.providerId,
      type: r.type,
      status: r.status,
      depth: DEPTH[r.type] ?? 5,
      uid: r.uid,
    });
  }

  for (const r of resources) {
    if (r.type === 'tenant' || r.type === 'project') continue;
    const placed = r.refs.some(x => PLACEMENT.has(x.relation) && byProvider.has(x.target));
    if (!placed && r.projectId) {
      // The tenant's name when the snapshot has it, else "Tenant"; never the raw id as the label (#26).
      const tenant = r.tenantId ? ensure({ id: `tenant:${r.tenantId}`, kind: 'tenant', label: byProvider.get(r.tenantId)?.name || 'Tenant', hint: r.tenantId, depth: 0 }) : undefined;
      const project = ensure({ id: `project:${r.projectId}`, kind: 'project', label: projectLabel(resources, r.projectId), depth: 1, uid: projectUid(resources, r.projectId) });
      if (tenant && !edges.some(e => e.from === tenant && e.to === project)) {
        edges.push({ from: tenant, to: project, relation: 'contains' });
      }
      let container = project;
      if (r.region) {
        container = ensure({ id: `region:${r.projectId}:${r.region}`, kind: 'region', label: r.region, sublabel: projectLabel(resources, r.projectId), depth: 2 });
        if (!edges.some(e => e.from === project && e.to === container)) {
          edges.push({ from: project, to: container, relation: 'contains' });
        }
      }
      edges.push({ from: container, to: r.uid, relation: 'contains' });
    }
    for (const ref of r.refs) {
      const target = byProvider.get(ref.target);
      if (!target) {
        unresolved.push({ from: r.uid, relation: ref.relation, target: ref.target });
        continue;
      }
      if (target.type === 'tenant' || target.type === 'project') continue;
      // Draw edges top-down: the container/target above, this resource below.
      edges.push({ from: target.uid, to: r.uid, relation: ref.relation });
    }
  }
  return { nodes: [...nodes.values()], edges, unresolved };
}

/** The project's own resource, when the snapshot has it: a click on its graph node opens it (W1F.S4). */
function projectUid(resources: ObservedResource[], projectId: string): string | undefined {
  return resources.find(r => r.type === 'project' && r.providerId === projectId)?.uid;
}

function projectLabel(resources: ObservedResource[], projectId: string): string {
  const p = resources.find(r => r.type === 'project' && r.providerId === projectId);
  return p?.name ? `${p.name}` : projectId;
}
