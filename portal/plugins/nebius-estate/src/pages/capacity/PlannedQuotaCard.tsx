import type { MaintenanceView, PlannedQuotaIssue, SourcedMetric } from '@internal/nebius-domain';
import { Badge, Card, DataTable, EmptyState, fmtAgo, fmtNumber, fmtTime } from '../../ui';
import { blockedPlans } from './helpers';
import { prettyEnum, SourceLine, Unavailable } from './parts';
import { QUOTA_REQUEST } from './QuotaSections';

const BASIS: Record<NonNullable<PlannedQuotaIssue['regionBasis']>, string> = {
  observed: 'where it runs; its node groups as observed',
  profile: 'its run profile; not applied yet',
};

/** One quota line in words. An applied root's need is compared with the limit alone: its use is already counted. */
export function plannedIssueText(i: PlannedQuotaIssue): string {
  if (i.state === 'blocked') return `limit 0, needs ${fmtNumber(i.need)}`;
  if (i.regionBasis === 'observed') return `needs ${fmtNumber(i.need)}, above the limit of ${fmtNumber(i.limit)}`;
  return `${fmtNumber(i.usage)} used of ${fmtNumber(i.limit)}, needs ${fmtNumber(i.need)} more`;
}

/**
 * Planned resources blocked by quota: each live root against the tenant allowances of its own region. The same
 * list (and count) as the Overview's "Planned resources blocked by quota" tile.
 */
export function PlannedQuotaCard({ metric, now }: { metric: SourcedMetric<PlannedQuotaIssue[]> | undefined; now: Date }) {
  const roots = blockedPlans(metric?.value);
  const n = roots?.length ?? 0;
  return (
    <Card title={roots ? `Planned resources against quota · ${n} planned root${n === 1 ? '' : 's'} blocked` : 'Planned resources against quota'} icon="lock" footer={metric ? <SourceLine metric={metric} now={now} /> : undefined}>
      {!metric ? (
        <span className="ne-muted">Not reported by this backend version.</span>
      ) : metric.value === null ? (
        <Unavailable what="Planned resources against quota" metric={metric} />
      ) : !metric.value.length ? (
        <EmptyState title="No planned root is blocked by quota in this scope" icon="check">
          Each live root&rsquo;s sizing fits the tenant allowances of its region, for the requirements the quota list covers.
        </EmptyState>
      ) : (
        <ul className="ne-discovery-list" aria-label="Planned roots blocked by quota">
          {roots!.map(plan => {
            const lines = metric.value!.filter(i => i.plan === plan);
            const profiles = [...new Set(lines.map(i => i.profile).filter(Boolean))];
            return (
              <li key={plan}>
                <strong>{plan.replace(/^terraform\/live\//, '')}</strong>{' '}
                <span className="ne-faint">
                  in {lines[0].region}{lines[0].regionBasis ? ` (${BASIS[lines[0].regionBasis]})` : ''}
                  {profiles.length ? ` · run profile ${profiles.join(', ')}` : ''}
                </span>
                <ul>
                  {lines.map(i => (
                    <li key={`${i.region}/${i.profile ?? ''}/${i.quota}`}>
                      {profiles.length > 1 && i.profile ? `${i.profile} · ` : ''}
                      {i.description ?? i.quota}: {plannedIssueText(i)}{' '}
                      <span className="ne-mono ne-faint">{i.quota}</span> <span className="ne-faint">({i.what})</span>
                    </li>
                  ))}
                </ul>
              </li>
            );
          })}
          <li className="ne-faint">Request quota in the console: {QUOTA_REQUEST}.</li>
        </ul>
      )}
    </Card>
  );
}

/** Scheduled maintenance in scope (maintenance.v1alpha1): the list the Overview's tile counts. */
export function MaintenanceCard({ metric, now }: { metric: SourcedMetric<MaintenanceView[]> | undefined; now: Date }) {
  return (
    <Card title="Scheduled maintenance" icon="clock" flush footer={metric ? <SourceLine metric={metric} now={now} /> : undefined}>
      {!metric ? (
        <div className="ne-card-body ne-muted">Not reported by this backend version.</div>
      ) : metric.value === null ? (
        <div className="ne-card-body">
          <Unavailable what="Scheduled maintenance" metric={metric} />
        </div>
      ) : (
        <DataTable<MaintenanceView>
          caption="Scheduled maintenance"
          compact
          rows={metric.value}
          rowKey={m => m.id}
          empty={<EmptyState title="No scheduled maintenance in these projects">The maintenance API answered with nothing scheduled or in progress.</EmptyState>}
          columns={[
            { key: 'n', header: 'Maintenance', render: m => <strong className="ne-cap-wrap">{m.name}</strong> },
            { key: 's', header: 'State', render: m => <Badge tone="info">{prettyEnum(m.state)}</Badge> },
            {
              key: 'w',
              header: 'When',
              sortValue: m => m.scheduledAt ?? m.startedAt ?? '',
              render: m => {
                const at = m.scheduledAt ?? m.startedAt;
                return at ? <span title={fmtTime(at)}>{m.startedAt && !m.scheduledAt ? `started ${fmtAgo(at, now)}` : fmtAgo(at, now)}</span> : <span className="ne-faint">time not given</span>;
              },
            },
            { key: 'a', header: 'Affected', align: 'right', render: m => (m.affected.length ? <span title={m.affected.join('\n')}>{fmtNumber(m.affected.length)}</span> : <span className="ne-faint">none listed</span>) },
          ]}
        />
      )}
    </Card>
  );
}
