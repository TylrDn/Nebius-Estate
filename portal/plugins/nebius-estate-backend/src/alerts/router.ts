import { AuditorService } from '@backstage/backend-plugin-api';
import { NotFoundError } from '@backstage/errors';
import express from 'express';
import Router from 'express-promise-router';
import { z } from 'zod';
import {
  AlertDetailResponse,
  AlertInstance,
  AlertNote,
  alertAnnotatePermission,
  AlertRule,
  AlertsResponse,
  AlertView,
  estateReadPermission,
  globalFilterSchema,
  GuidedFix,
  markdownSection,
  ObservedResource,
  renderTemplate,
  RuleStatus,
} from '@internal/nebius-domain';
import { Access, audited, inScope, ProjectScope } from '../lib/access';
import { filterResources, maskProjects, ResourceFilter } from '../views';
import { parse } from '../lib/parse';
import { RepoReader } from '../repo/RepoReader';
import { AlertStore } from './AlertStore';
import { AlertEngine, loadRules, NotifierRegistry } from './engine';
import { storedTitle } from './subject';

export interface AlertRouterOptions {
  access: Access;
  auditor: AuditorService;
  store: AlertStore;
  engine: AlertEngine;
  repo: RepoReader;
  notifiers: NotifierRegistry;
  now: () => Date;
  /** Project id → name (the inventory's projects), to mask out-of-scope names in rule reasons. */
  projectNames?: () => Map<string, string>;
  /** The current inventory, to place an alert in a region and a stage for the global filter. */
  resources?: () => ObservedResource[];
}

const ALERT_ID = z.string().regex(/^[0-9a-f]{16}$/);
const listQuery = globalFilterSchema.pick({ project: true, region: true, stage: true }).extend({ state: z.enum(['open', 'resolved', 'all']).default('all') });
const noteBody = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ack'), note: z.string().max(500).optional() }),
  z.object({ kind: z.literal('mute'), note: z.string().max(500).optional(), minutes: z.number().int().min(5).max(30 * 24 * 60) }),
]);

const enc = encodeURIComponent;

const rank = (a: AlertView) => (a.state === 'firing' ? 0 : a.state === 'pending' ? 1 : 2) * 10 + (a.severity === 'critical' ? 0 : a.severity === 'warning' ? 1 : 2);

/** The Logs page's ranges (plugins/nebius-estate logs/model.ts LOG_RANGES), smallest first. */
const LOG_RANGES: [string, number][] = [['15m', 15], ['1h', 60], ['6h', 360], ['24h', 1440], ['7d', 10080]];

/** The smallest Logs range reaching back to `since` from `now` (7 d at most). */
export function logsRangeSince(since: string, now: Date): string {
  const minutes = (now.getTime() - Date.parse(since)) / 60_000;
  return (LOG_RANGES.find(([, m]) => minutes <= m) ?? LOG_RANGES[LOG_RANGES.length - 1])[0];
}

export interface AlertLinkContext {
  /** Whether a resource (provider id) is in the current inventory; without it every resource counts as present. */
  present?: (providerId: string) => boolean;
  /** For the Logs range: from the alert's activeAt to now. */
  now?: Date;
}

/**
 * Where to look next: the Explorer item, the Fleet row and the Logs page, pre-filtered. G3.8: a VM no longer in the
 * inventory gets no Explorer link (it opened "not found or not in your scope") and a Fleet link marked deleted; the
 * Logs link carries the range that reaches back to when the alert became active.
 */
export function alertLinks(a: AlertInstance, rule?: Pick<AlertRule, 'metrics'>, ctx: AlertLinkContext = {}): AlertView['links'] {
  const out: AlertView['links'] = [];
  const project = a.projectId ? `project=${enc(a.projectId)}&` : '';
  const inst = a.labels.instance_id?.startsWith('computeinstance-') ? a.labels.instance_id : undefined;
  const uidId = a.resourceUid?.replace(/^nebius:/, '');
  const gone = (id: string | undefined) => Boolean(id && ctx.present && !ctx.present(id));
  const range = ctx.now ? `&range=${logsRangeSince(a.activeAt, ctx.now)}` : '';
  if (a.resourceUid && !gone(uidId)) out.push({ label: 'Open in Explorer', to: `/estate?uid=${enc(a.resourceUid)}` });
  if (inst && (rule?.metrics.some(m => m.startsWith('DCGM_')) || a.ruleName.startsWith('Gpu'))) out.push({ label: gone(inst) ? 'GPU on the Fleet heat map (VM deleted)' : 'GPU on the Fleet heat map', to: `/fleet?${project}focus=${enc(inst)}` });
  if (inst) out.push({ label: 'Serial-console logs of this VM', to: `/logs?${project}bucket=sp_serial&resource=${enc(inst)}${range}` });
  else if (a.labels.cluster || a.labels.node_group) out.push({ label: 'Control-plane errors', to: `/logs?${project}preset=control-plane-errors${range}` });
  if (a.labels.connector) out.push({ label: 'Connector on Integrations', to: '/integrations' });
  if (a.source === 'budgets') out.push({ label: 'Budgets & credits', to: '/budgets' });
  if (a.labels.quota || a.labels.maintenance) out.push({ label: 'GPU & Capacity', to: `/capacity${a.projectId ? `?project=${enc(a.projectId)}` : ''}` });
  return out;
}

/**
 * One alert as the API returns it. Alerts stored before names were kept get their title from the stored subject
 * (storedTitle) and the project's name from the inventory (`projectNames`), so no row reads `project-…`.
 */
export function alertView(a: AlertInstance, rule: AlertRule | undefined, notes: AlertNote[], now: Date, projectNames?: ReadonlyMap<string, string>, present?: (providerId: string) => boolean): AlertView {
  const mine = notes.filter(n => n.alertId === a.id);
  const muted = mine.find(n => n.kind === 'mute' && n.until && Date.parse(n.until) > now.getTime());
  const projectId = a.subject?.projectId ?? a.projectId;
  const projectName = a.subject?.projectName ?? (projectId ? projectNames?.get(projectId) : undefined);
  const subject = projectId && projectName ? { ...a.subject, projectId, projectName } : a.subject;
  return {
    ...a,
    ...(subject ? { subject } : {}),
    summary: storedTitle(a, rule?.summary ?? a.ruleName),
    description: a.fix?.meaning ?? renderTemplate(rule?.description ?? '', a.labels, a.value),
    ruleFor: rule ? `${rule.forSeconds / 60} min` : a.source === 'budgets' ? 'at once' : 'rule removed',
    links: alertLinks(a, rule, { present, now }),
    acknowledged: mine.find(n => n.kind === 'ack'),
    muted,
  };
}

/**
 * Whether an alert falls inside the global filter (G1.2). Project as before; region from the alert's `region` label,
 * else from the resource it is about, else from its project; stage through that resource, else through the projects the stage keeps.
 * An alert that cannot be placed in a region (a tenant-wide or connector alert) is kept and reported as
 * 'region-unknown', so the page can say it is not filtered by region.
 */
export function alertInFilter(a: AlertInstance, f: Pick<ResourceFilter, 'project' | 'region' | 'stage'>, resources: ObservedResource[]): 'in' | 'out' | 'region-unknown' {
  if (f.project && a.projectId !== f.project) return 'out';
  if (!f.region && !f.stage) return 'in';
  const byId = new Map(resources.map(r => [r.providerId, r]));
  const ids = [a.labels.instance_id, a.subject?.instanceId, a.subject?.nodeGroupId, a.subject?.clusterId, a.resourceUid?.replace(/^nebius:/, '')];
  const about = ids.map(id => (id ? byId.get(id) : undefined)).find(Boolean);
  const kept = filterResources(resources.filter(r => r.type !== 'project'), f);
  if (about && about.type !== 'project') return kept.some(r => r.providerId === about.providerId) ? 'in' : 'out';
  // An empty label (the allowance signal writes `region: ''` when the quota has none) is no region: fall back to the
  // resource, then to the alert's project (G3.2).
  const project = a.projectId ? byId.get(a.projectId) : undefined;
  const region = a.labels.region || about?.region || (project?.type === 'project' ? project.region : undefined);
  if (f.stage && a.projectId && !kept.some(r => r.projectId === a.projectId)) return 'out';
  if (!region) return 'region-unknown';
  if (f.region && region !== f.region) return 'out';
  if (f.stage && !kept.some(r => r.region === region && (!a.projectId || r.projectId === a.projectId))) return 'out';
  return 'in';
}

/**
 * A lookup of the current inventory's provider ids; undefined when there is no inventory yet (before the first sync)
 * or none is wired: every link is kept rather than every resource called deleted.
 */
const presentIn = (resources: ObservedResource[] | undefined) => {
  if (!resources?.length) return undefined;
  const ids = new Set(resources.map(r => r.providerId));
  return (id: string) => ids.has(id);
};

const escapeRe = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Rule statuses as one caller may see them. The engine evaluates every project; a project-scoped caller
 * gets reasons with other projects' ids and names masked, and firing / pending counts of the alerts in
 * its scope (`alerts` must already be scoped).
 */
export function scopeRuleStatuses(rules: RuleStatus[], alerts: Pick<AlertInstance, 'ruleId' | 'state'>[], scope: ProjectScope, names: Map<string, string>): RuleStatus[] {
  const hidden = scope.all ? [] : [...names].filter(([id, name]) => !scope.projects.has(id) && name && !/^project-[a-z0-9]+$/.test(name)).map(([, name]) => name).sort((a, b) => b.length - a.length);
  const nameRe = hidden.length ? new RegExp(`(?<![\\w-])(${hidden.map(escapeRe).join('|')})(?![\\w-])`, 'g') : undefined;
  const mask = (text: string | undefined) => (text === undefined || scope.all ? text : maskProjects(nameRe ? text.replace(nameRe, 'project-…') : text, scope));
  return rules.map(r => ({
    ...r,
    reason: mask(r.reason),
    firing: alerts.filter(a => a.ruleId === r.id && a.state === 'firing').length,
    pending: alerts.filter(a => a.ruleId === r.id && a.state === 'pending').length,
  }));
}

/** Alerts inbox, detail with the guided fix, acknowledge and mute (local notes only). */
export function alertsRouter(o: AlertRouterOptions): express.Router {
  const router = Router();

  const rulesById = async () => new Map((await loadRules(o.repo)).rules.map(r => [r.id, r]));

  router.get('/alerts', async (req, res) => {
    const caller = await o.access.require(req, estateReadPermission);
    const q = parse(listQuery, req.query);
    const now = o.now();
    const names = o.projectNames?.();
    const rules = await rulesById();
    const inventory = o.resources?.() ?? [];
    const present = presentIn(o.resources ? inventory : undefined);
    const placed = (await o.store.all()).filter(a => inScope(caller.scope, a.projectId)).map(a => ({ a, at: alertInFilter(a, q, inventory) }));
    const all = placed.filter(x => x.at !== 'out').map(x => x.a);
    const unplaced = placed.filter(x => x.at === 'region-unknown' && x.a.state !== 'resolved').length;
    const notes = await o.store.notes(all.map(a => a.id));
    const views = all
      .filter(a => q.state === 'all' || (q.state === 'open' ? a.state !== 'resolved' : a.state === 'resolved'))
      .map(a => alertView(a, rules.get(a.ruleId), notes, now, names, present))
      .sort((a, b) => rank(a) - rank(b) || b.activeAt.localeCompare(a.activeAt))
      .slice(0, 500);
    const st = o.engine.status();
    const body: AlertsResponse = {
      alerts: views,
      counts: {
        firing: all.filter(a => a.state === 'firing').length,
        pending: all.filter(a => a.state === 'pending').length,
        resolved: all.filter(a => a.state === 'resolved').length,
        muted: views.filter(v => v.muted && v.state !== 'resolved').length,
      },
      rules: scopeRuleStatuses(st.rules.length ? st.rules : [...rules.values()].map(r => pendingStatus(r)), all, caller.scope, o.projectNames?.() ?? new Map()),
      lastEvalAt: st.lastEvalAt,
      problems: st.problems,
      canAnnotate: await o.access.allowed(caller, alertAnnotatePermission),
      channels: ['browser', ...o.notifiers.channels()],
      ...(unplaced ? { filterNote: `${unplaced} open alert${unplaced === 1 ? '' : 's'} not filtered by ${q.stage && !q.region ? 'stage' : 'region'}: no region known` } : {}),
    };
    res.json(body);
  });

  router.get('/alerts/:id', async (req, res) => {
    const caller = await o.access.require(req, estateReadPermission);
    const id = parse(ALERT_ID, req.params.id);
    const a = await o.store.get(id);
    if (!a || !inScope(caller.scope, a.projectId)) throw new NotFoundError('alert not found or not in your scope');
    const rules = await rulesById();
    const rule = rules.get(a.ruleId);
    const notes = await o.store.notes([id]);
    const found = o.engine.status().rules.find(r => r.id === a.ruleId) ?? (rule ? pendingStatus(rule) : undefined);
    const scopedAlerts = (await o.store.all()).filter(x => x.ruleId === a.ruleId && inScope(caller.scope, x.projectId));
    const st = found ? scopeRuleStatuses([found], scopedAlerts, caller.scope, o.projectNames?.() ?? new Map())[0] : undefined;
    const body: AlertDetailResponse = {
      alert: alertView(a, rule, notes, o.now(), o.projectNames?.(), presentIn(o.resources?.())),
      rule: {
        ...(st ?? { id: a.ruleId, name: a.ruleName, file: a.ruleId.split('#')[0], group: '', severity: a.severity, source: a.source, expr: a.query, for: '', forSeconds: 0, summary: a.ruleName, status: 'error', reason: 'The rule is no longer in the repository.', firing: 0, pending: 0 }),
        description: rule?.description ?? '',
        runbook: rule?.runbook,
        docs: rule?.docs,
      },
      history: await o.store.history(id),
      notes,
      guidedFix: await guidedFix(o.repo, a, rule),
    };
    res.json(body);
  });

  router.post('/alerts/:id/notes', express.json({ limit: '64kb' }), async (req, res) => {
    const caller = await o.access.require(req, alertAnnotatePermission);
    const id = parse(ALERT_ID, req.params.id);
    const body = parse(noteBody, req.body);
    const a = await o.store.get(id);
    if (!a || !inScope(caller.scope, a.projectId)) throw new NotFoundError('alert not found or not in your scope');
    const now = o.now();
    const note = await audited(o.auditor, req, `alert-${body.kind}`, { alert: id, rule: a.ruleId }, () =>
      o.store.addNote({ alertId: id, kind: body.kind, userRef: caller.userEntityRef, note: body.note, until: body.kind === 'mute' ? new Date(now.getTime() + body.minutes * 60_000).toISOString() : undefined }, now),
    );
    res.status(201).json(note);
  });

  router.delete('/alerts/:id/notes/:kind', async (req, res) => {
    const caller = await o.access.require(req, alertAnnotatePermission);
    const id = parse(ALERT_ID, req.params.id);
    const kind = parse(z.enum(['ack', 'mute']), req.params.kind);
    const a = await o.store.get(id);
    if (!a || !inScope(caller.scope, a.projectId)) throw new NotFoundError('alert not found or not in your scope');
    await audited(o.auditor, req, `alert-un${kind}`, { alert: id }, () => o.store.removeNote(id, kind));
    res.status(204).end();
  });

  return router;
}


/** A rule before the first evaluation after start-up. */
function pendingStatus(r: AlertRule): RuleStatus {
  return {
    id: r.id, name: r.name, file: r.file, group: r.group, severity: r.severity, source: r.source, expr: r.expr, for: `${r.forSeconds / 60}m`, forSeconds: r.forSeconds, summary: r.summary,
    status: r.source === 'in-cluster' ? 'needs-in-cluster' : 'not-configured',
    reason: r.source === 'in-cluster' ? `Needs in-cluster Prometheus: ${(r.missingMetrics ?? []).join(', ')}.` : 'Not evaluated yet: rules run after each sync (the first one is still running).',
    firing: 0, pending: 0,
  };
}

const DEFAULT_CHECKS: Record<AlertRule['source'], string[]> = {
  nebius: ['Open the GPU on the Fleet heat map and compare it with the other GPUs of its node group.', 'Read the VM’s serial-console logs for errors around the time the alert started.'],
  portal: ['Open the resource in the Explorer and check its status and relations.', 'Compare with the GPU & Capacity page (quotas, maintenance, node groups).'],
  'in-cluster': ['kubectl get nodes,pods -A (read-only) on the cluster the alert names.'],
  budgets: ['Open Budgets & credits and compare with the console (Billing → Budgets).'],
};

export async function guidedFix(repo: RepoReader, a: AlertInstance, fromRules: AlertRule | undefined): Promise<GuidedFix> {
  let rule = fromRules;
  if (!rule && a.fix) {
    // Budget signals carry their own guided fix (budgets.ts); the runbook section is rendered the same way.
    rule = { id: a.ruleId, file: '', group: '', name: a.ruleName, expr: a.query, forSeconds: 0, severity: a.severity, summary: a.title ?? a.ruleName, description: a.fix.meaning, runbook: a.fix.runbook, docs: a.fix.docs, checks: a.fix.checks, fix: a.fix.action, labels: {}, source: 'budgets', metrics: [] };
  }
  const fix: GuidedFix = {
    meaning: rule ? renderTemplate(rule.description || rule.summary, a.labels, a.value) : 'The rule that raised this alert is no longer in the repository.',
    checks: (rule?.checks.length ? rule.checks : DEFAULT_CHECKS[a.source]).map(c => renderTemplate(c, a.labels, a.value)),
    docs: rule?.docs,
    fix: rule?.fix ? renderTemplate(rule.fix, a.labels, a.value) : 'Follow the runbook section below. The portal shows what a fix would change; it never applies one.',
    readOnly: true,
  };
  if (rule?.runbook) {
    const [path, anchor] = rule.runbook.split('#');
    try {
      const md = await repo.read(path);
      const section = anchor ? markdownSection(md, anchor) : md;
      fix.runbook = section
        ? { path, anchor, title: section.split('\n')[0].replace(/^#+\s*/, ''), markdown: section.slice(0, 20_000) }
        : { path, anchor, missing: `No section #${anchor} in ${path}: the whole runbook is in the document viewer.` };
    } catch {
      fix.runbook = { path, anchor, missing: `${path} is not in this checkout or not readable through the portal.` };
    }
  }
  return fix;
}
