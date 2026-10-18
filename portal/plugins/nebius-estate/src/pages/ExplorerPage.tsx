import { ReactNode, useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { GraphResponse, RepoModel, ResourceListResponse, ResourceView } from '@internal/nebius-domain';
import { isUnattributed, lifecycleLabel, RESOURCE_TYPE_LABELS } from '@internal/nebius-domain';
import {
  Async,
  Badge,
  Callout,
  Card,
  Chip,
  DataTable,
  fmtGib,
  filterQuery,
  Icon,
  PageShell,
  Segmented,
  StatusPill,
  Tabs,
  useGet,
  useGlobalFilter,
  usePortalNow,
} from '../ui';
import { observedCell } from '../components/observed';
import { ResourceDrawer } from '../components/ResourceDrawer';
import { ResourceGraph } from '../components/ResourceGraph';
import { attributionView, matchesTypeFilter, partialCoverageSentences, SERVICE_GROUPS, serviceOf, shortSummary } from './explorer/catalog';
import { TypeLabel } from './explorer/TypeGlyph';
import { graphCountText } from './explorer/graphView';

type View = 'all' | 'ttl' | 'orphans' | 'unattributed';
const VIEWS: View[] = ['all', 'ttl', 'orphans', 'unattributed'];
const MODES = ['graph', 'table'] as const;

/** A DNS name or CIDR breaks after its dots and slashes, not mid-word (#45: "sandbox.example.inter|nal."). */
function breakAtSeparators(text: string): ReactNode[] {
  return text.split(/(?<=[./])/).flatMap((part, i, all) => (i < all.length - 1 ? [part, <wbr key={i} />] : [part]));
}

export function ExplorerPage() {
  const [filter] = useGlobalFilter();
  const now = usePortalNow();
  const [params, setParams] = useSearchParams();
  // View, mode, type, search and the open resource live in the URL: shareable, and Back undoes a change.
  const q = params.get('q') ?? '';
  const type = params.get('type') ?? '';
  const rawMode = params.get('mode');
  const rawView = params.get('view');
  const mode = MODES.find(m => m === rawMode) ?? 'graph';
  const view = VIEWS.find(v => v === rawView) ?? 'all';
  const unknown = [rawView && !VIEWS.includes(rawView as View) ? `view "${rawView}"` : '', rawMode && !MODES.includes(rawMode as 'graph') ? `mode "${rawMode}"` : ''].filter(Boolean);
  const selected = params.get('uid') ?? undefined;
  const set = (k: string, v?: string, opts: { replace?: boolean } = {}) =>
    setParams(
      prev => {
        const p = new URLSearchParams(prev);
        if (v) p.set(k, v);
        else p.delete(k);
        return p;
      },
      { replace: opts.replace ?? false },
    );
  // Typing does not add a history entry per key.
  const setQ = (v: string) => set('q', v || undefined, { replace: true });
  const setType = (v: string) => set('type', v || undefined);

  const list = useGet<ResourceListResponse>(`/resources${filterQuery(filter)}`);
  const graph = useGet<GraphResponse>(mode === 'graph' ? `/graph${filterQuery(filter)}` : null);
  const repo = useGet<RepoModel>('/repo');

  const items = useMemo(() => {
    const all = list.data?.items ?? [];
    const needle = q.trim().toLowerCase();
    return all.filter(r => {
      if (!matchesTypeFilter(r.type, type)) return false;
      if (view === 'ttl' && r.ttl.state !== 'expired') return false;
      if (view === 'orphans' && !r.orphanReasons?.length) return false;
      if (view === 'unattributed' && !isUnattributed(r)) return false;
      if (needle) {
        const hay = [r.name, r.providerId, r.type, r.projectId, r.region, ...Object.entries(r.labels).map(([k, v]) => `${k}=${v}`)].join(' ').toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [list.data, q, type, view]);
  const matchIds = useMemo(() => new Set(items.map(i => i.uid)), [items]);
  const counts = useMemo(() => {
    const all = list.data?.items ?? [];
    return {
      all: all.length,
      ttl: all.filter(r => r.ttl.state === 'expired').length,
      orphans: all.filter(r => r.orphanReasons?.length).length,
      unattributed: all.filter(isUnattributed).length,
    };
  }, [list.data]);
  const filtering = Boolean(q || type || view !== 'all');
  const typeCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of list.data?.items ?? []) m.set(r.type, (m.get(r.type) ?? 0) + 1);
    return m;
  }, [list.data]);
  const defaults = useMemo(() => new Set((list.data?.items ?? []).filter(r => r.attribution.platformDefault).map(r => r.uid)), [list.data]);
  const projectName = useMemo(() => new Map((list.data?.items ?? []).filter(r => r.type === 'project').map(r => [r.providerId, r.name])), [list.data]);
  const nameById = useMemo(() => new Map((list.data?.items ?? []).map(r => [r.providerId, r.name])), [list.data]);

  return (
    <PageShell
      title="Estate Explorer"
      subtitle="Discovered resources and the relationships their data states explicitly. Nothing is linked by similar names."
      search={q}
      onSearch={setQ}
      filterExtra={
        <select className="ne-select" aria-label="Resource type" value={type} onChange={e => setType(e.target.value)}>
          <option value="">All types</option>
          {SERVICE_GROUPS.map(g => {
            const types = g.types.filter(t => t !== 'tenant');
            const total = types.reduce((n, t) => n + (typeCounts.get(t) ?? 0), 0);
            return (
              <optgroup key={g.id} label={g.label}>
                {types.length > 1 ? <option value={`svc:${g.id}`}>All {g.label} ({total})</option> : null}
                {types.map(t => (
                  <option key={t} value={t}>
                    {RESOURCE_TYPE_LABELS[t]} ({typeCounts.get(t) ?? 0})
                  </option>
                ))}
              </optgroup>
            );
          })}
        </select>
      }
      actions={
        <Segmented
          label="View mode"
          value={mode}
          onChange={v => set('mode', v === 'graph' ? undefined : v)}
          options={[
            { id: 'graph', label: <span className="ne-row" style={{ gap: 5 }}><Icon name="graph" size={14} /> Graph</span> },
            { id: 'table', label: <span className="ne-row" style={{ gap: 5 }}><Icon name="table" size={14} /> Table</span> },
          ]}
        />
      }
    >
      {unknown.length ? (
        <div style={{ marginBottom: 12 }}>
          <Callout tone="warn" title="Not applied from the link">
            Unknown {unknown.join(' and ')}; showing {rawView && view === 'all' ? 'all resources' : 'the default'} instead. Views: all, ttl, orphans, unattributed.
          </Callout>
        </div>
      ) : null}
      <Tabs
        label="Quick views"
        value={view}
        onChange={v => set('view', v === 'all' ? undefined : v)}
        tabs={[
          { id: 'all', label: 'All resources', count: counts.all },
          { id: 'ttl', label: 'TTL expired', count: counts.ttl },
          { id: 'orphans', label: 'Orphan candidates', count: counts.orphans },
          { id: 'unattributed', label: 'Unattributed', count: counts.unattributed },
        ]}
      />
      {list.data?.coverage.some(c => c.partial) ? (
        <div style={{ marginBottom: 12 }}>
          <Callout tone="warn" title="Partial inventory coverage">
            {partialCoverageSentences(list.data.coverage).join(' ')} See <Link to={`/integrations${filterQuery(filter)}`}>Integrations &amp; Coverage</Link>.
          </Callout>
        </div>
      ) : null}
      {view === 'orphans' ? (
        <div style={{ marginBottom: 12 }}>
          <Callout tone="info" title="Candidates, not verdicts">
            <p>
              Rules read explicit fields only: a disk with no attachments and no managing service (<code>status.managedBy</code>), a labelled resource whose parent is
              missing from the snapshot, a GPU cluster no instance uses. A resource is listed only when a rule matched on two consecutive syncs; anything created in the
              last 30 minutes or still provisioning is not evaluated yet (a node&rsquo;s boot disk is attached minutes after it is created).
            </p>
            <p>
              These are candidates for a person to check. The portal never deletes anything: confirm with <code>scripts/leftovers.sh</code> and follow{' '}
              <code>runbooks/teardown.md</code>.
            </p>
          </Callout>
        </div>
      ) : null}
      {mode === 'graph' ? (
        <Card
          title="Relationship graph"
          icon="graph"
          flush
          actions={<span className="ne-faint" style={{ fontSize: 12 }}>Dashed: grouping by project/region field · solid: placement reference · dotted: cross-reference (routes, backed by, in subnet …)<span className="ne-graph-dir"> · read left → right</span></span>}
        >
          <Async load={graph} rows={8}>
            {g =>
              g.nodes.length ? (
                <>
                  <ResourceGraph
                    nodes={g.nodes}
                    edges={g.edges}
                    selected={selected}
                    onSelect={n => (n.uid && !n.uid.startsWith('k8s:') ? set('uid', n.uid) : undefined)}
                    highlight={filtering ? n => (n.uid ? matchIds.has(n.uid) : false) : undefined}
                    defaults={defaults}
                  />
                  <div className="ne-card-foot" data-testid="graph-count">
                    {graphCountText(g.nodes)}. “All resources” ({counts.all}) lists cloud resources only, projects included; here projects and regions are groups.
                  </div>
                  {g.unresolved.length ? (
                    <div className="ne-card-foot">
                      {g.unresolved.length} reference(s) point outside this snapshot and are not drawn (e.g. {g.unresolved[0].relation} → <code>{g.unresolved[0].target}</code>).
                    </div>
                  ) : null}
                </>
              ) : (
                <div className="ne-state">
                  <div className="ne-state-title">No resources in this scope</div>
                  <div>
                    Clear the global filter, or check the connectors on Integrations &amp; Coverage. With no Nebius projects and read-only identity
                    configured, nothing is discovered (docs/portal/nebius-setup.md).
                  </div>
                </div>
              )
            }
          </Async>
        </Card>
      ) : null}
      <div className={mode === 'graph' ? 'ne-section' : undefined}>
        <Card title={`Resources (${items.length})`} icon="table" flush>
          <Async load={list} rows={8}>
            {() => (
              <DataTable<ResourceView>
                caption="Discovered resources"
                rows={items}
                rowKey={r => r.uid}
                selectedKey={selected}
                onRowClick={r => set('uid', r.uid)}
                initialSort={{ key: 'type', dir: 'asc' }}
                maxHeight={mode === 'graph' ? 640 : undefined}
                empty={
                  <div className="ne-state">
                    <div className="ne-state-title">No resources match</div>
                    <div>Change the quick view, type or search, or clear the global filter.</div>
                  </div>
                }
                columns={[
                  {
                    key: 'name',
                    header: 'Name',
                    sortValue: r => r.name,
                    render: r => (
                      <div>
                        <div style={{ fontWeight: 600 }}>{r.name}</div>
                        {/* One line on a wide screen (the full id in the tooltip and the drawer); wrapped on a phone. */}
                        <div className="ne-mono ne-faint ne-ellipsis" title={r.providerId}>
                          {r.providerId}
                        </div>
                      </div>
                    ),
                  },
                  { key: 'type', header: 'Type', sortValue: r => `${SERVICE_GROUPS.indexOf(serviceOf(r.type))}·${RESOURCE_TYPE_LABELS[r.type]}`, render: r => <TypeLabel type={r.type} /> },
                  { key: 'status', header: 'Status', sortValue: r => r.status, render: r => (lifecycleLabel(r.type, r.status) ? <StatusPill state={r.status} label={lifecycleLabel(r.type, r.status)} /> : <span className="ne-faint" title="It groups other resources: no lifecycle status">—</span>) },
                  {
                    key: 'project',
                    header: 'Project · region',
                    // Project, then region: a separator keeps one project's name from running into the region (G1.12).
                    sortValue: r => `${projectName.get(r.projectId ?? '') ?? r.projectId ?? ''}\u0001${r.region ?? ''}`,
                    render: r => (
                      <div>
                        {/* Breaks only between project and region, never inside "eu-north1" (W1F.S8). */}
                        <div title={r.projectId} className="ne-xproj">
                          <span className="ne-nowrap">{(r.projectId && projectName.get(r.projectId)) ?? r.projectId ?? 'no project'}</span>
                          {r.region ? (
                            <span className="ne-muted">
                              {' · '}
                              <span className="ne-nowrap">{r.region}</span>
                            </span>
                          ) : null}
                        </div>
                      </div>
                    ),
                  },
                  {
                    key: 'attr',
                    header: 'Stage / stack',
                    sortValue: r => `${r.attribution.stage ?? 'zz'}${r.attribution.stack ?? ''}`,
                    render: r => {
                      const v = attributionView(r, id => nameById.get(id));
                      if (v.kind === 'attributed') {
                        return (
                          <span>
                            {v.text}
                            {v.via ? <div className="ne-muted" style={{ fontSize: 'var(--ne-fs-caption)' }}>attributed via {v.via}</div> : null}
                          </span>
                        );
                      }
                      if (v.kind === 'project') return <span className="ne-faint" title="Not applicable: projects hold resources; they are not attributed themselves">—</span>;
                      if (v.kind === 'default' || v.kind === 'managed') return <Chip title={v.title}>{v.chip}</Chip>;
                      return (
                        <span title={v.title}>
                          <Badge tone="warn">unattributed</Badge>
                          {v.note ? <div className="ne-muted" style={{ fontSize: 'var(--ne-fs-caption)' }}>{v.note}</div> : null}
                        </span>
                      );
                    },
                  },
                  {
                    key: 'flags',
                    header: 'Flags',
                    render: r => (
                      <div className="ne-row" style={{ gap: 4 }}>
                        {r.ttl.state === 'expired' ? <Badge tone="danger">TTL expired</Badge> : r.ttl.state === 'active' ? <Badge tone="neutral">TTL {r.ttl.hoursLeft} h</Badge> : null}
                        {r.orphanReasons?.length ? <Badge tone="warn" title={r.orphanReasons.join('; ')}>orphan?</Badge> : null}
                        {(r.spec.gpus ?? 0) > 0 ? <Badge tone="accent">{r.spec.gpus} GPU</Badge> : null}
                        {r.spec.public ? <Badge tone="info" title="Public IP address or public endpoint">public</Badge> : null}
                        {shortSummary(r) ? <span className="ne-faint ne-xsummary">{breakAtSeparators(shortSummary(r)!)}</span> : null}
                        {r.spec.sizeGib !== undefined ? <span className="ne-faint ne-num">{fmtGib(r.spec.sizeGib)}</span> : null}
                      </div>
                    ),
                  },
                  { key: 'seen', header: 'Observed', sortValue: r => r.observedAt, sortKind: 'time', render: r => {
                      const c = observedCell(r, now);
                      return c.lastSeen ? <span className="ne-nowrap" title="Not read by the latest inventory sync: it may have changed or gone since">{c.text}</span> : <span className="ne-faint ne-nowrap">{c.text}</span>;
                    },
                  },
                ]}
              />
            )}
          </Async>
        </Card>
      </div>
      <ResourceDrawer uid={selected} onClose={() => set('uid')} onNavigate={uid => set('uid', uid)} now={now} repo={repo.data} resources={list.data?.items} />
    </PageShell>
  );
}
