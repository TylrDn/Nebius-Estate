// TEST ONLY: the routing of the Nebius API stub, shared by nebius-stub.mjs (Playwright) and the
// backend unit tests (mocked fetch). Documented shapes only; every value is invented (e00mock).
'use strict';
const { readFileSync } = require('fs');
const { join } = require('path');

const estate = JSON.parse(readFileSync(join(__dirname, 'estate.json'), 'utf8'));
const { createHash } = require('crypto');

/* ---- S3-compatible billing export bucket (path-style, SigV4 header checked for shape) ---- */
const EXPORT_BUCKET = 'e00mock-billing-export';
const EXPORT_FILES = { 'focus/focus-export-2026-10-06.csv.gz': readFileSync(join(__dirname, 'billing-export', 'focus-export-2026-10-06.csv.gz')) };
const xmlEscape = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function objectStorage(url, headers) {
  const auth = headers.authorization || headers.Authorization || '';
  if (!/^AWS4-HMAC-SHA256 Credential=[^/]+\/\d{8}\/[a-z0-9-]+\/s3\/aws4_request, SignedHeaders=[a-z0-9;-]+, Signature=[0-9a-f]{64}$/.test(auth)) {
    return { status: 403, raw: Buffer.from('<Error><Code>AccessDenied</Code></Error>'), contentType: 'application/xml' };
  }
  const [, bucket, ...rest] = url.pathname.split('/');
  if (bucket !== EXPORT_BUCKET) return { status: 404, raw: Buffer.from('<Error><Code>NoSuchBucket</Code></Error>'), contentType: 'application/xml' };
  if (rest.length) {
    const key = rest.map(decodeURIComponent).join('/');
    const file = EXPORT_FILES[key];
    return file ? { status: 200, raw: file, contentType: 'application/gzip' } : { status: 404, raw: Buffer.from('<Error><Code>NoSuchKey</Code></Error>'), contentType: 'application/xml' };
  }
  const prefix = url.searchParams.get('prefix') || '';
  const contents = Object.entries(EXPORT_FILES)
    .filter(([k]) => k.startsWith(prefix))
    .map(([k, b]) => `<Contents><Key>${xmlEscape(k)}</Key><LastModified>2026-10-07T00:00:00.000Z</LastModified><ETag>&quot;${createHash('md5').update(b).digest('hex')}&quot;</ETag><Size>${b.length}</Size><StorageClass>STANDARD</StorageClass></Contents>`)
    .join('');
  return { status: 200, raw: Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${EXPORT_BUCKET}</Name><Prefix>${xmlEscape(prefix)}</Prefix><KeyCount>${contents ? 1 : 0}</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`), contentType: 'application/xml' };
}
const TENANT = 'tenant-e00mocktest';

const ok = body => ({ status: 200, body });
const err = (status, code, message) => ({ status, body: { code, message } });

/** Invented per-hour prices (XTS) by spec, in the calculator's response shape. */
function price(spec) {
  const type = String(spec['@type'] || '');
  let cost;
  let unit = 'hour';
  if (type.endsWith('CreateInstanceRequest')) {
    const preset = String(spec.spec?.resources?.preset || '');
    const m = /^(?:(\d+)gpu-)?(\d+)vcpu-(\d+)gb$/.exec(preset);
    if (!m) return null;
    cost = Number(m[1] || 0) * 2.5 + Number(m[2]) * 0.01 + Number(m[3]) * 0.002;
    if (spec.spec?.preemptible) cost = cost * 0.4;
  } else if (type.endsWith('CreateDiskRequest') || type.endsWith('CreateFilesystemRequest')) {
    cost = Number(spec.spec?.sizeGibibytes || 0) * 0.0001;
  } else if (type.endsWith('postgresql.v1alpha1.CreateClusterRequest')) {
    // As live (2026-10-11): the template is priced, hosts multiply the whole template.
    const t = spec.spec?.config?.template || {};
    const m = /^(\d+)vcpu-(\d+)gb$/.exec(String(t.resources?.preset || ''));
    if (!m) return null;
    cost = (Number(m[1]) * 0.01 + Number(m[2]) * 0.002 + Number(t.disk?.sizeGibibytes || 0) * 0.0001) * Number(t.hosts?.count || 1);
  } else if (type.endsWith('mlflow.v1alpha1.CreateClusterRequest')) {
    return 'internal'; // live answers HTTP 500 "internal error" for MLflow create requests (2026-10-11)
  } else {
    return { unitType: 'UNIT_TYPE_USAGE_BASED', unit: 'gibibyte', cost: '0' };
  }
  return { unitType: 'UNIT_TYPE_TIME_BASED', unit, cost: cost.toFixed(6) };
}

function calculator(body) {
  // Contract prices answer since the tenant grants (equal to list on this account).
  const costs = [];
  for (const r of body.resourceSpecs || []) {
    const p = price(r.spec || {});
    if (!p) return err(400, 3, 'invalid preset');
    if (p === 'internal') return err(500, 13, 'internal error');
    const breakdown = { skuCosts: [{ skuId: 'sku-e00mock', quantity: '1', quantityRounded: '1', cost: p.cost, costRounded: p.cost }], cost: p.cost, costRounded: p.cost };
    costs.push({ metadata: r.spec?.metadata || {}, aggregationUnit: { unit: p.unit, unitType: p.unitType }, general: { total: breakdown } });
  }
  return ok({ resourceCosts: costs, totalCosts: [], currency: body.currency });
}

const telemetry = JSON.parse(readFileSync(join(__dirname, 'telemetry.json'), 'utf8'));

/** `METRIC`, `METRIC op N`, `max_over_time(METRIC[w])`, or an aggregation over a service series (Object Storage, disks) the stub knows. */
function parsePromQL(query) {
  const inc = /^\s*increase\(\s*([A-Za-z_:][A-Za-z0-9_:]*)\[[^\]]+\]\s*\)\s*(<=|>=|==|!=|<|>)\s*(-?\d+(?:\.\d+)?)\s*$/.exec(query);
  if (inc) return { increase: inc[1], op: inc[2], threshold: Number(inc[3]) };
  // The recorder's back-fill probe: max_over_time(METRIC[window]) answers the series that had any point.
  const over = /^\s*max_over_time\(\s*([A-Za-z_:][A-Za-z0-9_:]*)\[[^\]]+\]\s*\)\s*$/.exec(query);
  if (over) return { metric: over[1] };
  const cmp = /^\s*([A-Za-z_:][A-Za-z0-9_:]*)\s*(?:(<=|>=|==|!=|<|>)\s*(-?\d+(?:\.\d+)?))?\s*$/.exec(query);
  if (cmp) return { metric: cmp[1], op: cmp[2], threshold: cmp[3] === undefined ? undefined : Number(cmp[3]) };
  const svc = /\b(request_rate|http_bytes_sent|http_bytes_received|disk_read_bytes|disk_write_bytes|filestore_read_bytes|filestore_write_bytes)\b/.exec(query);
  return svc ? { service: svc[1] } : {};
}
const holds = (v, op, t) => op === undefined || (op === '<' ? v < t : op === '<=' ? v <= t : op === '>' ? v > t : op === '>=' ? v >= t : op === '==' ? v === t : v !== t);
const gpuLabels = s => ({ instance_id: s.instance_id, gpu: s.gpu, Hostname: s.Hostname, ...(s.namespace ? { namespace: s.namespace } : {}), ...(s.mk8s_cluster_id ? { mk8s_cluster_id: s.mk8s_cluster_id, mk8s_node_group_id: s.mk8s_node_group_id, job: s.job } : {}) });
/** A deterministic history around the current value: utilisation dips below 5 % for part of every two hours on the lab GPU. */
const valueAt = (base, metric, t) => (metric === 'DCGM_FI_DEV_GPU_UTIL' ? Math.max(0, Math.round(base * (0.55 + 0.45 * Math.sin(t / 1200)) * 10) / 10) : base);

function monitoring(project, query, source = estate.monitoring) {
  const q = parsePromQL(query);
  if (q.increase) {
    const rows = (((telemetry.increases || {})[project] || {})[q.increase] || [])
      .filter(r => holds(r.value, q.op, q.threshold))
      .map(({ value, ...labels }) => ({ metric: labels, value: [1760184000, String(value)] }));
    return ok({ status: 'success', data: { resultType: 'vector', result: rows } });
  }
  if (q.service) {
    const rows = ((telemetry.services[project] || {})[q.service] || []).map(({ value, ...labels }) => ({ metric: labels, value: [1760184000, String(value)] }));
    return ok({ status: 'success', data: { resultType: 'vector', result: rows } });
  }
  const series = (source[project] || [])
    .filter(s => s.values[q.metric] !== undefined && holds(s.values[q.metric], q.op, q.threshold))
    .map(s => ({ metric: { __name__: q.metric, ...gpuLabels(s) }, value: [1760184000, String(s.values[q.metric])] }));
  return ok({ status: 'success', data: { resultType: 'vector', result: series } });
}

function monitoringRange(project, query, start, end, step) {
  const q = parsePromQL(query);
  if (!(end >= start) || !(step > 0) || (end - start) / step > 11000) return err(400, 3, 'exceeded maximum resolution of 11,000 points per timeseries');
  const result = [];
  for (const s of estate.monitoring[project] || []) {
    if (s.values[q.metric] === undefined) continue;
    const values = [];
    for (let t = Math.ceil(start / step) * step; t <= end; t += step) {
      const v = valueAt(s.values[q.metric], q.metric, t);
      if (holds(v, q.op, q.threshold)) values.push([t, String(v)]);
    }
    if (values.length) result.push({ metric: { __name__: q.metric, ...gpuLabels(s) }, values });
  }
  return ok({ status: 'success', data: { resultType: 'matrix', result } });
}

function metricNames(project) {
  const gpu = (estate.monitoring[project] || []).length ? ['DCGM_FI_DEV_FB_TOTAL', 'DCGM_FI_DEV_FB_USED', 'DCGM_FI_DEV_GPU_TEMP', 'DCGM_FI_DEV_GPU_UTIL', 'DCGM_FI_DEV_POWER_USAGE', 'DCGM_FI_DEV_XID_ERRORS'] : [];
  return ok({ status: 'success', data: [...gpu, ...Object.keys(telemetry.services[project] || {})].sort() });
}

/* ---- Nebius Observability Logs (Loki read API): buckets exist only where the stub has lines ---- */
function logs(project, path, params) {
  if (!estate.projects[project]) return { status: 404, body: 'project not found' };
  const start = params.get('start');
  const end = params.get('end');
  if (!start || !end) return { status: 400, body: 'operation: decode params: query: "start": query parameter "start" not set' };
  const buckets = telemetry.logs[project] || {};
  if (path === 'labels') return ok({ status: 'success', data: Object.keys(buckets).length ? ['__bucket__'] : [] });
  if (path === 'label/__bucket__/values') return ok({ status: 'success', data: Object.keys(buckets).sort() });
  if (path !== 'query_range') return { status: 404, body: '404 page not found' };
  const query = params.get('query') || '';
  const bucket = /__bucket__\s*=\s*"([^"]*)"/.exec(query);
  if (!bucket) return { status: 400, body: 'bucket is not set' };
  if (!buckets[bucket[1]]) return { status: 404, body: `logging bucket with id=${bucket[1]} not found` };
  // Live 2026-10-12: a JSON parser stage on plain-text serial-console lines answers 500 every time.
  if (bucket[1] === 'sp_serial' && /\|\s*json\b/.test(query)) return { status: 500, body: 'internal error' };
  const resource = /sp_resource_id\s*=\s*"([^"]*)"/.exec(query);
  const contains = [...query.matchAll(/\|=\s*"((?:[^"\\]|\\.)*)"/g)].map(m => m[1]);
  const notRegex = [...query.matchAll(/!~\s*"((?:[^"\\]|\\.)*)"/g)].map(m => new RegExp(m[1].replace(/\\\\/g, '\\')));
  const regex = [...query.matchAll(/\|~\s*"((?:[^"\\]|\\.)*)"/g)].map(m => new RegExp(m[1].replace(/^\(\?i\)/, '').replace(/\\\\/g, '\\'), /^\(\?i\)/.test(m[1]) ? 'i' : ''));
  const limit = Number(params.get('limit') || 100);
  // The newest line is a minute before the request's end, or the project's quiet time (telemetry.logsQuietMinutes).
  const quiet = BigInt((telemetry.logsQuietMinutes || {})[project] || 1);
  const t0 = BigInt(end) - quiet * 60n * 1_000_000_000n;
  const result = buckets[bucket[1]]
    .filter(st => !resource || st.labels.sp_resource_id === resource[1])
    .map((st, i) => ({
      stream: { __bucket__: bucket[1], level: 'unknown', ...st.labels },
      values: st.lines
        .map((line, j) => [String(t0 - BigInt(i * 1000 + (st.lines.length - j) * 7) * 1_000_000_000n), line])
        .filter(([, line]) => contains.every(c => line.includes(c)) && regex.every(r => r.test(line)) && !notRegex.some(r => r.test(line)))
        .slice(0, limit),
    }))
    .filter(st => st.values.length);
  return ok({ status: 'success', data: { resultType: 'streams', result } });
}

const KUBE_PATHS = {
  '/api/v1/nodes': 'nodes', '/api/v1/namespaces': 'namespaces', '/apis/apps/v1/deployments': 'deployments', '/apis/apps/v1/statefulsets': 'statefulsets',
  '/apis/apps/v1/replicasets': 'replicasets', '/apis/batch/v1/jobs': 'jobs', '/api/v1/pods': 'pods', '/api/v1/persistentvolumeclaims': 'persistentvolumeclaims', '/api/v1/events': 'events',
};

/** A read-only Kubernetes API: lists for the identity's nebius:viewer group; writes and secrets are refused, as live. */
function kubeApi(method, cluster, path) {
  const data = (estate.kube || {})[cluster];
  if (!data) return { status: 503, body: { kind: 'Status', status: 'Failure', message: 'cluster not reachable', code: 503 } };
  if (method !== 'GET' || /\/secrets\b/.test(path)) return { status: 403, body: { kind: 'Status', status: 'Failure', reason: 'Forbidden', message: 'forbidden: nebius:viewer cannot do this', code: 403 } };
  const kind = KUBE_PATHS[path];
  if (!kind) return { status: 404, body: { kind: 'Status', status: 'Failure', reason: 'NotFound', code: 404 } };
  return ok({ kind: 'List', apiVersion: 'v1', metadata: {}, items: data[kind] || [] });
}

const audit = JSON.parse(readFileSync(join(__dirname, 'audit.json'), 'utf8'));

/** GET /audit/v2/audit-events: parentId, region, start and end required (400 otherwise, as live); newest first; pageSize/pageToken. */
function auditEvents(q) {
  for (const k of ['parentId', 'region', 'start', 'end']) if (!q.get(k)) return err(400, 3, `Bad ListAuditEventRequest.${k}: value is required`);
  if (q.get('parentId') !== audit.tenant) return err(403, 7, 'PermissionDenied');
  const start = Date.parse(q.get('start'));
  const end = Date.parse(q.get('end'));
  let all = (audit.events[q.get('region')] || [])
    .map(({ minutesAgo, ...e }) => ({ ...e, time: new Date(end - minutesAgo * 60_000).toISOString() }))
    .filter(e => Date.parse(e.time) >= start)
    .sort((a, b) => b.time.localeCompare(a.time));
  // The documented `filter` (nebius/api audit/v2); the stub knows only `action != '<A>'` clauses joined by AND.
  const filter = q.get('filter');
  if (filter) {
    const clauses = filter.split(/\s+AND\s+/).map(c => /^action\s*!=\s*'([A-Z_]+)'$/.exec(c.trim()));
    if (clauses.some(c => !c)) return err(400, 3, 'Bad ListAuditEventRequest.filter: unsupported expression');
    const not = new Set(clauses.map(c => c[1]));
    all = all.filter(e => !not.has(e.action));
  }
  const size = Number(q.get('pageSize') || 100);
  const from = Number(q.get('pageToken') || 0);
  const next = from + size < all.length ? String(from + size) : undefined;
  return ok({ items: all.slice(from, from + size), ...(next ? { nextPageToken: next } : {}) });
}

/** Returns { status, body } for one request; requires a bearer token like the real API. */
function handle(method, rawUrl, headers, body) {
  const url = new URL(rawUrl, 'http://127.0.0.1');
  if (url.pathname === '/healthz') return ok({ ok: true });
  const ai = require('./aiStub').aiHandle(method, url, headers || {});
  if (ai) return ai;
  if (url.pathname.startsWith(`/${EXPORT_BUCKET}`) || /^AWS4-HMAC-SHA256 /.test(headers.authorization || headers.Authorization || '')) return objectStorage(url, headers);
  if (!/^Bearer \S+$/.test(headers.authorization || headers.Authorization || '')) return err(401, 16, 'unauthenticated');
  const mon = /^\/projects\/([a-z0-9-]+)\/service-provider\/prometheus\/api\/v1\/(query|query_range|label\/__name__\/values)$/.exec(url.pathname);
  if (mon && !estate.projects[mon[1]]) return err(404, 5, 'project/bucket not found');
  if (mon && mon[2] === 'query') return monitoring(mon[1], url.searchParams.get('query') || '');
  if (mon && mon[2] === 'query_range') return monitoringRange(mon[1], url.searchParams.get('query') || '', Number(url.searchParams.get('start')), Number(url.searchParams.get('end')), Number(url.searchParams.get('step')));
  if (mon) return metricNames(mon[1]);
  const loki = /^\/projects\/([a-z0-9-]+)\/loki\/api\/v1\/(.+)$/.exec(url.pathname);
  if (loki) return logs(loki[1], loki[2], url.searchParams);
  // User-ingested series (the cluster's observability agent): 404 until the agent has written to the project.
  const agent = /^\/projects\/([a-z0-9-]+)\/prometheus\/api\/v1\/query$/.exec(url.pathname);
  if (agent) return (estate.agentMonitoring || {})[agent[1]] ? monitoring(agent[1], url.searchParams.get('query') || '', estate.agentMonitoring) : err(404, 5, 'project/bucket not found');
  // Kubernetes API of a discovered MK8s cluster (stands in for https://pu.<cluster>.mk8s.<region>.nebius.cloud); GET only.
  const kube = /^\/k8s\/(mk8scluster-[a-z0-9]+)(\/.*)$/.exec(url.pathname);
  if (kube) return kubeApi(method, kube[1], kube[2]);
  if (method === 'POST' && url.pathname === '/billing/v1/calculator/estimate-batch') return calculator(body || {});
  if (method !== 'GET') return err(405, 12, 'only list calls are served');
  if (url.pathname === '/audit/v2/audit-events') return auditEvents(url.searchParams);
  const project = /^\/iam\/v2\/projects\/([a-z0-9-]+)$/.exec(url.pathname);
  if (project) return estate.projects[project[1]] ? ok(estate.projects[project[1]]) : err(404, 5, 'project not found');
  if (url.pathname === '/iam/v2/projects') {
    // Tenant listing: answered with tenant-level `viewer` (granted on the account the stub mirrors).
    const ids = (estate.tenantProjects || {})[url.searchParams.get('parentId') || ''];
    return ids ? ok({ items: ids.map(id => estate.projects[id]).filter(Boolean) }) : err(403, 7, 'PermissionDenied');
  }
  const parentId = url.searchParams.get('parentId') || '';
  if ((estate.denied[url.pathname] || []).includes(parentId)) return err(403, 7, 'PermissionDenied');
  if (((estate.notFound || {})[url.pathname] || []).includes(parentId)) return err(404, 5, 'service not available for this project');
  if (estate.rejected && estate.rejected[url.pathname]) return err(400, 3, 'validation error: unsupported parent');
  // Page-size limits seen live: NVL groups accept at most 50, capacity allowances under 500.
  const pageSize = Number(url.searchParams.get('pageSize') || 0);
  if (url.pathname === '/compute/v1/nvl-instance-groups' && pageSize > 50) return err(400, 3, 'PageSize must be between 1 and 50 (or 0 for default)');
  if (url.pathname === '/capacity/v1/capacity-allowances' && pageSize >= 500) return err(400, 3, 'invalid page_size');
  const list = estate.lists[url.pathname];
  if (!list) return parentId === TENANT ? err(403, 7, 'PermissionDenied') : err(404, 5, `no such list ${url.pathname}`);
  const items = list[parentId] || [];
  const key = url.pathname === '/msp/postgresql/v1alpha1/clusters' ? 'clusters' : 'items';
  if (url.pathname === '/maintenance/v1alpha1/maintenances') return ok({ [key]: items });
  const PAGE = Number(url.searchParams.get('pageSize')) || 100; // honours the requested page size, as the API does
  const start = Number(url.searchParams.get('pageToken') || 0);
  const next = start + PAGE < items.length ? String(start + PAGE) : undefined;
  return ok({ [key]: items.slice(start, start + PAGE), ...(next ? { nextPageToken: next } : {}) });
}

module.exports = { handle, estate, EXPORT_BUCKET };
