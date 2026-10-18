/**
 * Kubernetes resource quantities (k8s.io/apimachinery resource.Quantity): a number with an optional binary-SI
 * (Ki, Mi, Gi, Ti, Pi, Ei), decimal-SI (n, u, m, k, M, G, T, P, E) or exponent (e3, E6) suffix. Used to sum a pod's
 * container requests and limits (followup 17), which were joined as strings before.
 */

const BINARY: Record<string, number> = { Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40, Pi: 2 ** 50, Ei: 2 ** 60 };
const DECIMAL: Record<string, number> = { n: 1e-9, u: 1e-6, m: 1e-3, '': 1, k: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18 };
const QUANTITY = /^([+-]?(?:\d+\.?\d*|\.\d+))(?:([eE][+-]?\d+)|(Ki|Mi|Gi|Ti|Pi|Ei|n|u|m|k|M|G|T|P|E))?$/;

/** The quantity as a plain number (cores, bytes, count), or undefined when it is not a Kubernetes quantity. */
export function parseKubeQuantity(q: string | number | undefined): number | undefined {
  if (typeof q === 'number') return Number.isFinite(q) ? q : undefined;
  const m = QUANTITY.exec(String(q ?? '').trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  if (m[2]) return n * 10 ** Number(m[2].slice(1));
  const suffix = m[3] ?? '';
  return n * (BINARY[suffix] ?? DECIMAL[suffix]);
}

const near = (x: number) => Math.abs(x - Math.round(x)) < 1e-9 * Math.max(1, Math.abs(x));

/**
 * A total in Kubernetes form: whole numbers in the largest unit that divides them exactly (binary first: 1408Mi, 3Gi;
 * then decimal: 1500M), fractions in millis (450m), micros or nanos (500u); a plain number otherwise.
 */
export function formatKubeQuantity(n: number): string {
  if (near(n)) {
    const whole = Math.round(n);
    if (whole >= 1024) {
      for (const [s, f] of Object.entries(BINARY).reverse()) if (whole >= f && whole % f === 0) return `${whole / f}${s}`;
    }
    if (whole >= 1000) {
      for (const s of ['E', 'P', 'T', 'G', 'M', 'k']) if (whole >= DECIMAL[s] && whole % DECIMAL[s] === 0) return `${whole / DECIMAL[s]}${s}`;
    }
    return String(whole);
  }
  // Fractions in the largest of m, u, n that holds them whole (a sub-millicore total is never rounded away).
  for (const [s, f] of [['m', 1e3], ['u', 1e6], ['n', 1e9]] as const) if (near(n * f)) return `${Math.round(n * f)}${s}`;
  return String(Number(n.toPrecision(12)));
}

/** Sums quantities across containers; a value that is not a quantity is kept as written, never counted as zero. */
export function sumKubeQuantities(values: Array<string | number>): string {
  const parsed = values.map(v => parseKubeQuantity(v));
  if (parsed.some(v => v === undefined)) {
    const total = parsed.filter((v): v is number => v !== undefined).reduce((a, b) => a + b, 0);
    const unread = values.filter((_, i) => parsed[i] === undefined).map(String);
    return [...(parsed.some(v => v !== undefined) ? [formatKubeQuantity(total)] : []), ...unread].join(' + ');
  }
  return formatKubeQuantity((parsed as number[]).reduce((a, b) => a + b, 0));
}
