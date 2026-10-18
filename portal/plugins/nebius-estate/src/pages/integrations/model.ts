import type { CapabilityRow, CapabilityState, CapabilityStatus, ConnectorStatus, HealthStats } from '@internal/nebius-domain';
import { errorReason } from '@internal/nebius-domain';

/** Most urgent first: what needs a grant or a look comes before what answered. */
export const STATE_ORDER: CapabilityState[] = ['permission-denied', 'unreachable', 'schema-drift', 'rejected', 'not-found', 'not-configured', 'ok'];

const rank = (s: string) => {
  const i = STATE_ORDER.indexOf(s as CapabilityState);
  return i < 0 ? STATE_ORDER.length : i;
};

/** Readable names for the service groups the backend reports; unknown groups show their key. */
export const SERVICE_LABELS: Record<string, string> = {
  iam: 'IAM',
  compute: 'Compute',
  mk8s: 'Managed Kubernetes',
  vpc: 'VPC networking',
  storage: 'Object Storage',
  registry: 'Container Registry',
  msp: 'Managed services (PostgreSQL, MLflow)',
  ai: 'Serverless AI',
  tunnel: 'Tunnels',
  kms: 'KMS',
  mysterybox: 'MysteryBox secrets',
  dns: 'DNS',
  quotas: 'Quotas',
  capacity: 'Capacity',
  maintenance: 'Maintenance',
  billing: 'Billing',
  monitoring: 'Monitoring',
};
const SERVICE_ORDER = Object.keys(SERVICE_LABELS);

export const serviceLabel = (service: string) => SERVICE_LABELS[service] ?? service;

/** A capability needs attention when it did not answer cleanly or only stale data is kept. */
/** Not configured (e.g. node groups with no cluster) is not a problem; refusals, failures, drift and stale data are. */
export const needsAttention = (c: CapabilityStatus) => (c.state !== 'ok' && c.state !== 'not-configured') || !!c.stale;

/** Runs that say nothing about health (not set up, waiting for a target): neutral, never failures. */
export const isNeutralRun = (r: { ok: boolean; errorClass?: string }) => !r.ok && ['not-configured', 'waiting', 'optional', 'starting', 'not-needed'].includes(r.errorClass ?? '');

/** Failed runs in the last 24 h (counted by the backend, else derived from the rate). */
export function failures24h(h: HealthStats): number {
  return h.failures24h ?? (h.successRate24h !== null && h.runs24h ? Math.round(h.runs24h * (1 - h.successRate24h)) : 0);
}

/** The failed runs of one item (newest failure included), not counting runs that say nothing about health. */
function failureTimes(h: HealthStats): string[] {
  const times = new Set((h.recentRuns ?? []).filter(r => !r.ok && !isNeutralRun(r)).map(r => r.at));
  if (h.lastFailureAt) times.add(h.lastFailureAt);
  return [...times];
}

/**
 * One sync attempt at which many calls failed together: one incident, not a reliability problem of each call (G1.6,
 * W1-P27). `connectors` are the distinct connectors that failed at that attempt (a connector's own run or its calls);
 * `calls` how many calls failed in it; `recoveredAt` the first run of those connectors that answered after it.
 */
export interface SyncIncident {
  at: string;
  connectors: string[];
  calls: number;
  recoveredAt?: string;
}

type Healthy = { health?: HealthStats };

/**
 * Sync attempts at which most calls failed together, from every failed run each call keeps (recentRuns and the newest
 * failure), not only its newest one (#28): at least 3 calls, and half of the calls with runs of the connectors that
 * failed there. One connector's sync failing across its calls is one incident of that connector, never "every
 * connector" (#35): `connectors` counts distinct connectors.
 */
export function syncIncidents(statuses: (Healthy & { id: string })[], capabilities: (Healthy & { connector: string })[]): SyncIncident[] {
  const calls = new Map<string, Set<number>>();
  const connectors = new Map<string, Set<string>>();
  const add = <T,>(m: Map<string, Set<T>>, at: string, v: T) => m.set(at, (m.get(at) ?? new Set<T>()).add(v));
  capabilities.forEach((c, i) => {
    if (!c.health) return;
    for (const at of failureTimes(c.health)) {
      add(calls, at, i);
      add(connectors, at, c.connector);
    }
  });
  for (const s of statuses) if (s.health) for (const at of failureTimes(s.health)) add(connectors, at, s.id);
  const out: SyncIncident[] = [];
  for (const [at, failed] of calls) {
    const ids = [...(connectors.get(at) ?? [])].sort();
    const withRuns = capabilities.filter(c => ids.includes(c.connector) && c.health && c.health.runs24h > 0).length;
    if (failed.size < 3 || failed.size < withRuns / 2) continue;
    const answered = [...statuses.filter(s => ids.includes(s.id)), ...capabilities.filter(c => ids.includes(c.connector))]
      .flatMap(x => x.health?.recentRuns ?? [])
      .filter(r => r.ok && r.at > at)
      .map(r => r.at)
      .sort();
    out.push({ at, connectors: ids, calls: failed.size, ...(answered.length ? { recoveredAt: answered[0] } : {}) });
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

/** The attempts of `syncIncidents`: what the rate, flaky and health views leave out. */
export function sharedOutages(statuses: (Healthy & { id: string })[], capabilities: (Healthy & { connector: string })[]): Set<string> {
  return new Set(syncIncidents(statuses, capabilities).map(i => i.at));
}

/**
 * An incident in words: "Nebius inventory: one sync failed across 35 calls" for one connector; "one sync failed for
 * 2 connectors at once" only when two or more failed in it (#35).
 */
export function incidentTitle(i: SyncIncident, titleOf: (id: string) => string = id => id): string {
  if (i.connectors.length > 1) return `One sync failed for ${i.connectors.length} connectors at once (${i.calls} calls)`;
  return `${titleOf(i.connectors[0] ?? 'a connector')}: one sync failed across ${i.calls} calls`;
}

/**
 * Failures in 24 h of this call alone: every failure at a shared outage inside those 24 h is left out, the older ones
 * too (#28). The window ends at the newest run the call keeps (when the backend counted failures24h); a shared failure
 * before it is not among failures24h and is not taken off.
 */
export function ownFailures(h: HealthStats, outages: ReadonlySet<string> = new Set()): number {
  const n = failures24h(h);
  if (!n || !outages.size) return n;
  const times = [...(h.recentRuns ?? []).map(r => r.at), ...(h.lastFailureAt ? [h.lastFailureAt] : [])].map(Date.parse).filter(t => !Number.isNaN(t));
  const since = times.length ? Math.max(...times) - 24 * 3_600_000 : -Infinity;
  return Math.max(0, n - failureTimes(h).filter(at => outages.has(at) && Date.parse(at) > since).length);
}

/**
 * Answers now, but failed on its own at least twice in the last 24 h: its own bucket, "flaky". One failure is a blip,
 * and one shared outage is not the call's (G1.6): a rate threshold would flag a call by how often it runs.
 */
export const FLAKY_OWN_FAILURES = 2;
export const isFlaky = (c: { health?: HealthStats }, outages?: ReadonlySet<string>) => !!c.health && c.health.runs24h > 0 && ownFailures(c.health, outages) >= FLAKY_OWN_FAILURES;

/** The "Needs attention" view: refused, failing, drifting or stale calls, plus flaky ones. */
export const needsAttentionOrFlaky = (c: CapabilityStatus, outages?: ReadonlySet<string>) => needsAttention(c) || isFlaky(c, outages);

/** "2 of 38 failed in 24 h" — or null when nothing failed. */
export function failuresText(h: HealthStats): string | null {
  const failed = failures24h(h);
  return failed > 0 && h.runs24h > 0 ? `${failed} of ${h.runs24h} failed in 24 h` : null;
}

export function countStates(items: { state: string }[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const i of items) counts.set(i.state, (counts.get(i.state) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => rank(a[0]) - rank(b[0]));
}

export interface CapabilityGroup {
  service: string;
  label: string;
  items: CapabilityStatus[];
  counts: [string, number][];
}

/** Capabilities grouped by service area (known areas in a fixed order), most urgent first inside a group. */
export function groupCapabilities(capabilities: CapabilityStatus[]): CapabilityGroup[] {
  const groups = new Map<string, CapabilityStatus[]>();
  for (const c of capabilities) groups.set(c.service, [...(groups.get(c.service) ?? []), c]);
  const pos = (s: string) => {
    const i = SERVICE_ORDER.indexOf(s);
    return i < 0 ? SERVICE_ORDER.length : i;
  };
  return [...groups.entries()]
    .sort((a, b) => pos(a[0]) - pos(b[0]) || a[0].localeCompare(b[0]))
    .map(([service, items]) => ({
      service,
      label: serviceLabel(service),
      items: [...items].sort((a, b) => rank(a.state) - rank(b.state) || a.title.localeCompare(b.title)),
      counts: countStates(items),
    }));
}

/**
 * The connector whose sync makes a capability's call: Nebius Monitoring and the billing
 * calculator have connectors of their own; every other Nebius read belongs to the inventory.
 */
/** The connector that makes the call (reported by the backend). */
export function connectorOf(c: CapabilityStatus): string {
  return c.connector;
}

/** The capabilities behind one connector card. */
export const capabilitiesOf = (connector: ConnectorStatus, capabilities: CapabilityStatus[]) => capabilities.filter(c => connectorOf(c) === connector.id);

/**
 * The date a call is known to answer: the later of its catalog check (`verified`) and its last live answer, the
 * same on the capability row and in the matrix (G1.16).
 */
export function verifiedOf(c: Pick<CapabilityStatus, 'verified' | 'state' | 'lastSuccess'>): { date: string; checked?: string; answered?: string } | undefined {
  const answered = c.state === 'ok' && c.lastSuccess ? c.lastSuccess.slice(0, 10) : undefined;
  const date = [c.verified, answered].filter((x): x is string => !!x).sort().pop();
  return date ? { date, checked: c.verified, answered } : undefined;
}

/* ---------------------------------------------------------------- matrix */

/** `{id}` and `<project>` placeholders compare equal, whatever their name. */
export const normalizePath = (p: string) => p.replace(/\{[^,}]*\}/g, '{}').replace(/<[^>]*>/g, '{}');

function expand(path: string): string[] {
  const m = /\{([^{}]*,[^{}]*)\}/.exec(path);
  if (!m) return [path];
  return m[1].split(',').flatMap(alt => expand(path.slice(0, m.index) + alt.trim() + path.slice(m.index + m[0].length)));
}

/** The documented paths a matrix row names: "GET /a/{b,c}?parentId=<x>, /d (host)" → /a/b, /a/c, /d. */
export function matrixPaths(restPath: string | undefined): string[] {
  if (!restPath) return [];
  return restPath
    .replace(/^(GET|POST)\s+/, '')
    .split(/,\s+/)
    .map(p => p.replace(/^(GET|POST)\s+/, '').replace(/\s*\(.*\)\s*$/, '').replace(/\?.*$/, '').trim())
    .flatMap(expand)
    .map(normalizePath);
}

export interface MatrixView {
  row: CapabilityRow;
  /** The capabilities the row documents, as this deployment saw them at the last sync. */
  capabilities: CapabilityStatus[];
  /** Connectors named by the row, when no capability matches (Kubernetes, Prometheus, CSV import). */
  connectors: ConnectorStatus[];
  /** Latest live verification date among the matched capabilities (or the row's own, verified by hand). */
  verified?: string;
  /** Nothing to call yet (no Managed Kubernetes cluster in the listed projects): idle, not a fault. */
  idle?: string;
}

/** Connector ids a matrix row names ("mk8s:<cluster id> (configured clusters: kubernetes:<name>)" → mk8s:, kubernetes:). */
export function rowConnectors(connector: string | undefined): { exact: string[]; prefixes: string[] } {
  const exact: string[] = [];
  const prefixes: string[] = [];
  for (const m of (connector ?? '').matchAll(/\b([a-z][a-z0-9-]*)(:)?/g)) {
    if (m[2]) prefixes.push(`${m[1]}:`);
    else exact.push(m[1]);
  }
  // Kubernetes is reached through discovered MK8s clusters (mk8s:<id>) or configured ones (kubernetes:<name>).
  if (exact.includes('kubernetes') || prefixes.includes('kubernetes:') || prefixes.includes('mk8s:')) prefixes.push('mk8s:', 'kubernetes:');
  return { exact, prefixes: [...new Set(prefixes)] };
}

/** Joins each documentation row with the live capability and connector state, so the matrix never claims what the data contradicts. */
export function matrixView(rows: CapabilityRow[], capabilities: CapabilityStatus[], statuses: ConnectorStatus[]): MatrixView[] {
  return rows.map(row => {
    const paths = new Set(matrixPaths(row.restPath));
    const { exact, prefixes } = rowConnectors(row.connector);
    const byPrefix = (id: string) => prefixes.some(p => id.startsWith(p));
    let caps = capabilities.filter(c => paths.has(normalizePath(c.path)));
    // Per-cluster calls (connector mk8s:<id>) have per-cluster paths: join them by their connector.
    if (!caps.length && prefixes.length) caps = capabilities.filter(c => byPrefix(c.connector));
    const connectors = caps.length ? [] : statuses.filter(s => exact.includes(s.id) || byPrefix(s.id));
    // A documented verification date, else the date a call of this deployment last answered on the live account.
    const verified = caps.map(c => verifiedOf(c)?.date).filter((v): v is string => !!v).sort().pop() ?? row.verifiedOn;
    const idle = !caps.length && !connectors.length && prefixes.includes('mk8s:') ? 'idle: no Managed Kubernetes cluster in the listed projects (connects automatically when one exists)' : undefined;
    return { row, capabilities: caps, connectors, verified, idle };
  });
}

/* ---------------------------------------------------------------- health */

export function fmtDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return 'n/a';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${(ms / 60_000).toFixed(1)} min`;
}

/** "97.5 %" from a 0–1 rate; "no run in 24 h" when there was none (never 0 %). */
export function fmtRate(h: HealthStats): string {
  if (!h.runs24h || h.successRate24h === null || h.successRate24h === undefined) return 'no run in 24 h';
  const pct = Math.round(h.successRate24h * 1000) / 10;
  return `${pct} %`;
}

export type RateTone = 'ok' | 'warn' | 'danger' | 'neutral';
/**
 * The tone of a 24 h success rate. Failures only at a shared outage (sharedOutages) leave it ok (G1.6), and so does a
 * single failure of the call's own that it has answered since: the same threshold as isFlaky, so an amber rate has a
 * flaky (or currently failing, so needs-attention) call behind it.
 */
export function rateTone(h: HealthStats, outages?: ReadonlySet<string>): RateTone {
  if (!h.runs24h || h.successRate24h === null || h.successRate24h === undefined) return 'neutral';
  if (h.successRate24h >= 0.99 || ownFailures(h, outages) === 0) return 'ok';
  if (ownFailures(h, outages) < FLAKY_OWN_FAILURES && h.consecutiveFailures === 0) return 'ok';
  return h.successRate24h >= 0.9 ? 'warn' : 'danger';
}

/** Screen-reader summary of the recent runs a sparkline draws. */
export function describeRuns(runs: HealthStats['recentRuns']): string {
  if (!runs.length) return 'No recorded runs';
  const neutral = runs.filter(isNeutralRun).length;
  const failed = runs.filter(r => !r.ok).length - neutral;
  const newest = runs[0];
  const outcome = newest.ok ? 'succeeded' : isNeutralRun(newest) ? `was ${newest.errorClass!.replace(/-/g, ' ')} (not a failure)` : `failed${newest.errorClass ? ` (${newest.errorClass.replace(/-/g, ' ')})` : ''}`;
  return `Last ${runs.length} runs: ${runs.length - failed - neutral} succeeded, ${failed} failed${neutral ? `, ${neutral} not set up or waiting` : ''}; newest ${outcome} in ${fmtDuration(newest.durationMs)}`;
}

/* ------------------------------------------------------------------ hints */

export type HintPart = { kind: 'text'; text: string } | { kind: 'code'; text: string } | { kind: 'doc'; text: string; path: string; anchor?: string };

/**
 * Splits a backend hint into text, `code` (role names) and repository docs the portal can open
 * (docs/<name>.md, the document viewer's allowlist).
 */
export function parseHint(hint: string): HintPart[] {
  const parts: HintPart[] = [];
  // docs/<name>.md and docs/{portal,decisions,evidence}/<name>.md: the viewer's allowlist (repo/RepoReader.ts).
  const re = /`([^`]+)`|\b(docs\/(?:(?:portal|decisions|evidence)\/)?[a-z0-9-]+\.md)(?![\w/])(?:#([a-z0-9-]+))?/g;
  let last = 0;
  for (let m = re.exec(hint); m; m = re.exec(hint)) {
    if (m.index > last) parts.push({ kind: 'text', text: hint.slice(last, m.index) });
    if (m[1] !== undefined) parts.push({ kind: 'code', text: m[1] });
    else parts.push(m[3] ? { kind: 'doc', text: m[0], path: m[2], anchor: m[3] } : { kind: 'doc', text: m[0], path: m[2] });
    last = m.index + m[0].length;
  }
  if (last < hint.length) parts.push({ kind: 'text', text: hint.slice(last) });
  return parts;
}

export const docHref = (path: string, anchor?: string) => `/evidence?doc=${encodeURIComponent(path)}${anchor ? `#${anchor}` : ''}`;

/** What to show when a refused call carries no hint of its own. */
export const DEFAULT_GRANT_HINT = 'Refused for this identity: grant the read role listed for this call in docs/credentials.md.';

/** The last time a call answered: this sync's success, else the newest successful run in its history (never "never" when runs succeeded). */
export function lastSuccessOf(c: Pick<CapabilityStatus, 'lastSuccess' | 'health'>): string | undefined {
  if (c.lastSuccess) return c.lastSuccess;
  return c.health?.recentRuns?.filter(r => r.ok).map(r => r.at).sort().pop();
}

/**
 * A call the quick (core-tier) sync skips is reported `not-configured` until the next full sync, although it
 * answered there: read it as answered on the full sync, so "not configured" never sits next to "success 100 %".
 */
export function observedState<C extends Pick<CapabilityStatus, 'state' | 'lastSuccess' | 'health' | 'hint'>>(c: C): C {
  if (c.state !== 'not-configured' || !lastSuccessOf(c)) return c;
  return { ...c, state: 'ok', hint: c.hint ?? 'Read on the full sync; the quicker sync in between does not call it.' };
}

/** Projects whose call did not answer at the last sync (a per-project 403, 503 …), shown on the row and the card. */
export function failingProjects(c: Pick<CapabilityStatus, 'perProject'>): { name: string; state: string; error?: string }[] {
  return (c.perProject ?? []).filter(p => p.state !== 'ok' && p.state !== 'not-configured').map(p => ({ name: p.name ?? p.id, state: p.state.replace(/-/g, ' '), error: p.error }));
}

/** "unreachable in default-project-eu-west1: 503 Service Unavailable" — or the plain state when no project is named. */
export function gapText(c: Pick<CapabilityStatus, 'state' | 'stale' | 'perProject'>): string {
  const failing = failingProjects(c);
  if (!failing.length) return c.stale ? 'stale' : c.state.replace(/-/g, ' ');
  // The HTTP status says enough on the card; without one, the cause in full (F1.30); the full error is on the row.
  return failing.map(f => `${f.state} in ${f.name}${f.error ? ` (${errorReason(f.error)})` : ''}`).join('; ');
}
