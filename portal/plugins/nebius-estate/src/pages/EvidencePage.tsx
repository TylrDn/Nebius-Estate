import { ReactNode, useEffect, useMemo, useRef } from 'react';
import { Link, Navigate, useLocation, useSearchParams } from 'react-router-dom';
import type { DocumentResponse, EvidenceItem, EvidenceKind, EvidenceResponse, NebiusDocsResponse, RecipeView, RunbookItem } from '@internal/nebius-domain';
import { annotateMermaid, EVIDENCE_KIND_LABELS, provenParts, recipeKeyPages, recipeProof } from '@internal/nebius-domain';
import { ApiError, Async, Badge, Callout, Card, Drawer, EmptyState, KeyValue, Markdown, PageShell, Reference, Tabs, useGet } from '../ui';
import { capsText, EVIDENCE_ORDER, leadEvidence, PROOF_TONE, provisioningText, recipeEvidence } from './solutions/model';

const ORDER = EVIDENCE_ORDER;

const KIND_TONE: Record<EvidenceKind, 'ok' | 'info' | 'accent' | 'warn' | 'neutral'> = {
  'repo-live': 'ok',
  'upstream-live': 'info',
  'mocked-plan-test': 'accent',
  'static-validation': 'neutral',
  'not-measured': 'warn',
};

const KIND_EXPLAIN: Record<EvidenceKind, string> = {
  'repo-live': "A live run of this repository's own code (Terraform roots, scripts or the portal), with its evidence file.",
  'upstream-live': 'Prior live runs of the pinned upstream Nebius recipes. They show the patterns work on Nebius; they did not run this repository and are not measurements of its defaults.',
  'mocked-plan-test': 'terraform test with mocked providers: plan-time logic and policy wiring are exercised; nothing is created.',
  'static-validation': 'Static checks in CI (make ci): formatting, validation, lint, policy, scanning. No credentials, no cloud calls.',
  'not-measured': 'Claims the repository does not yet back with a measurement. Shown so that nothing is mistaken for proven.',
};

type Tab = 'evidence' | 'recipes' | 'runbooks' | 'decisions';
const TABS: Tab[] = ['evidence', 'recipes', 'runbooks', 'decisions'];

/** What the live-run section says about applied roots, derived from the evidence files (never hard-coded). */
export function repoLiveText(items: Pick<EvidenceItem, 'liveRoot' | 'date'>[]): string {
  const runs = new Map<string, string[]>();
  for (const i of items) if (i.liveRoot) runs.set(i.liveRoot, [...(runs.get(i.liveRoot) ?? []), ...(i.date ? [i.date] : [])]);
  if (!runs.size) return 'No evidence file records an apply of a Terraform root of this repository yet.';
  const list = [...runs.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([root, dates]) => `${root.replace(/^terraform\/live\//, '')}${dates.length ? ` (${[...new Set(dates)].sort().join(', ')})` : ''}`);
  return `Terraform roots applied so far, per the evidence files: ${list.join(', ')}.`;
}

/** A title's trailing "— <date>" (2026-10-11, 2026-10-07/08), split off so it can stay on one line (#10). */
export function splitTitleDate(title: string): { head: string; date?: string } {
  const m = /^(.*?)\s+(—\s+\d{4}-\d{2}-\d{2}(?:\/\d{2})?)$/.exec(title);
  return m ? { head: m[1], date: m[2] } : { head: title };
}

/** A title whose date never breaks across lines ("— 2026-10-" / "11", #10). */
function DatedTitle({ title }: { title: string }) {
  const { head, date } = splitTitleDate(title);
  // One inline box: in a flex title or button, separate nodes would become side-by-side columns.
  return date ? (
    <span>
      {head} <span className="ne-nowrap">{date}</span>
    </span>
  ) : (
    <span>{title}</span>
  );
}

export type Session<T> = { date?: string; items: T[] };

/**
 * Live runs by session (evidence date): the newest session, and the earlier ones newest first, undated last.
 * Each live session adds runs; only the newest stays open so the page does not grow with every session (W1F.N5).
 * With no dated run, all of them are the newest session.
 */
export function splitLatestSession<T extends { date?: string }>(items: T[]): { latest: Session<T>; earlier: Session<T>[] } {
  const dates = [...new Set(items.map(i => i.date).filter((d): d is string => !!d))].sort().reverse();
  if (!dates.length) return { latest: { date: undefined, items }, earlier: [] };
  const of = (d?: string) => items.filter(i => (i.date || undefined) === d);
  const earlier: Session<T>[] = dates.slice(1).map(d => ({ date: d, items: of(d) }));
  const undated = of(undefined);
  if (undated.length) earlier.push({ date: undefined, items: undated });
  return { latest: { date: dates[0], items: of(dates[0]) }, earlier };
}

/** GitHub's heading anchor: lower case, punctuation dropped, spaces as dashes ("R1 — Inference" → "r1--inference"). */
export function githubSlug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

/** The heading an in-document anchor points at: by id, else by the GitHub slug of its text (links are written for GitHub). */
export function findHeading(root: ParentNode, anchor: string): HTMLElement | undefined {
  const id = decodeURIComponent(anchor);
  const headings = [...root.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6')];
  return headings.find(h => h.id === id) ?? headings.find(h => githubSlug(h.textContent ?? '') === id);
}

const RAW_ANCHOR = /<a\s+(?:id|name)\s*=\s*"([^"]+)"\s*>\s*<\/a>/gi;
const plain = (t: string) => t.replace(/\s+/g, ' ').trim();

/**
 * Raw HTML anchors (`<a id="x"></a>`) are stripped when a document is rendered (no raw HTML is allowed), so a
 * link to `#x` would go nowhere. Each one is remembered with the plain text that follows it, to find again.
 */
export function rawAnchors(markdown: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of markdown.matchAll(RAW_ANCHOR)) {
    const rest = markdown.slice((m.index ?? 0) + m[0].length).replace(/^\s+/, '');
    const line = rest.split('\n')[0]
      .replace(/^#{1,6}\s+/, '')
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[*`]|__/g, '');
    const text = plain(line);
    if (text) out.set(m[1], text);
  }
  return out;
}

/** The markdown without raw `<a id>` anchors: rendered, they would be empty links (no text, no target). */
export const stripRawAnchors = (markdown: string) => markdown.replace(RAW_ANCHOR, '');

/** The element an in-document anchor points at: a heading (findHeading), else the element a raw `<a id>` stood before; it gets the id. */
export function findAnchor(root: ParentNode, anchor: string, anchors: Map<string, string>): HTMLElement | undefined {
  const heading = findHeading(root, anchor);
  if (heading) return heading;
  const id = decodeURIComponent(anchor);
  const byId = [...root.querySelectorAll<HTMLElement>('[id]')].find(e => e.id === id);
  if (byId) return byId;
  const text = anchors.get(id);
  if (!text) return undefined;
  const depth = (e: Element) => {
    let n = 0;
    for (let a: Element | null = e; a && a !== root; a = a.parentElement) n++;
    return n;
  };
  const hits = [...root.querySelectorAll<HTMLElement>('*')].filter(e => plain(e.textContent ?? '').startsWith(text));
  const target = hits.sort((a, b) => depth(b) - depth(a))[0];
  if (target && !target.id) target.id = id;
  return target;
}

export function EvidencePage() {
  const load = useGet<EvidenceResponse>('/evidence');
  // The docs catalog's key pages name the recipes they serve: each recipe card links them (#11).
  const docs = useGet<NebiusDocsResponse>('/nebius-docs');
  const [params, setParams] = useSearchParams();
  // Tab and open document live in the URL: shareable, and Back returns to the previous one.
  const rawTab = params.get('tab');
  const tab = TABS.find(t => t === rawTab) ?? 'evidence';
  const setTab = (t: Tab) =>
    setParams(prev => {
      const p = new URLSearchParams(prev);
      if (t === 'evidence') p.delete('tab');
      else p.set('tab', t);
      return p;
    });
  const doc = params.get('doc') ?? undefined;
  const openDoc = (path?: string) =>
    setParams(
      prev => {
        const p = new URLSearchParams(prev);
        if (path) p.set('doc', path);
        else p.delete('doc');
        return p;
      },
      // Opening is a step Back can undo; closing replaces the open document, so Back goes to before it opened.
      { replace: !path },
    );

  // Solutions moved to their own page (F1.23): an old link (?tab=solutions&price=…) lands there.
  if (rawTab === 'solutions') {
    const rest = new URLSearchParams(params);
    rest.delete('tab');
    return <Navigate to={`/solutions${rest.toString() ? `?${rest.toString()}` : ''}`} replace />;
  }

  return (
    <PageShell
      title="Evidence & Runbooks"
      subtitle="What is proven, how, when and with which limits — taken from the repository, never turned into green health checks."
      filters={false}
      contents={tab === 'evidence' && load.data ? ORDER.map(k => ({ id: `ev-${k}`, label: EVIDENCE_KIND_LABELS[k] })) : undefined}
    >
      <Async load={load} rows={8}>
        {d => (
          <>
            {rawTab && rawTab !== tab ? (
              <div style={{ marginBottom: 12 }}>
                <Callout tone="warn" title="Not applied from the link">
                  Unknown tab &ldquo;{rawTab}&rdquo;; showing Evidence. Tabs: {TABS.join(', ')}.
                </Callout>
              </div>
            ) : null}
            <Tabs
              label="Evidence sections"
              value={tab}
              onChange={setTab}
              tabs={[
                { id: 'evidence', label: 'Evidence', count: d.items.length },
                { id: 'recipes', label: 'Recipes', count: d.recipes.length },
                { id: 'runbooks', label: 'Runbooks', count: d.runbooks.length },
                { id: 'decisions', label: 'Decisions (ADRs)', count: d.decisions.length },
              ]}
            />
            {tab === 'evidence' ? <EvidenceList items={d.items} openDoc={openDoc} /> : null}
            {tab === 'recipes' ? <RecipeList items={d.recipes} evidence={d.items} openDoc={openDoc} keyPages={docs.data?.keyPages} /> : null}
            {tab === 'runbooks' ? <DocList items={d.runbooks} openDoc={openDoc} icon="doc" /> : null}
            {tab === 'decisions' ? <DocList items={d.decisions} openDoc={openDoc} icon="evidence" /> : null}
          </>
        )}
      </Async>
      <DocViewer path={doc} onClose={() => openDoc(undefined)} />
    </PageShell>
  );
}

function EvidenceList({ items, openDoc }: { items: EvidenceItem[]; openDoc: (p: string) => void }) {
  const groups = useMemo(() => ORDER.map(k => ({ kind: k, items: items.filter(i => i.kind === k) })), [items]);
  return (
    <div className="ne-stack" style={{ gap: 18 }}>
      {/* Runs of this repository lead, open; every other kind folds under its name and count (W1F.N5: 25,252 px at 390). */}
      {groups.map((g, gi) => (
        <Reference key={g.kind} id={`ev-${g.kind}`} title={`${EVIDENCE_KIND_LABELS[g.kind]} (${g.items.length})`} hint={gi === 0 ? undefined : KIND_EXPLAIN[g.kind]} open={gi === 0}>
          <p className="ne-text-2" style={{ margin: '0 0 10px', fontSize: 'var(--ne-fs-small)', maxWidth: 'var(--ne-measure)' }}>
            {gi === 0 ? KIND_EXPLAIN[g.kind] : null}
            {g.kind === 'repo-live' ? ` ${repoLiveText(g.items)}` : null}
          </p>
          {g.items.length === 0 ? (
            <Card>
              <EmptyState title={g.kind === 'repo-live' ? 'No live run of this repository yet' : 'Nothing recorded'} icon="info">
                {g.kind === 'repo-live' ? 'docs/evidence/ holds no file whose Kind header says "run of this repository".' : null}
              </EmptyState>
            </Card>
          ) : g.kind === 'mocked-plan-test' || g.kind === 'static-validation' ? (
            <Card flush>
              <ul style={{ listStyle: 'none', margin: 0, padding: '6px 0' }}>
                {g.items.map(i => (
                  <li key={i.id} className="ne-between ne-evidence-row">
                    <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                      <strong style={{ fontWeight: 600 }}>{i.title}</strong> <span className="ne-faint ne-mono">{i.path ?? ''}</span>
                    </span>
                    <span className="ne-muted" style={{ fontSize: '0.75rem' }}>
                      {i.method}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          ) : (
            <SessionCards items={g.items} kind={g.kind} openDoc={openDoc} />
          )}
        </Reference>
      ))}
    </div>
  );
}

/** One evidence file as a card: what it proves up front, the rest one click away. */
function EvidenceCard({ i, kind, openDoc }: { i: EvidenceItem; kind: EvidenceKind; openDoc: (p: string) => void }) {
  return (
    <Card
      title={<DatedTitle title={i.title} />}
      icon={kind === 'not-measured' ? 'unavailable' : 'evidence'}
      actions={
        i.path ? (
          <button type="button" className="ne-btn ne-btn-sm" onClick={() => openDoc(i.path!)}>
            Read
          </button>
        ) : null
      }
    >
      {/*
        What it proves up front (the date is in the title); its limits, region and how it was measured one click
        away, named in the summary (and in the document). Twenty open cards made the page 25,252 px on a phone (W1F.N5).
      */}
      <KeyValue
        items={(
          [
            ['Proves', i.proves],
            ['Recipe', i.recipes?.join(', ') ?? i.recipe],
          ] as [string, string | undefined][]
        ).filter(([, v]) => v)}
      />
      {i.limitations || i.region || i.versions || i.method || i.cost ? (
        <details className="ne-more">
          <summary>{[i.limitations ? 'Limits' : '', i.region ? 'region' : '', i.method ? 'method' : '', i.versions ? 'versions' : '', i.cost ? 'cost' : ''].filter(Boolean).join(', ').replace(/^./, c => c.toUpperCase())}</summary>
          <KeyValue
            items={(
              [
                ['Limits', i.limitations],
                ['Date', i.date],
                ['Region', i.region],
                ['Versions', i.versions],
                ['Method', i.method],
                ['Cost', i.cost],
              ] as [string, string | undefined][]
            ).filter(([, v]) => v)}
          />
        </details>
      ) : null}
    </Card>
  );
}

/**
 * Cards of a kind. Live runs of this repository show the newest session open and fold each earlier session under
 * its date and count: every session adds runs, and 24 open cards made the page 9,609 px on a phone.
 */
function SessionCards({ items, kind, openDoc }: { items: EvidenceItem[]; kind: EvidenceKind; openDoc: (p: string) => void }) {
  const grid = (list: EvidenceItem[]) => (
    <div className="ne-grid ne-grid-2">
      {list.map(i => (
        <EvidenceCard key={i.id} i={i} kind={kind} openDoc={openDoc} />
      ))}
    </div>
  );
  if (kind !== 'repo-live') return grid(items);
  const { latest, earlier } = splitLatestSession(items);
  return (
    <div className="ne-stack" style={{ gap: 12 }}>
      {latest.date && earlier.length ? <p className="ne-text-2" style={{ margin: 0, fontSize: 'var(--ne-fs-small)', fontWeight: 600 }}>Latest session: {latest.date} ({latest.items.length})</p> : null}
      {grid(latest.items)}
      {earlier.map(e => (
        <details key={e.date ?? 'undated'} className="ne-more" id={`ev-repo-live-${e.date ?? 'undated'}`}>
          <summary>{e.date ? `Session ${e.date}` : 'Undated runs'} ({e.items.length})</summary>
          {grid(e.items)}
        </details>
      ))}
    </div>
  );
}

/** Evidence rows a recipe card leads with; the rest fold under their count (W1F.N5: R1 alone was 838 px on a phone). */
const LEAD_ROWS = 2;

function EvidenceRows({ rows, openDoc }: { rows: EvidenceItem[]; openDoc: (p: string) => void }) {
  return (
    <ul className="ne-ev-rows">
      {rows.map(e => (
        <li key={e.id}>
          <Badge tone={KIND_TONE[e.kind]} wrap>{EVIDENCE_KIND_LABELS[e.kind]}</Badge>{' '}
          {e.path ? (
            <button type="button" className="ne-btn ne-btn-sm ne-btn-ghost ne-btn-wrap" onClick={() => openDoc(e.path!)} aria-label={docButtonLabel(e.title, e.path)}>
              <DatedTitle title={e.title} />
            </button>
          ) : (
            e.title
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * The repository's recipes (R1–R16), read-only: README, runbooks, evidence rows, stage caps and how the
 * portal offers each (a form for R1, R3 and R4; read-only live roots; documentation and runbooks).
 */
function RecipeList({ items, evidence, openDoc, keyPages }: { items: RecipeView[]; evidence: EvidenceItem[]; openDoc: (p: string) => void; keyPages?: { path: string; why: string }[] }) {
  return (
    <div className="ne-grid ne-grid-2">
      {items.map(r => {
        const rows = recipeEvidence(evidence, r.id);
        const shown = leadEvidence(rows, LEAD_ROWS, r.id);
        const caps = capsText(r.caps);
        const proven = provenParts(r.provenToday);
        // W1-P13: the date of the newest live evidence file, or "Not measured", never blank.
        const last = recipeProof(r.id, evidence);
        return (
          <Card
            key={r.id}
            title={`${r.id} · ${r.title}`}
            icon="provision"
            actions={
              <>
                {proven.level && (
                  <Badge tone={PROOF_TONE[proven.level]} title="Proof level, as in the README What is proven table">
                    {proven.level}
                  </Badge>
                )}{' '}
                {/* W1-P13: the date of the newest live evidence file, or "Not measured", never blank (one line, no new row: N5). */}
                <span className="ne-faint ne-nowrap" style={{ fontSize: 'var(--ne-fs-small)' }} title={last.path ? `Newest live evidence: ${last.path}` : 'No evidence file in docs/evidence/ records a live run of it'}>
                  {last.lastLive ? `last live ${last.lastLive}` : 'Not measured'}
                </span>{' '}
                {r.docsAvailable ? (
                  <button type="button" className="ne-btn ne-btn-sm" onClick={() => openDoc(r.docs)} aria-label={`Read ${r.docs}`}>
                    Read
                  </button>
                ) : (
                  <Badge tone="neutral" title={`${r.docs} is not in this checkout yet`}>
                    README pending
                  </Badge>
                )}
              </>
            }
            footer={
              // The Nebius docs that name this recipe, on the same line as its path (no new row: the N5 phone budget).
              <>
                <span className="ne-mono">{r.path}</span>
                {keyPages && recipeKeyPages(keyPages, r.id).length ? (
                  <>
                    {' · '}
                    <Link to={`/nebius-docs?q=${encodeURIComponent(r.id)}`}>{`Nebius docs for ${r.id} (${recipeKeyPages(keyPages, r.id).length})`}</Link>
                  </>
                ) : null}
              </>
            }
          >
            {/* What is proven (level in the header, detail first) and the evidence up front; how it is provisioned and its runbooks one click away (W1F.N5). */}
            <p className="ne-text-2" style={{ margin: '0 0 8px' }}>
              {proven.detail.charAt(0).toUpperCase() + proven.detail.slice(1)}
            </p>
            <KeyValue
              items={(
                [
                  [
                    'Evidence',
                    rows.length ? (
                      <>
                        <EvidenceRows rows={shown.lead} openDoc={openDoc} />
                        {shown.rest.length ? (
                          <details className="ne-more">
                            <summary>{`${shown.rest.length} more`}</summary>
                            <EvidenceRows rows={shown.rest} openDoc={openDoc} />
                          </details>
                        ) : null}
                      </>
                    ) : (
                      <span className="ne-faint">no row yet</span>
                    ),
                  ],
                ] as ([string, ReactNode] | undefined)[]
              ).filter((x): x is [string, ReactNode] => Boolean(x))}
            />
            <details className="ne-more">
              <summary>{`Provisioning${caps ? ', GPU-node cap' : ''} and runbooks (${r.runbooks.length})`}</summary>
              <KeyValue
                items={(
                  [
                    ['Provisioning', provisioningText(r)],
                    caps ? ['GPU-node cap (platform/stages.yaml)', caps] : undefined,
                    r.moreDocs?.length ? ['Also', <DocButtons paths={r.moreDocs} openDoc={openDoc} />] : undefined,
                    ['Runbooks', r.runbooks.length ? <DocButtons paths={r.runbooks} openDoc={openDoc} /> : <span className="ne-faint">none yet</span>],
                  ] as ([string, ReactNode] | undefined)[]
                ).filter((x): x is [string, ReactNode] => Boolean(x))}
              />
            </details>
          </Card>
        );
      })}
    </div>
  );
}

/** A document button's accessible name: its visible text first (WCAG 2.5.3), then the path it opens. */
export function docButtonLabel(visible: string, path: string): string {
  return `${visible}, read ${path}`;
}

function DocButtons({ paths, openDoc }: { paths: string[]; openDoc: (p: string) => void }) {
  return (
    <span className="ne-row" style={{ gap: 2, flexWrap: 'wrap' }}>
      {paths.map(p => (
        <button key={p} type="button" className="ne-btn ne-btn-sm ne-btn-ghost ne-mono ne-btn-wrap" onClick={() => openDoc(p)} aria-label={docButtonLabel(p.split('/').pop() ?? p, p)}>
          {p.split('/').pop()}
        </button>
      ))}
    </span>
  );
}

function DocList({ items, openDoc, icon }: { items: RunbookItem[]; openDoc: (p: string) => void; icon: 'doc' | 'evidence' }) {
  return (
    <div className="ne-grid ne-grid-2">
      {items.map(r => (
        <Card
          key={r.id}
          title={r.title}
          icon={icon}
          actions={
            <button type="button" className="ne-btn ne-btn-sm" onClick={() => openDoc(r.path)}>
              Read
            </button>
          }
          footer={<span className="ne-mono">{r.path}</span>}
        >
          <p className="ne-text-2" style={{ margin: 0, fontSize: 'var(--ne-fs-small)', overflowWrap: 'anywhere' }}>
            {r.summary || 'No summary paragraph.'}
          </p>
        </Card>
      ))}
    </div>
  );
}

/**
 * Link targets inside a repository document: a relative link opens the linked
 * file in this viewer (the backend decides whether it is readable); absolute
 * links keep only http(s) and mailto. `search` is the page's current query: its
 * other parameters (the Evidence tab, the priced solution) are kept, so following
 * a link never changes the page behind the drawer (G5.9).
 */
export function docLink(from: string, href: string, search = ''): string {
  const open = (path: string, anchor?: string) => {
    const p = new URLSearchParams(search);
    p.set('doc', path);
    return `?${p.toString()}${anchor ? `#${anchor}` : ''}`;
  };
  // An in-document anchor keeps the open document (a bare "#x" would drop ?doc and close the viewer).
  if (href.startsWith('#')) return open(from, href.slice(1));
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return /^(https?|mailto):/i.test(href) ? href : '#';
  const [target, anchor] = href.split('#');
  const parts = href.startsWith('/') ? [] : from.split('/').slice(0, -1);
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg && seg !== '.') parts.push(seg);
  }
  return open(parts.join('/'), anchor);
}

/** A repository document in a drawer (also used by Solutions). */
export function DocViewer({ path, onClose }: { path?: string; onClose: () => void }) {
  const load = useGet<DocumentResponse>(path ? `/document?path=${encodeURIComponent(path)}` : null);
  const d = load.data && load.data.path === path ? load.data : undefined;
  const { hash, search } = useLocation();
  const body = useRef<HTMLDivElement>(null);
  // Scroll to the heading the #anchor names once the document is on screen.
  useEffect(() => {
    if (!d || !hash || !body.current) return;
    const h = findAnchor(body.current, hash.slice(1), rawAnchors(d.markdown));
    if (!h) return;
    h.scrollIntoView?.({ block: 'start' });
    h.setAttribute('tabindex', '-1');
    h.focus({ preventScroll: true });
  }, [d, hash]);
  const e = !d && !load.loading && load.error instanceof ApiError ? load.error : undefined;
  const missing = e?.status === 404;
  const refused = e?.status === 403 && /not readable/.test(e.message);
  return (
    <Drawer open={Boolean(path)} onClose={onClose} title={path?.split('/').pop() ?? ''} subtitle={path}>
      {missing || refused ? (
        <EmptyState title={missing ? 'Not in this checkout' : 'Not readable through the portal'} icon="doc">
          {missing
            ? 'The portal reads documents from its repository checkout, and this file is not there yet. It appears here once it is committed and the checkout is updated.'
            : 'Only allowlisted documentation and sizing files are served (docs/portal/security.md); state, plans and other files never are.'}
        </EmptyState>
      ) : (
        <Async load={{ ...load, data: d }} rows={10}>
          {doc =>
            doc.path.endsWith('.md') ? (
              <Markdown ref={body} content={annotateMermaid(stripRawAnchors(doc.markdown), doc.path)} transformLinkUri={href => docLink(doc.path, href, search)} />
            ) : (
              // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- WCAG scrollable-region-focusable
              <pre className="ne-code" tabIndex={0} aria-label={doc.path}>{doc.markdown}</pre>
            )
          }
        </Async>
      )}
    </Drawer>
  );
}
