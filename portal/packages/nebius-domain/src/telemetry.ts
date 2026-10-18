import type { Money } from './money';
import type { SourcedMetric } from './api';

/**
 * GPU telemetry history (the sample store) and the Fleet view built on it. Samples are the DCGM
 * series Nebius Monitoring publishes per GPU (utilisation, temperature, power, framebuffer), read by
 * the portal's sync loop: 1-minute samples kept 7 days, hourly roll-ups kept 90 days. Kept apart
 * from inventory (what exists) and billing (what was charged).
 */

/** The DCGM series stored per GPU, by stored field. */
export const SAMPLE_METRICS = {
  util: 'DCGM_FI_DEV_GPU_UTIL',
  temp: 'DCGM_FI_DEV_GPU_TEMP',
  power: 'DCGM_FI_DEV_POWER_USAGE',
  memUsed: 'DCGM_FI_DEV_FB_USED',
  memTotal: 'DCGM_FI_DEV_FB_TOTAL',
} as const;
export type SampleField = keyof typeof SAMPLE_METRICS;

/** A GPU below this utilisation is idle (the GPU idle rule and the idle-cost estimate use the same threshold). */
export const IDLE_UTIL_PERCENT = 5;
/** Sample resolution of the store (seconds). */
export const SAMPLE_STEP_SECONDS = 60;
export const SAMPLE_RETENTION_DAYS = 7;
export const ROLLUP_RETENTION_DAYS = 90;
/** Upper bound on the GPUs the store tracks (bounded size: rows = GPUs × minutes). */
export const MAX_TRACKED_GPUS = 2048;

/** The identity of one GPU series: project, VM (or host) and GPU, with its MK8s placement when labelled. */
export interface GpuSeries {
  key: string;
  projectId: string;
  instanceId?: string;
  node: string;
  gpu?: string;
  clusterId?: string;
  nodeGroupId?: string;
  /** Last-known names, from the inventory when the series was written: kept after the resources are deleted. */
  instanceName?: string;
  nodeGroupName?: string;
  clusterName?: string;
  projectName?: string;
  /** Region and stage (nip-stage, own or inherited) of the VM when the series was written: the global filter keeps a finished run's history (G2.1). */
  region?: string;
  stage?: string;
}

/** One stored 1-minute sample (seconds since the epoch, aligned to the minute). */
export interface GpuSample {
  key: string;
  ts: number;
  util?: number | null;
  temp?: number | null;
  power?: number | null;
  memUsed?: number | null;
  memTotal?: number | null;
}

/** One hourly roll-up of a GPU. */
export interface GpuHourly {
  key: string;
  /** Start of the hour, seconds since the epoch. */
  hour: number;
  samples: number;
  /** Samples whose utilisation was below IDLE_UTIL_PERCENT (each is one minute). */
  idleSamples: number;
  utilAvg: number | null;
  utilMax: number | null;
  tempAvg: number | null;
  tempMax: number | null;
  powerAvg: number | null;
  memUsedAvg: number | null;
  memTotal: number | null;
}

/** Labels that carry the GPU on Nebius Monitoring DCGM series (verified live: `uuid`; others from dcgm-exporter). */
const GPU_LABELS = ['gpu', 'gpu_id', 'gpu_index', 'uuid', 'UUID', 'device', 'minor_number'];
const INSTANCE_LABELS = ['instance_id', 'compute_instance_id', 'resource_id', 'vm_id', 'instance'];
const HOST_LABELS = ['Hostname', 'hostname', 'host', 'node', 'instance'];

/** The series identity of one DCGM result's labels (stable across metrics of the same GPU). */
export function seriesOf(projectId: string, labels: Record<string, string | undefined>): GpuSeries {
  const instanceId = INSTANCE_LABELS.map(k => labels[k]).find((x): x is string => typeof x === 'string' && x.startsWith('computeinstance-'));
  const node = HOST_LABELS.map(k => labels[k]).find((x): x is string => Boolean(x)) ?? instanceId ?? 'unknown';
  const gpu = GPU_LABELS.map(k => labels[k]).find((x): x is string => x !== undefined && x !== '');
  return {
    key: `${projectId}|${instanceId ?? node}|${gpu ?? ''}`,
    projectId,
    instanceId,
    node,
    gpu,
    clusterId: labels.mk8s_cluster_id || undefined,
    nodeGroupId: labels.mk8s_node_group_id || undefined,
  };
}

/**
 * One name for a GPU everywhere (Fleet rows, alert titles): "GPU <index>" from an index label, "GPU 0" for the only
 * GPU of its VM, else the short UUID ("GPU-0000mock"). Undefined when neither is known.
 */
export function gpuName(id: { index?: string; uuid?: string }, gpusOnVm?: number): string | undefined {
  if (id.index !== undefined && /^\d+$/.test(id.index)) return `GPU ${id.index}`;
  if (id.uuid && gpusOnVm === 1) return 'GPU 0';
  return id.uuid ? id.uuid.slice(0, 12) : undefined;
}

/** Aligns a time to the store's minute grid. */
export const minuteOf = (sec: number) => Math.floor(sec / SAMPLE_STEP_SECONDS) * SAMPLE_STEP_SECONDS;
export const hourOf = (sec: number) => Math.floor(sec / 3600) * 3600;

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const maxOf = (xs: number[]) => (xs.length ? Math.max(...xs) : null);
const vals = (xs: GpuSample[], f: SampleField) => xs.map(s => s[f]).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
const round = (v: number | null, d = 2) => (v === null ? null : Math.round(v * 10 ** d) / 10 ** d);

/** Hourly roll-ups of 1-minute samples (one per GPU and hour that has samples; no zero-filled hours). */
export function rollupHourly(samples: GpuSample[]): GpuHourly[] {
  const groups = new Map<string, GpuSample[]>();
  for (const s of samples) {
    const k = `${s.key}\u001f${hourOf(s.ts)}`;
    const g = groups.get(k);
    if (g) g.push(s);
    else groups.set(k, [s]);
  }
  return [...groups.entries()].map(([k, xs]) => {
    const [key, hour] = k.split('\u001f');
    const util = vals(xs, 'util');
    return {
      key,
      hour: Number(hour),
      samples: xs.length,
      idleSamples: util.filter(v => v < IDLE_UTIL_PERCENT).length,
      utilAvg: round(avg(util)),
      utilMax: maxOf(util),
      tempAvg: round(avg(vals(xs, 'temp'))),
      tempMax: maxOf(vals(xs, 'temp')),
      powerAvg: round(avg(vals(xs, 'power'))),
      memUsedAvg: round(avg(vals(xs, 'memUsed'))),
      memTotal: maxOf(vals(xs, 'memTotal')),
    };
  });
}

/* --------------------------------------------------------------- Fleet view */

export const FLEET_RANGES = ['1h', '6h', '24h', '7d'] as const;
export type FleetRange = (typeof FLEET_RANGES)[number];
export type FleetMetric = 'util' | 'temp' | 'power' | 'mem';

/**
 * GPU utilisation has one name, and every title says the window it covers (F1.1): Overview and Capacity show the
 * latest sample of each GPU, Fleet the mean over its range, the trends one mean per day. Different windows give
 * different numbers; the same window gives the same number (meanUtilisation everywhere).
 */
export const GPU_UTILISATION = 'GPU utilisation';
export type UtilisationWindow = 'latest' | 'daily' | FleetRange;

/** The window a figure covers, in words: "latest sample", "daily mean", "mean, last 24 h". */
export function windowText(w: UtilisationWindow): string {
  if (w === 'latest') return 'latest sample';
  if (w === 'daily') return 'daily mean';
  return `mean, last ${w.replace(/^(\d+)([a-z])$/, '$1 $2')}`;
}

/** The one title for GPU utilisation, for cards, tiles and table columns alike: "GPU utilisation · latest sample". */
export function utilisationTitle(w: UtilisationWindow): string {
  return `${GPU_UTILISATION} · ${windowText(w)}`;
}

/** The mean of utilisation values in percent, to one decimal; unobserved values are left out, and none is null. */
export function meanUtilisation(values: (number | null | undefined)[]): number | null {
  const v = values.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
  return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : null;
}

/** Window, bucket width and source table per range: the minute store up to a day, roll-ups beyond. */
export const RANGE_SPEC: Record<FleetRange, { seconds: number; bucketSeconds: number; source: 'samples' | 'hourly' }> = {
  '1h': { seconds: 3600, bucketSeconds: 60, source: 'samples' },
  '6h': { seconds: 6 * 3600, bucketSeconds: 300, source: 'samples' },
  '24h': { seconds: 86_400, bucketSeconds: 900, source: 'samples' },
  '7d': { seconds: 7 * 86_400, bucketSeconds: 3600, source: 'hourly' },
};

/** The bucket starts (seconds) covering [to − range, to), aligned to the bucket width. */
export function bucketStarts(range: FleetRange, toSec: number): number[] {
  const { seconds, bucketSeconds } = RANGE_SPEC[range];
  const end = Math.floor(toSec / bucketSeconds) * bucketSeconds;
  const n = seconds / bucketSeconds;
  return Array.from({ length: n }, (_, i) => end - (n - 1 - i) * bucketSeconds);
}

/** One GPU's values per bucket: mean of the samples in the bucket; null where nothing was observed (never 0). */
export function bucketize(
  samples: GpuSample[],
  starts: number[],
  bucketSeconds: number,
): Record<FleetMetric, (number | null)[]> & { idleMinutes: number; samples: number } {
  const n = starts.length;
  const first = starts[0] ?? 0;
  const sums = { util: new Array<number>(n).fill(0), temp: new Array<number>(n).fill(0), power: new Array<number>(n).fill(0), mem: new Array<number>(n).fill(0) };
  const counts = { util: new Array<number>(n).fill(0), temp: new Array<number>(n).fill(0), power: new Array<number>(n).fill(0), mem: new Array<number>(n).fill(0) };
  let idleMinutes = 0;
  let count = 0;
  for (const s of samples) {
    const i = Math.floor((s.ts - first) / bucketSeconds);
    if (i < 0 || i >= n) continue;
    count++;
    const add = (m: FleetMetric, v: number | null | undefined) => {
      if (typeof v !== 'number' || !Number.isFinite(v)) return;
      sums[m][i] += v;
      counts[m][i]++;
    };
    add('util', s.util);
    add('temp', s.temp);
    add('power', s.power);
    add('mem', typeof s.memUsed === 'number' && typeof s.memTotal === 'number' && s.memTotal > 0 ? (s.memUsed / s.memTotal) * 100 : null);
    if (typeof s.util === 'number' && s.util < IDLE_UTIL_PERCENT) idleMinutes++;
  }
  const mean = (m: FleetMetric) => sums[m].map((x, i) => (counts[m][i] ? Math.round((x / counts[m][i]) * 10) / 10 : null));
  return { util: mean('util'), temp: mean('temp'), power: mean('power'), mem: mean('mem'), idleMinutes, samples: count };
}

/** One GPU's samples in one bucket, summed in the database (`[sum, count]` per metric; mem in %). */
export interface BucketAggregate {
  key: string;
  /** Bucket index from the first bucket start. */
  bucket: number;
  samples: number;
  /** Samples below IDLE_UTIL_PERCENT (one per minute). */
  idle: number;
  util: [number, number];
  temp: [number, number];
  power: [number, number];
  mem: [number, number];
  /** Newest sample in the bucket (seconds). */
  newest: number;
}

/** bucketize from per-bucket sums (the database downsamples; same means, rounding and idle count). */
export function bucketizeAggregates(aggs: BucketAggregate[], n: number): Record<FleetMetric, (number | null)[]> & { idleMinutes: number; samples: number } {
  const out = { util: new Array<number | null>(n).fill(null), temp: new Array<number | null>(n).fill(null), power: new Array<number | null>(n).fill(null), mem: new Array<number | null>(n).fill(null) };
  let idleMinutes = 0;
  let samples = 0;
  for (const a of aggs) {
    if (a.bucket < 0 || a.bucket >= n) continue;
    samples += a.samples;
    idleMinutes += a.idle;
    for (const m of ['util', 'temp', 'power', 'mem'] as const) {
      const [sum, count] = a[m];
      if (count) out[m][a.bucket] = Math.round((sum / count) * 10) / 10;
    }
  }
  return { ...out, idleMinutes, samples };
}

/** The same per-bucket shape from hourly roll-ups (7-day range). */
export function bucketizeHourly(rows: GpuHourly[], starts: number[]): Record<FleetMetric, (number | null)[]> & { idleMinutes: number; samples: number } {
  const at = new Map(rows.map(r => [r.hour, r]));
  const pick = (f: (r: GpuHourly) => number | null) => starts.map(h => {
    const r = at.get(h);
    return r ? f(r) : null;
  });
  return {
    util: pick(r => r.utilAvg),
    temp: pick(r => r.tempAvg),
    power: pick(r => r.powerAvg),
    mem: pick(r => (r.memUsedAvg !== null && r.memTotal ? Math.round((r.memUsedAvg / r.memTotal) * 1000) / 10 : null)),
    idleMinutes: rows.filter(r => starts.includes(r.hour)).reduce((a, r) => a + r.idleSamples, 0),
    samples: rows.filter(r => starts.includes(r.hour)).reduce((a, r) => a + r.samples, 0),
  };
}

export interface FleetGpuRow {
  key: string;
  projectId: string;
  projectName?: string;
  instanceId?: string;
  instanceName?: string;
  /** Explorer uid of the VM, when it is in the inventory. */
  instanceUid?: string;
  node: string;
  gpu?: string;
  clusterId?: string;
  clusterName?: string;
  nodeGroupId?: string;
  nodeGroupName?: string;
  /** Explorer uid of the node group, when it is in the inventory (followup 34: the drawer links only then). */
  nodeGroupUid?: string;
  /** One value per bucket, null where no sample was recorded. */
  values: Record<FleetMetric, (number | null)[]>;
  lastSampleAt?: string;
  /** Minutes below the idle threshold in the range (one sample = one minute). */
  idleMinutes: number;
  samples: number;
  /** The GPU's name, the same as in its alerts ("GPU 0", or the short UUID): gpuName. */
  gpuName?: string;
  /** The VM runs now (in the inventory, not stopped or deleting) and the GPU sampled within one sync interval. */
  runningNow: boolean;
  /** Why the GPU is not running now, when that is known ("VM no longer in the inventory (deleted)"). */
  notRunning?: string;
  /**
   * What left the inventory since the series was recorded (only once the inventory has listed the project): said
   * apart from the names, the same for a VM known by name or by id (F1.40).
   */
  deleted?: { vm?: true; nodeGroup?: true; cluster?: true };
}

export interface FleetRollup {
  id: string;
  name: string;
  kind: 'node-group' | 'cluster' | 'standalone';
  gpus: number;
  /** Mean of the GPUs' sampled utilisation in the range; null when none was sampled. */
  meanUtil: number | null;
  maxTemp: number | null;
  idleGpuHours: number;
  /** The newest sample of its GPUs: tells apart runs that carry the same name (W1F.N4). */
  lastSampleAt?: string;
}

/**
 * Labels that read the same get what tells them apart (W1F.N4: Fleet listed "(deleted)" runs of one VM name with
 * nothing between them): the last sample's time ("· last sample 10-11 14:20 UTC"), then the end of the id when two
 * still match. A unique name stays as it is.
 */
export function distinctNames<T extends { id: string; name: string; lastSampleAt?: string }>(items: T[]): T[] {
  const count = (xs: string[]) => xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<string, number>());
  const names = count(items.map(i => i.name));
  const timed = items.map(i =>
    (names.get(i.name) ?? 0) > 1 && i.lastSampleAt ? `${i.name} · last sample ${i.lastSampleAt.slice(5, 10)} ${i.lastSampleAt.slice(11, 16)} UTC` : i.name,
  );
  const again = count(timed);
  return items.map((i, k) => ({ ...i, name: (again.get(timed[k]) ?? 0) > 1 ? `${timed[k]} · …${i.id.slice(-6)}` : timed[k] }));
}

/** Mean, max and idle hours over a set of rows (one roll-up line). */
export function rollupRows(rows: FleetGpuRow[], id: string, name: string, kind: FleetRollup['kind']): FleetRollup {
  const temp = rows.flatMap(r => r.values.temp.filter((v): v is number => v !== null));
  const last = rows.map(r => r.lastSampleAt).filter((x): x is string => Boolean(x)).sort().pop();
  return {
    id,
    name,
    kind,
    ...(last ? { lastSampleAt: last } : {}),
    gpus: rows.length,
    meanUtil: meanUtilisation(rows.flatMap(r => r.values.util)),
    maxTemp: temp.length ? Math.max(...temp) : null,
    idleGpuHours: Math.round((rows.reduce((a, r) => a + r.idleMinutes, 0) / 60) * 100) / 100,
  };
}

/** Idle GPU-hours priced at the live price per GPU-hour of each VM; VMs without a price are listed, not guessed. */
export interface IdleCost {
  gpuHours: number;
  thresholdPercent: number;
  /** Estimate: idle GPU-hours × (the VM's live hourly price ÷ its GPUs). Null when nothing could be priced. */
  cost: Money | null;
  pricedGpuHours: number;
  /** GPUs whose idle hours could not be priced, and why. */
  unpriced: { key: string; name: string; reason: string }[];
  priceSource?: string;
}

/** Object Storage, volumes, PostgreSQL and MLflow at a glance; "none in scope" when the service is not used. */
export interface ServicePanel {
  id: 'object-storage' | 'volumes' | 'postgresql' | 'mlflow';
  title: string;
  state: 'live' | 'none-in-scope' | 'no-metrics' | 'unavailable';
  reason?: string;
  source: string;
  observedAt?: string;
  items: { name: string; uid?: string; projectId?: string; status?: string; figures: { label: string; value: number | null; unit: string }[] }[];
}

/**
 * live: a GPU in scope sampled within one sync interval (plus the metrics' ingestion delay).
 * not-reporting: the history is read, but no GPU in scope has reported since (nothing running now).
 * stale: no new sample for three sync intervals while the history connector is failing.
 */
export interface FleetFreshness {
  state: 'live' | 'not-reporting' | 'stale' | 'waiting' | 'not-configured' | 'not-allowed';
  lastSampleAt?: string;
  oldestSampleAt?: string;
  reason?: string;
  source: string;
}

export interface FleetResponse {
  range: FleetRange;
  bucketSeconds: number;
  /** Bucket starts, ISO. */
  buckets: string[];
  rows: FleetGpuRow[];
  rollups: { nodeGroups: FleetRollup[]; clusters: FleetRollup[] };
  idle: SourcedMetric<IdleCost>;
  services: ServicePanel[];
  freshness: FleetFreshness;
  retention: string;
  /** GPUs with samples in the selected range, and of those the ones running now (FleetGpuRow.runningNow). */
  gpus: { inRange: number; runningNow: number };
}

/** Colour stop 0–1 for a value on a metric's scale (null stays null: the cell is drawn as "not observed"). */
export function heatLevel(metric: FleetMetric, v: number | null, powerMax = 700): number | null {
  if (v === null || !Number.isFinite(v)) return null;
  const clamp = (x: number) => Math.max(0, Math.min(1, x));
  if (metric === 'temp') return clamp((v - 30) / 60);
  if (metric === 'power') return clamp(v / Math.max(1, powerMax));
  return clamp(v / 100);
}
