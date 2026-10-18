import { provenParts, recipeProof, RECIPES } from '@internal/nebius-domain';
import { REPO_ROOT } from '../__testUtils__/testing';
import { evidenceIndex } from './evidence';
import { RepoReader } from './RepoReader';
import { solutionsIndex } from './solutions';

/**
 * Proof from evidence (W1-P11–W1-P13) on this repository's own files. The drift test is the CI check of W1-P12: a
 * solution README row that says a recipe was not run (or not measured) while docs/evidence/ records a live run (or a
 * measurement) of it fails `yarn test` in the CI portal job, as the Solutions page shows it in a banner.
 */
describe('proof from the evidence index', () => {
  it('says what each run of this repository shows: measured, a run, or a read / plan', async () => {
    const items = await evidenceIndex(new RepoReader(REPO_ROOT));
    const level = (f: string) => items.find(i => i.path === `docs/evidence/${f}`)?.level;
    expect(level('2026-10-12-token-factory-bench.md')).toBe('Measured');
    expect(level('2026-10-11-token-factory-smoke.md')).toBe('Live run');
    expect(level('2026-10-11-foundation-ci-federation-live.md')).toBe('Live run');
    expect(level('2026-10-11-sandbox-live-plans.md')).toBe('Live read / plan');
    expect(level('2026-10-11-sandbox-ci-federated-plan.md')).toBe('Live read / plan');
    expect(level('2026-10-11-observability-read-only.md')).toBe('Live read / plan');
    expect(level('2026-10-08-mk8s-b300-gpu-smoke.md')).toBeUndefined(); // a prior upstream run is not this repository's
    expect(items.filter(i => i.kind === 'repo-live' && !i.level)).toEqual([]);
  });

  it('the level computed from the evidence files is the README "What is proven" level of every recipe', async () => {
    const items = await evidenceIndex(new RepoReader(REPO_ROOT));
    for (const r of RECIPES) expect([r.id, recipeProof(r.id, items).level]).toEqual([r.id, provenParts(r.provenToday).level]);
  });

  it('W1-P11, W1-P13: every solution carries one proof per composed recipe, with the last live date or none', async () => {
    const { items } = await solutionsIndex(new RepoReader(REPO_ROOT));
    for (const s of items) {
      expect([s.id, s.proof.map(p => p.recipe)]).toEqual([s.id, [...new Set(s.recipes.map(r => r.id))]]);
      for (const p of s.proof) {
        // A live level always has a date and a file to open; one without live evidence has neither.
        const live = ['Measured', 'Live run', 'Live read / plan'].includes(p.level);
        expect([s.id, p.recipe, Boolean(p.lastLive && p.path)]).toEqual([s.id, p.recipe, live]);
      }
    }
    const s9 = items.find(s => s.id === 'S9')!;
    expect(s9.proof.find(p => p.recipe === 'R12')).toMatchObject({ level: 'Live run', lastLive: '2026-10-12' });
    expect(s9.proof.find(p => p.recipe === 'R5')).toEqual({ recipe: 'R5', level: 'Mocked only' });
  });

  it('W1-P12 (CI check): no solution README proof row contradicts the evidence index', async () => {
    const { items } = await solutionsIndex(new RepoReader(REPO_ROOT));
    const drift = items.flatMap(s => s.proofDrift.map(d => `${s.id} ${d.claim.path} [${d.claim.where}] says ${d.recipe} ${d.says}; evidence: ${d.proof.level} ${d.proof.lastLive ?? ''} ${d.proof.path ?? ''}`));
    expect(drift).toEqual([]);
  });
});
