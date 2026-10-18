import { attributeWithParents, CapabilityState, CapabilityStatus, ConnectorStatus, GpuSample, GpuSeries, MAX_TRACKED_GPUS, minuteOf, ObservedResource, SAMPLE_METRICS, SAMPLE_RETENTION_DAYS, SampleField, seriesOf } from '@internal/nebius-domain';
import { mapLimit, redact } from '../lib/http';
import { classify, worst } from '../inventory/contract';
import { hintFor } from '../inventory/nebius';
import { SyncExtension } from '../inventory/extension';
import { MetricsClient } from './MetricsClient';
import { SampleStore } from './SampleStore';

export const HISTORY_CONNECTOR = 'nebius-metrics-history';
export const HISTORY_SOURCE = 'Nebius Monitoring (DCGM, query_range) → portal sample store';

/**
 * Back-fill window: a long gap (the first sync reads 7 days) is read and written one window at a time
 * per project, so memory holds at most one window of samples per project in flight.
 */
export const BACKFILL_WINDOW_SECONDS = 6 * 3600;

/** Latest Object Storage and volume figures per project (instant queries at each sync). */
export interface ServiceFigures {
  observedAt: string;
  buckets: { projectId: string; bucketId: string; bucket: string; requestRate: number | null; bytesSent: number | null; bytesReceived: number | null }[];
  disks: { projectId: string; id: string; kind: 'disk' | 'filesystem'; readBps: number | null; writeBps: number | null }[];
  failed: { projectId: string; error: string }[];
}

const SERVICE_QUERIES = {
  // Verified live 2026-10-11: these Object Storage series grow like counters (despite the name), so they are rated.
  requestRate: 'sum by (bucket_id, bucket) (rate(request_rate[5m]))',
  bytesSent: 'sum by (bucket_id, bucket) (rate(http_bytes_sent[5m]))',
  bytesReceived: 'sum by (bucket_id, bucket) (rate(http_bytes_received[5m]))',
  diskRead: 'sum by (disk) (rate(disk_read_bytes[5m]))',
  diskWrite: 'sum by (disk) (rate(disk_write_bytes[5m]))',
  fsRead: 'sum by (filestore) (rate(filestore_read_bytes[5m]))',
  fsWrite: 'sum by (filestore) (rate(filestore_write_bytes[5m]))',
} as const;

export interface RecorderDeps {
  store: SampleStore;
  /** Undefined while Nebius Monitoring is not configured (no projects or no identity). */
  client: () => MetricsClient | undefined;
  projects: () => string[];
  /** The latest inventory (Object Storage buckets, disks and filesystems to read figures for). */
  resources: () => ObservedResource[];
  maxConcurrency: number;
  syncIntervalMinutes: number;
  now?: () => Date;
}

/**
 * Writes GPU samples to the portal database on the inventory's sync loop (a SyncExtension: no
 * scheduler of its own). Each sync reads `query_range` from the newest stored sample of each project
 * (at most 7 days back) to now at a 1-minute step, in windows of BACKFILL_WINDOW_SECONDS written one
 * at a time, so a restart or an outage heals itself on the next sync without holding days of samples
 * in memory. A gap longer than one window is probed first with `max_over_time` at the window step:
 * a project without GPUs costs that one call. Also reads the Object Storage and volume figures for
 * the Fleet service panels.
 */
export class TelemetryRecorder implements SyncExtension {
  private figures?: ServiceFigures;
  private lastWrite?: { at: string; samples: number; series: number; refused: number };

  constructor(private readonly d: RecorderDeps) {}

  serviceFigures(): ServiceFigures | undefined {
    return this.figures;
  }

  lastRun() {
    return this.lastWrite;
  }

  definitions(): ConnectorStatus[] {
    const configured = Boolean(this.d.projects().length);
    return [
      {
        id: HISTORY_CONNECTOR,
        title: 'GPU metrics history (sample store)',
        state: configured ? 'starting' : 'not-configured',
        scope: configured ? `${this.d.projects().length} project${this.d.projects().length === 1 ? '' : 's'}` : '—',
        projects: configured ? this.d.projects().map(id => ({ id })) : undefined,
        permissions: 'viewer on each listed project',
        services: ['DCGM utilisation, temperature, power, framebuffer (query_range, 1-min)', 'Object Storage request rate and traffic', 'disk and filesystem throughput'],
        staleAfterMinutes: this.d.syncIntervalMinutes * 3,
        missingCoverage: ['PostgreSQL and MLflow metrics: no series on the read API for the listed projects (console dashboards only)'],
        setup: 'docs/portal/nebius-setup.md#telemetry',
      },
    ];
  }

  async sync(attempt: string, only?: string): Promise<{ statuses: (Partial<ConnectorStatus> & { id: string })[]; capabilities: CapabilityStatus[] }> {
    if (only && only !== HISTORY_CONNECTOR) return { statuses: [], capabilities: [] };
    const base = {
      id: 'monitoring.gpu-history', title: 'GPU metrics history (Nebius Monitoring, query_range)', service: 'monitoring', connector: HISTORY_CONNECTOR as CapabilityStatus['connector'],
      scope: 'project' as const, path: '/projects/{project}/service-provider/prometheus/api/v1/query_range', method: 'GET' as const, verified: '2026-10-11',
    };
    const client = this.d.client();
    if (!client) {
      const hint = 'Needs the Nebius connector: listed projects and a read-only identity (docs/portal/nebius-setup.md).';
      return { statuses: [{ id: HISTORY_CONNECTOR, state: 'not-configured', error: hint }], capabilities: [{ ...base, state: 'not-configured', lastAttempt: attempt, hint }] };
    }
    const now = minuteOf(Math.floor((this.d.now?.() ?? new Date()).getTime() / 1000));
    const newest = await this.d.store.newestPerProject();
    // Names from the inventory now, stored with each series (kept after the resources are deleted).
    // Region and stage too (G2.1): the global filter keeps a run's history after its VM is deleted.
    const byId = new Map(this.d.resources().map(r => [r.providerId, r]));
    const named = (x: GpuSeries): GpuSeries => {
      const n = (id: string | undefined) => (id ? byId.get(id)?.name : undefined);
      const vm = x.instanceId ? byId.get(x.instanceId) : undefined;
      const owner = vm ?? (x.nodeGroupId ? byId.get(x.nodeGroupId) : undefined) ?? (x.clusterId ? byId.get(x.clusterId) : undefined);
      const stage = owner ? (owner.labels['nip-stage'] ?? attributeWithParents(owner, byId).stage) : undefined;
      const region = owner?.region ?? (owner ? byId.get(x.projectId)?.region : undefined);
      const extra = { instanceName: n(x.instanceId), nodeGroupName: n(x.nodeGroupId), clusterName: n(x.clusterId), projectName: n(x.projectId), region, stage };
      return { ...x, ...Object.fromEntries(Object.entries(extra).filter(([, v]) => v !== undefined)) };
    };
    const started = Date.now();
    const outcomes: { project: string; state: CapabilityState; series: number; error?: string }[] = [];
    const written = { samples: 0, series: 0, refused: 0 };
    // Series with a sample in the last two sync intervals: reporting now, as opposed to kept from earlier.
    const live = new Set<string>();
    const liveSince = now - 2 * this.d.syncIntervalMinutes * 60;
    const W = BACKFILL_WINDOW_SECONDS;
    await mapLimit(this.d.projects(), this.d.maxConcurrency, async project => {
      // Re-read the last five minutes too: late points are merged, never duplicated.
      const from = Math.max(now - SAMPLE_RETENTION_DAYS * 86_400 + 60, (newest.get(project) ?? 0) - 300);
      try {
        // The probe's last evaluation is `now` and each looks back one window, so together they cover
        // [from, now] (an evaluation grid starting at `from` would leave the newest partial window out).
        const probeStart = now - Math.ceil((now - from) / W) * W;
        if (now - from > W && !(await client.queryRange(project, `max_over_time(${SAMPLE_METRICS.util}[${W}s])`, probeStart, now, W)).length) {
          outcomes.push({ project, state: 'ok', series: 0 }); // no GPU in the whole gap: one call
          return;
        }
        const found = new Set<string>();
        // Windows [start, start + W − 60 s] at a 1-minute step: no overlap, no gap; one written at a time.
        for (let start = from; start <= now; start += W) {
          const end = Math.min(now, start + W - 60);
          const series = new Map<string, GpuSeries>();
          const samples = new Map<string, GpuSample>();
          for (const [field, metric] of Object.entries(SAMPLE_METRICS) as [SampleField, string][]) {
            const res = await client.queryRange(project, metric, start, end, 60);
            if (field === 'util' && !res.length) break; // no GPU in this window: one call, not five
            for (const r of res) {
              const s = named(seriesOf(project, r.metric));
              series.set(s.key, s);
              found.add(s.key);
              for (const [t, v] of r.values) {
                const ts = minuteOf(t);
                if (ts >= liveSince) live.add(s.key);
                const k = `${s.key}\u001f${ts}`;
                const row = samples.get(k) ?? { key: s.key, ts };
                row[field] = v;
                samples.set(k, row);
              }
            }
          }
          if (!series.size) continue;
          const w = await this.d.store.write([...series.values()], [...samples.values()], now);
          written.samples += w.samples;
          written.refused += w.refused;
          written.series = w.series;
        }
        outcomes.push({ project, state: 'ok', series: found.size });
      } catch (e) {
        outcomes.push({ project, state: classify(e).state, series: 0, error: redact((e as Error).message) });
      }
    });
    if (!written.series) written.series = await this.d.store.seriesInWindow(now);
    this.lastWrite = { at: attempt, ...written };
    await this.readServices(client, attempt);
    const state = worst(outcomes.map(o => o.state));
    const failed = outcomes.find(o => o.state !== 'ok');
    const capability: CapabilityStatus = {
      ...base, state, items: written.samples, latencyMs: Date.now() - started, lastAttempt: attempt,
      lastSuccess: outcomes.some(o => o.state === 'ok') ? attempt : undefined, lastError: failed?.error,
      hint: written.refused
        ? `${written.refused} new GPU series were not stored: the store tracks at most ${MAX_TRACKED_GPUS} GPUs seen in the last 7 days (bounded size).`
        : hintFor(state, 'a `viewer` access permit on the project for the portal’s group (docs/credentials.md)'),
      perProject: new Set(outcomes.map(o => o.state)).size > 1 ? outcomes.map(o => ({ id: o.project, state: o.state, items: o.series, error: o.error })) : undefined,
    };
    return {
      statuses: [
        {
          id: HISTORY_CONNECTOR,
          state: state === 'ok' ? 'ok' : state === 'permission-denied' ? 'permission-denied' : outcomes.some(o => o.state === 'ok') ? 'ok' : 'error',
          lastSuccess: capability.lastSuccess,
          error: failed ? `${failed.project}: ${failed.error}` : undefined,
          notes: [`${written.series} GPU series seen in the last 7 days (${live.size ? `${live.size} live now` : 'none live now'}); ${written.samples} new samples written.`],
        },
      ],
      capabilities: [capability],
    };
  }

  /** Object Storage and volume figures for the projects whose inventory has buckets, disks or filesystems. */
  private async readServices(client: MetricsClient, attempt: string) {
    const rs = this.d.resources();
    const want = (types: string[]) => new Set(rs.filter(r => types.includes(r.type) && r.projectId).map(r => r.projectId!));
    const bucketProjects = want(['storage-bucket']);
    const volumeProjects = want(['compute-disk', 'compute-filesystem']);
    // Before the first inventory has landed (the first sync runs this in parallel with it), read every listed project.
    if (!rs.length) {
      for (const p of this.d.projects()) {
        bucketProjects.add(p);
        volumeProjects.add(p);
      }
    }
    const projects = this.d.projects().filter(p => bucketProjects.has(p) || volumeProjects.has(p));
    const out: ServiceFigures = { observedAt: attempt, buckets: [], disks: [], failed: [] };
    await mapLimit(projects, this.d.maxConcurrency, async project => {
      try {
        if (bucketProjects.has(project)) {
          const [rate, sent, received] = await Promise.all([client.query(project, SERVICE_QUERIES.requestRate), client.query(project, SERVICE_QUERIES.bytesSent), client.query(project, SERVICE_QUERIES.bytesReceived)]);
          const ids = new Map<string, string>();
          for (const r of [...rate, ...sent, ...received]) if (r.metric.bucket_id) ids.set(r.metric.bucket_id, r.metric.bucket ?? r.metric.bucket_id);
          const pick = (xs: typeof rate, id: string) => xs.find(x => x.metric.bucket_id === id)?.value ?? null;
          for (const [id, name] of ids) out.buckets.push({ projectId: project, bucketId: id, bucket: name, requestRate: pick(rate, id), bytesSent: pick(sent, id), bytesReceived: pick(received, id) });
        }
        if (volumeProjects.has(project)) {
          const [dr, dw, fr, fw] = await Promise.all([client.query(project, SERVICE_QUERIES.diskRead), client.query(project, SERVICE_QUERIES.diskWrite), client.query(project, SERVICE_QUERIES.fsRead), client.query(project, SERVICE_QUERIES.fsWrite)]);
          const add = (kind: 'disk' | 'filesystem', label: string, read: typeof dr, write: typeof dr) => {
            const ids = new Set([...read, ...write].map(x => x.metric[label]).filter(Boolean));
            for (const id of ids) out.disks.push({ projectId: project, id, kind, readBps: read.find(x => x.metric[label] === id)?.value ?? null, writeBps: write.find(x => x.metric[label] === id)?.value ?? null });
          };
          add('disk', 'disk', dr, dw);
          add('filesystem', 'filestore', fr, fw);
        }
      } catch (e) {
        out.failed.push({ projectId: project, error: redact((e as Error).message) });
      }
    });
    this.figures = out;
  }
}
