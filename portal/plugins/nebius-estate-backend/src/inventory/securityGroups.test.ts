import { mapInstance } from './nebius-mappers';

// Live run 2026-10-11 (R10 gpu-vm): the VM's access group (network_interfaces[].security_groups) was
// listed in the inventory but the graph had no edge between the VM and it.
describe('instance → security group', () => {
  const ctx = { projectId: 'project-e00mocksandbox', observedAt: '2026-10-11T18:00:00Z' };

  it('links a VM to every security group on its interfaces, once each', () => {
    const vm = mapInstance(
      {
        metadata: { id: 'computeinstance-e00mockgpuvm' },
        spec: {
          resources: { platform: 'gpu-l40s-a', preset: '1gpu-8vcpu-32gb' },
          networkInterfaces: [
            { subnetId: 'vpcsubnet-e00mock', securityGroups: [{ id: 'vpcsecuritygroup-e00mockaccess' }, { id: 'vpcsecuritygroup-e00mockwork' }] },
            { subnet_id: 'vpcsubnet-e00mock', security_groups: [{ id: 'vpcsecuritygroup-e00mockaccess' }] },
          ],
        },
        status: { state: 'RUNNING' },
      },
      ctx,
    );
    expect(vm.refs.filter(r => r.relation === 'secured-by')).toEqual([
      { relation: 'secured-by', target: 'vpcsecuritygroup-e00mockaccess' },
      { relation: 'secured-by', target: 'vpcsecuritygroup-e00mockwork' },
    ]);
    expect(vm.refs).toContainEqual({ relation: 'in-subnet', target: 'vpcsubnet-e00mock' });
  });

  it('adds no edge when the interface names no group (the network default applies)', () => {
    const vm = mapInstance({ metadata: { id: 'computeinstance-e00mockx' }, spec: { networkInterfaces: [{ subnetId: 'vpcsubnet-e00mock' }] }, status: {} }, ctx);
    expect(vm.refs.some(r => r.relation === 'secured-by')).toBe(false);
  });
});
