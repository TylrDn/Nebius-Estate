import { render, screen } from '@testing-library/react';
import type { LogsResponse } from '@internal/nebius-domain';
import { Results } from './LogResults';

const Q = '{__bucket__="sp_serial"}';
const resp = (over: Partial<LogsResponse> = {}): LogsResponse => ({
  project: 'project-e00mocksandbox', bucket: 'sp_serial', query: Q, start: '2026-10-12T14:00:00.000Z', end: '2026-10-12T15:00:00.000Z',
  lines: [{ ts: '1', time: '2026-10-12T14:59:00.123Z', line: 'old line', labels: {} }], limit: 1000, truncated: false, bucketState: 'ok',
  source: 'Nebius Observability Logs (Loki read API)', observedAt: '2026-10-12T15:00:00.000Z', ...over,
});
const load = (data: LogsResponse | undefined, loading: boolean) => ({ data, loading, reload: () => undefined }) as any;

describe('log results', () => {
  it('mark the previous result as being replaced while a new query reads (G3.6)', () => {
    const { container } = render(<Results logs={load(resp(), true)} valid query={Q} />);
    expect(screen.getByText('Reading logs…')).toBeInTheDocument();
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(container.querySelector('.ne-logs-stale')).not.toBeNull();
    expect(screen.queryByText(/1 line ·/)).toBeNull();
  });

  it('treat a result of another query as stale before its request starts (G3.6)', () => {
    const { container } = render(<Results logs={load(resp(), false)} valid query='{__bucket__="sp_mk8s_control_plane"}' />);
    expect(screen.getByText('Reading logs…')).toBeInTheDocument();
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  it('show a failed new query over the last result, not as reading', () => {
    const logs = { ...load(resp(), false), error: new Error('Nebius Logs could not run this query (HTTP 500).') };
    const { container } = render(<Results logs={logs} valid query={`${Q} | json`} />);
    expect(screen.getByText('Showing the last result')).toBeInTheDocument();
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
  });

  it('show the count and range once the result is current', () => {
    const { container } = render(<Results logs={load(resp(), false)} valid query={Q} />);
    expect(screen.getByText(/^1 line ·/)).toBeInTheDocument();
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
  });

  it('date each row when the range spans more than one UTC day (G3.7)', () => {
    const lines = [
      { ts: '2', time: '2026-10-08T02:32:00.000Z', line: 'later', labels: {} },
      { ts: '1', time: '2026-10-07T16:33:00.000Z', line: 'earlier', labels: {} },
    ];
    const { container } = render(<Results logs={load(resp({ start: '2026-10-05T15:00:00.000Z', end: '2026-10-12T15:00:00.000Z', lines }), false)} valid query={Q} />);
    expect([...container.querySelectorAll('.ne-logrow-time')].map(e => e.textContent)).toEqual(['10-08 02:32:00.000', '10-07 16:33:00.000']);
    const same = render(<Results logs={load(resp(), false)} valid query={Q} />);
    expect([...same.container.querySelectorAll('.ne-logrow-time')].map(e => e.textContent)).toEqual(['14:59:00.123']);
  });
});
