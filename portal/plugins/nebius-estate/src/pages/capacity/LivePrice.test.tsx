import { render, screen } from '@testing-library/react';
import type { LivePriceResponse } from '@internal/nebius-domain';
import { LivePriceCell, LivePriceNote, livePricesView } from './LivePrice';

const priced = (amount: string): LivePriceResponse => ({
  value: { hourly: { amount, currency: 'USD' }, lines: [], unpriced: [], asOf: '2026-10-11T08:00:00Z', source: 'Nebius billing calculator', projectId: 'p', offer: 'list', contract: { attempted: false, available: null } } as any,
});

describe('calculator live prices', () => {
  it('never shows the previous footprint\'s prices: a changed footprint reads "pricing…" until its own reply', () => {
    const training = { body: 'training', results: { expected: priced('72.78') } };
    const view = livePricesView(training, 'soperator', true);
    expect(view).toEqual({ loading: true });
    render(<LivePriceCell prices={view} k="expected" />);
    expect(screen.getByText('pricing…')).toBeInTheDocument();
    expect(screen.queryByText(/72\.78/)).toBeNull();
  });
  it('shows the reply for the current footprint', () => {
    const view = livePricesView({ body: 'soperator', results: { expected: priced('1.93') } }, 'soperator', true);
    render(<LivePriceCell prices={view} k="expected" />);
    expect(screen.getByText('1.93 USD')).toBeInTheDocument();
  });
  it('says why there is no price, without raw validation text', () => {
    expect(livePricesView({}, 'x', false).reason).toMatch(/need nebius\.commercial/);
    expect(livePricesView({}, 'x', true, undefined, 'Enter whole numbers of nodes.')).toEqual({ loading: false, reason: 'Enter whole numbers of nodes.' });
  });
  it('shows cached figures for the same footprint while the fresh ones load, and says so', () => {
    const cache = { at: '2026-10-11T08:00:00Z', results: { expected: priced('72.78') } };
    const view = livePricesView({ body: 'training-old' }, 'training', true, undefined, undefined, cache);
    expect(view).toMatchObject({ loading: true, results: cache.results, cachedAt: cache.at });
    render(
      <>
        <LivePriceCell prices={view} k="expected" />
        <LivePriceNote prices={view} keys={['expected']} />
      </>,
    );
    expect(screen.getByText('72.78 USD')).toBeInTheDocument();
    expect(screen.getByText(/Cached figures from 2026-10-11 08:00 UTC; refreshing/)).toBeInTheDocument();
  });
  it('a cache never fills in for a failed or forbidden request', () => {
    const cache = { at: '2026-10-11T08:00:00Z', results: { expected: priced('72.78') } };
    expect(livePricesView({ body: 'training', error: 'boom' }, 'training', true, undefined, undefined, cache).results).toBeUndefined();
    expect(livePricesView({}, 'training', false, undefined, undefined, cache).results).toBeUndefined();
  });
});
