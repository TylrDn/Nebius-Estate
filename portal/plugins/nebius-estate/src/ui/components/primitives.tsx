import { cloneElement, CSSProperties, Fragment, isValidElement, ReactNode, RefObject, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { SourcedMetric } from '@internal/nebius-domain';
import { ApiError, Loadable } from '../api';
import { fmtAgo, fmtTime } from '../format';
import { NARROW_QUERY, useMediaQuery } from '../media';
import { Icon, IconName } from '../icons';

export type Tone = 'ok' | 'warn' | 'danger' | 'info' | 'accent' | 'neutral';

export function Badge({ tone = 'neutral', dot, wrap, children, title }: { tone?: Tone; dot?: boolean; wrap?: boolean; children: ReactNode; title?: string }) {
  return (
    <span className={`ne-badge ne-tone-${tone}${dot ? ' ne-badge-dot' : ''}${wrap ? ' ne-badge-wrap' : ''}`} title={title}>
      {children}
    </span>
  );
}

/** A connector's project scope: "9 projects: a, b, c +6 more", names first; every name and id in the title. */
export function ProjectNames({ summary, projects, max = 3 }: { summary: string; projects?: { id: string; name?: string }[]; max?: number }) {
  if (!projects?.length) return <>{summary}</>;
  const names = projects.map(p => p.name ?? p.id);
  const rest = names.length - max;
  return (
    <span title={projects.map(p => (p.name && p.name !== p.id ? `${p.name} (${p.id})` : p.id)).join('\n')}>
      {summary}: {names.slice(0, max).join(', ')}
      {rest > 0 ? ` +${rest} more` : ''}
    </span>
  );
}

/** A project by its name, as every page shows it, with the id on hover; an unknown project shows its id (F1.5). */
export function ProjectName({ id, names }: { id: string; names: (id: string) => string | undefined }) {
  const name = names(id);
  return name && name !== id ? <span title={id}>{name}</span> : <span>{id}</span>;
}

export function Chip({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <span className="ne-chip" title={title}>
      {children}
    </span>
  );
}

const STATE_TONE: Record<string, Tone> = {
  ok: 'ok',
  running: 'ok',
  succeeded: 'ok',
  priced: 'ok',
  under: 'ok',
  stale: 'warn',
  pending: 'warn',
  provisioning: 'info',
  near: 'warn',
  'permission-denied': 'danger',
  error: 'danger',
  over: 'danger',
  deleting: 'warn',
  stopped: 'neutral',
  'not-configured': 'neutral',
  optional: 'neutral',
  waiting: 'info',
  starting: 'info',
  'not-needed': 'ok',
  disabled: 'neutral',
  degraded: 'warn',
  // A connector whose sync ran while some of its calls were refused (connectorState).
  partial: 'warn',
  unknown: 'neutral',
  'no-data': 'neutral',
  // API capability states (CapabilityState)
  'not-found': 'neutral',
  rejected: 'neutral',
  unreachable: 'danger',
  'schema-drift': 'warn',
};

/**
 * A state. A normal state (ok, running, succeeded…) is quiet text with a dot: badges are kept for states that
 * need a look, so a column of "ok" does not drown the one "error" in it.
 */
export function StatusPill({ state, label, wrap }: { state: string; label?: string; wrap?: boolean }) {
  const tone = STATE_TONE[state] ?? 'neutral';
  const text = label ?? state.replace(/-/g, ' ');
  if (tone === 'ok') return <Quiet>{text}</Quiet>;
  return (
    <Badge tone={tone} dot wrap={wrap}>
      {text}
    </Badge>
  );
}

/** The normal state, said quietly: a green dot and plain text, no pill. */
export function Quiet({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <span className="ne-quiet" title={title}>
      {children}
    </span>
  );
}

export function Card({
  title,
  icon,
  actions,
  children,
  footer,
  className,
  bodyClassName,
  flush,
}: {
  title?: ReactNode;
  icon?: IconName;
  actions?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
  bodyClassName?: string;
  flush?: boolean;
}) {
  return (
    <section className={`ne-card ${className ?? ''}`}>
      {title || actions ? (
        <header className="ne-card-head">
          <h2 className="ne-card-title">
            {icon ? <Icon name={icon} size={15} /> : null}
            {title}
          </h2>
          {actions ? <div className="ne-row">{actions}</div> : null}
        </header>
      ) : null}
      <div className={flush ? bodyClassName : `ne-card-body ${bodyClassName ?? ''}`}>{children}</div>
      {footer ? (
        <footer className="ne-card-foot">
          <div className="ne-card-foot-text">{footer}</div>
        </footer>
      ) : null}
    </section>
  );
}

/**
 * A reference section of a long page: folded by default under its title and a one-line hint, so the sections
 * people act on come first (F1.13). A link to its id (the URL's #hash, "On this page") opens it (revealSection).
 */
export function Reference({ id, title, hint, children, open }: { id?: string; title: string; hint?: ReactNode; children: ReactNode; open?: boolean }) {
  return (
    <details className="ne-section ne-ref" id={id} open={open}>
      <summary className="ne-ref-summary">
        <h2 className="ne-ref-title">{title}</h2>
        {hint ? <span className="ne-ref-hint">{hint}</span> : null}
      </summary>
      <div className="ne-ref-body">{children}</div>
    </details>
  );
}

export function Callout({ tone = 'info', title, children, icon }: { tone?: 'info' | 'warn' | 'danger'; title?: ReactNode; children?: ReactNode; icon?: IconName }) {
  const ic: IconName = icon ?? (tone === 'warn' || tone === 'danger' ? 'warn' : 'info');
  return (
    <div className="ne-callout" data-tone={tone} role={tone === 'danger' ? 'alert' : 'note'}>
      <Icon name={ic} size={16} />
      <div>
        {title ? <div className="ne-callout-title">{title}</div> : null}
        {children ? <div className="ne-muted" style={{ color: 'var(--ne-text-2)' }}>{children}</div> : null}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- states */

export function EmptyState({ title, children, icon = 'info' }: { title: string; children?: ReactNode; icon?: IconName }) {
  return (
    <div className="ne-state">
      <div className="ne-state-icon ne-tone-neutral">
        <Icon name={icon} size={18} />
      </div>
      <div className="ne-state-title">{title}</div>
      {children ? <div style={{ maxWidth: 520 }}>{children}</div> : null}
    </div>
  );
}

export function ErrorState({ error, retry }: { error: Error; retry?: () => void }) {
  const denied = error instanceof ApiError && error.permissionDenied;
  return (
    <div className="ne-state" role={denied ? 'status' : 'alert'}>
      <div className={`ne-state-icon ${denied ? 'ne-tone-neutral' : 'ne-tone-danger'}`}>
        <Icon name={denied ? 'lock' : 'warn'} size={18} />
      </div>
      <div className="ne-state-title">{denied ? 'You do not have access to this view' : 'This view could not be loaded'}</div>
      <div style={{ maxWidth: 560 }}>
        {denied
          ? `${error.message}. Access is decided by the portal backend (nebiusEstate.access.roles); ask a platform admin.`
          : error.message}
      </div>
      {retry && !denied ? (
        <button className="ne-btn ne-btn-sm" type="button" onClick={retry} style={{ marginTop: 6 }}>
          <Icon name="refresh" size={14} /> Retry
        </button>
      ) : null}
    </div>
  );
}

export function Skeleton({ height = 14, width = '100%', style }: { height?: number; width?: number | string; style?: CSSProperties }) {
  return <div className="ne-skel" style={{ height, width, ...style }} aria-hidden />;
}

export function LoadingBlock({ rows = 4, label = 'Loading' }: { rows?: number; label?: string }) {
  return (
    <div className="ne-stack" style={{ padding: 16 }} role="status" aria-live="polite">
      <span className="ne-sr-only">{label}…</span>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} height={i === 0 ? 18 : 12} width={i === 0 ? '40%' : `${90 - i * 9}%`} />
      ))}
    </div>
  );
}

/** Renders loading / error / data for a Loadable; keeps showing stale data while reloading. */
export function Async<T>({ load, children, rows }: { load: Loadable<T>; children: (data: T) => ReactNode; rows?: number }) {
  if (load.data !== undefined) {
    return (
      <>
        {load.error ? <Callout tone="warn" title="Showing the last loaded data">{load.error.message}</Callout> : null}
        {children(load.data)}
      </>
    );
  }
  if (load.error) return <ErrorState error={load.error} retry={load.reload} />;
  return <LoadingBlock rows={rows} />;
}

/* ------------------------------------------------------------------ tiles */

export function StatTile<T>({
  label,
  metric,
  render,
  now,
  tone,
  icon,
  extra,
}: {
  label: string;
  metric: SourcedMetric<T>;
  render: (value: T) => ReactNode;
  now: Date;
  tone?: Tone;
  icon?: IconName;
  extra?: ReactNode;
}) {
  const color = tone ? `var(--ne-${tone === 'neutral' ? 'border-strong' : tone})` : undefined;
  return (
    <section className="ne-card ne-tile" aria-label={label}>
      {color ? <span className="ne-tile-accent" style={{ background: color }} /> : null}
      <div className="ne-tile-label">
        {icon ? <Icon name={icon} size={14} /> : null}
        {label}
      </div>
      {(metric.value === null || metric.value === undefined) && metric.empty ? (
        // The source answered and there is nothing (e.g. no running cluster): plain text, not a gap to set up.
        <>
          <div className="ne-tile-value" style={{ fontSize: '1rem' }}>{metric.empty}</div>
          {metric.unavailableReason ? <div className="ne-tile-reason">{metric.unavailableReason}</div> : null}
        </>
      ) : metric.value === null || metric.value === undefined ? (
        <>
          <div className="ne-tile-unavailable">
            <Icon name="unavailable" size={15} /> Unavailable
          </div>
          <div className="ne-tile-reason">{metric.unavailableReason}</div>
        </>
      ) : (
        <>
          <div className="ne-tile-value">
            {render(metric.value)}
            {metric.unit ? <span className="ne-tile-unit">{' '}{metric.unit}</span> : null}
          </div>
          {metric.note ? <div className="ne-tile-reason">{metric.note}</div> : null}
          {extra}
        </>
      )}
      <TileSource source={metric.source} observedAt={metric.observedAt} now={now} />
    </section>
  );
}

/**
 * A tile's source line: the source, then its age, which never breaks inside ("· 3 h ago" stays one unit). The dot is
 * drawn before each part and clipped at the start of a line, so a wrapped age starts its line without one (#60).
 */
export function TileSource({ source, observedAt, now }: { source: ReactNode; observedAt?: string; now: Date }) {
  return (
    <div className="ne-tile-source ne-tile-source-parts" title={observedAt ? fmtTime(observedAt) : undefined}>
      <span>
        <span>{source}</span>
        {observedAt ? <span className="ne-tile-age">{fmtAgo(observedAt, now)}</span> : null}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ table */

/** Tables with this many columns stack into labelled cards on a phone unless told not to. */
export const STACK_MIN_COLUMNS = 4;
/** Tables with this many rows get a scroll box of their own (viewport-high on wide screens, so the sticky header holds; 75 vh on a phone). */
export const TALL_TABLE_ROWS = 20;

export interface Column<T> {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  sortValue?: (row: T) => string | number;
  align?: 'left' | 'right';
  width?: number | string;
  /** A long header (a title with its window) may wrap, so it does not squeeze the other columns; its lines are balanced (#62). */
  wrapHeader?: boolean;
  /** 'time': the phone sort select says "oldest first / newest first" (G1.12); otherwise by the value's kind. */
  sortKind?: 'time';
  /** The phone sort select's words for ascending and descending, when the value's kind does not say it (G3.10). */
  sortLabels?: [string, string];
}

/**
 * Rows wholly below the visible bottom of their scrolling box: a row the edge cuts is partly seen and not counted
 * (F1.50: "25 more" with 25 rules, the first on screen); less than 1 px on screen is not seen.
 */
export function rowsBelowView(rowTops: number[], viewBottom: number): number {
  return rowTops.filter(t => t > viewBottom - 1).length;
}

/**
 * The edge below which a table's rows are not seen (F1.20 review): the box's bottom, or the "N more" cue's top where
 * the cue holds at the foot of the screen over a box taller than what is left of the screen.
 */
export function visibleRowEdge(boxBottom: number, cueTop: number | undefined): number {
  return cueTop === undefined ? boxBottom : Math.min(boxBottom, cueTop);
}

/**
 * Whether a table box scrolls, and how many rows are not seen below its visible edge (visibleRowEdge), kept current on
 * the box's scroll, the page's scroll and resize. Measured from the rendered rows, so it holds for stacked (card) rows too.
 */
function useRowsBelow(box: RefObject<HTMLDivElement>, cue: RefObject<HTMLElement>, deps: unknown[]): { scrolls: boolean; below: number } {
  const [state, setState] = useState({ scrolls: false, below: 0 });
  useEffect(() => {
    const el = box.current;
    if (!el) return undefined;
    const measure = () => {
      const scrolls = el.scrollHeight > el.clientHeight + 1;
      const edge = visibleRowEdge(el.getBoundingClientRect().bottom, cue.current?.getBoundingClientRect().top);
      const tops = [...el.querySelectorAll<HTMLElement>('tbody > tr')].map(r => r.getBoundingClientRect().top);
      const below = scrolls ? rowsBelowView(tops, edge) : 0;
      setState(s => (s.scrolls === scrolls && s.below === below ? s : { scrolls, below }));
    };
    measure();
    el.addEventListener('scroll', measure, { passive: true });
    window.addEventListener('scroll', measure, { passive: true });
    window.addEventListener('resize', measure);
    const ro = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    ro?.observe(el);
    return () => {
      el.removeEventListener('scroll', measure);
      window.removeEventListener('scroll', measure);
      window.removeEventListener('resize', measure);
      ro?.disconnect();
    };
    // Re-measured once the cue exists (its place sets the edge).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, state.scrolls]);
  return state;
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  selectedKey,
  empty,
  caption,
  compact,
  initialSort,
  maxHeight,
  stack,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  selectedKey?: string;
  empty?: ReactNode;
  caption: string;
  compact?: boolean;
  initialSort?: { key: string; dir: 'asc' | 'desc' };
  maxHeight?: number;
  /**
   * On a phone (≤ 600 px) each row becomes a card of labelled cells instead of a sideways-scrolling table.
   * On by default for 4 or more columns; pass `stack={false}` to keep a sideways-scrolling table.
   */
  stack?: boolean;
}) {
  const stacked = stack ?? columns.length >= STACK_MIN_COLUMNS;
  // A stacked table on a phone hides its header row: it sorts with a select instead, and the hidden header holds no
  // buttons a keyboard could land on unseen (W1F.S1).
  const narrow = useMediaQuery(NARROW_QUERY);
  const sortSelect = stacked && narrow;
  const [sort, setSort] = useState(initialSort);
  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find(c => c.key === sort.key);
    if (!col?.sortValue) return rows;
    const sv = col.sortValue;
    return [...rows].sort((a, b) => {
      const x = sv(a);
      const y = sv(b);
      const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
      return sort.dir === 'asc' ? c : -c;
    });
  }, [rows, sort, columns]);

  const tabStop = sorted.some(r => rowKey(r) === selectedKey) ? selectedKey : sorted.length ? rowKey(sorted[0]) : undefined;
  // A long table without its own height scrolls in a viewport-high box on wide screens, so its header stays visible.
  const tall = !maxHeight && rows.length >= TALL_TABLE_ROWS;
  const box = useRef<HTMLDivElement>(null);
  const cue = useRef<HTMLButtonElement>(null);
  // A box that scrolls says how many rows it hides (F1.20): "Rules" showed 11 of 25 with no cue.
  const { scrolls, below } = useRowsBelow(box, cue, [sorted, maxHeight, tall]);
  if (!rows.length) return <>{empty ?? <EmptyState title="Nothing to show" />}</>;
  const sortable = columns.filter(c => c.sortValue);
  return (
    <>
    {sortSelect && sortable.length ? (
      <div className="ne-table-sort">
        <label>
          <span className="ne-faint">Sort by </span>
          <select className="ne-select" aria-label={`Sort ${caption} by`} value={sort ? `${sort.key}:${sort.dir}` : ''} onChange={e => {
            const [key, dir] = e.target.value.split(':');
            setSort(key ? { key, dir: dir === 'desc' ? 'desc' : 'asc' } : undefined);
          }}>
            <option value="">Listed order</option>
            {sortable.flatMap(c => {
              const name = typeof c.header === 'string' ? c.header : c.key;
              const numeric = typeof c.sortValue!(rows[0]) === 'number';
              const [up, down] = c.sortLabels ?? (c.sortKind === 'time' ? ['oldest first', 'newest first'] : numeric ? ['low to high', 'high to low'] : ['A to Z', 'Z to A']);
              return [
                <option key={`${c.key}:asc`} value={`${c.key}:asc`}>{`${name}, ${up}`}</option>,
                <option key={`${c.key}:desc`} value={`${c.key}:desc`}>{`${name}, ${down}`}</option>,
              ];
            })}
          </select>
        </label>
      </div>
    ) : null}
    {/* The box and its cue in a block of their own: the sticky cue never rises over the sort select above the box. */}
    <div>
    {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- WCAG scrollable-region-focusable: the table may scroll */}
    <div ref={box} className={`ne-table-wrap${tall ? ' ne-table-wrap-tall' : ''}`} style={maxHeight ? { maxHeight, overflowY: 'auto' } : undefined} tabIndex={0} role="region" aria-label={caption}>
      <table className={`ne-table${compact ? ' ne-table-compact' : ''}${stacked ? ' ne-table-stack' : ''}`}>
        <caption className="ne-sr-only">{caption}</caption>
        <thead>
          <tr>
            {columns.map(c => {
              const active = sort?.key === c.key;
              return (
                <th
                  key={c.key}
                  scope="col"
                  className={[c.align === 'right' ? 'ne-right' : '', c.wrapHeader ? 'ne-th-wrap' : ''].filter(Boolean).join(' ') || undefined}
                  style={c.width ? { width: c.width } : undefined}
                  aria-sort={active ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                >
                  {c.sortValue && !sortSelect ? (
                    <button
                      type="button"
                      onClick={() => setSort(s => ({ key: c.key, dir: s?.key === c.key && s.dir === 'asc' ? 'desc' : 'asc' }))}
                    >
                      {c.header}
                      <Icon name="sort" size={12} />
                    </button>
                  ) : (
                    c.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.map((r, i) => {
            const k = rowKey(r);
            return (
              <tr
                key={k}
                data-clickable={onRowClick ? 'true' : undefined}
                aria-selected={selectedKey === k ? true : undefined}
                // One row in the tab order (the selected one, else the first); arrow keys move between rows.
                tabIndex={onRowClick ? (k === tabStop ? 0 : -1) : undefined}
                onClick={onRowClick ? () => onRowClick(r) : undefined}
                onKeyDown={
                  onRowClick
                    ? e => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          onRowClick(r);
                          return;
                        }
                        const to = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: sorted.length - 1 }[e.key];
                        if (to === undefined) return;
                        e.preventDefault();
                        const rowsHere = e.currentTarget.parentElement?.children;
                        (rowsHere?.[Math.max(0, Math.min(sorted.length - 1, to))] as HTMLElement | undefined)?.focus();
                      }
                    : undefined
                }
              >
                {columns.map(c => (
                  <td key={c.key} className={c.align === 'right' ? 'ne-right ne-num' : undefined} data-label={stacked && typeof c.header === 'string' ? c.header : undefined}>
                    {c.render(r)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
    {scrolls ? (
      // Always in the layout while the box scrolls (only hidden when nothing is below), so showing it never moves the page.
      // It holds at the foot of the screen while the table is on it (position: sticky), never below the fold.
      <button
        ref={cue}
        type="button"
        className={`ne-table-more${below > 0 ? '' : ' ne-table-more-done'}`}
        aria-label={`${below} more ${below === 1 ? 'row' : 'rows'} below in ${caption}: scroll down`}
        onClick={() => {
          const el = box.current;
          if (!el) return;
          if (el.scrollTop + el.clientHeight < el.scrollHeight - 1) el.scrollBy({ top: el.clientHeight * 0.8, behavior: 'smooth' });
          // The box is at its end but its foot is under the fold: bring the foot (and the cue's own place) on screen.
          else window.scrollBy({ top: el.getBoundingClientRect().bottom + (cue.current?.offsetHeight ?? 0) - window.innerHeight, behavior: 'smooth' });
        }}
      >
        <span aria-hidden>↓</span> {below} more {below === 1 ? 'row' : 'rows'} below
      </button>
    ) : null}
    </div>
    </>
  );
}

/* ----------------------------------------------------------------- drawer */

export function Drawer({
  open,
  onClose,
  title,
  subtitle,
  children,
  badges,
  mono = true,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  badges?: ReactNode;
  children: ReactNode;
  /** The subtitle is an id (monospace, the default) or prose (`false`; G4.15). */
  mono?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const returnTo = useRef<Element | null>(null);
  // Callers pass inline handlers; reading the latest one through a ref keeps the
  // effect below tied to `open` only, so a re-render never moves focus.
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!open) return undefined;
    returnTo.current = document.activeElement;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close.current();
      if (e.key === 'Tab' && ref.current) {
        const f = ref.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])');
        if (!f.length) return;
        const first = f[0];
        const last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      // Back to the opener; when there was none (opened from a link) or it is gone, to the page heading.
      const opener = returnTo.current as HTMLElement | null;
      if (opener && opener !== document.body && opener.isConnected) opener.focus?.();
      else document.querySelector<HTMLElement>('#main h1, h1[tabindex]')?.focus();
    };
  }, [open]);
  if (!open) return null;
  return (
    <>
      <div className="ne-drawer-backdrop" onClick={onClose} aria-hidden />
      <div className="ne-drawer ne-root" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={ref} tabIndex={-1} style={{ minHeight: 0 }}>
        <div className="ne-drawer-head">
          <div style={{ minWidth: 0 }}>
            <h2 id={titleId} className="ne-title" style={{ fontSize: '1.0625rem', overflowWrap: 'anywhere' }}>
              {title}
            </h2>
            {subtitle ? <div className={mono ? 'ne-muted ne-mono' : 'ne-muted'} style={{ marginTop: 2, overflowWrap: 'anywhere' }}>{subtitle}</div> : null}
            {badges ? <div className="ne-row" style={{ marginTop: 8 }}>{badges}</div> : null}
          </div>
          <button type="button" className="ne-btn ne-btn-ghost ne-btn-sm" onClick={onClose} aria-label="Close details">
            <Icon name="close" size={16} />
          </button>
        </div>
        {/* #40: the body scrolls; a tab stop lets a keyboard scroll it when it holds no link or button (WCAG scrollable-region-focusable). */}
        {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
        <div className="ne-drawer-body" role="region" aria-labelledby={titleId} tabIndex={0}>
          {children}
        </div>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------- tabs */

export function Tabs<T extends string>({ tabs, value, onChange, label }: { tabs: { id: T; label: ReactNode; count?: number }[]; value: T; onChange: (v: T) => void; label: string }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  return (
    <div className="ne-tabs" role="tablist" aria-label={label}>
      {tabs.map((t, i) => (
        <button
          key={t.id}
          ref={el => {
            refs.current[i] = el;
          }}
          type="button"
          role="tab"
          className="ne-tab"
          aria-selected={t.id === value}
          tabIndex={t.id === value ? 0 : -1}
          onClick={() => onChange(t.id)}
          onKeyDown={e => {
            const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
            if (!d) return;
            const n = (i + d + tabs.length) % tabs.length;
            onChange(tabs[n].id);
            refs.current[n]?.focus();
          }}
        >
          {t.label}
          {t.count !== undefined ? <span className="ne-faint" style={{ marginLeft: 6 }}>{t.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function Segmented<T extends string>({ options, value, onChange, label }: { options: { id: T; label: ReactNode; title?: string }[]; value: T; onChange: (v: T) => void; label: string }) {
  return (
    <div className="ne-seg" role="group" aria-label={label}>
      {options.map(o => (
        <button key={o.id} type="button" aria-pressed={o.id === value} title={o.title} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function KeyValue({ items }: { items: [ReactNode, ReactNode][] }) {
  return (
    <dl className="ne-kv">
      {items.map(([k, v], i) => (
        <Fragment key={i}>
          <dt>{k}</dt>
          <dd>{v ?? <span className="ne-faint">—</span>}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

export function DiffView({ diff, label }: { diff: string; label: string }) {
  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- WCAG scrollable-region-focusable: long lines scroll
    <pre className="ne-code" aria-label={label} tabIndex={0}>
      {diff.split('\n').map((l, i) => (
        <span key={i} className={l.startsWith('@@') ? 'ne-hunk' : l.startsWith('+') && !l.startsWith('+++') ? 'ne-add' : l.startsWith('-') && !l.startsWith('---') ? 'ne-del' : undefined}>
          {l}
          {'\n'}
        </span>
      ))}
    </pre>
  );
}

/** The id of a Field's error or hint, for an input nested deeper than the Field's direct child. */
export const fieldMessageId = (htmlFor: string) => `${htmlFor}-msg`;

/**
 * A labelled form field. Its error (or hint) is linked to the input with aria-describedby, and an
 * error sets aria-invalid, when the direct child is the input named by `htmlFor`; a nested input
 * passes `aria-describedby={fieldMessageId(htmlFor)}` itself (WCAG 1.3.1 / 3.3.1).
 */
export function Field({ label, hint, error, children, htmlFor }: { label: ReactNode; hint?: ReactNode; error?: string; children: ReactNode; htmlFor: string }) {
  const msgId = fieldMessageId(htmlFor);
  const hasMsg = Boolean(error || hint);
  let control = children;
  if (isValidElement<Record<string, unknown>>(children) && children.props.id === htmlFor) {
    const own = typeof children.props['aria-describedby'] === 'string' ? (children.props['aria-describedby'] as string) : '';
    const describedBy = [...own.split(' ').filter(x => x && x !== msgId), ...(hasMsg ? [msgId] : [])].join(' ');
    control = cloneElement(children, {
      'aria-describedby': describedBy || undefined,
      'aria-invalid': error ? 'true' : children.props['aria-invalid'],
    });
  }
  return (
    <div className="ne-field" data-invalid={error ? 'true' : undefined}>
      <label htmlFor={htmlFor}>{label}</label>
      {control}
      {error ? (
        <div className="ne-field-error" role="alert" id={msgId}>
          {error}
        </div>
      ) : hint ? (
        <div className="ne-field-hint" id={msgId}>
          {hint}
        </div>
      ) : null}
    </div>
  );
}
