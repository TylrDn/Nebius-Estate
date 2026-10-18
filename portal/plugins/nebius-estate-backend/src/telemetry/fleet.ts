import {
  attributeWithParents,
  bucketizeAggregates,
  bucketizeHourly,
  bucketStarts,
  Decimal,
  distinctNames,
  FleetGpuRow,
  FleetRange,
  FleetResponse,
  FleetRollup,
  GpuSeries,
  gpuName,
  IDLE_UTIL_PERCENT,
  IdleCost,
  Money,
  ObservedResource,
  RANGE_SPEC,
  rollupRows,
  ServicePanel,
} from '@internal/nebius-domain';
import { instancesListed, readTime, ScopedSnapshot } from '../views';
import { HISTORY_CONNECTOR, HISTORY_SOURCE, ServiceFigures } from './recorder';
import { SampleStore } from './SampleStore';

/** The live hourly price of one VM, or why there is none. */
export type VmPricer = (vm: ObservedResource) => Promise<{ hourly: Money | null; source?: string; reason?: string }>;

export interface FleetInput {
  store: SampleStore;
  snap: ScopedSnapshot;
  /** Projects in the caller's scope and the global project filter. */
  inScope: (projectId: string) => boolean;
  /**
   * The global region and stage filter. A GPU series follows the region and stage stored with it when it was
   * written, so a deleted VM's history stays under the filter it ran in (G2.1); never the current inventory alone.
   */
  filter?: { region?: string; stage?: string };
  range: FleetRange;
  now: Date;
  syncIntervalMinutes: number;
  monitoringConfigured: boolean;
  figures?: ServiceFigures;
  price: VmPricer;
}

const iso = (sec: number | undefined) => (sec === undefined ? undefined : new Date(sec * 1000).toISOString());

const RETENTION = '1-minute samples kept 7 days; hourly roll-ups kept 90 days (portal database).';

const VM_DELETED = 'VM no longer in the inventory (deleted)';

/** VM states whose GPUs cannot be reporting now. */
const NOT_RUNNING = new Set(['deleting', 'stopped']);

/** Nebius Monitoring publishes a minute a little late: a sample this much older than one sync interval still counts as live. */
const INGESTION_DELAY_SECONDS = 120;

/** The Fleet page: GPU × time from the sample store, roll-ups, idle-GPU cost and service panels. */
export async function fleet(i: FleetInput): Promise<FleetResponse> {
  const spec = RANGE_SPEC[i.range];
  const nowSec = Math.floor(i.now.getTime() / 1000);
  const starts = bucketStarts(i.range, nowSec);
  const from = starts[0];
  const to = starts[starts.length - 1] + spec.bucketSeconds;
  const byId = new Map(i.snap.resources.map(r => [r.providerId, r]));
  const inFilter = filterOf(i.snap.resources, byId, i.filter);
  const series = (await i.store.series()).filter(s => i.inScope(s.projectId) && inFilter.series(s));
  const keys = series.map(s => s.key);
  // Bounded reads: 7 d from the hourly roll-ups; 1 h, 6 h and 24 h downsampled in the database to one
  // row per GPU and bucket (≤ 96 per GPU), never every minute sample.
  const buckets =
    spec.source === 'hourly'
      ? groupBy(await i.store.hourly(from, to, keys), x => x.key)
      : groupBy(await i.store.bucketed(from, to, keys, spec.bucketSeconds), x => x.key);
  const newest = new Map<string, number>();
  if (spec.source === 'samples') for (const [k, xs] of buckets) newest.set(k, Math.max(...(xs as { newest: number }[]).map(x => x.newest)));

  // Running now: the VM is in the inventory and not stopped or deleting, and the GPU sampled within one sync
  // interval (plus Monitoring's ingestion delay). Newest samples come from the minute store whatever the range.
  const liveWindow = Math.round(i.syncIntervalMinutes * 60) + INGESTION_DELAY_SECONDS;
  const newestByKey = spec.source === 'samples' ? newest : new Map((await i.store.bucketed(nowSec - liveWindow, nowSec + 60, keys, liveWindow + 60)).map(a => [a.key, a.newest]));
  const synced = i.snap.resources.length > 0;
  const listed = instancesListed({ resources: i.snap.resources, capabilities: i.snap.capabilities ?? [] });
  // GPU series per VM in the store: a VM with one series has one GPU (it names "GPU 0" after the VM is gone too).
  const seriesPerVm = new Map<string, number>();
  for (const s of series) if (s.instanceId) seriesPerVm.set(s.instanceId, (seriesPerVm.get(s.instanceId) ?? 0) + 1);
  const rows: FleetGpuRow[] = [];
  for (const s of series) {
    const xs = buckets.get(s.key) ?? [];
    if (!xs.length) continue;
    const b = spec.source === 'hourly' ? bucketizeHourly(xs as any, starts) : bucketizeAggregates(xs as any, starts.length);
    if (!b.samples) continue;
    const vm = s.instanceId ? byId.get(s.instanceId) : undefined;
    const ng = s.nodeGroupId ? byId.get(s.nodeGroupId) : undefined;
    const cluster = s.clusterId ? byId.get(s.clusterId) : undefined;
    const notRunning = !synced || !s.instanceId || !listed(s.projectId)
      ? undefined
      : !vm
        ? VM_DELETED
        : vm.status === 'deleting' || vm.status === 'stopped'
          ? `VM is ${vm.status}`
          : undefined;
    const fresh = (newestByKey.get(s.key) ?? 0) >= nowSec - liveWindow;
    // A series stored before names were kept, whose resource is gone: the kind and id, never a bare id. Whether it
    // was deleted is said apart (`deleted`), the same for a resource known by name (F1.40).
    const fallback = (what: string, id: string | undefined) => (!id ? undefined : `${what[0].toUpperCase()}${what.slice(1)} ${id}`);
    const gone = (id: string | undefined) => Boolean(id && synced && listed(s.projectId) && !byId.has(id));
    const deleted = { ...(notRunning === VM_DELETED ? { vm: true as const } : {}), ...(gone(s.nodeGroupId) ? { nodeGroup: true as const } : {}), ...(gone(s.clusterId) ? { cluster: true as const } : {}) };
    rows.push({
      key: s.key,
      projectId: s.projectId,
      projectName: byId.get(s.projectId)?.name ?? s.projectName,
      instanceId: s.instanceId,
      instanceName: vm?.name ?? s.instanceName ?? (s.instanceId && s.instanceId === s.node ? fallback('VM', s.instanceId) : undefined),
      instanceUid: vm?.uid,
      node: s.node,
      gpu: s.gpu,
      gpuName: gpuName(/^\d+$/.test(s.gpu ?? '') ? { index: s.gpu } : { uuid: s.gpu }, vm?.spec.gpus ?? (s.instanceId ? seriesPerVm.get(s.instanceId) : undefined)),
      clusterId: s.clusterId,
      clusterName: cluster?.name ?? s.clusterName ?? fallback('cluster', s.clusterId),
      nodeGroupId: s.nodeGroupId,
      nodeGroupName: ng?.name ?? s.nodeGroupName ?? fallback('node group', s.nodeGroupId),
      ...(ng ? { nodeGroupUid: ng.uid } : {}),
      values: { util: b.util, temp: b.temp, power: b.power, mem: b.mem },
      lastSampleAt: newest.has(s.key) ? new Date(newest.get(s.key)! * 1000).toISOString() : undefined,
      idleMinutes: b.idleMinutes,
      samples: b.samples,
      runningNow: !notRunning && fresh,
      ...(notRunning ? { notRunning } : !fresh ? { notRunning: 'No sample in the last sync interval' } : {}),
      ...(Object.keys(deleted).length ? { deleted } : {}),
    });
  }
  rows.sort((a, b) => (a.clusterName ?? a.clusterId ?? '~').localeCompare(b.clusterName ?? b.clusterId ?? '~') || (a.nodeGroupName ?? '').localeCompare(b.nodeGroupName ?? '') || (a.instanceName ?? a.node).localeCompare(b.instanceName ?? b.node) || (a.gpu ?? '').localeCompare(b.gpu ?? ''));

  const del = (name: string, gone: boolean | undefined) => (gone ? `${name} (deleted)` : name);
  // Runs of one name (a VM or node group deleted and created again) are told apart by their last sample (W1F.N4).
  const nodeGroups: FleetRollup[] = distinctNames([...groupBy(rows, r => r.nodeGroupId ?? `standalone|${r.instanceId ?? r.node}`)].map(([id, rs]) =>
    id.startsWith('standalone|')
      ? rollupRows(rs, id, `${rs[0].instanceName ?? rs[0].node} (standalone VM${rs[0].deleted?.vm ? ', deleted' : ''})`, 'standalone')
      : rollupRows(rs, id, del(rs[0].nodeGroupName ?? id, rs[0].deleted?.nodeGroup), 'node-group'),
  ));
  const clusters: FleetRollup[] = distinctNames([...groupBy(rows.filter(r => r.clusterId), r => r.clusterId!)].map(([id, rs]) => rollupRows(rs, id, del(rs[0].clusterName ?? id, rs[0].deleted?.cluster), 'cluster')));

  // Freshness of the GPUs this scope and filter select, never of the whole store (G2.1).
  const stats = await i.store.extent(keys);
  const newestAll = rows.reduce<number | undefined>((a, r) => (r.lastSampleAt ? Math.max(a ?? 0, Date.parse(r.lastSampleAt) / 1000) : a), undefined) ?? stats.newest;
  const filtered = Boolean(i.filter?.region || i.filter?.stage);
  const filterWords = [i.filter?.region ? `region=${i.filter.region}` : '', i.filter?.stage ? `stage=${i.filter.stage}` : ''].filter(Boolean).join(' and ');
  const history = i.snap.statuses?.find(x => x.id === HISTORY_CONNECTOR)?.state;
  const failing = history === 'error' || history === 'stale' || history === 'permission-denied';
  const age = newestAll === undefined ? undefined : Math.round((nowSec - newestAll) / 60);
  // Why nothing reports is read from the inventory first (F1.35): with no GPU VM running there is nothing to sample,
  // whatever Monitoring answered; only a GPU VM that runs without samples points at Monitoring.
  const inventoryKnown = synced && i.snap.resources.some(r => r.type === 'project' && i.inScope(r.providerId) && listed(r.providerId));
  const gpuVmsRunning = i.snap.resources.filter(
    r => r.type === 'compute-instance' && (r.spec.gpus ?? 0) > 0 && !NOT_RUNNING.has(r.status) && r.projectId !== undefined && i.inScope(r.projectId) && inFilter.resource(r),
  ).length;
  const nothingRuns = inventoryKnown && gpuVmsRunning === 0;
  const freshness: FleetResponse['freshness'] = !i.monitoringConfigured
    ? { state: 'not-configured', source: HISTORY_SOURCE, reason: 'Nebius Monitoring is not configured: list projects and a read-only identity (docs/portal/nebius-setup.md#telemetry).' }
    : newestAll === undefined && filtered && (await i.store.stats()).newest !== undefined
      ? { state: 'not-reporting', source: HISTORY_SOURCE, reason: `No GPU sample is stored for ${filterWords} (7-day samples, 90-day roll-ups). Other GPUs have samples: clear the filter to see them.` }
      : newestAll === undefined
      ? { state: 'waiting', source: HISTORY_SOURCE, reason: 'No GPU samples stored yet: they appear after the first sync that finds a GPU VM reporting DCGM metrics (any project in scope).' }
      : nowSec - newestAll <= liveWindow
        ? { state: 'live', source: HISTORY_SOURCE, lastSampleAt: iso(newestAll), oldestSampleAt: iso(stats.oldest) }
        : nothingRuns
          ? { state: 'not-reporting', source: HISTORY_SOURCE, lastSampleAt: iso(newestAll), oldestSampleAt: iso(stats.oldest), reason: `No GPU VM runs now in the inventory: nothing has reported for ${age} min (the history below is kept).` }
          : failing && nowSec - newestAll > i.syncIntervalMinutes * 3 * 60
            ? {
                state: 'stale',
                source: HISTORY_SOURCE,
                lastSampleAt: iso(newestAll),
                oldestSampleAt: iso(stats.oldest),
                reason: `No new sample for ${age} min${gpuVmsRunning ? ` while ${gpuVmsRunning} GPU VM${gpuVmsRunning === 1 ? ' runs' : 's run'} in the inventory` : ''}: the last syncs could not read Nebius Monitoring (see Integrations).`,
              }
            : { state: 'not-reporting', source: HISTORY_SOURCE, lastSampleAt: iso(newestAll), oldestSampleAt: iso(stats.oldest), reason: `No GPU in scope has reported for ${age} min${gpuVmsRunning ? `, though ${gpuVmsRunning} GPU VM${gpuVmsRunning === 1 ? ' runs' : 's run'} in the inventory` : ': nothing runs now'} (the history below is kept).` };

  return {
    range: i.range,
    bucketSeconds: spec.bucketSeconds,
    buckets: starts.map(s => iso(s)!),
    rows,
    rollups: { nodeGroups, clusters },
    idle: await idleCost(rows, byId, i.price),
    services: servicePanels(i.snap, p => i.inScope(p), inFilter.resource, i.figures, i.monitoringConfigured),
    freshness,
    retention: RETENTION,
    gpus: { inRange: rows.length, runningNow: rows.filter(r => r.runningNow).length },
  };
}

async function idleCost(rows: FleetGpuRow[], byId: Map<string, ObservedResource>, price: VmPricer): Promise<FleetResponse['idle']> {
  const source = 'Sample store (utilisation below 5 %) × live price (Nebius billing calculator)';
  const gpuHours = Math.round((rows.reduce((a, r) => a + r.idleMinutes, 0) / 60) * 100) / 100;
  if (!rows.length) return { value: null, source, unavailableReason: 'No GPU samples in this range, so there is nothing to count as idle.' };
  const unpriced: IdleCost['unpriced'] = [];
  let total: Decimal | undefined;
  let currency: string | undefined;
  let priced = 0;
  let priceSource: string | undefined;
  const gpusPerVm = groupBy(rows, r => r.instanceId ?? r.key);
  for (const [vmId, rs] of gpusPerVm) {
    const idleMinutes = rs.reduce((a, r) => a + r.idleMinutes, 0);
    if (!idleMinutes) continue;
    const name = rs[0].instanceName ?? rs[0].node;
    const vm = byId.get(vmId);
    if (!vm) {
      unpriced.push({ key: vmId, name, reason: 'The VM is not in the current inventory (deleted, or the series carries no VM id), so it has no live price.' });
      continue;
    }
    const p = await price(vm);
    if (!p.hourly) {
      unpriced.push({ key: vmId, name, reason: p.reason ?? 'No live price for this VM.' });
      continue;
    }
    if (currency && p.hourly.currency !== currency) {
      unpriced.push({ key: vmId, name, reason: `Priced in ${p.hourly.currency}, not ${currency}: currencies are never converted.` });
      continue;
    }
    currency = p.hourly.currency;
    priceSource = p.source;
    const gpus = Math.max(1, vm.spec.gpus ?? rs.length);
    total = (total ?? Decimal.ZERO).add(Decimal.from(p.hourly.amount).mul(idleMinutes).div(60 * gpus));
    priced += idleMinutes / 60;
  }
  return {
    value: {
      gpuHours,
      thresholdPercent: IDLE_UTIL_PERCENT,
      cost: total && currency ? { amount: total.toFixed(2), currency } : null,
      pricedGpuHours: Math.round(priced * 100) / 100,
      unpriced,
      priceSource,
    },
    source,
    note: 'Estimate: idle GPU-hours × the VM’s live price per GPU-hour. Not a bill; reported cost is on Costs.',
  };
}

const RATE = 'req/s';
const BPS = 'B/s';

function servicePanels(snap: ScopedSnapshot, inScope: (p: string) => boolean, inFilter: (r: ObservedResource) => boolean, figures: ServiceFigures | undefined, configured: boolean): ServicePanel[] {
  const rs = snap.resources.filter(r => r.projectId && inScope(r.projectId) && inFilter(r));
  const of = (type: string) => rs.filter(r => r.type === type);
  const metricsReason = !configured
    ? 'Nebius Monitoring is not configured (docs/portal/nebius-setup.md#telemetry).'
    : !figures
      ? 'Figures are read at each sync; the first sync has not finished yet.'
      : undefined;
  // A card is as old as the inventory lists it is built from (followup 53), whatever it shows: none in scope included.
  const listedAt = (...ids: string[]) => {
    const t = readTime(snap, ids);
    return { ...(t.observedAt ? { observedAt: t.observedAt } : {}), ...(t.note ? { staleNote: t.note } : {}) };
  };
  const withStale = (reason: string | undefined, at: { staleNote?: string }) => [reason, at.staleNote].filter(Boolean).join(' ') || undefined;
  const failedNote = (projects: string[]) => {
    const f = figures?.failed.filter(x => projects.includes(x.projectId)) ?? [];
    return f.length ? `Could not read ${f.length} project(s): ${f[0].error.slice(0, 160)}` : undefined;
  };

  const buckets = of('storage-bucket');
  const bucketsAt = listedAt('storage.buckets');
  const objectStorage: ServicePanel = !buckets.length
    ? { id: 'object-storage', title: 'Object Storage', state: 'none-in-scope', source: 'Inventory (storage.v1 buckets)', reason: withStale('No bucket in scope.', bucketsAt), observedAt: bucketsAt.observedAt, items: [] }
    : {
        id: 'object-storage',
        title: 'Object Storage',
        state: metricsReason ? 'unavailable' : 'live',
        reason: metricsReason ?? failedNote([...new Set(buckets.map(b => b.projectId!))]),
        source: 'Nebius Monitoring: rate(request_rate[5m]), rate(http_bytes_sent/received[5m]) per bucket',
        observedAt: figures?.observedAt,
        items: buckets.map(b => {
          const f = figures?.buckets.find(x => x.bucketId === b.providerId || (x.projectId === b.projectId && x.bucket === b.name));
          return {
            name: b.name,
            uid: b.uid,
            projectId: b.projectId,
            status: f ? undefined : 'no traffic series in the last sync',
            figures: [
              { label: 'Requests', value: f?.requestRate ?? null, unit: RATE },
              { label: 'Sent', value: f?.bytesSent ?? null, unit: BPS },
              { label: 'Received', value: f?.bytesReceived ?? null, unit: BPS },
            ],
          };
        }),
      };

  const volumes = [...of('compute-disk'), ...of('compute-filesystem')];
  const volumesAt = listedAt('compute.disks', 'compute.filesystems');
  const volumePanel: ServicePanel = !volumes.length
    ? { id: 'volumes', title: 'Volumes (disks and filesystems)', state: 'none-in-scope', source: 'Inventory (compute.v1 disks, filesystems)', reason: withStale('No disk or filesystem in scope.', volumesAt), observedAt: volumesAt.observedAt, items: [] }
    : {
        id: 'volumes',
        title: 'Volumes (disks and filesystems)',
        state: metricsReason ? 'unavailable' : 'live',
        reason: metricsReason ?? failedNote([...new Set(volumes.map(v => v.projectId!))]),
        source: 'Nebius Monitoring: rate(disk_*_bytes[5m]), rate(filestore_*_bytes[5m]) — reported for attached volumes only',
        observedAt: figures?.observedAt,
        items: volumes
          .map(v => {
            const f = figures?.disks.find(x => x.id === v.providerId);
            return {
              name: v.name,
              uid: v.uid,
              projectId: v.projectId,
              status: f ? undefined : v.type === 'compute-disk' && !v.spec.attachments ? 'not attached: no I/O series' : 'no I/O series in the last sync',
              figures: [
                { label: 'Read', value: f?.readBps ?? null, unit: BPS },
                { label: 'Write', value: f?.writeBps ?? null, unit: BPS },
              ],
            };
          })
          .sort((a, b) => Number(Boolean(a.status)) - Number(Boolean(b.status)))
          .slice(0, 50),
      };

  const managed = (id: 'postgresql' | 'mlflow', type: string, title: string): ServicePanel => {
    const xs = of(type);
    const at = listedAt(id === 'postgresql' ? 'msp.postgresql' : 'msp.mlflow');
    return !xs.length
      ? { id, title, state: 'none-in-scope', source: `Inventory (${type === 'postgresql-cluster' ? 'msp/postgresql' : 'msp/mlflow'})`, reason: withStale(`No ${title} cluster in scope.`, at), observedAt: at.observedAt, items: [] }
      : {
          id,
          title,
          state: 'no-metrics',
          source: 'Inventory status; logs on the Logs page',
          observedAt: at.observedAt,
          reason: `${at.staleNote ? `${at.staleNote} ` : ''}Nebius shows ${title} metrics on the console dashboard; no series for it were found on the read API (metric list read 2026-10-11). Status comes from the inventory; logs are on the Logs page (bucket ${id === 'postgresql' ? 'sp_postgres' : 'sp_mlflow'}).`,
          items: xs.map(x => ({ name: x.name, uid: x.uid, projectId: x.projectId, status: x.status, figures: [] })),
        };
  };
  return [objectStorage, volumePanel, managed('postgresql', 'postgresql-cluster', 'Managed PostgreSQL'), managed('mlflow', 'mlflow-cluster', 'Managed MLflow')];
}


/**
 * The region and stage filter for GPU series and resources. A series is judged by the region and stage stored with
 * it; a series stored before they were kept (G2.1) by its VM, node group or cluster when still in the inventory,
 * else its project's region and the one stage its project's resources carry (none when they carry several).
 */
function filterOf(resources: ObservedResource[], byId: Map<string, ObservedResource>, f: FleetInput['filter']) {
  const stageOf = (r: ObservedResource) => r.labels['nip-stage'] ?? attributeWithParents(r, byId).stage;
  const resource = (r: ObservedResource) => (!f?.region || r.region === f.region) && (!f?.stage || stageOf(r) === f.stage);
  if (!f?.region && !f?.stage) return { series: (_s: GpuSeries) => true, resource };
  let projectStages: Map<string, Set<string>> | undefined;
  const projectStage = (projectId: string) => {
    if (!projectStages) {
      projectStages = new Map();
      for (const r of resources) {
        const st = r.type === 'project' || !r.projectId ? undefined : stageOf(r);
        if (st) projectStages.set(r.projectId!, (projectStages.get(r.projectId!) ?? new Set()).add(st));
      }
    }
    const xs = projectStages.get(projectId);
    return xs?.size === 1 ? [...xs][0] : undefined;
  };
  const series = (s: GpuSeries) => {
    const owner = [s.instanceId, s.nodeGroupId, s.clusterId].map(id => (id ? byId.get(id) : undefined)).find((x): x is ObservedResource => Boolean(x));
    const region = s.region ?? owner?.region ?? byId.get(s.projectId)?.region;
    if (f.region && region !== f.region) return false;
    const stage = s.stage ?? (owner ? stageOf(owner) : undefined) ?? projectStage(s.projectId);
    return !f.stage || stage === f.stage;
  };
  return { series, resource };
}

function groupBy<T>(xs: T[], key: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of xs) {
    const k = key(x);
    const g = m.get(k);
    if (g) g.push(x);
    else m.set(k, [x]);
  }
  return m;
}

export type { GpuSeries };
