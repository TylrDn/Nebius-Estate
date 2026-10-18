import { restartedStates } from './useFootprintLivePrices';

const ready = { status: 'ready' as const, response: { value: null, unavailableReason: 'x' } };

describe('footprint live prices while inputs change', () => {
  it('a changed footprint drops the previous prices (loading), never shows them as current', () => {
    expect(restartedStates({ min: ready, expected: ready, max: ready }, false)).toEqual({ min: { status: 'loading' }, expected: { status: 'loading' }, max: { status: 'loading' } });
  });
  it('a retry of the same footprint keeps them on screen, marked as updating', () => {
    expect(restartedStates({ min: ready, expected: ready, max: ready }, true).expected).toEqual({ ...ready, updating: true });
  });
});
