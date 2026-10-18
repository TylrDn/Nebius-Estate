import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { CapabilityStatus, ConnectorStatus } from '@internal/nebius-domain';
import { CapabilityGroups } from './CapabilityGroups';
import { ConnectorCard } from './ConnectorCard';

const now = new Date('2026-10-11T12:00:00Z');

const caps: CapabilityStatus[] = [
  { id: 'compute.instances', title: 'VMs', service: 'compute', connector: 'nebius-inventory', scope: 'project', path: '/compute/v1/instances', method: 'GET', state: 'ok', items: 12, lastSuccess: '2026-10-11T11:55:00Z', verified: '2026-10-11' },
  {
    id: 'capacity.block-groups',
    title: 'Capacity block groups (reservations)',
    service: 'capacity',
    connector: 'nebius-inventory',
    scope: 'tenant',
    path: '/capacity/v1/capacity-block-groups',
    method: 'GET',
    state: 'permission-denied',
    lastAttempt: '2026-10-11T11:55:00Z',
    lastError: '403 Forbidden',
    hint: 'Refused for this identity: grant a tenant-level read role (for example `security-auditor`) to the portal’s group (docs/credentials.md).',
  },
  {
    id: 'vpc.pools',
    title: 'IP pools',
    service: 'vpc',
    connector: 'nebius-inventory',
    scope: 'project',
    path: '/vpc/v1/pools',
    method: 'GET',
    state: 'schema-drift',
    items: 2,
    drift: ['spec.cidrs: expected array'],
    stale: true,
    perProject: [
      { id: 'project-e00a', name: 'training', state: 'ok', items: 2 },
      { id: 'project-e00b', name: 'serving', state: 'schema-drift', error: 'spec.cidrs' },
    ],
    health: {
      runs24h: 4,
      successRate24h: 0.5,
      p50Ms: 300,
      p95Ms: 1200,
      consecutiveFailures: 2,
      recentRuns: [
        { at: '2026-10-11T11:55:00Z', ok: false, durationMs: 1200, errorClass: 'schema-drift' },
        { at: '2026-10-11T11:40:00Z', ok: true, durationMs: 300 },
      ],
    },
  },
];

describe('CapabilityGroups', () => {
  it('stacks into labelled cells on a phone, like every other table on the page (G1.11)', () => {
    render(
      <MemoryRouter>
        <CapabilityGroups capabilities={caps} now={now} />
      </MemoryRouter>,
    );
    const table = screen.getByRole('table', { name: 'API capabilities by service area' });
    expect(table.className).toContain('ne-table-stack');
    const cells = [...table.querySelectorAll('tbody tr[data-state] > td')];
    expect(cells.length).toBeGreaterThan(0);
    expect(cells.map(td => td.getAttribute('data-label'))).toEqual(expect.not.arrayContaining([null]));
    expect(new Set(cells.map(td => td.getAttribute('data-label')))).toEqual(new Set(['Capability', 'State', 'Items', 'Freshness', 'Health (24 h)', 'Role to grant · last error · drift']));
  });

  const view = () =>
    render(
      <MemoryRouter>
        <CapabilityGroups capabilities={caps} now={now} />
      </MemoryRouter>,
    );

  it('groups by service area and shows state, items, freshness and the role to grant with a docs link', () => {
    view();
    expect(screen.getAllByRole('rowheader').map(h => h.textContent)).toEqual([expect.stringMatching(/^Compute/), expect.stringMatching(/^VPC networking/), expect.stringMatching(/^Capacity/)]);
    expect(screen.getByText('security-auditor').tagName).toBe('CODE');
    expect(screen.getAllByRole('link', { name: 'docs/credentials.md' })[0]).toHaveAttribute('href', '/evidence?doc=docs%2Fcredentials.md');
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('success 5 min ago')).toBeInTheDocument();
    // IP pools has no lastSuccess at this sync, but a successful run in its history: never "never succeeded".
    expect(screen.getAllByText('never succeeded')).toHaveLength(1);
    expect(screen.getByText('success 20 min ago')).toBeInTheDocument();
    expect(screen.getByText('stale data kept')).toBeInTheDocument();
    expect(screen.getByText('spec.cidrs: expected array')).toBeInTheDocument();
    expect(screen.getByText('2 failed in a row')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /Last 2 runs: 1 succeeded, 1 failed/ })).toBeInTheDocument();
  });

  it('expands per-project outcomes from the keyboard-reachable button', () => {
    view();
    const btn = screen.getByRole('button', { name: /Show per project \(2\)/ });
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(btn);
    expect(screen.getByRole('button', { name: /Hide per project/ })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('list', { name: 'IP pools per project' })).toHaveTextContent('serving');
  });

  it('surfaces a failing project on the row without expanding it', () => {
    view();
    expect(screen.getByText('Failing in serving: schema drift (spec.cidrs)')).toBeInTheDocument();
  });

  it('a call with successful runs is never "never succeeded", even when it is not configured now (node groups without a cluster)', () => {
    const ng: CapabilityStatus = {
      id: 'mk8s.node-groups', title: 'Node groups', service: 'mk8s', connector: 'nebius-inventory', scope: 'cluster', path: '/mk8s/v1/node-groups', method: 'GET', state: 'not-configured',
      hint: 'No Managed Kubernetes cluster in the listed projects.',
      health: { runs24h: 30, successRate24h: 1, p50Ms: 368, p95Ms: 500, consecutiveFailures: 0, recentRuns: [{ at: '2026-10-11T08:00:00Z', ok: true, durationMs: 368 }] },
    };
    render(
      <MemoryRouter>
        <CapabilityGroups capabilities={[ng]} now={now} />
      </MemoryRouter>,
    );
    expect(screen.queryByText('never succeeded')).not.toBeInTheDocument();
    expect(screen.getByText('success 4 h ago')).toBeInTheDocument();
  });

  it('filters to the capabilities that need attention', () => {
    view();
    fireEvent.click(screen.getByRole('button', { name: /Needs attention 2/ }));
    expect(screen.queryByText('VMs')).not.toBeInTheDocument();
    expect(screen.getByText('IP pools')).toBeInTheDocument();
  });
});

describe('ConnectorCard', () => {
  it('keeps keyboard focus on "Sync now" while the sync runs (aria-disabled, never disabled)', () => {
    const onSync = jest.fn();
    const s: ConnectorStatus = { id: 'tf', title: 'Token Factory', state: 'ok', scope: 'tenant', permissions: 'key', services: [], staleAfterMinutes: 0, missingCoverage: [], setup: 'docs/x.md' };
    const view = (syncing: boolean) => (
      <MemoryRouter>
        <ConnectorCard s={s} capabilities={[]} now={now} canSync syncing={syncing} onSync={onSync} />
      </MemoryRouter>
    );
    const { rerender } = render(view(false));
    const btn = screen.getByRole('button', { name: /Sync now/ });
    btn.focus();
    fireEvent.click(btn);
    expect(onSync).toHaveBeenCalledTimes(1);
    rerender(view(true));
    const busy = screen.getByRole('button', { name: /Syncing/ });
    expect(busy).toBe(btn);
    expect(busy).not.toBeDisabled();
    expect(busy).toHaveAttribute('aria-disabled', 'true');
    expect(busy).toHaveFocus();
    fireEvent.click(busy);
    expect(onSync).toHaveBeenCalledTimes(1); // a second click while syncing does nothing
  });

  const base: ConnectorStatus = {
    id: 'nebius-inventory',
    title: 'Nebius inventory',
    state: 'ok',
    scope: '2 projects',
    permissions: 'viewer',
    services: ['compute'],
    staleAfterMinutes: 45,
    missingCoverage: ['quotas', 'capacity blocks'],
    setup: 'docs/portal/nebius-setup.md',
  };
  const card = (s: ConnectorStatus, capabilities: CapabilityStatus[] = []) =>
    render(
      <MemoryRouter>
        <ConnectorCard s={s} capabilities={capabilities} now={now} canSync syncing={false} onSync={() => undefined} />
      </MemoryRouter>,
    );

  it('a sync where calls got no answer reads "degraded (N of M calls failed)" and names the cause in full (F1.30, F1.31)', () => {
    card({
      ...base,
      state: 'degraded',
      lastSuccess: '2026-10-11T11:30:00Z',
      calls: { total: 36, failed: 16 },
      error: 'project-e00mocklab compute.instances: https://api.nebius.cloud/compute/v1/instances: fetch failed (ENOTFOUND: getaddrinfo ENOTFOUND api.nebius.cloud) after 9 attempts in 28 s',
    });
    expect(screen.getByText('degraded (16 of 36 calls failed)')).toBeInTheDocument();
    expect(screen.getByText(/fetch failed \(ENOTFOUND: getaddrinfo ENOTFOUND api\.nebius\.cloud\) after 9 attempts in 28 s/)).toBeInTheDocument();
  });

  it('a deleted cluster\'s connector reads "retired" in a neutral tone, with no Sync now and no error', () => {
    card({ ...base, id: 'k8s:nip-legacy', title: 'Kubernetes — nip-legacy', state: 'disabled', notes: ['Retired: the cluster no longer exists.'] });
    const pill = screen.getByText('retired');
    expect(pill.closest('.ne-badge')).toHaveClass('ne-tone-neutral');
    expect(screen.queryByText('disabled')).toBeNull();
    expect(screen.queryByRole('button', { name: /Sync now/ })).toBeNull();
    expect(screen.getByText('Retired: the cluster no longer exists.')).toBeInTheDocument();
  });

  it('replaces the hand-written gap list with the calls that did not answer at the last sync', () => {
    card(base, caps);
    expect(screen.queryByText(/quotas; capacity blocks/)).not.toBeInTheDocument();
    expect(screen.getByText(/Capacity block groups \(reservations\) \(permission denied\)/)).toBeInTheDocument();
  });

  it('keeps the known gaps of connectors without per-call status', () => {
    card({ ...base, id: 'prometheus' });
    expect(screen.getByText(/quotas; capacity blocks/)).toBeInTheDocument();
  });

  it('shows health when present and nothing extra when absent', () => {
    const { unmount } = card(base);
    expect(screen.queryByText('Health')).not.toBeInTheDocument();
    unmount();
    card({ ...base, health: { runs24h: 96, successRate24h: 1, p50Ms: 900, p95Ms: 2100, consecutiveFailures: 0, nextRunAt: '2026-10-11T12:10:00Z', recentRuns: [{ at: '2026-10-11T11:55:00Z', ok: true, durationMs: 900 }] } });
    expect(screen.getByText('100 % succeeded')).toBeInTheDocument();
    expect(screen.getByText('900 ms · 2.1 s')).toBeInTheDocument();
    expect(screen.getByText('in 10 min')).toBeInTheDocument();
  });

  it('says why the next run comes early: "in 2 min (a cluster is provisioning)", and shows a paused fast re-sync note', () => {
    const health = { runs24h: 5, successRate24h: 1, p50Ms: 900, p95Ms: 2100, consecutiveFailures: 0, nextRunAt: '2026-10-11T12:02:00Z', nextRunReason: 'a cluster is provisioning', recentRuns: [] };
    const { unmount } = card({ ...base, health });
    expect(screen.getByText('in 2 min (a cluster is provisioning)')).toBeInTheDocument();
    unmount();
    card({ ...base, notes: ['Fast re-sync paused after 30 syncs in a row while a cluster is provisioning; back to the normal cadence (every 15 min) until nothing is changing state.'], health: { ...health, nextRunAt: '2026-10-11T12:10:00Z', nextRunReason: undefined } });
    expect(screen.getByText('in 10 min')).toBeInTheDocument();
    expect(screen.getByText(/^Fast re-sync paused after 30 syncs in a row/)).toBeInTheDocument();
  });

  it('says "not set up" for a connector missing its settings, never "every call answered" or a failure count', () => {
    const notSet = { ...base, id: 'billing-object-storage', title: 'Billing export pull', state: 'not-configured' as const, error: 'needs 4 environment variables: A, B, C, D', setup: 'docs/portal/billing-and-pricing.md#billing-export-pull' };
    const run = (errorClass: string) => ({ at: '2026-10-11T11:55:00Z', ok: false, durationMs: 0, errorClass });
    card(
      { ...notSet, health: { runs24h: 0, successRate24h: null, p50Ms: null, p95Ms: null, consecutiveFailures: 0, failures24h: 0, recentRuns: [run('not-configured'), run('not-configured')] } },
      [{ ...caps[0], id: 'billing.export.objects', connector: 'billing-object-storage', state: 'not-configured' }],
    );
    expect(screen.getByText('Not set up')).toBeInTheDocument();
    expect(screen.getByText(/Needs 4 environment variables/)).toBeInTheDocument();
    expect(screen.queryByText('Every call answered.')).not.toBeInTheDocument();
    expect(screen.getByText(/No call made: not set up/)).toBeInTheDocument();
    expect(screen.getByText('no run in 24 h')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /0 failed, 2 not set up or waiting/ })).toBeInTheDocument();
  });

  it('shows how many runs failed in 24 h and when, next to the rate', () => {
    card({ ...base, health: { runs24h: 38, successRate24h: 0.947, p50Ms: 900, p95Ms: 2100, consecutiveFailures: 0, failures24h: 2, lastFailureAt: '2026-10-11T06:00:00Z', recentRuns: [{ at: '2026-10-11T11:55:00Z', ok: true, durationMs: 900 }] } });
    expect(screen.getByText(/2 of 38 failed in 24 h · last failure 6 h ago/)).toBeInTheDocument();
  });

  it('an unset external Prometheus reads as complete: "not needed", no gap list, no Sync button', () => {
    card({ ...base, id: 'prometheus', title: 'External Prometheus', state: 'not-needed', missingCoverage: ['GPU telemetry already comes from Nebius Monitoring (official endpoint, all listed projects). Set this only for a Prometheus you run outside Nebius.'] });
    expect(screen.getByText('not needed')).toBeInTheDocument();
    expect(screen.getByText(/already comes from Nebius Monitoring/)).toBeInTheDocument();
    expect(screen.queryByText(/Known gaps/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Sync now/ })).not.toBeInTheDocument();
  });

  it('an on-demand connector says so, never "stale after 0 min"', () => {
    card({ ...base, id: 'nebius-pricing', title: 'Live prices', staleAfterMinutes: 0, lastSuccess: '2026-10-11T11:57:00Z', freshnessMinutes: 3 });
    expect(screen.queryByText(/stale after 0 min/)).not.toBeInTheDocument();
    expect(screen.getByText(/3 min since the last answer · on demand: priced when a page asks/)).toBeInTheDocument();
  });

  it('names the project whose call fails on the card (a per-project 503)', () => {
    const reg: CapabilityStatus = {
      id: 'registry.registries', title: 'Container registries', service: 'registry', connector: 'nebius-inventory', scope: 'project', path: '/registry/v1/registries', method: 'GET', state: 'unreachable',
      lastSuccess: '2026-10-11T11:55:00Z',
      perProject: [
        { id: 'project-e00a', name: 'default-project-eu-west2', state: 'ok', items: 0 },
        { id: 'project-e00b', name: 'default-project-eu-west1', state: 'unreachable', error: '503 Service Unavailable' },
      ],
    };
    card(base, [reg]);
    expect(screen.getByText(/Container registries \(unreachable in default-project-eu-west1 \(503\)\)/)).toBeInTheDocument();
  });

  it('reads "degraded" for a connector under 90 % success', () => {
    card({ ...base, state: 'degraded', health: { runs24h: 66, successRate24h: 0.576, p50Ms: 900, p95Ms: 2100, consecutiveFailures: 0, failures24h: 28, recentRuns: [] } });
    expect(screen.getByText('degraded')).toBeInTheDocument();
  });

  it('disables Sync now while a sync is running', () => {
    card({ ...base, running: true });
    expect(screen.getByText('sync in progress')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Sync in progress/ })).toHaveAttribute('aria-disabled', 'true');
  });
});

describe('a connector whose sync ran while some calls were refused (F1.14)', () => {
  const raw = (path: string) => `project-e00mocklegacy ${path}: GET http://127.0.0.1:7199/${path.replace('.', '/v1/')} → 403: {"code":7,"message":"PermissionDenied"}`;
  const s: ConnectorStatus = {
    id: 'nebius-inventory',
    title: 'Nebius inventory (REST API)',
    state: 'permission-denied',
    scope: '4 projects',
    permissions: 'viewer on each listed project',
    services: ['vpc'],
    staleAfterMinutes: 45,
    lastSuccess: '2026-10-11T11:55:00Z',
    lastAttempt: '2026-10-11T11:55:00Z',
    error: [raw('vpc.networks'), raw('vpc.subnets')].join('; '),
    missingCoverage: ['Networks (permission denied)', 'Subnets (permission denied)'],
    setup: 'docs/portal/nebius-setup.md',
    health: { runs24h: 1, successRate24h: 1, p50Ms: 72, p95Ms: 72, consecutiveFailures: 0, recentRuns: [{ at: '2026-10-11T11:55:00Z', ok: true, durationMs: 72 }] },
  };
  const refused = (title: string, path: string): CapabilityStatus => ({
    id: path,
    title,
    service: 'vpc',
    connector: 'nebius-inventory',
    scope: 'project',
    path,
    method: 'GET',
    state: 'permission-denied',
    lastError: `GET http://127.0.0.1:7199${path} → 403: {"code":7,"message":"PermissionDenied"}`,
    perProject: [
      { id: 'project-e00mocklegacy', name: 'legacy-research', state: 'permission-denied', error: `GET http://127.0.0.1:7199${path} → 403: {"code":7,"message":"PermissionDenied"}` },
      { id: 'project-e00mocksandbox', name: 'nip-sandbox', state: 'ok', items: 1 },
    ],
  });
  const capabilities = [refused('Networks', '/vpc/v1/networks'), refused('Subnets', '/vpc/v1/subnets')];

  it('the card reads "partial (2 calls refused)" with the refusals by project, and no raw JSON', () => {
    const { container } = render(
      <MemoryRouter>
        <ConnectorCard s={s} capabilities={capabilities} now={now} canSync={false} syncing={false} onSync={() => undefined} />
      </MemoryRouter>,
    );
    expect(screen.getAllByText('partial (2 calls refused)')[0]).toBeInTheDocument();
    expect(screen.queryByText('Permission denied')).not.toBeInTheDocument();
    expect(container).toHaveTextContent('legacy-research refused Networks and Subnets.');
    expect(container).toHaveTextContent('The sync itself ran, so its runs count as succeeded; these calls inside it were refused.');
    expect(container).not.toHaveTextContent('{"code"');
    expect(container).not.toHaveTextContent('127.0.0.1');
  });

  it('the capability rows give the error in plain words: method, path, status and message', () => {
    const { container } = render(
      <MemoryRouter>
        <CapabilityGroups capabilities={capabilities} now={now} />
      </MemoryRouter>,
    );
    expect(container).toHaveTextContent('Failing in legacy-research: permission denied (GET /vpc/v1/networks → 403 PermissionDenied)');
    fireEvent.click(screen.getAllByRole('button', { name: /Show per project/ })[0]);
    expect(container).not.toHaveTextContent('{"code"');
    expect(container).not.toHaveTextContent('127.0.0.1');
  });
});
