import { LifecycleStatus, ObservedResource, ResourceRef, ResourceType } from '@internal/nebius-domain';
import { NEBIUS_API } from './endpoints';

/**
 * Field mapping from documented Nebius REST list items to ObservedResource.
 * Tolerant of camelCase (REST) and snake_case (CLI JSON). Only fields that are
 * named here are kept: specs that may hold secrets (serverless env vars, auth
 * tokens, registry credentials, secret payloads) are never copied.
 */

export type Json = Record<string, any>;

export const pick = (o: Json | undefined, ...keys: string[]): any => {
  if (!o) return undefined;
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k];
  return undefined;
};

export function mapState(state: unknown): LifecycleStatus {
  const s = String(state ?? '').toUpperCase();
  // IP allocations: ALLOCATED / ASSIGNED are in use (vpc.v1 Allocation status.state).
  if (['RUNNING', 'READY', 'ACTIVE', 'SUCCESS', 'ALLOCATED', 'ASSIGNED'].some(x => s.includes(x))) return 'running';
  if (['STARTING', 'CREATING', 'PROVISIONING', 'UPDATING', 'RECONCILING', 'ALLOCATING'].some(x => s.includes(x))) return 'provisioning';
  if (['STOPPED', 'STOPPING'].some(x => s.includes(x))) return 'stopped';
  if (s.includes('DELET')) return 'deleting';
  if (['ERROR', 'FAILED'].some(x => s.includes(x))) return 'error';
  return 'unknown';
}

export interface Ctx {
  projectId: string;
  region?: string;
  tenantId?: string;
  observedAt: string;
  /** API origin the item was listed from (NEBIUS_API unless a test endpoint is configured). */
  endpoint?: string;
  /** Catalog capability that listed the item (lets a failed later sync keep this data, marked stale). */
  capability?: string;
}

export function base(item: Json, type: ResourceType, ctx: Ctx, notes: string[] = []): ObservedResource {
  const md = item.metadata ?? {};
  const st = item.status ?? {};
  const id = String(md.id);
  const parent = pick(md, 'parentId', 'parent_id');
  return {
    uid: `nebius:${id}`,
    providerId: id,
    type,
    name: String(md.name ?? id),
    tenantId: ctx.tenantId,
    projectId: typeof parent === 'string' && parent.startsWith('project-') ? parent : ctx.projectId,
    region: ctx.region,
    labels: (md.labels ?? {}) as Record<string, string>,
    status: mapState(pick(st, 'state', 'phase')),
    statusDetail: pick(st, 'stateDescription', 'state_description') as string | undefined,
    apiState: typeof pick(st, 'state', 'phase') === 'string' ? String(pick(st, 'state', 'phase')).toUpperCase() : undefined,
    createdAt: pick(md, 'createdAt', 'created_at') as string | undefined,
    refs: [],
    spec: {},
    source: { connector: 'nebius-inventory', kind: 'nebius-api', endpoint: ctx.endpoint ?? NEBIUS_API, capability: ctx.capability },
    observedAt: ctx.observedAt,
    coverageNotes: notes,
  };
}

export function mapInstance(item: Json, ctx: Ctx): ObservedResource {
  const r = base(item, 'compute-instance', ctx);
  const spec = item.spec ?? {};
  const res = spec.resources ?? {};
  const preset = String(res.preset ?? '');
  const m = /^(?:(\d+)gpu-)?(\d+)vcpu-(\d+)gb$/.exec(preset);
  const refs: ResourceRef[] = [];
  const gpuCluster = pick(pick(spec, 'gpuCluster', 'gpu_cluster'), 'id');
  if (gpuCluster) refs.push({ relation: 'in-fabric', target: String(gpuCluster) });
  const boot = pick(pick(pick(spec, 'bootDisk', 'boot_disk'), 'existingDisk', 'existing_disk'), 'id');
  if (boot) refs.push({ relation: 'attached-to', target: String(boot) }); // reversed below by the caller
  for (const fs of (pick(spec, 'filesystems') ?? []) as Json[]) {
    const fid = pick(pick(fs, 'existingFilesystem', 'existing_filesystem'), 'id');
    if (fid) refs.push({ relation: 'mounted-by', target: String(fid) });
  }
  for (const ni of (pick(spec, 'networkInterfaces', 'network_interfaces') ?? []) as Json[]) {
    const sub = pick(ni, 'subnetId', 'subnet_id');
    if (sub) refs.push({ relation: 'in-subnet', target: String(sub) });
    for (const sg of (pick(ni, 'securityGroups', 'security_groups') ?? []) as Json[]) {
      const id = pick(sg, 'id');
      if (id && !refs.some(x => x.relation === 'secured-by' && x.target === String(id))) refs.push({ relation: 'secured-by', target: String(id) });
    }
  }
  const preemptible = pick(spec, 'preemptible') !== undefined;
  r.spec = {
    platform: res.platform,
    preset: preset || undefined,
    gpus: m?.[1] ? Number(m[1]) : 0,
    vcpus: m ? Number(m[2]) : undefined,
    ramGib: m ? Number(m[3]) : undefined,
    capacityType: preemptible ? 'preemptible' : 'unknown',
  };
  // Instance → disk/filesystem are stored on the instance; the explorer draws
  // them from the disk / filesystem side, so keep only fabric, subnet and security groups here.
  r.refs = refs.filter(x => x.relation === 'in-fabric' || x.relation === 'in-subnet' || x.relation === 'secured-by');
  // A node VM: member of its node group (placement), or managed by the cluster when only that label is set.
  const ng = r.labels['mk8s-node-group-id'];
  if (ng) r.refs.push({ relation: 'member-of', target: ng });
  else r.refs.push(...mk8sManagedRefs(r.labels));
  (r as any)._attachRefs = refs.filter(x => x.relation === 'attached-to' || x.relation === 'mounted-by');
  if (!preemptible) r.coverageNotes.push('Capacity type: on-demand vs reserved is not distinguishable from the instance spec alone.');
  return r;
}

/**
 * A disk's or filesystem's size in GiB. The spec takes exactly one of size_bytes, size_kibibytes, size_mebibytes or
 * size_gibibytes, and status.size_bytes is read-only (terraform-provider compute_v1_disk, compute_v1_filesystem);
 * CSI-created disks need not use GiB (followup 15). Rounded to three decimals; undefined when none is reported.
 */
export function storageSizeGib(spec: Json, status: Json): number | undefined {
  const units: Array<[number, string, string]> = [
    [1, 'sizeGibibytes', 'size_gibibytes'],
    [2 ** 10, 'sizeMebibytes', 'size_mebibytes'],
    [2 ** 20, 'sizeKibibytes', 'size_kibibytes'],
    [2 ** 30, 'sizeBytes', 'size_bytes'],
  ];
  const read = (o: Json, camel: string, snake: string): number | undefined => {
    const v = pick(o, camel, snake);
    const n = Number(v);
    return v === undefined || v === '' || !Number.isFinite(n) || n < 0 ? undefined : n;
  };
  for (const [div, camel, snake] of units) {
    const n = read(spec, camel, snake);
    if (n !== undefined) return Math.round((n / div) * 1000) / 1000;
  }
  const bytes = read(status, 'sizeBytes', 'size_bytes');
  return bytes === undefined ? undefined : Math.round((bytes / 2 ** 30) * 1000) / 1000;
}

export function mapDisk(item: Json, ctx: Ctx): ObservedResource {
  const r = base(item, 'compute-disk', ctx);
  const spec = item.spec ?? {};
  const st = item.status ?? {};
  // Live (2026-10-11): status.readWriteAttachment is the instance id; read-only attachments are a list.
  const asList = (v: unknown): unknown[] => (v === undefined || v === null || v === '' ? [] : Array.isArray(v) ? v : [v]);
  const attachments = [
    ...asList(pick(st, 'readWriteAttachment', 'read_write_attachment')),
    ...asList(pick(st, 'readWriteAttachments', 'read_write_attachments')),
    ...asList(pick(st, 'readOnlyAttachments', 'read_only_attachments')),
  ]
    .map(a => (typeof a === 'string' ? a : pick(a as Json, 'instanceId', 'instance_id', 'id')))
    .filter((t): t is string => typeof t === 'string' && t.length > 0);
  const managedBy = pick(st, 'managedBy', 'managed_by');
  r.spec = {
    sizeGib: storageSizeGib(spec, st),
    diskType: pick(spec, 'type'),
    attachments: new Set(attachments).size,
    managedBy: managedBy === undefined ? undefined : typeof managedBy === 'string' ? managedBy : JSON.stringify(managedBy).slice(0, 200),
  };
  r.refs = [...new Set(attachments)].map(t => ({ relation: 'attached-to' as const, target: t }));
  r.refs.push(...mk8sManagedRefs(r.labels));
  if (!Object.keys(r.labels).length && r.name.startsWith('pvc-')) {
    r.coverageNotes.push('Unlabelled disk; CSI-created disks carry no nip-* labels (attribution needs the PVC binding).');
  }
  return r;
}

/** Node VMs and their disks carry the node group and cluster they were created for (labels set by Managed Kubernetes). */
function mk8sManagedRefs(labels: Record<string, string>): ResourceRef[] {
  const ng = labels['mk8s-node-group-id'];
  const cluster = labels['mk8s-cluster-id'];
  if (ng) return [{ relation: 'managed-by', target: ng }];
  return cluster ? [{ relation: 'managed-by', target: cluster }] : [];
}

export function mapFilesystem(item: Json, ctx: Ctx): ObservedResource {
  const r = base(item, 'compute-filesystem', ctx);
  const spec = item.spec ?? {};
  r.spec = { sizeGib: storageSizeGib(spec, item.status ?? {}), diskType: pick(spec, 'type') };
  return r;
}

export function mapGpuCluster(item: Json, ctx: Ctx): ObservedResource {
  const r = base(item, 'gpu-cluster', ctx);
  r.spec = { fabric: pick(item.spec, 'infinibandFabric', 'infiniband_fabric') };
  return r;
}

export function mapCluster(item: Json, ctx: Ctx): ObservedResource {
  const r = base(item, 'mk8s-cluster', ctx);
  const cp = pick(item.spec, 'controlPlane', 'control_plane') ?? {};
  const st = pick(item.status, 'controlPlane', 'control_plane') ?? {};
  r.spec = { k8sVersion: pick(st, 'version') ?? pick(cp, 'version') };
  const sub = pick(cp, 'subnetId', 'subnet_id');
  if (sub) r.refs.push({ relation: 'in-subnet', target: String(sub) });
  return r;
}

export function mapNodeGroup(item: Json, ctx: Ctx, clusterId: string): ObservedResource {
  const r = base(item, 'mk8s-node-group', ctx);
  const spec = item.spec ?? {};
  const tpl = spec.template ?? {};
  const res = tpl.resources ?? {};
  const preset = String(res.preset ?? '');
  const gpus = /^(\d+)gpu-/.exec(preset)?.[1];
  const auto = spec.autoscaling;
  const reservation = pick(tpl, 'reservationPolicy', 'reservation_policy');
  const policy = reservation ? pick(reservation, 'policy') : undefined;
  r.refs = [{ relation: 'parent', target: clusterId }];
  const gpuCluster = pick(pick(tpl, 'gpuCluster', 'gpu_cluster'), 'id');
  if (gpuCluster) r.refs.push({ relation: 'in-fabric', target: String(gpuCluster) });
  r.spec = {
    platform: res.platform,
    preset: preset || undefined,
    gpus: gpus ? Number(gpus) : 0,
    fixedNodeCount: pick(spec, 'fixedNodeCount', 'fixed_node_count') !== undefined ? Number(pick(spec, 'fixedNodeCount', 'fixed_node_count')) : undefined,
    autoscaling: auto ? { min: Number(pick(auto, 'minNodeCount', 'min_node_count') ?? 0), max: Number(pick(auto, 'maxNodeCount', 'max_node_count') ?? 0) } : undefined,
    capacityType: pick(tpl, 'preemptible') !== undefined ? 'preemptible' : policy && policy !== 'NONE' ? 'reserved' : 'on-demand',
    reservationPolicy: policy ? String(policy) : undefined,
  };
  return r;
}

/** Nebius creates a default network and subnet with each project (`status.default`); they are not ours to attribute. */
export function markPlatformDefault(r: ObservedResource, item: Json): ObservedResource {
  if (item.status?.default === true) {
    r.spec = { ...r.spec, platformDefault: true };
    r.coverageNotes.push('Project default created by Nebius (status.default): carries no nip-* labels by design.');
  }
  return r;
}

export function mapNetwork(item: Json, ctx: Ctx): ObservedResource {
  const r = markPlatformDefault(base(item, 'vpc-network', ctx), item);
  // The pools a default network draws from are project defaults too (resolved by the caller).
  if (r.spec.platformDefault) {
    const pools = ['ipv4PrivatePools', 'ipv4_private_pools', 'ipv4PublicPools', 'ipv4_public_pools'].flatMap(k => ((item.spec?.[k]?.pools ?? []) as Json[]).map(p => p?.id).filter((x): x is string => typeof x === 'string'));
    if (pools.length) (r as any)._defaultPools = pools;
  }
  return r;
}

export function mapSubnet(item: Json, ctx: Ctx): ObservedResource {
  const r = base(item, 'vpc-subnet', ctx);
  const net = pick(item.spec, 'networkId', 'network_id');
  if (net) r.refs.push({ relation: 'parent', target: String(net) });
  return markPlatformDefault(r, item);
}

export function mapBucket(item: Json, ctx: Ctx): ObservedResource {
  const r = base(item, 'storage-bucket', ctx, ['Bucket size and object counts are not read.']);
  // Storage class, versioning and lifecycle rules: what R8 sets on its buckets (live run 2026-10-11).
  const cls = pick(item.spec, 'defaultStorageClass', 'default_storage_class');
  const versioning = pick(item.spec, 'versioningPolicy', 'versioning_policy');
  const rules = pick(pick(item.spec, 'lifecycleConfiguration', 'lifecycle_configuration'), 'rules');
  const n = Array.isArray(rules) ? rules.length : 0;
  const parts = [cls && String(cls), versioning && `versioning ${versioning}`, n ? `${n} lifecycle rule${n === 1 ? '' : 's'}` : undefined].filter(Boolean);
  if (parts.length) r.spec = { ...r.spec, summary: parts.join(' · ') };
  return r;
}


/* ------------------------------------------------- further documented lists */

const num = (v: unknown): number | undefined => {
  const n = Number(v);
  return v === undefined || v === null || v === '' || !Number.isFinite(n) ? undefined : n;
};
const ids = (v: unknown): string[] => (Array.isArray(v) ? v.map(x => (typeof x === 'string' ? x : pick(x as Json, 'id'))).filter((x): x is string => typeof x === 'string' && x.length > 0) : []);

export function mapAllocation(item: Json, ctx: Ctx): ObservedResource {
  const r = base(item, 'vpc-allocation', ctx);
  const st = item.status ?? {};
  const ni = pick(pick(st, 'assignment'), 'networkInterface', 'network_interface');
  const instance = pick(ni, 'instanceId', 'instance_id');
  if (instance) r.refs.push({ relation: 'assigned-to', target: String(instance) });
  const details = pick(st, 'details') ?? {};
  const pub = pick(item.spec, 'ipv4Public', 'ipv4_public');
  const subnet = pick(details, 'subnetId', 'subnet_id') ?? pick(pub ?? pick(item.spec, 'ipv4Private', 'ipv4_private'), 'subnetId', 'subnet_id');
  if (subnet) r.refs.push({ relation: 'in-subnet', target: String(subnet) });
  r.spec = { public: Boolean(pub), summary: [pick(details, 'allocatedCidr', 'allocated_cidr'), pub ? 'public' : 'private', pick(st, 'static') ? 'static' : undefined].filter(Boolean).join(' · ') };
  if (!instance && !pick(pick(st, 'assignment'), 'loadBalancer', 'load_balancer')) r.coverageNotes.push('Not assigned to an instance or load balancer.');
  // A LoadBalancer Service's address (documented label) and node addresses carry their cluster.
  if (r.labels['nebius.com/managed-by'] === 'mk8s') r.coverageNotes.push('Created by Managed Kubernetes for a LoadBalancer Service (label nebius.com/managed-by: mk8s).');
  r.refs.push(...mk8sManagedRefs(r.labels));
  return r;
}

function inNetwork(r: ObservedResource, item: Json): ObservedResource {
  const net = pick(item.spec, 'networkId', 'network_id');
  if (net) r.refs.push({ relation: 'in-network', target: String(net) });
  return r;
}

/** The security group MK8s creates per cluster for its node groups (docs/naming.md §6). */
const MK8S_SYSTEM_SG = /^(mk8scluster-[a-z0-9]+)-node-groups-system$/;

export function mapSecurityGroup(item: Json, ctx: Ctx): ObservedResource {
  const r = markPlatformDefault(inNetwork(base(item, 'vpc-security-group', ctx), item), item);
  const cluster = MK8S_SYSTEM_SG.exec(r.name)?.[1];
  if (cluster && !r.spec.platformDefault) {
    r.refs.push({ relation: 'managed-by', target: cluster });
    r.coverageNotes.push('Security group Managed Kubernetes creates for the cluster’s node groups (recognised by name).');
  }
  return r;
}

export function mapRouteTable(item: Json, ctx: Ctx): ObservedResource {
  const r = markPlatformDefault(inNetwork(base(item, 'vpc-route-table', ctx), item), item);
  for (const subnet of ids(pick(pick(item.status, 'assignment'), 'subnets'))) r.refs.push({ relation: 'routes', target: subnet });
  return r;
}

export function mapPool(item: Json, ctx: Ctx): ObservedResource {
  const r = markPlatformDefault(base(item, 'vpc-pool', ctx), item);
  r.spec = { ...r.spec, summary: [pick(item.spec, 'visibility'), pick(item.spec, 'version')].filter(Boolean).join(' · '), public: pick(item.spec, 'visibility') === 'PUBLIC' };
  // The subnets and networks the pool is assigned to (documented status.assignment): who owns an unlabelled pool (#29).
  const assignment = pick(item.status, 'assignment');
  if (assignment && typeof assignment === 'object') r.spec = { ...r.spec, assignmentRead: true };
  for (const target of [...ids(pick(assignment, 'subnets')), ...ids(pick(assignment, 'networks'))]) r.refs.push({ relation: 'pool-of', target });
  // Fallback when no explicit field says so (a default network's pool list is the stronger signal, applied by the caller).
  if (!r.spec.platformDefault && /^default-(network|public)-pool(-[a-z0-9-]+)?$/.test(r.name)) {
    r.spec.platformDefault = true;
    r.coverageNotes.push('Project default pool created by Nebius (recognised by name): carries no nip-* labels by design.');
  }
  return r;
}

/** A default network's pools become project defaults (explicit reference, stronger than the name). */
export function markDefaultPools(resources: ObservedResource[]): void {
  const pools = new Set<string>();
  for (const r of resources) {
    for (const id of ((r as any)._defaultPools ?? []) as string[]) pools.add(id);
    delete (r as any)._defaultPools;
  }
  for (const r of resources) {
    if (r.type !== 'vpc-pool' || !pools.has(r.providerId) || r.spec.platformDefault) continue;
    r.spec = { ...r.spec, platformDefault: true };
    r.coverageNotes.push('Pool of the project’s default network (spec.ipv4_*_pools): carries no nip-* labels by design.');
  }
}

export function mapDiskSnapshot(item: Json, ctx: Ctx): ObservedResource {
  const r = base(item, 'disk-snapshot', ctx);
  const src = pick(item.spec, 'sourceDiskId', 'source_disk_id');
  if (src) r.refs.push({ relation: 'snapshot-of', target: String(src) });
  const bytes = num(pick(item.status, 'storageSizeBytes', 'storage_size_bytes'));
  r.spec = { sizeGib: bytes === undefined ? undefined : Math.round((bytes / 2 ** 30) * 10) / 10 };
  return r;
}

export function mapNvlGroup(item: Json, ctx: Ctx): ObservedResource {
  const r = base(item, 'nvl-instance-group', ctx);
  r.spec = { summary: [pick(item.spec, 'type'), pick(item.spec, 'size') ? `× ${pick(item.spec, 'size')}` : undefined].filter(Boolean).join(' ') };
  return r;
}

export function mapRegistry(item: Json, ctx: Ctx): ObservedResource {
  const r = base(item, 'container-registry', ctx);
  const images = num(pick(item.status, 'imagesCount', 'images_count')) ?? num(pick(item.spec, 'imagesCount', 'images_count'));
  r.spec = { summary: images === undefined ? '' : `${images} image${images === 1 ? '' : 's'}` };
  return r;
}

export function mapManagedCluster(type: 'postgresql-cluster' | 'mlflow-cluster') {
  return (item: Json, ctx: Ctx): ObservedResource => {
    // Phase (PHASE_RUNNING …) describes the cluster; `state` describes the last operation.
    const r = inNetwork(base({ ...item, status: { ...item.status, state: pick(item.status, 'phase') ?? pick(item.status, 'state') } }, type, ctx), item);
    // MLflow: spec.public_access; PostgreSQL: spec.config.public_access (live API, 2026-10-11).
    r.spec = { public: Boolean(pick(item.spec, 'publicAccess', 'public_access') ?? pick(pick(item.spec, 'config'), 'publicAccess', 'public_access')) };
    if (type === 'postgresql-cluster') {
      // spec.config.template: what the billing calculator prices (a template-only create request, verified
      // live 2026-10-11); hosts in fixedNodeCount. Same ClusterSpec message on create and list.
      const t = pick(pick(item.spec, 'config'), 'template');
      const res = pick(t, 'resources');
      const disk = pick(t, 'disk');
      Object.assign(r.spec, {
        platform: pick(res, 'platform') || undefined,
        preset: pick(res, 'preset') || undefined,
        diskType: pick(disk, 'type') || undefined,
        sizeGib: num(pick(disk, 'sizeGibibytes', 'size_gibibytes')),
        fixedNodeCount: num(pick(pick(t, 'hosts'), 'count')),
      });
    }
    return r;
  };
}

/** Serverless endpoints, jobs and DevLabs: platform, preset and backing VMs only, never env, tokens or credentials. */
export function mapServerless(type: 'ai-endpoint' | 'ai-job' | 'ai-devlab') {
  return (item: Json, ctx: Ctx): ObservedResource => {
    const r = base(item, type, ctx);
    const preset = String(pick(item.spec, 'preset') ?? '');
    const m = /^(?:(\d+)gpu-)?(\d+)vcpu-(\d+)gb$/.exec(preset);
    r.spec = { platform: pick(item.spec, 'platform'), preset: preset || undefined, gpus: m?.[1] ? Number(m[1]) : 0, public: Boolean(pick(item.spec, 'publicIp', 'public_ip')) };
    for (const inst of (pick(item.status, 'instances') ?? []) as Json[]) {
      const id = pick(inst, 'computeInstanceId', 'compute_instance_id');
      if (id) r.refs.push({ relation: 'backed-by', target: String(id) });
    }
    return r;
  };
}

export function mapTransfer(item: Json, ctx: Ctx): ObservedResource {
  const r = base(item, 'storage-transfer', ctx);
  r.spec = { summary: String(pick(item.status, 'suspensionState', 'suspension_state') ?? '') };
  return r;
}

export function mapTunnel(item: Json, ctx: Ctx): ObservedResource {
  const r = base({ ...item, status: { ...item.status, state: pick(item.status, 'state') === 'CREATED' ? 'READY' : pick(item.status, 'state') } }, 'tunnel', ctx);
  r.spec = { summary: String(pick(item.status, 'connectionState', 'connection_state') ?? '').replace('CONNECTION_STATE_', '').toLowerCase() };
  return r;
}

export function mapKmsKey(item: Json, ctx: Ctx): ObservedResource {
  const r = base(item, 'kms-key', ctx);
  r.spec = { summary: String(pick(item.spec, 'algorithm') ?? '') };
  return r;
}

/** Secrets: metadata only. The list response is never read beyond metadata and status.state. */
export function mapSecret(item: Json, ctx: Ctx): ObservedResource {
  return base({ metadata: item.metadata, status: { state: pick(item.status, 'state') } }, 'secret', ctx, ['Metadata only: the portal never requests or stores secret payloads.']);
}

export function mapDnsZone(item: Json, ctx: Ctx): ObservedResource {
  const r = base({ ...item, status: { ...item.status, state: item.status?.reconciling ? 'UPDATING' : 'READY' } }, 'dns-zone', ctx);
  const records = num(pick(item.status, 'recordCount', 'record_count'));
  const domain = String(pick(item.spec, 'domainName', 'domain_name') ?? '');
  r.spec = { summary: [domain || undefined, records === undefined ? undefined : `${records} records`].filter(Boolean).join(' · ') };
  // Documented per-network system zone `<network_ID>.compute.internal.` (read-only, created by Nebius).
  const net = /^(vpcnetwork-[a-z0-9]+)\.compute\.internal\.?$/.exec(domain)?.[1];
  if (net) {
    r.spec.platformDefault = true;
    r.refs.push({ relation: 'in-network', target: net });
    r.coverageNotes.push('System zone of the network, managed by Nebius (docs: system-managed zones).');
  }
  return r;
}
