import type { CapabilityStatus, CapacityBlockGroupView, FitsInRegion, Footprint, ProvisioningContext, ProvisioningRequestInput, QuotaAllowanceView, RegionsFile, ReservationCheck } from '@internal/nebius-domain';
import { fmtUtc, previewChange, validateProvisioningRequest } from '@internal/nebius-domain';
import { quotaCheckFor } from '../views';

type Caps = (Pick<CapabilityStatus, 'id' | 'state' | 'hint'> & Partial<Pick<CapabilityStatus, 'lastSuccess' | 'stale'>>)[];

/**
 * Where else the same request fits, by the tenant allowances the quota API lists in each region (W1-P3): every
 * compute VM requirement checked there and within its limit. The requested GPU platform is kept where the region
 * offers it, else the region's default. A run profile pins its region, so none is offered then.
 */
export function fitsElsewhere(quotas: QuotaAllowanceView[], input: ProvisioningRequestInput, ctx: ProvisioningContext, capabilities: Caps): FitsInRegion[] {
  if (input.runProfile || input.recipe === 'soperator-lab') return [];
  const out: FitsInRegion[] = [];
  for (const [region, entry] of Object.entries(ctx.regions.regions)) {
    if (region === input.region) continue;
    const platform = input.platform && entry.platforms[input.platform] ? input.platform : null;
    const alt: ProvisioningRequestInput = { ...input, region, platform, fabric: null };
    if (validateProvisioningRequest(alt, ctx).some(i => i.severity === 'error' && ['platform', 'region', 'capacityType'].includes(i.field))) continue;
    const change = previewChange(alt, ctx);
    const check = quotaCheckFor(quotas, change.footprint, region, input.capacityType, input.recipe === 'training-capacity', capabilities, change.quota.mk8sClusters);
    if (check.source !== 'tenant' || !check.lines.length || check.lines.some(l => l.state !== 'ok')) continue;
    // Confirmed only where the compute VM quotas themselves are listed: a region with no compute rows proves nothing.
    if (check.unchecked.some(u => u.quota.startsWith('compute.instance.'))) continue;
    out.push({ region, platform: platform ?? entry.default, checked: check.lines.length, unchecked: check.unchecked.map(u => u.quota) });
  }
  return out;
}

/**
 * A reserved request against the tenant's capacity block groups (capacity.v1, W1-P4): the groups of its region and
 * GPU platform. Undefined unless the request is reserved and has GPU nodes. Block groups not read: unknown.
 */
export function reservationCheck(
  groups: CapacityBlockGroupView[],
  fp: Footprint,
  input: Pick<ProvisioningRequestInput, 'region' | 'capacityType' | 'reservationPolicy'>,
  regions: RegionsFile,
  capabilities: Caps,
): ReservationCheck | undefined {
  if (input.capacityType !== 'reserved') return undefined;
  const g = fp.nodeGroups.find(x => x.role !== 'system' && x.count > 0 && /gpu-/.test(x.preset));
  if (!g) return undefined;
  const policy = input.reservationPolicy ?? 'AUTO';
  const platform = g.platform || regions.regions[input.region]?.default || 'the GPU platform';
  const base = { policy, region: input.region, platform } as const;
  const read = capabilities.find(c => c.id === 'capacity.block-groups');
  const at = read?.lastSuccess ? { observedAt: read.lastSuccess } : {};
  const matching = groups.filter(b => b.region === input.region && b.platform === platform && !/INACTIVE|SHUTTING/i.test(b.state ?? ''));
  if (matching.length) {
    const list = matching.map(b => `${b.name} (${b.fabric ?? 'no fabric stated'}, ${b.usage ?? '?'} of ${b.limit ?? '?'} in use)`).join('; ');
    return { ...base, ...at, state: 'matching', groups: matching, message: `${matching.length} capacity block group${matching.length === 1 ? '' : 's'} for ${platform} in ${input.region}: ${list}. Pass the reservation ids at plan time (TF_VAR_gpu_reservation); they are never committed.` };
  }
  if (read?.state !== 'ok' && !groups.length) {
    return { ...base, state: 'unknown', groups: [], message: `Reservations unknown: the tenant's capacity block groups were not read (${read ? read.state.replace(/-/g, ' ') : 'no sync yet'}${read?.lastSuccess ? `; last read ${fmtUtc(read.lastSuccess)}` : ''}). Check them before a ${policy} plan.` };
  }
  const tail =
    policy === 'STRICT'
      ? 'a STRICT node group draws only on a reservation, so its nodes cannot start. Request a capacity block group (runbooks/capacity-request.md) or choose AUTO / on-demand.'
      : 'AUTO falls back to on-demand capacity, which needs GPU quota.';
  return { ...base, ...at, state: 'none', groups: [], message: `The tenant lists no capacity block group for ${platform} in ${input.region} (capacity.v1): ${tail}` };
}
