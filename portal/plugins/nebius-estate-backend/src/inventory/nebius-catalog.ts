import { ObservedResource } from '@internal/nebius-domain';
import {
  Ctx,
  Json,
  mapAllocation,
  mapBucket,
  mapCluster,
  mapDisk,
  mapDiskSnapshot,
  mapDnsZone,
  mapFilesystem,
  mapGpuCluster,
  mapInstance,
  mapKmsKey,
  mapManagedCluster,
  mapNetwork,
  mapNvlGroup,
  mapPool,
  mapRegistry,
  mapRouteTable,
  mapSecret,
  mapSecurityGroup,
  mapServerless,
  mapSubnet,
  mapTransfer,
  mapTunnel,
} from './nebius-mappers';

/**
 * Every read-only Nebius list the portal makes, in one place. Each entry is a
 * documented REST GET (https://api.nebius.cloud/openapi.json) with the parent
 * it takes and the role to grant when it is refused. `verified` records the
 * date a GET with project-level `viewer` was seen to answer 200 on a live
 * account; tenant-level entries answer 403 until a tenant-level read role is
 * granted, and then light up on the next sync without any change here.
 */

export type CapabilityKind =
  | 'resources'
  | 'quotas'
  | 'capacity-allowances'
  | 'platforms'
  | 'maintenances'
  | 'capacity-block-groups'
  | 'resource-advice'
  | 'pricing-policies';

export interface CapabilityDef {
  id: string;
  title: string;
  service: string;
  path: string;
  /** project: parentId = project; tenant: parentId = tenant; cluster: parentId = each MK8s cluster. */
  scope: 'project' | 'tenant' | 'cluster';
  kind: CapabilityKind;
  map?: (item: Json, ctx: Ctx) => ObservedResource;
  /** What to grant when the call is refused. */
  grant: string;
  verified?: string;
  pageSize?: number;
  /**
   * core: read on every sync (what changes while things run: VMs, disks, clusters, IPs, buckets, Serverless,
   * managed PostgreSQL and MLflow, registries, quota allowances).
   * slow: read on full syncs only (every `fullSyncEvery` syncs, on start-up and on "Sync now"); between
   * them its items are carried over, shown as "last seen <t>" until the next full sync, and never priced.
   */
  tier: 'core' | 'slow';
}

const PROJECT_VIEWER = 'a `viewer` access permit on the project for the portal’s group (docs/credentials.md)';
const TENANT_READER = 'a tenant-level read role (for example `security-auditor` or `viewer` on the tenant) to the portal’s group (docs/credentials.md)';
const V = '2026-10-11';
// Managed PostgreSQL and MLflow, registries and quota allowances are cheap lists (one page per project) that change
// while a run creates or deletes things: on the slow tier, R12's appeared ~35 min late and stayed listed and priced
// after deletion (live 2026-10-12, followups 13 and 23). Core costs 4 calls per project and 1 per tenant more.
const CORE = new Set([
  'compute.instances', 'compute.disks', 'compute.filesystems', 'compute.gpu-clusters', 'mk8s.clusters', 'vpc.allocations', 'storage.buckets', 'ai.endpoints', 'ai.jobs',
  'msp.postgresql', 'msp.mlflow', 'registry.registries', 'quotas.allowances',
]);

const project = (id: string, title: string, service: string, path: string, kind: CapabilityKind, map?: CapabilityDef['map']): CapabilityDef => ({
  id,
  title,
  service,
  path,
  scope: 'project',
  kind,
  map,
  grant: PROJECT_VIEWER,
  verified: V,
  tier: CORE.has(id) ? 'core' : 'slow',
});

export const CATALOG: CapabilityDef[] = [
  project('compute.instances', 'VMs', 'compute', '/compute/v1/instances', 'resources', mapInstance),
  project('compute.disks', 'Disks', 'compute', '/compute/v1/disks', 'resources', mapDisk),
  project('compute.filesystems', 'Shared filesystems', 'compute', '/compute/v1/filesystems', 'resources', mapFilesystem),
  project('compute.gpu-clusters', 'GPU clusters (InfiniBand fabrics)', 'compute', '/compute/v1/gpu-clusters', 'resources', mapGpuCluster),
  project('compute.disk-snapshots', 'Disk snapshots', 'compute', '/compute/v1/disk-snapshots', 'resources', mapDiskSnapshot),
  // Live: "PageSize must be between 1 and 50" for this list.
  { ...project('compute.nvl-instance-groups', 'NVLink instance groups', 'compute', '/compute/v1/nvl-instance-groups', 'resources', mapNvlGroup), pageSize: 50 },
  project('compute.platforms', 'GPU and CPU platforms and presets', 'compute', '/compute/v1/platforms', 'platforms'),
  project('mk8s.clusters', 'Managed Kubernetes clusters', 'mk8s', '/mk8s/v1/clusters', 'resources', mapCluster),
  {
    id: 'mk8s.node-groups', title: 'Node groups', service: 'mk8s', path: '/mk8s/v1/node-groups', scope: 'cluster', kind: 'resources', grant: PROJECT_VIEWER, verified: V, tier: 'core',
  },
  project('vpc.networks', 'Networks', 'vpc', '/vpc/v1/networks', 'resources', mapNetwork),
  project('vpc.subnets', 'Subnets', 'vpc', '/vpc/v1/subnets', 'resources', mapSubnet),
  project('vpc.allocations', 'IP allocations (incl. public IPs)', 'vpc', '/vpc/v1/allocations', 'resources', mapAllocation),
  project('vpc.security-groups', 'Security groups', 'vpc', '/vpc/v1/security-groups', 'resources', mapSecurityGroup),
  project('vpc.route-tables', 'Route tables', 'vpc', '/vpc/v1/route-tables', 'resources', mapRouteTable),
  project('vpc.pools', 'IP pools', 'vpc', '/vpc/v1/pools', 'resources', mapPool),
  project('storage.buckets', 'Object Storage buckets', 'storage', '/storage/v1/buckets', 'resources', mapBucket),
  project('storage.transfers', 'Object Storage transfers', 'storage', '/storage/v1/transfers', 'resources', mapTransfer),
  project('registry.registries', 'Container registries', 'registry', '/registry/v1/registries', 'resources', mapRegistry),
  project('msp.postgresql', 'Managed PostgreSQL clusters', 'msp', '/msp/postgresql/v1alpha1/clusters', 'resources', mapManagedCluster('postgresql-cluster')),
  project('msp.mlflow', 'Managed MLflow clusters', 'msp', '/msp/mlflow/v1alpha1/clusters', 'resources', mapManagedCluster('mlflow-cluster')),
  project('ai.endpoints', 'Serverless endpoints', 'ai', '/ai/v1/endpoints', 'resources', mapServerless('ai-endpoint')),
  project('ai.jobs', 'Serverless jobs', 'ai', '/ai/v1/jobs', 'resources', mapServerless('ai-job')),
  project('ai.devlabs', 'DevLabs', 'ai', '/ai/v1/devlabs', 'resources', mapServerless('ai-devlab')),
  project('tunnel.tunnels', 'Tunnels', 'tunnel', '/tunnel/v1/tunnels', 'resources', mapTunnel),
  project('kms.symmetric-keys', 'KMS keys', 'kms', '/kms/v1/symmetric-keys', 'resources', mapKmsKey),
  project('mysterybox.secrets', 'Secrets (metadata only)', 'mysterybox', '/mysterybox/v1/secrets', 'resources', mapSecret),
  project('dns.zones', 'DNS zones', 'dns', '/dns/v1/zones', 'resources', mapDnsZone),
  project('quotas.allowances', 'Quota allowances', 'quotas', '/quotas/v1/quota-allowances', 'quotas'),
  project('capacity.allowances', 'Capacity allowances (reserved capacity per project)', 'capacity', '/capacity/v1/capacity-allowances', 'capacity-allowances'),
  project('maintenance.maintenances', 'Scheduled maintenance', 'maintenance', '/maintenance/v1alpha1/maintenances', 'maintenances'),
  // The parent of a pricing-policy list is not documented; a tenant parent answers 400. Tried per project.
  { ...project('billing.pricing-policies', 'Spot pricing policies', 'billing', '/billing/v1/pricing-policies', 'pricing-policies'), verified: undefined },
  // Tenant allowances are what enforcement checks (a live QuotaFailure named the tenant container).
  {
    id: 'quotas.allowances.tenant', title: 'Quota allowances (tenant)', service: 'quotas', path: '/quotas/v1/quota-allowances', scope: 'tenant', kind: 'quotas', grant: TENANT_READER, verified: V, tier: 'core',
  },
  {
    id: 'capacity.block-groups', title: 'Capacity block groups (reservations)', service: 'capacity', path: '/capacity/v1/capacity-block-groups', scope: 'tenant', kind: 'capacity-block-groups', grant: TENANT_READER, pageSize: 200, tier: 'slow',
  },
  {
    id: 'capacity.resource-advice', title: 'Capacity advice (availability by platform and preset)', service: 'capacity', path: '/capacity/v1/resource-advice', scope: 'tenant', kind: 'resource-advice', grant: TENANT_READER, pageSize: 200, tier: 'slow',
  },
];

export const NODE_GROUPS = CATALOG.find(c => c.id === 'mk8s.node-groups')!;

/** Opt-in tenant project discovery (hints only; the configured list stays the scope). */
export const DISCOVERY: CapabilityDef = {
  id: 'iam.projects.list', title: 'Projects in the tenant (discovery hint)', service: 'iam', path: '/iam/v2/projects', scope: 'tenant', kind: 'resources', grant: TENANT_READER, verified: V, tier: 'slow',
};
