import { InputError, NotAllowedError } from '@backstage/errors';
import express from 'express';
import Router from 'express-promise-router';
import { z } from 'zod';
import { globalFilterSchema, LOG_BUCKETS, LOG_PRESETS, LogBucketsResponse, logsReadPermission, LogsResponse, MAX_LOG_LINES, MAX_LOG_RANGE_SECONDS, validateLogQL } from '@internal/nebius-domain';
import { Access, inScope } from '../lib/access';
import { classify } from '../inventory/contract';
import { InventoryService } from '../inventory/InventoryService';
import { parse } from '../lib/parse';
import { redact } from '../lib/http';
import { BucketNotFoundError, LogQueryFailedError, LogQueryRejectedError, LOGS_SOURCE, LogsClient } from './LogsClient';
import { defaultLogProject, newestLineOf, PROBE_MS, projectsInFilter } from './defaultProject';

/** How long the "which projects have logs" probe is reused when the page opens without a project. */
const PROBE_TTL_MS = 5 * 60_000;

export interface LogsRouterOptions {
  access: Access;
  inventory: InventoryService;
  client: () => LogsClient | undefined;
  projects: () => string[];
}

const PROJECT = z.string().regex(/^project-[a-z0-9]+$/);
const NOT_CONFIGURED = 'Logs need the Nebius connector: listed projects and a read-only identity (docs/portal/nebius-setup.md#logs).';

const queryParams = z.object({
  project: PROJECT,
  query: z.string().min(1).max(2000),
  start: z.string().datetime({ offset: true }).optional(),
  end: z.string().datetime({ offset: true }).optional(),
  /** Instead of start: the last N minutes up to end (default 60). */
  sinceMinutes: z.coerce.number().int().min(1).max(MAX_LOG_RANGE_SECONDS / 60).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LOG_LINES).default(MAX_LOG_LINES),
});

/** Log buckets per project and log lines on demand (GET to Nebius only; nothing is stored). */
export function logsRouter(o: LogsRouterOptions): express.Router {
  const router = Router();

  const projectsFor = (scope: Parameters<typeof inScope>[0]) => {
    const names = new Map(o.inventory.snapshot().resources.filter(r => r.type === 'project').map(r => [r.providerId, r.name]));
    return o.projects().filter(p => inScope(scope, p)).map(id => ({ id, name: names.get(id) }));
  };

  type ScopedProject = ReturnType<typeof projectsFor>[number];
  const probes = new Map<string, { at: number; result: Promise<{ project: ScopedProject; withLogs: (ScopedProject & { buckets: string[]; recent: boolean })[] }> }>();

  // The newest line of each listed bucket of a project, reused like the probe: the page opens on a bucket with lines.
  const newestCache = new Map<string, { at: number; result: Promise<Map<string, string>> }>();
  const newestByBucket = (client: LogsClient, project: string, ids: string[], end: number) => {
    const key = `${project}:${ids.join(',')}`;
    const hit = newestCache.get(key);
    if (hit && Date.now() - hit.at < PROBE_TTL_MS) return hit.result;
    const result = Promise.all(
      ids.map(b =>
        client
          .queryRange(project, b, `{__bucket__="${b}"}`, end - PROBE_MS, end, 1)
          .then(l => [b, l[0]?.time] as const)
          .catch(() => [b, undefined] as const), // unread: the bucket keeps its listed state only
      ),
    ).then(r => new Map(r.filter((x): x is readonly [string, string] => Boolean(x[1]))));
    newestCache.set(key, { at: Date.now(), result });
    return result;
  };

  router.get('/logs/buckets', async (req, res) => {
    const caller = await o.access.require(req, logsReadPermission);
    const inScopeProjects = projectsFor(caller.scope);
    const f = parse(globalFilterSchema, req.query);
    const asked = f.project;
    if (asked && !inScopeProjects.some(p => p.id === asked)) throw new NotAllowedError('project not in your scope');
    // The global region and stage filter narrows the projects the page may open on (G3.3).
    const projects = projectsInFilter(inScopeProjects, o.inventory.snapshot().resources, f).filter(p => !asked || p.id === asked);
    if (!projects.length && inScopeProjects.length && (f.region || f.stage)) {
      const name = asked ? inScopeProjects.find(p => p.id === asked)?.name ?? asked : '';
      const parts = [f.stage && `stage=${f.stage}`, f.region && `region=${f.region}`, asked && `project=${name}`].filter(Boolean).join(' and ');
      const body: LogBucketsResponse = {
        projects, presets: LOG_PRESETS, source: LOGS_SOURCE, project: { id: '' }, buckets: LOG_BUCKETS.map(b => ({ ...b, state: 'unknown' as const })),
        unavailableReason: `No project in scope has ${parts}.`,
      };
      res.json(body);
      return;
    }
    let project = projects.find(p => p.id === asked) ?? projects[0];
    let projectsWithLogs: LogBucketsResponse['projectsWithLogs'];
    const probeClient = o.client();
    if (!asked && projects.length > 1 && probeClient) {
      // No project chosen: open on one with recent logs (the first in scope may have none, or only old ones), and name the others.
      const end = o.inventory.now().getTime();
      const key = projects.map(p => p.id).join(',');
      const hit = probes.get(key);
      const entry = hit && Date.now() - hit.at < PROBE_TTL_MS ? hit : { at: Date.now(), result: defaultLogProject(projects, (id, since) => probeClient.buckets(id, end - since, end), {
        now: end,
        // The newest line of each bucket (one line, newest first, over the probe week): what "recent" means (#31).
        newest: (id, bs) => newestLineOf(bs, b => probeClient.queryRange(id, b, `{__bucket__="${b}"}`, end - PROBE_MS, end, 1).then(l => l[0]?.time)),
      }) };
      probes.set(key, entry);
      const picked = await entry.result;
      project = picked.project;
      projectsWithLogs = picked.withLogs;
    }
    const base = { projects, presets: LOG_PRESETS, source: LOGS_SOURCE };
    const unknown = (reason: string): LogBucketsResponse => ({ ...base, project: project ?? { id: '' }, buckets: LOG_BUCKETS.map(b => ({ ...b, state: 'unknown' as const })), unavailableReason: reason });
    if (!project) {
      res.json(unknown(o.projects().length ? 'None of the listed projects is in your scope.' : NOT_CONFIGURED));
      return;
    }
    const client = o.client();
    if (!client) {
      res.json(unknown(NOT_CONFIGURED));
      return;
    }
    const end = o.inventory.now().getTime();
    try {
      const present = new Set(await client.buckets(project.id, end - PROBE_MS, end));
      const newest = await newestByBucket(client, project.id, LOG_BUCKETS.filter(b => present.has(b.id)).map(b => b.id), end);
      const body: LogBucketsResponse = {
        ...base,
        project,
        projectsWithLogs,
        buckets: LOG_BUCKETS.map(b =>
          present.has(b.id)
            ? { ...b, state: 'present' as const, ...(newest.get(b.id) ? { newest: newest.get(b.id) } : {}) }
            : { ...b, state: 'no-logs-yet' as const, note: `No logs yet from ${b.service} in this project (nothing written in the last 7 days).` },
        ),
      };
      res.json(body);
    } catch (e) {
      const state = classify(e).state;
      res.json(unknown(`Could not list log buckets (${state}): ${redact((e as Error).message).slice(0, 200)}${state === 'permission-denied' ? ' Grant the portal’s group `viewer` on the project.' : ''}`));
    }
  });

  router.get('/logs/query', async (req, res) => {
    const caller = await o.access.require(req, logsReadPermission);
    const q = parse(queryParams, req.query);
    if (!inScope(caller.scope, q.project) || !o.projects().includes(q.project)) throw new NotAllowedError('project not in your scope');
    const check = validateLogQL(q.query);
    if (!check.ok) throw new InputError(check.errors.join(' '));
    const client = o.client();
    if (!client) throw new InputError(NOT_CONFIGURED);
    const nowMs = o.inventory.now().getTime();
    const end = q.end ? Math.min(Date.parse(q.end), nowMs) : nowMs;
    const start = q.start ? Date.parse(q.start) : end - (q.sinceMinutes ?? 60) * 60_000;
    if (start >= end) throw new InputError('start must be before end');
    if ((end - start) / 1000 > MAX_LOG_RANGE_SECONDS) throw new InputError('The time range is limited to 7 days.');
    const common = { project: q.project, bucket: check.bucket!, query: q.query, start: new Date(start).toISOString(), end: new Date(end).toISOString(), limit: q.limit, source: LOGS_SOURCE, observedAt: new Date(nowMs).toISOString() };
    try {
      const lines = await client.queryRange(q.project, check.bucket!, q.query, start, end, q.limit);
      const body: LogsResponse = {
        ...common,
        lines,
        truncated: lines.length >= q.limit,
        bucketState: 'ok',
        note: lines.length ? undefined : 'No line matches in this time range. Widen the range or loosen the filter.',
      };
      res.json(body);
    } catch (e) {
      if (e instanceof BucketNotFoundError) {
        const svc = LOG_BUCKETS.find(b => b.id === check.bucket)?.service ?? check.bucket;
        const body: LogsResponse = { ...common, lines: [], truncated: false, bucketState: 'no-logs-yet', note: `No logs yet from ${svc}: Nebius creates the ${check.bucket} bucket when the service first writes to this project.` };
        res.json(body);
        return;
      }
      if (e instanceof LogQueryRejectedError) throw new InputError(`Nebius Logs refused the query: ${e.message}`);
      if (e instanceof LogQueryFailedError) throw new InputError(e.message);
      throw e;
    }
  });

  return router;
}
