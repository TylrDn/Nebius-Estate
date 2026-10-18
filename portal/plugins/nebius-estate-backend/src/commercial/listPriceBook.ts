import { Footprint, LIVE_LIST_BOOK_ID, LIVE_LIST_BOOK_NAME, ListPriceItem, listPriceBook, RateBook } from '@internal/nebius-domain';
import { EstateConfig } from '../lib/config';
import { inScope, ProjectScope } from '../lib/access';
import { InventoryService } from '../inventory/InventoryService';
import { CalculatorLine, diskSpec, filesystemSpec, instanceSpec } from './calculator';

/**
 * Storage priced per GiB from one calculator answer each. Sizes the docs allow for every type: Network SSD takes
 * 1–8192 GiB, IO_M3 multiples of 93 GiB (docs compute/storage/types, disk types comparison); the filesystem is a
 * Network SSD filesystem of the same 100 GiB.
 */
const STORAGE: { component: 'boot-disk' | 'disk-ssd' | 'disk-io-m3' | 'filesystem'; gib: number; spec: (project: string) => Record<string, unknown> }[] = [
  { component: 'boot-disk', gib: 100, spec: p => diskSpec(p, 'NETWORK_SSD', 100) },
  { component: 'disk-ssd', gib: 100, spec: p => diskSpec(p, 'NETWORK_SSD', 100) },
  { component: 'disk-io-m3', gib: 93, spec: p => diskSpec(p, 'NETWORK_SSD_IO_M3', 93) },
  { component: 'filesystem', gib: 100, spec: p => filesystemSpec(p, 'NETWORK_SSD', 100) },
];

export interface ListPriceRequest {
  id: string;
  name: string;
  /** Per region, the (platform, preset) pairs to price, each on-demand and preemptible unless `capacity` says. */
  regions: { region: string; presets: { platform: string; preset: string }[] }[];
  capacity?: ('on-demand' | 'preemptible')[];
}

/**
 * A rate book from the Nebius billing calculator's current list prices (W1-P6, W1-P7): every VM preset asked for
 * and the storage specs, priced in a listed project of each region (the project fixes the region). Prices nothing
 * in a region without a listed project, and names every spec the calculator did not price.
 */
export async function buildListPriceBook(inventory: InventoryService, cfg: EstateConfig, req: ListPriceRequest, scope: ProjectScope): Promise<{ book: RateBook; skipped: string[] }> {
  const calc = inventory.calculator();
  if (!calc) throw new Error('Live list prices need the Nebius connector: projects and a read-only identity (docs/portal/nebius-setup.md).');
  const snap = inventory.snapshot();
  const projectName = (id: string) => snap.resources.find(r => r.type === 'project' && r.providerId === id)?.name ?? id;
  const items: ListPriceItem[] = [];
  const skipped: string[] = [];
  const projects: string[] = [];
  const capacity = req.capacity ?? ['on-demand', 'preemptible'];
  let asOf = inventory.now().toISOString();
  for (const { region, presets } of req.regions) {
    const project = scope.all
      ? inventory.pricingProject(region)
      : snap.resources.find(r => r.type === 'project' && r.region === region && inScope(scope, r.providerId))?.providerId;
    const projectRegion = snap.resources.find(r => r.type === 'project' && r.providerId === project)?.region;
    if (!project || projectRegion !== region) {
      skipped.push(`${region}: no listed project${scope.all ? '' : ' in your authorized scope'} in this region (the calculator prices in a project's region)`);
      continue;
    }
    projects.push(projectName(project));
    // Each line carries the item it prices; its hourly price is filled from the calculator's answer.
    const lines: (CalculatorLine & { item: ListPriceItem })[] = [];
    for (const { platform, preset } of presets) {
      for (const cap of capacity) {
        lines.push({ key: `vm:${platform}:${preset}:${cap}`, description: `${region} ${platform} · ${preset} · ${cap}`, count: 1, spec: instanceSpec(project, platform, preset, cap === 'preemptible'), item: { kind: 'instance', region, platform, preset, capacityType: cap, hourly: '0' } });
      }
    }
    for (const s of STORAGE) lines.push({ key: `st:${s.component}`, description: `${region} ${s.component} ${s.gib} GiB`, count: 1, spec: s.spec(project), item: { kind: 'storage', region, component: s.component, gib: s.gib, hourly: '0' } });
    const est = await calc.estimate(lines, project, [], false);
    asOf = est.asOf;
    for (const l of lines) {
      const priced = est.lines.find(x => x.key === l.key);
      if (priced?.hourly) items.push({ ...l.item, hourly: priced.hourly.amount });
    }
    skipped.push(...est.unpriced.map(u => `${region}: ${u}`));
  }
  const currency = (cfg.nebius?.pricing.currency ?? 'usd').toUpperCase();
  const source = `Nebius billing calculator (list price)${projects.length ? `, project${projects.length === 1 ? '' : 's'} ${projects.join(', ')}` : ''}`;
  return { book: listPriceBook({ id: req.id, name: req.name, currency, retrievedAt: asOf, source, items }), skipped };
}

/**
 * The built-in price source for one estimate (W1-P6): the footprints' presets and the storage specs at the calculator's
 * list price in `region`, built per estimate (the calculator caches per spec), never stored. Throws when the calculator
 * cannot price in that region. A reservation's own price is not read: reserved compute stays a pricing gap.
 */
export async function liveListBook(inventory: InventoryService, cfg: EstateConfig, region: string, footprints: Footprint[], capacityType: string, scope: ProjectScope): Promise<RateBook> {
  const presets = new Map<string, { platform: string; preset: string }>();
  for (const fp of footprints) for (const g of fp.nodeGroups) presets.set(`${g.platform}|${g.preset}`, { platform: g.platform, preset: g.preset });
  const r = await buildListPriceBook(inventory, cfg, { id: LIVE_LIST_BOOK_ID, name: LIVE_LIST_BOOK_NAME, regions: [{ region, presets: [...presets.values()] }], capacity: capacityType === 'preemptible' ? ['on-demand', 'preemptible'] : ['on-demand'] }, scope);
  if (r.skipped.some(x => x.includes('no listed project'))) throw new Error(r.skipped[0]);
  return r.book;
}
