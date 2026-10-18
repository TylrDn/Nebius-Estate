import type { ReactNode } from 'react';
import { connectorState, plainError, refusedByProject } from '@internal/nebius-domain';
import type { CapabilityStatus, ConnectorStatus } from '@internal/nebius-domain';
import { Badge, Callout, Card, fmtAgo, fmtTime, Icon, KeyValue, ProjectNames, StatusPill } from '../../ui';
import { countStates, fmtRate, gapText, needsAttention, parseHint, rateTone } from './model';
import { HealthSummary, HintText } from './parts';

/** "a", "a and b", "a, b and c". */
const listText = (items: string[]) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

/**
 * Why a connector's card stays open for a look, or undefined when there is nothing to look at (answering, no error, no
 * gap, no failed run). An ok connector can still need a look (a flaky call): said, so the "ok" count and the Healthy
 * group are read together (W1-P29).
 */
export function lookReason(s: ConnectorStatus, capabilities: CapabilityStatus[], outages?: ReadonlySet<string>): string | undefined {
  if (s.state !== 'ok') return s.state.replace(/-/g, ' ');
  if (s.error) return 'an error at the last sync';
  if (s.running) return 'a sync is running';
  const look = capabilities.filter(needsAttention).length;
  if (look) return `${look} call${look === 1 ? '' : 's'} need${look === 1 ? 's' : ''} a look`;
  if (!capabilities.length && s.missingCoverage.length) return 'a coverage gap';
  if (s.health?.consecutiveFailures) return 'its last run failed';
  if (s.health && (rateTone(s.health, outages) === 'warn' || rateTone(s.health, outages) === 'danger')) return 'flaky: it failed on its own in the last 24 h';
  return undefined;
}

/** A connector with nothing to look at: its card folds its detail away. */
export const isHealthy = (s: ConnectorStatus, capabilities: CapabilityStatus[], outages?: ReadonlySet<string>): boolean => !lookReason(s, capabilities, outages);

/**
 * How fresh a connector's data is. One that answers on demand (live prices: priced when a page asks, cached for a
 * while) has no staleness window, and says so instead of "stale after 0 min".
 */
export function freshnessText(s: Pick<ConnectorStatus, 'freshnessMinutes' | 'staleAfterMinutes' | 'state'>): string {
  if (s.freshnessMinutes === undefined) return s.state === 'not-configured' || s.state === 'optional' || s.state === 'not-needed' ? 'not applicable' : 'no answer yet';
  if (!s.staleAfterMinutes) return `${s.freshnessMinutes} min since the last answer · on demand: priced when a page asks, never stale`;
  return `${s.freshnessMinutes} min (stale after ${s.staleAfterMinutes} min)`;
}

/** Only what the calls show: "Every call answered", or how many were not made because nothing is set up. */
export function answeredText(capabilities: CapabilityStatus[]): string {
  const notSetUp = capabilities.filter(c => c.state === 'not-configured').length;
  if (!notSetUp) return 'Every call answered.';
  if (notSetUp === capabilities.length) return `No call made: not set up (${notSetUp} call${notSetUp === 1 ? '' : 's'}).`;
  return `Every call made answered; ${notSetUp} not set up.`;
}

/**
 * One connector: scope, permissions, freshness, failure state and run health. For a connector whose
 * calls are listed as capabilities, the gaps come from the last sync (the calls that did not
 * answer), not from a hand-written list.
 */
export function ConnectorCard({
  s,
  capabilities,
  now,
  canSync,
  syncing,
  onSync,
  outages,
}: {
  s: ConnectorStatus;
  /** The capabilities this connector's sync calls; empty for connectors without per-call status. */
  capabilities: CapabilityStatus[];
  now: Date;
  canSync: boolean;
  syncing: boolean;
  onSync: () => void;
  /** Sync attempts every call failed at (sharedOutages): not counted against this connector (G1.6). */
  outages?: ReadonlySet<string>;
}) {
  const running = !!s.running;
  // A connector the backend retired (its cluster was deleted): a fact, not a failure, and nothing to sync.
  const retired = s.state === 'disabled' && /^Retired\b/.test(s.notes?.[0] ?? '');
  const gaps = capabilities.filter(needsAttention);
  const healthy = isHealthy(s, capabilities, outages);
  const view = connectorState(s);
  const partial = view.state === 'partial';
  const refused = partial ? refusedByProject(capabilities) : [];
  const detail = (
    <>
      {s.notes?.length ? (
        <div style={{ marginTop: 10 }}>
          <Callout tone="info" title={retired ? 'Retired' : s.state === 'waiting' ? 'Waiting' : 'Last sync'}>
            {s.notes.map(n => (
              <div key={n} className="ne-u1-wrap">{n}</div>
            ))}
          </Callout>
        </div>
      ) : null}
      {s.health ? (
        <div className="ne-u1-sub">
          <h3 className="ne-u1-subtitle">Health</h3>
          <HealthSummary health={s.health} now={now} outages={outages} />
        </div>
      ) : null}
    </>
  );
  return (
    <Card
      title={s.title}
      icon="integrations"
      actions={
        <>
          {running ? (
            <Badge tone="info" title={s.runningSince ? `Started ${fmtTime(s.runningSince)}` : undefined}>
              sync in progress
            </Badge>
          ) : null}
          {/* A partial connector's label names its gaps (W1F.S3): long, so it wraps. */}
          <StatusPill state={retired ? 'disabled' : view.state} label={retired ? 'retired' : view.label} wrap />
        </>
      }
      footer={
        <div className="ne-between">
          <span className="ne-u1-wrap">
            Setup: {parseHint(s.setup).some(p => p.kind === 'doc') ? <HintText hint={s.setup} /> : <code>{s.setup}</code>}
          </span>
          {canSync && !retired && s.state !== 'not-configured' && s.state !== 'optional' && s.state !== 'not-needed' ? (
            // aria-disabled, not disabled: a disabled button drops keyboard focus to <body> (WCAG 2.4.3).
            <button
              type="button"
              className="ne-btn ne-btn-sm"
              aria-disabled={syncing || running ? 'true' : undefined}
              onClick={syncing || running ? undefined : onSync}
            >
              <Icon name="refresh" size={13} /> {syncing ? 'Syncing…' : running ? 'Sync in progress…' : 'Sync now'}
              <span className="ne-sr-only">{` (${s.title})`}</span>
            </button>
          ) : null}
        </div>
      }
    >
      {healthy ? (
        // Nothing to look at: what it reads and how fresh, one line of health; the rest one click away.
        <>
          <KeyValue
            items={[
              ['Scope', <ProjectNames key="scope" summary={s.scope} projects={s.projects} />],
              ['Last success', s.lastSuccess ? `${fmtAgo(s.lastSuccess, now)} · ${fmtTime(s.lastSuccess)}` : 'never'],
              ['Freshness', freshnessText(s)],
              ...(s.health
                ? ([['Runs (24 h)', <span key="r" className="ne-num">{s.health.runs24h ? `${s.health.runs24h} · ${fmtRate(s.health)} succeeded` : fmtRate(s.health)}</span>]] as [string, ReactNode][])
                : []),
            ]}
          />
          <details className="ne-more">
            <summary>Permissions, services and run history</summary>
            <KeyValue
              items={[
                ['Permissions', s.permissions],
                ['Services', s.services.join(', ') || 'none listed'],
                ['Last attempt', s.lastAttempt ? `${fmtAgo(s.lastAttempt, now)} · ${fmtTime(s.lastAttempt)}` : 'never'],
              ]}
            />
            {detail}
          </details>
        </>
      ) : (
        <>
          <KeyValue
            items={[
              ['Scope', <ProjectNames key="scope" summary={s.scope} projects={s.projects} />],
              ['Permissions', s.permissions],
              ['Services', s.services.join(', ') || 'none listed'],
              ['Last attempt', s.lastAttempt ? `${fmtAgo(s.lastAttempt, now)} · ${fmtTime(s.lastAttempt)}` : 'never'],
              ['Last success', s.lastSuccess ? `${fmtAgo(s.lastSuccess, now)} · ${fmtTime(s.lastSuccess)}` : 'never'],
              ['Freshness', freshnessText(s)],
            ]}
          />
          {s.notes?.length ? (
            <div style={{ marginTop: 10 }}>
              <Callout tone="info" title={retired ? 'Retired' : s.state === 'waiting' ? 'Waiting' : 'Last sync'}>
                {s.notes.map(n => (
                  <div key={n} className="ne-u1-wrap">{n}</div>
                ))}
              </Callout>
            </div>
          ) : null}
        </>
      )}
      {partial ? (
        // Some calls refused while the sync ran: the refusals by project, in plain words (F1.14); the calls are listed below.
        <div style={{ marginTop: 10 }}>
          <Callout tone="warn" title={`Partial: ${view.label.replace(/^partial \((.*)\)$/, '$1')}`}>
            {refused.map(r => (
              <div key={r.project} className="ne-u1-wrap">
                {`${r.project} refused ${listText(r.calls)}.`}
              </div>
            ))}
            <div className="ne-u1-wrap">The sync itself ran, so its runs count as succeeded; these calls inside it were refused. Each names the role to grant in the list of calls.</div>
          </Callout>
        </div>
      ) : s.error && s.state === 'not-configured' ? (
        <div style={{ marginTop: 10 }}>
          <Callout tone="info" title="Not set up">
            <span className="ne-u1-wrap">
              {s.error.charAt(0).toUpperCase() + s.error.slice(1)}. See <HintText hint={s.setup} />.
            </span>
          </Callout>
        </div>
      ) : s.error ? (
        <div style={{ marginTop: 10 }}>
          <Callout tone={s.state === 'permission-denied' ? 'warn' : 'danger'} title={s.state === 'permission-denied' ? 'Permission denied' : 'Last error'}>
            <span className="ne-u1-wrap">{plainError(s.error, s.projects)}</span>
          </Callout>
        </div>
      ) : null}
      {s.health && !healthy ? (
        <div className="ne-u1-sub">
          <h3 className="ne-u1-subtitle">Health</h3>
          <HealthSummary health={s.health} now={now} outages={outages} />
        </div>
      ) : null}
      {capabilities.length ? (
        <div className="ne-u1-sub">
          <h3 className="ne-u1-subtitle">Calls at the last sync</h3>
          <div className="ne-row" style={{ gap: 4 }}>
            {countStates(capabilities).map(([state, n]) => (
              <StatusPill key={state} state={state} label={`${n} ${state.replace(/-/g, ' ')}`} />
            ))}
          </div>
          {gaps.length ? (
            <div className="ne-muted ne-u1-gaps">
              <strong style={{ color: 'var(--ne-text-2)' }}>Not covered now:</strong> {gaps.map(c => `${c.title} (${gapText(c)})`).join('; ')}
            </div>
          ) : (
            <div className="ne-muted ne-u1-gaps">{answeredText(capabilities)}</div>
          )}
        </div>
      ) : s.state === 'not-needed' ? (
        <div className="ne-muted ne-u1-gaps">{s.missingCoverage.join(' ')}</div>
      ) : s.missingCoverage.length ? (
        <div className="ne-muted ne-u1-gaps">
          <strong style={{ color: 'var(--ne-text-2)' }}>Known gaps:</strong> {s.missingCoverage.join('; ')}
        </div>
      ) : null}
    </Card>
  );
}
