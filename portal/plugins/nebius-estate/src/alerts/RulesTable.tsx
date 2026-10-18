import { Fragment } from 'react';
import type { RuleStatus } from '@internal/nebius-domain';
import { Badge, Card, Column, DataTable, fmtNumber, StatusPill } from '../ui';
import { forLabel, ruleReasonShort, SEVERITY_SORT_LABELS, SEVERITY_TONE, severityRank, SOURCE_LABEL } from './model';

/** The order under the initial sort's ties: by who evaluates the rule, then by name. */
const listed = (rules: RuleStatus[]) => [...rules].sort((a, b) => a.source.localeCompare(b.source) || a.name.localeCompare(b.name));

export const ruleColumns: Column<RuleStatus>[] = [
  {
    key: 'name',
    header: 'Rule',
    // The file path breaks after a slash, never inside a name ("fleet.ya / ml").
    render: r => (
      <div>
        <div style={{ fontWeight: 600 }}>{r.name}</div>
        <div className="ne-faint ne-mono" style={{ fontSize: 'var(--ne-fs-caption)' }}>
          {r.file.split('/').map((seg, i, all) => (
            <Fragment key={i}>
              {seg}
              {i < all.length - 1 ? '/' : null}
              {i < all.length - 1 ? <wbr /> : null}
            </Fragment>
          ))}
        </div>
      </div>
    ),
    sortValue: r => r.name,
  },
  { key: 'sev', header: 'Severity', render: r => <Badge tone={SEVERITY_TONE[r.severity]}>{r.severity}</Badge>, sortValue: r => severityRank(r.severity), sortLabels: SEVERITY_SORT_LABELS },
  { key: 'source', header: 'Evaluated by', render: r => SOURCE_LABEL[r.source], sortValue: r => r.source },
  {
    key: 'status',
    header: 'Status',
    render: r => (
      <div className="ne-stack" style={{ gap: 2 }}>
        <StatusPill state={r.status === 'evaluated' ? 'ok' : r.status === 'needs-in-cluster' ? 'optional' : r.status === 'error' ? 'error' : 'not-configured'} label={r.status.replace(/-/g, ' ')} />
        {r.reason ? (
          <span className="ne-faint" style={{ fontSize: 12, overflowWrap: 'anywhere' }} title={r.reason}>
            {ruleReasonShort(r.reason)}
          </span>
        ) : null}
      </div>
    ),
    sortValue: r => r.status,
  },
  // One wording and a numeric sort (G3.9): "0 min", "at once" and "0m" were the same hold; "at once" stays on one line.
  { key: 'for', header: 'For', render: r => <span className="ne-nowrap" title={r.for ? `for: ${r.for}` : undefined}>{r.for ? forLabel(r.forSeconds) : '—'}</span>, sortValue: r => r.forSeconds, width: 90 },
  { key: 'open', header: 'Firing / pending', align: 'right', render: r => `${fmtNumber(r.firing)} / ${fmtNumber(r.pending)}`, sortValue: r => r.firing * 1000 + r.pending },
];

/** Firing and pending rules first, then by who evaluates them and name (G3.11: the one firing rule sat at row 21 of 26). */
export function RulesTable({ rules }: { rules: RuleStatus[] }) {
  return (
    <Card
      flush
      footer="“Needs in-cluster Prometheus”: the rule reads metrics scraped inside a cluster (kube-state-metrics, kubelet or vLLM) that are not in the service-provider metrics the portal reads; with the observability agent, kube-state-metrics and kubelet series also reach the project's ingested Prometheus under other labels (k8s.cluster.id), which the portal does not query yet. It runs in the cluster's own Prometheus when Alertmanager is enabled (modules/o11y, runbooks/alerting.md); it is listed here, never dropped. “For”: how long the condition holds before the alert fires."
    >
      <DataTable caption="Alert rules" columns={ruleColumns} rows={listed(rules)} rowKey={r => r.id} initialSort={{ key: 'open', dir: 'desc' }} />
    </Card>
  );
}
