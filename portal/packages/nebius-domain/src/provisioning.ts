import { z } from 'zod';
import { Decimal } from './decimal';
import { inferenceFootprint, quotaNeeds, QuotaNeeds, runProfileSizing, soperatorLabFootprint, trainingFootprint, withWorkloadCount } from './capacity';
import { Footprint, RateBook, ScenarioInput } from './pricing';
import { HOURS_PER_PRICING_MONTH } from './units';
import { parseTfvars, RegionsFile, RunProfile, setTfvars, StagesFile, tfvarsToRecord, unifiedDiff } from './repo';

/**
 * Provisioning requests prepare a *reviewed configuration change*; they never
 * apply anything. The repository's own gates stay authoritative: CI
 * (make ci, conftest), plan-time preconditions in the stacks, the saved-plan
 * review, scripts/tf-run.sh and, for staging/prod, the disabled-by-default
 * pipeline with protected environments. Validation here is advisory and
 * mirrors those gates so a request fails early, not instead of them.
 */

export const RECIPE_IDS = ['sandbox-inference', 'training-capacity', 'soperator-lab'] as const;
export type RecipeId = (typeof RECIPE_IDS)[number];

export interface RecipeDefinition {
  id: RecipeId;
  title: string;
  stack: 'inference' | 'training' | 'soperator';
  summary: string;
  /** Stages this recipe can target; intersected with platform/stages.yaml. */
  stages: string[];
  capacityTypes: ('on-demand' | 'preemptible' | 'reserved')[];
  docs: string[];
}

export const RECIPE_DEFINITIONS: RecipeDefinition[] = [
  {
    id: 'sandbox-inference',
    title: 'Sandbox inference',
    stack: 'inference',
    summary: 'Single-GPU vLLM serving cluster in the sandbox stage, TTL-bound, torn down by the run that creates it.',
    stages: ['sandbox'],
    capacityTypes: ['preemptible', 'on-demand', 'reserved'],
    docs: ['terraform/stacks/inference/README.md', 'runbooks/deploy.md', 'docs/cost.md'],
  },
  {
    id: 'training-capacity',
    title: 'Training capacity request',
    stack: 'training',
    summary: '8-GPU InfiniBand nodes in one fabric for multi-node NCCL / PyTorch DDP. Training roots plan 0 GPU nodes until approved.',
    stages: ['sandbox', 'staging', 'prod'],
    capacityTypes: ['on-demand', 'reserved', 'preemptible'],
    docs: ['terraform/stacks/training/README.md', 'runbooks/capacity-request.md', 'docs/capacity.md'],
  },
  {
    id: 'soperator-lab',
    title: 'Soperator lab',
    stack: 'soperator',
    summary: 'Slurm on Kubernetes (Soperator 4.1.13) with the lab profile: one CPU worker, no GPU.',
    stages: ['sandbox', 'staging', 'prod'],
    capacityTypes: ['on-demand'],
    docs: ['terraform/stacks/soperator/README.md', 'docs/soperator-compatibility.md', 'runbooks/soperator-jobs.md'],
  },
];

const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

export const provisioningRequestSchema = z.object({
  recipe: z.enum(RECIPE_IDS),
  stage: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
  region: z.string().regex(/^[a-z]{2}-[a-z]+\d$/),
  /** null/omitted = the region's default platform. */
  platform: z.string().regex(/^gpu-[a-z0-9-]{2,40}$/).nullable().optional(),
  gpuNodeCount: z.number().int().min(0).max(64),
  capacityType: z.enum(['on-demand', 'preemptible', 'reserved']),
  reservationPolicy: z.enum(['AUTO', 'STRICT']).optional(),
  filestoreSizeGib: z.number().int().min(0).max(1_048_576).optional(),
  ttlExpires: z.string().regex(RFC3339_UTC, 'RFC 3339 UTC, e.g. 2026-10-31T18:00:00Z').optional(),
  runtimeHours: z.number().min(0.25).max(24 * 366),
  owner: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'lowercase letters, digits and dashes'),
  /** Empty while the SA has not typed one: the diff and the estimate still preview (W1-P5); Prepare refuses it. */
  requestRef: z.string().regex(/^([A-Za-z0-9][A-Za-z0-9._-]{0,63})?$/, 'a ticket, date or run id'),
  budget: z
    .object({
      amount: z.string().refine(s => Decimal.isValid(s) && !Decimal.from(s).isNegative(), 'non-negative decimal'),
      currency: z.string().regex(/^[A-Z]{3}$/),
    })
    .optional(),
  justification: z.string().max(2000).optional(),
  /** A committed run profile (platform/profiles/<stack>/<name>.json) the run is planned with: make plan PROFILE=<name> (#27). */
  runProfile: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/).optional(),
  /** Training: the InfiniBand fabric (infiniband_fabric); null/omitted = the platform's default in platform/regions.yaml (W1-P4). */
  fabric: z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/).nullable().optional(),
  /** The SA intends a stateful size to shrink, which replaces the volume and loses its data (W1-P2). */
  confirmShrink: z.boolean().optional(),
  /** Prepare although a quota stops the plan today: a quota request is pending (W1-P3). */
  quotaRequestPending: z.boolean().optional(),
});
export type ProvisioningRequestInput = z.infer<typeof provisioningRequestSchema>;

export interface PolicyIssue {
  field: string;
  message: string;
  /** Where the rule comes from in the repository. */
  source: string;
  severity: 'error' | 'warning' | 'info';
}

export interface ProvisioningContext {
  stages: StagesFile;
  regions: RegionsFile;
  now: Date;
  /** The committed sizing file of the request's root, as text: what the request is compared with (W1-P1, W1-P2). */
  sizingText?: string;
  /** Run profiles of the request's stack and stage (platform/profiles), for `runProfile` (#27). */
  runProfiles?: RunProfile[];
}

type Scalar = string | number | boolean | null;
type Sizing = Record<string, Scalar>;

/** Each form field and the sizing variable it writes. */
const FIELD_VARS = { gpuNodeCount: 'gpu_node_count', platform: 'gpu_platform', filestoreSizeGib: 'filestore_size_gib', capacityType: 'gpu_preemptible', fabric: 'infiniband_fabric' } as const;
const VAR_FIELD: Record<string, string> = Object.fromEntries(Object.entries(FIELD_VARS).map(([f, v]) => [v, f]));
const FIELD_WORDS: Record<string, string> = { gpuNodeCount: 'GPU nodes', platform: 'GPU platform', filestoreSizeGib: 'Shared filesystem', capacityType: 'Capacity type', fabric: 'InfiniBand fabric' };

/** Variable defaults of the form stacks (terraform/stacks/<stack>/variables.tf), used when a sizing file leaves one out. */
const STACK_DEFAULTS: Record<'inference' | 'training', { gpu_node_count: number; filestore_size_gib: number }> = {
  inference: { gpu_node_count: 1, filestore_size_gib: 64 },
  training: { gpu_node_count: 0, filestore_size_gib: 256 },
};

/** Sizes that hold data: a smaller value replaces the volume (W1-P2). */
const STATEFUL_SIZES: Record<string, string> = { filestore_size_gib: 'Shared filesystem' };
const SHRINK_SOURCE = 'docs.nebius.com/compute/storage/manage#how-to-resize-a-volume ("Reducing volume size is not possible")';

/** The form fields a root's committed sizing (with a run profile's vars over it) amounts to. */
export interface CommittedForm {
  gpuNodeCount: number;
  platform: string | null;
  filestoreSizeGib: number | undefined;
  capacityType: 'on-demand' | 'preemptible';
  fabric: string | null;
}

/**
 * What the form starts from (W1-P1): every field from the committed sizing file of the chosen stage, with the chosen
 * run profile's vars over it (#27), so an untouched field writes nothing.
 */
export function committedForm(recipe: RecipeId, sizing: Record<string, Scalar | undefined>, profile?: Pick<RunProfile, 'vars'>): CommittedForm {
  const stack = recipeById(recipe).stack;
  if (stack === 'soperator') return { gpuNodeCount: 0, platform: null, filestoreSizeGib: undefined, capacityType: 'on-demand', fabric: null };
  const s = runProfileSizing(sizing, profile);
  const d = STACK_DEFAULTS[stack];
  return {
    gpuNodeCount: typeof s.gpu_node_count === 'number' ? s.gpu_node_count : d.gpu_node_count,
    platform: typeof s.gpu_platform === 'string' && s.gpu_platform ? s.gpu_platform : null,
    filestoreSizeGib: s.enable_filestore === false ? undefined : typeof s.filestore_size_gib === 'number' ? s.filestore_size_gib : d.filestore_size_gib,
    capacityType: s.gpu_preemptible === true ? 'preemptible' : 'on-demand',
    fabric: typeof s.infiniband_fabric === 'string' && s.infiniband_fabric ? s.infiniband_fabric : null,
  };
}

/** The run profile a request names, among the root's (undefined when it names none or an unknown one). */
function chosenProfile(input: Pick<ProvisioningRequestInput, 'runProfile'>, ctx: Pick<ProvisioningContext, 'runProfiles'>): RunProfile | undefined {
  return input.runProfile ? ctx.runProfiles?.find(p => p.name === input.runProfile) : undefined;
}

/**
 * The request against its root's committed sizing (W1-P1): `base` is the sizing file with the run profile's vars
 * over it; `wanted` the value of every variable a form field writes; `edits` only those that differ from `base` and
 * that the profile does not set (a profile's vars override the sizing file at plan time).
 */
function requestVars(input: ProvisioningRequestInput, ctx: ProvisioningContext) {
  const stack = recipeById(input.recipe).stack;
  const sizing: Sizing = ctx.sizingText !== undefined ? tfvarsToRecord(parseTfvars(ctx.sizingText)) : {};
  const profile = chosenProfile(input, ctx);
  const base = runProfileSizing(sizing, profile);
  const wanted: Sizing = {};
  const edits: Record<string, string | number | boolean> = {};
  const conflicts: string[] = [];
  if (stack === 'soperator') return { sizing, base, profile, wanted, edits, conflicts };
  const d = STACK_DEFAULTS[stack];
  const region = ctx.regions.regions[input.region];
  const platform = input.platform || region?.default;
  const basePlatform = (typeof base.gpu_platform === 'string' && base.gpu_platform) || region?.default;
  wanted.gpu_node_count = input.gpuNodeCount;
  if (platform) wanted.gpu_platform = platform;
  if (input.filestoreSizeGib !== undefined) wanted.filestore_size_gib = input.filestoreSizeGib;
  if (input.recipe === 'sandbox-inference') wanted.gpu_preemptible = input.capacityType === 'preemptible';
  const defaultFabric = platform ? region?.platforms[platform]?.fabric : undefined;
  if (stack === 'training' && (input.fabric || defaultFabric)) wanted.infiniband_fabric = input.fabric || defaultFabric!;
  const current: Sizing = {
    gpu_node_count: typeof base.gpu_node_count === 'number' ? base.gpu_node_count : d.gpu_node_count,
    gpu_platform: basePlatform ?? null,
    filestore_size_gib: typeof base.filestore_size_gib === 'number' ? base.filestore_size_gib : d.filestore_size_gib,
    gpu_preemptible: base.gpu_preemptible === true,
    infiniband_fabric: (typeof base.infiniband_fabric === 'string' && base.infiniband_fabric) || defaultFabric || null,
  };
  for (const [k, v] of Object.entries(wanted)) {
    if (v === null) continue;
    if (profile && k in profile.vars) {
      if (profile.vars[k] !== v) conflicts.push(k);
      continue;
    }
    if (current[k] !== v) edits[k] = v;
  }
  return { sizing, base, profile, wanted, edits, conflicts };
}

export function recipeById(id: RecipeId): RecipeDefinition {
  return RECIPE_DEFINITIONS.find(r => r.id === id)!;
}

/** Stage choices for a recipe: the recipe's list ∩ stages declared in platform/stages.yaml. */
export function recipeStages(recipe: RecipeDefinition, stages: StagesFile): string[] {
  return recipe.stages.filter(s => s in stages.stages);
}

export function validateProvisioningRequest(input: ProvisioningRequestInput, ctx: ProvisioningContext): PolicyIssue[] {
  const issues: PolicyIssue[] = [];
  const err = (field: string, message: string, source: string) => issues.push({ field, message, source, severity: 'error' });
  const warn = (field: string, message: string, source: string) => issues.push({ field, message, source, severity: 'warning' });
  const info = (field: string, message: string, source: string) => issues.push({ field, message, source, severity: 'info' });

  const recipe = recipeById(input.recipe);
  if (!input.requestRef) err('requestRef', 'Enter a request reference (ticket, date or run id): it names the run (the nip-run label).', 'docs/naming.md');
  if (!recipeStages(recipe, ctx.stages).includes(input.stage)) {
    err('stage', `${recipe.title} cannot target stage "${input.stage}"`, 'platform/stages.yaml');
    return issues;
  }
  const policy = ctx.stages.stages[input.stage].policy;
  const region = ctx.regions.regions[input.region];
  if (!region) {
    err('region', `region ${input.region} is not in platform/regions.yaml`, 'platform/regions.yaml');
    return issues;
  }
  if (region.note) warn('region', region.note, `platform/regions.yaml: regions.${input.region}.note`);
  if (!recipe.capacityTypes.includes(input.capacityType)) {
    err('capacityType', `${input.capacityType} is not offered for ${recipe.title}`, 'recipe definition');
  }

  if (input.recipe !== 'soperator-lab') {
    const stack = recipe.stack as 'inference' | 'training';
    const platform = input.platform || region.default;
    const entry = region.platforms[platform];
    if (!entry) {
      err('platform', `${platform} is not offered in ${input.region}`, `platform/regions.yaml: regions.${input.region}.platforms`);
    } else if (stack === 'inference' && !entry.single_gpu_preset) {
      err('platform', `${platform} has no single-GPU preset in ${input.region}`, 'platform/regions.yaml');
    } else if (stack === 'training' && (!entry.ib_preset || !entry.fabric)) {
      err('platform', `${platform} has no 8-GPU InfiniBand preset/fabric in ${input.region}; it cannot form a GPU cluster`, 'platform/regions.yaml');
    }
    const cap = policy.max_gpu_nodes[stack];
    if (input.gpuNodeCount > cap) {
      err('gpuNodeCount', `${input.gpuNodeCount} GPU nodes exceeds the ${input.stage} cap of ${cap} for ${stack}`, `platform/stages.yaml: stages.${input.stage}.policy.max_gpu_nodes.${stack}`);
    }
    const stackCap = stack === 'inference' ? 8 : 32;
    if (input.gpuNodeCount > stackCap) {
      err('gpuNodeCount', `the ${stack} stack caps gpu_node_count at ${stackCap}`, `terraform/stacks/${stack}/variables.tf`);
    }
    if (input.capacityType === 'preemptible') {
      if (stack === 'inference' && !policy.allow_preemptible_serving) {
        err('capacityType', `stage ${input.stage} refuses preemptible serving`, `platform/stages.yaml: stages.${input.stage}.policy.allow_preemptible_serving`);
      }
      if (stack === 'training') {
        warn('capacityType', 'preemptible capacity can be reclaimed mid-run; never use it for a run whose numbers are recorded', 'docs/decisions/0007-capacity-on-demand-vs-preemptible.md');
      }
      if (input.reservationPolicy === 'STRICT') {
        err('reservationPolicy', 'a STRICT reservation group cannot be preemptible', 'terraform/modules/node-group (precondition)');
      }
    }
    if (stack === 'training' && policy.require_strict_reservation.training && input.gpuNodeCount > 0) {
      if (input.capacityType !== 'reserved' || input.reservationPolicy !== 'STRICT') {
        err('reservationPolicy', `stage ${input.stage} requires a STRICT reservation whenever training GPU nodes > 0`, `platform/stages.yaml: stages.${input.stage}.policy.require_strict_reservation.training`);
      }
    }
    if (input.capacityType === 'reserved' && !input.reservationPolicy) {
      err('reservationPolicy', 'reserved capacity needs a reservation policy (AUTO or STRICT)', 'docs/capacity.md');
    }
    if (stack === 'training' && input.gpuNodeCount === 1) {
      warn('gpuNodeCount', 'a multi-node NCCL test needs at least 2 nodes', 'terraform/stacks/training/variables.tf');
    }
    if (input.fabric && entry && stack === 'training' && !(entry.fabrics ?? (entry.fabric ? [entry.fabric] : [])).includes(input.fabric)) {
      err('fabric', `${input.fabric} is not a fabric of ${platform} in ${input.region}`, `platform/regions.yaml: regions.${input.region}.platforms.${platform}.fabrics`);
    }

    // #27: a run profile is the root's own (stack and stage), in its own region, and owns the variables it sets.
    if (input.runProfile) {
      const profile = chosenProfile(input, ctx);
      if (!profile) {
        err('runProfile', `no run profile ${input.runProfile} for ${stack} in stage ${input.stage}`, `platform/profiles/${stack}/`);
      } else {
        if (profile.region !== input.region) {
          err('region', `run profile ${profile.name} is for region ${profile.region}; scripts/run-profile.py refuses a plan in ${input.region}`, `platform/profiles/${stack}/${profile.name}.json`);
        }
        for (const k of requestVars(input, ctx).conflicts) {
          const field = VAR_FIELD[k] ?? k;
          err(field, `${FIELD_WORDS[field] ?? k} is set by run profile ${profile.name} (${k} = ${JSON.stringify(profile.vars[k])}); choose no profile to change it`, `platform/profiles/${stack}/${profile.name}.json`);
        }
      }
    }

    // W1-P2: a stateful size never shrinks without an explicit intent (the volume would be replaced, its data lost).
    if (ctx.sizingText !== undefined) {
      const { sizing, base, edits } = requestVars(input, ctx);
      const planned: Sizing = { ...base, ...edits };
      for (const [k, what] of Object.entries(STATEFUL_SIZES)) {
        const committed = typeof sizing[k] === 'number' ? (sizing[k] as number) : STACK_DEFAULTS[stack][k as 'filestore_size_gib'];
        const next = planned[k];
        if (typeof next !== 'number' || planned.enable_filestore === false || next >= committed) continue;
        const gib = (n: number) => `${n.toLocaleString('en-US')} GiB`;
        // The file's name only: the full path is one unbreakable token that would widen a phone screen.
        const file = sizingFilePath(input.recipe, input.stage)?.split('/').pop() ?? 'the sizing file';
        const message = `${what} would shrink from ${gib(committed)} to ${gib(next)} (${k} in ${input.stage}'s ${file}). A Nebius volume cannot be made smaller: shrinking replaces it, and its data is lost.`;
        if (input.confirmShrink) warn(VAR_FIELD[k] ?? k, `${message} Confirmed: "I intend to shrink/replace".`, SHRINK_SOURCE);
        else err(VAR_FIELD[k] ?? k, `${message} Reset to ${gib(committed)}, or tick "I intend to shrink/replace".`, SHRINK_SOURCE);
      }
    }
  }

  if (policy.require_ttl_label) {
    if (!input.ttlExpires) {
      err('ttlExpires', `stage ${input.stage} requires a nip-ttl-expires label`, `platform/stages.yaml: stages.${input.stage}.policy.require_ttl_label`);
    } else {
      const ttl = Date.parse(input.ttlExpires);
      const hours = (ttl - ctx.now.getTime()) / 3_600_000;
      if (hours <= 0) err('ttlExpires', 'TTL is in the past', 'docs/cost.md (Required labels)');
      else if (hours > input.runtimeHours + 1) {
        warn('ttlExpires', `TTL ends ${Math.round(hours)} h from now, beyond the ${input.runtimeHours} h approved runtime; it should end inside the approved run`, 'docs/cost.md (Required labels)');
      }
    }
  }
  if (input.stage === 'prod') {
    info('stage', 'prod is applied only by a manual pipeline dispatch from a release tag through a protected environment; this request prepares the reviewed change, nothing more', 'docs/change-management.md');
  }
  if (!input.budget) {
    warn('budget', 'no budget recorded; a written spend approval is required before any apply', 'CONTRIBUTING.md (Nothing billable without approval)');
  }
  info('policy', 'advisory check only: CI (make ci, conftest) and the stacks\' plan-time preconditions remain authoritative', 'docs/change-management.md');
  return issues;
}

/* ----------------------------------------------------------- change preview */

export interface FileChange {
  /** Repository-relative path; chosen from a fixed map, never from user input. */
  path: string;
  before: string;
  after: string;
  diff: string;
}

export interface ChangePreview {
  recipe: RecipeId;
  stage: string;
  files: FileChange[];
  /** Commands for the operator, rendered as text. The portal never runs them. */
  runSheet: string[];
  notes: string[];
  footprint: Footprint;
  quota: QuotaNeeds;
}

/** The only files a provisioning request may change. */
export function sizingFilePath(recipe: RecipeId, stage: string): string | undefined {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(stage)) return undefined;
  switch (recipe) {
    case 'sandbox-inference':
      return stage === 'sandbox' ? 'terraform/live/sandbox/inference/sandbox.auto.tfvars' : undefined;
    case 'training-capacity':
      return `terraform/live/${stage}/training/${stage}.auto.tfvars`;
    case 'soperator-lab':
      return undefined; // the lab profile is used as is; no sizing edit
    default:
      return undefined;
  }
}

export function previewChange(
  input: ProvisioningRequestInput,
  ctx: ProvisioningContext & { sizingText?: string },
): ChangePreview {
  const recipe = recipeById(input.recipe);
  const notes: string[] = [];
  const files: FileChange[] = [];
  const path = sizingFilePath(input.recipe, input.stage);
  const region = ctx.regions.regions[input.region];
  const platform = input.platform || region?.default;
  const labels = {
    'nip-stack': recipe.stack,
    'nip-env': recipe.stack, // deprecated; kept for one release (docs/naming.md)
    'nip-owner': input.owner,
    'nip-run': input.requestRef,
    ...(input.ttlExpires ? { 'nip-ttl-expires': input.ttlExpires } : {}),
  };
  const env = (stack: string) => [
    '# Never commit tenant/project IDs: they come from the environment (CONTRIBUTING: no real IDs).',
    `export NEBIUS_TENANT_ID=tenant-... NEBIUS_PROJECT_ID=project-... NEBIUS_REGION=${input.region}`,
    `source scripts/bootstrap-backend.sh ${input.stage} ${stack}`,
  ];

  let footprint: Footprint;
  // Only what the request changes against the committed sizing (and run profile) is written (W1-P1).
  const vars = requestVars(input, ctx);
  const sizing: Sizing = { ...vars.base, ...vars.edits };
  if (path && ctx.sizingText !== undefined) {
    const after = setTfvars(ctx.sizingText, vars.edits, input.requestRef ? `Added by provisioning request ${input.requestRef}` : 'Added by a provisioning request');
    files.push({ path, before: ctx.sizingText, after, diff: unifiedDiff(ctx.sizingText, after, path) });
  }
  const profileArg = vars.profile ? ` PROFILE=${vars.profile.name}` : '';

  const fctx = { regions: ctx.regions, region: input.region, gpuPlatform: platform };
  const runSheet: string[] = [];
  if (input.recipe === 'sandbox-inference' || input.recipe === 'training-capacity') {
    const stack = recipe.stack;
    footprint = stack === 'inference' ? inferenceFootprint(sizing, fctx, input.gpuNodeCount) : trainingFootprint(sizing, fctx, input.gpuNodeCount);
    if (vars.edits.gpu_platform !== undefined && region) {
      notes.push(`gpu_platform = "${platform}" is set explicitly because the request region's default is ${region.default}.`);
    }
    if (vars.profile) {
      notes.push(`Planned with run profile ${vars.profile.name} (platform/profiles/${stack}/${vars.profile.name}.json): its vars override the sizing file at plan time, so the fields it sets are not written; scripts/run-profile.py renders nip-run (RUN=) and nip-ttl-expires (TTL_HOURS=, hours from the plan).`);
    }
    notes.push('The region is not written to the sizing file: the live root reads it from NEBIUS_REGION via scripts/bootstrap-backend.sh.');
    runSheet.push(...env(stack));
    runSheet.push(`export TF_VAR_labels='${JSON.stringify(labels)}'`);
    if (input.capacityType === 'reserved') {
      runSheet.push(`export TF_VAR_gpu_reservation='{"policy":"${input.reservationPolicy ?? 'AUTO'}","reservation_ids":["<reservation-id>"]}'   # reservation IDs stay out of git`);
      notes.push('Reservation IDs are real resource IDs, which this repository never commits; pass them at plan time.');
    }
    runSheet.push(
      `make preflight STAGE=${input.stage} STACK=${stack}${profileArg}   # the same go/no-go as this check: stage caps, TTL, quota, capacity`,
      `make init plan STAGE=${input.stage} STACK=${stack}${profileArg}${vars.profile ? ` RUN=${input.requestRef}` : ''}     # read ${input.stage}-${stack}.tfplan before applying`,
      `make apply CONFIRM=yes STAGE=${input.stage} STACK=${stack}   # only with a written spend approval; refused for plans older than 10 h`,
    );
    if (input.stage === 'sandbox') {
      runSheet.push(`make destroy-plan STAGE=${input.stage} STACK=${stack} && make destroy CONFIRM=yes STAGE=${input.stage} STACK=${stack} && make leftovers STAGE=${input.stage} STACK=${stack}`);
    } else {
      runSheet.splice(runSheet.length - 2, 2, `# ${input.stage}: merge this change, then a manual dispatch of .github/workflows/terraform.yml (${input.stage === 'prod' ? 'from a release tag' : 'from main'}); the pipeline ships disabled`);
    }
  } else {
    footprint = soperatorLabFootprint(input.stage);
    notes.push('The Soperator lab profile (terraform/stacks/soperator/profiles/lab.tfvars) is used unchanged; stage overrides live in terraform/live/<stage>/soperator/stage.tfvars.');
    notes.push('Soperator 4.1.13 supports Kubernetes 1.32–1.35 and needs Terraform >= 1.12 (docs/soperator-compatibility.md).');
    runSheet.push(
      'make soperator-check    # recipe at the pinned tag: validate + mocked plan per stage (no credentials)',
      ...env('soperator'),
      '# then follow runbooks/deploy.md (Soperator section) with a written spend approval',
    );
  }
  notes.push('Nothing in this preview is applied by the portal. Review the diff, open a PR yourself, and let CI and the plan-time preconditions decide.');
  // The run sheet names the run (nip-run, RUN=): it waits for the reference, while the diff and the estimate do not (W1-P5).
  if (!input.requestRef) {
    runSheet.length = 0;
    notes.unshift('The run sheet is shown once a request reference is entered: it names the run (the nip-run label, RUN=).');
  }
  return {
    recipe: input.recipe,
    stage: input.stage,
    files,
    runSheet,
    notes,
    footprint,
    quota: quotaNeeds(footprint, { gpuCluster: input.recipe === 'training-capacity' }),
  };
}

/** A `git apply`-able patch for every changed file. */
export function previewToPatch(p: ChangePreview): string {
  return p.files.map(f => f.diff).filter(Boolean).join('');
}

/**
 * The scenario behind a provisioning estimate: the requested footprint as
 * expected and maximum, its floor (system nodes and storage, no GPU or worker
 * nodes) as minimum, priced with one rate book on `asOf`, for the approved runtime.
 */
export function scenarioFromProvisioning(change: ChangePreview, input: ProvisioningRequestInput, book: RateBook, asOf: string): ScenarioInput {
  const recipe = recipeById(input.recipe);
  return {
    name: `${recipe.title} ${input.requestRef}`.trim(),
    recipe: recipe.stack,
    region: input.region,
    currency: book.currency,
    rateBookId: book.id,
    capacityType: input.capacityType,
    asOf,
    // The approved runtime is the whole time the resources exist, warm-up and teardown included (the field hint,
    // the TTL check and the live price read it so): no overhead is added on top (G5.2).
    runtime: { activeHours: input.runtimeHours, warmupHours: 0, teardownHours: 0 },
    monthlyHours: HOURS_PER_PRICING_MONTH,
    footprints: { min: withWorkloadCount(change.footprint, 0), expected: change.footprint, max: change.footprint },
  };
}

export const PROVISIONING_STATES = ['prepared', 'approved', 'deployed', 'withdrawn'] as const;
export type ProvisioningState = (typeof PROVISIONING_STATES)[number];

export interface ProvisioningRequestRecord {
  id: string;
  input: ProvisioningRequestInput;
  state: ProvisioningState;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** sha256 of each sizing file as previewed; a stale base is refused. */
  baseHashes: Record<string, string>;
  patch: string;
  issues: PolicyIssue[];
  evidence?: string;
}
