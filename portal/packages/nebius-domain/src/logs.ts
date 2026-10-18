/**
 * Nebius Observability Logs: the Loki-compatible read API per project
 * (`read.logging.api.nebius.cloud/projects/<project>/loki/api/v1/…`). Buckets, presets, query
 * building and validation against the documented LogQL limits
 * (docs.nebius.com/observability/logs/query-language#limitations). Pure; the backend does the GETs.
 */

export interface LogBucketDef {
  id: string;
  service: string;
  /** What the bucket holds, as documented. */
  description: string;
}

/** Documented buckets (docs.nebius.com/observability/logs/query-language#stream-selectors). */
export const LOG_BUCKETS: LogBucketDef[] = [
  { id: 'sp_serial', service: 'Compute VMs', description: 'Serial console of every VM' },
  { id: 'sp_mk8s_control_plane', service: 'Managed Kubernetes control plane', description: 'Control-plane components (API server, scheduler, autoscaler, CCM)' },
  { id: 'sp_mk8s_audit_logs', service: 'Managed Kubernetes audit', description: 'Kubernetes audit log (when enabled on the cluster)' },
  { id: 'sp_k8srelease', service: 'Applications for Managed Kubernetes', description: 'Marketplace releases on clusters' },
  { id: 'sp_postgres', service: 'Managed PostgreSQL', description: 'PostgreSQL and pooler logs' },
  { id: 'sp_mlflow', service: 'Managed MLflow', description: 'MLflow server logs' },
  { id: 'sp_cloudapps', service: 'Standalone Applications', description: 'Standalone application logs' },
  { id: 'default', service: 'Your workloads (observability agent)', description: 'Logs the observability agent or an OpenTelemetry collector ingests' },
];

export const LOG_BUCKET_IDS = LOG_BUCKETS.map(b => b.id);
export const MAX_LOG_LINES = 1000;
export const MAX_LOG_RANGE_SECONDS = 7 * 86_400;

export interface LogPreset {
  id: string;
  label: string;
  bucket: string;
  query: string;
  description: string;
}

/** Ready-made searches. Line filters only: the documented stream label is __bucket__; other labels vary by service. */
export const LOG_PRESETS: LogPreset[] = [
  {
    id: 'serial-errors',
    label: 'Serial-console errors',
    bucket: 'sp_serial',
    // systemd's success lines ("[  OK  ] Stopped … that failed at package install time", with or without colour
    // codes) matched "fail" and topped the live results (G3.15); `[[]` is a literal "[" without escapes.
    query: '{__bucket__="sp_serial"} |~ "(?i)(error|fail|panic|xid|nvrm|call trace)" !~ "[[](.[[][0-9;]*m)? +OK +"',
    description: 'Kernel and boot errors on VMs: GPU Xid and NVRM messages, failed services, panics (systemd OK lines left out).',
  },
  {
    id: 'control-plane-errors',
    label: 'Control-plane errors',
    bucket: 'sp_mk8s_control_plane',
    query: '{__bucket__="sp_mk8s_control_plane"} |~ "(?i)(error|fail|denied|quota)"',
    description: 'Errors from Managed Kubernetes control-plane components, including the autoscaler (quota and capacity).',
  },
  {
    id: 'postgres-errors',
    label: 'PostgreSQL errors',
    bucket: 'sp_postgres',
    query: '{__bucket__="sp_postgres"} |~ "ERROR|FATAL|PANIC"',
    description: 'ERROR, FATAL and PANIC lines from Managed PostgreSQL clusters.',
  },
];

const escapeLogQL = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

/** A stream selector for a bucket, optionally narrowed to one resource (sp_resource_id, verified live on sp_serial) and a text. */
export function buildLogQuery(o: { bucket: string; resourceId?: string; contains?: string }): string {
  const sel = [`__bucket__="${escapeLogQL(o.bucket)}"`];
  if (o.resourceId) sel.push(`sp_resource_id="${escapeLogQL(o.resourceId)}"`);
  return `{${sel.join(', ')}}${o.contains ? ` |= "${escapeLogQL(o.contains)}"` : ''}`;
}

/** Functions the Nebius LogQL implementation refuses (documented limitations). */
const UNSUPPORTED = ['bytes_rate', 'bytes_over_time', 'absent_over_time', 'sort_desc', 'sort', 'vector', 'approx_topk'];
/** Metric queries return numbers, not lines; this page shows lines. */
const METRIC_FUNCTIONS = ['rate', 'count_over_time', 'sum_over_time', 'avg_over_time', 'max_over_time', 'min_over_time', 'quantile_over_time', 'first_over_time', 'last_over_time', 'stddev_over_time', 'stdvar_over_time', 'rate_counter', 'sum', 'avg', 'min', 'max', 'count', 'topk', 'bottomk'];

export interface LogQueryCheck {
  ok: boolean;
  errors: string[];
  /** The bucket named in the selector, when there is exactly one. */
  bucket?: string;
}

/** Checks a free LogQL query before it is sent: a log (not metric) query with one known __bucket__, balanced and bounded. */
export function validateLogQL(query: string): LogQueryCheck {
  const errors: string[] = [];
  const q = query.trim();
  if (!q) return { ok: false, errors: ['Enter a query, e.g. {__bucket__="sp_serial"} |= "error".'] };
  if (q.length > 2000) errors.push('The query is longer than 2000 characters.');
  // Strings out of the way before structural checks.
  const bare = q.replace(/"(?:[^"\\]|\\.)*"|`[^`]*`/g, '_s_');
  if (/["`]/.test(bare)) errors.push('A string is not closed: every " or ` needs its pair.');
  let depth = 0;
  for (const ch of bare) {
    if (ch === '{' || ch === '(') depth++;
    if (ch === '}' || ch === ')') depth--;
    if (depth < 0) break;
  }
  if (depth !== 0) errors.push('Brackets are not balanced.');
  const fn = (names: string[]) => names.find(n => new RegExp(`(^|[^A-Za-z0-9_])${n}\\s*(\\(|by\\b|without\\b)`).test(bare));
  const unsupported = fn(UNSUPPORTED);
  if (unsupported) errors.push(`${unsupported} is not supported by Nebius Logs (see the documented limitations).`);
  if (/\bwithout\s*\(/.test(bare)) errors.push('`without` aggregation is not supported by Nebius Logs.');
  const metric = fn(METRIC_FUNCTIONS);
  if (metric && !unsupported) errors.push(`${metric}(…) is a metric query; this page shows log lines. Remove the aggregation.`);
  if (!bare.startsWith('{')) errors.push('A log query starts with a stream selector, e.g. {__bucket__="sp_serial"}.');
  const buckets = [...q.matchAll(/__bucket__\s*=\s*"([^"]*)"/g)].map(m => m[1]);
  if (!buckets.length) errors.push('The selector must name a bucket: __bucket__="<bucket>" (Nebius Logs returns nothing without it).');
  else if (new Set(buckets).size > 1) errors.push('Name one bucket per query.');
  else if (!LOG_BUCKET_IDS.includes(buckets[0])) errors.push(`Unknown bucket "${buckets[0]}". Documented buckets: ${LOG_BUCKET_IDS.join(', ')}.`);
  if (/__bucket__\s*(!=|=~|!~)/.test(q)) errors.push('Select the bucket with = (exact match).');
  return { ok: errors.length === 0, errors, bucket: buckets.length === 1 ? buckets[0] : undefined };
}

/** Terminal colour codes and carriage returns as they arrive from serial consoles, removed for display. */
export function cleanLogLine(line: string): string {
  // eslint-disable-next-line no-control-regex
  return line.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\r+$/g, '').replace(/\r/g, '');
}

export interface LogLine {
  /** Nanoseconds since the epoch, as a string (exact). */
  ts: string;
  /** ISO time (millisecond precision) for display. */
  time: string;
  line: string;
  labels: Record<string, string>;
}

/** Streams → lines, newest first, at most `limit`. */
export function flattenStreams(result: { stream?: Record<string, string>; values?: [string, string][] }[], limit = MAX_LOG_LINES): LogLine[] {
  const out: LogLine[] = [];
  for (const s of result) {
    for (const [ts, line] of s.values ?? []) {
      out.push({ ts, time: new Date(Number(BigInt(ts) / 1_000_000n)).toISOString(), line: cleanLogLine(String(line)), labels: s.stream ?? {} });
    }
  }
  out.sort((a, b) => (BigInt(b.ts) > BigInt(a.ts) ? 1 : BigInt(b.ts) < BigInt(a.ts) ? -1 : 0));
  return out.slice(0, limit);
}

/* ------------------------------------------------------------ API contracts */

export interface LogBucketStatus extends LogBucketDef {
  /** present: the bucket has data in the window; no-logs-yet: Nebius has not created it (the service wrote nothing). */
  state: 'present' | 'no-logs-yet' | 'unknown';
  note?: string;
  /** The newest line's time in the last 7 days, when it could be read: the page opens on a bucket that has lines. */
  newest?: string;
}

export interface LogBucketsResponse {
  project: { id: string; name?: string };
  projects: { id: string; name?: string }[];
  /**
   * With no project asked for: the projects in scope with log buckets in the last 7 days; `recent` when they also
   * have logs in the last 24 h. The page opens on the first recent one, else the first (G3.14).
   */
  /** recent: a line in the last 24 h; newest: the newest line's time, when it could be read (#31). */
  projectsWithLogs?: { id: string; name?: string; buckets: string[]; recent?: boolean; newest?: string }[];
  buckets: LogBucketStatus[];
  presets: LogPreset[];
  source: string;
  /** Set when the buckets could not be listed (the reason and what to do). */
  unavailableReason?: string;
}

export interface LogsResponse {
  project: string;
  bucket: string;
  query: string;
  start: string;
  end: string;
  lines: LogLine[];
  limit: number;
  /** The limit was reached: older lines in the window are not shown. */
  truncated: boolean;
  /** no-logs-yet: Nebius answered "logging bucket … not found" (the service has written nothing to this project). */
  bucketState: 'ok' | 'no-logs-yet';
  note?: string;
  source: string;
  observedAt: string;
}
