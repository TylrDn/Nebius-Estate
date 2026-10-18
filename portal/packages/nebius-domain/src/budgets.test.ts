import { aggregateCosts, BudgetStatus, budgetStatus, countsAsSpend, SPEND_EXCLUDES, StoredBillingRecord } from './billing';
import { Decimal } from './decimal';
import {
  accountSummary,
  BudgetRecord,
  budgetInputSchema,
  BUDGET_RUNBOOK,
  budgetGlance,
  creditGlance,
  creditTone,
  budgetSignals,
  budgetCostsLink,
  CreditRecord,
  creditInputSchema,
  evaluateBudget,
  evaluateCredits,
  formIssues,
  periodWindow,
  projectionWarns,
  SpendContext,
  spendEntryInputSchema,
  SpendEntryRecord,
  trackedText,
} from './budgets';

const NOW = new Date('2026-10-11T12:00:00Z');

function rec(start: string, cost: string, o: Partial<StoredBillingRecord> = {}): StoredBillingRecord {
  const end = new Date(Date.parse(start) + 3_600_000).toISOString();
  return {
    key: `${start}|${cost}|${o.resourceId ?? ''}|${o.skuId ?? ''}`, slot: start, billingAccountId: 'customer-e00mock', billingPeriodStart: `${start.slice(0, 7)}-01T00:00:00.000Z`,
    billingPeriodEnd: '', chargePeriodStart: new Date(start).toISOString(), chargePeriodEnd: end, chargeCategory: 'Usage', chargeClass: '', chargeDescription: 'GPU hour',
    serviceName: 'Compute', serviceCategory: 'Compute', regionId: 'eu-north1', resourceId: 'computeinstance-e00mock', resourceName: 'vm', resourceType: 'computeinstance',
    skuId: 'sku-gpu', skuPriceId: '', pricingQuantity: '1', pricingUnit: 'h', containerId: 'project-e00mocka', containerName: 'a', tenantId: '', tenantName: '',
    projectId: 'project-e00mocka', projectName: 'a', trialId: '', contractPriceId: '', usageBasedDiscountIds: '', currency: 'USD',
    costs: { BilledCost: cost, EffectiveCost: cost, ListCost: cost, ContractedCost: cost }, tagsRaw: '', importId: 'i1', importedAt: '2026-10-11T08:00:00Z', ...o,
  };
}

const budget = (o: Partial<BudgetRecord> = {}): BudgetRecord => ({
  id: 'b1', createdBy: 'user:default/owner', updatedAt: '2026-10-10T00:00:00Z',
  ...budgetInputSchema.parse({ name: 'Monthly account', period: 'monthly', amount: '20', ...o }),
  ...o,
});

const ctx = (o: Partial<SpendContext> = {}): SpendContext => ({
  now: NOW,
  rows: [rec('2026-10-07T16:00:00Z', '4'), rec('2026-10-09T10:00:00Z', '4.75'), rec('2026-09-30T10:00:00Z', '100')],
  coverage: { earliestStart: '2026-09-30T10:00:00.000Z', latestEnd: '2026-10-11T06:00:00.000Z' },
  entries: [],
  ...o,
});

describe('budget and credit input', () => {
  it('validates a console-style budget and fills the documented defaults', () => {
    const b = budgetInputSchema.parse({ name: ' Lab ', period: 'quarterly', amount: '100' });
    expect(b).toMatchObject({ name: 'Lab', provider: 'ai-cloud', currency: 'USD', scope: { regions: [], projects: [], services: [], products: [] }, thresholds: { unit: 'percent', values: ['50', '80', '100'] } });
    expect(budgetInputSchema.safeParse({ name: 'x', period: 'weekly', amount: '1' }).success).toBe(false);
    expect(budgetInputSchema.safeParse({ name: 'x', period: 'daily', amount: '0' }).success).toBe(false);
    expect(budgetInputSchema.safeParse({ name: 'x', period: 'daily', amount: '1e3' }).success).toBe(false);
    expect(budgetInputSchema.safeParse({ name: 'x', period: 'daily', amount: '5', scope: { projects: ['not-a-project'] } }).success).toBe(false);
    // Conditions are console fields of AI Cloud budgets; a Token Factory budget has none.
    expect(budgetInputSchema.safeParse({ name: 'x', period: 'monthly', amount: '5', provider: 'token-factory', scope: { regions: ['eu-north1'] } }).success).toBe(false);
  });

  it('validates a credit: positive amount, a real applied date, expiry after it', () => {
    expect(creditInputSchema.parse({ name: 'Promo', provider: 'token-factory', amount: '25', appliedOn: '2026-10-11', expiresOn: '2026-11-10' })).toMatchObject({ currency: 'USD' });
    expect(creditInputSchema.safeParse({ name: 'Promo', provider: 'token-factory', amount: '25', appliedOn: '2026-10-11', expiresOn: '2026-10-10' }).success).toBe(false);
    expect(creditInputSchema.safeParse({ name: 'Promo', provider: 'token-factory', amount: '25', appliedOn: '2026-02-30' }).success).toBe(false);
    expect(spendEntryInputSchema.safeParse({ provider: 'token-factory', date: '2026-10-11', amount: '-1' }).success).toBe(false);
  });
});

describe('budget periods (00:00 UTC, calendar aligned, as in the console)', () => {
  it.each([
    ['daily', '2026-10-11T00:00:00.000Z', '2026-10-12T00:00:00.000Z'],
    ['monthly', '2026-10-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z'],
    ['quarterly', '2026-10-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z'],
    ['yearly', '2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z'],
  ] as const)('%s', (period, start, end) => {
    expect(periodWindow(period, NOW)).toEqual({ start, end });
  });
  it('a quarter starts on 1 January, April, July and October', () => {
    expect(periodWindow('quarterly', new Date('2026-05-15T00:00:00Z')).start).toBe('2026-04-01T00:00:00.000Z');
  });
});

describe('evaluateBudget', () => {
  it('sums the export rows of the current period only, labelled actual with their freshness', () => {
    const v = evaluateBudget(budget(), ctx());
    const actual = v.spend.parts.find(p => p.kind === 'actual')!;
    expect(actual).toMatchObject({ source: 'focus-export', amount: { amount: '8.75', currency: 'USD' }, asOf: '2026-10-11T06:00:00.000Z' });
    expect(v.window).toEqual({ start: '2026-10-01T00:00:00.000Z', end: '2026-11-01T00:00:00.000Z' });
    expect(v.spend.total.amount).toBe('8.75');
    expect(v.percent).toBe(43.8);
  });

  it('adds the live run-rate since the last exported hour as an estimate', () => {
    const v = evaluateBudget(budget(), ctx({ runRate: { hourly: { amount: '0.5', currency: 'USD' }, asOf: '2026-10-11T11:55:00Z', source: 'Nebius billing calculator (list price)' } }));
    const est = v.spend.parts.find(p => p.kind === 'estimate')!;
    // 06:00 → 12:00 = 6 h × 0.5
    expect(est).toMatchObject({ source: 'live-run-rate', amount: { amount: '3', currency: 'USD' } });
    expect(v.spend.total.amount).toBe('11.75');
  });

  it('says why no estimate was added', () => {
    expect(evaluateBudget(budget(), ctx({ runRateUnavailable: 'No rate: calculator not configured' })).notes.join(' ')).toMatch(/calculator not configured/);
    const scoped = evaluateBudget(budget({ scope: { regions: [], projects: [], services: ['Object Storage'], products: [] } }), ctx({ runRate: { hourly: { amount: '1', currency: 'USD' }, asOf: '', source: '' } }));
    expect(scoped.spend.parts.some(p => p.kind === 'estimate')).toBe(false);
    expect(scoped.notes.join(' ')).toMatch(/run-rate covers Compute/);
  });

  it('applies console scope conditions: all of them must match', () => {
    const rows = [rec('2026-10-08T00:00:00Z', '1'), rec('2026-10-08T01:00:00Z', '2', { regionId: 'uk-south1' }), rec('2026-10-08T02:00:00Z', '4', { projectId: 'project-e00mockb' }), rec('2026-10-08T03:00:00Z', '8', { serviceName: 'Object Storage', skuId: 'sku-storage', chargeDescription: 'Storage GiB-hour' })];
    const scoped = (scope: Partial<BudgetRecord['scope']>) => evaluateBudget(budget({ scope: { regions: [], projects: [], services: [], products: [], ...scope } }), ctx({ rows })).spend.total.amount;
    expect(scoped({})).toBe('15');
    expect(scoped({ regions: ['eu-north1'] })).toBe('13');
    expect(scoped({ regions: ['eu-north1'], projects: ['project-e00mocka'] })).toBe('9');
    expect(scoped({ services: ['object storage'] })).toBe('8');
    expect(scoped({ products: ['sku-storage'] })).toBe('8');
    expect(scoped({ products: ['GPU hour'] })).toBe('7');
  });

  it('leaves out tax rows (console budgets exclude VAT) and other currencies, and says so', () => {
    const v = evaluateBudget(budget(), ctx({ rows: [rec('2026-10-08T00:00:00Z', '5'), rec('2026-10-08T00:00:00Z', '1', { chargeCategory: 'Tax', skuId: 'tax' }), rec('2026-10-08T00:00:00Z', '9', { currency: 'EUR' })] }));
    expect(v.spend.total.amount).toBe('5');
    expect(v.notes.join(' ')).toMatch(/1 row\(s\) in other currencies/);
  });

  it('computes burn rate since the first exported hour and a period-end forecast', () => {
    const v = evaluateBudget(budget(), ctx({ rows: [rec('2026-10-07T12:00:00Z', '8'), rec('2026-10-10T12:00:00Z', '8')], coverage: { earliestStart: '2026-10-07T12:00:00.000Z', latestEnd: '2026-10-11T12:00:00.000Z' } }));
    // 16 over 4 days = 4/day; 20.5 days left → 16 + 82 = 98
    expect(v.burnRate?.perDay).toEqual({ amount: '4', currency: 'USD' });
    expect(v.forecast?.periodEnd).toEqual({ amount: '98', currency: 'USD' });
    expect(v.forecast?.overAmount).toBe(true);
  });

  it('forecasts two ways: at this period\'s average burn, and if nothing new runs (spend so far plus the live run-rate) (W1-P20)', () => {
    const rows = [rec('2026-10-07T12:00:00Z', '8'), rec('2026-10-10T12:00:00Z', '8')];
    const coverage = { earliestStart: '2026-10-07T12:00:00.000Z', latestEnd: '2026-10-11T12:00:00.000Z' };
    const v = evaluateBudget(budget(), ctx({ rows, coverage, runRate: { hourly: { amount: '1', currency: 'USD' }, asOf: '', source: 'calc' } }));
    // 16 spent; 4 a day over the 20.5 days left → 98. The inventory running now (1 USD/h) for the 492 h left → 508.
    expect(v.forecasts.averageBurn).toEqual({ periodEnd: { amount: '98', currency: 'USD' }, percent: 490, overAmount: true, text: 'at this period\'s average burn (4.00 USD a day)' });
    expect(v.forecasts.nothingNew).toEqual({ periodEnd: { amount: '508', currency: 'USD' }, percent: 2540, overAmount: true, text: 'if nothing new runs (1.00 USD / h running now)' });
    // Nothing running: the period ends at what was spent.
    const idle = evaluateBudget(budget(), ctx({ rows, coverage, runRateUnavailable: 'No running VMs, disks, filesystems or managed databases in scope to price.', nothingRunning: true }));
    expect(idle.forecasts.nothingNew).toMatchObject({ periodEnd: { amount: '16', currency: 'USD' }, text: 'if nothing new runs (nothing running now)' });
    // No run-rate: that line is withheld with the reason; the average burn still stands.
    const noRate = evaluateBudget(budget(), ctx({ rows, coverage, runRateUnavailable: 'Billing calculator unavailable' }));
    expect(noRate.forecasts.nothingNew).toEqual({ withheld: 'no live run-rate: Billing calculator unavailable' });
    expect('periodEnd' in noRate.forecasts.averageBurn).toBe(true);
    // Running resources the calculator could not price are not in the run-rate: the line and the estimate say so,
    // never a total that reads as everything running.
    const partialRate = { hourly: { amount: '1', currency: 'USD' }, asOf: '', source: 'calc', unpriced: 2 };
    const partial = evaluateBudget(budget(), ctx({ rows, coverage, runRate: partialRate }));
    expect(partial.forecasts.nothingNew).toMatchObject({ periodEnd: { amount: '508', currency: 'USD' }, text: 'if nothing new runs (1.00 USD / h running now; 2 running resources without a price are not in it)' });
    const est = evaluateBudget(budget(), ctx({ rows, coverage: { ...coverage, latestEnd: '2026-10-11T06:00:00.000Z' }, runRate: partialRate })).spend.parts.find(p => p.kind === 'estimate');
    expect(est?.note).toMatch(/2 running resources without a price are not in it/);
  });

  it('withholds a forecast with the reason when there is under a day of spend or no billing rows (W1-P20)', () => {
    const young = evaluateBudget(budget(), ctx({ rows: [rec('2026-10-11T06:00:00Z', '5')], coverage: { earliestStart: '2026-10-11T06:00:00.000Z', latestEnd: '2026-10-11T07:00:00.000Z' } }));
    expect(young.forecasts.averageBurn).toEqual({ withheld: 'less than a day of spend in this period (6 h)' });
    const none = evaluateBudget(budget(), ctx({ rows: [], coverage: {} }));
    expect(none.forecasts).toEqual({ averageBurn: { withheld: 'no billing export rows yet' }, nothingNew: { withheld: 'no billing export rows yet' } });
    const tf = evaluateBudget(budget({ provider: 'token-factory' }), ctx());
    expect(tf.forecasts.nothingNew).toEqual({ withheld: 'Token Factory has no run-rate: only the spend you enter' });
  });

  it('burns since the budget\'s first spend row, not since a month-long tax row at the start of the month (G4.3)', () => {
    // Live: a 0.00 Tax row charged 10-01 → 11-01 made the export's earliest start 10-01 00:00, while spend began 10-07 15:00.
    const tax = rec('2026-10-01T00:00:00Z', '0', { chargeCategory: 'Tax', skuId: 'tax', chargePeriodEnd: '2026-11-01T00:00:00.000Z' });
    const v = evaluateBudget(budget(), ctx({ rows: [tax, rec('2026-10-07T15:00:00Z', '8'), rec('2026-10-10T15:00:00Z', '8')], coverage: { earliestStart: '2026-10-01T00:00:00.000Z', latestEnd: '2026-10-11T12:00:00.000Z' } }));
    expect(v.burnRate?.since).toBe('2026-10-07T15:00:00.000Z');
    // 16 over 93 h, not over 10.5 days.
    expect(Number(v.burnRate!.perDay.amount)).toBeCloseTo((16 * 24) / 93, 6);
    // A budget scoped to one project burns from that project's first row.
    const b = evaluateBudget(budget({ scope: { regions: [], projects: ['project-e00mockb'], services: [], products: [] } }), ctx({ rows: [tax, rec('2026-10-07T15:00:00Z', '8'), rec('2026-10-09T12:00:00Z', '4', { projectId: 'project-e00mockb', containerId: 'project-e00mockb' })], coverage: { earliestStart: '2026-10-01T00:00:00.000Z', latestEnd: '2026-10-11T12:00:00.000Z' } }));
    expect(b.burnRate?.since).toBe('2026-10-09T12:00:00.000Z');
  });

  it('reports thresholds crossed and the status: ok, at threshold, over, no data', () => {
    expect(evaluateBudget(budget({ amount: '100' }), ctx()).status).toBe('ok');
    const at = evaluateBudget(budget({ amount: '16' }), ctx());
    expect(at.status).toBe('at-threshold');
    expect(at.thresholdStates.map(t => [t.value.amount, t.crossed])).toEqual([['8', 'actual'], ['12.8', false], ['16', false]]);
    expect(evaluateBudget(budget({ amount: '8' }), ctx()).status).toBe('over');
    expect(evaluateBudget(budget(), ctx({ rows: [], coverage: {} })).status).toBe('no-data');
    const abs = evaluateBudget(budget({ amount: '100', thresholds: { unit: 'absolute', values: ['5', '50'] } }), ctx());
    expect(abs.thresholdStates.map(t => t.crossed)).toEqual(['actual', false]);
  });

  it('a threshold crossed only once the estimate is added is marked as estimated, and only the projection is over (F1.47)', () => {
    const v = evaluateBudget(budget({ amount: '10', thresholds: { unit: 'percent', values: ['100'] } }), ctx({ runRate: { hourly: { amount: '1', currency: 'USD' }, asOf: '', source: 'calc' } }));
    expect(v.thresholdStates[0].crossed).toBe('estimate');
    expect(v.status).toBe('ok');
    expect(v.projection).toMatchObject({ over: true, text: 'Projected over the amount with the live estimate' });
  });

  it('a Token Factory budget counts the spend entered from the Token Factory Usage tab', () => {
    const entries: SpendEntryRecord[] = [
      { id: 'e1', provider: 'token-factory', date: '2026-10-10', amount: '1.25', currency: 'USD', createdBy: 'u', updatedAt: '' },
      { id: 'e2', provider: 'token-factory', date: '2026-09-29', amount: '9', currency: 'USD', createdBy: 'u', updatedAt: '' },
    ];
    const v = evaluateBudget(budget({ provider: 'token-factory' }), ctx({ entries }));
    expect(v.spend.parts).toEqual([expect.objectContaining({ source: 'token-factory-entries', kind: 'entered', amount: { amount: '1.25', currency: 'USD' }, asOf: '2026-10-10' })]);
  });
});

describe('evaluateCredits', () => {
  const credit = (o: Partial<CreditRecord> = {}): CreditRecord => ({
    id: 'c1', createdBy: 'u', updatedAt: '', ...creditInputSchema.parse({ name: 'Token Factory promo', provider: 'token-factory', amount: '25', appliedOn: '2026-10-01', expiresOn: '2026-10-21' }), ...o,
  });
  const tf = (date: string, amount: string): SpendEntryRecord => ({ id: date, provider: 'token-factory', date, amount, currency: 'USD', createdBy: 'u', updatedAt: '' });

  it('draws Token Factory spend against the credit, with remaining, burn and exhaustion date', () => {
    const [v] = evaluateCredits([credit()], ctx({ entries: [tf('2026-10-02', '3'), tf('2026-10-06', '2'), tf('2026-09-30', '50')] }));
    expect(v.used.total).toEqual({ amount: '5', currency: 'USD' });
    expect(v.remaining).toEqual({ amount: '20', currency: 'USD' });
    // 5 over 9.5 days since the first draw (2026-10-02 00:00 → now) ≈ 0.526/day: 20 left lasts ~38 days, beyond expiry
    expect(v.exhaustsOn).toBe('2026-11-18');
    expect(v.exhaustsBeforeExpiry).toBe(false);
    expect(v.daysToExpiry).toBe(10);
    expect(v.status).toBe('expiring');
    expect(v.statusText).toBe('Expires in 10 days');
  });

  it('the Overview glance lists each tracked credit, also when no budget exists (G1.18)', () => {
    const [unused] = evaluateCredits([credit({ expiresOn: undefined })], ctx({ entries: [tf('2026-10-02', '0')] }));
    expect(creditGlance([unused])).toEqual([{ key: 'c1', name: 'Token Factory promo', text: '25.00 USD of 25.00 USD left · no expiry entered', tone: 'neutral' }]);
    const [expiring] = evaluateCredits([credit()], ctx({ entries: [tf('2026-10-02', '3')] }));
    expect(creditGlance([expiring])[0]).toMatchObject({ text: '22.00 USD of 25.00 USD left · Expires in 10 days', tone: 'warn' });
  });

  it('AI Cloud credits draw the rows marked x_TrialId when the export marks any', () => {
    const rows = [rec('2026-10-07T16:00:00Z', '4', { trialId: 'trial-e00mock' }), rec('2026-10-08T16:00:00Z', '1')];
    const [v] = evaluateCredits([credit({ provider: 'ai-cloud', expiresOn: undefined })], ctx({ rows }));
    expect(v.used.total.amount).toBe('4');
    expect(v.used.parts[0].note).toMatch(/x_TrialId/);
    const [all] = evaluateCredits([credit({ provider: 'ai-cloud', expiresOn: undefined })], ctx({ rows: [rec('2026-10-08T16:00:00Z', '1')] }));
    expect(all.used.total.amount).toBe('1');
    expect(all.used.parts[0].note).toMatch(/marks no row/);
    expect(all.daysToExpiry).toBeNull();
  });

  it('an AI Cloud credit drawn from all spend (no row marked x_TrialId) says so on the page, not only in a tooltip (G4.9)', () => {
    const [all] = evaluateCredits([credit({ provider: 'ai-cloud', amount: '10', expiresOn: undefined })], ctx({ rows: [rec('2026-10-08T16:00:00Z', '12')] }));
    expect(all.status).toBe('used-up');
    expect(all.used.parts[0]).toMatchObject({ kind: 'actual', assumed: true });
    expect(all.notes.join(' ')).toMatch(/marks no row as credit-funded \(x_TrialId empty\)/);
    // Rows marked x_TrialId are what Nebius reports as credit-funded: not an assumption.
    const [marked] = evaluateCredits([credit({ provider: 'ai-cloud', expiresOn: undefined })], ctx({ rows: [rec('2026-10-07T16:00:00Z', '4', { trialId: 'trial-e00mock' })] }));
    expect(marked.used.parts[0].assumed).toBeUndefined();
    expect(marked.notes.join(' ')).not.toMatch(/marks no row/);
  });

  it('a credit without an expiry reads as active, with the missing date named and a grey tone, never green (G4.15, W1-P21)', () => {
    const [v] = evaluateCredits([credit({ expiresOn: undefined })], ctx({ entries: [tf('2026-10-02', '1')] }));
    expect([v.status, v.statusText]).toEqual(['ok', 'Active · no expiry entered']);
    expect(creditTone(v)).toBe('neutral');
    const [dated] = evaluateCredits([credit({ expiresOn: '2027-01-31' })], ctx({ entries: [tf('2026-10-02', '1')] }));
    expect(creditTone(dated)).toBe('ok');
  });

  it('a credit nothing was drawn from because no spend was entered is unverified: at most its amount, never green (#36)', () => {
    const [v] = evaluateCredits([credit({ expiresOn: undefined })], ctx());
    expect(v).toMatchObject({ status: 'unverified', statusText: 'Unverified: no spend entered', remainingAtMost: true, remaining: { amount: '25', currency: 'USD' } });
    expect(creditTone(v)).toBe('neutral');
    expect(creditGlance([v])).toEqual([{ key: 'c1', name: 'Token Factory promo', text: '≤ 25.00 USD of 25.00 USD left (no spend entered) · no expiry entered', tone: 'neutral' }]);
    // Spend entered before the credit applied does not verify it either.
    expect(evaluateCredits([credit({ expiresOn: undefined })], ctx({ entries: [tf('2026-09-30', '5')] }))[0].status).toBe('unverified');
    // An expiry warning still shows, with the remaining said as an upper bound.
    const [soon] = evaluateCredits([credit()], ctx());
    expect(soon).toMatchObject({ status: 'expiring', remainingAtMost: true });
    expect(budgetSignals({ budgets: [], credits: [soon] }, NOW)[0].title).toBe('Credit “Token Factory promo” expires in 10 days with up to 25 USD left');
    // AI Cloud: no export rows yet.
    const [cloud] = evaluateCredits([credit({ provider: 'ai-cloud', expiresOn: undefined })], ctx({ rows: [], coverage: {} }));
    expect(cloud).toMatchObject({ status: 'unverified', statusText: 'Unverified: no billing export rows', remainingAtMost: true });
    // AI Cloud: export rows exist, but none since the credit applied: still unverified, not "50 of 50 left" as measured.
    const [stale] = evaluateCredits(
      [credit({ provider: 'ai-cloud', amount: '50', expiresOn: undefined })],
      ctx({ rows: [rec('2026-09-10T10:00:00Z', '3')], coverage: { earliestStart: '2026-09-10T10:00:00.000Z', latestEnd: '2026-09-20T00:00:00.000Z' } }),
    );
    expect(stale).toMatchObject({ status: 'unverified', statusText: 'Unverified: no billing export rows since it applied', remainingAtMost: true, remaining: { amount: '50', currency: 'USD' } });
    expect(stale.notes.join(' ')).toMatch(/export ends 2026-09-20, before this credit applied on 2026-10-01/);
    // The account summary says the remaining figure is an upper bound.
    expect(accountSummary(ctx(), [], [v]).creditRemaining).toEqual([{ provider: 'token-factory', remaining: [{ amount: '25', currency: 'USD' }], atMost: true }]);
  });

  it('a credit the current burn uses up within 14 days is exhausting (amber), with its own signal (W1-P21)', () => {
    // 20 of 25 drawn over 9.5 days (≈ 2.1 a day): 5 left lasts about 2.4 days, before the expiry on 2026-10-21.
    const [v] = evaluateCredits([credit()], ctx({ entries: [tf('2026-10-02', '10'), tf('2026-10-06', '10')] }));
    expect(v.status).toBe('exhausting');
    expect(v.statusText).toBe(`Runs out about ${v.exhaustsOn} at the current burn`);
    expect(creditTone(v)).toBe('warn');
    const s = budgetSignals({ budgets: [], credits: [v] }, NOW);
    expect(s).toEqual([expect.objectContaining({ id: 'credit:c1:exhausting', kind: 'credit-exhausting', severity: 'critical', subject: { type: 'credit', id: 'c1', name: 'Token Factory promo', provider: 'token-factory' } })]);
    expect(s[0].title).toBe(`Credit “Token Factory promo” runs out about ${v.exhaustsOn} at the current burn (2.11 USD a day), 5.00 USD left`);
    expect(s[0].fix.runbook).toBe(BUDGET_RUNBOOK);
    // Less than a day of draws: no exhaustion warning from noise.
    const [young] = evaluateCredits([credit()], ctx({ entries: [tf('2026-10-11', '20')] }));
    expect(young.status).not.toBe('exhausting');
  });

  it('earlier credits of a provider draw first; a later one takes the rest', () => {
    const vs = evaluateCredits(
      [credit({ id: 'late', appliedOn: '2026-10-05', amount: '10' }), credit({ id: 'early', amount: '4' })],
      ctx({ entries: [tf('2026-10-06', '6')] }),
    );
    expect(Object.fromEntries(vs.map(v => [v.id, v.used.total.amount]))).toEqual({ early: '4', late: '2' });
    expect(vs.find(v => v.id === 'early')!.status).toBe('used-up');
  });

  it('marks expired and not yet started credits', () => {
    expect(evaluateCredits([credit({ appliedOn: '2026-09-01', expiresOn: '2026-09-30' })], ctx())[0].status).toBe('expired');
    expect(evaluateCredits([credit({ appliedOn: '2026-10-20', expiresOn: undefined })], ctx())[0].status).toBe('not-started');
  });
});

describe('budgetSignals', () => {
  it('raises threshold crossings and credit expiry within 14 days, each with a guided fix', () => {
    const budgets = [evaluateBudget(budget({ amount: '10' }), ctx()), evaluateBudget(budget({ id: 'b2', amount: '1000' }), ctx())];
    const credits = evaluateCredits(
      [
        { id: 'c1', createdBy: 'u', updatedAt: '', ...creditInputSchema.parse({ name: 'Promo', provider: 'token-factory', amount: '25', appliedOn: '2026-10-01', expiresOn: '2026-10-20' }) },
        { id: 'c2', createdBy: 'u', updatedAt: '', ...creditInputSchema.parse({ name: 'Far', provider: 'token-factory', amount: '25', appliedOn: '2026-10-01', expiresOn: '2027-01-20' }) },
      ],
      ctx(),
    );
    const s = budgetSignals({ budgets, credits }, NOW);
    // b1 (10 USD): 8.75 spent crosses 50 % and 80 %; its period-end forecast (≈ 25.8) also reaches 100 % (budget-forecast).
    expect(s.map(x => x.id)).toEqual(['budget:b1:threshold:50', 'budget:b1:threshold:80', 'budget:b1:forecast:100', 'credit:c1:expiry']);
    expect(s[0]).toMatchObject({ kind: 'budget-threshold', severity: 'warning', subject: { type: 'budget', id: 'b1' } });
    expect(s[3]).toMatchObject({ kind: 'credit-expiring', severity: 'warning' });
    for (const x of s) {
      expect(x.fix.runbook).toMatch(/^runbooks\/finance\.md#/);
      expect(x.fix.docs).toMatch(/^https:\/\/docs\.nebius\.com\//);
      expect(x.fix.checks.length).toBeGreaterThan(0);
    }
  });

  it('an amount crossed is critical; a credit already used up raises no expiry warning', () => {
    const s = budgetSignals({ budgets: [evaluateBudget(budget({ amount: '8', thresholds: { unit: 'percent', values: ['100'] } }), ctx())], credits: [] }, NOW);
    expect(s).toEqual([expect.objectContaining({ id: 'budget:b1:threshold:100', kind: 'budget-over', severity: 'critical' })]);
    const used = evaluateCredits([{ id: 'c', createdBy: 'u', updatedAt: '', ...creditInputSchema.parse({ name: 'x', provider: 'token-factory', amount: '1', appliedOn: '2026-10-01', expiresOn: '2026-10-15' }) }], ctx({ entries: [{ id: 'e', provider: 'token-factory', date: '2026-10-02', amount: '5', currency: 'USD', createdBy: 'u', updatedAt: '' }] }));
    expect(budgetSignals({ budgets: [], credits: used }, NOW)).toEqual([]);
  });
});

describe('budgetSignals: forecast', () => {
  // ctx(): 8.75 USD spent in October, burning since the period start (exports cover it): ≈ 0.83/day, ≈ 25.8 USD at month-end.
  it('warns when the period-end forecast crosses a threshold that spend to date has not, naming the highest one', () => {
    const b = evaluateBudget(budget({ amount: '20' }), ctx());
    expect(b.thresholdStates.every(t => !t.crossed)).toBe(true); // 8.75 of 20: below 50 %
    const s = budgetSignals({ budgets: [b], credits: [] }, NOW);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({
      id: 'budget:b1:forecast:100',
      kind: 'budget-forecast',
      severity: 'warning',
      subject: { type: 'budget', id: 'b1', name: 'Monthly account' },
      evidence: { value: b.forecast!.periodEnd, threshold: { amount: '20', currency: 'USD' }, basis: 'forecast' },
    });
    expect(s[0].title).toBe(`Budget “Monthly account” is forecast to reach 100 % by month-end (${Decimal.from(b.forecast!.periodEnd.amount).toFixed(2)} of 20.00 USD)`);
    expect(s[0].fix.meaning).toMatch(/burn rate/);
    expect(s[0].fix.meaning).toMatch(/not a charge/);
    expect(s[0].fix.checks.length).toBeGreaterThan(1);
    expect(s[0].fix.runbook).toBe(BUDGET_RUNBOOK);
    expect(s[0].fix.docs).toBe('https://docs.nebius.com/signup-billing/budgets#how-to-check-a-budget-status');
  });

  it('a forecast that reaches only a lower threshold is info; one under every open threshold raises nothing', () => {
    // 100 USD: thresholds 50 / 80 / 100; the forecast (8.75 USD since the first row, 2026-10-07 16:00, about 55.5 USD
    // at month-end; G4.3) reaches only the first.
    const s = budgetSignals({ budgets: [evaluateBudget(budget({ amount: '100' }), ctx())], credits: [] }, NOW);
    expect(s).toEqual([expect.objectContaining({ id: 'budget:b1:forecast:50', kind: 'budget-forecast', severity: 'info' })]);
    expect(budgetSignals({ budgets: [evaluateBudget(budget({ amount: '1000' }), ctx())], credits: [] }, NOW)).toEqual([]);
  });

  it('needs a day of spend before it forecasts, and says nothing once the amount is already spent', () => {
    const young = ctx({ rows: [rec('2026-10-11T06:00:00Z', '5')], coverage: { earliestStart: '2026-10-11T06:00:00.000Z', latestEnd: '2026-10-11T07:00:00.000Z' } });
    const b = evaluateBudget(budget({ amount: '20' }), young);
    expect(b.forecast?.overAmount).toBe(true); // 6 h of burn: a forecast exists, but it is too young to alert on
    expect(budgetSignals({ budgets: [b], credits: [] }, NOW).filter(x => x.kind === 'budget-forecast')).toEqual([]);
    const spent = budgetSignals({ budgets: [evaluateBudget(budget({ amount: '8', thresholds: { unit: 'percent', values: ['100'] } }), ctx())], credits: [] }, NOW);
    expect(spent.map(x => x.kind)).toEqual(['budget-over']);
  });
});

describe('accountSummary', () => {
  it('sums spend this month by source and remaining credit per provider, never across currencies', () => {
    const credits = evaluateCredits([{ id: 'c', createdBy: 'u', updatedAt: '', ...creditInputSchema.parse({ name: 'x', provider: 'token-factory', amount: '25', appliedOn: '2026-10-01' }) }], ctx());
    const s = accountSummary(ctx({ runRate: { hourly: { amount: '1', currency: 'USD' }, asOf: '', source: 'calc' } }), [], credits);
    expect(s.monthToDate.map(p => [p.source, p.amount.amount])).toEqual([['focus-export', '8.75'], ['live-run-rate', '6'], ['token-factory-entries', '0']]);
    expect(s.creditRemaining).toEqual([{ provider: 'token-factory', remaining: [{ amount: '25', currency: 'USD' }], atMost: true }]);
  });
});

describe('Open in Costs, scoped to the budget (W1-P23)', () => {
  it('links the period and the project and region it can express, and names the conditions Costs cannot apply', () => {
    const one = evaluateBudget(budget({ scope: { regions: ['eu-north1'], projects: ['project-e00mocka'], services: [], products: [] } }), ctx());
    expect(budgetCostsLink(one)).toEqual({ href: '/costs?project=project-e00mocka&region=eu-north1&from=2026-10-01&to=2026-11-01', notApplied: [] });
    const many = evaluateBudget(budget({ period: 'daily', scope: { regions: [], projects: ['project-e00mocka', 'project-e00mockb'], services: ['Compute'], products: [] } }), ctx());
    expect(budgetCostsLink(many)).toEqual({ href: '/costs?from=2026-10-11&to=2026-10-12', notApplied: ['2 projects (Costs filters one)', 'service Compute'] });
    expect(budgetCostsLink(evaluateBudget(budget({ provider: 'token-factory' }), ctx()))).toBeNull();
  });
});

describe('the projected line in words (#69)', () => {
  it('says nothing is running since the last exported hour, not a mid-sentence error', () => {
    const s = accountSummary(ctx({ runRateUnavailable: 'No running VMs, disks, filesystems or managed databases in scope to price.', nothingRunning: true }), [], []);
    expect(s.monthProjected).toBeNull();
    expect(s.projectedUnavailable).toBe('nothing running to estimate since 06:00 UTC');
    const other = accountSummary(ctx({ runRateUnavailable: 'Billing calculator unavailable: timeout' }), [], []);
    expect(other.projectedUnavailable).toBe('no live run-rate estimate: billing calculator unavailable: timeout');
  });
});

describe('one definition of spend for Overview, Costs and Budgets (F1.2)', () => {
  // The e2e FOCUS fixture's shape: usage, a tax row, a credit and an adjustment in one month.
  const rows = [
    rec('2026-10-07T12:00:00Z', '565.1744'),
    rec('2026-10-07T13:00:00Z', '12.40', { chargeCategory: 'Tax', resourceId: 'tax' }),
    rec('2026-10-07T14:00:00Z', '-5', { chargeCategory: 'Credit', resourceId: 'credit' }),
    rec('2026-10-07T15:00:00Z', '-1.25', { chargeCategory: 'Adjustment', resourceId: 'adj' }),
  ];

  it('leaves tax and credit rows out of spend, and says so in one phrase', () => {
    expect(rows.map(countsAsSpend)).toEqual([true, false, false, true]);
    expect(SPEND_EXCLUDES).toBe('excl. tax and credits');
  });

  it('gives the reported total and the spend budgets count side by side, and the spend equals the Budgets actual', () => {
    const report = aggregateCosts(rows, 'BilledCost', 'project');
    expect(report.totals).toEqual([{ amount: '571.3244', currency: 'USD' }]);
    expect(report.spendTotals).toEqual([{ amount: '563.9244', currency: 'USD' }]);
    const actual = accountSummary(ctx({ rows }), [], []).monthToDate.find(p => p.source === 'focus-export')!;
    expect(actual.amount).toEqual(report.spendTotals![0]);
    expect(actual.label).toBe(`FOCUS export, ${SPEND_EXCLUDES} (actual)`);
  });

  it('applies the same rule over any range: two months of rows give a larger spend than the month Budgets shows, equal over that month', () => {
    const twoMonths = [...rows, rec('2026-09-20T12:00:00Z', '40'), rec('2026-09-20T13:00:00Z', '3', { chargeCategory: 'Tax', resourceId: 'tax-sep' })];
    const all = aggregateCosts(twoMonths, 'BilledCost', 'project');
    expect(all.spendTotals).toEqual([{ amount: '603.9244', currency: 'USD' }]);
    const actual = accountSummary(ctx({ rows: twoMonths }), [], []).monthToDate.find(p => p.source === 'focus-export')!;
    expect(actual.amount).toEqual({ amount: '563.9244', currency: 'USD' });
    const october = aggregateCosts(twoMonths, 'BilledCost', 'project', { from: '2026-10-01T00:00:00.000Z', to: '2026-11-01T00:00:00.000Z' });
    expect(october.spendTotals).toEqual([actual.amount]);
  });
});

describe('per-project cost rows carry the Budgets rule beside them (F1.48)', () => {
  it('a project with a credit row: its row total includes the credit, its spend (what its budget counts) does not', () => {
    const rows = [
      rec('2026-10-07T12:00:00Z', '127.48'),
      rec('2026-10-07T14:00:00Z', '-5', { chargeCategory: 'Credit', resourceId: 'credit' }),
      rec('2026-10-07T15:00:00Z', '2', { projectId: 'project-e00mockb', containerId: 'project-e00mockb', projectName: 'b' }),
    ];
    const report = aggregateCosts(rows, 'BilledCost', 'project');
    const a = report.groups.find(g => g.key === 'project-e00mocka')!;
    expect(a.totals).toEqual([{ amount: '122.48', currency: 'USD' }]);
    expect(a.spendTotals).toEqual([{ amount: '127.48', currency: 'USD' }]);
    const projectBudget = evaluateBudget(budget({ amount: '1000', scope: { regions: [], projects: ['project-e00mocka'], services: [], products: [] } }), ctx({ rows }));
    expect(a.spendTotals![0]).toEqual(projectBudget.spend.actual);
    // A project with nothing left out carries no second figure.
    expect(report.groups.find(g => g.key === 'project-e00mockb')!.spendTotals).toBeUndefined();
  });
});

describe('spend and budgets honest (W1b)', () => {
  const rate = { hourly: { amount: '1', currency: 'USD' }, asOf: '', source: 'calc' };

  it('F1.6: the month headline is what was spent; the run-rate estimate is a separate projected line', () => {
    const s = accountSummary(ctx({ runRate: rate }), [], []);
    expect(s.monthSpent).toEqual([{ amount: '8.75', currency: 'USD' }]);
    expect(s.monthProjected).toEqual({ total: [{ amount: '14.75', currency: 'USD' }], estimate: [{ amount: '6', currency: 'USD' }] });
    const none = accountSummary(ctx({ runRateUnavailable: 'calculator not configured' }), [], []);
    expect(none.monthSpent).toEqual([{ amount: '8.75', currency: 'USD' }]);
    expect(none.monthProjected).toBeNull();
    expect(none.projectedUnavailable).toMatch(/calculator not configured/);
  });

  it('F1.6: entered Token Factory spend counts as spent, never added across currencies', () => {
    const entries: SpendEntryRecord[] = [{ id: 'e', provider: 'token-factory', date: '2026-10-10', amount: '2', currency: 'EUR', createdBy: 'u', updatedAt: '' }];
    expect(accountSummary(ctx({ entries }), [], []).monthSpent).toEqual([{ amount: '2', currency: 'EUR' }, { amount: '8.75', currency: 'USD' }]);
  });

  it('F1.7: a budget in a currency the spend is not in has no data (not 0 % and green), and says why', () => {
    const v = evaluateBudget(budget({ currency: 'EUR' }), ctx({ runRate: rate }));
    expect(v.status).toBe('no-data');
    expect(v.percent).toBeNull();
    expect(v.spend.parts).toEqual([]);
    expect(v.statusText).toBe('No data: spend is in USD, this budget in EUR');
    expect(v.notes.join(' ')).toMatch(/Spend in this scope is in USD; this budget is in EUR\. Edit the budget's currency to USD/);
    expect(budgetSignals({ budgets: [v], credits: [] }, NOW)).toEqual([]);
    const tf: SpendEntryRecord[] = [{ id: 'e', provider: 'token-factory', date: '2026-10-10', amount: '2', currency: 'USD', createdBy: 'u', updatedAt: '' }];
    expect(evaluateBudget(budget({ provider: 'token-factory', currency: 'EUR' }), ctx({ entries: tf })).status).toBe('no-data');
    // Some spend in the budget's currency: measured, the rest noted (unchanged).
    expect(evaluateBudget(budget(), ctx({ rows: [rec('2026-10-08T00:00:00Z', '5'), rec('2026-10-08T00:00:00Z', '9', { currency: 'EUR' })] })).status).toBe('ok');
  });

  it('F1.7: new budgets default to the currency the spend is in', () => {
    expect(accountSummary(ctx({ rows: [rec('2026-10-08T00:00:00Z', '5', { currency: 'XTS' })] }), [], []).spendCurrency).toEqual({ 'ai-cloud': 'XTS', 'token-factory': null });
    expect(accountSummary(ctx({ rows: [], coverage: {}, runRate: { ...rate, hourly: { amount: '1', currency: 'XTS' } } }), [], []).spendCurrency['ai-cloud']).toBe('XTS');
    const entries: SpendEntryRecord[] = [{ id: 'e', provider: 'token-factory', date: '2026-10-10', amount: '2', currency: 'USD', createdBy: 'u', updatedAt: '' }];
    expect(accountSummary(ctx({ rows: [], coverage: {}, entries }), [], []).spendCurrency).toEqual({ 'ai-cloud': null, 'token-factory': 'USD' });
  });

  it('F1.8: budget counts include the budgets from the configuration, named apart', () => {
    const config: BudgetStatus[] = [
      { id: 'sandbox-run', amount: '1500', currency: 'USD', period: '2026-10', scope: {}, source: 'test', reported: '3', percent: 0.2, state: 'under', statusText: '', basis: 'BilledCost', note: '' },
      { id: 'lab', amount: '10', currency: 'USD', period: '2026-10', scope: {}, source: 'test', reported: '9', percent: 90, state: 'near', statusText: '', basis: 'BilledCost', note: '' },
    ];
    const s = accountSummary(ctx(), [], [], config);
    expect(s.budgets).toEqual({ total: 2, entered: 0, fromConfig: 2, over: 0, atThreshold: 1, noData: 0 });
    expect(trackedText(s.budgets)).toBe('0 entered by you (2 from config)');
    expect(trackedText(accountSummary(ctx(), [evaluateBudget(budget(), ctx())], []).budgets)).toBe('1 entered by you');
  });
});

describe('budget, credit and spend forms in plain words (F1.9)', () => {
  it('names each wrong field once, in words, before anything is sent', () => {
    expect(formIssues('budget', { name: '', period: 'monthly', amount: '-5', currency: 'us', thresholds: { unit: 'percent', values: [] } })).toEqual({
      name: 'Enter a name (up to 80 characters).',
      amount: 'Enter an amount greater than 0, such as 100 or 99.50.',
      currency: 'Enter a three-letter currency code, such as USD.',
      thresholds: 'Enter 1 to 10 thresholds above 0, separated by commas, such as 50, 80, 100.',
    });
    expect(formIssues('budget', { name: 'x', period: 'monthly', amount: '5', scope: { regions: ['north'], projects: ['nope'] } })).toEqual({
      regions: 'Enter region ids such as eu-north1, separated by commas.',
      projects: 'Pick projects from the list.',
    });
    expect(formIssues('budget', { name: 'x', period: 'monthly', amount: '5' })).toEqual({});
    expect(formIssues('credit', { name: 'Promo', provider: 'token-factory', amount: '25', appliedOn: '2026-10-11', expiresOn: '2026-10-10' })).toEqual({ expiresOn: 'The expiry is before the applied date.' });
    expect(formIssues('credit', { name: 'Promo', provider: 'token-factory', amount: 'abc', appliedOn: '' })).toEqual({
      amount: 'Enter an amount greater than 0, such as 100 or 99.50.',
      appliedOn: 'Pick the date the credit applies from.',
    });
    expect(formIssues('spend', { provider: 'token-factory', date: '2026-10-11', amount: '' })).toEqual({ amount: 'Enter the spend of that day as 0 or more, such as 12.40.' });
    for (const text of Object.values(formIssues('budget', {}))) expect(text).not.toMatch(/expected|Too small|Invalid/);
  });
});

describe('review fixes: no-data budgets read the same on every page (F1.7)', () => {
  it('the spend currency comes from spend rows only (no superseded, tax or credit rows)', () => {
    const rows = [
      rec('2026-10-08T00:00:00Z', '5', { currency: 'XTS' }),
      rec('2026-10-09T00:00:00Z', '1', { currency: 'EUR', chargeCategory: 'Tax' }),
      rec('2026-10-09T01:00:00Z', '1', { currency: 'GBP', supersededBy: 'i2' } as Partial<StoredBillingRecord>),
    ];
    expect(accountSummary(ctx({ rows }), [], []).spendCurrency['ai-cloud']).toBe('XTS');
  });

  it('a config budget says why it has no data: another currency, or nothing reported yet', () => {
    const cfg = { id: 'usd', amount: '100', currency: 'USD', period: '2026-10', scope: {}, source: 'test' };
    const xts = budgetStatus(cfg, [rec('2026-10-08T00:00:00Z', '5', { currency: 'XTS' })]);
    expect(xts).toMatchObject({ state: 'no-data', percent: 0, statusText: 'No data: spend is in XTS, this budget in USD' });
    expect(budgetStatus(cfg, []).statusText).toBe('No spend reported for 2026-10 yet');
    expect(budgetStatus(cfg, [rec('2026-10-08T00:00:00Z', '50')]).statusText).toBe('Under 80 % of the amount');
  });

  it('a config budget says how fresh its figure is, as the other budget rows do (W1-P22): billing through the newest counted hour', () => {
    const cfg = { id: 'usd', amount: '100', currency: 'USD', period: '2026-10', scope: {}, source: 'test' };
    expect(budgetStatus(cfg, [rec('2026-10-08T00:00:00Z', '50'), rec('2026-10-09T05:00:00Z', '1'), rec('2026-10-10T00:00:00Z', '5', { currency: 'XTS' })]).billedThrough).toBe('2026-10-09T06:00:00.000Z');
    expect(budgetStatus(cfg, []).billedThrough).toBeUndefined();
  });

  it('the Overview glance: a no-data budget has no percent, the reason, and a neutral tone (entered and config)', () => {
    const c = ctx({ rows: [rec('2026-10-08T00:00:00Z', '5', { currency: 'XTS' })] });
    const usd = evaluateBudget(budget({ name: 'Dollar budget', amount: '100', currency: 'USD' }), c);
    const over = evaluateBudget(budget({ id: 'b2', name: 'Tiny', amount: '1', currency: 'XTS' }), c);
    const cfg = budgetStatus({ id: 'sandbox-run', amount: '1500', currency: 'USD', period: '2026-10', scope: {}, source: 'test' }, c.rows);
    const rows = budgetGlance({ budgets: [usd, over], configBudgets: [cfg] });
    expect(rows).toEqual([
      { key: 'b1', name: 'Dollar budget', percent: null, reason: 'No data: spend is in XTS, this budget in USD', amount: { amount: '100', currency: 'USD' }, tone: 'neutral' },
      { key: 'b2', name: 'Tiny', percent: over.percent, amount: { amount: '1', currency: 'XTS' }, tone: 'danger' },
      { key: 'config:sandbox-run', name: 'sandbox-run (config)', percent: null, reason: 'No data: spend is in XTS, this budget in USD', amount: { amount: '1500', currency: 'USD' }, tone: 'neutral' },
    ]);
    for (const r of rows) expect(r.reason ?? '').not.toMatch(/no spend reported/i);
  });
});

describe('budget Used is the actual; the projection is separate (F1.47)', () => {
  // One project, this month: 3.24 exported (actual) and a run-rate that adds 232.40 by now (estimate).
  const project = 'project-e00mocka';
  const rows = [rec('2026-10-05T00:00:00Z', '1.24'), rec('2026-10-08T00:00:00Z', '2')];
  const c = ctx({ rows, runRate: { hourly: { amount: '38.7333333333', currency: 'USD' }, asOf: '2026-10-11T11:55:00Z', source: 'calc' } });
  const entered = () => evaluateBudget(budget({ amount: '100', currency: 'USD', scope: { regions: [], projects: [project], services: [], products: [] } }), c);

  it('Used, the status and the thresholds count the actual only; the estimate never makes a budget over', () => {
    const v = entered();
    expect(v.spend.actual).toEqual({ amount: '3.24', currency: 'USD' });
    expect(v.percent).toBe(3.2);
    expect(v.status).toBe('ok');
    expect(v.statusText).toBe('Within every threshold');
    expect(v.thresholdStates.map(t => t.crossed)).toEqual(['estimate', 'estimate', 'estimate']);
  });

  it('the projection is its own figure: actual + estimate, its percent, and the thresholds it alone crosses', () => {
    const v = entered();
    expect(v.projection).toMatchObject({ estimate: { currency: 'USD' }, over: true });
    expect(Decimal.from(v.projection!.total.amount).toFixed(2)).toBe(Decimal.from(v.spend.total.amount).toFixed(2));
    expect(v.projection!.percent).toBeGreaterThan(100);
    expect(v.projection!.text).toMatch(/^Projected over the amount with the live estimate/);
    // Without a run-rate there is no projection.
    expect(evaluateBudget(budget({ amount: '100' }), ctx()).projection).toBeNull();
  });

  it('an entered budget and a config budget for the same project and month agree', () => {
    const v = entered();
    const cfg = budgetStatus({ id: 'lab', amount: '100', currency: 'USD', period: '2026-10', scope: { project }, source: 'test' }, rows);
    expect(v.percent).toBe(cfg.percent);
    expect(v.spend.actual.amount).toBe(cfg.reported);
    expect(budgetGlance({ budgets: [v], configBudgets: [cfg] }).map(r => [r.percent, r.tone])).toEqual([[3.2, 'ok'], [3.2, 'ok']]);
  });

  it('alerts: no threshold or over alert on the estimate; one projected alert, labelled, at warning', () => {
    const s = budgetSignals({ budgets: [entered()], credits: [] }, NOW);
    expect(s.filter(x => x.kind === 'budget-over' || x.kind === 'budget-threshold')).toEqual([]);
    const p = s.filter(x => x.kind === 'budget-projected');
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ id: 'budget:b1:projected:100', severity: 'warning', evidence: { basis: 'estimate', threshold: { amount: '100', currency: 'USD' } } });
    expect(p[0].title).toMatch(/projected to be over its amount with the live estimate/);
    expect(p[0].fix.meaning).toMatch(/not spend/);
    // An actual crossing keeps its alert, measured on the actual.
    const actualOver = budgetSignals({ budgets: [evaluateBudget(budget({ amount: '3', thresholds: { unit: 'percent', values: ['100'] } }), ctx({ rows }))], credits: [] }, NOW);
    expect(actualOver).toEqual([expect.objectContaining({ kind: 'budget-over', evidence: expect.objectContaining({ value: { amount: '3.24', currency: 'USD' }, basis: 'actual' }) })]);
    expect(p[0].fix.meaning).toMatch(/^Spent so far: /);
    expect(p[0].fix.meaning).not.toMatch(/export rows/);
  });

  it('a projection over the amount warns even without a threshold at 100 (thresholds 50/80, actual 85 %) (review)', () => {
    // amount 3.8: the actual 3.24 is 85 % (past 50 and 80); the estimate takes it over the amount, which no threshold names.
    const v = evaluateBudget(budget({ amount: '3.8', currency: 'USD', thresholds: { unit: 'percent', values: ['50', '80'] }, scope: { regions: [], projects: [project], services: [], products: [] } }), c);
    expect(v.status).toBe('at-threshold');
    expect(v.thresholdStates.map(t => t.crossed)).toEqual(['actual', 'actual']);
    expect(v.projection).toMatchObject({ over: true, text: 'Projected over the amount with the live estimate' });
    expect(projectionWarns(v)).toBe(true);
    const p = budgetSignals({ budgets: [v], credits: [] }, NOW).filter(x => x.kind === 'budget-projected');
    expect(p).toEqual([expect.objectContaining({ id: 'budget:b1:projected:amount', severity: 'warning', evidence: expect.objectContaining({ basis: 'estimate', threshold: { amount: '3.8', currency: 'USD' } }) })]);
    expect(p[0].title).toMatch(/projected to be over its amount with the live estimate/);
    // Already over on the actual: the over alert says it; no projected warning on top.
    const over = evaluateBudget(budget({ amount: '3', currency: 'USD', thresholds: { unit: 'percent', values: ['50'] }, scope: { regions: [], projects: [project], services: [], products: [] } }), c);
    expect(projectionWarns(over)).toBe(false);
    // Under every threshold and the amount with the estimate: nothing projected.
    const calm = evaluateBudget(budget({ amount: '100000', currency: 'USD', thresholds: { unit: 'percent', values: ['50'] }, scope: { regions: [], projects: [project], services: [], products: [] } }), c);
    expect(projectionWarns(calm)).toBe(false);
  });
});
