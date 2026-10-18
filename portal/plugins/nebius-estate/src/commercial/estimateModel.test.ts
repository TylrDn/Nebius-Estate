import { fmtUnitRate } from './estimateModel';

describe('unit rates in the cost breakdown (#70)', () => {
  it('keeps four significant digits for small rates, so a boot disk is not rounded away, with the unit', () => {
    expect(fmtUnitRate('0.000164383561643835', 'storage_gib')).toBe('0.0001644 / GiB');
    expect(fmtUnitRate('0.0002', 'storage_gib')).toBe('0.0002 / GiB');
    expect(fmtUnitRate('10', 'gpu')).toBe('10.00 / GPU');
    expect(fmtUnitRate('0.05', 'vcpu')).toBe('0.05 / vCPU');
    expect(fmtUnitRate('0.0123456', 'ram_gib')).toBe('0.01235 / GiB RAM');
  });
});
