import { budgetFormToInput, budgetToForm, creditStatusTone, budgetStatusTone, currencyHint, emptyBudgetForm, emptyCreditForm, emptySpendForm, partLabel, splitList, withProvider } from './model';

const NONE = { 'ai-cloud': null, 'token-factory': null };

describe('budgets page model', () => {
  it('turns the budget form into the API input, mirroring the console fields', () => {
    const f = { ...emptyBudgetForm(NONE), name: ' Lab ', amount: '100', thresholds: '50, 80,100', projects: ['project-e00a', 'project-e00b'], regions: '', services: 'Compute', products: '' };
    expect(budgetFormToInput(f)).toEqual({
      name: ' Lab ', provider: 'ai-cloud', period: 'monthly', amount: '100', currency: 'USD',
      thresholds: { unit: 'percent', values: ['50', '80', '100'] },
      scope: { regions: [], projects: ['project-e00a', 'project-e00b'], services: ['Compute'], products: [] },
    });
    expect(budgetFormToInput({ ...f, provider: 'token-factory' }).scope).toEqual({ regions: [], projects: [], services: [], products: [] });
  });

  it('round-trips a stored budget through the form', () => {
    const input = budgetFormToInput({ ...emptyBudgetForm(NONE), name: 'x', amount: '5', products: 'GPU hour; sku-1', note: 'n' });
    expect(budgetFormToInput(budgetToForm({ ...input, id: 'b', createdBy: 'u', updatedAt: '' } as any))).toEqual(input);
  });

  it('splits lists on commas, semicolons and spaces (products on commas and semicolons only)', () => {
    expect(splitList('a, b;c  d')).toEqual(['a', 'b', 'c', 'd']);
    expect(splitList('GPU hour; sku-1', true)).toEqual(['GPU hour', 'sku-1']);
  });

  it('maps statuses to tones and sources to labels', () => {
    expect(budgetStatusTone('over')).toBe('danger');
    expect(budgetStatusTone('at-threshold')).toBe('warn');
    expect(budgetStatusTone('no-data')).toBe('neutral');
    expect(creditStatusTone({ status: 'expiring', expiresOn: '2026-10-21' })).toBe('warn');
    // A used-up credit is not a neutral fact beside a red meter (G4.15).
    expect(creditStatusTone({ status: 'used-up' })).toBe('warn');
    // Never green without an expiry or a known draw (W1-P21, #36); running out soon is amber.
    expect(creditStatusTone({ status: 'ok' })).toBe('neutral');
    expect(creditStatusTone({ status: 'ok', expiresOn: '2027-01-01' })).toBe('ok');
    expect(creditStatusTone({ status: 'unverified' })).toBe('neutral');
    expect(creditStatusTone({ status: 'exhausting' })).toBe('warn');
    expect(partLabel({ kind: 'estimate' })).toBe('estimate');
    // Drawn from all spend because the export marks no row as credit-funded (G4.9).
    expect(partLabel({ kind: 'actual', assumed: true })).toBe('assumed: all spend');
    expect(partLabel({ kind: 'actual' })).toBe('actual');
  });
});

describe('the budget form starts in the spend currency (F1.7)', () => {
  const spend = { 'ai-cloud': 'XTS', 'token-factory': null };

  it('a new budget takes the currency AI Cloud spend is in; USD when none was seen', () => {
    expect(emptyBudgetForm(spend).currency).toBe('XTS');
    expect(emptyBudgetForm({ 'ai-cloud': null, 'token-factory': null }).currency).toBe('USD');
    expect(emptyBudgetForm(spend).projects).toEqual([]);
  });

  it('switching the provider follows its spend currency unless a currency was typed', () => {
    const f = emptyBudgetForm(spend);
    expect(withProvider(f, 'token-factory', spend)).toMatchObject({ provider: 'token-factory', currency: 'USD' });
    expect(withProvider({ ...f, currency: 'EUR' }, 'token-factory', spend).currency).toBe('EUR');
  });
});

describe('credits and spend entries start in the spend currency too (review of F1.7)', () => {
  const spend = { 'ai-cloud': 'XTS', 'token-factory': null };

  it('a new credit takes its provider\'s spend currency and follows the provider unless one was typed', () => {
    const c = emptyCreditForm(spend, '2026-10-12');
    expect(c).toMatchObject({ provider: 'token-factory', currency: 'USD', appliedOn: '2026-10-12', amount: '', name: '' });
    expect(withProvider(c, 'ai-cloud', spend).currency).toBe('XTS');
    expect(withProvider({ ...c, currency: 'EUR' }, 'ai-cloud', spend).currency).toBe('EUR');
    expect(emptySpendForm({ 'ai-cloud': null, 'token-factory': 'EUR' }, '2026-10-12')).toEqual({ provider: 'token-factory', date: '2026-10-12', amount: '', currency: 'EUR' });
  });

  it('the currency hint names the currency the spend is in', () => {
    expect(currencyHint(spend, 'ai-cloud')).toBe('Your Nebius AI Cloud spend is in XTS; a budget in another currency has no data (amounts are never converted).');
    expect(currencyHint(spend, 'token-factory')).toBeUndefined();
  });
});
