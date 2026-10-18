import type { EvidenceItem } from './api';
import { evidenceRunLevel, proofDrift, proofSummary, recipeProof, solutionProofClaims } from './proof';

const run = (id: string, recipe: string, date: string, level: EvidenceItem['level'], recipes?: string[]): EvidenceItem => ({
  id,
  kind: 'repo-live',
  title: id,
  path: `docs/evidence/${id}.md`,
  date,
  recipe,
  level,
  ...(recipes ? { recipes } : {}),
});

describe('what one live run shows (evidenceRunLevel)', () => {
  it('a figure judged against a pass bar is Measured; an apply is a Live run; a plan or a read is Live read / plan', () => {
    expect(evidenceRunLevel({ proves: 'Measured: 600/600 answered', liveRoot: undefined, text: 'tests/load/bench.sh' })).toBe('Measured');
    expect(evidenceRunLevel({ liveRoot: 'terraform/live/sandbox/data', text: 'run of this repository, plan and apply' })).toBe('Live run');
    expect(evidenceRunLevel({ text: 'run of this repository: `make plan` against the real API, never applied' })).toBe('Live read / plan');
    expect(evidenceRunLevel({ text: 'run of this repository (`.github/workflows/terraform.yml`, `action=plan`)' })).toBe('Live read / plan');
    expect(evidenceRunLevel({ text: 'R14 observability scripts, read-only against a real project' })).toBe('Live read / plan');
    // A paid request of a script is a run.
    expect(evidenceRunLevel({ text: 'run of this repository (`recipes/token-factory/smoke.py --yes`)' })).toBe('Live run');
  });

  it('a file of several sessions is Measured when a later session in its row is (the 2026-10-13 R1 retry)', () => {
    const r1 = 'session 1: one-SIGINT stop with state intact; apply stuck 59 min (R1-20). Retry: apply 8 min, 00–04 pass, Measured from the operator host via port-forward: 200/200 at 1, 8, 32 concurrent';
    expect(evidenceRunLevel({ proves: r1, liveRoot: 'terraform/live/sandbox/inference', text: 'run of this repository' })).toBe('Measured');
    // "not measured" anywhere in the row is not a claim of Measured.
    expect(evidenceRunLevel({ proves: 'apply and validate pass; throughput not measured. Measuredness pending', liveRoot: 'terraform/live/sandbox/inference' })).toBe('Live run');
    expect(evidenceRunLevel({ proves: 'Retry: apply only, Not measured', liveRoot: 'terraform/live/sandbox/inference' })).toBe('Live run');
  });
});

describe('a recipe proof roll-up (W1-P11, W1-P13)', () => {
  const items: EvidenceItem[] = [
    run('a', 'R12', '2026-10-11', 'Live run'),
    run('b', 'R12', '2026-10-12', 'Live run'),
    run('plans', 'R9', '2026-10-11', 'Live read / plan', ['R9', 'R7']),
    run('shared', 'R8', '2026-10-12', 'Live run', ['R8', 'R1']),
    run('bench', 'R11', '2026-10-12', 'Measured'),
    run('smoke', 'R11', '2026-10-11', 'Live run'),
    { id: 'todo:run:R5', kind: 'not-measured', title: 'R5: no run', recipe: 'R5' },
    { id: 'up', kind: 'upstream-live', title: 'prior', date: '2026-10-08' },
  ];

  it('takes the strongest level of the recipe\'s live evidence and its newest date and file', () => {
    expect(recipeProof('R12', items)).toEqual({ recipe: 'R12', level: 'Live run', lastLive: '2026-10-12', path: 'docs/evidence/b.md', title: 'b' });
    expect(recipeProof('R11', items)).toMatchObject({ level: 'Measured', lastLive: '2026-10-12', path: 'docs/evidence/bench.md' });
    expect(recipeProof('R7', items)).toMatchObject({ level: 'Live read / plan', lastLive: '2026-10-11', path: 'docs/evidence/plans.md' });
    expect(recipeProof('R1', items)).toMatchObject({ level: 'Live run', lastLive: '2026-10-12' });
  });

  it('a measurement belongs to the run\'s own recipe: another recipe the same file names (R10\'s plan in the R1 session) is not Measured by it', () => {
    const shared = [run('r1', 'R1', '2026-10-13', 'Measured', ['R1', 'R10'])];
    expect(recipeProof('R1', shared)).toMatchObject({ level: 'Measured', lastLive: '2026-10-13' });
    expect(recipeProof('R10', shared)).toMatchObject({ level: 'Live run', lastLive: '2026-10-13' });
  });

  it('a recipe with no live evidence keeps its offline or mocked level and reads "Not measured" for its last run, never blank', () => {
    expect(recipeProof('R5', items)).toEqual({ recipe: 'R5', level: 'Mocked only' }); // README: Mocked only
    expect(recipeProof('R16', items)).toEqual({ recipe: 'R16', level: 'Offline-ready' });
    // A recipe whose README claims a live level but has no live evidence file is not measured.
    expect(recipeProof('R10', items)).toEqual({ recipe: 'R10', level: 'Not measured' });
    expect(recipeProof('R99', items)).toEqual({ recipe: 'R99', level: 'Not measured' });
  });

  it('sums a solution\'s recipes into one derived status, never hand-written', () => {
    const proofs = ['R12', 'R7', 'R5', 'R11'].map(id => recipeProof(id, items));
    expect(proofSummary(proofs)).toEqual({ text: '2 of 4 recipes run live · 1 planned or read only', tone: 'info' });
    expect(proofSummary([recipeProof('R12', items)])).toEqual({ text: '1 of 1 recipe run live', tone: 'ok' });
    expect(proofSummary([recipeProof('R5', items)])).toEqual({ text: '0 of 1 recipe run live', tone: 'neutral' });
    expect(proofSummary([])).toEqual({ text: 'No recipe composed', tone: 'neutral' });
  });
});

describe('README proof rows against the evidence index (W1-P12)', () => {
  const items: EvidenceItem[] = [run('ml', 'R12', '2026-10-12', 'Live run'), run('data', 'R8', '2026-10-12', 'Live run'), run('bench', 'R11', '2026-10-12', 'Measured'), run('plans', 'R3', '2026-10-11', 'Live read / plan')];
  const proof = (id: string) => recipeProof(id, items);

  // The S9 and S1 rows as they stood on 2026-10-11 (fb08179).
  const s9 = [
    '| | |',
    '|---|---|',
    '| Status | designed to the Solution definition of done; **not deployed**; R5, R12 and R16 have no live run |',
    '| Dated | 2026-10-11. Prices are live calculator list prices |',
    '',
    '## 10. Proven vs not',
    '',
    '| Claim | Status | Evidence |',
    '|---|---|---|',
    '| R16 Kueue queues and topology placement | not run (static checks only) | [R16](x) |',
    '| R12 MLflow, registry pulls | not run (mocked tests) | [R12](y) |',
    '',
    '## Open questions',
    '',
    '| R12 outside the section | not run | — |',
  ].join('\n');

  it('reads the index Status, the README Status row and every row of section 10', () => {
    const claims = solutionProofClaims('S9', 'designed; R3, R5, R8, R12, R16 not run', 'solutions/S9-x/README.md', s9);
    expect(claims.map(c => c.where)).toEqual(['solutions/README.md, S9 Status', 'Status row', 'Proven vs not: R16 Kueue queues and topology placement', 'Proven vs not: R12 MLflow, registry pulls']);
    expect(claims[3].text).toBe('R12 MLflow, registry pulls: not run (mocked tests)');
  });

  it('flags a recipe said "not run" that has a live run, and one said "not measured" that is measured; a plan is not a run', () => {
    const claims = solutionProofClaims('S9', 'designed; R3, R5, R8, R12, R16 not run', 'solutions/S9-x/README.md', s9);
    const drift = proofDrift(claims, proof);
    expect(drift.map(d => `${d.claim.where} → ${d.recipe} ${d.says}`)).toEqual([
      'solutions/README.md, S9 Status → R8 not run',
      'solutions/README.md, S9 Status → R12 not run',
      'Status row → R12 not run',
      'Proven vs not: R12 MLflow, registry pulls → R12 not run',
    ]);
    expect(drift[0].proof).toMatchObject({ level: 'Live run', lastLive: '2026-10-12', path: 'docs/evidence/data.md' });
    // S3: "no throughput measured" for R11, which is Measured.
    const s3 = proofDrift(solutionProofClaims('S3', 'designed; one smoke request proven', 'solutions/S3-x/README.md', '| Status | designed; R11 smoke test run once (one request); no throughput measured |'), proof);
    expect(s3.map(d => `${d.claim.where} → ${d.recipe} ${d.says}`)).toEqual(['Status row → R11 not measured']);
    // Reconciled rows agree; a row that says what is still open about a recipe that ran is not drift.
    const ok = solutionProofClaims('S9', 'designed; R12 and R8 run live; R5 and R16 not run', 'solutions/S9-x/README.md', '| Status | designed; **not deployed**; R5 and R16 have no live run; R1 throughput not measured |');
    expect(proofDrift(ok, proof)).toEqual([]);
  });
});
