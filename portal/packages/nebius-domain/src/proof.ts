import type { EvidenceItem } from './api';
import { PROOF_LEVELS, ProofLevel, provenParts, RECIPES } from './repo';

/**
 * Proof from evidence (SA proposal 3, W1-P11–W1-P13): how far each recipe is proven is computed from the evidence
 * index (docs/evidence/), and a solution's hand-written proof rows are checked against it. Pure: the backend reads
 * the files, the pages and the CI test call these.
 */

/** What one run of this repository shows, in the README "What is proven" vocabulary. */
export type RunLevel = Extract<ProofLevel, 'Measured' | 'Live run' | 'Live read / plan'>;

/** A recipe's level from its evidence, or "Not measured" when nothing backs it. */
export type RecipeProofLevel = ProofLevel | 'Not measured';

export interface RecipeProof {
  recipe: string;
  level: RecipeProofLevel;
  /** Date of the newest live evidence file of the recipe (W1-P13); absent when there is none ("Not measured"). */
  lastLive?: string;
  /** That evidence file, to open. */
  path?: string;
  title?: string;
}

const PLAN_OR_READ = /\bmake plan\b|\baction=plan\b|\bplan only\b|\bno apply\b|\bnever applied\b|\bread-only\b/i;

/**
 * The level of one run of this repository: a figure judged against a pass bar (a clause of its evidence-index row
 * starts "Measured") is Measured; an apply of a live root is a Live run; a plan or a read-only call (`make plan`,
 * `action=plan`, "read-only" in its Kind header, Run column or title) is a Live read / plan; any other run of a
 * script (a paid request, an acceptance script) is a Live run. `text` is the Kind header, Run column and title.
 */
export function evidenceRunLevel(x: { proves?: string; liveRoot?: string; text?: string }): RunLevel {
  // A row may record several sessions of one file (2026-10-13: session 1, then a retry): any clause of it that starts
  // with "Measured" counts; "not measured" or a word that only starts with it never does.
  if (/(^|[.;:,]\s+)\W*Measured\b(?!ness)/.test(x.proves ?? '')) return 'Measured';
  if (x.liveRoot) return 'Live run';
  return PLAN_OR_READ.test(x.text ?? '') ? 'Live read / plan' : 'Live run';
}

const rank = (l: RecipeProofLevel) => (l === 'Not measured' ? PROOF_LEVELS.length : PROOF_LEVELS.indexOf(l));

/**
 * A recipe's proof from the evidence index: the strongest level of its live runs (`repo-live` rows naming it), with
 * the date and file of the newest one. With no live run it keeps the offline or mocked level of the README (which
 * no evidence file can back), and a README live level that no evidence file backs reads "Not measured".
 */
export function recipeProof(recipe: string, items: EvidenceItem[]): RecipeProof {
  const runs = items.filter(i => i.kind === 'repo-live' && i.level && (i.recipe === recipe || i.recipes?.includes(recipe)));
  if (!runs.length) {
    const readme = provenParts(RECIPES.find(r => r.id === recipe)?.provenToday ?? '').level;
    return { recipe, level: readme === 'Offline-ready' || readme === 'Mocked only' ? readme : 'Not measured' };
  }
  // A figure measured against a pass bar is the run's own recipe's: another recipe its file names (2026-10-13: R10's
  // plan in the R1 session) took part in a run, but was not measured by it.
  const own = (r: EvidenceItem): RecipeProofLevel => (r.level === 'Measured' && r.recipe !== recipe ? 'Live run' : r.level!);
  const level = runs.map(own).sort((a, b) => rank(a) - rank(b))[0];
  // The newest file; on the same day the recipe's own run, then the strongest.
  const newest = [...runs].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '') || Number(b.recipe === recipe) - Number(a.recipe === recipe) || rank(own(a)) - rank(own(b)))[0];
  return { recipe, level, ...(newest.date ? { lastLive: newest.date } : {}), ...(newest.path ? { path: newest.path } : {}), title: newest.title };
}

const RUN_LEVELS: RecipeProofLevel[] = ['Measured', 'Live run'];

/** A solution's derived status line from its recipes' proof: how many ran live, how many were only planned or read. */
export function proofSummary(proofs: RecipeProof[]): { text: string; tone: 'ok' | 'info' | 'neutral' } {
  if (!proofs.length) return { text: 'No recipe composed', tone: 'neutral' };
  const ran = proofs.filter(p => RUN_LEVELS.includes(p.level)).length;
  const planned = proofs.filter(p => p.level === 'Live read / plan').length;
  const text = `${ran} of ${proofs.length} recipe${proofs.length === 1 ? '' : 's'} run live${planned ? ` · ${planned} planned or read only` : ''}`;
  return { text, tone: ran === proofs.length ? 'ok' : ran ? 'info' : 'neutral' };
}

/** One hand-written proof row of a solution: where it is and its text. */
export interface ProofClaim {
  path: string;
  where: string;
  text: string;
}

/** A proof row that disagrees with the evidence index about one recipe. */
export interface ProofDrift {
  recipe: string;
  says: 'not run' | 'not measured';
  claim: ProofClaim;
  proof: RecipeProof;
}

const cells = (line: string) => {
  const t = line.trim();
  return t.startsWith('|') ? t.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim()) : [];
};
const plain = (s: string) => s.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[`*]/g, '').replace(/\s+/g, ' ').trim();

/**
 * A solution's proof rows: its Status cell in solutions/README.md, the Status row of its README's header table, and
 * every row of its "Proven vs not" section (section 10), as "claim: status".
 */
export function solutionProofClaims(id: string, indexStatus: string, readmePath: string, readme?: string): ProofClaim[] {
  const out: ProofClaim[] = [{ path: 'solutions/README.md', where: `solutions/README.md, ${id} Status`, text: plain(indexStatus) }];
  if (!readme) return out;
  let section = false;
  for (const line of readme.split('\n')) {
    if (/^##\s/.test(line)) section = /^##\s+(10\.?\s+)?Proven vs not\b/i.test(line);
    const c = cells(line);
    if (!section && c.length >= 2 && c[0] === 'Status') out.push({ path: readmePath, where: 'Status row', text: plain(c[1]) });
    if (section && c.length >= 2 && !/^-+$/.test(c[0]) && c[0] !== 'Claim') out.push({ path: readmePath, where: `Proven vs not: ${plain(c[0])}`, text: `${plain(c[0])}: ${plain(c[1])}` });
  }
  return out;
}

const NOT_RUN = /\b(not run|no live run|never run|not yet run|has no run|have no run)\b/i;
const NOT_MEASURED = /\b(not measured|never measured|no throughput measured|nothing measured)\b/i;

/**
 * Proof rows that the evidence index contradicts (W1-P12). Each row is read clause by clause (split on ";" and
 * sentence ends; a clause naming no recipe is about the recipes of the clause before it); a clause that names
 * recipes (`R<n>`) and says "not run" contradicts a recipe with a live run
 * (Live run or Measured: a plan is not a run), and one that says "not measured" contradicts a Measured recipe.
 */
export function proofDrift(claims: ProofClaim[], proof: (recipe: string) => RecipeProof): ProofDrift[] {
  const out: ProofDrift[] = [];
  for (const claim of claims) {
    let named: string[] = [];
    for (const clause of claim.text.split(/;|\.\s+/)) {
      // A clause that names no recipe continues the one before it ("R11 smoke test run once; no throughput measured").
      const own = [...new Set([...clause.matchAll(/\b(R\d{1,2})\b/g)].map(m => m[1]))];
      if (own.length) named = own;
      const says = NOT_RUN.test(clause) ? 'not run' : NOT_MEASURED.test(clause) ? 'not measured' : undefined;
      if (!says) continue;
      for (const recipe of named) {
        const p = proof(recipe);
        if (says === 'not run' ? RUN_LEVELS.includes(p.level) : p.level === 'Measured') out.push({ recipe, says, claim, proof: p });
      }
    }
  }
  return out;
}
