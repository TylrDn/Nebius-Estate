import { CSSProperties, useEffect, useMemo, useRef, useState } from 'react';
import type { LogLine, LogsResponse } from '@internal/nebius-domain';
import { validateLogQL } from '@internal/nebius-domain';
import { Callout, Card, EmptyState, ErrorState, fmtTime, KeyValue, LoadingBlock, NARROW_QUERY, useGet, useMediaQuery } from '../ui';
import { displayLine, lineTime, listHeight, spansDays, visibleWindow } from './model';

/** A log row is 1.5rem tall (styles.css): 24 px at the default root size (WCAG 2.5.8 target size), more when the browser enlarges text. */
const rowHeight = () => Math.round(24 * ((typeof window !== 'undefined' && parseFloat(window.getComputedStyle(document.documentElement).fontSize)) || 16) / 16);
const VIEWPORT = 460;

/**
 * The result of the query in the URL. While a new query, bucket, preset, range or project reads, the previous
 * result stays (useGet keeps data) but is dimmed, marked aria-busy and titled "Reading logs…" (G3.6: live reads
 * take 1.1–1.4 s, and the old lines read as the new bucket's). `project` and `minutes`: what the page asks for now.
 */
export function Results({ logs, valid, query, widen, project, minutes }: { logs: ReturnType<typeof useGet<LogsResponse>>; valid: boolean; query: string; widen?: () => void; project?: string; minutes?: number }) {
  if (!valid) {
    return (
      <EmptyState title="Fix the query to see log lines" icon="info">
        {validateLogQL(query).errors.join(' ')}
      </EmptyState>
    );
  }
  if (!logs.data && logs.error) return <ErrorState error={logs.error} retry={logs.reload} />;
  if (!logs.data) return <LoadingBlock rows={6} label="Reading logs" />;
  const r = logs.data;
  const otherRange = minutes !== undefined && Math.round((Date.parse(r.end) - Date.parse(r.start)) / 60_000) !== minutes;
  // A failed new query keeps the previous result under "Showing the last result": not busy.
  const busy = logs.loading || (!logs.error && (r.query !== query || (project !== undefined && r.project !== project) || otherRange));
  const title = busy ? 'Reading logs…' : `${r.lines.length}${r.truncated ? '+' : ''} line${r.lines.length === 1 ? '' : 's'} · ${fmtTime(r.start)} → ${fmtTime(r.end)}`;
  return (
    <div aria-busy={busy} className={busy ? 'ne-logs-stale' : undefined}>
      <Card title={title} icon="logs" footer={`${r.source}, newest first; at most ${r.limit} lines per query.`}>
        {logs.error ? <Callout tone="warn" title="Showing the last result">{logs.error.message}</Callout> : null}
        {r.bucketState === 'no-logs-yet' ? (
          <EmptyState title="No logs yet" icon="info">
            {r.note}
          </EmptyState>
        ) : !r.lines.length ? (
          <EmptyState title="No matching lines" icon="search">
            {r.note}
            {widen ? (
              <>
                {' '}
                <button type="button" className="ne-btn ne-btn-sm" onClick={widen}>
                  Widen to 7 d
                </button>
              </>
            ) : null}
          </EmptyState>
        ) : (
          <>
            {r.truncated ? (
              <Callout tone="info" title={`Showing the newest ${r.limit} lines`}>
                Older lines in this range are not shown. Narrow the time range or add a filter (|= "text").
              </Callout>
            ) : null}
            <LogList lines={r.lines} withDate={spansDays(r.start, r.end)} />
          </>
        )}
      </Card>
    </div>
  );
}

/**
 * A windowed list: only the rows in view are in the DOM, so 1000 lines scroll smoothly. On a phone the rows wrap
 * instead (each its own height, all in the DOM, in a box of at most 70 % of the screen): a 145 px cut showed no line
 * in full until it was selected (W1F.S5).
 */
function LogList({ lines, withDate }: { lines: LogLine[]; withDate: boolean }) {
  const narrow = useMediaQuery(NARROW_QUERY);
  const ref = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(0);
  const [open, setOpen] = useState<number>();
  useEffect(() => {
    setOpen(undefined);
    setTop(0);
    if (ref.current) ref.current.scrollTop = 0;
  }, [lines]);
  const ROW = useMemo(rowHeight, []);
  const { start, end } = visibleWindow(top, VIEWPORT, ROW, lines.length);
  const sel = open !== undefined ? lines[open] : undefined;
  const row = (l: LogLine, i: number, style?: CSSProperties) => (
    <button key={`${l.ts}-${i}`} type="button" className="ne-logrow" style={style} aria-pressed={open === i} onClick={() => setOpen(open === i ? undefined : i)}>
      <span className="ne-logrow-time">{lineTime(l.time, withDate)}</span>
      <span className="ne-logrow-text">{displayLine(l.line) || ' '}</span>
    </button>
  );
  return (
    <>
      {narrow ? (
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- WCAG scrollable-region-focusable
        <div className="ne-loglist ne-loglist-wrap" ref={ref} tabIndex={0} role="region" aria-label={`Log lines, ${lines.length} in total; select a line for its labels`}>
          {lines.map((l, i) => row(l, i))}
        </div>
      ) : (
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- WCAG scrollable-region-focusable
        <div className="ne-loglist" ref={ref} tabIndex={0} role="region" aria-label={`Log lines, ${lines.length} in total; select a line for its labels`} style={{ height: listHeight(lines.length, ROW, VIEWPORT) + 2 }} onScroll={e => setTop(e.currentTarget.scrollTop)}>
          <div className="ne-loglist-inner" style={{ height: lines.length * ROW }}>
            {lines.slice(start, end).map((l, k) => row(l, start + k, { top: (start + k) * ROW, height: ROW }))}
          </div>
        </div>
      )}
      {sel ? (
        <div className="ne-section" aria-live="polite">
          <KeyValue
            items={[
              ['Time', `${fmtTime(sel.time)} (${sel.time})`],
              ['Line', <span className="ne-logdetail">{displayLine(sel.line)}</span>],
              ...Object.entries(sel.labels).map(([k, v]) => [k, <span className="ne-mono" style={{ overflowWrap: 'anywhere' }}>{v}</span>] as [string, JSX.Element]),
            ]}
          />
        </div>
      ) : null}
    </>
  );
}
