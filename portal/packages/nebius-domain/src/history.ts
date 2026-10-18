import { attributeWithParents, effectiveTtl, findOrphanCandidates, NIP_LABELS, ObservedResource } from './resources';
import type { GpuHourly, GpuSeries } from './telemetry';

/**
 * Daily estate history: one row per (day, project, region, stage). Each sync merges into today's rows
 * (mergeDayRows, G2.5): GPUs, vCPUs and running VMs keep the day's maximum, GPU utilisation the mean of every
 * sample of the day, and resources, TTL-expired and orphan candidates the last state. A run torn down before the
 * day's last sync still shows that day. Rows are per project so that project scoping and the global filter apply
 * to history exactly as they apply to the live views.
 */

export interface DailySummaryRow {
  day: string; // YYYY-MM-DD (UTC)
  projectId: string;
  region: string; // '' when unknown
  stage: string; // nip-stage label, '' when unattributed
  resources: number;
  runningInstances: number;
  gpus: number;
  vcpus: number;
  ttlExpired: number;
  orphanCandidates: number;
  /** Sum and count of DCGM samples mapped to instances of this key (mean = sum / count). */
  gpuUtilSum: number;
  gpuUtilSamples: number;
  /**
   * GPUs, running VMs or utilisation were raised from the GPU sample store's hourly roll-ups (backfillFromTelemetry,
   * #33): the day's syncs missed GPUs that reported. vCPUs, resources and TTL or orphan counts stay as recorded.
   */
  telemetryBackfill?: boolean;
}

/** Why a day is marked incomplete (HistoryPoint.incomplete): said under the chart and on the point. */
export const HISTORY_INCOMPLETE =
  'Recorded incompletely: the day\u2019s syncs missed GPUs or GPU utilisation that GPU telemetry saw, so those figures come from the hourly GPU samples; vCPUs and resource counts are what the syncs recorded.';

/** A history chart's footer: the source, what a point means and, when a day is marked, why its point is hollow (#33). */
export function historyFooter(h: { source: string; note?: string; points: Pick<HistoryPoint, 'incomplete'>[] }): string {
  const incomplete = h.points.find(p => p.incomplete)?.incomplete;
  return `${h.source}. ${h.note ?? 'Gaps are days without a snapshot.'}${incomplete ? ` Hollow points: ${incomplete}` : ''}`;
}

export interface HistoryPoint {
  day: string;
  resources: number;
  runningInstances: number;
  gpus: number;
  vcpus: number;
  ttlExpired: number;
  orphanCandidates: number;
  /** null when no telemetry sample was recorded that day for the selection. */
  gpuUtilMean: number | null;
  /** Set when a row of the day was backfilled from GPU telemetry (HISTORY_INCOMPLETE): the day is not a full record. */
  incomplete?: string;
}

const keyOf = (r: Pick<ObservedResource, 'projectId' | 'region' | 'labels'>) =>
  `${r.projectId ?? ''}\u001f${r.region ?? ''}\u001f${r.labels?.[NIP_LABELS.stage] ?? ''}`;

/** Summarises one snapshot into per-(project, region, stage) rows for `now`'s UTC day. */
export function summarizeDay(
  resources: ObservedResource[],
  now: Date,
  telemetry?: { samples: { instanceId?: string; gpuUtilPercent: number }[] },
): DailySummaryRow[] {
  const day = now.toISOString().slice(0, 10);
  const rows = new Map<string, DailySummaryRow>();
  const row = (r: ObservedResource) => {
    const k = keyOf(r);
    let v = rows.get(k);
    if (!v) {
      v = {
        day, projectId: r.projectId ?? '', region: r.region ?? '', stage: r.labels?.[NIP_LABELS.stage] ?? '',
        resources: 0, runningInstances: 0, gpus: 0, vcpus: 0, ttlExpired: 0, orphanCandidates: 0, gpuUtilSum: 0, gpuUtilSamples: 0,
      };
      rows.set(k, v);
    }
    return v;
  };
  const orphans = new Set(findOrphanCandidates(resources).map(o => o.uid));
  const byId = new Map(resources.map(r => [r.providerId, r]));
  const byInstance = new Map<string, ObservedResource>();
  for (const r of resources) {
    if (r.type === 'project' || r.type === 'tenant' || !r.projectId) continue;
    const v = row(r);
    v.resources++;
    if (r.type === 'compute-instance') {
      byInstance.set(r.providerId, r);
      if (r.status === 'running') {
        v.runningInstances++;
        v.gpus += r.spec.gpus ?? 0;
        v.vcpus += r.spec.vcpus ?? 0;
      }
    }
    // Node VMs, CSI volumes and node IPs take the TTL of their node group / cluster.
    if (effectiveTtl(attributeWithParents(r, byId), now).state === 'expired') v.ttlExpired++;
    if (orphans.has(r.uid)) v.orphanCandidates++;
  }
  for (const s of telemetry?.samples ?? []) {
    const inst = s.instanceId ? byInstance.get(s.instanceId) : undefined;
    if (!inst) continue; // samples that cannot be tied to an instance are not attributed
    const v = row(inst);
    v.gpuUtilSum += s.gpuUtilPercent;
    v.gpuUtilSamples++;
  }
  return [...rows.values()];
}

/** What the daily points mean (GET /history `note`, shown under every history chart). */
export const HISTORY_NOTE =
  'One point per day, from this portal\u2019s syncs: GPUs, vCPUs and running VMs are the day\u2019s maximum, GPU utilisation the mean of the day\u2019s samples, resources and TTL or orphan counts the last state of the day. A run started and torn down between two syncs is not seen. Days the portal did not run are gaps, not zeros.';

/**
 * Merges a sync's rows into the rows already stored for the same day (G2.5): maxima for GPUs, vCPUs and running
 * VMs, summed utilisation samples (a daily mean), the latest resources, TTL-expired and orphan counts. A key the
 * new sync no longer has keeps its maxima and samples, with 0 for the last-state counts.
 */
export function mergeDayRows(stored: DailySummaryRow[], incoming: DailySummaryRow[]): DailySummaryRow[] {
  const key = (r: DailySummaryRow) => `${r.day}\u001f${r.projectId}\u001f${r.region}\u001f${r.stage}`;
  const out = new Map<string, DailySummaryRow>();
  const days = new Set(incoming.map(r => r.day));
  for (const r of stored) if (days.has(r.day)) out.set(key(r), { ...r, resources: 0, ttlExpired: 0, orphanCandidates: 0 });
  for (const r of incoming) {
    const was = out.get(key(r));
    out.set(
      key(r),
      !was
        ? r
        : {
            ...r,
            runningInstances: Math.max(was.runningInstances, r.runningInstances),
            gpus: Math.max(was.gpus, r.gpus),
            vcpus: Math.max(was.vcpus, r.vcpus),
            gpuUtilSum: was.gpuUtilSum + r.gpuUtilSum,
            gpuUtilSamples: was.gpuUtilSamples + r.gpuUtilSamples,
            ...(was.telemetryBackfill || r.telemetryBackfill ? { telemetryBackfill: true } : {}),
          },
    );
  }
  return [...out.values()];
}

export interface HistoryFilter {
  project?: string;
  region?: string;
  stage?: string;
}

/** Sums rows per day for the selection. Days without rows are absent (gaps), never zero-filled. */
export function aggregateHistory(rows: DailySummaryRow[], f: HistoryFilter = {}): HistoryPoint[] {
  const days = new Map<string, HistoryPoint & { utilSum: number; utilN: number; partial: boolean }>();
  for (const r of rows) {
    if (f.project && r.projectId !== f.project) continue;
    if (f.region && r.region !== f.region) continue;
    if (f.stage && r.stage !== f.stage) continue;
    const p = days.get(r.day) ?? { day: r.day, resources: 0, runningInstances: 0, gpus: 0, vcpus: 0, ttlExpired: 0, orphanCandidates: 0, gpuUtilMean: null, utilSum: 0, utilN: 0, partial: false };
    if (r.telemetryBackfill) p.partial = true;
    p.resources += r.resources;
    p.runningInstances += r.runningInstances;
    p.gpus += r.gpus;
    p.vcpus += r.vcpus;
    p.ttlExpired += r.ttlExpired;
    p.orphanCandidates += r.orphanCandidates;
    p.utilSum += r.gpuUtilSum;
    p.utilN += r.gpuUtilSamples;
    days.set(r.day, p);
  }
  return [...days.values()]
    .sort((a, b) => a.day.localeCompare(b.day))
    .map(({ utilSum, utilN, partial, ...p }) => ({ ...p, gpuUtilMean: utilN ? Math.round((utilSum / utilN) * 10) / 10 : null, ...(partial ? { incomplete: HISTORY_INCOMPLETE } : {}) }));
}

/* ------------------------------------------------ backfill from GPU telemetry (#33) */

const dayOf = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 10);

/**
 * What the GPU sample store saw per UTC day and (project, region, stage) of each series, comparable with a day row's
 * peak (mergeDayRows keeps the most GPUs of any one sync): GPUs and VMs (instance, else node) are counted per hour
 * (a series with at least one sample in that hour), and the project's busiest hour of the day sets them, so VMs
 * replaced during the day are not added up. Utilisation is weighted by samples over the whole day. A lower bound on
 * what ran (a GPU without DCGM series is not seen), except that a VM replaced within one hour counts with its
 * successor in that hour.
 */
export function telemetryDayRows(series: GpuSeries[], hourly: GpuHourly[]): DailySummaryRow[] {
  const bySeries = new Map(series.map(s => [s.key, s]));
  const acc = new Map<string, DailySummaryRow>();
  // Per (day, project): per hour, per row key, the series and VMs that reported.
  const hours = new Map<string, Map<number, Map<string, { gpus: Set<string>; vms: Set<string> }>>>();
  for (const h of hourly) {
    const s = bySeries.get(h.key);
    if (!s || h.samples <= 0) continue;
    const day = dayOf(h.hour);
    const region = s.region ?? '';
    const stage = s.stage ?? '';
    const k = `${day}\u001f${s.projectId}\u001f${region}\u001f${stage}`;
    let v = acc.get(k);
    if (!v) {
      v = { day, projectId: s.projectId, region, stage, resources: 0, runningInstances: 0, gpus: 0, vcpus: 0, ttlExpired: 0, orphanCandidates: 0, gpuUtilSum: 0, gpuUtilSamples: 0 };
      acc.set(k, v);
    }
    if (h.utilAvg !== null) {
      v.gpuUtilSum += h.utilAvg * h.samples;
      v.gpuUtilSamples += h.samples;
    }
    const dp = `${day}\u001f${s.projectId}`;
    const perHour = hours.get(dp) ?? new Map();
    hours.set(dp, perHour);
    const perKey = perHour.get(h.hour) ?? new Map();
    perHour.set(h.hour, perKey);
    const seen = perKey.get(k) ?? { gpus: new Set<string>(), vms: new Set<string>() };
    perKey.set(k, seen);
    seen.gpus.add(s.key);
    seen.vms.add(s.instanceId ?? s.node);
  }
  for (const perHour of hours.values()) {
    const total = (m: Map<string, { gpus: Set<string>; vms: Set<string> }>) =>
      [...m.values()].reduce((a, x) => ({ gpus: a.gpus + x.gpus.size, vms: a.vms + x.vms.size }), { gpus: 0, vms: 0 });
    // The busiest hour: most GPUs, then most VMs, then the earliest.
    const [, peak] = [...perHour.entries()]
      .map(([hr, m]) => [hr, m, total(m)] as const)
      .sort((a, b) => b[2].gpus - a[2].gpus || b[2].vms - a[2].vms || a[0] - b[0])[0];
    for (const [k, seen] of peak) {
      const v = acc.get(k)!;
      v.gpus = seen.gpus.size;
      v.runningInstances = seen.vms.size;
    }
  }
  return [...acc.values()];
}

/**
 * Raises days the portal recorded with fewer GPUs than GPU telemetry saw in its busiest hour (#33: rows written before the per-day peak
 * of G2.5 kept only the day's last state, so a run torn down before the last sync read 0 GPUs). Compared per day and
 * project, so a series whose region or stage differs from the day row's is not counted twice: the deficit in GPUs and
 * running VMs is added to the project's row with the series' key when there is one, else to the project's first
 * row of the day, else to a new row; utilisation is taken from telemetry only when the day has none. Days the portal
 * did not record stay gaps; nothing is lowered; a second run changes nothing. `today` (YYYY-MM-DD, UTC) takes no
 * utilisation from telemetry: on a fresh start the first sync runs before the telemetry recorder, so its missing
 * utilisation is start-up order, not a gap in the record. Returns every row of each changed day (for
 * HistoryStore.replaceDays) and those days.
 */
export function backfillFromTelemetry(stored: DailySummaryRow[], telemetry: DailySummaryRow[], today?: string): { rows: DailySummaryRow[]; days: string[] } {
  const recorded = new Set(stored.map(r => r.day));
  const key = (r: DailySummaryRow) => `${r.day}\u001f${r.projectId}\u001f${r.region}\u001f${r.stage}`;
  const byDay = new Map<string, DailySummaryRow[]>();
  for (const r of stored) byDay.set(r.day, [...(byDay.get(r.day) ?? []), { ...r }]);
  const changed = new Set<string>();
  const telByDayProject = new Map<string, DailySummaryRow[]>();
  for (const t of telemetry) {
    if (!recorded.has(t.day)) continue;
    const k = `${t.day}\u001f${t.projectId}`;
    telByDayProject.set(k, [...(telByDayProject.get(k) ?? []), t]);
  }
  for (const tel of telByDayProject.values()) {
    const { day, projectId } = tel[0];
    const rows = byDay.get(day)!;
    const mine = rows.filter(r => r.projectId === projectId);
    const sum = (xs: DailySummaryRow[], f: (r: DailySummaryRow) => number) => xs.reduce((a, r) => a + f(r), 0);
    const gpuGap = sum(tel, r => r.gpus) - sum(mine, r => r.gpus);
    const vmGap = sum(tel, r => r.runningInstances) - sum(mine, r => r.runningInstances);
    const utilMissing = day !== today && sum(mine, r => r.gpuUtilSamples) === 0 && sum(tel, r => r.gpuUtilSamples) > 0;
    if (gpuGap <= 0 && !utilMissing) continue;
    // The telemetry key with the most GPUs names where the deficit lands.
    const main = [...tel].sort((a, b) => b.gpus - a.gpus)[0];
    let target = mine.find(r => key(r) === key(main)) ?? mine[0];
    if (!target) {
      target = { day, projectId, region: main.region, stage: main.stage, resources: 0, runningInstances: 0, gpus: 0, vcpus: 0, ttlExpired: 0, orphanCandidates: 0, gpuUtilSum: 0, gpuUtilSamples: 0 };
      rows.push(target);
    }
    if (gpuGap > 0) target.gpus += gpuGap;
    if (gpuGap > 0 && vmGap > 0) target.runningInstances += vmGap;
    if (utilMissing) {
      target.gpuUtilSum = sum(tel, r => r.gpuUtilSum);
      target.gpuUtilSamples = sum(tel, r => r.gpuUtilSamples);
    }
    target.telemetryBackfill = true;
    changed.add(day);
  }
  const days = [...changed].sort();
  return { rows: days.flatMap(d => byDay.get(d)!), days };
}
