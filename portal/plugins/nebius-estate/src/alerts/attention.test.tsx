import { render } from '@testing-library/react';
import type { AlertsResponse } from '@internal/nebius-domain';
import { alertsAttentionRow } from './attention';

const alert = (id: string, ruleName: string) => ({ id, ruleName, state: 'firing', severity: 'warning', summary: `${ruleName} ${id}`, muted: undefined, labels: {}, subject: { projectName: 'lab' } }) as any;
const data = (alerts: any[], extra: Partial<AlertsResponse> = {}) => ({ data: { alerts, lastEvalAt: '2026-10-12T12:00:00Z', ...extra } as AlertsResponse });

describe('the Overview alerts row', () => {
  it('links to Alerts with the whole global filter, not the project only (G1.2)', () => {
    const row = alertsAttentionRow(data([]), { project: 'project-e00a', region: 'eu-north1', stage: 'sandbox' }, 0);
    expect(row.to).toBe('/alerts?project=project-e00a&region=eu-north1&stage=sandbox');
  });

  it('says when some alerts could not be filtered by region', () => {
    const row = alertsAttentionRow(data([alert('1', 'ConnectorDown')], { filterNote: '1 open alert not filtered by region: no region known' }), { region: 'eu-north1' }, 0);
    const { container } = render(<>{row.detail}</>);
    expect(container).toHaveTextContent('1 open alert not filtered by region: no region known');
  });

  it('does not count again the project-cap alerts the caps row lists (G1.4)', () => {
    const caps = Array.from({ length: 8 }, (_, i) => alert(String(i), 'ProjectAllowanceBelowTenant'));
    const listed = alertsAttentionRow(data(caps), {}, 8);
    expect(listed.metric.value).toBe(0);
    expect(listed.zeroLabel).toBe('8 firing, all project caps (listed below)');
    const mixed = alertsAttentionRow(data([...caps, alert('x', 'GpuThrottling')]), {}, 8);
    expect(mixed.metric.value).toBe(1);
    const { container } = render(<>{mixed.detail}</>);
    expect(container).toHaveTextContent('GpuThrottling x');
    expect(container).not.toHaveTextContent('ProjectAllowanceBelowTenant 0');
    expect(container).toHaveTextContent('+ 8 project-cap alerts, listed below');
    // Without the caps row (e.g. a filter that hides it) they count as any alert.
    expect(alertsAttentionRow(data(caps), {}, 0).metric.value).toBe(8);
  });
});
