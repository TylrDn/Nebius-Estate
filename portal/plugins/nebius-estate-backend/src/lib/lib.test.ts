import { readFileSync } from 'fs';
import { createServer } from 'http';
import { AddressInfo, Socket } from 'net';
import { resolve } from 'path';
import { ConfigReader } from '@backstage/config';
import { loadConfig } from '@backstage/config-loader';
import { parse as parseYaml } from 'yaml';
import { REPO_ROOT } from '../__testUtils__/testing';
import { HttpClient, HttpError, inBackgroundSync, mapLimit, OriginNotAllowedError, paginate, redact, REQUEST_CONNECT_RETRY_BUDGET_MS, USER_AGENT } from './http';
import { readEstateConfig, testEndpointKeys } from './config';
import { inScope, scopeFor } from './access';

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

describe('HttpClient', () => {
  const noSleep = async () => {};

  it('refuses origins outside the allowlist and URLs with credentials', async () => {
    const c = new HttpClient({ allowedOrigins: ['https://api.nebius.cloud'], timeoutMs: 1000, fetch: jest.fn() });
    await expect(c.request('https://169.254.169.254/latest/meta-data')).rejects.toBeInstanceOf(OriginNotAllowedError);
    await expect(c.request('https://api.nebius.cloud.evil.example/x')).rejects.toBeInstanceOf(OriginNotAllowedError);
    await expect(c.request('https://user:pw@api.nebius.cloud/x')).rejects.toBeInstanceOf(OriginNotAllowedError);
    await expect(c.request('http://api.nebius.cloud/x')).rejects.toBeInstanceOf(OriginNotAllowedError);
  });

  it('retries 429 and 5xx with backoff, then succeeds', async () => {
    const f = jest
      .fn()
      .mockResolvedValueOnce(json({}, 503))
      .mockResolvedValueOnce(json({}, 429, { 'retry-after': '1' }))
      .mockResolvedValueOnce(json({ ok: 1 }));
    const sleeps: number[] = [];
    const c = new HttpClient({ allowedOrigins: ['https://api.nebius.cloud'], timeoutMs: 1000, fetch: f, sleep: async ms => { sleeps.push(ms); } });
    await expect(c.request('https://api.nebius.cloud/compute/v1/instances')).resolves.toEqual({ ok: 1 });
    expect(f).toHaveBeenCalledTimes(3);
    expect(sleeps[1]).toBe(1000); // Retry-After honoured
  });

  it('gives up after maxRetries and does not retry 4xx', async () => {
    const f = jest.fn().mockResolvedValue(json({}, 500));
    const c = new HttpClient({ allowedOrigins: ['https://api.nebius.cloud'], timeoutMs: 1000, fetch: f, maxRetries: 2, sleep: noSleep });
    await expect(c.request('https://api.nebius.cloud/x')).rejects.toBeInstanceOf(HttpError);
    expect(f).toHaveBeenCalledTimes(3);
    const g = jest.fn().mockResolvedValue(json({ message: 'denied' }, 403));
    const d = new HttpClient({ allowedOrigins: ['https://api.nebius.cloud'], timeoutMs: 1000, fetch: g, sleep: noSleep });
    await expect(d.request('https://api.nebius.cloud/x')).rejects.toMatchObject({ status: 403 });
    expect(g).toHaveBeenCalledTimes(1);
  });

  it('sends the authorization header but never leaks it in errors', async () => {
    const f = jest.fn().mockResolvedValue(new Response('token Bearer abc.def.ghi rejected', { status: 401 }));
    const c = new HttpClient({ allowedOrigins: ['https://api.nebius.cloud'], timeoutMs: 1000, fetch: f, authorization: async () => 'Bearer abc.def.ghi' });
    const err = (await c.request('https://api.nebius.cloud/x?pageToken=secret').then(() => undefined, (e: unknown) => e)) as Error;
    expect((f.mock.calls[0][1].headers as Headers).get('Authorization')).toBe('Bearer abc.def.ghi');
    expect((f.mock.calls[0][1].headers as Headers).get('User-Agent')).toBe(USER_AGENT); // explicit: the API refuses some default agents
    expect(err.message).not.toContain('abc.def.ghi');
    expect(err.message).not.toContain('pageToken');
  });

  it('caps JSON responses at maxResponseBytes, declared or streamed, with a clear error', async () => {
    const big = JSON.stringify({ data: 'x'.repeat(2048) });
    const declared = new HttpClient({ allowedOrigins: ['https://read.monitoring.api.nebius.cloud'], timeoutMs: 1000, maxResponseBytes: 1024, fetch: jest.fn().mockResolvedValue(new Response(big, { status: 200, headers: { 'content-length': String(big.length) } })) });
    await expect(declared.request('https://read.monitoring.api.nebius.cloud/projects/p/x?query=secret')).rejects.toThrow(/https:\/\/read\.monitoring\.api\.nebius\.cloud\/projects\/p\/x: the response exceeds the 1024-byte limit/);
    // No content-length (chunked): counted while it streams, and the read stops at the cap.
    const stream = () => new ReadableStream({ start(c) { for (let i = 0; i < 64; i++) c.enqueue(new TextEncoder().encode('x'.repeat(64))); c.close(); } });
    const streamed = new HttpClient({ allowedOrigins: ['https://read.monitoring.api.nebius.cloud'], timeoutMs: 1000, maxResponseBytes: 1024, fetch: jest.fn().mockResolvedValue(new Response(stream(), { status: 200 })) });
    await expect(streamed.request('https://read.monitoring.api.nebius.cloud/x')).rejects.toThrow(/exceeds the 1024-byte limit/);
    const ok = new HttpClient({ allowedOrigins: ['https://read.monitoring.api.nebius.cloud'], timeoutMs: 1000, maxResponseBytes: 1024, fetch: jest.fn().mockResolvedValue(json({ ok: 1 })) });
    await expect(ok.request('https://read.monitoring.api.nebius.cloud/x')).resolves.toEqual({ ok: 1 });
  });

  /** What undici's fetch throws when the connection fails: TypeError "fetch failed", the reason in `cause`. */
  const fetchFailed = (code: string, message = `connect ${code} 203.0.113.10:443`) => new TypeError('fetch failed', { cause: Object.assign(new Error(message), { code }) });

  describe('connect-class errors (F1.45: a sync that fired before Wi-Fi/DNS was back)', () => {
    afterEach(() => jest.useRealTimers());

    it('in a sync, retries a connect-class error for about 30 s of backoff, then names the cause code', async () => {
      const f = jest.fn().mockRejectedValue(fetchFailed('ENOTFOUND', 'getaddrinfo ENOTFOUND api.nebius.cloud'));
      const sleeps: number[] = [];
      const c = new HttpClient({ allowedOrigins: ['https://api.nebius.cloud'], timeoutMs: 1000, fetch: f, sleep: async ms => { sleeps.push(ms); } });
      const err = (await inBackgroundSync(() => c.request('https://api.nebius.cloud/compute/v1/instances')).then(() => undefined, (e: unknown) => e)) as Error & { cause?: { code?: string } };
      const waited = sleeps.reduce((a, b) => a + b, 0);
      // The old budget was 3 retries (~2.5 s): every origin failed before the network was back.
      expect(f.mock.calls.length).toBeGreaterThan(5);
      expect(waited).toBeGreaterThanOrEqual(20_000);
      expect(waited).toBeLessThanOrEqual(30_000);
      expect(err.message).toContain('fetch failed');
      expect(err.message).toContain('ENOTFOUND');
      expect(err.message).toContain('getaddrinfo ENOTFOUND api.nebius.cloud');
      expect(err.message).toMatch(/after \d+ attempts/);
      expect(err.cause?.code).toBe('ENOTFOUND');
    });

    it('on a request a person waits for (outside a sync), gives up on a connect-class error within about 3 s', async () => {
      const f = jest.fn().mockRejectedValue(fetchFailed('ENOTFOUND', 'getaddrinfo ENOTFOUND api.nebius.cloud'));
      const sleeps: number[] = [];
      const c = new HttpClient({ allowedOrigins: ['https://api.nebius.cloud'], timeoutMs: 1000, fetch: f, sleep: async ms => { sleeps.push(ms); } });
      await expect(c.request('https://api.nebius.cloud/x')).rejects.toThrow(/ENOTFOUND/);
      expect(f.mock.calls.length).toBeGreaterThan(1);
      expect(sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(REQUEST_CONNECT_RETRY_BUDGET_MS);
    });

    it('rides out a network that returns within the budget (fake timers)', async () => {
      jest.useFakeTimers({ now: Date.parse('2026-10-12T03:00:00Z') });
      const back = Date.now() + 20_000;
      const f = jest.fn(async () => {
        if (Date.now() < back) throw fetchFailed(['ENETUNREACH', 'EAI_AGAIN', 'ECONNREFUSED'][f.mock.calls.length % 3]);
        return json({ ok: 1 });
      });
      const c = new HttpClient({ allowedOrigins: ['https://api.nebius.cloud'], timeoutMs: 1000, fetch: f, now: () => Date.now() });
      const result = inBackgroundSync(() => c.request('https://api.nebius.cloud/x'));
      await jest.advanceTimersByTimeAsync(31_000);
      await expect(result).resolves.toEqual({ ok: 1 });
      expect(f.mock.calls.length).toBeGreaterThan(4);
    });

    it('stops at the budget on the clock, not only on summed backoff (a slow attempt counts)', async () => {
      jest.useFakeTimers({ now: Date.parse('2026-10-12T03:00:00Z') });
      // Each attempt hangs until it times out (10 s, as AbortSignal.timeout rejects; its own timer is not faked):
      // a request timeout is connect-class too.
      const f = jest.fn(() => new Promise<Response>((_r, reject) => {
        setTimeout(() => reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError')), 10_000);
      }));
      const c = new HttpClient({ allowedOrigins: ['https://api.nebius.cloud'], timeoutMs: 10_000, fetch: f as any, now: () => Date.now() });
      const result = inBackgroundSync(() => c.request('https://api.nebius.cloud/x')).then(() => undefined, (e: Error) => e);
      await jest.advanceTimersByTimeAsync(60_000);
      const err = await result;
      expect(err?.message).toMatch(/TimeoutError/);
      expect(f.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(f.mock.calls.length).toBeLessThanOrEqual(3);
    });

    it('a back-off wait does not hold the process open (a stopped backend\'s sync never keeps a Jest worker alive)', async () => {
      const timers: NodeJS.Timeout[] = [];
      const real = global.setTimeout;
      const spy = jest.spyOn(global, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
        const t = real(fn, ms);
        timers.push(t);
        return t;
      }) as any);
      try {
        const f = jest.fn().mockRejectedValueOnce(fetchFailed('ECONNREFUSED')).mockResolvedValueOnce(json({ ok: 1 }));
        const c = new HttpClient({ allowedOrigins: ['https://api.nebius.cloud'], timeoutMs: 1000, fetch: f });
        await expect(c.request('https://api.nebius.cloud/x')).resolves.toEqual({ ok: 1 });
        expect(timers.length).toBeGreaterThan(0);
        expect(timers.every(t => !t.hasRef())).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });

    it.each(['ECONNRESET', 'UND_ERR_SOCKET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT'])('retries %s', async code => {
      const f = jest.fn().mockRejectedValueOnce(fetchFailed(code)).mockResolvedValueOnce(json({ ok: 1 }));
      const c = new HttpClient({ allowedOrigins: ['https://api.nebius.cloud'], timeoutMs: 1000, fetch: f, sleep: noSleep });
      await expect(c.request('https://api.nebius.cloud/x')).resolves.toEqual({ ok: 1 });
      expect(f).toHaveBeenCalledTimes(2);
    });

    it('fails fast on other errors, with the cause in the message', async () => {
      const tls = jest.fn().mockRejectedValue(fetchFailed('CERT_HAS_EXPIRED', 'certificate has expired'));
      const c = new HttpClient({ allowedOrigins: ['https://api.nebius.cloud'], timeoutMs: 1000, fetch: tls, sleep: noSleep });
      await expect(c.request('https://api.nebius.cloud/x')).rejects.toThrow(/fetch failed \(CERT_HAS_EXPIRED: certificate has expired\)/);
      expect(tls).toHaveBeenCalledTimes(1);
      const plain = jest.fn().mockRejectedValue(new Error('unexpected redirect'));
      const d = new HttpClient({ allowedOrigins: ['https://api.nebius.cloud'], timeoutMs: 1000, fetch: plain, sleep: noSleep });
      await expect(d.request('https://api.nebius.cloud/x')).rejects.toThrow(/unexpected redirect/);
      expect(plain).toHaveBeenCalledTimes(1);
    });

    it('a stale keep-alive socket reset after idle is retried on a new connection (as before F1.30: a guard that the narrower retry still covers it)', async () => {
      // A NAT or load balancer that dropped idle flows (or a laptop that slept) answers the first request on an
      // idle pooled socket with a reset. Real sockets on loopback; no Nebius endpoint.
      const server = createServer((_req, res) => {
        res.setHeader('Keep-Alive', 'timeout=600');
        res.setHeader('content-type', 'application/json');
        res.end('{"ok":true}');
      });
      server.keepAliveTimeout = 600_000;
      server.on('connection', (s: Socket) => {
        let last = Date.now();
        s.prependListener('data', () => {
          if (Date.now() - last > 300) s.resetAndDestroy();
          last = Date.now();
        });
      });
      await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
      try {
        const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        const c = new HttpClient({ allowedOrigins: [base], timeoutMs: 5000, baseDelayMs: 10 });
        const wave = () => Promise.all(Array.from({ length: 6 }, (_, i) => c.request(`${base}/r${i}`).then(() => 'ok', (e: Error) => e.message)));
        expect(await wave()).toEqual(Array(6).fill('ok'));
        await new Promise(r => setTimeout(r, 600));
        // Raw fetch on the same kind of idle pool fails: the guard exercises a real reset.
        const raw = await Promise.all(Array.from({ length: 6 }, () => fetch(`${base}/raw`).then(r => r.text()).then(() => 'ok', (e: Error & { cause?: { code?: string } }) => e.cause?.code)));
        expect(raw).toContain('ECONNRESET');
        await wave();
        await new Promise(r => setTimeout(r, 600));
        expect(await wave()).toEqual(Array(6).fill('ok'));
      } finally {
        server.closeAllConnections();
        await new Promise(r => server.close(r));
      }
    });
  });

  it('times out slow calls', async () => {
    const f = jest.fn((_u: string, init: RequestInit) => new Promise<Response>((_r, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    const c = new HttpClient({ allowedOrigins: ['https://api.nebius.cloud'], timeoutMs: 20, fetch: f as any, maxRetries: 0 });
    await expect(c.request('https://api.nebius.cloud/x')).rejects.toThrow(/aborted/);
  });
});

describe('pagination and concurrency', () => {
  it('follows nextPageToken until empty and bounds pages', async () => {
    const pages: Record<string, { items: number[]; nextPageToken?: string }> = {
      '': { items: [1, 2], nextPageToken: 'p2' },
      p2: { items: [3], nextPageToken: 'p3' },
      p3: { items: [4], nextPageToken: '' },
    };
    const r = await paginate(async t => pages[t ?? '']);
    expect(r).toEqual({ items: [1, 2, 3, 4], truncated: false });
    const loop = await paginate(async () => ({ items: [1], nextPageToken: 'again' }), 3);
    expect(loop).toEqual({ items: [1, 1, 1], truncated: true });
  });

  it('keeps at most `limit` tasks in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5, 6], 2, async n => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise(r => setTimeout(r, 5));
      inFlight--;
      return n * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10, 12]);
    expect(peak).toBe(2);
  });
});

describe('redact', () => {
  it('removes tokens, JWTs, keys and secret pairs', () => {
    const s = redact('Bearer abc123 eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0xx.c2lnbmF0dXJl "secret":"s3cr3t" password=hunter2 -----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----');
    expect(s).not.toMatch(/abc123|eyJhbGci|s3cr3t|hunter2|MIIE/);
  });
});

describe('redact: S3 error bodies', () => {
  it('strips the access key id, string to sign and canonical request of a SignatureDoesNotMatch body', () => {
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<Error><Code>SignatureDoesNotMatch</Code><Message>The request signature we calculated does not match the signature you provided. Check your key and signing method.</Message><AWSAccessKeyId>NAKIAE00MOCKEXAMPLE7</AWSAccessKeyId><StringToSign>AWS4-HMAC-SHA256
20261011T080000Z
20261011/eu-north1/s3/aws4_request
6f1c0e5a9a77d2c4e00mockhash</StringToSign><SignatureProvided>9a77d2c4e00mocksignature0123456789abcdef</SignatureProvided><StringToSignBytes>41 57 53 34</StringToSignBytes><CanonicalRequest>GET
/e00mock-bucket
list-type=2
host:storage.eu-north1.nebius.cloud
x-amz-credential=NAKIAE00MOCKEXAMPLE7/20261011
</CanonicalRequest><CanonicalRequestBytes>47 45 54</CanonicalRequestBytes><RequestId>e00mock-req</RequestId></Error>`;
    const s = redact(body);
    expect(s).toContain('<Code>SignatureDoesNotMatch</Code>');
    expect(s).toContain('<RequestId>e00mock-req</RequestId>');
    expect(s).toContain('<AWSAccessKeyId>[redacted]</AWSAccessKeyId>');
    expect(s).not.toMatch(/NAKIAE00MOCKEXAMPLE7|e00mocksignature|e00mockhash|41 57 53 34|47 45 54|e00mock-bucket/);
    // Credential and signature query parameters of a presigned URL, too.
    expect(redact('X-Amz-Credential=NAKIAE00MOCKEXAMPLE7%2F20261011&X-Amz-Signature=abcdef0123')).not.toMatch(/NAKIAE00MOCKEXAMPLE7|abcdef0123/);
  });
});

describe('configuration', () => {
  const served = (extra: object = {}) => ({
    nebiusEstate: {
      access: { roles: [{ name: 'ops', principals: ['group:default/platform'], permissions: ['*'] }] },
      nebius: { projects: [{ id: 'project-e00mock' }], auth: { tokenEnv: 'NEBIUS_IAM_TOKEN' } },
      ...extra,
    },
  });
  const local = (extra: object = {}, nebiusEstate: object = {}) => ({ backend: { listen: { host: '127.0.0.1' } }, ...served(nebiusEstate), ...extra });
  const read = (data: object, env: NodeJS.ProcessEnv = {}) => readEstateConfig(new ConfigReader(data as any), env);

  it('has no mode: an old `mode` key is refused with an explanation', () => {
    expect(() => read(served({ mode: 'demo' }))).toThrow(/no demo mode/);
  });

  it('fails closed: roles required; guest, development roles and a test endpoint only on loopback', () => {
    expect(() => read(served({ access: { roles: [] } }))).toThrow(/roles/);
    expect(() => read({ ...served(), auth: { providers: { guest: {} } } })).toThrow(/guest/);
    expect(() => read({ ...served(), backend: { listen: { host: '0.0.0.0' } }, auth: { providers: { guest: {} } } })).toThrow(/guest/);
    expect(read(local({ auth: { providers: { guest: {} } } })).localOnly).toBe(true);
    const devRole = { access: { roles: [{ name: 'x', principals: ['user:development/guest'], permissions: ['*'] }] } };
    expect(() => read(served(devRole))).toThrow(/development/);
    expect(read(local({}, devRole)).roles).toHaveLength(1);
    const stub = { nebius: { projects: [{ id: 'project-e00mock' }], apiEndpoint: 'http://127.0.0.1:7199', auth: {} } };
    expect(() => read(served(stub))).toThrow(/apiEndpoint/);
    expect(read(local({}, stub)).nebius?.apiEndpoint).toBe('http://127.0.0.1:7199');
    expect(() => read(local({}, { nebius: { projects: [], apiEndpoint: 'https://evil.example', auth: {} } }))).toThrow(/apiEndpoint/);
  });

  it('requires explicit projects when served; a local run may start unconfigured', () => {
    expect(() => read(served({ nebius: { projects: [], auth: {} } }))).toThrow(/projects/);
    expect(read(local({}, { nebius: { projectIdsEnv: 'NEBIUS_PROJECT_IDS', auth: {} } })).nebius?.projects).toEqual([]);
  });

  it('reads project ids from the variable named by projectIdsEnv, validated and de-duplicated', () => {
    const cfg = { nebius: { projects: [{ id: 'project-e00mocka', name: 'a' }], projectIdsEnv: 'NEBIUS_PROJECT_IDS', auth: {} } };
    const r = read(local({}, cfg), { NEBIUS_PROJECT_IDS: ' project-e00mocka, project-e00mockb ,' });
    expect(r.nebius?.projects).toEqual([{ id: 'project-e00mocka', name: 'a', regions: undefined }, { id: 'project-e00mockb' }]);
    expect(() => read(local({}, cfg), { NEBIUS_PROJECT_IDS: 'project-e00mocka,../x' })).toThrow(/not a Nebius project id/);
  });

  it('rejects non-https endpoints, embedded credentials and bad env names', () => {
    const k = (url: string) => served({ kubernetes: { clusters: [{ name: 'a', url, tokenEnv: 'K8S_TOKEN' }] } });
    expect(() => read(k('http://10.0.0.1:6443'))).toThrow(/https/);
    expect(() => read(k('https://u:p@10.0.0.1:6443'))).toThrow(/credentials/);
    expect(read(k('https://10.0.0.1:6443')).kubernetes[0].url).toBe('https://10.0.0.1:6443');
    expect(() => read(served({ kubernetes: { clusters: [{ name: 'a', url: 'https://x', tokenEnv: 'bad name' }] } }))).toThrow(/environment variable/);
    expect(read(served({ prometheus: { url: 'http://localhost:9090' } })).prometheus?.url).toBe('http://localhost:9090');
    expect(() => read(served({ prometheus: { url: 'http://prom.internal:9090' } }))).toThrow(/https/);
  });

  it('accepts only https dashboard links', () => {
    const k = (dashboardUrl: string) => served({ kubernetes: { clusters: [{ name: 'a', url: 'https://k', tokenEnv: 'T', dashboardUrl }] } });
    expect(() => read(k(['javascript', 'alert(1)'].join(':')))).toThrow(/https/);
    expect(read(k('https://grafana.internal/d/x')).kubernetes[0].dashboardUrl).toBe('https://grafana.internal/d/x');
  });

  it('fast re-sync: 120 s and 30 in a row by default; never sooner than the 60 s "Sync now" cooldown; 0 turns it off', () => {
    const fast = (o: object) => read(served({ nebius: { projects: [{ id: 'project-e00mock' }], auth: {}, ...o } })).nebius!;
    expect(fast({})).toMatchObject({ fastSyncSeconds: 120, fastSyncMax: 30 });
    expect(fast({ fastSyncSeconds: 10, fastSyncMax: 0 })).toMatchObject({ fastSyncSeconds: 60, fastSyncMax: 1 });
    expect(fast({ fastSyncSeconds: 5000, fastSyncMax: 1000 })).toMatchObject({ fastSyncSeconds: 900, fastSyncMax: 200 });
    expect(fast({ fastSyncSeconds: 0 }).fastSyncSeconds).toBe(0);
  });

  it('validates budgets', () => {
    const budget = { id: 'b', project: 'project-e00mock', amount: '100', currency: 'XTS', period: '2026-10', source: 'test' };
    expect(read(served({ budgets: [budget] })).budgets[0].scope.project).toBe('project-e00mock');
    expect(() => read(served({ budgets: [{ ...budget, amount: '1e3' }] }))).toThrow(/budget b/);
  });
});

describe('committed app-config files', () => {
  // ${VAR} placeholders get syntactically valid test values, as the environment would supply them.
  const ENV: Record<string, string> = { PORTAL_BASE_URL: 'https://estate.example.internal' };
  const load = (files: string[], extra?: object) =>
    ConfigReader.fromConfigs([
      ...files.map(f => ({
        context: f,
        data: parseYaml(readFileSync(resolve(REPO_ROOT, 'portal', f), 'utf8').replace(/\$\{(\w+)\}/g, (_m, name: string) => ENV[name] ?? 'test')),
      })),
      ...(extra ? [{ context: 'test', data: extra }] : []),
    ]);

  it('base + production is valid with projects from the environment, and refuses to start without them', () => {
    const cfg = readEstateConfig(load(['app-config.yaml', 'app-config.production.yaml']), { NEBIUS_PROJECT_IDS: 'project-e00mocksandbox' });
    expect(cfg.localOnly).toBe(false);
    expect(cfg.nebius?.projects.map(p => p.id)).toEqual(['project-e00mocksandbox']);
    expect(() => readEstateConfig(load(['app-config.yaml', 'app-config.production.yaml']), {})).toThrow(/projects/);
  });

  it('base + local starts on loopback with the guest identity and no credentials', () => {
    const cfg = readEstateConfig(load(['app-config.yaml', 'app-config.local.yaml']), {});
    expect(cfg.localOnly).toBe(true);
    expect(cfg.nebius?.projects).toEqual([]);
    expect(cfg.nebius?.auth.serviceAccount?.privateKeyFileEnv).toBe('NEBIUS_SA_PRIVATE_KEY_FILE');
  });

  it('local maps NEBIUS_TENANT_ID; unset or empty (as .env.example ships it) leaves the tenant unset (F1.32)', async () => {
    // The real Backstage loader and substitution, so an empty variable is tested as it is substituted.
    const read = async (value: string | undefined) => {
      const saved = process.env.NEBIUS_TENANT_ID;
      if (value === undefined) delete process.env.NEBIUS_TENANT_ID;
      else process.env.NEBIUS_TENANT_ID = value;
      try {
        const { appConfigs } = await loadConfig({
          configRoot: resolve(REPO_ROOT, 'portal'),
          configTargets: [{ path: resolve(REPO_ROOT, 'portal', 'app-config.yaml') }, { path: resolve(REPO_ROOT, 'portal', 'app-config.local.yaml') }],
        });
        return readEstateConfig(ConfigReader.fromConfigs(appConfigs), {}).nebius?.tenantId;
      } finally {
        if (saved === undefined) delete process.env.NEBIUS_TENANT_ID;
        else process.env.NEBIUS_TENANT_ID = saved;
      }
    };
    await expect(read('tenant-e00mocktest')).resolves.toBe('tenant-e00mocktest');
    await expect(read(undefined)).resolves.toBeUndefined();
    await expect(read('')).resolves.toBeUndefined();
  });

  it('refuses the guest provider on a served deployment, and the local file never makes one reachable', () => {
    expect(() => readEstateConfig(load(['app-config.yaml', 'app-config.production.yaml'], { auth: { providers: { guest: {} } } }), { NEBIUS_PROJECT_IDS: 'project-e00mocka' })).toThrow(/guest/);
    expect(() => readEstateConfig(load(['app-config.yaml', 'app-config.local.yaml'], { backend: { listen: { host: '0.0.0.0' } } }), {})).toThrow(/guest/);
  });

  it('the e2e configuration is test-only: its stub endpoint is refused off loopback', () => {
    const e2e = (extra?: object) =>
      ConfigReader.fromConfigs([
        ...['portal/app-config.yaml', 'portal/app-config.local.yaml', 'portal/e2e-stub/app-config.e2e.yaml'].map(f => ({ context: f, data: parseYaml(readFileSync(resolve(REPO_ROOT, f), 'utf8')) })),
        ...(extra ? [{ context: 'test', data: extra }] : []),
      ]);
    expect(readEstateConfig(e2e(), {}).nebius?.apiEndpoint).toBe('http://127.0.0.1:7199');
    expect(() => readEstateConfig(e2e({ backend: { listen: { host: '0.0.0.0' } }, auth: { providers: {} } }), {})).toThrow();
  });

  it('names the settings that point at a test endpoint: every one in the e2e run, none in a local or served one (F1.29)', () => {
    const e2e = ConfigReader.fromConfigs(
      ['portal/app-config.yaml', 'portal/app-config.local.yaml', 'portal/e2e-stub/app-config.e2e.yaml'].map(f => ({ context: f, data: parseYaml(readFileSync(resolve(REPO_ROOT, f), 'utf8')) })),
    );
    expect(testEndpointKeys(readEstateConfig(e2e, {}))).toEqual([
      'nebius.apiEndpoint',
      'nebius.monitoring.endpoint',
      'nebius.logging.endpoint',
      'nebius.audit.endpoint',
      'nebius.mk8s.testEndpoint',
      'billing.export.endpoint',
    ]);
    expect(testEndpointKeys(readEstateConfig(load(['app-config.yaml', 'app-config.local.yaml']), {}))).toEqual([]);
    expect(testEndpointKeys(readEstateConfig(load(['app-config.yaml', 'app-config.production.yaml']), { NEBIUS_PROJECT_IDS: 'project-e00mocksandbox' }))).toEqual([]);
  });
});

describe('project scope', () => {
  const roles = [
    { name: 'all', principals: ['group:default/platform'], permissions: ['*'], projects: ['*'] },
    { name: 'team-a', principals: ['user:default/alice'], permissions: ['nebius.estate.read'], projects: ['project-e00mocka'] },
  ];

  it('scopes callers to their roles projects', () => {
    const alice = scopeFor(roles, ['user:default/alice']);
    expect(inScope(alice, 'project-e00mocka')).toBe(true);
    expect(inScope(alice, 'project-e00mockb')).toBe(false);
    expect(inScope(alice, undefined)).toBe(false);
  });

  it('grants everything to wildcard roles and nothing to strangers', () => {
    expect(scopeFor(roles, ['user:default/bob', 'group:default/platform']).all).toBe(true);
    const stranger = scopeFor(roles, ['user:default/mallory']);
    expect(stranger.all).toBe(false);
    expect(inScope(stranger, 'project-e00mocka')).toBe(false);
  });
});
