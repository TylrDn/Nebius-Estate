import { distinctNames, FleetGpuRow, FleetMetric, FleetRange, heatLevel } from '@internal/nebius-domain';
import { fmtNumber } from '../ui';

/** View helpers for the Fleet page: colour classes, units and grouping. Pure, so they are unit-tested. */

export const METRICS: { id: FleetMetric; label: string; unit: string; scale: [string, string, string] }[] = [
  { id: 'util', label: 'Utilisation', unit: '%', scale: ['0 %', '50 %', '100 %'] },
  { id: 'temp', label: 'Temperature', unit: '°C', scale: ['30 °C', '60 °C', '90 °C'] },
  { id: 'power', label: 'Power', unit: 'W', scale: ['0 W', 'half of max', 'max in view'] },
  { id: 'mem', label: 'Memory', unit: '%', scale: ['0 %', '50 %', '100 %'] },
];

export const RANGES: { id: FleetRange; label: string }[] = [
  { id: '1h', label: '1 h' },
  { id: '6h', label: '6 h' },
  { id: '24h', label: '24 h' },
  { id: '7d', label: '7 d' },
];

/**
 * The Logs range that reaches back to a GPU's last sample (G2.6): a finished run's serial console is older than
 * Logs' default hour. Without a last sample (7 d is read from hourly roll-ups) the Fleet range itself.
 */
export function logsRangeFor(lastSampleAt: string | undefined, range: FleetRange, nowMs: number): '1h' | '6h' | '24h' | '7d' {
  if (!lastSampleAt) return range;
  const age = nowMs - Date.parse(lastSampleAt);
  return age <= 3_600_000 ? '1h' : age <= 6 * 3_600_000 ? '6h' : age <= 86_400_000 ? '24h' : '7d';
}

/** Idle GPU-hours at one precision in the tile, the drawer and the roll-ups (G2.15). */
export function fmtGpuHours(h: number): string {
  return fmtNumber(h, h < 1 ? 2 : 1);
}

/** The CSS class of one heat-map cell: ten steps of the metric's scale, or "not observed" (never the low end). */
export function heatClass(metric: FleetMetric, v: number | null, maxPower: number): string {
  const level = heatLevel(metric, v, maxPower);
  return level === null ? 'ne-heat-cnone' : `ne-heat-c${Math.min(9, Math.floor(level * 10))}`;
}

export function fmtMetric(metric: FleetMetric, v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return 'not observed';
  const n = Math.round(v * 10) / 10;
  return metric === 'temp' ? `${n} °C` : metric === 'power' ? `${Math.round(v)} W` : `${n} %`;
}

/** The highest power value in view (the power scale is relative: GPU TDP is not published per series). */
export function powerMax(rows: FleetGpuRow[]): number {
  let m = 0;
  for (const r of rows) for (const v of r.values.power) if (v !== null && v > m) m = v;
  return m || 1;
}

export interface RowGroup {
  key: string;
  title: string;
  rows: FleetGpuRow[];
}

/** Rows grouped as cluster › node group, standalone VMs last. */
export function groupRows(rows: FleetGpuRow[]): RowGroup[] {
  const out = new Map<string, RowGroup>();
  for (const r of rows) {
    const key = r.nodeGroupId ?? `standalone:${r.projectId}`;
    const del = (name: string, gone: boolean | undefined) => (gone ? `${name} (deleted)` : name);
    const title = r.nodeGroupId
      ? `${del(r.clusterName ?? r.clusterId ?? 'cluster', r.deleted?.cluster)} › ${del(r.nodeGroupName ?? r.nodeGroupId, r.deleted?.nodeGroup)}`
      : `Standalone VMs · ${r.projectName ?? r.projectId}`;
    const g = out.get(key) ?? { key, title, rows: [] };
    g.rows.push(r);
    out.set(key, g);
  }
  // Two groups that read the same (a node group of one name, deleted and created again) say which is which (W1F.N4).
  const last = (g: RowGroup) => g.rows.map(r => r.lastSampleAt ?? '').sort().pop() || undefined;
  const titled = distinctNames([...out.values()].map(g => ({ ...g, id: g.key, name: g.title, lastSampleAt: last(g) })));
  for (const t of titled) out.set(t.key, { key: t.key, title: t.name, rows: t.rows });
  return [...out.values()].sort((a, b) => Number(a.key.startsWith('standalone:')) - Number(b.key.startsWith('standalone:')) || a.title.localeCompare(b.title));
}

/** "<VM name> · GPU 0": the same GPU name as its alerts (gpuName from the API), else from the series label. */
/** The one state a GPU row shows beside its label: deleted, not running, or nothing while it runs (F1.40). */
export function rowState(r: Pick<FleetGpuRow, 'runningNow' | 'deleted'>): 'deleted' | 'not running' | undefined {
  if (r.deleted?.vm) return 'deleted';
  return r.runningNow === false ? 'not running' : undefined;
}

/**
 * The drawer's node-group drill-down (followup 34): a link to the Explorer only while the node group is in the inventory
 * (its uid, as the VM link checks instanceUid); "deleted" once a listed project's sync no longer has it; otherwise
 * (before the first sync, or a project not listed) a note that the Explorer has nothing to open; nothing for a standalone VM.
 */
export function nodeGroupDrill(r: Pick<FleetGpuRow, 'nodeGroupId' | 'nodeGroupUid' | 'deleted'>): { uid: string } | { note: string } | undefined {
  if (!r.nodeGroupId) return undefined;
  if (r.deleted?.nodeGroup) return { note: 'Node group deleted; not in the Explorer.' };
  return r.nodeGroupUid ? { uid: r.nodeGroupUid } : { note: 'Node group not in the current inventory, so the Explorer has nothing to open.' };
}

/**
 * Each GPU row's label (gpuLabel), told apart where two read the same: runs of one VM name, deleted and created again,
 * get their last sample's time (W1F.N4).
 */
export function rowLabels(rows: FleetGpuRow[]): Map<string, string> {
  return new Map(distinctNames(rows.map(r => ({ key: r.key, id: r.instanceId ?? r.key, name: gpuLabel(r), lastSampleAt: r.lastSampleAt }))).map(x => [x.key, x.name]));
}

export function gpuLabel(r: Pick<FleetGpuRow, 'instanceName' | 'node' | 'gpu' | 'gpuName'>): string {
  const gpu = r.gpuName ?? (r.gpu ? (/^GPU-/.test(r.gpu) ? r.gpu.slice(0, 12) : `GPU ${r.gpu}`) : 'GPU');
  return `${r.instanceName ?? r.node} · ${gpu}`;
}

/** "08:15" within a day, "10-09 14:00" for the 7-day range (UTC, as every portal time). */
export function bucketLabel(iso: string, range: FleetRange): string {
  return range === '7d' ? `${iso.slice(5, 10)} ${iso.slice(11, 16)}` : iso.slice(11, 16);
}

/** Bytes per second as B/s, KiB/s, MiB/s, GiB/s. */
export function fmtRate(v: number | null, unit: string): string {
  if (v === null || !Number.isFinite(v)) return 'no series';
  if (unit !== 'B/s') return `${Math.round(v * 100) / 100} ${unit}`;
  const steps = ['B/s', 'KiB/s', 'MiB/s', 'GiB/s'];
  let x = v;
  let i = 0;
  while (x >= 1024 && i < steps.length - 1) {
    x /= 1024;
    i++;
  }
  return `${Math.round(x * 10) / 10} ${steps[i]}`;
}

/** Mean of the non-null values, or null. */
export function meanOf(xs: (number | null)[]): number | null {
  const v = xs.filter((x): x is number => x !== null);
  return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : null;
}

/** A bucket width in words: "15-min", "hourly". */
export const bucketWords = (seconds: number) => (seconds >= 3600 ? 'hourly' : `${seconds / 60}-min`);

export function lastOf(xs: (number | null)[]): number | null {
  for (let i = xs.length - 1; i >= 0; i--) if (xs[i] !== null) return xs[i];
  return null;
}

/** Unpriced idle VMs grouped by their reason, in first-seen order: one sentence per reason, with its VM names. */
export function groupByReason(items: { name: string; reason: string }[]): { reason: string; names: string[] }[] {
  const out = new Map<string, string[]>();
  for (const i of items) out.set(i.reason, [...(out.get(i.reason) ?? []), i.name]);
  return [...out.entries()].map(([reason, names]) => ({ reason, names }));
}
