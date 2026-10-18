import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { docsCoverage, docsHref, docsUrl } from '@internal/nebius-domain';
import type { IntegrationsResponse, NebiusDocsPage as DocsEntry, NebiusDocsPageResponse, NebiusDocsResponse } from '@internal/nebius-domain';
import { Async, Callout, Card, Drawer, EmptyState, Markdown, PageShell, Reference, useGet } from '../ui';
import { DocsCoverageTable } from './nebiusDocs/DocsCoverage';
import { observedState } from './integrations/model';

/** A link inside a mirrored page: a docs path opens here; anything else is the public docs site. */
export function mirrorLink(href: string): string {
  if (/^https?:\/\//.test(href)) return href;
  if (href.startsWith('#')) return href;
  if (href.startsWith('/')) {
    const [path, anchor] = href.split('#');
    return anchor ? docsUrl(path.replace(/\/$/, '') || '/', anchor) : docsHref(path.replace(/\/$/, '') || '/');
  }
  return docsUrl(`/${href}`);
}

/** Pages whose title, path or key-page note matches every word of the search ("R3", "quota", "infiniband"). */
export function matchPages(pages: DocsEntry[], keyPages: { path: string; why: string }[], q: string): DocsEntry[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return pages;
  const why = new Map(keyPages.map(k => [k.path, k.why]));
  // A recipe id matches as a word: R1 is not R12.
  const has = (text: string, w: string) => (/^r\d+$/.test(w) ? new RegExp(`\\b${w}\\b`).test(text) : text.includes(w));
  return pages.filter(p => {
    const text = `${p.title} ${p.path} ${why.get(p.path) ?? ''}`.toLowerCase();
    return words.every(w => has(text, w));
  });
}

function PageList({ pages, open }: { pages: DocsEntry[]; open: (path: string) => void }) {
  return (
    <ul className="ne-docs-list">
      {pages.map(p => (
        <li key={p.path}>
          <button type="button" className="ne-linkbtn" onClick={() => open(p.path)}>
            {p.title}
          </button>{' '}
          <span className="ne-faint ne-mono ne-docs-path">{p.path}</span>
        </li>
      ))}
    </ul>
  );
}

function DocsDrawer({ path, onClose }: { path?: string; onClose: () => void }) {
  const load = useGet<NebiusDocsPageResponse>(path ? `/nebius-docs/page?path=${encodeURIComponent(path)}` : null);
  const d = load.data?.path === path ? load.data : undefined;
  return (
    <Drawer open={Boolean(path)} onClose={onClose} title={d?.title ?? path ?? ''} subtitle={path}>
      <Async load={{ ...load, data: d }} rows={10}>
        {doc => (
          <>
            <p style={{ marginTop: 0 }}>
              <a href={doc.url} target="_blank" rel="noreferrer">
                Open on docs.nebius.com ↗
              </a>
            </p>
            {doc.mirrored && doc.markdown !== undefined ? (
              <Markdown content={doc.markdown} transformLinkUri={mirrorLink} />
            ) : (
              <>
                <EmptyState title="Not in the local mirror" icon="doc">
                  The page text is read from the local mirror (.cache/nebius-docs, written by make docs-catalog), which does not have this page. Its sections are below, each a link to
                  docs.nebius.com.
                </EmptyState>
                {doc.headings.length ? (
                  <ul aria-label="Sections of this page">
                    {doc.headings.map(h => (
                      <li key={h.anchor}>
                        <a href={docsUrl(doc.path, h.anchor)} target="_blank" rel="noreferrer">
                          {h.text}
                        </a>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </>
            )}
          </>
        )}
      </Async>
    </Drawer>
  );
}

export function NebiusDocsPage() {
  const docs = useGet<NebiusDocsResponse>('/nebius-docs');
  const integrations = useGet<IntegrationsResponse>('/integrations');
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const section = params.get('section') ?? undefined;
  const page = params.get('page') ?? undefined;
  const set = (patch: Record<string, string | undefined>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    setParams(next);
  };
  // Stated only once /integrations answers: while it loads, or when it fails, no section is called "not read" (W1-P26).
  // The same input as Integrations: a call the quick sync skipped reads as answered on the full sync.
  const coverage = useMemo(
    () =>
      docs.data && integrations.data
        ? docsCoverage(docs.data.sections, integrations.data.capabilities.map(observedState), { soperatorClusterIds: integrations.data.soperatorClusterIds })
        : undefined,
    [docs.data, integrations.data],
  );
  return (
    <PageShell
      title="Nebius docs"
      subtitle="The Nebius documentation catalog (docs/reference/nebius-docs.md), each service section with what the portal reads of it. A page opens here from the local mirror when it is present, and always on docs.nebius.com."
      filters={false}
      contents={[
        { id: 'docs-coverage', label: 'Coverage' },
        { id: 'docs-key', label: 'Key pages' },
        { id: 'docs-sections', label: 'Sections' },
      ]}
    >
      <Async load={docs} rows={8}>
        {d => {
          const found = matchPages(d.pages, d.keyPages, q);
          return (
            <>
              <div className="ne-row" style={{ marginBottom: 12, flexWrap: 'wrap' }}>
                <div className="ne-search" style={{ flex: '1 1 18rem' }}>
                  <input className="ne-input" type="search" aria-label="Search the docs catalog" placeholder="Search titles, paths, recipes (R3)…" value={q} onChange={e => set({ q: e.target.value || undefined })} style={{ width: '100%' }} />
                </div>
                <span className="ne-faint">
                  {d.pages.length} pages · catalog of {d.generated} · {d.mirror ? 'local mirror present' : 'no local mirror: pages open on docs.nebius.com'}
                </span>
              </div>
              {q ? (
                <Card title={`${found.length} page${found.length === 1 ? '' : 's'} match “${q}”`} icon="doc">
                  {found.length ? <PageList pages={found.slice(0, 100)} open={p => set({ page: p })} /> : <p className="ne-muted" style={{ margin: 0 }}>No catalogued page matches.</p>}
                </Card>
              ) : null}

              <section id="docs-coverage" aria-label="Coverage against the Nebius docs" className="ne-section">
                <Card
                  title="What the portal reads, against the docs"
                  icon="integrations"
                  flush
                  footer={coverage?.summary ?? (integrations.error ? `Coverage unavailable: ${integrations.error.message}` : 'Checking what the portal reads…')}
                >
                  <Async load={{ ...integrations, data: coverage }} rows={6}>
                    {c => <DocsCoverageTable rows={c.rows} />}
                  </Async>
                </Card>
              </section>

              <Reference id="docs-key" title={`Key pages (${d.keyPages.length})`} hint="The pages this repository relies on, with why." open={!q && !section}>
                <ul className="ne-docs-list">
                  {d.keyPages.map(k => (
                    <li key={k.path}>
                      <button type="button" className="ne-linkbtn" onClick={() => set({ page: k.path })}>
                        {d.pages.find(p => p.path === k.path)?.title ?? k.path}
                      </button>{' '}
                      <span className="ne-muted">— {k.why}</span>
                    </li>
                  ))}
                </ul>
              </Reference>

              <h2 className="ne-section-title ne-section" id="docs-sections">
                Sections
              </h2>
              {d.sections.map(s => {
                const row = coverage?.rows.find(r => r.section === s.name);
                const pages = d.pages.filter(p => p.section === s.name);
                return (
                  <Reference
                    key={s.name}
                    id={`docs-section-${s.name === '/' ? 'home' : s.name}`}
                    title={`${s.name === '/' ? 'home' : s.name} (${s.pages} page${s.pages === 1 ? '' : 's'})`}
                    hint={row ? `${row.state === 'read' ? 'Read by the portal' : row.state === 'reference' ? 'Documentation only' : row.state === 'failing' ? 'Called, not answering' : 'Not read by the portal'}${s.referenceOnly ? ' · landing page only in the catalog' : ''}` : undefined}
                    open={section === s.name}
                  >
                    {row?.reason || row?.impact ? (
                      <p className="ne-muted" style={{ marginTop: 0 }}>
                        {row.reason} {row.impact}
                      </p>
                    ) : null}
                    <PageList pages={pages} open={p => set({ page: p })} />
                  </Reference>
                );
              })}
              {!d.mirror ? (
                <Callout tone="info" title="No local mirror">
                  Pages open on docs.nebius.com. To read them here, run <code>make docs-catalog</code> (network; writes the git-ignored .cache/nebius-docs).{' '}
                  <Link to="/evidence?doc=docs%2Freference%2Fnebius-docs.md">The catalog as a document</Link>.
                </Callout>
              ) : null}
            </>
          );
        }}
      </Async>
      <DocsDrawer path={page} onClose={() => set({ page: undefined })} />
    </PageShell>
  );
}
