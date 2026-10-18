import {
  AllowanceFinding,
  CapabilityStatus,
  meanUtilisation,
  NEAR_LIMIT_PERCENT,
  nearLimitCheck,
  reconcileTenantUsage,
  nearLimitText,
  attribute,
  attributeWithParents,
  checkAllowances,
  buildResourceGraph,
  AvailabilityCheck,
  clusterLifecycleReason,
  CapacityBlockGroupView,
  CapacityResponse,
  checkAvailability,
  checkPlannedFootprint,
  checkQuotas,
  PolicyIssue,
  ProvisioningRequestInput,
  ResourceAdviceView,
  findOrphanCandidates,
  Footprint,
  parsePreset,
  plannedFootprint,
  PlannedQuotaIssue,
  QuotaAllowanceView,
  QuotaCheck,
  quotaLineAmount,
  quotaRequirements,
  ReservationCheck,
  runProfileSizing,
  tenantAllowances,
  tenantAllowancesGap,
  orphanExemption,
  GraphResponse,
  NodeGroupCapacity,
  ObservedResource,
  OverviewResponse,
  LiveRoot,
  RepoModel,
  ResourceListResponse,
  ResourceView,
  SourcedMetric,
  effectiveTtl,
  fmtUtc,
  lastSeenBefore,
  WorkloadsResponse,
  WorkloadSummary,
} from '@internal/nebius-domain';
import { inScope, ProjectScope } from './lib/access';
import { EstateSnapshot, gpuQuantity, KubeCluster } from './inventory/types';
import { CATALOG, NODE_GROUPS } from './inventory/nebius-catalog';
import { MONITORING_SOURCE } from './inventory/monitoring';

/**
 * Pure functions from (snapshot, repository, caller scope) to API responses.
 * Scope is applied first, so nothing below can leak an out-of-scope row.
 */

export interface ScopedSnapshot {
  resources: ObservedResource[];
  kube: KubeCluster[];
  telemetry: EstateSnapshot['telemetry'];
  monitoring: EstateSnapshot['monitoring'];
  coverage: EstateSnapshot['coverage'];
  statuses: EstateSnapshot['statuses'];
  capabilities: EstateSnapshot['capabilities'];
  capacity: EstateSnapshot['capacity'];
  /** The caller sees every project (tenant-level data is shown to unrestricted callers only). */
  unrestricted: boolean;
  orphanStreaks?: Record<string, number>;
  observedAt?: string;
  /** EstateSnapshot.inventoryReadAt: resources read before it are shown as last seen. */
  inventoryReadAt?: string;
}

export function scopeSnapshot(s: EstateSnapshot, scope: ProjectScope): ScopedSnapshot {
  const resources = s.resources.filter(r => inScope(scope, r.projectId));
  const visible = new Set(resources.map(r => r.providerId));
  const kube = s.kube.filter(c => (c.mk8sClusterId ? visible.has(c.mk8sClusterId) : scope.all));
  const nodes = new Set(kube.flatMap(c => c.nodes.map(n => n.name)));
  const telemetry = s.telemetry
    ? { ...s.telemetry, samples: s.telemetry.samples.filter(x => (x.instanceId ? visible.has(x.instanceId) : nodes.has(x.node))) }
    : undefined;
  const monitoring = s.monitoring ? { ...s.monitoring, gpus: s.monitoring.gpus.filter(g => inScope(scope, g.projectId)) } : undefined;
  const own = <T extends { projectId?: string }>(xs: T[]) => xs.filter(x => inScope(scope, x.projectId));
  // Tenant-level capacity (block groups, advice) is for unrestricted callers only.
  const scopedCapacity = scope.all
    ? { ...s.capacity, quotas: withTenantQuota(s.capacity.quotas) }
    : {
        quotas: own(s.capacity.quotas),
        capacityAllowances: own(s.capacity.capacityAllowances),
        maintenances: own(s.capacity.maintenances),
        platforms: s.capacity.platforms.filter(p => p.projects.some(id => scope.projects.has(id))).map(p => ({ ...p, projects: p.projects.filter(id => scope.projects.has(id)) })),
        capacityBlockGroups: [],
        resourceAdvice: [],
      };
  const capabilities = scope.all
    ? s.capabilities
    : s.capabilities
        // A discovered cluster's capability is visible with its cluster.
        .filter(c => !c.id.startsWith('k8s.cluster:') || visible.has(c.id.slice('k8s.cluster:'.length)))
        .map(c => ({ ...c, lastError: maskProjects(c.lastError, scope), perProject: c.perProject?.filter(p => scope.projects.has(p.id)) }));
  // A restricted caller sees only its own projects in connector scopes, errors and coverage.
  const statuses = scope.all
    ? s.statuses
    : s.statuses
        .filter(c => !c.id.startsWith('mk8s:') || (c.projects ?? []).some(p => scope.projects.has(p.id)))
        .map(c => {
        const projects = c.projects?.filter(p => scope.projects.has(p.id));
        return {
          ...c,
          projects,
          scope: projects ? `${projects.length} project${projects.length === 1 ? '' : 's'} in your scope` : maskProjects(c.scope, scope)!,
          error: maskProjects(c.error, scope),
        };
      });
  const coverage = scope.all
    ? s.coverage
    : s.coverage.filter(c => !c.project || scope.projects.has(c.project.id)).map(c => ({ ...c, note: maskProjects(c.note, scope) }));
  return { resources, kube, telemetry, monitoring, coverage, statuses, capabilities, capacity: scopedCapacity, unrestricted: scope.all, observedAt: s.observedAt, inventoryReadAt: s.inventoryReadAt, orphanStreaks: s.orphanStreaks };
}

/**
 * Attaches to each project placeholder (inherits-tenant) the tenant allowance of the same quota and region it
 * draws on. Unrestricted callers only: tenant-level figures are not shown to project-scoped callers. A tenant usage
 * below what its projects report takes their sum first (reconcileTenantUsage), so both rows show the same use.
 */
export function withTenantQuota(all: QuotaAllowanceView[]): QuotaAllowanceView[] {
  const quotas = reconcileTenantUsage(all);
  const key = (q: QuotaAllowanceView) => `${q.name}|${q.region ?? ''}`;
  const tenant = new Map(tenantAllowances(quotas).map(q => [key(q), q]));
  return quotas.map(q => {
    const t = q.allocation === 'inherits-tenant' ? tenant.get(key(q)) : undefined;
    return t ? { ...q, tenant: { limit: t.limit, usage: t.usage, usagePercent: t.limit > 0 ? Math.round((10_000 * t.usage) / t.limit) / 100 : null } } : q;
  });
}

/** Connector scopes and errors name every configured project; a restricted caller sees only its own ids. */
export function maskProjects(text: string | undefined, scope: ProjectScope): string | undefined {
  if (!text || scope.all) return text;
  return text.replace(/project-[a-z0-9]+/g, id => (scope.projects.has(id) ? id : 'project-…'));
}

/**
 * Applies the global project / region / stage filter on top of the caller's
 * scope. Projects stay when any of their resources remains; Kubernetes
 * clusters follow their MK8s cluster; telemetry follows the remaining nodes.
 * Without an active filter the snapshot is returned unchanged.
 */
export function narrowSnapshot(s: ScopedSnapshot, f: Pick<ResourceFilter, 'project' | 'region' | 'stage'>): ScopedSnapshot {
  if (!f.project && !f.region && !f.stage) return s;
  const kept = filterResources(
    s.resources.filter(r => r.type !== 'project'),
    { project: f.project, region: f.region, stage: f.stage },
  );
  const projects = new Set(kept.map(r => r.projectId));
  const resources = [...s.resources.filter(r => r.type === 'project' && projects.has(r.providerId)), ...kept];
  const ids = new Set(resources.map(r => r.providerId));
  const kube = s.kube.filter(c => c.mk8sClusterId !== undefined && ids.has(c.mk8sClusterId));
  const nodes = new Set(kube.flatMap(c => c.nodes.map(n => n.name)));
  const telemetry = s.telemetry
    ? { ...s.telemetry, samples: s.telemetry.samples.filter(x => (x.instanceId ? ids.has(x.instanceId) : nodes.has(x.node))) }
    : undefined;
  // Monitoring series follow their VM when its id is known, else their project.
  const monitoring = s.monitoring
    ? { ...s.monitoring, gpus: s.monitoring.gpus.filter(g => (g.instanceId ? ids.has(g.instanceId) : !!g.projectId && projects.has(g.projectId) && !f.region && !f.stage)) }
    : undefined;
  // The regions a project filter stands for: its project's region and those of its resources and quota allocations.
  const regionsOf = (set: Set<string>) => (set.size ? set : undefined);
  const projectRegions = f.project
    ? regionsOf(new Set(
        [
          ...s.resources.filter(r => r.providerId === f.project || r.projectId === f.project).map(r => r.region),
          ...s.capacity.quotas.filter(q => q.scope === 'project' && q.projectId === f.project).map(q => q.region),
        ].filter((x): x is string => !!x),
      ))
    : undefined;
  // A stage filter stands for the projects it keeps and the regions of their kept resources (G1.2): other projects'
  // caps and other regions' tenant allowances are out of scope, as they are under a project filter.
  // A stage that keeps nothing leaves the tenant list whole (the page shows the empty-scope banner instead).
  const stageRegions = f.stage && kept.length ? new Set(kept.map(r => r.region).filter((x): x is string => !!x)) : undefined;
  const scopeRegions = projectRegions && stageRegions ? new Set([...projectRegions].filter(r => stageRegions.has(r))) : (projectRegions ?? stageRegions);
  const projectKept = (id: string) => (!f.project || id === f.project) && (!f.stage || projects.has(id));
  const narrowedCapacity = {
    ...s.capacity,
    // Tenant allowances bind every project, so a project or stage filter keeps them — in the scope's regions only.
    quotas: s.capacity.quotas.filter(
      q =>
        (q.scope === 'tenant' ? !q.region || !scopeRegions || scopeRegions.has(q.region) : projectKept(q.projectId)) &&
        (!f.region || !q.region || q.region === f.region),
    ),
    capacityAllowances: s.capacity.capacityAllowances.filter(q => projectKept(q.projectId)),
    maintenances: s.capacity.maintenances.filter(m => projectKept(m.projectId)),
    capacityBlockGroups: s.capacity.capacityBlockGroups.filter(b => !f.region || b.region === f.region),
    platforms: s.capacity.platforms
      .filter(p => (!f.project || p.projects.includes(f.project)) && (!f.region || !p.regions?.length || p.regions.includes(f.region)))
      .map(p => (f.project ? { ...p, projects: [f.project], regions: p.regions?.filter(r => !projectRegions || projectRegions.has(r)) } : p)),
    resourceAdvice: s.capacity.resourceAdvice.filter(a => (!f.region || !a.region || a.region.startsWith(f.region)) && (!scopeRegions || !a.region || scopeRegions.has(a.region))),
  };
  return { ...s, resources, kube, telemetry, monitoring, capacity: narrowedCapacity };
}

export interface ResourceFilter {
  project?: string;
  region?: string;
  stage?: string;
  type?: string;
  q?: string;
  attribution?: 'attributed' | 'unattributed';
}

/** The stages resources carry (own nip-stage label or their parents'), in the order of platform/stages.yaml. */
export function presentStages(rs: ObservedResource[], known: string[]): string[] {
  const byId = new Map(rs.map(r => [r.providerId, r]));
  const present = new Set(rs.filter(r => r.type !== 'project').map(r => r.labels['nip-stage'] ?? attributeWithParents(r, byId).stage).filter((x): x is string => Boolean(x)));
  if (!rs.length) return known;
  return [...known.filter(s => present.has(s)), ...[...present].filter(s => !known.includes(s)).sort()];
}

/** When a filter leaves no project although the inventory has some: say which filter, instead of "no inventory". */
export function emptyScopeReason(before: ScopedSnapshot, after: ScopedSnapshot, f: Pick<ResourceFilter, 'project' | 'region' | 'stage'>): string | undefined {
  if (!f.project && !f.region && !f.stage) return undefined;
  const has = (s: ScopedSnapshot) => s.resources.some(r => r.type === 'project');
  if (!has(before) || has(after)) return undefined;
  // The project by the name the filter bar shows (G1.17); its id when the inventory has no name for it.
  const projectName = f.project ? before.resources.find(r => r.type === 'project' && r.providerId === f.project)?.name || f.project : '';
  // A project and a region it is not in (G2.10): name the mismatch, not a missing allowance.
  if (f.project && f.region && !f.stage) {
    const own = [...new Set(before.resources.filter(r => r.providerId === f.project || r.projectId === f.project).map(r => r.region).filter((x): x is string => !!x))].sort();
    if (own.length && !own.includes(f.region)) return `The filter selects nothing: ${projectName} is not in ${f.region} (its region${own.length === 1 ? '' : 's'}: ${own.join(', ')}).`;
  }
  const parts = [f.stage ? `stage=${f.stage}` : '', f.region ? `region=${f.region}` : '', f.project ? `project=${projectName}` : ''].filter(Boolean);
  return `No project in scope has ${parts.join(' and ')}.`;
}

export function filterResources(rs: ObservedResource[], f: ResourceFilter): ObservedResource[] {
  const q = f.q?.trim().toLowerCase();
  // Node VMs and disks Managed Kubernetes creates carry no nip-* labels: they take their cluster's.
  const byId = new Map(rs.map(r => [r.providerId, r]));
  return rs.filter(r => {
    if (f.project && r.projectId !== f.project) return false;
    if (f.region && r.region !== f.region) return false;
    if (f.stage && (r.labels['nip-stage'] ?? attributeWithParents(r, byId).stage) !== f.stage) return false;
    if (f.type && r.type !== f.type) return false;
    if (f.attribution) {
      const a = attributeWithParents(r, byId);
      if (a.platformDefault || (a.managed && !a.attributed)) return false; // neither ours to attribute nor unattributed
      if ((f.attribution === 'attributed') !== a.attributed) return false;
    }
    if (q) {
      const hay = [r.name, r.providerId, r.type, r.projectId, r.region, ...Object.entries(r.labels).map(([k, v]) => `${k}=${v}`)].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

const RECIPE_DOCS: Record<string, { title: string; path: string }[]> = {
  inference: [
    { title: 'Inference stack', path: 'terraform/stacks/inference/README.md' },
    { title: 'Deploy runbook', path: 'runbooks/deploy.md' },
  ],
  training: [
    { title: 'Training stack', path: 'terraform/stacks/training/README.md' },
    { title: 'Capacity request', path: 'runbooks/capacity-request.md' },
  ],
  soperator: [{ title: 'Soperator stack', path: 'terraform/stacks/soperator/README.md' }],
  network: [{ title: 'Network stack', path: 'terraform/stacks/network/README.md' }],
  data: [{ title: 'Data stack', path: 'terraform/stacks/data/README.md' }],
};

/** A rule must match on this many consecutive syncs before a resource is shown as an orphan candidate. */
export const ORPHAN_CONFIRM_SYNCS = 2;
/**
 * …unless the resource is older than this: a provisioning gap cannot explain a condition on a resource
 * that old, so a restart (streaks start again) does not hide long-standing candidates for one interval.
 */
export const ORPHAN_SETTLED_HOURS = 6;

/**
 * `all`: every resource in scope (parents, clusters) for orphan and attribution lookups when `rs` is a
 * filtered subset. `orphanStreaks`: consecutive syncs each uid matched an orphan rule (from the inventory).
 */
export function resourceViews(
  rs: ObservedResource[],
  repo: RepoModel,
  now: Date,
  ctx: { all?: ObservedResource[]; orphanStreaks?: Readonly<Record<string, number>>; inventoryReadAt?: string } = {},
): ResourceView[] {
  const roots = new Map(repo.liveRoots.map(r => [r.path, r]));
  const all = ctx.all ?? rs;
  const byId = new Map(all.map(r => [r.providerId, r]));
  const orphans = new Map(findOrphanCandidates(all, now).map(o => [o.uid, o.reasons]));
  const settled = (r: ObservedResource) => !!r.createdAt && now.getTime() - Date.parse(r.createdAt) > ORPHAN_SETTLED_HOURS * 3_600_000;
  const confirmed = (r: ObservedResource) => !ctx.orphanStreaks || (ctx.orphanStreaks[r.uid] ?? 0) >= ORPHAN_CONFIRM_SYNCS || settled(r);
  return rs.map(r => {
    const attribution = attributeWithParents(r, byId, new Set(roots.keys()));
    const root = attribution.liveRoot ? roots.get(attribution.liveRoot) : undefined;
    const reasons = orphans.get(r.uid);
    const exemption = r.spec.platformDefault ? undefined : orphanExemption(r, now);
    const lastSeen = lastSeenBefore(r, ctx.inventoryReadAt);
    return {
      ...r,
      attribution,
      ttl: effectiveTtl(attribution, now),
      orphanReasons: reasons && confirmed(r) ? reasons : undefined,
      orphanNote: exemption ?? (reasons && !confirmed(r) ? `matched an orphan rule on the last sync only (${reasons.join('; ')}); shown if it still does on the next` : undefined),
      desiredStateLink: root ? { liveRoot: root.path, sizingFile: root.sizingFile } : undefined,
      docs: attribution.stack ? RECIPE_DOCS[attribution.stack] : undefined,
      ...(lastSeen ? { lastSeen } : {}),
    };
  });
}

export function resourceList(s: ScopedSnapshot, repo: RepoModel, now: Date, f: ResourceFilter): ResourceListResponse {
  const items = resourceViews(filterResources(s.resources, f), repo, now, { all: s.resources, orphanStreaks: s.orphanStreaks, inventoryReadAt: s.inventoryReadAt });
  return {
    items,
    total: items.length,
    coverage: s.coverage,
    observedAt: s.observedAt,
  };
}

export function graph(s: ScopedSnapshot, f: ResourceFilter): GraphResponse {
  const rs = filterResources(s.resources, { ...f, type: undefined, q: undefined });
  // Kubernetes objects become graph nodes only through explicit mappings.
  const visible = new Set(rs.map(r => r.providerId));
  const extra: ObservedResource[] = [];
  for (const c of s.kube) {
    if (!c.mk8sClusterId || !visible.has(c.mk8sClusterId)) continue;
    // A deleting cluster's last snapshot is not drawn as if its workloads still ran.
    if (kubeStaleReason(c, s.resources)) continue;
    const at = c.observedAt ?? '';
    const src = { connector: `kubernetes:${c.name}`, kind: 'kubernetes-api' as const };
    for (const ns of c.namespaces) {
      if (ns === 'kube-system') continue;
      const nsId = `k8s:${c.name}:ns:${ns}`;
      extra.push({ uid: nsId, providerId: nsId, type: 'k8s-namespace', name: ns, labels: {}, status: 'running', refs: [{ relation: 'in-cluster', target: c.mk8sClusterId }], spec: {}, source: src, observedAt: at, coverageNotes: [] });
    }
    for (const w of c.workloads) {
      const wId = `k8s:${c.name}:${w.kind}:${w.namespace}/${w.name}`;
      const pending = w.pods.some(p => p.phase === 'Pending');
      extra.push({
        uid: wId, providerId: wId, type: 'k8s-workload', name: w.name, labels: {}, status: pending ? 'pending' : 'running',
        refs: [{ relation: 'in-namespace', target: `k8s:${c.name}:ns:${w.namespace}` }], spec: { workloadKind: w.kind, requests: w.requests },
        source: src, observedAt: at, coverageNotes: [],
      });
      for (const p of w.pods) {
        const node = c.nodes.find(n => n.name === p.node);
        const pId = `k8s:${c.name}:pod:${w.namespace}/${p.name}`;
        extra.push({
          uid: pId, providerId: pId, type: 'k8s-pod', name: p.name, labels: {}, status: p.phase === 'Pending' ? 'pending' : p.phase === 'Running' ? 'running' : 'unknown',
          statusDetail: p.message,
          refs: [{ relation: 'owned-by', target: wId }, ...(node?.instanceId && visible.has(node.instanceId) ? [{ relation: 'runs-on' as const, target: node.instanceId }] : [])],
          spec: {}, source: src, observedAt: at, coverageNotes: [],
        });
      }
    }
  }
  return buildResourceGraph([...rs, ...extra]);
}

/**
 * Why a cluster's Kubernetes snapshot is not current when its lifecycle explains it (deleting, or gone from the
 * inventory); undefined otherwise. A configured cluster outside the Nebius inventory has no lifecycle here.
 */
export function kubeStaleReason(c: KubeCluster, resources: ObservedResource[]): string | undefined {
  if (!c.mk8sClusterId) return undefined;
  return clusterLifecycleReason(resources.find(r => r.providerId === c.mk8sClusterId), { inventorySynced: resources.length > 0 });
}

/** Clusters whose Kubernetes figures count as current, and the ones left out with their reason. */
function splitKube(s: Pick<ScopedSnapshot, 'kube' | 'resources'>) {
  const current: KubeCluster[] = [];
  const excluded: { name: string; reason: string }[] = [];
  for (const c of s.kube) {
    const reason = kubeStaleReason(c, s.resources);
    if (reason) excluded.push({ name: s.resources.find(r => r.providerId === c.mk8sClusterId)?.name ?? c.name, reason });
    else current.push(c);
  }
  return { current, excluded };
}

/**
 * An empty state's read time: when the list that answered it (the cluster list for "no cluster", the VM list for
 * "no GPUs running") last answered, as `{ observedAt }`; nothing when that list never has.
 */
function listReadAt(s: Pick<ScopedSnapshot, 'capabilities' | 'observedAt'>, id: string): { observedAt?: string } {
  if (!(s.capabilities ?? []).some(c => c.id === id)) return {};
  const at = readTime(s, [id]).observedAt;
  return at ? { observedAt: at } : {};
}

const excludedText = (excluded: { name: string; reason: string }[]) => excluded.map(e => `${e.name}: ${e.reason}`).join('; ');

/**
 * A Kubernetes-derived tile: unavailable without clusters, "no running cluster" when every cluster in scope is
 * deleting or gone (its last snapshot is not current), else the current clusters' figure, naming those left out.
 */
function kubeMetric<T>(s: ScopedSnapshot, source: string, value: (current: KubeCluster[]) => T, extra: { unit?: string; note?: string } = {}): SourcedMetric<T> {
  const { current, excluded } = splitKube(s);
  // An empty state is as of the cluster list that answered it, not without a time.
  const listed = listReadAt(s, 'mk8s.clusters');
  if (!s.kube.length) {
    const clusters = s.resources.filter(r => r.type === 'mk8s-cluster');
    if (s.resources.length && !clusters.length) {
      return { value: null, source, empty: 'No Kubernetes cluster in scope', unavailableReason: 'No Managed Kubernetes cluster in scope; clusters are discovered and connected automatically.', ...listed };
    }
    if (clusters.length && clusters.every(c => c.status === 'deleting')) {
      return { value: null, source, empty: 'No running Kubernetes cluster', unavailableReason: `${clusters.map(c => `${c.name}: ${clusterLifecycleReason(c, { inventorySynced: true })}`).join('; ')}.`, ...listed };
    }
    return { value: null, source, unavailableReason: 'No Kubernetes cluster is configured or in scope.' };
  }
  if (!current.length) {
    return { value: null, source, empty: 'No running Kubernetes cluster', unavailableReason: `${excludedText(excluded)}. Its last Kubernetes snapshot is not counted as current.`, ...listed };
  }
  const note = [extra.note, excluded.length ? `Not counted: ${excluded.map(e => `${e.name} (${e.reason})`).join('; ')}.` : ''].filter(Boolean).join(' ');
  return { value: value(current), unit: extra.unit, source, observedAt: current.map(c => c.observedAt).filter(Boolean).sort().at(-1), ...(note ? { note } : {}) };
}

const TERMINAL_POD_PHASES = new Set(['Succeeded', 'Failed']);

function k8sGpuTotals(kube: KubeCluster[]) {
  let allocatable = 0;
  let requested = 0;
  let pending = 0;
  for (const c of kube) {
    if (c.error && !c.observedAt) continue;
    for (const n of c.nodes) allocatable += gpuQuantity(n.allocatable['nvidia.com/gpu']);
    for (const w of c.workloads) {
      const perPod = gpuQuantity(w.requests['nvidia.com/gpu']);
      // Demand from live pods only (G2.8): a finished GPU Job or a pod left Failed after its preemptible node was
      // reclaimed holds no GPU. A pod without a phase is counted, as Kubernetes has not settled it yet.
      requested += perPod * w.pods.filter(p => !TERMINAL_POD_PHASES.has(p.phase)).length;
      pending += w.pods.filter(p => p.phase === 'Pending' && perPod > 0).length;
    }
  }
  return { allocatable, requested, pending };
}

/**
 * Clusters whose running GPU VMs (node-group members) advertise fewer allocatable GPUs to Kubernetes than they
 * have: typically a node group without a GPU drivers preset, or no NVIDIA device plugin / GPU operator. Only
 * clusters the Kubernetes connector read; a check to make, not a conclusion.
 */
export function gpuSchedulingChecks(resources: ObservedResource[], kube: KubeCluster[]): NonNullable<OverviewResponse['gpuSchedulingChecks']> {
  const byId = new Map(resources.map(r => [r.providerId, r]));
  const out: NonNullable<OverviewResponse['gpuSchedulingChecks']> = [];
  for (const c of kube) {
    if (!c.mk8sClusterId || !c.observedAt || (c.error && !c.stale) || kubeStaleReason(c, resources)) continue;
    const vms = resources.filter(r => {
      if (r.type !== 'compute-instance' || r.status !== 'running' || !(r.spec.gpus ?? 0)) return false;
      const ng = byId.get(r.refs.find(x => x.relation === 'member-of')?.target ?? '');
      return ng?.refs.some(x => x.relation === 'parent' && x.target === c.mk8sClusterId);
    });
    if (!vms.length) continue;
    const gpus = vms.reduce((a, v) => a + (v.spec.gpus ?? 0), 0);
    const allocatable = c.nodes.reduce((a, n) => a + gpuQuantity(n.allocatable['nvidia.com/gpu']), 0);
    if (allocatable >= gpus) continue;
    const nodeGroups = [...new Set(vms.map(v => byId.get(v.refs.find(x => x.relation === 'member-of')!.target)?.name).filter((x): x is string => !!x))];
    out.push({ cluster: byId.get(c.mk8sClusterId)?.name ?? c.name, clusterId: c.mk8sClusterId, nodeGroups, gpuVms: vms.length, gpus, allocatable });
  }
  return out;
}

const TENANT_ONLY = 'Tenant-level data is shown to callers who can see every project.';

function gpuTelemetry(s: ScopedSnapshot, telemetryAllowed: boolean): OverviewResponse['gpuTelemetry'] {
  if (!telemetryAllowed) return { value: null, source: MONITORING_SOURCE, unavailableReason: 'You do not have nebius.telemetry.read.' };
  return s.monitoring
    ? { value: namedGpus(s), source: MONITORING_SOURCE, observedAt: s.monitoring.observedAt, note: 'Latest value per GPU series of a running VM; each number names its source.' }
    : { value: null, source: MONITORING_SOURCE, unavailableReason: capabilityGap(s, 'monitoring.gpu') };
}

/**
 * Whether the inventory can say a VM of this project is gone: the VM list (compute.instances) answered for the
 * project. A project whose list is refused never shows its VMs, so their absence means nothing. Without a
 * capability record (before the first sync), a synced inventory is taken as listed.
 */
export function instancesListed(s: Pick<EstateSnapshot, 'capabilities' | 'resources'>): (projectId: string | undefined) => boolean {
  const cap = s.capabilities.find(c => c.id === 'compute.instances');
  const ok = (state: string | undefined) => state === 'ok' || state === 'schema-drift';
  return projectId => {
    if (!projectId || !s.resources.length) return false;
    if (!cap) return true;
    const p = cap.perProject?.find(x => x.id === projectId);
    // Without a per-project breakdown every project had the same outcome.
    return p ? ok(p.state) : !cap.perProject && ok(cap.state);
  };
}

/** VM states whose GPUs cannot be reporting now. */
const NOT_RUNNING = new Set(['deleting', 'stopped']);

/**
 * GPU series of VMs that exist and run now, named. Nebius Monitoring still answers for a deleted VM for a few
 * minutes; once the inventory has synced, a series whose VM left it (or is stopped or deleting) is not current.
 */
function namedGpus(s: ScopedSnapshot) {
  const vms = new Map(s.resources.filter(r => r.type === 'compute-instance').map(r => [r.providerId, r]));
  const listed = instancesListed(s);
  return (s.monitoring?.gpus ?? [])
    .filter(g => !g.instanceId || !listed(g.projectId) || (vms.has(g.instanceId) && !NOT_RUNNING.has(vms.get(g.instanceId)!.status)))
    .map(g => ({ ...g, instanceName: g.instanceId ? vms.get(g.instanceId)?.name : undefined }));
}

/** Overview and Capacity say the same about the same window: the latest sample of each reporting GPU series. */
const latestUtilisationNote = (n: number) => `Mean of ${n} reporting GPU series at their latest sample; GPUs without metrics are not counted.`;

/** GPU utilisation from every telemetry source in scope, each series labelled with its source. */
function utilisation(s: ScopedSnapshot): { samples: { node: string; percent: number }[]; source: string; observedAt?: string; reason: string } {
  const nebius = namedGpus(s)
    .filter(g => g.utilPercent !== undefined)
    .map(g => ({ node: `${g.instanceName ?? g.node}${g.gpu !== undefined ? ` · GPU ${g.gpu}` : ''}`, percent: g.utilPercent! }));
  const inCluster = (s.telemetry?.samples ?? []).map(x => ({ node: x.node, percent: x.gpuUtilPercent }));
  const sources = [nebius.length ? MONITORING_SOURCE : '', inCluster.length ? 'Prometheus / DCGM (in-cluster)' : ''].filter(Boolean);
  const reason = s.monitoring
    ? 'No GPU series in scope: Nebius Monitoring reports none for the listed projects (no running GPU VMs, or no metrics yet).'
    : `No GPU telemetry in scope${capabilityGap(s, 'monitoring.gpu') ? `: ${capabilityGap(s, 'monitoring.gpu')}` : '.'} Cloud inventory cannot supply utilisation.`;
  return { samples: [...nebius, ...inCluster], source: sources.join(' + ') || 'GPU telemetry', observedAt: s.monitoring?.observedAt ?? s.telemetry?.observedAt, reason };
}

const capabilityOk = (s: ScopedSnapshot, id: string) => ['ok', 'schema-drift'].includes(s.capabilities.find(c => c.id === id)?.state ?? '');

const TENANT_QUOTAS = 'quotas.allowances.tenant';

/**
 * Why no tenant quota allowance is in hand: no tenant id, a refusal, no answer (F1.33); for a project-scoped caller,
 * that tenant data is not shown to them (the list may well have been read).
 */
function tenantGap(s: Pick<ScopedSnapshot, 'capabilities' | 'unrestricted'>): string {
  if (!s.unrestricted) return 'tenant-level data is shown to callers who can see every project';
  return tenantAllowancesGap(s.capabilities.find(c => c.id === TENANT_QUOTAS));
}

/** Why a capability has no data, naming what to do about it. */
function capabilityGap(s: ScopedSnapshot, id: string): string {
  const c = s.capabilities.find(x => x.id === id);
  if (!c) return inventoryGap(s).replace(/^: /, '') || 'Not read yet.';
  if (c.state === 'not-configured') return c.hint ?? 'Not configured (docs/portal/nebius-setup.md).';
  if (c.state === 'ok') return ''; // it answered: nothing to add (G2.10, never "…: ok.")
  return `${c.state}${c.hint ? `: ${c.hint}` : ''}`;
}

/** Why there is no inventory snapshot, said so that the reader knows what to configure. */
function inventoryGap(s: ScopedSnapshot): string {
  const st = s.statuses.find(x => x.id === 'nebius-inventory')?.state;
  if (st === 'not-configured') return ': the Nebius inventory connector is not configured (list projects and a read-only identity, docs/portal/nebius-setup.md)';
  return st && st !== 'ok' ? ` (connector state: ${st}; see Integrations)` : '';
}

export function overview(
  s: ScopedSnapshot,
  repo: RepoModel,
  now: Date,
  opts: { telemetryAllowed: boolean; pendingRequests: number | null; emptyScope?: string; filter?: Pick<ResourceFilter, 'project' | 'region' | 'stage'>; all?: ObservedResource[]; allQuotas?: QuotaAllowanceView[] },
): OverviewResponse {
  const inv = s.resources;
  const invSource = 'Nebius inventory (REST API)';
  const hasInventory = inv.length > 0;
  const unavailable = (reason: string) => ({ value: null, source: invSource, unavailableReason: reason });
  const projects = [...new Set(inv.filter(r => r.type === 'project').map(r => r.providerId))];
  const regions = [...new Set(inv.map(r => r.region).filter((x): x is string => Boolean(x)))].sort();
  const gpuByPlatform: Record<string, number> = {};
  let gpus = 0;
  let vcpus = 0;
  for (const r of inv) {
    if (r.type !== 'compute-instance' || r.status !== 'running') continue;
    gpus += r.spec.gpus ?? 0;
    vcpus += r.spec.vcpus ?? 0;
    if (r.spec.gpus) gpuByPlatform[r.spec.platform ?? 'unknown'] = (gpuByPlatform[r.spec.platform ?? 'unknown'] ?? 0) + r.spec.gpus;
  }
  const kubeSource = 'Kubernetes API (configured clusters)';
  const views = resourceViews(inv, repo, now, { all: s.resources, orphanStreaks: s.orphanStreaks });
  const util = utilisation(s);
  const why = inventoryGap(s);
  const noInventory = opts.emptyScope ?? `No inventory snapshot${why}`;

  return {
    generatedAt: now.toISOString(),
    emptyScope: opts.emptyScope,
    gpuSchedulingChecks: gpuSchedulingChecks(inv, s.kube),
    projects: hasInventory ? { value: projects, source: invSource, observedAt: s.observedAt } : unavailable(noInventory),
    regions: hasInventory ? { value: regions, source: invSource, observedAt: s.observedAt } : unavailable(noInventory),
    gpuInventory: hasInventory
      ? { value: { gpus, byPlatform: gpuByPlatform }, unit: 'GPUs', source: invSource, observedAt: s.observedAt, note: 'GPUs on running VMs (cloud capacity), from presets. Not Kubernetes allocatable, not utilisation.' }
      : unavailable(noInventory),
    cpuInventory: hasInventory
      ? { value: { vcpus }, unit: 'vCPUs', source: invSource, observedAt: s.observedAt, note: 'vCPUs of running VMs, GPU presets included.' }
      : unavailable(noInventory),
    k8sAllocatableGpus: kubeMetric(s, kubeSource, c => k8sGpuTotals(c).allocatable, { unit: 'GPUs', note: 'Sum of node status.allocatable["nvidia.com/gpu"].' }),
    k8sRequestedGpus: kubeMetric(s, kubeSource, c => k8sGpuTotals(c).requested, { unit: 'GPUs', note: 'Pod requests, scheduled or pending. A request is not utilisation.' }),
    gpuUtilization: !opts.telemetryAllowed
      ? { value: null, source: 'GPU telemetry', unavailableReason: 'You do not have nebius.telemetry.read.' }
      : !hasInventory
        ? // Next to "GPUs on running VMs: unavailable", a utilisation of "1 GPU" would contradict it.
          { value: null, source: 'GPU telemetry', unavailableReason: `Waiting for the inventory: GPU series are tied to running VMs once it has synced${why ? ` (${why.replace(/^[:\s(]+|\)$/g, '')})` : ''}.` }
        : util.samples.length === 0
        ? s.monitoring && gpus === 0
          ? { value: null, source: 'GPU telemetry', empty: 'No GPUs running', unavailableReason: 'No running GPU VM in scope, so there is nothing to measure.', ...listReadAt(s, 'compute.instances') }
          : { value: null, source: 'GPU telemetry', unavailableReason: util.reason }
        : {
            value: { meanPercent: meanUtilisation(util.samples.map(x => x.percent))!, gpusReporting: util.samples.length },
            unit: '%', source: util.source, observedAt: util.observedAt,
            note: latestUtilisationNote(util.samples.length),
          },
    gpuTelemetry: gpuTelemetry(s, opts.telemetryAllowed),
    quotasNearLimit: nearLimit(s),
    quotasAboveLimit: aboveLimit(s),
    plannedQuotaIssues: plannedQuotaIssues(s, repo, opts.filter, opts.all, opts.allQuotas, opts.emptyScope),
    allowanceCheck: allowanceCheck(s, opts.emptyScope),
    maintenances: maintenanceMetric(s),
    pendingGpuPods: kubeMetric(s, kubeSource, c => k8sGpuTotals(c).pending, { unit: 'pods' }),
    pendingProvisioningRequests: opts.pendingRequests === null
      ? { value: null, source: 'Portal database', unavailableReason: 'You do not have nebius.provisioning.preview.' }
      : { value: opts.pendingRequests, unit: 'requests', source: 'Portal database' },
    ttlExpired: hasInventory
      ? { value: views.filter(v => v.ttl.state === 'expired').length, unit: 'resources', source: `${invSource} labels (nip-ttl-expires)`, observedAt: inventoryListsReadAt(s) }
      : unavailable(noInventory),
    orphanCandidates: hasInventory
      ? { value: views.filter(v => v.orphanReasons?.length).length, unit: 'resources', source: invSource, observedAt: inventoryListsReadAt(s), note: 'Candidates for review; nothing is deleted automatically.' }
      : unavailable(noInventory),
    connectors: s.statuses,
  };
}

/** `{ [key]: value }`, or nothing when the value is undefined. */
const optional = <K extends string>(key: K, value: string | undefined): Partial<Record<K, string>> => (value ? ({ [key]: value } as Record<K, string>) : {});

/** Every inventory resource list (the catalog's lists plus node groups), for counts that span them all. */
const RESOURCE_LISTS = [...CATALOG.filter(d => d.kind === 'resources').map(d => d.id), NODE_GROUPS.id];

/**
 * When a figure built from every inventory list was read (followup 13): the oldest last success of the lists that
 * answered, so slow-tier lists read on full syncs only date it, not the latest (possibly fast) re-sync.
 */
function inventoryListsReadAt(s: Pick<ScopedSnapshot, 'capabilities' | 'observedAt'>): string | undefined {
  return readTime(s, RESOURCE_LISTS).observedAt;
}

/** When the Serverless endpoint and job lists were read (AI services; a fast re-sync does not read them). */
export function serverlessReadAt(s: Pick<ScopedSnapshot, 'capabilities' | 'observedAt'>): string | undefined {
  return readTime(s, ['ai.endpoints', 'ai.jobs']).observedAt;
}

/** Scheduled (not finished, not cancelled) maintenance in scope; the Overview tile and the Capacity section show the same list. */
function maintenanceMetric(s: ScopedSnapshot): OverviewResponse['maintenances'] {
  const source = 'Scheduled maintenance (maintenance.v1alpha1)';
  return capabilityOk(s, 'maintenance.maintenances')
    ? { value: s.capacity.maintenances.filter(m => m.state !== 'STATE_FINISHED' && m.state !== 'STATE_CANCELLED'), source, ...readTime(s, ['maintenance.maintenances']) }
    : { value: null, source, unavailableReason: capabilityGap(s, 'maintenance.maintenances') };
}

/** Allowances in use above their limit (a limit of 0 included): the judged set Capacity flags in its Quotas card (F1.11). */
function aboveLimit(s: ScopedSnapshot): NonNullable<OverviewResponse['quotasAboveLimit']> {
  const source = 'Quota allowances (quotas.v1)';
  if (!s.capacity.quotas.length) return { value: null, source, unavailableReason: capabilityGap(s, 'quotas.allowances') };
  return { value: nearLimitCheck(s.capacity.quotas).aboveLimit, source, ...quotaReadTime(s, 'Usage above the limit, as Capacity shows it: the projects can report more than the tenant figure.') };
}

/** The read time of the quota lists behind the in-scope allowances: the project list, and the tenant list when its rows are shown. */
function quotaReadTime(s: ScopedSnapshot, note?: string) {
  return readTime(s, ['quotas.allowances', ...(s.capacity.quotas.some(q => q.scope === 'tenant') ? [TENANT_QUOTAS] : [])], note);
}

function nearLimit(s: ScopedSnapshot): OverviewResponse['quotasNearLimit'] {
  const source = 'Quota allowances (quotas.v1)';
  if (!s.capacity.quotas.length) return { value: null, source, unavailableReason: capabilityGap(s, 'quotas.allowances') };
  // Enforcement uses tenant allowances; without a tenant list, the real project caps (nearLimitCheck, as Capacity counts).
  const check = nearLimitCheck(s.capacity.quotas);
  const level = check.level;
  if (check.judged === check.zeroLimit) {
    return {
      value: null, source, ...quotaReadTime(s),
      unavailableReason: level === 'tenant'
        ? 'No tenant allowance has a non-zero limit in scope; limit 0 is shown as blocked on Capacity.'
        : `No quota limit is known in scope: the projects draw on the tenant quota, and no tenant allowance was read (${tenantGap(s)}).`,
    };
  }
  return {
    value: check.near,
    source,
    ...quotaReadTime(s, `${level === 'tenant' ? 'Tenant' : 'Project'} allowances at ${NEAR_LIMIT_PERCENT} % use or more${check.zeroLimit ? `; limit 0 is blocked, not near, and shown on Capacity` : ''}. A quota is a ceiling, never a guarantee of capacity.`),
    coverage: { checked: check.judged, total: s.capacity.quotas.length, zeroLimit: check.zeroLimit, summary: nearLimitText(check, false) },
  };
}

/**
 * Real project caps against the tenant limit of the same quota and region (checkAllowances): above it no
 * effect, below it caps the project, 0 blocks it. Tenant figures are for unrestricted callers only.
 */
export function allowanceCheck(s: ScopedSnapshot, emptyScope?: string): SourcedMetric<AllowanceFinding[]> {
  const source = 'Project and tenant quota allowances (quotas.v1)';
  if (!s.unrestricted) return { value: null, source, unavailableReason: 'Tenant-level data is shown to callers who can see every project.' };
  if (emptyScope) return { value: null, source, unavailableReason: emptyScope };
  const findings = checkAllowances(s.capacity.quotas);
  if (findings === null) {
    const gap = capabilityGap(s, 'quotas.allowances.tenant');
    return { value: null, source, unavailableReason: `No tenant quota allowances read, so project caps cannot be compared${gap ? `: ${gap}` : ''}.` };
  }
  const placeholders = s.capacity.quotas.filter(q => q.allocation === 'inherits-tenant').length;
  return {
    value: findings, source,
    ...readTime(s, ['quotas.allowances', TENANT_QUOTAS], `Project allowances with a limit of their own, compared with the tenant limit of the same quota and region. A project placeholder (no limit of its own) uses the tenant quota and is not a cap${placeholders ? ` (${placeholders} here)` : ''}. Read-only: change a cap in the console or with scripts/quota-plan.py.`),
  };
}

/**
 * The region a live root is checked in: the one its runs target (F1.38). Where the root runs (its resources'
 * nip-region label or region), else the regions of its run profiles (platform/profiles/<stack>/*.json for its stage).
 * Otherwise the region is unknown, whatever the filter: the root is not checked, never against a fallback region or
 * the filter's region. The global filter only narrows: a root running, or profiled, outside the filter's regions
 * (or of another stage) is out of scope ([]), so narrowing the scope never adds a blocked root.
 */
export function liveRootRegions(
  root: Pick<RepoModel['liveRoots'][number], 'stage' | 'stack' | 'runRegions'>,
  all: ObservedResource[],
  f: Pick<ResourceFilter, 'project' | 'region' | 'stage'> = {},
): { region: string; basis: 'observed' | 'profile' }[] | 'unknown' {
  if (f.stage && root.stage !== f.stage) return [];
  const mine = all.filter(r => r.type !== 'project' && r.labels['nip-stage'] === root.stage && (r.labels['nip-stack'] ?? r.labels['nip-env']) === root.stack);
  const scopeRegions = filterRegions(all, f);
  const inFilter = (region: string) => !scopeRegions || scopeRegions.includes(region);
  if (mine.length) {
    const where = mine.filter(r => !f.project || r.projectId === f.project);
    const regions = [...new Set(where.map(r => r.labels['nip-region'] ?? r.region).filter((x): x is string => !!x))].sort();
    return regions.filter(inFilter).map(region => ({ region, basis: 'observed' as const }));
  }
  if (!root.runRegions?.length) return 'unknown';
  return [...new Set(root.runRegions)].sort().filter(inFilter).map(region => ({ region, basis: 'profile' as const }));
}

/** The regions the global filter selects: the region, or the filtered project's regions; undefined without one. */
function filterRegions(all: ObservedResource[], f: Pick<ResourceFilter, 'project' | 'region'>): string[] | undefined {
  if (f.region) return [f.region];
  if (!f.project) return undefined;
  return [...new Set(all.filter(r => r.type === 'project' && r.providerId === f.project).map(r => r.region).filter((x): x is string => !!x))].sort();
}

/**
 * Planned resources blocked by quota: each live root's sizing against the tenant allowances of the region its runs
 * target (checkPlannedFootprint, the same check as the footprint calculator), within the global filter.
 * `all`: the caller's unfiltered resources, to find where a root runs.
 */
export function plannedQuotaIssues(
  s: ScopedSnapshot,
  repo: RepoModel,
  f: Pick<ResourceFilter, 'project' | 'region' | 'stage'> = {},
  all: ObservedResource[] = s.resources,
  allQuotas?: QuotaAllowanceView[],
  emptyScope?: string,
): OverviewResponse['plannedQuotaIssues'] {
  const source = 'Live sizing files × tenant quota allowances';
  // The filter selects nothing (G2.10): say so, never "no tenant allowance listed".
  if (emptyScope) return { value: null, source, unavailableReason: emptyScope };
  // A stage filter narrows the tenant list to the regions the stage runs in, but its planned roots may target
  // another region (a run profile): those are checked against the caller's whole tenant list (G1.2).
  const tenant = tenantAllowances(f.stage && allQuotas ? allQuotas : s.capacity.quotas);
  if (!tenant.length && s.unrestricted && (f.region || f.project) && s.capabilities.find(c => c.id === 'quotas.allowances.tenant')?.state === 'ok') {
    // The tenant list answered; the filtered region simply has no allowance rows.
    const regions = filterRegions(all, f) ?? [];
    return { value: null, source, unavailableReason: `No tenant quota allowance listed for ${regions.join(', ') || 'the filtered project\'s region'}` };
  }
  if (!tenant.length) {
    return { value: null, source, unavailableReason: s.unrestricted ? `No tenant quota allowances read${capabilityGap(s, 'quotas.allowances.tenant') ? `: ${capabilityGap(s, 'quotas.allowances.tenant')}` : ''}` : 'Tenant-level data is shown to callers who can see every project.' };
  }
  const issues: PlannedQuotaIssue[] = [];
  const checked: string[] = [];
  const unknown: string[] = [];
  const byId = new Map(all.map(r => [r.providerId, r]));
  for (const root of repo.liveRoots) {
    if (root.stack !== 'inference' && root.stack !== 'training' && root.stack !== 'gpu-vm') continue;
    const name = root.path.replace(/^terraform\/live\//, '');
    const targets = liveRootRegions(root, all, f);
    if (targets === 'unknown') {
      unknown.push(name);
      continue;
    }
    const check = (lines: ReturnType<typeof checkQuotas>['lines'], region: string, basis: 'observed' | 'profile', profile?: string) => {
      for (const l of lines) {
        if (l.state === 'ok') continue;
        const usage = tenant.find(q => q.name === l.quota && (q.region === region || !q.region))?.usage ?? l.usage;
        issues.push({ plan: root.path, region, regionBasis: basis, ...(profile ? { profile } : {}), quota: l.quota, description: tenant.find(q => q.name === l.quota)?.description, need: l.need, limit: l.limit, usage, state: l.state, what: l.what });
      }
    };
    for (const { region, basis } of targets) {
      const fctx = { regions: repo.regions, region };
      if (basis === 'observed') {
        // Applied (G2.2): what runs is checked, not the sizing file (a run planned with a profile differs from it).
        // Its own use is already in the usage figures, so each need is compared with the limit alone.
        const seen = observedFootprint(root, region, all, byId);
        checked.push(`${name} (${region}, as observed: ${seen.groups.map(g => `${g.count} × ${g.preset}`).join(', ') || 'no node group or VM yet'})`);
        const limitsOnly = tenant.filter((q): q is typeof q & { limit: number } => q.limit !== null && (q.region === region || !q.region)).map(q => ({ ...q, usage: 0 }));
        check(checkQuotas(seen.fp, region, limitsOnly, { capacityType: seen.capacityType, gpuCluster: root.stack === 'training' }).lines, region, basis);
        continue;
      }
      // Not applied: each run profile for this region sizes the check (its vars over the sizing file, as
      // `make plan PROFILE=<name>` renders them); the sizing file alone when no profile names this region.
      const profiles = (root.runProfiles ?? []).filter(p => p.region === region);
      for (const p of profiles.length ? profiles : [undefined]) {
        const sizing = runProfileSizing(root.sizing, p);
        const fp = plannedFootprint(root.stack, sizing, fctx);
        checked.push(`${name} (${region}${p ? `, profile ${p.name}` : ''})`);
        if (fp) check(checkPlannedFootprint(fp, root.stack, sizing, region, tenant).lines, region, basis, p?.name);
      }
    }
  }
  return {
    value: issues, source,
    ...readTime(s, ['quotas.allowances', TENANT_QUOTAS], `Each live root against the tenant allowances of the region its runs target: an applied root by its node groups as observed, otherwise its run profile's sizing (platform/profiles), else its sizing file; the filter only narrows. Checked: ${checked.join(', ') || 'none in this filter'}.${unknown.length ? ` Region unknown (not applied, no run profile), not checked: ${unknown.join(', ')}.` : ''} Blocked: the limit is 0; request quota in the console (Administration → Limits → Quotas).`),
  };
}

/**
 * What an applied live root runs in a region, as the inventory sees it: its node groups (own or inherited nip-stage
 * and nip-stack, from the cluster) and its standalone VMs. Counts are the fixed node count, else the autoscaling
 * maximum. The GPU capacity type is preemptible or reserved only when every GPU group is.
 */
function observedFootprint(root: Pick<LiveRoot, 'stage' | 'stack'>, region: string, all: ObservedResource[], byId: Map<string, ObservedResource>) {
  const ours = (r: ObservedResource) => {
    const a = attributeWithParents(r, byId);
    return (r.labels['nip-stage'] ?? a.stage) === root.stage && (r.labels['nip-stack'] ?? r.labels['nip-env'] ?? a.stack) === root.stack && (r.labels['nip-region'] ?? r.region) === region;
  };
  const units = all.filter(r => (r.type === 'mk8s-node-group' || (r.type === 'compute-instance' && !r.refs.some(x => x.relation === 'member-of'))) && r.spec.preset && r.status !== 'deleting' && ours(r));
  const groups: Footprint['nodeGroups'] = units.map(r => {
    const gpus = r.spec.gpus ?? parsePreset(r.spec.preset!)?.gpus ?? 0;
    const count = r.type === 'compute-instance' ? 1 : r.spec.fixedNodeCount ?? r.spec.autoscaling?.max ?? 0;
    return { name: r.name, role: gpus > 0 ? 'gpu' : 'system', platform: r.spec.platform ?? '', preset: r.spec.preset!, count, bootDiskGib: 0 };
  });
  const gpuTypes = new Set(units.filter(r => (r.spec.gpus ?? parsePreset(r.spec.preset!)?.gpus ?? 0) > 0).map(r => r.spec.capacityType ?? 'on-demand'));
  const only = gpuTypes.size === 1 ? [...gpuTypes][0] : undefined;
  const capacityType: 'on-demand' | 'preemptible' | 'reserved' = only === 'preemptible' || only === 'reserved' ? only : 'on-demand';
  const fp: Footprint = { nodeGroups: groups, filesystemGib: 0, extraSsdGib: 0, ioM3Gib: 0, objectStorageGib: 0, publicIps: 0 };
  return { fp, groups, capacityType };
}

/** A previewed footprint against the tenant allowances of its region. */
export function quotaCheckFor(
  quotas: QuotaAllowanceView[],
  fp: Footprint,
  region: string,
  capacityType?: 'on-demand' | 'preemptible' | 'reserved',
  gpuCluster?: boolean,
  capabilities: (Pick<CapabilityStatus, 'id' | 'state' | 'hint'> & Partial<Pick<CapabilityStatus, 'lastSuccess' | 'stale'>>)[] = [],
  /** Managed Kubernetes clusters the request creates (its QuotaNeeds), checked against mk8s.cluster.count (G5.3). */
  mk8sClusters = 0,
): QuotaCheck {
  const tenant = tenantAllowances(quotas);
  const opts = { capacityType, gpuCluster, mk8sClusters };
  const { lines, unchecked } = checkQuotas(fp, region, tenant, opts);
  const read = capabilities.find(c => c.id === TENANT_QUOTAS);
  if (!tenant.length) {
    const gap = tenantAllowancesGap(read);
    return { region, source: 'none', lines: [], unchecked: quotaRequirements(fp, opts), reason: `No tenant quota allowances were read (${gap}); quotas not checked.` };
  }
  // The card is as old as the tenant list's own last read (#13), not the snapshot.
  const stamp = read?.lastSuccess
    ? { observedAt: read.lastSuccess, ...(read.stale || read.state !== 'ok' ? { note: `The tenant allowances: the latest read failed; these figures are from ${fmtUtc(read.lastSuccess)}.` } : {}) }
    : {};
  return { region, source: 'tenant', lines: lines.map(l => ({ ...l, description: tenant.find(q => q.name === l.quota)?.description })), unchecked, ...stamp };
}

/** The capacity advisor's view of a previewed request's GPU nodes (undefined when it has none). */
export function availabilityFor(
  advice: ResourceAdviceView[],
  fp: Footprint,
  input: Pick<ProvisioningRequestInput, 'region' | 'capacityType'> & Partial<Pick<ProvisioningRequestInput, 'fabric'>>,
  repo: Pick<RepoModel, 'regions'>,
  /** The sync's capability records: an advisor that was not read is "availability unknown", never "fits" (W1-P4). */
  capabilities?: Pick<CapabilityStatus, 'id' | 'state'>[],
): AvailabilityCheck | undefined {
  const g = fp.nodeGroups.find(x => x.role !== 'system' && x.count > 0 && /gpu-/.test(x.preset));
  if (!g) return undefined;
  // The fabric the request names (W1-P4), else the platform's default in platform/regions.yaml.
  const fabric = input.fabric || repo.regions.regions[input.region]?.platforms[g.platform]?.fabric;
  const want = { region: input.region, platform: g.platform, preset: g.preset, fabric: /^8gpu/.test(g.preset) ? fabric : undefined, capacityType: input.capacityType, requested: g.count };
  const read = capabilities?.find(c => c.id === 'capacity.resource-advice');
  if (capabilities && read?.state !== 'ok' && !advice.length && input.capacityType !== 'reserved') {
    return {
      ...want, alternatives: [], state: 'unknown',
      message: `Availability unknown: the capacity advisor was not read (${read ? read.state.replace(/-/g, ' ') : 'no sync yet'}); nothing here says the ${g.count} × ${g.preset} fit${g.count === 1 ? 's' : ''}.`,
    };
  }
  return checkAvailability(advice, want);
}

/**
 * Live checks a previewed request carries: quota (tenant allowances), the capacity advisor and, for reserved
 * capacity, the tenant's capacity block groups. A quota that stops the plan is an error that disables Prepare, as
 * `make preflight` fails it, unless the request says a quota request is pending (W1-P3); a STRICT reservation with no
 * matching block group is an error (W1-P4); the rest are warnings.
 */
export function liveIssues(
  quota: QuotaCheck | undefined,
  availability: AvailabilityCheck | undefined,
  input: Partial<ProvisioningRequestInput> = {},
  reservations?: ReservationCheck,
): PolicyIssue[] {
  const out: PolicyIssue[] = [];
  for (const l of quota?.lines ?? []) {
    if (l.state === 'ok') continue;
    const a = (n: number) => quotaLineAmount(l.quota, n);
    const head = `${l.description ?? l.quota} (${l.quota}): ${l.state === 'blocked' ? 'limit 0' : `${a(l.usage)} used of ${a(l.limit)}`}, needs ${a(l.need)}; short by ${a(l.short)}.`;
    out.push(
      input.quotaRequestPending
        ? { field: 'quota', severity: 'warning', source: `quotas.v1 tenant allowances (${quota!.region})`, message: `${head} Prepared with "Prepare anyway: quota request pending": the quota must be granted (Administration → Limits → Quotas) before the first apply.` }
        : { field: 'quota', severity: 'error', source: `quotas.v1 tenant allowances (${quota!.region}); scripts/preflight.py fails it`, message: `${head} The plan would stop here: request quota in the console (Administration → Limits → Quotas), switch to a region where it fits, or tick "Prepare anyway: quota request pending".` },
    );
  }
  if (reservations) {
    const source = 'capacity.v1 capacity block groups (tenant)';
    if (reservations.state === 'none') out.push({ field: 'reservationPolicy', severity: reservations.policy === 'STRICT' ? 'error' : 'warning', source, message: reservations.message });
    else if (reservations.state === 'unknown') out.push({ field: 'reservationPolicy', severity: 'warning', source, message: reservations.message });
    else out.push({ field: 'reservationPolicy', severity: 'info', source, message: reservations.message });
  }
  if (availability?.state === 'unknown') {
    out.push({ field: 'gpuNodeCount', severity: 'warning', source: 'capacity.v1 resource advice (tenant)', message: availability.message });
  }
  if (availability && (availability.state === 'short' || availability.state === 'limit-reached')) {
    const alt = availability.alternatives.map(a => `${a.region}${a.fabric ? ` ${a.fabric}` : ''} ${a.capacityType} (${a.level}, ${a.available} available)`).join('; ');
    out.push({ field: 'gpuNodeCount', severity: 'warning', source: 'capacity.v1 resource advice (tenant)', message: `${availability.message}${alt ? ` Room now: ${alt}.` : ''} Advice changes minute to minute and is not a reservation.` });
  }
  return out;
}

/**
 * When the data of these lists was read: the oldest last success among them (a card is as old as its oldest part),
 * not the snapshot time (followup 13). A list whose latest attempt failed says its data is from its last success.
 * Before any capability record (no sync yet) the snapshot time stands.
 */
export function readTime(s: Pick<ScopedSnapshot, 'capabilities' | 'observedAt'>, ids: string[], note?: string): { observedAt?: string; note?: string } {
  const caps = ids.map(id => (s.capabilities ?? []).find(c => c.id === id)).filter((c): c is CapabilityStatus => Boolean(c));
  if (!caps.length) return { observedAt: s.observedAt, note };
  const times = caps.map(c => c.lastSuccess).filter((t): t is string => Boolean(t)).sort();
  const stale = caps.filter(c => c.stale && c.lastSuccess);
  const staleNote = stale.length ? `${stale.map(c => `${c.title}: the latest read failed; last read ${fmtUtc(c.lastSuccess)}`).join('; ')}.` : undefined;
  return { observedAt: times[0], note: [note, staleNote].filter(Boolean).join(' ') || undefined };
}

export function capacity(
  s: ScopedSnapshot,
  telemetryAllowed: boolean,
  ctx?: {
    repo: RepoModel;
    filter?: Pick<ResourceFilter, 'project' | 'region' | 'stage'>;
    all?: ObservedResource[];
    /** The caller's quota allowances before the filter (the planned check under a stage filter). */
    allQuotas?: QuotaAllowanceView[];
    /** The caller's block groups before the region filter. */
    allBlockGroups?: CapacityBlockGroupView[];
    /** The global filter selects no project (emptyScopeReason): said once, instead of per card (G2.10). */
    emptyScope?: string;
  },
): CapacityResponse {
  const shownGroups = new Set(s.capacity.capacityBlockGroups.map(g => g.id));
  const outside =
    s.unrestricted && ctx?.filter?.region && ctx.allBlockGroups
      ? ctx.allBlockGroups.filter(g => !shownGroups.has(g.id)).map(g => ({ id: g.id, name: g.name, ...(g.region ? { region: g.region } : {}) }))
      : undefined;
  const clusters = new Map(s.resources.filter(r => r.type === 'mk8s-cluster').map(r => [r.providerId, r]));
  const members = new Map<string, number>();
  for (const r of s.resources) {
    if (r.type !== 'compute-instance' || r.status !== 'running') continue;
    const ng = r.refs.find(x => x.relation === 'member-of')?.target;
    if (ng) members.set(ng, (members.get(ng) ?? 0) + 1);
  }
  // GPU series join to node groups by their mk8s_node_group_id label, or through the VM's membership.
  const groupOfVm = new Map(s.resources.filter(r => r.type === 'compute-instance').flatMap(r => {
    const ng = r.refs.find(x => x.relation === 'member-of')?.target;
    return ng ? [[r.providerId, ng] as const] : [];
  }));
  const utilByGroup = new Map<string, number[]>();
  for (const g of telemetryAllowed ? namedGpus(s) : []) {
    const ng = g.mk8sNodeGroupId ?? (g.instanceId ? groupOfVm.get(g.instanceId) : undefined);
    if (ng && g.utilPercent !== undefined) utilByGroup.set(ng, [...(utilByGroup.get(ng) ?? []), g.utilPercent]);
  }
  const groupUtil = new Map([...utilByGroup.entries()].map(([ng, xs]) => [ng, { meanPercent: meanUtilisation(xs)!, gpusReporting: xs.length }]));
  const nodeGroups: NodeGroupCapacity[] = s.resources
    .filter(r => r.type === 'mk8s-node-group')
    .map(r => {
      const clusterId = r.refs.find(x => x.relation === 'parent')?.target;
      return {
        uid: r.uid,
        cluster: (clusterId && clusters.get(clusterId)?.name) ?? clusterId ?? 'unknown',
        name: r.name,
        platform: r.spec.platform,
        preset: r.spec.preset,
        gpusPerNode: r.spec.gpus ?? 0,
        nodes: members.get(r.providerId) ?? 0,
        fixedNodeCount: r.spec.fixedNodeCount,
        autoscaling: r.spec.autoscaling,
        capacityType: r.spec.capacityType ?? 'unknown',
        fabric: r.spec.fabric,
        projectId: r.projectId,
        region: r.region,
        gpuUtil: groupUtil.get(r.providerId),
      };
    });
  const inGroups = new Set(s.resources.filter(r => r.refs.some(x => x.relation === 'member-of')).map(r => r.providerId));
  const standaloneGpuVms = s.resources
    .filter(r => r.type === 'compute-instance' && (r.spec.gpus ?? 0) > 0 && !inGroups.has(r.providerId))
    .map(r => ({ uid: r.uid, name: r.name, platform: r.spec.platform, preset: r.spec.preset, gpus: r.spec.gpus ?? 0, capacityType: r.spec.capacityType ?? 'unknown', status: r.status }));
  const util = utilisation(s);
  const kubeSource = 'Kubernetes API';
  const cap = <T>(id: string, value: T[], source: string, note?: string, also: string[] = []) =>
    capabilityOk(s, id) || value.length ? { value, source, ...readTime(s, [id, ...also], note) } : { value: null, source, unavailableReason: capabilityGap(s, id) };
  const gpus = nodeGroups.reduce((a, g) => a + g.gpusPerNode * g.nodes, 0) + standaloneGpuVms.reduce((a, v) => a + (v.status === 'running' ? v.gpus : 0), 0); // running only, as the Overview (G2.7)
  return {
    gpusPresent: s.resources.length
      ? { value: gpus, unit: 'GPUs', source: 'Nebius inventory', observedAt: s.observedAt, note: 'Running node-group members and standalone GPU VMs, from presets.' }
      : { value: null, source: 'Nebius inventory', unavailableReason: `No inventory snapshot${inventoryGap(s)}` },
    nodeGroups,
    ...optional('nodeGroupsObservedAt', readTime(s, ['mk8s.clusters', NODE_GROUPS.id]).observedAt),
    standaloneGpuVms,
    requests: kubeMetric(s, kubeSource, c => {
      const k = k8sGpuTotals(c);
      return { requestedGpus: k.requested, pendingGpuPods: k.pending };
    }),
    utilization: !telemetryAllowed
      ? { value: null, source: 'GPU telemetry', unavailableReason: 'You do not have nebius.telemetry.read.' }
      : util.samples.length
        ? { value: { meanPercent: meanUtilisation(util.samples.map(x => x.percent))!, perNode: util.samples.map(x => ({ node: x.node, percent: x.percent })) }, source: util.source, observedAt: util.observedAt, note: latestUtilisationNote(util.samples.length) }
        : s.monitoring && s.resources.length && gpus === 0
          ? // The same words as the Overview: nothing runs, so there is nothing to measure (not "unavailable").
            { value: null, source: 'GPU telemetry', empty: 'No GPUs running', unavailableReason: 'No running GPU VM in scope, so there is nothing to measure.', ...listReadAt(s, 'compute.instances') }
          : { value: null, source: 'GPU telemetry', unavailableReason: util.reason },
    gpuTelemetry: gpuTelemetry(s, telemetryAllowed),
    quotas: cap('quotas.allowances', s.capacity.quotas, 'Quota allowances (quotas.v1)', 'A quota is a ceiling, never a guarantee of physical capacity.', s.capacity.quotas.some(q => q.scope === 'tenant') ? [TENANT_QUOTAS] : []),
    capacityAllowances: cap('capacity.allowances', s.capacity.capacityAllowances, 'Capacity allowances (capacity.v1)'),
    capacityBlockGroups: s.unrestricted
      ? cap('capacity.block-groups', s.capacity.capacityBlockGroups, 'Capacity block groups (capacity.v1, tenant)')
      : { value: null, source: 'Capacity block groups (capacity.v1, tenant)', unavailableReason: TENANT_ONLY },
    resourceAdvice: s.unrestricted
      ? cap('capacity.resource-advice', s.capacity.resourceAdvice, 'Capacity advice (capacity.v1, tenant)', 'Availability advice, not a reservation or guarantee.')
      : { value: null, source: 'Capacity advice (capacity.v1, tenant)', unavailableReason: TENANT_ONLY },
    platforms: cap('compute.platforms', s.capacity.platforms, 'Platforms (compute.v1)'),
    ...(outside ? { blockGroupsOutsideFilter: outside } : {}),
    plannedQuotaIssues: ctx ? plannedQuotaIssues(s, ctx.repo, ctx.filter, ctx.all, ctx.allQuotas, ctx.emptyScope) : undefined,
    allowanceCheck: allowanceCheck(s, ctx?.emptyScope),
    ...(ctx?.emptyScope ? { emptyScope: ctx.emptyScope } : {}),
    maintenances: maintenanceMetric(s),
    ...(!s.capacity.quotas.some(q => q.scope === 'tenant') ? { tenantQuotasGap: tenantGap(s) } : {}),
  };
}

/** Soperator clusters in scope (followup 18): by the nip-stack label, by name, or by a soperator namespace. */
function soperatorClusterRefs(s: Pick<ScopedSnapshot, 'resources' | 'kube'>): { id?: string; name: string }[] {
  const out: { id?: string; name: string }[] = [];
  for (const r of s.resources) {
    if (r.type === 'mk8s-cluster' && (attribute(r).stack === 'soperator' || /soperator/i.test(r.name))) out.push({ id: r.providerId, name: r.name });
  }
  for (const c of s.kube) if (c.namespaces.some(ns => /^soperator/.test(ns))) out.push({ id: c.mk8sClusterId, name: c.name });
  return out;
}

function soperatorClusters(s: Pick<ScopedSnapshot, 'resources' | 'kube'>): string[] {
  return [...new Set(soperatorClusterRefs(s).map(c => c.name))].sort();
}

/** The Managed Kubernetes cluster ids of the Soperator clusters in scope: the docs coverage reads Slurm through them only (W1-P26). */
export function soperatorClusterIds(s: Pick<ScopedSnapshot, 'resources' | 'kube'>): string[] {
  return [...new Set(soperatorClusterRefs(s).flatMap(c => (c.id ? [c.id] : [])))].sort();
}

export function workloads(s: ScopedSnapshot): WorkloadsResponse {
  const clustersReadAt = (s.capabilities ?? []).some(c => c.id === 'mk8s.clusters') ? readTime(s, ['mk8s.clusters']).observedAt : s.inventoryReadAt ?? s.observedAt;
  const out: WorkloadSummary[] = [];
  for (const c of s.kube) {
    for (const w of c.workloads) {
      out.push({
        cluster: c.name,
        namespace: w.namespace,
        name: w.name,
        kind: w.kind,
        replicas: w.replicas,
        readyReplicas: w.readyReplicas,
        gpuRequest: gpuQuantity(w.requests['nvidia.com/gpu']),
        requests: w.requests,
        limits: w.limits,
        pendingPods: w.pods.filter(p => p.phase === 'Pending').length,
        schedulingMessages: [...new Set(w.pods.map(p => p.message).filter((m): m is string => Boolean(m)))],
        restarts: w.pods.reduce((n, p) => n + (p.restarts ?? 0), 0),
        podIssues: [...new Set(w.pods.flatMap(p => p.waiting ?? []))],
        ...(w.job ? { job: w.job } : {}),
        nodeSelector: w.nodeSelector,
        tolerations: w.tolerations,
        recipe: w.recipe,
        uid: `k8s:${c.name}:${w.kind}:${w.namespace}/${w.name}`,
      });
    }
  }
  return {
    clusters: s.kube.map(c => {
      const staleReason = kubeStaleReason(c, s.resources);
      const error = staleReason ? `${staleReason}. Showing the last successful snapshot (stale).` : c.error ?? (c.stale ? 'Showing the last successful snapshot (stale).' : undefined);
      return {
        name: c.name,
        configured: true,
        dashboardUrl: c.dashboardUrl ?? undefined,
        observedAt: c.observedAt,
        error,
        ...(staleReason ? { staleReason } : {}),
        namespaces: c.namespaces,
        nodes: c.nodes.map(n => ({
          name: n.name,
          ...(n.nodeGroupId ? { nodeGroupId: n.nodeGroupId } : {}),
          gpus: gpuQuantity(n.allocatable['nvidia.com/gpu']),
          ...(n.ready !== undefined ? { ready: n.ready } : {}),
          cordoned: n.cordoned ?? false,
          deleting: n.deleting ?? false,
        })),
      };
    }),
    workloads: out,
    soperatorClusters: soperatorClusters(s),
    // As of the cluster list's own last read (followup 53); before any capability record, the last inventory read.
    ...(clustersReadAt ? { inventoryObservedAt: clustersReadAt } : {}),
    events: s.kube.flatMap(c => c.events.map(e => ({ cluster: c.name, ...e }))),
    slurm: { available: false, reason: 'No supported Slurm connector is implemented; Kubernetes objects alone do not expose Slurm queue or accounting state. Use sinfo / squeue / sacct on the login node (runbooks/soperator-jobs.md).' },
  };
}
