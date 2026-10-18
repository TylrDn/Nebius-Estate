import { stepStates } from './steps';

describe('provisioning stepper (G5.6)', () => {
  const base = { valid: true, estimate: false, livePriced: false, estimateUnavailable: false, created: false };

  it('counts Estimate done on a live price or a known "no rate book", not only on a rate-book estimate', () => {
    // Live today: no rate book, a live price on screen, Prepare enabled.
    expect(stepStates({ ...base, livePriced: true, estimateUnavailable: true }).slice(0, 5)).toEqual(['done', 'done', 'done', 'done', 'current']);
    expect(stepStates({ ...base, estimate: true })[3]).toBe('done');
    expect(stepStates({ ...base, livePriced: true })[3]).toBe('done');
  });

  it('keeps Estimate current while nothing is priced yet, and nothing past an invalid request', () => {
    expect(stepStates(base)[3]).toBe('current');
    expect(stepStates({ ...base, valid: false, livePriced: true }).slice(0, 4)).toEqual(['done', 'current', undefined, undefined]);
    expect(stepStates({ ...base, livePriced: true, created: true })[5]).toBe('current');
  });
});
