import { fireEvent, render, screen } from '@testing-library/react';
import type { ProvisioningRequestRecord } from '@internal/nebius-domain';
import { CiPlanStatus, RequestActions } from './ProvisioningRequests';

describe('provisioning step 6', () => {
  it('has its own section that says how CI and the plan are checked', () => {
    render(<CiPlanStatus />);
    expect(screen.getByRole('heading', { name: '6 · CI / plan status' })).toBeInTheDocument();
    expect(screen.getByText(/No CI integration is configured/)).toBeInTheDocument();
    expect(screen.getByText(/make ci/)).toBeInTheDocument();
  });
});

describe('provisioning step 7: request actions (G5.1)', () => {
  const rec = (state: ProvisioningRequestRecord['state']) =>
    ({ id: '7c7e4676-0000-4000-8000-000000000001', state, input: { requestRef: 'audit-g5' } }) as unknown as ProvisioningRequestRecord;

  it('a prepared request is approved or withdrawn', () => {
    render(<RequestActions r={rec('prepared')} canRequest act={jest.fn()} onPatch={jest.fn()} />);
    expect(screen.getByRole('button', { name: 'Mark approved' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Withdraw' })).toBeInTheDocument();
  });

  it('an approved request offers Withdraw and Mark deployed, which asks for its docs/evidence/ file', async () => {
    const act = jest.fn().mockResolvedValue(true);
    render(<RequestActions r={rec('approved')} canRequest act={act} onPatch={jest.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw' }));
    expect(act).toHaveBeenCalledWith(rec('approved').id, 'withdraw');
    fireEvent.click(screen.getByRole('button', { name: 'Mark deployed' }));
    const field = screen.getByLabelText('Evidence file for audit-g5');
    fireEvent.change(field, { target: { value: 'notes/run.md' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save deployed' }));
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText(/docs\/evidence\/<name>\.md/)).toBeInTheDocument();
    expect(act).toHaveBeenCalledTimes(1);
    fireEvent.change(field, { target: { value: 'docs/evidence/2026-10-12-sandbox-inference-run.md' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save deployed' }));
    expect(act).toHaveBeenLastCalledWith(rec('approved').id, 'evidence', { state: 'deployed', evidence: 'docs/evidence/2026-10-12-sandbox-inference-run.md' });
  });

  it('deployed and withdrawn requests, and callers without the permission, get no state actions', () => {
    const { rerender } = render(<RequestActions r={rec('deployed')} canRequest act={jest.fn()} onPatch={jest.fn()} />);
    expect(screen.queryByRole('button', { name: /Withdraw|Mark/ })).toBeNull();
    rerender(<RequestActions r={rec('approved')} canRequest={false} act={jest.fn()} onPatch={jest.fn()} />);
    expect(screen.queryByRole('button', { name: /Withdraw|Mark/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Patch' })).toBeInTheDocument();
  });
});
