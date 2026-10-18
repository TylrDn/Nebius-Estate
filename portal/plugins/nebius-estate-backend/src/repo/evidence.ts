import { evidenceRunLevel, EvidenceItem, RECIPES, RunbookItem } from '@internal/nebius-domain';
import { RepoReader } from './RepoReader';

/**
 * Builds the evidence index from the repository itself. Documentation claims
 * are never turned into health checks: each item says what kind of evidence
 * it is, when, how, and what it does NOT show.
 */

/**
 * Reads a `- **Name:** value` header bullet (value may wrap onto indented
 * lines) and returns it as plain text. `names` are alternatives.
 */
export function headerField(md: string, ...names: string[]): string | undefined {
  const lines = md.split('\n');
  for (let i = 0; i < lines.length; i++) {
    // `- **Name:** value` or the plain `- Name: value` some evidence files use.
    const m = /^-\s+\*\*([^*]+?):?\*\*:?\s*(.*)$/.exec(lines[i]) ?? /^-\s+([A-Z][A-Za-z /]{1,40}):\s+(.*)$/.exec(lines[i]);
    if (!m || !names.some(n => m[1].trim().toLowerCase() === n.toLowerCase())) continue;
    const parts = [m[2]];
    for (let j = i + 1; j < lines.length && /^\s{2,}\S/.test(lines[j]); j++) parts.push(lines[j].trim());
    return plain(parts.join(' '));
  }
  return undefined;
}

/**
 * Markdown inline syntax removed. Code spans keep their content as written (a glob such as `platform/alerts/*.yaml`
 * keeps its star, G5.8); emphasis is removed only in pairs, so a lone `*` stays.
 */
function plain(s: string): string {
  const code: string[] = [];
  return s
    .replace(/`([^`]*)`/g, (_, c: string) => `\uE000${code.push(c) - 1}\uE000`)
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\*\*([^*]+?)\*\*/g, '$1')
    .replace(/(^|[^*\w])\*([^*\s](?:[^*]*?[^*\s])?)\*(?!\w)/g, '$1$2')
    // _emphasis_ / __strong__ at word boundaries (snake_case identifiers keep their underscores).
    .replace(/(^|[\s(])_{1,2}([^_\s][^_]*?)_{1,2}(?=$|[\s).,;:!?])/g, '$1$2')
    .replace(/\uE000(\d+)\uE000/g, (_, i: string) => code[Number(i)])
    .replace(/\s+/g, ' ')
    .trim();
}

function firstHeading(md: string): string | undefined {
  return /^#\s+(.+)$/m.exec(md)?.[1]?.trim();
}

const LIST_ITEM = /^([-*+]|\d+[.)])\s/;

/** At most `max` characters, cut after a sentence when one ends late enough, else on a word, with "…". */
function clip(text: string, max = 400): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const sentence = Math.max(head.lastIndexOf('. '), head.lastIndexOf('; '));
  if (sentence >= max / 2) return `${head.slice(0, sentence + 1).replace(/;$/, '')}…`;
  const word = head.lastIndexOf(' ');
  return `${head.slice(0, word > 0 ? word : max).replace(/[,;:]$/, '')}…`;
}

/**
 * The first prose paragraph as plain text (inline Markdown removed), at most 400 characters, cut on a word.
 * Leading header bullets (`- **Status:** …`) are skipped with their indented continuation lines (G5.8), fenced
 * code is skipped, and a list after the paragraph has started ends it. Prose that follows a code block in the same
 * section is a note on that code ("Record in docs/evidence/: …"), not a summary, and is skipped up to the next
 * heading (#73). A document with no prose paragraph (a numbered checklist) falls back to the first sentence of its
 * first list item that is not a command, i.e. does not open with a code span (#9), then to its first sub-heading.
 */
export function firstParagraph(md: string): string {
  const out: string[] = [];
  /** The list item being read: its lines, or null for one that is not a summary (header bullet, command). */
  let item: string[] | null | undefined;
  let firstItem: string[] | undefined;
  let subHeading: string | undefined;
  let started = false;
  let inFence = false;
  let afterCode = false;
  const closeItem = () => {
    if (item && !firstItem) firstItem = item;
    item = undefined;
  };
  for (const l of md.split('\n')) {
    const t = l.trim();
    if (t.startsWith('```') || t.startsWith('~~~')) {
      if (started) break;
      inFence = !inFence;
      if (!inFence) afterCode = true;
      closeItem();
      continue;
    }
    if (inFence) continue;
    if (l.startsWith('#') || !t) {
      if (started) break;
      if (l.startsWith('#')) {
        afterCode = false;
        if (/^#{2,6}\s/.test(l)) subHeading ??= l.replace(/^#+\s+/, '');
      }
      closeItem();
      continue;
    }
    if (!started) {
      if (LIST_ITEM.test(t)) {
        closeItem();
        const text = t.replace(LIST_ITEM, '');
        item = /^[-*+]\s+\*\*[^*]+:\*\*/.test(t) || text.startsWith('`') ? null : [text];
        continue;
      }
      if (item !== undefined && /^\s{2,}\S/.test(l)) {
        item?.push(t);
        continue;
      }
      if (/^[|>]/.test(t) || afterCode) continue;
    } else if (LIST_ITEM.test(t)) {
      break;
    }
    closeItem();
    started = true;
    out.push(t);
  }
  closeItem();
  if (out.length) return clip(plain(out.join(' ')));
  if (firstItem) return clip(firstSentence(plain(firstItem.join(' '))));
  return clip(plain(subHeading ?? ''));
}

/** The first sentence of a text: up to the first `.`, `!` or `?` that a capitalised word follows. */
function firstSentence(text: string): string {
  return /^(.+?[.!?])\s+(?=[A-Z])/.exec(text)?.[1] ?? text;
}

/** The first paragraph under a `## <name>` heading (an ADR's Context), else the document's first paragraph. */
export function sectionParagraph(md: string, name: string): string {
  const m = new RegExp(`^##\\s+${name}\\s*$`, 'm').exec(md);
  return (m ? firstParagraph(md.slice(m.index + m[0].length)) : '') || firstParagraph(md);
}

/** Rows of the "File | Kind | Run | Proves" table in docs/evidence/README.md. */
function evidenceTable(readme: string): Map<string, { kind: string; run: string; proves: string }> {
  const out = new Map<string, { kind: string; run: string; proves: string }>();
  for (const line of readme.split('\n')) {
    // The closing pipe is optional in GFM: a row without it still counts.
    const m = /^\|\s*\[`([^`]+)`\]\(([^)]+)\)\s*\|\s*([^|]+)\|\s*([^|]+)\|\s*([^|]+?)\s*(?:\||$)/.exec(line);
    if (m) out.set(m[2].trim(), { kind: m[3].trim(), run: m[4].trim(), proves: m[5].trim() });
  }
  return out;
}

const STATIC_CHECKS: { title: string; method: string }[] = [
  { title: 'Pinned toolbox: every check runs in one image', method: 'make ci-docker (tools/toolbox; versions and sha256 sums from platform/versions.yaml)' },
  { title: 'Every image, action and script default is pinned', method: 'make pins (scripts/pins.py check)' },
  { title: 'terraform fmt / validate (every root)', method: 'make ci → fmt-check, validate' },
  { title: 'Rendered live roots are current', method: 'make render-live-check (scripts/render-live-roots.py --check)' },
  { title: 'tflint (recommended preset)', method: 'make lint' },
  { title: 'Stage policy, prod sizing and allowlists (conftest / OPA)', method: 'make policy over platform/stages.yaml and every sizing file' },
  { title: 'Kustomize builds', method: 'make kustomize' },
  { title: 'Shell scripts', method: 'make shellcheck' },
  { title: 'NCCL log parser self-test (fixtures)', method: 'make selftest' },
  { title: 'Secrets and IaC scanning', method: 'make scan (gitleaks over history, Trivy config scan)' },
  { title: 'Markdown links', method: 'make links (lychee)' },
  { title: 'Portal typecheck, lint, config schema, unit tests, build', method: 'CI portal job (make portal-build portal-test); Playwright + axe: make portal-e2e' },
  { title: 'Soperator recipe at the pinned tag', method: 'make soperator-check (validate + mocked plan per stage, Terraform ≥ 1.12)' },
];

const NOT_MEASURED: { title: string; recipe: string; limitations: string }[] = [
  { title: 'Multi-node InfiniBand bandwidth (NCCL busbw, 2 × 8 GPUs)', recipe: 'R3', limitations: 'No run of the training stack with GPU nodes; single-GPU NCCL init only (prior upstream run).' },
  { title: 'Serving throughput / latency of this repository\'s defaults', recipe: 'R1', limitations: 'tests/load method exists; no results committed.' },
  { title: 'Serverless endpoint vs. Kubernetes comparison figures', recipe: 'R6', limitations: 'Only that the comparison ran (prior run log); figures not in the repository.' },
  { title: 'Rollback drill and backup restore on a real cluster', recipe: 'R2', limitations: 'docs/security.md: "not yet demonstrated on a real cluster".' },
];

/**
 * The live root a run of this repository applied, from its Kind header: `terraform/live/<stage>/<stack>`, or a
 * single-segment root such as `terraform/live/foundation` (G5.7).
 */
export function liveRootOf(kindHeader: string | undefined): string | undefined {
  return /\bterraform\/live\/[a-z0-9-]+(?:\/[a-z0-9-]+)?\b/.exec(kindHeader ?? '')?.[0];
}

/** Single-segment live roots and the recipe that owns them: the foundation is R2 (Foundation & lifecycle). */
const ROOT_RECIPES: Record<string, string> = { 'terraform/live/foundation': 'R2' };

/** The recipe a live root belongs to: its stack's recipe, or the owner of a single-segment root. */
function recipeOfRoot(liveRoot: string | undefined): string | undefined {
  if (!liveRoot) return undefined;
  if (ROOT_RECIPES[liveRoot]) return ROOT_RECIPES[liveRoot];
  const stack = liveRoot.split('/')[3];
  return stack ? RECIPES.find(r => r.stack === stack)?.id : undefined;
}

const recipeIds = (text: string | undefined) => [...new Set([...(text ?? '').matchAll(/\b(R\d{1,2})\b/g)].map(m => m[1]))].filter(id => RECIPES.some(r => r.id === id));

/**
 * The recipe a run belongs to: an `R<n>` in the README's Run column, else one in the file's heading (G5.10), else
 * the recipe of its live root.
 */
export function recipeOfRun(run: string | undefined, liveRoot: string | undefined, heading?: string): string | undefined {
  return recipeIds(run)[0] ?? recipeIds(heading)[0] ?? recipeOfRoot(liveRoot);
}

/** Every recipe a run covers: the `R<n>`s of its Run column (else its heading), plus its live root's recipe. */
export function recipesOfRun(run: string | undefined, liveRoot: string | undefined, heading?: string): string[] {
  const named = recipeIds(run).length ? recipeIds(run) : recipeIds(heading);
  const root = recipeOfRoot(liveRoot);
  if (!named.length) return root ? [root] : [];
  // A single-segment root's owner is added (the foundation apply backs R2 as well as R13); a stack root's recipe
  // is already the one the row names.
  return root && liveRoot && ROOT_RECIPES[liveRoot] && !named.includes(root) ? [...named, root] : named;
}

export async function evidenceIndex(repo: RepoReader): Promise<EvidenceItem[]> {
  const items: EvidenceItem[] = [];
  const readme = await repo.read('docs/evidence/README.md');
  const table = evidenceTable(readme);

  for (const path of await repo.list('docs/evidence')) {
    const name = path.slice('docs/evidence/'.length);
    if (name === 'README.md') continue;
    const md = await repo.read(path);
    const row = table.get(name);
    const kindText = (headerField(md, 'Kind') ?? row?.kind ?? '').toLowerCase();
    const dateRegion = headerField(md, 'Date / region / platform', 'Date / region');
    const isRepoRun = (kindText.includes('run of this repository') || row?.kind.toLowerCase() === 'this repository') && !kindText.includes('prior');
    const liveRoot = isRepoRun ? liveRootOf(headerField(md, 'Kind')) : undefined;
    const heading = firstHeading(md);
    const recipes = isRepoRun ? recipesOfRun(row?.run, liveRoot, heading) : [];
    items.push({
      id: `evidence:${name}`,
      kind: isRepoRun ? 'repo-live' : 'upstream-live',
      title: heading ?? name,
      path,
      date: /^(\d{4}-\d{2}-\d{2})/.exec(name)?.[1],
      region: /\b((?:eu|uk|us|me)-[a-z]+\d)\b/.exec(dateRegion ?? '')?.[1],
      versions: headerField(md, 'Versions observed', 'Versions', 'Platform / versions'),
      method: headerField(md, 'Method', 'Source'),
      cost: headerField(md, 'Cost'),
      limitations: headerField(md, 'Caveats', 'Limitations') ?? headerField(md, 'Kind'),
      proves: row ? plain(row.proves) : undefined,
      liveRoot,
      recipe: isRepoRun ? recipeOfRun(row?.run, liveRoot, heading) : undefined,
      ...(recipes.length > 1 ? { recipes } : {}),
      // What the run shows (W1-P11): measured, a run, or a read / plan, from its index row, Kind header and title.
      ...(isRepoRun ? { level: evidenceRunLevel({ proves: row ? plain(row.proves) : undefined, liveRoot, text: [headerField(md, 'Kind'), row?.run, heading].filter(Boolean).join(' ') }) } : {}),
    });
  }
  // Which live roots ran is read from the evidence files; nothing here says "none yet" by hand.
  const applied = [...new Set(items.map(i => i.liveRoot).filter((x): x is string => !!x))].sort();
  items.push({
    id: 'todo:live-roots',
    kind: 'not-measured',
    title: applied.length ? 'A full apply of every live root of this repository' : "Any live apply of this repository's own roots",
    recipe: 'R2',
    limitations: applied.length
      ? `Applied so far (docs/evidence): ${applied.map(r => r.replace(/^terraform\/live\//, '')).join(', ')}; every other root is plan-tested only.`
      : 'No evidence file records an apply of a terraform/live root yet.',
  });

  for (const t of await repo.planTests()) {
    items.push({
      id: `plan-test:${t}`,
      kind: 'mocked-plan-test',
      title: t.replace(/^terraform\//, '').replace(/\/tests\/.*/, ''),
      path: t,
      method: 'terraform test with mocked providers (plan only); make test',
      limitations: 'Proves plan-time logic and policy wiring; nothing was created.',
    });
  }
  for (const s of STATIC_CHECKS) {
    items.push({ id: `static:${s.title}`, kind: 'static-validation', title: s.title, method: s.method, limitations: 'Static: no credentials, no cloud calls.' });
  }
  for (const n of NOT_MEASURED) {
    items.push({ id: `todo:${n.title}`, kind: 'not-measured', title: n.title, recipe: n.recipe, limitations: n.limitations });
  }
  // Every recipe with no row of its own yet gets one: nothing reads as proven by omission.
  const covered = new Set(items.flatMap(i => [i.recipe, ...(i.recipes ?? [])]).filter(Boolean));
  for (const r of RECIPES.filter(x => !covered.has(x.id))) {
    items.push({
      id: `todo:run:${r.id}`,
      kind: 'not-measured',
      title: `${r.id} ${r.title}: no run of this repository yet`,
      recipe: r.id,
      limitations: `Proven today: ${r.provenToday}. No evidence file in docs/evidence/ records a run of it.`,
    });
  }
  return items;
}

export async function runbookIndex(repo: RepoReader): Promise<RunbookItem[]> {
  const out: RunbookItem[] = [];
  for (const path of await repo.list('runbooks')) {
    const md = await repo.read(path);
    const name = path.slice('runbooks/'.length, -3);
    out.push({ id: name, title: firstHeading(md) ?? name, path, summary: firstParagraph(md) });
  }
  return out;
}

export async function decisionIndex(repo: RepoReader): Promise<RunbookItem[]> {
  const out: RunbookItem[] = [];
  for (const path of await repo.list('docs/decisions')) {
    if (path.endsWith('README.md') || path.endsWith('0000-template.md')) continue;
    const md = await repo.read(path);
    // An ADR's summary is its Context (the header bullets above it are status and dated notes, G5.8).
    out.push({ id: path, title: firstHeading(md) ?? path, path, summary: sectionParagraph(md, 'Context') });
  }
  return out;
}
