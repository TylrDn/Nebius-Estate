import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { LogBucketsResponse, LogsResponse } from '@internal/nebius-domain';
import { LOG_PRESETS, validateLogQL } from '@internal/nebius-domain';
import { Async, Badge, Callout, Card, Field, filterQuery, Icon, PageShell, Segmented, useGet, useGlobalFilter } from '../ui';
import { defaultQuery, initialQuery, LOG_RANGES, LogRange, projectNote } from './model';
import { Results } from './LogResults';
import { AuditEvents } from './AuditEvents';

/** Logs: Nebius Observability Logs per project and bucket, read on demand through the portal backend. */
export function LogsPage() {
  const [filter] = useGlobalFilter();
  const [params, setParams] = useSearchParams();
  const range = (LOG_RANGES.find(r => r.id === params.get('range'))?.id ?? '1h') as LogRange;
  // The whole global filter: the region and stage narrow the projects the page may open on (G3.3).
  const buckets = useGet<LogBucketsResponse>(`/logs/buckets${filterQuery(filter)}`);
  // A link that names no query opens on a bucket with lines (defaultQuery), once the project's buckets are known.
  const named = Boolean(params.get('q') || params.get('preset') || params.get('bucket'));
  const opened = useMemo(() => (!named && buckets.data && !buckets.data.unavailableReason ? defaultQuery(buckets.data.buckets) : undefined), [named, buckets.data]);
  const query = opened?.query ?? initialQuery({ q: params.get('q'), preset: params.get('preset'), bucket: params.get('bucket'), resource: params.get('resource') });
  const [draft, setDraft] = useState(query);
  useEffect(() => setDraft(query), [query]);
  const check = useMemo(() => validateLogQL(draft), [draft]);
  const update = (patch: Record<string, string | undefined>) =>
    setParams(
      p => {
        const n = new URLSearchParams(p);
        for (const [k, v] of Object.entries(patch)) {
          if (v) n.set(k, v);
          else n.delete(k);
        }
        return n;
      },
      { replace: true },
    );
  const run = (q: string) => update({ q, preset: undefined, bucket: undefined, resource: undefined });

  const project = buckets.data?.project.id;
  // The query that ran (the URL's), not the draft being typed: its bucket is the selected one.
  const ran = useMemo(() => validateLogQL(query), [query]);
  const valid = ran.ok;
  const minutes = LOG_RANGES.find(r => r.id === range)!.ms / 60_000;
  const logs = useGet<LogsResponse>(project && valid ? `/logs/query?${new URLSearchParams({ project, query, sinceMinutes: String(minutes) }).toString()}` : null);

  return (
    <PageShell title="Logs" subtitle="Nebius Observability Logs for one project: VM serial consoles, Managed Kubernetes control planes, managed services and your own workloads. Read on demand, never stored by the portal.">
      <Async load={buckets} rows={3}>
        {b => (
          <>
            {b.unavailableReason ? (
              <Callout tone="warn" title="Log buckets could not be listed">
                {b.unavailableReason}
              </Callout>
            ) : (
              <p className="ne-muted" style={{ marginTop: 0 }}>
                Project <strong>{b.project.name ?? b.project.id}</strong>
                {filter.project ? '' : ` (${projectNote(b, false)})`}. {b.source}.
                {opened?.note ? <span data-testid="logs-opened-on"> Opened on a bucket with lines: {opened.note}.</span> : null}
              </p>
            )}
            {!b.project.id ? null : (
              <>
                <Card title="Query" icon="search">
                  <div className="ne-stack" style={{ gap: 10 }}>
                    <div className="ne-row ne-chips-wrap" style={{ gap: 6, flexWrap: 'wrap' }} role="group" aria-label="Presets">
                      <span className="ne-label">Presets</span>
                      {LOG_PRESETS.map(p => (
                        <button key={p.id} type="button" className="ne-btn ne-btn-sm" aria-pressed={query === p.query} title={p.description} onClick={() => update({ preset: p.id, q: undefined, bucket: undefined, resource: undefined })}>
                          {p.label}
                        </button>
                      ))}
                    </div>
                    <div className="ne-row ne-chips-wrap" style={{ gap: 6, flexWrap: 'wrap' }} role="group" aria-label="Buckets">
                      <span className="ne-label">Buckets</span>
                      {b.buckets.map(x => (
                        <button
                          key={x.id}
                          type="button"
                          // A bucket Nebius has not created yet is quieter than one with logs (dashed, muted).
                          className={`ne-btn ne-btn-sm${x.state === 'no-logs-yet' ? ' ne-btn-quiet' : ''}`}
                          // The bucket the query reads is the selected one, also for a preset or a narrowed query (F1.24).
                          aria-pressed={valid && ran.bucket === x.id}
                          title={x.note ?? x.description}
                          onClick={() => run(`{__bucket__="${x.id}"}`)}
                        >
                          {x.service}
                          {x.state === 'no-logs-yet' ? <span className="ne-faint"> · no logs yet</span> : null}
                        </button>
                      ))}
                    </div>
                    <Field label="LogQL" htmlFor="logql" error={draft.trim() && !check.ok ? check.errors[0] : undefined} hint='Every query names one bucket, e.g. {__bucket__="sp_serial"} |= "error". Line filters: |= != |~ !~.'>
                      <textarea
                        id="logql"
                        className="ne-input ne-textarea"
                        value={draft}
                        spellCheck={false}
                        onChange={e => setDraft(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && check.ok) run(draft.trim());
                        }}
                      />
                    </Field>
                    <div className="ne-row" style={{ gap: 10, flexWrap: 'wrap' }}>
                      <Segmented label="Time range" options={LOG_RANGES.map(r => ({ id: r.id, label: r.label }))} value={range} onChange={v => update({ range: v === '1h' ? undefined : v })} />
                      <button type="button" className="ne-btn ne-btn-primary ne-btn-sm" disabled={!check.ok} onClick={() => run(draft.trim())}>
                        <Icon name="search" size={13} /> Run query
                      </button>
                      {params.get('resource') ? <Badge tone="accent">narrowed to {params.get('resource')}</Badge> : null}
                    </div>
                  </div>
                </Card>
                <div className="ne-section">
                  <Results logs={logs} valid={valid} query={query} project={project} minutes={minutes} widen={range === '7d' ? undefined : () => update({ range: '7d' })} />
                </div>
              </>
            )}
          </>
        )}
      </Async>
      <div className="ne-section">
        <AuditEvents />
      </div>
    </PageShell>
  );
}
