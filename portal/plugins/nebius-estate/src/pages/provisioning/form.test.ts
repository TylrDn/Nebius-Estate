import type { ProvisioningRequestInput, RecipesResponse } from '@internal/nebius-domain';
import { committedFor, fieldOrigin, prefill, setByProfile, shrinkOf, switchFor } from './form';

/** The sizing files as the backend serves them (GET /provisioning/recipes), trimmed to the fields the form edits. */
const data: Pick<RecipesResponse, 'sizing' | 'regions'> = {
  sizing: [
    { stage: 'sandbox', stack: 'training', sizingFile: 'terraform/live/sandbox/training/sandbox.auto.tfvars', sizing: { cpu_node_count: 2, gpu_node_count: 0, enable_filestore: true, filestore_size_gib: 256 } },
    { stage: 'staging', stack: 'training', sizingFile: 'terraform/live/staging/training/staging.auto.tfvars', sizing: { cpu_node_count: 2, gpu_node_count: 0, enable_filestore: true, filestore_size_gib: 1024 } },
    { stage: 'prod', stack: 'training', sizingFile: 'terraform/live/prod/training/prod.auto.tfvars', sizing: { cpu_node_count: 3, gpu_node_count: 0, enable_filestore: true, filestore_size_gib: 4096 } },
    {
      stage: 'sandbox', stack: 'inference', sizingFile: 'terraform/live/sandbox/inference/sandbox.auto.tfvars',
      sizing: { cpu_node_count: 2, gpu_node_count: 1, gpu_preemptible: true, enable_filestore: true, filestore_size_gib: 64 },
      runProfiles: [{ name: 'l40s-gpu-only', region: 'eu-north1', vars: { cpu_node_count: 0, gpu_platform: 'gpu-l40s-a', gpu_preset: '1gpu-8vcpu-32gb', gpu_node_count: 1, gpu_preemptible: true, enable_filestore: true, filestore_size_gib: 64 } }],
    },
  ],
  regions: [
    { id: 'eu-north1', default: 'gpu-h100-sxm', platforms: [{ id: 'gpu-h100-sxm', single_gpu_preset: '1gpu-16vcpu-200gb', ib_preset: '8gpu-128vcpu-1600gb', fabric: 'fabric-3', fabrics: ['fabric-2', 'fabric-3', 'fabric-4', 'fabric-6'] }, { id: 'gpu-l40s-a', single_gpu_preset: '1gpu-8vcpu-32gb' }] },
    { id: 'eu-west1', default: 'gpu-h200-sxm', platforms: [{ id: 'gpu-h200-sxm', single_gpu_preset: '1gpu-16vcpu-200gb', ib_preset: '8gpu-128vcpu-1600gb', fabric: 'fabric-5', fabrics: ['fabric-5'] }] },
    { id: 'us-central1', default: 'gpu-h200-sxm', platforms: [{ id: 'gpu-h200-sxm', single_gpu_preset: '1gpu-16vcpu-200gb', ib_preset: '8gpu-128vcpu-1600gb', fabric: 'us-central1-a' }] },
  ],
};
const training = { id: 'training-capacity' as const, stack: 'training' as const };
const inference = { id: 'sandbox-inference' as const, stack: 'inference' as const };
const base: ProvisioningRequestInput = { recipe: 'training-capacity', stage: 'sandbox', region: 'eu-north1', platform: null, gpuNodeCount: 0, capacityType: 'on-demand', filestoreSizeGib: 256, runtimeHours: 8, owner: 'platform', requestRef: 'r' };

describe('W1-P1: the form follows the committed sizing of the chosen stage', () => {
  it('switching sandbox → prod prefills 4096 GiB, never keeps the sandbox 256 GiB', () => {
    const prod = prefill({ ...base, stage: 'prod' }, committedFor(data, training, 'prod'), ['on-demand', 'reserved', 'preemptible']);
    expect(prod).toMatchObject({ gpuNodeCount: 0, filestoreSizeGib: 4096, capacityType: 'on-demand', platform: null, fabric: null });
    expect(prefill({ ...base, stage: 'staging' }, committedFor(data, training, 'staging'), ['on-demand']).filestoreSizeGib).toBe(1024);
  });

  it('badges each field "from sizing file" or "changed by you"', () => {
    const c = committedFor(data, training, 'prod');
    const input = prefill({ ...base, stage: 'prod' }, c, ['on-demand']);
    expect(fieldOrigin('filestoreSizeGib', input, c)).toEqual({ label: 'from sizing file', tone: 'neutral' });
    expect(fieldOrigin('gpuNodeCount', { ...input, gpuNodeCount: 2 }, c)).toEqual({ label: 'changed by you', tone: 'warn' });
    expect(fieldOrigin('platform', { ...input, platform: undefined }, c).label).toBe('from sizing file');
  });

  it('W1-P2: a smaller filesystem than the sizing file is a shrink', () => {
    const c = committedFor(data, training, 'prod');
    expect(shrinkOf({ filestoreSizeGib: 256 }, c)).toEqual({ from: 4096, to: 256 });
    expect(shrinkOf({ filestoreSizeGib: 4096 }, c)).toBeUndefined();
    expect(shrinkOf({ filestoreSizeGib: 8192 }, c)).toBeUndefined();
  });
});

describe('#27: a run profile in the Provisioning form', () => {
  it('prefills from the profile, takes its region and name, and owns the fields it sets', () => {
    const c = committedFor(data, inference, 'sandbox', 'l40s-gpu-only');
    const input = prefill({ ...base, recipe: 'sandbox-inference', region: 'eu-west1' }, c, ['preemptible', 'on-demand', 'reserved']);
    expect(input).toMatchObject({ runProfile: 'l40s-gpu-only', region: 'eu-north1', platform: 'gpu-l40s-a', gpuNodeCount: 1, capacityType: 'preemptible', filestoreSizeGib: 64 });
    expect(setByProfile('gpuNodeCount', c.profile)).toBe(true);
    expect(setByProfile('fabric', c.profile)).toBe(false);
    expect(fieldOrigin('platform', input, c)).toEqual({ label: 'from run profile l40s-gpu-only', tone: 'info' });
    // Back to no profile: the sizing file again, and no runProfile in the request.
    const none = prefill(input, committedFor(data, inference, 'sandbox'), ['preemptible']);
    expect(none.runProfile).toBeUndefined();
    expect(none.platform).toBeNull();
  });
});

describe('W1-P4: one-click switches from the advisor', () => {
  const t = { ...base, recipe: 'training-capacity' as const };
  it('another listed fabric of the platform in the region: "Use fabric-4"', () => {
    expect(switchFor({ region: 'eu-north1', fabric: 'fabric-4', capacityType: 'on-demand', level: 'high', available: 6 }, t, 'gpu-h100-sxm', data.regions)).toEqual({ label: 'Use fabric-4', patch: { fabric: 'fabric-4', capacityType: 'on-demand' } });
    // A fabric name platform/regions.yaml does not list for it: no button.
    expect(switchFor({ region: 'eu-north1', fabric: 'eu-north1-a', capacityType: 'on-demand', level: 'high', available: 6 }, t, 'gpu-h100-sxm', data.regions)).toBeUndefined();
  });

  it('another region only where it offers the platform', () => {
    expect(switchFor({ region: 'eu-west1', fabric: 'fabric-5', capacityType: 'on-demand', level: 'high', available: 3 }, t, 'gpu-h200-sxm', data.regions)).toEqual({ label: 'Use eu-west1 fabric-5', patch: { region: 'eu-west1', platform: null, fabric: 'fabric-5', capacityType: 'on-demand' } });
    expect(switchFor({ region: 'us-central1', fabric: 'us-central1-b', capacityType: 'on-demand', level: 'medium', available: 3 }, t, 'gpu-h100-sxm', data.regions)).toBeUndefined();
  });
});
