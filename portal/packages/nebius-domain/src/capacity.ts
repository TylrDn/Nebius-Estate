import { Footprint, NodeGroupShape } from './pricing';
import { RegionsFile } from './repo';
import { parsePreset } from './units';
import type { QuotaAllowanceView, ResourceAdviceView } from './api';

/**
 * Footprints derived from the repository's sizing files, using the same
 * arithmetic as docs/capacity.md ("Quotas per stack"). These are the shapes
 * a root would plan; they say nothing about whether the capacity exists.
 */

export const CPU_PLATFORM = 'cpu-d3';
export const CPU_BOOT_GIB = 128;
export const O11Y_TSDB_GIB = 25;

type Sizing = Record<string, string | number | boolean | null | undefined>;

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' ? v : fallback;
}
function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}
function strOr(v: unknown, fallback: string): string {
  return typeof v === 'string' && v ? v : fallback;
}

export interface FootprintContext {
  regions: RegionsFile;
  region: string;
  /** null/undefined = the region's default platform (platform/regions.yaml). */
  gpuPlatform?: string | null;
}

export function resolvePlatform(ctx: FootprintContext): { platform: string; entry: RegionsFile['regions'][string]['platforms'][string] } | undefined {
  const region = ctx.regions.regions[ctx.region];
  if (!region) return undefined;
  const platform = ctx.gpuPlatform || region.default;
  const entry = region.platforms[platform];
  return entry ? { platform, entry } : undefined;
}

export function inferenceFootprint(sizing: Sizing, ctx: FootprintContext, gpuNodeCount?: number): Footprint {
  const p = resolvePlatform({ ...ctx, gpuPlatform: (sizing.gpu_platform as string | null) ?? ctx.gpuPlatform });
  const groups: NodeGroupShape[] = [
    { name: 'system', role: 'system', platform: CPU_PLATFORM, preset: strOr(sizing.cpu_preset, '8vcpu-32gb'), count: num(sizing.cpu_node_count, 2), bootDiskGib: CPU_BOOT_GIB },
  ];
  if (p?.entry.single_gpu_preset) {
    groups.push({ name: 'gpu', role: 'gpu', platform: p.platform, preset: strOr(sizing.gpu_preset, p.entry.single_gpu_preset), count: gpuNodeCount ?? num(sizing.gpu_node_count, 1), bootDiskGib: num(sizing.gpu_boot_disk_size_gib, 512) });
  }
  return {
    nodeGroups: groups,
    filesystemGib: bool(sizing.enable_filestore, true) ? num(sizing.filestore_size_gib, 64) : 0,
    extraSsdGib: bool(sizing.enable_o11y, true) ? O11Y_TSDB_GIB : 0,
    ioM3Gib: 0,
    objectStorageGib: 0,
    publicIps: 0,
  };
}

export function trainingFootprint(sizing: Sizing, ctx: FootprintContext, gpuNodeCount?: number): Footprint {
  const p = resolvePlatform({ ...ctx, gpuPlatform: (sizing.gpu_platform as string | null) ?? ctx.gpuPlatform });
  const groups: NodeGroupShape[] = [
    { name: 'system', role: 'system', platform: CPU_PLATFORM, preset: strOr(sizing.cpu_preset, '8vcpu-32gb'), count: num(sizing.cpu_node_count, 2), bootDiskGib: CPU_BOOT_GIB },
  ];
  if (p?.entry.ib_preset) {
    groups.push({ name: 'gpu', role: 'gpu', platform: p.platform, preset: strOr(sizing.gpu_preset, p.entry.ib_preset), count: gpuNodeCount ?? num(sizing.gpu_node_count, 0), bootDiskGib: num(sizing.gpu_boot_disk_size_gib, 1023) });
  }
  return {
    nodeGroups: groups,
    filesystemGib: bool(sizing.enable_filestore, true) ? num(sizing.filestore_size_gib, 256) : 0,
    extraSsdGib: bool(sizing.enable_o11y, true) ? O11Y_TSDB_GIB : 0,
    ioM3Gib: 0,
    objectStorageGib: 0,
    publicIps: 0,
  };
}

/**
 * R10 GPU VM (terraform/stacks/gpu-vm): one VM of `platform` / `preset` (the region's default platform and its
 * single-GPU preset when unset), its boot disk, and a public address when `public_ip`.
 */
export function gpuVmFootprint(sizing: Sizing, ctx: FootprintContext): Footprint {
  const p = resolvePlatform({ ...ctx, gpuPlatform: (sizing.platform as string | null) ?? ctx.gpuPlatform });
  return {
    nodeGroups: p?.entry.single_gpu_preset ? [{ name: 'vm', role: 'gpu', platform: p.platform, preset: strOr(sizing.preset, p.entry.single_gpu_preset), count: 1, bootDiskGib: num(sizing.boot_disk_size_gib, 200) }] : [],
    filesystemGib: 0,
    extraSsdGib: 0,
    ioM3Gib: 0,
    objectStorageGib: 0,
    publicIps: bool(sizing.public_ip, false) ? 1 : 0,
  };
}

/** The footprint a live root of `stack` plans from `sizing` (tfvars, merged with a run profile's vars). */
export function plannedFootprint(stack: string, sizing: Sizing, ctx: FootprintContext, gpuNodeCount?: number): Footprint | undefined {
  if (stack === 'inference') return inferenceFootprint(sizing, ctx, gpuNodeCount);
  if (stack === 'training') return trainingFootprint(sizing, ctx, gpuNodeCount);
  if (stack === 'gpu-vm') return gpuVmFootprint(sizing, ctx);
  return undefined;
}

/**
 * Soperator lab profile (terraform/stacks/soperator/profiles/lab.tfvars) as
 * docs/capacity.md tallies it: 52 vCPU, 1,280 GiB boot SSD, ~280 GiB IO_M3
 * spool, 448 GiB filesystems, one login-node public IP, no GPU.
 */
export function soperatorLabFootprint(stage: string): Footprint {
  const prod = stage === 'prod';
  return {
    nodeGroups: [
      { name: 'system', role: 'system', platform: CPU_PLATFORM, preset: '8vcpu-32gb', count: 3, bootDiskGib: 128 },
      { name: 'controller', role: 'system', platform: CPU_PLATFORM, preset: '4vcpu-16gb', count: 1, bootDiskGib: 128 },
      { name: 'login', role: 'system', platform: CPU_PLATFORM, preset: '16vcpu-64gb', count: 1, bootDiskGib: 256 },
      { name: 'worker-cpu', role: 'cpu-worker', platform: CPU_PLATFORM, preset: '8vcpu-32gb', count: 1, bootDiskGib: 512 },
    ],
    filesystemGib: prod ? 2048 + 2048 + 128 : 256 + 64 + 128,
    extraSsdGib: 0,
    ioM3Gib: 279,
    objectStorageGib: 0,
    publicIps: 1,
  };
}

export interface QuotaNeeds {
  nonGpuVcpus: number;
  gpuVms: number;
  gpus: number;
  networkSsdGib: number;
  ioM3Gib: number;
  filesystemGib: number;
  publicIps: number;
  gpuClusters: number;
  mk8sClusters: number;
}

/** Quota arithmetic of docs/capacity.md for any footprint. */
export function quotaNeeds(fp: Footprint, opts: { gpuCluster?: boolean } = {}): QuotaNeeds {
  let nonGpuVcpus = 0;
  let gpuVms = 0;
  let gpus = 0;
  let boot = 0;
  for (const g of fp.nodeGroups) {
    const shape = parsePreset(g.preset);
    if (!shape) continue;
    if (shape.gpus > 0) {
      gpuVms += g.count;
      gpus += shape.gpus * g.count;
    } else {
      nonGpuVcpus += shape.vcpus * g.count;
    }
    boot += g.bootDiskGib * g.count;
  }
  return {
    nonGpuVcpus,
    gpuVms,
    gpus,
    networkSsdGib: boot + fp.extraSsdGib,
    ioM3Gib: fp.ioM3Gib,
    filesystemGib: fp.filesystemGib,
    publicIps: fp.publicIps,
    gpuClusters: opts.gpuCluster && gpus > 0 ? 1 : 0,
    mk8sClusters: 1,
  };
}

/** Sets the count of every GPU / worker group of a footprint, keeping the system nodes. */
export function withWorkloadCount(fp: Footprint, count: number): Footprint {
  return {
    ...fp,
    nodeGroups: fp.nodeGroups.map(g => (g.role === 'system' ? g : { ...g, count })),
  };
}

/* ------------------------------------------------------------ quota checks */

/** How a footprint draws on quota: capacity type of its workload groups, a GPU cluster, and new Managed Kubernetes clusters. */
export interface QuotaOptions {
  capacityType?: 'on-demand' | 'preemptible' | 'reserved';
  gpuCluster?: boolean;
  mk8sClusters?: number;
}

/** One allowance as the quotas API reports it (absent limit or usage already read as 0). */
export interface QuotaAllowanceLike {
  name: string;
  region?: string;
  limit: number;
  usage: number;
  unit?: string;
}

export interface QuotaRequirement {
  quota: string;
  need: number;
  /** What needs it, e.g. "2 × 8vcpu-32gb system nodes". */
  what: string;
}

export interface QuotaCheckLine extends QuotaRequirement {
  limit: number;
  usage: number;
  /** blocked: the limit is 0; exceeded: usage + need is over the limit. */
  state: 'ok' | 'blocked' | 'exceeded';
  /** How much more quota the plan needs (0 when it fits). */
  short: number;
}

/** "gpu-h100-sxm" → "h100": the GPU quota names use the short model (compute.instance.gpu.h100). */
export function gpuQuotaModel(platform: string | undefined): string | undefined {
  return /^gpu-([a-z0-9]+)/.exec(platform ?? '')?.[1];
}

/**
 * The quota allowances a footprint draws on (names as the quotas API lists them). `capacityType` applies to
 * the workload groups (system nodes are always on-demand). GPU quotas count regular VMs without reservations
 * (docs: compute/resources/quotas-limits): a preemptible VM counts against compute.instance.preemptible.count
 * instead, and a reserved VM against its reservation (capacity allowance), so neither needs GPU quota.
 * `mk8sClusters` counts the Managed Kubernetes clusters the plan creates (a provisioning request: every form
 * recipe creates one, G5.3); planned live roots leave it out, as their cluster may already exist.
 */
export function quotaRequirements(fp: Footprint, opts: QuotaOptions = {}): QuotaRequirement[] {
  const out = new Map<string, QuotaRequirement>();
  const add = (quota: string, need: number, what: string) => {
    if (need <= 0) return;
    const r = out.get(quota);
    out.set(quota, r ? { quota, need: r.need + need, what: `${r.what}; ${what}` } : { quota, need, what });
  };
  let vms = 0;
  let ssd = fp.extraSsdGib;
  for (const g of fp.nodeGroups) {
    const shape = parsePreset(g.preset);
    if (!shape || g.count <= 0) continue;
    vms += g.count;
    ssd += g.bootDiskGib * g.count;
    const label = `${g.count} × ${g.preset} ${g.name}`;
    const cap = g.role === 'system' ? 'on-demand' : opts.capacityType ?? 'on-demand';
    if (shape.gpus > 0) {
      const model = gpuQuotaModel(g.platform);
      if (cap === 'preemptible') add('compute.instance.preemptible.count', g.count, `${label} (preemptible)`);
      else if (cap === 'on-demand' && model) add(`compute.instance.gpu.${model}`, shape.gpus * g.count, label);
    } else if (cap === 'preemptible') {
      add('compute.instance.preemptible.count', g.count, `${label} (preemptible)`);
      add('compute.instance.non-gpu.vcpu', shape.vcpus * g.count, label);
    } else {
      add('compute.instance.non-gpu.vcpu', shape.vcpus * g.count, label);
    }
  }
  add('compute.instance.count', vms, `${vms} VM${vms === 1 ? '' : 's'}`);
  // Names as the live quotas API lists them (verified 2026-10-11; sizes in bytes).
  add('compute.disk.size.network-ssd', ssd, `${ssd} GiB of boot and extra disks`);
  add('compute.disk.size.network-ssd-io-m3', fp.ioM3Gib, `${fp.ioM3Gib} GiB of IO_M3 disks`);
  add('compute.filesystem.size.network-ssd', fp.filesystemGib, `${fp.filesystemGib} GiB of shared filesystems`);
  if (opts.gpuCluster && fp.nodeGroups.some(g => g.count > 0 && (parsePreset(g.preset)?.gpus ?? 0) > 0)) add('compute.gpucluster.count', 1, 'GPU cluster (InfiniBand fabric)');
  add('mk8s.cluster.count', opts.mk8sClusters ?? 0, `Managed Kubernetes cluster${(opts.mk8sClusters ?? 0) === 1 ? '' : 's'}`);
  return [...out.values()];
}

/** Sizes are reported in GiB or bytes; requirements are in GiB. */
function inGib(q: QuotaAllowanceLike, n: number): number {
  return /^byte/i.test(q.unit ?? '') ? n / 2 ** 30 : n;
}

/**
 * A footprint against the allowances of one region: what is blocked (limit 0), what would exceed
 * its limit, and which requirements have no allowance in the list (not checked, never assumed ok).
 */
export function checkQuotas(
  fp: Footprint,
  region: string,
  quotas: QuotaAllowanceLike[],
  opts: QuotaOptions = {},
): { lines: QuotaCheckLine[]; unchecked: QuotaRequirement[] } {
  const lines: QuotaCheckLine[] = [];
  const unchecked: QuotaRequirement[] = [];
  for (const req of quotaRequirements(fp, opts)) {
    const q = quotas.find(x => x.name === req.quota && (x.region === region || !x.region));
    if (!q) {
      unchecked.push(req);
      continue;
    }
    const limit = inGib(q, q.limit);
    const usage = inGib(q, q.usage);
    const state = limit === 0 ? 'blocked' : usage + req.need > limit ? 'exceeded' : 'ok';
    lines.push({ ...req, limit, usage, state, short: Math.max(0, usage + req.need - limit) });
  }
  return { lines, unchecked };
}

/** How a planned root draws on quota: its GPU capacity type (sizing `gpu_preemptible`) and whether it forms a GPU cluster (training). */
export function plannedQuotaOptions(stack: string, sizing: Sizing): { capacityType: 'on-demand' | 'preemptible'; gpuCluster: boolean } {
  // R10's variable is `preemptible`; R1 and R3 say `gpu_preemptible`.
  const preemptible = stack === 'gpu-vm' ? sizing.preemptible === true : sizing.gpu_preemptible === true;
  return { capacityType: preemptible ? 'preemptible' : 'on-demand', gpuCluster: stack === 'training' };
}

/**
 * The one definition of "blocked by quota" for a planned footprint (Overview, Capacity, the footprint
 * calculator): its requirements against the tenant allowances (as enforced) of one region, its own.
 * Project allocations are not enforcement and are ignored here.
 */
export function checkPlannedFootprint(
  fp: Footprint,
  stack: string,
  sizing: Sizing,
  region: string,
  quotas: (Omit<QuotaAllowanceLike, 'limit'> & { scope?: string; limit: number | null })[],
): { lines: QuotaCheckLine[]; unchecked: QuotaRequirement[] } {
  const tenant = quotas.filter((q): q is typeof q & { limit: number } => q.scope === 'tenant' && q.limit !== null && (q.region === region || !q.region));
  return checkQuotas(fp, region, tenant, plannedQuotaOptions(stack, sizing));
}

/**
 * The limit that actually applies to an allowance. Tenant allowances and real project allocations carry
 * their own limit; a project placeholder (inherits-tenant) draws on the tenant allowance of its quota and
 * region — `tenant-unknown` when that was not read (never assumed 0).
 */
export function effectiveQuota<T extends Pick<QuotaAllowanceView, 'scope' | 'allocation' | 'limit' | 'usage' | 'tenant'>>(
  q: T,
): { basis: 'tenant' | 'project' | 'tenant-unknown'; limit: number | null; usage: number } {
  if (q.allocation === 'inherits-tenant') return q.tenant ? { basis: 'tenant', limit: q.tenant.limit, usage: q.tenant.usage } : { basis: 'tenant-unknown', limit: null, usage: q.usage };
  return { basis: q.scope === 'tenant' ? 'tenant' : 'project', limit: q.limit, usage: q.usage };
}

/* ------------------------------------------- project allowances vs tenant quota */

/**
 * A real project cap (a project allowance with a limit of its own) against the tenant limit of the same quota
 * and region: above it has no effect (the tenant limit always binds), below it caps the project, 0 blocks it.
 * Placeholders (inherits-tenant) are not caps. The 2026-10-11 eu-west2 incident had all three
 * (docs/capacity.md, "Project allowances vs tenant quotas"); `scripts/quota-plan.py` makes the same check.
 */
export type AllowanceFindingKind = 'no-effect' | 'caps-below' | 'zero-cap';

export interface AllowanceFinding {
  kind: AllowanceFindingKind;
  projectId: string;
  name: string;
  region?: string;
  description?: string;
  unit?: string;
  projectLimit: number;
  tenantLimit: number;
  /** The project's own usage of the quota. */
  usage: number;
}

/** Plain wording per finding, shared by the Capacity page, the Overview and the alert evidence. */
export const ALLOWANCE_VERDICT: Record<AllowanceFindingKind, string> = {
  'zero-cap': 'Blocks this project: its cap is 0 while the tenant allows more. Intended?',
  'caps-below': 'Caps this project below the tenant limit. Intended?',
  'no-effect': 'No effect: the tenant limit is lower and always applies.',
};

const FINDING_ORDER: AllowanceFindingKind[] = ['zero-cap', 'caps-below', 'no-effect'];

/** Every real project cap that differs from its tenant limit; null when no tenant allowance was read (cannot judge). */
export function checkAllowances(quotas: QuotaAllowanceView[]): AllowanceFinding[] | null {
  const tenant = new Map(tenantAllowances(quotas).map(q => [`${q.name}|${q.region ?? ''}`, q.limit]));
  if (!tenant.size) return null;
  const out: AllowanceFinding[] = [];
  for (const q of quotas) {
    if (q.scope !== 'project' || q.allocation !== 'set' || q.limit === null) continue;
    const t = tenant.get(`${q.name}|${q.region ?? ''}`);
    if (t === undefined || t === q.limit) continue;
    const kind: AllowanceFindingKind = q.limit > t ? 'no-effect' : q.limit === 0 ? 'zero-cap' : 'caps-below';
    out.push({ kind, projectId: q.projectId, name: q.name, region: q.region, description: q.description, unit: q.unit, projectLimit: q.limit, tenantLimit: t, usage: q.usage });
  }
  return out.sort((a, b) => FINDING_ORDER.indexOf(a.kind) - FINDING_ORDER.indexOf(b.kind) || a.projectId.localeCompare(b.projectId) || a.name.localeCompare(b.name));
}

/** The findings that cut a project's quota (caps below the tenant limit, caps of 0). */
export const cutsProject = (f: Pick<AllowanceFinding, 'kind'>) => f.kind !== 'no-effect';

/** Tenant allowances (always with a limit), for checks that need the enforced numbers. */
export function tenantAllowances<T extends Pick<QuotaAllowanceView, 'scope' | 'limit'>>(quotas: T[]): (T & { limit: number })[] {
  return quotas.filter((q): q is T & { limit: number } => q.scope === 'tenant' && q.limit !== null);
}

/** An allowance at this share of its limit or more is "near its limit". */
export const NEAR_LIMIT_PERCENT = 80;

type QuotaLike = Pick<QuotaAllowanceView, 'scope' | 'allocation' | 'limit' | 'usage' | 'usagePercent'>;

export interface NearLimitCheck<T> {
  /** Tenant allowances are what enforcement checks; without a tenant read, the real project caps. */
  level: 'tenant' | 'project';
  /** Allowances judged (with a limit, limit 0 included): the "with a limit" count Capacity lists under "All tenant quotas" (F1.39). */
  judged: number;
  /** Of those, the ones with limit 0 (blocked: nothing can be created; never "near"). */
  zeroLimit: number;
  /** At NEAR_LIMIT_PERCENT of a non-zero limit or more. */
  near: T[];
  /** In use above the limit (a limit of 0 included): the usage the projects report is more than the tenant allows (F1.11). */
  aboveLimit: T[];
}

/** Quotas near their limit, counted once for the Overview's attention row and Capacity's Quotas header (F1.4). */
export function nearLimitCheck<T extends QuotaLike>(quotas: T[]): NearLimitCheck<T> {
  const tenant = tenantAllowances(quotas);
  const level = tenant.length ? ('tenant' as const) : ('project' as const);
  const judged = tenant.length ? tenant : quotas.filter((q): q is T & { limit: number } => q.scope === 'project' && q.allocation === 'set' && q.limit !== null);
  return {
    level,
    judged: judged.length,
    zeroLimit: judged.filter(q => q.limit === 0).length,
    near: judged.filter(q => q.limit > 0 && (q.usagePercent ?? (100 * q.usage) / q.limit) >= NEAR_LIMIT_PERCENT),
    aboveLimit: judged.filter(q => q.usage > q.limit),
  };
}

/**
 * "1 in use above its limit · 0 at ≥ 80 % · 426 tenant quotas with a limit (1 at limit 0)": the worst state first,
 * the same words and the same N on both pages (F1.4, F1.39). `above: false` leaves out the above-limit count where
 * it has a row of its own (the Overview's "Quotas in use above the limit", F1.11).
 */
export function nearLimitText(c: Pick<NearLimitCheck<unknown>, 'level' | 'judged' | 'zeroLimit' | 'near'> & { aboveLimit?: unknown[] }, above = true): string {
  const zero = c.zeroLimit ? ` (${c.zeroLimit} at limit 0)` : '';
  const over = above && c.aboveLimit?.length ? `${c.aboveLimit.length} in use above ${c.aboveLimit.length === 1 ? 'its' : 'their'} limit · ` : '';
  return `${over}${c.near.length} at ≥ ${NEAR_LIMIT_PERCENT} % · ${c.judged} ${c.level} quota${c.judged === 1 ? '' : 's'} with a limit${zero}`;
}

/* ------------------------------------------- tenant usage against its projects */

const quotaKey = (q: Pick<QuotaAllowanceView, 'name' | 'region'>) => `${q.name}|${q.region ?? ''}`;

/**
 * A tenant allowance reports less usage than the projects beneath it (the API omits a zero, so an absent tenant
 * usage reads 0 while a project reports 48 vCPUs): the tenant figure takes the projects' sum, keeps what it said in
 * `reportedUsage`, and its share is recomputed. Project rows are unchanged. Unrestricted callers only: a
 * project-scoped caller does not see every project, so the sum would be partial.
 */
export function reconcileTenantUsage(quotas: QuotaAllowanceView[]): QuotaAllowanceView[] {
  const sums = new Map<string, number>();
  for (const q of quotas) if (q.scope === 'project') sums.set(quotaKey(q), (sums.get(quotaKey(q)) ?? 0) + q.usage);
  return quotas.map(q => {
    const sum = q.scope === 'tenant' ? sums.get(quotaKey(q)) : undefined;
    if (sum === undefined || sum <= q.usage) return q;
    return { ...q, usage: sum, usagePercent: q.limit ? Math.round((10_000 * sum) / q.limit) / 100 : null, reportedUsage: q.usage };
  });
}

/** "48 in use against a limit of 0: the projects report 48, the tenant 0." — or undefined when usage is within the limit. */
export function usageAboveLimitText(q: Pick<QuotaAllowanceView, 'usage' | 'limit' | 'unit' | 'reportedUsage'>): string | undefined {
  if (q.limit === null || q.usage <= q.limit) return undefined;
  const n = (x: number) => fmtQuotaAmount(x, q.unit);
  const why = q.reportedUsage === undefined ? '' : `: the projects report ${n(q.usage)}, the tenant ${n(q.reportedUsage)}`;
  return `${n(q.usage)} in use against a limit of ${n(q.limit)}${why}.`;
}

/* ------------------------------------------------- node groups: observed vs spec */

export interface NodeCountState {
  /**
   * complete: within the spec with at least one node up; scaled-to-zero: autoscaling at 0 (nothing missing, nothing
   * up); short: fewer than the fixed count or the autoscaling minimum; above: more than the fixed count or maximum;
   * unknown: no size in the spec.
   */
  state: 'complete' | 'scaled-to-zero' | 'short' | 'above' | 'unknown';
  /** The fixed count, or the autoscaling minimum. */
  target?: number;
  /** The fixed count, or the autoscaling maximum: set when nodes are above it. */
  ceiling?: number;
  missing: number;
  extra: number;
}

/** Observed nodes against the node group's spec: "all nodes up" only when that is what it means (F1.12). */
export function nodeCountState(g: { nodes: number; fixedNodeCount?: number; autoscaling?: { min: number; max: number } }): NodeCountState {
  const target = g.fixedNodeCount ?? g.autoscaling?.min;
  const ceiling = g.fixedNodeCount ?? g.autoscaling?.max;
  if (target === undefined) return { state: 'unknown', missing: 0, extra: 0 };
  if (ceiling !== undefined && g.nodes > ceiling) return { state: 'above', target, ceiling, missing: 0, extra: g.nodes - ceiling };
  if (g.nodes < target) return { state: 'short', target, missing: target - g.nodes, extra: 0 };
  return { state: g.nodes === 0 ? 'scaled-to-zero' : 'complete', target, missing: 0, extra: 0 };
}

/* ------------------------------------------------ reservations: list vs users */

export interface ReservationEvidence {
  /** Block groups the list returned; null when it was not read. */
  listed: number | null;
  /** Block groups capacity allowances name that no list holds (not even outside the region filter), with the allowances naming each. */
  unlisted: { id: string; allowances: string[] }[];
  /** Block groups allowances name that the region filter hides: listed, in another region. */
  elsewhere: { id: string; region?: string; allowances: string[] }[];
  /** Node groups whose capacity type is reserved. */
  reservedNodeGroups: string[];
  /** Something draws on a reservation (an allowance names one, or a node group runs as reserved). */
  inUse: boolean;
  /** The region filter the list was read under, when one is active. */
  region?: string;
}

/**
 * The capacity block group list against what uses a reservation: capacity allowances naming a block group and node
 * groups running as reserved. An empty list beside either is reconciled in words, not shown as "No reservations" (F1.10).
 * Allowances carry no region, so under a region filter `hidden` (the block groups the filter left out) keeps a
 * reservation listed in another region from reading as an API gap.
 */
export function reservationEvidence(
  blockGroups: { id: string }[] | null,
  allowances: { name: string; capacityBlockGroupId?: string }[] | null,
  nodeGroups: { name: string; capacityType: string }[],
  filter?: { region?: string; hidden?: { id: string; region?: string }[] },
): ReservationEvidence {
  const known = new Set((blockGroups ?? []).map(g => g.id));
  const hidden = new Map((filter?.hidden ?? []).map(g => [g.id, g]));
  const unlisted = new Map<string, string[]>();
  const elsewhere = new Map<string, string[]>();
  for (const a of allowances ?? []) {
    if (!a.capacityBlockGroupId || known.has(a.capacityBlockGroupId)) continue;
    const into = hidden.has(a.capacityBlockGroupId) ? elsewhere : unlisted;
    into.set(a.capacityBlockGroupId, [...(into.get(a.capacityBlockGroupId) ?? []), a.name]);
  }
  const reservedNodeGroups = nodeGroups.filter(g => g.capacityType === 'reserved').map(g => g.name);
  const named = (allowances ?? []).some(a => a.capacityBlockGroupId);
  return {
    listed: blockGroups === null ? null : blockGroups.length,
    unlisted: [...unlisted.entries()].map(([id, names]) => ({ id, allowances: names })),
    elsewhere: [...elsewhere.entries()].map(([id, names]) => ({ id, region: hidden.get(id)?.region, allowances: names })),
    reservedNodeGroups,
    inUse: named || reservedNodeGroups.length > 0,
    ...(filter?.region ? { region: filter.region } : {}),
  };
}

/** "a", "a and b", "a, b and c". */
function listText(items: string[]): string {
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** "capacity allowance a names reservation x", "capacity allowances a and b name reservations x and y". */
function allowanceClause(entries: { id: string; allowances: string[] }[]): string {
  const allowances = entries.flatMap(u => u.allowances);
  const many = allowances.length > 1;
  return `capacity allowance${many ? 's' : ''} ${listText(allowances)} name${many ? '' : 's'} reservation${entries.length > 1 ? 's' : ''} ${listText(entries.map(u => u.id))}`;
}

/**
 * Why an empty reservation list sits beside reservations in use, in plain words; undefined when nothing contradicts it.
 * It states what was observed (an allowance names the block group; the list lacks it), not that the reservation exists.
 */
export function reservationGapText(e: ReservationEvidence): string | undefined {
  if (e.listed !== 0) return undefined;
  const parts: string[] = [];
  if (e.unlisted.length) parts.push(allowanceClause(e.unlisted));
  if (e.reservedNodeGroups.length) {
    const many = e.reservedNodeGroups.length > 1;
    parts.push(`node group${many ? 's' : ''} ${listText(e.reservedNodeGroups)} run${many ? '' : 's'} as reserved`);
  }
  if (!parts.length) return undefined;
  const where = e.region ? ` in ${e.region}` : '';
  let tail: string;
  if (e.unlisted.length) {
    const several = e.unlisted.length > 1;
    const it = several ? 'them' : 'it';
    tail = `${several ? 'Allowances name them' : 'An allowance names it'}; ${e.region ? `the list shows ${it} in no region` : `the list does not show ${it}`}, and the API does not say why.`;
  } else {
    tail = `The list does not show ${e.reservedNodeGroups.length > 1 ? 'their reservations' : 'its reservation'}${where}, and the API does not say why.`;
  }
  return `The reservation list shows none${where}, yet ${parts.join(' and ')}. ${tail}`;
}

/** Reservations allowances name that the region filter hides, with their region; undefined when there are none. */
export function reservationElsewhereText(e: ReservationEvidence): string | undefined {
  if (!e.elsewhere.length) return undefined;
  const regions = [...new Set(e.elsewhere.map(x => x.region ?? 'another region'))];
  const several = e.elsewhere.length > 1;
  const clause = allowanceClause(e.elsewhere);
  return `${clause[0].toUpperCase()}${clause.slice(1)}, which ${several ? 'are' : 'is'} in ${listText(regions)}, outside the region filter${e.region ? ` (${e.region})` : ''}.`;
}

/* ------------------------------------------------------ availability (advice) */

export type CapacityKind = 'on-demand' | 'preemptible' | 'reserved';

const ADVICE_KEY = { 'on-demand': 'onDemand', preemptible: 'preemptible', reserved: 'reserved' } as const;
const ADVICE_RANK: Record<string, number> = { high: 4, medium: 3, low: 2, 'limit-reached': 1 };

export interface AvailabilityOption {
  region: string;
  fabric?: string;
  capacityType: CapacityKind;
  level: string;
  available: number;
}

export interface AvailabilityCheck {
  region: string;
  platform: string;
  preset: string;
  fabric?: string;
  capacityType: CapacityKind;
  requested: number;
  /**
   * short: fewer available than requested; limit-reached: none can be created; no-advice: the advisor lists nothing
   * for this shape; unknown: the advisor was not read (W1-P4: never "fits").
   */
  state: 'ok' | 'short' | 'limit-reached' | 'no-advice' | 'not-applicable' | 'unknown';
  level?: string;
  available?: number;
  limit?: number;
  stale?: boolean;
  /** Same platform and preset elsewhere (another fabric, region or capacity type) with room for the request. */
  alternatives: AvailabilityOption[];
  message: string;
}

/**
 * The capacity advisor's view of one request: GPU VMs of `preset` on `platform` in `region` (and `fabric`,
 * when the shape needs one) of `capacityType`. Advice is a snapshot, not a reservation; it changes minute to minute.
 */
export function checkAvailability(
  advice: ResourceAdviceView[],
  want: { region: string; platform: string; preset: string; fabric?: string; capacityType: CapacityKind; requested: number },
): AvailabilityCheck {
  const base = { ...want, alternatives: [] as AvailabilityOption[] };
  if (want.capacityType === 'reserved') return { ...base, state: 'not-applicable', message: 'Reserved capacity is checked against the reservation (capacity block group), not the advisor.' };
  if (want.requested <= 0) return { ...base, state: 'not-applicable', message: 'No GPU nodes requested.' };
  const shape = advice.filter(a => a.platform === want.platform && a.preset === want.preset);
  const options: (AvailabilityOption & { stale: boolean; limit?: number })[] = [];
  for (const a of shape) {
    for (const kind of ['on-demand', 'preemptible'] as const) {
      const x = a[ADVICE_KEY[kind]];
      if (!a.region || !x?.level) continue;
      options.push({ region: a.region, fabric: a.fabric, capacityType: kind, level: x.level.toLowerCase(), available: x.available ?? 0, limit: x.limit, stale: x.dataState?.toLowerCase() === 'stale' });
    }
  }
  const inRegion = options.filter(o => o.region === want.region && o.capacityType === want.capacityType);
  // The advisor's fabric names can differ from platform/regions.yaml: without a match, judge the region.
  const onFabric = inRegion.filter(o => want.fabric && o.fabric === want.fabric);
  const here = onFabric.length ? onFabric : inRegion;
  const score = (o: AvailabilityOption) => (ADVICE_RANK[o.level] ?? 0) * 10_000 + Math.min(o.available, 9_999);
  const best = [...here].sort((a, b) => score(b) - score(a))[0];
  const roomy = (o: AvailabilityOption) => o.level !== 'limit-reached' && o.available >= want.requested;
  const alternatives = options
    .filter(o => o !== best && roomy(o) && !(o.region === want.region && o.capacityType === want.capacityType && o.fabric === best?.fabric))
    .sort((a, b) => Number(b.capacityType === want.capacityType) - Number(a.capacityType === want.capacityType) || score(b) - score(a))
    .slice(0, 3)
    .map(({ region, fabric, capacityType, level, available }) => ({ region, fabric, capacityType, level, available }));
  const where = `${want.region}${onFabric.length ? ` ${want.fabric}` : ''}`;
  if (!best) return { ...base, alternatives, state: 'no-advice', message: `The capacity advisor lists no ${want.capacityType} advice for ${want.platform} ${want.preset} in ${where}.` };
  const figures = { level: best.level, available: best.available, limit: best.limit, stale: best.stale, fabric: best.fabric };
  if (best.level === 'limit-reached') return { ...base, ...figures, alternatives, state: 'limit-reached', message: `${want.capacityType} ${want.preset} in ${where}: limit reached (0 available, ${want.requested} requested).` };
  if (best.available < want.requested) return { ...base, ...figures, alternatives, state: 'short', message: `${want.capacityType} ${want.preset} in ${where}: ${best.level}, ${best.available} available vs ${want.requested} requested.` };
  return { ...base, ...figures, alternatives, state: 'ok', message: `${want.capacityType} ${want.preset} in ${where}: ${best.level}, ${best.available} available vs ${want.requested} requested.` };
}

/**
 * A quota amount as GPU & Capacity shows it: bytes as GiB / TiB (two decimals at most), anything else as a grouped
 * number. Alert titles use it too, so "capped at 1649267441664" reads "capped at 1.5 TiB".
 */
export function fmtQuotaAmount(n: number, unit: string | undefined): string {
  const grouped = (x: number) => x.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 0 });
  if (!/^bytes?$/i.test(unit ?? '')) return grouped(n);
  const gib = n / 2 ** 30;
  if (gib >= 1024) return `${grouped(gib / 1024)} TiB`;
  if (gib > 0 && gib < 0.01) return '< 0.01 GiB';
  return `${grouped(gib)} GiB`;
}

/**
 * An amount of a quota line (checkQuotas: sizes in GiB) in its unit: sizes as GiB / TiB, vCPU and GPUs by name,
 * counts as grouped numbers (#43: "4,373 > 4,096" read as nothing).
 */
export function quotaLineAmount(quota: string, n: number): string {
  if (/\.size\./.test(quota)) return fmtQuotaAmount(n * 2 ** 30, 'bytes');
  const grouped = n.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 0 });
  if (/(^|\.)vcpu$/.test(quota)) return `${grouped} vCPU`;
  if (/(^|\.)gpu\.[a-z0-9-]+$/.test(quota)) return `${grouped} GPU${n === 1 ? '' : 's'}`;
  return grouped;
}

/**
 * The inputs a live root is planned with under a run profile (one model for the Overview, the footprint calculator,
 * Provisioning and scripts/preflight.py): the sizing file, then the profile's vars over it, as
 * `make plan PROFILE=<name>` renders them (-var-file after the auto file).
 */
export function runProfileSizing<T extends Record<string, string | number | boolean | null | undefined>>(sizing: T, profile?: { vars: Record<string, string | number | boolean | null> }): T {
  return profile ? { ...sizing, ...profile.vars } : { ...sizing };
}
