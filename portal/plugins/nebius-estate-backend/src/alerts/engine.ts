import { promises as fs } from 'fs';
import { join } from 'path';
import { LoggerService } from '@backstage/backend-plugin-api';
import {
  inClusterReason,
  ActiveSeries,
  BudgetSignal,
  AlertInstance,
  AlertNotification,
  AlertNotifier,
  AlertRule,
  AlertTransition,
  alertId,
  evalSignalExpr,
  formatDuration,
  parseRuleFile,
  parseSignalExpr,
  RuleFileProblem,
  RuleStatus,
  stepRule,
  trailingRunStart,
} from '@internal/nebius-domain';
import { mapLimit, redact } from '../lib/http';
import { InventoryService } from '../inventory/InventoryService';
import { isAllowedRepoPath, RepoReader } from '../repo/RepoReader';
import { MetricsClient } from '../telemetry/MetricsClient';
import { AlertStore } from './AlertStore';
import { SignalBuilder, unknownInputs } from './signals';
import { storedTitle, withNames } from './subject';
import { instancesListed } from '../views';

/** Rule files: the shared Prometheus rules, then the portal's own (same format). One source of rules. */
export const RULE_DIRS = ['platform/alerts', 'platform/alerts/portal'] as const;

/** Every rule file in the repository, parsed. Unreadable files are problems, not exceptions. */
export async function loadRules(repo: RepoReader): Promise<{ rules: AlertRule[]; problems: RuleFileProblem[] }> {
  const rules: AlertRule[] = [];
  const problems: RuleFileProblem[] = [];
  for (const dir of RULE_DIRS) {
    const names = await fs.readdir(join(repo.root, dir)).catch(() => [] as string[]);
    for (const name of names.filter(n => n.endsWith('.yaml')).sort()) {
      const file = `${dir}/${name}`;
      if (!isAllowedRepoPath(file)) {
        problems.push({ file, message: 'file name not readable through the portal (lowercase letters, digits and hyphens only)' });
        continue;
      }
      try {
        const r = parseRuleFile(await repo.read(file), file);
        rules.push(...r.rules);
        problems.push(...r.problems);
      } catch (e) {
        problems.push({ file, message: redact((e as Error).message) });
      }
    }
  }
  const seen = new Set<string>();
  return {
    rules: rules.filter(r => (seen.has(r.id) ? (problems.push({ file: r.file, message: `${r.name} is defined twice; the first wins` }), false) : seen.add(r.id))),
    problems,
  };
}

const BUDGET_KINDS: { kind: BudgetSignal['kind']; name: string; severity: 'warning' | 'critical'; summary: string }[] = [
  { kind: 'budget-threshold', name: 'BudgetThresholdCrossed', severity: 'warning', summary: 'A budget crossed one of its thresholds' },
  { kind: 'budget-over', name: 'BudgetOver', severity: 'critical', summary: 'A budget is over its amount' },
  { kind: 'budget-projected', name: 'BudgetProjected', severity: 'warning', summary: 'Spend plus the live run-rate estimate reaches a budget threshold the actual has not' },
  { kind: 'budget-forecast', name: 'BudgetForecast', severity: 'warning', summary: 'A budget is forecast to cross a threshold by the end of its period that spend has not crossed yet' },
  { kind: 'credit-expiring', name: 'CreditExpiring', severity: 'warning', summary: 'A credit expires within 14 days with money left' },
  { kind: 'credit-exhausting', name: 'CreditExhausting', severity: 'warning', summary: 'A credit runs out within 14 days at the current burn' },
];

/** What a budget write changed, for `reevaluateBudgets`: a deleted budget or credit resolves its alerts with the reason. */
export interface BudgetChange {
  deleted?: { type: 'budget' | 'credit'; id: string };
}

/** Typed seam for team mode: Slack, email and webhook notifiers register here; none ships (the browser notifies). */
export class NotifierRegistry {
  private readonly notifiers: AlertNotifier[] = [];

  register(n: AlertNotifier) {
    this.notifiers.push(n);
  }

  channels() {
    return this.notifiers.map(n => n.channel);
  }

  async dispatch(events: AlertNotification[], logger: LoggerService) {
    if (!events.length) return;
    for (const n of this.notifiers) {
      try {
        await n.notify(events);
      } catch (e) {
        logger.warn(`nebius-estate: ${n.channel} notifier failed: ${redact((e as Error).message)}`);
      }
    }
  }
}

export interface EngineDeps {
  store: AlertStore;
  repo: RepoReader;
  inventory: Pick<InventoryService, 'snapshot' | 'now'>;
  metrics: () => MetricsClient | undefined;
  projects: () => string[];
  maxConcurrency: number;
  logger: LoggerService;
  notifiers: NotifierRegistry;
}

const IN_CLUSTER_REASON = inClusterReason;

/**
 * Evaluates every rule after each sync (InventoryService.afterSync), keeps pending state between
 * syncs in the alert store, and resolves alerts whose condition no longer holds. A query that fails
 * leaves that rule's alerts as they were: a failed read never resolves an alert.
 */
export class AlertEngine {
  private readonly signals = new SignalBuilder();
  private statuses = new Map<string, RuleStatus>();
  private problems: RuleFileProblem[] = [];
  private lastEvalAt?: string;
  private budgetSignals?: () => Promise<BudgetSignal[]>;
  private budgetsDefined?: () => Promise<{ budgets: number; credits: number }>;
  /** Evaluations run one at a time: a budget write's re-evaluation never interleaves with a sync's (W1-P19). */
  private queue: Promise<unknown> = Promise.resolve();

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  constructor(private readonly d: EngineDeps) {}

  /** Budget and credit signals (Budgets & credits) become alerts of source `budgets`; they fire and resolve with the signal. */
  useBudgetSignals(fn: () => Promise<BudgetSignal[]>, defined?: () => Promise<{ budgets: number; credits: number }>) {
    this.budgetSignals = fn;
    this.budgetsDefined = defined;
  }

  status(): { rules: RuleStatus[]; problems: RuleFileProblem[]; lastEvalAt?: string } {
    return { rules: [...this.statuses.values()], problems: this.problems, lastEvalAt: this.lastEvalAt };
  }

  async evaluate(): Promise<{ transitions: AlertTransition[] }> {
    return this.serial(() => this.evaluateNow());
  }

  /**
   * Budget and credit alerts only, now (W1-P19): run after every budget, credit or spend-entry write, so a deleted
   * budget's alerts resolve at once ("budget deleted") and a crossing fires without waiting for the next sync.
   */
  async reevaluateBudgets(change: BudgetChange = {}): Promise<{ resolved: number; fired: number }> {
    return this.serial(async () => {
      const now = this.d.inventory.now();
      const at = now.toISOString();
      const prev = (await this.d.store.all()).filter(a => a.source === 'budgets');
      const next: AlertInstance[] = [];
      const transitions: AlertTransition[] = [];
      const statuses = new Map<string, RuleStatus>();
      await this.evalBudgets(prev, now, next, transitions, statuses);
      if (change.deleted) {
        const prefix = `${change.deleted.type}:${change.deleted.id}:`;
        for (const t of transitions.filter(x => x.to === 'resolved')) {
          const a = next.find(x => x.id === t.alertId);
          if (a?.labels.signal?.startsWith(prefix)) a.evidence = `${a.evidence ?? ''} Resolved: ${change.deleted.type} deleted.`.trim();
        }
      }
      for (const [id, st] of statuses) {
        st.firing = next.filter(a => a.ruleId === id && a.state === 'firing').length;
        st.pending = next.filter(a => a.ruleId === id && a.state === 'pending').length;
        this.statuses.set(id, st);
      }
      await this.d.store.save(next, transitions, now);
      const byId = new Map(next.map(a => [a.id, a]));
      const notify = transitions.filter(t => t.to === 'firing' || (t.to === 'resolved' && t.from === 'firing'));
      await this.d.notifiers.dispatch(
        notify.map(t => {
          const a = byId.get(t.alertId)!;
          return { alertId: t.alertId, ruleName: a.ruleName, severity: a.severity, state: t.to, summary: storedTitle(a, a.ruleName), at, link: `/alerts?alert=${t.alertId}` };
        }),
        this.d.logger,
      );
      return { resolved: transitions.filter(t => t.to === 'resolved').length, fired: transitions.filter(t => t.to === 'firing').length };
    });
  }

  private async evaluateNow(): Promise<{ transitions: AlertTransition[] }> {
    const now = this.d.inventory.now();
    const at = now.toISOString();
    const { rules, problems } = await loadRules(this.d.repo);
    const prev = await this.d.store.all();
    const snap = this.d.inventory.snapshot();
    const signals = this.signals.signals(snap, now);
    const unknown = unknownInputs(snap);
    const client = this.d.metrics();
    const names = new Map(snap.resources.filter(r => r.type === 'project').map(r => [r.providerId, r.name]));
    const resourcesById = new Map(snap.resources.map(r => [r.providerId, r]));
    const leftInventory = goneVms(snap);
    const next: AlertInstance[] = [];
    const transitions: AlertTransition[] = [];
    const statuses = new Map<string, RuleStatus>();

    for (const rule of rules) {
      const status: RuleStatus = {
        id: rule.id, name: rule.name, file: rule.file, group: rule.group, severity: rule.severity, source: rule.source, expr: rule.expr,
        for: formatDuration(rule.forSeconds), forSeconds: rule.forSeconds, summary: rule.summary, status: 'evaluated', firing: 0, pending: 0,
      };
      const mine = prev.filter(p => p.ruleId === rule.id);
      let active: ActiveSeries[] | undefined;
      // Open alerts whose input is unknown now: kept exactly as they were, outside stepRule (F1.34).
      let held: AlertInstance[] = [];
      let query = rule.expr;
      if (rule.source === 'in-cluster') {
        status.status = 'needs-in-cluster';
        status.reason = IN_CLUSTER_REASON(rule.missingMetrics ?? []);
      } else if (rule.source === 'portal') {
        const expr = parseSignalExpr(rule.expr);
        query = `${rule.expr}  (portal signal, computed from the inventory snapshot)`;
        if (!expr) {
          status.status = 'error';
          status.reason = 'Portal rules use `nebius_estate_<signal>{label="value"} <op> <number>` only.';
        } else {
          active = withNames(evalSignalExpr(expr, signals).map(s => ({ labels: s.labels, display: s.display, value: s.value, ...(s.valueKind ? { valueKind: s.valueKind } : {}), projectId: s.projectId, resourceUid: s.resourceUid, evidence: s.evidence })), rule.summary, resourcesById);
          // Open alerts whose input is missing now are unknown: kept as they were (state, since-times, title), never
          // resolved, so they do not resolve and re-fire with data availability, and a pending one does not reach
          // firing on old data (F1.34).
          const kept = keptUnknown(mine, active, unknown.filter(u => u.metric === expr.metric), rule.id);
          if (kept.instances.length) {
            held = kept.instances;
            status.reason = `${held.length} alert${held.length === 1 ? ' kept as it was' : 's kept as they were'}: input unknown (${kept.reasons.join('; ')}).`;
          }
        }
      } else if (!client) {
        status.status = 'not-configured';
        status.reason = 'Nebius Monitoring is not configured: list projects and a read-only identity (docs/portal/nebius-setup.md#telemetry).';
      } else {
        query = `${rule.expr}  (Nebius Monitoring, each listed project)`;
        const r = await this.evalNebius(client, rule, mine, now, names);
        // A VM that left the inventory is not running: Monitoring answers for it a few more minutes, its alerts resolve now.
        active = withNames(r.active.filter(a => !leftInventory(a.labels.instance_id, a.projectId)), rule.summary, resourcesById);
        if (r.errors.length) {
          status.status = r.errors.length === this.d.projects().length ? 'error' : 'evaluated';
          status.reason = `${r.errors.length} project(s) could not be queried (their alerts are kept as they were): ${r.errors[0]}`;
          if (status.status === 'error') active = undefined;
        }
      }
      if (active) {
        const heldIds = new Set(held.map(h => h.id));
        const step = stepRule(rule, mine.filter(m => !heldIds.has(m.id)), active, now, query);
        for (const t of step.transitions) {
          const a = step.instances.find(x => x.id === t.alertId);
          if (t.to === 'resolved' && a && leftInventory(a.labels.instance_id, a.projectId)) a.evidence = `${a.evidence ?? ''} Resolved: the VM left the inventory (deleted).`.trim();
        }
        next.push(...step.instances, ...held);
        transitions.push(...step.transitions);
      } else {
        next.push(...mine);
      }
      status.lastEvalAt = active ? at : undefined;
      statuses.set(rule.id, status);
    }

    await this.evalBudgets(prev, now, next, transitions, statuses);

    // Alerts of rules that were removed from the repository are resolved, not left open.
    const ruleIds = new Set([...rules.map(r => r.id), ...statuses.keys()]);
    for (const p of prev.filter(x => !ruleIds.has(x.ruleId))) {
      if (p.state === 'resolved') next.push(p);
      else {
        next.push({ ...p, state: 'resolved', resolvedAt: at, lastEvalAt: at, evidence: `${p.evidence ?? ''} Resolved: the rule is no longer in the repository.`.trim() });
        transitions.push({ alertId: p.id, ruleId: p.ruleId, from: p.state, to: 'resolved', at, value: p.value });
      }
    }

    for (const s of statuses.values()) {
      s.firing = next.filter(a => a.ruleId === s.id && a.state === 'firing').length;
      s.pending = next.filter(a => a.ruleId === s.id && a.state === 'pending').length;
    }
    await this.d.store.save(next, transitions, now);
    this.statuses = statuses;
    this.problems = problems;
    this.lastEvalAt = at;

    const byId = new Map(next.map(a => [a.id, a]));
    const ruleById = new Map(rules.map(r => [r.id, r]));
    await this.d.notifiers.dispatch(
      transitions
        .filter(t => t.to === 'firing' || (t.to === 'resolved' && t.from === 'firing'))
        .map(t => {
          const a = byId.get(t.alertId)!;
          return { alertId: t.alertId, ruleName: a.ruleName, severity: a.severity, state: t.to, summary: storedTitle(a, ruleById.get(t.ruleId)?.summary ?? a.ruleName), at: t.at, link: `/alerts?alert=${t.alertId}` };
        }),
      this.d.logger,
    );
    return { transitions };
  }

  /**
   * Fast-sync step (inventory/fastSync.ts): resolves open alerts whose VM left the inventory, from the
   * inventory alone. No Monitoring query, no rule evaluation; the next full evaluation does the rest.
   */
  async resolveGoneVms(): Promise<{ resolved: number }> {
    return this.serial(() => this.resolveGoneVmsNow());
  }

  private async resolveGoneVmsNow(): Promise<{ resolved: number }> {
    const now = this.d.inventory.now();
    const at = now.toISOString();
    const leftInventory = goneVms(this.d.inventory.snapshot());
    const prev = await this.d.store.all();
    const transitions: AlertTransition[] = [];
    const next = prev.map(a => {
      if (a.state === 'resolved' || !a.labels.instance_id || !leftInventory(a.labels.instance_id, a.projectId)) return a;
      transitions.push({ alertId: a.id, ruleId: a.ruleId, from: a.state, to: 'resolved', at, value: a.value });
      return { ...a, state: 'resolved' as const, resolvedAt: at, lastEvalAt: at, evidence: `${a.evidence ?? ''} Resolved: the VM left the inventory (deleted).`.trim() };
    });
    if (!transitions.length) return { resolved: 0 };
    await this.d.store.save(next, transitions, now);
    const byId = new Map(next.map(a => [a.id, a]));
    await this.d.notifiers.dispatch(
      transitions
        .filter(t => t.from === 'firing')
        .map(t => {
          const a = byId.get(t.alertId)!;
          return { alertId: t.alertId, ruleName: a.ruleName, severity: a.severity, state: 'resolved' as const, summary: storedTitle(a, a.ruleName), at, link: `/alerts?alert=${t.alertId}` };
        }),
      this.d.logger,
    );
    return { resolved: transitions.length };
  }

  /** One pseudo-rule per budget signal kind; a failed read keeps the budget alerts as they were. */
  private async evalBudgets(prev: AlertInstance[], now: Date, next: AlertInstance[], transitions: AlertTransition[], statuses: Map<string, RuleStatus>) {
    let signals: BudgetSignal[] | undefined;
    let reason: string | undefined;
    if (!this.budgetSignals) reason = 'Budgets & credits is not connected to the alert engine.';
    else {
      try {
        signals = await this.budgetSignals();
      } catch (e) {
        reason = `Budget signals could not be read (alerts kept as they were): ${redact((e as Error).message).slice(0, 200)}`;
      }
    }
    // #65: a rule over budgets says so when none is defined (and over credits when none is entered), not "evaluated".
    const defined = signals && this.budgetsDefined ? await this.budgetsDefined().catch(() => undefined) : undefined;
    for (const kind of BUDGET_KINDS) {
      const rule = { id: `budgets#${kind.kind}`, name: kind.name, forSeconds: 0, severity: 'warning' as const, source: 'budgets' as const };
      const mine = prev.filter(p => p.ruleId === rule.id);
      const credit = kind.kind.startsWith('credit-');
      const none = defined && (credit ? defined.credits === 0 : defined.budgets === 0);
      const noneReason = credit ? 'No credits entered: add one on Budgets & credits.' : 'No budgets defined: add one on Budgets & credits.';
      const status: RuleStatus = {
        id: rule.id, name: rule.name, file: 'Budgets & credits (entered by you)', group: 'budgets', severity: kind.severity, source: 'budgets',
        expr: `budgetSignals() kind = ${kind.kind}`, for: '0m', forSeconds: 0, summary: kind.summary, status: signals && !none ? 'evaluated' : 'not-configured', reason: none ? noneReason : reason, firing: 0, pending: 0,
        lastEvalAt: signals ? now.toISOString() : undefined,
      };
      statuses.set(rule.id, status);
      if (!signals) {
        next.push(...mine);
        continue;
      }
      const active: ActiveSeries[] = signals
        .filter(x => x.kind === kind.kind)
        .map(x => ({
          labels: { signal: x.id, name: x.subject.name, subject: x.subject.type },
          value: Number(x.evidence.value.amount),
          valueKind: { unit: x.evidence.value.currency },
          severity: x.severity,
          title: x.title,
          fix: x.fix,
          evidence: `${x.title}: ${x.evidence.value.amount} ${x.evidence.value.currency}${x.evidence.threshold ? ` against ${x.evidence.threshold.amount} ${x.evidence.threshold.currency}` : ''} (${x.evidence.basis}${x.evidence.asOf ? `, as of ${x.evidence.asOf}` : ''}${x.evidence.expiresOn ? `, expires ${x.evidence.expiresOn}` : ''}).`,
        }));
      const step = stepRule(rule, mine, active, now, 'budgetSignals(budgets, credits) on the backend clock');
      next.push(...step.instances);
      transitions.push(...step.transitions);
    }
  }

  /** PromQL against every listed project; a newly active series looks back over `for:` to find when it started holding. */
  private async evalNebius(client: MetricsClient, rule: AlertRule, mine: AlertInstance[], now: Date, names: Map<string, string>) {
    const active: ActiveSeries[] = [];
    const errors: string[] = [];
    const nowSec = Math.floor(now.getTime() / 1000);
    const open = new Set(mine.filter(a => a.state !== 'resolved').map(a => JSON.stringify(sortLabels(a.labels))));
    const vmNames = new Map(this.d.inventory.snapshot().resources.filter(r => r.type === 'compute-instance').map(r => [r.providerId, r.name]));
    await mapLimit(this.d.projects(), this.d.maxConcurrency, async project => {
      try {
        const res = await client.query(project, rule.expr);
        const fresh: ActiveSeries[] = [];
        for (const r of res) {
          const { __name__: _n, ...labels } = r.metric;
          const series: ActiveSeries = {
            labels: { ...labels, project },
            value: r.value,
            projectId: project,
            resourceUid: labels.instance_id?.startsWith('computeinstance-') ? `nebius:${labels.instance_id}` : undefined,
            evidence: `${rule.expr} → ${Math.round(r.value * 100) / 100} in ${names.get(project) ?? project}${labels.instance_id ? ` (${vmNames.get(labels.instance_id) ? `${vmNames.get(labels.instance_id)}, ` : ''}${labels.instance_id})` : ''}.`,
          };
          if (rule.forSeconds > 0 && !open.has(JSON.stringify(sortLabels(series.labels)))) fresh.push(series);
          active.push(series);
        }
        if (fresh.length) {
          // History: how long has each new series held? One range query per project.
          const range = await client.queryRange(project, rule.expr, nowSec - rule.forSeconds - 120, nowSec, 60);
          for (const s of fresh) {
            const match = range.find(x => {
              const { __name__: _n, ...l } = x.metric;
              return JSON.stringify(sortLabels({ ...l, project })) === JSON.stringify(sortLabels(s.labels));
            });
            const start = match ? trailingRunStart(match.values, 60, nowSec) : undefined;
            if (start !== undefined) s.since = new Date(start * 1000).toISOString();
          }
        }
      } catch (e) {
        errors.push(`${names.get(project) ?? project}: ${redact((e as Error).message).slice(0, 200)}`);
        // Keep this project's open alerts as they are: a failed query says nothing about the condition.
        for (const a of mine.filter(x => x.projectId === project && x.state !== 'resolved')) active.push({ labels: a.labels, value: a.value, projectId: a.projectId, resourceUid: a.resourceUid, evidence: a.evidence, since: a.activeAt });
      }
    });
    return { active, errors };
  }
}

/**
 * VMs that left the inventory (or are being deleted), once a successful inventory sync has listed the VMs of their
 * project (instancesListed). Before that, or where the list is refused, nothing is known to be gone.
 */
function goneVms(snap: ReturnType<EngineDeps['inventory']['snapshot']>) {
  const state = snap.statuses.find(s => s.id === 'nebius-inventory')?.state;
  const synced = state === 'ok' || state === 'permission-denied' || state === 'degraded';
  const listed = instancesListed(snap);
  const vms = new Map(snap.resources.filter(r => r.type === 'compute-instance').map(r => [r.providerId, r]));
  return (instanceId: string | undefined, projectId: string | undefined) => {
    if (!synced || !instanceId?.startsWith('computeinstance-') || !listed(projectId)) return false;
    const vm = vms.get(instanceId);
    return !vm || vm.status === 'deleting';
  };
}

/** Open alerts of a rule that are not active now and whose input is unknown (UnknownInput): held unchanged. */
function keptUnknown(mine: AlertInstance[], active: ActiveSeries[], unknown: { projectId?: string; labels?: Record<string, string>; reason: string }[], ruleId: string) {
  const activeIds = new Set(active.map(a => alertId(ruleId, a.labels)));
  const instances: AlertInstance[] = [];
  const reasons = new Set<string>();
  for (const a of mine) {
    if (a.state === 'resolved' || activeIds.has(a.id)) continue;
    const u = unknown.find(x => (!x.projectId || x.projectId === a.projectId) && Object.entries(x.labels ?? {}).every(([k, v]) => a.labels[k] === v));
    if (!u) continue;
    reasons.add(u.reason);
    instances.push(a);
  }
  return { instances, reasons: [...reasons] };
}

function sortLabels(l: Record<string, string>): [string, string][] {
  return Object.entries(l).sort(([a], [b]) => a.localeCompare(b));
}
