import { CapabilityState, CapabilityStatus, ConnectorStatus, flattenStreams, LogLine } from '@internal/nebius-domain';
import { HttpClient, HttpError, mapLimit, redact } from '../lib/http';
import { classify, worst } from '../inventory/contract';
import { hintFor } from '../inventory/nebius';
import { SyncExtension } from '../inventory/extension';

export { NEBIUS_LOGGING } from '../inventory/endpoints';
export const LOGS_CONNECTOR = 'nebius-logging';
export const LOGS_SOURCE = 'Nebius Observability Logs (Loki read API)';

type Json = Record<string, any>;

/** "logging bucket with id=<b> not found": the service has written nothing to this project yet (verified live 2026-10-11). */
export class BucketNotFoundError extends Error {
  constructor(readonly bucket: string) {
    super(`logging bucket ${bucket} not found`);
    this.name = 'BucketNotFoundError';
  }
}

/** A query Nebius Logs refused (400), with its own message (e.g. "invalid query: …"). */
export class LogQueryRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LogQueryRejectedError';
  }
}

/**
 * A query Nebius Logs accepted but could not run (HTTP 500 from query_range, verified live 2026-10-12): e.g. a
 * `| json` stage on a bucket whose lines are plain text. Deterministic, so not retried; said without the upstream URL.
 */
export class LogQueryFailedError extends Error {
  constructor(readonly status: number) {
    super(`Nebius Logs could not run this query (HTTP ${status}). Parser stages such as | json fail on buckets whose lines are not JSON (sp_serial is plain text); use a line filter (|= "text") instead.`);
    this.name = 'LogQueryFailedError';
  }
}

const ns = (ms: number) => `${BigInt(Math.floor(ms)) * 1_000_000n}`;

/** GET only: labels, label values and query_range per project. `start`/`end` are required by the API, in ns. */
export class LogsClient {
  constructor(private readonly http: HttpClient, private readonly base: string) {}

  private url(project: string, path: string, params: Record<string, string>) {
    return `${this.base}/projects/${encodeURIComponent(project)}/loki/api/v1/${path}?${new URLSearchParams(params).toString()}`;
  }

  private async get(url: string, bucket?: string, query = false): Promise<Json> {
    try {
      return await this.http.request<Json>(url, {}, { retry500: !query });
    } catch (e) {
      if (query && e instanceof HttpError && e.status === 500) throw new LogQueryFailedError(500);
      if (e instanceof HttpError && e.status === 404 && /logging bucket with id=/.test(e.message)) throw new BucketNotFoundError(bucket ?? /id=([a-z0-9_]+)/.exec(e.message)?.[1] ?? '?');
      if (e instanceof HttpError && e.status === 400) throw new LogQueryRejectedError(e.message.replace(/^GET \S+ → 400: /, '').replace(/^"|"$/g, ''));
      throw e;
    }
  }

  async labels(project: string, startMs: number, endMs: number): Promise<string[]> {
    const res = await this.get(this.url(project, 'labels', { start: ns(startMs), end: ns(endMs) }));
    if (res?.status !== 'success') throw new Error(`unexpected Loki labels response: ${String(res?.status).slice(0, 80)}`);
    return Array.isArray(res.data) ? res.data.map(String) : [];
  }

  async buckets(project: string, startMs: number, endMs: number): Promise<string[]> {
    const res = await this.get(this.url(project, 'label/__bucket__/values', { start: ns(startMs), end: ns(endMs) }));
    if (res?.status !== 'success') throw new Error(`unexpected Loki label values response: ${String(res?.status).slice(0, 80)}`);
    return Array.isArray(res.data) ? res.data.map(String) : [];
  }

  async queryRange(project: string, bucket: string, query: string, startMs: number, endMs: number, limit: number): Promise<LogLine[]> {
    const res = await this.get(this.url(project, 'query_range', { query, start: ns(startMs), end: ns(endMs), limit: String(limit), direction: 'backward' }), bucket, true);
    if (res?.status !== 'success' || res.data?.resultType !== 'streams') {
      throw new LogQueryRejectedError(res?.data?.resultType ? `The query returned ${res.data.resultType}, not log lines: remove the aggregation.` : `unexpected Loki response: ${String(res?.status).slice(0, 80)}`);
    }
    return flattenStreams(res.data.result ?? [], limit);
  }
}

/**
 * The Logs connector on the inventory's sync loop: one `labels` call per listed project shows that
 * the identity can read logs (Integrations, health). Log lines themselves are read on demand from
 * the Logs page, never stored.
 */
export class LogsExtension implements SyncExtension {
  constructor(private readonly d: { client: () => LogsClient | undefined; projects: () => string[]; maxConcurrency: number; syncIntervalMinutes: number; now?: () => Date }) {}

  definitions(): ConnectorStatus[] {
    const n = this.d.projects().length;
    return [
      {
        id: LOGS_CONNECTOR,
        title: 'Logs (Nebius Logs API)',
        state: n ? 'starting' : 'not-configured',
        scope: n ? `${n} project${n === 1 ? '' : 's'}` : '—',
        projects: n ? this.d.projects().map(id => ({ id })) : undefined,
        permissions: 'viewer on each listed project',
        services: ['serial consoles', 'MK8s control plane and audit', 'Kubernetes releases', 'PostgreSQL', 'MLflow', 'Standalone Applications', 'user-ingested'],
        staleAfterMinutes: this.d.syncIntervalMinutes * 3,
        missingCoverage: ['Log-based alerts: Nebius Logs does not evaluate alerts on aggregated values (documented limitation)'],
        setup: 'docs/portal/nebius-setup.md#logs',
      },
    ];
  }

  async sync(attempt: string, only?: string) {
    if (only && only !== LOGS_CONNECTOR) return { statuses: [], capabilities: [] };
    const base = {
      id: 'logs.labels', title: 'Logs read (Nebius Observability Logs, Loki label values)', service: 'observability', connector: LOGS_CONNECTOR as CapabilityStatus['connector'], scope: 'project' as const,
      path: '/projects/{project}/loki/api/v1/label/__bucket__/values', method: 'GET' as const, verified: '2026-10-11',
    };
    const client = this.d.client();
    if (!client) {
      const hint = 'Needs the Nebius connector: listed projects and a read-only identity (docs/portal/nebius-setup.md).';
      return { statuses: [{ id: LOGS_CONNECTOR, state: 'not-configured' as const, error: hint }], capabilities: [{ ...base, state: 'not-configured' as const, lastAttempt: attempt, hint }] };
    }
    const end = (this.d.now?.() ?? new Date()).getTime();
    const started = Date.now();
    const outcomes: { project: string; state: CapabilityState; items: number; error?: string }[] = [];
    await mapLimit(this.d.projects(), this.d.maxConcurrency, async project => {
      try {
        outcomes.push({ project, state: 'ok', items: (await client.buckets(project, end - 86_400_000, end)).length });
      } catch (e) {
        outcomes.push({ project, state: classify(e).state, items: 0, error: redact((e as Error).message) });
      }
    });
    const state = worst(outcomes.map(o => o.state));
    const failed = outcomes.find(o => o.state !== 'ok');
    const capability: CapabilityStatus = {
      ...base, state, items: outcomes.reduce((a, o) => a + o.items, 0), latencyMs: Date.now() - started, lastAttempt: attempt,
      lastSuccess: outcomes.some(o => o.state === 'ok') ? attempt : undefined, lastError: failed?.error,
      hint: hintFor(state, 'a `viewer` access permit on the project for the portal’s group (docs/credentials.md)'),
      perProject: new Set(outcomes.map(o => o.state)).size > 1 ? outcomes.map(o => ({ id: o.project, state: o.state, items: o.items, error: o.error })) : undefined,
    };
    return {
      statuses: [
        {
          id: LOGS_CONNECTOR,
          state: (state === 'ok' ? 'ok' : state === 'permission-denied' ? 'permission-denied' : outcomes.some(o => o.state === 'ok') ? 'ok' : 'error') as ConnectorStatus['state'],
          lastSuccess: capability.lastSuccess,
          error: failed ? `${failed.project}: ${failed.error}` : undefined,
          notes: [`${capability.items} log buckets with data (24 h).`],
        },
      ],
      capabilities: [capability],
    };
  }
}
