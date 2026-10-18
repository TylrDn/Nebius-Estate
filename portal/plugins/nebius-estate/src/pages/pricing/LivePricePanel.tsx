import { ReactNode, useState } from 'react';
import type { LivePriceLine, Money, RateBookKind } from '@internal/nebius-domain';
import { Badge, Callout, Card, DataTable, fmtMoney, fmtNumber, fmtTime, Icon, Segmented, Skeleton } from '../../ui';
import { compareToList, contractStatus, estimateOf, liveHourly, liveTotal, LivePriceState, mixedRunTotal, priceBasis, priceBasisText, sharedReason, timesHours } from './livePrice';

export interface LivePriceRow {
  key: string;
  label: string;
  state: LivePriceState;
  /** The same footprint at the user rate book, per hour, for the comparison. */
  book?: Money;
  /** Hours the resources exist, for a run-period figure at list price. */
  runHours?: number;
  /** Hours per live-price line key when lines run for different hours (a solution footprint, G5.14). */
  lineHours?: Record<string, number>;
}

export const LIVE_PRICE_TITLE = 'Nebius live price (billing calculator)';
export const RATE_BOOK_LABEL = 'user rate book (negotiated / what-if)';

const bookKindLabel = (kind: RateBookKind) => (kind === 'negotiated' ? 'negotiated' : 'what-if (public list entered by you)');

/**
 * Live Nebius billing-calculator prices for one or more footprints: hourly
 * figure with "as of", per-SKU breakdown, contract-price status, unpriced
 * lines, and the user rate book as a separate, labelled comparison.
 */
export function LivePricePanel({
  rows,
  rateBook,
  onRetry,
  id,
  projectName = x => x,
}: {
  rows: LivePriceRow[];
  rateBook?: { name: string; kind: RateBookKind };
  onRetry?: () => void;
  id: string;
  /** Project id → name, for "priced in project …" (the id stays in the title). */
  projectName?: (id: string) => string;
}) {
  const [selected, setSelected] = useState(rows.find(r => r.key === 'expected')?.key ?? rows[0]?.key);
  const sel = rows.find(r => r.key === selected) ?? rows[0];
  const ref = rows.map(r => estimateOf(r.state)).find(Boolean);
  // Every capacity type the tiles price, not only the first row's (G5.12): "on-demand · preemptible".
  const capacity = [...new Set(rows.map(r => estimateOf(r.state)?.capacity?.text).filter((t): t is string => Boolean(t)))].join(' · ');
  const contract = ref ? contractStatus(ref) : undefined;
  const basis = ref ? priceBasis(ref) : undefined;
  const denied = rows.find(r => r.state.status === 'denied');
  const anyFailed = rows.some(r => r.state.status === 'error');
  const busy = rows.some(r => r.state.status === 'loading' || (r.state.status === 'ready' && r.state.updating));
  // One reason for every footprint is said once, above the tiles (F1.17).
  const shared = sharedReason(rows.map(r => r.state));

  return (
    <Card
      title={LIVE_PRICE_TITLE}
      icon="commercial"
      actions={
        onRetry && (anyFailed || denied) ? (
          <button type="button" className="ne-btn ne-btn-sm ne-no-print" onClick={onRetry}>
            <Icon name="refresh" size={13} /> Retry
          </button>
        ) : undefined
      }
      footer={
        ref
          ? `${ref.source} · ${priceBasisText(ref, m => fmtMoney(m))} as of ${fmtTime(ref.asOf)}${ref.projectId ? ` · priced in project ${projectName(ref.projectId)}` : ''} · not a quote; nothing is created`
          : 'Nebius billing calculator (estimate-batch) · not a quote; nothing is created'
      }
    >
      <div className="ne-stack u5-live" id={id} aria-busy={busy}>
        <div className="ne-row">
          <Badge tone="accent">Nebius billing calculator</Badge>
          {ref && basis ? <Badge tone={basis.label === 'contract price' ? 'ok' : 'info'}>{priceBasisText(ref, m => fmtMoney(m))}</Badge> : null}
          {capacity ? (
            <span data-testid="live-capacity">
              <Badge tone="info" wrap>
                Capacity: {capacity}
              </Badge>
            </span>
          ) : null}
          {ref ? <Badge>as of {fmtTime(ref.asOf)}</Badge> : null}
          {busy ? <Badge tone="warn">updating…</Badge> : null}
        </div>
        {denied?.state.status === 'denied' ? (
          <Callout tone="warn" title="No permission for live prices">
            {denied.state.message}
          </Callout>
        ) : null}
        {contract && !contract.contract ? <Callout tone="info" title="Contract price not shown">{contract.note}</Callout> : null}
        {shared ? (
          <Callout tone="warn" title="No live price">
            {shared}
          </Callout>
        ) : null}

        <div className="ne-grid ne-grid-tiles" aria-live="polite">
          {rows.map(r => (
            <PriceTile key={r.key} row={r} sharedReason={Boolean(shared)} />
          ))}
        </div>

        {sel ? <Breakdown row={sel} rows={rows} onSelect={setSelected} /> : null}

        {rateBook && rows.some(r => r.book) ? <Comparison rows={rows} rateBook={rateBook} /> : null}
      </div>
    </Card>
  );
}

function PriceTile({ row, sharedReason: shared }: { row: LivePriceRow; sharedReason?: boolean }) {
  const label = `${LIVE_PRICE_TITLE} · ${row.label}`;
  const s = row.state;
  let body: ReactNode;
  if (shared) {
    body = <Unavailable reason="The reason is above." />;
  } else if (s.status === 'loading') {
    body = (
      <>
        <Skeleton height={26} width="60%" />
        <div className="ne-tile-reason">Asking the billing calculator…</div>
      </>
    );
  } else if (s.status !== 'ready') {
    body = <Unavailable reason={s.status === 'idle' ? s.message ?? 'Waiting for inputs.' : s.message} />;
  } else if (!s.response.value && s.response.emptyFootprint) {
    // Nothing asked for: 0, not "unavailable" (F1.18).
    const zero = { amount: '0', currency: s.response.emptyFootprint.currency };
    body = (
      <>
        <div className="ne-tile-value u5-figure">
          {fmtMoney(zero)}
          <span className="ne-tile-unit">{' '}/ h</span>
        </div>
        <div className="ne-tile-reason">
          {row.runHours !== undefined ? `run (${fmtNumber(row.runHours, 2)} h): ${fmtMoney(zero)} · ` : ''}empty footprint: nothing to price
        </div>
      </>
    );
  } else if (!s.response.value) {
    body = <Unavailable reason={s.response.unavailableReason ?? 'The backend returned no price and no reason.'} />;
  } else {
    const est = s.response.value;
    const t = liveTotal(est);
    const mixed = row.runHours === undefined && row.lineHours && t.hourly ? mixedRunTotal(est, row.lineHours) : null;
    body = t.hourly ? (
      <>
        <div className="ne-tile-value u5-figure" data-updating={s.updating ? 'true' : undefined}>
          {fmtMoney(t.hourly)}
          <span className="ne-tile-unit">{' '}/ h</span>
        </div>
        <div className="ne-tile-reason">
          {row.runHours !== undefined ? `run (${fmtNumber(row.runHours, 2)} h): ${fmtMoney(timesHours(t.hourly, row.runHours))} · ` : ''}
          {mixed ? `per run (mixed hours): ${fmtMoney(mixed)} · ` : ''}
          {t.pricedLines} line(s) priced
          {t.partial ? ` · partial: ${t.unpricedCount} not included` : ''}
        </div>
        <div className="ne-tile-source">
          <span>{est.source}</span>
          <span>· as of {fmtTime(est.asOf)}</span>
        </div>
      </>
    ) : (
      <Unavailable reason={est.unpriced.length ? `No line is priced per hour: ${est.unpriced.join('; ')}` : 'The calculator priced no line per hour.'} />
    );
  }
  return (
    <section className="ne-card ne-tile" aria-label={label}>
      <div className="ne-tile-label">{label}</div>
      {body}
    </section>
  );
}

function Unavailable({ reason }: { reason: string }) {
  return (
    <>
      <div className="ne-tile-unavailable">
        <Icon name="unavailable" size={15} /> Unavailable
      </div>
      <div className="ne-tile-reason u5-wrap">{reason}</div>
    </>
  );
}

function Breakdown({ row, rows, onSelect }: { row: LivePriceRow; rows: LivePriceRow[]; onSelect: (k: string) => void }) {
  const est = estimateOf(row.state);
  return (
    <div className="ne-stack" style={{ gap: 8 }}>
      <div className="ne-between">
        <h3 className="ne-section-title" style={{ margin: 0 }}>
          Per-SKU breakdown{rows.length > 1 ? ` · ${row.label}` : ''}
        </h3>
        {rows.length > 1 ? <Segmented label="Footprint for the SKU breakdown" options={rows.map(r => ({ id: r.key, label: r.label }))} value={row.key} onChange={onSelect} /> : null}
      </div>
      {est ? (
        <>
          <DataTable<LivePriceLine>
            caption={`Live price lines, ${row.label}`}
            compact
            rows={est.lines}
            rowKey={l => l.key}
            empty={<span className="ne-muted">The calculator returned no lines for this footprint.</span>}
            columns={[
              {
                key: 'd',
                header: 'Line',
                render: l => (
                  <div className="u5-wrap">
                    <div>{l.description}</div>
                    {l.note ? <div className="ne-faint" style={{ fontSize: 'var(--ne-fs-caption)' }}>{l.note}</div> : null}
                  </div>
                ),
              },
              { key: 'c', header: 'Count', align: 'right', render: l => fmtNumber(l.count) },
              { key: 'h', header: 'Per hour (all units)', align: 'right', render: l => (l.hourly ? fmtMoney(l.hourly, 4) : <span className="ne-muted">{l.unit ? `priced per ${l.unit}` : 'usage-based'}</span>) },
              {
                key: 's',
                header: 'SKUs per unit (id · quantity · cost)',
                render: l =>
                  l.skus.length ? (
                    <ul className="u5-skus">
                      {l.skus.map((k, i) => (
                        <li key={`${k.skuId}-${i}`}>
                          <code>{k.skuId || 'SKU id not given'}</code> · {k.quantity ? (Number.isFinite(Number(k.quantity)) ? fmtNumber(Number(k.quantity), 4) : k.quantity) : 'quantity not given'} · {k.cost ? fmtMoney({ amount: k.cost, currency: est.currency }, 4) : 'cost not given'}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <span className="ne-faint">no SKU detail</span>
                  ),
              },
            ]}
          />
          {est.unpriced.length ? (
            <div>
              <div className="ne-tile-label">Not in the hourly figure</div>
              <ul className="u5-unpriced">
                {est.unpriced.map(u => (
                  <li key={u}>{u}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      ) : (
        <span className="ne-muted">{row.state.status === 'ready' && row.state.response.emptyFootprint ? 'Empty footprint: no lines to price.' : 'No live breakdown for this footprint.'}</span>
      )}
    </div>
  );
}

function Comparison({ rows, rateBook }: { rows: LivePriceRow[]; rateBook: { name: string; kind: RateBookKind } }) {
  return (
    <div className="ne-stack" style={{ gap: 8 }}>
      <h3 className="ne-section-title" style={{ margin: 0 }}>Compared with your {RATE_BOOK_LABEL}</h3>
      <div className="ne-row">
        <Badge tone={rateBook.kind === 'negotiated' ? 'info' : 'neutral'} wrap>
          {rateBook.name} · {bookKindLabel(rateBook.kind)}
        </Badge>
      </div>
      <DataTable<LivePriceRow>
        caption="Rate book compared with the live price"
        compact
        rows={rows}
        rowKey={r => r.key}
        columns={[
          { key: 'f', header: 'Footprint', render: r => <strong>{r.label}</strong> },
          { key: 'b', header: 'Rate book / h', align: 'right', render: r => fmtMoney(r.book) },
          { key: 'l', header: 'Nebius live / h', align: 'right', render: r => listCell(r.state) },
          {
            key: 'd',
            header: 'Rate book − live',
            align: 'right',
            render: r => {
              const c = compareToList(r.book, liveHourly(r.state));
              return c.kind === 'delta' ? (
                `${fmtMoney(c.delta)}${c.percent !== null ? ` (${c.percent} %)` : ''}`
              ) : (
                <span className="ne-muted u5-wrap">{c.reason}</span>
              );
            },
          },
        ]}
      />
      <p className="ne-faint" style={{ fontSize: 'var(--ne-fs-caption)', margin: 0 }}>
        The rate book is arithmetic on rates you entered (negotiated or what-if); the live price (contract or list) comes from the Nebius calculator. Neither is a quote or
        a bill.
      </p>
    </div>
  );
}

function listCell(s: LivePriceState): ReactNode {
  if (s.status === 'loading') return <span className="ne-muted">loading…</span>;
  const h = liveHourly(s);
  return h ? fmtMoney(h) : <span className="ne-muted">unavailable</span>;
}
