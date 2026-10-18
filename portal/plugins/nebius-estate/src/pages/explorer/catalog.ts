import type { CoverageEntry, Relation, ResourceType, ResourceView, TtlState } from '@internal/nebius-domain';
import { fmtUtc, lifecycleLabel, RESOURCE_TYPE_LABELS, UNLABELLABLE } from '@internal/nebius-domain';

/**
 * Explorer-only presentation data per resource type: the service it belongs
 * to, how to look it up outside the portal, and which spec fields matter.
 * Everything here restates the documented REST list paths the inventory
 * connector reads (plugins/nebius-estate-backend/src/inventory/nebius-catalog.ts);
 * nothing is inferred from names.
 */

export type ServiceId = 'org' | 'compute' | 'kubernetes' | 'network' | 'storage' | 'data' | 'ai' | 'security';

export interface ServiceGroup {
  id: ServiceId;
  label: string;
  /** Section of the Nebius console where these resources are listed (no deep links: console URLs are undocumented). */
  console: string;
  types: ResourceType[];
}

export const SERVICE_GROUPS: ServiceGroup[] = [
  { id: 'org', label: 'Organisation', console: 'Administration', types: ['tenant', 'project'] },
  {
    id: 'compute',
    label: 'Compute',
    console: 'Compute',
    types: ['compute-instance', 'compute-disk', 'disk-snapshot', 'compute-filesystem', 'gpu-cluster', 'nvl-instance-group'],
  },
  {
    id: 'kubernetes',
    label: 'Managed Kubernetes',
    console: 'Managed Kubernetes',
    types: ['mk8s-cluster', 'mk8s-node-group', 'k8s-namespace', 'k8s-workload', 'k8s-pod', 'k8s-pvc'],
  },
  {
    id: 'network',
    label: 'Network',
    console: 'Network',
    types: ['vpc-network', 'vpc-subnet', 'vpc-allocation', 'vpc-security-group', 'vpc-route-table', 'vpc-pool', 'dns-zone', 'tunnel'],
  },
  { id: 'storage', label: 'Storage and registry', console: 'Storage', types: ['storage-bucket', 'storage-transfer', 'container-registry'] },
  { id: 'data', label: 'Managed services', console: 'Managed services', types: ['postgresql-cluster', 'mlflow-cluster'] },
  { id: 'ai', label: 'Serverless AI', console: 'AI Studio', types: ['ai-endpoint', 'ai-job', 'ai-devlab'] },
  { id: 'security', label: 'Security', console: 'Security', types: ['kms-key', 'secret'] },
];

const SERVICE_OF = new Map<ResourceType, ServiceGroup>(SERVICE_GROUPS.flatMap(g => g.types.map(t => [t, g] as const)));

export function serviceOf(type: ResourceType): ServiceGroup {
  return SERVICE_OF.get(type) ?? SERVICE_GROUPS[0];
}

/** Type filter value: a single type, or `svc:<service>` for every type of one service. */
export function matchesTypeFilter(type: ResourceType, filter: string): boolean {
  if (!filter) return true;
  if (filter.startsWith('svc:')) return serviceOf(type).id === filter.slice(4);
  return type === filter;
}

/* ------------------------------------------------------------- relations */

export const RELATION_LABELS: Record<Relation | 'contains', { out: string; in: string }> = {
  contains: { out: 'contains', in: 'grouped under' },
  parent: { out: 'child of', in: 'parent of' },
  'member-of': { out: 'member of', in: 'has member' },
  'attached-to': { out: 'attached to', in: 'has attached' },
  'mounted-by': { out: 'mounted by', in: 'mounts' },
  'in-fabric': { out: 'in GPU fabric', in: 'GPU fabric of' },
  'in-subnet': { out: 'in subnet', in: 'subnet of' },
  'runs-on': { out: 'runs on', in: 'runs' },
  'owned-by': { out: 'owned by', in: 'owns' },
  'bound-to': { out: 'bound to', in: 'bound by' },
  'in-namespace': { out: 'in namespace', in: 'namespace of' },
  'in-cluster': { out: 'in cluster', in: 'cluster of' },
  'assigned-to': { out: 'IP assigned to', in: 'has IP allocation' },
  'in-network': { out: 'in network', in: 'network of' },
  routes: { out: 'routes subnet', in: 'routed by' },
  'snapshot-of': { out: 'snapshot of', in: 'has snapshot' },
  'backed-by': { out: 'backed by VM', in: 'backs' },
  'managed-by': { out: 'managed by', in: 'manages' },
  'secured-by': { out: 'secured by', in: 'secures' },
  'pool-of': { out: 'pool of', in: 'uses pool' },
};

/** Relations that place a resource below another one; the others are cross-references in the graph. */
export const PLACEMENT_RELATIONS: ReadonlySet<string> = new Set([
  'contains',
  'parent',
  'in-namespace',
  'in-cluster',
  'member-of',
  'attached-to',
  'owned-by',
  'in-network',
  'snapshot-of',
  'assigned-to',
]);

/**
 * The relation(s) between a resource and one related resource, read from the
 * refs on either side. Empty when the related resource is not in `index`.
 */
export function relationLabels(r: Pick<ResourceView, 'providerId' | 'refs'>, other: Pick<ResourceView, 'providerId' | 'refs'> | undefined): string[] {
  if (!other) return [];
  const out = r.refs.filter(x => x.target === other.providerId).map(x => RELATION_LABELS[x.relation].out);
  const inn = other.refs.filter(x => x.target === r.providerId).map(x => RELATION_LABELS[x.relation].in);
  return [...new Set([...out, ...inn])];
}

/* -------------------------------------------------------------- pointers */

interface Api {
  /** Documented REST list path (the get-by-id path is `<path>/{id}`). */
  path: string;
  /** `nebius` CLI words: service [api-version] resource. */
  cli: string;
}

const API: Partial<Record<ResourceType, Api>> = {
  project: { path: '/iam/v2/projects', cli: 'iam v2 project' },
  'compute-instance': { path: '/compute/v1/instances', cli: 'compute instance' },
  'compute-disk': { path: '/compute/v1/disks', cli: 'compute disk' },
  'disk-snapshot': { path: '/compute/v1/disk-snapshots', cli: 'compute disk-snapshot' },
  'compute-filesystem': { path: '/compute/v1/filesystems', cli: 'compute filesystem' },
  'gpu-cluster': { path: '/compute/v1/gpu-clusters', cli: 'compute gpu-cluster' },
  'nvl-instance-group': { path: '/compute/v1/nvl-instance-groups', cli: 'compute nvl-instance-group' },
  'mk8s-cluster': { path: '/mk8s/v1/clusters', cli: 'mk8s cluster' },
  'mk8s-node-group': { path: '/mk8s/v1/node-groups', cli: 'mk8s node-group' },
  'vpc-network': { path: '/vpc/v1/networks', cli: 'vpc network' },
  'vpc-subnet': { path: '/vpc/v1/subnets', cli: 'vpc subnet' },
  'vpc-allocation': { path: '/vpc/v1/allocations', cli: 'vpc allocation' },
  'vpc-security-group': { path: '/vpc/v1/security-groups', cli: 'vpc security-group' },
  'vpc-route-table': { path: '/vpc/v1/route-tables', cli: 'vpc route-table' },
  'vpc-pool': { path: '/vpc/v1/pools', cli: 'vpc pool' },
  'dns-zone': { path: '/dns/v1/zones', cli: 'dns zone' },
  tunnel: { path: '/tunnel/v1/tunnels', cli: 'tunnel' },
  'storage-bucket': { path: '/storage/v1/buckets', cli: 'storage bucket' },
  'storage-transfer': { path: '/storage/v1/transfers', cli: 'storage transfer' },
  'container-registry': { path: '/registry/v1/registries', cli: 'registry' },
  'postgresql-cluster': { path: '/msp/postgresql/v1alpha1/clusters', cli: 'msp postgresql v1alpha1 cluster' },
  'mlflow-cluster': { path: '/msp/mlflow/v1alpha1/clusters', cli: 'msp mlflow v1alpha1 cluster' },
  'ai-endpoint': { path: '/ai/v1/endpoints', cli: 'ai endpoint' },
  'ai-job': { path: '/ai/v1/jobs', cli: 'ai job' },
  'ai-devlab': { path: '/ai/v1/devlabs', cli: 'ai devlab' },
  'kms-key': { path: '/kms/v1/symmetric-keys', cli: 'kms symmetric-key' },
  secret: { path: '/mysterybox/v1/secrets', cli: 'mysterybox secret' },
};

const KUBE_KIND: Partial<Record<ResourceType, string>> = { 'k8s-namespace': 'namespace', 'k8s-workload': 'deployment,statefulset,daemonset,job', 'k8s-pod': 'pod', 'k8s-pvc': 'pvc' };

export interface LookupPointer {
  /** Where to find it in the console (section only; console URLs are not documented, so there is no link). */
  console: string;
  /** Read-only REST GET, when the type comes from the Nebius API. */
  rest?: string;
  /** Read-only CLI command. */
  cli?: string;
  note?: string;
}

/** How to look the resource up outside the portal. Read-only commands only. */
export function lookupPointer(r: Pick<ResourceView, 'type' | 'providerId' | 'name' | 'source'>): LookupPointer {
  const svc = serviceOf(r.type);
  const api = API[r.type];
  if (r.source.kind === 'kubernetes-api' || KUBE_KIND[r.type]) {
    const kind = KUBE_KIND[r.type];
    return {
      console: svc.console,
      cli: kind ? `kubectl get ${kind} --all-namespaces --field-selector metadata.name=${r.name}` : undefined,
      note: 'Kubernetes objects are read from the cluster API, not from Nebius.',
    };
  }
  if (!api) return { console: svc.console };
  return {
    console: `${svc.console} → ${RESOURCE_TYPE_LABELS[r.type].replace(' (metadata only)', '')}`,
    rest: `GET ${api.path}/${r.providerId}`,
    cli: `nebius ${api.cli} get --id ${r.providerId}`,
    note:
      r.type === 'secret'
        ? 'Metadata only: the portal never requests or stores secret payloads.'
        : undefined,
  };
}

/* ------------------------------------------------------------ key fields */

export type Resolve = (providerId: string) => string | undefined;

const targets = (r: Pick<ResourceView, 'refs'>, relation: Relation) => r.refs.filter(x => x.relation === relation).map(x => x.target);
const named = (ids: string[], resolve: Resolve) => (ids.length ? ids.map(id => resolve(id) ?? id).join(', ') : undefined);
const yesNo = (v: boolean | undefined, yes: string, no: string) => (v === undefined ? undefined : v ? yes : no);

/**
 * Type-specific fields for the drawer, from `spec` and `refs` only. A row is
 * left out when its source field is absent (never rendered as 0 or "no").
 */
export function keyFields(r: Pick<ResourceView, 'type' | 'spec' | 'refs'>, resolve: Resolve): [string, string][] {
  const s = r.spec;
  const rows: [string, string | undefined][] = [];
  switch (r.type) {
    case 'vpc-allocation':
      rows.push(
        ['Address', s.summary || undefined],
        ['Visibility', yesNo(s.public, 'public IP', 'private IP')],
        ['Assigned to', named(targets(r, 'assigned-to'), resolve) ?? 'not assigned to an instance'],
        ['Subnet', named(targets(r, 'in-subnet'), resolve)],
      );
      break;
    case 'vpc-security-group':
      rows.push(['Network', named(targets(r, 'in-network'), resolve)], ['Project default', s.platformDefault ? 'yes (status.default)' : undefined]);
      break;
    case 'vpc-route-table': {
      const subnets = targets(r, 'routes');
      rows.push(
        ['Network', named(targets(r, 'in-network'), resolve)],
        ['Routes subnets', subnets.length ? `${subnets.length}: ${named(subnets, resolve)}` : 'none assigned'],
        ['Project default', s.platformDefault ? 'yes (status.default)' : undefined],
      );
      break;
    }
    case 'vpc-pool':
      rows.push(['Pool', s.summary || undefined], ['Visibility', yesNo(s.public, 'public', 'private')]);
      break;
    case 'disk-snapshot':
      rows.push(['Source disk', named(targets(r, 'snapshot-of'), resolve)], ['Stored size', s.sizeGib !== undefined ? `${s.sizeGib} GiB` : undefined]);
      break;
    case 'nvl-instance-group':
      rows.push(['Group', s.summary || undefined]);
      break;
    case 'container-registry':
      rows.push(['Images', s.summary || undefined]);
      break;
    case 'postgresql-cluster':
    case 'mlflow-cluster':
      rows.push(['Network', named(targets(r, 'in-network'), resolve)], ['Public access', yesNo(s.public, 'enabled', 'disabled')]);
      break;
    case 'ai-endpoint':
    case 'ai-job':
    case 'ai-devlab': {
      const vms = targets(r, 'backed-by');
      rows.push(
        ['Platform', s.platform],
        ['Preset', s.preset],
        ['GPUs', s.gpus !== undefined ? String(s.gpus) : undefined],
        ['Public IP', yesNo(s.public, 'yes', 'no')],
        ['Backing VMs', vms.length ? named(vms, resolve) : 'none reported'],
      );
      break;
    }
    case 'storage-transfer':
      rows.push(['Suspension state', s.summary || undefined]);
      break;
    case 'tunnel':
      rows.push(['Connection', s.summary || undefined]);
      break;
    case 'kms-key':
      rows.push(['Algorithm', s.summary || undefined]);
      break;
    case 'secret':
      rows.push(['Contents', 'metadata only (name, labels, state); payloads are never read']);
      break;
    case 'dns-zone':
      rows.push(['Zone', s.summary || undefined]);
      break;
    case 'vpc-network':
    case 'vpc-subnet':
      rows.push(['Project default', s.platformDefault ? 'yes (status.default)' : undefined]);
      break;
    default:
      rows.push(['Summary', s.summary || undefined]);
  }
  return rows.filter((x): x is [string, string] => x[1] !== undefined && x[1] !== '');
}

/** One short line for the table: the type's most telling field. */
export function shortSummary(r: Pick<ResourceView, 'type' | 'spec' | 'refs'>): string | undefined {
  if (r.type === 'secret') return 'metadata only';
  if (r.type === 'vpc-route-table') {
    const n = targets(r, 'routes').length;
    return `${n} subnet${n === 1 ? '' : 's'}`;
  }
  if (r.type === 'ai-endpoint' || r.type === 'ai-job' || r.type === 'ai-devlab') return r.spec.preset;
  return r.spec.summary || undefined;
}

/** A resource's TTL for the drawer: "2026-10-11 10:44 UTC (active)", formatted like every other time. */
export function ttlText(t: TtlState): string {
  if (t.state === 'none') return 'none';
  if (t.state === 'invalid') return `invalid: ${t.raw}`;
  return `${fmtUtc(t.expiresAt) ?? t.expiresAt} (${t.state})`;
}

/**
 * The Explorer's partial-coverage callout: one sentence per project that was not fully read, named, each ending in a
 * full stop, so "See Integrations & Coverage." starts a sentence of its own (W1F.S7).
 */
export function partialCoverageSentences(coverage: CoverageEntry[]): string[] {
  return coverage
    .filter(c => c.partial && c.note)
    .map(c => {
      const note = c.note!.trim().replace(/\.$/, '');
      return c.project ? `${c.project.name ?? c.project.id}: ${note}.` : `${note.charAt(0).toUpperCase()}${note.slice(1)}.`;
    });
}

/**
 * How a resource's attribution reads, once, for the Explorer table and the drawer alike (#46: the table said "managed
 * by a Nebius managed service" and the drawer "unattributed" for the same subnet).
 */
export type AttributionView =
  | { kind: 'attributed'; text: string; via?: string }
  | { kind: 'project'; sentence: string }
  | { kind: 'default'; chip: 'default'; title: string; sentence: string }
  | { kind: 'managed'; chip: 'managed'; title: string; sentence: string }
  | { kind: 'unattributed'; sentence: string; note?: string; title?: string };

const DEFAULT_TITLE = 'Created by Nebius with the project (status.default); not ours to attribute';

export function attributionView(r: Pick<ResourceView, 'type' | 'attribution' | 'refs' | 'spec'>, name: (providerId: string) => string | undefined = () => undefined): AttributionView {
  const a = r.attribution;
  if (a.attributed) return { kind: 'attributed', text: `${a.stage ?? 'no stage'} / ${a.stack ?? 'no stack'}`, ...(a.inheritedFrom ? { via: a.inheritedFrom } : {}) };
  if (r.type === 'project') return { kind: 'project', sentence: 'Not applicable (a project holds resources; it is not attributed).' };
  if (a.platformDefault) return { kind: 'default', chip: 'default', title: DEFAULT_TITLE, sentence: 'Project default created by Nebius (status.default): not ours to attribute.' };
  if (a.managed) return { kind: 'managed', chip: 'managed', title: `Managed by ${a.managed}; the resource does not name it`, sentence: `Managed by ${a.managed}: not ours to attribute.` };
  const to = r.type === 'vpc-pool' ? r.refs.filter(x => x.relation === 'pool-of').map(x => name(x.target) ?? x.target) : [];
  if (r.type === 'vpc-pool' && (to.length || r.spec.assignmentRead)) {
    // #29: a pool without labels says why: what it is assigned to (its owner), or, when the API said so, that it is
    // assigned to nothing. Not that nothing uses it: allocations (ipv4_private/ipv4_public.pool_id) and child pools
    // (source_pool_id) can draw from a pool directly, and neither field is read here.
    if (!to.length) return { kind: 'unattributed', sentence: 'No nip-* labels, and assigned to no subnet or network (status.assignment); allocations or child pools may still use it directly (pool_id / source_pool_id are not read here).', note: 'assigned to no subnet or network' };
    return { kind: 'unattributed', sentence: `No nip-* labels: assigned to ${to.join(', ')}, which has no nip-* labels either.`, note: `pool of ${to.join(', ')}` };
  }
  const why = UNLABELLABLE[r.type];
  if (why) return { kind: 'unattributed', sentence: `Unattributed: ${why}`, note: 'the service keeps no labels', title: why };
  return { kind: 'unattributed', sentence: 'No nip-* labels: unattributed (never inferred from the name).' };
}

/**
 * The drawer's Status: the lifecycle word, with the API state after it only when it says more ("error — ERROR: boot
 * disk not found", never "active — ACTIVE": #56). A container has no lifecycle status; its API state is shown as such
 * (F1.21).
 */
export function drawerStatus(d: Pick<ResourceView, 'type' | 'status' | 'statusDetail'>): string | undefined {
  const label = lifecycleLabel(d.type, d.status);
  if (!label) return d.statusDetail ? `API state ${d.statusDetail}` : undefined;
  return d.statusDetail && d.statusDetail.trim().toLowerCase() !== label.toLowerCase() ? `${label} — ${d.statusDetail}` : label;
}
