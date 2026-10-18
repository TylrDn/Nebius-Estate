import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import type { BuiltInPriceSource, Footprint, ListResponse, RateBook, RateBookSummary, RecipesResponse, Scenario, ScenarioChoices, ScenarioEstimate, ScenarioRecord } from '@internal/nebius-domain';
import { DRAFT_QUOTE_LABEL, LIVE_LIST_BOOK_ID, platformsWithoutRate, preferredPlatform, scenarioChoices } from '@internal/nebius-domain';
import { ApiError, Async, Callout, Card, EmptyState, Field, PageShell, Tabs, useBackend, useGet, useMeta } from '../ui';
import { EstimateView } from './EstimateView';
import { RateBooks } from './RateBooks';
import { footprintOrderIssues, NewScenarioInput, newScenario, STORAGE_ROWS, unknownTab, useUrlTab } from './scenarioDraft';

const TABS = ['scenarios', 'ratebooks'] as const;

export function CommercialPage() {
  // Kept in the URL (?tab=ratebooks), so a link opens the same tab.
  const [tab, setTab] = useUrlTab(TABS);
  const unknown = unknownTab(useLocation().search, TABS);
  return (
    <PageShell
      title="Commercial Scenarios"
      subtitle="Scenario planning and draft quotes from user-managed rate books or the built-in Nebius list price (live calculator), each rate with its source and retrieval date, beside the Nebius live price (billing calculator) for the same footprints. Nothing is invented: a price neither source has stays missing."
      filters={false}
    >
      <div style={{ marginBottom: 14 }}>
        <Callout tone="warn" title={DRAFT_QUOTE_LABEL}>
          Draft quotes are arithmetic on the selected price source (a rate book, or the list price the calculator returns now); the live price is what the Nebius billing calculator returns now. Neither reserves
          capacity, implies contract terms or reflects what was billed — see Costs for reported spend.
        </Callout>
      </div>
      {unknown ? (
        // Said, as on Evidence, instead of a silent fallback (#72).
        <div style={{ marginBottom: 12 }}>
          <Callout tone="warn" title="Not applied from the link">
            Unknown tab &ldquo;{unknown}&rdquo;; showing Scenarios &amp; draft quotes. Tabs: {TABS.join(', ')}.
          </Callout>
        </div>
      ) : null}
      <Tabs label="Commercial sections" value={tab} onChange={setTab} tabs={[{ id: 'scenarios', label: 'Scenarios & draft quotes' }, { id: 'ratebooks', label: 'Rate books' }]} />
      {tab === 'scenarios' ? <Scenarios onOpenRateBooks={() => setTab('ratebooks')} /> : <RateBooks />}
    </PageShell>
  );
}

/* ------------------------------------------------------------- scenarios */

/**
 * What a scenario form offers to pick (F1.17): the rate book's regions and compute platforms, with presets from
 * the rate book and platform/regions.yaml. Either source may be refused (permissions); the form then asks in words.
 */
function useScenarioChoices(rateBookId: string | undefined): ScenarioChoices & { ready: boolean; rated: boolean } {
  const meta = useMeta();
  // The built-in live price has no stored entries: its choices come from platform/regions.yaml (W1-P6).
  const book = useGet<RateBook>(rateBookId && rateBookId !== LIVE_LIST_BOOK_ID ? `/ratebooks/${encodeURIComponent(rateBookId)}` : null);
  const recipes = useGet<RecipesResponse>(meta.data?.permissions['nebius.provisioning.preview'] ? '/provisioning/recipes' : null);
  const choices = useMemo(() => scenarioChoices(book.data, recipes.data?.regions), [book.data, recipes.data]);
  // `rated`: the lists come from the rate book's own entries (not the region file), so "no rate here" is a fact.
  return { ...choices, ready: Boolean(book.data || book.error || rateBookId === LIVE_LIST_BOOK_ID), rated: Boolean(book.data?.entries.length) };
}

type BooksResponse = ListResponse<RateBookSummary> & { builtIn?: BuiltInPriceSource };

/**
 * What a scenario can be priced from (W1-P6): the imported rate books, then the built-in live list price when the
 * calculator is set up (the only choice while no book is imported). The built-in source has no entries: the calculator prices each estimate.
 */
export function priceSources(d: BooksResponse | undefined): RateBookSummary[] {
  const b = d?.builtIn;
  const live: RateBookSummary[] = b?.available
    ? [{ id: b.id, name: b.name, kind: 'public-list', classification: 'public', currency: b.currency, entries: 0, discountRules: [], archived: false, isDefault: false }]
    : [];
  // Imported books first (a negotiated or what-if book is the one chosen on purpose), the built-in source after them.
  return [...(d?.items ?? []), ...live];
}

function Scenarios({ onOpenRateBooks }: { onOpenRateBooks: () => void }) {
  const list = useGet<ListResponse<ScenarioRecord>>('/scenarios');
  const books = useGet<BooksResponse>('/ratebooks');
  const sources = priceSources(books.data);
  const [selected, setSelected] = useState<string>();
  const [draft, setDraft] = useState<ScenarioRecord>();
  const [creating, setCreating] = useState(false);
  const meta = useMeta();
  const canWrite = Boolean(meta.data?.permissions['nebius.commercial.scenario.write']);
  const [notice, setNotice] = useState<string>();
  const created = (id: string) => {
    setCreating(false);
    setSelected(id);
    list.reload();
  };
  // A save opens what was saved: after "Save as copy" the copy, so further edits change it, not the original (G4.8).
  const saved = (id: string, text: string) => {
    setNotice(text);
    setSelected(id);
    list.reload();
  };
  // After a delete, the next scenario in the list opens (G4.6).
  const deleted = (id: string, name: string) => {
    const items = list.data?.items ?? [];
    const rest = items.filter(x => x.id !== id);
    const next = rest[Math.min(Math.max(0, items.findIndex(x => x.id === id)), rest.length - 1)];
    setNotice(`Deleted scenario ${name}.`);
    setSelected(next?.id);
    list.reload();
  };
  const form = (cancellable: boolean) => (
    <NewScenarioPanel books={sources.filter(b => !b.archived)} canWrite={canWrite} onCreated={created} onCancel={cancellable ? () => setCreating(false) : undefined} onOpenRateBooks={onOpenRateBooks} liveReason={books.data?.builtIn?.available ? undefined : books.data?.builtIn?.reason} />
  );

  useEffect(() => {
    if (!list.data?.items.length) return;
    const pick = list.data.items.find(s => s.id === selected) ?? list.data.items[0];
    setSelected(pick.id);
    setDraft(structuredClone(pick));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list.data]);

  return (
    <Async load={list} rows={6}>
      {d =>
        d.items.length === 0 ? (
          <div className="ne-stack" style={{ gap: 14 }}>
            <Card>
              <EmptyState title="No scenarios yet" icon="commercial">
                {sources.length
                  ? 'Create one below: one node group to start; edit footprints, storage and discounts afterwards.'
                  : 'A scenario is priced from a rate book or the live list price: neither is available yet.'}
              </EmptyState>
            </Card>
            {books.loading && !books.data ? null : form(false)}
          </div>
        ) : (
          <div className="ne-stack" style={{ gap: 14 }}>
          {notice ? <Callout tone="info">{notice}</Callout> : null}
          {creating ? form(true) : null}
          <div className="ne-grid ne-grid-side">
            <Card
              title="Scenarios"
              icon="commercial"
              flush
              actions={
                <button type="button" className="ne-btn ne-btn-sm" disabled={!canWrite || creating} title={canWrite ? undefined : 'Requires nebius.commercial.scenario.write'} onClick={() => setCreating(true)}>
                  New scenario
                </button>
              }
            >
              <ul style={{ listStyle: 'none', margin: 0, padding: 6 }} aria-label="Scenarios">
                {d.items.map(s => (
                  <li key={s.id}>
                    <button
                      type="button"
                      aria-pressed={s.id === selected}
                      className="ne-btn ne-btn-ghost"
                      style={{ width: '100%', height: 'auto', padding: '8px 10px', justifyContent: 'flex-start', textAlign: 'left', whiteSpace: 'normal', background: s.id === selected ? 'var(--ne-accent-soft)' : undefined }}
                      onClick={() => {
                        setSelected(s.id);
                        setDraft(structuredClone(s));
                      }}
                    >
                      <div>
                        <div style={{ fontWeight: 600 }}>{s.name}</div>
                        <div className="ne-faint" style={{ fontSize: 'var(--ne-fs-caption)' }}>
                          {s.recipe} · {s.region} · {s.capacityType}
                        </div>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            </Card>
            {draft ? <ScenarioWorkspace key={draft.id} initial={draft} books={sources} onSaved={saved} onDeleted={deleted} /> : null}
          </div>
          </div>
        )
      }
    </Async>
  );
}

function ScenarioWorkspace({
  initial,
  books,
  onSaved,
  onDeleted,
}: {
  initial: ScenarioRecord;
  books: RateBookSummary[];
  onSaved: (id: string, text: string) => void;
  onDeleted: (id: string, name: string) => void;
}) {
  const call = useBackend();
  const meta = useMeta();
  const [s, setS] = useState<ScenarioRecord>(initial);
  const [est, setEst] = useState<ScenarioEstimate>();
  const [err, setErr] = useState<string>();
  const [saved, setSaved] = useState<string>();
  const [armed, setArmed] = useState(false);
  // Footprint rows out of order (G4.7): named on their fields, and nothing is saved until they are fixed.
  const order = footprintOrderIssues(s.footprints);
  const invalid = new Set(order.map(i => i.input));
  const book = books.find(b => b.id === s.rateBookId);
  const canWrite = meta.data?.permissions['nebius.commercial.scenario.write'];
  const choices = useScenarioChoices(s.rateBookId);
  // A saved region the rate book does not price stays selectable, said so (F1.17).
  const regionOptions = choices.regions.includes(s.region) || !s.region ? choices.regions : [s.region, ...choices.regions];
  // Regions where the scenario's platforms have no compute rate are marked, and the chosen one is explained (F1.17 review).
  const scenarioPlatforms = (['min', 'expected', 'max'] as const).flatMap(k => s.footprints[k].nodeGroups.map(g => g.platform));
  const unpriced = (region: string) => (choices.rated ? platformsWithoutRate(choices, region, scenarioPlatforms) : []);
  const unpricedHere = unpriced(s.region);
  const regionHint = !choices.regions.includes(s.region) && choices.ready
    ? 'The rate book has no rate in this region'
    : unpricedHere.length
      ? `No rate for ${unpricedHere.join(', ')} in ${s.region}: those node groups show as pricing gaps`
      : undefined;

  useEffect(() => {
    const t = setTimeout(() => {
      const { createdBy, updatedAt, ...body } = s;
      call<ScenarioEstimate>('/estimate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        .then(e => {
          setEst(e);
          setErr(undefined);
        })
        .catch((e: Error) => setErr(e instanceof ApiError && e.permissionDenied ? `${e.message}.` : e.message));
    }, 250);
    return () => clearTimeout(t);
  }, [s, call]);

  const save = async (asNew: boolean) => {
    const { createdBy, updatedAt, ...body } = s;
    try {
      const r = asNew
        ? await call<Scenario>('/scenarios', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, id: undefined, name: `${s.name} (copy)` }) })
        : await call<Scenario>(`/scenarios/${encodeURIComponent(s.id!)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      onSaved(r.id ?? s.id!, asNew ? `Saved ${r.name}; it is open below.` : `Saved ${r.name}.`);
    } catch (e) {
      setSaved((e as Error).message);
    }
  };
  const remove = async () => {
    setArmed(false);
    try {
      await call(`/scenarios/${encodeURIComponent(s.id!)}`, { method: 'DELETE' });
      onDeleted(s.id!, initial.name);
    } catch (e) {
      setSaved((e as Error).message);
    }
  };
  const saveTitle = !canWrite ? 'Requires nebius.commercial.scenario.write' : order.length ? `Fix the footprints first: ${order[0].text}` : undefined;

  const setFp = (k: 'min' | 'expected' | 'max', fp: Footprint) => setS(x => ({ ...x, footprints: { ...x.footprints, [k]: fp } }));
  const num = (v: string, min = 0) => Math.max(min, Number(v) || 0);

  return (
    <div className="ne-stack" style={{ gap: 14, minWidth: 0 }}>
      <Card
        title="Scenario inputs"
        icon="provision"
        actions={
          armed ? (
            <>
              <button type="button" className="ne-btn ne-btn-sm" onClick={remove} aria-label={`Confirm: delete scenario ${initial.name}`}>
                Delete
              </button>
              <button type="button" className="ne-btn ne-btn-sm ne-btn-ghost" onClick={() => setArmed(false)}>
                Keep
              </button>
            </>
          ) : (
            <>
              <button type="button" className="ne-btn ne-btn-sm" disabled={!canWrite || order.length > 0} onClick={() => save(false)} title={saveTitle}>
                Save
              </button>
              <button type="button" className="ne-btn ne-btn-sm" disabled={!canWrite || order.length > 0} onClick={() => save(true)} title={saveTitle}>
                Save as copy
              </button>
              <button type="button" className="ne-btn ne-btn-sm ne-btn-ghost" disabled={!canWrite} onClick={() => setArmed(true)} title={canWrite ? undefined : 'Requires nebius.commercial.scenario.write'} aria-label={`Delete scenario ${initial.name}`}>
                Delete
              </button>
            </>
          )
        }
        footer={saved}
      >
        <div className="ne-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: 12 }}>
          <Field label="Name" htmlFor="s-name">
            <input id="s-name" className="ne-input" value={s.name} onChange={e => setS({ ...s, name: e.target.value })} />
          </Field>
          <Field label="Rate book" htmlFor="s-book" hint={book ? `${book.kind} · ${book.classification}${book.archived ? ' · archived: still prices this scenario, not offered for new ones' : ''}` : books.length ? `Its rate book ${s.rateBookId} is gone: pick another` : 'No rate book imported (Rate books tab)'}>
            {/* Never a blank select (F1.17): a missing rate book is named, and with none imported there is nothing to pick. */}
            {books.length ? (
              <select id="s-book" className="ne-select" value={book ? s.rateBookId : ''} onChange={e => setS({ ...s, rateBookId: e.target.value, discountRuleIds: [] })}>
                {book ? null : <option value="" disabled>Rate book not found</option>}
                {/* Archived books stay listed only for the scenario that already uses one (W1-P8). */}
                {books.filter(b => !b.archived || b.id === s.rateBookId).map(b => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                    {b.archived ? ' (archived)' : ''}
                  </option>
                ))}
              </select>
            ) : (
              <input id="s-book" className="ne-input" value={s.rateBookId} readOnly aria-readonly="true" />
            )}
          </Field>
          <Field label="Currency" htmlFor="s-cur" hint="Must match the rate book; nothing is converted">
            <input id="s-cur" className="ne-input" value={s.currency} maxLength={3} onChange={e => setS({ ...s, currency: e.target.value.toUpperCase() })} />
          </Field>
          <Field label="Region" htmlFor="s-region" hint={regionHint}>
            <select id="s-region" className="ne-select" value={s.region} onChange={e => setS({ ...s, region: e.target.value })}>
              {regionOptions.map(r => {
                const gaps = choices.regions.includes(r) ? unpriced(r) : [];
                return (
                  <option key={r} value={r}>
                    {gaps.length ? `${r} · no rate for ${gaps.join(', ')}` : r}
                  </option>
                );
              })}
            </select>
          </Field>
          <Field label="Capacity type" htmlFor="s-cap">
            <select id="s-cap" className="ne-select" value={s.capacityType} onChange={e => setS({ ...s, capacityType: e.target.value as Scenario['capacityType'] })}>
              <option>on-demand</option>
              <option>reserved</option>
              <option>preemptible</option>
            </select>
          </Field>
          <Field label="Pricing date" htmlFor="s-asof">
            <input id="s-asof" className="ne-input" type="date" value={s.asOf} onChange={e => setS({ ...s, asOf: e.target.value })} />
          </Field>
          <Field label="Active hours" htmlFor="s-active">
            <input id="s-active" className="ne-input ne-num" type="number" min={0} value={s.runtime.activeHours} onChange={e => setS({ ...s, runtime: { ...s.runtime, activeHours: num(e.target.value) } })} />
          </Field>
          <Field label="Warm-up / teardown h" htmlFor="s-warm">
            <div className="ne-row" style={{ flexWrap: 'nowrap' }}>
              <input id="s-warm" aria-label="Warm-up hours" className="ne-input ne-num" style={{ width: '50%' }} type="number" min={0} step={0.25} value={s.runtime.warmupHours} onChange={e => setS({ ...s, runtime: { ...s.runtime, warmupHours: num(e.target.value) } })} />
              <input aria-label="Teardown hours" className="ne-input ne-num" style={{ width: '50%' }} type="number" min={0} step={0.25} value={s.runtime.teardownHours} onChange={e => setS({ ...s, runtime: { ...s.runtime, teardownHours: num(e.target.value) } })} />
            </div>
          </Field>
          <Field label="Monthly hours assumption" htmlFor="s-month" hint="730 = always on">
            <input id="s-month" className="ne-input ne-num" type="number" min={0} max={744} value={s.monthlyHours} onChange={e => setS({ ...s, monthlyHours: Math.min(744, num(e.target.value)) })} />
          </Field>
          <Field label="Customer margin %" htmlFor="s-margin" hint="Optional; produces a separate draft selling price">
            <input id="s-margin" className="ne-input ne-num" inputMode="decimal" value={s.marginPercent ?? ''} onChange={e => setS({ ...s, marginPercent: e.target.value.replace(/[^0-9.]/g, '') || undefined })} />
          </Field>
        </div>

        <h3 className="ne-section-title" style={{ marginTop: 16 }}>Footprints (node groups × count, storage)</h3>
        <div className="ne-table-wrap">
          <table className="ne-table ne-table-compact">
            <caption className="ne-sr-only">Footprints</caption>
            <thead>
              <tr>
                <th scope="col">Item</th>
                <th scope="col">Minimum</th>
                <th scope="col">Expected</th>
                <th scope="col">Maximum</th>
              </tr>
            </thead>
            <tbody>
              {s.footprints.expected.nodeGroups.map((g, gi) => (
                <tr key={g.name}>
                  <td>
                    <div style={{ fontWeight: 600 }}>{g.name}</div>
                    <div className="ne-mono ne-faint">
                      {g.platform} · {g.preset}
                    </div>
                  </td>
                  {(['min', 'expected', 'max'] as const).map(k => (
                    <td key={k}>
                      <input
                        aria-label={`${g.name} ${k} count`}
                        aria-invalid={invalid.has(`${g.name} ${k} count`) || undefined}
                        className="ne-input ne-num"
                        style={{ width: 80 }}
                        type="number"
                        min={0}
                        value={s.footprints[k].nodeGroups[gi]?.count ?? 0}
                        onChange={e => setFp(k, { ...s.footprints[k], nodeGroups: s.footprints[k].nodeGroups.map((x, i) => (i === gi ? { ...x, count: num(e.target.value) } : x)) })}
                      />
                    </td>
                  ))}
                </tr>
              ))}
              {STORAGE_ROWS.map(([f, label]) => (
                <tr key={f}>
                  <td>{label}</td>
                  {(['min', 'expected', 'max'] as const).map(k => (
                    <td key={k}>
                      <input aria-label={`${f} ${k}`} aria-invalid={invalid.has(`${f} ${k}`) || undefined} className="ne-input ne-num" style={{ width: 100 }} type="number" min={0} value={s.footprints[k][f] ?? 0} onChange={e => setFp(k, { ...s.footprints[k], [f]: num(e.target.value) })} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {order.length ? (
          <div style={{ marginTop: 10 }} role="status">
            <Callout tone="warn" title="Footprints out of order: not saved">
              {order.map(i => i.text).join('; ')}. Each row needs minimum ≤ expected ≤ maximum; the draft quote below prices the rows as entered.
            </Callout>
          </div>
        ) : null}

        {book?.discountRules.length ? (
          <>
            <h3 className="ne-section-title" style={{ marginTop: 16 }}>Discount assumptions (applied only to matching lines)</h3>
            <div className="ne-stack" style={{ gap: 6 }}>
              {book.discountRules.map(r => (
                <label key={r.id} className="ne-row" style={{ fontSize: '0.8125rem' }}>
                  <input
                    type="checkbox"
                    checked={s.discountRuleIds.includes(r.id)}
                    onChange={e => setS({ ...s, discountRuleIds: e.target.checked ? [...s.discountRuleIds, r.id] : s.discountRuleIds.filter(x => x !== r.id) })}
                  />
                  <span>
                    {r.description} — {r.percent} % on {[...(r.appliesTo.components ?? []), ...(r.appliesTo.platforms ?? []), ...(r.appliesTo.capacityTypes ?? [])].join(', ')}
                  </span>
                  <span className="ne-faint" style={{ fontSize: 'var(--ne-fs-caption)' }}>source: {r.source}</span>
                </label>
              ))}
            </div>
          </>
        ) : null}
      </Card>

      {err ? <Callout tone="danger" title="Estimate unavailable">{err}</Callout> : null}
      {est ? <EstimateView est={est} scenarioId={s.id} scenario={{ footprints: s.footprints, region: s.region, capacityType: s.capacityType }} /> : !err ? <Card><span className="ne-muted">Estimating…</span></Card> : null}
    </div>
  );
}

/* ---------------------------------------------------------- new scenario */

type NewScenarioProps = { books: RateBookSummary[]; canWrite: boolean; onCreated: (id: string) => void; onCancel?: () => void; onOpenRateBooks?: () => void; liveReason?: string };

/**
 * The New scenario panel: collapsed to one line, without Cancel, while no rate book exists (a scenario is
 * priced from one); the form once one does. Cancel only where it closes something (not in the empty state).
 */
export function NewScenarioPanel(props: NewScenarioProps) {
  if (!props.books.length) {
    // What comes first, and the way there (#49): no "create one below" above a form that cannot open.
    return (
      <Callout tone="info" title="New scenario">
        <p style={{ margin: 0 }}>A scenario is priced from a rate book, and none is imported yet.</p>
        {props.liveReason ? <p style={{ margin: '6px 0 0' }}>The Nebius list price (live calculator) is not available either: {props.liveReason}</p> : null}
        <p style={{ margin: '6px 0 0' }}>
          Import or build a rate book first.{' '}
          {props.onOpenRateBooks ? (
            <button type="button" className="ne-btn ne-btn-sm" onClick={props.onOpenRateBooks}>
              Open Rate books
            </button>
          ) : null}
        </p>
      </Callout>
    );
  }
  const onlyLive = props.books.every(b => b.id === LIVE_LIST_BOOK_ID);
  return (
    <>
      {onlyLive ? (
        // A scenario no longer waits for a rate book (W1-P6); negotiated rates are an import or a build away.
        <Callout tone="info" title="Priced at the Nebius list price">
          No rate book is imported: new scenarios are priced at the Nebius list price (live calculator).{' '}
          {props.onOpenRateBooks ? (
            <button type="button" className="ne-btn ne-btn-sm ne-btn-ghost" onClick={props.onOpenRateBooks}>
              Import or build a rate book
            </button>
          ) : null}
        </Callout>
      ) : null}
      <NewScenarioForm {...props} />
    </>
  );
}

function NewScenarioForm({ books, canWrite, onCreated, onCancel }: NewScenarioProps) {
  const call = useBackend();
  const [f, setF] = useState<NewScenarioInput>({ name: '', rateBookId: '', currency: '', region: '', capacityType: 'on-demand', activeHours: 24, platform: '', preset: '', count: 1, bootDiskGib: 200 });
  const [msg, setMsg] = useState<string>();
  const book = books.find(b => b.id === f.rateBookId) ?? books[0];
  const choices = useScenarioChoices(book?.id);
  // Picked from lists (F1.17): the first choice stands until another is picked, and a pick the next list lacks falls back to its first.
  const pick = (v: string, list: string[]) => (list.includes(v) ? v : list[0] ?? '');
  const region = pick(f.region, choices.regions);
  const platforms = region ? choices.platforms(region) : [];
  // Opens on a GPU platform with a preset picker, not on the first name alphabetically (cpu-d3, with no preset known).
  const platform = platforms.includes(f.platform) ? f.platform : preferredPlatform(choices, region);
  const presets = platform ? choices.presets(region, platform) : [];
  const preset = presets.length ? pick(f.preset, presets) : f.preset;
  // The built-in list price (W1-P6): choices from platform/regions.yaml, and no reserved rate (it would only ever be a pricing gap).
  const live = book?.id === LIVE_LIST_BOOK_ID;
  const capacityType = live && f.capacityType === 'reserved' ? 'on-demand' : f.capacityType;
  const picked: NewScenarioInput = { ...f, region, platform, preset, capacityType };
  const missing = (['name', 'region', 'platform', 'preset'] as const).filter(k => !picked[k].trim());
  const create = async () => {
    setMsg(undefined);
    try {
      const body = newScenario({ ...picked, rateBookId: book!.id, currency: book!.currency }, new Date().toISOString().slice(0, 10));
      const r = await call<Scenario>('/scenarios', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      onCreated(r.id!);
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  const set = <K extends keyof NewScenarioInput>(k: K, v: NewScenarioInput[K]) => setF(x => ({ ...x, [k]: v }));
  return (
    <Card
      title="New scenario"
      icon="plus"
      actions={onCancel ? <button type="button" className="ne-btn ne-btn-sm ne-btn-ghost" onClick={onCancel}>Cancel</button> : undefined}
      footer={msg ? <span style={{ color: 'var(--ne-danger)' }}>{msg}</span> : book?.id === LIVE_LIST_BOOK_ID ? 'Regions, platforms and presets from platform/regions.yaml, priced by the Nebius billing calculator at list price for each estimate; a preset it does not price shows as a missing rate, never as zero.' : 'Regions and platforms are the ones the chosen rate book prices; a preset it does not price shows as a missing rate, never as zero.'}
    >
      {!books.length ? (
        <Callout tone="info">Import or build a rate book first (Rate books tab): a scenario is priced from one.</Callout>
      ) : (
        <div className="ne-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: 12 }}>
          <Field label="Name" htmlFor="n-name">
            <input id="n-name" className="ne-input" value={f.name} maxLength={120} onChange={e => set('name', e.target.value)} />
          </Field>
          {/* Two columns wide, so "Nebius list price (live calculator)" is not cut in its select (Wave 1 verification). */}
          <div className="ne-grid-span2">
            <Field label="Rate book" htmlFor="n-book" hint={book ? `${book.currency} · ${book.kind}` : undefined}>
              <select id="n-book" className="ne-select" value={book?.id} onChange={e => set('rateBookId', e.target.value)}>
                {books.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </Field>
          </div>
          <Field label="Region" htmlFor="n-region" hint={book?.id === LIVE_LIST_BOOK_ID ? 'Regions in platform/regions.yaml' : choices.regions.length ? 'Regions the rate book prices' : choices.ready ? 'The rate book prices no region' : 'Reading the rate book…'}>
            <select id="n-region" className="ne-select" value={region} disabled={!choices.regions.length} onChange={e => setF(x => ({ ...x, region: e.target.value, platform: '', preset: '' }))}>
              {choices.regions.map(r => <option key={r}>{r}</option>)}
            </select>
          </Field>
          <Field label="Capacity type" htmlFor="n-cap" hint={live ? 'Reserved is a contract rate, not a list price: import or build a rate book for it' : undefined}>
            <select id="n-cap" className="ne-select" value={capacityType} onChange={e => set('capacityType', e.target.value as Scenario['capacityType'])}>
              <option>on-demand</option>
              <option disabled={live}>reserved</option>
              <option>preemptible</option>
            </select>
          </Field>
          <Field label="Platform" htmlFor="n-platform" hint={live ? `Platforms of platform/regions.yaml in ${region}` : platforms.length ? `With a GPU or vCPU rate in ${region}` : `No compute rate in ${region || 'this rate book'}`}>
            <select id="n-platform" className="ne-select" value={platform} disabled={!platforms.length} onChange={e => setF(x => ({ ...x, platform: e.target.value, preset: '' }))}>
              {platforms.map(p => <option key={p}>{p}</option>)}
            </select>
          </Field>
          {presets.length ? (
            <Field label="Preset" htmlFor="n-preset" hint={live ? 'From platform/regions.yaml' : 'From the rate book and platform/regions.yaml'}>
              <select id="n-preset" className="ne-select" value={preset} onChange={e => set('preset', e.target.value)}>
                {presets.map(p => <option key={p}>{p}</option>)}
              </select>
            </Field>
          ) : (
            <Field label="Preset" htmlFor="n-preset" hint={`No preset is known for ${platform || 'this platform'}: type it as the console shows it, e.g. 4vcpu-16gb`}>
              <input id="n-preset" className="ne-input" value={f.preset} maxLength={64} onChange={e => set('preset', e.target.value)} />
            </Field>
          )}
          <Field label="Nodes (expected)" htmlFor="n-count">
            <input id="n-count" className="ne-input ne-num" type="number" min={0} max={512} value={f.count} onChange={e => set('count', Math.max(0, Math.min(512, Math.round(Number(e.target.value) || 0))))} />
          </Field>
          <Field label="Active hours" htmlFor="n-hours">
            <input id="n-hours" className="ne-input ne-num" type="number" min={0} value={f.activeHours} onChange={e => set('activeHours', Math.max(0, Number(e.target.value) || 0))} />
          </Field>
          <div style={{ alignSelf: 'end' }}>
            <button type="button" className="ne-btn" disabled={!canWrite || missing.length > 0} title={!canWrite ? 'Requires nebius.commercial.scenario.write' : missing.length ? `Fill in: ${missing.join(', ')}` : undefined} onClick={create}>
              Create scenario
            </button>
          </div>
        </div>
      )}
    </Card>
  );
}
