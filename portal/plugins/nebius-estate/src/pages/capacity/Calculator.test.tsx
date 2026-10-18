import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { NodeCountFields, QuotaNeedCell } from './Calculator';
import type { CountKey } from './helpers';

function Fields() {
  const [raw, setRaw] = useState<Record<CountKey, string>>({ min: '0', expected: '2', max: '4' });
  return <NodeCountFields raw={raw} onChange={(k, v) => setRaw(r => ({ ...r, [k]: v }))} />;
}

describe('footprint calculator', () => {
  it('shows field-level messages: decimals, order, and a clamped value', () => {
    render(<Fields />);
    fireEvent.change(screen.getByLabelText('expected GPU nodes'), { target: { value: '1.5' } });
    expect(screen.getByText('Enter a whole number of nodes (no decimals).')).toBeInTheDocument();
    expect(screen.getByLabelText('expected GPU nodes')).toHaveAttribute('aria-invalid', 'true');
    fireEvent.change(screen.getByLabelText('expected GPU nodes'), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('min GPU nodes'), { target: { value: '5' } });
    expect(screen.getByText('Minimum (5) is above expected (1).')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('min GPU nodes'), { target: { value: '0' } });
    fireEvent.change(screen.getByLabelText('max GPU nodes'), { target: { value: '100000' } });
    expect(screen.getByText('Clamped to 64 (the most nodes one node group plans here).')).toBeInTheDocument();
    expect(screen.queryByText(/Invalid input|expected int/)).toBeNull();
  });

  it('names the quota that blocks a footprint in its region', () => {
    const { container } = render(<QuotaNeedCell s={{ state: 'blocked', lines: [{ quota: 'compute.instance.non-gpu.vcpu', need: 16, what: '2 × 8vcpu-32gb system', limit: 0, usage: 0, state: 'blocked', short: 16 }] }} region="eu-north1" />);
    expect(screen.getByText('blocked')).toBeInTheDocument();
    expect(container).toHaveTextContent('compute.instance.non-gpu.vcpu needs 16 vCPU, limit 0 in eu-north1');
  });
});
