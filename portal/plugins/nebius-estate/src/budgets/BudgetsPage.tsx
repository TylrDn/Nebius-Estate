import { Fragment, ReactNode, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { BudgetsResponse, BudgetView, CreditInput, CreditView, FilterOptions, FormField, SpendEntryInput, SpendEntryRecord, SpendPart } from '@internal/nebius-domain';
import { BUDGET_PERIODS, budgetCostsLink, exportFreshnessText, formIssues, projectionWarns, SPEND_EXCLUDES, SPEND_PROVIDER_LABELS, SPEND_PROVIDERS, trackedText } from '@internal/nebius-domain';
import {
  Async,
  Badge,
  Callout,
  Card,
  DataTable,
  Drawer,
  EmptyState,
  Field,
  fmtAgo,
  fmtMoney,
  fmtThreshold,
  fmtMoneyList,
  fmtNumber,
  fieldMessageId,
  fmtTime,
  Icon,
  Meter,
  PageShell,
  ProjectName,
  useBackend,
  useGet,
  usePortalNow,
  useProjectNames,
} from '../ui';
import { BudgetForm, budgetFormToInput, budgetStatusTone, budgetToForm, creditStatusTone, currencyHint, emptyBudgetForm, emptyCreditForm, emptySpendForm, partLabel, withProvider } from './model';

type Editing =
  | { kind: 'budget'; id?: string; form: BudgetForm }
  | { kind: 'credit'; id?: string; form: CreditInput }
  | { kind: 'spend'; id?: string; form: SpendEntryInput };

const today = () => new Date().toISOString().slice(0, 10);

type Issues = Partial<Record<FormField, string>>;

/** Each form's input ids by field, in the order the drawer shows them (the first wrong one takes focus). */
const FIELD_IDS: Record<Editing['kind'], Partial<Record<FormField, string>>> = {
  budget: { name: 'b-name', provider: 'b-provider', scope: 'b-provider', period: 'b-period', amount: 'b-amount', currency: 'b-currency', thresholds: 'b-thresholds', regions: 'b-regions', projects: 'b-projects', services: 'b-services', products: 'b-products', note: 'b-note' },
  credit: { name: 'c-name', provider: 'c-provider', amount: 'c-amount', currency: 'c-currency', appliedOn: 'c-applied', expiresOn: 'c-expires', note: 'c-note' },
  spend: { date: 's-date', amount: 's-amount', currency: 's-currency', note: 's-note' },
};

const bodyOf = (e: Editing) => (e.kind === 'budget' ? budgetFormToInput(e.form) : e.form);

/** One spend part: amount, whether actual / estimate / entered, and how fresh it is. */
function Part({ p, now }: { p: SpendPart; now: Date }) {
  return (
    <div style={{ fontSize: 12 }} title={p.note}>
      <span className="ne-num">{fmtMoney(p.amount)}</span>{' '}
      <Badge tone={p.kind === 'estimate' ? 'info' : p.assumed ? 'warn' : 'neutral'}>{partLabel(p)}</Badge>
      <span className="ne-faint"> {p.asOf ? (p.asOf.length === 10 ? `entered for ${p.asOf}` : `as of ${fmtAgo(p.asOf, now)}`) : ''}</span>
    </div>
  );
}

/**
 * Used is the actual (export rows and entered spend) against the amount, as for a config budget; the actual plus
 * the live estimate is a separate Projected line, never in the meter or the status.
 */
function BudgetUsed({ b }: { b: BudgetView }) {
  const tone = budgetStatusTone(b.status);
  return (
    <div style={{ minWidth: 130 }}>
      <div className="ne-num" style={{ fontSize: 12 }} data-testid="budget-used">{b.percent === null ? 'no data' : `${fmtNumber(b.percent, 1)} % · ${fmtMoney(b.spend.actual)}`}</div>
      <Meter percent={Math.min(100, b.percent ?? 0)} tone={tone === 'neutral' ? 'accent' : (tone as 'ok' | 'warn' | 'danger')} label={`Budget ${b.name} used`} />
      <div className="ne-faint" style={{ fontSize: 'var(--ne-fs-caption)' }}>{b.thresholdStates.map(t => `${fmtThreshold(t.entered, b.thresholds.unit, b.currency)}${t.crossed === 'actual' ? ' ✓' : ''}`).join(' · ')}</div>
      {b.spend.parts[0]?.asOf ? (
        // How fresh the measured figure is, on every row (W1-P22): billing rows through, or the newest entered day.
        <div className="ne-faint" style={{ fontSize: 'var(--ne-fs-caption)' }} data-testid="budget-asof">
          {b.provider === 'token-factory' ? `entered through ${b.spend.parts[0].asOf.slice(0, 10)}` : `billing through ${fmtTime(b.spend.parts[0].asOf)}`}
        </div>
      ) : null}
      {b.projection ? (
        <div className="ne-faint" style={{ fontSize: 'var(--ne-fs-caption)' }} data-testid="budget-projected" title={b.spend.parts.find(p => p.kind === 'estimate')?.note}>
          Projected <span className="ne-num">{b.projection.percent === null ? '' : `${fmtNumber(b.projection.percent, 1)} % · `}{fmtMoney(b.projection.total)}</span> with the live estimate (+{fmtMoney(b.projection.estimate)})
        </div>
      ) : null}
    </div>
  );
}

export function BudgetsPage() {
  const load = useGet<BudgetsResponse>('/budgets');
  const call = useBackend();
  const now = usePortalNow();
  const names = useProjectNames();
  const [editing, setEditing] = useState<Editing>();
  const [error, setError] = useState<string>();
  const [msg, setMsg] = useState<string>();
  // Set by the first Save: from then on every wrong field says so as it is typed.
  const [tried, setTried] = useState(false);
  const open = (e: Editing) => {
    setEditing(e);
    setTried(false);
    setError(undefined);
  };
  const spend = load.data?.summary.spendCurrency ?? { 'ai-cloud': null, 'token-factory': null };
  // One spend entry per day (W1-P22): a new entry for a day already entered replaces that entry, said before Save.
  const replaces = editing?.kind === 'spend' && !editing.id ? load.data?.entries.find(e => e.date === editing.form.date) : undefined;

  const save = async () => {
    if (!editing) return;
    setError(undefined);
    setTried(true);
    const body = bodyOf(editing);
    // Checked here first, in plain words, with the route's own schema; nothing is sent until it passes.
    const issues: Issues = formIssues(editing.kind, body);
    const first = Object.entries(FIELD_IDS[editing.kind]).find(([f]) => issues[f as FormField]);
    if (first) {
      document.getElementById(first[1])?.focus();
      return;
    }
    try {
      const id = editing.id ?? replaces?.id;
      await call(`/budgets/${editing.kind}${id ? `/${id}` : ''}`, { method: id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      setMsg(replaces ? `Replaced the spend entry of ${replaces.date}.` : `Saved ${editing.kind === 'spend' ? 'the spend entry' : `“${(editing.form as { name: string }).name.trim()}”`}.`);
      setEditing(undefined);
      load.reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const remove = async (kind: Editing['kind'], id: string, what: string) => {
    try {
      await call(`/budgets/${kind}/${id}`, { method: 'DELETE' });
      setMsg(`Deleted ${what}.`);
      load.reload();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };

  return (
    <PageShell
      title="Budgets & credits"
      subtitle="The budgets and credits you track, each measured against spend from the best source, labelled per figure: FOCUS export rows (actual), the live run-rate since the last exported hour (estimate), and Token Factory spend you enter."
      filters={false}
    >
      <Async load={load} rows={6}>
        {d => {
          const canEdit = d.canEdit;
          const editTitle = canEdit ? undefined : 'Requires nebius.billing.budget.write';
          return (
            <>
              <div style={{ marginBottom: 12 }}>
                <Callout tone="info" title="Entered by you: a mirror of your console budgets and credits">
                  Nebius AI Cloud has no API for budgets, the balance or promo credits, and Token Factory has none for usage or balance. Enter each budget as it is set in{' '}
                  <a href={d.links.billing} target="_blank" rel="noreferrer">the console (Billing → Budgets)</a> and each credit with its expiry; Token Factory spend comes from its{' '}
                  <a href={d.links.tokenFactory} target="_blank" rel="noreferrer">Usage tab</a>. Console budgets alert by email and never cap spend; this page does not either.
                </Callout>
              </div>
              {d.scopeNote ? <div style={{ marginBottom: 12 }}><Callout tone="warn">{d.scopeNote}</Callout></div> : null}
              {msg ? <div style={{ marginBottom: 12 }}><Callout tone="info">{msg}</Callout></div> : null}

              <Summary d={d} now={now} />

              {d.budgets.length === 0 && d.credits.length === 0 ? (
                <div className="ne-section">
                  <Card>
                    <EmptyState title={d.configBudgets.length ? 'No budgets or credits entered by you' : 'Nothing tracked yet'} icon="budget">
                      {d.configBudgets.length
                        ? `${d.configBudgets.length} budget${d.configBudgets.length === 1 ? '' : 's'} from the configuration ${d.configBudgets.length === 1 ? 'is' : 'are'} listed below (read-only): add ${d.configBudgets.length === 1 ? 'it' : 'each'} here, with the other budgets and credits you track, for example the Token Factory promo credit.`
                        : 'Add the budgets and credits you track, for example the Token Factory promo credit.'}
                      <div className="ne-row" style={{ justifyContent: 'center', marginTop: 12 }}>
                        <button type="button" className="ne-btn" disabled={!canEdit} title={editTitle} onClick={() => open({ kind: 'budget', form: emptyBudgetForm(spend) })}>
                          <Icon name="plus" size={14} /> Add budget
                        </button>
                        <button type="button" className="ne-btn" disabled={!canEdit} title={editTitle} onClick={() => open({ kind: 'credit', form: emptyCreditForm(spend, today()) })}>
                          <Icon name="plus" size={14} /> Add credit
                        </button>
                      </div>
                    </EmptyState>
                  </Card>
                </div>
              ) : null}

              {d.budgets.length || d.credits.length ? (
                <div className="ne-section">
                  <Card
                    title="Budgets"
                    icon="budget"
                    flush
                    actions={<button type="button" className="ne-btn ne-btn-sm" disabled={!canEdit} title={editTitle} onClick={() => open({ kind: 'budget', form: emptyBudgetForm(spend) })}><Icon name="plus" size={14} /> Add budget</button>}
                    footer="Periods start at 00:00 UTC on calendar boundaries, as in the console. Forecasts to the period end: at this period's average burn (spend since its first row; needs a day of it), and if nothing new runs (spend so far plus the live run-rate of what runs now). Tax and credit rows are left out (console budgets exclude VAT; a credit is not spend)."
                  >
                    <DataTable
                      caption="Budgets"
                      rows={d.budgets}
                      rowKey={b => b.id}
                      empty={<EmptyState title="No budgets">Add the budgets you set in the console.</EmptyState>}
                      columns={[
                        { key: 'n', header: 'Budget', sortValue: b => b.name, render: b => <BudgetName b={b} names={names} /> },
                        { key: 'a', header: 'Amount · period', render: b => <div><div className="ne-num">{fmtMoney({ amount: b.amount, currency: b.currency })}</div><div className="ne-faint" style={{ fontSize: 'var(--ne-fs-caption)' }}>{b.period} · {b.window.start.slice(0, 10)} → {b.window.end.slice(0, 10)}</div></div> },
                        { key: 's', header: 'Spend to date', render: b => <div>{b.spend.parts.length ? b.spend.parts.map(p => <Part key={p.source} p={p} now={now} />) : <span className="ne-muted">—</span>}{b.notes.map(n => <div key={n} className="ne-faint" style={{ fontSize: 'var(--ne-fs-caption)', maxWidth: 320 }}>{n}</div>)}</div> },
                        { key: 'u', header: 'Used', sortValue: b => b.percent ?? -1, render: b => <BudgetUsed b={b} /> },
                        { key: 'f', header: 'Forecast to period end', render: b => <BudgetForecast b={b} /> },
                        { key: 't', header: 'Status', render: b => <div className="ne-stack-xs"><Badge tone={budgetStatusTone(b.status)} wrap>{b.statusText}</Badge>{b.projection && projectionWarns(b) ? <Badge tone={b.projection.over ? 'warn' : 'info'} wrap>{b.projection.text}</Badge> : null}</div> },
                        { key: 'x', header: <span className="ne-sr-only">Actions</span>, render: b => <RowActions canEdit={canEdit} onEdit={() => open({ kind: 'budget', id: b.id, form: budgetToForm(b) })} onDelete={() => remove('budget', b.id, `the budget “${b.name}”`)} label={b.name} /> },
                      ]}
                    />
                  </Card>
                </div>
              ) : null}

              {d.configBudgets.length ? (
                <div className="ne-section">
                  <Card title="Budgets from the configuration (read-only)" icon="lock" flush footer={d.configBudgetsNote}>
                    <DataTable
                      caption="Budgets from the configuration"
                      rows={d.configBudgets}
                      rowKey={b => b.id}
                      columns={[
                        { key: 'i', header: 'Budget', render: b => <div><strong>{b.id}</strong> <Badge tone="neutral">from config</Badge><div className="ne-faint" style={{ fontSize: 'var(--ne-fs-caption)' }}>{b.source}</div></div> },
                        { key: 's', header: 'Scope · month', render: b => <>{b.scope.project ? <ProjectName id={b.scope.project} names={names} /> : 'all projects'} · {b.period}</> },
                        {
                          key: 'a',
                          header: `Spend ${SPEND_EXCLUDES} / budget`,
                          align: 'right',
                          render: b => (
                            <>
                              {fmtMoney({ amount: b.reported, currency: b.currency })} / {fmtMoney({ amount: b.amount, currency: b.currency }, 0)}
                              {/* How fresh the figure is, as on the other budget rows (W1-P22). */}
                              {b.billedThrough ? <div className="ne-faint" style={{ fontSize: 'var(--ne-fs-caption)' }} data-testid="config-budget-asof">billing through {fmtTime(b.billedThrough)}</div> : null}
                            </>
                          ),
                        },
                        { key: 'p', header: 'Used', render: b =>
                            b.state === 'no-data' ? (
                              <Badge tone="neutral" wrap>{b.statusText}</Badge>
                            ) : (
                              <div style={{ minWidth: 130 }}><div className="ne-num" style={{ fontSize: 12 }}>{b.percent === null ? 'no amount' : `${fmtNumber(b.percent, 1)} %`}</div><Meter percent={Math.min(100, b.percent ?? 0)} tone={b.state === 'over' ? 'danger' : b.state === 'near' ? 'warn' : 'ok'} label={`Config budget ${b.id} used`} /></div>
                            ) },
                      ]}
                    />
                  </Card>
                </div>
              ) : null}

              {d.budgets.length || d.credits.length ? (
                <div className="ne-section">
                  <Card
                    title="Credits"
                    icon="commercial"
                    flush
                    actions={<button type="button" className="ne-btn ne-btn-sm" disabled={!canEdit} title={editTitle} onClick={() => open({ kind: 'credit', form: emptyCreditForm(spend, today()) })}><Icon name="plus" size={14} /> Add credit</button>}
                    footer="Earlier credits of a provider draw first. AI Cloud credits draw the export rows marked x_TrialId when the export marks any; Token Factory credits draw the spend you enter. Exhaustion uses the burn rate since the first draw."
                  >
                    <DataTable
                      caption="Credits"
                      rows={d.credits}
                      rowKey={c => c.id}
                      empty={<EmptyState title="No credits">Add a credit, for example the Token Factory promo credit.</EmptyState>}
                      columns={[
                        { key: 'n', header: 'Credit', sortValue: c => c.name, render: c => <div><strong>{c.name}</strong><div className="ne-faint" style={{ fontSize: 'var(--ne-fs-caption)' }}>{SPEND_PROVIDER_LABELS[c.provider]} · entered by {c.createdBy}</div>{c.note ? <div className="ne-faint" style={{ fontSize: 'var(--ne-fs-caption)' }}>{c.note}</div> : null}</div> },
                        { key: 'v', header: 'Amount · validity', render: c => <div><div className="ne-num">{fmtMoney({ amount: c.amount, currency: c.currency })}</div><div className="ne-faint" style={{ fontSize: 'var(--ne-fs-caption)' }}>{c.appliedOn} → {c.expiresOn ?? 'no expiry entered'}</div></div> },
                        { key: 'u', header: 'Used', render: c => <div>{c.used.parts.map(p => <Part key={p.source} p={p} now={now} />)}{c.notes.map(n => <div key={n} className="ne-faint" style={{ fontSize: 'var(--ne-fs-caption)', maxWidth: 320 }}>{n}</div>)}</div> },
                        { key: 'r', header: 'Remaining', sortValue: c => Number(c.remaining.amount), render: c => <CreditRemaining c={c} /> },
                        { key: 'f', header: 'Burn · runs out', render: c => <CreditForecast c={c} /> },
                        { key: 't', header: 'Status', render: c => <Badge tone={creditStatusTone(c)} wrap>{c.statusText}</Badge> },
                        { key: 'x', header: <span className="ne-sr-only">Actions</span>, render: c => <RowActions canEdit={canEdit} label={c.name} onEdit={() => open({ kind: 'credit', id: c.id, form: { name: c.name, provider: c.provider, amount: c.amount, currency: c.currency, appliedOn: c.appliedOn, expiresOn: c.expiresOn, note: c.note } })} onDelete={() => remove('credit', c.id, `the credit “${c.name}”`)} /> },
                      ]}
                    />
                  </Card>
                </div>
              ) : null}

              <div className="ne-section">
                <Entries entries={d.entries} canEdit={canEdit} tokenFactory={d.links.tokenFactory} onAdd={() => open({ kind: 'spend', form: emptySpendForm(spend, today()) })} onEdit={e => open({ kind: 'spend', id: e.id, form: { provider: 'token-factory', date: e.date, amount: e.amount, currency: e.currency, note: e.note } })} onDelete={e => remove('spend', e.id, `the spend entry of ${e.date}`)} />
              </div>

              {d.signals.length ? (
                <div className="ne-section">
                  <Card title="Budget and credit signals" icon="warn" footer="These feed the Alerts page. Each has a guided fix in runbooks/finance.md.">
                    <ul className="ne-stack" style={{ margin: 0, padding: 0, listStyle: 'none', gap: 8 }}>
                      {d.signals.map(s => (
                        <li key={s.id}>
                          <Badge tone={s.severity === 'critical' ? 'danger' : s.severity === 'warning' ? 'warn' : 'info'}>{s.severity}</Badge> {s.title}
                          <div className="ne-faint" style={{ fontSize: 12 }}>{s.fix.action}</div>
                        </li>
                      ))}
                    </ul>
                  </Card>
                </div>
              ) : null}
            </>
          );
        }}
      </Async>
      <Drawer
        open={Boolean(editing)}
        onClose={() => { setEditing(undefined); setError(undefined); }}
        title={editing ? `${editing.id ? 'Edit' : 'Add'} ${editing.kind === 'spend' ? 'Token Factory spend' : editing.kind}` : ''}
        subtitle="Entered by you; stored in the portal database. Nothing is sent to Nebius."
        mono={false}
      >
        {editing ? <EditForm editing={editing} setEditing={setEditing} issues={tried ? formIssues(editing.kind, bodyOf(editing)) : {}} spend={spend} error={error} onSave={save} replaces={replaces} /> : null}
      </Drawer>
    </PageShell>
  );
}

function BudgetName({ b, names }: { b: BudgetView; names: (id: string) => string | undefined }) {
  const s = b.scope;
  const conditions: ReactNode[] = [
    s.regions.length ? `region ${s.regions.join(', ')}` : '',
    s.projects.length ? (
      <>
        project{' '}
        {s.projects.map((p, i) => (
          <Fragment key={p}>
            {i ? ', ' : ''}
            <ProjectName id={p} names={names} />
          </Fragment>
        ))}
      </>
    ) : (
      ''
    ),
    s.services.length ? `service ${s.services.join(', ')}` : '',
    s.products.length ? `product ${s.products.join(', ')}` : '',
  ].filter(Boolean);
  return (
    <div>
      <strong>{b.name}</strong>
      <div className="ne-faint" style={{ fontSize: 'var(--ne-fs-caption)' }}>
        {SPEND_PROVIDER_LABELS[b.provider]} ·{' '}
        {conditions.length
          ? conditions.map((c, i) => (
              <Fragment key={i}>
                {i ? ' and ' : ''}
                {c}
              </Fragment>
            ))
          : 'all usage'}
      </div>
      <div className="ne-faint" style={{ fontSize: 'var(--ne-fs-caption)' }}>entered by {b.createdBy}</div>
      <CostsLink b={b} />
    </div>
  );
}

/** The budget's period and scope on Costs (W1-P23); what Costs cannot filter is named beside the link. */
function CostsLink({ b }: { b: BudgetView }) {
  const l = budgetCostsLink(b);
  if (!l) return null;
  return (
    <div style={{ fontSize: 'var(--ne-fs-caption)' }}>
      <Link to={l.href} aria-label={`Open in Costs: budget ${b.name}`}>Open in Costs →</Link>
      {l.notApplied.length ? <span className="ne-faint"> (not applied there: {l.notApplied.join('; ')})</span> : null}
    </div>
  );
}

/**
 * What the budget being typed measures now (W1-P23): its scope's spend in the current period against the amount,
 * from the same evaluation Budgets uses (POST /budgets/preview); nothing is saved.
 */
function ScopePreview({ form }: { form: BudgetForm }) {
  const call = useBackend();
  const input = budgetFormToInput(form);
  const key = JSON.stringify(input);
  const valid = Object.keys(formIssues('budget', input)).length === 0;
  const [view, setView] = useState<{ key: string; b?: BudgetView; error?: string }>();
  useEffect(() => {
    if (!valid) return undefined;
    const t = setTimeout(() => {
      call<BudgetView>('/budgets/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: key })
        .then(b => setView({ key, b }))
        .catch((e: Error) => setView({ key, error: e.message }));
    }, 350);
    return () => clearTimeout(t);
  }, [key, valid, call]);
  const current = view?.key === key ? view : undefined;
  let text: ReactNode;
  if (!valid) text = 'The preview follows once the name, amount and conditions are valid.';
  else if (!current) text = 'Measuring this scope…';
  else if (current.error) text = `No preview: ${current.error}`;
  else if (current.b!.status === 'no-data') text = current.b!.statusText;
  else {
    const b = current.b!;
    text = (
      <>
        <span className="ne-num">{fmtMoney(b.spend.actual)}</span> spent in this scope this {b.period === 'daily' ? 'day' : b.period.replace(/ly$/, '')} so far
        {b.percent !== null ? ` (${fmtNumber(b.percent, 1)} % of the amount)` : ''}
        {b.spend.parts[0]?.asOf ? ` · ${b.provider === 'token-factory' ? `entered through ${b.spend.parts[0].asOf.slice(0, 10)}` : `billing through ${fmtTime(b.spend.parts[0].asOf)}`}` : ''}
      </>
    );
  }
  return (
    <div className="ne-field-hint" role="status" aria-live="polite" data-testid="scope-preview">
      <strong>Scope preview:</strong> {text}
    </div>
  );
}

/**
 * What is left, with its meter; an unverified credit (nothing known drawn) reads "≤ amount" with why and no meter, as a
 * full green bar would read as measured (#36).
 */
function CreditRemaining({ c }: { c: CreditView }) {
  if (c.remainingAtMost) {
    return (
      <div style={{ minWidth: 120 }} data-testid="credit-remaining">
        <div className="ne-num" style={{ fontSize: 12 }}>≤ {fmtMoney(c.remaining)}</div>
        <div className="ne-faint" style={{ fontSize: 'var(--ne-fs-caption)' }}>{c.provider === 'token-factory' ? 'no spend entered' : 'no billing export rows'}</div>
      </div>
    );
  }
  return (
    <div style={{ minWidth: 120 }} data-testid="credit-remaining">
      <div className="ne-num" style={{ fontSize: 12 }}>{fmtMoney(c.remaining)}</div>
      <Meter percent={c.percentUsed} tone={c.percentUsed >= 100 ? 'danger' : c.percentUsed >= 80 ? 'warn' : 'ok'} label={`Credit ${c.name} used`} />
    </div>
  );
}

/**
 * Two forecast lines (W1-P20): at this period's average burn, and if nothing new runs (spend so far plus what runs
 * now); each withheld with its reason rather than extrapolated from too little.
 */
function BudgetForecast({ b }: { b: BudgetView }) {
  const lines = [b.forecasts.averageBurn, b.forecasts.nothingNew];
  return (
    <div style={{ fontSize: 12, minWidth: 180 }} className="ne-stack-xs" data-testid="budget-forecast">
      {lines.map((l, i) =>
        'withheld' in l ? (
          <div key={i} className="ne-faint">
            {i === 0 ? 'Average burn' : 'If nothing new runs'}: withheld, {l.withheld}
          </div>
        ) : (
          <div key={i} style={l.overAmount ? { color: 'var(--ne-danger)' } : undefined}>
            <span className="ne-num">→ {fmtMoney(l.periodEnd)}</span>
            {l.percent !== null ? ` (${fmtNumber(l.percent, 0)} %)` : ''} <span className={l.overAmount ? undefined : 'ne-faint'}>{l.text}</span>
          </div>
        ),
      )}
    </div>
  );
}

function CreditForecast({ c }: { c: CreditView }) {
  if (!c.burnRate) return <span className="ne-faint" style={{ fontSize: 12 }}>no draw yet</span>;
  return (
    <div style={{ fontSize: 12 }}>
      <div>{fmtMoney(c.burnRate.perDay)}/day</div>
      {c.exhaustsOn ? (
        <div style={c.exhaustsBeforeExpiry ? undefined : { color: 'var(--ne-text-3)' }}>
          runs out {c.exhaustsOn}
          {c.exhaustsBeforeExpiry === false ? ' (after it expires: some will lapse)' : ''}
        </div>
      ) : null}
    </div>
  );
}

/** Edit and a two-step delete (removes it from the portal only; the console is not changed). */
function RowActions({ canEdit, onEdit, onDelete, label }: { canEdit: boolean; onEdit: () => void; onDelete: () => void; label: string }) {
  const [armed, setArmed] = useState(false);
  return (
    <div className="ne-row" style={{ flexWrap: 'nowrap' }}>
      {armed ? (
        <>
          <button type="button" className="ne-btn ne-btn-sm" onClick={() => { setArmed(false); onDelete(); }} aria-label={`Confirm: delete ${label} from the portal`}>Delete</button>
          <button type="button" className="ne-btn ne-btn-sm ne-btn-ghost" onClick={() => setArmed(false)}>Keep</button>
        </>
      ) : (
        <>
          <button type="button" className="ne-btn ne-btn-sm ne-btn-ghost" disabled={!canEdit} onClick={onEdit} aria-label={`Edit ${label}`}>Edit</button>
          <button type="button" className="ne-btn ne-btn-sm ne-btn-ghost" disabled={!canEdit} onClick={() => setArmed(true)} aria-label={`Delete ${label}`}>Delete</button>
        </>
      )}
    </div>
  );
}

function Summary({ d, now }: { d: BudgetsResponse; now: Date }) {
  const s = d.summary;
  return (
    <div className="ne-grid ne-grid-tiles">
      <section className="ne-card ne-tile" aria-label="Spend this month">
        <div className="ne-tile-label"><Icon name="costs" size={14} /> Spend this month (account)</div>
        {/* The headline is what was spent (export rows and entered spend), one total per currency; the estimate is never in it. */}
        {s.monthSpent.map(t => (
          <div key={t.currency} className="ne-tile-value">
            {fmtMoney(t)}
          </div>
        ))}
        {s.monthToDate.filter(p => p.kind !== 'estimate').map(p => (
          <div key={`${p.source}-${p.amount.currency}`} style={{ fontSize: 12.5 }} title={p.note}>
            <span className="ne-num" style={{ fontWeight: 600 }}>{fmtMoney(p.amount)}</span> <span className="ne-faint">{p.label}</span>
          </div>
        ))}
        <div className="ne-tile-projected" data-testid="projected" title={s.monthToDate.find(p => p.kind === 'estimate')?.note}>
          {s.monthProjected ? (
            <>
              Projected to now <span className="ne-num">{fmtMoneyList(s.monthProjected.total)}</span>
              <span className="ne-faint"> with the live run-rate estimate since the last exported hour (+{fmtMoneyList(s.monthProjected.estimate)})</span>
            </>
          ) : (
            <span className="ne-faint">Projected: {s.projectedUnavailable}</span>
          )}
        </div>
        <div className="ne-tile-source">{s.exportThrough ? `export through ${fmtTime(s.exportThrough)} · ${fmtAgo(s.exportThrough, now)}` : 'no export rows yet'}</div>
        {d.exportFreshness && exportFreshnessText(d.exportFreshness, now) ? (
          <div className="ne-tile-source" data-testid="export-freshness">{exportFreshnessText(d.exportFreshness, now)}</div>
        ) : null}
      </section>
      <section className="ne-card ne-tile" aria-label="Credit remaining">
        <div className="ne-tile-label"><Icon name="commercial" size={14} /> Credit remaining</div>
        {s.creditRemaining.length ? (
          s.creditRemaining.map(c => (
            <div key={c.provider}>
              <div className="ne-tile-value" style={{ fontSize: 20 }}>{c.atMost ? '≤ ' : ''}{fmtMoneyList(c.remaining)}</div>
              <div className="ne-faint" style={{ fontSize: 12 }}>{SPEND_PROVIDER_LABELS[c.provider]}{c.atMost ? ` · unverified: ${c.provider === 'token-factory' ? 'no spend entered' : 'no billing export rows'}` : ''}</div>
            </div>
          ))
        ) : (
          <div className="ne-tile-reason">No valid credit entered.</div>
        )}
        <div className="ne-tile-source">{s.credits.total} credit(s){s.credits.expiringSoon ? ` · ${s.credits.expiringSoon} expiring within 14 days` : ''}</div>
      </section>
      <section className="ne-card ne-tile" aria-label="Budgets summary">
        <div className="ne-tile-label"><Icon name="budget" size={14} /> Budgets</div>
        <div className="ne-tile-value">{s.budgets.total}</div>
        <div className="ne-tile-reason">{s.budgets.over} over · {s.budgets.atThreshold} at a threshold · {s.budgets.noData} without data</div>
        <div className="ne-tile-source">{trackedText(s.budgets)}</div>
      </section>
      <section className="ne-card ne-tile" aria-label="Signals">
        <div className="ne-tile-label"><Icon name="warn" size={14} /> Signals</div>
        <div className="ne-tile-value">{d.signals.length}</div>
        <div className="ne-tile-reason">{d.signals.length ? 'thresholds crossed, projected or forecast, or credits expiring' : 'nothing crossed, projected or forecast to cross, no credit expiring within 14 days'}</div>
        <div className="ne-tile-source">evaluated {fmtAgo(d.generatedAt, now)}</div>
      </section>
    </div>
  );
}

function Entries({ entries, canEdit, tokenFactory, onAdd, onEdit, onDelete }: { entries: SpendEntryRecord[]; canEdit: boolean; tokenFactory: string; onAdd: () => void; onEdit: (e: SpendEntryRecord) => void; onDelete: (e: SpendEntryRecord) => void }) {
  return (
    <Card
      title="Token Factory spend (entered by you)"
      icon="ai"
      flush
      actions={<button type="button" className="ne-btn ne-btn-sm" disabled={!canEdit} title={canEdit ? undefined : 'Requires nebius.billing.budget.write'} onClick={onAdd}><Icon name="plus" size={14} /> Add spend</button>}
      footer={<>Token Factory has no usage API: copy the daily spend from its <a href={tokenFactory} target="_blank" rel="noreferrer">Usage tab</a>. Each entry is the spend of that day (UTC).</>}
    >
      <DataTable
        caption="Token Factory spend entries"
        rows={entries}
        rowKey={e => e.id}
        empty={<EmptyState title="No Token Factory spend entered">Add it from the Usage tab to track Token Factory budgets and credits.</EmptyState>}
        columns={[
          { key: 'd', header: 'Date', sortValue: e => e.date, sortKind: 'time', render: e => e.date },
          { key: 'a', header: 'Amount', align: 'right', sortValue: e => Number(e.amount), render: e => fmtMoney({ amount: e.amount, currency: e.currency }) },
          { key: 'n', header: 'Note', render: e => <span className="ne-muted">{e.note ?? ''}</span> },
          { key: 'b', header: 'Entered by', render: e => <span className="ne-faint" style={{ fontSize: 12 }}>{e.createdBy}</span> },
          { key: 'x', header: <span className="ne-sr-only">Actions</span>, render: e => <RowActions canEdit={canEdit} label={`spend of ${e.date}`} onEdit={() => onEdit(e)} onDelete={() => onDelete(e)} /> },
        ]}
      />
    </Card>
  );
}

function EditForm({ editing, setEditing, issues, spend, error, onSave, replaces }: { editing: Editing; setEditing: (e: Editing) => void; issues: Issues; spend: BudgetsResponse['summary']['spendCurrency']; error?: string; onSave: () => void; replaces?: SpendEntryRecord }) {
  const ids = FIELD_IDS[editing.kind];
  const errorAt = (id: string) => (Object.entries(ids) as [FormField, string][]).filter(([, x]) => x === id).map(([f]) => issues[f]).find(Boolean);
  const input = (id: string, label: string, value: string, set: (v: string) => void, hint?: string, type = 'text') => (
    <Field label={label} htmlFor={id} hint={hint} error={errorAt(id)}>
      <input id={id} className="ne-input" type={type} value={value} onChange={e => set(e.target.value)} />
    </Field>
  );
  const wrong = Object.keys(issues).length;
  let fields: JSX.Element;
  if (editing.kind === 'budget') {
    const f = editing.form;
    const set = (patch: Partial<BudgetForm>) => setEditing({ ...editing, form: { ...f, ...patch } });
    fields = (
      <>
        {input('b-name', 'Name', f.name, v => set({ name: v }), 'As in the console')}
        <Field label="Provider" htmlFor="b-provider" hint="Console budgets are AI Cloud budgets; a Token Factory budget tracks the spend you enter" error={errorAt('b-provider')}>
          <select id="b-provider" className="ne-select" value={f.provider} onChange={e => setEditing({ ...editing, form: withProvider(f, e.target.value as BudgetForm['provider'], spend) })}>
            {SPEND_PROVIDERS.map(p => <option key={p} value={p}>{SPEND_PROVIDER_LABELS[p]}</option>)}
          </select>
        </Field>
        <Field label="Time period" htmlFor="b-period" hint="Starts 00:00 UTC, calendar aligned">
          <select id="b-period" className="ne-select" value={f.period} onChange={e => set({ period: e.target.value as BudgetForm['period'] })}>
            {BUDGET_PERIODS.map(p => <option key={p} value={p}>{p[0].toUpperCase() + p.slice(1)}</option>)}
          </select>
        </Field>
        {input('b-amount', 'Amount', f.amount, v => set({ amount: v }), 'Excluding VAT, e.g. 100 or 99.50')}
        <ScopePreview form={f} />
        {input('b-currency', 'Currency', f.currency, v => set({ currency: v }), currencyHint(spend, f.provider))}
        <Field label="Thresholds" htmlFor="b-thresholds" hint="Comma-separated, e.g. 50, 80, 100" error={errorAt('b-thresholds')}>
          <div className="ne-row" style={{ flexWrap: 'nowrap' }}>
            <select aria-label="Threshold unit" className="ne-select" value={f.thresholdUnit} onChange={e => set({ thresholdUnit: e.target.value as BudgetForm['thresholdUnit'] })}>
              <option value="percent">% of amount</option>
              <option value="absolute">absolute</option>
            </select>
            <input id="b-thresholds" className="ne-input" value={f.thresholds} onChange={e => set({ thresholds: e.target.value })} aria-describedby={fieldMessageId('b-thresholds')} aria-invalid={errorAt('b-thresholds') ? 'true' : undefined} />
          </div>
        </Field>
        {f.provider === 'ai-cloud' ? (
          <>
            <p className="ne-faint" style={{ fontSize: 12, margin: 0 }}>Scope: leave every condition empty for all usage. With several, a row must match all of them.</p>
            {input('b-regions', 'Region condition', f.regions, v => set({ regions: v }), 'e.g. eu-north1')}
            <ProjectPicker selected={f.projects} onChange={projects => set({ projects })} error={errorAt('b-projects')} />
            {input('b-services', 'Service condition', f.services, v => set({ services: v }), 'e.g. Compute; Object Storage')}
            {input('b-products', 'Product condition', f.products, v => set({ products: v }), 'SKU ids or product names, separated by ;')}
          </>
        ) : null}
        {input('b-note', 'Note', f.note, v => set({ note: v }))}
      </>
    );
  } else if (editing.kind === 'credit') {
    const f = editing.form;
    const set = (patch: Partial<CreditInput>) => setEditing({ ...editing, form: { ...f, ...patch } });
    fields = (
      <>
        {input('c-name', 'Name', f.name, v => set({ name: v }), 'e.g. Token Factory promo credit')}
        <Field label="Provider" htmlFor="c-provider">
          <select id="c-provider" className="ne-select" value={f.provider} onChange={e => setEditing({ ...editing, form: withProvider(f, e.target.value as CreditInput['provider'], spend) })}>
            {SPEND_PROVIDERS.map(p => <option key={p} value={p}>{SPEND_PROVIDER_LABELS[p]}</option>)}
          </select>
        </Field>
        {input('c-amount', 'Amount', f.amount, v => set({ amount: v }))}
        {input('c-currency', 'Currency', f.currency, v => set({ currency: v }))}
        {input('c-applied', 'Applied on', f.appliedOn, v => set({ appliedOn: v }), undefined, 'date')}
        {input('c-expires', 'Expires on (optional)', f.expiresOn ?? '', v => set({ expiresOn: v || undefined }), 'Valid through the end of this day (UTC)', 'date')}
        {input('c-note', 'Note', f.note ?? '', v => set({ note: v || undefined }))}
      </>
    );
  } else {
    const f = editing.form;
    const set = (patch: Partial<SpendEntryInput>) => setEditing({ ...editing, form: { ...f, ...patch } });
    fields = (
      <>
        {input('s-date', 'Date (UTC)', f.date, v => set({ date: v }), undefined, 'date')}
        {input('s-amount', 'Spend that day', f.amount, v => set({ amount: v }), 'From the Token Factory Usage tab')}
        {input('s-currency', 'Currency', f.currency, v => set({ currency: v }))}
        {input('s-note', 'Note', f.note ?? '', v => set({ note: v || undefined }))}
      </>
    );
  }
  return (
    <form className="ne-stack" style={{ gap: 12 }} onSubmit={e => { e.preventDefault(); onSave(); }}>
      {fields}
      {wrong ? <Callout tone="danger">Not saved: {wrong === 1 ? '1 field needs' : `${wrong} fields need`} a fix.</Callout> : null}
      {error ? <Callout tone="danger" title="Not saved">{error}</Callout> : null}
      {replaces ? (
        <Callout tone="warn" title={`Spend for ${replaces.date} is already entered`}>
          {fmtMoney({ amount: replaces.amount, currency: replaces.currency })} entered by {replaces.createdBy}. The Usage tab shows one total a day: saving replaces that entry, it is not added to it.
        </Callout>
      ) : null}
      <div className="ne-row">
        <button type="submit" className="ne-btn">{replaces ? `Save (replaces the entry of ${replaces.date})` : 'Save'}</button>
      </div>
    </form>
  );
}

/** The project condition: the projects the caller can see, by name with the id on hover; none ticked is every project. */
function ProjectPicker({ selected, onChange, error }: { selected: string[]; onChange: (ids: string[]) => void; error?: string }) {
  const opts = useGet<FilterOptions>('/filters');
  const known = opts.data?.projects ?? [];
  // A stored id the caller no longer sees stays listed (by id), so editing never drops it silently.
  const projects = [...known, ...selected.filter(id => !known.some(p => p.id === id)).map(id => ({ id, name: id }))];
  const msgId = fieldMessageId('b-projects');
  return (
    <fieldset id="b-projects" tabIndex={-1} className="ne-field ne-checklist" data-invalid={error ? 'true' : undefined} aria-describedby={msgId}>
      <legend>Project condition</legend>
      {projects.length ? (
        projects.map(p => (
          <label key={p.id} className="ne-row" title={p.id}>
            <input
              type="checkbox"
              checked={selected.includes(p.id)}
              onChange={e => onChange(e.target.checked ? [...selected, p.id] : selected.filter(x => x !== p.id))}
            />
            {p.name}
          </label>
        ))
      ) : (
        <span className="ne-faint">{opts.loading ? 'Loading projects…' : 'No projects are visible to you.'}</span>
      )}
      {error ? (
        <div className="ne-field-error" role="alert" id={msgId}>{error}</div>
      ) : (
        <div className="ne-field-hint" id={msgId}>None ticked: every project.</div>
      )}
    </fieldset>
  );
}
