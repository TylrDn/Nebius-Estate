/**
 * How a connector's state reads on the Overview and Integrations: a sync that ran while some of its calls were
 * refused is "partial", not "permission denied" beside a 100 % success rate; API errors are shown in plain words,
 * without the host or the JSON body (F1.14, F1.15).
 */
import type { CapabilityStatus, ConnectorStatus } from './api';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const failedText = (c: { failed: number; total: number }) => `${c.failed} of ${plural(c.total, 'call')} failed`;

/** Calls refused at the last sync: the "(permission denied)" coverage gaps, else one per "; "-separated error. */
function refusedCount(s: Pick<ConnectorStatus, 'missingCoverage' | 'error'>): number {
  const gaps = s.missingCoverage.filter(m => /\(permission denied\)$/.test(m)).length;
  if (gaps) return gaps;
  return s.error ? s.error.split('; ').filter(Boolean).length : 0;
}

/** A connector's coverage gaps by kind: refused (403), failing or rejected (unreachable, 400, schema drift …), waiting for data (404). */
export interface GapCounts {
  refused: number;
  failing: number;
  waiting: number;
}

/** Counts "<title> (<state>)" coverage entries by kind: a 404 on data nobody has written yet is not a refusal. */
export function gapCounts(missingCoverage: string[]): GapCounts {
  const c = { refused: 0, failing: 0, waiting: 0 };
  for (const m of missingCoverage) {
    const state = /\(([a-z -]+)\)$/.exec(m)?.[1];
    if (state === 'permission denied') c.refused++;
    else if (state === 'not found') c.waiting++;
    else c.failing++;
  }
  return c;
}

/**
 * The one wording of a connector's gaps (W1F.S3), on its card, in the Integrations table and in the Overview line:
 * "3 calls refused, 2 failing or rejected, 1 waiting for data" ("calls" once, on the first figure).
 */
export function gapText(c: GapCounts): string {
  const parts = [
    c.refused ? ['refused', c.refused] : undefined,
    c.failing ? ['failing or rejected', c.failing] : undefined,
    c.waiting ? ['waiting for data', c.waiting] : undefined,
  ].filter((x): x is [string, number] => Boolean(x));
  return parts.map(([word, n], i) => (i ? `${n} ${word}` : `${plural(n, 'call')} ${word}`)).join(', ');
}

export interface ConnectorStateView {
  /** A StatusPill state: the connector's own, or `partial`. */
  state: string;
  label: string;
  /** Calls refused at the last sync (0 unless the connector reports refusals). */
  refused: number;
  /** Other coverage gaps of a connector with refusals (not found, schema drift, rejected …), so a summary matches the card. */
  otherGaps: number;
  /** Calls of the last sync that got no answer, of how many (a degraded connector); absent otherwise. */
  failedCalls?: { failed: number; total: number };
  /** A partial connector's gaps by kind, as its label words them. */
  gaps?: GapCounts;
}

/**
 * A connector the backend marks permission-denied that still synced (it has a last success) answered some calls
 * and was refused others: "partial (3 calls refused)". Refused outright, it stays "permission denied".
 */
export function connectorState(s: Pick<ConnectorStatus, 'state' | 'lastSuccess' | 'missingCoverage' | 'error' | 'calls'>): ConnectorStateView {
  const refused = s.state === 'permission-denied' ? refusedCount(s) : 0;
  const otherGaps = refused ? s.missingCoverage.filter(m => !/\(permission denied\)$/.test(m)).length : 0;
  if (s.state === 'permission-denied' && s.lastSuccess && refused) {
    const gaps = { ...gapCounts(s.missingCoverage), refused };
    return { state: 'partial', label: `partial (${gapText(gaps)})`, refused, otherGaps, gaps };
  }
  // Some calls of the last sync got no answer (F1.31): say how many, so "degraded" is never read as "slow".
  if (s.state === 'degraded' && s.calls?.failed) {
    const failedCalls = { failed: s.calls.failed, total: s.calls.total };
    return { state: 'degraded', label: `degraded (${failedText(failedCalls)})`, refused, otherGaps, failedCalls };
  }
  return { state: s.state, label: s.state.replace(/-/g, ' '), refused, otherGaps };
}

/**
 * Why one call failed, short enough for a card: its HTTP status when it has one, else its message after the URL, in
 * full: "fetch failed (ECONNRESET: read ECONNRESET) after 9 attempts in 28 s" (F1.30: a 60-character cut left "fetch fa").
 */
export function errorReason(error: string): string {
  const status = /→ ([45]\d\d)\b/.exec(error)?.[1] ?? /^\s*([45]\d\d)\b/.exec(error)?.[1];
  if (status) return status;
  return error.replace(/^(?:(?:GET|POST|HEAD) )?https?:\/\/[^\s:]+(?::\d+)?[^\s:]*:\s*/, '');
}

/** States that ask for a look, worst first; the rest are facts (waiting, not needed, not set up …). */
const NEEDS_LOOK = ['error', 'permission-denied', 'stale', 'degraded', 'partial'];

/** Connectors with nothing to apply to (an optional connector, one another source makes unneeded): not applicable, never a gap (W1-P28). */
export const NOT_APPLICABLE_STATES = ['optional', 'not-needed'];

/** Facts about a connector that ask for nothing now (waiting for a cluster, starting, not set up, retired). */
const FACTS = ['waiting', 'starting', 'not-configured', 'disabled'];

export interface HealthSegment {
  text: string;
  /** The connector state this segment counts (`connectorState(s).state`): the filter its chip opens on Integrations (W1-P29). */
  state: string;
  /** How many connectors the segment counts: the same number the filtered table lists. */
  count: number;
  /** Set only on what needs a look: the Overview badges these segments and leaves the rest as text. */
  tone?: 'warn' | 'danger';
  /** A grey "not applicable" state (optional, not needed): never counted as a gap (W1-P28). */
  notApplicable?: boolean;
}

/** The state a connector is counted and filtered under: its view state (partial, degraded …), the same everywhere. */
export const connectorFilterState = (s: Pick<ConnectorStatus, 'state' | 'lastSuccess' | 'missingCoverage' | 'error' | 'calls'>) => connectorState(s).state;

/**
 * The one line for every connector (#7, W1-P29): "14 connectors: 10 ok · 1 partial (3 calls refused …) · 2 waiting ·
 * 1 not needed". Each state is counted once and only under its own name (a not-needed connector is not counted as ok), so
 * every segment equals the rows the Integrations table shows under that state's filter (`connectorFilterState`).
 * `segments` carry a tone only where something needs a look; `attention` counts those connectors; `tone` is the worst.
 */
export function connectorHealthLine(statuses: Pick<ConnectorStatus, 'state' | 'lastSuccess' | 'missingCoverage' | 'error' | 'calls'>[]): {
  text: string;
  head: string;
  tone: 'ok' | 'warn' | 'danger';
  attention: number;
  segments: HealthSegment[];
} {
  const views = statuses.map(connectorState);
  const groups = new Map<string, { n: number; gaps: GapCounts; failed: number; total: number }>();
  for (const v of views) {
    const g = groups.get(v.state) ?? { n: 0, gaps: { refused: 0, failing: 0, waiting: 0 }, failed: 0, total: 0 };
    const add = v.gaps ?? { refused: 0, failing: 0, waiting: 0 };
    groups.set(v.state, {
      n: g.n + 1,
      gaps: { refused: g.gaps.refused + add.refused, failing: g.gaps.failing + add.failing, waiting: g.gaps.waiting + add.waiting },
      failed: g.failed + (v.failedCalls?.failed ?? 0),
      total: g.total + (v.failedCalls?.total ?? 0),
    });
  }
  // ok first, then what needs a look (worst first), then facts, then what does not apply.
  const ORDER = ['ok', ...NEEDS_LOOK, ...FACTS, ...NOT_APPLICABLE_STATES];
  const order = (s: string) => (ORDER.includes(s) ? ORDER.indexOf(s) : ORDER.length);
  const toneOf = (s: string) => (!NEEDS_LOOK.includes(s) ? undefined : NEEDS_LOOK.indexOf(s) < 3 ? ('danger' as const) : ('warn' as const));
  const segments: HealthSegment[] = [...groups.entries()]
    .sort((a, b) => order(a[0]) - order(b[0]) || a[0].localeCompare(b[0]))
    .map(([state, g]) => {
      // The card's own words (gapText), summed over the connectors in this state (W1F.S3).
      const text =
        state === 'partial'
          ? `${g.n} partial (${gapText(g.gaps)})`
          : state === 'degraded' && g.failed
            ? `${g.n} degraded (${failedText(g)})`
            : `${g.n} ${state.replace(/-/g, ' ')}`;
      const tone = toneOf(state);
      return { text, state, count: g.n, ...(tone ? { tone } : {}), ...(NOT_APPLICABLE_STATES.includes(state) ? { notApplicable: true } : {}) };
    });
  const attention = views.filter(v => NEEDS_LOOK.includes(v.state)).length;
  const danger = segments.some(r => r.tone === 'danger');
  const head = `${plural(statuses.length, 'connector')}:`;
  return { text: `${head} ${segments.map(x => x.text).join(' · ')}`, head, tone: danger ? 'danger' : attention ? 'warn' : 'ok', attention, segments };
}

/**
 * An API error in plain words: "GET http://host/vpc/v1/networks → 403: {"code":7,"message":"PermissionDenied"}"
 * reads "GET /vpc/v1/networks → 403 PermissionDenied". The host and the JSON body go; the method, path, status and
 * message stay. The body runs to the next "; " (the separator between calls) or the end, so nested objects such as a
 * gRPC details array go with it. A body cut off mid-message keeps what it has, marked with "…". Other text is left as it is.
 */
export function plainError(text: string, projects: { id: string; name?: string }[] = []): string {
  const names = new Map(projects.filter(p => p.name).map(p => [p.id, p.name!]));
  return (
    text
      .replace(/\b(GET|POST|PUT|PATCH|DELETE) https?:\/\/[^/\s]+(\/[^\s]*) → (\d{3}): (\{(?:(?!; )[^])*)/g, (_m, method: string, path: string, code: string, body: string) => {
        const message = /"message"\s*:\s*"([^"]*)("?)/.exec(body);
        const said = message ? ` ${message[1]}${message[2] ? '' : '…'}` : '';
        return `${method} ${path} → ${code}${said}`;
      })
      // Any other URL keeps its path, not the host: a network error ("https://host/path: fetch failed (ECONNRESET: …)")
      // and a call that failed after its retries ("https://host/path → 503 after 4 attempts", W1F.N3).
      .replace(/\bhttps?:\/\/[^/\s]+(\/[^\s:]*)/g, '$1')
      // Project ids read as the names the connector knows (`ConnectorStatus.projects`, scoped to the caller).
      .replace(/\bproject-[a-z0-9]+\b/g, id => names.get(id) ?? id)
  );
}

/**
 * One inventory error as the connector's error line: "Container registries in project-…: <message>", with the call's
 * title where it is known (W1F.N3: the line read "project-… registry.registries: https://host/… → 503 after 4
 * attempts"). The project stays an id here, so a project-scoped caller's view can mask it; `plainError` with the
 * connector's projects shows the name.
 */
export function inventoryErrorLine(e: { project: string; service: string; message: string }, call?: string): string {
  return `${call ?? e.service} in ${e.project}: ${e.message}`;
}

/**
 * Several "; "-separated errors as one line for a table cell: the first in plain words and in full, then a count.
 * `total` is how many errors the text stands for (ConnectorStatus.errorCount) when it keeps only the first few.
 */
export function errorSummary(text: string, total?: number, projects?: { id: string; name?: string }[]): string {
  const [first, ...rest] = plainError(text, projects).split('; ').filter(Boolean);
  const more = Math.max(rest.length, (total ?? 0) - 1);
  return `${first ?? ''}${more ? ` (+${more} more)` : ''}`;
}

/** Refused calls grouped by the project that refused them (names from the per-project outcomes). */
export function refusedByProject(capabilities: CapabilityStatus[]): { project: string; calls: string[] }[] {
  const out = new Map<string, string[]>();
  const add = (project: string, call: string) => out.set(project, [...(out.get(project) ?? []), call]);
  for (const c of capabilities) {
    if (c.state !== 'permission-denied') continue;
    const refused = (c.perProject ?? []).filter(p => p.state === 'permission-denied');
    if (refused.length) for (const p of refused) add(p.name ?? p.id, c.title);
    else add(c.scope === 'tenant' ? 'the tenant' : 'every project', c.title);
  }
  return [...out.entries()].map(([project, calls]) => ({ project, calls }));
}

/**
 * Why no tenant quota allowances are in hand, from the state of their list (quotas.allowances.tenant). Without a
 * tenant id the list is never called ("not configured"): that is not a missing role, and saying so sent the owner
 * after a grant that was already in place (F1.33).
 */
export function tenantAllowancesGap(c: Pick<CapabilityStatus, 'state' | 'hint'> | undefined): string {
  const state = c?.state ?? 'not-configured';
  switch (state) {
    case 'not-configured':
      return 'the tenant id is not known: set NEBIUS_TENANT_ID, or it is read from a project once a project read succeeds';
    case 'permission-denied':
      return 'the portal identity needs a tenant-level read role';
    case 'unreachable':
      return 'the tenant allowance list did not answer at the last sync';
    case 'ok':
      return 'the tenant allowance list is empty';
    case 'schema-drift':
      return 'the tenant allowance list answered in a shape the portal does not read (schema drift)';
    default:
      return `the tenant allowance list answered "${state.replace(/-/g, ' ')}"`;
  }
}

/**
 * A billing export import as information, not a gap (#5): "Last import: <file> (<month>), N rows". The object key's
 * folders can hold the billing account and customer ids (#6): only the file name and a YYYY-MM month from the key are
 * shown. Several files: the first named, the rest counted.
 */
export function lastImportNote(imported: ({ key: string; rows: number } | { key: string; removed: true })[]): string | undefined {
  if (!imported.length) return undefined;
  const rows = (n: number) => `${n} row${n === 1 ? '' : 's'}`;
  const count = (x: (typeof imported)[number]) => ('rows' in x ? x.rows : 0);
  const [first, ...rest] = imported;
  const file = first.key.split('/').filter(Boolean).pop() ?? first.key;
  const month = /(?:^|\/)(\d{4}-\d{2})(?:-\d{2})?(?:\/|$)/.exec(first.key)?.[1] ?? /(\d{4}-\d{2})/.exec(first.key)?.[1];
  const more = rest.length ? `; ${rest.length} more file${rest.length === 1 ? '' : 's'} (${rows(rest.reduce((a, r) => a + count(r), 0))})` : '';
  // An import deleted since is named as removed, never as an import of 0 rows.
  return `Last import: ${file}${month ? ` (${month})` : ''}, ${'rows' in first ? rows(first.rows) : 'since removed'}${more}`;
}
