import type { CapabilityState, Footprint, LiveRoot, NodeGroupCapacity, PlannedQuotaIssue, PlatformView, QuotaAllowanceView, QuotaCheckLine, RegionsFile } from '@internal/nebius-domain';
import { checkPlannedFootprint, effectiveQuota, gpuQuotaModel, NEAR_LIMIT_PERCENT, nodeCountState, parsePreset, plannedQuotaOptions, quotaLineAmount, resolvePlatform, runProfileSizing } from '@internal/nebius-domain';
import { fmtNumber } from '../../ui/format';

const CAPABILITY_STATES: CapabilityState[] = ['ok', 'permission-denied', 'not-found', 'rejected', 'unreachable', 'schema-drift', 'not-configured'];

/** A GPU quota: counted in GPUs, or named `<service>.<kind>.gpu.<model>` (never `non-gpu`). */
export function isGpuQuota(q: Pick<QuotaAllowanceView, 'name' | 'unit'>): boolean {
  if (q.unit?.toLowerCase() === 'gpu' || q.unit?.toLowerCase() === 'gpus') return true;
  return /(^|\.)gpu\.[a-z0-9-]+$/i.test(q.name);
}

/** "compute.instance.gpu.h100" -> "H100"; falls back to the description, then the name. */
export function gpuModel(q: Pick<QuotaAllowanceView, 'name' | 'description'>): string {
  const m = /(?:^|\.)gpu\.([a-z0-9-]+)$/i.exec(q.name);
  if (m) return m[1].toUpperCase();
  return q.description ?? q.name;
}

/** Usage as a percentage of the limit: the API's figure first, else usage / limit; null when it cannot be known. */
export function usagePercent(x: { usage: number | null; limit: number | null; usagePercent?: number | null }): number | null {
  if (x.usagePercent !== null && x.usagePercent !== undefined && Number.isFinite(x.usagePercent)) return x.usagePercent;
  if (x.usage === null || x.limit === null || x.limit <= 0) return null;
  return (x.usage / x.limit) * 100;
}

export type UsageLevel = 'over' | 'near' | 'under' | 'zero-limit' | 'inherits' | 'unknown';

type UsageLike = { usage: number | null; limit: number | null; usagePercent?: number | null; allocation?: QuotaAllowanceView['allocation'] };

/**
 * How close an allowance is to its ceiling. A limit of 0 is its own state: nothing can be created until quota
 * is granted. A project placeholder (inherits-tenant) has no ceiling of its own: it uses the tenant quota.
 */
export function usageLevel(x: UsageLike): UsageLevel {
  if (x.allocation === 'inherits-tenant') return 'inherits';
  if (x.limit === 0) return 'zero-limit';
  const p = usagePercent(x);
  if (p === null) return 'unknown';
  if (p >= 100) return 'over';
  if (p >= NEAR_LIMIT_PERCENT) return 'near';
  return 'under';
}

export const LEVEL_TONE: Record<UsageLevel, 'danger' | 'warn' | 'ok' | 'neutral'> = {
  over: 'danger',
  near: 'warn',
  under: 'ok',
  'zero-limit': 'danger',
  inherits: 'neutral',
  unknown: 'neutral',
};

export const LEVEL_LABEL: Record<UsageLevel, string> = {
  over: 'at limit',
  near: 'near limit',
  under: 'headroom',
  'zero-limit': 'blocked (limit 0)',
  inherits: 'uses tenant quota',
  unknown: 'limit not reported',
};

/** Meter colour for a level. */
export function meterTone(level: UsageLevel): 'accent' | 'ok' | 'warn' | 'danger' {
  return level === 'over' ? 'danger' : level === 'near' || level === 'zero-limit' ? 'warn' : 'accent';
}

/**
 * What to show for an allowance. A placeholder shows the tenant allowance it draws on (headroom against
 * the tenant limit of its region), or no limit when that was not read: never 0.
 */
export function quotaFigures(q: QuotaAllowanceView): { usage: number; limit: number | null; percent: number | null; level: UsageLevel; inherits: boolean; ownUsage: number } {
  const e = effectiveQuota(q);
  const inherits = q.allocation === 'inherits-tenant';
  const percent = inherits ? (e.limit ? (100 * e.usage) / e.limit : null) : usagePercent(q);
  return { usage: e.usage, limit: e.limit, percent, level: usageLevel(q), inherits, ownUsage: q.usage };
}

const URGENCY: Record<UsageLevel, number> = { over: 0, near: 1, 'zero-limit': 2, under: 3, unknown: 4, inherits: 5 };

/** How urgent an allowance is, as a number (0 most urgent): the Status column sorts by it (G2.12), never by the level's name. */
export function urgencyRank(q: UsageLike): number {
  return URGENCY[usageLevel(q)];
}

/** Sorts the most urgent allowance first: at limit, near limit, zero limit, then by percentage. */
export function byUrgency<T extends UsageLike>(a: T, b: T): number {
  const d = urgencyRank(a) - urgencyRank(b);
  return d !== 0 ? d : (usagePercent(b) ?? -1) - (usagePercent(a) ?? -1);
}

/** Compute VM quotas (compute.*); other services (Standalone Applications: msp.cloudapps.*, …) are listed apart. */
export function isComputeQuota(q: Pick<QuotaAllowanceView, 'name'>): boolean {
  return q.name.startsWith('compute.');
}

export const PREEMPTIBLE_QUOTA = 'compute.instance.preemptible.count';

/** "Compute VMs", "Standalone apps", or the service id. */
export function serviceLabel(q: Pick<QuotaAllowanceView, 'name' | 'service'>): string {
  if (isComputeQuota(q)) return 'Compute VMs';
  if (q.name.startsWith('msp.cloudapps.')) return 'Standalone apps';
  return q.service ?? q.name.split('.')[0];
}

/**
 * Whether an allowance needs attention now: at or near its limit, or a Compute limit of 0 in a region the
 * estate uses (`targets`; every region when none is known). A limit 0 elsewhere, or in another service, is
 * a fact, not an alarm. Placeholders never are: they use the tenant quota.
 */
export function isUrgentQuota(q: QuotaAllowanceView, targets?: Set<string>): boolean {
  const level = usageLevel(q);
  if (level === 'over' || level === 'near') return true;
  if (level !== 'zero-limit') return false;
  return isComputeQuota(q) && (!targets?.size || !q.region || targets.has(q.region));
}

/* --------------------------------------------- node groups against quota */

export interface NodeGroupQuotaStatus {
  /**
   * complete: as many nodes as configured, at least one up; scaled-to-zero: autoscaling at 0, nothing missing;
   * above: more nodes than the spec allows (a mismatch); ok: short of nodes, but the quota has room;
   * not-checked: no allowance to judge by.
   */
  state: 'complete' | 'scaled-to-zero' | 'above' | 'ok' | 'blocked' | 'exhausted' | 'not-checked';
  missing: number;
  /** Nodes above the fixed count or the autoscaling maximum (`ceiling`). */
  extra?: number;
  ceiling?: number;
  /** The fixed count or the autoscaling minimum. */
  target?: number;
  quota?: string;
  description?: string;
  need?: number;
  limit?: number | null;
  usage?: number;
  reason?: string;
}

/**
 * A node group with fewer observed nodes than its configured count, against the regional quota its preset
 * consumes: non-GPU vCPU for CPU presets, the GPU quota for on-demand GPU presets, the preemptible VM count for
 * preemptible ones. Reserved groups draw on their reservation and are not judged here.
 */
export function nodeGroupQuotaStatus(g: NodeGroupCapacity, quotas: QuotaAllowanceView[] | null): NodeGroupQuotaStatus {
  const count = nodeCountState(g);
  const missing = count.missing;
  if (count.state === 'above') return { state: 'above', missing, extra: count.extra, ceiling: count.ceiling, target: count.target };
  if (count.state === 'scaled-to-zero') return { state: 'scaled-to-zero', missing, target: 0 };
  if (!missing) return { state: 'complete', missing };
  if (g.capacityType === 'reserved') return { state: 'not-checked', missing, reason: 'reserved: draws on its reservation (capacity allowance)' };
  const shape = parsePreset(g.preset ?? '');
  let quota: string | undefined;
  let need = 0;
  if (g.gpusPerNode > 0 || (shape?.gpus ?? 0) > 0) {
    const model = gpuQuotaModel(g.platform);
    if (g.capacityType === 'preemptible') {
      quota = PREEMPTIBLE_QUOTA;
      need = missing;
    } else if (model) {
      quota = `compute.instance.gpu.${model}`;
      need = missing * (g.gpusPerNode || shape?.gpus || 0);
    }
  } else if (shape) {
    quota = 'compute.instance.non-gpu.vcpu';
    need = missing * shape.vcpus;
  }
  if (!quota) return { state: 'not-checked', missing, reason: 'preset not recognised' };
  const here = (quotas ?? []).filter(q => q.name === quota && (!q.region || q.region === g.region));
  const q =
    here.find(x => x.scope === 'tenant') ??
    here.find(x => x.projectId === g.projectId && x.allocation === 'set') ??
    here.find(x => x.projectId === g.projectId);
  const e = q ? effectiveQuota(q) : undefined;
  if (!q || !e || e.limit === null) return { state: 'not-checked', missing, quota, need, reason: 'no allowance with a known limit for this region' };
  const base = { missing, quota, description: q.description, need, limit: e.limit, usage: e.usage };
  if (e.limit === 0) return { ...base, state: 'blocked' };
  if (e.usage + need > e.limit) return { ...base, state: 'exhausted' };
  return { ...base, state: 'ok' };
}

/** Case-insensitive match of every word in `q` against a quota's name, description, service, region, unit and project name. */
export function matchesQuota(q: QuotaAllowanceView, query: string, projectName?: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = [q.name, q.description, q.service, q.region, q.unit, q.projectId, projectName, q.state, q.scope === 'tenant' ? 'tenant' : ''].filter(Boolean).join(' ').toLowerCase();
  return words.every(w => hay.includes(w));
}

/**
 * The backend writes an unavailable capability as `<state>: <hint>` (or a plain sentence when it was never read).
 * Splits it so the UI can show a status pill and the hint separately.
 */
export function parseUnavailable(reason: string | undefined): { state?: CapabilityState; text: string } {
  if (!reason) return { text: 'No reason was given.' };
  const m = /^([a-z-]+):\s*(.*)$/s.exec(reason);
  if (m && (CAPABILITY_STATES as string[]).includes(m[1])) return { state: m[1] as CapabilityState, text: m[2] || reason };
  return { text: reason };
}

/* ---------------------------------------------------------------- platforms */

export type PlatformCheck = 'match' | 'preset-mismatch' | 'missing-live' | 'not-in-yaml' | 'not-checked';

export interface PlatformRow {
  key: string;
  region: string;
  platform: string;
  humanName?: string;
  /** In platform/regions.yaml for this region. */
  inYaml: boolean;
  isDefault: boolean;
  yamlPresets: string[];
  /** Live GPU presets seen in projects located in this region (empty when not seen). */
  livePresets: string[];
  /** Projects (ids) in this region whose platform list includes it. */
  projects: string[];
  /** Presets named in regions.yaml that the live API does not offer. */
  missingPresets: string[];
  check: PlatformCheck;
}

/**
 * Which regions each project sits in, from its quota allowances and node groups (both regional).
 * Used for platforms without `regions` (PlatformView.regions is the primary source).
 */
export function projectRegions(quotas: QuotaAllowanceView[] | null, nodeGroups: NodeGroupCapacity[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const add = (p: string | undefined, r: string | undefined) => {
    if (!p || !r) return;
    if (!out.has(p)) out.set(p, new Set());
    out.get(p)!.add(r);
  };
  for (const q of quotas ?? []) if (q.scope !== 'tenant') add(q.projectId, q.region);
  for (const g of nodeGroups) add(g.projectId, g.region);
  return out;
}

const gpuPresets = (p: PlatformView) => p.presets.filter(x => x.gpus > 0).map(x => x.name);

/**
 * Compares the GPU platforms and presets the live API offers (per project, placed in the project's region)
 * with platform/regions.yaml. A region with no project in scope cannot be checked and says so.
 */
export function comparePlatforms(live: PlatformView[], yaml: RegionsFile, projRegions: Map<string, Set<string>>, onlyRegion?: string): PlatformRow[] {
  const gpuLive = live.filter(p => gpuPresets(p).length > 0);
  const regionsWithProjects = new Set([...[...projRegions.values()].flatMap(s => [...s]), ...live.flatMap(p => p.regions ?? [])]);
  const regions = new Set([...Object.keys(yaml.regions), ...regionsWithProjects]);
  const rows: PlatformRow[] = [];
  for (const region of [...regions].sort()) {
    if (onlyRegion && region !== onlyRegion) continue;
    const reg = yaml.regions[region];
    const checked = regionsWithProjects.has(region);
    const liveHere = gpuLive
      // A project whose region is known counts only in that region; one of unknown region counts where the platform is listed.
      .map(p => ({ p, projects: p.projects.filter(id => (projRegions.get(id) ? projRegions.get(id)!.has(region) : !!p.regions?.includes(region))) }))
      .filter(x => x.projects.length > 0);
    const names = new Set([...Object.keys(reg?.platforms ?? {}), ...liveHere.map(x => x.p.name)]);
    for (const platform of [...names].sort()) {
      const entry = reg?.platforms[platform];
      const l = liveHere.find(x => x.p.name === platform);
      const yamlPresets = entry ? [entry.single_gpu_preset, entry.ib_preset].filter((x): x is string => Boolean(x)) : [];
      const livePresets = l ? gpuPresets(l.p) : [];
      const missingPresets = l ? yamlPresets.filter(x => !livePresets.includes(x)) : [];
      let check: PlatformCheck;
      if (!checked) check = 'not-checked';
      else if (entry && l) check = missingPresets.length ? 'preset-mismatch' : 'match';
      else if (entry) check = 'missing-live';
      else check = 'not-in-yaml';
      rows.push({
        key: `${region}/${platform}`,
        region,
        platform,
        humanName: l?.p.humanName,
        inYaml: Boolean(entry),
        isDefault: reg?.default === platform,
        yamlPresets,
        livePresets,
        projects: l?.projects ?? [],
        missingPresets,
        check,
      });
    }
  }
  return rows;
}

/** Live GPU platforms in projects whose region is not known from quotas or node groups. */
export function unplacedPlatforms(live: PlatformView[], projRegions: Map<string, Set<string>>): { platform: string; projects: string[] }[] {
  return live
    .filter(p => gpuPresets(p).length > 0 && !p.regions?.length)
    .map(p => ({ platform: p.name, projects: p.projects.filter(id => !projRegions.has(id)) }))
    .filter(x => x.projects.length > 0);
}

/* ------------------------------------------------- footprint calculator */

export const MAX_CALC_NODES = 64;
export type CountKey = 'min' | 'expected' | 'max';
const COUNT_LABEL: Record<CountKey, string> = { min: 'Minimum', expected: 'Expected', max: 'Maximum' };

/**
 * The calculator's node counts, checked on the client: whole numbers, minimum ≤ expected ≤ maximum. A value
 * above the 64-node ceiling is clamped, and the field says so. `counts` is set only when every field is valid.
 */
export function validateNodeCounts(raw: Record<CountKey, string>): {
  counts?: Record<CountKey, number>;
  errors: Partial<Record<CountKey, string>>;
  notes: Partial<Record<CountKey, string>>;
} {
  const errors: Partial<Record<CountKey, string>> = {};
  const notes: Partial<Record<CountKey, string>> = {};
  const n: Partial<Record<CountKey, number>> = {};
  for (const k of ['min', 'expected', 'max'] as const) {
    const v = raw[k].trim();
    if (/^\d+$/.test(v)) {
      const x = Number(v);
      n[k] = Math.min(x, MAX_CALC_NODES);
      if (x > MAX_CALC_NODES) notes[k] = `Clamped to ${MAX_CALC_NODES} (the most nodes one node group plans here).`;
    } else errors[k] = /^-?\d*[.,]\d+$/.test(v) ? 'Enter a whole number of nodes (no decimals).' : 'Enter a whole number of nodes.';
  }
  if (n.min !== undefined && n.expected !== undefined && n.min > n.expected) errors.min = `${COUNT_LABEL.min} (${n.min}) is above expected (${n.expected}).`;
  if (n.max !== undefined && n.expected !== undefined && n.max < n.expected) errors.max = `${COUNT_LABEL.max} (${n.max}) is below expected (${n.expected}).`;
  if (Object.keys(errors).length) return { errors, notes };
  return { counts: n as Record<CountKey, number>, errors, notes };
}

export interface FootprintQuotaStatus {
  /** blocked: some limit is 0; exceeded: some limit would be passed; not-checked: no tenant allowance read for the region. */
  state: 'ok' | 'blocked' | 'exceeded' | 'not-checked';
  lines: QuotaCheckLine[];
}

/** The calculator's footprint against the tenant allowances of its region: checkPlannedFootprint, as on Overview. */
export function footprintQuotaStatus(fp: Footprint, stack: string, sizing: Record<string, string | number | boolean | null>, region: string, quotas: QuotaAllowanceView[] | null | undefined): FootprintQuotaStatus {
  const r = checkPlannedFootprint(fp, stack, sizing, region, quotas ?? []);
  if (!r.lines.length) return { state: 'not-checked', lines: [] };
  const bad = r.lines.filter(l => l.state !== 'ok');
  return { state: bad.some(l => l.state === 'blocked') ? 'blocked' : bad.length ? 'exceeded' : 'ok', lines: bad.length ? bad : r.lines };
}

/* ------------------------------------------------------------- units */

const UNIT_LABELS: Record<string, string> = { count: '', byte: 'GiB', bytes: 'GiB', vcpu: 'vCPUs', gpu: 'GPUs', gib: 'GiB' };

/** How a quota's unit reads: "count" disappears, bytes are shown in GiB / TiB, vcpu → vCPUs. */
export function unitLabel(unit: string | undefined): string {
  if (!unit) return '';
  return UNIT_LABELS[unit.toLowerCase()] ?? unit;
}

/** A quota amount in its unit as people read it: bytes as GiB / TiB, everything else a plain number. */
export function fmtQuotaAmount(n: number, unit: string | undefined): string {
  if (!/^bytes?$/i.test(unit ?? '')) return fmtNumber(n, 2);
  const gib = n / 2 ** 30;
  if (gib >= 1024) return `${fmtNumber(gib / 1024, 2)} TiB`;
  if (gib > 0 && gib < 0.01) return '< 0.01 GiB';
  return `${fmtNumber(gib, 2)} GiB`;
}

/** The live roots blocked by quota (the Overview tile and the Capacity header count these): distinct plans, sorted. */
export function blockedPlans(issues: PlannedQuotaIssue[] | null | undefined): string[] | null {
  if (!issues) return null;
  return [...new Set(issues.map(i => i.plan))].sort();
}

/* ------------------------------------------------------- footprint calculator */

/**
 * The sizing the calculator uses (G2.3): the live root's sizing file, with a run profile's vars over it when one is
 * chosen (as `make plan PROFILE=<name>` renders them); the GPU capacity type the price and quota check use; and the
 * GPU platform the footprint resolves to in the region.
 */
export function calculatorSizing(
  root: Pick<LiveRoot, 'sizing' | 'runProfiles'> | undefined,
  stack: string,
  profileName: string | undefined,
  regions: RegionsFile,
  region: string,
): { sizing: LiveRoot['sizing']; profile?: NonNullable<LiveRoot['runProfiles']>[number]; capacityType: 'on-demand' | 'preemptible'; gpuPlatform?: string } {
  const profile = profileName ? root?.runProfiles?.find(p => p.name === profileName) : undefined;
  const sizing = runProfileSizing(root?.sizing ?? {}, profile);
  const gpuPlatform = resolvePlatform({ regions, region, gpuPlatform: (sizing.gpu_platform as string | null | undefined) ?? undefined })?.platform;
  return { sizing, ...(profile ? { profile } : {}), capacityType: plannedQuotaOptions(stack, sizing).capacityType, ...(gpuPlatform ? { gpuPlatform } : {}) };
}

/**
 * The node counts once a run profile is chosen (#27): a profile plans a fixed gpu_node_count, so expected and max are
 * that count and min is at most it. Max never stays above the profile's count (it kept 4 and warned above the cap).
 */
export function profileNodeCounts(raw: Record<CountKey, string>, n: number): Record<CountKey, string> {
  const min = Number(raw.min);
  return { min: String(Number.isInteger(min) && min >= 0 ? Math.min(min, n) : 0), expected: String(n), max: String(n) };
}

/** A quota line of a footprint check, in words and units (#43): "in use 0 GiB + needs 4.27 TiB > limit 4 TiB in eu-north1". */
export function quotaLineText(l: Pick<QuotaCheckLine, 'quota' | 'need' | 'limit' | 'usage' | 'state'>, region: string): string {
  const a = (n: number) => quotaLineAmount(l.quota, n);
  if (l.state === 'blocked') return `needs ${a(l.need)}, limit 0 in ${region}`;
  return `in use ${a(l.usage)} + needs ${a(l.need)} ${l.state === 'ok' ? '≤' : '>'} limit ${a(l.limit)} in ${region}`;
}
