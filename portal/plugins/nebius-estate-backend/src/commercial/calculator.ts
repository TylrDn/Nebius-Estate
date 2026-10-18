import { CapabilityState, Decimal, Footprint, lastSeenBefore, lastSeenReason, LivePriceEstimate, LivePriceLine, ObservedResource } from '@internal/nebius-domain';
import { HttpClient, redact } from '../lib/http';
import { LruTtlCache } from '../lib/limits';
import { classify } from '../inventory/contract';
import { NEBIUS_API } from '../inventory/endpoints';

type Json = Record<string, any>;

export const CALCULATOR_PATH = '/billing/v1/calculator/estimate-batch';

/**
 * Live list prices from the Nebius billing calculator
 * (POST /billing/v1/calculator/estimate-batch, nebius.billing.v1.EstimateBatchRequest).
 * The call prices a would-be create request; it creates nothing, and it is the
 * only POST the portal makes to the Nebius API. Results are cached per spec
 * and project (the project fixes the region) for `ttlMs`, in an LRU of at most
 * `cacheMax` entries (default CALCULATOR_CACHE_MAX).
 *
 * Contract prices need resource.billinggroup.get on the billing group; when
 * that is refused the list price is used and the estimate says so.
 */

export interface CalculatorLine {
  key: string;
  description: string;
  count: number;
  /** A google.protobuf.Any create request (with "@type"). */
  spec: Json;
  note?: string;
  /** A VM line's capacity type (F1.41). */
  capacityType?: 'preemptible' | 'on-demand';
}

export const instanceSpec = (project: string, platform: string, preset: string, preemptible: boolean): Json => ({
  '@type': 'type.googleapis.com/nebius.compute.v1.CreateInstanceRequest',
  metadata: { parentId: project, name: 'estimate' },
  spec: { resources: { platform, preset }, bootDisk: { attachMode: 'READ_WRITE' }, ...(preemptible ? { preemptible: { onPreemption: 'STOP' } } : {}) },
});
export const diskSpec = (project: string, type: string, gib: number): Json => ({
  '@type': 'type.googleapis.com/nebius.compute.v1.CreateDiskRequest',
  metadata: { parentId: project, name: 'estimate' },
  spec: { type, sizeGibibytes: String(Math.ceil(gib)) },
});
export const filesystemSpec = (project: string, type: string, gib: number): Json => ({
  '@type': 'type.googleapis.com/nebius.compute.v1.CreateFilesystemRequest',
  metadata: { parentId: project, name: 'estimate' },
  spec: { type, sizeGibibytes: String(Math.ceil(gib)) },
});

const postgresSpec = (project: string, r: ObservedResource): Json => ({
  '@type': 'type.googleapis.com/nebius.msp.postgresql.v1alpha1.CreateClusterRequest',
  metadata: { parentId: project, name: 'estimate' },
  spec: { config: { template: { resources: { platform: r.spec.platform, preset: r.spec.preset }, disk: { type: r.spec.diskType ?? 'network-ssd', sizeGibibytes: String(Math.ceil(r.spec.sizeGib ?? 0)) }, hosts: { count: String(r.spec.fixedNodeCount ?? 1) } } } },
});

/** Why a running managed MLflow cluster has no live price: the calculator fails on its create request. */
export const MLFLOW_UNPRICED = 'the billing calculator does not price MLflow clusters (HTTP 500 for a MLflow create request, 2026-10-11); see the MLflow pricing page';

const STORAGE_NOTE = 'Disk and filesystem specs are priced through their documented create requests (verified live for VMs only).';

/** A scenario or provisioning footprint as calculator lines (VMs, boot disks, storage). */
export function footprintLines(fp: Footprint, project: string, preemptible: boolean): { lines: CalculatorLine[]; unpriced: string[] } {
  const lines: CalculatorLine[] = [];
  for (const g of fp.nodeGroups.filter(x => x.count > 0)) {
    const capacityType = preemptible && g.role !== 'system' ? 'preemptible' : 'on-demand';
    lines.push({ key: `vm:${g.name}`, description: `${g.name}: ${g.platform} · ${g.preset} · ${capacityType}`, count: g.count, spec: instanceSpec(project, g.platform, g.preset, capacityType === 'preemptible'), capacityType });
    if (g.bootDiskGib > 0) lines.push({ key: `boot:${g.name}`, description: `${g.name} boot disk ${g.bootDiskGib} GiB`, count: g.count, spec: diskSpec(project, 'NETWORK_SSD', g.bootDiskGib), note: STORAGE_NOTE });
  }
  if (fp.filesystemGib > 0) lines.push({ key: 'fs', description: `Shared filesystem ${fp.filesystemGib} GiB`, count: 1, spec: filesystemSpec(project, 'NETWORK_SSD', fp.filesystemGib), note: STORAGE_NOTE });
  if (fp.extraSsdGib > 0) lines.push({ key: 'ssd', description: `Network SSD ${fp.extraSsdGib} GiB`, count: 1, spec: diskSpec(project, 'NETWORK_SSD', fp.extraSsdGib), note: STORAGE_NOTE });
  if (fp.ioM3Gib > 0) lines.push({ key: 'io', description: `IO_M3 ${fp.ioM3Gib} GiB`, count: 1, spec: diskSpec(project, 'NETWORK_SSD_IO_M3', fp.ioM3Gib), note: STORAGE_NOTE });
  const unpriced: string[] = [];
  if (fp.objectStorageGib > 0) unpriced.push('Object Storage (usage-based; not priced per hour)');
  if (fp.publicIps > 0) unpriced.push('Public IPs (not priced through the calculator here)');
  return { lines, unpriced };
}

/**
 * Running VMs, their disks and filesystems, and running Managed PostgreSQL clusters from the inventory,
 * grouped into calculator lines per project; with what is running but cannot be priced, and why.
 */
/** What the live run-rate prices (or names as unpriced), by resource type. */
const PRICED_TYPES: Partial<Record<ObservedResource['type'], string>> = {
  'compute-instance': 'VM',
  'compute-disk': 'Disk',
  'compute-filesystem': 'Filesystem',
  'postgresql-cluster': 'Managed PostgreSQL',
  'mlflow-cluster': 'Managed MLflow',
};

export function inventoryLines(resources: ObservedResource[], inventoryReadAt?: string): { lines: Map<string, CalculatorLine[]>; unpriced: Map<string, string[]> } {
  const byProject = new Map<string, Map<string, CalculatorLine>>();
  const unpriced = new Map<string, string[]>();
  const skip = (project: string, why: string) => unpriced.set(project, [...(unpriced.get(project) ?? []), why]);
  const add = (project: string, key: string, make: () => CalculatorLine) => {
    const m = byProject.get(project) ?? new Map<string, CalculatorLine>();
    const existing = m.get(key);
    if (existing) existing.count++;
    else m.set(key, make());
    byProject.set(project, m);
  };
  for (const r of resources) {
    if (!r.projectId) continue;
    // Last read before the latest inventory sync (its list was not read or failed then): it may be gone, so it is
    // named with its last-seen time and never priced (followup 23: a deleted PostgreSQL cluster stayed priced).
    const storage = r.type === 'compute-disk' || r.type === 'compute-filesystem';
    const seen = PRICED_TYPES[r.type] && (storage || r.status === 'running') ? lastSeenBefore(r, inventoryReadAt) : undefined;
    if (seen) {
      skip(r.projectId, `${PRICED_TYPES[r.type]} ${r.name}: ${lastSeenReason(seen)}; not priced`);
      continue;
    }
    if (r.type === 'compute-instance' && r.status === 'running' && r.spec.platform && r.spec.preset) {
      const pre = r.spec.capacityType === 'preemptible';
      add(r.projectId, `vm:${r.spec.platform}:${r.spec.preset}:${pre}`, () => ({ key: `vm:${r.spec.platform}:${r.spec.preset}:${pre}`, description: `${r.spec.platform} · ${r.spec.preset}${pre ? ' (preemptible)' : ''}`, count: 1, spec: instanceSpec(r.projectId!, r.spec.platform!, r.spec.preset!, pre) }));
    }
    if (storage && !r.spec.sizeGib) skip(r.projectId, `${PRICED_TYPES[r.type]} ${r.name}: the API answer has no size to price`);
    if (storage && r.spec.sizeGib) {
      const type = r.spec.diskType ?? 'NETWORK_SSD';
      const key = `${r.type}:${type}:${r.spec.sizeGib}`;
      add(r.projectId, key, () => ({ key, description: `${r.type === 'compute-disk' ? 'Disk' : 'Filesystem'} ${type} ${r.spec.sizeGib} GiB`, count: 1, spec: r.type === 'compute-disk' ? diskSpec(r.projectId!, type, r.spec.sizeGib!) : filesystemSpec(r.projectId!, type, r.spec.sizeGib!), note: STORAGE_NOTE }));
    }
    if (r.type === 'postgresql-cluster' && r.status === 'running') {
      if (r.spec.platform && r.spec.preset && r.spec.sizeGib) {
        const hosts = r.spec.fixedNodeCount ?? 1;
        const key = `pg:${r.spec.platform}:${r.spec.preset}:${r.spec.diskType ?? 'network-ssd'}:${r.spec.sizeGib}:${hosts}`;
        add(r.projectId, key, () => ({ key, description: `Managed PostgreSQL ${r.spec.platform} · ${r.spec.preset}, ${r.spec.sizeGib} GiB, ${hosts} host${hosts === 1 ? '' : 's'}`, count: 1, spec: postgresSpec(r.projectId!, r) }));
      } else skip(r.projectId, `Managed PostgreSQL ${r.name}: the API answer has no resource template to price`);
    }
    if (r.type === 'mlflow-cluster' && r.status === 'running') skip(r.projectId, `Managed MLflow ${r.name}: ${MLFLOW_UNPRICED}`);
  }
  return { lines: new Map([...byProject.entries()].map(([p, m]) => [p, [...m.values()]])), unpriced };
}

interface PricedSpec {
  hourly: string | null;
  unit?: string;
  skus: LivePriceLine['skus'];
}

export interface CalculatorStatus {
  state: CapabilityState;
  lastAttempt?: string;
  lastSuccess?: string;
  lastError?: string;
  contractState?: CapabilityState;
}

/** Upper bound on cached calculator answers (one per offer × spec). */
export const CALCULATOR_CACHE_MAX = 2000;

export class NebiusCalculator {
  private readonly cache: LruTtlCache<string, PricedSpec>;
  /** Lookups in flight by cache key: parallel requests for the same spec share one call (single-flight). */
  private readonly inFlight = new Map<string, Promise<PricedSpec>>();
  readonly status: CalculatorStatus = { state: 'not-configured' };

  constructor(
    private readonly http: HttpClient,
    private readonly opts: { currency: string; ttlMs: number; base?: string; now?: () => Date; cacheMax?: number },
  ) {
    this.cache = new LruTtlCache({ max: opts.cacheMax ?? CALCULATOR_CACHE_MAX, ttlMs: opts.ttlMs });
  }

  get cacheSize(): number {
    return this.cache.size;
  }

  /** One spec at one offer: from the cache, from a lookup already in flight, or from a new call. */
  private price(line: CalculatorLine, offer: 'list' | 'contract'): Promise<PricedSpec> {
    const key = `${offer}|${JSON.stringify(line.spec)}`;
    const hit = this.cache.get(key);
    if (hit) return Promise.resolve(hit);
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    const call = this.fetchPrice(line, offer, key).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, call);
    return call;
  }

  private async fetchPrice(line: CalculatorLine, offer: 'list' | 'contract', key: string): Promise<PricedSpec> {
    const body: Json = { currency: this.opts.currency, resourceSpecs: [{ spec: line.spec }], ...(offer === 'contract' ? { offerTypes: ['OFFER_TYPE_CONTRACT_PRICE'] } : {}) };
    const res = await this.http.request<Json>(`${this.opts.base ?? NEBIUS_API}${CALCULATOR_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const cost = (res?.resourceCosts ?? [])[0] ?? {};
    const unit = cost.aggregationUnit ?? {};
    const timeBased = unit.unitType === 'UNIT_TYPE_TIME_BASED' && unit.unit === 'hour';
    const total = cost.general?.total ?? cost.fixedInstance?.perInstance;
    const value: PricedSpec = {
      hourly: timeBased && typeof total?.cost === 'string' && Decimal.isValid(total.cost) ? total.cost : null,
      unit: unit.unit ? String(unit.unit) : undefined,
      skus: ((total?.skuCosts ?? []) as Json[]).map(s => ({ skuId: String(s.skuId ?? ''), quantity: String(s.quantity ?? ''), cost: String(s.cost ?? '') })),
    };
    this.cache.set(key, value);
    return value;
  }

  /**
   * Prices lines at list price (default) or tries the contract price first.
   * Throws only when the calculator itself is unusable (refused, unreachable).
   */
  async estimate(lines: CalculatorLine[], project: string, unpriced: string[], wantContract = false): Promise<LivePriceEstimate> {
    const at = (this.opts.now?.() ?? new Date()).toISOString();
    this.status.lastAttempt = at;
    let offer: 'list' | 'contract' = wantContract ? 'contract' : 'list';
    let contractNote: string | undefined;
    const out: LivePriceLine[] = [];
    const missing = [...unpriced];
    let total = Decimal.ZERO;
    let anyHourly = false;
    let listTotal: LivePriceEstimate['listHourly'];
    // A footprint's lines are priced together; the HTTP client's per-host limit still bounds concurrency.
    const settle = (o: 'list' | 'contract') =>
      Promise.all(lines.map(l => this.price(l, o).then(p => ({ p, e: undefined as unknown }), (e: unknown) => ({ p: undefined, e }))));
    try {
      let results = await settle(offer);
      if (offer === 'contract' && results.some(r => r.e !== undefined && classify(r.e).state === 'permission-denied')) {
        offer = 'list';
        this.status.contractState = 'permission-denied';
        contractNote = 'Contract prices need resource.billinggroup.get on the billing group: list prices shown.';
        results = await settle('list');
      }
      lines.forEach((l, i) => {
        const { p, e } = results[i];
        if (!p) {
          const c = classify(e);
          if (c.state === 'rejected' || c.state === 'not-found') {
            missing.push(`${l.description} (calculator: ${redact((e as Error).message).slice(0, 140)})`);
            return;
          }
          throw e;
        }
        const hourly = p.hourly === null ? null : Decimal.from(p.hourly).mul(Decimal.from(String(l.count)));
        if (hourly === null) missing.push(`${l.description} (${p.unit ? `priced per ${p.unit}` : 'usage-based'})`);
        else {
          total = total.add(hourly);
          anyHourly = true;
        }
        out.push({ key: l.key, description: l.description, count: l.count, hourly: hourly === null ? null : { amount: hourly.toString(), currency: this.opts.currency.toUpperCase() }, unit: p.unit, skus: p.skus, note: l.note, ...(l.capacityType ? { capacityType: l.capacityType } : {}) });
      });
      if (offer === 'contract') {
        this.status.contractState = 'ok';
        // The list price next to the contract price, so a reader can see whether they differ.
        const priced = lines.filter(l => out.find(o => o.key === l.key)?.hourly);
        const lists = await Promise.all(priced.map(l => this.price(l, 'list')));
        let list = Decimal.ZERO;
        priced.forEach((l, i) => {
          const p = lists[i];
          if (p.hourly === null) return;
          const lh = Decimal.from(p.hourly).mul(Decimal.from(String(l.count)));
          out.find(o => o.key === l.key)!.listHourly = { amount: lh.toString(), currency: this.opts.currency.toUpperCase() };
          list = list.add(lh);
        });
        listTotal = anyHourly ? { amount: list.toString(), currency: this.opts.currency.toUpperCase() } : null;
      }
      this.status.state = 'ok';
      this.status.lastSuccess = at;
      this.status.lastError = undefined;
    } catch (e) {
      this.status.state = classify(e).state;
      this.status.lastError = redact((e as Error).message);
      throw e;
    }
    return {
      source: offer === 'contract' ? 'Nebius billing calculator (contract price)' : 'Nebius billing calculator (list price)',
      offer,
      asOf: at,
      currency: this.opts.currency.toUpperCase(),
      projectId: project,
      lines: out,
      hourly: anyHourly ? { amount: total.toString(), currency: this.opts.currency.toUpperCase() } : null,
      contractNote,
      contract: { attempted: wantContract, available: wantContract ? offer === 'contract' : null },
      listHourly: listTotal,
      unpriced: missing,
    };
  }
}
