import { mapBucket } from './nebius-mappers';

// Live run 2026-10-11 (R8 data): the Explorer showed the dataset and checkpoint buckets with an empty
// specification, so their storage class, versioning and lifecycle rules (what R8 sets) were invisible.
describe('bucket summary', () => {
  const ctx = { projectId: 'project-e00mocksandbox', observedAt: '2026-10-11T18:45:00Z' };

  it('summarises storage class, versioning and lifecycle rules', () => {
    const b = mapBucket(
      {
        metadata: { id: 'storagebucket-e00mock', name: 'nip-sandbox-checkpoints-x' },
        spec: { defaultStorageClass: 'STANDARD', versioningPolicy: 'ENABLED', lifecycleConfiguration: { rules: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] } },
        status: { state: 'ACTIVE' },
      },
      ctx,
    );
    expect(b.spec.summary).toBe('STANDARD · versioning ENABLED · 3 lifecycle rules');
  });

  it('reads snake_case fields and leaves out what the API omits', () => {
    const b = mapBucket({ metadata: { id: 'storagebucket-e00mock2' }, spec: { default_storage_class: 'ENHANCED_THROUGHPUT', lifecycle_configuration: { rules: [{ id: 'a' }] } }, status: {} }, ctx);
    expect(b.spec.summary).toBe('ENHANCED_THROUGHPUT · 1 lifecycle rule');
    expect(mapBucket({ metadata: { id: 'storagebucket-e00mock3' }, spec: {}, status: {} }, ctx).spec.summary).toBeUndefined();
  });
});
