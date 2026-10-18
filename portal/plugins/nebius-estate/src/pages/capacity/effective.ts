import type { PlatformView, QuotaAllowanceView } from '@internal/nebius-domain';
import { gpuQuotaModel } from '@internal/nebius-domain';

/**
 * What a quota card says beyond the tenant figure (SA proposal 6, slice 1): the limit that applies once project caps
 * are taken into account, what a limit elsewhere makes unusable, and the live platforms no quota names. Pure, from the
 * /capacity quota list (tenant allowances, and the project allowances of the projects in scope).
 */

const sameQuota = (a: Pick<QuotaAllowanceView, 'name' | 'region'>, b: Pick<QuotaAllowanceView, 'name' | 'region'>) => a.name === b.name && (a.region ?? '') === (b.region ?? '');
/** A real project cap (a project allowance with a limit of its own; a placeholder is not a cap). */
const isCap = (q: QuotaAllowanceView): q is QuotaAllowanceView & { limit: number } => q.scope === 'project' && q.allocation === 'set' && q.limit !== null;

export interface TileLimit {
  /** Projects whose own cap is below the tenant limit of this quota and region (a cap of 0 included), lowest first. */
  caps: { projectId: string; limit: number; usage: number }[];
  /** No project allowance was read (for the filtered project, or for any project): a cap may exist unseen. */
  capsUnknown: boolean;
  /** Under a project filter: the limit that applies to that project, set by its own cap or by the tenant. */
  effective?: { projectId: string; limit: number; usage: number; by: 'project' | 'tenant' };
}

/**
 * The effective limit of a tenant allowance: min(project cap, tenant limit) (W1-P14). With a project filter, the
 * limit that applies to that project; without one, the projects capped below the tenant limit. A project allowance
 * tile (no tenant read) has nothing to compare.
 */
export function tileLimit(t: QuotaAllowanceView, quotas: QuotaAllowanceView[], project?: string): TileLimit {
  if (t.scope !== 'tenant' || t.limit === null) return { caps: [], capsUnknown: false };
  const tenantLimit = t.limit;
  const projectRows = quotas.filter(q => q.scope === 'project' && (!project || q.projectId === project));
  if (!projectRows.length) return { caps: [], capsUnknown: true };
  const caps = projectRows
    .filter(isCap)
    .filter(q => sameQuota(q, t) && q.limit < tenantLimit)
    .map(q => ({ projectId: q.projectId, limit: q.limit, usage: q.usage }))
    .sort((a, b) => a.limit - b.limit || a.projectId.localeCompare(b.projectId));
  if (!project) return { caps, capsUnknown: false };
  const own = caps.find(c => c.projectId === project);
  return { caps, capsUnknown: false, effective: own ? { ...own, by: 'project' } : { projectId: project, limit: tenantLimit, usage: t.usage, by: 'tenant' } };
}

export const GPU_CLUSTER_QUOTA = 'compute.gpucluster.count';
export const NON_GPU_VCPU_QUOTA = 'compute.instance.non-gpu.vcpu';

/**
 * GPU clusters (InfiniBand) limited to 0 in a region: by the tenant, or by a project's own cap of 0 (W1-P14). An 8-GPU
 * InfiniBand node joins a GPU cluster (docs: compute/clusters/gpu), so those presets cannot join one there (they still
 * run, without InfiniBand). Null when
 * nothing blocks (or no GPU cluster allowance is listed).
 */
export function gpuClusterBlock(region: string, quotas: QuotaAllowanceView[], project?: string): { tenant: boolean; projects: string[] } | null {
  const rows = quotas.filter(q => q.name === GPU_CLUSTER_QUOTA && (q.region ?? '') === region);
  const tenant = rows.some(q => q.scope === 'tenant' && q.limit === 0);
  const projects = rows.filter(isCap).filter(q => q.limit === 0 && (!project || q.projectId === project)).map(q => q.projectId).sort();
  return tenant || projects.length ? { tenant, projects } : null;
}

export interface K8sUsability {
  /** yes: room for CPU node groups; full: in use up to the limit; cpu-blocked: limit 0; unknown: no allowance listed. */
  state: 'yes' | 'full' | 'cpu-blocked' | 'unknown';
  limit?: number;
  usage?: number;
  by?: 'tenant' | 'project';
  /** When a project cap sets the limit shown: that project (the filtered one, or without a filter the highest cap). */
  projectId?: string;
  /** Without a project filter: projects whose own non-GPU vCPU cap is 0 in the region. */
  projectsBlocked: string[];
}

/**
 * Whether the Kubernetes recipes can start their CPU (system) node groups in a region (W1-P15): they draw on the
 * non-GPU vCPU quota (docs/capacity.md, "Quotas per stack"), which defaults to 0 in some regions. The limit that
 * applies is the tenant's, or a project's own lower cap under its filter; with project allowances only, the filtered
 * project's cap, or without a filter the highest cap with its project named (projects at 0 are listed, not the region).
 */
export function k8sRecipeUsability(region: string, quotas: QuotaAllowanceView[], project?: string): K8sUsability {
  const rows = quotas.filter(q => q.name === NON_GPU_VCPU_QUOTA && (q.region ?? '') === region);
  const tenant = rows.find(q => q.scope === 'tenant' && q.limit !== null);
  const caps = rows.filter(isCap).filter(q => !project || q.projectId === project);
  const projectsBlocked = project ? [] : caps.filter(c => c.limit === 0).map(c => c.projectId).sort();
  const sorted = [...caps].sort((a, b) => a.limit - b.limit || a.projectId.localeCompare(b.projectId));
  const lowestCap = sorted[0];
  // Without a filter and without a tenant read, the region is as usable as its best-off project: the highest cap,
  // named; projects capped at 0 are listed (projectsBlocked) instead of blocking the whole region.
  const shownCap = project ? lowestCap : [...sorted].sort((a, b) => b.limit - a.limit || a.projectId.localeCompare(b.projectId))[0];
  let pick: { limit: number; usage: number; by: 'tenant' | 'project'; projectId?: string } | undefined;
  if (tenant && tenant.limit !== null) {
    pick = project && lowestCap && lowestCap.limit < tenant.limit ? { limit: lowestCap.limit, usage: lowestCap.usage, by: 'project', projectId: lowestCap.projectId } : { limit: tenant.limit, usage: tenant.usage, by: 'tenant' };
  } else if (shownCap) {
    pick = { limit: shownCap.limit, usage: shownCap.usage, by: 'project', projectId: shownCap.projectId };
  }
  if (!pick) return { state: 'unknown', projectsBlocked };
  const state = pick.limit === 0 ? 'cpu-blocked' : pick.usage >= pick.limit ? 'full' : 'yes';
  return { state, ...pick, projectsBlocked };
}

/**
 * GPU platforms the live compute API offers in a region with no Compute GPU allowance of their model there (W1-P17):
 * GB300 (gpu-gb300) is offered, while the quota list names only compute.instance.gpu.b300 and the like. Each gets a
 * card of its own instead of being missing from the quota grid.
 */
export function platformsWithoutQuota(platforms: PlatformView[] | null, quotas: QuotaAllowanceView[], region: string): PlatformView[] {
  if (!platforms) return [];
  const models = new Set(quotas.filter(q => (q.region ?? '') === region).map(q => /^compute\.instance\.gpu\.([a-z0-9-]+)$/.exec(q.name)?.[1]).filter(Boolean));
  return platforms
    .filter(p => p.presets.some(s => s.gpus > 0) && (p.regions ?? []).includes(region))
    .filter(p => {
      const m = gpuQuotaModel(p.name);
      return !!m && !models.has(m);
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
