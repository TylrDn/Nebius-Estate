import { historyFooter, utilisationTitle } from '@internal/nebius-domain';
import type { BillingSummaryResponse, BudgetsResponse, HistoryResponse, LivePriceResponse, OverviewResponse, RunRateResponse, SourcedMetric } from '@internal/nebius-domain';
import {
  Async,
  Badge,
  Card,
  EmptyState,
  fmtMoneyList,
  fmtNumber,
  filterQuery,
  Meter,
  PageShell,
  TrendChart,
  useGet,
  useGlobalFilter,
  usePortalNow,
  useProjectNames,
} from '../ui';
import { billingMetric, budgetSpendLine, filterNotApplied, SETUP } from './overview/model';
import { useAlertsAttention } from '../alerts/attention';
import { AttentionTile, BudgetsTile, ConnectorSummary, GpuSchedulingChecks, LiveRunRateTile, RateBookRunRateTile, SourcedTile, TelemetryLines } from './overview/parts';

/** Combines the three Kubernetes GPU numbers into one tile without merging their meaning. */
function gpuDemand(o: OverviewResponse): SourcedMetric<{ requested: number; allocatable: number; pending: number }> {
  if (o.k8sRequestedGpus.value === null || o.k8sAllocatableGpus.value === null) {
    // "No running Kubernetes cluster" (a deleting cluster's last snapshot is not current) is not a setup gap.
    return { value: null, source: o.k8sRequestedGpus.source, unavailableReason: o.k8sRequestedGpus.unavailableReason, empty: o.k8sRequestedGpus.empty, observedAt: o.k8sRequestedGpus.observedAt };
  }
  // The API names clusters it left out (deleting or gone) after its own note.
  const left = o.k8sAllocatableGpus.note?.match(/Not counted: .*$/)?.[0];
  return {
    value: { requested: o.k8sRequestedGpus.value, allocatable: o.k8sAllocatableGpus.value, pending: o.pendingGpuPods.value ?? 0 },
    source: o.k8sRequestedGpus.source,
    observedAt: o.k8sRequestedGpus.observedAt,
    note: `Requested by pods / allocatable on nodes. A request is demand, not utilisation.${left ? ` ${left}` : ''}`,
  };
}

export function OverviewPage() {
  const [filter] = useGlobalFilter();
  const now = usePortalNow();
  const overview = useGet<OverviewResponse>(`/overview${filterQuery(filter)}`);
  const history = useGet<HistoryResponse>(`/history${filterQuery(filter, { days: '30' })}`);
  // Budgets come from one place, the Budgets & credits page (stored ones, plus deprecated config ones read-only).
  const budgets = useGet<BudgetsResponse>('/budgets');
  const billing = useGet<BillingSummaryResponse>(`/billing/summary${filterQuery({ project: filter.project, region: filter.region }, { metric: 'BilledCost', dimension: 'service' })}`);
  const runrate = useGet<RunRateResponse>(`/runrate${filterQuery(filter)}`);
  const liveRate = useGet<LivePriceResponse>(`/runrate/live${filterQuery(filter)}`);
  const alerts = useAlertsAttention();
  const projectName = useProjectNames();
  const billingIgnores = filterNotApplied(filter, ['project', 'region']);

  return (
    <PageShell title="Overview" subtitle="What is running, what it costs and what needs attention. Every number names its source; a missing source shows as Unavailable, never as zero.">
      <Async load={overview} rows={6}>
        {o => {
          const demand = gpuDemand(o);
          if (o.emptyScope) {
            // One banner for the whole page instead of a wall of "Unavailable" tiles: nothing is missing, the filter matches nothing.
            return (
              <>
                <EmptyState title={o.emptyScope} icon="info">
                  Nothing needs setting up: no project carries this filter. Change or clear the filter above.
                </EmptyState>
                <div className="ne-section">
                  <ConnectorSummary statuses={o.connectors} />
                </div>
              </>
            );
          }
          return (
            <>
              {/* What needs a look comes first, full width; the numbers follow. */}
              <AttentionTile o={o} now={now} alerts={alerts} projectName={projectName} />

              <h2 className="ne-section-title ne-section">Running now</h2>
              <div className="ne-grid ne-grid-tiles">
                <SourcedTile
                  label="Projects · regions"
                  icon="explorer"
                  metric={o.projects}
                  now={now}
                  setup={SETUP.inventory}
                  render={v => `${v.length} project${v.length === 1 ? '' : 's'} · ${o.regions.value?.length ?? 0} region${o.regions.value?.length === 1 ? '' : 's'}`}
                  extra={<div className="ne-tile-reason">{o.regions.value?.join(', ')}</div>}
                />
                <SourcedTile
                  label="GPUs on running VMs"
                  icon="gpu"
                  tone="accent"
                  metric={o.gpuInventory}
                  now={now}
                  setup={SETUP.inventory}
                  render={v => fmtNumber(v.gpus)}
                  extra={
                    <>
                      <div className="ne-row" style={{ marginTop: 2, gap: 4 }}>
                        {Object.entries(o.gpuInventory.value?.byPlatform ?? {}).map(([p, n]) => (
                          <Badge key={p} tone="accent">
                            {p} × {n}
                          </Badge>
                        ))}
                      </div>
                      {o.cpuInventory.value ? <div className="ne-tile-reason">{fmtNumber(o.cpuInventory.value.vcpus)} vCPUs on running VMs</div> : null}
                    </>
                  }
                />
                <SourcedTile
                  label="GPU demand (Kubernetes)"
                  icon="workloads"
                  tone={demand.value?.pending ? 'warn' : undefined}
                  metric={demand}
                  now={now}
                  setup={SETUP.kubernetes}
                  render={v => (
                    <>
                      {fmtNumber(v.requested)}
                      <span className="ne-tile-unit">{' '}/ {fmtNumber(v.allocatable)} allocatable</span>
                    </>
                  )}
                  extra={demand.value?.pending ? <Badge tone="warn" dot>{demand.value.pending} GPU pod(s) pending</Badge> : null}
                />
                <SourcedTile
                  label={utilisationTitle('latest')}
                  icon="gpu"
                  metric={o.gpuUtilization}
                  now={now}
                  setup={SETUP.telemetry}
                  render={v => fmtNumber(v.meanPercent, 1)}
                  extra={
                    o.gpuUtilization.value ? (
                      <Meter percent={o.gpuUtilization.value.meanPercent} label={utilisationTitle('latest')} />
                    ) : null
                  }
                  always={<TelemetryLines metric={o.gpuTelemetry} now={now} tileSource={o.gpuUtilization.source} setup={o.gpuUtilization.value ? SETUP.telemetry : undefined} />}
                />
              </div>

              <GpuSchedulingChecks checks={o.gpuSchedulingChecks} />

              <h2 className="ne-section-title ne-section">Spend</h2>
              <div className="ne-grid ne-grid-tiles">
                <SourcedTile
                  label="Reported cost (BilledCost)"
                  icon="costs"
                  setup={SETUP.billing}
                  metric={billingMetric(billing, now)}
                  now={now}
                  render={v => (v.length ? fmtMoneyList(v) : <span className="ne-ov-small">No cost in the imported period</span>)}
                  extra={
                    <>
                      {billing.data && budgetSpendLine(billing.data.report) ? <div className="ne-tile-reason">{budgetSpendLine(billing.data.report)}</div> : null}
                      {/* Billing rows are selected by project and region only: a stage filter says it does not apply (G1.1). */}
                      {billingIgnores ? (
                        <Badge tone="neutral" wrap>
                          {billingIgnores}
                        </Badge>
                      ) : null}
                    </>
                  }
                />
                <LiveRunRateTile live={liveRate} book={runrate} now={now} />
                <RateBookRunRateTile book={runrate} now={now} />
                <BudgetsTile load={budgets} filter={filter} />
              </div>

              <div className="ne-section">
                <Trends load={history} />
              </div>

              {/* One line and a link: the table is on Integrations (F1.15). */}
              <div className="ne-section">
                <ConnectorSummary statuses={o.connectors} />
              </div>
            </>
          );
        }}
      </Async>
    </PageShell>
  );
}

function Trends({ load }: { load: ReturnType<typeof useGet<HistoryResponse>> }) {
  return (
    <Card title="Trends · last 30 days" icon="costs" footer={load.data ? historyFooter(load.data) : undefined}>
      <Async load={load} rows={3}>
        {h =>
          h.points.length < 2 ? (
            <p className="ne-muted" style={{ margin: 0 }}>
              Not enough history yet: the portal records one point per day from its own syncs, so trends appear after the second day.
            </p>
          ) : (
            <div className="ne-grid ne-grid-2" style={{ gap: 20 }}>
              <Trend label="GPUs on running VMs" points={h.points.map(p => ({ day: p.day, value: p.gpus, note: p.incomplete }))} color="var(--ne-chart-1)" />
              <Trend label="vCPUs on running VMs" points={h.points.map(p => ({ day: p.day, value: p.vcpus }))} color="var(--ne-chart-4)" />
              <Trend label={`${utilisationTitle('daily')} (%)`} points={h.points.map(p => ({ day: p.day, value: p.gpuUtilMean, note: p.incomplete }))} color="var(--ne-chart-5)" max={100} empty="No telemetry samples in this window." />
              <Trend label="TTL expired + orphan candidates" points={h.points.map(p => ({ day: p.day, value: p.ttlExpired + p.orphanCandidates }))} color="var(--ne-chart-3)" />
            </div>
          )
        }
      </Async>
    </Card>
  );
}

function Trend({ label, points, color, max, empty }: { label: string; points: { day: string; value: number | null; note?: string }[]; color: string; max?: number; empty?: string }) {
  const last = [...points].reverse().find(p => p.value !== null);
  return (
    <div>
      <div className="ne-between" style={{ marginBottom: 4 }}>
        <span className="ne-label">{label}</span>
        <span className="ne-num" style={{ fontWeight: 650 }}>
          {last ? fmtNumber(last.value as number, 1) : <span className="ne-faint">no data</span>}
        </span>
      </div>
      {points.some(p => p.value !== null) ? (
        <TrendChart points={points} label={`${label}, daily`} valueLabel={label} color={color} max={max} />
      ) : (
        <p className="ne-faint" style={{ margin: 0, fontSize: 12.5 }}>
          {empty ?? 'No data in this window.'}
        </p>
      )}
    </div>
  );
}
