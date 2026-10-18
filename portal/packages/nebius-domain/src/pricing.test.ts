import { globalFilterSchema } from './api';
import { estimateScenario, estimateHeadline, findRate, footprintIsEmpty, footprintSchema, platformsWithoutRate, preferredPlatform, scenarioChoices, RateBook, rateBookSchema, ScenarioInput, quoteToCsvRows, quoteDocument, DRAFT_QUOTE_LABEL } from './pricing';

const base = {
  provider: 'nebius',
  region: 'test-region1',
  currency: 'XTS',
  effectiveFrom: '2026-01-01',
  source: 'unit test',
  retrievedAt: '2026-10-01T00:00:00Z',
  classification: 'confidential' as const,
};

function book(extra: Partial<RateBook> = {}): RateBook {
  return rateBookSchema.parse({
    id: 'test-book',
    name: 'Test book',
    kind: 'negotiated',
    classification: 'confidential',
    currency: 'XTS',
    entries: [
      // Bundled GPU-hour: vCPU and RAM of the preset are included.
      { ...base, id: 'gpu-h', service: 'compute', platform: 'gpu-x', component: 'gpu', unit: { quantity: 'gpu', per: 'hour' }, capacityType: 'on-demand', price: '10', bundles: ['vcpu', 'ram'] },
      { ...base, id: 'gpu-spot', service: 'compute', platform: 'gpu-x', component: 'gpu', unit: { quantity: 'gpu', per: 'hour' }, capacityType: 'preemptible', price: '4', bundles: ['vcpu', 'ram'], priceSemantics: 'variable' },
      { ...base, id: 'cpu-v', service: 'compute', platform: 'cpu-d3', component: 'vcpu', unit: { quantity: 'vcpu', per: 'hour' }, capacityType: 'any', price: '0.01' },
      { ...base, id: 'cpu-r', service: 'compute', platform: 'cpu-d3', component: 'ram', unit: { quantity: 'ram_gib', per: 'hour' }, capacityType: 'any', price: '0.001' },
      { ...base, id: 'boot', service: 'compute', component: 'boot-disk', unit: { quantity: 'storage_gib', per: 'month730' }, capacityType: 'any', price: '0.073' },
      { ...base, id: 'fs', service: 'compute', component: 'filesystem', unit: { quantity: 'storage_gib', per: 'month730' }, capacityType: 'any', price: '0.146' },
      { ...base, id: 'ssd-old', service: 'compute', component: 'disk-ssd', unit: { quantity: 'storage_gib', per: 'month730' }, capacityType: 'any', price: '0.073', effectiveTo: '2026-06-30' },
    ],
    discountRules: [
      { id: 'gpu-10', description: '10% off GPU', percent: '10', appliesTo: { components: ['gpu'] }, source: 'test' },
      { id: 'gpu-x-5', description: '5% off gpu-x', percent: '5', appliesTo: { platforms: ['gpu-x'] }, source: 'test' },
    ],
    ...extra,
  });
}

function scenario(extra: Partial<ScenarioInput> = {}): ScenarioInput {
  const fp = (gpuNodes: number) => ({
    nodeGroups: [
      { name: 'system', role: 'system' as const, platform: 'cpu-d3', preset: '8vcpu-32gb', count: 2, bootDiskGib: 100 },
      { name: 'gpu', role: 'gpu' as const, platform: 'gpu-x', preset: '1gpu-16vcpu-200gb', count: gpuNodes, bootDiskGib: 0 },
    ],
    filesystemGib: 100,
  });
  return {
    name: 'test',
    recipe: 'inference',
    region: 'test-region1',
    currency: 'XTS',
    rateBookId: 'test-book',
    capacityType: 'on-demand',
    asOf: '2026-10-01',
    runtime: { activeHours: 10, warmupHours: 1, teardownHours: 1 },
    monthlyHours: 730,
    footprints: { min: fp(0), expected: fp(1), max: fp(2) },
    ...extra,
  };
}

const exp = (e: ReturnType<typeof estimateScenario>) => e.footprints.find(f => f.footprint === 'expected')!;

describe('estimateScenario', () => {
  it('prices a footprint with decimal arithmetic and normalised units', () => {
    const e = estimateScenario(scenario(), book(), new Date('2026-10-01T00:00:00Z'));
    const f = exp(e);
    // system: 16 vCPU × 0.01 + 64 GiB × 0.001 = 0.224; boot 200 GiB × 0.073/730 = 0.02;
    // fs 100 × 0.146/730 = 0.02 → floor 0.264; GPU 1 × 10 = 10 workload.
    expect(f.hourlyFloor.amount).toBe('0.264');
    expect(f.hourlyWorkload.amount).toBe('10');
    expect(f.hourly.amount).toBe('10.264');
    expect(f.runHours).toBe(12);
    expect(f.runPeriod.amount).toBe('123.168');
    expect(f.monthly.amount).toBe('7492.72');
    expect(e.label).toBe(DRAFT_QUOTE_LABEL);
  });

  it('does not double count vCPU/RAM bundled into the GPU rate', () => {
    const f = exp(estimateScenario(scenario(), book()));
    const gpuGroup = f.lines.filter(l => l.nodeGroup === 'gpu');
    expect(gpuGroup.find(l => l.component === 'vcpu')?.status).toBe('bundled');
    expect(gpuGroup.find(l => l.component === 'ram')?.status).toBe('bundled');
    expect(gpuGroup.filter(l => l.status === 'priced').map(l => l.component)).toEqual(['gpu']);
  });

  it('reports missing and expired rates instead of pricing them at zero', () => {
    const e = estimateScenario(
      scenario({ footprints: { ...scenario().footprints, expected: { ...scenario().footprints.expected, extraSsdGib: 50, publicIps: 1 } } }),
      book(),
    );
    const issues = e.coverage.issues.filter(i => i.footprint === 'expected');
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ component: 'disk-ssd', status: 'expired-rate' }),
        expect.objectContaining({ component: 'public-ip', status: 'missing-rate' }),
      ]),
    );
    expect(e.coverage.complete).toBe(false);
    expect(exp(e).hourly.amount).toBe('10.264'); // excluded lines add nothing
  });

  it('says how many lines a total leaves out, and gives no total or selling price when a compute line is unpriced (W1-P9, #50)', () => {
    // Storage gaps only: a total, with the lines it excludes named.
    const storageGap = estimateScenario(
      scenario({ marginPercent: '10', footprints: { ...scenario().footprints, expected: { ...scenario().footprints.expected, extraSsdGib: 50, publicIps: 1 } } }),
      book(),
    );
    expect(estimateHeadline(exp(storageGap))).toEqual({ state: 'partial', unpricedLines: 2, unpricedCompute: 0, text: 'excludes 2 unpriced lines' });
    expect(storageGap.sellingPrice).toBeDefined();
    // A GPU platform without a rate: no total, and no selling price built on the rest.
    const gpuGap = estimateScenario(
      scenario({
        marginPercent: '10',
        footprints: {
          ...scenario().footprints,
          expected: { ...scenario().footprints.expected, nodeGroups: [...scenario().footprints.expected.nodeGroups, { name: 'gpu2', role: 'gpu', platform: 'gpu-unpriced', preset: '1gpu-16vcpu-200gb', count: 1, bootDiskGib: 0 }] },
        },
      }),
      book(),
    );
    const h = estimateHeadline(exp(gpuGap));
    expect(h).toMatchObject({ state: 'incomplete', unpricedCompute: 3 });
    expect(h.text).toBe(`Incomplete: ${h.unpricedLines} lines unpriced`);
    expect(gpuGap.sellingPrice).toBeUndefined();
    expect(gpuGap.sellingPriceWithheld).toBe(h.text);
    expect(estimateHeadline(exp(estimateScenario(scenario(), book())))).toEqual({ state: 'complete', unpricedLines: 0, unpricedCompute: 0, text: 'all lines priced' });
  });

  it('the downloadable quote carries each footprint headline and no total for an incomplete footprint (W1-P9, #50)', () => {
    const gpuGap = estimateScenario(
      scenario({
        marginPercent: '10',
        footprints: {
          ...scenario().footprints,
          expected: { ...scenario().footprints.expected, nodeGroups: [...scenario().footprints.expected.nodeGroups, { name: 'gpu2', role: 'gpu', platform: 'gpu-unpriced', preset: '1gpu-16vcpu-200gb', count: 1, bootDiskGib: 0 }] },
        },
      }),
      book(),
    );
    expect(exp(gpuGap).headline).toEqual(estimateHeadline(exp(gpuGap)));
    const q = quoteDocument(gpuGap);
    const expected = q.footprints.find(f => f.footprint === 'expected')!;
    expect(expected.headline.state).toBe('incomplete');
    expect(expected.headline.text).toMatch(/^Incomplete: \d+ lines unpriced$/);
    for (const k of ['hourly', 'hourlyFloor', 'hourlyWorkload', 'runPeriod', 'monthly', 'commitmentHourly'] as const) expect(expected[k]).toBeNull();
    expect(expected.totalsWithheld).toBe(expected.headline.text);
    // The lines stay: what was priced and what was not is still in the quote.
    expect(expected.lines.length).toBe(exp(gpuGap).lines.length);
    expect(q.sensitivity.every(s => s.runPeriod.expected === null)).toBe(true);
    expect(q.sellingPrice).toBeUndefined();
    // A complete footprint keeps its totals.
    const min = q.footprints.find(f => f.footprint === 'min')!;
    expect(min.headline.state).toBe('complete');
    expect(min.runPeriod).toEqual(gpuGap.footprints.find(f => f.footprint === 'min')!.runPeriod);
    expect(q.sensitivity[0].runPeriod.min).toEqual(gpuGap.sensitivity[0].runPeriod.min);
    expect(JSON.parse(JSON.stringify(q)).footprints.find((f: any) => f.footprint === 'expected').monthly).toBeNull();
  });

  it('excludes rates in another currency and says so', () => {
    const b = book();
    b.entries = b.entries.map(r => (r.id === 'fs' ? { ...r, currency: 'EUR' } : r));
    const e = estimateScenario(scenario(), b);
    expect(e.coverage.issues.some(i => i.status === 'currency-mismatch' && i.component === 'filesystem')).toBe(true);
    const e2 = estimateScenario(scenario({ currency: 'USD' }), book());
    expect(e2.errors[0]).toMatch(/differs from scenario currency/);
  });

  it('applies a discount only to matching lines and refuses overlapping rules', () => {
    const e = estimateScenario(scenario({ discountRuleIds: ['gpu-10'] }), book());
    const f = exp(e);
    expect(f.lines.filter(l => l.discount).map(l => l.component)).toEqual(['gpu']);
    expect(f.hourlyWorkload.amount).toBe('9');
    expect(f.hourlyFloor.amount).toBe('0.264');

    const overlap = estimateScenario(scenario({ discountRuleIds: ['gpu-10', 'gpu-x-5'] }), book());
    expect(overlap.errors.some(x => /overlap/.test(x))).toBe(true);
    expect(exp(overlap).lines.some(l => l.discount)).toBe(false);
  });

  it('flags variable spot prices', () => {
    const e = estimateScenario(scenario({ capacityType: 'preemptible' }), book());
    expect(e.coverage.variablePriceComponents).toContain('gpu gpu-x');
    expect(exp(e).hourlyWorkload.amount).toBe('4');
  });

  it('charges commitments as floor and does not charge committed units again', () => {
    const e = estimateScenario(
      scenario({ commitments: [{ id: 'c1', description: '1 GPU committed', component: 'gpu', platform: 'gpu-x', committedQuantity: 1, hourlyPrice: '7', source: 'test' }] }),
      book(),
    );
    const f = exp(e);
    expect(f.commitmentHourly.amount).toBe('7');
    expect(f.hourlyWorkload.amount).toBe('0');
    expect(f.hourlyFloor.amount).toBe('7.264');
    // min footprint has 0 GPU nodes but still pays the commitment
    expect(e.footprints[0].hourly.amount).toBe('7.264');
  });

  it('computes sensitivity and a separate selling price', () => {
    const e = estimateScenario(scenario({ marginPercent: '20' }), book());
    expect(e.sensitivity.map(s => s.activeHours)).toEqual([5, 10, 15, 20]);
    expect(e.sensitivity[1].runPeriod.expected.amount).toBe(exp(e).runPeriod.amount);
    expect(e.sellingPrice?.runPeriod.amount).toBe('147.8');
  });

  it('finds the most specific rate', () => {
    const b = book();
    b.entries.push({ ...b.entries[0], id: 'gpu-preset', preset: '1gpu-16vcpu-200gb', price: '9' });
    expect(findRate(b, { region: 'test-region1', component: 'gpu', platform: 'gpu-x', preset: '1gpu-16vcpu-200gb', capacityType: 'on-demand' }, '2026-10-01').rate?.id).toBe('gpu-preset');
  });

  it('exports quote CSV rows', () => {
    const { header, rows } = quoteToCsvRows(estimateScenario(scenario(), book()));
    expect(header[0]).toBe('footprint');
    expect(rows.length).toBeGreaterThan(5);
  });

  it('rejects discount rules without a scope and invalid prices', () => {
    expect(() => book({ discountRules: [{ id: 'x', description: 'all', percent: '5', appliesTo: {}, source: 's' }] as any })).toThrow();
    expect(() => rateBookSchema.parse({ ...book(), entries: [{ ...book().entries[0], price: '1e3' }] })).toThrow();
  });
});

describe('estimateRunRate', () => {
  const vm = (extra: object) => ({ uid: 'u', name: 'n', type: 'compute-instance', status: 'running', region: 'test-region1', spec: { platform: 'gpu-x', preset: '1gpu-16vcpu-200gb', capacityType: 'on-demand' }, ...extra });
  it('prices running VMs and storage, bundles vCPU/RAM into GPU rates, skips stopped VMs', () => {
    const { estimateRunRate } = require('./pricing');
    const r = estimateRunRate(
      [
        vm({ uid: 'a' }),
        vm({ uid: 'b', spec: { platform: 'cpu-d3', preset: '8vcpu-32gb' } }),
        vm({ uid: 'c', status: 'stopped' }),
        { uid: 'd', name: 'fs', type: 'compute-filesystem', status: 'running', region: 'test-region1', spec: { sizeGib: 100 } },
      ],
      book(),
      '2026-10-01',
    );
    // a: 10 (bundled); b: 8 × 0.01 + 32 × 0.001 = 0.112; fs: 100 × 0.0002 = 0.02
    expect(r.hourly).toEqual([{ amount: '10.132', currency: 'XTS' }]);
    expect(r.pricedResources).toBe(3);
    expect(r.excluded).toBe(1);
  });
  it('lists unpriced resources instead of pricing them at zero', () => {
    const { estimateRunRate } = require('./pricing');
    const r = estimateRunRate([vm({ uid: 'z', spec: { platform: 'gpu-y', preset: '1gpu-16vcpu-200gb' } })], book(), '2026-10-01');
    expect(r.hourly).toEqual([]);
    expect(r.unpricedResources[0].reason).toMatch(/no gpu rate/);
  });
  // W1-P10: the live tile priced a running PostgreSQL and listed MLflow while this tile read "0 priced, 0 without a rate".
  it('counts the same running resources as the live run-rate: managed PostgreSQL and MLflow are listed without a rate, never left out', () => {
    const { estimateRunRate } = require('./pricing');
    const r = estimateRunRate(
      [
        { uid: 'pg', name: 'r12-db', type: 'postgresql-cluster', status: 'running', region: 'test-region1', spec: {} },
        { uid: 'ml', name: 'r12-mlflow', type: 'mlflow-cluster', status: 'running', region: 'test-region1', spec: {} },
        { uid: 'pg-off', name: 'old-db', type: 'postgresql-cluster', status: 'stopped', region: 'test-region1', spec: {} },
      ],
      book(),
      '2026-10-01',
    );
    expect(r.pricedResources).toBe(0);
    expect(r.unpricedResources).toEqual([
      { uid: 'pg', name: 'r12-db', reason: 'managed PostgreSQL: a rate book has no managed-service rate (the live run-rate prices it)' },
      { uid: 'ml', name: 'r12-mlflow', reason: 'managed MLflow: a rate book has no managed-service rate' },
    ]);
    expect(r.excluded).toBe(1);
    expect(r.note).toMatch(/managed PostgreSQL and MLflow are listed without a rate/);
  });
  // Live 2026-10-12 (followup 23): a deleted PostgreSQL cluster stayed priced from an old read.
  it('never prices a resource the latest inventory sync did not read: it is listed with when it was last seen', () => {
    const { estimateRunRate } = require('./pricing');
    const src = { connector: 'nebius-inventory', kind: 'nebius-api' };
    const r = estimateRunRate(
      [vm({ uid: 'a', source: src, observedAt: '2026-10-12T20:18:00Z' }), vm({ uid: 'old', name: 'gone-vm', source: src, observedAt: '2026-10-12T19:00:00Z' })],
      book(),
      '2026-10-01',
      { inventoryReadAt: '2026-10-12T20:18:00Z' },
    );
    expect(r.hourly).toEqual([{ amount: '10', currency: 'XTS' }]);
    expect(r.pricedResources).toBe(1);
    expect(r.unpricedResources).toEqual([{ uid: 'old', name: 'gone-vm', reason: 'last seen 2026-10-12 19:00 UTC, not in the latest inventory sync' }]);
  });
});

describe('footprint input bounds', () => {
  it('bounds platform and preset names (they become calculator cache keys and request bodies)', () => {
    const g = { name: 'gpu', role: 'gpu', platform: 'gpu-h200-sxm', preset: '8gpu-128vcpu-1600gb', count: 1, bootDiskGib: 100 };
    expect(footprintSchema.safeParse({ nodeGroups: [g] }).success).toBe(true);
    expect(footprintSchema.safeParse({ nodeGroups: [{ ...g, platform: 'x'.repeat(65) }] }).success).toBe(false);
    expect(footprintSchema.safeParse({ nodeGroups: [{ ...g, preset: 'x'.repeat(65) }] }).success).toBe(false);
  });
});

describe('footprintIsEmpty (F1.18)', () => {
  const g = { name: 'gpu', role: 'gpu' as const, platform: 'gpu-h100-sxm', preset: '1gpu-16vcpu-200gb', count: 0, bootDiskGib: 200 };
  const fp = (over = {}) => footprintSchema.parse({ nodeGroups: [g], ...over });
  it('is empty when no node group has a node and no storage or IP is asked for', () => {
    expect(footprintIsEmpty(fp())).toBe(true);
    expect(footprintIsEmpty(footprintSchema.parse({ nodeGroups: [] }))).toBe(true);
  });
  it('is not empty with one node, one GiB of any storage or one public IP', () => {
    expect(footprintIsEmpty(fp({ nodeGroups: [{ ...g, count: 1 }] }))).toBe(false);
    for (const k of ['filesystemGib', 'extraSsdGib', 'ioM3Gib', 'objectStorageGib', 'publicIps']) expect(footprintIsEmpty(fp({ [k]: 1 }))).toBe(false);
  });
});

describe('scenarioChoices (F1.17)', () => {
  const entry = (region: string, component: string, platform?: string, preset?: string) => ({ region, component, platform, preset }) as any;
  const priced = { entries: [entry('eu-north1', 'gpu', 'gpu-h100-sxm'), entry('eu-north1', 'vcpu', 'cpu-d3'), entry('eu-north1', 'boot-disk'), entry('uk-south1', 'gpu', 'gpu-b300-sxm'), entry('uk-south1', 'gpu', 'gpu-b300-sxm', '8gpu-192vcpu-2768gb')] };
  const regions = [
    { id: 'eu-north1', platforms: [{ id: 'gpu-h100-sxm', single_gpu_preset: '1gpu-16vcpu-200gb', ib_preset: '8gpu-128vcpu-1600gb' }, { id: 'gpu-l40s-a', single_gpu_preset: '1gpu-8vcpu-32gb' }] },
    { id: 'uk-south1', platforms: [{ id: 'gpu-b300-sxm', single_gpu_preset: '1gpu-24vcpu-346gb', ib_preset: '8gpu-192vcpu-2768gb' }] },
    { id: 'eu-west2', platforms: [] },
  ];
  it('offers the regions and compute platforms the rate book prices', () => {
    const c = scenarioChoices(priced, regions);
    expect(c.regions).toEqual(['eu-north1', 'uk-south1']);
    expect(c.platforms('eu-north1')).toEqual(['cpu-d3', 'gpu-h100-sxm']);
    expect(c.platforms('eu-west2')).toEqual([]);
  });
  it('offers the rate book presets first, then the region file presets, without repeats', () => {
    const c = scenarioChoices(priced, regions);
    expect(c.presets('eu-north1', 'gpu-h100-sxm')).toEqual(['1gpu-16vcpu-200gb', '8gpu-128vcpu-1600gb']);
    expect(c.presets('uk-south1', 'gpu-b300-sxm')).toEqual(['8gpu-192vcpu-2768gb', '1gpu-24vcpu-346gb']);
    // No preset is known for a CPU platform: the form asks for one (never invented).
    expect(c.presets('eu-north1', 'cpu-d3')).toEqual([]);
  });
  it('falls back to the region file without a rate book', () => {
    const c = scenarioChoices(undefined, regions);
    expect(c.regions).toEqual(['eu-north1', 'eu-west2', 'uk-south1']);
    expect(c.platforms('eu-north1')).toEqual(['gpu-h100-sxm', 'gpu-l40s-a']);
  });
  it('opens the new-scenario form on a GPU platform with a known preset, not on the first name alphabetically', () => {
    const c = scenarioChoices(priced, regions);
    // cpu-d3 sorts first but has no preset: the form would open on a free-text field.
    expect(preferredPlatform(c, 'eu-north1')).toBe('gpu-h100-sxm');
    expect(preferredPlatform(c, 'uk-south1')).toBe('gpu-b300-sxm');
    // Only a CPU platform without a preset: it is still the one offered.
    expect(preferredPlatform(scenarioChoices({ entries: [entry('eu-west1', 'vcpu', 'cpu-e2')] }, regions), 'eu-west1')).toBe('cpu-e2');
    expect(preferredPlatform(c, 'eu-west2')).toBe('');
  });
  it('names the scenario platforms a region has no compute rate for', () => {
    const c = scenarioChoices(priced, regions);
    expect(platformsWithoutRate(c, 'uk-south1', ['gpu-h100-sxm', 'cpu-d3', 'gpu-h100-sxm'])).toEqual(['cpu-d3', 'gpu-h100-sxm']);
    expect(platformsWithoutRate(c, 'eu-north1', ['gpu-h100-sxm'])).toEqual([]);
  });
});

describe('filter and region input errors in words (F1.17)', () => {
  it('names what a region, project or stage looks like instead of printing the pattern', () => {
    const r = globalFilterSchema.safeParse({ region: 'mars-1', project: 'p1', stage: 'Prod!' });
    expect(r.success).toBe(false);
    const messages = r.success ? [] : r.error.issues.map(i => `${i.path.join('.')}: ${i.message}`);
    expect(messages).toEqual(['project: not a project id (project- and lower-case letters or digits)', 'region: not a Nebius region id such as eu-north1', 'stage: not a stage name (lower-case letters, digits and dashes)']);
    expect(messages.join(' ')).not.toMatch(/pattern|Invalid string/);
  });
});
