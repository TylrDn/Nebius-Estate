import type { AlertsResponse, GlobalFilter, SourcedMetric } from '@internal/nebius-domain';
import { filterQuery, useGet, useGlobalFilter } from '../ui';
import type { AttentionRow } from '../pages/overview/parts';
import { subjectText } from './model';

/** The rule that turns each project cap below the tenant limit into an alert; the caps row lists the same facts. */
export const PROJECT_CAP_RULE = 'ProjectAllowanceBelowTenant';

/** Open alerts in the whole global filter (project, region and stage), for the Overview's "Alerts firing" row. */
export function useAlertsAttention() {
  const [filter] = useGlobalFilter();
  return useGet<AlertsResponse>(`/alerts${filterQuery(filter, { state: 'open' })}`);
}

/**
 * The "Alerts firing" attention row: unmuted firing alerts in the filter, linking to Alerts with the same filter
 * (G1.2). `capsListed`: how many project caps the Overview lists in a row of its own; while that row is shown, the
 * project-cap alerts are not counted a second time here (G1.4).
 */
export function alertsAttentionRow(load: { data?: AlertsResponse; error?: Error }, filter: GlobalFilter, capsListed: number): AttentionRow {
  const all = load.data?.alerts.filter(a => a.state === 'firing' && !a.muted);
  const capAlerts = capsListed ? (all?.filter(a => a.ruleName === PROJECT_CAP_RULE) ?? []) : [];
  const firing = all?.filter(a => !capAlerts.includes(a));
  const metric: SourcedMetric = load.data
    ? { value: firing!.length, source: 'Alert rules (platform/alerts), evaluated after each sync', observedAt: load.data.lastEvalAt }
    : { value: null, source: 'Alert rules (platform/alerts)', unavailableReason: load.error ? `Alerts could not be read: ${load.error.message}` : 'Loading alerts…' };
  const note = load.data?.filterNote;
  return {
    label: 'Alerts firing',
    metric,
    to: `/alerts${filterQuery(filter)}`,
    tone: (firing?.some(a => a.severity === 'critical') ? 'danger' : 'warn') as 'danger' | 'warn',
    setup: 'runbooks/fleet-alerts.md',
    ...(capAlerts.length && !firing?.length ? { zeroLabel: `${capAlerts.length} firing, all project caps (listed below)` } : {}),
    detail:
      firing?.length || note ? (
        <ul className="ne-ov-mini">
          {firing?.slice(0, 3).map(a => (
            <li key={a.id}>
              <span className="ne-ov-break">{a.summary}</span> <span className="ne-faint">· {[subjectText(a).project, a.severity].filter(Boolean).join(' · ')}</span>
            </li>
          ))}
          {firing && firing.length > 3 ? <li className="ne-faint">+{firing.length - 3} more on Alerts</li> : null}
          {firing?.length && capAlerts.length ? <li className="ne-faint">+ {capAlerts.length} project-cap alert{capAlerts.length === 1 ? '' : 's'}, listed below</li> : null}
          {note ? <li className="ne-faint">{note}</li> : null}
        </ul>
      ) : null,
  };
}
