import { render, screen } from '@testing-library/react';
import type { LivePriceResponse } from '@internal/nebius-domain';
import { LivePricePanel } from './LivePricePanel';

const priced = (amount: string, capacity: 'on-demand' | 'preemptible', lines: [string, string][] = []): LivePriceResponse => ({
  value: {
    hourly: { amount, currency: 'USD' },
    lines: lines.map(([key, a]) => ({ key, description: key, count: 1, hourly: { amount: a, currency: 'USD' }, skus: [] })),
    unpriced: [],
    asOf: '2026-10-11T08:00:00Z',
    source: 'Nebius billing calculator (list price)',
    projectId: 'project-e00mocksandbox',
    offer: 'list',
    currency: 'USD',
    contract: { attempted: false, available: null },
    capacity: { type: capacity, text: capacity },
  } as any,
});

describe('live price panel', () => {
  it('G5.12: the capacity chip names every capacity type the tiles price, not only the first', () => {
    render(
      <LivePricePanel
        id="x"
        rows={[
          { key: 'on-demand', label: 'On-demand', state: { status: 'ready', response: priced('87.60', 'on-demand') } },
          { key: 'preemptible', label: 'Preemptible (spot now)', state: { status: 'ready', response: priced('25.20', 'preemptible') } },
        ]}
      />,
    );
    expect(screen.getByTestId('live-capacity')).toHaveTextContent('Capacity: on-demand · preemptible');
  });

  it('G5.14: items with different hours get a per-run total weighed per line', () => {
    render(
      <LivePricePanel
        id="x"
        rows={[{ key: 'on-demand', label: 'On-demand', lineHours: { 'vm:a': 176, 'vm:b': 730 }, state: { status: 'ready', response: priced('3', 'on-demand', [['vm:a', '1'], ['vm:b', '2']]) } }]}
      />,
    );
    expect(screen.getByText(/per run \(mixed hours\): 1,636\.00 USD/)).toBeInTheDocument();
  });
});
