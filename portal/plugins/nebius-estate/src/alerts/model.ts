import type { AlertNotification, AlertNotifier, AlertView, RuleSource } from '@internal/nebius-domain';
import { fmtTime } from '../ui/format';

/** View helpers for the Alerts page and the browser notifier. Pure where possible, so they are unit-tested. */

export const SOURCE_LABEL: Record<RuleSource, string> = {
  nebius: 'Nebius Monitoring',
  portal: 'Portal (inventory)',
  'in-cluster': 'Needs in-cluster Prometheus',
  budgets: 'Budgets & credits',
};

export const SEVERITY_TONE = { critical: 'danger', warning: 'warn', info: 'info' } as const;

/** Labels worth showing as the alert's scope (the project is shown by name elsewhere). */
const SCOPE_KEYS = ['node_group_name', 'name', 'title', 'node', 'instance_id', 'cluster', 'quota', 'region', 'uuid', 'gpu', 'connector'];

/** Whether `text` shows `value` as a whole token (not inside a longer id or number: a GPU index "0" in "10.0"). */
function mentions(text: string, value: string): boolean {
  const esc = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\w.-])${esc}($|[^\\w.-]|\\.(?!\\w))`).test(text);
}

/** `summary`: the alert's title; a label it already shows is not repeated in the scope (#64). */
export function scopeText(labels: Record<string, string>, summary = ''): string {
  const parts = SCOPE_KEYS.filter(k => labels[k]).map(k => labels[k]);
  if (!parts.length) return 'whole estate';
  return [...new Set(parts)].filter(p => !mentions(summary, p)).slice(0, 3).join(' · ');
}

/**
 * What an alert is about, by name: VM, GPU, node group and cluster (`primary`), the project by name, and the ids
 * as secondary text. Alerts stored before names were kept fall back to their labels and the project id.
 */
export function subjectText(a: Pick<AlertView, 'labels' | 'projectId' | 'subject'> & { summary?: string }): { primary: string; project?: string; ids?: string } {
  const s = a.subject;
  const summary = a.summary ?? '';
  if (!s) return { primary: scopeText(a.labels, summary), project: a.projectId, ids: undefined };
  const names = [s.instanceName ?? s.instanceId, s.gpu, s.nodeGroupName ?? (s.instanceId ? undefined : s.nodeGroupId), s.clusterName ?? (s.instanceId || s.nodeGroupId ? undefined : s.clusterId)].filter((x): x is string => !!x);
  const ids = [s.instanceName ? s.instanceId : undefined, s.gpuUuid && s.gpuUuid !== s.gpu ? s.gpuUuid : undefined, s.projectName ? s.projectId : undefined].filter((x): x is string => !!x);
  return { primary: [...new Set(names)].filter(n => !mentions(summary, n)).join(' · ') || (names.length ? '' : scopeText(a.labels, summary)), project: s.projectName ?? s.projectId ?? a.projectId, ids: ids.length ? ids.join(' · ') : undefined };
}

/** The time the inbox's "since" column shows per tab, named so it cannot be misread (holding vs firing). */
export function sinceOf(a: Pick<AlertView, 'activeAt' | 'firedAt' | 'resolvedAt'>, tab: 'firing' | 'pending' | 'resolved'): { header: string; at?: string; title: string } {
  const both = `Holding since ${fmtTime(a.activeAt)}${a.firedAt ? `; firing since ${fmtTime(a.firedAt)}` : ''}`;
  if (tab === 'resolved') return { header: 'Resolved', at: a.resolvedAt, title: `${both}; resolved ${fmtTime(a.resolvedAt)}` };
  if (tab === 'firing') return { header: 'Firing since', at: a.firedAt ?? a.activeAt, title: both };
  return { header: 'Holding since', at: a.activeAt, title: both };
}

/** Relative links inside a runbook section open in the portal's document viewer, like the Evidence page. */
export function runbookLink(path: string, href: string): string {
  if (href.startsWith('#')) return `/evidence?doc=${encodeURIComponent(path)}`;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return /^(https?|mailto):/i.test(href) ? href : '#';
  const parts = path.split('/').slice(0, -1);
  for (const seg of href.split('#')[0].split('/')) {
    if (seg === '..') parts.pop();
    else if (seg && seg !== '.') parts.push(seg);
  }
  return `/evidence?doc=${encodeURIComponent(parts.join('/'))}`;
}

/** A rule's `docs` link as rendered: https only (rule files and budget signals are data); otherwise none. */
export function docsLink(href: string | undefined): string | undefined {
  if (!href) return undefined;
  try {
    return /^https:\/\//i.test(href) && new URL(href).protocol === 'https:' ? href : undefined;
  } catch {
    return undefined;
  }
}

/** Firing, unmuted alerts not notified yet (by id and the time they fired, so a new episode notifies again). */
export function newlyFiring(alerts: AlertView[], seen: Set<string>): AlertView[] {
  return alerts.filter(a => a.state === 'firing' && !a.muted && !seen.has(`${a.id}@${a.firedAt ?? a.activeAt}`));
}

export const seenKey = (a: Pick<AlertView, 'id' | 'firedAt' | 'activeAt'>) => `${a.id}@${a.firedAt ?? a.activeAt}`;

/**
 * The browser channel of the notifier interface: the Notification API while the portal is open.
 * Team channels (Slack, email, webhooks) implement the same AlertNotifier interface on the backend.
 */
export class BrowserNotifier implements AlertNotifier {
  readonly channel = 'browser' as const;

  static supported(): boolean {
    return typeof window !== 'undefined' && 'Notification' in window;
  }

  static permission(): NotificationPermission | 'unsupported' {
    return BrowserNotifier.supported() ? Notification.permission : 'unsupported';
  }

  static async request(): Promise<NotificationPermission | 'unsupported'> {
    if (!BrowserNotifier.supported()) return 'unsupported';
    return Notification.permission === 'default' ? Notification.requestPermission() : Notification.permission;
  }

  constructor(private readonly open: (link: string) => void) {}

  async notify(events: AlertNotification[]): Promise<void> {
    if (BrowserNotifier.permission() !== 'granted') return;
    for (const e of events.slice(0, 5)) {
      const n = new Notification(`${e.severity === 'critical' ? 'Critical' : e.severity === 'warning' ? 'Warning' : 'Info'}: ${e.ruleName}`, { body: e.summary, tag: e.alertId });
      n.onclick = () => {
        window.focus();
        this.open(e.link);
      };
    }
  }
}

const PREF = 'nebius-estate.alerts.browser-notifications';

/** The user's toggle, kept in this browser only. */
export function notificationsEnabled(): boolean {
  try {
    return window.localStorage.getItem(PREF) === 'on';
  } catch {
    return false;
  }
}

export function setNotificationsEnabled(on: boolean) {
  try {
    window.localStorage.setItem(PREF, on ? 'on' : 'off');
  } catch {
    /* storage blocked: the toggle lasts for this page only */
  }
}

const IN_CLUSTER = /^Needs in-cluster Prometheus: (.+?) (?:is|are) (?:scraped inside a cluster|not in the service-provider metrics)/;

/** A rule's reason for the Rules table: an in-cluster rule names only the metrics it needs (the footer says why once). */
export function ruleReasonShort(reason: string): string {
  const m = IN_CLUSTER.exec(reason);
  return m ? `Needs ${m[1]}` : reason;
}

/** Rank of a severity, most severe first: one order for the inbox and the Rules table (G3.10). */
export const severityRank = (s: string) => ['critical', 'warning', 'info'].indexOf(s);
export const SEVERITY_SORT_LABELS: [string, string] = ['most severe first', 'least severe first'];

/** A rule's hold in one wording (G3.9): "at once" for 0, else "10 min", "1 h". */
export function forLabel(seconds: number): string {
  if (seconds <= 0) return 'at once';
  if (seconds % 3600 === 0) return `${seconds / 3600} h`;
  if (seconds % 60 === 0) return `${seconds / 60} min`;
  return `${seconds} s`;
}

/** A resolved alert that went pending and cleared before its `for:` ran out: it never fired (G3.12). */
export const clearedBeforeFiring = (a: Pick<AlertView, 'state' | 'firedAt'>) => a.state === 'resolved' && !a.firedAt;

/** A rule's `for:` ("0m", "15m", "1h30m") in the portal's words: "at once", "15 min", "1 h 30 min". */
export function forText(d: string): string {
  const parts = [...d.matchAll(/(\d+)([hms])/g)].filter(([, n]) => Number(n) > 0).map(([, n, u]) => `${n} ${u === 'h' ? 'h' : u === 'm' ? 'min' : 's'}`);
  if (/^[\dhms]+$/.test(d) && !parts.length) return 'at once';
  return parts.length ? parts.join(' ') : d;
}
