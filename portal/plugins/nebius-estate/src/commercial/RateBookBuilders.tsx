import { useMemo, useRef, useState } from 'react';
import type { RateBook, RecipesResponse } from '@internal/nebius-domain';
import { describeUnit, rateBookFromCsv } from '@internal/nebius-domain';
import { Badge, Callout, Card, DataTable, Field, Icon, useBackend, useDownload, useGet, useMeta } from '../ui';

/** A book about to be saved, with what could not go in and why (W1-P7: preview and validate before commit). */
export interface PendingBook {
  book?: RateBook;
  /** Rows or specs left out (the book is still saved without them). */
  skipped: string[];
  /** Rows that are wrong: nothing is saved until they are fixed. */
  errors: string[];
  origin: string;
}

const today = () => new Date().toISOString().slice(0, 10);

/**
 * The preview of a rate book before it is stored: what it holds, what it leaves out, and Save / Discard. Nothing is
 * written until Save, and a book with wrong rows has no Save.
 */
export function BookPreview({ pending, exists, onSaved, onDiscard }: { pending: PendingBook; exists: boolean; onSaved: (b: RateBook) => void; onDiscard: () => void }) {
  const call = useBackend();
  const [err, setErr] = useState<string>();
  const b = pending.book;
  const save = async () => {
    if (!b) return;
    setErr(undefined);
    try {
      await call(`/ratebooks/${encodeURIComponent(b.id)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
      onSaved(b);
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <Card
      title={b ? `Preview: ${b.name} · ${b.entries.length} rates · ${b.currency}` : 'Preview: not a valid rate book'}
      icon="table"
      flush
      actions={
        <div className="ne-row">
          {b && !pending.errors.length ? (
            <button type="button" className="ne-btn ne-btn-sm" onClick={save}>
              {exists ? `Replace rate book ${b.id}` : 'Save rate book'}
            </button>
          ) : null}
          <button type="button" className="ne-btn ne-btn-sm ne-btn-ghost" onClick={onDiscard}>
            Discard
          </button>
        </div>
      }
      footer={`${pending.origin}. Nothing is stored until it is saved; a rate book stays in the portal database, never in the repository.`}
    >
      <div className="ne-stack" style={{ padding: 12, gap: 8 }} data-testid="book-preview">
        {pending.errors.length ? (
          <Callout tone="danger" title={`Not saved: ${pending.errors.length} problem${pending.errors.length === 1 ? '' : 's'}`}>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {pending.errors.slice(0, 20).map(e => (
                <li key={e}>{e}</li>
              ))}
              {pending.errors.length > 20 ? <li>… {pending.errors.length - 20} more</li> : null}
            </ul>
          </Callout>
        ) : null}
        {pending.skipped.length ? (
          <Callout tone="warn" title={`${pending.skipped.length} left out`}>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {pending.skipped.map(e => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          </Callout>
        ) : null}
        {b ? (
          <div className="ne-row">
            <Badge tone={b.classification === 'confidential' ? 'danger' : 'info'}>{b.classification}</Badge>
            <Badge tone="neutral">{b.kind}</Badge>
            {exists ? <Badge tone="warn">replaces the stored book with this id</Badge> : null}
          </div>
        ) : null}
        {err ? <Callout tone="danger">{err}</Callout> : null}
      </div>
      {b?.entries.length ? (
        <DataTable
          caption="Rates in the preview"
          compact
          rows={b.entries}
          rowKey={r => r.id}
          maxHeight={360}
          columns={[
            { key: 'r', header: 'Region', render: r => r.region },
            { key: 'c', header: 'Component', render: r => `${r.component}${r.bundles.length ? ` (bundles ${r.bundles.join(', ')})` : ''}` },
            { key: 'p', header: 'Platform · preset', render: r => <span className="ne-mono">{r.platform ?? 'any'}{r.preset ? ` · ${r.preset}` : ''}</span> },
            { key: 'cap', header: 'Capacity', render: r => r.capacityType },
            { key: 'price', header: 'Price', align: 'right', render: r => `${r.price} ${r.currency} ${describeUnit(r.unit)}` },
          ]}
        />
      ) : null}
    </Card>
  );
}

/**
 * Build a rate book from current list prices (W1-P7): pick regions (and optionally platforms) from
 * platform/regions.yaml; the billing calculator prices their presets and the storage specs now.
 */
export function ListPriceBuilder({ canWrite, onPreview }: { canWrite: boolean; onPreview: (p: PendingBook) => void }) {
  const call = useBackend();
  const meta = useMeta();
  const recipes = useGet<RecipesResponse>(meta.data?.permissions['nebius.provisioning.preview'] ? '/provisioning/recipes' : null);
  const regions = useMemo(() => recipes.data?.regions ?? [], [recipes.data]);
  const [picked, setPicked] = useState<string[]>([]);
  const [platforms, setPlatforms] = useState<string[]>([]);
  const [name, setName] = useState(`Nebius list prices ${today()}`);
  const [id, setId] = useState(`list-${today()}`);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const offered = useMemo(() => [...new Set(regions.filter(r => picked.includes(r.id)).flatMap(r => r.platforms.map(p => p.id)))].sort(), [regions, picked]);
  const build = async () => {
    setErr(undefined);
    setBusy(true);
    try {
      const r = await call<{ book: RateBook; skipped: string[] }>('/ratebooks/from-list-prices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, name, regions: picked, ...(platforms.length ? { platforms: platforms.filter(p => offered.includes(p)) } : {}) }),
      });
      onPreview({ book: r.book, skipped: r.skipped, errors: [], origin: `Priced now by the Nebius billing calculator (list price) for ${picked.join(', ')}` });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const toggle = (xs: string[], x: string) => (xs.includes(x) ? xs.filter(y => y !== x) : [...xs, x]);
  return (
    <Card title="Build from current list prices" icon="commercial" footer="Each preset of platform/regions.yaml in the chosen regions, on-demand and preemptible, and the disk and filesystem types, priced by the billing calculator in a listed project of each region. A preview first; nothing is stored until it is saved.">
      <div className="ne-stack" style={{ gap: 10 }}>
        <div className="ne-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12 }}>
          <Field label="Rate book name" htmlFor="lp-name">
            <input id="lp-name" className="ne-input" value={name} maxLength={120} onChange={e => setName(e.target.value)} />
          </Field>
          <Field label="Rate book id" htmlFor="lp-id" hint="Lowercase letters, digits and dashes">
            <input id="lp-id" className="ne-input" value={id} maxLength={63} onChange={e => setId(e.target.value.toLowerCase())} />
          </Field>
        </div>
        <fieldset className="ne-field ne-checklist">
          <legend>Regions</legend>
          {regions.length ? (
            regions.map(r => (
              <label key={r.id} className="ne-row">
                <input type="checkbox" checked={picked.includes(r.id)} onChange={() => setPicked(xs => toggle(xs, r.id))} />
                {r.id}
              </label>
            ))
          ) : (
            <span className="ne-faint">{recipes.loading ? 'Reading platform/regions.yaml…' : 'platform/regions.yaml is not readable with your permissions.'}</span>
          )}
        </fieldset>
        {offered.length ? (
          <fieldset className="ne-field ne-checklist">
            <legend>Platforms (none ticked: all of them)</legend>
            {offered.map(p => (
              <label key={p} className="ne-row">
                <input type="checkbox" checked={platforms.includes(p)} onChange={() => setPlatforms(xs => toggle(xs, p))} />
                <span className="ne-mono">{p}</span>
              </label>
            ))}
          </fieldset>
        ) : null}
        {err ? <Callout tone="danger">{err}</Callout> : null}
        <div>
          <button type="button" className="ne-btn" disabled={!canWrite || !picked.length || busy} title={!canWrite ? 'Requires nebius.commercial.rate.write' : !picked.length ? 'Pick at least one region' : undefined} onClick={build}>
            {busy ? 'Pricing…' : 'Price now and preview'}
          </button>
        </div>
      </div>
    </Card>
  );
}

/** A rate book from a CSV on the downloadable template (W1-P7), checked here and previewed before it is saved. */
export function CsvImport({ canWrite, onPreview }: { canWrite: boolean; onPreview: (p: PendingBook) => void }) {
  const { download, error } = useDownload();
  const file = useRef<HTMLInputElement>(null);
  const [m, setM] = useState({ id: '', name: '', kind: 'negotiated' as RateBook['kind'], classification: 'confidential' as RateBook['classification'], currency: 'USD' });
  const ready = /^[a-z0-9][a-z0-9-]{1,62}$/.test(m.id) && m.name.trim() && /^[A-Z]{3}$/.test(m.currency);
  const read = async (f: File) => {
    const r = rateBookFromCsv(await f.text(), { ...m, name: m.name.trim() });
    onPreview({ book: r.book, skipped: [], errors: r.errors, origin: `CSV ${f.name}, ${r.rows} row${r.rows === 1 ? '' : 's'}` });
  };
  return (
    <Card
      title="Import a CSV"
      icon="download"
      actions={
        <button type="button" className="ne-btn ne-btn-sm ne-btn-ghost" onClick={() => download('/ratebooks/template.csv', 'rate-book-template.csv', 'text/csv')}>
          <Icon name="download" size={13} /> CSV template
        </button>
      }
      footer="One rate per row, in the template's columns. Every wrong row and field is named, and nothing is saved while any is wrong."
    >
      <div className="ne-stack" style={{ gap: 10 }}>
        {error ? <Callout tone="danger">{error}</Callout> : null}
        <div className="ne-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: 12 }}>
          <Field label="Rate book name" htmlFor="csv-name">
            <input id="csv-name" className="ne-input" value={m.name} maxLength={120} onChange={e => setM({ ...m, name: e.target.value })} />
          </Field>
          <Field label="Rate book id" htmlFor="csv-id" hint="Lowercase letters, digits and dashes">
            <input id="csv-id" className="ne-input" value={m.id} maxLength={63} onChange={e => setM({ ...m, id: e.target.value.toLowerCase() })} />
          </Field>
          <Field label="Kind" htmlFor="csv-kind">
            <select id="csv-kind" className="ne-select" value={m.kind} onChange={e => setM({ ...m, kind: e.target.value as RateBook['kind'] })}>
              <option value="negotiated">negotiated</option>
              <option value="public-list">public-list</option>
            </select>
          </Field>
          <Field label="Classification" htmlFor="csv-class">
            <select id="csv-class" className="ne-select" value={m.classification} onChange={e => setM({ ...m, classification: e.target.value as RateBook['classification'] })}>
              <option value="confidential">confidential</option>
              <option value="public">public</option>
            </select>
          </Field>
          <Field label="Currency" htmlFor="csv-currency">
            <input id="csv-currency" className="ne-input" value={m.currency} maxLength={3} onChange={e => setM({ ...m, currency: e.target.value.toUpperCase() })} />
          </Field>
        </div>
        <input
          ref={file}
          type="file"
          accept=".csv,text/csv"
          hidden
          aria-label="Rate book CSV file"
          onChange={e => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) read(f);
          }}
        />
        <div>
          <button type="button" className="ne-btn" disabled={!canWrite || !ready} title={!canWrite ? 'Requires nebius.commercial.rate.write' : !ready ? 'Name, id and a three-letter currency first' : undefined} onClick={() => file.current?.click()}>
            <Icon name="plus" size={14} /> Choose CSV and preview
          </button>
        </div>
      </div>
    </Card>
  );
}
