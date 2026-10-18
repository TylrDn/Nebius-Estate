import { ReactNode, useState } from 'react';
import { Link } from 'react-router-dom';
import type { FootprintEstimate, ListResponse, Money, ScenarioEstimate, ScenarioRecord } from '@internal/nebius-domain';
import { DRAFT_QUOTE_LABEL, estimateHeadline, LIVE_LIST_BOOK_ID } from '@internal/nebius-domain';
import { Badge, Callout, Card, DataTable, fmtMoney, fmtNumber, fmtTime, Icon, StatusPill, useDownload, useGet, useProjectNames } from '../ui';
import { LivePricePanel, RATE_BOOK_LABEL } from '../pages/pricing/LivePricePanel';
import { fmtUnitRate } from './estimateModel';
import { FOOTPRINT_KEYS, FootprintPricingInput, useFootprintLivePrices } from '../pages/pricing/useFootprintLivePrices';

const LIVE_PRICE_PENDING = 'Nebius live price (billing calculator) not requested';
const BUILT_IN_LIST_LABEL = 'built-in Nebius list price (live calculator)';
const FOOTPRINT_LABELS = { min: 'minimum', expected: 'expected', max: 'maximum' } as const;

/**
 * The draft quote for one scenario estimate: figures, footprints, line items, sensitivity and coverage,
 * plus the same footprints at Nebius list price from the live billing calculator.
 * Pass `scenario` (the inputs being edited) so the live price follows edits; without it the saved
 * scenario `scenarioId` is priced and the panel says so.
 */
export function EstimateView({ est, scenarioId, scenario }: { est: ScenarioEstimate; scenarioId?: string; scenario?: FootprintPricingInput }) {
  const { download, error } = useDownload();
  const saved = useGet<ListResponse<ScenarioRecord>>(scenario || !scenarioId ? null : '/scenarios');
  const savedScenario = saved.data?.items.find(x => x.id === scenarioId);
  const pricing: FootprintPricingInput | undefined =
    scenario ?? (savedScenario ? { footprints: savedScenario.footprints, region: savedScenario.region, capacityType: savedScenario.capacityType } : undefined);
  const live = useFootprintLivePrices(pricing);
  // "priced in project nip-sandbox", as on Provisioning, not the raw id (G4.14).
  const names = useProjectNames();
  const exp = est.footprints.find(f => f.footprint === 'expected')!;
  const [fpView, setFpView] = useState<'min' | 'expected' | 'max'>('expected');
  const lines = est.footprints.find(f => f.footprint === fpView)!.lines;
  const kindLabel = est.rateBook.kind === 'public-list' ? 'Public list-rate estimate' : 'Negotiated-rate scenario';
  // The built-in live list price is no user rate book: nobody entered its rates, and it is not compared with itself (W1-P6).
  const builtIn = est.rateBook.id === LIVE_LIST_BOOK_ID;
  const noRateIn = builtIn ? 'no list price from the calculator' : 'no rate in this rate book';
  // No total built on an unpriced compute line, and every total names the lines it leaves out (W1-P9, #50).
  const head = estimateHeadline(exp);
  const incomplete = head.state === 'incomplete';
  const excludes = head.state === 'partial' ? ` · ${head.text}` : '';
  /** A footprint's money, or "incomplete" when one of its compute lines has no rate. */
  const total = (f: FootprintEstimate, x: Money, digits?: number) => (estimateHeadline(f).state === 'incomplete' ? 'incomplete' : fmtMoney(x, digits));
  return (
    <div className="ne-stack" style={{ gap: 14 }} id="draft-quote">
      <Card
        title="Draft quote"
        icon="commercial"
        actions={
          <div className="ne-row ne-no-print">
            {scenarioId ? (
              <>
                <button type="button" className="ne-btn ne-btn-sm" onClick={() => download(`/scenarios/${encodeURIComponent(scenarioId)}/quote.json`, `draft-quote-${scenarioId}.json`, 'application/json')}>
                  <Icon name="download" size={13} /> JSON
                </button>
                <button type="button" className="ne-btn ne-btn-sm" onClick={() => download(`/scenarios/${encodeURIComponent(scenarioId)}/quote.csv`, `draft-quote-${scenarioId}.csv`, 'text/csv')}>
                  <Icon name="download" size={13} /> CSV
                </button>
              </>
            ) : null}
            <button type="button" className="ne-btn ne-btn-sm" onClick={() => window.print()}>
              <Icon name="print" size={13} /> Print
            </button>
          </div>
        }
        footer={`Generated ${fmtTime(est.generatedAt)} · rates as of ${est.asOf} · valid until ${est.validUntil} · ${est.label}`}
      >
        {error ? <div style={{ marginBottom: 10 }}><Callout tone="danger">{error}</Callout></div> : null}
        <div className="ne-row" style={{ marginBottom: 10 }}>
          <Badge tone="warn" wrap>{DRAFT_QUOTE_LABEL}</Badge>
          <Badge tone={est.rateBook.kind === 'negotiated' ? 'info' : 'accent'}>{kindLabel}</Badge>
          <Badge wrap>{builtIn ? BUILT_IN_LIST_LABEL : `${est.rateBook.name} · ${RATE_BOOK_LABEL}`}</Badge>
          {est.coverage.complete ? <Badge tone="ok">all components priced</Badge> : <Badge tone="danger">{est.coverage.issues.length} pricing gap(s)</Badge>}
          {est.coverage.variablePriceComponents.length ? <Badge tone="warn">variable spot price</Badge> : null}
        </div>
        <div className="ne-grid ne-grid-tiles">
          {incomplete ? (
            <>
              <Figure label={kindLabel} value={head.text} tone="danger" sub={`no total: ${head.unpricedCompute} GPU, vCPU or RAM line${head.unpricedCompute === 1 ? ' has' : 's have'} ${noRateIn} · see Cost breakdown`} />
              <Figure label="Monthly scenario" value="—" sub="no total while a compute line is unpriced" />
              <Figure label="Cost floor (always-on)" value="—" sub="no total while a compute line is unpriced" />
            </>
          ) : (
            <>
              <Figure label={kindLabel} value={fmtMoney(exp.runPeriod)} sub={`expected footprint · ${exp.runHours} h · ${fmtMoney(exp.hourly)} / h${excludes}`} />
              <Figure label="Monthly scenario" value={fmtMoney(exp.monthly)} sub={`${exp.monthlyHours} h assumption${excludes}`} />
              <Figure label="Cost floor (always-on)" value={`${fmtMoney(exp.hourlyFloor)} / h`} sub={`workload-dependent ${fmtMoney(exp.hourlyWorkload)} / h${exp.commitmentHourly.amount !== '0' ? ` · commitments ${fmtMoney(exp.commitmentHourly)} / h` : ''}${excludes}`} />
            </>
          )}
          {est.sellingPrice ? (
            <Figure label="Customer-facing draft selling price" value={fmtMoney(est.sellingPrice.runPeriod)} sub={`margin ${est.sellingPrice.marginPercent} % · monthly ${fmtMoney(est.sellingPrice.monthly)}${excludes}`} />
          ) : est.sellingPriceWithheld ? (
            <Figure label="Customer-facing draft selling price" value="—" sub={`Not priced: ${est.sellingPriceWithheld.replace(/^Incomplete: /, '')}`} />
          ) : (
            <Figure label="Customer-facing draft selling price" value="—" sub="No margin entered" />
          )}
          <Figure label="Observed billed cost" value="—" sub={<Link to="/costs">Reported separately in Costs →</Link>} />
        </div>
        <h3 className="ne-section-title" style={{ marginTop: 16 }}>Footprints</h3>
        <DataTable
          caption="Footprint comparison"
          compact
          rows={est.footprints}
          rowKey={f => f.footprint}
          columns={[
            { key: 'f', header: 'Footprint', render: f => <strong>{f.footprint}</strong> },
            { key: 'g', header: 'GPUs · vCPU', align: 'right', render: f => `${f.gpus} · ${f.vcpus}` },
            { key: 'h', header: 'Hourly', align: 'right', render: f => total(f, f.hourly) },
            { key: 'fl', header: 'Floor / workload', align: 'right', render: f => (estimateHeadline(f).state === 'incomplete' ? 'incomplete' : `${fmtMoney(f.hourlyFloor)} / ${fmtMoney(f.hourlyWorkload)}`) },
            { key: 'r', header: `Run (${exp.runHours} h)`, align: 'right', render: f => total(f, f.runPeriod) },
            { key: 'm', header: 'Monthly', align: 'right', render: f => total(f, f.monthly) },
            { key: 'u', header: 'Unpriced lines', align: 'right', render: f => <UnpricedCell f={f} /> },
          ]}
        />
      </Card>

      {!scenario && scenarioId && !savedScenario ? (
        <Callout tone={saved.error ? 'warn' : 'info'} title={LIVE_PRICE_PENDING}>
          {saved.error ? `The saved scenario could not be loaded: ${saved.error.message}` : saved.loading ? 'Loading the saved scenario…' : 'This scenario is not saved yet; save it to price it live.'}
        </Callout>
      ) : null}
      {pricing ? (
        <div className="ne-stack" style={{ gap: 6 }}>
          {!scenario ? <p className="ne-faint" style={{ fontSize: 'var(--ne-fs-caption)', margin: 0 }}>Live prices follow the saved scenario; unsaved edits are not reflected until saved.</p> : null}
          <LivePricePanel
            id="live-list-price"
            rateBook={builtIn ? undefined : { name: est.rateBook.name, kind: est.rateBook.kind }}
            onRetry={live.reload}
            projectName={id => names(id) ?? id}
            rows={FOOTPRINT_KEYS.map(k => {
              const f = est.footprints.find(x => x.footprint === k);
              // An incomplete rate-book total is not compared with the live price (W1-P9).
              return { key: k, label: FOOTPRINT_LABELS[k], state: live.states[k], book: f && estimateHeadline(f).state !== 'incomplete' ? f.hourly : undefined, runHours: f?.runHours };
            })}
          />
        </div>
      ) : null}

      <Card title="Cost breakdown" icon="table" flush actions={<select className="ne-select" aria-label="Footprint" value={fpView} onChange={e => setFpView(e.target.value as typeof fpView)}><option value="min">minimum</option><option value="expected">expected</option><option value="max">maximum</option></select>}>
          <DataTable
            caption="Cost lines"
            compact
            rows={lines}
            rowKey={l => `${l.description}${l.component}`}
            // Four columns (#70): the basis sits with the line and the discount under the hourly figure, so a stacked
            // card on a phone is four short rows, not six.
            columns={[
              { key: 'd', header: 'Line', render: l => <div><div>{l.description} <Badge tone={l.basis === 'floor' ? 'neutral' : 'accent'}>{l.basis}</Badge></div>{l.note ? <div className="ne-faint" style={{ fontSize: 'var(--ne-fs-caption)' }}>{l.note}</div> : null}</div> },
              { key: 'r', header: 'Unit rate / h', align: 'right', render: l => (l.hourlyUnitRate ? fmtUnitRate(l.hourlyUnitRate, l.quantityUnit) : '—') },
              { key: 'h', header: 'Hourly', align: 'right', render: l => (l.hourly ? <div>{fmtMoney(l.hourly, 4)}{l.discount ? <div className="ne-faint" style={{ fontSize: 'var(--ne-fs-caption)' }}>discount {fmtMoney(l.discount.hourly, 4)} ({l.discount.percent} %)</div> : null}</div> : '—') },
              { key: 's', header: 'Status', render: l => <StatusPill state={l.status === 'priced' ? 'ok' : l.status === 'bundled' ? 'disabled' : 'error'} label={l.variablePrice ? 'priced · variable' : l.status} /> },
            ]}
          />
        </Card>
        <div className="ne-grid ne-grid-2">
          <Card title="Sensitivity to runtime" icon="clock" flush>
            <DataTable
              caption="Runtime sensitivity"
              compact
              rows={est.sensitivity}
              rowKey={x => String(x.activeHours)}
              columns={[
                { key: 'h', header: 'Active h', align: 'right', render: x => fmtNumber(x.activeHours, 2) },
                { key: 'a', header: 'Min', align: 'right', render: x => total(est.footprints.find(f => f.footprint === 'min')!, x.runPeriod.min, 0) },
                { key: 'b', header: 'Expected', align: 'right', render: x => total(exp, x.runPeriod.expected, 0) },
                { key: 'c', header: 'Max', align: 'right', render: x => total(est.footprints.find(f => f.footprint === 'max')!, x.runPeriod.max, 0) },
              ]}
            />
          </Card>
          <Card title="Coverage and assumptions" icon="info">
            {est.errors.map(e => (
              <div key={e} style={{ marginBottom: 8 }}>
                <Callout tone="danger">{e}</Callout>
              </div>
            ))}
            {est.coverage.issues.length ? (
              <ul style={{ margin: '0 0 10px', paddingLeft: 18, fontSize: '0.78125rem' }}>
                {est.coverage.issues.map((i, k) => (
                  <li key={k}>
                    <strong>{i.status}</strong> ({i.footprint}): {i.description}
                  </li>
                ))}
              </ul>
            ) : null}
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: '0.78125rem' }} className="ne-muted">
              {est.assumptions.map(a => (
                <li key={a}>{a}</li>
              ))}
              {est.coverage.variablePriceComponents.length ? <li>Variable spot price for {est.coverage.variablePriceComponents.join(', ')}: the price can change every 15 minutes during use.</li> : null}
            </ul>
          </Card>
        </div>
    </div>
  );
}

/** "2 (1 compute)" with the unpriced lines named on hover; "0" when every line has a rate. */
function UnpricedCell({ f }: { f: FootprintEstimate }) {
  const h = estimateHeadline(f);
  if (!h.unpricedLines) return <>0</>;
  const names = f.lines.filter(l => l.status !== 'priced' && l.status !== 'bundled').map(l => `${l.description} (${l.status})`).join('; ');
  return (
    <span title={names} style={{ color: h.state === 'incomplete' ? 'var(--ne-danger)' : undefined }}>
      {h.unpricedLines}
      {h.unpricedCompute ? ` (${h.unpricedCompute} compute)` : ''}
    </span>
  );
}

function Figure({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'danger' }) {
  return (
    <section className="ne-card ne-tile" aria-label={label}>
      <div className="ne-tile-label">{label}</div>
      <div className="ne-tile-value" style={{ fontSize: tone ? '1rem' : '1.3125rem', color: tone ? 'var(--ne-danger)' : undefined }}>
        {value}
      </div>
      {sub ? <div className="ne-tile-reason">{sub}</div> : null}
    </section>
  );
}
