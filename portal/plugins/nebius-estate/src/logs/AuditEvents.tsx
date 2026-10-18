import { useState } from 'react';
import type { AuditEvent, AuditEventsResponse } from '@internal/nebius-domain';
import { MAX_AUDIT_EVENTS } from '@internal/nebius-domain';
import { Async, Badge, Callout, Card, Column, DataTable, fmtTime, Segmented, useGet } from '../ui';
import { AUDIT_RANGES, AuditRange, auditResource, auditResult, auditTruncation, auditWho } from './auditModel';

/** Events listed at first and added by each "Show more". */
const AUDIT_PAGE = 50;

const COLUMNS: Column<AuditEvent>[] = [
  { key: 'time', header: 'Time', render: e => <span className="ne-nowrap">{fmtTime(e.time)}</span>, sortValue: e => e.time, sortKind: 'time' },
  { key: 'who', header: 'Who', render: e => auditWho(e), sortValue: e => auditWho(e) },
  { key: 'action', header: 'Action', render: e => <span title={e.type}>{e.service.toLowerCase().replace(/_/g, ' ')} · {e.action.toLowerCase()}</span>, sortValue: e => `${e.service} ${e.action}` },
  { key: 'resource', header: 'Resource', render: e => <span className="ne-ov-break">{auditResource(e)}</span>, sortValue: e => auditResource(e) },
  {
    key: 'result',
    header: 'Result',
    render: e => {
      const r = auditResult(e);
      return (
        <span title={r.detail}>
          <Badge tone={r.tone}>{r.label}</Badge>
          {r.detail ? <span className="ne-muted"> {r.detail}</span> : null}
        </span>
      );
    },
    sortValue: e => auditResult(e).label,
  },
];

/** Recent tenant audit events (Nebius Audit Logs), read on demand per region; nothing is stored. */
export function AuditEvents() {
  const [range, setRange] = useState<AuditRange>('24h');
  const [region, setRegion] = useState<string>();
  const [reads, setReads] = useState(false);
  // #30: how many events to list; "Show more" raises it up to the API's maximum, a new range, region or reads resets it.
  // The reset happens in the same update as the change (not in an effect after it), so only one request is made.
  const [limit, setLimit] = useState(AUDIT_PAGE);
  const reset = <T,>(set: (v: T) => void) => (v: T) => {
    setLimit(AUDIT_PAGE);
    set(v);
  };
  const minutes = AUDIT_RANGES.find(r => r.id === range)!.minutes;
  const params = new URLSearchParams({ sinceMinutes: String(minutes), reads: String(reads), limit: String(limit), ...(region ? { region } : {}) });
  const load = useGet<AuditEventsResponse>(`/audit/events?${params.toString()}`);
  return (
    <Card title="Audit events (tenant)" icon="logs">
      <Async load={load} rows={4}>
        {a => {
          const cut = auditTruncation(a);
          return (
            <div className="ne-stack" style={{ gap: 10 }}>
              <div className="ne-row" style={{ gap: 10, flexWrap: 'wrap' }}>
                <select className="ne-select" aria-label="Audit region" value={a.region} onChange={e => reset(setRegion)(e.target.value)}>
                  {a.regions.map(r => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
                <Segmented label="Audit time range" options={AUDIT_RANGES.map(r => ({ id: r.id, label: r.label }))} value={range} onChange={reset(setRange)} />
                <label className="ne-row" style={{ gap: 6 }}>
                  <input type="checkbox" checked={reads} onChange={e => reset(setReads)(e.target.checked)} /> Include reads (GET, LIST)
                </label>
              </div>
              {a.unavailableReason ? (
                <Callout tone="warn" title="Audit events could not be read">
                  {a.unavailableReason}
                </Callout>
              ) : (
                <>
                  {cut ? (
                    <Callout tone="info" title={cut.title}>
                      {cut.body}
                      {cut.more ? (
                        <>
                          {' '}
                          <button type="button" className="ne-btn ne-btn-sm" onClick={() => setLimit(l => Math.min(l + AUDIT_PAGE, MAX_AUDIT_EVENTS))}>
                            Show {Math.min(AUDIT_PAGE, MAX_AUDIT_EVENTS - limit)} more
                          </button>
                        </>
                      ) : null}
                    </Callout>
                  ) : null}
                  <DataTable
                    caption={`Audit events in ${a.region}, ${fmtTime(a.start)} to ${fmtTime(a.end)}`}
                    columns={COLUMNS}
                    rows={a.events}
                    rowKey={e => e.id}
                    compact
                    initialSort={{ key: 'time', dir: 'desc' }}
                    empty={cut && a.scannedFrom ? `No ${a.writesOnly ? 'changes' : 'events'} since ${fmtTime(a.scannedFrom)} (see above).` : a.writesOnly ? 'No changes in this range (reads are hidden).' : 'No events in this range.'}
                  />
                </>
              )}
              <p className="ne-muted" style={{ margin: 0 }}>
                {a.source}: who did what to which resource, tenant-wide, one region at a time. Kept: time, caller, action, resource, result; never the token, client IP or request contents.
              </p>
            </div>
          );
        }}
      </Async>
    </Card>
  );
}
