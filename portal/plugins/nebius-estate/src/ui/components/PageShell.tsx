import { MouseEvent, ReactNode, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { FilterOptions } from '@internal/nebius-domain';
import { revealSection } from '../anchors';
import { refreshAll, useGet, useRefreshClock } from '../api';
import { ignoredFilterValues, IgnoredFilterValue, useGlobalFilter } from '../filters';
import { Icon } from '../icons';
import { NARROW_QUERY, useMediaQuery } from '../media';
import { Badge, Callout } from './primitives';
import { TestDataBanner } from './TestData';

/**
 * Every Nebius connector is read-only; the portal never applies a change to the cloud. It does save its own data
 * (budgets, scenarios, rate books, imports), so the badge names what it is read-only to (F1.22).
 */
function ReadOnlyBadge() {
  return (
    <Badge tone="ok" dot title="Read-only connectors to the configured Nebius projects: nothing is created or changed in Nebius from the portal. Budgets, scenarios, rate books and imports are saved in the portal's own database.">
      Read-only to Nebius
    </Badge>
  );
}

const AUTO_REFRESH_MS = 5 * 60_000;

/** "Refreshed 3 min ago · Refresh"; refetches every view on the page, and quietly every 5 min while visible. */
export function RefreshControl() {
  const { refreshedAt } = useRefreshClock();
  const [, setNow] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => {
      setNow(Date.now());
      if (document.visibilityState === 'visible' && Date.now() - refreshedAt >= AUTO_REFRESH_MS) refreshAll();
    }, 30_000);
    return () => window.clearInterval(id);
  }, [refreshedAt]);
  const mins = Math.floor((Date.now() - refreshedAt) / 60_000);
  const age = mins < 1 ? 'Refreshed just now' : `Refreshed ${mins} min ago`;
  return (
    <span className="ne-row ne-no-print" style={{ gap: 6 }}>
      {/* On a phone the age is the button's hover text, so Refresh and the read-only badge share one row (#24). */}
      <span className="ne-faint ne-refresh-age" style={{ fontSize: '0.75rem' }} aria-live="polite">
        {age}
      </span>
      <button type="button" className="ne-btn ne-btn-sm" onClick={refreshAll} aria-label="Refresh all data on this page" title={age}>
        <Icon name="refresh" size={13} /> Refresh
      </button>
    </span>
  );
}

export function FilterBar({ search, onSearch, extra }: { search?: string; onSearch?: (q: string) => void; extra?: ReactNode }) {
  const [filter, setFilter] = useGlobalFilter();
  const [params] = useSearchParams();
  const opts = useGet<FilterOptions>('/filters');
  const o = opts.data;
  // A value from the link that cannot apply (invalid, or nothing in scope matches it) is taken out of the URL —
  // and the bar says which, instead of silently showing everything.
  const [ignored, setIgnored] = useState<IgnoredFilterValue[]>([]);
  // #32: before the first inventory sync the options are empty; read them again until the scope is known.
  const reload = opts.reload;
  useEffect(() => {
    if (!o?.pending) return undefined;
    const t = setTimeout(reload, 5000);
    return () => clearTimeout(t);
  }, [o, reload]);
  useEffect(() => {
    if (!o) return;
    const bad = ignoredFilterValues(params, o);
    if (!bad.length) return;
    setIgnored(prev => [...prev.filter(p => !bad.some(b => b.key === p.key)), ...bad]);
    setFilter(Object.fromEntries(bad.map(b => [b.key, undefined])), { replace: true });
  }, [o, params, setFilter]);
  const active = Boolean(filter.project || filter.region || filter.stage);
  const sameName = (name: string) => (o?.projects.filter(p => p.name === name).length ?? 0) > 1;
  // On a phone the three selects (and the search) were two to four rows above the first figure (#24): one "Filters"
  // control that says what is applied, opened on a tap.
  const narrow = useMediaQuery(NARROW_QUERY);
  const bar = (
    <div className="ne-filterbar" role="search" aria-label="Global filter">
      <select className="ne-select" aria-label="Project" value={filter.project ?? ''} onChange={e => setFilter({ project: e.target.value || undefined })}>
        <option value="">All projects</option>
        {o?.projects.map(p => (
          <option key={p.id} value={p.id} title={p.id}>
            {sameName(p.name) ? `${p.name} (${p.id})` : p.name}
          </option>
        ))}
      </select>
      <select className="ne-select" aria-label="Region" value={filter.region ?? ''} onChange={e => setFilter({ region: e.target.value || undefined })}>
        <option value="">All regions</option>
        {o?.regions.map(r => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
      </select>
      <select className="ne-select" aria-label="Stage" value={filter.stage ?? ''} onChange={e => setFilter({ stage: e.target.value || undefined })}>
        <option value="">All stages</option>
        {o?.stages.map(s => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
      {onSearch ? (
        <div className="ne-search">
          <Icon name="search" size={14} />
          <input className="ne-input" type="search" placeholder="Search name, id, label…" aria-label="Search" value={search ?? ''} onChange={e => onSearch(e.target.value)} />
        </div>
      ) : null}
      {active ? (
        <button type="button" className="ne-btn ne-btn-ghost ne-btn-sm" onClick={() => setFilter({ project: undefined, region: undefined, stage: undefined })}>
          Clear filters
        </button>
      ) : null}
      {extra}
    </div>
  );
  const applied = [
    filter.project ? (o?.projects.find(p => p.id === filter.project)?.name ?? filter.project) : 'all projects',
    filter.region ?? 'all regions',
    filter.stage ?? 'all stages',
    ...(search ? [`“${search}”`] : []),
  ].join(' · ');
  return (
    <>
    {narrow ? (
      <details className="ne-filter-fold">
        <summary>
          <Icon name="search" size={13} /> Filters<span className="ne-filter-fold-applied">: {applied}</span>
        </summary>
        {bar}
      </details>
    ) : (
      bar
    )}
    {ignored.length ? (
      <div className="ne-filter-notice" role="status">
        <Callout tone="warn" title="Filter from the link not applied">
          {ignored.map(i => `${i.key} "${i.value}" (${i.reason})`).join('; ')}. Showing all {ignored.map(i => `${i.key === 'project' ? 'projects' : `${i.key}s`}`).join(', ')} instead.{' '}
          <button type="button" className="ne-btn ne-btn-ghost ne-btn-sm" onClick={() => setIgnored([])}>
            Dismiss
          </button>
        </Callout>
      </div>
    ) : null}
    </>
  );
}

/**
 * The page intro. On a phone a long intro pushed the first figure below the fold (#24): its first sentence shows, and
 * the rest is one tap away ("More about this page"). A wide screen shows it whole.
 */
export function Subtitle({ text }: { text: ReactNode }) {
  const narrow = useMediaQuery(NARROW_QUERY);
  const parts = typeof text === 'string' ? introParts(text) : null;
  if (!narrow || !parts) return <p className="ne-subtitle">{text}</p>;
  return (
    <div className="ne-subtitle">
      <p className="ne-subtitle-first">{parts.first}</p>
      <details className="ne-subtitle-more">
        <summary>More about this page</summary>
        <p>{parts.more}</p>
      </details>
    </div>
  );
}

/** The phone intro: the first sentence and the rest; a first sentence over 90 characters is cut at a word, and the whole text is the rest. */
export function introParts(text: string, max = 90): { first: string; more: string } | null {
  const m = /^(.+?[.:])\s+(\S[^]*)$/.exec(text);
  const sentence = m ? m[1] : text;
  if (sentence.length > max) {
    const cut = sentence.lastIndexOf(' ', max - 10);
    return { first: `${sentence.slice(0, cut > 0 ? cut : max - 10).replace(/[,;:(]$/, '')}…`, more: text };
  }
  return m ? { first: m[1], more: m[2] } : null;
}

/** A section a long page lists in its "On this page" row: the element id and its label. */
export interface PageSection {
  id: string;
  label: string;
}

/** Moves to a section: scrolls it under the sticky header (scroll-margin), focuses it, and names it in the URL. */
export function goToSection(id: string, e?: MouseEvent) {
  const el = document.getElementById(id);
  if (!el) return;
  e?.preventDefault();
  revealSection(el);
  el.scrollIntoView?.({ block: 'start' });
  if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
  el.focus({ preventScroll: true });
  window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}#${id}`);
}

/** "On this page": links to the sections of a long page, in the page header so they stay at hand. */
export function SectionLinks({ sections }: { sections: PageSection[] }) {
  if (sections.length < 2) return null;
  return (
    <nav className="ne-toc ne-no-print" aria-label="On this page">
      <span className="ne-toc-label" aria-hidden>
        On this page
      </span>
      <ul>
        {sections.map(s => (
          <li key={s.id}>
            <a href={`#${s.id}`} onClick={e => goToSection(s.id, e)}>
              {s.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function PageShell({
  title,
  subtitle,
  actions,
  filters = true,
  search,
  onSearch,
  filterExtra,
  contents,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  filters?: boolean;
  search?: string;
  onSearch?: (q: string) => void;
  filterExtra?: ReactNode;
  /** Sections of a long page, listed under the title (SectionLinks). */
  contents?: PageSection[];
  children: ReactNode;
}) {
  useEffect(() => {
    document.title = `${title} · Nebius Estate`;
  }, [title]);
  // The sticky header's height, so a section scrolled to (or a sticky element) sits below it, not under it.
  const root = useRef<HTMLDivElement>(null);
  const header = useRef<HTMLElement>(null);
  useEffect(() => {
    const h = header.current;
    if (!h || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => root.current?.style.setProperty('--ne-header-h', `${Math.round(h.getBoundingClientRect().height)}px`));
    ro.observe(h);
    return () => ro.disconnect();
  }, []);
  return (
    <div className="ne-root" ref={root}>
      <main className="ne-page" id="main">
        <header className="ne-header" ref={header}>
          <TestDataBanner />
          <div className="ne-header-row">
            <div style={{ minWidth: 0 }}>
              <nav aria-label="Breadcrumb">
                <ol className="ne-crumbs">
                  <li>Nebius Estate</li>
                  <li aria-current="page">{title}</li>
                </ol>
              </nav>
              {/* Focusable by script: a dialog opened from a link (no opener) returns focus here. */}
              <h1 className="ne-title" tabIndex={-1}>
                {title}
              </h1>
              {subtitle ? <Subtitle text={subtitle} /> : null}
            </div>
            <div className="ne-header-aside">
              {actions}
              <RefreshControl />
              <ReadOnlyBadge />
            </div>
          </div>
          {filters ? <FilterBar search={search} onSearch={onSearch} extra={filterExtra} /> : null}
          {contents ? <SectionLinks sections={contents} /> : null}
        </header>
        {children}
      </main>
    </div>
  );
}

/** The clock for ages and TTLs on a page: the browser's, at render time. */
export function usePortalNow(): Date {
  return new Date();
}
