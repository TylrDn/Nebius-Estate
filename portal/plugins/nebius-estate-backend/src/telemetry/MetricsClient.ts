import { HttpClient } from '../lib/http';
import { MONITORING_PATHS } from '../inventory/monitoring';

type Json = Record<string, any>;

export interface InstantResult {
  metric: Record<string, string>;
  value: number;
  ts: number;
}
export interface RangeResult {
  metric: Record<string, string>;
  values: [number, number][];
}

/**
 * Prometheus-compatible read API of Nebius Monitoring for one project (service-provider metrics:
 * DCGM, node, disk, filestore and Object Storage series). GET only: query, query_range and the
 * metric-name list, all verified live 2026-10-11 with the portal's read-only identity.
 */
export class MetricsClient {
  constructor(private readonly http: HttpClient, private readonly base: string) {}

  private url(project: string, path: string, params: Record<string, string>) {
    return `${this.base}/projects/${encodeURIComponent(project)}/${MONITORING_PATHS.vm}/api/v1/${path}?${new URLSearchParams(params).toString()}`;
  }

  private static check(res: Json, what: string, type?: string) {
    if (res?.status !== 'success' || (type && res.data?.resultType !== type)) {
      throw new Error(`unexpected PromQL response for ${what}: ${String(res?.error ?? res?.status ?? 'no status').slice(0, 160)}`);
    }
  }

  async query(project: string, expr: string): Promise<InstantResult[]> {
    const res = await this.http.request<Json>(this.url(project, 'query', { query: expr }));
    MetricsClient.check(res, expr);
    const data = res.data;
    // A scalar comparison (e.g. `vector(1) > 0`) answers a scalar; alerting only uses vectors.
    if (data?.resultType !== 'vector' || !Array.isArray(data.result)) return [];
    return (data.result as { metric?: Record<string, string>; value?: [number, string] }[])
      .map(r => ({ metric: r.metric ?? {}, value: Number(r.value?.[1]), ts: Number(r.value?.[0]) }))
      .filter(r => Number.isFinite(r.value));
  }

  async queryRange(project: string, expr: string, startSec: number, endSec: number, stepSec: number): Promise<RangeResult[]> {
    const res = await this.http.request<Json>(this.url(project, 'query_range', { query: expr, start: String(startSec), end: String(endSec), step: String(stepSec) }));
    MetricsClient.check(res, expr, 'matrix');
    return ((res.data.result ?? []) as { metric?: Record<string, string>; values?: [number, string][] }[]).map(r => ({
      metric: r.metric ?? {},
      values: (r.values ?? []).map(([t, v]) => [Number(t), Number(v)] as [number, number]).filter(([, v]) => Number.isFinite(v)),
    }));
  }

  async metricNames(project: string): Promise<string[]> {
    const res = await this.http.request<Json>(`${this.base}/projects/${encodeURIComponent(project)}/${MONITORING_PATHS.vm}/api/v1/label/__name__/values`);
    MetricsClient.check(res, '__name__ values');
    return Array.isArray(res.data) ? res.data.map(String) : [];
  }
}
