import { useEffect, useRef, useState } from 'react';
import type { ConnectorStatus, CoverageEntry, IntegrationsResponse, NebiusDocsResponse, SyncResponse } from '@internal/nebius-domain';
import { ApiError, Async, Badge, Callout, Card, DataTable, fmtTime, PageShell, ProjectNames, Quiet, Reference, useBackend, useGet, useGlobalFilter, useMediaQuery, usePortalNow, useScrollToHash, NARROW_QUERY } from '../ui';
import { CapabilityGroups } from './integrations/CapabilityGroups';
import { ConnectorCard, isHealthy, lookReason } from './integrations/ConnectorCard';
import { MatrixCard } from './integrations/MatrixCard';
import { SetupChecklist } from './integrations/SetupChecklist';
import { capabilitiesOf, incidentTitle, observedState, syncIncidents } from './integrations/model';
import { ConnectorStateChips, ConnectorTable, connectorFilterHref } from './overview/parts';
import { Link, useSearchParams } from 'react-router-dom';
import { connectorFilterState, docsCoverage, NOT_APPLICABLE_STATES } from '@internal/nebius-domain';
import { DocsCoverageTable } from './nebiusDocs/DocsCoverage';

export interface CoverageRow {
  key: string;
  connector: string;
  projects: { id: string; name?: string }[];
  /** "all 9 projects", "3 projects" or one project's name. */
  label: string;
  services: string[];
  partial: boolean;
  note?: string;
}

/**
 * One row per connector for the projects whose coverage is identical and complete; a row of its
 * own for each project that differs (partial, refused calls), so problems stand out.
 */
export function collapseCoverage(entries: CoverageEntry[]): CoverageRow[] {
  const total = entries.filter(e => e.project).length;
  const rows = new Map<string, CoverageRow>();
  for (const e of entries) {
    const same = e.project && !e.partial && !e.note;
    const key = same ? `${e.connector}|${e.services.join(',')}` : `${e.connector}|${e.project?.id ?? ''}|${e.note ?? ''}`;
    const row = rows.get(key) ?? { key, connector: e.connector, projects: [], label: '', services: e.services, partial: e.partial, note: e.note };
    if (e.project) row.projects.push(e.project);
    rows.set(key, row);
  }
  for (const row of rows.values()) {
    const n = row.projects.length;
    row.label = n === 0 ? 'tenant / connector-wide' : n === 1 ? row.projects[0].name ?? row.projects[0].id : n === total ? `all ${n} projects` : `${n} projects`;
  }
  return [...rows.values()].sort((a, b) => Number(b.partial) - Number(a.partial));
}

/** While a connector reports a running sync, the page polls so "sync in progress" clears by itself. */
const RUNNING_POLL_MS = 5000;

/** The outcome of a manual sync, as a note above the cards. A 409 means a sync is already running: not an error. */
export function syncNote(s: Pick<ConnectorStatus, 'id' | 'title'>, outcome: { ok: SyncResponse } | { error: unknown }): { tone: 'info' | 'danger'; text: string } {
  if ('ok' in outcome) return { tone: 'info', text: outcome.ok.note ?? `Sync of ${s.title} finished.` };
  const e = outcome.error;
  if (e instanceof ApiError && e.status === 409) return { tone: 'info', text: `Sync in progress: ${e.message || `${s.title} is already syncing.`} This page refreshes when it finishes.` };
  return { tone: 'danger', text: `Sync of ${s.title} failed: ${(e as Error).message}` };
}

/** Projects the tenant lists that are not in NEBIUS_PROJECT_IDS: a hint only, never added to the scope. */
export function DiscoveryHint({ projects }: { projects: NonNullable<IntegrationsResponse['unconfiguredProjects']> }) {
  const n = projects.length;
  return (
    <div style={{ marginBottom: 12 }}>
      <Callout tone="info" title={`${n} project${n === 1 ? '' : 's'} in the tenant ${n === 1 ? 'is' : 'are'} not in NEBIUS_PROJECT_IDS`}>
        <p>
          The tenant project list (tenant <code>viewer</code>) shows {n === 1 ? 'a project' : 'projects'} the portal does not read. The scope stays
          what <code>NEBIUS_PROJECT_IDS</code> lists; add an id there and restart to include it.
        </p>
        <ul className="ne-discovery-list" aria-label="Projects not configured">
          {projects.map(p => (
            <li key={p.id}>
              {p.name ? <strong>{p.name}</strong> : null} <code>{p.id}</code>
              {p.region ? <> · {p.region}</> : null}
            </li>
          ))}
        </ul>
      </Callout>
    </div>
  );
}

export function IntegrationsPage() {
  const load = useGet<IntegrationsResponse>('/integrations');
  // The docs catalog, so coverage is stated against what Nebius documents (W1-P26).
  const docs = useGet<NebiusDocsResponse>('/nebius-docs');
  const narrow = useMediaQuery(NARROW_QUERY);
  // A link to a folded section (#capabilities, #coverage, #matrix, #connectors-healthy) opens it and scrolls there.
  useScrollToHash(Boolean(load.data));
  const now = usePortalNow();
  const call = useBackend();
  const [params] = useSearchParams();
  const [filter] = useGlobalFilter();
  // The state a count chip filters the table by (W1-P29): the same states and counts as the chips.
  const only = params.get('connectors') ?? undefined;
  const [syncing, setSyncing] = useState<string>();
  const [note, setNote] = useState<{ tone: 'info' | 'danger'; text: string }>();

  const reload = useRef(load.reload);
  reload.current = load.reload;
  const running = !!load.data?.statuses.some(s => s.running);
  useEffect(() => {
    if (!running) return undefined;
    const t = setTimeout(() => reload.current(), RUNNING_POLL_MS);
    return () => clearTimeout(t);
  }, [running, load.data]);

  const sync = async (s: ConnectorStatus) => {
    setSyncing(s.id);
    try {
      const r = await call<SyncResponse>(`/integrations/${encodeURIComponent(s.id)}/sync`, { method: 'POST' });
      setNote(syncNote(s, { ok: r }));
    } catch (error) {
      setNote(syncNote(s, { error }));
    } finally {
      setSyncing(undefined);
      load.reload();
    }
  };

  return (
    <PageShell
      title="Integrations & Coverage"
      subtitle="Every connector and every API call it makes, with scope, permissions, freshness, health and failure state, from the last sync."
      filters={false}
      contents={[
        { id: 'setup', label: 'Day-one setup' },
        { id: 'connector-summary', label: 'Summary' },
        { id: 'connectors', label: 'Connectors' },
        { id: 'connectors-healthy', label: 'Healthy connectors' },
        ...(load.data?.statuses.some(s => NOT_APPLICABLE_STATES.includes(s.state)) ? [{ id: 'connectors-not-applicable', label: 'Not applicable' }] : []),
        { id: 'capabilities', label: 'API capabilities' },
        ...(load.data?.coverage.length ? [{ id: 'coverage', label: 'Inventory coverage' }] : []),
        ...(docs.data ? [{ id: 'docs-coverage', label: 'Against the docs' }] : []),
        { id: 'matrix', label: 'Capability matrix' },
      ]}
    >
      <Async load={load} rows={8}>
        {loaded => {
          // A call the quick sync skipped reads as answered on the full sync, not "not configured".
          const d = { ...loaded, capabilities: loaded.capabilities?.map(observedState) };
          // A sync most calls failed at: one incident, said once here, not as each call's flakiness (G1.6, W1-P27).
          const incidents = syncIncidents(d.statuses, d.capabilities ?? []);
          const outages = new Set(incidents.map(i => i.at));
          const titleOf = (id: string) => d.statuses.find(s => s.id === id)?.title ?? id;
          return (
            <>
              <div aria-live="polite">
                {note ? (
                  <div style={{ marginBottom: 12 }}>
                    <Callout tone={note.tone}>{note.text}</Callout>
                  </div>
                ) : null}
              </div>
              {incidents.length ? (
                <div style={{ marginBottom: 12 }}>
                  <Callout tone="info" title={incidents.length === 1 ? 'A failed sync, counted once' : `${incidents.length} failed syncs, each counted once`}>
                    <ul className="ne-discovery-list" aria-label="Failed syncs">
                      {incidents.map(i => (
                        <li key={i.at}>
                          {fmtTime(i.at)} · {incidentTitle(i, titleOf)}
                          {i.connectors.length > 1 ? ` (${i.connectors.map(titleOf).join(', ')})` : ''}; {i.recoveredAt ? `recovered ${fmtTime(i.recoveredAt)}` : 'no answer since'}.
                        </li>
                      ))}
                    </ul>
                    Each is one incident, not counted against each call or connector it touched: a call is flaky only when it fails on its own.
                  </Callout>
                </div>
              ) : null}
              {d.unconfiguredProjects?.length ? <DiscoveryHint projects={d.unconfiguredProjects} /> : null}
              <SetupChecklist statuses={d.statuses} />
              {/* The one-line-per-connector summary first; the cards below hold the detail (healthy ones folded). */}
              <section id="connector-summary" aria-label="Connector summary">
                <Card title="Connector health" icon="integrations" flush>
                  <div className="ne-ov-connectors ne-int-chips">
                    <ConnectorStateChips statuses={d.statuses} active={only} />
                    {only ? <Link to={connectorFilterHref(filter)}>Show every connector</Link> : null}
                  </div>
                  <ConnectorTable statuses={only ? d.statuses.filter(s => connectorFilterState(s) === only) : d.statuses} now={now} onIntegrations narrow={narrow} outages={outages} />
                </Card>
              </section>
              <h2 className="ne-section-title ne-section" id="connectors">
                Connectors
              </h2>
              {/* Cards that need a look stay open; the healthy ones fold under one line (W1F.N5), listed in the table above. */}
              {(() => {
                const card = (s: ConnectorStatus) => (
                  <ConnectorCard
                    key={s.id}
                    s={s}
                    capabilities={capabilitiesOf(s, d.capabilities ?? [])}
                    now={now}
                    canSync={d.canAdminister}
                    syncing={syncing === s.id}
                    onSync={() => sync(s)}
                    outages={outages}
                  />
                );
                // Optional and not-needed connectors apply to nothing here: a grey group of their own, folded (W1-P28, #54).
                const notApplicable = d.statuses.filter(s => NOT_APPLICABLE_STATES.includes(s.state));
                const healthy = d.statuses.filter(s => !notApplicable.includes(s) && isHealthy(s, capabilitiesOf(s, d.capabilities ?? []), outages));
                const look = d.statuses.filter(s => !healthy.includes(s) && !notApplicable.includes(s));
                // Counted "ok" in the chips but open here: each named with why, so the counts read together (W1-P29).
                const okCount = d.statuses.filter(s => connectorFilterState(s) === 'ok').length;
                const okOpen = look.filter(s => connectorFilterState(s) === 'ok');
                return (
                  <>
                    {okOpen.length ? (
                      <div className="ne-muted" style={{ marginBottom: 8 }}>
                        Counted ok, open here for a look:
                        <ul className="ne-discovery-list" aria-label="Ok connectors open for a look">
                          {okOpen.map(s => (
                            <li key={s.id}>
                              {s.title}: {lookReason(s, capabilitiesOf(s, d.capabilities ?? []), outages)}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                    {look.length ? <div className="ne-grid ne-grid-2">{look.map(card)}</div> : null}
                    {healthy.length ? (
                      <Reference id="connectors-healthy" title={`Healthy connectors (${healthy.length} of ${okCount} ok)`} hint={healthy.map(s => s.title).join(' · ')} open={!look.length}>
                        <div className="ne-grid ne-grid-2">{healthy.map(card)}</div>
                      </Reference>
                    ) : null}
                    {notApplicable.length ? (
                      <Reference id="connectors-not-applicable" title={`Not applicable (${notApplicable.length})`} hint={`${notApplicable.map(s => `${s.title}: ${s.state.replace(/-/g, ' ')}`).join(' · ')}. Not counted as gaps.`}>
                        <div className="ne-grid ne-grid-2">{notApplicable.map(card)}</div>
                      </Reference>
                    ) : null}
                  </>
                );
              })()}

              {/* Reference sections fold under their title and count, like Capacity (F1.13): 19,818 px on a phone (W1F.N5). */}
              <Reference
                id="capabilities"
                title={`API capabilities (${d.capabilities?.length ?? 0} calls)`}
                hint={capabilityHint(d.capabilities ?? [])}
              >
                {d.capabilities?.length ? (
                  <CapabilityGroups capabilities={d.capabilities} now={now} outages={outages} />
                ) : (
                  <Callout tone="info" title="No API capabilities reported yet">
                    The per-call status appears after the first sync of a configured Nebius connector.
                  </Callout>
                )}
              </Reference>

              {d.coverage.length ? (
                <Reference id="coverage" title={`Inventory coverage in your scope (${d.coverage.length})`} hint={coverageHint(d.coverage)}>
                  <Card flush>
                    <DataTable<CoverageRow>
                      caption="Coverage"
                      rows={collapseCoverage(d.coverage)}
                      rowKey={c => c.key}
                      columns={[
                        {
                          key: 'pr',
                          header: 'Project',
                          render: c =>
                            c.projects.length > 1 ? (
                              <ProjectNames summary={c.label} projects={c.projects} />
                            ) : (
                              <span title={c.projects[0]?.id}>{c.label}</span>
                            ),
                        },
                        { key: 'c', header: 'Connector', render: c => c.connector },
                        { key: 's', header: 'Services listed', render: c => c.services.join(', ') },
                        { key: 'p', header: 'Complete?', render: c => (c.partial ? <Badge tone="warn">partial</Badge> : <Quiet>complete for listed services</Quiet>) },
                        { key: 'n', header: 'Note', render: c => <span className="ne-muted">{c.note ?? 'no gaps'}</span> },
                      ]}
                    />
                  </Card>
                </Reference>
              ) : null}

              {docs.data ? (
                (() => {
                  const c = docsCoverage(docs.data.sections, d.capabilities ?? [], { soperatorClusterIds: d.soperatorClusterIds });
                  return (
                    <Reference id="docs-coverage" title="Coverage against the Nebius docs" hint={c.summary}>
                      <Card flush footer={<>Sections from the docs catalog of {docs.data.generated} (docs/reference/nebius-docs.md); each links to its pages on <Link to="/nebius-docs">Nebius docs</Link>.</>}>
                        <DocsCoverageTable rows={c.rows} />
                      </Card>
                    </Reference>
                  );
                })()
              ) : null}

              <Reference id="matrix" title="Capability matrix" hint="Every capability against every connector: which source answers what.">
                <MatrixCard rows={d.matrix} capabilities={d.capabilities ?? []} statuses={d.statuses} />
              </Reference>
            </>
          );
        }}
      </Async>
    </PageShell>
  );
}

/** A folded capability section's one line: how many calls answered, and how many need a look. */
export function capabilityHint(capabilities: { state: string }[]): string {
  const ok = capabilities.filter(c => c.state === 'ok').length;
  const look = capabilities.filter(c => !['ok', 'not-configured', 'not-found'].includes(c.state)).length;
  return `${ok} of ${capabilities.length} answered at the last sync${look ? ` · ${look} need a look` : ''}.`;
}

/** A folded coverage section's one line: how many projects were read only in part. */
export function coverageHint(coverage: { partial: boolean }[]): string {
  const partial = coverage.filter(c => c.partial).length;
  return partial ? `${partial} of ${coverage.length} read in part.` : `All ${coverage.length} read in full.`;
}
