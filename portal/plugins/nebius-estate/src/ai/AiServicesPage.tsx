import { Link } from 'react-router-dom';
import type { AiServicesResponse } from '@internal/nebius-domain';
import { Async, Badge, Callout, Card, DataTable, EmptyState, fmtAgo, fmtNumber, fmtTime, KeyValue, PageShell, ProjectName, StatusPill, useGet, usePortalNow, useProjectNames } from '../ui';
import { accessBadge, checkBadge, createdSortValue, createdText, mlServicesEmpty, serverlessEmpty } from './model';

/**
 * AI services: Token Factory (key health, models), Hugging Face (token health, gated access per
 * model the workloads pull) and Serverless AI endpoints and jobs. Every read goes through the backend,
 * which checks once per sync and keeps the key and token to itself.
 */
export function AiServicesPage() {
  const load = useGet<AiServicesResponse>('/ai-services');
  const now = usePortalNow();
  const names = useProjectNames();
  return (
    <PageShell
      title="AI services"
      subtitle="Token Factory and Hugging Face health, the Serverless AI endpoints and jobs, and the container registries and MLflow clusters. Checked by the backend once per sync; no key or token reaches the browser."
      filters={false}
    >
      <Async load={load} rows={6}>
        {d => {
          const tf = d.tokenFactory;
          const hf = d.huggingface;
          const tfBadge = checkBadge(tf.state, tf.stale);
          const hfBadge = checkBadge(hf.state, hf.stale);
          // A column with one value on every row says nothing per row: it moves to the footer.
          const sameOwner = tf.models.length > 1 && tf.models.every(m => m.ownedBy === tf.models[0].ownedBy);
          const sameType = tf.models.length > 1 && tf.models.every(m => m.object === tf.models[0].object);
          return (
            <>
              <div className="ne-grid ne-grid-main ne-section">
                <Card
                  title="Token Factory"
                  icon="ai"
                  actions={<Badge tone={tfBadge.tone} dot>{tfBadge.label}</Badge>}
                  footer={`Checked every ${d.syncIntervalMinutes} min; "Sync now" on Integrations (connector token-factory) checks again.`}
                >
                  <div className="ne-stack" style={{ gap: 10 }}>
                    <KeyValue
                      items={[
                        ['API key', tf.keyConfigured ? (tf.keyValid === true ? 'configured · valid' : tf.keyValid === false ? 'configured · refused' : 'configured · not checked yet') : 'not configured'],
                        ['Models', tf.models.length ? `${fmtNumber(tf.models.length)}${tf.stale ? ' (last good list)' : ''}` : '—'],
                        ['Last check', tf.lastCheck ? `${fmtTime(tf.lastCheck)} · ${fmtAgo(tf.lastCheck, now)}` : 'not yet'],
                        ['Last success', tf.lastSuccess ? fmtTime(tf.lastSuccess) : '—'],
                      ]}
                    />
                    {tf.hint ? <Callout tone={tf.state === 'not-configured' ? 'info' : 'warn'}>{tf.hint}</Callout> : null}
                    <Callout tone="info" title="Usage and balance: console only">
                      {/* The note opens with the callout's own title: said once. */}
                      {tf.usageNote.replace(/^Usage and balance: console only\.\s*/, '')} <a href={tf.consoleUrl} target="_blank" rel="noreferrer">Open the Token Factory console</a>.
                    </Callout>
                  </div>
                </Card>
                <Card
                  title="Hugging Face"
                  icon="ai"
                  actions={<Badge tone={hfBadge.tone} dot>{hfBadge.label}</Badge>}
                  footer="Gated access is checked with a HEAD of each model's config.json; weights are never downloaded."
                >
                  <div className="ne-stack" style={{ gap: 10 }}>
                    <KeyValue
                      items={[
                        ['Token', hf.tokenConfigured ? (hf.tokenValid === true ? 'configured · valid' : hf.tokenValid === false ? 'configured · refused' : 'configured · not checked yet') : 'not configured'],
                        ['Account', hf.account ? `${hf.account.name ?? '—'} (${hf.account.type ?? 'unknown type'}${hf.account.isPro ? ', PRO' : ''})` : '—'],
                        ['Token type', hf.account?.tokenRole ? `${hf.account.tokenRole}${hf.account.canReadGatedRepos === false ? ' · cannot read gated repos' : hf.account.canReadGatedRepos ? ' · can read gated repos' : ''}` : '—'],
                        ['Last check', hf.lastCheck ? `${fmtTime(hf.lastCheck)} · ${fmtAgo(hf.lastCheck, now)}` : 'not yet'],
                      ]}
                    />
                    {hf.hint ? <Callout tone={hf.state === 'not-configured' ? 'info' : 'warn'}>{hf.hint}</Callout> : null}
                  </div>
                </Card>
              </div>

              <div className="ne-section">
                <Card title="Models the workloads pull (Hugging Face)" icon="workloads" flush footer="From workloads/inference/overlays, recipes/serverless and platform/versions.yaml.">
                  <DataTable
                    caption="Workload models"
                    rows={hf.models}
                    rowKey={m => m.repo}
                    empty={<EmptyState title="No model ids found">No Hugging Face model id in the workloads or recipes of this checkout.</EmptyState>}
                    columns={[
                      { key: 'r', header: 'Model', sortValue: m => m.repo, render: m => <a href={`https://huggingface.co/${m.repo}`} target="_blank" rel="noreferrer" className="ne-mono">{m.repo}</a> },
                      { key: 'a', header: 'Gated · access', render: m => { const b = accessBadge(m); return <Badge tone={b.tone} wrap>{b.label}</Badge>; } },
                      { key: 'n', header: 'What it means', render: m => <span className="ne-muted" style={{ fontSize: '0.78125rem' }}>{m.note}</span> },
                      { key: 'u', header: 'Used by', render: m => <div className="ne-faint" style={{ fontSize: 'var(--ne-fs-caption)' }}>{m.usedBy.map(u => <div key={u} className="ne-mono" style={{ overflowWrap: 'anywhere' }}>{u}</div>)}</div> },
                    ]}
                  />
                </Card>
              </div>

              <div className="ne-section">
                <Card
                  title="Token Factory models"
                  icon="ai"
                  flush
                  footer={
                    sameOwner || sameType
                      ? `Every model: ${[sameOwner ? `owner ${tf.models[0].ownedBy ?? '—'}` : '', sameType ? `type ${tf.models[0].object ?? '—'}` : ''].filter(Boolean).join(' · ')} (a column that would repeat it on every row is left out).`
                      : undefined
                  }
                >
                  <DataTable
                    caption="Token Factory models"
                    rows={tf.models}
                    rowKey={m => m.id}
                    maxHeight={420}
                    empty={<EmptyState title="No model list">{tf.state === 'not-configured' ? 'Configure the Token Factory API key to list the models.' : 'The list has not been read yet; it is read on the next sync.'}</EmptyState>}
                    columns={[
                      { key: 'i', header: 'Model id', sortValue: m => m.id, render: m => <span className="ne-mono" style={{ overflowWrap: 'anywhere' }}>{m.id}</span> },
                      ...(sameOwner ? [] : [{ key: 'o', header: 'Owner', render: (m: (typeof tf.models)[number]) => m.ownedBy ?? '—' }]),
                      ...(sameType ? [] : [{ key: 't', header: 'Type', render: (m: (typeof tf.models)[number]) => m.object ?? '—' }]),
                      { key: 'c', header: 'Created', sortValue: m => createdSortValue(m.created, tf.lastSuccess ?? tf.lastCheck), sortKind: 'time', render: m => { const t = createdText(m.created, tf.lastSuccess ?? tf.lastCheck); return t === 'not reported' ? <span className="ne-faint" title="The API returned the time of the request, not a creation date">{t}</span> : t; } },
                    ]}
                  />
                </Card>
              </div>

              <div className="ne-section">
                <Card title="Serverless AI endpoints and jobs" icon="workloads" flush footer={d.serverless.observedAt ? `Inventory as of ${fmtTime(d.serverless.observedAt)}` : undefined}>
                  {d.serverless.note ? <div style={{ padding: 12 }}><Callout tone="info">{d.serverless.note}</Callout></div> : null}
                  <DataTable
                    caption="Serverless endpoints and jobs"
                    rows={[...d.serverless.endpoints.map(e => ({ ...e, kind: 'endpoint' })), ...d.serverless.jobs.map(j => ({ ...j, kind: 'job' }))]}
                    rowKey={r => r.uid}
                    empty={<EmptyState title={serverlessEmpty(d.serverless).title}>{serverlessEmpty(d.serverless).text}</EmptyState>}
                    columns={[
                      { key: 'n', header: 'Name', sortValue: r => r.name, render: r => <strong>{r.name}</strong> },
                      { key: 'k', header: 'Kind', render: r => r.kind },
                      { key: 's', header: 'Status', render: r => <StatusPill state={r.status} /> },
                      { key: 'p', header: 'Platform · preset', render: r => <span className="ne-mono">{[r.platform, r.preset].filter(Boolean).join(' · ') || '—'}</span> },
                      { key: 'r', header: 'Project · region', sortValue: r => `${(r.projectId && names(r.projectId)) ?? r.projectId ?? ''}${r.region ?? ''}`, render: r => <span className="ne-faint">{r.projectId ? <ProjectName id={r.projectId} names={names} /> : null}{r.projectId && r.region ? ' · ' : ''}{r.region}</span> },
                    ]}
                  />
                </Card>
              </div>

              <div className="ne-section">
                <Card
                  title="Container registries and MLflow"
                  icon="workloads"
                  flush
                  footer={`${d.mlServices.observedAt ? `Inventory as of ${fmtTime(d.mlServices.observedAt)} · ${fmtAgo(d.mlServices.observedAt, now)}. ` : ''}Recipe R12 (ml-services) creates both; open one in the Estate Explorer for its relations and labels.`}
                >
                  {d.mlServices.note ? <div style={{ padding: 12 }}><Callout tone="info">{d.mlServices.note}</Callout></div> : null}
                  <DataTable
                    caption="Container registries and MLflow clusters"
                    rows={[...d.mlServices.registries.map(r => ({ ...r, kind: 'Container registry' })), ...d.mlServices.mlflow.map(m => ({ ...m, kind: 'Managed MLflow' }))]}
                    rowKey={r => r.uid}
                    empty={<EmptyState title={mlServicesEmpty(d.mlServices).title}>{mlServicesEmpty(d.mlServices).text}</EmptyState>}
                    columns={[
                      { key: 'n', header: 'Name', sortValue: r => r.name, render: r => <Link to={`/estate?uid=${encodeURIComponent(r.uid)}`} style={{ overflowWrap: 'anywhere', fontWeight: 600 }}>{r.name}</Link> },
                      { key: 'k', header: 'Kind', render: r => r.kind },
                      { key: 's', header: 'Status', render: r => <StatusPill state={r.status} /> },
                      { key: 'd', header: 'Details', render: r => (r.detail ? r.detail : <span className="ne-faint">—</span>) },
                      { key: 'r', header: 'Project · region', sortValue: r => `${(r.projectId && names(r.projectId)) ?? r.projectId ?? ''}${r.region ?? ''}`, render: r => <span className="ne-faint">{r.projectId ? <ProjectName id={r.projectId} names={names} /> : null}{r.projectId && r.region ? ' · ' : ''}{r.region}</span> },
                    ]}
                  />
                </Card>
              </div>
            </>
          );
        }}
      </Async>
    </PageShell>
  );
}
