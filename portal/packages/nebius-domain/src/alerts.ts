import { parse as parseYaml } from 'yaml';
import { untilText } from './time';
import { fmtQuotaAmount, quotaLineAmount } from './capacity';

/**
 * Alert rules and their evaluation. One rule format for everything: the Prometheus rule files in
 * platform/alerts/*.yaml (also loaded by in-cluster Prometheus) plus portal rules in the same format
 * under platform/alerts/portal/. A rule is evaluated where its metrics live:
 * - `nebius`: PromQL against Nebius Monitoring (the portal's read-only identity, per project);
 * - `portal`: signals only the portal sees (quotas, connectors, Kubernetes allocatable, maintenance),
 *   named `nebius_estate_*` and computed from the inventory snapshot;
 * - `in-cluster`: metrics only an in-cluster Prometheus scrapes (kube-state-metrics, vLLM, kubelet);
 *   listed as "needs in-cluster Prometheus", never dropped.
 * Pure: parsing, classification, the signal expression language and the pending → firing → resolved
 * state machine. The backend does the I/O.
 */

/** `budgets`: signals of the Budgets & credits page (budgetSignals in budgets.ts), one alert per signal; they carry their own guided fix. */
export type RuleSource = 'nebius' | 'portal' | 'in-cluster' | 'budgets';
export type AlertSeverity = 'critical' | 'warning' | 'info';
export type AlertState = 'pending' | 'firing' | 'resolved';

export interface AlertRule {
  /** `<file>#<alert>`: unique across files. */
  id: string;
  file: string;
  group: string;
  name: string;
  expr: string;
  forSeconds: number;
  severity: AlertSeverity;
  summary: string;
  description: string;
  /** Repository path with an #anchor, e.g. runbooks/incident.md#gpu-faults. */
  runbook?: string;
  /** docs.nebius.com URL with an #anchor. */
  docs?: string;
  /** Read-only checks to run, one per line. */
  checks: string[];
  /** What a fix would change (never executed by the portal). */
  fix?: string;
  labels: Record<string, string>;
  source: RuleSource;
  metrics: string[];
  /** For in-cluster rules: the metrics Nebius Monitoring does not carry. */
  missingMetrics?: string[];
}

export interface RuleFileProblem {
  file: string;
  message: string;
}

/** "5m", "1h30m", "90s", "0m" → seconds; undefined for anything else. */
export function parseDuration(text: string | undefined): number | undefined {
  if (text === undefined || text === null) return 0;
  const s = String(text).trim();
  if (!/^(\d+(ms|s|m|h|d|w|y))+$/.test(s)) return undefined;
  const unit: Record<string, number> = { ms: 0.001, s: 1, m: 60, h: 3600, d: 86_400, w: 604_800, y: 31_536_000 };
  let total = 0;
  for (const m of s.matchAll(/(\d+)(ms|s|m|h|d|w|y)/g)) total += Number(m[1]) * unit[m[2]];
  return Math.round(total);
}

/** "1 h" from seconds, for display: the unit spaced, as every number on the pages (W1F.S6). */
export function formatDuration(sec: number): string {
  if (sec <= 0) return '0 min';
  if (sec % 3600 === 0) return `${sec / 3600} h`;
  if (sec % 60 === 0) return `${sec / 60} min`;
  return `${sec} s`;
}

const PROMQL_WORDS = new Set([
  'sum', 'min', 'max', 'avg', 'group', 'stddev', 'stdvar', 'count', 'count_values', 'bottomk', 'topk', 'quantile', 'by', 'without', 'on', 'ignoring',
  'group_left', 'group_right', 'and', 'or', 'unless', 'bool', 'offset', 'abs', 'absent', 'absent_over_time', 'ceil', 'changes', 'clamp', 'clamp_max',
  'clamp_min', 'day_of_month', 'day_of_week', 'days_in_month', 'delta', 'deriv', 'exp', 'floor', 'histogram_quantile', 'holt_winters', 'hour', 'idelta',
  'increase', 'irate', 'label_join', 'label_replace', 'ln', 'log2', 'log10', 'minute', 'month', 'predict_linear', 'rate', 'resets', 'round', 'scalar',
  'sort', 'sort_desc', 'sqrt', 'time', 'timestamp', 'vector', 'year', 'avg_over_time', 'min_over_time', 'max_over_time', 'sum_over_time',
  'count_over_time', 'quantile_over_time', 'stddev_over_time', 'stdvar_over_time', 'last_over_time', 'present_over_time', 'inf', 'nan',
]);

/** Metric names in a PromQL expression (label matchers, grouping lists, strings and durations removed). */
export function metricNames(expr: string): string[] {
  const s = expr
    .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`/g, '""') // strings
    .replace(/\{[^}]*\}/g, ' ') // label matchers
    .replace(/\[[^\]]*\]/g, ' ') // range selectors
    .replace(/\b(by|without|on|ignoring|group_left|group_right)\s*\([^)]*\)/g, ' '); // label lists
  const out = new Set<string>();
  for (const m of s.matchAll(/[A-Za-z_:][A-Za-z0-9_:.]*/g)) {
    const w = m[0];
    const next = s.slice((m.index ?? 0) + w.length).trimStart();
    if (PROMQL_WORDS.has(w) || next.startsWith('(')) continue;
    out.add(w);
  }
  return [...out];
}

/**
 * Metric families only an in-cluster Prometheus scrapes (kube-state-metrics, kubelet, cAdvisor, API server, vLLM),
 * and dcgm-exporter's old throttle series (metric list read live 2026-10-11).
 */
const IN_CLUSTER = /^(kube_|kubelet_|container_|apiserver_|vllm:|nvidia_gpu_|DCGM_FI_DEV_CLOCK_THROTTLE_REASONS$)/;
/**
 * dcgm-exporter names Nebius Monitoring publishes under a newer name. A rule that also reads the newer name
 * (`(NEW or OLD)`) is evaluable against Nebius Monitoring: the absent old series is harmless in PromQL (G3.1).
 */
const RENAMED: Record<string, string> = { DCGM_FI_DEV_CLOCK_THROTTLE_REASONS: 'DCGM_FI_DEV_CLOCKS_EVENT_REASONS' };
/**
 * Why an in-cluster rule is not evaluated by the portal. G3.13: Nebius Monitoring does carry kube_* series (146 names
 * on 2026-10-11) in the project's ingested Prometheus when the observability agent runs, under other labels; the portal
 * reads only the service-provider metrics, so the gap is the portal's source, not Nebius Monitoring as a whole.
 */
export function inClusterReason(missing: string[]): string {
  return `Needs in-cluster Prometheus: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not in the service-provider metrics the portal reads. With the observability agent, kube-state-metrics and kubelet series also reach the project's ingested Prometheus, under other labels (k8s.cluster.id), which the portal does not query yet. This rule runs in the cluster's Prometheus when Alertmanager is enabled (modules/o11y, runbooks/alerting.md).`;
}

/** Signals the portal computes from its own snapshot. */
export const PORTAL_SIGNAL_PREFIX = 'nebius_estate_';

/** Where a rule can be evaluated, from its metric names. */
export function classifyRule(metrics: string[]): { source: RuleSource; missing?: string[] } {
  if (metrics.length && metrics.every(m => m.startsWith(PORTAL_SIGNAL_PREFIX))) return { source: 'portal' };
  const missing = metrics.filter(m => IN_CLUSTER.test(m) && !(RENAMED[m] && metrics.includes(RENAMED[m])));
  return missing.length ? { source: 'in-cluster', missing } : { source: 'nebius' };
}

const SEVERITIES: AlertSeverity[] = ['critical', 'warning', 'info'];

/** Every rule of one Prometheus rule file; problems are reported, never thrown. */
export function parseRuleFile(text: string, file: string): { rules: AlertRule[]; problems: RuleFileProblem[] } {
  const problems: RuleFileProblem[] = [];
  let doc: any;
  try {
    doc = parseYaml(text);
  } catch (e) {
    return { rules: [], problems: [{ file, message: `not valid YAML: ${(e as Error).message.split('\n')[0]}` }] };
  }
  if (!doc || !Array.isArray(doc.groups)) return { rules: [], problems: [{ file, message: 'no `groups:` list' }] };
  const rules: AlertRule[] = [];
  for (const g of doc.groups) {
    for (const r of Array.isArray(g?.rules) ? g.rules : []) {
      if (!r?.alert) continue; // recording rules are not alerts
      const name = String(r.alert);
      const expr = String(r.expr ?? '').trim();
      const forSeconds = parseDuration(r.for);
      if (!expr) problems.push({ file, message: `${name}: no expr` });
      if (forSeconds === undefined) problems.push({ file, message: `${name}: for: "${r.for}" is not a duration` });
      const severity = String(r.labels?.severity ?? 'warning') as AlertSeverity;
      if (!SEVERITIES.includes(severity)) problems.push({ file, message: `${name}: severity "${severity}" is not one of ${SEVERITIES.join(', ')}` });
      const a = r.annotations ?? {};
      const metrics = metricNames(expr);
      const cls = classifyRule(metrics);
      rules.push({
        id: `${file}#${name}`,
        file,
        group: String(g.name ?? ''),
        name,
        expr,
        forSeconds: forSeconds ?? 0,
        severity: SEVERITIES.includes(severity) ? severity : 'warning',
        summary: String(a.summary ?? name),
        description: String(a.description ?? ''),
        runbook: a.runbook ? String(a.runbook) : undefined,
        docs: a.docs ? String(a.docs) : undefined,
        checks: String(a.checks ?? '')
          .split('\n')
          .map(x => x.trim())
          .filter(Boolean),
        fix: a.fix ? String(a.fix).trim() : undefined,
        labels: Object.fromEntries(Object.entries(r.labels ?? {}).map(([k, v]) => [k, String(v)])),
        source: cls.source,
        metrics,
        missingMetrics: cls.missing,
      });
    }
  }
  return { rules, problems };
}

/** GitHub-style heading anchor (what the doc viewer and GitHub link to). */
export function headingAnchor(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

/** Anchors of every heading in a Markdown document (fenced code ignored; duplicates numbered as GitHub does). */
export function markdownAnchors(markdown: string): string[] {
  const out: string[] = [];
  const seen = new Map<string, number>();
  let fenced = false;
  for (const line of markdown.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) continue;
    const m = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const base = headingAnchor(m[1]);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.push(n ? `${base}-${n}` : base);
  }
  return out;
}

/** The section of a Markdown document under the heading with this anchor, up to the next heading of the same or a higher level. */
export function markdownSection(markdown: string, anchor: string): string | undefined {
  const lines = markdown.split('\n');
  const seen = new Map<string, number>();
  let fenced = false;
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) fenced = !fenced;
    if (fenced) continue;
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(lines[i]);
    if (!m) continue;
    if (start >= 0 && m[1].length <= level) return lines.slice(start, i).join('\n').trim();
    const base = headingAnchor(m[2]);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    if (start < 0 && (n ? `${base}-${n}` : base) === anchor) {
      start = i;
      level = m[1].length;
    }
  }
  return start >= 0 ? lines.slice(start).join('\n').trim() : undefined;
}

/* --------------------------------------------------------- portal signals */

/**
 * What an alert's value counts, so it reads with its unit (#42: "Value: 3,848,290,697,216" was a byte quota cut by
 * 3.5 TiB). Not part of the alert's identity.
 */
export interface AlertValueKind {
  /** A quota's own unit: bytes read as GiB / TiB, anything else as a grouped number (fmtQuotaAmount). */
  quotaUnit?: string;
  /** A quota line's name: the amount as checkQuotas gives it (sizes in GiB, vCPU, GPUs; quotaLineAmount). */
  quota?: string;
  /** A unit word after the number ("GPUs", "h", "USD"). */
  unit?: string;
  /** What the amount is, after it ("below the tenant limit"). */
  meaning?: string;
}

/** "3.5 TiB below the tenant limit"; with nothing known about the value, the number alone (two decimals at most). */
export function alertValueText(value: number, of?: AlertValueKind): string {
  const grouped = value.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 0 });
  if (!of) return grouped;
  const amount = of.quotaUnit !== undefined ? fmtQuotaAmount(value, of.quotaUnit) : of.quota ? quotaLineAmount(of.quota, value) : of.unit ? `${grouped} ${of.unit}` : grouped;
  return of.meaning ? `${amount} ${of.meaning}` : amount;
}

/** One series of a portal signal: labels and a value, like a PromQL instant vector element. */
export interface SignalSeries {
  metric: string;
  labels: Record<string, string>;
  /**
   * Values the rule's summary shows in place of raw labels (a byte quota as "1.5 TiB"). Not part of the alert's
   * identity: the labels stay as they are, so a formatting change never resolves and re-fires an alert.
   */
  display?: Record<string, string>;
  value: number;
  valueKind?: AlertValueKind;
  /** Human-readable evidence for the guided fix ("node group gpu: 0 of 2 nodes; compute.instance.gpu.l40s limit 0"). */
  evidence?: string;
  /** The project the series belongs to (scoping). */
  projectId?: string;
  /** Explorer uid of the resource it is about, when there is one. */
  resourceUid?: string;
}

export interface SignalExpr {
  metric: string;
  matchers: { label: string; op: '=' | '!=' | '=~' | '!~'; value: string }[];
  op?: '>' | '>=' | '<' | '<=' | '==' | '!=';
  threshold?: number;
}

/** `name{label="v"} > 0` or a bare selector (any series present). The only syntax portal rules use. */
export function parseSignalExpr(expr: string): SignalExpr | undefined {
  const m = /^\s*([A-Za-z_:][A-Za-z0-9_:]*)\s*(\{([^}]*)\})?\s*(?:(>=|<=|==|!=|>|<)\s*(-?\d+(?:\.\d+)?))?\s*$/.exec(expr);
  if (!m) return undefined;
  const matchers: SignalExpr['matchers'] = [];
  if (m[3]?.trim()) {
    for (const part of m[3].split(',').map(x => x.trim()).filter(Boolean)) {
      const mm = /^([A-Za-z_][A-Za-z0-9_]*)\s*(=~|!~|!=|=)\s*"((?:[^"\\]|\\.)*)"$/.exec(part);
      if (!mm) return undefined;
      matchers.push({ label: mm[1], op: mm[2] as SignalExpr['matchers'][number]['op'], value: mm[3] });
    }
  }
  return { metric: m[1], matchers, op: m[4] as SignalExpr['op'], threshold: m[5] === undefined ? undefined : Number(m[5]) };
}

/** The series of `signals` the expression selects (PromQL filter semantics: the value is kept). */
export function evalSignalExpr(expr: SignalExpr, signals: SignalSeries[]): SignalSeries[] {
  const cmp = (v: number) => {
    if (expr.op === undefined || expr.threshold === undefined) return true;
    const t = expr.threshold;
    return expr.op === '>' ? v > t : expr.op === '>=' ? v >= t : expr.op === '<' ? v < t : expr.op === '<=' ? v <= t : expr.op === '==' ? v === t : v !== t;
  };
  return signals.filter(s => {
    if (s.metric !== expr.metric) return false;
    for (const mt of expr.matchers) {
      const v = s.labels[mt.label] ?? '';
      const re = mt.op === '=~' || mt.op === '!~' ? new RegExp(`^(?:${mt.value})$`) : undefined;
      const matches = mt.op === '=' || mt.op === '!=' ? v === mt.value : re!.test(v);
      if (matches !== (mt.op === '=' || mt.op === '=~')) return false;
    }
    return cmp(s.value);
  });
}

/* ----------------------------------------------------------- state machine */

/**
 * What an alert is about, by name (ids kept as secondary text). Resolved at evaluation from the inventory and kept
 * with the alert, so a resolved alert of a deleted VM still reads by name.
 */
export interface AlertSubject {
  instanceId?: string;
  instanceName?: string;
  /** "GPU 0" (the index, or the only GPU of a 1-GPU VM), else the short UUID. */
  gpu?: string;
  gpuUuid?: string;
  nodeGroupId?: string;
  nodeGroupName?: string;
  clusterId?: string;
  clusterName?: string;
  projectId?: string;
  projectName?: string;
}

/** One alert: a rule × one label set. Stored with its history; resolved alerts stay until pruned. */
export interface AlertInstance {
  /** Stable: rule id + label set. */
  id: string;
  ruleId: string;
  ruleName: string;
  severity: AlertSeverity;
  source: RuleSource;
  state: AlertState;
  labels: Record<string, string>;
  projectId?: string;
  resourceUid?: string;
  /** When the condition was first seen holding (Prometheus `activeAt`). */
  activeAt: string;
  firedAt?: string;
  resolvedAt?: string;
  lastEvalAt: string;
  value: number;
  /** What the value counts (portal and budget signals); absent for a Monitoring rule's query result. */
  valueKind?: AlertValueKind;
  /** The query that produced the value, and where it ran. */
  query: string;
  evidence?: string;
  /** The signal's own title (budgets), or the rule summary rendered with names instead of ids (VM name, GPU index). */
  title?: string;
  fix?: { meaning: string; checks: string[]; action: string; runbook: string; docs: string };
  subject?: AlertSubject;
}

/** A series for which the rule's condition holds now. `since` may be earlier than now when history shows how long it has held. */
export interface ActiveSeries {
  labels: Record<string, string>;
  /** Template values for the title only (SignalSeries.display). */
  display?: Record<string, string>;
  value: number;
  valueKind?: AlertValueKind;
  since?: string;
  projectId?: string;
  resourceUid?: string;
  evidence?: string;
  /** Overrides the rule's severity (budget signals carry their own). */
  severity?: AlertSeverity;
  title?: string;
  fix?: AlertInstance['fix'];
  subject?: AlertSubject;
}

export interface AlertTransition {
  alertId: string;
  ruleId: string;
  from: AlertState | 'inactive';
  to: AlertState;
  at: string;
  value: number;
}

/** Stable id of a rule × label set (sorted labels). */
export function alertId(ruleId: string, labels: Record<string, string>): string {
  const body = `${ruleId}\u001f${Object.keys(labels)
    .sort()
    .map(k => `${k}=${labels[k]}`)
    .join('\u001f')}`;
  // FNV-1a 64-bit as two 32-bit halves: short, stable, no crypto dependency in the shared package.
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < body.length; i++) {
    const c = body.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x811c9dc5) >>> 0;
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}

/**
 * One evaluation of a rule. Prometheus semantics: a series that starts holding is `pending`, and
 * `firing` once it has held for `for:` (from `activeAt`, which may come from history); a pending or
 * firing alert whose series no longer holds is `resolved`. A resolved alert that holds again starts
 * a new episode (pending, new activeAt). Returns the next instances of this rule and the transitions.
 */
export function stepRule(
  rule: Pick<AlertRule, 'id' | 'name' | 'forSeconds' | 'severity' | 'source'>,
  previous: AlertInstance[],
  active: ActiveSeries[],
  now: Date,
  query: string,
): { instances: AlertInstance[]; transitions: AlertTransition[] } {
  const at = now.toISOString();
  const prev = new Map(previous.filter(p => p.ruleId === rule.id).map(p => [p.id, p]));
  const out: AlertInstance[] = [];
  const transitions: AlertTransition[] = [];
  const seen = new Set<string>();
  for (const a of active) {
    const id = alertId(rule.id, a.labels);
    if (seen.has(id)) continue;
    seen.add(id);
    const p = prev.get(id);
    const open = p && p.state !== 'resolved' ? p : undefined;
    const since = a.since && Date.parse(a.since) < now.getTime() ? a.since : at;
    const activeAt = open ? (Date.parse(since) < Date.parse(open.activeAt) ? since : open.activeAt) : since;
    const held = (now.getTime() - Date.parse(activeAt)) / 1000;
    const state: AlertState = held >= rule.forSeconds ? 'firing' : 'pending';
    const firedAt = state === 'firing' ? (open?.firedAt ?? at) : undefined;
    const next: AlertInstance = {
      id,
      ruleId: rule.id,
      ruleName: rule.name,
      severity: a.severity ?? rule.severity,
      source: rule.source,
      state,
      labels: a.labels,
      projectId: a.projectId,
      resourceUid: a.resourceUid,
      activeAt,
      firedAt,
      lastEvalAt: at,
      value: a.value,
      ...(a.valueKind ? { valueKind: a.valueKind } : {}),
      query,
      evidence: a.evidence,
      ...(a.title ? { title: a.title } : {}),
      ...(a.fix ? { fix: a.fix } : {}),
      ...(a.subject ?? open?.subject ? { subject: a.subject ?? open?.subject } : {}),
    };
    const from = open?.state ?? 'inactive';
    if (from !== state) transitions.push({ alertId: id, ruleId: rule.id, from, to: state, at, value: a.value });
    out.push(next);
  }
  for (const p of prev.values()) {
    if (seen.has(p.id)) continue;
    if (p.state === 'resolved') {
      out.push(p);
      continue;
    }
    out.push({ ...p, state: 'resolved', resolvedAt: at, lastEvalAt: at });
    transitions.push({ alertId: p.id, ruleId: rule.id, from: p.state, to: 'resolved', at, value: p.value });
  }
  return { instances: out, transitions };
}

/* ------------------------------------------------------------ API contracts */

/** How a rule stands for this deployment. */
export interface RuleStatus {
  id: string;
  name: string;
  file: string;
  group: string;
  severity: AlertSeverity;
  source: RuleSource;
  expr: string;
  /** The rule's `for:` as written or formatted by the engine; `forSeconds` is the number to show and sort by (G3.9). */
  for: string;
  forSeconds: number;
  summary: string;
  /** evaluated: ran this sync; needs-in-cluster: metrics only an in-cluster Prometheus has; error: the query failed. */
  status: 'evaluated' | 'needs-in-cluster' | 'error' | 'not-configured';
  reason?: string;
  lastEvalAt?: string;
  firing: number;
  pending: number;
}

/** A local note on an alert: acknowledged, or muted until a time. Stored with the user ref; never sent anywhere. */
export interface AlertNote {
  id: string;
  alertId: string;
  kind: 'ack' | 'mute';
  userRef: string;
  note?: string;
  createdAt: string;
  /** Mute only: until when. */
  until?: string;
}

export interface AlertView extends AlertInstance {
  summary: string;
  description: string;
  ruleFor: string;
  /** Where to look: the Fleet row, the Explorer item or the Logs page, pre-filtered. */
  links: { label: string; to: string }[];
  acknowledged?: AlertNote;
  muted?: AlertNote;
}

export interface AlertsResponse {
  alerts: AlertView[];
  counts: { firing: number; pending: number; resolved: number; muted: number };
  rules: RuleStatus[];
  lastEvalAt?: string;
  /** Problems reading the rule files (shown, never hidden). */
  problems: RuleFileProblem[];
  canAnnotate: boolean;
  /** Notification channels the backend could send to (none yet: the browser notifies while the page is open). */
  channels: NotifierChannel[];
  /** Open alerts kept under a region or stage filter although no region is known for them (G1.2). */
  filterNote?: string;
}

export interface GuidedFix {
  meaning: string;
  checks: string[];
  runbook?: { path: string; anchor?: string; title?: string; markdown?: string; missing?: string };
  docs?: string;
  fix: string;
  /** Always true: the portal shows what a fix would change, it never applies one. */
  readOnly: true;
}

export interface AlertDetailResponse {
  alert: AlertView;
  rule: RuleStatus & { description: string; runbook?: string; docs?: string };
  history: { at: string; from: string; to: string; value: number }[];
  notes: AlertNote[];
  guidedFix: GuidedFix;
}

/* ---------------------------------------------------------------- notifier */

/**
 * Where alert transitions can go. `browser` is the Notification API while the portal is open (the
 * frontend implements it). Slack, email and webhooks are typed seams for team mode: the backend
 * notifier registry accepts implementations of AlertNotifier without any change to rules.
 */
export type NotifierChannel = 'browser' | 'slack' | 'email' | 'webhook';

export interface AlertNotification {
  alertId: string;
  ruleName: string;
  severity: AlertSeverity;
  state: AlertState;
  summary: string;
  at: string;
  /** Portal path of the alert, e.g. /alerts?alert=<id>. */
  link: string;
}

export interface AlertNotifier {
  readonly channel: NotifierChannel;
  notify(events: AlertNotification[]): Promise<void>;
}

/** Configuration shapes the seams will take (no implementation ships; secrets would be env names, never values). */
export interface SlackNotifierConfig {
  channel: 'slack';
  webhookUrlEnv: string;
  minSeverity: AlertSeverity;
}
export interface EmailNotifierConfig {
  channel: 'email';
  to: string[];
  minSeverity: AlertSeverity;
}
export interface WebhookNotifierConfig {
  channel: 'webhook';
  urlEnv: string;
  minSeverity: AlertSeverity;
}
export type NotifierConfig = SlackNotifierConfig | EmailNotifierConfig | WebhookNotifierConfig;

const SEVERITY_RANK: Record<AlertSeverity, number> = { info: 0, warning: 1, critical: 2 };
export const severityAtLeast = (s: AlertSeverity, min: AlertSeverity) => SEVERITY_RANK[s] >= SEVERITY_RANK[min];

/**
 * A rule summary says "GPU {{ $labels.gpu }}{{ $labels.uuid }}"; filled with a UUID label ("GPU-…") it read "GPU GPU-…"
 * (#66). The word is dropped before a value that already carries it.
 */
export function tidyAlertTitle(title: string): string {
  return title.replace(/\bGPU (?=GPU-)/g, '');
}

/**
 * Prometheus annotation templates as the rules use them: `{{ $labels.x }}`, `{{ $value }}`; anything else is left as
 * written. A missing label renders empty, as in Prometheus, so a rule can name both the dcgm-exporter label and the
 * Nebius Monitoring one (`{{ $labels.Hostname }}{{ $labels.instance_id }}`). Portal rules may also write
 * `{{ $value | untilHours }}`: a value in hours as a time ahead ("in 49 d"), worded by the formatter every page uses.
 */
export function renderTemplate(text: string, labels: Record<string, string>, value: number): string {
  return tidyAlertTitle(text
    .replace(/\{\{\s*\$labels\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (_m, k: string) => labels[k] ?? '')
    .replace(/\{\{\s*\$value\s*\|\s*untilHours\s*\}\}/g, () => untilText(value * 3_600_000))
    .replace(/\{\{\s*\$value\s*\}\}/g, () => String(Math.round(value * 100) / 100)));
}

/** Where a rule's condition held continuously up to the last point of a range query (the series' `activeAt`). */
export function trailingRunStart(points: [number, number][], stepSec: number, nowSec: number): number | undefined {
  if (!points.length) return undefined;
  const ts = points.map(p => p[0]).sort((a, b) => a - b);
  if (nowSec - ts[ts.length - 1] > 2 * stepSec) return undefined;
  let start = ts[ts.length - 1];
  for (let i = ts.length - 2; i >= 0; i--) {
    if (start - ts[i] > stepSec * 1.5) break;
    start = ts[i];
  }
  return start;
}
