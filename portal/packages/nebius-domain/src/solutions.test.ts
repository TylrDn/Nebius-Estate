import { existsSync, readdirSync, readFileSync } from 'fs';
import { resolve } from 'path';
import {
  annotateMermaid,
  githubBlobUrl,
  parseSolutionFootprint,
  parseSolutionsIndex,
  SOLUTION_DEFAULT_STATUS,
  solutionStatusFromReadme,
} from './solutions';

// Reads the repository's own solutions, so a change to their layout fails here instead of in the UI.
const REPO = resolve(__dirname, '../../../..');
const read = (p: string) => readFileSync(resolve(REPO, p), 'utf8');

describe('solutions index (solutions/README.md)', () => {
  const rows = parseSolutionsIndex(read('solutions/README.md'));

  it('lists S1–S9 with their README paths, in order', () => {
    expect(rows.map(r => r.id)).toEqual(['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9']);
    expect(rows[0]).toMatchObject({ dir: 'solutions/S1-private-llm-serving-vpn', readme: 'solutions/S1-private-llm-serving-vpn/README.md', scenario: 'Private LLM serving with VPN to on-prem' });
  });

  // Structure, not content: the index is edited as solutions evolve, so assert what must stay true.
  it('resolves every composed recipe to an existing repository README', () => {
    for (const row of rows) {
      expect(row.recipes.length).toBeGreaterThan(0);
      for (const r of row.recipes) expect(existsSync(resolve(REPO, r.docs))).toBe(true);
    }
    expect(rows[0].recipes.map(r => r.id)).toEqual(expect.arrayContaining(['R1', 'R7']));
    expect(rows[0].recipes.find(r => r.id === 'R7')?.docs).toBe('terraform/stacks/network/README.md');
    expect(rows[2].recipes.find(r => r.id === 'R11')?.docs).toBe('recipes/token-factory/README.md');
  });

  it('keeps a status on every row and the headline estimate as plain text', () => {
    for (const row of rows) expect(row.status.trim()).not.toBe('');
    expect(rows[1].headline).toMatch(/\$[\d,]+/);
    for (const row of rows) expect(row.headline).not.toMatch(/[[\]`*]/);
  });

  it('falls back to the default status when a row has none', () => {
    const md = ['| Id | Scenario | Recipes composed | Worked example | Headline | Status |', '|---|---|---|---|---|---|', '| [S1](S1-x/README.md) | X | [R1](../terraform/stacks/inference/README.md) | ex | $1 |  |'].join('\n');
    expect(parseSolutionsIndex(md)[0].status).toBe(SOLUTION_DEFAULT_STATUS);
    expect(SOLUTION_DEFAULT_STATUS).toBe('design done; live evidence not yet run');
  });

  it('reads the Status row of a solution README', () => {
    expect(solutionStatusFromReadme(read('solutions/S3-llm-api-token-factory/README.md'))).toMatch(/600-request concurrency sweep/);
    expect(solutionStatusFromReadme('# S0\n\nno table')).toBeUndefined();
  });
});

describe('solution footprints → the live-price calculator footprint', () => {
  it('maps every committed footprint file without error', () => {
    for (const dir of readdirSync(resolve(REPO, 'solutions')).filter(d => /^S\d-/.test(d))) {
      for (const f of readdirSync(resolve(REPO, 'solutions', dir)).filter(x => /^footprint.*\.json$/.test(x))) {
        const r = parseSolutionFootprint(read(`solutions/${dir}/${f}`));
        expect(r.error).toBeUndefined();
        expect(r.footprint?.nodeGroups.length).toBeGreaterThan(0);
      }
    }
  });

  it('turns VM items into node groups and disks or filesystems into storage', () => {
    const r = parseSolutionFootprint(read('solutions/S1-private-llm-serving-vpn/footprint.json'));
    expect(r).toMatchObject({ name: 's1-private-serving-prod-month', region: 'eu-north1', runHours: 730, capacityTypes: ['on-demand'] });
    const gpu = r.footprint!.nodeGroups.find(g => g.name === 'gpu-serving');
    expect(gpu).toMatchObject({ platform: 'gpu-h200-sxm', preset: '1gpu-16vcpu-200gb', count: 2, bootDiskGib: 0 });
    // Boot disks are separate items in the file: 512×2 + 128×3 + 25 + 50×4 GiB of network SSD.
    expect(r.footprint!.extraSsdGib).toBe(512 * 2 + 128 * 3 + 25 + 50 * 4);
    expect(r.footprint!.filesystemGib).toBe(2048);
    expect(r.footprint!.ioM3Gib).toBe(0);
  });

  it('prices on-demand and preemptible when a VM asks to compare, keeping the others on-demand', () => {
    const r = parseSolutionFootprint(read('solutions/S4-burst-training-preemptible/footprint.json'));
    expect(r.capacityTypes).toEqual(['on-demand', 'preemptible']);
    expect(r.runHours).toBe(72);
    // The calculator flow never prices a `system` group preemptible: CPU nodes stay on-demand in the spot row.
    expect(r.footprint!.nodeGroups.find(g => g.name === 'gpu-nodes')?.role).toBe('gpu');
    expect(r.footprint!.nodeGroups.find(g => g.name === 'cpu-nodes')?.role).toBe('system');
  });

  it('counts IO_M3 disks separately', () => {
    const r = parseSolutionFootprint(read('solutions/S5-slurm-migration/footprint.json'));
    expect(r.footprint!.ioM3Gib).toBe(279);
    expect(r.footprint!.filesystemGib).toBe(2048 + 2048 + 128);
  });

  it('has no single run length when items differ in hours, and says so', () => {
    const r = parseSolutionFootprint(
      JSON.stringify({ name: 'x', region: 'eu-north1', items: [{ name: 'a', platform: 'cpu-d3', preset: '4vcpu-16gb', count: 1, hours: 10 }, { name: 'b', disk_type: 'NETWORK_SSD', size_gib: 10, count: 1, hours: 20 }] }),
    );
    expect(r.runHours).toBeUndefined();
    expect(r.notes.join(' ')).toMatch(/different hours/);
  });

  it('G5.14: keeps each calculator line\'s hours when items differ, so a per-run total can weigh them (S9)', () => {
    const r = parseSolutionFootprint(read('solutions/S9-data-science-notebooks/footprint.json'));
    expect(r.runHours).toBeUndefined();
    expect(r.lineHours).toEqual({ 'vm:devlabs': 176, 'vm:train-gpu-nodes': 730, 'vm:cpu-nodes': 730, ssd: 730, fs: 730 });
    expect(r.notes.join(' ')).toMatch(/per-run total weighs each line by its own hours/);
    // Items merged into one calculator line with different hours cannot be weighed: that line has no hours.
    const mixed = parseSolutionFootprint(
      JSON.stringify({ name: 'x', region: 'eu-north1', items: [{ name: 'a', platform: 'cpu-d3', preset: '4vcpu-16gb', count: 1, hours: 10 }, { name: 'b', disk_type: 'NETWORK_SSD', size_gib: 10, count: 1, hours: 20 }, { name: 'c', disk_type: 'NETWORK_SSD', size_gib: 10, count: 1, hours: 10 }] }),
    );
    expect(mixed.lineHours).toEqual({ 'vm:a': 10 });
    expect(mixed.notes.join(' ')).toMatch(/only per-hour figures/);
  });

  it('reports a malformed file instead of throwing', () => {
    expect(parseSolutionFootprint('{').error).toMatch(/not JSON/);
    expect(parseSolutionFootprint(JSON.stringify({ name: 'x', region: 'eu-north1', items: [{ name: 'a', disk_type: 'TAPE', size_gib: 1, count: 1 }] })).error).toBeDefined();
    expect(parseSolutionFootprint(JSON.stringify({ name: 'x', region: 'Not a region', items: [] })).error).toBeDefined();
  });
});

describe('Mermaid diagrams in the document viewer', () => {
  it('captions each Mermaid block and links to the rendered diagram on GitHub, keeping the source', () => {
    const md = 'Intro\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\nAfter\n';
    const out = annotateMermaid(md, 'solutions/S1-x/README.md');
    expect(out).toContain('```mermaid\nflowchart LR\n  A --> B\n```');
    expect(out).toContain('Diagram (Mermaid)');
    expect(out).toContain(`(${githubBlobUrl('solutions/S1-x/README.md')})`);
    expect(out.indexOf('Diagram (Mermaid)')).toBeLessThan(out.indexOf('```mermaid'));
  });

  it('leaves documents without Mermaid unchanged', () => {
    const md = '# T\n\n```bash\necho hi\n```\n';
    expect(annotateMermaid(md, 'runbooks/x.md')).toBe(md);
  });

  it('links to the file on the repository default branch', () => {
    expect(githubBlobUrl('solutions/S1-x/README.md')).toBe('https://github.com/TylrDn/Nebius-Estate/blob/main/solutions/S1-x/README.md');
  });
});
