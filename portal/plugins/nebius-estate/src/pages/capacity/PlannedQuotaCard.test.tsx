import { render, screen } from '@testing-library/react';
import { MaintenanceCard, PlannedQuotaCard } from './PlannedQuotaCard';

const now = new Date('2026-10-11T08:00:00Z');
const issue = (plan: string, regionBasis: 'observed' | 'profile') => ({ plan, region: 'eu-north1', regionBasis, quota: 'compute.instance.non-gpu.vcpu', description: 'Total number of vCPUs for non-GPU VMs', need: 16, limit: 0, usage: 0, state: 'blocked' as const, what: '2 × 8vcpu-32gb system' });

describe('planned resources against quota (Capacity)', () => {
  it('lists each blocked root with its own region, and why that region', () => {
    render(<PlannedQuotaCard metric={{ source: 'Live sizing files × tenant quota allowances', value: [issue('terraform/live/sandbox/inference', 'observed'), issue('terraform/live/prod/training', 'profile')] }} now={now} />);
    const list = screen.getByRole('list', { name: 'Planned roots blocked by quota' });
    expect(list).toHaveTextContent('sandbox/inference');
    expect(list).toHaveTextContent('eu-north1 (where it runs; its node groups as observed)');
    expect(list).toHaveTextContent('eu-north1 (its run profile; not applied yet)');
    expect(list).toHaveTextContent('Total number of vCPUs for non-GPU VMs: limit 0, needs 16');
    expect(screen.getByRole('heading', { name: /2 planned roots blocked/ })).toBeInTheDocument();
  });
  it('names the run profile a check used, and words an applied root\'s need against the limit alone (G2.2)', () => {
    const profiled = { ...issue('terraform/live/sandbox/inference', 'profile'), profile: 'with-cpu-nodes' };
    const applied = { ...issue('terraform/live/staging/inference', 'observed'), quota: 'compute.instance.preemptible.count', description: 'Preemptible VMs', state: 'exceeded' as const, need: 9, limit: 8, usage: 8 };
    render(<PlannedQuotaCard metric={{ source: 's', value: [profiled, applied] }} now={now} />);
    const list = screen.getByRole('list', { name: 'Planned roots blocked by quota' });
    expect(list).toHaveTextContent('run profile with-cpu-nodes');
    expect(list).toHaveTextContent('Preemptible VMs: needs 9, above the limit of 8');
  });
  it('says so when nothing is blocked', () => {
    render(<PlannedQuotaCard metric={{ source: 's', value: [] }} now={now} />);
    expect(screen.getByText('No planned root is blocked by quota in this scope')).toBeInTheDocument();
  });
});

describe('scheduled maintenance (Capacity)', () => {
  it('lists maintenance with its time, and says so when there is none', () => {
    const { rerender } = render(<MaintenanceCard metric={{ source: 'Scheduled maintenance (maintenance.v1alpha1)', value: [] }} now={now} />);
    expect(screen.getByText('No scheduled maintenance in these projects')).toBeInTheDocument();
    rerender(<MaintenanceCard metric={{ source: 'm', value: [{ id: 'mnt-1', name: 'host-upgrade', projectId: 'p', state: 'STATE_SCHEDULED', scheduledAt: '2026-10-12T08:00:00Z', affected: ['computeinstance-a'] }] }} now={now} />);
    expect(screen.getByRole('table', { name: 'Scheduled maintenance' })).toHaveTextContent('host-upgrade');
    expect(screen.getByRole('table', { name: 'Scheduled maintenance' })).toHaveTextContent('in 24 h');
  });
});
