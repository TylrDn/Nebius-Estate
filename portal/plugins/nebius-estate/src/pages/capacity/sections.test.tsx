import type { ReactNode } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { CapacityResponse, NodeGroupCapacity, PlatformView, QuotaAllowanceView } from '@internal/nebius-domain';
import { reservationEvidence } from '@internal/nebius-domain';
import { GpuTelemetryCard } from './GpuTelemetryCard';
import { CapacityAllowancesCard, QuotaId, QuotasCard } from './QuotaSections';
import { urgencyRank } from './helpers';
import { EstateBlockers, NodeGroupQuotaCell } from './EstateBlockers';
import { bestRegions, BlockGroupsCard, ResourceAdviceCard } from './TenantSections';

const now = new Date('2026-10-11T12:00:00Z');
const name = (id: string) => ({ 'project-e00mocksandbox': 'sandbox' })[id] ?? id;

const quotas: CapacityResponse['quotas'] = {
  source: 'Quota allowances (quotas.v1)',
  observedAt: '2026-10-11T11:54:00Z',
  value: [
    { scope: 'project', allocation: 'set', projectId: 'project-e00mocksandbox', name: 'compute.instance.gpu.h100', region: 'eu-north1', limit: 2, usage: 2, usagePercent: 100, unit: 'gpu', description: 'GPUs H100' },
    { scope: 'project', allocation: 'set', projectId: 'project-e00mocksandbox', name: 'compute.instance.non-gpu.vcpu', region: 'eu-north1', limit: 256, usage: 48, usagePercent: 18.75, unit: 'vcpu', description: 'vCPUs for non-GPU VMs' },
    { scope: 'project', allocation: 'set', projectId: 'project-e00mocksandbox', name: 'compute.disk.size.network-ssd', region: 'eu-north1', limit: 20480, usage: 2000, usagePercent: 9.77, unit: 'GiB', description: 'Network SSD disk size' },
  ],
};

const denied = { value: null, source: 'Capacity block groups (capacity.v1, tenant)', unavailableReason: 'permission-denied: Refused for this identity: grant a tenant-level read role.' };

function Router({ children }: { children: ReactNode }) {
  return <MemoryRouter>{children}</MemoryRouter>;
}

describe('Allowance check (project caps against the tenant quota)', () => {
  const f = (kind: 'no-effect' | 'caps-below' | 'zero-cap', quota: string, projectLimit: number, tenantLimit: number) => ({ kind, projectId: 'project-e00mocksandbox', name: quota, region: 'eu-west2', description: `About ${quota}`, unit: 'count', projectLimit, tenantLimit, usage: 0 });
  const findings = [f('zero-cap', 'dns.zone.count', 0, 100), f('caps-below', 'vpc.allocation.count', 13, 1000), f('no-effect', 'compute.instance.count', 22, 12)];

  it('lists caps that block, cap or have no effect in plain words, with the project and both limits', () => {
    render(
      <Router>
        <QuotasCard metric={quotas} name={name} now={now} allowances={{ value: findings, source: 'Project and tenant quota allowances (quotas.v1)' }} />
      </Router>,
    );
    const check = screen.getByRole('region', { name: 'Allowance check' });
    expect(check).toHaveTextContent('2 cut a project');
    const rows = screen.getByRole('list', { name: 'Project caps that differ from the tenant limit' }).querySelectorAll('li');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent('About dns.zone.count');
    expect(rows[0]).toHaveTextContent('sandbox · eu-west2: project cap 0, tenant limit 100');
    expect(rows[0]).toHaveTextContent('Blocks this project');
    expect(rows[1]).toHaveTextContent('project cap 13, tenant limit 1,000');
    expect(rows[1]).toHaveTextContent('Caps this project below the tenant limit. Intended?');
    expect(rows[2]).toHaveTextContent('No effect: the tenant limit is lower and always applies.');
    expect(check).toHaveTextContent('scripts/quota-plan.py');
  });

  it('says so when every cap equals the tenant limit, and why when it cannot judge', () => {
    const { unmount } = render(
      <Router>
        <QuotasCard metric={quotas} name={name} now={now} allowances={{ value: [], source: 's' }} />
      </Router>,
    );
    expect(screen.getByRole('region', { name: 'Allowance check' })).toHaveTextContent('No project cap differs from its tenant limit');
    unmount();
    render(
      <Router>
        <QuotasCard metric={quotas} name={name} now={now} allowances={{ value: null, source: 's', unavailableReason: 'Tenant-level data is shown to callers who can see every project.' }} />
      </Router>,
    );
    expect(screen.getByRole('region', { name: 'Allowance check' })).toHaveTextContent('Tenant-level data is shown to callers who can see every project.');
  });
});

describe('the Quotas footnote names why tenant allowances are missing (F1.33)', () => {
  it('says the tenant id is unknown when that is the cause, not that a role is missing', () => {
    render(
      <Router>
        <QuotasCard metric={quotas} name={name} now={now} tenantGap="the tenant id is not known: set NEBIUS_TENANT_ID, or it is read from a project once a project read succeeds" />
      </Router>,
    );
    const footnote = screen.getByText(/Only project allowances were read/);
    expect(footnote).toHaveTextContent('Only project allowances were read (the tenant id is not known: set NEBIUS_TENANT_ID');
    expect(footnote).not.toHaveTextContent('tenant-level read role');
  });
});

describe('Capacity sections', () => {
  it('shows GPU quotas first with their limit state, and searches the other quotas', () => {
    render(
      <Router>
        <QuotasCard metric={quotas} name={name} now={now} />
      </Router>,
    );
    const gpu = screen.getByRole('list', { name: 'GPU quotas · eu-north1' });
    expect(gpu).toHaveTextContent('H100');
    expect(gpu).toHaveTextContent('at limit');
    expect(gpu).toHaveTextContent('sandbox');
    expect(screen.getByRole('region', { name: 'All quota allowances' })).toHaveTextContent('vCPUs for non-GPU VMs');
    fireEvent.change(screen.getByLabelText('Search all quotas'), { target: { value: 'ssd' } });
    expect(screen.getByRole('region', { name: 'All quota allowances' })).not.toHaveTextContent('vCPUs');
  });

  it('leads with tenant allowances, marks limit 0 as blocked with where to request, and lists project allocations beneath', () => {
    const tenant = (quotaName: string, limit: number, usage: number, description: string) => ({ scope: 'tenant' as const, allocation: 'set' as const, projectId: '', name: quotaName, region: 'eu-north1', limit, usage, usagePercent: limit ? (100 * usage) / limit : null, unit: 'x', description });
    render(
      <Router>
        <QuotasCard
          metric={{ ...quotas, value: [tenant('compute.instance.gpu.h100', 32, 2, 'GPUs H100'), tenant('compute.instance.non-gpu.vcpu', 0, 0, 'vCPUs for non-GPU VMs'), ...quotas.value!] }}
          name={name}
          now={now}
        />
      </Router>,
    );
    expect(screen.getByText('Compute GPU and preemptible VM quotas by region (tenant)')).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'GPU quotas · eu-north1' })).toHaveTextContent('tenant');
    expect(screen.queryByText(/planned root/)).not.toBeInTheDocument(); // the header counts planned roots, none given here
    expect(screen.getByRole('region', { name: 'All quota allowances' })).toHaveTextContent('blocked (limit 0)');
    expect(screen.getByRole('region', { name: 'Project quota allocations' })).toHaveTextContent('sandbox');
    // The header counts what the Overview counts, in the same words (F1.4).
    expect(screen.getByText('0 at ≥ 80 % · 2 tenant quotas with a limit (1 at limit 0)')).toBeInTheDocument();
  });

  it('the Overview\'s N is the Capacity list\'s N: tenant rows without a limit are counted apart (F1.39)', () => {
    const t = (quotaName: string, limit: number | null) => ({ scope: 'tenant' as const, allocation: 'set' as const, projectId: '', name: quotaName, region: 'eu-north1', limit, usage: 0, usagePercent: null, unit: 'x' });
    render(
      <Router>
        <QuotasCard
          metric={{ ...quotas, value: [t('compute.instance.count', 100), t('compute.instance.gpu.h100', 32), t('storage.bucket.count', null), { ...t('compute.instance.count', null), scope: 'project' as const, allocation: 'inherits-tenant' as const, projectId: 'project-e00mocka' }] }}
          name={name}
          now={now}
        />
      </Router>,
    );
    expect(screen.getByText('0 at ≥ 80 % · 2 tenant quotas with a limit')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'All tenant quotas (3 · 2 with a limit)' })).toBeInTheDocument();
    // Project placeholders have no limit of their own by design: their list keeps its plain count.
    expect(screen.getByRole('heading', { name: 'Project allocations (1)' })).toBeInTheDocument();
  });

  it('reads a project placeholder as "uses tenant quota" against the tenant limit, never as blocked; other services and preemptible apart', () => {
    const t = (quotaName: string, limit: number, usage: number, region = 'eu-north1', service = 'compute') => ({ scope: 'tenant' as const, allocation: 'set' as const, projectId: '', name: quotaName, region, service, limit, usage, usagePercent: limit ? (100 * usage) / limit : null, unit: 'gpu' });
    const placeholder = { scope: 'project' as const, allocation: 'inherits-tenant' as const, projectId: 'project-e00mocksandbox', name: 'compute.instance.gpu.l40s', region: 'eu-north1', limit: null, usage: 1, usagePercent: null, unit: 'gpu', description: 'GPUs L40S', tenant: { limit: 32, usage: 1, usagePercent: 3.13 } };
    render(
      <Router>
        <QuotasCard
          metric={{ ...quotas, value: [t('compute.instance.gpu.l40s', 32, 1), t('compute.instance.preemptible.count', 8, 1), t('msp.cloudapps.gpu.l40s', 0, 0, 'eu-north1', 'msp'), t('compute.instance.gpu.h200', 0, 0, 'eu-north2'), placeholder] }}
          name={name}
          now={now}
          targets={new Set(['eu-north1'])}
        />
      </Router>,
    );
    const here = screen.getByRole('list', { name: 'GPU quotas · eu-north1' });
    expect(here).toHaveTextContent('Preemptible VMs');
    expect(here).toHaveTextContent('Compute VMs');
    expect(here).not.toHaveTextContent('blocked');
    // A limit 0 in a region the estate does not use, or in another service, is not an alarm.
    expect(screen.queryByText(/blocked \(limit 0\)/)).not.toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'GPU quotas of other services' })).toHaveTextContent('Standalone apps');
    const alloc = screen.getByRole('region', { name: 'Project quota allocations' });
    expect(alloc).toHaveTextContent('uses tenant quota');
    expect(alloc).toHaveTextContent('tenant 1 / 32');
    expect(alloc).not.toHaveTextContent('limit 0');
  });

  it('names the quota blocking a node group short of nodes, with where to request it', () => {
    const t = (quotaName: string, limit: number, usage: number, description: string) => ({ scope: 'tenant' as const, allocation: 'set' as const, projectId: '', name: quotaName, region: 'eu-north1', limit, usage, usagePercent: null, description });
    const ng = { uid: 'u1', cluster: 'nip-sandbox-inference', name: 'ng-cpu', platform: 'cpu-d3', preset: '4vcpu-16gb', gpusPerNode: 0, nodes: 0, fixedNodeCount: 2, capacityType: 'on-demand' as const, region: 'eu-north1' };
    const gpu = { ...ng, uid: 'u2', name: 'ng-gpu', platform: 'gpu-l40s-a', preset: '1gpu-8vcpu-32gb', gpusPerNode: 1, nodes: 1, fixedNodeCount: 1, capacityType: 'preemptible' as const };
    render(
      <Router>
        <EstateBlockers nodeGroups={[ng, gpu]} quotas={[t('compute.instance.non-gpu.vcpu', 0, 0, 'vCPUs for non-GPU VMs'), t('compute.instance.preemptible.count', 8, 1, 'Preemptible VMs')]} />
      </Router>,
    );
    const list = screen.getByRole('list', { name: 'Blocking your estate' });
    expect(list).toHaveTextContent('nip-sandbox-inference / ng-cpu');
    expect(list).toHaveTextContent('0 of 2 nodes up');
    expect(list).toHaveTextContent('compute.instance.non-gpu.vcpu (vCPUs for non-GPU VMs) has limit 0; 8 needed');
    expect(list).not.toHaveTextContent('ng-gpu');
    expect(screen.getByRole('link', { name: 'Request quota' })).toHaveAttribute('href', 'https://console.nebius.com/quota');
  });

  it('never renders an unavailable quota list as zero', () => {
    render(
      <Router>
        <QuotasCard metric={{ value: null, source: 'Quota allowances (quotas.v1)', unavailableReason: 'unreachable: timed out' }} name={name} now={now} />
      </Router>,
    );
    expect(screen.getByText('Quota allowances: unavailable')).toBeInTheDocument();
    expect(screen.getByText('timed out')).toBeInTheDocument();
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });

  it('names the tenant role to grant and links the credentials guide when a tenant read is refused', () => {
    render(
      <Router>
        <BlockGroupsCard metric={denied} now={now} />
        <ResourceAdviceCard metric={{ ...denied, source: 'Capacity advice (capacity.v1, tenant)' }} now={now} />
        <CapacityAllowancesCard metric={{ value: [], source: 'Capacity allowances (capacity.v1)' }} blockGroups={denied} name={name} now={now} />
      </Router>,
    );
    expect(screen.getAllByText('security-auditor')).toHaveLength(2);
    const links = screen.getAllByRole('link', { name: 'docs/credentials.md' });
    expect(links[0]).toHaveAttribute('href', `/evidence?doc=${encodeURIComponent('docs/credentials.md')}`);
    expect(screen.getByText('No capacity allowances in these projects')).toBeInTheDocument();
  });

  it('says no GPU VMs are reporting when telemetry answered empty, and lists GPUs otherwise', () => {
    const { rerender } = render(<GpuTelemetryCard metric={{ value: [], source: 'Nebius Monitoring' }} name={name} now={now} />);
    expect(screen.getByText('No GPU VMs reporting in these projects')).toBeInTheDocument();
    rerender(
      <GpuTelemetryCard
        metric={{ value: [{ instanceName: 'nip-sandbox-inference-gpu-0', node: 'n', gpu: '0', projectId: 'project-e00mocksandbox', utilPercent: 63.5, tempC: 54, powerW: 310.2, memoryUsedMiB: 40211, memoryTotalMiB: 81559, source: 'Nebius Monitoring (DCGM)' }], source: 'Nebius Monitoring' }}
        name={name}
        now={now}
      />,
    );
    const table = screen.getByRole('region', { name: 'GPU telemetry per GPU' });
    expect(table).toHaveTextContent('nip-sandbox-inference-gpu-0');
    expect(table).toHaveTextContent('63.5 %');
    expect(table).toHaveTextContent('54 °C');
    expect(table).toHaveTextContent('310 W');
    expect(table).toHaveTextContent('39.3 / 79.6 GiB');
  });

  const advice: CapacityResponse['resourceAdvice'] = {
    source: 'Capacity advice (capacity.v1, tenant)',
    observedAt: '2026-10-11T11:54:00Z',
    value: [
      { region: 'eu-north1', fabric: 'eu-north1-a', platform: 'gpu-h100-sxm', preset: '8gpu-128vcpu-1600gb', gpus: 8, onDemand: { level: 'low', available: 1, limit: 4, dataState: 'fresh', effectiveAt: '2026-10-11T11:00:00Z' }, preemptible: { level: 'medium', available: 2, limit: 4, dataState: 'stale', effectiveAt: '2026-10-11T06:00:00Z' }, reserved: { level: 'limit-reached', dataState: 'fresh' } },
      { region: 'us-central1', fabric: 'us-central1-b', platform: 'gpu-h100-sxm', preset: '8gpu-128vcpu-1600gb', gpus: 8, onDemand: { level: 'medium', available: 3, limit: 4, dataState: 'fresh' }, reserved: { level: 'limit-reached' } },
      { region: 'eu-west1', platform: 'gpu-h200-sxm', preset: '8gpu-128vcpu-1600gb', onDemand: { level: 'limit-reached', dataState: 'fresh' } },
    ],
  };

  it('picks the best region per platform by on-demand level, and none when every region is at its limit', () => {
    expect(bestRegions(advice.value!)).toEqual([{ platform: 'gpu-h100-sxm', region: 'us-central1', preset: '8gpu-128vcpu-1600gb', level: 'medium', stale: false }]);
  });

  it('judges the best region per preset: a 1-GPU preset with room says nothing about the 8-GPU one', () => {
    const rows = [
      { region: 'eu-north1', platform: 'gpu-h100-sxm', preset: '1gpu-16vcpu-200gb', onDemand: { level: 'high', available: 40, limit: 64 } },
      { region: 'eu-north1', fabric: 'fabric-3', platform: 'gpu-h100-sxm', preset: '8gpu-128vcpu-1600gb', onDemand: { level: 'limit-reached', available: 0, limit: 4 } },
    ];
    expect(bestRegions(rows)).toEqual([{ platform: 'gpu-h100-sxm', region: 'eu-north1', preset: '1gpu-16vcpu-200gb', level: 'high', stale: false }]);
    const err = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    render(<ResourceAdviceCard metric={{ ...advice, value: [...rows, { ...rows[0], region: 'us-central1', preset: '8gpu-128vcpu-1600gb', onDemand: { level: 'high', available: 2, limit: 4 } }] }} now={now} />);
    expect(err.mock.calls.filter(c => /same key/.test(String(c[0])))).toEqual([]);
    err.mockRestore();
    const best = screen.getByRole('list', { name: 'Best region per platform' });
    expect(best).toHaveTextContent('gpu-h100-sxm · 1gpu-16vcpu-200gb: eu-north1');
    expect(best).toHaveTextContent('gpu-h100-sxm · 8gpu-128vcpu-1600gb: us-central1'); // not eu-north1, where 8-GPU is at its limit
  });

  it('the Reserved filter keeps only rows where reserved capacity is offered', () => {
    render(<ResourceAdviceCard metric={advice} now={now} reservations={reservationEvidence([{ id: 'cbg' }], [], [])} />);
    fireEvent.change(screen.getByLabelText('Advice capacity type'), { target: { value: 'reserved' } });
    expect(screen.getByText('No capacity advice for this selection')).toBeInTheDocument();
  });

  it('the quota header counts the planned roots blocked by quota, as the Overview does, and links the list', () => {
    const issue = (plan: string, quota: string) => ({ plan, region: 'eu-north1', quota, need: 16, limit: 0, usage: 0, state: 'blocked' as const, what: '2 × 8vcpu-32gb system' });
    render(
      <Router>
        <QuotasCard metric={quotas} name={name} now={now} planned={{ source: 's', value: [issue('terraform/live/sandbox/inference', 'a'), issue('terraform/live/sandbox/inference', 'b'), issue('terraform/live/prod/training', 'a')] }} />
      </Router>,
    );
    expect(screen.getByRole('link', { name: '2 planned roots blocked' })).toHaveAttribute('href', '#planned-quota');
  });

  it('shows the availability matrix with levels, numbers, age and stale data, and filters it', () => {
    render(<ResourceAdviceCard metric={advice} now={now} />);
    const table = screen.getByRole('table', { name: 'Capacity availability matrix' });
    expect(table).toHaveTextContent('1 available / 4 limit');
    expect(table).toHaveTextContent('limit reached');
    expect(table).toHaveTextContent('0 available / 0 limit'); // proto3: omitted numbers are 0, never "?"
    expect(table).not.toHaveTextContent('?');
    expect(table).toHaveTextContent('stale');
    expect(table).toHaveTextContent('as of 1 h ago');
    expect(screen.getByRole('list', { name: 'Best region per platform' })).toHaveTextContent('Best region for gpu-h100-sxm · 8gpu-128vcpu-1600gb: us-central1');
    fireEvent.change(screen.getByLabelText('Advice platform'), { target: { value: 'gpu-h200-sxm' } });
    expect(table).not.toHaveTextContent('us-central1');
    expect(screen.getByRole('list', { name: 'Best region per platform' })).toHaveTextContent('No region currently advises on-demand capacity');
    fireEvent.change(screen.getByLabelText('Advice platform'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Advice capacity type'), { target: { value: 'preemptible' } });
    expect(screen.getAllByRole('row')).toHaveLength(2); // header + the one row with preemptible advice
    expect(screen.queryByRole('columnheader', { name: /On-demand/ })).not.toBeInTheDocument();
  });

  it('hides the reserved column, with one line instead, when the tenant holds no reservation', () => {
    render(<ResourceAdviceCard metric={advice} now={now} reservations={reservationEvidence([], [], [])} />);
    expect(screen.queryByRole('columnheader', { name: /Reserved/ })).not.toBeInTheDocument();
    expect(screen.getByText(/No reservations in this tenant; reserved capacity needs a capacity block group/)).toBeInTheDocument();
  });

  it('says there are no reservations when the tenant answers an empty list', () => {
    render(
      <Router>
        <BlockGroupsCard metric={{ value: [], source: 'Capacity block groups (capacity.v1, tenant)' }} now={now} />
      </Router>,
    );
    expect(screen.getByText('No reservations in this tenant')).toBeInTheDocument();
  });
});

describe('capacity, reconciled and short (W1c)', () => {
  const advice: CapacityResponse['resourceAdvice'] = {
    source: 'Capacity advice (capacity.v1, tenant)',
    value: [{ region: 'eu-north1', platform: 'gpu-h100-sxm', preset: '8gpu-128vcpu-1600gb', onDemand: { level: 'low', available: 1, limit: 4 }, reserved: { level: 'limit-reached' } }],
  };
  const ng = (over: Partial<NodeGroupCapacity>): NodeGroupCapacity => ({ uid: 'u', cluster: 'nip-staging-training', name: 'ng', platform: 'cpu-d3', preset: '8vcpu-32gb', gpusPerNode: 0, nodes: 2, fixedNodeCount: 2, capacityType: 'on-demand', region: 'eu-north1', ...over });
  const tenant = (quotaName: string, limit: number, usage: number, extra: object = {}) => ({ scope: 'tenant' as const, allocation: 'set' as const, projectId: '', name: quotaName, region: 'eu-north1', limit, usage, usagePercent: null, unit: 'vcpu', description: 'vCPUs for non-GPU VMs', ...extra });

  it('F1.12: the node-group quota check is a short badge; the full sentence is its tooltip and read to screen readers', () => {
    const { container } = render(<NodeGroupQuotaCell g={ng({ nodes: 0, fixedNodeCount: 3, region: 'uk-south1' })} quotas={[]} />);
    const badge = container.querySelector('.ne-badge')!;
    expect(badge).toHaveTextContent(/^3 short · not checked$/);
    expect(badge).not.toHaveClass('ne-badge-wrap');
    expect(badge.getAttribute('title')).toBe('3 nodes short; quota not checked (no allowance with a known limit for this region)');
    expect(container).toHaveTextContent('3 nodes short; quota not checked'); // sr-only copy
  });

  it('F1.12: a group scaled to zero and a group above its fixed size are not "all nodes up"; the mismatch is flagged', () => {
    const { container, rerender } = render(<NodeGroupQuotaCell g={ng({ nodes: 0, fixedNodeCount: undefined, autoscaling: { min: 0, max: 2 }, capacityType: 'reserved' })} quotas={[]} />);
    expect(container.querySelector('.ne-badge')).toHaveTextContent(/^0 nodes \(min 0\)$/);
    expect(container.querySelector('.ne-badge')!.getAttribute('title')).toBe('No node running: autoscaling 0–2 is at its minimum of 0. Nothing is missing; nothing is up.');
    expect(container).not.toHaveTextContent('all nodes up');
    // A fixed size of 0 does not autoscale: it is said as configured.
    rerender(<NodeGroupQuotaCell g={ng({ nodes: 0, fixedNodeCount: 0 })} quotas={[]} />);
    expect(container.querySelector('.ne-badge')).toHaveTextContent(/^0 nodes \(fixed 0\)$/);
    expect(container.querySelector('.ne-badge')!.getAttribute('title')).toBe('No node running: the spec fixes 0 nodes. Nothing is missing; nothing is up.');
    rerender(<NodeGroupQuotaCell g={ng({ nodes: 3 })} quotas={[]} />);
    const above = container.querySelector('.ne-badge')!;
    expect(above).toHaveTextContent(/^1 above fixed 2$/);
    expect(above).toHaveClass('ne-tone-warn');
    // Observed facts only: no guess at the cause.
    expect(above.getAttribute('title')).toBe('3 nodes observed; the spec fixes 2; the API does not say why.');
    rerender(<NodeGroupQuotaCell g={ng({})} quotas={[]} />);
    // One vocabulary: every state, "all nodes up" included, is a Badge.
    const ok = container.querySelector('.ne-badge')!;
    expect(ok).toHaveTextContent(/^all nodes up$/);
    expect(ok).toHaveClass('ne-tone-ok');
  });

  it('F1.11: a tenant row whose projects report more shows their use against the 0 limit, flagged where it is seen first', () => {
    const vcpu = tenant('compute.instance.non-gpu.vcpu', 0, 48, { reportedUsage: 0 });
    const placeholder = { scope: 'project' as const, allocation: 'inherits-tenant' as const, projectId: 'project-e00mocksandbox', name: 'compute.instance.non-gpu.vcpu', region: 'eu-north1', limit: null, usage: 48, usagePercent: null, unit: 'vcpu', description: 'vCPUs for non-GPU VMs', tenant: { limit: 0, usage: 48, usagePercent: null } };
    render(
      <Router>
        <QuotasCard metric={{ ...quotas, value: [tenant('compute.instance.gpu.h100', 32, 2, { unit: 'gpu', description: 'GPUs H100' }), vcpu, placeholder] }} name={name} now={now} targets={new Set(['eu-north1'])} />
      </Router>,
    );
    const flag = screen.getByRole('list', { name: 'Quotas in use above their limit' });
    expect(flag).toHaveTextContent('vCPUs for non-GPU VMs · eu-north1: 48 in use against a limit of 0: the projects report 48, the tenant 0.');
    expect(flag.closest('details')).toBeNull(); // visible without opening anything
    const all = screen.getByRole('region', { name: 'All quota allowances' });
    expect(all).toHaveTextContent('48 / 0');
    expect(all).toHaveTextContent('above limit');
    expect(screen.getByRole('region', { name: 'Project quota allocations' })).toHaveTextContent('tenant 48 / 0');
    // The header leads with the worst state, in the danger tone (not a neutral "none").
    const header = screen.getByText('1 in use above its limit · 0 at ≥ 80 % · 2 tenant quotas with a limit (1 at limit 0)');
    expect(header.className).toContain('ne-tone-danger');
  });

  it('F1.13: the long quota tables are folded; their summary says how many rows and what is in them', () => {
    render(
      <Router>
        <QuotasCard metric={quotas} name={name} now={now} />
      </Router>,
    );
    const table = screen.getByRole('region', { name: 'All quota allowances' });
    const folded = table.closest('details') as HTMLDetailsElement;
    expect(folded.open).toBe(false);
    expect(folded.querySelector('summary')).toHaveTextContent('All quotas (3)');
  });

  it('F1.10: an empty reservation list beside an allowance on a block group and a reserved node group is explained, not "No reservations"', () => {
    const allowances: CapacityResponse['capacityAllowances'] = {
      source: 'Capacity allowances (capacity.v1)',
      value: [{ projectId: 'project-e00mocksandbox', name: 'h100-reserved-eu-north1', capacityBlockGroupId: 'capacityblockgroup-e00mockh100', limit: 16, usage: 0, usagePercent: 0, unit: 'gpu', state: 'STATE_ACTIVE' }],
    };
    const blockGroups = { value: [], source: 'Capacity block groups (capacity.v1, tenant)' };
    const evidence = reservationEvidence(blockGroups.value, allowances.value, [ng({ name: 'nip-staging-training-gpu', capacityType: 'reserved' })]);
    render(
      <Router>
        <CapacityAllowancesCard metric={allowances} blockGroups={blockGroups} name={name} now={now} evidence={evidence} />
        <BlockGroupsCard metric={blockGroups} now={now} evidence={evidence} />
        <ResourceAdviceCard metric={advice} now={now} reservations={evidence} />
      </Router>,
    );
    expect(screen.queryByText('No reservations in this tenant')).not.toBeInTheDocument();
    expect(screen.queryByText(/No reservations in this tenant/)).not.toBeInTheDocument();
    expect(screen.getByText('Reservation in use, not listed')).toBeInTheDocument();
    expect(screen.getByText(/capacity allowance h100-reserved-eu-north1 names reservation capacityblockgroup-e00mockh100 and node group nip-staging-training-gpu runs as reserved/)).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Capacity allowances' })).toHaveTextContent('not in the reservation list');
    // The reserved column stays: a reservation is in use.
    expect(screen.getByRole('columnheader', { name: /Reserved/ })).toBeInTheDocument();
  });

  it('F1.10 under a region filter: a reservation the filter hides is named with its region, not blamed on the API', () => {
    const allowances: CapacityResponse['capacityAllowances'] = {
      source: 'Capacity allowances (capacity.v1)',
      value: [{ projectId: 'project-e00mocksandbox', name: 'h100-reserved-eu-north1', capacityBlockGroupId: 'capacityblockgroup-e00mockh100', limit: 16, usage: 0, usagePercent: 0, unit: 'gpu', state: 'STATE_ACTIVE' }],
    };
    const blockGroups = { value: [], source: 'Capacity block groups (capacity.v1, tenant)' };
    const evidence = reservationEvidence(blockGroups.value, allowances.value, [], { region: 'uk-south1', hidden: [{ id: 'capacityblockgroup-e00mockh100', region: 'eu-north1' }] });
    render(
      <Router>
        <CapacityAllowancesCard metric={allowances} blockGroups={blockGroups} name={name} now={now} evidence={evidence} />
        <BlockGroupsCard metric={blockGroups} now={now} evidence={evidence} />
      </Router>,
    );
    expect(screen.getByText('No reservations in uk-south1')).toBeInTheDocument();
    expect(screen.getByText(/which is in eu-north1, outside the region filter \(uk-south1\)/)).toBeInTheDocument();
    expect(screen.queryByText(/the API does not say why/)).not.toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'Capacity allowances' });
    expect(table).not.toHaveTextContent('not in the reservation list');
    expect(table).toHaveTextContent('in eu-north1, outside the filter');
  });

  it('F1.10 under a region filter: a reservation no region lists says the list was filtered', () => {
    const allowances: CapacityResponse['capacityAllowances'] = {
      source: 'Capacity allowances (capacity.v1)',
      value: [{ projectId: 'project-e00mocksandbox', name: 'h100-reserved-eu-north1', capacityBlockGroupId: 'capacityblockgroup-e00mockh100', limit: 16, usage: 0, usagePercent: 0 }],
    };
    const blockGroups = { value: [], source: 'Capacity block groups (capacity.v1, tenant)' };
    const evidence = reservationEvidence(blockGroups.value, allowances.value, [], { region: 'uk-south1', hidden: [] });
    render(<BlockGroupsCard metric={blockGroups} now={now} evidence={evidence} />);
    expect(screen.getByText(/The reservation list shows none in uk-south1/)).toBeInTheDocument();
    expect(screen.getByText(/the list shows it in no region/)).toBeInTheDocument();
  });
});

describe('a filter that selects nothing (G2.10)', () => {
  it('the empty quota list says the filter matches no project, never "request quota"', () => {
    const why = 'The filter selects nothing: nip-lab is not in eu-north1 (its region: uk-south1).';
    render(
      <Router>
        <QuotasCard metric={{ ...quotas, value: [] }} name={name} now={now} emptyScope={why} />
      </Router>,
    );
    expect(screen.getByText(why)).toBeInTheDocument();
    expect(screen.queryByText(/request quota in the console/)).toBeNull();
  });
});

describe('best region follows the selected capacity type (G2.4)', () => {
  // L40S in eu-north1: on-demand low (1 of 8), preemptible high (8 of 8); H200 on-demand at its limit, preemptible medium.
  const rows = [
    { region: 'eu-north1', platform: 'gpu-l40s-a', preset: '1gpu-8vcpu-32gb', onDemand: { level: 'low', available: 1, limit: 8 }, preemptible: { level: 'high', available: 8, limit: 8 } },
    { region: 'eu-west1', platform: 'gpu-h200-sxm', preset: '1gpu-16vcpu-200gb', onDemand: { level: 'limit-reached', available: 0, limit: 4 }, preemptible: { level: 'medium', available: 2, limit: 4 } },
  ];

  it('ranks, filters and labels by preemptible when Preemptible is selected', () => {
    expect(bestRegions(rows, 'preemptible')).toEqual([
      { platform: 'gpu-h200-sxm', region: 'eu-west1', preset: '1gpu-16vcpu-200gb', level: 'medium', stale: false },
      { platform: 'gpu-l40s-a', region: 'eu-north1', preset: '1gpu-8vcpu-32gb', level: 'high', stale: false },
    ]);
    // All types: on-demand, as before.
    expect(bestRegions(rows).map(b => [b.platform, b.level])).toEqual([['gpu-l40s-a', 'low']]);
  });

  it('the summary badge names the selected type, never "on-demand" under Preemptible', () => {
    render(<ResourceAdviceCard metric={{ source: 's', value: rows }} now={now} />);
    fireEvent.change(screen.getByLabelText('Advice capacity type'), { target: { value: 'preemptible' } });
    const best = screen.getByRole('list', { name: 'Best region per platform' });
    expect(best).toHaveTextContent('gpu-l40s-a · 1gpu-8vcpu-32gb: eu-north1 high preemptible');
    expect(best).toHaveTextContent('gpu-h200-sxm · 1gpu-16vcpu-200gb: eu-west1 medium preemptible');
    expect(best).not.toHaveTextContent('on-demand');
  });

  it('a long summary shows the first lines and folds the rest', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ region: 'eu-north1', platform: `gpu-p${String(i).padStart(2, '0')}`, preset: '1gpu-8vcpu-32gb', onDemand: { level: 'high', available: 4, limit: 8 } }));
    render(<ResourceAdviceCard metric={{ source: 's', value: many }} now={now} />);
    const best = screen.getByRole('list', { name: 'Best region per platform' });
    expect(best.querySelectorAll(':scope > li')).toHaveLength(6);
    expect(screen.getByText('6 more platform presets')).toBeInTheDocument();
  });
});

describe('quota polish (G2.12, G2.14)', () => {
  it('a quota id breaks only after its dots', () => {
    const { container } = render(<QuotaId name="compute.instance.preemptible.count" />);
    expect(container).toHaveTextContent('compute.instance.preemptible.count');
    expect(container.querySelectorAll('wbr')).toHaveLength(3);
  });

  it('the Status sort orders by urgency, not by the level names', () => {
    const row = (id: string, limit: number | null, usage: number) => ({ scope: 'tenant' as const, allocation: 'set' as const, projectId: '', name: id, region: 'eu-north1', limit, usage, usagePercent: limit ? (100 * usage) / limit : null });
    const rows = [row('compute.headroom', 100, 1), row('compute.zero', 0, 0), row('compute.over', 4, 4)];
    expect(rows.map(urgencyRank)).toEqual([3, 2, 0]);
    expect([...rows].sort((a, b) => urgencyRank(a) - urgencyRank(b)).map(r => r.name)).toEqual(['compute.over', 'compute.zero', 'compute.headroom']);
  });
});

describe('capacity cards: effective limits, dependencies, K8s, live platforms, search (W1-P14..W1-P18)', () => {
  const LAB = 'project-e00mocklab';
  const STAGING = 'project-e00mockstaging';
  const names = (id: string) => ({ [LAB]: 'lab', [STAGING]: 'staging' })[id] ?? id;
  const t = (quotaName: string, region: string, limit: number, usage: number, unit = 'gpu'): QuotaAllowanceView => ({ scope: 'tenant', allocation: 'set', projectId: '', name: quotaName, region, limit, usage, usagePercent: limit ? (100 * usage) / limit : null, unit });
  const p = (projectId: string, quotaName: string, region: string, limit: number | null, usage: number, unit = 'gpu'): QuotaAllowanceView => ({
    scope: 'project', allocation: limit === null ? 'inherits-tenant' : 'set', projectId, name: quotaName, region, limit, usage, usagePercent: null, unit,
  });
  const metric = (value: QuotaAllowanceView[]): CapacityResponse['quotas'] => ({ source: 'Quota allowances (quotas.v1)', value });
  const base = [
    t('compute.instance.gpu.b300', 'uk-south1', 32, 1),
    t('compute.instance.gpu.h100', 'eu-north1', 32, 2),
    t('compute.instance.non-gpu.vcpu', 'eu-north1', 0, 48, 'vcpu'),
    t('compute.instance.non-gpu.vcpu', 'uk-south1', 200, 16, 'vcpu'),
    t('compute.gpucluster.count', 'eu-north1', 5, 0, 'count'),
    p(LAB, 'compute.instance.gpu.b300', 'uk-south1', 1, 1),
    p(STAGING, 'compute.gpucluster.count', 'eu-north1', 0, 0, 'count'),
    p(STAGING, 'compute.instance.gpu.h100', 'eu-north1', null, 0),
  ];
  const tile = (container: HTMLElement, model: string) => [...container.querySelectorAll('.ne-cap-gpu')].find(el => el.querySelector('.ne-cap-gpu-model')?.textContent === model) as HTMLElement;

  it('W1-P14: with the project selected, the card leads with its effective limit, capped by project; the tenant figure is labelled tenant', () => {
    const { container } = render(<QuotasCard metric={metric(base.filter(q => q.scope === 'tenant' || q.projectId === LAB))} name={names} now={now} project={LAB} />);
    const b300 = tile(container, 'B300');
    expect(b300).toHaveTextContent('Effective limit for lab: 1 / 1 GPUs');
    expect(b300).toHaveTextContent('capped by project');
    expect(b300).toHaveTextContent('Tenant 1 / 32 GPUs');
    expect(b300).toHaveAttribute('data-level', 'over');
  });

  it('W1-P14: without a filter, the projects capped below the tenant limit are named on the card', () => {
    const { container } = render(<QuotasCard metric={metric(base)} name={names} now={now} />);
    expect(tile(container, 'B300')).toHaveTextContent('Capped by project: lab 1');
    expect(tile(container, 'H100')).not.toHaveTextContent('Capped by project');
  });

  it('W1-P14: a GPU clusters cap of 0 is badged on the GPU cards of that region', () => {
    const platforms: PlatformView[] = [{ name: 'gpu-h100-sxm', presets: [{ name: '8gpu-128vcpu-1600gb', gpus: 8, vcpus: 128, memoryGibibytes: 1600 }], projects: [STAGING], regions: ['eu-north1'] }];
    const { container } = render(<QuotasCard metric={metric(base)} name={names} now={now} platforms={platforms} />);
    expect(tile(container, 'H100')).toHaveTextContent('GPU clusters cap 0 (staging): 8-GPU presets cannot join an InfiniBand GPU cluster');
    expect(tile(container, 'B300')).not.toHaveTextContent('GPU clusters');
  });

  it('W1-P14: without the platform list, which models have an 8-GPU preset is not known, so no card gets the GPU-cluster badge', () => {
    const { container } = render(<QuotasCard metric={metric(base)} name={names} now={now} platforms={null} />);
    expect(tile(container, 'H100')).not.toHaveTextContent('GPU clusters');
  });

  it('W1-P14: allowances unread → "project cap unknown", and the tenant value is labelled tenant', () => {
    const { container } = render(<QuotasCard metric={metric(base.filter(q => q.scope === 'tenant'))} name={names} now={now} />);
    const h100 = tile(container, 'H100');
    expect(h100).toHaveTextContent('Project cap unknown');
    expect(h100).toHaveTextContent('Tenant 2 / 32 GPUs');
  });

  it('W1-P15: with project caps only and no filter, the line names the project whose cap it shows, and one project at 0 does not block the region', () => {
    const caps = [t('compute.instance.gpu.b300', 'uk-south1', 32, 1), p(LAB, 'compute.instance.non-gpu.vcpu', 'uk-south1', 0, 0, 'vcpu'), p(STAGING, 'compute.instance.non-gpu.vcpu', 'uk-south1', 64, 16, 'vcpu')];
    render(<QuotasCard metric={metric(caps)} name={names} now={now} />);
    const k8s = screen.getByRole('region', { name: 'Quotas in uk-south1' }).querySelector('.ne-cap-k8s');
    expect(k8s).toHaveTextContent('Usable by K8s recipes: yes. 48 of 64 non-GPU vCPUs free (staging cap)');
    expect(k8s).toHaveTextContent('Capped at 0 for lab.');
  });

  it('W1-P15: each region with GPU quota says whether the K8s recipes can start their CPU node groups', () => {
    render(<QuotasCard metric={metric(base)} name={names} now={now} />);
    const north = screen.getByRole('region', { name: 'Quotas in eu-north1' });
    expect(north.querySelector('.ne-cap-k8s')).toHaveTextContent('Usable by K8s recipes: no CPU nodes. Non-GPU vCPU limit 0 (tenant)');
    expect(north.querySelector('.ne-cap-k8s')).toHaveTextContent('cpu_node_count = 0');
    const south = screen.getByRole('region', { name: 'Quotas in uk-south1' });
    expect(south.querySelector('.ne-cap-k8s')).toHaveTextContent('Usable by K8s recipes: yes. 184 of 200 non-GPU vCPUs free (tenant)');
  });

  it('W1-P17: a GPU platform the live API offers without a quota of its model gets a card of its own', () => {
    const platforms: PlatformView[] = [{ name: 'gpu-gb300', humanName: 'NVIDIA GB300 NVL72 with NVIDIA Grace', presets: [{ name: '4gpu-112vcpu-800gb', gpus: 4, vcpus: 112, memoryGibibytes: 800 }], projects: [STAGING], regions: ['eu-north1'] }];
    const { container } = render(<QuotasCard metric={metric(base)} name={names} now={now} platforms={platforms} />);
    const gb300 = tile(container, 'GB300');
    expect(gb300).toBeTruthy();
    expect(gb300).toHaveTextContent('NVIDIA GB300 NVL72 with NVIDIA Grace');
    expect(gb300).toHaveTextContent('4gpu-112vcpu-800gb');
    expect(gb300).toHaveTextContent('No GPU quota listed');
    expect(gb300.closest('section')).toHaveAttribute('aria-label', 'Quotas in eu-north1');
  });

  it('W1-P16: a search covers every row, even when the near-limit filter is on', () => {
    const many = Array.from({ length: 60 }, (_, i) => t(`vpc.thing${i}.count`, 'eu-north1', 100, 1, 'count'));
    render(<QuotasCard metric={metric([...base, ...many])} name={names} now={now} />);
    const table = screen.getByRole('table', { name: 'All quota allowances' });
    const fold = within(table.closest('details')!);
    expect(fold.getByRole('checkbox', { name: /Near limit or blocked only/ })).toBeChecked();
    fireEvent.change(screen.getByLabelText('Search all tenant quotas'), { target: { value: 'thing42' } });
    expect(table).toHaveTextContent('vpc.thing42.count');
    expect(fold.getByText(/^1 of 65 shown/)).toHaveTextContent('1 of 65 shown (search covers every row)');
    expect(fold.getByRole('checkbox', { name: /Near limit or blocked only/ })).toBeDisabled();
    // "tenant" finds tenant allowances.
    fireEvent.change(screen.getByLabelText('Search all tenant quotas'), { target: { value: 'tenant thing4' } });
    expect(fold.getByText(/of 65 shown/)).toHaveTextContent('11 of 65 shown');
  });

  it('W1-P18: an empty reservation list leads to the capacity request runbook and the Nebius docs', () => {
    render(
      <Router>
        <BlockGroupsCard metric={{ value: [], source: 'Capacity block groups (capacity.v1, tenant)' }} now={now} />
      </Router>,
    );
    expect(screen.getByText('No reservations in this tenant')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /How to request a reservation/ })).toHaveAttribute('href', '/evidence?doc=runbooks%2Fcapacity-request.md#3-reservation-staging-optional-prod-training-required');
    expect(screen.getByRole('link', { name: /Reservations in the Nebius docs/ })).toHaveAttribute('href', 'https://docs.nebius.com/compute/virtual-machines/reservations');
  });

  it('#59: an allowance-check badge sits on its title row, not under the sentence', () => {
    const f = { kind: 'zero-cap' as const, projectId: STAGING, name: 'compute.gpucluster.count', region: 'eu-north1', description: 'GPU clusters', unit: 'count', projectLimit: 0, tenantLimit: 5, usage: 0 };
    render(
      <Router>
        <QuotasCard metric={metric(base)} name={names} now={now} allowances={{ value: [f], source: 's' }} />
      </Router>,
    );
    const row = screen.getByRole('list', { name: 'Project caps that differ from the tenant limit' }).querySelector('li')!;
    const title = row.querySelector('.ne-attn-row')!;
    expect(title).toHaveTextContent('GPU clusters');
    expect(title.lastElementChild).toHaveTextContent('cap 0');
    expect(title).not.toHaveTextContent('Blocks this project');
  });
});
