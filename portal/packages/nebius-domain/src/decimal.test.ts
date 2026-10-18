import { Decimal, DecimalParseError } from './decimal';
import { CurrencyMismatchError, MoneyBag, addMoney, money } from './money';
import { parsePreset, toHourly } from './units';

describe('Decimal', () => {
  it('adds without float error', () => {
    expect(Decimal.from('0.1').add('0.2').toString()).toBe('0.3');
    expect(Decimal.sum(Array.from({ length: 1000 }, () => Decimal.from('0.0001'))).toString()).toBe('0.1');
  });

  it('multiplies and divides with half-even rounding at 12 digits', () => {
    expect(Decimal.from('1').div(3).toString()).toBe('0.333333333333');
    expect(Decimal.from('2').div(3).toString()).toBe('0.666666666667');
    expect(Decimal.from('0.0000000000005').toString()).toBe('0'); // half-even: 0.5e-12 → 0
    expect(Decimal.from('0.0000000000015').toString()).toBe('0.000000000002');
    expect(Decimal.from('-1.5').mul('2').toString()).toBe('-3');
  });

  it('formats with toFixed half-even and keeps sign', () => {
    expect(Decimal.from('2.345').toFixed(2)).toBe('2.34');
    expect(Decimal.from('2.355').toFixed(2)).toBe('2.36');
    expect(Decimal.from('-0.004').toFixed(2)).toBe('0.00');
    expect(Decimal.from('-1.005').toFixed(2)).toBe('-1.00');
    expect(Decimal.from('12').toFixed(0)).toBe('12');
  });

  it('rejects floats, exponents and separators', () => {
    expect(() => Decimal.from(0.1)).toThrow(DecimalParseError);
    expect(() => Decimal.from('1e3')).toThrow(DecimalParseError);
    expect(() => Decimal.from('1,000')).toThrow(DecimalParseError);
    expect(Decimal.isValid('-12.50')).toBe(true);
  });

  it('compares', () => {
    expect(Decimal.from('1.10').eq('1.1')).toBe(true);
    expect(Decimal.from('-1').cmp('0')).toBe(-1);
  });
});

describe('Money', () => {
  it('refuses to add different currencies', () => {
    expect(() => addMoney(money('1', 'USD'), money('1', 'EUR'))).toThrow(CurrencyMismatchError);
  });

  it('keeps per-currency totals in a bag', () => {
    const bag = new MoneyBag().add('1.5', 'USD').add('2', 'EUR').add('-0.5', 'USD');
    expect(bag.toList()).toEqual([
      { amount: '2', currency: 'EUR' },
      { amount: '1', currency: 'USD' },
    ]);
    expect(() => bag.single()).toThrow(CurrencyMismatchError);
  });
});

describe('units', () => {
  it('normalises periods to hourly', () => {
    expect(toHourly('0.001', 'second').toString()).toBe('3.6');
    expect(toHourly('73', 'month730').toString()).toBe('0.1');
    expect(toHourly('2.5', 'hour').toString()).toBe('2.5');
  });

  it('parses Nebius preset names and nothing else', () => {
    expect(parsePreset('1gpu-16vcpu-200gb')).toEqual({ gpus: 1, vcpus: 16, ramGib: 200 });
    expect(parsePreset('8vcpu-32gb')).toEqual({ gpus: 0, vcpus: 8, ramGib: 32 });
    expect(parsePreset('large')).toBeUndefined();
  });
});
