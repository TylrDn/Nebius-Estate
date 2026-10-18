/**
 * Outbound HTTP for connectors. Every call:
 *  - goes only to an origin on the connector's allowlist (SSRF guard: URLs
 *    are built from configuration, never from request input, and checked),
 *  - has a hard timeout,
 *  - retries 429/5xx with exponential backoff and jitter, honouring Retry-After, a bounded
 *    number of times; retries connect-class network errors (isConnectClass) for up to
 *    `connectRetryBudgetMs` (~30 s inside a sync, inBackgroundSync: long enough for Wi-Fi and DNS
 *    to come back after a laptop wakes; ~3 s on a request a person waits for); fails fast on any other error, and names the cause (`err.cause.code`) in the message,
 *  - never puts credentials into thrown messages or logs (redact()),
 *  - is a GET unless its exact URL path is on the client's POST allowlist
 *    (the token exchange and the billing calculator: both read-only), or a
 *    HEAD on a client created with `allowHead` (an access check, see head()),
 *  - waits its turn on the host's limiter (concurrency and spacing per host).
 */
import { AsyncLocalStorage } from 'async_hooks';

/** Sent on every outbound request (the plugin's package version). */
export const USER_AGENT = 'nebius-estate/0.1.0';

export type FetchFn = (url: string, init: RequestInit & { signal?: AbortSignal }) => Promise<Response>;

export interface HttpClientOptions {
  allowedOrigins: string[];
  timeoutMs: number;
  maxRetries?: number;
  baseDelayMs?: number;
  fetch?: FetchFn;
  /** Returns the Authorization header value, e.g. "Bearer …". */
  authorization?: () => Promise<string | undefined>;
  sleep?: (ms: number) => Promise<void>;
  /** Exact URL paths that may be POSTed to; everything else must be a GET. */
  allowPostPaths?: string[];
  /** Shared per host: bounds concurrency and request rate towards it. */
  limiter?: HostLimiter;
  /** Allows head(): a read-only access check that returns the status (e.g. can a token read a gated file). */
  allowHead?: boolean;
  /** Upper bound on a JSON response body (request()); a larger answer is an error, not a memory spike. */
  maxResponseBytes?: number;
  /** Time a connect-class error is retried for, attempts and backoff included (default 30 s in a sync, else 3 s). */
  connectRetryBudgetMs?: number;
  /** Monotonic clock in ms for the connect budget (tests); default performance.now. */
  now?: () => number;
}

/** Connect retry budget of a sync (inBackgroundSync): the 2026-10-12 wake-from-sleep failures all fell inside ~2.5 s. */
export const CONNECT_RETRY_BUDGET_MS = 30_000;
/** Connect retry budget of a request a person waits for (a page's Logs, audit or Monitoring query): fail in seconds. */
export const REQUEST_CONNECT_RETRY_BUDGET_MS = 3_000;

const backgroundSync = new AsyncLocalStorage<{ stop?: AbortSignal }>();

/**
 * Runs a sync (scheduled or "Sync now"): the calls it makes, through any client, retry a connect-class error for
 * the long budget. Calls outside one (request handlers) keep the short budget, so a page never hangs ~30 s.
 * `stop` (the plugin shutting down) ends the sync's calls: an in-flight call is aborted, a back-off wait ends at once,
 * and no further attempt is made, so a stopped backend never syncs on into a closed database.
 */
export function inBackgroundSync<T>(fn: () => Promise<T>, stop?: AbortSignal): Promise<T> {
  return backgroundSync.run({ stop }, fn);
}

/** The error a sync's call ends with once its backend is stopping. */
export class SyncStoppedError extends Error {
  constructor(url: string) {
    super(`${safePath(url)}: stopped: the portal backend is shutting down`);
    this.name = 'SyncStoppedError';
  }
}

/** Waits `ms`, or less when `stop` fires first. */
function stoppable(sleep: (ms: number) => Promise<void>, ms: number, stop?: AbortSignal): Promise<void> {
  if (!stop) return sleep(ms);
  if (stop.aborted) return Promise.resolve();
  let onAbort!: () => void;
  const aborted = new Promise<void>(r => {
    onAbort = r;
    stop.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([sleep(ms), aborted]).finally(() => stop.removeEventListener('abort', onAbort));
}
/** Upper bound on one backoff step between connect retries, so the network is probed every few seconds. */
const CONNECT_MAX_DELAY_MS = 5_000;

/**
 * Errors where no answer came because the connection could not be made or was dropped: the network or DNS is not
 * (yet) there, the peer reset a pooled socket, or the attempt timed out. undici puts the reason in `cause`
 * (`TypeError: fetch failed`, cause.code ECONNRESET …); a timeout is a TimeoutError (AbortSignal.timeout).
 */
export const CONNECT_CLASS_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET', 'UND_ERR_SOCKET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT',
]);

/** The cause code of a failed fetch (`err.cause.code`), or the error's own code; `TimeoutError` for a timeout. */
export function causeCode(e: unknown): string | undefined {
  const err = e as { name?: string; code?: unknown; cause?: { code?: unknown; name?: string } } | undefined;
  if (err?.name === 'TimeoutError' || err?.cause?.name === 'TimeoutError') return 'TimeoutError';
  const code = err?.cause?.code ?? err?.code;
  return typeof code === 'string' ? code : undefined;
}

export function isConnectClass(e: unknown): boolean {
  const code = causeCode(e);
  return code === 'TimeoutError' || (code !== undefined && CONNECT_CLASS_CODES.has(code));
}

/** "fetch failed (ECONNREFUSED: connect ECONNREFUSED 203.0.113.10:443)": the message with its cause, in full. */
export function describeNetworkError(e: Error): string {
  const cause = (e as { cause?: unknown }).cause as { code?: unknown; message?: unknown } | undefined;
  const code = causeCode(e);
  const causeMessage = cause && typeof cause.message === 'string' && cause.message !== e.message ? cause.message : undefined;
  if (code === 'TimeoutError' && !causeMessage) return `${e.message} (TimeoutError)`;
  if (!code && !causeMessage) return e.message;
  return `${e.message} (${[code, causeMessage].filter(Boolean).join(': ')})`;
}

/** Response cap of the Nebius Monitoring and Logs clients (query_range and LogQL answers). */
export const MAX_TELEMETRY_RESPONSE_BYTES = 32 * 1024 * 1024;

/**
 * Per-host concurrency cap and minimum spacing between request starts. One
 * instance is shared by every client that talks to the same host.
 */
export class HostLimiter {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  private nextStart = 0;

  constructor(
    private readonly maxConcurrent: number,
    private readonly minIntervalMs: number,
    private readonly sleep: (ms: number) => Promise<void> = ms => new Promise(res => setTimeout(res, ms)),
  ) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.maxConcurrent) await new Promise<void>(res => this.waiting.push(res));
    this.active++;
    try {
      const now = performance.now(); // monotonic: wall-clock jumps never stall or burst the queue
      const wait = this.nextStart - now;
      this.nextStart = Math.max(now, this.nextStart) + this.minIntervalMs;
      if (wait > 0) await this.sleep(wait);
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

export class MethodNotAllowedError extends Error {
  constructor(method: string, url: string) {
    super(`${method} ${safePath(url)} is not allowed: the portal only reads`);
    this.name = 'MethodNotAllowedError';
  }
}

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}

export class OriginNotAllowedError extends Error {
  constructor(url: string) {
    super(`outbound request to ${safeOrigin(url)} is not on the allowlist`);
    this.name = 'OriginNotAllowedError';
  }
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '(invalid url)';
  }
}

const WHOLE_MATCH_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, // JWT
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
];
/** key/value pairs whose value is a secret: the key and separator are kept. */
const SECRET_PAIR = /(access[_-]?token|secret|password|private[_-]?key)(["':=\s]+)[^\s"',}]+/gi;
/**
 * S3 error-body fields that echo the signing input (SignatureDoesNotMatch and similar): the access key
 * id, the string to sign, the signature and the canonical request. The element is kept, its content is not.
 */
const S3_ECHO_FIELDS = /<(AWSAccessKeyId|StringToSign|StringToSignBytes|SignatureProvided|CanonicalRequest|CanonicalRequestBytes|Signature)>[\s\S]*?<\/\1>/g;
/** SigV4 credential and signature in a URL query or header. */
const SIGV4_PARAMS = /((?:X-Amz-)?(?:Credential|Signature)=)[^\s&,"']+/gi;

/** Removes private keys, JWTs, bearer tokens, secret-looking key/value pairs and S3 signing echoes. */
export function redact(text: string): string {
  let out = text;
  for (const p of WHOLE_MATCH_PATTERNS) out = out.replace(p, '[redacted]');
  out = out.replace(S3_ECHO_FIELDS, (_m, tag: string) => `<${tag}>[redacted]</${tag}>`);
  out = out.replace(SIGV4_PARAMS, (_m, key: string) => `${key}[redacted]`);
  return out.replace(SECRET_PAIR, (_m, key: string, sep: string) => `${key}${sep}[redacted]`);
}

export class HttpClient {
  private readonly fetchFn: FetchFn;
  private readonly origins: Set<string>;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: HttpClientOptions) {
    this.fetchFn = opts.fetch ?? ((u, i) => fetch(u, i));
    this.origins = new Set(opts.allowedOrigins.map(o => new URL(o).origin));
    // A back-off wait never holds the process open by itself: a sync still retrying when the backend stops (a test
    // backend's teardown, a shutdown) must not keep Node, or a Jest worker, alive until its retry budget runs out.
    this.sleep = opts.sleep ?? (ms => new Promise(r => setTimeout(r, ms).unref()));
  }

  assertAllowed(url: string): void {
    let origin: string;
    try {
      const u = new URL(url);
      if (u.username || u.password) throw new OriginNotAllowedError(url);
      origin = u.origin;
    } catch (e) {
      if (e instanceof OriginNotAllowedError) throw e;
      throw new OriginNotAllowedError(url);
    }
    if (!this.origins.has(origin)) throw new OriginNotAllowedError(url);
  }

  /**
   * `retry500: false`: a 500 is returned as an HttpError at once (with its body), for calls whose 500 is
   * deterministic, e.g. a Loki query the backend cannot run (G3.5). 429, 502, 503 and 504 are retried as usual.
   */
  async request<T>(url: string, init: RequestInit = {}, opts: { retry500?: boolean } = {}): Promise<T> {
    const max = this.opts.maxResponseBytes;
    if (max === undefined) return this.send(url, init, 'application/json', async res => (await res.json()) as T, undefined, opts.retry500);
    return this.send(url, init, 'application/json', async res => JSON.parse((await readCapped(res, max, url)).toString('utf8')) as T, undefined, opts.retry500);
  }

  /**
   * A HEAD for an access check: no body is read, redirects are not followed (a 3xx answers "reachable"),
   * and the final status is returned rather than thrown. 429/5xx and network errors are retried as usual.
   * Only on a client created with `allowHead`.
   */
  async head(url: string): Promise<number> {
    return this.send(url, { method: 'HEAD' }, '*/*', async res => res.status);
  }

  /**
   * A GET for a file (e.g. an Object Storage object), bounded to `maxBytes`. `headersFor` is called
   * per attempt, so a request signature (SigV4) is fresh on every retry.
   */
  async requestBytes(url: string, opts: { maxBytes: number; headersFor?: () => Record<string, string> }): Promise<Buffer> {
    return this.send(
      url,
      {},
      '*/*',
      async res => {
        const declared = Number(res.headers.get('content-length'));
        if (Number.isFinite(declared) && declared > opts.maxBytes) throw new Error(`${safePath(url)}: ${declared} bytes exceeds the ${opts.maxBytes}-byte limit`);
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > opts.maxBytes) throw new Error(`${safePath(url)}: ${buf.length} bytes exceeds the ${opts.maxBytes}-byte limit`);
        return buf;
      },
      opts.headersFor,
    );
  }

  private async send<T>(url: string, init: RequestInit, accept: string, read: (res: Response) => Promise<T>, headersFor?: () => Record<string, string>, retry500 = true): Promise<T> {
    this.assertAllowed(url);
    const method = (init.method ?? 'GET').toUpperCase();
    const head = method === 'HEAD' && this.opts.allowHead === true;
    if (method !== 'GET' && !head && !(method === 'POST' && this.opts.allowPostPaths?.includes(new URL(url).pathname))) {
      throw new MethodNotAllowedError(method, url);
    }
    const maxRetries = this.opts.maxRetries ?? 3;
    const base = this.opts.baseDelayMs ?? 250;
    const now = this.opts.now ?? (() => performance.now());
    const sync = backgroundSync.getStore();
    const stop = sync?.stop;
    const budget = maxRetries === 0 ? 0 : this.opts.connectRetryBudgetMs ?? (sync ? CONNECT_RETRY_BUDGET_MS : REQUEST_CONNECT_RETRY_BUDGET_MS);
    const started = now();
    let waited = 0;
    let attempt = 0;
    for (;;) {
      if (stop?.aborted) throw new SyncStoppedError(url);
      const headers = new Headers(init.headers);
      headers.set('Accept', accept);
      // Always explicit: api.nebius.cloud refuses some default client User-Agents (403).
      headers.set('User-Agent', USER_AGENT);
      const auth = await this.opts.authorization?.();
      if (auth) headers.set('Authorization', auth);
      for (const [k, v] of Object.entries(headersFor?.() ?? {})) headers.set(k, v);
      let res: Response | undefined;
      let networkError: Error | undefined;
      try {
        const call = () => this.fetchFn(url, { ...init, headers, redirect: head ? 'manual' : 'error', signal: stop ? AbortSignal.any([AbortSignal.timeout(this.opts.timeoutMs), stop]) : AbortSignal.timeout(this.opts.timeoutMs) });
        res = await (this.opts.limiter ? this.opts.limiter.run(call) : call());
      } catch (e) {
        if (stop?.aborted) throw new SyncStoppedError(url);
        networkError = e as Error;
      }
      if (!networkError && res && !(res.status === 429 || (res.status >= 500 && (retry500 || res.status !== 500)))) {
        if (!res.ok && !head) {
          const body = redact((await res.text().catch(() => '')).slice(0, 500));
          throw new HttpError(res.status, `${init.method ?? 'GET'} ${safePath(url)} → ${res.status}${body ? `: ${body}` : ''}`);
        }
        return read(res);
      }
      if (networkError) {
        // Connect-class: retried while the budget lasts (the time spent, or the backoff slept when the clock is faked).
        const delay = Math.min(base * 2 ** attempt, CONNECT_MAX_DELAY_MS) + Math.floor(Math.random() * base);
        const spent = Math.max(now() - started, waited);
        if (!isConnectClass(networkError) || spent + delay > budget) {
          const tries = attempt + 1;
          const after = tries > 1 ? ` after ${tries} attempts in ${Math.round(spent / 1000)} s` : '';
          throw new Error(`${safePath(url)}: ${redact(describeNetworkError(networkError))}${after}`, { cause: networkError.cause ?? networkError });
        }
        await stoppable(this.sleep, delay, stop);
        waited += delay;
        attempt++;
        continue;
      }
      if (attempt >= maxRetries) throw new HttpError(res!.status, `${safePath(url)} → ${res!.status} after ${attempt + 1} attempts`);
      const retryAfter = Number(res!.headers.get('retry-after'));
      const delay = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, 30_000)
        : base * 2 ** attempt + Math.floor(Math.random() * base);
      await stoppable(this.sleep, delay, stop);
      waited += delay;
      attempt++;
    }
  }
}

/** Reads a body up to `maxBytes`: refused at once when the declared length is larger, else counted while it streams. */
async function readCapped(res: Response, maxBytes: number, url: string): Promise<Buffer> {
  const tooLarge = () => new Error(`${safePath(url)}: the response exceeds the ${maxBytes}-byte limit (narrow the query or its time range)`);
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function safePath(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return '(invalid url)';
  }
}

/**
 * Follows `pageToken` / `nextPageToken` pagination (Nebius REST, verified in
 * https://api.nebius.cloud/openapi.json). Stops at maxPages to bound work.
 */
export async function paginate<T>(
  fetchPage: (pageToken?: string) => Promise<{ items?: T[]; nextPageToken?: string }>,
  maxPages = 100,
): Promise<{ items: T[]; truncated: boolean }> {
  const items: T[] = [];
  let token: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const res = await fetchPage(token);
    items.push(...(res.items ?? []));
    token = res.nextPageToken || undefined;
    if (!token) return { items, truncated: false };
  }
  return { items, truncated: true };
}

/** Runs tasks with at most `limit` in flight. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}
