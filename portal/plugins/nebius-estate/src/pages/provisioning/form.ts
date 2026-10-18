import type { AvailabilityOption, CommittedForm, ProvisioningRequestInput, RecipeDefinition, RecipesResponse, RunProfile } from '@internal/nebius-domain';
import { committedForm } from '@internal/nebius-domain';

/**
 * The Provisioning form against the committed configuration (W1-P1, #27): what each sizing field starts from, where
 * that value comes from, and the one-click switches the live checks offer (W1-P3, W1-P4).
 */

export type SizingField = keyof CommittedForm;
export const SIZING_FIELDS: SizingField[] = ['gpuNodeCount', 'platform', 'capacityType', 'filestoreSizeGib', 'fabric'];

/** The sizing variable each field writes (as the domain's previewChange does). */
const FIELD_VAR: Record<SizingField, string> = { gpuNodeCount: 'gpu_node_count', platform: 'gpu_platform', capacityType: 'gpu_preemptible', filestoreSizeGib: 'filestore_size_gib', fabric: 'infiniband_fabric' };

export interface Committed {
  /** The root's sizing file, e.g. terraform/live/prod/training/prod.auto.tfvars; undefined for a recipe without one. */
  sizingFile?: string;
  /** Run profiles of the root (its stack and stage). */
  profiles: RunProfile[];
  profile?: RunProfile;
  /** The sizing file alone. */
  file: CommittedForm;
  /** The sizing file with the chosen profile's vars over it: what an untouched form plans. */
  form: CommittedForm;
}

/** The committed configuration of a recipe in a stage, with a run profile when one is named. */
export function committedFor(data: Pick<RecipesResponse, 'sizing'>, recipe: Pick<RecipeDefinition, 'id' | 'stack'>, stage: string, profileName?: string): Committed {
  const root = data.sizing.find(s => s.stage === stage && s.stack === recipe.stack);
  const profiles = root?.runProfiles ?? [];
  const profile = profileName ? profiles.find(p => p.name === profileName) : undefined;
  const sizing = root?.sizing ?? {};
  return { sizingFile: root?.sizingFile, profiles, ...(profile ? { profile } : {}), file: committedForm(recipe.id, sizing), form: committedForm(recipe.id, sizing, profile) };
}

/** The input with every sizing field set to its committed value (and the profile's region and name, when one is chosen). */
export function prefill(input: ProvisioningRequestInput, c: Committed, capacityTypes: ProvisioningRequestInput['capacityType'][]): ProvisioningRequestInput {
  const capacityType = capacityTypes.includes(c.form.capacityType) ? c.form.capacityType : capacityTypes[0];
  const out: ProvisioningRequestInput = { ...input, gpuNodeCount: c.form.gpuNodeCount, platform: c.form.platform, capacityType, filestoreSizeGib: c.form.filestoreSizeGib, fabric: c.form.fabric, confirmShrink: undefined };
  if (capacityType !== 'reserved') delete out.reservationPolicy;
  if (c.profile) return { ...out, runProfile: c.profile.name, region: c.profile.region };
  const { runProfile: _drop, ...rest } = out;
  return rest;
}

/** Whether the chosen run profile sets a field (it is then the profile's, not editable here). */
export function setByProfile(field: SizingField, profile: RunProfile | undefined): boolean {
  return Boolean(profile && FIELD_VAR[field] in profile.vars);
}

export interface Origin {
  label: string;
  tone: 'neutral' | 'info' | 'warn';
}

/** Where a field's value comes from: the run profile, the sizing file, or the person filling the form. */
export function fieldOrigin(field: SizingField, input: ProvisioningRequestInput, c: Committed): Origin {
  if (setByProfile(field, c.profile)) return { label: `from run profile ${c.profile!.name}`, tone: 'info' };
  const value = field === 'platform' || field === 'fabric' ? input[field] ?? null : input[field];
  return value === c.form[field] ? { label: 'from sizing file', tone: 'neutral' } : { label: 'changed by you', tone: 'warn' };
}

/** A shared filesystem smaller than the sizing file holds (W1-P2): from and to, in GiB. */
export function shrinkOf(input: Pick<ProvisioningRequestInput, 'filestoreSizeGib'>, c: Committed): { from: number; to: number } | undefined {
  const from = c.file.filestoreSizeGib;
  const to = input.filestoreSizeGib;
  return from !== undefined && to !== undefined && to < from ? { from, to } : undefined;
}

/**
 * What one advisor option with room would change in the request (W1-P4): another fabric of the same platform in the
 * region ("Use fabric-4"), or another region that offers the platform for this recipe ("Use eu-west1"). Undefined when
 * platform/regions.yaml does not offer it, so no button promises a plan that cannot be made.
 */
export function switchFor(
  o: AvailabilityOption,
  input: Pick<ProvisioningRequestInput, 'region' | 'platform' | 'recipe'>,
  platform: string,
  regions: RecipesResponse['regions'],
): { label: string; patch: Partial<ProvisioningRequestInput> } | undefined {
  const region = regions.find(r => r.id === o.region);
  const p = region?.platforms.find(x => x.id === platform);
  if (!region || !p) return undefined;
  if (input.recipe === 'training-capacity' && !(p.ib_preset && p.fabric)) return undefined;
  if (input.recipe === 'sandbox-inference' && !p.single_gpu_preset) return undefined;
  const capacity = o.capacityType !== undefined ? { capacityType: o.capacityType } : {};
  if (o.region === input.region) {
    if (input.recipe !== 'training-capacity' || !o.fabric || !(p.fabrics ?? [p.fabric]).includes(o.fabric)) return undefined;
    return { label: `Use ${o.fabric}`, patch: { fabric: o.fabric, ...capacity } };
  }
  const fabric = input.recipe === 'training-capacity' && o.fabric && (p.fabrics ?? [p.fabric]).includes(o.fabric) ? o.fabric : null;
  return { label: `Use ${o.region}${fabric ? ` ${fabric}` : ''}`, patch: { region: o.region, platform: platform === region.default ? null : platform, fabric, ...capacity } };
}
