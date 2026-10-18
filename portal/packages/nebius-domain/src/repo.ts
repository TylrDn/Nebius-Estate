import { isMap, isScalar, parseDocument } from 'yaml';
import { z } from 'zod';

/**
 * Desired configuration as the repository declares it. Parsers take file
 * text, not paths: the backend decides which files may be read.
 *
 * Authoritative sources (see docs/portal/architecture.md):
 *   platform/stages.yaml    stage policy, enforced at plan time by the stacks
 *   platform/regions.yaml   region → GPU platform → presets, fabrics
 *   platform/versions.yaml  every pinned version
 *   terraform/live/<stage>/<stack>/<stage>.auto.tfvars   per-stage sizing (rendered roots; soperator: stage.tfvars)
 */

/**
 * Stacks with a live root per stage (terraform/live/<stage>/<stack>). Only inference, training and
 * soperator have provisioning forms; the others are shown read-only (sizing, plan tests, desired state).
 * R15 (nvl) has no live root: no stage may plan a rack until a reservation is approved.
 */
export const STACKS = ['inference', 'training', 'soperator', 'network', 'data', 'gpu-vm', 'ml-services', 'governance'] as const;
export type Stack = (typeof STACKS)[number];

/* ------------------------------------------------------------- stages.yaml */

/** `gpu-vm` (R10) and `nvl` (R15) caps are newer keys; a stages file without them still parses. */
const perStack = z.object({ inference: z.number().int(), training: z.number().int(), 'gpu-vm': z.number().int().optional(), nvl: z.number().int().optional() });
const perStackBool = z.object({ inference: z.boolean(), training: z.boolean(), nvl: z.boolean().optional() });

export const stagePolicySchema = z.object({
  etcd_cluster_size: z.number().int(),
  public_endpoint: z.boolean(),
  require_ttl_label: z.boolean(),
  allow_preemptible_serving: z.boolean(),
  forbid_deletion: z.boolean(),
  max_gpu_nodes: perStack,
  k8s_version_offset: z.number().int(),
  k8s_version_pinned: z.boolean(),
  audit_logs: z.boolean(),
  alertmanager: z.boolean(),
  require_allowed_cidrs: z.boolean(),
  require_strict_reservation: perStackBool,
});
export type StagePolicy = z.infer<typeof stagePolicySchema>;

export const stagesFileSchema = z.object({
  stages: z.record(
    z.string(),
    z.object({ description: z.string(), policy: stagePolicySchema }),
  ),
  promotion: z.array(z.object({ from: z.string(), to: z.string(), requires: z.string() })),
});
export type StagesFile = z.infer<typeof stagesFileSchema>;

/* ------------------------------------------------------------ regions.yaml */

export const platformEntrySchema = z.object({
  single_gpu_preset: z.string().optional(),
  ib_preset: z.string().optional(),
  drivers_preset: z.string().optional(),
  operator_driver_version: z.string().optional(),
  fabric: z.string().optional(),
  fabrics: z.array(z.string()).optional(),
});

export const regionsFileSchema = z.object({
  regions: z.record(
    z.string(),
    z.object({
      note: z.string().optional(),
      default: z.string(),
      platforms: z.record(z.string(), platformEntrySchema),
    }),
  ),
  kubernetes_versions: z.array(z.string()),
});
export type RegionsFile = z.infer<typeof regionsFileSchema>;

/* ----------------------------------------------------------- versions.yaml */

export interface PinnedVersion {
  path: string;
  version?: string;
  value?: string;
  source?: string;
  verified?: string;
  note?: string;
}

export interface ParseWarning {
  file: string;
  message: string;
}

export interface ParseResult<T> {
  value: T;
  warnings: ParseWarning[];
}

/**
 * Parses YAML keeping duplicate top-level mapping keys: their contents are
 * merged (later keys win inside the merged map) and each duplicate is
 * reported, where a plain YAML load would silently keep only the last block.
 */
export function parseYamlMergingDuplicates(text: string, file: string): ParseResult<Record<string, unknown>> {
  const doc = parseDocument(text, { uniqueKeys: false });
  const warnings: ParseWarning[] = doc.errors.map(e => ({ file, message: e.message }));
  const out: Record<string, unknown> = {};
  if (!isMap(doc.contents)) return { value: (doc.toJS() ?? {}) as Record<string, unknown>, warnings };
  for (const pair of doc.contents.items) {
    const key = isScalar(pair.key) ? String(pair.key.value) : String(pair.key);
    const value = (pair.value as { toJSON?: () => unknown } | null)?.toJSON?.() ?? (isScalar(pair.value) ? pair.value.value : pair.value);
    if (key in out) {
      warnings.push({
        file,
        message: `duplicate top-level key "${key}": blocks merged; a standard YAML parser keeps only the last one`,
      });
      const prev = out[key];
      out[key] =
        prev && typeof prev === 'object' && value && typeof value === 'object'
          ? { ...(prev as object), ...(value as object) }
          : value;
    } else {
      out[key] = value;
    }
  }
  return { value: out, warnings };
}

export function parseStages(text: string): ParseResult<StagesFile> {
  const { value, warnings } = parseYamlMergingDuplicates(text, 'platform/stages.yaml');
  return { value: stagesFileSchema.parse(value), warnings };
}

export function parseRegions(text: string): ParseResult<RegionsFile> {
  const { value, warnings } = parseYamlMergingDuplicates(text, 'platform/regions.yaml');
  return { value: regionsFileSchema.parse(value), warnings };
}

export function parseVersions(text: string): ParseResult<PinnedVersion[]> {
  const { value, warnings } = parseYamlMergingDuplicates(text, 'platform/versions.yaml');
  const out: PinnedVersion[] = [];
  const walk = (node: unknown, path: string[]) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    const rec = node as Record<string, unknown>;
    const leafKeys = ['version', 'value', 'ref', 'install'];
    if (leafKeys.some(k => typeof rec[k] === 'string')) {
      out.push({
        path: path.join(' / '),
        version: str(rec.version) ?? str(rec.ref) ?? str(rec.tag),
        value: str(rec.value) ?? str(rec.install),
        source: str(rec.source),
        verified: str(rec.verified),
        note: str(rec.note),
      });
      return;
    }
    for (const [k, v] of Object.entries(rec)) walk(v, [...path, k]);
  };
  walk(value, []);
  return { value: out, warnings };
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/* ------------------------------------------------------------------ tfvars */

export type TfvarValue =
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'complex'; raw: string };

export interface TfvarEntry {
  key: string;
  value: TfvarValue;
  line: number;
  comment?: string;
}

const ASSIGN = /^([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(.*)$/;

/**
 * Reads the top-level assignments of a hand-maintained tfvars file. Only
 * single-line scalars are interpreted; maps, lists and multi-line values are
 * kept raw (kind "complex") and are never rewritten by the portal.
 */
export function parseTfvars(text: string): TfvarEntry[] {
  const lines = text.split('\n');
  const out: TfvarEntry[] = [];
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (depth > 0) {
      depth += bracketDelta(trimmed);
      continue;
    }
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) continue;
    const m = ASSIGN.exec(trimmed);
    if (!m) continue;
    const [, key, rest] = m;
    const { body, comment } = splitComment(rest);
    const delta = bracketDelta(body);
    if (delta > 0 || /^[[{]/.test(body)) {
      depth = Math.max(0, delta);
      out.push({ key, value: { kind: 'complex', raw: body }, line: i + 1, comment });
      continue;
    }
    out.push({ key, value: parseScalar(body), line: i + 1, comment });
  }
  return out;
}

function bracketDelta(s: string): number {
  let d = 0;
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"' && s[i - 1] !== '\\') inStr = !inStr;
    if (inStr) continue;
    if (c === '#') break;
    if (c === '{' || c === '[') d++;
    if (c === '}' || c === ']') d--;
  }
  return d;
}

function commentIndex(rest: string): number {
  let inStr = false;
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i];
    if (c === '"' && rest[i - 1] !== '\\') inStr = !inStr;
    if (!inStr && c === '#') return i;
  }
  return -1;
}

function splitComment(rest: string): { body: string; comment?: string } {
  let inStr = false;
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i];
    if (c === '"' && rest[i - 1] !== '\\') inStr = !inStr;
    if (!inStr && c === '#') {
      return { body: rest.slice(0, i).trim(), comment: rest.slice(i + 1).trim() };
    }
  }
  return { body: rest.trim() };
}

function parseScalar(body: string): TfvarValue {
  if (body === 'true' || body === 'false') return { kind: 'bool', value: body === 'true' };
  if (body === 'null') return { kind: 'null' };
  if (/^-?\d+(\.\d+)?$/.test(body)) return { kind: 'number', value: Number(body) };
  const s = /^"((?:[^"\\]|\\.)*)"$/.exec(body);
  if (s) return { kind: 'string', value: s[1].replace(/\\"/g, '"') };
  return { kind: 'complex', raw: body };
}

export function tfvarsToRecord(entries: TfvarEntry[]): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const e of entries) {
    switch (e.value.kind) {
      case 'string':
      case 'number':
      case 'bool':
        out[e.key] = e.value.value;
        break;
      case 'null':
        out[e.key] = null;
        break;
      default:
        out[e.key] = e.value.raw;
    }
  }
  return out;
}

export type ScalarEdit = string | number | boolean;

export function renderScalar(v: ScalarEdit): string {
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('non-finite number');
    return String(v);
  }
  if (!/^[A-Za-z0-9_.:\-/ ]*$/.test(v)) {
    throw new Error(`refusing to write string value with unsupported characters: ${JSON.stringify(v)}`);
  }
  return `"${v}"`;
}

/**
 * Sets single-line scalar assignments, preserving surrounding lines and an
 * existing trailing comment. Keys that are absent are appended in a marked
 * block. Refuses to touch complex (map/list/multi-line) values.
 */
export function setTfvars(text: string, edits: Record<string, ScalarEdit>, appendNote?: string): string {
  const entries = parseTfvars(text);
  const lines = text.split('\n');
  const appended: string[] = [];
  for (const [key, value] of Object.entries(edits)) {
    if (!/^[a-z_][a-z0-9_]*$/.test(key)) throw new Error(`invalid tfvars key ${key}`);
    const rendered = renderScalar(value);
    const existing = entries.find(e => e.key === key);
    if (existing) {
      if (existing.value.kind === 'complex') throw new Error(`refusing to rewrite complex value of ${key}`);
      const idx = existing.line - 1;
      const original = lines[idx];
      const eq = original.indexOf('=');
      const head = original.slice(0, eq + 1);
      const rest = original.slice(eq + 1);
      const hash = commentIndex(rest);
      const valuePart = hash === -1 ? rest : rest.slice(0, hash);
      const lead = /^\s*/.exec(valuePart)?.[0] || ' ';
      const oldValue = valuePart.trim();
      const trail = valuePart.length - lead.length - oldValue.length;
      // Keep a trailing comment in the same column (terraform fmt leaves it alone).
      const gap = ' '.repeat(Math.max(1, trail + oldValue.length - rendered.length));
      lines[idx] = hash === -1 ? `${head}${lead}${rendered}` : `${head}${lead}${rendered}${gap}${rest.slice(hash)}`;
    } else {
      appended.push(`${key} = ${rendered}`);
    }
  }
  if (appended.length) {
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    lines.push('', `# ${appendNote ?? 'Added by a Nebius Estate provisioning request'}`, ...appended, '');
  }
  return lines.join('\n');
}

/* -------------------------------------------------------------- unified diff */

/** Minimal unified diff (LCS) for small configuration files. */
export function unifiedDiff(oldText: string, newText: string, path: string, context = 3): string {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  type Op = { t: ' ' | '-' | '+'; s: string; ai: number; bi: number };
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ t: ' ', s: a[i], ai: i, bi: j });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      ops.push({ t: '-', s: a[i], ai: i, bi: j });
      i++;
    } else {
      ops.push({ t: '+', s: b[j], ai: i, bi: j });
      j++;
    }
  }
  while (i < n) ops.push({ t: '-', s: a[i], ai: i++, bi: j });
  while (j < m) ops.push({ t: '+', s: b[j], ai: i, bi: j++ });

  const changed = ops.map((o, k) => (o.t !== ' ' ? k : -1)).filter(k => k >= 0);
  if (!changed.length) return '';
  const hunks: [number, number][] = [];
  for (const k of changed) {
    const start = Math.max(0, k - context);
    const end = Math.min(ops.length - 1, k + context);
    const last = hunks[hunks.length - 1];
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else hunks.push([start, end]);
  }
  const out = [`--- a/${path}`, `+++ b/${path}`];
  for (const [s, e] of hunks) {
    const slice = ops.slice(s, e + 1);
    const aStart = slice[0].ai + 1;
    const bStart = slice[0].bi + 1;
    const aLen = slice.filter(o => o.t !== '+').length;
    const bLen = slice.filter(o => o.t !== '-').length;
    out.push(`@@ -${aLen ? aStart : aStart - 1},${aLen} +${bLen ? bStart : bStart - 1},${bLen} @@`);
    for (const o of slice) out.push(`${o.t}${o.s}`);
  }
  return `${out.join('\n')}\n`;
}

/* -------------------------------------------------------- repository model */

export interface LiveRoot {
  stage: string;
  stack: Stack;
  path: string;
  /** Sizing file relative to the repository root. */
  sizingFile: string;
  sizing: Record<string, string | number | boolean | null>;
  /** Mocked plan tests present (terraform test), not an apply. */
  hasPlanTests: boolean;
  /** Regions the root's runs target: those of the run profiles for its stack and stage (platform/profiles/<stack>/*.json). */
  runRegions?: string[];
  /**
   * The run profiles for its stack and stage: name (file name), region and the `vars` that override the sizing
   * file when the run is planned with PROFILE=<name> (G2.2). Only scalar vars are kept.
   */
  runProfiles?: RunProfile[];
}

/** A run profile of a live root (platform/profiles/<stack>/<name>.json). */
export interface RunProfile {
  name: string;
  region: string;
  vars: Record<string, string | number | boolean | null>;
  description?: string;
}

/**
 * How the portal offers a recipe: `form` — a provisioning form (R1, R3, R4); `live-root` — a
 * Terraform stack with tfvars-driven live roots, shown read-only (sizing, plan tests, desired-state
 * links); `documentation` — its README and runbooks only.
 */
export type RecipeProvisioning = 'form' | 'live-root' | 'documentation';

export interface RecipeSummary {
  id: string;
  title: string;
  /** The stack of its live roots (terraform/live/<stage>/<stack>), when it has any. */
  stack?: Stack;
  path: string;
  docs: string;
  /** Further READMEs of a recipe that spans two places (R9: recipes/finance + the governance stack). */
  moreDocs?: string[];
  runbooks: string[];
  provenToday: string;
  provisioning: RecipeProvisioning;
  /** Key of `max_gpu_nodes` in platform/stages.yaml that caps it (R10 `gpu-vm`, R15 `nvl`). */
  capKey?: 'gpu-vm' | 'nvl';
}

/** The README "Pick a recipe" table, as structured data. */
/** The proof levels of the README "What is proven" table, strongest first; every `provenToday` starts with one. */
export const PROOF_LEVELS = ['Measured', 'Live run', 'Live read / plan', 'Offline-ready', 'Mocked only'] as const;
export type ProofLevel = (typeof PROOF_LEVELS)[number];

/** Splits a recipe's `provenToday` into its README proof level and the detail after it. */
export function provenParts(text: string): { level: ProofLevel | null; detail: string } {
  const level = PROOF_LEVELS.find(l => text.startsWith(`${l}: `));
  return level ? { level, detail: text.slice(level.length + 2) } : { level: null, detail: text };
}

export const RECIPES: RecipeSummary[] = [
  { id: 'R1', title: 'Kubernetes inference', stack: 'inference', provisioning: 'form', path: 'terraform/stacks/inference', docs: 'terraform/stacks/inference/README.md', runbooks: ['runbooks/deploy.md', 'runbooks/rollback.md', 'runbooks/incident.md'], provenToday: 'Measured: 2026-10-13 sweep of vLLM Qwen2.5-1.5B on 1 preemptible L40S from the operator host (port-forward), 200/200 at 1, 8 and 32 concurrent; E2E p99 0.85–1.47 s (pass, bar 10 s); up to 3,696 output tok/s; $0.056 per 1M output at 32; in-cluster bench blocked by egress (R1-21)' },
  { id: 'R2', title: 'Foundation & lifecycle', provisioning: 'documentation', path: 'terraform', docs: 'terraform/README.md', runbooks: ['runbooks/deploy.md', 'runbooks/drift.md', 'runbooks/teardown.md'], provenToday: 'Live run: foundation applied for sandbox (IAM only); every apply used the bootstrap, plan, apply, destroy and leftovers lifecycle; 2026-10-12: plan-scoped preflight GO, TTL jobs armed, safe teardown stop and clean rerun; staging, prod and a pipeline apply not run' },
  { id: 'R3', title: 'Training + NCCL', stack: 'training', provisioning: 'form', path: 'terraform/stacks/training', docs: 'terraform/stacks/training/README.md', runbooks: ['runbooks/capacity-request.md', 'runbooks/incident.md'], provenToday: 'Live read / plan: planned against the real API, not applied (non-GPU vCPU quota 0); single-GPU NCCL init seen in a prior upstream run; multi-node InfiniBand not measured' },
  { id: 'R4', title: 'Soperator (Slurm on Kubernetes)', stack: 'soperator', provisioning: 'form', path: 'terraform/stacks/soperator', docs: 'terraform/stacks/soperator/README.md', runbooks: ['runbooks/soperator-jobs.md'], provenToday: 'Live read / plan: planned against the real API, not applied (non-GPU vCPU quota 0); sbatch end to end on Soperator 4.1.13 in a prior upstream run (CPU worker)' },
  { id: 'R5', title: 'Workflow platform (team namespaces)', provisioning: 'documentation', path: 'recipes/team-platform', docs: 'recipes/team-platform/README.md', runbooks: [], provenToday: 'Mocked only: manifests build in CI' },
  { id: 'R6', title: 'Serverless endpoint', provisioning: 'documentation', path: 'recipes/serverless', docs: 'recipes/serverless/README.md', runbooks: [], provenToday: 'Offline-ready: scripts and the in-region comparison checked on stubs; not yet measured here' },
  { id: 'R7', title: 'Private network perimeter', stack: 'network', provisioning: 'live-root', path: 'terraform/stacks/network', docs: 'terraform/stacks/network/README.md', runbooks: ['runbooks/network.md'], provenToday: 'Live read / plan: planned against the real API, not applied (the NAT VM needs non-GPU vCPU quota)' },
  { id: 'R8', title: 'Dataset and checkpoint data plane', stack: 'data', provisioning: 'live-root', path: 'terraform/stacks/data', docs: 'terraform/stacks/data/README.md', runbooks: ['runbooks/data.md', 'runbooks/backup-restore.md'], provenToday: 'Live run: applied in sandbox twice (two buckets, a filesystem; torn down); filesystem fio 2,066 MiB/s write, 1,757 MiB/s read from one L40S node on 2026-10-12 (one short run); no transfer or restore yet' },
  { id: 'R9', title: 'Finance & governance (pricing, spot caps, project limits, budgets)', stack: 'governance', provisioning: 'live-root', path: 'recipes/finance', docs: 'recipes/finance/README.md', moreDocs: ['terraform/stacks/governance/README.md'], runbooks: ['runbooks/finance.md'], provenToday: 'Live run: one H100 spot cap applied in sandbox 2026-10-11 and torn down (L40S takes none); price.py live on every S1–S9 footprint and re-priced before the 2026-10-12 run; monthly close not run' },
  { id: 'R10', title: 'One GPU VM serving a model (no Kubernetes)', stack: 'gpu-vm', provisioning: 'live-root', capKey: 'gpu-vm', path: 'terraform/stacks/gpu-vm', docs: 'terraform/stacks/gpu-vm/README.md', runbooks: ['runbooks/gpu-vm.md'], provenToday: 'Live run: applied in sandbox 2026-10-11 (1 preemptible L40S VM, vLLM answered; torn down); no completion with the key yet' },
  { id: 'R11', title: 'Token Factory (hosted open models)', provisioning: 'documentation', path: 'recipes/token-factory', docs: 'recipes/token-factory/README.md', runbooks: ['runbooks/token-factory.md'], provenToday: 'Measured: 2026-10-12 sweep of Qwen3-30B-A3B from the operator host, 600/600 answered; E2E p99 3.9 s at 8 and 4.4 s at 32 concurrent (pass, bar 10 s), 14.1 s at 1 (fail); up to 1,195 output tok/s; $0.30 per 1M output' },
  { id: 'R12', title: 'ML services (registry, MLflow, PostgreSQL)', stack: 'ml-services', provisioning: 'live-root', path: 'terraform/stacks/ml-services', docs: 'terraform/stacks/ml-services/README.md', runbooks: ['runbooks/ml-services.md'], provenToday: 'Live run: applied in sandbox twice, torn down; 2026-10-12: one-pass apply, registry push and pull, node pull with no pull secret, PostgreSQL select 1 over verify-full; MLflow client check failed (cause unknown)' },
  { id: 'R13', title: 'CI federation (GitHub OIDC) and team groups', provisioning: 'documentation', path: 'terraform/modules/foundation/ci-federation', docs: 'terraform/modules/foundation/ci-federation/README.md', runbooks: ['runbooks/identity.md', 'runbooks/credential-rotation.md'], provenToday: 'Live run: applied for sandbox 2026-10-11; federated CI plan green (GitHub OIDC → STS, audience sts.nebius.com); apply side not yet' },
  { id: 'R14', title: 'Observability (metrics, logs, traces, alerts)', provisioning: 'documentation', path: 'recipes/observability', docs: 'recipes/observability/README.md', runbooks: ['runbooks/observability.md', 'runbooks/fleet-alerts.md'], provenToday: 'Live run: metric names and log labels read live 2026-10-11; acceptance on an R1 cluster 2026-10-12: Grafana and Alertmanager answer, test alert routed, no Nebius data source provisioned; traces, journald and alert delivery not yet run' },
  { id: 'R15', title: 'Rack-scale GB300 NVL72', provisioning: 'documentation', capKey: 'nvl', path: 'terraform/stacks/nvl', docs: 'terraform/stacks/nvl/README.md', runbooks: ['runbooks/nvl.md', 'runbooks/capacity-request.md'], provenToday: 'Mocked only: no stage may plan a rack (max_gpu_nodes.nvl 0) until capacity is approved' },
  { id: 'R16', title: 'Team queues on one GPU cluster (Kueue, topology-aware)', provisioning: 'documentation', path: 'workloads/kueue', docs: 'workloads/kueue/README.md', runbooks: ['runbooks/team-scheduling.md'], provenToday: 'Offline-ready: manifests build and pass policy/kueue.rego in CI; admission, borrow and reclaim script tested on stubs; not yet run' },
];

/** A recipe's GPU-node cap per stage from platform/stages.yaml, when one key caps it (R10, R15). */
export function recipeCaps(recipe: Pick<RecipeSummary, 'capKey'>, stages: StagesFile): Record<string, number> | undefined {
  if (!recipe.capKey) return undefined;
  const out: Record<string, number> = {};
  for (const [stage, s] of Object.entries(stages.stages)) {
    const v = s.policy.max_gpu_nodes[recipe.capKey];
    if (typeof v === 'number') out[stage] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

/** A recipe as read from this checkout: its README may not exist yet (for example, a new stack). */
export type RecipeView = RecipeSummary & {
  docsAvailable: boolean;
  /** GPU-node cap per stage (platform/stages.yaml), for recipes capped by their own key. */
  caps?: Record<string, number>;
  /** Live roots of its stack in this checkout (terraform/live/<stage>/<stack>). */
  liveRoots: string[];
};

export interface RepoModel {
  commit?: string;
  stages: StagesFile;
  regions: RegionsFile;
  versions: PinnedVersion[];
  liveRoots: LiveRoot[];
  recipes: RecipeView[];
  warnings: ParseWarning[];
  readAt: string;
}
