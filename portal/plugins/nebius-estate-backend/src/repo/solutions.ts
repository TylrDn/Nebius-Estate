import {
  parseSolutionFootprint,
  parseSolutionsIndex,
  proofDrift,
  recipeProof,
  SOLUTION_DEFAULT_STATUS,
  solutionProofClaims,
  SolutionsResponse,
  SolutionView,
  solutionStatusFromReadme,
} from '@internal/nebius-domain';
import { evidenceIndex } from './evidence';
import { RepoReader } from './RepoReader';

/**
 * The solutions (S1–S9) as this checkout has them: the index table of solutions/README.md, whether
 * each README is present, and each footprint file mapped onto a live-price footprint. Read-only; a
 * missing or malformed file is reported on its row, never as a failure of the whole list.
 */
export async function solutionsIndex(repo: RepoReader): Promise<SolutionsResponse> {
  let index: string;
  try {
    index = await repo.read('solutions/README.md');
  } catch {
    return { items: [], unavailableReason: 'solutions/README.md is not in this checkout.' };
  }
  const items: SolutionView[] = [];
  // Proof is computed from the evidence index (W1-P11); without it every recipe reads as not measured.
  const evidence = await evidenceIndex(repo).catch(() => []);
  for (const row of parseSolutionsIndex(index)) {
    const readmeAvailable = await repo.exists(row.readme);
    const readme = readmeAvailable ? await repo.read(row.readme).catch(() => undefined) : undefined;
    // The index row's status first; a row without one takes the README's Status line, else the default.
    const status = row.status !== SOLUTION_DEFAULT_STATUS ? row.status : (readme ? solutionStatusFromReadme(readme) : undefined) ?? row.status;
    const proof = [...new Set(row.recipes.map(r => r.id))].map(id => recipeProof(id, evidence));
    const drift = proofDrift(solutionProofClaims(row.id, row.status, row.readme, readme), id => proof.find(p => p.recipe === id) ?? recipeProof(id, evidence));
    const files = await repo.footprints(row.dir).catch(() => []);
    const footprints = await Promise.all(
      files.map(async f => {
        try {
          return parseSolutionFootprint(await repo.read(f), f);
        } catch (e) {
          return { path: f, capacityTypes: [], notes: [], error: `not readable: ${(e as Error).message}` };
        }
      }),
    );
    items.push({ ...row, status, readmeAvailable, footprints, proof, proofDrift: drift });
  }
  return { items };
}
