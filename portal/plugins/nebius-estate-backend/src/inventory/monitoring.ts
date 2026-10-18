import { CapabilityState, GpuTelemetryView } from '@internal/nebius-domain';
import { HttpClient, mapLimit, redact } from '../lib/http';
import { classify } from './contract';
import { NEBIUS_MONITORING } from './endpoints';

type Json = Record<string, any>;

/**
 * GPU telemetry from Nebius Monitoring, with no cluster or exporter of our
 * own: the PromQL read API per project
 * (`/projects/<project>/service-provider/prometheus/api/v1/query`), which
 * carries the GPU metrics Nebius publishes for VMs (docs.nebius.com,
 * compute/monitoring/virtual-machines). Read with the same read-only identity
 * as the inventory. A project without GPU VMs simply returns no series.
 *
 * The label that carries the VM id is not documented; the candidates below are
 * tried in order and a series without one is kept under its host label.
 */
export const GPU_METRICS = {
  utilPercent: 'DCGM_FI_DEV_GPU_UTIL',
  tempC: 'DCGM_FI_DEV_GPU_TEMP',
  powerW: 'DCGM_FI_DEV_POWER_USAGE',
  memoryUsedMiB: 'DCGM_FI_DEV_FB_USED',
  memoryTotalMiB: 'DCGM_FI_DEV_FB_TOTAL',
} as const;

const INSTANCE_LABELS = ['instance_id', 'compute_instance_id', 'resource_id', 'vm_id', 'id', 'instance'];
const GPU_LABELS = ['gpu', 'gpu_id', 'gpu_index', 'GPU_I_ID', 'device', 'minor_number'];
const HOST_LABELS = ['Hostname', 'hostname', 'host', 'node', 'instance'];

export const MONITORING_SOURCE = 'Nebius Monitoring (service-provider GPU metrics)';
/** Series the observability agent on an MK8s cluster writes to the project's own Monitoring (dcgm-exporter on GPU nodes). */
export const AGENT_SOURCE = 'Nebius Monitoring (observability agent, dcgm-exporter)';
/** Service-provider metrics for VMs, and the user-ingested series of the project (what the cluster agent pushes). */
export const MONITORING_PATHS = { vm: 'service-provider/prometheus', agent: 'prometheus' } as const;

/** One list of GPUs from both sources: the same GPU (project, VM or host, index) appears once, gaps filled from the other. */
export function mergeGpus(first: GpuTelemetryView[], second: GpuTelemetryView[]): GpuTelemetryView[] {
  const key = (g: GpuTelemetryView) => `${g.projectId ?? ''}|${g.instanceId ?? g.node}|${g.gpu ?? ''}`;
  const out = new Map(first.map(g => [key(g), { ...g }]));
  for (const g of second) {
    const k = key(g);
    const have = out.get(k);
    if (!have) out.set(k, { ...g });
    else for (const [f, v] of Object.entries(g)) if ((have as Record<string, unknown>)[f] === undefined) (have as Record<string, unknown>)[f] = v;
  }
  return [...out.values()];
}

export interface MonitoringResult {
  gpus: GpuTelemetryView[];
  outcomes: { project: string; state: CapabilityState; series: number; latencyMs: number; error?: string }[];
  observedAt: string;
}

export class NebiusMonitoringConnector {
  constructor(
    private readonly http: HttpClient,
    private readonly opts: { projects: string[]; maxConcurrency: number; base?: string; now?: () => Date; path?: string; source?: string },
  ) {}

  private url(project: string, query: string) {
    return `${this.opts.base ?? NEBIUS_MONITORING}/projects/${encodeURIComponent(project)}/${this.opts.path ?? MONITORING_PATHS.vm}/api/v1/query?${new URLSearchParams({ query }).toString()}`;
  }

  async sync(): Promise<MonitoringResult> {
    const observedAt = (this.opts.now?.() ?? new Date()).toISOString();
    const gpus = new Map<string, GpuTelemetryView>();
    const outcomes: MonitoringResult['outcomes'] = [];
    await mapLimit(this.opts.projects, this.opts.maxConcurrency, async project => {
      const started = Date.now();
      let series = 0;
      try {
        for (const [field, metric] of Object.entries(GPU_METRICS) as [keyof typeof GPU_METRICS, string][]) {
          const res = await this.http.request<Json>(this.url(project, metric));
          if (res?.status !== 'success' || res.data?.resultType !== 'vector' || !Array.isArray(res.data.result)) {
            throw new Error(`unexpected PromQL response for ${metric}: ${String(res?.error ?? res?.status).slice(0, 120)}`);
          }
          for (const r of res.data.result as { metric?: Record<string, string>; value?: [number, string] }[]) {
            const v = Number(r.value?.[1]);
            if (!Number.isFinite(v)) continue;
            const labels = r.metric ?? {};
            const instanceId = INSTANCE_LABELS.map(k => labels[k]).find(x => typeof x === 'string' && x.startsWith('computeinstance-'));
            const host = HOST_LABELS.map(k => labels[k]).find(Boolean) ?? instanceId ?? 'unknown';
            const gpu = GPU_LABELS.map(k => labels[k]).find(x => x !== undefined);
            const key = `${project}|${instanceId ?? host}|${gpu ?? ''}`;
            const g = gpus.get(key) ?? {
              instanceId, node: host, gpu, projectId: project, source: this.opts.source ?? MONITORING_SOURCE,
              // Live (2026-10-11): the observability agent's DCGM series carry the MK8s cluster and node group.
              mk8sClusterId: labels.mk8s_cluster_id || undefined, mk8sNodeGroupId: labels.mk8s_node_group_id || undefined,
            };
            g[field] = v;
            gpus.set(key, g);
            series++;
          }
        }
        outcomes.push({ project, state: 'ok', series, latencyMs: Date.now() - started });
      } catch (e) {
        outcomes.push({ project, state: classify(e).state, series, latencyMs: Date.now() - started, error: redact((e as Error).message) });
      }
    });
    return { gpus: [...gpus.values()], outcomes, observedAt };
  }
}
