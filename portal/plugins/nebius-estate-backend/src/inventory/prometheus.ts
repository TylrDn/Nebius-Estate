import { HttpClient } from '../lib/http';
import { TelemetrySnapshot } from './types';

/**
 * GPU utilisation from a configured Prometheus-compatible endpoint. The
 * repository installs dcgm-exporter with the NVIDIA device plugin and the
 * Marketplace grafana-and-prometheus release (platform/versions.yaml), so
 * DCGM_FI_DEV_GPU_UTIL is the documented metric to read. Cloud inventory
 * alone cannot supply utilisation; without this connector the UI says so.
 *
 * Grouped by Hostname (dcgm-exporter in a cluster) and instance_id (Nebius
 * Monitoring, which has no Hostname label; live-verified 2026-10-11 against
 * read.monitoring.api.nebius.cloud/projects/<project>/service-provider/prometheus).
 */
export const GPU_UTIL_QUERY = 'avg by (Hostname, instance_id) (DCGM_FI_DEV_GPU_UTIL)';

export class PrometheusConnector {
  constructor(private readonly baseUrl: string, private readonly http: HttpClient) {}

  async sync(now = new Date()): Promise<TelemetrySnapshot> {
    const q = new URLSearchParams({ query: GPU_UTIL_QUERY });
    const res = await this.http.request<{
      status: string;
      data?: { resultType: string; result: { metric: Record<string, string>; value: [number, string] }[] };
      error?: string;
    }>(`${this.baseUrl}/api/v1/query?${q.toString()}`);
    if (res.status !== 'success' || res.data?.resultType !== 'vector') {
      throw new Error(`Prometheus query failed: ${res.error ?? res.status}`);
    }
    return {
      source: 'prometheus',
      query: GPU_UTIL_QUERY,
      observedAt: now.toISOString(),
      samples: res.data.result
        .map(r => ({
          node: r.metric.Hostname ?? r.metric.node ?? r.metric.instance_id ?? r.metric.instance ?? 'unknown',
          // The VM id ties a sample to the inventory (and to the caller's project scope).
          ...(r.metric.instance_id ? { instanceId: r.metric.instance_id } : {}),
          gpuUtilPercent: Number(r.value[1]),
        }))
        .filter(s => Number.isFinite(s.gpuUtilPercent)),
    };
  }
}
