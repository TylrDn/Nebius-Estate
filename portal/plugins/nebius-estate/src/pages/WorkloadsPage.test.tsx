import { render, screen } from '@testing-library/react';
import { ConstraintChips } from './WorkloadsPage';

describe('workload constraints', () => {
  it('lists a toleration repeated per container once, without a duplicate-key warning', () => {
    const err = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      render(<ConstraintChips nodeSelector={{}} tolerations={['node.cilium.io/agent-not-ready:*', 'node.cilium.io/agent-not-ready:*']} />);
      expect(screen.getAllByText('node.cilium.io/agent-not-ready:*')).toHaveLength(1);
      expect(err.mock.calls.map(c => String(c[0])).filter(m => /same key/.test(m))).toEqual([]);
    } finally {
      err.mockRestore();
    }
  });
  it('says "none" instead of an empty cell', () => {
    render(<ConstraintChips nodeSelector={{}} tolerations={[]} />);
    expect(screen.getByText('none')).toBeInTheDocument();
  });
});
