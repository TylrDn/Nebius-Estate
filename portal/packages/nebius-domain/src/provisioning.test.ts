import { readFileSync } from 'fs';
import { resolve } from 'path';
import { parseRegions, parseStages, parseTfvars, RunProfile, tfvarsToRecord } from './repo';
import { NIP_LABELS } from './resources';
import {
  committedForm,
  previewChange,
  previewToPatch,
  provisioningRequestSchema,
  ProvisioningRequestInput,
  scenarioFromProvisioning,
  sizingFilePath,
  validateProvisioningRequest,
} from './provisioning';
import { inferenceFootprint, quotaNeeds, soperatorLabFootprint, trainingFootprint } from './capacity';
import { estimateScenario, rateBookSchema } from './pricing';

const REPO = resolve(__dirname, '../../../..');
const read = (p: string) => readFileSync(resolve(REPO, p), 'utf8');
const stages = parseStages(read('platform/stages.yaml')).value;
const regions = parseRegions(read('platform/regions.yaml')).value;
const now = new Date('2026-10-10T12:00:00Z');
const ctx = { stages, regions, now };

const sandbox: ProvisioningRequestInput = {
  recipe: 'sandbox-inference',
  stage: 'sandbox',
  region: 'eu-north1',
  gpuNodeCount: 1,
  capacityType: 'preemptible',
  ttlExpires: '2026-10-10T20:00:00Z',
  runtimeHours: 8,
  owner: 'platform',
  requestRef: 'ticket-123',
  budget: { amount: '50', currency: 'USD' },
};

const errors = (i: ProvisioningRequestInput) => validateProvisioningRequest(i, ctx).filter(x => x.severity === 'error');

describe('provisioning request schema', () => {
  it('rejects injection-shaped parameters', () => {
    expect(provisioningRequestSchema.safeParse({ ...sandbox, stage: '../prod' }).success).toBe(false);
    expect(provisioningRequestSchema.safeParse({ ...sandbox, owner: 'a b; rm -rf' }).success).toBe(false);
    expect(provisioningRequestSchema.safeParse({ ...sandbox, requestRef: "x' && curl" }).success).toBe(false);
    expect(provisioningRequestSchema.safeParse({ ...sandbox, region: 'eu-north1/../../' }).success).toBe(false);
    expect(provisioningRequestSchema.safeParse({ ...sandbox, platform: 'gpu-x"; evil' }).success).toBe(false);
    expect(provisioningRequestSchema.safeParse({ ...sandbox, ttlExpires: 'tomorrow' }).success).toBe(false);
    expect(provisioningRequestSchema.safeParse(sandbox).success).toBe(true);
  });

  it('maps only to fixed sizing files', () => {
    expect(sizingFilePath('sandbox-inference', 'sandbox')).toBe('terraform/live/sandbox/inference/sandbox.auto.tfvars');
    expect(sizingFilePath('sandbox-inference', 'prod')).toBeUndefined();
    expect(sizingFilePath('training-capacity', '../../etc')).toBeUndefined();
    expect(sizingFilePath('soperator-lab', 'sandbox')).toBeUndefined();
  });
});

describe('policy-aware validation (platform/stages.yaml)', () => {
  it('accepts a valid sandbox request', () => {
    expect(errors(sandbox)).toEqual([]);
  });

  it('enforces the per-stage GPU cap', () => {
    const e = errors({ ...sandbox, gpuNodeCount: 3 });
    expect(e[0]).toMatchObject({ field: 'gpuNodeCount', source: 'platform/stages.yaml: stages.sandbox.policy.max_gpu_nodes.inference' });
  });

  it('requires a future TTL in sandbox and warns when it outlives the run', () => {
    expect(errors({ ...sandbox, ttlExpires: undefined })[0].field).toBe('ttlExpires');
    expect(errors({ ...sandbox, ttlExpires: '2026-10-09T00:00:00Z' })[0].message).toMatch(/past/);
    const w = validateProvisioningRequest({ ...sandbox, ttlExpires: '2026-10-20T00:00:00Z' }, ctx);
    expect(w.some(x => x.severity === 'warning' && x.field === 'ttlExpires')).toBe(true);
  });

  it('requires STRICT reservations for prod training with GPUs', () => {
    const base: ProvisioningRequestInput = { ...sandbox, recipe: 'training-capacity', stage: 'prod', capacityType: 'on-demand', gpuNodeCount: 2, ttlExpires: undefined };
    expect(errors(base).map(e => e.field)).toContain('reservationPolicy');
    expect(errors({ ...base, capacityType: 'reserved', reservationPolicy: 'STRICT' })).toEqual([]);
    expect(errors({ ...base, gpuNodeCount: 0 })).toEqual([]);
  });

  it('refuses platforms without an InfiniBand fabric for training', () => {
    const e = errors({ ...sandbox, recipe: 'training-capacity', platform: 'gpu-l40s-a', capacityType: 'on-demand', gpuNodeCount: 2 });
    expect(e.map(x => x.field)).toContain('platform');
  });

  it('refuses preemptible serving where the stage forbids it', () => {
    expect(errors({ ...sandbox, recipe: 'sandbox-inference', stage: 'staging' })[0].field).toBe('stage');
  });
});

describe('change preview', () => {
  const text = read('terraform/live/sandbox/inference/sandbox.auto.tfvars');

  it('produces a patch against the real sizing file and a run sheet', () => {
    const p = previewChange({ ...sandbox, gpuNodeCount: 2, filestoreSizeGib: 128 }, { ...ctx, sizingText: text });
    expect(p.files).toHaveLength(1);
    expect(p.files[0].diff).toContain('+gpu_node_count  = 2');
    expect(p.files[0].diff).toContain('+filestore_size_gib = 128');
    expect(previewToPatch(p)).toBe(p.files[0].diff);
    expect(p.runSheet.join('\n')).toContain('"nip-ttl-expires":"2026-10-10T20:00:00Z"');
    // nip-stack is the label; the deprecated nip-env is written alongside for one release.
    expect(p.runSheet.join('\n')).toMatch(/"nip-stack":"inference","nip-env":"inference"/);
    expect(p.runSheet.join('\n')).not.toMatch(/project-e|tenant-e/);
    expect(p.quota).toMatchObject({ gpus: 2, nonGpuVcpus: 16, networkSsdGib: 2 * 128 + 2 * 512 + 25, filesystemGib: 128 });
  });

  it('writes gpu_platform only when it differs from the region default', () => {
    const p = previewChange({ ...sandbox, platform: 'gpu-h200-sxm' }, { ...ctx, sizingText: text });
    expect(p.files[0].after).toContain('gpu_platform = "gpu-h200-sxm"');
    const q = previewChange(sandbox, { ...ctx, sizingText: text });
    expect(q.files[0].after).not.toContain('gpu_platform');
  });

  it('keeps reservation IDs out of the patch', () => {
    const p = previewChange(
      { ...sandbox, recipe: 'training-capacity', stage: 'prod', capacityType: 'reserved', reservationPolicy: 'STRICT', gpuNodeCount: 2, ttlExpires: undefined },
      { ...ctx, sizingText: read('terraform/live/prod/training/prod.auto.tfvars') },
    );
    expect(p.files[0].diff.split('\n').filter(l => l.startsWith('+') && l.includes('reservation-'))).toEqual([]);
    expect(p.runSheet.join('\n')).toContain('TF_VAR_gpu_reservation');
    expect(p.runSheet.join('\n')).toContain('release tag');
  });

  it('builds the estimate scenario: floor as minimum, rate-book currency, 730-hour month', () => {
    const input = { ...sandbox, gpuNodeCount: 2 };
    const p = previewChange(input, { ...ctx, sizingText: text });
    const book = rateBookSchema.parse(JSON.parse(read('portal/e2e-stub/ratebook.json')));
    const s = scenarioFromProvisioning(p, input, book, '2026-10-10');
    expect(s).toMatchObject({ recipe: 'inference', currency: book.currency, rateBookId: book.id, asOf: '2026-10-10', monthlyHours: 730 });
    expect(s.footprints.expected).toBe(p.footprint);
    const e = estimateScenario(s, book, now);
    expect(e.footprints.map(f => f.gpus)).toEqual([0, 2, 2]);
    expect(e.currency).toBe(book.currency);
    // G5.2: the approved runtime is the whole run (warm-up and teardown included), as the field hint, the TTL
    // check and the live-price tile read it: the estimate's run is 8 h, not 8 + 0.75 + 0.5.
    expect(s.runtime).toEqual({ activeHours: input.runtimeHours, warmupHours: 0, teardownHours: 0 });
    expect(e.footprints.map(f => f.runHours)).toEqual([input.runtimeHours, input.runtimeHours, input.runtimeHours]);
  });

  it('soperator lab changes no files', () => {
    const p = previewChange({ ...sandbox, recipe: 'soperator-lab', capacityType: 'on-demand', gpuNodeCount: 0 }, ctx);
    expect(p.files).toEqual([]);
    expect(p.quota.nonGpuVcpus).toBe(52);
  });
});

describe('capacity arithmetic matches docs/capacity.md', () => {
  const sizing = (stage: string, stack: string) =>
    Object.fromEntries(read(`terraform/live/${stage}/${stack}/${stage}.auto.tfvars`).split('\n').map(l => /^(\w+)\s*=\s*([\w.]+)/.exec(l)).filter(Boolean).map(m => [m![1], /^\d+$/.test(m![2]) ? Number(m![2]) : m![2] === 'true' ? true : m![2] === 'false' ? false : m![2]]));
  const fctx = { regions, region: 'eu-north1' };

  it('inference sandbox / prod', () => {
    expect(quotaNeeds(inferenceFootprint(sizing('sandbox', 'inference'), fctx))).toMatchObject({ nonGpuVcpus: 16, gpuVms: 1, networkSsdGib: 793, filesystemGib: 64 });
    expect(quotaNeeds(inferenceFootprint(sizing('prod', 'inference'), fctx))).toMatchObject({ nonGpuVcpus: 24, gpuVms: 2, networkSsdGib: 1433, filesystemGib: 1024 });
  });

  it('training sandbox and the 2-node addition', () => {
    expect(quotaNeeds(trainingFootprint(sizing('sandbox', 'training'), fctx), { gpuCluster: true })).toMatchObject({ nonGpuVcpus: 16, gpus: 0, networkSsdGib: 281, gpuClusters: 0 });
    expect(quotaNeeds(trainingFootprint(sizing('sandbox', 'training'), fctx, 2), { gpuCluster: true })).toMatchObject({ gpus: 16, networkSsdGib: 281 + 2 * 1023, gpuClusters: 1 });
  });

  it('soperator lab', () => {
    expect(quotaNeeds(soperatorLabFootprint('sandbox'))).toMatchObject({ nonGpuVcpus: 52, networkSsdGib: 1280, filesystemGib: 448, publicIps: 1, gpus: 0 });
  });
});

describe('W1-P1: the form starts from the committed sizing and patches only what the request changes', () => {
  const prodText = read('terraform/live/prod/training/prod.auto.tfvars');
  const stagingText = read('terraform/live/staging/training/staging.auto.tfvars');
  const record = (t: string) => tfvarsToRecord(parseTfvars(t));
  const training = (stage: string): ProvisioningRequestInput => ({ ...sandbox, recipe: 'training-capacity', stage, capacityType: 'reserved', reservationPolicy: 'STRICT', gpuNodeCount: 2, ttlExpires: undefined });

  it('prefills every field from the sizing file of the chosen stage', () => {
    expect(committedForm('training-capacity', record(prodText))).toEqual({ gpuNodeCount: 0, platform: null, filestoreSizeGib: 4096, capacityType: 'on-demand', fabric: null });
    expect(committedForm('training-capacity', record(stagingText))).toMatchObject({ gpuNodeCount: 0, filestoreSizeGib: 1024 });
    expect(committedForm('sandbox-inference', record(read('terraform/live/sandbox/inference/sandbox.auto.tfvars')))).toEqual({ gpuNodeCount: 1, platform: null, filestoreSizeGib: 64, capacityType: 'preemptible', fabric: null });
  });

  it('changing only the GPU node count patches only gpu_node_count (prod 4096 and staging 1024 GiB stay)', () => {
    for (const [stage, text] of [['prod', prodText], ['staging', stagingText]] as const) {
      const committed = committedForm('training-capacity', record(text));
      const p = previewChange({ ...training(stage), filestoreSizeGib: committed.filestoreSizeGib }, { ...ctx, sizingText: text });
      const changed = p.files[0].diff.split('\n').filter(l => /^[+-][a-z_]/.test(l));
      expect(changed).toHaveLength(2);
      expect(changed.every(l => l.includes('gpu_node_count'))).toBe(true);
      expect(p.files[0].after).toContain(`filestore_size_gib = ${committed.filestoreSizeGib}`);
      // Also when the field is left empty.
      const q = previewChange(training(stage), { ...ctx, sizingText: text });
      expect(q.files[0].diff).not.toContain('filestore_size_gib');
    }
  });

  it('writes nothing when every field matches the committed sizing', () => {
    const text = read('terraform/live/sandbox/inference/sandbox.auto.tfvars');
    expect(previewChange({ ...sandbox, ...committedForm('sandbox-inference', record(text)) } as ProvisioningRequestInput, { ...ctx, sizingText: text }).files[0].diff).toBe('');
  });
});

describe('W1-P2: a stateful size never shrinks silently', () => {
  const prodText = read('terraform/live/prod/training/prod.auto.tfvars');
  const shrink: ProvisioningRequestInput = { ...sandbox, recipe: 'training-capacity', stage: 'prod', capacityType: 'on-demand', gpuNodeCount: 0, filestoreSizeGib: 256, ttlExpires: undefined };
  const issues = (i: ProvisioningRequestInput) => validateProvisioningRequest(i, { ...ctx, sizingText: prodText });

  it('a smaller shared filesystem is an error naming both sizes, the reset value and the Nebius rule', () => {
    const e = issues(shrink).filter(x => x.severity === 'error' && x.field === 'filestoreSizeGib');
    expect(e).toHaveLength(1);
    expect(e[0].message).toMatch(/4,096 GiB to 256 GiB/);
    expect(e[0].message).toMatch(/Reset to 4,096 GiB/);
    expect(e[0].source).toMatch(/docs\.nebius\.com\/compute\/storage\/manage#how-to-resize-a-volume/);
  });

  it('an explicit "I intend to shrink/replace" turns it into a warning; growing is fine', () => {
    const w = issues({ ...shrink, confirmShrink: true }).filter(x => x.field === 'filestoreSizeGib');
    expect(w.map(x => x.severity)).toEqual(['warning']);
    expect(issues({ ...shrink, filestoreSizeGib: 8192 }).filter(x => x.field === 'filestoreSizeGib')).toEqual([]);
  });

  it('W1-P5: the shrink still has its diff to show', () => {
    const p = previewChange(shrink, { ...ctx, sizingText: prodText });
    expect(p.files[0].diff).toContain('+filestore_size_gib = 256');
  });
});

describe('W1-P5: the diff and the estimate show before a request reference is typed', () => {
  const text = read('terraform/live/sandbox/inference/sandbox.auto.tfvars');
  const noRef = { ...sandbox, gpuNodeCount: 2, requestRef: '' };

  it('an empty reference parses, and is the one error that blocks Prepare', () => {
    expect(provisioningRequestSchema.safeParse(noRef).success).toBe(true);
    expect(errors(noRef)).toEqual([expect.objectContaining({ field: 'requestRef', message: expect.stringMatching(/^Enter a request reference/) })]);
    expect(errors(sandbox).filter(e => e.field === 'requestRef')).toEqual([]);
  });

  it('previews the diff and the footprint; the run sheet, which names the run, waits for the reference', () => {
    const p = previewChange(noRef, { ...ctx, sizingText: text });
    expect(p.files[0].diff).toContain('+gpu_node_count  = 2');
    expect(p.footprint.nodeGroups.length).toBeGreaterThan(0);
    expect(p.runSheet).toEqual([]);
    expect(p.notes).toContain('The run sheet is shown once a request reference is entered: it names the run (the nip-run label, RUN=).');
    expect(previewChange({ ...noRef, requestRef: 'ticket-9' }, { ...ctx, sizingText: text }).runSheet.join('\n')).toContain('"nip-run":"ticket-9"');
  });
});

describe('#27: a run profile sizes the request as make plan PROFILE=<name> does', () => {
  const text = read('terraform/live/sandbox/inference/sandbox.auto.tfvars');
  const profile: RunProfile = JSON.parse(read('platform/profiles/inference/l40s-gpu-only.json'));
  const runProfiles = [{ ...profile, name: 'l40s-gpu-only' }];
  const withProfile: ProvisioningRequestInput = { ...sandbox, runProfile: 'l40s-gpu-only', platform: 'gpu-l40s-a', gpuNodeCount: 1, filestoreSizeGib: 64 };
  const pctx = { ...ctx, sizingText: text, runProfiles };

  it('prices and quota-checks the profile\'s shape (no CPU node, one L40S) and patches nothing it sets', () => {
    const p = previewChange(withProfile, pctx);
    expect(p.footprint.nodeGroups.map(g => [g.platform, g.preset, g.count])).toEqual([['cpu-d3', '8vcpu-32gb', 0], ['gpu-l40s-a', '1gpu-8vcpu-32gb', 1]]);
    expect(p.quota.nonGpuVcpus).toBe(0);
    expect(p.files[0].diff).toBe('');
    expect(p.runSheet.join('\n')).toContain('PROFILE=l40s-gpu-only');
    expect(p.runSheet.join('\n')).toContain('make preflight STAGE=sandbox STACK=inference PROFILE=l40s-gpu-only');
    expect(validateProvisioningRequest(withProfile, pctx).filter(x => x.severity === 'error')).toEqual([]);
  });

  it('prefills from the profile over the sizing file', () => {
    expect(committedForm('sandbox-inference', tfvarsToRecord(parseTfvars(text)), runProfiles[0])).toEqual({ gpuNodeCount: 1, platform: 'gpu-l40s-a', filestoreSizeGib: 64, capacityType: 'preemptible', fabric: null });
  });

  it('refuses a field the profile sets, another region, or an unknown profile', () => {
    const fields = (i: ProvisioningRequestInput) => validateProvisioningRequest(i, pctx).filter(x => x.severity === 'error').map(x => x.field);
    expect(fields({ ...withProfile, gpuNodeCount: 2 })).toContain('gpuNodeCount');
    expect(fields({ ...withProfile, region: 'eu-west1', platform: null })).toContain('region');
    expect(fields({ ...withProfile, runProfile: 'no-such-profile' })).toContain('runProfile');
  });
});

describe('generated sizing files stay terraform-fmt clean', () => {
  // Runs only where terraform is installed (CI for the repo has it; the portal tests do not require it).
  const { spawnSync } = require('child_process') as typeof import('child_process');
  const tf = spawnSync('terraform', ['version'], { encoding: 'utf8' });
  it('every recipe/stage patch is already formatted (skipped without terraform)', () => {
    if (tf.status !== 0) return;
    const cases: [ProvisioningRequestInput, string][] = [
      [{ ...sandbox, gpuNodeCount: 2, filestoreSizeGib: 128, platform: 'gpu-h200-sxm' }, 'terraform/live/sandbox/inference/sandbox.auto.tfvars'],
      [{ ...sandbox, recipe: 'training-capacity', stage: 'staging', capacityType: 'on-demand', gpuNodeCount: 2, ttlExpires: undefined }, 'terraform/live/staging/training/staging.auto.tfvars'],
      [{ ...sandbox, recipe: 'training-capacity', stage: 'prod', capacityType: 'reserved', reservationPolicy: 'STRICT', gpuNodeCount: 16, ttlExpires: undefined }, 'terraform/live/prod/training/prod.auto.tfvars'],
    ];
    for (const [input, path] of cases) {
      const p = previewChange(input, { ...ctx, sizingText: read(path) });
      const out = spawnSync('terraform', ['fmt', '-'], { input: p.files[0].after, encoding: 'utf8' });
      expect(out.status).toBe(0);
      expect(out.stdout).toBe(p.files[0].after);
    }
  });
});

describe('label keys', () => {
  it('lists the optional foundation and security-group labels', () => {
    expect(NIP_LABELS).toMatchObject({ stack: 'nip-stack', env: 'nip-env', layer: 'nip-layer', purpose: 'nip-purpose' });
  });
});

