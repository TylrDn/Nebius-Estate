import { aggregateCosts, attributedProject, exportCadence, exportFreshnessText, billingSlot, BillingLedger, effectiveRange, exportHealth, normalizeFocusCsv, parseTags, TAX_GROUP_KEY, withFocusExtensions } from './billing';
import { parseCsv, toCsv } from './csv';

const HEADER =
  'BillingAccountId,BillingCurrency,BillingPeriodStart,BillingPeriodEnd,ChargePeriodStart,ChargePeriodEnd,ChargeCategory,ChargeClass,ChargeDescription,ServiceName,RegionId,ResourceId,ResourceName,SkuId,PricingQuantity,PricingUnit,BilledCost,EffectiveCost,ListCost,ContractedCost,x_ContainerId,x_ContainerName,Tags';

function row(hour: string, opts: Partial<Record<string, string>> = {}): string {
  const r = {
    BillingAccountId: 'contract-e00mock',
    BillingCurrency: 'XTS',
    BillingPeriodStart: '2026-10-01T00:00:00Z',
    BillingPeriodEnd: '2026-11-01T00:00:00Z',
    ChargePeriodStart: `2026-10-05T${hour}:00:00Z`,
    ChargePeriodEnd: `2026-10-05T${String(Number(hour) + 1).padStart(2, '0')}:00:00Z`,
    ChargeCategory: 'Usage',
    ChargeClass: '',
    ChargeDescription: 'GPU hour',
    ServiceName: 'Compute',
    RegionId: 'eu-north1',
    ResourceId: 'computeinstance-e00mockgpu',
    ResourceName: 'gpu-node',
    SkuId: 'sku-gpu',
    PricingQuantity: '1',
    PricingUnit: 'GPU-hour',
    BilledCost: '10.00',
    EffectiveCost: '9.00',
    ListCost: '12.00',
    ContractedCost: '9.50',
    x_ContainerId: 'project-e00mocksandbox',
    x_ContainerName: 'sandbox',
    Tags: '',
    ...opts,
  };
  return HEADER.split(',').map(h => (r as any)[h]).join(',');
}

const csv = (...rows: string[]) => [HEADER, ...rows].join('\n');

describe('CSV parser', () => {
  it('handles quotes, escaped quotes, CRLF and embedded newlines', () => {
    const r = parseCsv('a,b\r\n"x, y","he said ""hi""\nthere"\r\n');
    expect(r.rows).toEqual([{ a: 'x, y', b: 'he said "hi"\nthere' }]);
    expect(r.errors).toEqual([]);
  });
  it('reports ragged rows', () => {
    expect(parseCsv('a,b\n1\n').errors[0].message).toMatch(/expected 2 fields/);
  });
  it('neutralises spreadsheet formulas on export but keeps negative numbers', () => {
    expect(toCsv(['x'], [['=cmd()'], ['-1.5']])).toBe("x\n'=cmd()\n-1.5\n");
  });
});

describe('FOCUS normalisation', () => {
  it('reports missing required columns', () => {
    const r = normalizeFocusCsv('BilledCost\n1');
    expect(r.missingColumns).toContain('BillingCurrency');
    expect(r.records).toEqual([]);
  });

  it('keeps credits, adjustments and taxes as signed rows', () => {
    const r = normalizeFocusCsv(
      csv(
        row('00'),
        row('00', { ChargeCategory: 'Credit', ChargeDescription: 'Promo credit', BilledCost: '-3.00', EffectiveCost: '-3.00', ListCost: '', ContractedCost: '', SkuId: 'sku-credit' }),
        row('00', { ChargeCategory: 'Adjustment', ChargeClass: 'Correction', ChargeDescription: 'Correction', BilledCost: '-0.50', EffectiveCost: '-0.50', ListCost: '', ContractedCost: '', SkuId: 'sku-adj' }),
        row('00', { ChargeCategory: 'Tax', ChargeDescription: 'VAT', BilledCost: '1.30', EffectiveCost: '1.30', ListCost: '', ContractedCost: '', SkuId: 'sku-tax', ResourceId: '' }),
      ),
    );
    expect(r.errors).toEqual([]);
    const ledger = new BillingLedger();
    ledger.ingest('i1', '2026-10-06T00:00:00Z', r.records);
    const report = aggregateCosts(ledger.all(), 'BilledCost', 'chargeCategory');
    expect(report.totals).toEqual([{ amount: '7.8', currency: 'XTS' }]);
    expect(report.groups.map(g => g.key).sort()).toEqual(['Adjustment / Correction', 'Credit', 'Tax', 'Usage']);
    // ListCost is empty on credit/tax rows: they are counted, not zeroed.
    const list = aggregateCosts(ledger.all(), 'ListCost', 'service');
    expect(list.rowsWithoutMetric).toBe(3);
    expect(list.totals[0].amount).toBe('12');
  });

  it('never sums different cost metrics', () => {
    const r = normalizeFocusCsv(csv(row('00')));
    const ledger = new BillingLedger();
    ledger.ingest('i1', 'now', r.records);
    expect(aggregateCosts(ledger.all(), 'BilledCost', 'service').totals[0].amount).toBe('10');
    expect(aggregateCosts(ledger.all(), 'EffectiveCost', 'service').totals[0].amount).toBe('9');
  });

  it('rejects invalid decimals per row without dropping the file', () => {
    const r = normalizeFocusCsv(csv(row('00'), row('01', { BilledCost: '1e3' })));
    expect(r.records).toHaveLength(1);
    expect(r.errors[0]).toEqual({ row: 3, message: 'invalid decimal "1e3"' });
  });
});

describe('BillingLedger supersession and deduplication', () => {
  it('drops exact duplicates inside one file', () => {
    const r = normalizeFocusCsv(csv(row('00'), row('00')));
    const s = new BillingLedger().ingest('i1', 'now', r.records);
    expect(s.accepted).toBe(1);
    expect(s.duplicatesInFile).toBe(1);
  });

  it('an import\'s period is the hours its usage rows cover, not a month-long tax row\'s month (#68)', () => {
    const tax = row('00', { ChargeCategory: 'Tax', ResourceId: 'contract-e00mock', SkuId: 'tax', ChargePeriodStart: '2026-10-01T00:00:00Z', ChargePeriodEnd: '2026-11-01T00:00:00Z' });
    const s = new BillingLedger().ingest('i1', 'now', normalizeFocusCsv(csv(row('03'), row('04'), tax)).records);
    expect([s.periodStart, s.periodEnd]).toEqual(['2026-10-05T03:00:00.000Z', '2026-10-05T05:00:00.000Z']);
    // A file of month-long rows only keeps their span.
    const only = new BillingLedger().ingest('i2', 'now', normalizeFocusCsv(csv(tax)).records);
    expect([only.periodStart, only.periodEnd]).toEqual(['2026-10-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z']);
  });

  it('a re-import of the same hours replaces them (no double counting)', () => {
    const ledger = new BillingLedger();
    ledger.ingest('i1', 't1', normalizeFocusCsv(csv(row('00'), row('01'))).records);
    const s = ledger.ingest('i2', 't2', normalizeFocusCsv(csv(row('00'), row('01'))).records);
    expect(s.supersededRows).toBe(2);
    expect(s.supersededImports).toEqual(['i1']);
    expect(aggregateCosts(ledger.all(), 'BilledCost', 'service').totals[0].amount).toBe('20');
  });

  it('an overlapping export restates only the overlapped hours', () => {
    const ledger = new BillingLedger();
    ledger.ingest('i1', 't1', normalizeFocusCsv(csv(row('00'), row('01'), row('02'))).records);
    // i2 covers 02-03; hour 02 was restated with a correction
    ledger.ingest('i2', 't2', normalizeFocusCsv(csv(row('02', { BilledCost: '11.00' }), row('03'))).records);
    const r = aggregateCosts(ledger.all(), 'BilledCost', 'day');
    expect(r.totals[0].amount).toBe('41');
    expect(ledger.active().filter(x => x.importId === 'i1')).toHaveLength(2);
  });

  it('a one-project file does not supersede other projects in the same hours', () => {
    const ledger = new BillingLedger();
    const staging = { x_ContainerId: 'project-e00mockstaging', x_ContainerName: 'staging', ResourceId: 'computeinstance-e00mockstg' };
    ledger.ingest('i1', 't1', normalizeFocusCsv(csv(row('00'), row('00', staging))).records);
    const s = ledger.ingest('i2', 't2', normalizeFocusCsv(csv(row('00', { BilledCost: '11.00' }))).records);
    expect(s.supersededRows).toBe(1);
    const byProject = aggregateCosts(ledger.all(), 'BilledCost', 'project');
    expect(byProject.groups.map(g => [g.key, g.totals[0].amount]).sort()).toEqual([
      ['project-e00mocksandbox', '11'],
      ['project-e00mockstaging', '10'],
    ]);
  });

  it('keeps currencies apart', () => {
    const ledger = new BillingLedger();
    ledger.ingest('i1', 't', normalizeFocusCsv(csv(row('00'), row('01', { BillingCurrency: 'EUR', BillingAccountId: 'contract-e00mockeu' }))).records);
    expect(aggregateCosts(ledger.all(), 'BilledCost', 'service').totals).toEqual([
      { amount: '10', currency: 'EUR' },
      { amount: '10', currency: 'XTS' },
    ]);
  });
});

describe('aggregation and export health', () => {
  it('reports unattributed rows and label joins from inventory', () => {
    const ledger = new BillingLedger();
    ledger.ingest('i1', 't', normalizeFocusCsv(csv(row('00'), row('01', { ResourceId: 'disk-e00mockpvc', x_ContainerId: '' }))).records);
    const byProject = aggregateCosts(ledger.all(), 'BilledCost', 'project');
    expect(byProject.groups.find(g => g.unattributed)?.rows).toBe(1);
    const byStage = aggregateCosts(ledger.all(), 'BilledCost', 'label:nip-stage', {}, id =>
      id === 'computeinstance-e00mockgpu' ? { 'nip-stage': 'sandbox' } : undefined,
    );
    expect(byStage.groups.map(g => g.key).sort()).toEqual(['(unattributed)', 'sandbox']);
    expect(byStage.attributionNote).toMatch(/inventory/);
  });

  it('prefers the row\'s own Tags for label breakdowns and falls back to the inventory join', () => {
    const ledger = new BillingLedger();
    const json = '"{""nip-stage"":""staging"",""team"":""ml""}"'; // JSON object, CSV-quoted
    ledger.ingest('i1', 't', normalizeFocusCsv(csv(
      row('00', { Tags: json }),
      row('01', { Tags: '"nip-stage=prod;team=ml"', ResourceId: 'computeinstance-e00mockb' }),
      row('02', { ServiceName: 'Object Storage', ResourceId: 'computeinstance-e00mockgpu' }), // no tags: inventory join
      row('03', { Tags: 'not a map', ResourceId: 'bucket-e00mocknone' }), // unparseable: ignored
    )).records);
    const byStage = aggregateCosts(ledger.all(), 'BilledCost', 'label:nip-stage', {}, id =>
      id === 'computeinstance-e00mockgpu' ? { 'nip-stage': 'staging' } : undefined,
    );
    const g = Object.fromEntries(byStage.groups.map(x => [x.key, x]));
    expect(g.staging).toMatchObject({ rows: 2, labelSource: 'mixed' });
    expect(g.prod).toMatchObject({ rows: 1, labelSource: 'tags' });
    expect(g['(unattributed)'].rows).toBe(1);
    expect(byStage.attributionNote).toMatch(/2 row\(s\) from the export's own Tags.*1 from joining ResourceId.*1 without/);
  });

  it('a group whose tax rows are 0.00 carries no second, identical "excl. tax" figure; a tax-only group still says none counts (G4.12)', () => {
    const ledger = new BillingLedger();
    ledger.ingest('i1', 't', normalizeFocusCsv(csv(
      row('00', { BilledCost: '9.04' }),
      row('01', { ChargeCategory: 'Tax', BilledCost: '0.00', ResourceId: '', SkuId: 'tax', ChargeDescription: 'VAT' }),
      row('02', { ChargeCategory: 'Tax', BilledCost: '1.50', ResourceId: '', SkuId: 'tax2', ChargeDescription: 'VAT', x_ContainerId: 'project-e00mocktaxonly', x_ContainerName: 'taxonly' }),
    )).records);
    const byStage = aggregateCosts(ledger.all(), 'BilledCost', 'label:nip-stage');
    // Live: "unattributed … 9.04 USD" and under it "9.04 USD excl. tax and credits".
    const un = byStage.groups.find(g => g.unattributed)!;
    expect(un.totals).toEqual([{ amount: '10.54', currency: 'XTS' }]);
    expect(un.spendTotals).toEqual([{ amount: '9.04', currency: 'XTS' }]);
    const byProject = aggregateCosts(ledger.all(), 'BilledCost', 'project');
    expect(byProject.groups.find(g => g.key === 'project-e00mocksandbox')!.spendTotals).toBeUndefined();
    expect(byProject.groups.find(g => g.key === 'project-e00mocktaxonly')!.spendTotals).toEqual([]);
  });

  it('a tax row without a region, service or project is its own "Tax / contract-level" group, not "unattributed" (G4.13)', () => {
    const ledger = new BillingLedger();
    ledger.ingest('i1', 't', normalizeFocusCsv(csv(
      row('00'),
      row('01', { ChargeCategory: 'Tax', BilledCost: '0.00', ResourceId: '', SkuId: 'tax', ServiceName: '', RegionId: '', x_ContainerId: '' }),
      row('02', { RegionId: '', ResourceId: 'computeinstance-e00mockother' }),
    )).records);
    for (const dim of ['region', 'service', 'project'] as const) {
      const r = aggregateCosts(ledger.all(), 'BilledCost', dim);
      const tax = r.groups.find(g => g.key === TAX_GROUP_KEY);
      expect([dim, tax?.label, tax?.unattributed, tax?.rows]).toEqual([dim, `Tax / contract-level (no ${dim})`, false, 1]);
    }
    // A usage row without a region is still unattributed.
    expect(aggregateCosts(ledger.all(), 'BilledCost', 'region').groups.find(g => g.unattributed)?.rows).toBe(1);
  });

  it('parses Tags defensively', () => {
    expect(parseTags('{"a":"1","b":2}')).toEqual({ a: '1', b: '2' });
    expect(parseTags('a=1, b:two ; c = 3')).toEqual({ a: '1', b: 'two', c: '3' });
    expect(parseTags('')).toBeUndefined();
    expect(parseTags('{}')).toBeUndefined();
    expect(parseTags('[1,2]')).toBeUndefined();
    expect(parseTags('{broken')).toBeUndefined();
    expect(parseTags('just text')).toBeUndefined();
  });

  it('measures lag in whole hours, and coverage instead of a missing-hour count', () => {
    const ledger = new BillingLedger();
    ledger.ingest('i1', 't', normalizeFocusCsv(csv(row('00'), row('03'))).records);
    const h = exportHealth(ledger.active(), { rows: ledger.all().length, imports: 1 }, new Date('2026-10-06T04:00:00Z'));
    expect(h.lagHours).toBe(24);
    // Hours 01 and 02 hold no rows: FOCUS exports only carry hours with usage, so they are not counted as gaps.
    expect(h.coverage).toEqual({ from: '2026-10-05T00:00:00.000Z', through: '2026-10-05T04:00:00.000Z', spanHours: 4, hoursWithUsage: 2, daysWithoutUsage: [] });
    expect((h as any).missingHours).toBeUndefined();
    expect((h as any).firstGaps).toBeUndefined();
  });

  it('dates freshness by the last exported hour, not by a month-long row; coverage starts at the first usage hour', () => {
    const ledger = new BillingLedger();
    // A month-long row (tax, subscription) starts at the period start and ends at the next month: it is not usage.
    const monthly = row('00', { ChargePeriodStart: '2026-10-01T00:00:00Z', ChargePeriodEnd: '2026-11-01T00:00:00Z', ChargeCategory: 'Tax', BilledCost: '0' });
    // The newest hour is partial: the export's data ends at 08:49:48.
    const partial = row('08', { ChargePeriodEnd: '2026-10-05T08:49:48Z' });
    ledger.ingest('i1', 't', normalizeFocusCsv(csv(monthly, row('06'), partial)).records);
    const h = exportHealth(ledger.active(), { rows: 3, imports: 1 }, new Date('2026-10-05T10:27:00Z'));
    expect(h.latestChargePeriodEnd).toBe('2026-11-01T00:00:00.000Z'); // kept: the reporting period
    expect(h.exportedThrough).toBe('2026-10-05T08:49:48.000Z');
    expect(h.firstUsageHour).toBe('2026-10-05T06:00:00.000Z');
    expect(h.lagHours).toBe(1); // 10:27 − 08:49, never "in 21 d" or 0
    expect(h.coverage).toMatchObject({ from: '2026-10-05T06:00:00.000Z', through: '2026-10-05T08:49:48.000Z', spanHours: 3, hoursWithUsage: 2 });
  });

  it('live-shaped rows: a first hour that starts mid-hour, and hours or days without usage, are not reported as gaps', () => {
    const ledger = new BillingLedger();
    const at = (start: string, end: string, extra: Partial<Record<string, string>> = {}) => row('00', { ChargePeriodStart: start, ChargePeriodEnd: end, ...extra });
    ledger.ingest(
      'i1',
      't',
      normalizeFocusCsv(
        csv(
          at('2026-10-05T15:48:47Z', '2026-10-05T16:00:00Z'), // the export's first row: a VM created at 15:48:47
          at('2026-10-05T16:00:00Z', '2026-10-05T17:00:00Z'),
          at('2026-10-05T16:00:00Z', '2026-10-05T17:00:00Z', { ResourceId: 'computedisk-e00mockboot', SkuId: 'sku-disk' }),
          // 17:00 holds no rows (nothing ran); 2026-10-06 holds none either.
          at('2026-10-05T18:00:00Z', '2026-10-05T19:00:00Z'),
          at('2026-10-07T10:00:00Z', '2026-10-07T10:31:12Z'),
        ),
      ).records,
    );
    const h = exportHealth(ledger.active(), { rows: 5, imports: 1 }, new Date('2026-10-07T12:00:00Z'));
    expect(h.firstUsageHour).toBe('2026-10-05T15:00:00.000Z'); // floored to the hour
    expect(h.coverage).toEqual({
      from: '2026-10-05T15:00:00.000Z',
      through: '2026-10-07T10:31:12.000Z',
      spanHours: 44,
      hoursWithUsage: 4,
      daysWithoutUsage: ['2026-10-06'],
    });
  });

  it('falls back to the newest start + 1 h when only month-long rows exist', () => {
    const ledger = new BillingLedger();
    ledger.ingest('i1', 't', normalizeFocusCsv(csv(row('00', { ChargePeriodStart: '2026-10-01T00:00:00Z', ChargePeriodEnd: '2026-11-01T00:00:00Z' }))).records);
    const h = exportHealth(ledger.active(), { rows: 1, imports: 1 }, new Date('2026-10-05T10:00:00Z'));
    expect(h.exportedThrough).toBe('2026-10-01T01:00:00.000Z');
    expect(h.coverage).toBeUndefined(); // no usage row: nothing to say about hours
  });

  it('filters by period, project and region', () => {
    const ledger = new BillingLedger();
    ledger.ingest('i1', 't', normalizeFocusCsv(csv(row('00'), row('01', { RegionId: 'uk-south1' }))).records);
    expect(aggregateCosts(ledger.all(), 'BilledCost', 'region', { regions: ['uk-south1'] }).totals[0].amount).toBe('10');
    expect(aggregateCosts(ledger.all(), 'BilledCost', 'region', { from: '2026-10-05T01:00:00.000Z' }).groups).toHaveLength(1);
  });
});

describe('Nebius FOCUS extension columns', () => {
  const EXT = 'x_TenantId,x_TenantName,x_ProjectId,x_ProjectName,x_TrialId,x_ContractPriceId,x_UsageBasedDiscountIds';
  const extCsv = (...rows: string[]) => [`${HEADER},${EXT}`, ...rows].join('\n');
  const ext = (hour: string, values: string, opts: Partial<Record<string, string>> = {}) => `${row(hour, opts)},${values}`;

  it('parses the extension columns instead of reporting them as unknown', () => {
    const r = normalizeFocusCsv(extCsv(ext('00', 'tenant-e00mock,mock-tenant,project-e00mockp,mock-project,trial-e00mock,NULL,NULL', { x_ContainerId: 'project-e00mockp' })));
    expect(r.unknownColumns).toEqual([]);
    expect(r.records[0]).toMatchObject({
      tenantId: 'tenant-e00mock', tenantName: 'mock-tenant', projectId: 'project-e00mockp', projectName: 'mock-project',
      trialId: 'trial-e00mock', contractPriceId: '', usageBasedDiscountIds: '',
    });
  });

  it('reads the literal NULL the export writes as an empty value, also in cost columns', () => {
    const r = normalizeFocusCsv(extCsv(ext('00', 'NULL,NULL,NULL,NULL,NULL,NULL,NULL', { EffectiveCost: 'NULL' })));
    expect(r.errors).toEqual([]);
    expect(r.records[0]).toMatchObject({ trialId: '', projectId: '', costs: { BilledCost: '10', EffectiveCost: null } });
  });

  it('treats NULL as empty in every column, so it never shows as data (live export, 2026-10-11)', () => {
    const r = normalizeFocusCsv(extCsv(ext('00', 'NULL,NULL,NULL,NULL,NULL,NULL,NULL', { ChargeClass: 'NULL', ResourceName: 'NULL', Tags: 'NULL', RegionId: 'NULL', PricingQuantity: 'NULL', ChargeCategory: 'Tax' })));
    expect(r.errors).toEqual([]);
    expect(r.records[0]).toMatchObject({ chargeClass: '', resourceName: '', tagsRaw: '', regionId: '', pricingQuantity: null });
    const ledger = new BillingLedger();
    ledger.ingest('i1', 't', r.records);
    expect(aggregateCosts(ledger.all(), 'BilledCost', 'chargeCategory').groups[0].key).toBe('Tax');
    expect(aggregateCosts(ledger.all(), 'BilledCost', 'resource').groups[0].label).not.toMatch(/NULL/);
  });

  it('cleans NULL text out of rows stored before it was treated as empty', () => {
    const stored = { ...normalizeFocusCsv(csv(row('00'))).records[0], chargeClass: 'NULL', resourceName: 'NULL', tagsRaw: 'NULL' };
    expect(withFocusExtensions(stored)).toMatchObject({ chargeClass: '', resourceName: '', tagsRaw: '' });
  });

  it('attributes a row to x_ProjectId first, then x_ContainerId', () => {
    const r = normalizeFocusCsv(extCsv(
      ext('00', 't,tn,project-e00mockp,mock-project,,,', { x_ContainerId: '', x_ContainerName: 'container' }),
      ext('01', 't,tn,,,,,'),
    ));
    expect(attributedProject(r.records[0])).toEqual({ id: 'project-e00mockp', name: 'mock-project' });
    expect(attributedProject(r.records[1])).toEqual({ id: 'project-e00mocksandbox', name: 'sandbox' });
    const ledger = new BillingLedger();
    ledger.ingest('i1', 't', r.records);
    const report = aggregateCosts(ledger.all(), 'BilledCost', 'project');
    expect(report.groups.map(g => g.label).sort()).toEqual(['mock-project (project-e00mockp)', 'sandbox (project-e00mocksandbox)']);
  });

  it('refuses a row whose x_ProjectId and x_ContainerId disagree, with the reason', () => {
    const r = normalizeFocusCsv(extCsv(
      ext('00', 't,tn,project-e00mocksandbox,sandbox,,,', { x_ContainerId: 'project-e00mockstaging', x_ContainerName: 'staging' }),
      ext('01', 't,tn,project-e00mocksandbox,sandbox,,,'),
    ));
    expect(r.records).toHaveLength(1);
    expect(r.errors).toEqual([{ row: 2, message: expect.stringMatching(/x_ProjectId project-e00mocksandbox and x_ContainerId project-e00mockstaging disagree/) }]);
  });

  it('builds the supersession slot from the attributed project, the id scope checks use', () => {
    const r = normalizeFocusCsv(extCsv(
      ext('00', 't,tn,project-e00mocksandbox,sandbox,,,', { x_ContainerId: '' }),
      ext('00', 't,tn,,,,,', { x_ContainerId: 'project-e00mockstaging', ResourceId: 'computeinstance-e00mockstg' }),
    ));
    expect(r.records.map(x => x.slot.split('\u001f')[1])).toEqual(['project-e00mocksandbox', 'project-e00mockstaging']);
    expect(r.records.map(x => billingSlot(x))).toEqual(r.records.map(x => x.slot));
    // A row attributed through x_ProjectId supersedes that project's earlier rows of the hour, and no other project's.
    const ledger = new BillingLedger();
    ledger.ingest('i1', 't', normalizeFocusCsv(csv(row('00'), row('00', { x_ContainerId: 'project-e00mockstaging', ResourceId: 'computeinstance-e00mockstg' }))).records);
    const s = ledger.ingest('i2', 't', [r.records[0]]);
    expect(s.supersededRows).toBe(1);
    expect(ledger.active().map(x => attributedProject(x).id).sort()).toEqual(['project-e00mocksandbox', 'project-e00mockstaging']);
  });

  it('counts the rows and cost drawn from trial or promo credit (x_TrialId set)', () => {
    const r = normalizeFocusCsv(extCsv(ext('00', 't,tn,project-e00mockp,p,trial-e00mock,,', { x_ContainerId: 'project-e00mockp' }), ext('01', 't,tn,project-e00mockp,p,NULL,,', { BilledCost: '2.5', x_ContainerId: 'project-e00mockp' })));
    const ledger = new BillingLedger();
    ledger.ingest('i1', 't', r.records);
    const report = aggregateCosts(ledger.all(), 'BilledCost', 'project');
    expect(report.creditFunded).toEqual({ rows: 1, totals: [{ amount: '10', currency: 'XTS' }] });
    expect(report.groups[0].creditFundedRows).toBe(1);
  });

  it('re-derives the extension fields of rows stored before they were parsed, idempotently', () => {
    const old = { ...normalizeFocusCsv(csv(row('00'))).records[0] } as Record<string, unknown>;
    for (const k of ['tenantId', 'tenantName', 'projectId', 'projectName', 'trialId', 'contractPriceId', 'usageBasedDiscountIds']) delete old[k];
    const once = withFocusExtensions(old as any);
    expect(once).toMatchObject({ projectId: 'project-e00mocksandbox', projectName: 'sandbox', trialId: '', tenantId: '' });
    expect(withFocusExtensions(once)).toEqual(once);
    // A container that is not a project is not taken for one.
    expect(withFocusExtensions({ ...(old as any), containerId: 'tenant-e00mock' }).projectId).toBe('');
  });
});

describe('effectiveRange (F1.19)', () => {
  const h = { earliestChargePeriodStart: '2026-10-06T12:00:00Z', latestChargePeriodStart: '2026-10-07T00:00:00Z' };
  it('fills the empty ends with the days the rows span ([from, to) in UTC days, the end exclusive)', () => {
    expect(effectiveRange(h, { from: '', to: '' })).toEqual({ from: '2026-10-06', to: '2026-10-08', fromImplicit: true, toImplicit: true });
  });
  it('keeps a chosen end as it is', () => {
    expect(effectiveRange(h, { from: '2026-10-01', to: '' })).toEqual({ from: '2026-10-01', to: '2026-10-08', fromImplicit: false, toImplicit: true });
    expect(effectiveRange(h, { from: '', to: '2026-10-07' })).toEqual({ from: '2026-10-06', to: '2026-10-07', fromImplicit: true, toImplicit: false });
  });
  it('leaves an end empty when no row says where it is', () => {
    expect(effectiveRange({}, { from: '', to: '' })).toEqual({ from: '', to: '', fromImplicit: true, toImplicit: true });
  });
  it('exportHealth reports the newest charge-period start', () => {
    const ledger = new BillingLedger();
    ledger.ingest('i1', 't', normalizeFocusCsv(csv(row('03'), row('00'))).records);
    expect(exportHealth(ledger.active(), { rows: 2, imports: 1 }, new Date('2026-10-06T00:00:00Z')).latestChargePeriodStart).toMatch(/^2026-10-05T03:00:00/);
  });
});

describe('next pull and next export file (#12)', () => {
  const now = new Date('2026-10-12T21:40:00Z');
  it('estimates the next file from the observed arrivals (about hourly), and says it is an estimate', () => {
    const arrivals = ['2026-10-12T21:16:00Z', '2026-10-12T20:15:00Z', '2026-10-12T19:17:00Z', '2026-10-12T18:16:00Z'];
    expect(exportCadence(arrivals, now)).toEqual({ expectedAt: '2026-10-12T22:16:00.000Z', intervalMinutes: 60, files: 4, late: false });
    expect(exportFreshnessText({ nextRunAt: '2026-10-12T21:45:00Z', nextFile: exportCadence(arrivals, now) }, now)).toBe(
      'next pull 21:45 UTC · next export file expected ≈ 22:16 UTC (estimate from the last 4 arrivals; Nebius writes the periodic export about hourly)',
    );
  });
  it('hides the estimate when the cadence cannot be observed: too few files, or no regular interval', () => {
    expect(exportCadence(['2026-10-12T21:16:00Z', '2026-10-12T20:15:00Z'], now)).toBeUndefined();
    expect(exportCadence(['2026-10-12T21:16:00Z', '2026-10-10T20:15:00Z', '2026-10-02T19:17:00Z'], now)).toBeUndefined();
    expect(exportFreshnessText({ nextRunAt: '2026-10-12T21:45:00Z' }, now)).toBe('next pull 21:45 UTC');
    expect(exportFreshnessText({}, now)).toBeUndefined();
  });
  it('says a file that has not arrived when expected is late', () => {
    const arrivals = ['2026-10-12T19:16:00Z', '2026-10-12T18:15:00Z', '2026-10-12T17:17:00Z'];
    expect(exportCadence(arrivals, now)).toMatchObject({ expectedAt: '2026-10-12T20:16:00.000Z', late: true });
    expect(exportFreshnessText({ nextFile: exportCadence(arrivals, now) }, now)).toBe(
      'next export file was expected ≈ 20:16 UTC, not arrived yet (estimate from the last 3 arrivals; Nebius writes the periodic export about hourly)',
    );
  });
});

