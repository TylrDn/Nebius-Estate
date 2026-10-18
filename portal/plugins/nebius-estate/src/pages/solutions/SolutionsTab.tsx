import { useEffect, useMemo, useRef, useState } from 'react';
import type { FilterOptions, LivePriceResponse, RecipeProof, SolutionsResponse, SolutionView } from '@internal/nebius-domain';
import { proofSummary } from '@internal/nebius-domain';
import { Badge, Callout, Card, EmptyState, Field, Icon, KeyValue, useBackend, useGet, useMeta } from '../../ui';
import { LivePricePanel } from '../pricing/LivePricePanel';
import { failureState, LivePriceState } from '../pricing/livePrice';
import { footprintLabel, PriceRequest, priceRequests, priceRowLabel, PROOF_TONE, usdText } from './model';

const NEEDED = ['nebius.commercial.scenario.read', 'nebius.commercial.rate.read'];
/** The price card's footer: what the file is and where the dated cost model is, with no date of its own (G5.13). */
export const SOLUTION_PRICE_FOOTER = 'This footprint file, read from this checkout, is what recipes/finance/price.py prices. Read opens the solution README with its dated cost model.';
/** The price panel the "Price this footprint" buttons disclose. */
const PRICE_PANEL = 'solution-price-panel';

/**
 * Live prices for a solution footprint: one POST /pricing/footprint per capacity type (the same
 * calculator flow as Provisioning and Commercial). Replies to an earlier footprint are dropped.
 */
function useSolutionPrices(requests: PriceRequest[], allowed: boolean | undefined): { states: Record<string, LivePriceState>; reload: () => void } {
  const call = useBackend();
  const [states, setStates] = useState<Record<string, LivePriceState>>({});
  const [tick, setTick] = useState(0);
  const seq = useRef(0);
  const key = JSON.stringify(requests.map(r => r.body));

  useEffect(() => {
    const mine = ++seq.current;
    const reqs = JSON.parse(key) as PriceRequest['body'][];
    if (allowed === false) {
      const message = `Live prices need ${NEEDED.join(' and ')} (portal permissions).`;
      setStates(Object.fromEntries(reqs.map(b => [b.capacityType, { status: 'denied', message } as LivePriceState])));
      return;
    }
    if (allowed === undefined) {
      setStates(Object.fromEntries(reqs.map(b => [b.capacityType, { status: 'loading' } as LivePriceState])));
      return;
    }
    setStates(Object.fromEntries(reqs.map(b => [b.capacityType, { status: 'loading' } as LivePriceState])));
    for (const body of reqs) {
      call<LivePriceResponse>('/pricing/footprint', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        .then(response => mine === seq.current && setStates(s => ({ ...s, [body.capacityType]: { status: 'ready', response } })))
        .catch(e => mine === seq.current && setStates(s => ({ ...s, [body.capacityType]: failureState(e) })));
    }
  }, [key, call, allowed, tick]);

  return { states, reload: () => setTick(t => t + 1) };
}

/** "Price this footprint": the solution's footprint files through the Nebius billing calculator. */
function PriceFootprint({ s, onClose }: { s: SolutionView; onClose: () => void }) {
  const meta = useMeta();
  const priceable = s.footprints.filter(f => f.footprint);
  const [path, setPath] = useState(priceable[0]?.path);
  const fp = priceable.find(f => f.path === path) ?? priceable[0];
  const requests = useMemo(() => (fp ? priceRequests(fp) : []), [fp]);
  const allowed = meta.data ? NEEDED.every(p => meta.data!.permissions[p]) : undefined;
  const live = useSolutionPrices(requests, allowed);
  // "priced in project <name>", as on Provisioning and Commercial (G5.13), never the raw id.
  const filters = useGet<FilterOptions>('/filters');
  const projectName = (id: string) => filters.data?.projects.find(p => p.id === id)?.name ?? id;
  return (
    <Card
      title={`Price this footprint · ${s.id} ${s.scenario}`}
      icon="commercial"
      actions={
        <button type="button" className="ne-btn ne-btn-sm" onClick={onClose} aria-label="Close the price panel">
          <Icon name="close" size={13} /> Close
        </button>
      }
      footer={SOLUTION_PRICE_FOOTER}
    >
      <div className="ne-stack" style={{ gap: 12 }}>
        {priceable.length > 1 ? (
          <Field label="Footprint file" htmlFor="sol-fp">
            <select id="sol-fp" className="ne-select" value={fp?.path} onChange={e => setPath(e.target.value)}>
              {priceable.map(f => (
                <option key={f.path} value={f.path}>
                  {footprintLabel(f)}
                </option>
              ))}
            </select>
          </Field>
        ) : fp ? (
          <p className="ne-muted" style={{ margin: 0, fontSize: '0.78125rem' }}>
            <span className="ne-mono">{footprintLabel(fp)}</span>
          </p>
        ) : null}
        {s.footprints.filter(f => f.error).map(f => (
          <Callout key={f.path} tone="warn" title={`${f.path.split('/').pop()} could not be read`}>
            {f.error}
          </Callout>
        ))}
        {fp ? (
          <>
            {fp.notes.length ? (
              <ul className="ne-muted" style={{ margin: 0, paddingLeft: 18, fontSize: '0.78125rem' }}>
                {fp.notes.map(n => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            ) : null}
            <LivePricePanel id={`solution-price-${s.id}`} projectName={projectName} onRetry={live.reload} rows={requests.map(r => {
                const state: LivePriceState = live.states[r.key] ?? { status: 'loading' };
                return { key: r.key, label: priceRowLabel(r, state), state, runHours: r.runHours, lineHours: r.lineHours };
              })} />
          </>
        ) : (
          <EmptyState title="No footprint to price" icon="commercial">
            This solution has no readable footprint file in the checkout.
          </EmptyState>
        )}
      </div>
    </Card>
  );
}

/**
 * A solution's proof, computed from the evidence index (W1-P11, W1-P13): the derived status line, then one chip per
 * composed recipe with its level and the date of its newest live evidence file (which opens), or "Not measured".
 */
function ProofChips({ proof, openDoc }: { proof: RecipeProof[]; openDoc: (p: string) => void }) {
  const summary = proofSummary(proof);
  return (
    <div className="ne-stack" style={{ gap: 4 }}>
      <Badge tone={summary.tone} wrap title="Computed from docs/evidence/: each composed recipe's strongest live evidence">
        {summary.text}
      </Badge>
      <ul className="ne-proof-chips">
        {proof.map(p => (
          <li key={p.recipe}>
            <span className="ne-mono">{p.recipe}</span>{' '}
            <Badge tone={PROOF_TONE[p.level]}>{p.level}</Badge>{' '}
            {p.path && p.lastLive ? (
              <button type="button" className="ne-btn ne-btn-sm ne-btn-ghost" onClick={() => openDoc(p.path!)} aria-label={`last live ${p.lastLive}, read ${p.path}`} title={p.title}>
                last live {p.lastLive}
              </button>
            ) : (
              <span className="ne-faint">Not measured</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** README proof rows the evidence index contradicts (W1-P12): what the row says, and what the evidence has. */
function ProofDriftBanner({ s }: { s: SolutionView }) {
  if (!s.proofDrift.length) return null;
  return (
    <div style={{ marginBottom: 10 }}>
      <Callout tone="warn" title="README proof rows disagree with the evidence index">
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          {s.proofDrift.map(d => (
            <li key={`${d.claim.where}-${d.recipe}`}>
              {d.claim.where} says {d.recipe} {d.says}; the evidence index has {d.proof.level}
              {d.proof.lastLive ? ` ${d.proof.lastLive}` : ''}
              {d.proof.path ? ` (${d.proof.path.split('/').pop()})` : ''}.
            </li>
          ))}
        </ul>
      </Callout>
    </div>
  );
}

/** Solutions S1–S9 (solutions/README.md) on the Solutions page: scenario, composed recipes, status, Read and Price this footprint. */
export function SolutionsTab({
  data,
  openDoc,
  price,
  setPrice,
  recipeTitles,
}: {
  data: SolutionsResponse;
  openDoc: (p: string) => void;
  price?: string;
  setPrice: (id?: string) => void;
  /** Recipe id -> title ("R7" -> "Network"), shown as the recipe button's tooltip. */
  recipeTitles?: Record<string, string>;
}) {
  const priced = data.items.find(s => s.id === price);
  // Price opened by a click on a card (often far below the panel, F1.23 review): the panel comes on screen and its
  // heading takes focus. A panel opened from the link leaves the page where it is.
  const reveal = useRef(false);
  useEffect(() => {
    if (!reveal.current || !priced) return;
    reveal.current = false;
    const panel = document.getElementById(PRICE_PANEL);
    const heading = panel?.querySelector<HTMLElement>('.ne-card-title');
    if (heading) {
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    }
    panel?.scrollIntoView({ block: 'start' });
  }, [priced]);
  if (data.unavailableReason) {
    return (
      <Card>
        <EmptyState title="No solutions in this checkout" icon="doc">
          {data.unavailableReason}
        </EmptyState>
      </Card>
    );
  }
  return (
    <div className="ne-stack" style={{ gap: 14 }}>
      <p className="ne-muted" style={{ margin: 0, fontSize: '0.78125rem' }}>
        Prices in the READMEs are dated estimates, not quotes; &ldquo;Price this footprint&rdquo; asks the Nebius billing calculator now.
      </p>
      {price && !priced ? (
        <Callout tone="warn" title="Not applied from the link">
          Unknown solution &ldquo;{price}&rdquo;.
        </Callout>
      ) : null}
      {priced ? (
        <div id={PRICE_PANEL}>
          <PriceFootprint key={priced.id} s={priced} onClose={() => setPrice(undefined)} />
        </div>
      ) : null}
      <div className="ne-grid ne-grid-2">
        {data.items.map(s => (
          // Every card alike (F1.23): the title alone in the header; Price and Read in one row at the foot of the body.
          <Card key={s.id} className="ne-sol-card" title={`${s.id} · ${s.scenario}`} icon="evidence" footer={<span className="ne-mono">{s.dir}</span>}>
            <ProofDriftBanner s={s} />
            <KeyValue
              items={[
                [
                  'Recipes',
                  <span className="ne-row" style={{ gap: 2, flexWrap: 'wrap' }}>
                    {s.recipes.map(r => (
                      <button key={r.id} type="button" className="ne-btn ne-btn-sm ne-btn-ghost" onClick={() => openDoc(r.docs)} aria-label={`Read recipe ${r.id}: ${r.docs}`} title={recipeTitles?.[r.id] ? `${r.id} · ${recipeTitles[r.id]}` : undefined}>
                        {r.id}
                      </button>
                    ))}
                  </span>,
                ],
                ['Worked example', s.workedExample],
                ['Estimate (README)', usdText(s.headline)],
                // Derived from the evidence index, never hand-written (W1-P11).
                ['Recipe proof (evidence)', <ProofChips proof={s.proof} openDoc={openDoc} />],
                // The README's own words, labelled as such: a status line, not an alarm (neutral). It is the whole
                // solution's, so "not deployed" does not read against the recipes above that ran live.
                ['Solution status (README)', <Badge tone="neutral" wrap title="The solution as a whole, as written in solutions/README.md; the recipe proof above is computed from docs/evidence/">{s.status}</Badge>],
              ]}
            />
            <div className="ne-row ne-sol-actions">
              {s.footprints.some(f => f.footprint) ? (
                <button
                  type="button"
                  className="ne-btn ne-btn-sm"
                  onClick={() => {
                    reveal.current = price !== s.id;
                    setPrice(price === s.id ? undefined : s.id);
                  }}
                  aria-label={`Price this footprint: ${s.id}`}
                  aria-expanded={price === s.id}
                  aria-controls={price === s.id ? PRICE_PANEL : undefined}
                >
                  <Icon name="commercial" size={13} /> Price this footprint
                </button>
              ) : null}
              {s.readmeAvailable ? (
                <button type="button" className="ne-btn ne-btn-sm" onClick={() => openDoc(s.readme)} aria-label={`Read ${s.readme}`}>
                  <Icon name="doc" size={13} /> Read
                </button>
              ) : (
                <Badge tone="neutral" title={`${s.readme} is not in this checkout yet`}>
                  README pending
                </Badge>
              )}
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
