import { formatKubeQuantity, parseKubeQuantity, sumKubeQuantities } from './kubeQuantity';

// Followup 17: requests and limits were joined as strings ("100m+250m+100m") instead of summed.
describe('Kubernetes quantities', () => {
  it('parses decimal SI, binary SI, milli and exponent forms', () => {
    expect(parseKubeQuantity('250m')).toBe(0.25);
    expect(parseKubeQuantity('2')).toBe(2);
    expect(parseKubeQuantity('1.5')).toBe(1.5);
    expect(parseKubeQuantity('128Mi')).toBe(128 * 2 ** 20);
    expect(parseKubeQuantity('1Gi')).toBe(2 ** 30);
    expect(parseKubeQuantity('2Ki')).toBe(2048);
    expect(parseKubeQuantity('1G')).toBe(1e9);
    expect(parseKubeQuantity('500k')).toBe(500e3);
    expect(parseKubeQuantity('1e3')).toBe(1000);
    expect(parseKubeQuantity('12E')).toBe(12e18);
    expect(parseKubeQuantity('lots')).toBeUndefined();
    expect(parseKubeQuantity('')).toBeUndefined();
  });

  it('formats CPU-like totals in cores or millicores and byte totals in the largest exact unit', () => {
    expect(formatKubeQuantity(0.45)).toBe('450m');
    expect(formatKubeQuantity(2)).toBe('2');
    expect(formatKubeQuantity(1.5)).toBe('1500m');
    expect(formatKubeQuantity(384 * 2 ** 20)).toBe('384Mi');
    expect(formatKubeQuantity(3 * 2 ** 30)).toBe('3Gi');
    expect(formatKubeQuantity(1.5e9)).toBe('1500M');
    // Below a millicore the total keeps its value: micro and nano units, never rounded to 0.001 or 0.
    expect(formatKubeQuantity(0.0005)).toBe('500u');
    expect(sumKubeQuantities(['1n', '1n'])).toBe('2n');
    expect(sumKubeQuantities(['1m', '500u'])).toBe('1500u');
  });

  it('sums mixed units: 100m + 250m + 100m CPU, 128Mi + 1Gi + 256Mi memory', () => {
    expect(sumKubeQuantities(['100m', '250m', '100m'])).toBe('450m');
    expect(sumKubeQuantities(['128Mi', '1Gi', '256Mi'])).toBe('1408Mi');
    expect(sumKubeQuantities(['1', '1'])).toBe('2');
    expect(sumKubeQuantities(['500m', '1500m'])).toBe('2');
  });

  it('a value it cannot read is kept, never summed as zero', () => {
    expect(sumKubeQuantities(['100m', 'weird'])).toBe('100m + weird');
  });
});
