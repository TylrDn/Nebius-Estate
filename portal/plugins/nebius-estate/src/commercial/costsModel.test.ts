import { fmtMoney } from '../ui/format';
import { costGroupLabel, dailyChartFooter, costGroupSortText, costGroupSpendLine, costMetricLabel, costsEmptyState, dailyExcludedNote, dataTile, latestPerImporter, coverageTile, periodEndText, dailyPoints, emptyCostsText, ignoredRange, importPeriodText, rangeError, rangeFromSearch, rejectReason, roundedShares, reportShows } from './costsModel';

describe('costs page model', () => {
  it('rounds each breakdown row as every page rounds money, with a share in percent (F1.2)', () => {
    const usd = (amount: string) => ({ amount, currency: 'USD' });
    const rows = roundedShares([usd('8.189165'), usd('0.565269')], '8.754434');
    expect(rows.map(r => r.display)).toEqual(['8.19 USD', '0.57 USD']);
    expect(rows.map(r => r.percent)).toEqual([93.5, 6.5]);
    expect(roundedShares([usd('1'), usd('-1.25')], '-0.25').map(r => r.display)).toEqual(['1.00 USD', fmtMoney(usd('-1.25'))]);
    // The 2026-10-06 export: nip-sandbox is 3.2448 XTS, shown 3.24 here as on Budgets (never nudged to 3.25 to add up).
    const xts = (amount: string) => ({ amount, currency: 'XTS' });
    const sandbox = roundedShares([xts('59.2128'), xts('22.7136'), xts('3.2448'), xts('0.6144')], '85.7856');
    expect(sandbox.map(r => r.display)).toEqual(['59.21 XTS', '22.71 XTS', '3.24 XTS', '0.61 XTS']);
    expect(sandbox[2].display).toBe(fmtMoney(xts('3.2448')));
  });

  it('shows the project name alone when known, with the id kept for the tooltip', () => {
    expect(costGroupLabel('project', { key: 'project-e00abc', label: 'nbis-labs (project-e00abc)' })).toEqual({ text: 'nbis-labs', title: 'project-e00abc' });
    expect(costGroupLabel('project', { key: 'project-e00abc', label: 'project-e00abc' })).toEqual({ text: 'project-e00abc', title: undefined });
    expect(costGroupLabel('resource', { key: 'vm-1', label: 'gpu (vm-1)' })).toEqual({ text: 'gpu', title: 'vm-1' });
    expect(costGroupLabel('service', { key: 'Compute', label: 'Compute' })).toEqual({ text: 'Compute', title: undefined });
  });

  it('tells a VM and its boot disk apart when they share a name: the type from the id prefix (#47)', () => {
    expect(costGroupLabel('resource', { key: 'computeinstance-e00mockgpu', label: 'gpu-node-1 (computeinstance-e00mockgpu)' })).toEqual({ text: 'gpu-node-1 · VM', title: 'computeinstance-e00mockgpu' });
    expect(costGroupLabel('resource', { key: 'computedisk-e00mockgpu', label: 'gpu-node-1 (computedisk-e00mockgpu)' })).toEqual({ text: 'gpu-node-1 · disk', title: 'computedisk-e00mockgpu' });
    expect(costGroupLabel('resource', { key: 'computefilesystem-e00mockfs', label: 'shared (computefilesystem-e00mockfs)' }).text).toBe('shared · filesystem');
    expect(costGroupLabel('resource', { key: 'vpcallocation-e00mockip', label: 'ip (vpcallocation-e00mockip)' }).text).toBe('ip · IP address');
    // An unknown prefix keeps the name alone; the project breakdown is unchanged.
    expect(costGroupLabel('resource', { key: 'vm-1', label: 'gpu (vm-1)' }).text).toBe('gpu');
    expect(costGroupLabel('project', { key: 'project-e00abc', label: 'nbis-labs (project-e00abc)' }).text).toBe('nbis-labs');
  });

  it('names negative bars only when the chart has one (#71)', () => {
    const p = (value: number | null) => ({ label: 'd', value, display: '' });
    expect(dailyChartFooter([p(1), p(null), p(2)], 2)).toBe('3 days, 2 with rows');
    expect(dailyChartFooter([p(1), p(-0.5)], 2)).toBe('2 days, 2 with rows · negative bars are credits or adjustments');
    expect(dailyChartFooter([p(1)], 1)).toBe('1 day, 1 with rows');
  });

  it('catches an inverted date range on the field', () => {
    expect(rangeError('2026-10-20', '2026-10-01')).toBe('“To” must be after “From”.');
    expect(rangeError('2026-10-01', '2026-10-01')).toBe('“To” must be after “From”.');
    expect(rangeError('2026-10-01', '2026-10-02')).toBeUndefined();
    expect(rangeError('', '2026-10-02')).toBeUndefined();
  });

  it('explains an import with no rows as a header-only file', () => {
    expect(importPeriodText({ accepted: 0, rejected: 0 })).toBe('Header only: no usage in this period');
    expect(importPeriodText({ accepted: 0, rejected: 2 })).toBe('No row accepted: see the reasons');
    expect(importPeriodText({ accepted: 3, rejected: 0, periodStart: 'a', periodEnd: 'b' })).toBeUndefined();
  });

  it('words the empty state from the export pull state', () => {
    expect(emptyCostsText({ state: 'ok', scope: 'bucket (eu-north1)' })).toMatch(/^Export pull configured; waiting for the first files \(Nebius writes hourly\)/);
    expect(emptyCostsText({ state: 'not-configured', scope: '—' })).toMatch(/configure the export pull/);
    expect(emptyCostsText({ state: 'permission-denied', scope: 'b', note: '403' })).toMatch(/cannot read the bucket/);
    expect(emptyCostsText(undefined)).toMatch(/configure the export pull/);
  });

  it('names raw contract and bucket rows: "Tax / contract-level", and the bucket name from the inventory', () => {
    expect(costGroupLabel('project', { key: 'contract-e00s76um', label: 'contract-e00s76um' })).toEqual({ text: 'Tax / contract-level', title: 'contract-e00s76um' });
    const names = new Map([['storagebucket-e00abc', 'nip-tfstate']]);
    expect(costGroupLabel('resource', { key: 'storagebucket-e00abc', label: 'storagebucket-e00abc' }, names)).toEqual({ text: 'nip-tfstate', title: 'storagebucket-e00abc' });
    expect(costGroupLabel('resource', { key: 'storagebucket-e00zzz', label: 'storagebucket-e00zzz' }, names)).toEqual({ text: 'Object Storage bucket storagebucket-e00zzz', title: 'storagebucket-e00zzz' });
  });

  it('keeps gaps between non-contiguous days instead of drawing them side by side', () => {
    const g = (key: string, amount: string) => ({ key, label: key, rows: 1, totals: [{ amount, currency: 'USD' }] });
    const pts = dailyPoints([g('2026-10-01', '1'), g('2026-10-04', '2')] as any);
    expect(pts.map(p => [p.label, p.value])).toEqual([
      ['2026-10-01', 1],
      ['2026-10-02', null],
      ['2026-10-03', null],
      ['2026-10-04', 2],
    ]);
    expect(pts[1].display).toBe('no rows');
  });

  it('reads a deep-linked range from the URL and ignores malformed dates', () => {
    expect(rangeFromSearch(new URLSearchParams('from=2026-10-01&to=2026-10-08'))).toEqual({ from: '2026-10-01', to: '2026-10-08' });
    expect(rangeFromSearch(new URLSearchParams('from=yesterday&to=2026-10-08'))).toEqual({ from: '', to: '2026-10-08' });
    expect(rangeFromSearch(new URLSearchParams(''))).toEqual({ from: '', to: '' });
  });

  it('labels the old NULL rejection as an import from before the fix', () => {
    expect(rejectReason('invalid decimal "NULL"')).toBe('invalid decimal "NULL": imported before the NULL fix; re-import to apply');
    expect(rejectReason('missing BilledCost')).toBe('missing BilledCost');
  });

  it('ends the reporting period at the last exported hour, not at the end of the open billing period', () => {
    expect(periodEndText({ activeRows: 3, latestChargePeriodEnd: '2026-11-01T00:00:00Z' }, { through: '2026-10-11T10:00:00Z', narrowed: false })).toBe('exported through 2026-10-11 10:00 UTC');
    expect(periodEndText({ activeRows: 3, latestChargePeriodEnd: '2026-10-08T00:00:00Z' }, { narrowed: false })).toBe('2026-10-08 00:00 UTC');
    expect(periodEndText({ activeRows: 0 }, { narrowed: false })).toBe('');
  });

  it('a range or filter ends the reporting period at its own last hour, never the whole export\'s; an empty range says so (G4.2)', () => {
    // Live: [2026-10-07, 2026-10-09) read "→ exported through 2026-10-12 13:16 UTC".
    expect(periodEndText({ activeRows: 120, latestChargePeriodEnd: '2026-10-09T00:00:00Z' }, { through: '2026-10-08T23:00:00Z', narrowed: true })).toBe('through 2026-10-08 23:00 UTC (last hour shown)');
    expect(periodEndText({ activeRows: 0 }, { narrowed: true })).toBe('no rows in this range');
  });

  it('a project with no billing rows says so and counts the rows imported for the others, not "waiting for the first files" (G4.1)', () => {
    const pull = { state: 'ok' as const, scope: 'bucket (eu-north1)' };
    const r = costsEmptyState({ rows: 0, rowsAnyRange: 0, importedRows: 678, selection: 'default-project-us-north1', pull, range: { from: '', to: '' } });
    expect(r.title).toBe('No billed rows for default-project-us-north1');
    expect(r.text).toMatch(/678 rows/);
    expect(r.text).toMatch(/other projects or regions/);
    expect(r.text).not.toMatch(/waiting/);
    // Nothing imported at all is still worded from the export pull.
    expect(costsEmptyState({ rows: 0, rowsAnyRange: 0, importedRows: 0, selection: 'x', pull, range: { from: '', to: '' } }).title).toBe('No billing data imported');
  });

  it('sorts the label column by the text shown, not the raw key (G4.13)', () => {
    const names = new Map([['storagebucket-e00mockb', 'alpha-bucket']]);
    const groups = [
      { key: 'project-e00b', label: 'nbis-labs (project-e00b)', unattributed: false },
      { key: 'contract-e00mockc', label: 'contract-e00mockc', unattributed: false },
      { key: 'project-e00a', label: 'default-a (project-e00a)', unattributed: false },
    ];
    expect([...groups].sort((a, b) => costGroupSortText('project', a).localeCompare(costGroupSortText('project', b))).map(g => g.key)).toEqual(['project-e00a', 'project-e00b', 'contract-e00mockc']);
    expect(costGroupSortText('resource', { key: 'storagebucket-e00mockb', label: 'storagebucket-e00mockb', unattributed: false }, names)).toBe('alpha-bucket');
    expect(costGroupSortText('region', { key: '(unattributed)', label: '(unattributed)', unattributed: true })).toBe('unattributed');
  });

  it('names the month-long rows the daily chart leaves out (G4.10)', () => {
    expect(dailyExcludedNote({ rows: 1, totals: [{ amount: '0', currency: 'USD' }], categories: ['Tax'] })).toBe('1 month-long Tax row (0.00 USD) is not drawn per day; the totals include it.');
    expect(dailyExcludedNote({ rows: 2, totals: [{ amount: '3.5', currency: 'USD' }], categories: ['Purchase', 'Tax'] })).toBe('2 month-long Purchase and Tax rows (3.50 USD) are not drawn per day; the totals include them.');
    expect(dailyExcludedNote(undefined)).toBeUndefined();
  });

  it('names range values from a link that cannot apply (walkthrough 3)', () => {
    expect(ignoredRange(new URLSearchParams('from=bogus&to=2026-10-08'))).toEqual([{ key: 'from', value: 'bogus' }]);
    expect(ignoredRange(new URLSearchParams('from=2026-02-31&to=x'))).toEqual([
      { key: 'from', value: '2026-02-31' },
      { key: 'to', value: 'x' },
    ]);
    expect(ignoredRange(new URLSearchParams('from=2026-10-01'))).toEqual([]);
  });

  it('an empty range with imports says "No billed rows in this range", not "No billing data imported" (walkthrough 3)', () => {
    const pull = { state: 'ok' as const, scope: 'bucket (eu-north1)' };
    expect(costsEmptyState({ rows: 0, rowsAnyRange: 0, pull, range: { from: '2026-10-01', to: '' } }).title).toBe('No billing data imported');
    const r = costsEmptyState({ rows: 0, rowsAnyRange: 1767, pull, range: { from: '2025-01-01', to: '2025-01-02' } });
    expect(r.title).toBe('No billed rows in this range');
    expect(r.text).toMatch(/2025-01-01 to 2025-01-02/);
    expect(r.text).not.toMatch(/waiting/);
    expect(costsEmptyState({ rows: 5, rowsAnyRange: 5, pull, range: { from: '', to: '' } }).title).toBeUndefined();
  });

  it('completeness in plain words: hours with usage of the hours the export spans; an hour without usage is not a gap (F1.42)', () => {
    const t = coverageTile({ from: '2026-10-07T15:00:00.000Z', through: '2026-10-11T09:31:00.000Z', spanHours: 91, hoursWithUsage: 12, daysWithoutUsage: [] });
    expect(`${t.value} ${t.unit}`).toBe('12 of 91 h with usage');
    expect(t.reason).toBe('The export spans 2026-10-07 15:00 UTC → 2026-10-11 09:31 UTC. An hour without usage has no row in a FOCUS export, so it is not a gap.');
    expect(t.reason).not.toMatch(/missing|covered/);
    const d = coverageTile({ from: '2026-10-01T00:00:00.000Z', through: '2026-10-05T00:00:00.000Z', spanHours: 96, hoursWithUsage: 30, daysWithoutUsage: ['2026-10-02', '2026-10-03'] });
    expect(d.reason).toMatch(/ 2 days without any row \(2026-10-02, 2026-10-03\): idle, or not exported\.$/);
    expect(coverageTile({ from: 'a', through: 'b', spanHours: 30, hoursWithUsage: 5, daysWithoutUsage: ['2026-10-02'] }).reason).toMatch(/ 1 day without any row \(2026-10-02\)/);
    expect(coverageTile(undefined)).toEqual({ label: 'Completeness', value: '—', unit: '', reason: 'No usage rows yet.' });
  });
});

describe('costs page readability', () => {
  it('names a FOCUS metric in words', () => {
    expect(costMetricLabel('BilledCost')).toBe('Billed cost');
    expect(costMetricLabel('EffectiveCost')).toBe('Effective cost');
  });

  it('lists the newest import of each importer first; the rest is history', () => {
    const items = [
      { id: '3', importedBy: 'system:billing-export' },
      { id: '2', importedBy: 'user:guest' },
      { id: '1', importedBy: 'system:billing-export' },
    ];
    expect(latestPerImporter(items).map(i => i.id)).toEqual(['3', '2']);
  });
});

describe('cost rows and budgets use one rule (F1.48)', () => {
  const xts = (amount: string) => ({ amount, currency: 'XTS' });
  it('a billed-cost row with a credit or tax row in it carries what its budget counts, labelled with the rule', () => {
    expect(costGroupSpendLine('BilledCost', { spendTotals: [xts('127.48')] })).toBe('127.48 XTS excl. tax and credits (the Budgets rule)');
    expect(costGroupSpendLine('BilledCost', { spendTotals: [] })).toBe('none of it counts as spend (excl. tax and credits: the Budgets rule)');
  });
  it('nothing extra when nothing is left out, or for a metric budgets do not use', () => {
    expect(costGroupSpendLine('BilledCost', {})).toBeUndefined();
    expect(costGroupSpendLine('ListCost', { spendTotals: [xts('1')] })).toBeUndefined();
  });

  it('an empty range: the Data tile counts this range against the imports, no stray separator; completeness says it is the whole export (W1F.S2)', () => {
    const empty = { activeRows: 0, imports: 0, currencies: [] as string[] };
    const d = dataTile(empty, { ranged: true, rowsAnyRange: 1767 });
    expect(`${d.value} ${d.unit}`).toBe('0 rows in this range');
    expect(d.reason).toBe('1,767 rows in the imports in all · superseded rows are deleted on import');
    expect(d.reason).not.toMatch(/ · $|· ·|^ ·/);
    const whole = dataTile({ activeRows: 1767, imports: 3, currencies: ['XTS'] }, { ranged: false, rowsAnyRange: 1767 });
    expect(`${whole.value} ${whole.unit} · ${whole.reason}`).toBe('1,767 active rows · from 3 imports · superseded rows are deleted on import · XTS');
    expect(dataTile({ activeRows: 5, imports: 1, currencies: [] }, { ranged: false, rowsAnyRange: 5 }).reason).toBe('from 1 import · superseded rows are deleted on import');
    const c = { from: '2026-10-07T15:00:00.000Z', through: '2026-10-11T09:31:00.000Z', spanHours: 66, hoursWithUsage: 66, daysWithoutUsage: [] };
    const t = coverageTile(c, true);
    expect(t.label).toBe('Completeness (whole export)');
    expect(t.reason).toMatch(/^Not limited to the chosen range\. The export spans /);
    expect(coverageTile(c).label).toBe('Completeness');
  });

  it('a breakdown answers the tab and metric asked for: the previous tab\'s rows are never shown under the new heading', () => {
    const report = { metric: 'BilledCost', dimension: 'resource' } as const;
    expect(reportShows(report, 'BilledCost', 'resource')).toBe(true);
    // While the project breakdown loads, the resource rows (kept by useGet while it refetches) are not the project's.
    expect(reportShows(report, 'BilledCost', 'project')).toBe(false);
    expect(reportShows(report, 'EffectiveCost', 'resource')).toBe(false);
    expect(reportShows(undefined, 'BilledCost', 'resource')).toBe(false);
  });
});
