import type { ReactNode } from 'react';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { OverviewResponse } from '@internal/nebius-domain';
import { AttentionTile, BudgetsTile, ConnectorSummary, ConnectorTable, GpuSchedulingChecks, LiveRunRateTile, SetupHint, SourcedTile, TelemetryLines } from './parts';

const now = new Date('2026-10-11T12:00:00Z');
function Router({ children }: { children: ReactNode }) {
  return <MemoryRouter>{children}</MemoryRouter>;
}
const metric = (value: number | null) => ({ value, source: 's' });

describe('overview parts', () => {
  it('words a zero for quotas plainly, with the count Capacity shows, and never as a green 0', () => {
    const o = {
      ttlExpired: metric(0),
      orphanCandidates: metric(0),
      quotasNearLimit: { value: [], source: 'q', note: 'Tenant allowances at 80 % use or more. A quota is a ceiling.', coverage: { checked: 9, total: 419, zeroLimit: 1, summary: '0 at ≥ 80 % · 9 tenant quotas with a limit (1 at limit 0)' } },
      plannedQuotaIssues: { value: [], source: 'p' },
      maintenances: { value: [], source: 'm' },
      pendingProvisioningRequests: metric(0),
    } as unknown as OverviewResponse;
    render(
      <Router>
        <AttentionTile o={o} now={now} />
      </Router>,
    );
    const badge = screen.getByText('0 at ≥ 80 % · 9 tenant quotas with a limit (1 at limit 0)');
    expect(badge).toHaveAttribute('title', expect.stringContaining('ceiling'));
    expect(badge.className).toContain('ne-tone-neutral');
    // The threshold is said once, in the badge (the same words as Capacity); the long badge takes the row's width (F1.39 review).
    expect(screen.getByRole('link', { name: 'Quotas near their limit' })).toBeInTheDocument();
    expect(screen.queryByText(/Quotas at 80 %/)).toBeNull();
    expect(badge.closest('.ne-attn-row')!.className).toContain('ne-attn-row-wide');
  });

  it('phrases a GPU VM that advertises 0 allocatable GPUs as a check, with the guide', () => {
    render(<GpuSchedulingChecks checks={[{ cluster: 'nip-sandbox-inference', clusterId: 'mk8scluster-e00c', nodeGroups: ['ng-gpu'], gpuVms: 1, gpus: 1, allocatable: 0 }]} />);
    const li = screen.getByRole('list', { name: 'GPU scheduling checks' });
    expect(li).toHaveTextContent('1 GPU VM (1 GPU) in cluster nip-sandbox-inference (node group ng-gpu) advertises 0 allocatable GPUs. Check the node group’s GPU drivers preset');
    expect(screen.getByRole('link', { name: 'GPU set-up guide' })).toHaveAttribute('href', 'https://docs.nebius.com/kubernetes/gpu/set-up');
  });

  it('counts planned roots blocked by quota (as Capacity does) and links each tile to its section', () => {
    const issue = (plan: string, quota: string) => ({ plan, region: 'eu-north1', quota, need: 16, limit: 0, usage: 0, state: 'blocked', what: 'x' });
    const o = {
      ttlExpired: metric(0),
      orphanCandidates: metric(0),
      quotasNearLimit: { value: [], source: 'q' },
      plannedQuotaIssues: { value: [issue('terraform/live/sandbox/inference', 'a'), issue('terraform/live/sandbox/inference', 'b'), issue('terraform/live/prod/training', 'a')], source: 'p' },
      maintenances: { value: [], source: 'm' },
      pendingProvisioningRequests: metric(0),
    } as unknown as OverviewResponse;
    render(
      <Router>
        <AttentionTile o={o} now={now} />
      </Router>,
    );
    const planned = screen.getByRole('link', { name: 'Planned resources blocked by quota' });
    expect(planned).toHaveAttribute('href', '/capacity#planned-quota');
    expect(planned.closest('li')).toHaveTextContent('2'); // two roots, three quota lines
    expect(screen.getByRole('link', { name: 'Quotas near their limit' })).toHaveAttribute('href', '/capacity#quotas');
    expect(screen.getByRole('link', { name: 'Scheduled maintenance' })).toHaveAttribute('href', '/capacity#maintenance');
  });

  it('adds a row for project caps that cut a project (below the tenant limit or 0), only when there are some', () => {
    const f = (kind: string, quota: string) => ({ kind, projectId: 'project-e00a', name: quota, region: 'eu-west2', projectLimit: 1, tenantLimit: 10, usage: 0 });
    const base = { ttlExpired: metric(0), orphanCandidates: metric(0), quotasNearLimit: { value: [], source: 'q' }, plannedQuotaIssues: { value: [], source: 'p' }, maintenances: { value: [], source: 'm' }, pendingProvisioningRequests: metric(0) };
    const { unmount } = render(
      <Router>
        <AttentionTile o={{ ...base, allowanceCheck: { value: [f('caps-below', 'vpc.allocation.count'), f('zero-cap', 'dns.zone.count'), f('no-effect', 'compute.instance.count')], source: 'a' } } as unknown as OverviewResponse} now={now} />
      </Router>,
    );
    const row = screen.getByRole('link', { name: 'Project quota caps below the tenant limit' });
    expect(row).toHaveAttribute('href', '/capacity#allowance-check');
    expect(row.closest('li')).toHaveTextContent('2');
    expect(row.closest('li')).toHaveTextContent('vpc.allocation.count');
    unmount();
    render(
      <Router>
        <AttentionTile o={{ ...base, allowanceCheck: { value: [f('no-effect', 'compute.instance.count')], source: 'a' } } as unknown as OverviewResponse} now={now} />
      </Router>,
    );
    expect(screen.queryByRole('link', { name: 'Project quota caps below the tenant limit' })).not.toBeInTheDocument();
  });

  it('gives an Unavailable exactly one Fix link, to the page where the fix happens (W1-P24)', () => {
    const { container } = render(
      <Router>
        <SetupHint reason="No rate book has been imported." setup="docs/portal/nebius-setup.md#budgets-and-the-default-rate-book" />
      </Router>,
    );
    expect(container.querySelectorAll('a')).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'Fix: Import or build a rate book →' })).toHaveAttribute('href', '/commercial?tab=ratebooks');
  });

  it('never leaves a bare dash in the connector table', () => {
    const statuses = [
      { id: 'kubernetes', title: 'Kubernetes workloads (optional)', state: 'optional', scope: '—', permissions: '', services: [], staleAfterMinutes: 0, missingCoverage: ['Needs a Managed Kubernetes cluster.'], setup: 'docs/portal/nebius-setup.md#kubernetes' },
      { id: 'nebius-inventory', title: 'Nebius inventory', state: 'ok', scope: '9 projects', permissions: '', services: [], staleAfterMinutes: 45, missingCoverage: [], setup: 'docs/portal/nebius-setup.md', lastSuccess: '2026-10-11T11:50:00Z' },
    ] as any;
    render(
      <Router>
        <ConnectorTable statuses={statuses} now={now} />
      </Router>,
    );
    const table = screen.getByRole('table', { name: 'Connector health' });
    expect(table).not.toHaveTextContent('—');
    expect(screen.getAllByTitle('not applicable: an optional connector')[0]).toHaveTextContent('n/a');
    expect(table).toHaveTextContent('No issue');
  });

  it('colours the 24 h success rate as the connector cards do: 99.1 % is fine, a shared outage is not the connector\'s (G1.8)', () => {
    const OUT = '2026-10-12T04:20:17.000Z';
    const st = (id: string, runs24h: number, failures24h: number, lastFailureAt?: string) =>
      ({ id, title: id, state: 'ok', scope: 's', missingCoverage: [], health: { runs24h, failures24h, successRate24h: (runs24h - failures24h) / runs24h, p50Ms: 1, p95Ms: 2, consecutiveFailures: 0, lastFailureAt, recentRuns: [] } }) as any;
    render(
      <Router>
        <ConnectorTable statuses={[st('a', 117, 1, '2026-10-12T09:00:00.000Z'), st('b', 55, 1, OUT), st('c', 20, 4, '2026-10-12T09:00:00.000Z')]} now={now} outages={new Set([OUT])} />
      </Router>,
    );
    const rate = (text: string) => screen.getByText(text, { exact: false }).closest('span.ne-num') as HTMLElement;
    expect(rate('99.1 %').getAttribute('style') ?? '').not.toMatch(/warn|danger/);
    expect(rate('98.2 %').getAttribute('style') ?? '').not.toMatch(/warn|danger/);
    expect(rate('80 %').getAttribute('style')).toMatch(/--ne-danger/);
  });

  it('says "nothing running" for an empty source, without "Unavailable" or a setup prompt', () => {
    render(
      <Router>
        <SourcedTile label="Measured GPU utilisation" metric={{ value: null, source: 'GPU telemetry', empty: 'No GPUs running', unavailableReason: 'No running GPU VM in scope.' }} now={now} setup="docs/portal/nebius-setup.md#telemetry" render={() => null} />
      </Router>,
    );
    const tile = screen.getByRole('region', { name: 'Measured GPU utilisation' });
    expect(tile).toHaveTextContent('No GPUs running');
    expect(tile).not.toHaveTextContent('Unavailable');
    expect(tile).not.toHaveTextContent('Set up');
  });

  it('shows a 0 run-rate when nothing runs, under the same label as a priced one', () => {
    const book = { data: { value: null, unavailableReason: 'No rate book has been imported.' }, reload: () => {} } as any;
    const { unmount } = render(
      <Router>
        <LiveRunRateTile live={{ data: { value: null, unavailableReason: 'No running VMs, disks, filesystems or managed databases in scope to price.', nothingRunning: { currency: 'USD' } }, reload: () => {} } as any} book={book} now={now} />
      </Router>,
    );
    const tile = screen.getByRole('region', { name: 'Run-rate (live)' });
    expect(tile).toHaveTextContent('0 USD / h');
    expect(tile).toHaveTextContent('nothing running');
    expect(tile).not.toHaveTextContent('Set up');
    expect(tile).not.toHaveTextContent('Fallback');
    unmount();
    const est = { source: 'Nebius billing calculator (list price)', offer: 'list', asOf: '2026-10-11T09:00:00Z', currency: 'USD', projectId: 'p', contract: { attempted: false, available: null }, lines: [], hourly: { amount: '0.81', currency: 'USD' }, unpriced: [] };
    render(
      <Router>
        <LiveRunRateTile live={{ data: { value: est }, reload: () => {} } as any} book={book} now={now} />
      </Router>,
    );
    expect(screen.getByRole('region', { name: 'Run-rate (live)' })).toHaveTextContent('list price');
  });

  it('gives unavailable temperature and power a Fix link when the tile has none of its own (W1-P24)', () => {
    const m = { value: null, source: 'GPU telemetry', unavailableReason: 'No DCGM exporter answers.' } as any;
    const { container, unmount } = render(
      <Router>
        <TelemetryLines metric={m} now={now} setup="docs/portal/nebius-setup.md#telemetry" />
      </Router>,
    );
    expect(container).toHaveTextContent('Temperature and power unavailable: No DCGM exporter answers.');
    expect(container.querySelectorAll('a[data-fix]')).toHaveLength(1);
    unmount();
    // Without `setup` (the tile is Unavailable and carries its own Fix): no second one.
    const own = render(
      <Router>
        <TelemetryLines metric={m} now={now} />
      </Router>,
    );
    expect(own.container.querySelectorAll('a[data-fix]')).toHaveLength(0);
  });

  it('prints the telemetry source once when it is the tile\'s own source', () => {
    const m = { value: [{ node: 'n', tempC: 27, powerW: 34, source: 'Nebius Monitoring (service-provider GPU metrics)' }], source: 'Nebius Monitoring (service-provider GPU metrics)', observedAt: '2026-10-11T11:57:00Z' } as any;
    const { container } = render(<TelemetryLines metric={m} now={now} tileSource="Nebius Monitoring (service-provider GPU metrics)" />);
    expect(container).not.toHaveTextContent('Nebius Monitoring');
    const other = render(<TelemetryLines metric={m} now={now} tileSource="GPU telemetry" />);
    expect(other.container).toHaveTextContent('Nebius Monitoring (service-provider GPU metrics) · 3 min ago');
  });

  it('F1.14/F1.15: the connector table on Integrations says partial and does not link to itself; the Overview has one line and a link', () => {
    const statuses = [
      {
        id: 'nebius-inventory', title: 'Nebius inventory', state: 'permission-denied', scope: '4 projects', permissions: '', services: [], staleAfterMinutes: 45, setup: 'docs/portal/nebius-setup.md', lastSuccess: '2026-10-11T11:50:00Z',
        error: 'p vpc.networks: GET http://h/vpc/v1/networks → 403: {"code":7,"message":"PermissionDenied"}', missingCoverage: ['Networks (permission denied)', 'Subnets (permission denied)', 'DNS zones (not found)'],
      },
      { id: 'logs', title: 'Logs', state: 'ok', scope: '4 projects', permissions: '', services: [], staleAfterMinutes: 45, missingCoverage: [], setup: 'docs/x.md', lastSuccess: '2026-10-11T11:50:00Z' },
      { id: 'mk8s:x', title: 'Kubernetes — x', state: 'waiting', scope: 'cluster x', permissions: '', services: [], staleAfterMinutes: 45, missingCoverage: [], setup: 'docs/x.md', notes: ['Cluster is PROVISIONING.'] },
    ] as any;
    const { unmount } = render(
      <Router>
        <ConnectorTable statuses={statuses} now={now} onIntegrations />
      </Router>,
    );
    const table = screen.getByRole('table', { name: 'Connector health' });
    // One wording on the card, in the State column and in the Overview line (W1F.S3).
    expect(table).toHaveTextContent('partial (2 calls refused, 1 waiting for data)');
    expect(table).not.toHaveTextContent('permission denied');
    expect(table).toHaveTextContent('Which project refused which call — in its card below');
    expect(screen.queryByRole('link', { name: /see Integrations/ })).not.toBeInTheDocument();
    unmount();
    render(
      <Router>
        <ConnectorSummary statuses={statuses} />
      </Router>,
    );
    const summary = screen.getByRole('region', { name: 'Connector health' });
    expect(summary).toHaveTextContent('3 connectors: 1 ok · 1 partial (2 calls refused, 1 waiting for data) · 1 waiting');
    // Every count is the filter that lists those connectors on Integrations (W1-P29).
    expect(screen.getByRole('link', { name: '1 ok' })).toHaveAttribute('href', '/integrations?connectors=ok#connector-summary');
    expect(screen.getByRole('link', { name: '1 waiting' })).toHaveAttribute('href', '/integrations?connectors=waiting#connector-summary');
    expect(screen.getByRole('link', { name: /^1 partial/ })).toHaveAttribute('href', '/integrations?connectors=partial#connector-summary');
    // Only the part that needs a look is a badge; the healthy count and the waiting ones are plain text.
    const badges = summary.querySelectorAll('.ne-badge');
    expect(badges).toHaveLength(1);
    expect(badges[0]).toHaveTextContent(/^1 partial \(2 calls refused, 1 waiting for data\)$/);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'All integrations →' })).toHaveAttribute('href', '/integrations');
  });

  it('F1.11: a quota in use above its limit is an attention item of its own, in the danger tone, also on a phone', () => {
    const vcpu = { scope: 'tenant', allocation: 'set', projectId: '', name: 'compute.instance.non-gpu.vcpu', description: 'vCPUs for non-GPU VMs', region: 'eu-north1', limit: 0, usage: 48, usagePercent: null, unit: 'vcpu', reportedUsage: 0 };
    const o = {
      ttlExpired: metric(0),
      orphanCandidates: metric(0),
      quotasNearLimit: { value: [], source: 'q', coverage: { checked: 9, total: 9, zeroLimit: 1, summary: '0 at ≥ 80 % · 9 tenant quotas with a limit (1 at limit 0)' } },
      quotasAboveLimit: { value: [vcpu], source: 'q' },
      plannedQuotaIssues: { value: [], source: 'p' },
      maintenances: { value: [], source: 'm' },
      pendingProvisioningRequests: metric(0),
    } as unknown as OverviewResponse;
    const original = window.matchMedia;
    const view = () =>
      render(
        <Router>
          <AttentionTile o={o} now={now} />
        </Router>,
      );
    const wide = view();
    const row = screen.getByRole('link', { name: 'Quotas in use above the limit' }).closest('li')!;
    expect(row.querySelector('.ne-badge')).toHaveTextContent(/^1$/);
    expect(row.querySelector('.ne-badge')!.className).toContain('ne-tone-danger');
    expect(row).toHaveTextContent('vCPUs for non-GPU VMs · eu-north1 48 / 0');
    expect(screen.getByRole('link', { name: 'Quotas in use above the limit' })).toHaveAttribute('href', '/capacity#quotas');
    wide.unmount();
    window.matchMedia = ((q: string) => ({ matches: q === '(max-width: 600px)', addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia;
    try {
      const { container } = view();
      expect(container.querySelector('summary')).toHaveTextContent('1 Quotas in use above the limit');
    } finally {
      window.matchMedia = original;
    }
  });

  it('F1.15, #25, #44: on a phone the strip folds to a short list of what needs a look; on a wide screen there is no fold to get stuck', () => {
    const o = {
      ttlExpired: metric(18),
      orphanCandidates: metric(0),
      quotasNearLimit: { value: [], source: 'q', coverage: { checked: 9, total: 9, zeroLimit: 1, summary: '0 at ≥ 80 % · 9 tenant quotas with a limit (1 at limit 0)' } },
      plannedQuotaIssues: { value: null, source: 'p', unavailableReason: 'not read' },
      maintenances: { value: [], source: 'm' },
      pendingProvisioningRequests: metric(0),
    } as unknown as OverviewResponse;
    const original = window.matchMedia;
    const view = () =>
      render(
        <Router>
          <AttentionTile o={o} now={now} />
        </Router>,
      );
    // Wide: the list itself, with no details element that a narrow-to-wide flip could leave closed (#44).
    const wide = view();
    expect(wide.container.querySelector('details.ne-attn-fold')).toBeNull();
    expect(screen.getByRole('link', { name: 'TTL expired' })).toBeInTheDocument();
    wide.unmount();
    window.matchMedia = ((q: string) => ({ matches: q === '(max-width: 600px)', addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia;
    try {
      const { container } = view();
      const fold = container.querySelector('details.ne-attn-fold') as HTMLDetailsElement;
      expect(fold.open).toBe(false);
      const summary = fold.querySelector('summary')!;
      // One short row per item that needs a look: count, then label (#25); zeros left out; an unreadable source says so.
      const rows = [...summary.querySelectorAll('.ne-attn-sum-row')].map(r => r.textContent);
      expect(rows).toEqual(['18 TTL expired', 'unavailable Planned resources blocked by quota']);
      expect(summary).not.toHaveTextContent('Orphan candidates');
      // "Show all" says what all covers: the checks, not more problems (#25).
      expect(summary.querySelector('.ne-attn-more')).toHaveTextContent('Show all 6 checks');
    } finally {
      window.matchMedia = original;
    }
  });

  it('#2, #4: project-cap rows name the project, and say that acknowledging an intended cap with a note is the expected action', () => {
    const cut = { kind: 'zero-cap', projectId: 'project-e00mocklab', name: 'compute.instance.gpu.h100', description: 'H100 GPUs', region: 'eu-north1', unit: 'gpu', projectLimit: 0, tenantLimit: 8, usage: 0 };
    const o = {
      ttlExpired: metric(0),
      orphanCandidates: metric(0),
      quotasNearLimit: { value: [], source: 'q' },
      plannedQuotaIssues: { value: [], source: 'p' },
      allowanceCheck: { value: [cut], source: 'a' },
      maintenances: { value: [], source: 'm' },
      pendingProvisioningRequests: metric(0),
    } as unknown as OverviewResponse;
    render(
      <Router>
        <AttentionTile o={o} now={now} projectName={id => (id === 'project-e00mocklab' ? 'nip-lab' : undefined)} />
      </Router>,
    );
    const row = screen.getByRole('link', { name: 'Project quota caps below the tenant limit' }).closest('li')!;
    expect(row).toHaveTextContent('nip-lab · H100 GPUs · compute.instance.gpu.h100 · eu-north1');
    expect(row).not.toHaveTextContent('project-e00mocklab');
    expect(row).toHaveTextContent('Intended (a project kept small on purpose)? Acknowledge its alert with a note');
    expect(within(row as HTMLElement).getByRole('link', { name: 'Acknowledge on Alerts' })).toHaveAttribute('href', '/alerts');
  });

  it('shows tracked credits on the Overview when no budget exists, and says the tile is not filtered (G1.18, G1.1)', () => {
    const credit = { id: 'c1', name: 'Token Factory promo', amount: '25', currency: 'USD', remaining: { amount: '25', currency: 'USD' }, status: 'ok', statusText: 'Active' };
    const d = { budgets: [], configBudgets: [], credits: [credit] } as any;
    const { unmount } = render(
      <Router>
        <BudgetsTile load={{ data: d }} filter={{ stage: 'sandbox' }} />
      </Router>,
    );
    const tile = screen.getByRole('region', { name: 'Budgets (advisory)' });
    expect(tile).toHaveTextContent('Token Factory promo');
    expect(tile).toHaveTextContent('25.00 USD of 25.00 USD left · no expiry entered');
    expect(tile).toHaveTextContent('Not filtered by stage: whole account');
    unmount();
    const { container } = render(
      <Router>
        <BudgetsTile load={{ data: { budgets: [], configBudgets: [], credits: [] } as any }} filter={{}} />
      </Router>,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
