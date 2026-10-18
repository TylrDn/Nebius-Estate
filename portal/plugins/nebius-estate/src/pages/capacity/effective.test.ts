import type { PlatformView, QuotaAllowanceView } from '@internal/nebius-domain';
import { gpuClusterBlock, k8sRecipeUsability, platformsWithoutQuota, tileLimit } from './effective';

const q = (over: Partial<QuotaAllowanceView>): QuotaAllowanceView => ({
  scope: 'tenant',
  projectId: '',
  name: 'compute.instance.gpu.b300',
  region: 'uk-south1',
  allocation: 'set',
  limit: 32,
  usage: 0,
  usagePercent: 0,
  unit: 'gpu',
  ...over,
});
const LAB = 'project-e00mocklab';
const OTHER = 'project-e00mockother';
const tenantB300 = q({});
const labCap = q({ scope: 'project', projectId: LAB, limit: 1, usage: 1 });

describe('tileLimit: the effective limit min(project cap, tenant) (W1-P14)', () => {
  it('under a project filter, the project cap below the tenant limit is the limit, "capped by project"', () => {
    expect(tileLimit(tenantB300, [tenantB300, labCap], LAB)).toEqual({ caps: [{ projectId: LAB, limit: 1, usage: 1 }], capsUnknown: false, effective: { projectId: LAB, limit: 1, usage: 1, by: 'project' } });
  });

  it('a project without a cap of its own (a placeholder, or none listed) gets the tenant limit', () => {
    const placeholder = q({ scope: 'project', projectId: LAB, allocation: 'inherits-tenant', limit: null, usage: 1 });
    expect(tileLimit(tenantB300, [tenantB300, placeholder], LAB).effective).toEqual({ projectId: LAB, limit: 32, usage: 0, by: 'tenant' });
    const otherQuota = q({ scope: 'project', projectId: LAB, name: 'compute.instance.non-gpu.vcpu', limit: 8 });
    expect(tileLimit(tenantB300, [tenantB300, otherQuota], LAB).effective?.by).toBe('tenant');
    // A cap above the tenant limit has no effect: the tenant limit binds.
    expect(tileLimit(tenantB300, [tenantB300, q({ scope: 'project', projectId: LAB, limit: 64 })], LAB).effective?.by).toBe('tenant');
  });

  it('without a filter, every project capped below the tenant limit is listed (a cap of 0 included); other regions and quotas are not', () => {
    const zero = q({ scope: 'project', projectId: OTHER, limit: 0 });
    const elsewhere = q({ scope: 'project', projectId: OTHER, region: 'eu-west2', limit: 0 });
    const t = tileLimit(tenantB300, [tenantB300, labCap, zero, elsewhere]);
    expect(t.caps).toEqual([{ projectId: OTHER, limit: 0, usage: 0 }, { projectId: LAB, limit: 1, usage: 1 }]);
    expect(t.effective).toBeUndefined();
    expect(t.capsUnknown).toBe(false);
  });

  it('project caps unknown when no project allowance was read (for the filtered project, or at all)', () => {
    expect(tileLimit(tenantB300, [tenantB300]).capsUnknown).toBe(true);
    expect(tileLimit(tenantB300, [tenantB300, q({ scope: 'project', projectId: OTHER, name: 'vpc.allocation.count' })], LAB)).toEqual({ caps: [], capsUnknown: true });
  });

  it('a project allowance tile (no tenant read) has nothing to compare', () => {
    expect(tileLimit(labCap, [labCap], LAB)).toEqual({ caps: [], capsUnknown: false });
  });
});

describe('gpuClusterBlock: GPU clusters cap 0 keeps 8-GPU presets out of an InfiniBand GPU cluster (W1-P14)', () => {
  const cluster = (over: Partial<QuotaAllowanceView>) => q({ name: 'compute.gpucluster.count', unit: 'count', region: 'eu-north1', limit: 5, ...over });
  it('names a tenant limit 0 and every project capped at 0 in the region', () => {
    expect(gpuClusterBlock('eu-north1', [cluster({ limit: 0 })])).toEqual({ tenant: true, projects: [] });
    expect(gpuClusterBlock('eu-north1', [cluster({}), cluster({ scope: 'project', projectId: 'project-e00mockstaging', limit: 0 })])).toEqual({ tenant: false, projects: ['project-e00mockstaging'] });
  });
  it('under a project filter, only that project counts; nothing blocks → null', () => {
    const quotas = [cluster({}), cluster({ scope: 'project', projectId: 'project-e00mockstaging', limit: 0 })];
    expect(gpuClusterBlock('eu-north1', quotas, 'project-e00mocksandbox')).toBeNull();
    expect(gpuClusterBlock('eu-north1', quotas, 'project-e00mockstaging')).toEqual({ tenant: false, projects: ['project-e00mockstaging'] });
    expect(gpuClusterBlock('uk-south1', quotas)).toBeNull();
    // A placeholder is not a cap of 0.
    expect(gpuClusterBlock('eu-north1', [cluster({}), cluster({ scope: 'project', projectId: LAB, allocation: 'inherits-tenant', limit: null })])).toBeNull();
  });
});

describe('k8sRecipeUsability: the non-GPU vCPU a recipe\'s CPU node groups need (W1-P15)', () => {
  const vcpu = (over: Partial<QuotaAllowanceView>) => q({ name: 'compute.instance.non-gpu.vcpu', unit: 'vcpu', region: 'eu-north1', limit: 200, usage: 48, ...over });
  it('a tenant limit of 0 blocks the CPU node groups; room is said in vCPUs; at the limit is full', () => {
    expect(k8sRecipeUsability('eu-north1', [vcpu({ limit: 0 })])).toMatchObject({ state: 'cpu-blocked', limit: 0, usage: 48, by: 'tenant' });
    expect(k8sRecipeUsability('eu-north1', [vcpu({})])).toMatchObject({ state: 'yes', limit: 200, usage: 48, by: 'tenant' });
    expect(k8sRecipeUsability('eu-north1', [vcpu({ usage: 200 })])).toMatchObject({ state: 'full' });
  });
  it('a project cap below the tenant limit applies under its filter, and is named without one', () => {
    const quotas = [vcpu({}), vcpu({ scope: 'project', projectId: LAB, limit: 0, usage: 0 })];
    expect(k8sRecipeUsability('eu-north1', quotas, LAB)).toMatchObject({ state: 'cpu-blocked', limit: 0, by: 'project' });
    expect(k8sRecipeUsability('eu-north1', quotas)).toMatchObject({ state: 'yes', projectsBlocked: [LAB] });
  });
  it('unknown when no non-GPU vCPU allowance is listed in the region', () => {
    expect(k8sRecipeUsability('uk-south1', [vcpu({})])).toEqual({ state: 'unknown', projectsBlocked: [] });
  });
  it('with project allowances only, the project caps are what is known', () => {
    expect(k8sRecipeUsability('eu-north1', [vcpu({ scope: 'project', projectId: LAB, limit: 16, usage: 0 })])).toMatchObject({ state: 'yes', limit: 16, by: 'project', projectId: LAB });
  });
  it('with project caps only and no filter, the highest cap is shown with its project; projects at 0 are named, not the region', () => {
    const caps = [vcpu({ scope: 'project', projectId: LAB, limit: 0, usage: 0 }), vcpu({ scope: 'project', projectId: OTHER, limit: 64, usage: 16 })];
    expect(k8sRecipeUsability('eu-north1', caps)).toEqual({ state: 'yes', limit: 64, usage: 16, by: 'project', projectId: OTHER, projectsBlocked: [LAB] });
    expect(k8sRecipeUsability('eu-north1', caps, LAB)).toMatchObject({ state: 'cpu-blocked', projectId: LAB });
  });
});

describe('platformsWithoutQuota: live-API GPU platforms with no quota tile (W1-P17)', () => {
  const platform = (name: string, gpus: number, regions: string[]): PlatformView => ({ name, presets: [{ name: `${gpus}gpu`, gpus, vcpus: 8, memoryGibibytes: 32 }], projects: [LAB], regions });
  it('GB300 offered in a region with no compute.instance.gpu.gb300 allowance gets a card; listed models and CPU platforms do not', () => {
    const platforms = [platform('gpu-gb300', 4, ['eu-north1']), platform('gpu-h100-sxm', 8, ['eu-north1']), platform('cpu-d3', 0, ['eu-north1']), platform('gpu-b300-sxm', 8, ['uk-south1'])];
    const quotas = [q({ name: 'compute.instance.gpu.h100', region: 'eu-north1' }), tenantB300];
    expect(platformsWithoutQuota(platforms, quotas, 'eu-north1').map(p => p.name)).toEqual(['gpu-gb300']);
    expect(platformsWithoutQuota(platforms, quotas, 'uk-south1')).toEqual([]);
    expect(platformsWithoutQuota(null, quotas, 'eu-north1')).toEqual([]);
  });
});
