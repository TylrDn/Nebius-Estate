import { Link } from 'react-router-dom';
import type { ResourceListResponse, WorkloadsResponse, WorkloadSummary } from '@internal/nebius-domain';
import {
  Async,
  Badge,
  Callout,
  Card,
  Chip,
  DataTable,
  EmptyState,
  fmtAgo,
  fmtTime,
  filterQuery,
  PageShell,
  StatusPill,
  useGet,
  useGlobalFilter,
  usePortalNow,
} from '../ui';
import { nodeBadges, nodeSummary, staleReason, uniqueTolerations, workloadHealth } from './workloads/model';

type NodeRow = WorkloadsResponse['clusters'][number]['nodes'][number] & { cluster: string };

/** nodeSelector and tolerations of a workload. The same toleration repeats once per container: listed once. */
export function ConstraintChips({ nodeSelector, tolerations }: Pick<WorkloadSummary, 'nodeSelector' | 'tolerations'>) {
  if (!Object.keys(nodeSelector).length && !tolerations.length) return <span className="ne-faint">none</span>;
  return (
    <div className="ne-row" style={{ gap: 4 }}>
      {Object.entries(nodeSelector).map(([k, v]) => (
        <Chip key={`s:${k}`} title="nodeSelector">
          {k}={v}
        </Chip>
      ))}
      {uniqueTolerations(tolerations).map(t => (
        <Chip key={`t:${t}`} title="toleration">
          {t}
        </Chip>
      ))}
    </div>
  );
}

export function WorkloadsPage() {
  const [filter] = useGlobalFilter();
  const now = usePortalNow();
  const load = useGet<WorkloadsResponse>(`/workloads${filterQuery(filter)}`);
  // A stale snapshot says why: the inventory knows when its cluster is being deleted or gone.
  const anyStale = !!load.data?.clusters.some(c => c.error && !c.staleReason);
  const inventory = useGet<ResourceListResponse>(anyStale ? `/resources${filterQuery(filter)}` : null);

  return (
    <PageShell
      title="Workloads"
      subtitle="Read-only view of the Kubernetes clusters in scope: deployments, stateful sets, jobs, pods, requests and scheduling. Managed Kubernetes clusters are discovered automatically; no kubeconfig upload, no user-supplied cluster URLs."
    >
      <Async load={load} rows={6}>
        {w =>
          w.clusters.length === 0 ? (
            <>
              <Card>
                <EmptyState title="No Kubernetes cluster in scope" icon="workloads">
                  Managed Kubernetes clusters in the listed projects are found and connected automatically once they exist (with the portal&rsquo;s read-only
                  Nebius identity); none is in scope now. Clusters outside Nebius can be added in app-config:{' '}
                  <Link to={`/evidence?doc=${encodeURIComponent('docs/portal/nebius-setup.md')}#kubernetes`}>docs/portal/nebius-setup.md#kubernetes</Link>.
                  {w.inventoryObservedAt ? (
                    <div className="ne-faint" style={{ marginTop: 8, fontSize: 'var(--ne-fs-caption)' }} title={fmtTime(w.inventoryObservedAt)}>
                      Inventory as of {fmtTime(w.inventoryObservedAt)} · {fmtAgo(w.inventoryObservedAt, now)}
                    </div>
                  ) : null}
                </EmptyState>
              </Card>
              {w.soperatorClusters.length ? (
                <div className="ne-section">
                  <SoperatorCard clusters={w.soperatorClusters} reason={w.slurm.reason} />
                </div>
              ) : null}
            </>
          ) : (
            <>
              <div className="ne-grid ne-grid-tiles">
                {w.clusters.map(c => (
                  <section key={c.name} className="ne-card ne-tile" aria-label={`Cluster ${c.name}`}>
                    <div className="ne-between">
                      <strong>{c.name}</strong>
                      <StatusPill state={c.error || c.staleReason ? 'stale' : 'ok'} label={c.error || c.staleReason ? 'stale' : 'synced'} />
                    </div>
                    <div className="ne-tile-reason">Observed {c.observedAt ? `${fmtAgo(c.observedAt, now)} (${fmtTime(c.observedAt)})` : 'never'}</div>
                    {c.error || c.staleReason ? (
                      <div style={{ fontSize: '0.75rem', color: 'var(--ne-warn)' }}>
                        {staleReason(c, inventory.data?.items) ? <strong>{staleReason(c, inventory.data?.items)} </strong> : null}
                        {c.error}
                      </div>
                    ) : null}
                    <div className="ne-tile-reason" data-testid="node-summary">{nodeSummary(c.nodes)}</div>
                    <div className="ne-row" style={{ gap: 4 }} aria-label={`Namespaces in ${c.name}`} role="list">
                      {c.namespaces.length ? (
                        c.namespaces.map(ns => (
                          <span role="listitem" key={ns}>
                            <Chip title="namespace">{ns}</Chip>
                          </span>
                        ))
                      ) : (
                        <span className="ne-faint" role="listitem">no namespace read</span>
                      )}
                    </div>
                    <div className="ne-tile-source">
                      {c.dashboardUrl ? (
                        <a href={c.dashboardUrl} target="_blank" rel="noreferrer">
                          Open cluster UI ↗
                        </a>
                      ) : (
                        'No cluster UI link configured'
                      )}
                    </div>
                  </section>
                ))}
              </div>

              <div className="ne-section">
                <Card title="Workloads" icon="workloads" flush footer="GPU request = nvidia.com/gpu requested per pod × pods. A request is demand, not utilisation; utilisation needs DCGM telemetry (GPU & Capacity).">
                  <DataTable<WorkloadSummary>
                    caption="Workloads"
                    stack
                    rows={w.workloads}
                    rowKey={x => x.uid}
                    initialSort={{ key: 'pending', dir: 'desc' }}
                    columns={[
                      {
                        key: 'name',
                        header: 'Workload',
                        sortValue: x => `${x.cluster}/${x.namespace}/${x.name}`,
                        render: x => (
                          <div>
                            <div style={{ fontWeight: 600 }}>{x.name}</div>
                            <div className="ne-faint" style={{ fontSize: '0.75rem' }}>
                              {x.kind} · {x.cluster}/{x.namespace}
                            </div>
                          </div>
                        ),
                      },
                      { key: 'ready', header: 'Ready', align: 'right', sortValue: x => (x.readyReplicas ?? 0) - (x.replicas ?? 0), render: x => (x.replicas === undefined ? <span className="ne-faint" title="Jobs and pods without a replica count">{x.readyReplicas ?? 0} ready</span> : `${x.readyReplicas ?? 0}/${x.replicas}`) },
                      { key: 'gpu', header: 'GPU / pod', align: 'right', sortValue: x => x.gpuRequest, render: x => (x.gpuRequest ? <Badge tone="accent">{x.gpuRequest}</Badge> : <span className="ne-faint">0</span>) },
                      {
                        key: 'req',
                        header: 'Requests · limits',
                        render: x => (
                          <div className="ne-row" style={{ gap: 4 }}>
                            {Object.entries(x.requests).map(([k, v]) => (
                              <Chip key={k}>
                                {k}={v}
                              </Chip>
                            ))}
                            {Object.keys(x.limits).length ? <span className="ne-faint" style={{ fontSize: 'var(--ne-fs-caption)' }}>limits: {Object.entries(x.limits).map(([k, v]) => `${k}=${v}`).join(', ')}</span> : null}
                          </div>
                        ),
                      },
                      {
                        key: 'pending',
                        header: 'Health · scheduling',
                        sortValue: x => x.pendingPods * 2 + (workloadHealth(x, w.events, w.workloads).tone === 'ok' ? 0 : 1),
                        render: x => {
                          const h = workloadHealth(x, w.events, w.workloads);
                          return (
                            <div>
                              <Badge tone={h.tone} dot>
                                {h.label}
                              </Badge>
                              {h.details.map(m => (
                                <div key={m} style={{ fontSize: '0.75rem', color: 'var(--ne-text-2)', marginTop: 4, maxWidth: 420 }}>
                                  {m}
                                </div>
                              ))}
                            </div>
                          );
                        },
                      },
                      { key: 'constraints', header: 'Constraints', render: x => <ConstraintChips nodeSelector={x.nodeSelector} tolerations={x.tolerations} /> },
                      { key: 'recipe', header: 'Recipe', render: x => (x.recipe ? <Badge tone="info">{x.recipe}</Badge> : <span className="ne-faint" title="No recipe label on the workload">not labelled</span>) },
                    ]}
                  />
                </Card>
              </div>

              <div className="ne-section">
                <Card title="Nodes" icon="workloads" flush footer="State from the Kubernetes API: the Ready condition, spec.unschedulable (cordoned) and metadata.deletionTimestamp (deleting).">
                  <DataTable<NodeRow>
                    caption="Nodes"
                    stack
                    rows={w.clusters.flatMap(c => c.nodes.map(n => ({ ...n, cluster: c.name })))}
                    rowKey={n => `${n.cluster}/${n.name}`}
                    initialSort={{ key: 'state', dir: 'desc' }}
                    empty={<EmptyState title="No nodes reported" />}
                    columns={[
                      { key: 'name', header: 'Node', sortValue: n => `${n.cluster}/${n.name}`, render: n => (
                        <div>
                          <div className="ne-mono" style={{ overflowWrap: 'anywhere' }}>{n.name}</div>
                          <div className="ne-faint" style={{ fontSize: '0.75rem' }}>{n.cluster}</div>
                        </div>
                      ) },
                      { key: 'ng', header: 'Node group', render: n => (n.nodeGroupId ? <span className="ne-mono" style={{ overflowWrap: 'anywhere' }}>{n.nodeGroupId}</span> : <span className="ne-faint">no node-group label</span>) },
                      { key: 'gpus', header: 'GPUs', align: 'right', sortValue: n => n.gpus, render: n => (n.gpus ? <Badge tone="accent">{n.gpus}</Badge> : <span className="ne-faint">0</span>) },
                      {
                        key: 'state',
                        header: 'State',
                        sortValue: n => nodeBadges(n).reduce((a, b) => a + (b.tone === 'danger' ? 4 : b.tone === 'warn' ? 2 : b.tone === 'neutral' ? 1 : 0), 0),
                        render: n => (
                          <div className="ne-row" style={{ gap: 4 }}>
                            {nodeBadges(n).map(b => (
                              <Badge key={b.label} tone={b.tone} dot>
                                {b.label}
                              </Badge>
                            ))}
                          </div>
                        ),
                      },
                    ]}
                  />
                </Card>
              </div>

              <div className={w.soperatorClusters.length ? 'ne-section ne-grid ne-grid-main' : 'ne-section'}>
                <Card title="Recent warning events" icon="warn" flush>
                  <DataTable
                    caption="Events"
                    compact
                    rows={w.events}
                    rowKey={e => `${e.cluster}${e.involved}${e.lastSeen}`}
                    empty={<EmptyState title="No warning events" />}
                    columns={[
                      { key: 'w', header: 'When', render: e => <span className="ne-nowrap ne-muted">{fmtAgo(e.lastSeen, now)}</span> },
                      { key: 'o', header: 'Object', render: e => <span className="ne-mono">{e.involved}</span> },
                      { key: 'r', header: 'Reason', render: e => <Badge tone={e.type === 'Warning' ? 'warn' : 'neutral'}>{e.reason}</Badge> },
                      { key: 'm', header: 'Message', render: e => <span style={{ fontSize: '0.78125rem' }}>{e.message}</span> },
                    ]}
                  />
                </Card>
                {w.soperatorClusters.length ? <SoperatorCard clusters={w.soperatorClusters} reason={w.slurm.reason} /> : null}
              </div>
            </>
          )
        }
      </Async>
    </PageShell>
  );
}

/** Soperator (Slurm on Kubernetes): shown only while a Soperator cluster is in scope (followup 18). */
function SoperatorCard({ clusters, reason }: { clusters: string[]; reason: string }) {
  return (
    <Card title="Soperator (Slurm on Kubernetes)" icon="workloads">
      <div className="ne-stack">
        <Callout tone="warn" title="Slurm queue and accounting: unavailable">
          {reason}
        </Callout>
        <div style={{ fontSize: '0.8125rem' }}>
          Soperator cluster{clusters.length === 1 ? '' : 's'} in scope: {clusters.join(', ')}. Its Kubernetes objects (controller, login, workers) appear in the
          workload table once its cluster is connected.
        </div>
        <div className="ne-stack" style={{ gap: 4, fontSize: '0.8125rem' }}>
          <Link to="/evidence?doc=terraform%2Fstacks%2Fsoperator%2FREADME.md">Soperator recipe (R4)</Link>
          <Link to="/evidence?doc=docs%2Fevidence%2F2026-10-08-soperator-4.1.13-cpu.md">Evidence: sbatch end to end on 4.1.13 (prior upstream run)</Link>
          <Link to="/evidence?doc=runbooks%2Fsoperator-jobs.md">Runbook: Soperator jobs</Link>
        </div>
      </div>
    </Card>
  );
}
