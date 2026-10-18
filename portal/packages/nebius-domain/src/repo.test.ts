import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import {
  parseRegions,
  PROOF_LEVELS,
  provenParts,
  parseStages,
  parseTfvars,
  parseVersions,
  parseYamlMergingDuplicates,
  RECIPES,
  recipeCaps,
  setTfvars,
  STACKS,
  tfvarsToRecord,
  unifiedDiff,
} from './repo';

// These tests read the repository's authoritative files, so a schema change
// there fails here instead of in the UI.
const REPO = resolve(__dirname, '../../../..');
const read = (p: string) => readFileSync(resolve(REPO, p), 'utf8');

describe('repository schema parsing', () => {
  it('parses platform/stages.yaml', () => {
    const { value } = parseStages(read('platform/stages.yaml'));
    expect(Object.keys(value.stages)).toEqual(['sandbox', 'staging', 'prod', 'lab']);
    expect(value.stages.sandbox.policy.require_ttl_label).toBe(true);
    // lab: CPU-only, TTL-bound (ADR-0009 later change 2026-10-12; policy/stages.rego).
    expect(value.stages.lab.policy.require_ttl_label).toBe(true);
    expect(Object.values(value.stages.lab.policy.max_gpu_nodes).every(n => n === 0)).toBe(true);
    expect(value.stages.prod.policy.require_strict_reservation.training).toBe(true);
    expect(value.promotion.length).toBeGreaterThan(0);
  });

  it('parses platform/regions.yaml', () => {
    const { value } = parseRegions(read('platform/regions.yaml'));
    expect(value.regions['eu-north1'].default).toBe('gpu-h100-sxm');
    expect(value.regions['eu-north1'].platforms['gpu-l40s-a'].ib_preset).toBeUndefined();
    expect(value.kubernetes_versions).toContain('1.36');
  });

  it('parses platform/versions.yaml', () => {
    const paths = parseVersions(read('platform/versions.yaml')).value.map(v => v.path);
    expect(paths).toEqual(expect.arrayContaining(['tooling / nebius_cli', 'tooling / conftest', 'tooling / tflint']));
  });

  it('parses every committed live sizing file', () => {
    for (const stage of ['sandbox', 'staging', 'prod']) {
      for (const stack of ['inference', 'training']) {
        const rec = tfvarsToRecord(parseTfvars(read(`terraform/live/${stage}/${stack}/${stage}.auto.tfvars`)));
        expect(typeof rec.gpu_node_count).toBe('number');
        expect(rec.cluster_name).toBe(`nip-${stage}-${stack}`);
      }
    }
  });
});

describe('recipe registry (README "Pick a recipe" table)', () => {
  const readmeRows = read('README.md')
    .split('\n')
    .map(l => /^\|\s*\*\*(R\d+)\*\*\s*\|[^|]*\|\s*\[`([^`]+)`\]\(([^)]+)\)/.exec(l))
    .filter((m): m is RegExpExecArray => Boolean(m));

  it('lists every recipe of the README, R1–R16, with the README path and docs', () => {
    expect(RECIPES.map(r => r.id)).toEqual(readmeRows.map(m => m[1]));
    expect(RECIPES.map(r => r.id)).toEqual(Array.from({ length: 16 }, (_, i) => `R${i + 1}`));
    for (const m of readmeRows) {
      const r = RECIPES.find(x => x.id === m[1])!;
      expect(r.docs).toBe(m[3]);
      expect(r.path).toBe(m[2].replace(/\/$/, ''));
    }
  });

  it('states the proof level of the README "What is proven" table for every recipe', () => {
    const levels = new Map(
      read('README.md')
        .split('\n')
        .map(l => /^\|\s*\*\*(R\d+)\*\*\s*\|\s*(Measured|Live run|Live read \/ plan|Offline-ready|Mocked only)\s*\|/.exec(l))
        .filter((m): m is RegExpExecArray => Boolean(m))
        .map(m => [m[1], m[2]] as const),
    );
    expect([...levels.keys()]).toEqual(RECIPES.map(r => r.id));
    for (const r of RECIPES) expect([r.id, r.provenToday.split(':')[0]]).toEqual([r.id, levels.get(r.id)]);
  });

  it('splits each proven-today text into its README proof level and the detail after it', () => {
    expect(provenParts('Live read / plan: planned, not applied')).toEqual({ level: 'Live read / plan', detail: 'planned, not applied' });
    expect(provenParts('no level here')).toEqual({ level: null, detail: 'no level here' });
    for (const r of RECIPES) {
      const { level, detail } = provenParts(r.provenToday);
      expect([r.id, PROOF_LEVELS.includes(level!)]).toEqual([r.id, true]);
      expect(detail.length).toBeGreaterThan(0);
    }
  });

  it('points every recipe at documents and runbooks that exist', () => {
    for (const r of RECIPES) {
      for (const p of [r.docs, ...(r.moreDocs ?? []), ...r.runbooks]) expect([r.id, p, existsSync(resolve(REPO, p))]).toEqual([r.id, p, true]);
    }
    expect(RECIPES.filter(r => r.runbooks.length === 0).map(r => r.id)).toEqual(['R5', 'R6']);
  });

  it('offers a form only for R1, R3 and R4; live roots are read-only; the rest are documentation and runbooks', () => {
    const by = (k: string) => RECIPES.filter(r => r.provisioning === k).map(r => r.id);
    expect(by('form')).toEqual(['R1', 'R3', 'R4']);
    expect(by('live-root')).toEqual(['R7', 'R8', 'R9', 'R10', 'R12']);
    expect(by('documentation')).toEqual(['R2', 'R5', 'R6', 'R11', 'R13', 'R14', 'R15', 'R16']);
    // Every recipe with a stack has a live root per stage in this checkout.
    for (const r of RECIPES.filter(x => x.stack)) {
      expect(STACKS).toContain(r.stack);
      const file = r.stack === 'soperator' ? 'terraform/live/sandbox/soperator/stage.tfvars' : `terraform/live/sandbox/${r.stack}/sandbox.auto.tfvars`;
      expect([r.id, existsSync(resolve(REPO, file))]).toEqual([r.id, true]);
    }
  });

  it('reads the GPU caps of R10 and R15 from platform/stages.yaml (nvl is 0 everywhere until a reservation)', () => {
    const stages = parseStages(read('platform/stages.yaml')).value;
    expect(recipeCaps(RECIPES.find(r => r.id === 'R15')!, stages)).toEqual({ sandbox: 0, staging: 0, prod: 0, lab: 0 });
    expect(recipeCaps(RECIPES.find(r => r.id === 'R10')!, stages)).toEqual({ sandbox: 1, staging: 1, prod: 0, lab: 0 });
    expect(recipeCaps(RECIPES.find(r => r.id === 'R11')!, stages)).toBeUndefined();
  });
});

describe('YAML duplicate merge', () => {
  it('merges duplicate mapping blocks', () => {
    const { value, warnings } = parseYamlMergingDuplicates('a:\n  x: 1\nb: 2\na:\n  y: 3\n', 't');
    expect(value).toEqual({ a: { x: 1, y: 3 }, b: 2 });
    expect(warnings).toHaveLength(1);
  });
});

describe('tfvars editing', () => {
  const text = [
    '# header comment',
    'cluster_name = "nip-sandbox-inference"',
    'gpu_node_count  = 1    # cap 2 in sandbox',
    'gpu_preemptible = true',
    'labels = {',
    '  "nip-env" = "inference"',
    '}',
    '',
  ].join('\n');

  it('reads scalars and keeps maps raw', () => {
    const e = parseTfvars(text);
    expect(e.map(x => x.key)).toEqual(['cluster_name', 'gpu_node_count', 'gpu_preemptible', 'labels']);
    expect(e[1]).toMatchObject({ value: { kind: 'number', value: 1 }, comment: 'cap 2 in sandbox' });
    expect(e[3].value.kind).toBe('complex');
  });

  it('rewrites a scalar in place, keeping alignment and comment, and appends new keys', () => {
    const out = setTfvars(text, { gpu_node_count: 2, gpu_platform: 'gpu-h200-sxm' }, 'test');
    expect(out).toContain('gpu_node_count  = 2    # cap 2 in sandbox');
    expect(out).toContain('# test\ngpu_platform = "gpu-h200-sxm"');
    expect(out.startsWith('# header comment\n')).toBe(true);
  });

  it('refuses unsafe keys, values and complex rewrites', () => {
    expect(() => setTfvars(text, { labels: 'x' })).toThrow(/complex/);
    expect(() => setTfvars(text, { 'a"; rm': 1 } as any)).toThrow(/invalid tfvars key/);
    expect(() => setTfvars(text, { cluster_name: 'x"\n} evil' })).toThrow(/unsupported characters/);
    expect(() => setTfvars(text, { gpu_node_count: Number.NaN })).toThrow();
  });

  it('produces an applyable unified diff', () => {
    const out = setTfvars(text, { gpu_node_count: 2 });
    const diff = unifiedDiff(text, out, 'terraform/live/sandbox/inference/sandbox.auto.tfvars');
    expect(diff).toContain('--- a/terraform/live/sandbox/inference/sandbox.auto.tfvars');
    expect(diff).toContain('-gpu_node_count  = 1    # cap 2 in sandbox');
    expect(diff).toContain('+gpu_node_count  = 2    # cap 2 in sandbox');
    expect(unifiedDiff(text, text, 'x')).toBe('');
  });
});
