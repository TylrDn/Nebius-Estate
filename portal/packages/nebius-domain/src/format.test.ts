import { formatDuration } from './alerts';
import { fmtCelsius, fmtMoney, fmtMoneyOf, fmtNumber, fmtPercent, fmtPerHour, fmtThreshold } from './format';

describe('one way to write a number (W1F.S6)', () => {
  it('groups thousands and keeps a space before every unit', () => {
    expect(fmtNumber(1159.69, 2)).toBe('1,159.69');
    expect(fmtMoney({ amount: '1159.69', currency: 'XTS' })).toBe('1,159.69 XTS');
    expect(fmtMoney({ amount: '-3.5', currency: 'XTS' })).toBe('−3.50 XTS');
    expect(fmtPercent(37.84)).toBe('37.8 %');
    expect(fmtPercent(14, 0)).toBe('14 %');
    expect(fmtCelsius(54)).toBe('54 °C');
    expect(fmtPerHour({ amount: '4.83', currency: 'XTS' })).toBe('4.83 XTS / h');
    expect(fmtThreshold('50', 'percent', 'XTS')).toBe('50 %');
    expect(fmtThreshold('1500', 'amount', 'XTS')).toBe('1,500 XTS');
    expect(fmtMoneyOf({ amount: '1159.69', currency: 'XTS' }, { amount: '1500', currency: 'XTS' })).toBe('1,159.69 of 1,500.00 XTS');
    expect(fmtMoneyOf({ amount: '5', currency: 'USD' }, { amount: '10', currency: 'XTS' })).toBe('5.00 USD of 10.00 XTS');
  });

  it('writes a rule duration with its unit spaced (alert rules: "for 1 h")', () => {
    expect(formatDuration(3600)).toBe('1 h');
    expect(formatDuration(300)).toBe('5 min');
    expect(formatDuration(45)).toBe('45 s');
    expect(formatDuration(0)).toBe('0 min');
  });
});
