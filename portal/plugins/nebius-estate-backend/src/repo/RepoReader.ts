import { createHash } from 'crypto';
import { promises as fs, realpathSync } from 'fs';
import { join, resolve, sep } from 'path';
import {
  LiveRoot,
  parseRegions,
  parseStages,
  parseTfvars,
  parseVersions,
  RECIPES,
  recipeCaps,
  RepoModel,
  RunProfile,
  Stack,
  STACKS,
  tfvarsToRecord,
} from '@internal/nebius-domain';

/**
 * Read-only access to this repository's files. Only paths matching
 * ALLOWED are readable; every path is resolved, symlinks included, and must
 * stay inside the repository root. Nothing here writes to disk.
 */
const STAGE = '(sandbox|staging|prod)';
const ALLOWED: RegExp[] = [
  /^README\.md$/,
  /^CHANGELOG\.md$/,
  /^CONTRIBUTING\.md$/,
  /^platform\/(stages|regions|versions)\.yaml$/,
  /^platform\/alerts\/(portal\/)?[a-z0-9-]+\.yaml$/,
  /^platform\/README\.md$/,
  // Run profiles: the stack, stages and region a run targets (F1.38: planned roots are checked in that region).
  /^platform\/profiles\/(inference|training|gpu-vm)\/[a-z0-9-]+\.json$/,
  new RegExp(`^terraform/live/${STAGE}/(inference|training|network|data|gpu-vm|ml-services|governance)/${STAGE}\\.auto\\.tfvars$`),
  new RegExp(`^terraform/live/${STAGE}/soperator/stage\\.tfvars$`),
  /^terraform\/stacks\/(inference|training|soperator|network|data|gpu-vm|ml-services|governance|nvl)\/README\.md$/,
  /^terraform\/modules\/foundation\/ci-federation\/README\.md$/,
  /^terraform\/README\.md$/,
  /^docs\/[a-z0-9-]+\.md$/,
  // The Nebius docs catalog (make docs-catalog) and its local page mirror (git-ignored; absent until the catalog is built).
  /^docs\/reference\/nebius-docs\.(json|md)$/,
  /^\.cache\/nebius-docs\/([a-z0-9][a-z0-9_-]*\/)*[a-z0-9][a-z0-9_.-]*\.md$/,
  /^docs\/(portal|solutions|design)\/([a-z0-9-]+|README)\.md$/,
  // Dated plans the README, CHANGELOG and docs link (live-run plan, overnight brief).
  /^docs\/plans\/\d{4}-\d{2}-\d{2}-[a-z0-9-]+\.md$/,
  /^docs\/decisions\/\d{4}-[a-z0-9-]+\.md$/,
  /^docs\/decisions\/README\.md$/,
  /^docs\/evidence\/[A-Za-z0-9.-]+\.md$/,
  /^runbooks\/[a-z0-9-]+\.md$/,
  /^recipes\/(serverless|team-platform|finance|token-factory|observability)\/README\.md$/,
  // Solutions (S1–S9): the index, each README and the footprint files its cost model prices.
  /^solutions\/README\.md$/,
  /^solutions\/S\d{1,2}-[a-z0-9-]+\/README\.md$/,
  /^solutions\/S\d{1,2}-[a-z0-9-]+\/footprint(-[a-z0-9-]+)?\.json$/,
  // Model ids the workloads pull (AI services: Hugging Face gated-access checks).
  /^recipes\/serverless\/(endpoint|job)\.sh$/,
  /^workloads\/inference\/overlays\/[a-z0-9.-]+\/kustomization\.yaml$/,
  /^workloads\/((inference|training|data\/copy-job|kueue)\/)?README\.md$/,
  /^tests\/(README|load\/README)\.md$/,
];

export class PathNotAllowedError extends Error {
  constructor(path: string) {
    super(`path not readable through the portal: ${path}`);
    this.name = 'PathNotAllowedError';
  }
}

export function isAllowedRepoPath(rel: string): boolean {
  if (rel.includes('\0') || rel.includes('\\') || rel.split('/').some(s => s === '..' || s === '.' || s === '')) return false;
  return ALLOWED.some(r => r.test(rel));
}

export class RepoReader {
  readonly root: string;
  private cache?: { at: number; model: RepoModel };

  constructor(repoRoot: string, private readonly ttlMs = 5000) {
    this.root = realpathSync(resolve(repoRoot));
  }

  private async resolveSafe(rel: string): Promise<string> {
    if (!isAllowedRepoPath(rel)) throw new PathNotAllowedError(rel);
    const abs = resolve(this.root, rel);
    const real = await fs.realpath(abs).catch(() => abs);
    if (real !== this.root && !real.startsWith(this.root + sep)) throw new PathNotAllowedError(rel);
    return real;
  }

  async read(rel: string): Promise<string> {
    const p = await this.resolveSafe(rel);
    const stat = await fs.stat(p);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new PathNotAllowedError(rel);
    return fs.readFile(p, 'utf8');
  }

  async exists(rel: string): Promise<boolean> {
    try {
      await fs.access(await this.resolveSafe(rel));
      return true;
    } catch {
      return false;
    }
  }

  async hash(rel: string): Promise<string> {
    return sha256(await this.read(rel));
  }

  /** HEAD commit read from .git without shelling out. */
  async commit(): Promise<string | undefined> {
    try {
      const head = (await fs.readFile(join(this.root, '.git', 'HEAD'), 'utf8')).trim();
      if (!head.startsWith('ref: ')) return /^[0-9a-f]{40}$/.test(head) ? head : undefined;
      const ref = head.slice(5);
      if (!/^refs\/heads\/[A-Za-z0-9._/-]+$/.test(ref)) return undefined;
      const loose = await fs.readFile(join(this.root, '.git', ref), 'utf8').catch(() => undefined);
      if (loose) return loose.trim();
      const packed = await fs.readFile(join(this.root, '.git', 'packed-refs'), 'utf8').catch(() => '');
      return packed.split('\n').find(l => l.endsWith(` ${ref}`))?.split(' ')[0];
    } catch {
      return undefined;
    }
  }

  async list(dir: 'docs/evidence' | 'runbooks' | 'docs/decisions'): Promise<string[]> {
    const entries = await fs.readdir(join(this.root, dir), { withFileTypes: true });
    return entries
      .filter(e => e.isFile() && e.name.endsWith('.md'))
      .map(e => `${dir}/${e.name}`)
      .filter(isAllowedRepoPath)
      .sort();
  }

  /** The footprint files of one solution folder: `footprint.json` first, then its variants. */
  async footprints(dir: string): Promise<string[]> {
    if (!/^solutions\/S\d{1,2}-[a-z0-9-]+$/.test(dir)) throw new PathNotAllowedError(dir);
    const entries = await fs.readdir(join(this.root, dir), { withFileTypes: true }).catch(() => []);
    return entries
      .filter(e => e.isFile())
      .map(e => `${dir}/${e.name}`)
      .filter(p => isAllowedRepoPath(p) && p.endsWith('.json'))
      .sort((a, b) => (a.endsWith('/footprint.json') ? -1 : b.endsWith('/footprint.json') ? 1 : a.localeCompare(b)));
  }

  /** Mocked plan tests present under terraform/ (terraform test files, not applies). */
  async planTests(): Promise<string[]> {
    const out: string[] = [];
    const walk = async (d: string, depth: number) => {
      if (depth > 6) return;
      const entries = await fs.readdir(join(this.root, d), { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        if (e.name.startsWith('.') || e.name === 'upstream') continue;
        const p = `${d}/${e.name}`;
        if (e.isDirectory()) await walk(p, depth + 1);
        else if (e.name.endsWith('.tftest.hcl')) out.push(p);
      }
    };
    await walk('terraform', 0);
    return out.sort();
  }

  /**
   * Run profiles (platform/profiles/<stack>/<name>.json): stack, stages, region, and the scalar `vars` that override
   * the sizing file when a run is planned with PROFILE=<name> (G2.2). A file that does not parse is skipped.
   */
  async runProfiles(): Promise<(RunProfile & { stack: string; stages: string[] })[]> {
    const out: (RunProfile & { stack: string; stages: string[] })[] = [];
    for (const stack of ['inference', 'training', 'gpu-vm']) {
      const entries = await fs.readdir(join(this.root, 'platform', 'profiles', stack), { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        const rel = `platform/profiles/${stack}/${e.name}`;
        if (!e.isFile() || !e.name.endsWith('.json') || !isAllowedRepoPath(rel)) continue;
        try {
          const j = JSON.parse(await this.read(rel));
          if (j.stack !== stack || !Array.isArray(j.stages) || typeof j.region !== 'string') continue;
          const vars = Object.fromEntries(
            Object.entries(j.vars && typeof j.vars === 'object' ? (j.vars as Record<string, unknown>) : {}).filter(
              (kv): kv is [string, string | number | boolean | null] => kv[1] === null || ['string', 'number', 'boolean'].includes(typeof kv[1]),
            ),
          );
          out.push({
            name: e.name.replace(/\.json$/, ''),
            stack,
            stages: j.stages.filter((x: unknown) => typeof x === 'string'),
            region: j.region,
            vars,
            ...(typeof j.description === 'string' ? { description: j.description } : {}),
          });
        } catch {
          // Not a run profile the portal can use: the root falls back to "region unknown".
        }
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async model(): Promise<RepoModel> {
    if (this.cache && Date.now() - this.cache.at < this.ttlMs) return this.cache.model;
    const stages = parseStages(await this.read('platform/stages.yaml'));
    const regions = parseRegions(await this.read('platform/regions.yaml'));
    const versions = parseVersions(await this.read('platform/versions.yaml'));
    const tests = await this.planTests();
    const profiles = await this.runProfiles();
    const liveRoots: LiveRoot[] = [];
    for (const stage of Object.keys(stages.value.stages)) {
      for (const stack of STACKS as readonly Stack[]) {
        const sizingFile =
          stack === 'soperator'
            ? `terraform/live/${stage}/soperator/stage.tfvars`
            : `terraform/live/${stage}/${stack}/${stage}.auto.tfvars`;
        if (!isAllowedRepoPath(sizingFile) || !(await this.exists(sizingFile))) continue;
        const path = `terraform/live/${stage}/${stack}`;
        const mine = profiles.filter(p => p.stack === stack && p.stages.includes(stage));
        const runRegions = [...new Set(mine.map(p => p.region))].sort();
        liveRoots.push({
          stage,
          stack,
          path,
          sizingFile,
          sizing: tfvarsToRecord(parseTfvars(await this.read(sizingFile))),
          hasPlanTests: stack === 'soperator' ? tests.some(t => t.startsWith('terraform/stacks/soperator/')) : tests.some(t => t.startsWith(`${path}/`)),
          ...(runRegions.length ? { runRegions, runProfiles: mine.map(({ name, region, vars, description }) => ({ name, region, vars, ...(description ? { description } : {}) })) } : {}),
        });
      }
    }
    const model: RepoModel = {
      commit: await this.commit(),
      stages: stages.value,
      regions: regions.value,
      versions: versions.value,
      liveRoots,
      recipes: await Promise.all(
        RECIPES.map(async r => ({
          ...r,
          docsAvailable: await this.exists(r.docs),
          caps: recipeCaps(r, stages.value),
          liveRoots: r.stack ? liveRoots.filter(l => l.stack === r.stack).map(l => l.path) : [],
        })),
      ),
      warnings: [...stages.warnings, ...regions.warnings, ...versions.warnings],
      readAt: new Date().toISOString(),
    };
    this.cache = { at: Date.now(), model };
    return model;
  }
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
