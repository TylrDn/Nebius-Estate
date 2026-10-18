import { render, screen, within } from '@testing-library/react';
import type { RepoModel } from '@internal/nebius-domain';
import { StagePolicyCard } from '../CapacityPage';

const policy = (gpuVm: number, training: number, strictTraining: boolean) => ({
  allow_preemptible_serving: gpuVm > 0, forbid_deletion: false, k8s_version_offset: 0, k8s_version_pinned: false, audit_logs: true, alertmanager: false, require_allowed_cidrs: false, require_ttl_label: true,
  max_gpu_nodes: { inference: 2, training, 'gpu-vm': gpuVm, nvl: 0 },
  require_strict_reservation: { inference: false, training: strictTraining, nvl: true },
});

describe('stage policy caps (G2.11)', () => {
  it('shows every cap key, gpu-vm and nvl included, and every STRICT requirement', () => {
    const repo = { stages: { stages: { sandbox: { policy: policy(1, 4, false) }, prod: { policy: policy(0, 32, true) } } } } as unknown as RepoModel;
    render(<StagePolicyCard repo={repo} />);
    const table = screen.getByRole('table', { name: 'Stage policy' });
    expect(within(table).getByRole('columnheader', { name: 'GPU VMs (R10)' })).toBeInTheDocument();
    expect(within(table).getByRole('columnheader', { name: 'NVL rack nodes (R15)' })).toBeInTheDocument();
    const sandbox = within(table).getByRole('row', { name: /sandbox/ });
    expect(sandbox).toHaveTextContent('≤ 1');
    expect(sandbox).toHaveTextContent('0: refused'); // nvl
    expect(sandbox).toHaveTextContent('nvl');
    const prod = within(table).getByRole('row', { name: /prod/ });
    expect(prod).toHaveTextContent('training');
    expect(prod).toHaveTextContent('nvl');
  });
});
