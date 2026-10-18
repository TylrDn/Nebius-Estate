import { render, screen } from '@testing-library/react';
import type { RuleStatus } from '@internal/nebius-domain';
import { RulesTable, ruleColumns } from './RulesTable';

const rule = (name: string, over: Partial<RuleStatus>): RuleStatus => ({
  id: `f.yaml#${name}`, name, file: 'platform/alerts/f.yaml', group: 'g', severity: 'warning', source: 'nebius', expr: 'x', for: '5 min', forSeconds: 300,
  summary: name, status: 'evaluated', firing: 0, pending: 0, ...over,
});
const rules = [
  rule('BudgetCrossed', { source: 'budgets', for: '0m', forSeconds: 0, severity: 'info' }),
  rule('GpuHot', { for: '0 min', forSeconds: 0, severity: 'critical' }),
  rule('PodsPending', { source: 'in-cluster', for: '1 h', forSeconds: 3600, status: 'needs-in-cluster' }),
  rule('GpuIdle', { for: '10 min', forSeconds: 600 }),
  rule('ProjectAllowanceBelowTenant', { source: 'portal', for: '0 min', forSeconds: 0, firing: 8 }),
];
const col = (key: string) => ruleColumns.find(c => c.key === key)!;

describe('alert rules table', () => {
  it('shows a 0-second hold one way, "at once", and sorts For by seconds (G3.9)', () => {
    render(<RulesTable rules={rules} />);
    const forCells = [...document.querySelectorAll('td[data-label="For"], td')].filter(td => td.getAttribute('data-label') === 'For').map(td => td.textContent);
    expect(new Set(forCells.filter(t => /0|once/.test(t ?? '')))).toEqual(new Set(['at once', '10 min']));
    expect(forCells).not.toContain('0 min');
    const byFor = [...rules].sort((a, b) => (col('for').sortValue!(a) as number) - (col('for').sortValue!(b) as number)).map(r => r.forSeconds);
    expect(byFor).toEqual([0, 0, 0, 600, 3600]);
  });

  it('ranks severity critical, warning, info, as the inbox does (G3.10)', () => {
    const bySev = [...rules].sort((a, b) => (col('sev').sortValue!(a) as number) - (col('sev').sortValue!(b) as number)).map(r => r.severity);
    expect(bySev).toEqual(['critical', 'warning', 'warning', 'warning', 'info']);
    expect(col('sev').sortLabels).toEqual(['most severe first', 'least severe first']);
  });

  it('opens with firing and pending rules first, then by who evaluates them (G3.11)', () => {
    render(<RulesTable rules={rules} />);
    const names = screen.getAllByRole('row').slice(1).map(r => r.querySelector('td div div')?.textContent);
    expect(names[0]).toBe('ProjectAllowanceBelowTenant');
    expect(names.slice(1)).toEqual(['BudgetCrossed', 'PodsPending', 'GpuHot', 'GpuIdle']);
  });
});
