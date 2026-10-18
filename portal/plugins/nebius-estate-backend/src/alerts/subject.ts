import { ActiveSeries, AlertInstance, AlertSubject, gpuName, ObservedResource, renderTemplate, tidyAlertTitle } from '@internal/nebius-domain';

/**
 * Names for what an alert is about, from the inventory at evaluation time: VM, GPU, node group, cluster and
 * project, ids kept beside them. Rule labels stay as they are (they are the alert's identity); only the title
 * and the subject are rendered with names.
 */

const shortUuid = (uuid: string) => uuid.slice(0, 12);

/** The GPU of a series' labels: its index (or 0 for the only GPU of its VM), its UUID, and the shared name (gpuName). */
export function gpuOf(labels: Record<string, string>, vm?: ObservedResource): { gpu?: string; index?: string; uuid?: string } {
  const uuid = labels.uuid ?? labels.UUID;
  const raw = labels.gpu ?? labels.gpu_index ?? labels.minor_number;
  const index = raw !== undefined && /^\d+$/.test(raw) ? raw : uuid && vm?.spec.gpus === 1 ? '0' : undefined;
  return { gpu: gpuName({ index, uuid }), index, uuid };
}

export function alertSubject(labels: Record<string, string>, byId: ReadonlyMap<string, ObservedResource>, projectId?: string): AlertSubject | undefined {
  const instanceId = labels.instance_id?.startsWith('computeinstance-') ? labels.instance_id : undefined;
  const vm = instanceId ? byId.get(instanceId) : undefined;
  const nodeGroupId = labels.node_group ?? labels.mk8s_node_group_id ?? vm?.refs.find(r => r.relation === 'member-of')?.target;
  const ng = nodeGroupId ? byId.get(nodeGroupId) : undefined;
  const clusterId = labels.mk8s_cluster_id ?? (labels.cluster?.startsWith('mk8scluster-') ? labels.cluster : undefined) ?? ng?.refs.find(r => r.relation === 'parent')?.target;
  const project = projectId ?? labels.project;
  const g = instanceId ? gpuOf(labels, vm) : {};
  const s: AlertSubject = {
    ...(instanceId ? { instanceId, instanceName: vm?.name ?? labels.name } : {}),
    ...(g.gpu ? { gpu: g.gpu } : {}),
    ...(g.uuid ? { gpuUuid: g.uuid } : {}),
    ...(nodeGroupId ? { nodeGroupId, nodeGroupName: ng?.name ?? labels.node_group_name } : {}),
    ...(clusterId ? { clusterId, clusterName: byId.get(clusterId)?.name } : {}),
    ...(project ? { projectId: project, projectName: byId.get(project)?.name } : {}),
  };
  const clean = Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined)) as AlertSubject;
  return Object.keys(clean).length ? clean : undefined;
}

/**
 * The rule summary rendered with names: the VM name for `instance_id` / `Hostname`, and the GPU index (or short
 * UUID) for `gpu` / `uuid`, so "GPU GPU-0000mock-… on computeinstance-…" reads "GPU 0 on <vm name>".
 */
export function namedSummary(summary: string, labels: Record<string, string>, value: number, subject: AlertSubject | undefined, vm?: ObservedResource): string {
  if (!subject?.instanceId) return renderTemplate(summary, labels, value);
  const g = gpuOf(labels, vm);
  const display = {
    ...labels,
    ...(subject.instanceName ? { instance_id: subject.instanceName, Hostname: '' } : {}),
    ...(g.index !== undefined ? { gpu: g.index, uuid: '' } : g.uuid ? { gpu: '', uuid: shortUuid(g.uuid) } : {}),
  };
  return renderTemplate(summary, display, value);
}

/** Adds the subject and a named title to each active series of a rule. */
export function withNames(active: ActiveSeries[], summary: string, byId: ReadonlyMap<string, ObservedResource>): ActiveSeries[] {
  return active.map(a => {
    const subject = alertSubject(a.labels, byId, a.projectId);
    const vm = subject?.instanceId ? byId.get(subject.instanceId) : undefined;
    // Display values (formatted amounts) stand in for their raw labels in the title only.
    return { ...a, subject, title: a.title ?? namedSummary(summary, a.display ? { ...a.labels, ...a.display } : a.labels, a.value, subject, vm) };
  });
}

/**
 * The title of a stored alert: its own title when it has one; for an alert stored before titles were kept, the
 * rule summary rendered with its stored subject (VM name, GPU index), else with a short GPU id. Never the full UUID.
 */
export function storedTitle(a: Pick<AlertInstance, 'title' | 'labels' | 'value' | 'subject'>, summary: string): string {
  if (a.title) return tidyAlertTitle(a.title);
  const s = a.subject;
  const uuid = a.labels.uuid ?? a.labels.UUID;
  const index = s?.gpu ? /^GPU (\d+)$/.exec(s.gpu)?.[1] : undefined;
  const display = {
    ...a.labels,
    ...(s?.instanceName ? { instance_id: s.instanceName, Hostname: '' } : {}),
    ...(index !== undefined ? { gpu: index, uuid: '', UUID: '' } : uuid ? { uuid: shortUuid(uuid), UUID: shortUuid(uuid) } : {}),
  };
  return renderTemplate(summary, display, a.value);
}
