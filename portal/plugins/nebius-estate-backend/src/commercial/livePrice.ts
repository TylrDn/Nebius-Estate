import { Decimal, Footprint, footprintIsEmpty, LivePriceEstimate, LivePriceResponse, ObservedResource } from '@internal/nebius-domain';
import { redact } from '../lib/http';
import { EstateConfig } from '../lib/config';
import { inScope, ProjectScope } from '../lib/access';
import { classify } from '../inventory/contract';
import { InventoryService } from '../inventory/InventoryService';
import { footprintLines, inventoryLines } from './calculator';
import { readTime } from '../views';

/** The inventory lists the run-rate prices from: "nothing running" is as of their read. */
const PRICED_LISTS = ['compute.instances', 'compute.disks', 'compute.filesystems', 'msp.postgresql', 'msp.mlflow'];

const NOT_CONFIGURED = 'Live list prices need the Nebius connector: projects and a read-only identity (docs/portal/nebius-setup.md).';

const failure = (e: unknown): LivePriceResponse => ({ value: null, unavailableReason: `Billing calculator ${classify(e).state}: ${redact((e as Error).message).slice(0, 200)}` });

/**
 * The capacity type a footprint is priced as, in words (F1.41): preemptible applies to GPU node groups only (system
 * nodes stay on-demand), and a reservation is priced at the on-demand price (its own price is not read here).
 */
export function capacityText(type: 'preemptible' | 'on-demand' | 'reserved', lines: { capacityType?: 'preemptible' | 'on-demand' }[]): string {
  if (type === 'reserved') return 'reserved, priced at the on-demand price (a reservation\'s own price is not read here)';
  const types = new Set(lines.map(l => l.capacityType).filter(Boolean));
  return types.size > 1 ? 'preemptible GPU nodes, on-demand system nodes' : [...types][0] ?? type;
}

/** A footprint at Nebius list price, in a listed project of the requested region. */
export async function livePrice(
  inventory: InventoryService,
  cfg: EstateConfig,
  fp: Footprint,
  region: string | undefined,
  capacityType: 'preemptible' | 'on-demand' | 'reserved' = 'on-demand',
  scope: ProjectScope,
): Promise<LivePriceResponse> {
  const preemptible = capacityType === 'preemptible';
  const calc = inventory.calculator();
  if (!calc) return { value: null, unavailableReason: NOT_CONFIGURED };
  // Nothing asked for costs 0: no calculator call, and no "unavailable" for a scenario's empty minimum (F1.18).
  if (footprintIsEmpty(fp)) {
    return { value: null, unavailableReason: 'Empty footprint: nothing to price.', emptyFootprint: { currency: (cfg.nebius?.pricing.currency ?? 'usd').toUpperCase() } };
  }
  // Contract prices belong to the selected project: hypothetical footprints must use a project the caller may price.
  const project = !scope.all
    ? inventory.snapshot().resources.find(r => r.type === 'project' && inScope(scope, r.providerId) && (!region || r.region === region))?.providerId
    : inventory.pricingProject(region);
  if (!project && !scope.all) {
    return { value: null, unavailableReason: `No authorized project${region ? ` in ${region}` : ''} is available in your pricing scope.` };
  }
  const projectRegion = inventory.snapshot().resources.find(r => r.type === 'project' && r.providerId === project)?.region;
  if (!project) return { value: null, unavailableReason: NOT_CONFIGURED };
  if (region && projectRegion && projectRegion !== region) {
    const regions = [...new Set(inventory.snapshot().resources.filter(r => r.type === 'project' && r.region).map(r => r.region as string))].sort();
    return { value: null, unavailableReason: `No listed project is in ${region}: the calculator prices in a project's region (projects are in: ${regions.join(', ')}).` };
  }
  const { lines, unpriced } = footprintLines(fp, project, preemptible);
  try {
    const value = await calc.estimate(lines, project, unpriced, cfg.nebius?.pricing.tryContractPrice);
    return { value: { ...value, capacity: { type: capacityType, text: capacityText(capacityType, lines) } } };
  } catch (e) {
    return failure(e);
  }
}

/** What the running inventory in scope costs per hour at list price, project by project. */
export async function liveRunRate(inventory: InventoryService, cfg: EstateConfig, resources: ObservedResource[]): Promise<LivePriceResponse> {
  const calc = inventory.calculator();
  if (!calc) return { value: null, unavailableReason: NOT_CONFIGURED };
  const { lines: perProject, unpriced } = inventoryLines(resources, inventory.snapshot().inventoryReadAt);
  // A project whose running resources are all unpriceable still gets an estimate that says so.
  for (const p of unpriced.keys()) if (!perProject.has(p)) perProject.set(p, []);
  if (!perProject.size) {
    // Nothing to price is a zero only once the inventory has answered; before that it is unknown.
    const snap = inventory.snapshot();
    const synced = snap.statuses.some(s => s.id === 'nebius-inventory' && Boolean(s.lastSuccess));
    const observedAt = synced ? readTime(snap, PRICED_LISTS).observedAt : undefined;
    return {
      value: null,
      unavailableReason: 'No running VMs, disks, filesystems or managed databases in scope to price.',
      ...(synced ? { nothingRunning: { currency: (cfg.nebius?.pricing.currency ?? 'usd').toUpperCase() } } : {}),
      ...(observedAt ? { observedAt } : {}),
    };
  }
  const names = new Map(resources.filter(r => r.type === 'project').map(r => [r.providerId, r.name]));
  try {
    const parts: LivePriceEstimate[] = [];
    for (const [project, lines] of perProject) parts.push(await calc.estimate(lines, project, unpriced.get(project) ?? [], cfg.nebius?.pricing.tryContractPrice));
    const currency = parts[0].currency;
    const total = parts.reduce((a, p) => a.add(p.hourly?.amount ?? '0'), Decimal.ZERO);
    return {
      value: {
        ...parts[0],
        projectId: parts.length === 1 ? parts[0].projectId : '',
        // Line keys are unique across projects (the same preset can run in several).
        lines: parts.flatMap(p => p.lines.map(l => ({ ...l, key: `${p.projectId}|${l.key}`, description: parts.length > 1 ? `${names.get(p.projectId) ?? p.projectId}: ${l.description}` : l.description }))),
        hourly: parts.some(p => p.hourly) ? { amount: total.toString(), currency } : null,
        listHourly: parts.every(p => p.offer === 'contract') && parts.some(p => p.listHourly)
          ? { amount: parts.reduce((a, p) => a.add(p.listHourly?.amount ?? '0'), Decimal.ZERO).toString(), currency }
          : undefined,
        contract: { attempted: parts.some(p => p.contract.attempted), available: parts.some(p => p.contract.attempted) ? parts.every(p => p.contract.available) : null },
        unpriced: parts.flatMap(p => p.unpriced),
        offer: parts.every(p => p.offer === 'contract') ? 'contract' : 'list',
        source: parts.every(p => p.offer === 'contract') ? 'Nebius billing calculator (contract price)' : 'Nebius billing calculator (list price)',
      },
    };
  } catch (e) {
    return failure(e);
  }
}
