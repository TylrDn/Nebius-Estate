import { z } from 'zod';
import { Footprint, NodeGroupShape } from './pricing';
import type { ProofDrift, RecipeProof } from './proof';

/**
 * Solutions (S1–S9): customer scenarios that compose several recipes, each in
 * `solutions/S<n>-<slug>/README.md` with `footprint*.json` beside it. Parsers
 * take file text, not paths: the backend decides which files may be read.
 *
 *   solutions/README.md            the index table (scenario, recipes, worked example, headline, status)
 *   solutions/S<n>-…/footprint*.json  what `recipes/finance/price.py` prices; here mapped onto the
 *                                     portal's live-price footprint (POST /pricing/footprint)
 */

/** What a solution without a status of its own says: designed on paper, nothing run live. */
export const SOLUTION_DEFAULT_STATUS = 'design done; live evidence not yet run';

/** Where the repository is published: Mermaid diagrams are drawn there, not in the portal. */
export const REPOSITORY_URL = 'https://github.com/TylrDn/Nebius-Estate';

export function githubBlobUrl(path: string, ref = 'main'): string {
  return `${REPOSITORY_URL}/blob/${ref}/${path.split('/').map(encodeURIComponent).join('/')}`;
}

export interface SolutionRecipeRef {
  id: string;
  /** README of the recipe, relative to the repository root. */
  docs: string;
}

export interface SolutionIndexRow {
  id: string;
  /** `solutions/S<n>-<slug>` */
  dir: string;
  readme: string;
  scenario: string;
  recipes: SolutionRecipeRef[];
  workedExample: string;
  headline: string;
  status: string;
}

export interface SolutionFootprintView {
  /** `solutions/S<n>-…/footprint*.json` */
  path: string;
  name?: string;
  region?: string;
  /** Hours every item runs; absent when items differ (then only per-hour figures are meaningful). */
  runHours?: number;
  /**
   * When items differ in hours: the hours of each live-price line by its calculator key (`vm:<name>`, `ssd`, `io`,
   * `fs`), for a per-run total weighed per line (G5.14). A line merging items of different hours has none.
   */
  lineHours?: Record<string, number>;
  /** Rows to price: on-demand always; preemptible too when a VM is marked `compare` or `true`. */
  capacityTypes: ('on-demand' | 'preemptible')[];
  footprint?: Footprint;
  notes: string[];
  /** Why the file could not be turned into a footprint (shown instead of a Price action). */
  error?: string;
}

export interface SolutionView extends SolutionIndexRow {
  readmeAvailable: boolean;
  footprints: SolutionFootprintView[];
  /** One proof per composed recipe, computed from the evidence index (W1-P11). */
  proof: RecipeProof[];
  /** README proof rows the evidence index contradicts (W1-P12); empty when they agree. */
  proofDrift: ProofDrift[];
}

export interface SolutionsResponse {
  items: SolutionView[];
  /** Set when solutions/README.md is not in the checkout or cannot be read. */
  unavailableReason?: string;
}

/* ------------------------------------------------------------------- index */

const plain = (s: string) =>
  s
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[`*]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** Resolves a link written relative to `from` (a file) into a repository path. */
function resolveRel(from: string, href: string): string {
  const parts = from.split('/').slice(0, -1);
  for (const seg of href.split('#')[0].split('/')) {
    if (seg === '..') parts.pop();
    else if (seg && seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

function cells(line: string): string[] {
  const t = line.trim();
  if (!t.startsWith('|')) return [];
  return t.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
}

/**
 * Rows of the "Index" table in solutions/README.md:
 * `| [S1](S1-…/README.md) | scenario | [R7](…), [R1](…) | worked example | headline | status |`.
 */
export function parseSolutionsIndex(md: string): SolutionIndexRow[] {
  const out: SolutionIndexRow[] = [];
  for (const line of md.split('\n')) {
    const c = cells(line);
    if (c.length < 6) continue;
    const id = /^\[(S\d+)\]\(([^)]+)\)$/.exec(c[0]);
    if (!id) continue;
    const readme = resolveRel('solutions/README.md', id[2]);
    const recipes = [...c[2].matchAll(/\[(R\d+)\]\(([^)]+)\)/g)].map(m => ({ id: m[1], docs: resolveRel('solutions/README.md', m[2]) }));
    out.push({
      id: id[1],
      dir: readme.split('/').slice(0, -1).join('/'),
      readme,
      scenario: plain(c[1]),
      recipes,
      workedExample: plain(c[3]),
      headline: plain(c[4]),
      status: plain(c[5]) || SOLUTION_DEFAULT_STATUS,
    });
  }
  return out;
}

/** The `| Status | … |` row of a solution README's header table. */
export function solutionStatusFromReadme(md: string): string | undefined {
  for (const line of md.split('\n')) {
    const c = cells(line);
    if (c.length >= 2 && c[0] === 'Status') return plain(c[1]) || undefined;
  }
  return undefined;
}

/* -------------------------------------------------------------- footprints */

const size = z.number().positive().max(10_000_000);
const count = z.number().int().min(0).max(512);
const hours = z.number().positive().max(100_000).optional();
const vmItem = z.object({
  name: z.string().min(1).max(60),
  platform: z.string().regex(/^[a-z0-9-]{1,40}$/),
  preset: z.string().regex(/^[a-z0-9-]{1,40}$/),
  count,
  hours,
  preemptible: z.union([z.boolean(), z.literal('compare')]).optional(),
});
const diskItem = z.object({ name: z.string().min(1).max(60), disk_type: z.enum(['NETWORK_SSD', 'NETWORK_SSD_IO_M3', 'NETWORK_SSD_NON_REPLICATED', 'NETWORK_HDD']), size_gib: size, count, hours });
const fsItem = z.object({ name: z.string().min(1).max(60), filesystem_type: z.enum(['NETWORK_SSD', 'NETWORK_HDD']), size_gib: size, count, hours });

export const solutionFootprintFileSchema = z.object({
  name: z.string().min(1).max(120),
  region: z.string().regex(/^[a-z]{2}-[a-z]+\d$/, 'a region id such as eu-north1'),
  hours: hours,
  items: z.array(z.union([vmItem, diskItem, fsItem])).max(64),
});
export type SolutionFootprintFile = z.infer<typeof solutionFootprintFileSchema>;

/**
 * Maps a solution footprint file (the `recipes/finance/price.py` format) onto the portal's live-price
 * footprint. As in price.py, a GPU VM without `preemptible` is compared at spot; a VM marked `false`
 * stays on-demand in the preemptible row. The calculator flow prices every group but `system` at spot
 * in that row, so on-demand-only VMs are given the `system` role here (the role only steers pricing).
 * Disk types other than network SSD and IO_M3 are noted, not priced.
 */
export function parseSolutionFootprint(text: string, path = ''): SolutionFootprintView {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { path, capacityTypes: [], notes: [], error: `not JSON: ${(e as Error).message}` };
  }
  const parsed = solutionFootprintFileSchema.safeParse(raw);
  if (!parsed.success) {
    return { path, capacityTypes: [], notes: [], error: parsed.error.issues.map(i => `${i.path.join('.') || 'file'}: ${i.message}`).join('; ') };
  }
  const file = parsed.data;
  const notes: string[] = [];
  const nodeGroups: NodeGroupShape[] = [];
  let filesystemGib = 0;
  let extraSsdGib = 0;
  let ioM3Gib = 0;
  let spot = false;
  const hoursSeen = new Set<number>();
  // Hours per calculator line key (the keys footprintLines gives the live price), to weigh a mixed-hours run.
  const keyHours = new Map<string, Set<number>>();
  const lineHour = (key: string, h: number) => keyHours.set(key, (keyHours.get(key) ?? new Set<number>()).add(h));
  for (const it of file.items) {
    const h = it.hours ?? file.hours ?? 1;
    hoursSeen.add(h);
    if ('platform' in it) {
      const pre = it.preemptible ?? (it.platform.startsWith('gpu-') ? 'compare' : false);
      if (pre === true) notes.push(`${it.name} is pinned to preemptible in the file; its on-demand row is shown for comparison only.`);
      if (pre !== false) spot = true;
      if (it.count > 0) lineHour(`vm:${it.name.slice(0, 60)}`, h);
      nodeGroups.push({
        name: it.name.slice(0, 60),
        role: pre === false ? 'system' : it.platform.startsWith('gpu-') ? 'gpu' : 'cpu-worker',
        platform: it.platform,
        preset: it.preset,
        count: it.count,
        bootDiskGib: 0,
      });
    } else if ('disk_type' in it) {
      const gib = it.size_gib * it.count;
      if (it.disk_type === 'NETWORK_SSD') {
        extraSsdGib += gib;
        if (gib > 0) lineHour('ssd', h);
      } else if (it.disk_type === 'NETWORK_SSD_IO_M3') {
        ioM3Gib += gib;
        if (gib > 0) lineHour('io', h);
      }
      else notes.push(`${it.name} (${it.disk_type}, ${gib} GiB) is not priced here; price.py prices it.`);
    } else {
      const gib = it.size_gib * it.count;
      if (it.filesystem_type === 'NETWORK_SSD') {
        filesystemGib += gib;
        if (gib > 0) lineHour('fs', h);
      } else notes.push(`${it.name} (${it.filesystem_type} filesystem, ${gib} GiB) is not priced here; price.py prices it.`);
    }
  }
  let lineHours: Record<string, number> | undefined;
  if (hoursSeen.size > 1) {
    const hoursText = [...hoursSeen].sort((a, b) => a - b).join(', ');
    lineHours = Object.fromEntries([...keyHours].filter(([, hs]) => hs.size === 1).map(([k, hs]) => [k, [...hs][0]]));
    const weighable = Object.keys(lineHours).length === keyHours.size;
    notes.push(
      weighable
        ? `Items run for different hours (${hoursText} h): the per-run total weighs each line by its own hours, as price.py does.`
        : `Items run for different hours (${hoursText} h), and some are priced together: only per-hour figures are shown; price.py gives the per-run total.`,
    );
  }
  return {
    path,
    name: file.name,
    region: file.region,
    runHours: hoursSeen.size === 1 ? [...hoursSeen][0] : undefined,
    ...(lineHours ? { lineHours } : {}),
    capacityTypes: spot ? ['on-demand', 'preemptible'] : ['on-demand'],
    footprint: { nodeGroups, filesystemGib, extraSsdGib, ioM3Gib, objectStorageGib: 0, publicIps: 0 },
    notes,
  };
}

/* ----------------------------------------------------------------- Mermaid */

/**
 * The document viewer has no Mermaid renderer (none is in the lockfile): each ```mermaid block keeps
 * its source and gets a caption with a link to the file on GitHub, where it is drawn.
 */
export function annotateMermaid(md: string, path: string): string {
  if (!/^```mermaid\s*$/m.test(md)) return md;
  const caption = `*Diagram (Mermaid): shown as source here; [view it drawn on GitHub](${githubBlobUrl(path)}).*`;
  return md.replace(/^```mermaid\s*$/gm, `\n${caption}\n\n\`\`\`mermaid`);
}
