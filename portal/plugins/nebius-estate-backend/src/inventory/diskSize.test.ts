import { inventoryLines } from '../commercial/calculator';
import { mapDisk, mapFilesystem } from './nebius-mappers';

// Followup 15: CSI-created disks (pvc-…) were read through spec.size_gibibytes only. The disk and filesystem specs
// take exactly one of size_bytes, size_kibibytes, size_mebibytes or size_gibibytes, and status.size_bytes is
// read-only (terraform-provider compute_v1_disk / compute_v1_filesystem); a disk sized in another unit had no
// size, and the live run-rate then dropped it without a word.
describe('disk and filesystem size: every documented unit', () => {
  const ctx = { projectId: 'project-e00mocksandbox', observedAt: '2026-10-13T10:00:00Z' };
  const disk = (spec: Record<string, unknown>, status: Record<string, unknown> = {}) =>
    mapDisk({ metadata: { id: 'computedisk-e00mockpvc', name: 'pvc-e00mock' }, spec: { type: 'NETWORK_SSD', ...spec }, status: { state: 'READY', ...status } }, ctx);

  it('reads size_gibibytes, size_mebibytes, size_kibibytes and size_bytes (camelCase or snake_case)', () => {
    expect(disk({ sizeGibibytes: '128' }).spec.sizeGib).toBe(128);
    expect(disk({ size_mebibytes: '2048' }).spec.sizeGib).toBe(2);
    expect(disk({ sizeKibibytes: String(10 * 2 ** 20) }).spec.sizeGib).toBe(10);
    expect(disk({ size_bytes: String(64 * 2 ** 30) }).spec.sizeGib).toBe(64);
  });

  it('falls back to the read-only status.size_bytes when the spec names no size', () => {
    expect(disk({}, { sizeBytes: String(32 * 2 ** 30) }).spec.sizeGib).toBe(32);
    expect(disk({}, { size_bytes: String(32 * 2 ** 30) }).spec.sizeGib).toBe(32);
  });

  it('a fractional size keeps three decimals; no size at all stays undefined', () => {
    expect(disk({ sizeBytes: String(1.5 * 2 ** 30 + 1) }).spec.sizeGib).toBe(1.5);
    expect(disk({}).spec.sizeGib).toBeUndefined();
  });

  it('a filesystem reads the same units', () => {
    const fs = mapFilesystem({ metadata: { id: 'computefilesystem-e00mock', name: 'fs' }, spec: { size_bytes: String(100 * 2 ** 30) }, status: {} }, ctx);
    expect(fs.spec.sizeGib).toBe(100);
  });
});

describe('live run-rate: a disk with no size is unpriced, never dropped', () => {
  const ctx = { projectId: 'project-e00mocksandbox', observedAt: '2026-10-13T10:00:00Z' };

  it('prices a CSI disk sized in bytes and names a disk with no size as unpriced', () => {
    const sized = mapDisk({ metadata: { id: 'computedisk-e00mockpvc1', name: 'pvc-e00mock1' }, spec: { type: 'NETWORK_SSD', sizeBytes: String(50 * 2 ** 30) }, status: { state: 'READY' } }, ctx);
    const bare = mapDisk({ metadata: { id: 'computedisk-e00mockpvc2', name: 'pvc-e00mock2' }, spec: { type: 'NETWORK_SSD' }, status: { state: 'READY' } }, ctx);
    const fs = mapFilesystem({ metadata: { id: 'computefilesystem-e00mockfs', name: 'shared' }, spec: { type: 'NETWORK_SSD' }, status: { state: 'READY' } }, ctx);
    const { lines, unpriced } = inventoryLines([sized, bare, fs]);
    expect(lines.get('project-e00mocksandbox')?.map(l => l.description)).toEqual(['Disk NETWORK_SSD 50 GiB']);
    expect(unpriced.get('project-e00mocksandbox')).toEqual([
      'Disk pvc-e00mock2: the API answer has no size to price',
      'Filesystem shared: the API answer has no size to price',
    ]);
  });
});
