import { render, screen } from '@testing-library/react';
import type { AvailabilityCheck, QuotaCheck, QuotaNeeds } from '@internal/nebius-domain';
import { fireEvent } from '@testing-library/react';
import { AvailabilityCard, QuotaNeedsCard, ReservationsCard } from './LiveChecks';

const needs: QuotaNeeds = { nonGpuVcpus: 16, gpuVms: 1, gpus: 1, networkSsdGib: 793, ioM3Gib: 0, filesystemGib: 64, publicIps: 0, gpuClusters: 0, mk8sClusters: 1 };

describe('provisioning live checks', () => {
  it('shows needs vs live limit vs usage per quota, with blocked and short-by markers and where to request', () => {
    const check: QuotaCheck = {
      region: 'eu-north1',
      source: 'tenant',
      lines: [
        { quota: 'compute.instance.non-gpu.vcpu', need: 16, what: '2 × 8vcpu-32gb system', limit: 0, usage: 0, state: 'blocked', short: 16, description: 'vCPUs for non-GPU VMs' },
        { quota: 'compute.instance.preemptible.count', need: 1, what: '1 × gpu (preemptible)', limit: 8, usage: 1, state: 'ok', short: 0, description: 'Preemptible VMs' },
        { quota: 'compute.instance.count', need: 3, what: '3 VMs', limit: 12, usage: 11, state: 'exceeded', short: 2 },
      ],
      unchecked: [{ quota: 'compute.disk.size.network-ssd', need: 793, what: 'disks' }],
    };
    render(<QuotaNeedsCard check={check} needs={needs} />);
    const table = screen.getByRole('table', { name: 'Quota needs vs limits' });
    expect(table).toHaveTextContent('vCPUs for non-GPU VMs');
    expect(table).toHaveTextContent('blocked (limit 0)');
    expect(table).toHaveTextContent('short by 2');
    expect(screen.getByText('2 quotas would stop this plan')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /request quota in the console/ })).toHaveAttribute('href', 'https://console.nebius.com/quota');
    expect(screen.getByText(/Not checked/)).toHaveTextContent('compute.disk.size.network-ssd');
    // G5.5: the status badge wraps instead of being cut at the card edge.
    expect(screen.getByText('blocked (limit 0)')).toHaveClass('ne-badge-wrap');
  });

  it('says plainly when quotas could not be checked, and still shows the arithmetic', () => {
    render(<QuotaNeedsCard check={{ region: 'eu-north1', source: 'none', lines: [], unchecked: [], reason: 'No tenant quota allowances were read.' }} needs={needs} />);
    expect(screen.getByText('Quotas not checked')).toBeInTheDocument();
    expect(screen.getByText(/Non-GPU vCPU 16/)).toBeInTheDocument();
    // G5.3: the arithmetic names the Managed Kubernetes cluster the recipe creates.
    expect(screen.getByText(/Non-GPU vCPU 16/)).toHaveTextContent('Managed Kubernetes clusters 1');
  });

  it('warns when the capacity advisor has fewer available than requested and names options with room', () => {
    const a: AvailabilityCheck = {
      region: 'eu-north1', platform: 'gpu-h100-sxm', preset: '8gpu-128vcpu-1600gb', fabric: 'fabric-3', capacityType: 'on-demand', requested: 2, state: 'short', level: 'low', available: 0, limit: 4,
      alternatives: [{ region: 'eu-north1', fabric: 'fabric-3', capacityType: 'preemptible', level: 'high', available: 6 }], message: 'on-demand 8gpu-128vcpu-1600gb in eu-north1 fabric-3: low, 0 available vs 2 requested.',
    };
    render(<AvailabilityCard a={a} />);
    expect(screen.getByText(/0 available vs 2 requested/)).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Where there is room now' })).toHaveTextContent('eu-north1 fabric-3 · preemptible · high · 6 available');
  });

  it('#43, #13, W1-P3: amounts in units, the tenant list\'s read time, "Fits in" with a switch, and "Prepare anyway"', () => {
    const check: QuotaCheck = {
      region: 'eu-north1', source: 'tenant', observedAt: '2026-10-12T23:20:00Z',
      lines: [
        { quota: 'compute.instance.non-gpu.vcpu', need: 16, what: '2 × 8vcpu-32gb system', limit: 0, usage: 0, state: 'blocked', short: 16 },
        { quota: 'compute.disk.size.network-ssd', need: 4373, what: 'disks', limit: 4096, usage: 0, state: 'exceeded', short: 277 },
      ],
      unchecked: [],
    };
    const use = jest.fn();
    const pending = jest.fn();
    render(<QuotaNeedsCard check={check} needs={needs} fitsIn={[{ region: 'eu-west1', platform: 'gpu-h200-sxm', checked: 4, unchecked: [] }]} onUseRegion={use} pending={{ checked: false, onChange: pending }} />);
    const table = screen.getByRole('table', { name: 'Quota needs vs limits' });
    expect(table).toHaveTextContent('4.27 TiB');
    expect(table).toHaveTextContent('16 vCPU');
    expect(table).toHaveTextContent('short by 277 GiB');
    expect(screen.getByTestId('quota-read-at')).toHaveTextContent('Tenant allowances read');
    expect(screen.getByTestId('fits-in')).toHaveTextContent('Fits in: eu-west1 (gpu-h200-sxm)');
    fireEvent.click(screen.getByRole('button', { name: 'Use eu-west1' }));
    expect(use).toHaveBeenCalledWith('eu-west1', 'gpu-h200-sxm');
    fireEvent.click(screen.getByLabelText('Prepare anyway: quota request pending'));
    expect(pending).toHaveBeenCalledWith(true);
  });

  it('W1-P4: an advisor that was not read says "availability unknown"; switches are buttons; reservations are listed', () => {
    const a: AvailabilityCheck = { region: 'eu-north1', platform: 'gpu-h100-sxm', preset: '8gpu-128vcpu-1600gb', capacityType: 'on-demand', requested: 2, state: 'unknown', alternatives: [], message: 'Availability unknown: the capacity advisor was not read (unreachable).' };
    const { unmount } = render(<AvailabilityCard a={a} />);
    expect(screen.getByText('availability unknown')).toBeInTheDocument();
    expect(screen.queryByText(/fits/)).toBeNull();
    unmount();
    const click = jest.fn();
    const short: AvailabilityCheck = { ...a, state: 'limit-reached', alternatives: [{ region: 'eu-north1', fabric: 'fabric-4', capacityType: 'on-demand', level: 'high', available: 6 }], message: 'limit reached' };
    render(<AvailabilityCard a={short} switches={[{ key: 'k', label: 'Use fabric-4', onClick: click }]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Use fabric-4' }));
    expect(click).toHaveBeenCalled();
    render(<ReservationsCard r={{ policy: 'STRICT', region: 'eu-north1', platform: 'gpu-h100-sxm', state: 'none', groups: [], message: 'The tenant lists no capacity block group for gpu-h100-sxm in eu-north1 (capacity.v1): a STRICT node group draws only on a reservation.' }} />);
    expect(screen.getByText('none matching')).toBeInTheDocument();
  });
});
