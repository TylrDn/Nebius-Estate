import { creditTone, SPEND_PROVIDER_LABELS } from '@internal/nebius-domain';
import type { AccountSummary, BudgetInput, BudgetRecord, BudgetState, CreditInput, CreditView, SpendEntryInput, SpendPart } from '@internal/nebius-domain';
import type { Tone } from '../ui';

/** The budget form as typed (lists as text), mirroring the console's Budgets wizard. */
export interface BudgetForm {
  name: string;
  provider: BudgetInput['provider'];
  period: BudgetInput['period'];
  amount: string;
  currency: string;
  thresholdUnit: 'percent' | 'absolute';
  thresholds: string;
  regions: string;
  /** Picked from the projects the caller can see. */
  projects: string[];
  services: string;
  products: string;
  note: string;
}

type SpendCurrency = AccountSummary['spendCurrency'];
const currencyOf = (spend: SpendCurrency, provider: BudgetForm['provider']) => spend[provider] ?? 'USD';

/** A new budget starts in the currency the provider's spend is in (amounts are never converted), USD when none was seen. */
export const emptyBudgetForm = (spend: SpendCurrency): BudgetForm => ({
  name: '', provider: 'ai-cloud', period: 'monthly', amount: '', currency: currencyOf(spend, 'ai-cloud'), thresholdUnit: 'percent', thresholds: '50, 80, 100',
  regions: '', projects: [], services: '', products: '', note: '',
});

/** A new credit (Token Factory by default) starts in its provider's spend currency, USD when none was seen. */
export const emptyCreditForm = (spend: SpendCurrency, appliedOn: string): CreditInput => ({
  name: '', provider: 'token-factory', amount: '', currency: currencyOf(spend, 'token-factory'), appliedOn,
});

/** A new Token Factory spend entry starts in the currency the earlier entries are in. */
export const emptySpendForm = (spend: SpendCurrency, date: string): SpendEntryInput => ({
  provider: 'token-factory', date, amount: '', currency: currencyOf(spend, 'token-factory'),
});

/** The Currency hint names the currency the provider's spend is in; none when no spend was seen. */
export const currencyHint = (spend: SpendCurrency, provider: BudgetForm['provider']): string | undefined =>
  spend[provider] ? `Your ${SPEND_PROVIDER_LABELS[provider]} spend is in ${spend[provider]}; a budget in another currency has no data (amounts are never converted).` : undefined;

/** Another provider: the currency follows its spend unless the owner typed one (budgets and credits). */
export const withProvider = <F extends { provider: BudgetForm['provider']; currency: string }>(f: F, provider: BudgetForm['provider'], spend: SpendCurrency): F => ({
  ...f,
  provider,
  currency: f.currency.trim().toUpperCase() === currencyOf(spend, f.provider) ? currencyOf(spend, provider) : f.currency,
});

/** Ids split on commas, semicolons and blanks; product names (which have spaces) on commas and semicolons only. */
export function splitList(text: string, names = false): string[] {
  return text.split(names ? /[,;]/ : /[,;\s]+/).map(x => x.trim()).filter(Boolean);
}

export function budgetFormToInput(f: BudgetForm): BudgetInput {
  const tf = f.provider === 'token-factory';
  return {
    name: f.name,
    provider: f.provider,
    period: f.period,
    amount: f.amount.trim(),
    currency: f.currency.trim().toUpperCase(),
    thresholds: { unit: f.thresholdUnit, values: splitList(f.thresholds) },
    scope: {
      regions: tf ? [] : splitList(f.regions),
      projects: tf ? [] : f.projects,
      services: tf ? [] : splitList(f.services, true),
      products: tf ? [] : splitList(f.products, true),
    },
    ...(f.note.trim() ? { note: f.note.trim() } : {}),
  };
}

export function budgetToForm(b: BudgetRecord): BudgetForm {
  return {
    name: b.name, provider: b.provider, period: b.period, amount: b.amount, currency: b.currency, thresholdUnit: b.thresholds.unit,
    thresholds: b.thresholds.values.join(', '), regions: b.scope.regions.join(', '), projects: [...b.scope.projects],
    services: b.scope.services.join('; '), products: b.scope.products.join('; '), note: b.note ?? '',
  };
}

export const budgetStatusTone = (s: BudgetState): Tone => ({ ok: 'ok', 'at-threshold': 'warn', over: 'danger', 'no-data': 'neutral' } as const)[s];
/** A used-up credit warns, as its red meter does (G4.15); green only with a known expiry, never when unverified (W1-P21, #36). */
export const creditStatusTone = (c: Pick<CreditView, 'status' | 'expiresOn'>): Tone => creditTone(c);
/** A figure that rests on an assumption says so (G4.9). */
export const partLabel = (p: Pick<SpendPart, 'kind' | 'assumed'>) => (p.assumed ? 'assumed: all spend' : ({ actual: 'actual', estimate: 'estimate', entered: 'entered by you' } as const)[p.kind]);
