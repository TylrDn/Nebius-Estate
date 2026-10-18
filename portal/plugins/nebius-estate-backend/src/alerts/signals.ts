import { ALLOWANCE_VERDICT, attributeWithParents, CapabilityStatus, checkAllowances, checkQuotas, cutsProject, fmtQuotaAmount, fmtUtc, Footprint, lifecycleLabel, ObservedResource, SignalSeries, tenantAllowances, tenantAllowancesGap } from '@internal/nebius-domain';
import { EstateSnapshot, gpuQuantity } from '../inventory/types';

/**
 * Portal signals: what only the portal can see, as instant-vector series named `nebius_estate_*`
 * for the rules in platform/alerts/portal/. Computed from the inventory snapshot after each sync.
 * Every series carries its project (for scoping), the resource it is about and a line of evidence.
 */
export const SIGNALS = {
  quotaBlocked: 'nebius_estate_node_group_quota_blocked',
  connectorFailing: 'nebius_estate_connector_failing',
  allocatableZero: 'nebius_estate_gpu_allocatable_zero',
  maintenance: 'nebius_estate_maintenance_scheduled',
  preemptibleLost: 'nebius_estate_preemptible_node_lost',
  allowanceBelowTenant: 'nebius_estate_project_allowance_below_tenant',
  ttlExpiresSoon: 'nebius_estate_ttl_expires_hours',
} as const;

const NODE_STATES = new Set(['running', 'provisioning', 'pending']);

/**
 * Where a signal's input is missing now, so its series cannot be computed: an open alert there is unknown, not
 * resolved (F1.34: alerts resolved and re-fired with every failed read, their since-times reset). `projectId`
 * narrows it to one project; `labels` to the alerts carrying them; neither means every alert of the signal.
 */
export interface UnknownInput {
  metric: string;
  projectId?: string;
  labels?: Record<string, string>;
  reason: string;
}

const answered = (c: Pick<CapabilityStatus, 'state'> | undefined) => c?.state === 'ok' || c?.state === 'schema-drift';

/** Projects whose list `id` did not answer at the last sync (a per-project failure, or every project when not split). */
function failedProjects(snap: EstateSnapshot, id: string): { all: boolean; projects: string[] } {
  const c = snap.capabilities.find(x => x.id === id);
  if (!c || answered(c) || c.state === 'not-configured') return { all: false, projects: [] };
  const failing = (c.perProject ?? []).filter(p => !answered(p) && p.state !== 'not-configured').map(p => p.id);
  return c.perProject?.length ? { all: false, projects: failing } : { all: true, projects: [] };
}

/** Inputs of each portal signal that are missing at this evaluation (see UnknownInput). */
export function unknownInputs(snap: EstateSnapshot): UnknownInput[] {
  const out: UnknownInput[] = [];
  const perProject = (metric: string, capability: string, what: string) => {
    const f = failedProjects(snap, capability);
    if (f.all) out.push({ metric, reason: `${what} did not answer at the last sync` });
    for (const projectId of f.projects) out.push({ metric, projectId, reason: `${what} did not answer for this project at the last sync` });
  };
  // Tenant allowances: needed by both quota signals. Missing (no tenant id, refused, no answer) is unknown.
  const tenantCap = snap.capabilities.find(c => c.id === 'quotas.allowances.tenant');
  if (!tenantAllowances(snap.capacity.quotas.filter(q => q.scope === 'tenant')).length && !answered(tenantCap)) {
    const reason = `no tenant allowance read: ${tenantAllowancesGap(tenantCap)}`;
    out.push({ metric: SIGNALS.quotaBlocked, reason }, { metric: SIGNALS.allowanceBelowTenant, reason });
  }
  perProject(SIGNALS.allowanceBelowTenant, 'quotas.allowances', 'the project allowance list');
  perProject(SIGNALS.quotaBlocked, 'mk8s.node-groups', 'the node group list');
  perProject(SIGNALS.quotaBlocked, 'compute.instances', 'the VM list');
  perProject(SIGNALS.maintenance, 'maintenance.maintenances', 'the maintenance list');
  // Only a sync where every call answered can say a preemptible VM is gone.
  const inventory = snap.statuses.find(s => s.id === 'nebius-inventory')?.state;
  if (inventory !== undefined && inventory !== 'ok' && inventory !== 'permission-denied') out.push({ metric: SIGNALS.preemptibleLost, reason: `the inventory sync is ${inventory.replace(/-/g, ' ')}` });
  // A cluster that was not read now says nothing about its nodes' allocatable GPUs.
  for (const c of snap.kube.filter(k => k.stale || k.error)) out.push({ metric: SIGNALS.allocatableZero, labels: { cluster: c.mk8sClusterId ?? c.name }, reason: `cluster ${c.name} was not read at the last sync` });
  return out;
}

/** A preemptible VM with where it ran and its effective TTL, as seen at one evaluation. */
interface Placement {
  vm: ObservedResource;
  nodeGroup?: string;
  cluster?: string;
  ttlExpires?: string;
}

export class SignalBuilder {
  /** Preemptible VMs running at the previous evaluation, with their node group, cluster and effective TTL then (in memory: a restart never invents a loss). */
  private preemptible = new Map<string, Placement>();
  private primed = false;

  signals(snap: EstateSnapshot, now: Date): SignalSeries[] {
    return [...quotaBlocked(snap), ...allowanceBelowTenant(snap), ...connectorFailing(snap), ...allocatableZero(snap), ...maintenance(snap, now), ...this.preemptibleLost(snap, now), ...ttlExpiresSoon(snap, now)];
  }

  /**
   * A preemptible VM that ran at the last evaluation and is now gone or stopped (Nebius stops preempted VMs). Not a
   * loss when it went on purpose: its node group or cluster is deleting or gone with it, or its effective TTL passed.
   */
  private preemptibleLost(snap: EstateSnapshot, now: Date): SignalSeries[] {
    const inventoryOk = snap.statuses.find(s => s.id === 'nebius-inventory')?.state;
    const vms = snap.resources.filter(r => r.type === 'compute-instance' && r.spec.capacityType === 'preemptible');
    const out: SignalSeries[] = [];
    // A failed inventory sync keeps its last items; only a successful one can say a VM is gone.
    if (inventoryOk !== 'ok' && inventoryOk !== 'permission-denied') return out;
    const byId = new Map(snap.resources.map(r => [r.providerId, r]));
    const placement = (v: ObservedResource): Placement => {
      const nodeGroup = v.refs.find(x => x.relation === 'member-of')?.target;
      const cluster = nodeGroup ? byId.get(nodeGroup)?.refs.find(x => x.relation === 'parent')?.target : undefined;
      // Node VMs carry the mk8s labels; without them, the TTL of the node group or cluster it is a member of.
      const ttlExpires = [v, nodeGroup && byId.get(nodeGroup), cluster && byId.get(cluster)].map(x => (x ? attributeWithParents(x, byId).ttlExpires : undefined)).find(Boolean);
      return { vm: v, nodeGroup, cluster, ttlExpires };
    };
    const current = new Map(vms.map(v => [v.providerId, v]));
    const onPurpose = (p: Placement) => {
      if (p.ttlExpires && Date.parse(p.ttlExpires) <= now.getTime()) return true;
      const gone = (id: string | undefined) => id !== undefined && (!byId.has(id) || byId.get(id)!.status === 'deleting');
      return gone(p.nodeGroup) || gone(p.cluster);
    };
    const lost = (v: ObservedResource, how: string) => {
      const ng = v.refs.find(x => x.relation === 'member-of')?.target;
      out.push({
        metric: SIGNALS.preemptibleLost,
        labels: { project: v.projectId ?? '', instance_id: v.providerId, name: v.name, ...(ng ? { node_group: ng } : {}) },
        value: 1,
        valueKind: { unit: 'VM', meaning: 'lost' },
        projectId: v.projectId,
        resourceUid: current.has(v.providerId) ? v.uid : undefined,
        evidence: `${v.name} (${v.spec.platform ?? 'VM'} ${v.spec.preset ?? ''}, preemptible) ${how}.`,
      });
    };
    if (this.primed) {
      for (const [id, p] of this.preemptible) {
        if (!current.has(id) && !onPurpose(p)) lost(p.vm, 'was running at the last sync and is gone now');
      }
    }
    for (const v of vms) if (v.status === 'stopped' && !onPurpose(placement(v))) lost(v, 'is stopped (Nebius stops a preempted VM; it does not restart by itself)');
    this.preemptible = new Map(vms.filter(v => NODE_STATES.has(v.status)).map(v => [v.providerId, placement(v)]));
    this.primed = true;
    return out;
  }
}

/** A node group with fewer nodes than it asks for, whose missing nodes the tenant quota of its region cannot hold. */
export function quotaBlocked(snap: EstateSnapshot): SignalSeries[] {
  const tenant = tenantAllowances(snap.capacity.quotas.filter(q => q.scope === 'tenant'));
  if (!tenant.length) return [];
  const byId = new Map(snap.resources.map(r => [r.providerId, r]));
  const out: SignalSeries[] = [];
  for (const ng of snap.resources.filter(r => r.type === 'mk8s-node-group')) {
    const desired = ng.spec.fixedNodeCount ?? ng.spec.autoscaling?.min ?? 0;
    if (!desired || !ng.spec.platform || !ng.spec.preset) continue;
    const nodes = snap.resources.filter(r => r.type === 'compute-instance' && NODE_STATES.has(r.status) && r.refs.some(x => (x.relation === 'member-of' || x.relation === 'managed-by') && x.target === ng.providerId)).length;
    const missing = desired - nodes;
    if (missing <= 0) continue;
    const region = ng.region ?? byId.get(ng.projectId ?? '')?.region;
    if (!region) continue;
    const gpus = /^(\d+)gpu-/.exec(ng.spec.preset)?.[1];
    const fp: Footprint = {
      nodeGroups: [{ name: ng.name.slice(0, 60), role: gpus ? 'gpu' : 'system', platform: ng.spec.platform, preset: ng.spec.preset, count: missing, bootDiskGib: 0 }],
      filesystemGib: 0, extraSsdGib: 0, ioM3Gib: 0, objectStorageGib: 0, publicIps: 0,
    };
    const capacityType = ng.spec.capacityType === 'preemptible' ? 'preemptible' : ng.spec.capacityType === 'reserved' ? 'reserved' : 'on-demand';
    const cluster = ng.refs.find(x => x.relation === 'parent')?.target;
    for (const line of checkQuotas(fp, region, tenant.filter(q => !q.region || q.region === region), { capacityType }).lines.filter(l => l.state !== 'ok')) {
      out.push({
        metric: SIGNALS.quotaBlocked,
        labels: { project: ng.projectId ?? '', region, node_group: ng.providerId, node_group_name: ng.name, quota: line.quota, ...(cluster ? { cluster } : {}) },
        value: line.short || line.need,
        valueKind: { quota: line.quota, meaning: line.short ? 'short for the missing nodes' : 'needed by the missing nodes' },
        projectId: ng.projectId,
        resourceUid: ng.uid,
        evidence: `${ng.name}: ${nodes} of ${desired} node(s); ${line.quota} in ${region}: limit ${line.limit}, in use ${line.usage}, the missing ${missing} node(s) need ${line.need} (${line.state === 'blocked' ? 'limit 0' : `${line.short} short`}).`,
      });
    }
  }
  return out;
}

/**
 * A real project cap below the tenant limit of its quota and region, or at 0 while the tenant allows more: the
 * project gets less than it would inherit (the 2026-10-11 eu-west2 incident). The value is how much is cut
 * (tenant limit minus project cap). Caps above the tenant limit have no effect and are not signalled.
 */
export function allowanceBelowTenant(snap: EstateSnapshot): SignalSeries[] {
  return (checkAllowances(snap.capacity.quotas) ?? []).filter(cutsProject).map(f => ({
    metric: SIGNALS.allowanceBelowTenant,
    labels: { project: f.projectId, region: f.region ?? '', quota: f.name, kind: f.kind, project_limit: String(f.projectLimit), tenant_limit: String(f.tenantLimit) },
    // The title reads amounts as GPU & Capacity does (bytes as GiB / TiB); the labels keep the raw numbers.
    display: { project_limit: fmtQuotaAmount(f.projectLimit, f.unit), tenant_limit: fmtQuotaAmount(f.tenantLimit, f.unit) },
    value: f.tenantLimit - f.projectLimit,
    valueKind: { quotaUnit: f.unit ?? '', meaning: 'below the tenant limit' },
    projectId: f.projectId,
    evidence: `${f.description ?? f.name} (${f.name}) in ${f.region ?? 'no region'}: project cap ${fmtQuotaAmount(f.projectLimit, f.unit)}, tenant limit ${fmtQuotaAmount(f.tenantLimit, f.unit)}${f.unit && !/^bytes?$/i.test(f.unit) ? ` (${f.unit})` : ''}; project uses ${fmtQuotaAmount(f.usage, f.unit)}. ${ALLOWANCE_VERDICT[f.kind]}`,
  }));
}

/**
 * A connector whose last sync failed or whose data is older than its freshness bound. Optional and unset connectors
 * never count, nor the connector of a discovered cluster that is deleting or gone (it is retired, nothing to fix).
 */
export function connectorFailing(snap: EstateSnapshot): SignalSeries[] {
  const byId = new Map(snap.resources.map(r => [r.providerId, r]));
  const retired = (id: string) => {
    if (!id.startsWith('mk8s:')) return false;
    const c = byId.get(id.slice('mk8s:'.length));
    return c ? c.status === 'deleting' : snap.resources.length > 0;
  };
  return snap.statuses
    .filter(s => (s.state === 'error' || s.state === 'stale') && !retired(s.id))
    .map(s => ({
      metric: SIGNALS.connectorFailing,
      labels: { connector: s.id, title: s.title },
      value: Math.max(1, s.health?.consecutiveFailures ?? 1),
      valueKind: { meaning: 'failed syncs in a row' },
      projectId: s.projects?.length === 1 ? s.projects[0].id : undefined,
      evidence: `${s.title}: ${s.state}${s.error ? ` — ${s.error.slice(0, 240)}` : ''}${s.lastSuccess ? ` (last success ${s.lastSuccess})` : ' (no success recorded)'}.`,
    }));
}

/** A running GPU VM that is a Kubernetes node advertising no allocatable nvidia.com/gpu. */
export function allocatableZero(snap: EstateSnapshot): SignalSeries[] {
  const byId = new Map(snap.resources.map(r => [r.providerId, r]));
  const out: SignalSeries[] = [];
  for (const c of snap.kube) {
    if (c.stale || c.error) continue;
    for (const n of c.nodes) {
      const vm = n.instanceId ? byId.get(n.instanceId) : undefined;
      if (!vm || vm.status !== 'running' || !(vm.spec.gpus ?? 0)) continue;
      if (gpuQuantity(n.allocatable['nvidia.com/gpu']) > 0) continue;
      out.push({
        metric: SIGNALS.allocatableZero,
        labels: { cluster: c.mk8sClusterId ?? c.name, node: n.name, instance_id: vm.providerId, ...(n.nodeGroupId ? { node_group: n.nodeGroupId } : {}) },
        value: vm.spec.gpus ?? 0,
        valueKind: { unit: 'GPUs', meaning: 'on the VM, none allocatable' },
        projectId: vm.projectId,
        resourceUid: vm.uid,
        evidence: `${vm.name} has ${vm.spec.gpus} GPU(s) (${vm.spec.preset ?? 'preset unknown'}); node ${n.name} advertises nvidia.com/gpu = ${n.allocatable['nvidia.com/gpu'] ?? 'absent'}.`,
      });
    }
  }
  return out;
}

/**
 * A running root near its TTL (#19): per project, stage, stack and run, the hours until the earliest nip-ttl-expires
 * (own or inherited: a node VM takes its cluster's) among its running resources, while that time is ahead. The rule
 * fires below its threshold so someone extends the TTL or saves results before the scheduled teardown
 * (runbooks/teardown.md). An expired TTL is the Overview's "TTL expired" count, not this alert.
 */
export function ttlExpiresSoon(snap: EstateSnapshot, now: Date): SignalSeries[] {
  const byId = new Map(snap.resources.map(r => [r.providerId, r]));
  const roots = new Map<string, { labels: Record<string, string>; projectId?: string; ttl: number; names: string[] }>();
  for (const r of snap.resources) {
    if (lifecycleLabel(r.type, r.status) !== 'running') continue;
    const a = attributeWithParents(r, byId);
    const ttl = a.ttlExpires ? Date.parse(a.ttlExpires) : NaN;
    if (!Number.isFinite(ttl) || ttl <= now.getTime()) continue;
    const labels = { project: r.projectId ?? '', stage: a.stage ?? '', stack: a.stack ?? '', ...(a.run ? { run: a.run } : {}) };
    const key = JSON.stringify(labels);
    const root = roots.get(key) ?? { labels, projectId: r.projectId, ttl, names: [] as string[] };
    root.ttl = Math.min(root.ttl, ttl);
    root.names.push(r.name);
    roots.set(key, root);
  }
  return [...roots.values()].map(x => {
    const hours = Math.round(((x.ttl - now.getTime()) / 3_600_000) * 10) / 10;
    const when = fmtUtc(new Date(x.ttl).toISOString())!;
    const root = `${x.labels.stage || 'no stage'}/${x.labels.stack || 'no stack'}${x.labels.run ? ` (run ${x.labels.run})` : ''}`;
    const n = x.names.length;
    return {
      metric: SIGNALS.ttlExpiresSoon,
      labels: x.labels,
      display: { ttl_expires: when, run_note: x.labels.run ? ` (run ${x.labels.run})` : '' },
      value: hours,
      valueKind: { unit: 'h', meaning: 'until its TTL' },
      projectId: x.projectId,
      evidence: `${n} running resource${n === 1 ? '' : 's'} of ${root}: nip-ttl-expires ${when}, the earliest of them: ${x.names.slice(0, 5).join(', ')}${n > 5 ? ` and ${n - 5} more` : ''}.`,
    };
  });
}

/** Maintenance not finished or cancelled; the value is hours until it starts (0 once started or when no time is given). */
export function maintenance(snap: EstateSnapshot, now: Date): SignalSeries[] {
  return snap.capacity.maintenances
    .filter(m => m.state !== 'STATE_FINISHED' && m.state !== 'STATE_CANCELLED')
    .map(m => {
      const at = m.scheduledAt ? Date.parse(m.scheduledAt) : NaN;
      const hours = Number.isFinite(at) ? Math.max(0, Math.round(((at - now.getTime()) / 3_600_000) * 10) / 10) : 0;
      return {
        metric: SIGNALS.maintenance,
        labels: { project: m.projectId, maintenance: m.id, name: m.name },
        value: hours,
        valueKind: { unit: 'h', meaning: 'until it starts' },
        projectId: m.projectId,
        evidence: `${m.name}: ${m.state ?? 'state not given'}${m.scheduledAt ? `, scheduled ${m.scheduledAt}` : ''}${m.startedAt ? `, started ${m.startedAt}` : ''}; ${m.affected.length} affected resource(s)${m.affected.length ? `: ${m.affected.slice(0, 5).join(', ')}` : ''}.`,
      };
    });
}
