import { render, screen } from '@testing-library/react';
import { TrendChart } from './charts';

const gridLabels = (container: HTMLElement) => [...container.querySelectorAll('svg g[aria-hidden] > g > text')].map(t => t.textContent);

describe('TrendChart (#52, #33)', () => {
  it('counts get whole-number gridlines: 1 GPU reads 0 and 1, never 0.5', () => {
    const { container, unmount } = render(<TrendChart label="GPUs" valueLabel="GPUs" points={[{ day: '2026-10-10', value: 0 }, { day: '2026-10-11', value: 1 }]} />);
    expect(gridLabels(container)).toEqual(['0', '1']);
    unmount();
    const five = render(<TrendChart label="GPUs" valueLabel="GPUs" points={[{ day: '2026-10-10', value: 3 }, { day: '2026-10-11', value: 4 }]} />);
    expect(gridLabels(five.container)).toEqual(['0', '5']);
    five.unmount();
    const ten = render(<TrendChart label="GPUs" valueLabel="GPUs" points={[{ day: '2026-10-10', value: 8 }, { day: '2026-10-11', value: 9 }]} />);
    expect(gridLabels(ten.container)).toEqual(['0', '5', '10']);
  });

  it('keeps a fractional middle gridline for values that are not counts', () => {
    const { container } = render(<TrendChart label="Utilisation" valueLabel="%" max={100} points={[{ day: '2026-10-10', value: 12.5 }, { day: '2026-10-11', value: 40 }]} />);
    expect(gridLabels(container)).toEqual(['0', '50', '100']);
  });

  it('says there are no samples instead of drawing empty axes when no day has a value', () => {
    const { container } = render(<TrendChart label="Utilisation" valueLabel="%" max={100} points={[{ day: '2026-10-10', value: null }, { day: '2026-10-11', value: null }]} />);
    expect(container.querySelector('svg')).toBeNull();
    expect(screen.getByText('No samples in these days.')).toBeInTheDocument();
  });

  it('draws an incomplete day as a hollow point with its reason, in the table and the caption', () => {
    const { container } = render(
      <TrendChart
        label="GPUs"
        valueLabel="GPUs"
        points={[
          { day: '2026-10-10', value: 1 },
          { day: '2026-10-11', value: 1, note: 'Recorded incompletely: from GPU telemetry.' },
          { day: '2026-10-12', value: 2 },
        ]}
      />,
    );
    const hollow = container.querySelectorAll('circle[data-incomplete="true"]');
    expect(hollow).toHaveLength(1);
    expect(hollow[0].querySelector('title')?.textContent).toBe('2026-10-11: 1 · Recorded incompletely: from GPU telemetry.');
    expect(screen.getByRole('cell', { name: '1 (recorded incompletely)' })).toBeInTheDocument();
    expect(container.querySelector('figcaption')).toHaveTextContent('Hollow point: a day recorded incompletely (10-11).');
  });

  it('has no caption when every day is complete', () => {
    const { container } = render(<TrendChart label="GPUs" valueLabel="GPUs" points={[{ day: '2026-10-10', value: 1 }, { day: '2026-10-11', value: 1 }]} />);
    expect(container.querySelector('figcaption')).toBeNull();
    expect(container.querySelectorAll('circle[data-incomplete="true"]')).toHaveLength(0);
  });
});
