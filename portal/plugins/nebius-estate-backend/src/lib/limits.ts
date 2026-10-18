/**
 * In-memory bounds for expensive work: a size- and age-bounded cache, and a per-key token bucket.
 * One backend replica (docs/portal/architecture.md), so process memory is the right place.
 */

/** A Map with a size cap (least recently used goes first) and a time to live per entry. */
export class LruTtlCache<K, V> {
  private readonly entries = new Map<K, { at: number; value: V }>();
  private readonly now: () => number;

  constructor(private readonly opts: { max: number; ttlMs: number; now?: () => number }) {
    this.now = opts.now ?? Date.now;
  }

  get size(): number {
    return this.entries.size;
  }

  get(key: K): V | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    this.entries.delete(key);
    if (this.now() - hit.at >= this.opts.ttlMs) return undefined;
    this.entries.set(key, hit); // most recently used last
    return hit.value;
  }

  set(key: K, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, { at: this.now(), value });
    while (this.entries.size > this.opts.max) this.entries.delete(this.entries.keys().next().value as K);
  }
}

/**
 * A token bucket per key (e.g. per user): `capacity` requests at once, refilled at `refillPerSecond`.
 * At most `maxKeys` buckets are kept; the least recently used is dropped (it would be full again).
 */
export class TokenBucketLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  private readonly now: () => number;

  constructor(private readonly opts: { capacity: number; refillPerSecond: number; maxKeys: number; now?: () => number }) {
    this.now = opts.now ?? Date.now;
  }

  get size(): number {
    return this.buckets.size;
  }

  /** Takes one token: 0 when allowed, else the whole seconds until the next token (for Retry-After). */
  take(key: string): number {
    const now = this.now();
    const prev = this.buckets.get(key);
    this.buckets.delete(key);
    const tokens = prev ? Math.min(this.opts.capacity, prev.tokens + ((now - prev.at) / 1000) * this.opts.refillPerSecond) : this.opts.capacity;
    const allowed = tokens >= 1;
    this.buckets.set(key, { tokens: allowed ? tokens - 1 : tokens, at: now });
    while (this.buckets.size > this.opts.maxKeys) this.buckets.delete(this.buckets.keys().next().value as string);
    return allowed ? 0 : Math.max(1, Math.ceil((1 - tokens) / this.opts.refillPerSecond));
  }
}

/** HTTP 429 through the Backstage error handler (it honours `statusCode`). */
export class TooManyRequestsError extends Error {
  readonly statusCode = 429;
  constructor(message: string) {
    super(message);
    this.name = 'TooManyRequestsError';
  }
}

/**
 * Calculator-backed routes share one bucket per user: 30 at once, then one per second.
 * Includes live estimates and quotes, list-price book previews, and optional Fleet idle cost.
 */
export const CALCULATOR_RATE = { capacity: 30, refillPerSecond: 1, maxKeys: 10_000 };

/** Takes a token for `user` or throws 429 with Retry-After set on `res`. */
export function takeOrThrow(limiter: TokenBucketLimiter, user: string, res: { setHeader(name: string, value: string): unknown }): void {
  const wait = limiter.take(user);
  if (!wait) return;
  res.setHeader('Retry-After', String(wait));
  throw new TooManyRequestsError(`Too many live-price requests: try again in ${wait} s (each user may price ${CALCULATOR_RATE.capacity} at once, then one every ${1 / CALCULATOR_RATE.refillPerSecond} s).`);
}
