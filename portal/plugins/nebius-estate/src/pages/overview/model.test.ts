import type { HealthStats, LivePriceEstimate } from '@internal/nebius-domain';
import { billingMetric, runRateCountText, budgetSpendLine, filterNotApplied, countOf, fmtDuration, missingSummary, liveRunRateMetric, SETUP, setupDocFor, fixFor, successPercent, summariseTelemetry, upcomingMaintenance } from './model';

const health = (h: Partial<HealthStats>): HealthStats => ({ runs24h: 4, successRate24h: 1, p50Ms: 100, p95Ms: 200, consecutiveFailures: 0, recentRuns: [], ...h });

const estimate: LivePriceEstimate = {
  source: 'Nebius billing calculator (list price)',
  offer: 'list',
  asOf: '2026-10-11T09:00:00Z',
  currency: 'USD',
  projectId: 'project-e00mocka',
  contract: { attempted: false, available: null },
  lines: [],
  hourly: { amount: '12.5', currency: 'USD' },
  unpriced: [],
};

describe('overview model', () => {
  it('keeps unknown apart from zero', () => {
    expect(countOf({ value: null, source: 's', unavailableReason: 'r' })).toEqual({ value: null, source: 's', unavailableReason: 'r' });
    expect(countOf({ value: [], source: 's' }).value).toBe(0);
    expect(successPercent(undefined)).toBeNull();
    expect(successPercent(health({ successRate24h: null, runs24h: 0 }))).toBeNull();
    expect(fmtDuration(null)).toBeNull();
    expect(summariseTelemetry(null)).toBeNull();
  });

  it('reads the success rate as a ratio', () => {
    expect(successPercent(health({ successRate24h: 0.75 }))).toBe(75);
    expect(successPercent(health({ successRate24h: 1 }))).toBe(100);
    expect(successPercent(health({ successRate24h: 0 }))).toBe(0);
  });

  it('formats durations', () => {
    expect(fmtDuration(850)).toBe('850 ms');
    expect(fmtDuration(12_340)).toBe('12.3 s');
    expect(fmtDuration(126_000)).toBe('2.1 min');
  });

  it('summarises temperature and power only over GPUs that report them', () => {
    const s = summariseTelemetry([
      { node: 'a', tempC: 60, powerW: 300, source: 'Nebius Monitoring' },
      { node: 'b', tempC: 70, source: 'Nebius Monitoring' },
      { node: 'c', source: 'Nebius Monitoring' },
    ]);
    expect(s).toEqual({ gpus: 3, temp: { reporting: 2, mean: 65, max: 70 }, power: { reporting: 1, total: 300, max: 300 }, sources: ['Nebius Monitoring'] });
    expect(summariseTelemetry([{ node: 'a', source: 'x' }])).toMatchObject({ temp: null, power: null });
  });

  it('labels the live run-rate with its source and time, and says why when absent', () => {
    const m = liveRunRateMetric({ data: { value: estimate } });
    expect(m.source).toBe('Nebius billing calculator (list price)');
    expect(m.note).toBe('list price as of 2026-10-11 09:00 UTC');
    expect(liveRunRateMetric({ data: { value: { ...estimate, offer: 'contract' } } }).note).toMatch(/^contract price as of/);
    const contract = { ...estimate, offer: 'contract' as const, hourly: { amount: '6.12', currency: 'XTS' } };
    expect(liveRunRateMetric({ data: { value: { ...contract, listHourly: { amount: '6.120', currency: 'XTS' } } } }).note).toMatch(/^contract price \(= list\) as of/);
    expect(liveRunRateMetric({ data: { value: { ...contract, listHourly: { amount: '7.00', currency: 'XTS' } } } }).note).toMatch(/^contract price \(list 7\.00 XTS \/ h\) as of/);
    expect(liveRunRateMetric({ data: { value: null, unavailableReason: 'not configured' } })).toMatchObject({ value: null, unavailableReason: 'not configured' });
    expect(liveRunRateMetric({ error: new Error('forbidden') })).toMatchObject({ value: null, unavailableReason: 'forbidden' });
  });

  it('"nothing running" is as of the inventory lists that found nothing to price', () => {
    const m = liveRunRateMetric({ data: { value: null, nothingRunning: { currency: 'XTS' }, observedAt: '2026-10-13T16:34:00Z' } });
    expect(m).toMatchObject({ value: null, empty: '0 XTS / h — nothing running', observedAt: '2026-10-13T16:34:00Z' });
  });

  it('points a missing permission at the access roles', () => {
    expect(setupDocFor('You do not have nebius.telemetry.read.', SETUP.telemetry)).toBe(SETUP.access);
    expect(setupDocFor('No GPU series in scope', SETUP.telemetry)).toBe(SETUP.telemetry);
  });

  it('orders maintenance soonest first and keeps null as unavailable', () => {
    expect(upcomingMaintenance({ value: null, source: 's' })).toBeNull();
    const m = upcomingMaintenance({
      value: [
        { id: '2', name: 'later', projectId: 'p', scheduledAt: '2026-10-20T00:00:00Z', affected: [] },
        { id: '3', name: 'unscheduled', projectId: 'p', affected: [] },
        { id: '1', name: 'sooner', projectId: 'p', scheduledAt: '2026-10-12T00:00:00Z', affected: [] },
      ],
      source: 's',
    });
    expect(m?.map(x => x.id)).toEqual(['1', '2', '3']);
  });
});

describe('connector issue wording', () => {
  it('words missing coverage per state: refused, failing, waiting', () => {
    expect(missingSummary(['Projects (permission denied)', 'Spot pricing policies (rejected)', 'DNS zones (not found)', 'Registries (not found)'])).toBe('1 call refused, 1 failing or rejected, 2 waiting for data');
    expect(missingSummary([])).toBe('');
  });

  it('dates the billing export by its last exported hour, never by the end of the billing month', () => {
    const exportHealth = { rows: 297, activeRows: 297, imports: 1, earliestChargePeriodStart: '2026-10-01T00:00:00.000Z', latestChargePeriodEnd: '2026-11-01T00:00:00.000Z', exportedThrough: '2026-10-11T08:49:48.000Z', firstUsageHour: '2026-10-07T09:00:00.000Z', lagHours: 1, missingHours: 0, firstGaps: [], currencies: ['USD'], billingPeriods: ['2026-10'] };
    const m = billingMetric({ data: { report: { totals: [{ amount: '9.45', currency: 'USD' }] }, health: exportHealth } as any });
    expect(m.observedAt).toBe('2026-10-11T08:49:48.000Z');
    expect(m.note).toBe('Usage 2026-10-07 09:00 UTC → exported through 2026-10-11 08:49 UTC · export lag 1 h');
    expect(billingMetric({ data: { report: { totals: [] }, health: { ...exportHealth, imports: 0, rows: 0 } } as any }).value).toBeNull();
    // The lag uses the one duration formatter, so it never reads "124 h" beside "5 d ago" (F1.3).
    expect(billingMetric({ data: { report: { totals: [] }, health: { ...exportHealth, lagHours: 124 } } as any }).note).toMatch(/ · export lag 5 d$/);
    // #12: the next pull and the next file's estimate follow the freshness, when known.
    const pull = { state: 'ok', scope: 'bucket', nextRunAt: '2026-10-11T09:15:00Z', nextFile: { expectedAt: '2026-10-11T09:49:00Z', intervalMinutes: 60, files: 4, late: false } };
    expect(billingMetric({ data: { report: { totals: [] }, health: exportHealth, exportPull: pull } as any }, new Date('2026-10-11T09:00:00Z')).note).toBe(
      'Usage 2026-10-07 09:00 UTC → exported through 2026-10-11 08:49 UTC · export lag 1 h · next pull 09:15 UTC · next export file expected ≈ 09:49 UTC (estimate from the last 4 arrivals; Nebius writes the periodic export about hourly)',
    );
  });

  it('with a project or region filter, names the selection\'s last usage apart from the export\'s freshness (G1.3)', () => {
    const exportH = { rows: 297, activeRows: 297, imports: 1, exportedThrough: '2026-10-12T13:16:32.000Z', firstUsageHour: '2026-10-07T09:00:00.000Z', lagHours: 2, currencies: ['USD'], billingPeriods: ['2026-10'] };
    const m = billingMetric({ data: { report: { totals: [{ amount: '1.5', currency: 'USD' }] }, health: exportH, selectionLastUsage: '2026-10-08T02:34:14.000Z' } as any });
    expect(m.observedAt).toBe('2026-10-12T13:16:32.000Z');
    expect(m.note).toBe('Last usage in scope 2026-10-08 02:34 UTC · export through 2026-10-12 13:16 UTC · export lag 2 h');
    expect(m.note).not.toMatch(/lag 4 d/);
  });

  it('says when a tile does not follow an active filter, instead of showing it unfiltered in silence (G1.1)', () => {
    expect(filterNotApplied({ stage: 'sandbox' }, ['project', 'region'])).toBe('Not filtered by stage: whole account');
    expect(filterNotApplied({ stage: 'sandbox', project: 'p' }, ['project', 'region'])).toBe('Not filtered by stage: every stage of the selected project');
    expect(filterNotApplied({ stage: 'sandbox', region: 'r' }, ['project', 'region'])).toBe('Not filtered by stage: every stage of the selected region');
    expect(filterNotApplied({ stage: 'sandbox', project: 'p', region: 'r' }, ['project', 'region'])).toBe('Not filtered by stage: every stage of the selected project and region');
    expect(filterNotApplied({ project: 'p', region: 'r' }, ['project', 'region'])).toBeUndefined();
    expect(filterNotApplied({}, [])).toBeUndefined();
    expect(filterNotApplied({ project: 'p', stage: 's' }, [])).toBe('Not filtered by project or stage: whole account');
  });

  it('puts the spend budgets count beside the reported total, labelled, when tax or credits make them differ (F1.2)', () => {
    const xts = (amount: string) => [{ amount, currency: 'XTS' }];
    expect(budgetSpendLine({ totals: xts('571.3244'), spendTotals: xts('563.9244') })).toBe('563.92 XTS excl. tax and credits (the Budgets rule)');
    expect(budgetSpendLine({ totals: xts('85.7856'), spendTotals: xts('85.7856') })).toBeUndefined();
    expect(budgetSpendLine({ totals: xts('1') })).toBeUndefined();
  });
});

describe('one count for both run-rate tiles (W1-P10)', () => {
  it('counts resources, not calculator lines, in the same words on the live and rate-book tiles', () => {
    const lines = [
      { key: 'vm', description: 'gpu-h100-sxm · 1gpu', count: 2, hourly: { amount: '5', currency: 'USD' }, skus: [] },
      { key: 'pg', description: 'Managed PostgreSQL', count: 1, hourly: { amount: '0.1', currency: 'USD' }, skus: [] },
    ];
    expect(runRateCountText({ priced: lines.reduce((a, l) => a + l.count, 0), unpriced: 1 })).toBe('3 resources priced, 1 without a price');
    expect(runRateCountText({ priced: 0, unpriced: 2 })).toBe('0 resources priced, 2 without a price');
    expect(runRateCountText({ priced: 1, unpriced: 0 })).toBe('1 resource priced, 0 without a price');
  });
});

describe('one Fix link per Unavailable, to the page where the fix happens (W1-P24)', () => {
  it('maps each source to its page; a missing permission to the access roles', () => {
    expect(fixFor('No rate book has been imported.', SETUP.rateBook)).toEqual({ to: '/commercial?tab=ratebooks', label: 'Import or build a rate book' });
    expect(fixFor('No billing export imported yet: import a FOCUS CSV on Costs, or set up the export pull.', SETUP.billing)).toEqual({ to: '/costs', label: 'Import a billing export on Costs' });
    expect(fixFor('Alerts could not be read: 500', 'runbooks/fleet-alerts.md')).toEqual({ to: '/alerts?tab=rules', label: 'Check the alert rules' });
    expect(fixFor('No GPU series in scope', SETUP.telemetry, '?stage=sandbox')).toEqual({ to: '/integrations?stage=sandbox#connectors', label: 'Check GPU telemetry on Integrations' });
    expect(fixFor('the calculator did not answer', SETUP.livePrices).to).toBe('/integrations#connectors');
    expect(fixFor('No inventory yet', SETUP.inventory).label).toBe('Check the Nebius inventory on Integrations');
    expect(fixFor('No cluster', SETUP.kubernetes).label).toBe('Check Kubernetes on Integrations');
    // A permission the caller lacks is fixed by a portal role, whatever the source.
    expect(fixFor('You do not have nebius.provisioning.preview.', SETUP.access)).toEqual({ to: `/evidence?doc=${encodeURIComponent('docs/portal/nebius-setup.md')}#access-roles`, label: 'Ask for the portal role (access roles)' });
    expect(fixFor('You do not have nebius.telemetry.read.', SETUP.telemetry).label).toBe('Ask for the portal role (access roles)');
  });
});
