import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { SourcedMetric } from '@internal/nebius-domain';
import { Callout, fmtAgo, fmtNumber, fmtTime, Meter, StatusPill } from '../../ui';
import { fmtQuotaAmount, LEVEL_LABEL, LEVEL_TONE, meterTone, parseUnavailable, unitLabel, usageLevel, usagePercent } from './helpers';

/** Where the credentials guide opens in the portal (Evidence & Runbooks renders repository docs). */
export const CREDENTIALS_DOC = `/evidence?doc=${encodeURIComponent('docs/credentials.md')}`;

/** Project id -> display name (API names from /filters), id when unknown. */
export type ProjectNamer = (id: string) => string;

/** "Source · observed 6 min ago" plus the metric's note, for card footers. */
export function SourceLine({ metric, now, extra }: { metric: SourcedMetric<unknown>; now: Date; extra?: ReactNode }) {
  return (
    <span>
      <span className="ne-mono">{metric.source}</span>
      {metric.observedAt ? <span title={fmtTime(metric.observedAt)}> · observed {fmtAgo(metric.observedAt, now)}</span> : null}
      {metric.note ? <> · {metric.note}</> : null}
      {extra ? <> {extra}</> : null}
    </span>
  );
}

/**
 * A capability that answered nothing: the state as a pill and the backend's reason, never a zero.
 * Tenant-level reads that were refused also name the role to grant and link the credentials guide.
 */
export function Unavailable({ what, metric, tenant }: { what: string; metric: SourcedMetric<unknown>; tenant?: boolean }) {
  const { state, text } = parseUnavailable(metric.unavailableReason);
  const denied = state === 'permission-denied';
  return (
    <div className="ne-cap-unavailable">
      <Callout tone={denied ? 'warn' : 'info'} icon={denied ? 'lock' : 'unavailable'} title={`${what}: unavailable`}>
        <span className="ne-cap-unavailable-body">
          {state ? <StatusPill state={state} /> : null}
          {denied && tenant ? (
            <span>
              This is a tenant-level read and the portal&rsquo;s identity is refused. Grant <code>security-auditor</code> on the tenant (a tenant-level read role;{' '}
              <code>viewer</code> on the tenant also works) to the portal&rsquo;s group, as described in <Link to={CREDENTIALS_DOC}>docs/credentials.md</Link>. The next sync
              picks it up; nothing here changes.
            </span>
          ) : null}
          <span>
            {denied && tenant ? 'API said: ' : null}
            {text}
          </span>
          {denied && !tenant ? (
            <span>
              See <Link to={CREDENTIALS_DOC}>docs/credentials.md</Link>.
            </span>
          ) : null}
        </span>
      </Callout>
    </div>
  );
}

/** Usage against a limit with a meter; never invents a zero for a missing figure. */
export function UsageCell({ usage, limit, percent, unit, label }: { usage: number | null; limit: number | null; percent?: number | null; unit?: string; label: string }) {
  const x = { usage, limit, usagePercent: percent ?? null };
  const level = usageLevel(x);
  const p = usagePercent(x);
  return (
    <div className="ne-cap-usage">
      <div className="ne-between ne-cap-usage-figures">
        <span className="ne-num">
          {usage === null ? <span className="ne-faint">usage not reported</span> : fmtQuotaAmount(usage, unit)} / {limit === null ? <span className="ne-faint">limit not reported by the API</span> : fmtQuotaAmount(limit, unit)}
          {/* Bytes carry their unit (GiB / TiB); "count" needs none. */}
          {unit && !/^bytes?$/i.test(unit) && unitLabel(unit) ? <span className="ne-faint"> {unitLabel(unit)}</span> : null}
        </span>
        <span className="ne-num" data-level={level}>
          {/* The status carries a limit 0 (and the alarm); the figure states only the share. */}
          {p === null ? (level === 'zero-limit' ? (usage ? 'above limit' : null) : LEVEL_LABEL[level]) : `${fmtNumber(p, 1)} %`}
        </span>
      </div>
      {p !== null ? <Meter percent={p} tone={meterTone(level)} label={label} /> : null}
    </div>
  );
}

export function LevelBadge({ usage, limit, percent, allocation }: { usage: number | null; limit: number | null; percent?: number | null; allocation?: 'set' | 'inherits-tenant' }) {
  const level = usageLevel({ usage, limit, usagePercent: percent ?? null, allocation });
  return <StatusPill state={LEVEL_TONE[level] === 'danger' ? 'over' : LEVEL_TONE[level] === 'warn' ? 'near' : LEVEL_TONE[level] === 'ok' ? 'under' : 'unknown'} label={LEVEL_LABEL[level]} />;
}

/** "STATE_ACTIVE" -> "active", "LEVEL_HIGH" -> "high". */
export function prettyEnum(v: string | undefined): string {
  if (!v) return 'not stated';
  return v.replace(/^(STATE|LEVEL|USAGE_STATE|AVAILABILITY)_/, '').replace(/_/g, ' ').toLowerCase();
}
