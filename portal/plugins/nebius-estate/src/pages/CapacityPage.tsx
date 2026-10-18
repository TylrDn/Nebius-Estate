import { useCallback, useState } from 'react';
import { historyFooter, reservationEvidence, utilisationTitle } from '@internal/nebius-domain';
import type { CapacityResponse, FilterOptions, HistoryPoint, NodeGroupCapacity, RepoModel } from '@internal/nebius-domain';
import {
  Async,
  Badge,
  Callout,
  Card,
  DataTable,
  fmtAgo,
  fmtNumber,
  fmtTime,
  filterQuery,
  Meter,
  PageShell,
  Reference,
  StatTile,
  TrendChart,
  useGet,
  useGlobalFilter,
  usePortalNow,
  useScrollToHash,
} from '../ui';
import { FootprintCalculator } from './capacity/Calculator';
import { GpuTelemetryCard } from './capacity/GpuTelemetryCard';
import { MaintenanceCard, PlannedQuotaCard } from './capacity/PlannedQuotaCard';
import { PlatformsCard } from './capacity/PlatformsCard';
import { CapacityAllowancesCard, QuotasCard } from './capacity/QuotaSections';
import { BlockGroupsCard, ResourceAdviceCard } from './capacity/TenantSections';
import { EstateBlockers, NodeGroupQuotaCell } from './capacity/EstateBlockers';

/**
 * The page's sections, in order, for the "On this page" row (ids below; Overview links land on some of them). What
 * people act on comes first; reference sections follow, folded (F1.13), and open when a link names them.
 */
const CONTENTS = [
  { id: 'quotas', label: 'Quotas' },
  { id: 'planned-quota', label: 'Blocked plans' },
  { id: 'maintenance', label: 'Maintenance' },
  { id: 'node-groups', label: 'Node groups' },
  { id: 'reservations', label: 'Reservations' },
  { id: 'availability', label: 'Availability' },
  { id: 'platforms', label: 'Platforms' },
  { id: 'gpu-telemetry', label: 'GPU telemetry' },
  { id: 'stage-policy', label: 'Stage policy' },
  { id: 'calculator', label: 'Calculator' },
];

const CAP_TONE = { 'on-demand': 'info', preemptible: 'warn', reserved: 'ok', unknown: 'neutral' } as const;

export function CapacityPage() {
  const [filter] = useGlobalFilter();
  const now = usePortalNow();
  const cap = useGet<CapacityResponse>(`/capacity${filterQuery(filter)}`);
  const repo = useGet<RepoModel>('/repo');
  const history = useGet<{ points: HistoryPoint[]; source: string; note?: string }>(`/history${filterQuery(filter, { days: '30' })}`);
  const filters = useGet<FilterOptions>('/filters');
  const projectName = useCallback((id: string) => filters.data?.projects.find(p => p.id === id)?.name ?? id, [filters.data]);
  // Overview links land on #quotas, #planned-quota and #maintenance.
  useScrollToHash(Boolean(cap.data && repo.data));

  return (
    <PageShell
      title="GPU & Capacity"
      subtitle="What exists, what the quotas and reservations allow, what workloads ask for and what telemetry measures: different numbers, kept apart."
      contents={CONTENTS}
    >
      <Async load={cap} rows={6}>
        {c => {
          // Who uses a reservation, against the block-group list (F1.10): the Reservations and Availability cards agree.
          const reservations = reservationEvidence(c.capacityBlockGroups.value, c.capacityAllowances.value, c.nodeGroups, {
            region: filter.region,
            hidden: c.blockGroupsOutsideFilter,
          });
          // Regions the estate uses (node groups, and the regions of planned roots): a Compute limit 0 there is an alarm;
          // elsewhere it is a fact.
          const targets = new Set(
            [...c.nodeGroups.map(g => g.region), ...(c.plannedQuotaIssues?.value ?? []).map(i => i.region), filter.region].filter((r): r is string => Boolean(r)),
          );
          return (
            <>
              {c.emptyScope ? (
                <Callout title={c.emptyScope}>Quotas, planned roots and allowance checks are empty because the filter matches no project, not because an allowance is missing. Change or clear the filter above.</Callout>
              ) : null}
              <EstateBlockers nodeGroups={c.nodeGroups} quotas={c.quotas.value} />
              <div className="ne-grid ne-grid-tiles">
                <StatTile
                  label="GPUs present (cloud)"
                  icon="gpu"
                  tone="accent"
                  now={now}
                  metric={c.gpusPresent}
                  render={v => fmtNumber(v)}
                />
                <StatTile label="GPUs requested by pods" icon="workloads" now={now} metric={{ ...c.requests, value: c.requests.value ? c.requests.value.requestedGpus : null }} render={v => fmtNumber(v)} />
                <StatTile label="Pending GPU pods (unscheduled demand)" icon="clock" tone={c.requests.value?.pendingGpuPods ? 'warn' : undefined} now={now} metric={{ ...c.requests, value: c.requests.value ? c.requests.value.pendingGpuPods : null }} render={v => fmtNumber(v)} />
                <StatTile
                  label={utilisationTitle('latest')}
                  icon="gpu"
                  now={now}
                  metric={c.utilization}
                  render={v => `${fmtNumber(v.meanPercent, 1)} %`}
                  extra={
                    <div className="ne-stack" style={{ gap: 4, marginTop: 4 }}>
                      {c.utilization.value?.perNode.map(n => (
                        <div key={n.node}>
                          <div className="ne-between" style={{ fontSize: 'var(--ne-fs-caption)' }}>
                            <span className="ne-mono ne-muted">{n.node}</span>
                            <span className="ne-num">{fmtNumber(n.percent, 1)} %</span>
                          </div>
                          <Meter percent={n.percent} label={`GPU utilisation ${n.node}`} />
                        </div>
                      ))}
                    </div>
                  }
                />
              </div>

              <div className="ne-section" id="quotas">
                <QuotasCard metric={c.quotas} name={projectName} now={now} targets={targets} planned={c.plannedQuotaIssues} allowances={c.allowanceCheck} tenantGap={c.tenantQuotasGap} emptyScope={c.emptyScope} project={filter.project} platforms={c.platforms.value} />
              </div>

              <div className="ne-section" id="planned-quota">
                <PlannedQuotaCard metric={c.plannedQuotaIssues} now={now} />
              </div>

              <div className="ne-section" id="maintenance">
                <MaintenanceCard metric={c.maintenances} now={now} />
              </div>

              <div className="ne-section" id="node-groups">
                <Card title="Node groups" icon="gpu" flush footer="Nodes: observed · configured, from each node group's spec (fixed size or autoscaling min–max). A node group's bounds and a quota are ceilings; neither guarantees that physical capacity is available.">
                  <DataTable<NodeGroupCapacity>
                    caption="Node groups"
                    rows={c.nodeGroups}
                    rowKey={g => g.uid}
                    initialSort={{ key: 'gpus', dir: 'desc' }}
                    empty={<div className="ne-state"><div className="ne-state-title">No node groups in scope</div><div>Node groups come from the Nebius inventory connector (Integrations &amp; Coverage).</div>{c.nodeGroupsObservedAt ? <div className="ne-faint" style={{ fontSize: 'var(--ne-fs-caption)' }} title={fmtTime(c.nodeGroupsObservedAt)}>Node groups read {fmtTime(c.nodeGroupsObservedAt)} · {fmtAgo(c.nodeGroupsObservedAt, now)}</div> : null}</div>}
                    columns={[
                      { key: 'name', header: 'Cluster / node group', sortValue: g => `${g.cluster}/${g.name}`, render: g => <div><div style={{ fontWeight: 600 }}>{g.name}</div><div className="ne-faint" style={{ fontSize: '0.75rem' }}>{g.cluster} · {g.region ?? 'region not stated'}</div></div> },
                      { key: 'preset', header: 'Platform · preset', render: g => <span className="ne-mono">{g.platform ?? 'platform not stated'} · {g.preset ?? 'preset not stated'}</span> },
                      // Observed beside the spec in one column, so the quota check next to it reads against both and the table fits 1440 px.
                      {
                        key: 'nodes',
                        header: 'Nodes',
                        sortValue: g => g.nodes,
                        render: g => (
                          <span>
                            <span className="ne-num">{fmtNumber(g.nodes)}</span>
                            <span className="ne-faint"> · {g.fixedNodeCount !== undefined ? `fixed ${g.fixedNodeCount}` : g.autoscaling ? `autoscale ${g.autoscaling.min}–${g.autoscaling.max}` : 'bounds unknown'}</span>
                          </span>
                        ),
                      },
                      { key: 'quota', header: 'Quota check', render: g => <NodeGroupQuotaCell g={g} quotas={c.quotas.value} /> },
                      { key: 'gpus', header: 'GPUs (present)', align: 'right', sortValue: g => g.gpusPerNode * g.nodes, render: g => (g.gpusPerNode ? `${g.gpusPerNode * g.nodes} (${g.gpusPerNode}/node)` : <span className="ne-faint">CPU</span>) },
                      {
                        key: 'util',
                        header: utilisationTitle('latest'),
                        align: 'right',
                        sortValue: g => g.gpuUtil?.meanPercent ?? -1,
                        render: g =>
                          g.gpuUtil ? (
                            <span title={`Mean of ${g.gpuUtil.gpusReporting} reporting GPU(s) at their latest sample, Nebius Monitoring`}>{fmtNumber(g.gpuUtil.meanPercent, 1)} %</span>
                          ) : g.gpusPerNode ? (
                            <span className="ne-faint">no series</span>
                          ) : (
                            <span className="ne-faint" title="Not applicable: a CPU node group">n/a</span>
                          ),
                      },
                      { key: 'cap', header: 'Capacity type', sortValue: g => g.capacityType, render: g => <Badge tone={CAP_TONE[g.capacityType]}>{g.capacityType}</Badge> },
                      { key: 'fabric', header: 'Fabric', render: g => (g.fabric ? <span className="ne-mono">{g.fabric}</span> : <span className="ne-faint">no GPU cluster</span>) },
                    ]}
                  />
                </Card>
              </div>

              {c.standaloneGpuVms.length ? (
                <div className="ne-section">
                  <Card title="Standalone GPU VMs" icon="gpu" flush footer="Not part of a Managed Kubernetes node group: no Kubernetes requests are collected for them. Only running VMs count toward GPUs present, as on the Overview.">
                    <DataTable
                      caption="Standalone GPU VMs"
                      rows={c.standaloneGpuVms}
                      rowKey={v => v.uid}
                      columns={[
                        { key: 'n', header: 'VM', render: v => <strong>{v.name}</strong> },
                        { key: 'p', header: 'Platform · preset', render: v => <span className="ne-mono">{v.platform} · {v.preset}</span> },
                        { key: 's', header: 'Status', render: v => <Badge tone={v.status === 'running' ? 'ok' : 'neutral'}>{v.status}</Badge> },
                        { key: 'g', header: 'GPUs', align: 'right', render: v => v.gpus },
                        { key: 'c', header: 'Capacity type', render: v => <Badge tone={CAP_TONE[v.capacityType as keyof typeof CAP_TONE] ?? 'neutral'}>{v.capacityType}</Badge> },
                      ]}
                    />
                  </Card>
                </div>
              ) : null}

              <div className="ne-section ne-stack" style={{ gap: 14 }} id="reservations">
                <CapacityAllowancesCard metric={c.capacityAllowances} blockGroups={c.capacityBlockGroups} name={projectName} now={now} evidence={reservations} />
                <BlockGroupsCard metric={c.capacityBlockGroups} now={now} evidence={reservations} />
              </div>

              <Reference id="availability" title="Capacity availability" hint="where on-demand, preemptible and reserved capacity is advised, by region and preset">
                <ResourceAdviceCard metric={c.resourceAdvice} now={now} reservations={reservations} />
              </Reference>

              <Reference id="platforms" title="Platforms & presets" hint="the GPU platforms and presets the live API offers, against platform/regions.yaml">
                <PlatformsCard metric={c.platforms} yaml={repo.data?.regions} yamlError={repo.error?.message} cap={c} region={filter.region} name={projectName} now={now} />
              </Reference>

              <Reference id="gpu-telemetry" title="GPU telemetry per GPU" hint={`utilisation, temperature, power and memory of each GPU at its latest sample${history.data && history.data.points.length > 1 ? ', and 30-day trends' : ''}`}>
                <div className="ne-stack" style={{ gap: 14 }}>
                  <GpuTelemetryCard metric={c.gpuTelemetry} name={projectName} now={now} />
                  {history.data && history.data.points.length > 1 ? (
                    <Card title="GPUs present vs. GPU utilisation · 30 days" icon="costs" footer={historyFooter(history.data)}>
                      <div className="ne-grid ne-grid-2" style={{ gap: 20 }}>
                        <div>
                          <div className="ne-label" style={{ marginBottom: 4 }}>GPUs on running VMs</div>
                          <TrendChart points={history.data.points.map(p => ({ day: p.day, value: p.gpus, note: p.incomplete }))} label="GPUs on running VMs, daily" valueLabel="GPUs" />
                        </div>
                        <div>
                          <div className="ne-label" style={{ marginBottom: 4 }}>{utilisationTitle('daily')} (%)</div>
                          <TrendChart points={history.data.points.map(p => ({ day: p.day, value: p.gpuUtilMean, note: p.incomplete }))} label={utilisationTitle('daily')} valueLabel="%" color="var(--ne-chart-5)" max={100} />
                        </div>
                      </div>
                    </Card>
                  ) : null}
                </div>
              </Reference>
            </>
          );
        }}
      </Async>

      <Async load={repo} rows={4}>
        {r => (
          <>
            <Reference id="stage-policy" title="Stage policy and region prerequisites" hint="the caps per stage in platform/stages.yaml, and what each region offers">
              <div className="ne-stack" style={{ gap: 14 }}>
                <StagePolicyCard repo={r} />
                <PrerequisitesCard repo={r} region={filter.region} />
              </div>
            </Reference>
            <Reference id="calculator" title="Footprint calculator" hint="what a plan needs from the quotas at its minimum, expected and maximum node counts">
              <FootprintCalculator repo={r} quotas={cap.data?.quotas.value} defaultRegion={filter.region} name={projectName} />
            </Reference>
          </>
        )}
      </Async>
    </PageShell>
  );
}

/** Column titles of the GPU caps; any other key of max_gpu_nodes is shown under its own name. */
const CAP_TITLES: Record<string, string> = {
  inference: 'Inference GPU nodes',
  training: 'Training GPU nodes',
  'gpu-vm': 'GPU VMs (R10)',
  nvl: 'NVL rack nodes (R15)',
};

/** Every cap key the stages carry, in a fixed order (G2.11: gpu-vm and nvl are the caps a batch run meets). */
export function stageCapKeys(repo: Pick<RepoModel, 'stages'>, of: 'max_gpu_nodes' | 'require_strict_reservation'): string[] {
  const keys = new Set(Object.values(repo.stages.stages).flatMap(v => Object.keys(v.policy[of] ?? {})));
  const order = Object.keys(CAP_TITLES);
  return [...keys].sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99) || a.localeCompare(b));
}

export function StagePolicyCard({ repo }: { repo: RepoModel }) {
  const rows = Object.entries(repo.stages.stages);
  const caps = stageCapKeys(repo, 'max_gpu_nodes');
  const strict = stageCapKeys(repo, 'require_strict_reservation');
  return (
    <Card title="Stage policy caps" icon="lock" flush footer="platform/stages.yaml, enforced at plan time by the stacks and by conftest (make policy). A cap of 0 refuses any plan of that kind in the stage.">
      <DataTable
        caption="Stage policy"
        compact
        rows={rows}
        rowKey={([s]) => s}
        columns={[
          { key: 's', header: 'Stage', render: ([s]) => <strong>{s}</strong> },
          ...caps.map(k => ({
            key: `cap-${k}`,
            header: CAP_TITLES[k] ?? `${k} GPU nodes`,
            wrapHeader: true,
            align: 'right' as const,
            render: ([, v]: (typeof rows)[number]) => {
              const n = (v.policy.max_gpu_nodes as Record<string, number | undefined>)[k];
              return n === undefined ? <span className="ne-faint">not set</span> : n === 0 ? <Badge tone="danger">0: refused</Badge> : `≤ ${n}`;
            },
          })),
          { key: 'p', header: 'Preemptible serving', render: ([, v]) => (v.policy.allow_preemptible_serving ? <Badge tone="warn">allowed</Badge> : <Badge tone="neutral">refused</Badge>) },
          {
            key: 'r',
            header: 'STRICT reservation',
            render: ([, v]) => {
              const req = strict.filter(k => (v.policy.require_strict_reservation as Record<string, boolean | undefined>)[k]);
              return req.length ? <span className="ne-row" style={{ gap: 4, flexWrap: 'wrap' }}>{req.map(k => <Badge key={k} tone="ok">{k}</Badge>)}</span> : <span className="ne-faint">not required</span>;
            },
          },
          { key: 'ttl', header: 'TTL label', render: ([, v]) => (v.policy.require_ttl_label ? 'required' : <span className="ne-faint">not required</span>) },
        ]}
      />
    </Card>
  );
}

function PrerequisitesCard({ repo, region }: { repo: RepoModel; region?: string }) {
  const [sel, setSel] = useState(region && repo.regions.regions[region] ? region : Object.keys(repo.regions.regions)[0]);
  const reg = repo.regions.regions[sel];
  return (
    <Card
      title="Region prerequisites"
      icon="explorer"
      actions={
        <select className="ne-select" aria-label="Region" value={sel} onChange={e => setSel(e.target.value)}>
          {Object.keys(repo.regions.regions).map(r => (
            <option key={r}>{r}</option>
          ))}
        </select>
      }
      footer="platform/regions.yaml (verified against docs.nebius.com). CPU, storage and fabric needs come from docs/capacity.md; quota defaults vary by region — request them before any apply."
    >
      {reg.note ? (
        <div style={{ marginBottom: 10 }}>
          <Callout tone="warn">{reg.note}</Callout>
        </div>
      ) : null}
      <DataTable
        caption="GPU platforms in region"
        compact
        rows={Object.entries(reg.platforms)}
        rowKey={([p]) => p}
        columns={[
          { key: 'p', header: 'Platform', render: ([p]) => <span className="ne-mono">{p}{p === reg.default ? ' (default)' : ''}</span> },
          { key: '1', header: '1-GPU preset', render: ([, e]) => (e.single_gpu_preset ? <span className="ne-mono">{e.single_gpu_preset}</span> : <span className="ne-faint">none</span>) },
          { key: '8', header: '8-GPU (IB) preset', render: ([, e]) => (e.ib_preset ? <span className="ne-mono">{e.ib_preset}</span> : <span className="ne-faint">none</span>) },
          { key: 'f', header: 'Fabric', render: ([, e]) => (e.fabric ? <span className="ne-mono">{e.fabric}</span> : <Badge tone="neutral">no GPU cluster</Badge>) },
          { key: 'd', header: 'Driver', render: ([, e]) => (e.drivers_preset ? <span className="ne-mono">{e.drivers_preset}</span> : <span className="ne-faint">stack default</span>) },
        ]}
      />
      <p className="ne-muted" style={{ fontSize: '0.75rem', margin: '10px 0 0' }}>
        Kubernetes versions accepted for new clusters: {repo.regions.kubernetes_versions.join(', ')}.
      </p>
    </Card>
  );
}
