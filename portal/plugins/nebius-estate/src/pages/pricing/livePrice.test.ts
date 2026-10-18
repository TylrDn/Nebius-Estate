import type { LivePriceEstimate } from '@internal/nebius-domain';
import type { LivePriceState } from './livePrice';
import { ApiError } from '../../ui/api';
import { compareToList, contractStatus, failureState, liveHourly, mixedRunTotal, sharedReason, liveTotal, pendingState, priceBasis, priceBasisText, timesHours } from './livePrice';

const est = (over: Partial<LivePriceEstimate> = {}): LivePriceEstimate => ({
  source: 'Nebius billing calculator (list price)',
  offer: 'list',
  asOf: '2026-10-11T10:00:00.000Z',
  currency: 'XTS',
  projectId: 'project-e00mocka',
  contract: { attempted: false, available: null },
  lines: [{ key: 'vm:gpu', description: 'gpu', count: 2, hourly: { amount: '5.2', currency: 'XTS' }, skus: [] }],
  hourly: { amount: '5.2', currency: 'XTS' },
  unpriced: [],
  ...over,
});

describe('live price helpers', () => {
  it('never turns an all-unpriced estimate into a 0 figure', () => {
    const t = liveTotal(est({ lines: [{ key: 'o', description: 'object', count: 1, hourly: null, unit: 'gibibyte', skus: [] }], hourly: { amount: '0', currency: 'XTS' }, unpriced: ['object (priced per gibibyte)'] }));
    expect(t.hourly).toBeNull();
    expect(t.partial).toBe(false);
  });

  it('flags a partial hourly figure when components are unpriced', () => {
    const t = liveTotal(est({ unpriced: ['Public IPs'] }));
    expect(t.hourly?.amount).toBe('5.2');
    expect(t.partial).toBe(true);
  });

  it('shows the billing-group note unless the backend returned a contract price', () => {
    expect(contractStatus(est({ offer: 'contract', source: 'Nebius billing calculator (contract price)' }))).toEqual({ contract: true });
    const s = contractStatus(est({ contractNote: 'Contract prices need resource.billinggroup.get on the billing group: list prices shown.' }));
    expect(s.contract).toBe(false);
    expect(!s.contract && s.note).toMatch(/^Contract prices need billing-group access/);
  });

  it('compares only in the same currency', () => {
    expect(compareToList({ amount: '6.5', currency: 'XTS' }, { amount: '5.2', currency: 'XTS' })).toEqual({ kind: 'delta', delta: { amount: '1.3', currency: 'XTS' }, percent: '25.0' });
    expect(compareToList({ amount: '6.5', currency: 'USD' }, { amount: '5.2', currency: 'XTS' }).kind).toBe('na');
    expect(compareToList(undefined, { amount: '5.2', currency: 'XTS' }).kind).toBe('na');
    expect(compareToList({ amount: '1', currency: 'XTS' }, null).kind).toBe('na');
  });

  it('multiplies by hours exactly', () => {
    expect(timesHours({ amount: '5.2', currency: 'XTS' }, 8.25)).toEqual({ amount: '42.9', currency: 'XTS' });
  });

  it('separates permission from other failures, and keeps shown data while updating', () => {
    expect(failureState(new ApiError(403, 'prices need nebius.commercial.rate.read')).status).toBe('denied');
    expect(failureState(new ApiError(500, 'boom'))).toEqual({ status: 'error', message: 'boom' });
    expect(pendingState({ status: 'ready', response: { value: null, unavailableReason: 'x' } })).toEqual({ status: 'ready', response: { value: null, unavailableReason: 'x' }, updating: true });
    expect(pendingState({ status: 'error', message: 'x' })).toEqual({ status: 'loading' });
  });

  it('labels a contract price, and says "= list" only when the totals are equal', () => {
    expect(priceBasis(est())).toEqual({ label: 'list price' });
    const c = est({ offer: 'contract', source: 'Nebius billing calculator (contract price)' });
    expect(priceBasis({ ...c, listHourly: { amount: '5.20', currency: 'XTS' } })).toEqual({ label: 'contract price', sameAsList: true });
    expect(priceBasis({ ...c, listHourly: { amount: '6', currency: 'XTS' } })).toEqual({ label: 'contract price', sameAsList: false, listHourly: { amount: '6', currency: 'XTS' } });
    expect(priceBasis({ ...c, listHourly: { amount: '5.2', currency: 'USD' } })).toEqual({ label: 'contract price' });
    expect(priceBasisText({ ...c, listHourly: { amount: '5.2', currency: 'XTS' } }, m => m.amount)).toBe('contract price (= list)');
    expect(priceBasisText({ ...c, listHourly: { amount: '6', currency: 'XTS' } }, m => m.amount)).toBe('contract price (list 6 / h)');
  });

  it('an empty footprint is 0 per hour (F1.18), an unanswered one stays unknown', () => {
    expect(liveHourly({ status: 'ready', response: { value: null, unavailableReason: 'Empty footprint: nothing to price.', emptyFootprint: { currency: 'XTS' } } })).toEqual({ amount: '0', currency: 'XTS' });
    expect(liveHourly({ status: 'ready', response: { value: null, unavailableReason: 'No listed project' } })).toBeNull();
    expect(liveHourly({ status: 'ready', response: { value: est() } })).toEqual({ amount: '5.2', currency: 'XTS' });
    expect(liveHourly({ status: 'loading' })).toBeNull();
    expect(compareToList({ amount: '0.00', currency: 'XTS' }, liveHourly({ status: 'ready', response: { value: null, emptyFootprint: { currency: 'XTS' } } }))).toEqual({ kind: 'delta', delta: { amount: '0', currency: 'XTS' }, percent: null });
  });

  it('says a reason every footprint shares once (F1.17), and nothing when they differ or one is priced', () => {
    const bad: LivePriceState = { status: 'error', message: 'region: not a Nebius region id such as eu-north1' };
    const none: LivePriceState = { status: 'ready', response: { value: null, unavailableReason: 'No listed project is in eu-west2' } };
    expect(sharedReason([bad, bad, bad])).toBe('region: not a Nebius region id such as eu-north1');
    expect(sharedReason([none, none])).toBe('No listed project is in eu-west2');
    expect(sharedReason([bad])).toBeUndefined();
    expect(sharedReason([bad, none])).toBeUndefined();
    expect(sharedReason([bad, { status: 'ready', response: { value: est() } }])).toBeUndefined();
    expect(sharedReason([{ status: 'loading' }, { status: 'loading' }])).toBeUndefined();
  });

  it('G5.14: a per-run total over mixed hours weighs each priced line by its own hours, or is unknown', () => {
    const line = (key: string, amount: string | null) => ({ key, description: key, count: 1, hourly: amount === null ? null : { amount, currency: 'USD' }, skus: [] });
    const mixed = { lines: [line('vm:devlabs', '9.2'), line('vm:train', '70'), line('ssd', '0.5'), line('obj', null)], currency: 'USD' } as unknown as LivePriceEstimate;
    // 9.2 × 176 + 70 × 730 + 0.5 × 730
    expect(mixedRunTotal(mixed, { 'vm:devlabs': 176, 'vm:train': 730, ssd: 730 })).toEqual({ amount: '53084.2', currency: 'USD' });
    expect(mixedRunTotal(mixed, { 'vm:devlabs': 176, ssd: 730 })).toBeNull(); // a priced line without hours
  });
});
