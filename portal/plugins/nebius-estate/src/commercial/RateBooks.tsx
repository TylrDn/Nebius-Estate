import { useEffect, useMemo, useRef, useState } from 'react';
import type { ListResponse, RateBook, RateBookChoice, RateBookSummary } from '@internal/nebius-domain';
import { describeUnit, rateBookSchema } from '@internal/nebius-domain';
import { Async, Badge, Callout, Card, DataTable, EmptyState, Icon, useBackend, useGet, useMeta } from '../ui';
import { BookPreview, CsvImport, ListPriceBuilder, PendingBook } from './RateBookBuilders';

/** Rate books: imported as schema-validated JSON, stored in the portal database only. */
export function RateBooks() {
  const books = useGet<ListResponse<RateBookSummary> & { runRateBook?: RateBookChoice }>('/ratebooks');
  const meta = useMeta();
  const call = useBackend();
  const [sel, setSel] = useState<string>();
  const detail = useGet<RateBook>(sel ? `/ratebooks/${encodeURIComponent(sel)}` : null);
  const [msg, setMsg] = useState<{ tone: 'info' | 'danger'; text: string }>();
  // A two-step delete, as for budgets: the first click arms it, the second deletes (G4.5).
  const [armed, setArmed] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const canWrite = meta.data?.permissions['nebius.commercial.rate.write'];
  // Built from list prices or a CSV: previewed here, stored only on Save (W1-P7). The builders mount when opened.
  const [pending, setPending] = useState<PendingBook>();
  const [building, setBuilding] = useState(false);
  useEffect(() => {
    if (!sel && books.data?.items[0]) setSel(books.data.items[0].id);
  }, [books.data, sel]);

  const importFile = async (f: File) => {
    try {
      const parsed = rateBookSchema.safeParse(JSON.parse(await f.text()));
      if (!parsed.success) throw new Error(parsed.error.issues.slice(0, 5).map(i => `${i.path.join('.')}: ${i.message}`).join('; '));
      await call(`/ratebooks/${encodeURIComponent(parsed.data.id)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parsed.data) });
      setMsg({ tone: 'info', text: `Imported rate book ${parsed.data.name} (${parsed.data.entries.length} rates, ${parsed.data.classification}).` });
      books.reload();
      setSel(parsed.data.id);
    } catch (e) {
      setMsg({ tone: 'danger', text: (e as Error).message });
    }
  };

  /** Archive / restore and the portal default (W1-P8): audited writes; the server refuses what would break a default. */
  const lifecycle = async (b: RateBookSummary, action: 'archive' | 'restore' | 'default' | 'undefault') => {
    try {
      if (action === 'archive' || action === 'restore') {
        await call(`/ratebooks/${encodeURIComponent(b.id)}/archive`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ archived: action === 'archive' }) });
      } else {
        await call(`/ratebooks/${encodeURIComponent(b.id)}/default`, { method: action === 'default' ? 'POST' : 'DELETE' });
      }
      setMsg({ tone: 'info', text: { archive: `Archived rate book ${b.name}: it keeps pricing its scenarios, and is no longer a default or offered for a new scenario.`, restore: `Restored rate book ${b.name}.`, default: `${b.name} is the portal default rate book.`, undefault: `${b.name} is no longer the portal default.` }[action] });
      books.reload();
    } catch (e) {
      setMsg({ tone: 'danger', text: (e as Error).message });
    }
  };

  const remove = async (b: RateBookSummary) => {
    setArmed(false);
    try {
      await call(`/ratebooks/${encodeURIComponent(b.id)}`, { method: 'DELETE' });
      setMsg({ tone: 'info', text: `Deleted rate book ${b.name}.` });
      setSel(books.data?.items.find(x => x.id !== b.id)?.id);
      books.reload();
    } catch (e) {
      setMsg({ tone: 'danger', text: (e as Error).message });
    }
  };

  const entries = useMemo(() => detail.data?.entries ?? [], [detail.data]);
  return (
    <Async load={books} rows={5}>
      {d => (
        <div className="ne-stack" style={{ gap: 14 }}>
          <div className="ne-between">
            <div className="ne-row">
              <select className="ne-select" aria-label="Rate book" value={sel ?? ''} onChange={e => { setSel(e.target.value); setArmed(false); }}>
                {d.items.map(b => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                    {b.archived ? ' (archived)' : ''}
                  </option>
                ))}
              </select>
              <SelectedBadges book={d.items.find(b => b.id === sel)} runRate={d.runRateBook} />
              {d.items.some(b => b.id === sel) ? (
                <>
                  <Lifecycle book={d.items.find(b => b.id === sel)!} canWrite={Boolean(canWrite)} onAction={lifecycle} />
                  <DeleteBook book={d.items.find(b => b.id === sel)!} canWrite={Boolean(canWrite)} armed={armed} setArmed={setArmed} onDelete={remove} />
                </>
              ) : null}
            </div>
            <input ref={file} type="file" accept="application/json,.json" hidden onChange={e => {
              const f = e.target.files?.[0];
              e.target.value = ''; // the same file can be imported again
              if (f) importFile(f);
            }} />
            <button type="button" className="ne-btn ne-btn-sm" disabled={!canWrite} onClick={() => file.current?.click()} title={canWrite ? 'Schema-validated JSON (docs/portal/billing-and-pricing.md)' : 'Requires nebius.commercial.rate.write'}>
              <Icon name="plus" size={14} /> Import rate book JSON
            </button>
          </div>
          {msg ? <Callout tone={msg.tone}>{msg.text}</Callout> : null}
          <div className="ne-row">
            <button type="button" className="ne-btn ne-btn-sm ne-btn-ghost" aria-expanded={building} onClick={() => setBuilding(x => !x)}>
              {building ? 'Close the builders' : 'Build a rate book: from current list prices, or a CSV'}
            </button>
          </div>
          {building ? (
            <div className="ne-grid ne-grid-2">
              <ListPriceBuilder canWrite={Boolean(canWrite)} onPreview={setPending} />
              <CsvImport canWrite={Boolean(canWrite)} onPreview={setPending} />
            </div>
          ) : null}
          {pending ? (
            <BookPreview
              pending={pending}
              exists={Boolean(pending.book && d.items.some(b => b.id === pending.book!.id))}
              onDiscard={() => setPending(undefined)}
              onSaved={b => {
                setPending(undefined);
                setMsg({ tone: 'info', text: `Saved rate book ${b.name} (${b.entries.length} rates, ${b.classification}).` });
                books.reload();
                setSel(b.id);
              }}
            />
          ) : null}
          {d.runRateBook ? (
            // Which book prices the run-rate, and why: an imported what-if book never takes over unsaid (G4.5).
            <Callout tone={d.runRateBook.how === 'first-by-id' ? 'warn' : 'info'} title={`Run-rate book: ${d.runRateBook.name}`}>
              Prices the run-rate on the Overview and the provisioning estimates. {d.runRateBook.text}
            </Callout>
          ) : null}
          <Callout tone="info" title="Rate books stay in the portal database">
            They are never committed to the repository. Confidential books are visible only to callers with nebius.commercial.rate.read; edits need
            nebius.commercial.rate.write and are audited.
          </Callout>
          {d.items.length === 0 ? (
            <Card>
              <EmptyState title="No rate book yet" icon="commercial">
                Import a rate book JSON (schema: docs/portal/billing-and-pricing.md), build one from current list prices, or import a CSV on the
                template. Every rate carries its source and retrieval date; the portal never invents a price. Until one exists, scenarios are priced at
                the Nebius list price (live calculator) and the rate-book run-rate shows as unavailable.
              </EmptyState>
            </Card>
          ) : (
          <Async load={detail} rows={6}>
            {b => (
              <Card title={`${b.name} · ${b.entries.length} rates · ${b.currency}`} icon="table" flush footer={b.note}>
                <DataTable
                  caption="Rates"
                  compact
                  rows={entries}
                  rowKey={r => r.id}
                  maxHeight={520}
                  columns={[
                    { key: 'r', header: 'Region', sortValue: r => r.region, render: r => r.region },
                    { key: 'c', header: 'Component', sortValue: r => r.component, render: r => <span>{r.component}{r.bundles.length ? <span className="ne-faint"> (bundles {r.bundles.join(', ')})</span> : null}</span> },
                    { key: 'p', header: 'Platform · preset', render: r => <span className="ne-mono">{r.platform ?? 'any'}{r.preset ? ` · ${r.preset}` : ''}</span> },
                    { key: 'cap', header: 'Capacity', render: r => r.capacityType },
                    { key: 'price', header: 'Price', align: 'right', sortValue: r => Number(r.price), render: r => `${r.price} ${r.currency}` },
                    { key: 'u', header: 'Unit', render: r => <span className="ne-muted">{describeUnit(r.unit)}</span> },
                    { key: 'e', header: 'Effective', render: r => <span className={r.effectiveTo ? 'ne-faint' : undefined}>{r.effectiveFrom} → {r.effectiveTo ?? 'open'}</span> },
                    { key: 's', header: 'Source', render: r => <span className="ne-faint" style={{ fontSize: 'var(--ne-fs-caption)' }}>{r.source} · {r.retrievedAt.slice(0, 10)}{r.priceSemantics === 'variable' ? ' · variable' : ''}</span> },
                  ]}
                />
              </Card>
            )}
          </Async>
          )}
        </div>
      )}
    </Async>
  );
}

function SelectedBadges({ book, runRate }: { book?: RateBookSummary; runRate?: RateBookChoice }) {
  if (!book) return null;
  return (
    <>
      <Badge tone={book.classification === 'confidential' ? 'danger' : 'info'}>{book.classification}</Badge>
      <Badge tone="neutral">{book.kind}</Badge>
      {book.isDefault ? <Badge tone="ok">portal default</Badge> : null}
      {book.archived ? <Badge tone="warn">archived</Badge> : null}
      {runRate?.id === book.id ? <Badge tone={runRate.how === 'first-by-id' ? 'warn' : 'ok'} title={runRate.text}>run-rate book</Badge> : null}
    </>
  );
}

/** Set or unset the portal default, archive or restore (W1-P8). */
function Lifecycle({ book, canWrite, onAction }: { book: RateBookSummary; canWrite: boolean; onAction: (b: RateBookSummary, a: 'archive' | 'restore' | 'default' | 'undefault') => void }) {
  const title = canWrite ? undefined : 'Requires nebius.commercial.rate.write';
  return (
    <>
      {book.archived ? null : (
        <button type="button" className="ne-btn ne-btn-sm ne-btn-ghost" disabled={!canWrite} title={title} onClick={() => onAction(book, book.isDefault ? 'undefault' : 'default')}>
          {book.isDefault ? 'Unset portal default' : 'Set as portal default'}
        </button>
      )}
      <button type="button" className="ne-btn ne-btn-sm ne-btn-ghost" disabled={!canWrite} title={title} onClick={() => onAction(book, book.archived ? 'restore' : 'archive')} aria-label={`${book.archived ? 'Restore' : 'Archive'} rate book ${book.name}`}>
        {book.archived ? 'Restore' : 'Archive'}
      </button>
    </>
  );
}

/** Delete in two steps; the server refuses a book a scenario prices with, or the configured default, and says why. */
function DeleteBook({ book, canWrite, armed, setArmed, onDelete }: { book: RateBookSummary; canWrite: boolean; armed: boolean; setArmed: (v: boolean) => void; onDelete: (b: RateBookSummary) => void }) {
  if (armed) {
    return (
      <>
        <button type="button" className="ne-btn ne-btn-sm" onClick={() => onDelete(book)} aria-label={`Confirm: delete rate book ${book.name} from the portal`}>
          Delete
        </button>
        <button type="button" className="ne-btn ne-btn-sm ne-btn-ghost" onClick={() => setArmed(false)}>
          Keep
        </button>
      </>
    );
  }
  return (
    <button type="button" className="ne-btn ne-btn-sm ne-btn-ghost" disabled={!canWrite} title={canWrite ? undefined : 'Requires nebius.commercial.rate.write'} onClick={() => setArmed(true)} aria-label={`Delete rate book ${book.name}`}>
      Delete
    </button>
  );
}
