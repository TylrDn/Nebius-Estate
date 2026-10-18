import type { EvidenceItem, SolutionFootprintView } from '@internal/nebius-domain';
import { capsText, footprintLabel, priceRequests, priceRowLabel, leadEvidence, recipeEvidence, provisioningText, usdText } from './model';

const fp: SolutionFootprintView = {
  path: 'solutions/S4-burst-training-preemptible/footprint.json',
  name: 's4-burst-4x8-h100-72h',
  region: 'eu-north1',
  runHours: 72,
  capacityTypes: ['on-demand', 'preemptible'],
  footprint: { nodeGroups: [{ name: 'gpu-nodes', role: 'gpu', platform: 'gpu-h100-sxm', preset: '8gpu-128vcpu-1600gb', count: 4, bootDiskGib: 0 }], filesystemGib: 4096, extraSsdGib: 0, ioM3Gib: 0, objectStorageGib: 0, publicIps: 0 },
  notes: [],
};

describe('price this footprint', () => {
  it('asks the calculator once per capacity type, in the footprint region, with its run length', () => {
    const r = priceRequests(fp);
    expect(r.map(x => x.key)).toEqual(['on-demand', 'preemptible']);
    expect(r[1]).toMatchObject({ label: 'Preemptible (spot now)', runHours: 72, body: { footprint: fp.footprint, region: 'eu-north1', capacityType: 'preemptible' } });
    expect(r[0].body.capacityType).toBe('on-demand');
  });

  it('labels a row with the price basis the calculator answered with, never a fixed "(list)"', () => {
    const [onDemand] = priceRequests(fp);
    expect(onDemand.label).toBe('On-demand');
    expect(priceRowLabel(onDemand, { status: 'loading' })).toBe('On-demand');
    const ready = (value: object) => ({ status: 'ready', response: { value } }) as any;
    expect(priceRowLabel(onDemand, ready({ offer: 'contract', hourly: { amount: '12.5', currency: 'USD' }, listHourly: { amount: '12.5', currency: 'USD' } }))).toBe('On-demand · contract price (= list)');
    expect(priceRowLabel(onDemand, ready({ offer: 'list', hourly: { amount: '12.5', currency: 'USD' } }))).toBe('On-demand · list price');
  });

  it('asks nothing for a footprint that could not be read', () => {
    expect(priceRequests({ ...fp, footprint: undefined, error: 'bad' })).toEqual([]);
  });

  it('names a footprint file by its variant', () => {
    expect(footprintLabel(fp)).toBe('footprint.json · eu-north1 · 72 h');
    expect(footprintLabel({ ...fp, path: 'solutions/S2-x/footprint-b300.json', region: 'eu-west2', runHours: undefined })).toBe('footprint-b300.json · eu-west2');
  });
});

describe('recipe cards', () => {
  const items = [
    { id: 'a', kind: 'repo-live', title: 'Smoke', recipe: 'R11', path: 'docs/evidence/x.md' },
    { id: 'b', kind: 'not-measured', title: 'No run', recipe: 'R10' },
    { id: 'c', kind: 'static-validation', title: 'fmt' },
    { id: 'd', kind: 'repo-live', title: 'Live plans', recipe: 'R9', recipes: ['R9', 'R7'], path: 'docs/evidence/y.md' },
  ] as EvidenceItem[];

  it('lists the evidence rows of a recipe', () => {
    expect(recipeEvidence(items, 'R11').map(i => i.id)).toEqual(['a']);
    expect(recipeEvidence(items, 'R10').map(i => i.id)).toEqual(['b']);
    expect(recipeEvidence(items, 'R1')).toEqual([]);
    // A run that names several recipes in its Run column belongs to each of them.
    expect(recipeEvidence(items, 'R7').map(i => i.id)).toEqual(['d']);
    expect(recipeEvidence(items, 'R9').map(i => i.id)).toEqual(['d']);
  });

  it('leads with the strongest, newest rows and folds the rest; a not-measured claim is never folded', () => {
    const rows = [
      { id: 'mock', kind: 'mocked-plan-test', title: 'm' },
      { id: 'old', kind: 'repo-live', title: 'o', date: '2026-10-11' },
      { id: 'gap', kind: 'not-measured', title: 'g' },
      { id: 'new', kind: 'repo-live', title: 'n', date: '2026-10-12' },
      { id: 'up', kind: 'upstream-live', title: 'u', date: '2026-09-01' },
      { id: 'old2', kind: 'repo-live', title: 'o2', date: '2026-10-11' },
    ] as EvidenceItem[];
    const { lead, rest } = leadEvidence(rows, 3);
    expect(lead.map(i => i.id)).toEqual(['new', 'old', 'old2', 'gap']);
    expect(rest.map(i => i.id)).toEqual(['up', 'mock']);
    // Few rows: nothing folds.
    expect(leadEvidence(rows.slice(0, 2), 3)).toEqual({ lead: [rows[1], rows[0]], rest: [] });
    expect(leadEvidence([], 3)).toEqual({ lead: [], rest: [] });
  });

  it("#48: a recipe card leads with the recipe's own runs, then runs it shares with other recipes", () => {
    // The 2026-10-12 session: R8 and R14 acceptance runs also cover R1 and sort first by file name.
    const rows = [
      { id: 'data', kind: 'repo-live', title: 'd', date: '2026-10-12', recipe: 'R8', recipes: ['R8', 'R1'] },
      { id: 'o11y', kind: 'repo-live', title: 'o', date: '2026-10-12', recipe: 'R14', recipes: ['R14', 'R1'] },
      { id: 'own', kind: 'repo-live', title: 'v', date: '2026-10-12', recipe: 'R1' },
      { id: 'own-old', kind: 'repo-live', title: 'v0', date: '2026-10-11', recipe: 'R1' },
      { id: 'gap', kind: 'not-measured', title: 'g', recipe: 'R1' },
    ] as EvidenceItem[];
    expect(leadEvidence(rows, 2, 'R1').lead.map(i => i.id)).toEqual(['own', 'own-old', 'gap']);
    expect(leadEvidence(rows, 2, 'R1').rest.map(i => i.id)).toEqual(['data', 'o11y']);
    // For R8 its own acceptance run leads.
    expect(leadEvidence(rows, 1, 'R8').lead.map(i => i.id)).toEqual(['data', 'gap']);
  });

  it('writes the stage caps from platform/stages.yaml', () => {
    expect(capsText({ sandbox: 1, staging: 1, prod: 0 })).toBe('sandbox 1 · staging 1 · prod 0');
    expect(capsText(undefined)).toBeUndefined();
  });

  it('says how each recipe is offered', () => {
    expect(provisioningText({ provisioning: 'form', liveRoots: [] })).toBe('Form on the Provisioning page');
    expect(provisioningText({ provisioning: 'live-root', liveRoots: ['terraform/live/sandbox/gpu-vm', 'terraform/live/staging/gpu-vm'] })).toBe('Read-only live roots: sandbox, staging (no form)');
    expect(provisioningText({ provisioning: 'documentation', liveRoots: [] })).toBe('Documentation and runbook');
  });
});

describe('usdText', () => {
  it('writes README dollar amounts the way the rest of the portal writes money: "<amount> USD"', () => {
    expect(usdText('$9,127.34 a month on-demand (+ MLflow ≈ $364)')).toBe('9,127.34 USD a month on-demand (+ MLflow ≈ 364 USD)');
    expect(usdText('$32.40–$1,800 a month by model; self-host counterpart $4,056.10')).toBe('32.40–1,800 USD a month by model; self-host counterpart 4,056.10 USD');
    expect(usdText('no price')).toBe('no price');
  });
});
