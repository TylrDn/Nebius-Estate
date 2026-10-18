import { fireEvent, render, screen } from '@testing-library/react';
import { DataTable, Drawer, Field, fieldMessageId, ProjectName, rowsBelowView, StatTile, visibleRowEdge } from './primitives';
import { fmtAgo, fmtMoney, fmtMoneyList } from '../format';

describe('StatTile', () => {
  it('shows Unavailable with the reason instead of a zero', () => {
    render(<StatTile label="GPU utilisation" metric={{ value: null, source: 'Prometheus', unavailableReason: 'No telemetry configured.' }} render={v => String(v)} now={new Date()} />);
    expect(screen.getByText('Unavailable')).toBeInTheDocument();
    expect(screen.getByText('No telemetry configured.')).toBeInTheDocument();
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });

  it('says an empty state plainly, without "Unavailable"', () => {
    render(<StatTile label="GPUs requested by pods" metric={{ value: null, source: 'Kubernetes', empty: 'No running Kubernetes cluster' }} render={v => String(v)} now={new Date()} />);
    expect(screen.getByText('No running Kubernetes cluster')).toBeInTheDocument();
    expect(screen.queryByText('Unavailable')).toBeNull();
  });

  it('renders a value with its source and age', () => {
    render(<StatTile label="GPUs" metric={{ value: 0, unit: 'GPUs', source: 'inventory', observedAt: '2026-10-10T11:00:00Z' }} render={v => String(v)} now={new Date('2026-10-10T12:00:00Z')} />);
    expect(screen.getByText('0')).toBeInTheDocument();
    // #60: the age is one no-wrap unit; its separating dot is drawn by CSS, so a wrapped age never starts with "·".
    const age = screen.getByText('1 h ago');
    expect(age).toHaveClass('ne-tile-age');
    expect(age.closest('.ne-tile-source')).toHaveTextContent('inventory1 h ago');
  });
});

describe('DataTable', () => {
  const rows = [{ id: 'b', n: 2 }, { id: 'a', n: 10 }];
  const cols = [
    { key: 'id', header: 'Id', render: (r: { id: string }) => r.id, sortValue: (r: { id: string }) => r.id },
    { key: 'n', header: 'N', render: (r: { n: number }) => r.n, sortValue: (r: { n: number }) => r.n },
  ];

  it('sorts by header and announces aria-sort', () => {
    render(<DataTable caption="t" rows={rows} rowKey={r => r.id} columns={cols as any} />);
    fireEvent.click(screen.getByRole('button', { name: /N/ }));
    expect(screen.getAllByRole('row').slice(1).map(r => r.textContent)).toEqual(['b2', 'a10']);
    expect(screen.getByRole('columnheader', { name: /N/ })).toHaveAttribute('aria-sort', 'ascending');
  });

  it('on a phone a stacked table sorts with a select, and its hidden header has no focusable buttons (W1F.S1)', () => {
    const original = window.matchMedia;
    window.matchMedia = ((q: string) => ({ matches: q === '(max-width: 600px)', addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia;
    try {
      const { container } = render(<DataTable caption="Rules" rows={rows} rowKey={r => r.id} columns={cols as any} stack />);
      expect(container.querySelectorAll('thead button')).toHaveLength(0);
      const select = screen.getByRole('combobox', { name: 'Sort Rules by' });
      expect([...(select as HTMLSelectElement).options].map(o => o.text)).toEqual(['Listed order', 'Id, A to Z', 'Id, Z to A', 'N, low to high', 'N, high to low']);
      fireEvent.change(select, { target: { value: 'n:desc' } });
      expect(screen.getAllByRole('row').slice(1).map(r => r.textContent)).toEqual(['a10', 'b2']);
      // A time column reads oldest / newest, not "A to Z" (G1.12).
      const timed = [{ key: 'seen', header: 'Observed', render: (r: { id: string }) => r.id, sortValue: (r: { id: string }) => r.id, sortKind: 'time' }];
      render(<DataTable caption="Seen" rows={rows} rowKey={r => r.id} columns={timed as any} stack />);
      expect([...(screen.getByRole('combobox', { name: 'Sort Seen by' }) as HTMLSelectElement).options].map(o => o.text)).toEqual(['Listed order', 'Observed, oldest first', 'Observed, newest first']);
      expect(screen.getByRole('columnheader', { name: /N/ })).toHaveAttribute('aria-sort', 'descending');
      // A column may name its two orders itself (G3.10: severity read "low to high" while listing critical first).
      const ranked = [{ key: 'sev', header: 'Severity', render: (r: { id: string }) => r.id, sortValue: () => 0, sortLabels: ['most severe first', 'least severe first'] }];
      render(<DataTable caption="Ranked" rows={rows} rowKey={r => r.id} columns={ranked as any} stack />);
      expect([...(screen.getByRole('combobox', { name: 'Sort Ranked by' }) as HTMLSelectElement).options].map(o => o.text)).toEqual(['Listed order', 'Severity, most severe first', 'Severity, least severe first']);
    } finally {
      window.matchMedia = original;
    }
  });

  it('on a wide screen the header buttons sort and no select is shown (W1F.S1)', () => {
    render(<DataTable caption="Rules" rows={rows} rowKey={r => r.id} columns={cols as any} stack />);
    expect(screen.queryByRole('combobox', { name: 'Sort Rules by' })).toBeNull();
    expect(screen.getAllByRole('button', { name: /Id|N/ }).length).toBeGreaterThan(0);
  });

  it('can stack into labelled cards on a phone: each cell carries its column name', () => {
    render(<DataTable caption="t" rows={rows} rowKey={r => r.id} columns={cols as any} stack />);
    expect(screen.getByRole('table')).toHaveClass('ne-table-stack');
    expect(screen.getAllByRole('cell')[1]).toHaveAttribute('data-label', 'N');
  });

  it('stacks by default from 4 columns; a narrower table, or stack={false}, scrolls sideways', () => {
    const four = ['a', 'b', 'c', 'd'].map(k => ({ key: k, header: k.toUpperCase(), render: (r: { id: string }) => `${k}${r.id}` }));
    const { unmount } = render(<DataTable caption="t" rows={rows} rowKey={r => r.id} columns={four as any} />);
    expect(screen.getByRole('table')).toHaveClass('ne-table-stack');
    expect(screen.getAllByRole('cell')[3]).toHaveAttribute('data-label', 'D');
    unmount();
    const { unmount: u2 } = render(<DataTable caption="t" rows={rows} rowKey={r => r.id} columns={four as any} stack={false} />);
    expect(screen.getByRole('table')).not.toHaveClass('ne-table-stack');
    u2();
    render(<DataTable caption="t" rows={rows} rowKey={r => r.id} columns={cols as any} />);
    expect(screen.getByRole('table')).not.toHaveClass('ne-table-stack');
  });

  it('gives a long table without its own height a viewport-high box, so its header stays in view', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ id: `r${i}`, n: i }));
    const { unmount } = render(<DataTable caption="long" rows={many} rowKey={r => r.id} columns={cols as any} />);
    expect(screen.getByRole('region', { name: 'long' })).toHaveClass('ne-table-wrap-tall');
    unmount();
    render(<DataTable caption="boxed" rows={many} rowKey={r => r.id} columns={cols as any} maxHeight={300} />);
    expect(screen.getByRole('region', { name: 'boxed' })).not.toHaveClass('ne-table-wrap-tall');
  });

  it('counts only the rows wholly below a scrolling box\'s edge, for the "N more" cue (F1.20, F1.50)', () => {
    // Row tops in px against the box's visible bottom: a row cut by the edge is partly seen, so it is not counted.
    expect(rowsBelowView([0, 40, 80, 120, 160], 130)).toBe(1);
    expect(rowsBelowView([0, 40, 80, 120, 160], 120)).toBe(2); // a row starting on the edge is not seen
    expect(rowsBelowView([0, 40, 80], 120)).toBe(0);
    expect(rowsBelowView([0, 40, 119.4], 120)).toBe(1); // under 1 px on screen is not seen
    expect(rowsBelowView([0, 40, 118], 120)).toBe(0);
    // 25 stacked rule cards, the first partly on screen above the cue: 24 more, not 25 (F1.50).
    expect(rowsBelowView(Array.from({ length: 25 }, (_, i) => 700 + i * 300), 816)).toBe(24);
    expect(rowsBelowView([], 100)).toBe(0);
  });

  it('counts against the cue when it holds at the foot of the screen over a box taller than the screen (F1.20 review)', () => {
    // Box bottom 985 px, cue held at 872 px (a 900 px screen): rows under the cue are not seen.
    expect(visibleRowEdge(985, 872)).toBe(872);
    // The cue in its own place, under the box: the box's edge counts.
    expect(visibleRowEdge(600, 601)).toBe(600);
    // No cue (the box does not scroll): the box's edge.
    expect(visibleRowEdge(600, undefined)).toBe(600);
  });

  it('activates rows from the keyboard', () => {
    const onRow = jest.fn();
    render(<DataTable caption="t" rows={rows} rowKey={r => r.id} columns={cols as any} onRowClick={onRow} />);
    const row = screen.getAllByRole('row')[1];
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(onRow).toHaveBeenCalledWith(rows[0]);
  });

  it('puts one row in the tab order and moves between rows with the arrow keys', () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ id: `r${i}`, n: i }));
    render(<DataTable caption="t" rows={many} rowKey={r => r.id} columns={cols as any} onRowClick={() => undefined} selectedKey="r2" />);
    const body = screen.getAllByRole('row').slice(1);
    expect(body.map(r => r.getAttribute('tabindex'))).toEqual(['-1', '-1', '0', '-1', '-1']);
    body[2].focus();
    fireEvent.keyDown(body[2], { key: 'ArrowDown' });
    expect(body[3]).toHaveFocus();
    fireEvent.keyDown(body[3], { key: 'Home' });
    expect(body[0]).toHaveFocus();
  });
});

describe('Field', () => {
  it('links its input to the error message (aria-describedby) and marks it invalid', () => {
    render(
      <Field label="Owner" htmlFor="f-owner" error="Enter the owning team">
        <input id="f-owner" />
      </Field>,
    );
    const input = screen.getByLabelText('Owner');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('Enter the owning team');
  });

  it('links the hint when there is no error, keeps an existing description and leaves aria-invalid off', () => {
    render(
      <>
        <span id="extra">extra</span>
        <Field label="Ref" htmlFor="f-ref" hint="Ticket, date or run id">
          <input id="f-ref" aria-describedby="extra" />
        </Field>
      </>,
    );
    const input = screen.getByLabelText('Ref');
    expect(input).not.toHaveAttribute('aria-invalid');
    expect(input).toHaveAccessibleDescription('extra Ticket, date or run id');
  });

  it('exposes the message id for an input nested deeper than the field child', () => {
    render(
      <Field label="Budget" htmlFor="f-b" error="Enter an amount">
        <div>
          <input id="f-b" aria-describedby={fieldMessageId('f-b')} />
        </div>
      </Field>,
    );
    expect(screen.getByLabelText('Budget')).toHaveAccessibleDescription('Enter an amount');
  });
});

describe('Drawer', () => {
  it('sets an id subtitle in monospace and prose in the text font (G4.15)', () => {
    const { rerender } = render(<Drawer open title="VM" subtitle="computeinstance-e00mock" onClose={() => undefined}>x</Drawer>);
    expect(screen.getByText('computeinstance-e00mock')).toHaveClass('ne-mono');
    rerender(<Drawer open title="Add credit" subtitle="Entered by you; stored in the portal database." mono={false} onClose={() => undefined}>x</Drawer>);
    expect(screen.getByText('Entered by you; stored in the portal database.')).not.toHaveClass('ne-mono');
  });

  it('the body scrolls with the keyboard: a tab stop named by the drawer title, even with nothing focusable inside (#40)', () => {
    render(<Drawer open title="nip-sandbox-state" onClose={() => undefined}>plain text, no link or button</Drawer>);
    const body = screen.getByRole('region', { name: 'nip-sandbox-state' });
    expect(body).toHaveClass('ne-drawer-body');
    expect(body).toHaveAttribute('tabindex', '0');
  });

  it('keeps focus where the user put it when the parent re-renders', () => {
    const view = (n: number) => (
      <Drawer open title="Doc" onClose={() => n}>
        <button type="button">inside {n}</button>
      </Drawer>
    );
    const { rerender } = render(view(1));
    screen.getByRole('button', { name: 'inside 1' }).focus();
    rerender(view(2)); // a new inline onClose, as every caller passes
    expect(screen.getByRole('button', { name: 'inside 2' })).toHaveFocus();
  });

  it('returns focus to the opener when it closes, or to the page heading when it was opened from a link', () => {
    const opener = (open: boolean) => (
      <div>
        <h1 tabIndex={-1}>Page</h1>
        <button type="button">Read</button>
        <Drawer open={open} title="Doc" onClose={() => undefined}>
          x
        </Drawer>
      </div>
    );
    const { rerender } = render(opener(false));
    screen.getByRole('button', { name: 'Read' }).focus();
    rerender(opener(true));
    rerender(opener(false));
    expect(screen.getByRole('button', { name: 'Read' })).toHaveFocus();

    (document.activeElement as HTMLElement).blur(); // a deep link: nothing had focus
    rerender(opener(true));
    rerender(opener(false));
    expect(screen.getByRole('heading', { name: 'Page' })).toHaveFocus();
  });

  it('closes on Escape with the latest handler', () => {
    const first = jest.fn();
    const latest = jest.fn();
    const { rerender } = render(<Drawer open title="Doc" onClose={first}>x</Drawer>);
    rerender(<Drawer open title="Doc" onClose={latest}>x</Drawer>);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(latest).toHaveBeenCalled();
    expect(first).not.toHaveBeenCalled();
  });
});

describe('format', () => {
  it('formats money with sign, grouping and explicit currency', () => {
    expect(fmtMoney({ amount: '-1234.5', currency: 'XTS' })).toBe('−1,234.50 XTS');
    expect(fmtMoneyList([{ amount: '1', currency: 'EUR' }, { amount: '2', currency: 'USD' }])).toBe('1.00 EUR + 2.00 USD');
  });
  it('formats relative time against the portal clock', () => {
    expect(fmtAgo('2026-10-10T20:00:00Z', new Date('2026-10-10T12:00:00Z'))).toBe('in 8 h');
  });
  it('uses the domain rounding rule (whole units), so "N h ago" matches the export lag in hours', () => {
    // exportedThrough 1 h 40 min ago: lag 1 h, and "1 h ago" (not "2 h ago").
    expect(fmtAgo('2026-10-10T10:20:00Z', new Date('2026-10-10T12:00:00Z'))).toBe('1 h ago');
    expect(fmtAgo('2026-10-10T11:58:20Z', new Date('2026-10-10T12:00:00Z'))).toBe('1 min ago');
  });
});

describe('charts', () => {
  it('rounds axis maxima to readable values', () => {
    const { niceMax } = require('./charts');
    expect([niceMax(0), niceMax(7), niceMax(13), niceMax(240), niceMax(784.5)]).toEqual([1, 10, 20, 250, 1000]);
  });

  it('leaves a gap for a day without rows in a column chart', () => {
    const { ColumnChart } = require('./charts');
    const { container } = render(
      <ColumnChart label="c" valueLabel="v" points={[{ label: '2026-10-01', value: 1, display: '1' }, { label: '2026-10-02', value: null, display: 'no rows' }, { label: '2026-10-03', value: 2, display: '2' }]} />,
    );
    expect(container.querySelectorAll('rect')).toHaveLength(2);
    expect(screen.getByText('no rows')).toBeInTheDocument();
  });

  it('labels the middle gridline exactly: 2.5, never "3", and 12.5 on live GPU data (G4.4)', () => {
    const { ColumnChart } = require('./charts');
    const axis = (max: number) => {
      const { container, unmount } = render(<ColumnChart label="c" valueLabel="v" points={[{ label: '2026-10-07', value: max, display: String(max) }]} />);
      const labels = [...container.querySelectorAll('svg g[aria-hidden] > g > text')].map(t => t.textContent);
      unmount();
      return labels;
    };
    expect(axis(4.2)).toEqual(['0', '2.5', '5']);
    expect(axis(24)).toEqual(['0', '12.5', '25']);
    expect(axis(80)).toEqual(['0', '50', '100']);
    expect(axis(0.22)).toEqual(['0', '0.125', '0.25']);
  });

  it('draws at the width it is given, so a phone keeps 11 px labels and fewer day ticks (G4.11)', () => {
    const { ColumnChart } = require('./charts');
    const RO = (global as any).ResizeObserver;
    (global as any).ResizeObserver = class {
      constructor(private cb: (e: { contentRect: { width: number } }[]) => void) {}
      observe() {
        this.cb([{ contentRect: { width: 260 } }]);
      }
      disconnect() {}
    };
    try {
      const points = Array.from({ length: 12 }, (_, i) => ({ label: `2026-10-${String(i + 1).padStart(2, '0')}`, value: i, display: String(i) }));
      const { container } = render(<ColumnChart label="c" valueLabel="v" points={points} />);
      const svg = container.querySelector('svg')!;
      expect(svg.getAttribute('viewBox')).toBe('0 0 260 170');
      expect(svg.querySelector('g[aria-hidden]')!.getAttribute('font-size')).toBe('11');
      const dayTicks = [...svg.querySelectorAll('g[aria-hidden] > text')];
      expect(dayTicks.length).toBeLessThanOrEqual(4);
    } finally {
      (global as any).ResizeObserver = RO;
    }
  });

  it('keeps missing days as gaps in trends', () => {
    const { TrendChart } = require('./charts');
    const { container } = render(
      <TrendChart label="t" valueLabel="v" points={[{ day: '2026-10-01', value: 1 }, { day: '2026-10-02', value: null }, { day: '2026-10-04', value: 3 }]} />,
    );
    expect(container.querySelectorAll('path')).toHaveLength(2); // two separate segments
    expect(screen.getAllByText('not observed')).toHaveLength(2); // 10-02 null and 10-03 absent
  });
});

describe('ProjectName (F1.5)', () => {
  it('shows the project name, with the id on hover; an unknown project shows its id', () => {
    const { rerender } = render(<ProjectName id="project-e00mocksandbox" names={id => ({ 'project-e00mocksandbox': 'nip-sandbox' })[id]} />);
    expect(screen.getByText('nip-sandbox')).toHaveAttribute('title', 'project-e00mocksandbox');
    expect(screen.queryByText('project-e00mocksandbox')).not.toBeInTheDocument();
    rerender(<ProjectName id="project-e00other" names={() => undefined} />);
    expect(screen.getByText('project-e00other')).not.toHaveAttribute('title');
  });
});
