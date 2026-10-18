import { z } from 'zod';
import { Decimal } from './decimal';
import { Money, money } from './money';
import { parsePreset, RatePeriod, RateQuantity, toHourly } from './units';
import { lastSeenBefore, lastSeenReason } from './resources';

/**
 * Rate books and scenario estimates.
 *
 * Four kinds of figure are kept apart all the way to the UI:
 *   public list-rate estimate  — a rate book of kind `public-list`
 *   negotiated-rate scenario   — a rate book of kind `negotiated`
 *   observed billed cost       — billing.ts, never produced here
 *   customer-facing draft price — `sellingPrice`, derived from one estimate
 * Nothing here is a provider offer: there is no pricing API behind it, every
 * rate is user-entered or imported with a source and a timestamp.
 */

export const DRAFT_QUOTE_LABEL = 'Draft estimate — not a provider offer or capacity guarantee.';

export const CHARGE_COMPONENTS = [
  'gpu',
  'vcpu',
  'ram',
  'boot-disk',
  'disk-ssd',
  'disk-io-m3',
  'filesystem',
  'object-storage',
  'public-ip',
  'other',
] as const;
export type ChargeComponent = (typeof CHARGE_COMPONENTS)[number];

export const CAPACITY_TYPES = ['on-demand', 'preemptible', 'reserved'] as const;
export type CapacityType = (typeof CAPACITY_TYPES)[number];

const decimalString = z
  .string()
  .refine(s => Decimal.isValid(s), 'must be a plain decimal string (no exponent, no separators)');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');

export const rateEntrySchema = z.object({
  id: z.string().min(1).max(120),
  provider: z.string().min(1).default('nebius'),
  region: z.string().min(1),
  service: z.enum(['compute', 'mk8s', 'storage', 'object-storage', 'network', 'other']),
  /** GPU or CPU platform (gpu-h100-sxm, cpu-d3); omitted for platform-independent charges. */
  platform: z.string().optional(),
  /** A specific preset, or omitted for "any preset of the platform". */
  preset: z.string().optional(),
  component: z.enum(CHARGE_COMPONENTS),
  unit: z.object({
    quantity: z.enum(['gpu', 'vcpu', 'ram_gib', 'storage_gib', 'instance', 'ip', 'unit']),
    per: z.enum(['second', 'hour', 'month730']),
  }),
  capacityType: z.enum(['on-demand', 'preemptible', 'reserved', 'any']),
  currency: z.string().regex(/^[A-Z]{3}$/),
  price: decimalString,
  effectiveFrom: isoDate,
  effectiveTo: isoDate.optional(),
  source: z.string().min(1),
  retrievedAt: z.string().min(1),
  classification: z.enum(['public', 'confidential']),
  /**
   * Components this rate already includes. A GPU-hour rate that bundles the
   * preset's vCPU and RAM lists ['vcpu', 'ram']: those components are then
   * not charged separately for that node (no double counting).
   */
  bundles: z.array(z.enum(CHARGE_COMPONENTS)).default([]),
  /** `variable`: the price can move during use (spot); estimates flag it. */
  priceSemantics: z.enum(['fixed', 'variable']).default('fixed'),
  note: z.string().optional(),
});
export type RateEntry = z.infer<typeof rateEntrySchema>;

export const discountRuleSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  /** Percentage off, 0–100, decimal string. */
  percent: decimalString.refine(s => {
    const d = Decimal.from(s);
    return d.cmp(0) >= 0 && d.cmp(100) <= 0;
  }, 'percent must be within 0–100'),
  /** Applies only to lines matching ALL given selectors; at least one selector is required. */
  appliesTo: z
    .object({
      components: z.array(z.enum(CHARGE_COMPONENTS)).optional(),
      platforms: z.array(z.string()).optional(),
      capacityTypes: z.array(z.enum(CAPACITY_TYPES)).optional(),
    })
    .refine(a => Boolean(a.components?.length || a.platforms?.length || a.capacityTypes?.length), {
      message: 'a discount must name the components, platforms or capacity types it applies to',
    }),
  source: z.string().min(1),
});
export type DiscountRule = z.infer<typeof discountRuleSchema>;

export const RATE_BOOK_KINDS = ['public-list', 'negotiated'] as const;
export type RateBookKind = (typeof RATE_BOOK_KINDS)[number];

export const rateBookSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
  name: z.string().min(1).max(120),
  kind: z.enum(RATE_BOOK_KINDS),
  classification: z.enum(['public', 'confidential']),
  currency: z.string().regex(/^[A-Z]{3}$/),
  entries: z.array(rateEntrySchema).max(5000),
  discountRules: z.array(discountRuleSchema).default([]),
  note: z.string().optional(),
});
export type RateBook = z.infer<typeof rateBookSchema>;

/* ---------------------------------------------------------------- scenario */

export const nodeGroupShapeSchema = z.object({
  name: z.string().min(1).max(60),
  role: z.enum(['system', 'gpu', 'cpu-worker']),
  // Bounded: they become calculator request bodies and cache keys.
  platform: z.string().min(1).max(64),
  preset: z.string().min(1).max(64),
  count: z.number().int().min(0).max(512),
  bootDiskGib: z.number().int().min(0).max(65536),
});
export type NodeGroupShape = z.infer<typeof nodeGroupShapeSchema>;

export const footprintSchema = z.object({
  nodeGroups: z.array(nodeGroupShapeSchema).max(32),
  filesystemGib: z.number().min(0).max(10_000_000).default(0),
  extraSsdGib: z.number().min(0).max(10_000_000).default(0),
  ioM3Gib: z.number().min(0).max(10_000_000).default(0),
  objectStorageGib: z.number().min(0).max(100_000_000).default(0),
  publicIps: z.number().int().min(0).max(1000).default(0),
});
export type Footprint = z.infer<typeof footprintSchema>;

/**
 * A footprint that asks for nothing: no node in any group, no storage, no public IP. Its price is 0 by
 * definition (in any currency), not unknown: an empty "minimum" footprint is a real scenario (F1.18).
 */
export function footprintIsEmpty(fp: Footprint): boolean {
  return fp.nodeGroups.every(g => g.count === 0) && !fp.filesystemGib && !fp.extraSsdGib && !fp.ioM3Gib && !fp.objectStorageGib && !fp.publicIps;
}

/** A region of platform/regions.yaml as the provisioning model serves it (RecipesResponse.regions). */
export interface RegionPlatforms {
  id: string;
  platforms: { id: string; single_gpu_preset?: string; ib_preset?: string }[];
}

export interface ScenarioChoices {
  /** Regions the rate book has rates in (else, without a rate book, the regions of platform/regions.yaml). */
  regions: string[];
  /** Compute platforms with a GPU or vCPU rate in the region. */
  platforms: (region: string) => string[];
  /** Presets known for the platform: the rate book's own, then platform/regions.yaml's single-GPU and InfiniBand presets. */
  presets: (region: string, platform: string) => string[];
}

const uniqSorted = (xs: (string | undefined)[]) => [...new Set(xs.filter((x): x is string => Boolean(x)))].sort();

/**
 * What the new-scenario and scenario forms offer to pick (F1.17): only regions, platforms and presets the
 * rate book prices or the repository's region file names, so a typed region can no longer fail the
 * calculator's pattern check. An empty preset list means none is known: the form then asks for one in words.
 */
export function scenarioChoices(book: Pick<RateBook, 'entries'> | undefined, regions: RegionPlatforms[] = []): ScenarioChoices {
  const entries = book?.entries ?? [];
  const bookRegions = uniqSorted(entries.map(e => e.region));
  return {
    regions: bookRegions.length ? bookRegions : uniqSorted(regions.map(r => r.id)),
    platforms: region => {
      const priced = uniqSorted(entries.filter(e => e.region === region && (e.component === 'gpu' || e.component === 'vcpu')).map(e => e.platform));
      if (entries.length) return priced;
      return uniqSorted(regions.find(r => r.id === region)?.platforms.map(p => p.id) ?? []);
    },
    presets: (region, platform) => {
      const own = uniqSorted(entries.filter(e => e.region === region && e.platform === platform).map(e => e.preset));
      const known = regions.find(r => r.id === region)?.platforms.find(p => p.id === platform);
      return [...new Set([...own, ...uniqSorted([known?.single_gpu_preset, known?.ib_preset])])];
    },
  };
}

/**
 * The platform a new-scenario form opens on (F1.17): the first GPU platform with a known preset, else the first
 * platform with one, else the first. Alphabetical order alone opened a GPU cloud's form on cpu-d3, the one
 * platform without a preset, so the first thing shown was a free-text field.
 */
export function preferredPlatform(choices: ScenarioChoices, region: string): string {
  const platforms = choices.platforms(region);
  const withPreset = platforms.filter(p => choices.presets(region, p).length);
  return withPreset.find(p => p.startsWith('gpu-')) ?? withPreset[0] ?? platforms[0] ?? '';
}

/** The scenario's platforms (sorted, once each) that have no GPU or vCPU rate in `region`: the region picker says so (F1.17). */
export function platformsWithoutRate(choices: ScenarioChoices, region: string, platforms: string[]): string[] {
  const priced = new Set(choices.platforms(region));
  return uniqSorted(platforms.filter(p => !priced.has(p)));
}

export const commitmentSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  component: z.enum(CHARGE_COMPONENTS),
  platform: z.string().optional(),
  /** Units committed per hour (e.g. 16 GPUs). Paid whether used or not. */
  committedQuantity: z.number().min(0),
  /** Hourly price per committed unit, in the scenario currency. */
  hourlyPrice: decimalString,
  source: z.string().min(1),
});

export const scenarioSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1).max(120),
  recipe: z.enum(['inference', 'training', 'soperator', 'custom']),
  region: z.string().min(1),
  currency: z.string().regex(/^[A-Z]{3}$/),
  rateBookId: z.string().min(1),
  capacityType: z.enum(CAPACITY_TYPES),
  /** Pricing date: rates must be effective on this date. */
  asOf: isoDate,
  runtime: z.object({
    activeHours: z.number().min(0).max(100_000),
    warmupHours: z.number().min(0).max(1000).default(0),
    teardownHours: z.number().min(0).max(1000).default(0),
  }),
  /** Explicit hours assumption for the monthly figure (730 = always on). */
  monthlyHours: z.number().min(0).max(744).default(730),
  footprints: z.object({ min: footprintSchema, expected: footprintSchema, max: footprintSchema }),
  discountRuleIds: z.array(z.string()).default([]),
  commitments: z.array(commitmentSchema).default([]),
  /** Optional customer-facing margin; produces a separate draft selling price. */
  marginPercent: decimalString.optional(),
  quoteValidityDays: z.number().int().min(1).max(365).default(14),
  notes: z.string().max(4000).optional(),
});
export type Scenario = z.infer<typeof scenarioSchema>;
export type ScenarioInput = z.input<typeof scenarioSchema>;

/* -------------------------------------------------------------- estimation */

export type LineStatus = 'priced' | 'missing-rate' | 'expired-rate' | 'currency-mismatch' | 'bundled';

export interface EstimateLine {
  nodeGroup?: string;
  platform?: string;
  component: ChargeComponent;
  description: string;
  /** Units charged per hour (GPUs, vCPUs, GiB...). */
  quantity: string;
  quantityUnit: RateQuantity;
  /** Normalised per-hour unit rate in scenario currency (priced lines only). */
  hourlyUnitRate?: string;
  hourly?: Money;
  discount?: { ruleId: string; percent: string; hourly: Money };
  /** floor = accrues while the estate exists; workload = scales with GPU/worker footprint. */
  basis: 'floor' | 'workload';
  status: LineStatus;
  rateId?: string;
  rateSource?: string;
  rateRetrievedAt?: string;
  variablePrice?: boolean;
  note?: string;
}

export interface FootprintEstimate {
  footprint: 'min' | 'expected' | 'max';
  lines: EstimateLine[];
  hourly: Money;
  hourlyFloor: Money;
  hourlyWorkload: Money;
  /** Hours the resources exist: warm-up + active + teardown. */
  runHours: number;
  runPeriod: Money;
  monthlyHours: number;
  monthly: Money;
  commitmentHourly: Money;
  gpus: number;
  vcpus: number;
  /** What this footprint's total may say (W1-P9): set by estimateScenario. */
  headline: EstimateHeadline;
}

export interface CoverageIssue {
  footprint: string;
  component: ChargeComponent;
  description: string;
  status: Exclude<LineStatus, 'priced' | 'bundled'>;
}

export interface ScenarioEstimate {
  label: typeof DRAFT_QUOTE_LABEL;
  scenarioName: string;
  rateBook: { id: string; name: string; kind: RateBookKind; classification: string };
  currency: string;
  asOf: string;
  generatedAt: string;
  validUntil: string;
  footprints: FootprintEstimate[];
  coverage: { complete: boolean; issues: CoverageIssue[]; variablePriceComponents: string[] };
  sensitivity: { activeHours: number; runPeriod: Record<'min' | 'expected' | 'max', Money> }[];
  sellingPrice?: {
    marginPercent: string;
    basis: 'expected';
    runPeriod: Money;
    monthly: Money;
    note: string;
  };
  /**
   * Set instead of `sellingPrice` when the expected footprint has an unpriced GPU, vCPU or RAM line (W1-P9): a margin
   * on a total that leaves out compute is not a price. The text is the headline's ("Incomplete: N lines unpriced").
   */
  sellingPriceWithheld?: string;
  assumptions: string[];
  errors: string[];
}

/** Compute charges: a footprint total without one of them is no total at all (W1-P9). */
const COMPUTE_COMPONENTS: ReadonlySet<ChargeComponent> = new Set(['gpu', 'vcpu', 'ram']);

export interface EstimateHeadline {
  /** complete: every line priced; partial: only storage or IP lines unpriced (a total that names them); incomplete: a compute line unpriced (no total). */
  state: 'complete' | 'partial' | 'incomplete';
  unpricedLines: number;
  unpricedCompute: number;
  text: string;
}

/**
 * What a footprint's headline may say (W1-P9, #50): a total only when every GPU, vCPU and RAM line is priced, and then
 * with the storage or IP lines it leaves out named; otherwise "Incomplete: N lines unpriced" and no total.
 */
export function estimateHeadline(f: Pick<FootprintEstimate, 'lines'>): EstimateHeadline {
  const unpriced = f.lines.filter(l => l.status !== 'priced' && l.status !== 'bundled');
  const compute = unpriced.filter(l => COMPUTE_COMPONENTS.has(l.component)).length;
  const n = unpriced.length;
  const lines = `${n} ${n === 1 ? 'line' : 'lines'}`;
  if (compute) return { state: 'incomplete', unpricedLines: n, unpricedCompute: compute, text: `Incomplete: ${lines} unpriced` };
  if (n) return { state: 'partial', unpricedLines: n, unpricedCompute: 0, text: `excludes ${n} unpriced ${n === 1 ? 'line' : 'lines'}` };
  return { state: 'complete', unpricedLines: 0, unpricedCompute: 0, text: 'all lines priced' };
}

function effectiveOn(r: RateEntry, date: string): 'effective' | 'expired' | 'future' {
  if (r.effectiveFrom > date) return 'future';
  if (r.effectiveTo && r.effectiveTo < date) return 'expired';
  return 'effective';
}

interface RateQuery {
  region: string;
  component: ChargeComponent;
  platform?: string;
  preset?: string;
  capacityType: CapacityType;
}

/**
 * Most specific matching rate: preset beats platform-wide beats
 * platform-independent; an exact capacity type beats `any`.
 */
export function findRate(
  book: RateBook,
  q: RateQuery,
  asOf: string,
): { rate?: RateEntry; status: 'found' | 'missing' | 'expired' } {
  const candidates = book.entries.filter(
    r =>
      r.region === q.region &&
      r.component === q.component &&
      (r.capacityType === q.capacityType || r.capacityType === 'any') &&
      (r.platform === undefined || r.platform === q.platform) &&
      (r.preset === undefined || r.preset === q.preset),
  );
  const score = (r: RateEntry) =>
    (r.preset ? 4 : 0) + (r.platform ? 2 : 0) + (r.capacityType === q.capacityType ? 1 : 0);
  const effective = candidates.filter(r => effectiveOn(r, asOf) === 'effective').sort((a, b) => score(b) - score(a));
  if (effective.length) return { rate: effective[0], status: 'found' };
  if (candidates.some(r => effectiveOn(r, asOf) === 'expired')) return { status: 'expired' };
  return { status: 'missing' };
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function estimateScenario(input: ScenarioInput, book: RateBook, now = new Date()): ScenarioEstimate {
  const s = scenarioSchema.parse(input);
  const errors: string[] = [];
  const assumptions: string[] = [
    `Rates effective on ${s.asOf} from rate book "${book.name}" (${book.kind}).`,
    `Resources exist for ${s.runtime.warmupHours} h warm-up + ${s.runtime.activeHours} h active + ${s.runtime.teardownHours} h teardown.`,
    `Monthly figure assumes ${s.monthlyHours} hours.`,
    `Capacity type: ${s.capacityType}. Quota or a rate entry does not guarantee that capacity is available.`,
    'Volumes are charged on provisioned size; compute per second of existence, not of utilisation.',
  ];
  if (book.currency !== s.currency) {
    errors.push(`Rate book currency ${book.currency} differs from scenario currency ${s.currency}; no exchange-rate policy exists, so mismatched lines are excluded.`);
  }

  const rules = s.discountRuleIds.map(id => {
    const r = book.discountRules.find(d => d.id === id);
    if (!r) errors.push(`Discount rule ${id} is not in rate book ${book.id}`);
    return r;
  }).filter((r): r is DiscountRule => Boolean(r));

  const issues: CoverageIssue[] = [];
  const variable = new Set<string>();
  const footprints: FootprintEstimate[] = (['min', 'expected', 'max'] as const).map(name => {
    const f = estimateFootprint(name, s.footprints[name], s, book, rules, issues, variable, errors);
    return { ...f, headline: estimateHeadline(f) };
  });

  const sensitivity = [0.5, 1, 1.5, 2].map(mult => {
    const activeHours = Math.round(s.runtime.activeHours * mult * 100) / 100;
    const hours = s.runtime.warmupHours + activeHours + s.runtime.teardownHours;
    const runPeriod = Object.fromEntries(
      footprints.map(f => [f.footprint, money(Decimal.from(f.hourly.amount).mul(hoursDec(hours)), s.currency)]),
    ) as Record<'min' | 'expected' | 'max', Money>;
    return { activeHours, runPeriod };
  });

  let sellingPrice: ScenarioEstimate['sellingPrice'];
  let sellingPriceWithheld: string | undefined;
  const expectedHeadline = estimateHeadline(footprints.find(f => f.footprint === 'expected')!);
  if (s.marginPercent !== undefined && expectedHeadline.state === 'incomplete') {
    sellingPriceWithheld = expectedHeadline.text;
  } else if (s.marginPercent !== undefined) {
    const expected = footprints.find(f => f.footprint === 'expected')!;
    const factor = Decimal.ONE.add(Decimal.from(s.marginPercent).div(100));
    sellingPrice = {
      marginPercent: s.marginPercent,
      basis: 'expected',
      runPeriod: money(Decimal.from(expected.runPeriod.amount).mul(factor).toFixed(2), s.currency),
      monthly: money(Decimal.from(expected.monthly.amount).mul(factor).toFixed(2), s.currency),
      note: 'Customer-facing draft selling price = expected-footprint estimate × (1 + margin). Not a provider price.',
    };
  }

  return {
    label: DRAFT_QUOTE_LABEL,
    scenarioName: s.name,
    rateBook: { id: book.id, name: book.name, kind: book.kind, classification: book.classification },
    currency: s.currency,
    asOf: s.asOf,
    generatedAt: now.toISOString(),
    validUntil: addDays(now.toISOString().slice(0, 10), s.quoteValidityDays),
    footprints,
    coverage: { complete: issues.length === 0, issues, variablePriceComponents: [...variable] },
    sensitivity,
    sellingPrice,
    ...(sellingPriceWithheld ? { sellingPriceWithheld } : {}),
    assumptions,
    errors,
  };
}

function hoursDec(h: number): Decimal {
  return Decimal.from(h.toFixed(4));
}

function estimateFootprint(
  name: 'min' | 'expected' | 'max',
  fp: Footprint,
  s: Scenario,
  book: RateBook,
  rules: DiscountRule[],
  issues: CoverageIssue[],
  variable: Set<string>,
  errors: string[],
): Omit<FootprintEstimate, 'headline'> {
  const lines: EstimateLine[] = [];
  let gpus = 0;
  let vcpus = 0;

  const priceLine = (
    base: Omit<EstimateLine, 'status' | 'quantity'> & { quantity: Decimal },
    q: RateQuery,
  ): RateEntry | null => {
    if (base.quantity.isZero()) return null;
    const found = findRate(book, q, s.asOf);
    const line: EstimateLine = { ...base, platform: q.platform, quantity: base.quantity.toString(), status: 'priced' };
    if (!found.rate) {
      line.status = found.status === 'expired' ? 'expired-rate' : 'missing-rate';
      issues.push({ footprint: name, component: base.component, description: base.description, status: line.status });
      lines.push(line);
      return null;
    }
    const r = found.rate;
    line.rateId = r.id;
    line.rateSource = r.source;
    line.rateRetrievedAt = r.retrievedAt;
    if (r.currency !== s.currency) {
      line.status = 'currency-mismatch';
      issues.push({ footprint: name, component: base.component, description: base.description, status: 'currency-mismatch' });
      lines.push(line);
      return null;
    }
    const unitHourly = toHourly(r.price, r.unit.per as RatePeriod);
    line.hourlyUnitRate = unitHourly.toString();
    const hourly = unitHourly.mul(base.quantity);
    line.hourly = money(hourly, s.currency);
    if (r.priceSemantics === 'variable') {
      line.variablePrice = true;
      line.note = 'Variable (spot) price: can change during use; the estimate uses the recorded rate.';
      variable.add(`${base.component}${q.platform ? ` ${q.platform}` : ''}`);
    }
    const matching = rules.filter(d => discountMatches(d, base.component, q.platform, s.capacityType));
    if (matching.length > 1) {
      errors.push(`Discount rules ${matching.map(d => d.id).join(', ')} overlap on ${base.description}; none applied to that line.`);
    } else if (matching.length === 1) {
      const d = matching[0];
      line.discount = {
        ruleId: d.id,
        percent: d.percent,
        hourly: money(hourly.mul(Decimal.from(d.percent).div(100)).neg(), s.currency),
      };
    }
    lines.push(line);
    return r;
  };

  for (const g of fp.nodeGroups) {
    if (g.count === 0) continue;
    const shape = parsePreset(g.preset);
    if (!shape) {
      errors.push(`Preset "${g.preset}" of node group ${g.name} is not a recognised Nebius preset name`);
      continue;
    }
    gpus += shape.gpus * g.count;
    vcpus += shape.vcpus * g.count;
    const basis = g.role === 'system' ? 'floor' : 'workload';
    const capacityType: CapacityType = g.role === 'system' ? 'on-demand' : s.capacityType;
    const common = { nodeGroup: g.name, basis } as const;
    let bundled: ChargeComponent[] = [];
    if (shape.gpus > 0) {
      const r = priceLine(
        {
          ...common,
          component: 'gpu',
          description: `${g.name}: ${g.count} × ${g.platform} ${g.preset} — GPUs`,
          quantity: Decimal.from(shape.gpus * g.count),
          quantityUnit: 'gpu',
        },
        { region: s.region, component: 'gpu', platform: g.platform, preset: g.preset, capacityType },
      );
      bundled = r?.bundles ?? [];
    }
    for (const [component, qty, unit] of [
      ['vcpu', shape.vcpus * g.count, 'vcpu'],
      ['ram', shape.ramGib * g.count, 'ram_gib'],
    ] as const) {
      const description = `${g.name}: ${g.count} × ${g.platform} ${g.preset} — ${component === 'vcpu' ? 'vCPU' : 'RAM GiB'}`;
      if (bundled.includes(component)) {
        lines.push({ ...common, component, description, quantity: String(qty), quantityUnit: unit, status: 'bundled', note: 'Included in the GPU rate (bundled); not charged separately.' });
        continue;
      }
      priceLine(
        { ...common, component, description, quantity: Decimal.from(qty), quantityUnit: unit },
        { region: s.region, component, platform: g.platform, preset: g.preset, capacityType },
      );
    }
    priceLine(
      {
        ...common,
        component: 'boot-disk',
        description: `${g.name}: ${g.count} × ${g.bootDiskGib} GiB boot disk`,
        quantity: Decimal.from(g.bootDiskGib * g.count),
        quantityUnit: 'storage_gib',
      },
      { region: s.region, component: 'boot-disk', capacityType: 'on-demand' },
    );
  }

  const storage: [ChargeComponent, number, string][] = [
    ['filesystem', fp.filesystemGib, 'Shared filesystem'],
    ['disk-ssd', fp.extraSsdGib, 'Network SSD (CSI volumes)'],
    ['disk-io-m3', fp.ioM3Gib, 'Network SSD IO_M3'],
    ['object-storage', fp.objectStorageGib, 'Object Storage'],
  ];
  for (const [component, gib, label] of storage) {
    priceLine(
      { basis: 'floor', component, description: `${label}: ${gib} GiB`, quantity: Decimal.from(String(gib)), quantityUnit: 'storage_gib' },
      { region: s.region, component, capacityType: 'on-demand' },
    );
  }
  priceLine(
    { basis: 'floor', component: 'public-ip', description: `Public IPs: ${fp.publicIps}`, quantity: Decimal.from(fp.publicIps), quantityUnit: 'ip' },
    { region: s.region, component: 'public-ip', capacityType: 'on-demand' },
  );

  // Commitments: paid whether used or not, so they are floor charges; the
  // committed units are then not charged again at the on-demand rate.
  let commitmentHourly = Decimal.ZERO;
  for (const c of s.commitments) {
    const committedCost = Decimal.from(c.hourlyPrice).mul(Decimal.from(String(c.committedQuantity)));
    commitmentHourly = commitmentHourly.add(committedCost);
    let remaining = Decimal.from(String(c.committedQuantity));
    for (const l of lines) {
      if (remaining.isZero()) break;
      if (l.status !== 'priced' || l.component !== c.component || !l.hourly) continue;
      if (c.platform && l.platform !== c.platform) continue;
      const q = Decimal.from(l.quantity);
      const covered = q.cmp(remaining) <= 0 ? q : remaining;
      remaining = remaining.sub(covered);
      const coveredCost = Decimal.from(l.hourlyUnitRate!).mul(covered);
      l.hourly = money(Decimal.from(l.hourly.amount).sub(coveredCost), s.currency);
      l.note = `${covered.toString()} ${l.quantityUnit} covered by commitment ${c.id}`;
      if (l.discount) {
        l.discount.hourly = money(Decimal.from(l.hourly.amount).mul(Decimal.from(l.discount.percent).div(100)).neg(), s.currency);
      }
    }
  }

  let floor = Decimal.ZERO;
  let workload = Decimal.ZERO;
  for (const l of lines) {
    if (l.status !== 'priced' || !l.hourly) continue;
    const net = Decimal.from(l.hourly.amount).add(l.discount ? l.discount.hourly.amount : '0');
    if (l.basis === 'floor') floor = floor.add(net);
    else workload = workload.add(net);
  }
  floor = floor.add(commitmentHourly);
  const hourly = floor.add(workload);
  const runHours = s.runtime.warmupHours + s.runtime.activeHours + s.runtime.teardownHours;
  return {
    footprint: name,
    lines,
    hourly: money(hourly, s.currency),
    hourlyFloor: money(floor, s.currency),
    hourlyWorkload: money(workload, s.currency),
    runHours,
    runPeriod: money(hourly.mul(hoursDec(runHours)), s.currency),
    monthlyHours: s.monthlyHours,
    monthly: money(hourly.mul(hoursDec(s.monthlyHours)), s.currency),
    commitmentHourly: money(commitmentHourly, s.currency),
    gpus,
    vcpus,
  };
}

function discountMatches(d: DiscountRule, component: ChargeComponent, platform: string | undefined, capacityType: CapacityType): boolean {
  const a = d.appliesTo;
  if (a.components?.length && !a.components.includes(component)) return false;
  if (a.platforms?.length && (!platform || !a.platforms.includes(platform))) return false;
  if (a.capacityTypes?.length && !a.capacityTypes.includes(capacityType)) return false;
  return true;
}

/* ------------------------------------------------------------ quote export */

type FootprintTotal = 'hourly' | 'hourlyFloor' | 'hourlyWorkload' | 'runPeriod' | 'monthly' | 'commitmentHourly';
const FOOTPRINT_TOTALS: readonly FootprintTotal[] = ['hourly', 'hourlyFloor', 'hourlyWorkload', 'runPeriod', 'monthly', 'commitmentHourly'];

export type QuoteFootprint = Omit<FootprintEstimate, FootprintTotal> & { [K in FootprintTotal]: Money | null } & { totalsWithheld?: string };

export interface QuoteDocument extends Omit<ScenarioEstimate, 'footprints' | 'sensitivity'> {
  footprints: QuoteFootprint[];
  sensitivity: { activeHours: number; runPeriod: Record<'min' | 'expected' | 'max', Money | null> }[];
}

/**
 * The downloadable draft quote (quote.json, W1-P9 #50): the estimate with each footprint's headline, and no totals for
 * a footprint with an unpriced GPU, vCPU or RAM line. A sum of the priced lines alone (a boot disk without its GPU)
 * would read as the price; its lines stay, so what was priced and what was not is still in the quote.
 */
export function quoteDocument(e: ScenarioEstimate): QuoteDocument {
  const withheld = new Set(e.footprints.filter(f => f.headline.state === 'incomplete').map(f => f.footprint));
  return {
    ...e,
    footprints: e.footprints.map(f =>
      withheld.has(f.footprint)
        ? { ...f, ...(Object.fromEntries(FOOTPRINT_TOTALS.map(k => [k, null])) as Record<FootprintTotal, null>), totalsWithheld: f.headline.text }
        : f,
    ),
    sensitivity: e.sensitivity.map(s => ({
      activeHours: s.activeHours,
      runPeriod: Object.fromEntries(Object.entries(s.runPeriod).map(([k, v]) => [k, withheld.has(k as FootprintEstimate['footprint']) ? null : v])) as Record<'min' | 'expected' | 'max', Money | null>,
    })),
  };
}

export function quoteToCsvRows(e: ScenarioEstimate): { header: string[]; rows: (string | number)[][] } {
  const header = ['footprint', 'node_group', 'component', 'description', 'quantity', 'unit', 'hourly_unit_rate', 'hourly', 'discount_hourly', 'basis', 'status', 'rate_id', 'currency'];
  const rows = e.footprints.flatMap(f =>
    f.lines.map(l => [
      f.footprint, l.nodeGroup ?? '', l.component, l.description, l.quantity, l.quantityUnit,
      l.hourlyUnitRate ?? '', l.hourly?.amount ?? '', l.discount?.hourly.amount ?? '', l.basis, l.status, l.rateId ?? '', e.currency,
    ]),
  );
  return { header, rows };
}

/* ------------------------------------------------- run-rate from inventory */

export interface RunRateResult {
  rateBook: { id: string; name: string; kind: RateBookKind };
  asOf: string;
  hourly: Money[];
  pricedResources: number;
  unpricedResources: { uid: string; name: string; reason: string }[];
  excluded: number;
  variablePrice: boolean;
  note: string;
}

interface RunRateResource {
  uid: string;
  name: string;
  type: string;
  status: string;
  region?: string;
  spec: { platform?: string; preset?: string; sizeGib?: number; capacityType?: string; diskType?: string };
  observedAt?: string;
  source?: { connector: string };
}

/**
 * Estimated hourly run-rate of what the inventory shows running, priced with
 * one rate book. Resources whose rate is missing, expired or in another
 * currency are listed, never priced at zero. Stopped VMs contribute nothing
 * for compute (their disks still count). This is an estimate from list or
 * negotiated rates, not billed cost. `inventoryReadAt`: when the latest inventory sync read the cloud; a resource
 * last read before it is listed as unpriced with its last-seen time, never priced (it may be gone).
 */
export function estimateRunRate(resources: RunRateResource[], book: RateBook, asOf: string, opts: { inventoryReadAt?: string } = {}): RunRateResult {
  const totals = new Map<string, Decimal>();
  const unpriced: RunRateResult['unpricedResources'] = [];
  let priced = 0;
  let excluded = 0;
  const flags = { variablePrice: false };
  const add = (amount: Decimal, currency: string) => totals.set(currency, (totals.get(currency) ?? Decimal.ZERO).add(amount));

  for (const r of resources) {
    const region = r.region;
    if (r.type === 'compute-instance') {
      if (r.status !== 'running') {
        excluded++;
        continue;
      }
      const seen = lastSeenBefore(r, opts.inventoryReadAt);
      if (seen) {
        unpriced.push({ uid: r.uid, name: r.name, reason: lastSeenReason(seen) });
        continue;
      }
      const shape = r.spec.preset ? parsePreset(r.spec.preset) : undefined;
      if (!region || !shape || !r.spec.platform) {
        unpriced.push({ uid: r.uid, name: r.name, reason: 'region, platform or preset unknown' });
        continue;
      }
      const cap: CapacityType = r.spec.capacityType === 'preemptible' ? 'preemptible' : r.spec.capacityType === 'reserved' ? 'reserved' : 'on-demand';
      const lines: { component: ChargeComponent; qty: number }[] = [];
      let bundled: ChargeComponent[] = [];
      let failed: string | undefined;
      let sum = Decimal.ZERO;
      let currency: string | undefined;
      const price = (component: ChargeComponent, qty: number) => {
        const f = findRate(book, { region, component, platform: r.spec.platform, preset: r.spec.preset, capacityType: cap }, asOf);
        if (!f.rate) {
          failed = `${f.status === 'expired' ? 'expired' : 'no'} ${component} rate for ${r.spec.platform} (${cap}) in ${region}`;
          return undefined;
        }
        if (currency && f.rate.currency !== currency) {
          failed = 'rates in more than one currency';
          return undefined;
        }
        currency = f.rate.currency;
        if (f.rate.priceSemantics === 'variable') flags.variablePrice = true;
        sum = sum.add(toHourly(f.rate.price, f.rate.unit.per as RatePeriod).mul(qty));
        return f.rate;
      };
      if (shape.gpus > 0) bundled = price('gpu', shape.gpus)?.bundles ?? [];
      if (!failed) lines.push({ component: 'vcpu', qty: shape.vcpus }, { component: 'ram', qty: shape.ramGib });
      for (const l of lines) if (!failed && !bundled.includes(l.component)) price(l.component, l.qty);
      if (failed || !currency) {
        unpriced.push({ uid: r.uid, name: r.name, reason: failed ?? 'no rate' });
        continue;
      }
      add(sum, currency);
      priced++;
    } else if (r.type === 'compute-disk' || r.type === 'compute-filesystem') {
      const seen = lastSeenBefore(r, opts.inventoryReadAt);
      if (seen) {
        unpriced.push({ uid: r.uid, name: r.name, reason: lastSeenReason(seen) });
        continue;
      }
      const gib = r.spec.sizeGib;
      if (!region || gib === undefined) {
        unpriced.push({ uid: r.uid, name: r.name, reason: 'region or size unknown' });
        continue;
      }
      const component: ChargeComponent = r.type === 'compute-filesystem' ? 'filesystem' : r.spec.diskType === 'NETWORK_SSD_IO_M3' ? 'disk-io-m3' : 'disk-ssd';
      const f = findRate(book, { region, component, capacityType: 'on-demand' }, asOf);
      // boot disks are disks too; fall back to the boot-disk rate only when no disk rate exists
      const g = f.rate || r.type === 'compute-filesystem' ? f : findRate(book, { region, component: 'boot-disk', capacityType: 'on-demand' }, asOf);
      if (!g.rate) {
        unpriced.push({ uid: r.uid, name: r.name, reason: `${f.status === 'expired' ? 'expired' : 'no'} ${component} rate in ${region}` });
        continue;
      }
      add(toHourly(g.rate.price, g.rate.unit.per as RatePeriod).mul(gib), g.rate.currency);
      priced++;
    } else if (r.type === 'postgresql-cluster' || r.type === 'mlflow-cluster') {
      // Counted as the live run-rate counts them (W1-P10): running managed services are named without a rate, never
      // left out, so the two tiles count the same resources.
      if (r.status !== 'running') {
        excluded++;
        continue;
      }
      unpriced.push({
        uid: r.uid,
        name: r.name,
        reason: r.type === 'postgresql-cluster' ? 'managed PostgreSQL: a rate book has no managed-service rate (the live run-rate prices it)' : 'managed MLflow: a rate book has no managed-service rate',
      });
    }
  }
  return {
    rateBook: { id: book.id, name: book.name, kind: book.kind },
    asOf,
    hourly: [...totals.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([c, d]) => money(d, c)),
    pricedResources: priced,
    unpricedResources: unpriced,
    excluded,
    variablePrice: flags.variablePrice,
    note: 'Estimated run-rate of running compute and provisioned storage at the rate book’s rates. Not billed cost; network, IPs and Object Storage are not included; managed PostgreSQL and MLflow are listed without a rate.',
  };
}
