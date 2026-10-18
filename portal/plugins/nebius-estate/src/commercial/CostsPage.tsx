import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { BillingSummaryResponse, CostMetric, ExportHealth, ImportRecord, ListResponse, ResourceListResponse } from '@internal/nebius-domain';
import { COST_METRICS, Decimal, effectiveRange, exportFreshnessText, lagText, SPEND_EXCLUDES } from '@internal/nebius-domain';
import {
  Async,
  Badge,
  BarList,
  Callout,
  Card,
  ColumnChart,
  DataTable,
  EmptyState,
  Field,
  filterQuery,
  fmtMoney,
  fmtMoneyList,
  fmtNumber,
  fmtTime,
  Icon,
  KeyValue,
  LoadingBlock,
  PageShell,
  Segmented,
  Tabs,
  useBackend,
  useDownload,
  useGet,
  useGlobalFilter,
  useMeta,
  useProjectNames,
} from '../ui';
import { NARROW_QUERY, useMediaQuery } from '../ui/media';
import { costGroupLabel, costGroupSortText, dailyChartFooter, costGroupSpendLine, costMetricLabel, costsEmptyState, dailyExcludedNote, dataTile, latestPerImporter, coverageTile, dailyPoints, periodEndText, ignoredRange, importPeriodText, rangeError, rangeFromSearch, rejectReason, reportShows, roundedShares } from './costsModel';
import { budgetSpendLine } from '../pages/overview/model';

const DIMENSIONS = [
  { id: 'project', label: 'Project' },
  { id: 'service', label: 'Service' },
  { id: 'region', label: 'Region' },
  { id: 'resource', label: 'Resource' },
  { id: 'chargeCategory', label: 'Charge category' },
  { id: 'label:nip-stage', label: 'Stage label' },
  { id: 'label:nip-run', label: 'Run label' },
] as const;
type Dim = (typeof DIMENSIONS)[number]['id'];

const LABEL_SOURCE = { tags: 'from the export Tags', inventory: 'from the inventory join', mixed: 'Tags and inventory join' } as const;

export function CostsPage() {
  const [filter] = useGlobalFilter();
  const meta = useMeta();
  const { download, error: downloadError } = useDownload();
  const [metric, setMetric] = useState<CostMetric>('BilledCost');
  const [dim, setDim] = useState<Dim>('project');
  // The range lives in the URL (`?from=&to=`), so a view of a period can be linked.
  const [params, setParams] = useSearchParams();
  const [from, setFrom] = useState(() => rangeFromSearch(params).from);
  const [to, setTo] = useState(() => rangeFromSearch(params).to);
  // Range values from the link that are not dates: said once, like the global filter's "not applied" notice.
  const [ignored, setIgnored] = useState(() => ignoredRange(params));
  const badRange = rangeError(from, to);
  // An inverted range is caught on the field and not sent; the page keeps the last valid range, greyed out.
  const [applied, setApplied] = useState(() => (badRange ? { from: '', to: '' } : { from, to }));
  useEffect(() => {
    if (badRange) return;
    setApplied({ from, to });
    setParams(
      prev => {
        const next = new URLSearchParams(prev);
        for (const [k, v] of Object.entries({ from, to })) {
          if (v) next.set(k, v);
          else next.delete(k);
        }
        return next;
      },
      { replace: true },
    );
  }, [from, to, badRange, setParams]);
  const q = filterQuery({ project: filter.project, region: filter.region }, { metric, dimension: dim, from: applied.from || undefined, to: applied.to || undefined });
  const summary = useGet<BillingSummaryResponse>(`/billing/summary${q}`);
  const shown = effectiveRange(summary.data?.health ?? {}, { from, to });
  const imports = useGet<ListResponse<ImportRecord>>('/billing/imports');
  // Buckets are billed under their id; the inventory knows their names.
  const inventory = useGet<ResourceListResponse>(dim === 'resource' ? '/resources' : null);
  const names = useMemo(() => new Map((inventory.data?.items ?? []).filter(r => r.type === 'storage-bucket').map(r => [r.providerId, r.name])), [inventory.data]);
  const projectName = useProjectNames();
  // The project / region filter in words, for an empty selection (G4.1).
  const selection = [filter.project ? projectName(filter.project) ?? filter.project : '', filter.region ?? ''].filter(Boolean).join(' in ') || undefined;
  // A range or a project / region filter narrows the reporting period to the rows shown (G4.2).
  const narrowed = Boolean(applied.from || applied.to || filter.project || filter.region);
  const narrow = useMediaQuery(NARROW_QUERY);

  return (
    <PageShell
      title="Costs"
      subtitle="Reported cost from imported Nebius FOCUS billing exports. One cost metric at a time, currencies never combined, credits and adjustments kept as rows."
      actions={
        <button type="button" className="ne-btn" onClick={() => download(`/billing/export.csv${q}`, `nebius-cost-${dim.replace(':', '-')}-${metric}.csv`, 'text/csv')}>
          <Icon name="download" size={15} /> Export CSV
        </button>
      }
    >
      {downloadError ? (
        <div style={{ marginBottom: 12 }}>
          <Callout tone="danger">{downloadError}</Callout>
        </div>
      ) : null}
      {filter.stage ? (
        <div style={{ marginBottom: 12 }}>
          <Callout tone="info">Not filtered by stage: billing rows are selected by project and region only (only some rows carry a nip-stage tag). Use the “Stage label” breakdown, which reads the export’s Tags and joins the other rows to inventory labels.</Callout>
        </div>
      ) : null}
      {ignored.length ? (
        <div className="ne-filter-notice" role="status" style={{ marginBottom: 12 }}>
          <Callout tone="warn" title="Range from the link not applied">
            {ignored.map(i => `${i.key} "${i.value}" (not a date, YYYY-MM-DD)`).join('; ')}. Showing {from || to ? `${from || 'the start'} to ${to || 'now'}` : 'the whole period'} instead.{' '}
            <button type="button" className="ne-btn ne-btn-ghost ne-btn-sm" onClick={() => setIgnored([])}>
              Dismiss
            </button>
          </Callout>
        </div>
      ) : null}
      <div className="ne-between" style={{ marginBottom: 12 }}>
        {/* Metrics in words; the FOCUS column name is the hint (F1.19). */}
        <Segmented<CostMetric> label="Cost metric" value={metric} onChange={setMetric} options={COST_METRICS.map(m => ({ id: m, label: costMetricLabel(m), title: `FOCUS column ${m}` }))} />
        <div className="ne-row" style={{ alignItems: 'flex-start' }}>
          {/* An empty end shows the day the rows set, so the fields always say the range in force (F1.19). */}
          <Field label="From (UTC)" htmlFor="c-from" hint={shown.fromImplicit && shown.from ? 'first row (no start chosen)' : undefined}>
            <input id="c-from" className="ne-input" type="date" value={shown.from} onChange={e => setFrom(e.target.value)} />
          </Field>
          <Field label="To (exclusive)" htmlFor="c-to" error={badRange} hint={shown.toImplicit && shown.to ? 'after the last row (no end chosen)' : undefined}>
            <input id="c-to" className="ne-input" type="date" value={shown.to} onChange={e => setTo(e.target.value)} />
          </Field>
          {from || to ? (
            <button type="button" className="ne-btn ne-btn-sm ne-btn-ghost" style={{ marginTop: 22 }} onClick={() => { setFrom(''); setTo(''); }}>
              Whole period
            </button>
          ) : null}
        </div>
      </div>
      <Async load={summary} rows={8}>
        {s => {
          // One currency: each row rounded as everywhere else (fmtMoney), with its share of the total.
          const single = s.report.totals.length === 1 && s.report.groups.every(g => g.totals.length === 1 && g.totals[0].currency === s.report.totals[0].currency);
          const rounded = single ? roundedShares(s.report.groups.map(g => g.totals[0]), s.report.totals[0].amount) : [];
          const shares = new Map(single ? s.report.groups.map((g, i) => [g.key, rounded[i]]) : []);
          const empty = costsEmptyState({ rows: s.health.rows, rowsAnyRange: s.rowsAnyRange, importedRows: s.importedRows, selection, pull: s.exportPull, range: applied });
          const points = dailyPoints(s.daily.groups);
          const excluded = dailyExcludedNote(s.dailyExcluded);
          const chartCurrency = s.daily.groups.length && s.daily.groups.every(g => g.totals.length === 1 && g.totals[0].currency === s.daily.groups[0].totals[0]?.currency) ? s.daily.groups[0].totals[0]?.currency : undefined;
          return (
          <>
            {badRange ? (
              <div style={{ marginBottom: 12 }}>
                <Callout tone="warn" title="Range not applied">
                  Showing {applied.from || applied.to ? `${applied.from || 'the start'} to ${applied.to || 'now'}` : 'the whole period'} until the dates are fixed.
                </Callout>
              </div>
            ) : null}
            <div className={badRange ? 'ne-frozen' : undefined} data-testid="costs-results">
            <p className="ne-muted" style={{ margin: '0 0 12px', fontSize: '0.78125rem' }}>
              <strong style={{ color: 'var(--ne-text-2)' }}>{costMetricLabel(metric)}:</strong> {s.metricDescription} {s.note}
            </p>
            {s.health.rows === 0 && s.rowsAnyRange ? (
              <div style={{ marginBottom: 12 }}>
                <HealthStrip h={s.health} ranged={Boolean(applied.from || applied.to)} rowsAnyRange={s.rowsAnyRange} periodThrough={s.periodThrough} narrowed={narrowed} />
              </div>
            ) : null}
            {s.health.rows === 0 ? (
              <Card>
                <EmptyState title={empty.title ?? ''} icon="costs">
                  {empty.text}
                </EmptyState>
              </Card>
            ) : (
              <>
                {/* The headline first (total, by day), then where the figures come from (period, lag, completeness). */}
                <div className="ne-grid ne-grid-main">
                  <Card
                    title={`${costMetricLabel(metric)} by day${chartCurrency ? `, ${chartCurrency}` : ''}`}
                    icon="costs"
                    footer={dailyChartFooter(points, s.daily.groups.length)}
                  >
                    <ColumnChart
                      label={`${metric} per day${chartCurrency ? ` in ${chartCurrency}` : ''}`}
                      valueLabel={metric}
                      points={points}
                    />
                    {excluded ? <p className="ne-faint" data-testid="daily-excluded" style={{ fontSize: 'var(--ne-fs-caption)', margin: '6px 0 0' }}>{excluded}</p> : null}
                    {s.daily.groups.some(g => g.totals.length > 1) ? <Callout tone="warn">Some days hold several currencies; they are listed in the table, not charted together.</Callout> : null}
                  </Card>
                  <Card title="Total in period" icon="commercial">
                    <div className="ne-stack">
                      {s.report.totals.map(t => (
                        <div key={t.currency}>
                          <div className="ne-tile-value">{fmtMoney(t)}</div>
                          <div className="ne-muted" style={{ fontSize: '0.75rem' }}>
                            <span title={`FOCUS column ${metric}`}>{costMetricLabel(metric)}</span> in {t.currency}
                          </div>
                        </div>
                      ))}
                      {metric === 'BilledCost' && budgetSpendLine(s.report) ? <div className="ne-tile-reason">{budgetSpendLine(s.report)}</div> : null}
                      {s.report.totals.length > 1 ? <Callout tone="warn">Several currencies: shown separately, never summed (no exchange-rate policy).</Callout> : null}
                      <KeyValue
                        items={[
                          ['Rows by category', Object.entries(s.report.rowsByCategory).map(([k, v]) => `${k} ${v}`).join(' · ')],
                          ['Rows without this metric', `${s.report.rowsWithoutMetric} (excluded, not zeroed)`],
                        ]}
                      />
                    </div>
                  </Card>
                </div>
                <div className="ne-section">
                  <HealthStrip h={s.health} ranged={Boolean(applied.from || applied.to)} rowsAnyRange={s.rowsAnyRange} periodThrough={s.periodThrough} narrowed={narrowed} pull={s.exportPull} />
                </div>

                <div className="ne-section">
                  <Tabs label="Breakdown" value={dim} onChange={setDim} tabs={DIMENSIONS.map(d => ({ id: d.id, label: d.label }))} />
                  {s.report.creditFunded ? (
                    <div style={{ marginBottom: 10 }}>
                      <Callout tone="info">{fmtNumber(s.report.creditFunded.rows)} row(s), {fmtMoneyList(s.report.creditFunded.totals)}, are drawn from trial or promo credit (x_TrialId set in the export).</Callout>
                    </div>
                  ) : null}
                  {s.report.attributionNote ? (
                    <div style={{ marginBottom: 10 }}>
                      <Callout tone="info">{s.report.attributionNote}</Callout>
                    </div>
                  ) : null}
                  <div className="ne-grid ne-grid-main">
                    <Card
                      title={`${costMetricLabel(metric)} by ${DIMENSIONS.find(d => d.id === dim)?.label.toLowerCase()}`}
                      flush
                      footer={
                        s.report.totals.length === 1 ? (
                          <>
                            Total{' '}
                            <span className="ne-num" title={`Exact total: ${s.report.totals[0].amount} ${s.report.totals[0].currency}`}>
                              {fmtMoney(s.report.totals[0])}
                            </span>
                            . Each row is rounded on its own, as on every page, so the rows can differ from the total by a few cents; the exact figures are in the tooltips and the CSV export.
                            {metric === 'BilledCost' ? ` Rows include tax and credit rows; budgets leave them out (${SPEND_EXCLUDES}), so a row that holds any also shows what its budget counts.` : null}
                          </>
                        ) : undefined
                      }
                    >
                      {!reportShows(s.report, metric, dim) ? <LoadingBlock rows={6} label="Reading the breakdown" /> : <DataTable
                        caption="Cost breakdown"
                        rows={s.report.groups}
                        rowKey={g => g.key}
                        // Stacked cards on a phone scroll with the page, not inside a 460 px box (#67).
                        maxHeight={narrow ? undefined : 460}
                        columns={[
                          { key: 'l', header: DIMENSIONS.find(d => d.id === dim)?.label, sortValue: g => costGroupSortText(dim, g, names), render: g => {
                            if (g.unattributed) return <span><Badge tone="warn">unattributed</Badge> <span className="ne-muted">no value on the row</span></span>;
                            const l = costGroupLabel(dim, g, names);
                            return (
                              <span style={{ overflowWrap: 'anywhere' }} title={l.title}>
                                {l.text}
                                {g.labelSource ? <span className="ne-faint" style={{ fontSize: 'var(--ne-fs-caption)' }}> · {LABEL_SOURCE[g.labelSource]}</span> : null}
                                {g.creditFundedRows ? <> <Badge tone="info" title="x_TrialId is set on these rows">drawn from trial/promo credit ({g.creditFundedRows})</Badge></> : null}
                              </span>
                            );
                          } },
                          { key: 'r', header: 'Rows', align: 'right', sortValue: g => g.rows, render: g => fmtNumber(g.rows) },
                          { key: 't', header: costMetricLabel(metric), align: 'right', sortValue: g => (g.totals[0] ? Decimal.from(g.totals[0].amount).toNumber() : 0), render: g => {
                            const amount = shares.has(g.key) ? <span title={`Exact: ${g.totals[0].amount} ${g.totals[0].currency}`}>{shares.get(g.key)!.display}</span> : fmtMoneyList(g.totals);
                            const rule = costGroupSpendLine(metric, g);
                            return rule ? <div>{amount}<div className="ne-faint" data-testid="cost-row-spend" style={{ fontSize: 'var(--ne-fs-caption)' }}>{rule}</div></div> : amount;
                          } },
                          { key: 's', header: 'Share', align: 'right', sortValue: g => shares.get(g.key)?.percent ?? -1, render: g => (shares.get(g.key)?.percent ?? null) === null ? '—' : `${fmtNumber(shares.get(g.key)!.percent, 1)} %` },
                        ]}
                      />}
                    </Card>
                    <Card title="Share" icon="costs">
                      {!reportShows(s.report, metric, dim) ? <LoadingBlock rows={4} label="Reading the breakdown" /> : <BarList
                        label="Cost share"
                        items={s.report.groups.slice(0, 12).filter(g => g.totals.length === 1).map(g => ({ key: g.key, label: costGroupLabel(dim, g, names).text, value: Decimal.from(g.totals[0].amount).toNumber(), display: shares.has(g.key) ? `${shares.get(g.key)!.display} · ${fmtNumber(shares.get(g.key)!.percent, 1)} %` : fmtMoney(g.totals[0]), muted: g.unattributed }))}
                      />}
                      <p className="ne-faint" style={{ fontSize: 'var(--ne-fs-caption)', marginTop: 12 }}>
                        Idle cost is not shown: claiming it needs per-resource utilisation joined to billed rows, which this attribution cannot support. Utilisation-based allocation is not invoice reconciliation.
                      </p>
                    </Card>
                  </div>
                </div>
              </>
            )}
            </div>
          </>
          );
        }}
      </Async>
      <div className="ne-section">
        <Callout tone="info" title="Budgets">
          Budgets and credits are tracked in one place, measured against these billed rows and the live run-rate: <Link to="/budgets">Budgets &amp; credits →</Link>
        </Callout>
      </div>
      <div className="ne-section">
        <Imports load={imports} canImport={Boolean(meta.data?.permissions['nebius.billing.import'])} onImported={() => { imports.reload(); summary.reload(); }} />
      </div>
    </PageShell>
  );
}

function HealthStrip({ h, ranged, rowsAnyRange, periodThrough, narrowed, pull }: { h: ExportHealth; ranged: boolean; rowsAnyRange: number; periodThrough?: string; narrowed: boolean; pull?: BillingSummaryResponse['exportPull'] }) {
  const stale = (h.lagHours ?? 0) > 24;
  // The next pull and the next export file's estimate beside the lag (#12); nothing when neither is known.
  const next = pull ? exportFreshnessText(pull, new Date()) : undefined;
  const cov = coverageTile(h.coverage, ranged);
  const data = dataTile(h, { ranged, rowsAnyRange });
  return (
    <div className="ne-grid ne-grid-tiles">
      <section className="ne-card ne-tile" aria-label="Billing period">
        <div className="ne-tile-label">Reporting period</div>
        {h.earliestChargePeriodStart ? <div style={{ fontWeight: 600 }}>{fmtTime(h.earliestChargePeriodStart)} →</div> : null}
        <div style={{ fontWeight: 600 }} data-testid="period-end">{periodEndText(h, { through: periodThrough, narrowed }) || '—'}</div>
        <div className="ne-tile-source">Billing periods: {h.billingPeriods.join(', ') || '—'}</div>
      </section>
      <section className="ne-card ne-tile" aria-label="Export lag">
        <div className="ne-tile-label">Export lag</div>
        <div className="ne-tile-value">{h.lagHours === undefined ? '—' : lagText(h.lagHours)}</div>
        {stale ? <Badge tone="warn" title="Figures are incomplete for the most recent hours">delayed export</Badge> : <Badge tone="ok">within a day</Badge>}
        {next ? <div className="ne-tile-source" data-testid="export-freshness">{next}</div> : null}
      </section>
      <section className="ne-card ne-tile" aria-label="Completeness">
        <div className="ne-tile-label">{cov.label}</div>
        <div className="ne-tile-value">
          {cov.value}
          <span className="ne-tile-unit">{' '}{cov.unit}</span>
        </div>
        <div className="ne-tile-reason">{cov.reason}</div>
      </section>
      <section className="ne-card ne-tile" aria-label="Data">
        <div className="ne-tile-label">Data</div>
        <div className="ne-tile-value">{data.value}<span className="ne-tile-unit">{' '}{data.unit}</span></div>
        <div className="ne-tile-reason">{data.reason}</div>
      </section>
    </div>
  );
}

function Imports({ load, canImport, onImported }: { load: ReturnType<typeof useGet<ListResponse<ImportRecord>>>; canImport: boolean; onImported: () => void }) {
  const call = useBackend();
  const [all, setAll] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState<{ tone: 'info' | 'danger'; text: string }>();
  const upload = async (f: File) => {
    setMsg(undefined);
    try {
      const text = await f.text();
      const r = await call<ImportRecord>(`/billing/imports?filename=${encodeURIComponent(f.name.replace(/[^A-Za-z0-9._ -]/g, '_').slice(0, 120))}`, { method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: text });
      setMsg({ tone: 'info', text: `Imported ${r.summary.accepted} rows (${r.summary.duplicatesInFile} duplicates dropped, ${r.summary.supersededRows} earlier rows superseded and deleted, ${r.summary.rejected} rejected${r.summary.errors?.[0] ? `; first: row ${r.summary.errors[0].row}: ${r.summary.errors[0].message}` : ''}).` });
      onImported();
    } catch (e) {
      setMsg({ tone: 'danger', text: (e as Error).message });
    }
  };
  return (
    <Card
      title="Billing imports"
      icon="download"
      flush
      actions={
        <>
          <input ref={file} type="file" accept=".csv,text/csv" hidden onChange={e => {
            const f = e.target.files?.[0];
            e.target.value = ''; // the same file can be imported again
            if (f) upload(f);
          }} />
          <button type="button" className="ne-btn ne-btn-sm" disabled={!canImport} title={canImport ? undefined : 'Requires nebius.billing.import'} onClick={() => file.current?.click()}>
            <Icon name="plus" size={14} /> Import FOCUS CSV
          </button>
        </>
      }
      footer="Re-importing an hour replaces that hour for the same billing account and project (supersession by billing account × project × charge-period start), so overlapping or repeated exports never double count. Files are stored in the portal database only."
    >
      {msg ? <div style={{ padding: 12 }}><Callout tone={msg.tone}>{msg.text}</Callout></div> : null}
      <Async load={load} rows={3}>
        {d => (
          <>
          <DataTable
            caption="Billing imports"
            rows={all ? d.items : latestPerImporter(d.items)}
            rowKey={i => i.id}
            empty={<EmptyState title="No imports yet" />}
            columns={[
              { key: 'f', header: 'File', render: i => <div><strong>{i.filename}</strong><div className="ne-faint" style={{ fontSize: '0.75rem' }}>{fmtTime(i.importedAt)} · {i.importedBy}</div></div> },
              // The first and last usage hour of the file; month-long tax rows no longer stretch it to the month (#68).
              { key: 'p', header: 'Usage hours', render: i => <span className="ne-muted">{importPeriodText(i.summary) ?? `${fmtTime(i.summary.periodStart)} → ${fmtTime(i.summary.periodEnd)}`}</span> },
              { key: 'a', header: 'Accepted', align: 'right', render: i => fmtNumber(i.summary.accepted) },
              { key: 'd', header: 'Duplicates', align: 'right', render: i => fmtNumber(i.summary.duplicatesInFile) },
              { key: 's', header: 'Superseded', align: 'right', render: i => fmtNumber(i.summary.supersededRows) },
              {
                key: 'r', header: 'Rejected', align: 'right', render: i =>
                  i.summary.rejected ? (
                    <div>
                      <span style={{ color: 'var(--ne-danger)' }}>{i.summary.rejected}</span>
                      <ul className="ne-faint" style={{ margin: '4px 0 0', padding: 0, listStyle: 'none', fontSize: 'var(--ne-fs-caption)', textAlign: 'left' }}>
                        {i.summary.errors.slice(0, 3).map(e => <li key={`${e.row}-${e.message}`}>row {e.row}: {rejectReason(e.message)}</li>)}
                        {i.summary.errors.length > 3 ? <li>… {i.summary.errors.length - 3} more</li> : null}
                      </ul>
                    </div>
                  ) : 0,
              },
            ]}
          />
          {d.items.length > latestPerImporter(d.items).length ? (
            <div style={{ padding: '8px 16px' }}>
              <button type="button" className="ne-btn ne-btn-sm ne-btn-ghost" aria-expanded={all} onClick={() => setAll(x => !x)}>
                {all ? 'Show the latest import of each source only' : `Show all ${d.items.length} imports (${d.items.length - latestPerImporter(d.items).length} earlier)`}
              </button>
            </div>
          ) : null}
          </>
        )}
      </Async>
    </Card>
  );
}
