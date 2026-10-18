import { mockServices } from '@backstage/backend-test-utils';
import { ConfigReader } from '@backstage/config';
import { resolve } from 'path';
import { HostLimiter, HttpClient, MethodNotAllowedError } from '../lib/http';
import { readEstateConfig } from '../lib/config';
import { footprintLines, NebiusCalculator } from '../commercial/calculator';
import { TEST_DATA, testConfig } from '../__testUtils__/testing';
import { NEBIUS_API, NEBIUS_MONITORING } from './endpoints';
import { connectorDefinitions, InventoryService } from './InventoryService';
import { NebiusMonitoringConnector } from './monitoring';
import { CATALOG } from './nebius-catalog';
import { mapQuotaAllowance, NebiusInventoryConnector } from './nebius';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const stub: { handle: (m: string, u: string, h: Record<string, string>, b?: unknown) => { status: number; body?: unknown; raw?: Buffer; contentType?: string }; estate: any } = require(resolve(TEST_DATA, 'stubApi.js'));

/** fetch backed by the shared stub, with hooks to break individual calls. */
function stubFetch(override?: (url: URL, init: RequestInit) => Response | Promise<Response | undefined> | undefined) {
  const calls: { method: string; url: string }[] = [];
  const fetch = jest.fn(async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    calls.push({ method: init.method ?? 'GET', url: url.pathname + url.search });
    const o = await override?.(url, init);
    if (o) return o;
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const r = stub.handle(init.method ?? 'GET', url.pathname + url.search, headers, init.body ? JSON.parse(String(init.body)) : undefined);
    if (r.raw) return new Response(r.raw, { status: r.status, headers: { 'content-type': r.contentType ?? 'application/octet-stream' } });
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
  });
  return { fetch, calls };
}

const PROJECTS = ['project-e00mocksandbox', 'project-e00mockstaging', 'project-e00mocklab', 'project-e00mocklegacy'].map(id => ({ id }));
const client = (fetch: any, extra: Partial<ConstructorParameters<typeof HttpClient>[0]> = {}) =>
  new HttpClient({ allowedOrigins: [NEBIUS_API, NEBIUS_MONITORING], timeoutMs: 1000, fetch, authorization: async () => 'Bearer test', sleep: async () => undefined, ...extra });

describe('the full read-only catalog against the documented shapes', () => {
  it('reads every capability, maps new resource kinds with their relations, and reports tenant-level refusals with the role to grant', async () => {
    const { fetch, calls } = stubFetch();
    const r = await new NebiusInventoryConnector(client(fetch), { tenantId: 'tenant-e00mocktest', projects: PROJECTS, maxConcurrency: 4 }).sync();
    expect(calls.every(c => c.method === 'GET')).toBe(true);
    const state = Object.fromEntries(r.capabilities.map(c => [c.id, c.state]));
    // The stub's deliberate cases: drift on tunnels, a 404 for one project's DNS zones.
    expect(state['tunnel.tunnels']).toBe('schema-drift');
    expect(state['dns.zones']).toBe('not-found');
    const notOk = CATALOG.filter(d => d.verified && !['ok', 'permission-denied'].includes(state[d.id]) && !['tunnel.tunnels', 'dns.zones'].includes(d.id)).map(d => `${d.id}: ${state[d.id]} ${r.capabilities.find(c => c.id === d.id)?.lastError}`);
    expect(notOk).toEqual([]);
    expect(state['capacity.block-groups']).toBe('ok');
    expect(state['capacity.resource-advice']).toBe('ok'); // items without metadata.id: keyed by region/fabric/platform/preset, not drift
    expect(r.capacity.resourceAdvice).toHaveLength(5);
    // proto3: within a reported availability, omitted numbers are 0 (no reservation: limit reached, 0 of 0).
    expect(r.capacity.resourceAdvice[0].reserved).toMatchObject({ level: 'limit-reached', available: 0, limit: 0 });
    expect(state['billing.pricing-policies']).toBe('rejected');
    expect(r.capabilities.find(c => c.id === 'vpc.networks')!.perProject?.find(p => p.id === 'project-e00mocklegacy')?.state).toBe('permission-denied');

    const byId = Object.fromEntries(r.resources.map(x => [x.providerId, x]));
    expect(byId['vpcallocation-e00mocksbxpub']).toMatchObject({ type: 'vpc-allocation', refs: expect.arrayContaining([{ relation: 'assigned-to', target: 'computeinstance-e00mockinfgpu0' }]), spec: { public: true } });
    expect(byId['vpcsecuritygroup-e00mocksbx']).toMatchObject({ refs: [{ relation: 'in-network', target: 'vpcnetwork-e00mocksbx' }], spec: { platformDefault: true } });
    expect(byId['vpcroutetable-e00mocksbx'].refs).toEqual(expect.arrayContaining([{ relation: 'routes', target: 'vpcsubnet-e00mocksbx' }]));
    expect(byId['computesnapshot-e00mocksbx'].refs).toEqual([{ relation: 'snapshot-of', target: 'computedisk-e00mockpvcorphan' }]);
    expect(byId['aiendpoint-e00mocksbx']).toMatchObject({ type: 'ai-endpoint', status: 'running', refs: [{ relation: 'backed-by', target: 'computeinstance-e00mockinfgpu0' }] });
    expect(byId['postgresqlcluster-e00mockstg']).toMatchObject({ type: 'postgresql-cluster', status: 'running', region: 'eu-north1' });
    expect(byId['mysteryboxsecret-e00mockstg']).toMatchObject({ type: 'secret', spec: {} });

    // Live shape: no metadata.id (identity is parent + name + region). Tenant: proto3 JSON omits zeros, so an
    // absent limit is 0 (a live QuotaFailure reported limit "0"). Project placeholders (no id, epoch createdAt,
    // no limit, no state) are not limits: the project draws on the tenant quota (verified live 2026-10-11).
    expect(state['quotas.allowances']).toBe('ok');
    expect(state['quotas.allowances.tenant']).toBe('ok');
    expect(r.capacity.quotas.find(q => q.name === 'compute.instance.gpu.h100' && q.projectId === 'project-e00mocksandbox')).toMatchObject({ scope: 'project', allocation: 'inherits-tenant', limit: null, usage: 2, unit: 'gpu', usageState: 'used', usagePercent: null });
    expect(r.capacity.quotas.find(q => q.name === 'compute.instance.gpu.h100' && q.projectId === 'project-e00mockstaging')).toMatchObject({ allocation: 'inherits-tenant', limit: null, usage: 0, usageState: 'not-used' });
    expect(r.capacity.quotas.find(q => q.name === 'msp.cloudapps.gpu.h100')).toMatchObject({ allocation: 'inherits-tenant', limit: null, usage: 0, usageState: 'not-applicable' });
    const tenantQ = r.capacity.quotas.filter(q => q.scope === 'tenant');
    expect(tenantQ.every(q => q.allocation === 'set' && q.limit !== null)).toBe(true);
    expect(tenantQ.find(q => q.name === 'compute.instance.count')).toMatchObject({ projectId: '', region: 'eu-north1', limit: 12, usage: 9, usagePercent: 75 });
    expect(tenantQ.find(q => q.name === 'compute.instance.non-gpu.vcpu')).toMatchObject({ limit: 0, usage: 0, usagePercent: null });
    expect(state['compute.nvl-instance-groups']).toBe('ok');
    expect(state['capacity.allowances']).toBe('ok');
    expect(r.capacity.platforms.map(p => p.name).sort()).toEqual(['cpu-d3', 'gpu-b300-sxm', 'gpu-gb300', 'gpu-h100-sxm']);
    expect(r.capacity.maintenances[0]).toMatchObject({ affected: ['mk8scluster-e00mocktrn'], state: 'STATE_SCHEDULED' });
    expect(r.capacity.capacityBlockGroups).toEqual([]);
  });

  it('a refused tenant-level list says which role to grant', async () => {
    const { fetch } = stubFetch(url => (url.searchParams.get('parentId') === 'tenant-e00mocktest' ? new Response('{"code":7}', { status: 403 }) : undefined));
    const r = await new NebiusInventoryConnector(client(fetch), { tenantId: 'tenant-e00mocktest', projects: [{ id: 'project-e00mocksandbox' }], maxConcurrency: 4, catalog: CATALOG.filter(d => d.scope === 'tenant') }).sync();
    const c = r.capabilities.find(x => x.id === 'capacity.block-groups')!;
    expect(c.state).toBe('permission-denied');
    expect(c.hint).toMatch(/tenant-level read role/);
  });

  it('never copies secret payloads, tokens or passwords', async () => {
    const { fetch } = stubFetch();
    const r = await new NebiusInventoryConnector(client(fetch), { tenantId: 'tenant-e00mocktest', projects: PROJECTS, maxConcurrency: 4 }).sync();
    expect(JSON.stringify(r)).not.toContain('never-copied-stub-value');
  });

  it('reports schema drift as its own state and keeps what it can read', async () => {
    const { fetch } = stubFetch(url => {
      if (url.pathname !== '/compute/v1/instances') return undefined;
      const items = [{ metadata: { id: 'computeinstance-e00mockdrift', name: 'x' }, spec: {}, status: { state: 'HIBERNATING' } }, { metadata: {}, spec: {} }];
      return new Response(JSON.stringify({ items }), { status: 200 });
    });
    const r = await new NebiusInventoryConnector(client(fetch), { projects: [{ id: 'project-e00mocksandbox' }], maxConcurrency: 2, catalog: CATALOG.filter(d => d.id === 'compute.instances') }).sync();
    const c = r.capabilities.find(x => x.id === 'compute.instances')!;
    expect(c.state).toBe('schema-drift');
    expect(c.drift).toEqual(expect.arrayContaining(['status.state: undocumented value "HIBERNATING"', '1 item(s) without metadata.id were skipped']));
    expect(r.resources.find(x => x.providerId === 'computeinstance-e00mockdrift')?.status).toBe('unknown');
  });

  it('retries 429 with Retry-After, and reports a timeout as unreachable without blocking the rest', async () => {
    let throttled = false;
    const { fetch } = stubFetch(url => {
      if (url.pathname === '/compute/v1/disks' && !throttled) {
        throttled = true;
        return new Response('{}', { status: 429, headers: { 'retry-after': '1' } });
      }
      if (url.pathname === '/vpc/v1/networks') throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
      return undefined;
    });
    const catalog = CATALOG.filter(d => ['compute.disks', 'vpc.networks', 'storage.buckets'].includes(d.id));
    const r = await new NebiusInventoryConnector(client(fetch, { maxRetries: 1 }), { projects: [{ id: 'project-e00mocksandbox' }], maxConcurrency: 2, catalog }).sync();
    const state = Object.fromEntries(r.capabilities.map(c => [c.id, c.state]));
    expect(state).toMatchObject({ 'compute.disks': 'ok', 'vpc.networks': 'unreachable', 'storage.buckets': 'ok' });
    expect(r.capabilities.find(c => c.id === 'vpc.networks')!.hint).toMatch(/last good data is kept/);
  });

  it('a list that refuses the page size is read again with the service default, and says so', async () => {
    const { fetch, calls } = stubFetch(url =>
      url.pathname === '/dns/v1/zones' && url.searchParams.has('pageSize') ? new Response('{"code":3,"message":"PageSize must be between 1 and 10"}', { status: 400 }) : undefined,
    );
    const r = await new NebiusInventoryConnector(client(fetch), { projects: [{ id: 'project-e00mocksandbox' }], maxConcurrency: 2, catalog: CATALOG.filter(d => d.id === 'dns.zones') }).sync();
    const c = r.capabilities.find(x => x.id === 'dns.zones')!;
    expect(c).toMatchObject({ state: 'schema-drift', items: 1 });
    expect(c.drift).toEqual([expect.stringMatching(/refused pageSize 100/)]);
    expect(calls.filter(x => x.url.startsWith('/dns/v1/zones')).map(x => x.url.includes('pageSize'))).toEqual([true, false]);
  });

  it('a 404 is not-found, not an error', async () => {
    const { fetch } = stubFetch(url => (url.pathname === '/dns/v1/zones' ? new Response('{"code":5}', { status: 404 }) : undefined));
    const r = await new NebiusInventoryConnector(client(fetch), { projects: [{ id: 'project-e00mocksandbox' }], maxConcurrency: 2, catalog: CATALOG.filter(d => d.id === 'dns.zones') }).sync();
    expect(r.capabilities.find(c => c.id === 'dns.zones')!.state).toBe('not-found');
    expect(r.errors).toEqual([]);
  });
});

describe('outbound guards', () => {
  it('allows POST only to listed paths', async () => {
    const { fetch } = stubFetch();
    await expect(client(fetch).request(`${NEBIUS_API}/compute/v1/instances`, { method: 'POST', body: '{}' })).rejects.toBeInstanceOf(MethodNotAllowedError);
    await expect(client(fetch).request(`${NEBIUS_API}/compute/v1/instances`, { method: 'DELETE' })).rejects.toBeInstanceOf(MethodNotAllowedError);
  });

  it('bounds concurrency per host', async () => {
    const limiter = new HostLimiter(2, 0);
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 6 }, () =>
        limiter.run(async () => {
          active++;
          peak = Math.max(peak, active);
          await new Promise(r => setTimeout(r, 5));
          active--;
        }),
      ),
    );
    expect(peak).toBe(2);
  });
});

describe('Nebius Monitoring (GPU metrics without a cluster)', () => {
  it('reads utilisation, temperature, power and memory per GPU, tied to its VM', async () => {
    const { fetch } = stubFetch();
    const r = await new NebiusMonitoringConnector(client(fetch), { projects: ['project-e00mocksandbox', 'project-e00mockstaging'], maxConcurrency: 2 }).sync();
    expect(r.gpus).toEqual([
      expect.objectContaining({ instanceId: 'computeinstance-e00mockinfgpu0', gpu: '0', projectId: 'project-e00mocksandbox', utilPercent: 63.5, tempC: 54, powerW: 310.2, memoryUsedMiB: 40211, memoryTotalMiB: 81559 }),
    ]);
    expect(r.outcomes.map(o => o.state)).toEqual(['ok', 'ok']);
  });

  it('a refused or missing project is reported per project', async () => {
    const { fetch } = stubFetch(url => (url.pathname.includes('project-e00mockstaging') ? new Response('{"code":7}', { status: 403 }) : undefined));
    const r = await new NebiusMonitoringConnector(client(fetch), { projects: ['project-e00mocksandbox', 'project-e00mockstaging', 'project-e00mocknone'], maxConcurrency: 2 }).sync();
    expect(Object.fromEntries(r.outcomes.map(o => [o.project, o.state]))).toEqual({ 'project-e00mocksandbox': 'ok', 'project-e00mockstaging': 'permission-denied', 'project-e00mocknone': 'not-found' });
  });
});

describe('Nebius billing calculator (live list prices)', () => {
  const fp = { nodeGroups: [{ name: 'gpu', role: 'gpu' as const, platform: 'gpu-h100-sxm', preset: '1gpu-16vcpu-200gb', count: 2, bootDiskGib: 200 }], filesystemGib: 1024, extraSsdGib: 0, ioM3Gib: 0, objectStorageGib: 50, publicIps: 1 };

  it('prices a footprint at list price when the contract price is refused, says so, and caches', async () => {
    const { fetch, calls } = stubFetch((_url, init) => (String(init.body ?? '').includes('OFFER_TYPE_CONTRACT_PRICE') ? new Response('{"code":7,"message":"PermissionDenied"}', { status: 403 }) : undefined));
    const calc = new NebiusCalculator(client(fetch, { allowPostPaths: ['/billing/v1/calculator/estimate-batch'] }), { currency: 'xts', ttlMs: 60_000 });
    const { lines, unpriced } = footprintLines(fp, 'project-e00mocksandbox', false);
    const e = await calc.estimate(lines, 'project-e00mocksandbox', unpriced, true);
    expect(e).toMatchObject({ offer: 'list', source: 'Nebius billing calculator (list price)', currency: 'XTS', contractNote: expect.stringMatching(/billinggroup/) });
    expect(e.lines.map(l => [l.key, l.count, l.hourly?.amount])).toEqual([
      ['vm:gpu', 2, '6.12'],
      ['boot:gpu', 2, '0.04'],
      ['fs', 1, '0.1024'],
    ]);
    expect(e.hourly).toEqual({ amount: '6.2624', currency: 'XTS' });
    expect(e.unpriced).toEqual(['Object Storage (usage-based; not priced per hour)', 'Public IPs (not priced through the calculator here)']);
    const before = calls.length;
    await calc.estimate(lines, 'project-e00mocksandbox', unpriced, false);
    expect(calls.length).toBe(before); // cached list prices
    expect(calls.every(c => c.method === 'POST' && c.url === '/billing/v1/calculator/estimate-batch')).toBe(true);
  });

  it('a contract price comes with the list price of the same lines', async () => {
    const { fetch } = stubFetch();
    const calc = new NebiusCalculator(client(fetch, { allowPostPaths: ['/billing/v1/calculator/estimate-batch'] }), { currency: 'xts', ttlMs: 60_000 });
    const { lines, unpriced } = footprintLines(fp, 'project-e00mocksandbox', false);
    const e = await calc.estimate(lines, 'project-e00mocksandbox', unpriced, true);
    expect(e).toMatchObject({ offer: 'contract', source: 'Nebius billing calculator (contract price)', contract: { attempted: true, available: true } });
    expect(e.listHourly).toEqual(e.hourly); // same as list on this account
  });

  it('a rejected spec is listed as unpriced, never guessed', async () => {
    const { fetch } = stubFetch();
    const calc = new NebiusCalculator(client(fetch, { allowPostPaths: ['/billing/v1/calculator/estimate-batch'] }), { currency: 'xts', ttlMs: 60_000 });
    const { lines } = footprintLines({ ...fp, nodeGroups: [{ ...fp.nodeGroups[0], preset: 'not-a-preset' }], filesystemGib: 0, objectStorageGib: 0, publicIps: 0 }, 'project-e00mocksandbox', false);
    const e = await calc.estimate(lines, 'project-e00mocksandbox', [], false);
    expect(e.lines.map(l => l.key)).toEqual(['boot:gpu']);
    expect(e.unpriced[0]).toMatch(/not-a-preset.*calculator/);
  });
});

describe('billing calculator: parallel footprints share calls (walkthrough 3)', () => {
  // A scenario's min / expected / max footprints: the same GPU node group at different counts, different filesystems.
  const group = { name: 'gpu', role: 'gpu' as const, platform: 'gpu-h100-sxm', preset: '1gpu-16vcpu-200gb', bootDiskGib: 200 };
  const footprints = [
    { nodeGroups: [{ ...group, count: 1 }], filesystemGib: 512, extraSsdGib: 0, ioM3Gib: 0, objectStorageGib: 0, publicIps: 0 },
    { nodeGroups: [{ ...group, count: 2 }], filesystemGib: 1024, extraSsdGib: 0, ioM3Gib: 0, objectStorageGib: 0, publicIps: 0 },
    { nodeGroups: [{ ...group, count: 4 }], filesystemGib: 2048, extraSsdGib: 0, ioM3Gib: 0, objectStorageGib: 0, publicIps: 0 },
  ];
  const LATENCY_MS = 150;

  async function firstLoad() {
    const { fetch, calls } = stubFetch(async () => {
      await new Promise(r => setTimeout(r, LATENCY_MS)); // the calculator's latency
      return undefined;
    });
    const calc = new NebiusCalculator(client(fetch, { allowPostPaths: ['/billing/v1/calculator/estimate-batch'] }), { currency: 'xts', ttlMs: 60_000 });
    const t0 = Date.now();
    const estimates = await Promise.all(footprints.map(f => {
      const { lines, unpriced } = footprintLines(f, 'project-e00mocksandbox', false);
      return calc.estimate(lines, 'project-e00mocksandbox', unpriced, true);
    }));
    return { ms: Date.now() - t0, calls: calls.length, estimates, calc };
  }

  it('coalesces identical in-flight lookups and prices a footprint\'s lines together; the cache still answers repeats', async () => {
    const r = await firstLoad();
    // Distinct specs: 1 VM spec + 1 boot disk + 3 filesystems = 5, each at contract and at list price.
    expect(r.calls).toBe(10);
    expect(r.ms).toBeLessThan(LATENCY_MS * 4); // was 6 sequential round trips per footprint
    expect(r.estimates.map(e => e.hourly?.amount)).toEqual(['3.1312', '6.2624', '12.5248']);
    expect(r.estimates.every(e => e.offer === 'contract' && e.listHourly?.amount === e.hourly?.amount)).toBe(true);
    expect(r.calc.cacheSize).toBe(10);
  });
});

describe('InventoryService keeps the last good data', () => {
  it('a list that fails on a later sync keeps its previous items, marked stale, and the capability keeps its last success', async () => {
    let deny = false;
    const { fetch } = stubFetch(url => (deny && url.pathname === '/compute/v1/disks' ? new Response('{"code":14}', { status: 503 }) : undefined));
    const spy = jest.spyOn(global, 'fetch').mockImplementation(fetch as any);
    try {
      const cfg = readEstateConfig(new ConfigReader(testConfig() as any));
      const svc = new InventoryService(cfg, mockServices.logger.mock());
      await svc.start();
      await svc.ready();
      const before = svc.snapshot().resources.filter(r => r.type === 'compute-disk').length;
      expect(before).toBeGreaterThan(0);
      deny = true;
      await svc.syncAll();
      const disks = svc.snapshot().resources.filter(r => r.type === 'compute-disk');
      expect(disks.length).toBe(before);
      expect(disks.every(d => d.coverageNotes.some(n => n.startsWith('Stale:')))).toBe(true);
      const cap = svc.snapshot().capabilities.find(c => c.id === 'compute.disks')!;
      expect(cap).toMatchObject({ state: 'unreachable', stale: true });
      expect(cap.lastSuccess).toBeDefined();
    } finally {
      spy.mockRestore();
    }
  }, 30_000);
});

describe('sync speed and concurrency', () => {
  const nine = ['sandbox', 'staging', 'lab', 'legacy', 'p5', 'p6', 'p7', 'p8', 'p9'].map(x => ({ id: `project-e00mock${x}` }));

  // Measured here (2026-10-12): full 285 calls ~8.9 s; core 131 calls ~4.4 s, was 94 calls ~3.3 s before managed
  // PostgreSQL, MLflow, registries and quota allowances joined the core tier (4 calls per project + 1 per tenant).
  it('9 projects at a live-like 350 ms per call, 12 calls in flight per host: a full sync under 10 s, a core-tier sync under 5 s', async () => {
    const run = async (skip?: Set<string>) => {
      const { fetch, calls } = stubFetch(async () => {
        await new Promise(r => setTimeout(r, 350));
        return undefined;
      });
      const started = performance.now();
      await new NebiusInventoryConnector(client(fetch, { limiter: new HostLimiter(12, 20) }), { tenantId: 'tenant-e00mocktest', projects: nine, maxConcurrency: 12, skip }).sync();
      return { calls: calls.length, ms: Math.round(performance.now() - started) };
    };
    const full = await run();
    const core = await run(new Set(CATALOG.filter(d => d.tier === 'slow').map(d => d.id)));
    const moved = ['msp.postgresql', 'msp.mlflow', 'registry.registries', 'quotas.allowances', 'quotas.allowances.tenant'];
    const before = await run(new Set([...CATALOG.filter(d => d.tier === 'slow').map(d => d.id), ...moved]));
    expect(core.calls - before.calls).toBe(4 * nine.length + 1);
    expect(full.ms).toBeLessThan(10_000);
    expect(core.ms).toBeLessThan(5_000);
  }, 60_000);

  it('reports a running sync, so a manual sync can be refused instead of queued', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => (release = r));
    const { fetch } = stubFetch(async () => {
      await gate;
      return undefined;
    });
    const spy = jest.spyOn(global, 'fetch').mockImplementation(fetch as any);
    try {
      const svc = new InventoryService(readEstateConfig(new ConfigReader(testConfig() as any)), mockServices.logger.mock());
      await svc.start(); // returns before the first sync finishes
      expect(svc.isRunning()).toBeDefined();
      expect(svc.snapshot().statuses.find(s => s.id === 'nebius-inventory')).toMatchObject({ running: true });
      release();
      await svc.ready();
      expect(svc.isRunning()).toBeUndefined();
      expect(svc.snapshot().statuses.find(s => s.id === 'nebius-inventory')?.running).toBe(false);
    } finally {
      spy.mockRestore();
    }
  }, 30_000);

  it('tiered syncs: slow lists are read on full syncs only, and their data stands in between', async () => {
    const { fetch, calls } = stubFetch();
    const spy = jest.spyOn(global, 'fetch').mockImplementation(fetch as any);
    try {
      const cfg = readEstateConfig(new ConfigReader(testConfig({ nebius: { ...(testConfig() as any).nebiusEstate.nebius, fullSyncEvery: 2 } }) as any));
      const svc = new InventoryService(cfg, mockServices.logger.mock());
      await svc.start();
      await svc.ready(); // full
      const quotas = svc.snapshot().capacity.quotas.length;
      const before = calls.length;
      await svc.syncAll(); // second sync: core tier only
      const second = calls.slice(before).map(c => c.url);
      expect(second.some(u => u.startsWith('/compute/v1/instances'))).toBe(true);
      expect(second.some(u => u.startsWith('/dns/') || u.startsWith('/compute/v1/platforms'))).toBe(false);
      expect(svc.snapshot().capacity.quotas.length).toBe(quotas);
      expect(svc.snapshot().resources.some(r => r.type === 'dns-zone' && !r.coverageNotes.some(n => n.startsWith('Stale:')))).toBe(true);
      const mark = calls.length;
      await svc.syncAll(); // third: full again
      expect(calls.slice(mark).some(c => c.url.startsWith('/dns/'))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  }, 30_000);

  // Live 2026-10-12 (followups 13, 23): R12 PostgreSQL, MLflow and the registry showed ~35 min late, and after their
  // deletion PostgreSQL stayed "running" and priced, because these lists were read on full syncs only.
  it('every sync reads managed PostgreSQL, MLflow, registries and quota allowances (project and tenant)', () => {
    for (const id of ['msp.postgresql', 'msp.mlflow', 'registry.registries', 'quotas.allowances', 'quotas.allowances.tenant']) {
      expect([id, CATALOG.find(d => d.id === id)?.tier]).toEqual([id, 'core']);
    }
  });

  it('a core sync costs 4 more list calls per project and 1 per tenant than before, and stays under the per-host budget', async () => {
    const { fetch, calls } = stubFetch();
    const slow = new Set(CATALOG.filter(d => d.tier === 'slow').map(d => d.id));
    await new NebiusInventoryConnector(client(fetch), { tenantId: 'tenant-e00mocktest', projects: PROJECTS, maxConcurrency: 4, skip: new Set([...slow, 'iam.projects.list']) }).sync();
    const lists = (prefix: string) => calls.filter(c => c.url.startsWith(prefix)).length;
    // One page per project for each project list, one tenant call for tenant quotas.
    expect(lists('/msp/postgresql/')).toBe(PROJECTS.length);
    expect(lists('/msp/mlflow/')).toBe(PROJECTS.length);
    expect(lists('/registry/v1/registries')).toBe(PROJECTS.length);
    expect(lists('/quotas/v1/quota-allowances')).toBe(PROJECTS.length + 1);
    expect(calls.filter(c => c.url.startsWith('/dns/') || c.url.startsWith('/vpc/v1/networks')).length).toBe(0);
  });

  it('a managed cluster or registry deleted between syncs leaves the inventory on the next core sync, and quota usage follows', async () => {
    let deleted = false;
    const gone = (url: URL) =>
      deleted && ['/msp/postgresql/v1alpha1/clusters', '/msp/mlflow/v1alpha1/clusters', '/registry/v1/registries'].includes(url.pathname)
        ? new Response(JSON.stringify(url.pathname.startsWith('/msp/postgresql') ? { clusters: [] } : { items: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
        : undefined;
    const { fetch } = stubFetch(url => gone(url));
    const spy = jest.spyOn(global, 'fetch').mockImplementation(fetch as any);
    try {
      const cfg = readEstateConfig(new ConfigReader(testConfig({ nebius: { ...(testConfig() as any).nebiusEstate.nebius, fullSyncEvery: 4 } }) as any));
      const svc = new InventoryService(cfg, mockServices.logger.mock());
      await svc.start();
      await svc.ready(); // full
      const kinds = () => svc.snapshot().resources.filter(r => ['postgresql-cluster', 'mlflow-cluster', 'container-registry'].includes(r.type)).map(r => r.type).sort();
      expect(kinds()).toEqual(['container-registry', 'mlflow-cluster', 'postgresql-cluster']);
      const quotasRead = svc.snapshot().capabilities.find(c => c.id === 'quotas.allowances')!.lastSuccess;
      deleted = true;
      await new Promise(r => setTimeout(r, 5));
      await svc.syncAll(); // core sync (not a full one)
      expect(kinds()).toEqual([]);
      // The quota list was read again: its last success moved on with the core sync.
      expect(svc.snapshot().capabilities.find(c => c.id === 'quotas.allowances')!.lastSuccess! > quotasRead!).toBe(true);
    } finally {
      spy.mockRestore();
    }
  }, 30_000);

  it('records when the latest core sync read the inventory; a fast re-sync does not move it, and lists it did not read keep their own time', async () => {
    const { fetch } = stubFetch();
    const spy = jest.spyOn(global, 'fetch').mockImplementation(fetch as any);
    try {
      const cfg = readEstateConfig(new ConfigReader(testConfig({ nebius: { ...(testConfig() as any).nebiusEstate.nebius, fullSyncEvery: 4 } }) as any));
      const svc = new InventoryService(cfg, mockServices.logger.mock());
      await svc.start();
      await svc.ready(); // full
      const first = svc.snapshot().inventoryReadAt!;
      expect(first).toEqual(expect.any(String));
      await new Promise(r => setTimeout(r, 5));
      await svc.syncAll(); // core
      const core = svc.snapshot().inventoryReadAt!;
      expect(core > first).toBe(true);
      const pg = svc.snapshot().resources.find(r => r.type === 'postgresql-cluster')!;
      expect(pg.observedAt).toBe(core);
      // A slow-tier list (DNS) was not read by the core sync: its items keep the time they were read.
      expect(svc.snapshot().resources.find(r => r.type === 'dns-zone')!.observedAt).toBe(first);
      await new Promise(r => setTimeout(r, 5));
      await (svc as any).runSync(undefined, true); // fast
      expect(svc.snapshot().inventoryReadAt).toBe(core);
    } finally {
      spy.mockRestore();
    }
  }, 30_000);

  it('a capability skipped by a core or fast sync keeps its last state, items and last success (never "not configured")', async () => {
    const { fetch } = stubFetch();
    const spy = jest.spyOn(global, 'fetch').mockImplementation(fetch as any);
    try {
      const cfg = readEstateConfig(new ConfigReader(testConfig({ nebius: { ...(testConfig() as any).nebiusEstate.nebius, fullSyncEvery: 3 } }) as any));
      const svc = new InventoryService(cfg, mockServices.logger.mock());
      await svc.start();
      await svc.ready(); // full
      const pick = () => new Map(svc.snapshot().capabilities.filter(c => c.connector === 'nebius-inventory').map(c => [c.id, { state: c.state, items: c.items, lastSuccess: c.lastSuccess }]));
      const full = pick();
      expect(full.get('iam.projects.list')).toMatchObject({ state: 'ok', items: expect.any(Number), lastSuccess: expect.any(String) });
      const slow = [...CATALOG.filter(d => d.tier === 'slow').map(d => d.id), 'iam.projects.list'];
      await svc.syncAll(); // core tier
      const core = pick();
      for (const id of slow) expect([id, core.get(id)]).toEqual([id, full.get(id)]);
      await (svc as any).runSync(undefined, true); // fast tier
      const fast = pick();
      for (const id of slow) expect([id, fast.get(id)]).toEqual([id, full.get(id)]);
      for (const [id, c] of fast) expect([id, c.state]).not.toEqual([id, 'not-configured']);
    } finally {
      spy.mockRestore();
    }
  }, 30_000);
});

describe('tenant project discovery is "not configured" only when it cannot run', () => {
  const run = async (opts: { tenantId?: string; discoverProjects?: boolean }, refuseProjects = false) => {
    // A refused project read leaves no tenant id to derive (none configured either).
    const { fetch } = stubFetch(url => (refuseProjects && url.pathname.startsWith('/iam/v2/projects/') ? new Response('{}', { status: 403 }) : undefined));
    const r = await new NebiusInventoryConnector(client(fetch), { projects: [{ id: 'project-e00mocksandbox' }], maxConcurrency: 4, ...opts }).sync();
    return r.capabilities.find(c => c.id === 'iam.projects.list');
  };
  it('discoverProjects off: not reported; on without a tenant id: not configured; on with one: read', async () => {
    expect(await run({ tenantId: 'tenant-e00mocktest', discoverProjects: false })).toBeUndefined();
    expect((await run({ tenantId: 'tenant-e00mocktest', discoverProjects: true }))?.state).toBe('ok');
    expect(await run({ discoverProjects: true }, true)).toMatchObject({ state: 'not-configured', hint: expect.stringContaining('No tenant id') });
  });
  it('skipped (slow tier) it is not reported at all, so the service keeps its last state', async () => {
    const { fetch } = stubFetch();
    const r = await new NebiusInventoryConnector(client(fetch), { tenantId: 'tenant-e00mocktest', projects: [{ id: 'project-e00mocksandbox' }], maxConcurrency: 4, discoverProjects: true, skip: new Set(['iam.projects.list']) }).sync();
    expect(r.capabilities.find(c => c.id === 'iam.projects.list')).toBeUndefined();
  });
});

describe('quota allowance mapping', () => {
  const meta = (extra: object = {}) => ({ name: 'compute.instance.non-gpu.vcpu', parentId: 'p', ...extra });
  it('a tenant allowance without spec.limit is limit 0 (enforced)', () => {
    expect(mapQuotaAllowance({ metadata: meta(), spec: { region: 'eu-north1' }, status: {} }, '')).toMatchObject({ scope: 'tenant', allocation: 'set', limit: 0, usage: 0, usagePercent: null });
  });
  it('a project placeholder (no id, epoch created_at, no limit, no state) inherits the tenant quota, in either JSON casing', () => {
    for (const m of [meta({ createdAt: '1970-01-01T00:00:00Z' }), meta({ created_at: '1970-01-01T00:00:00Z' }), meta(), meta({ id: 'p/x/eu-north1', idFromKey: true })]) {
      expect(mapQuotaAllowance({ metadata: m, spec: { region: 'eu-north1' }, status: { usage: '3', usage_state: 'USAGE_STATE_USED' } }, 'project-a')).toMatchObject({ scope: 'project', allocation: 'inherits-tenant', limit: null, usage: 3, usagePercent: null });
    }
  });
  it('a real project allocation is a cap: its limit, or 0 when omitted', () => {
    const real = { metadata: meta({ id: 'quotaallowance-x', createdAt: '2026-10-01T10:00:00Z' }), spec: { region: 'eu-north1', limit: '64' }, status: { usage: '16', state: 'STATE_ACTIVE' } };
    expect(mapQuotaAllowance(real, 'project-a')).toMatchObject({ allocation: 'set', limit: 64, usage: 16, usagePercent: 25 });
    expect(mapQuotaAllowance({ ...real, spec: { region: 'eu-north1' } }, 'project-a')).toMatchObject({ allocation: 'set', limit: 0, usagePercent: null });
    expect(mapQuotaAllowance({ metadata: meta({ createdAt: '1970-01-01T00:00:00Z' }), spec: { region: 'eu-north1' }, status: { state: 'STATE_ACTIVE' } }, 'project-a')).toMatchObject({ allocation: 'set', limit: 0 });
  });
  it('usagePercent is a percentage: the API reports usage_percentage as a 0–1 fraction (live 2026-10-11: 1 of 8 → 0.125)', () => {
    // Live-shaped tenant allowance: int64 as strings, the fraction as a number.
    const live = { metadata: { name: 'compute.instance.preemptible.count', parentId: 'tenant-x' }, spec: { region: 'eu-north1', limit: '8' }, status: { usage: '1', usagePercentage: 0.125, usageState: 'USAGE_STATE_USED', unit: 'count' } };
    expect(mapQuotaAllowance(live, '')).toMatchObject({ limit: 8, usage: 1, usagePercent: 12.5 });
    expect(mapQuotaAllowance({ ...live, spec: { region: 'eu-north1', limit: '50' }, status: { usage: '1', usage_percentage: 0.02 } }, '')).toMatchObject({ usagePercent: 2 });
    expect(mapQuotaAllowance({ ...live, spec: { region: 'eu-north1', limit: '2' }, status: { usage: '2', usagePercentage: 1 } }, '')).toMatchObject({ usagePercent: 100 });
    // The API rounds its fraction (2 of 32 reads 0.06): usage / limit is exact.
    expect(mapQuotaAllowance({ ...live, spec: { region: 'eu-north1', limit: '32' }, status: { usage: '2', usagePercentage: 0.06 } }, '')).toMatchObject({ usagePercent: 6.25 });
    // Only the fraction, no usage figure: still a percentage.
    expect(mapQuotaAllowance({ ...live, status: { usagePercentage: '0.875' } }, '')).toMatchObject({ usagePercent: 87.5 });
  });
});

describe('connectors before their first sync', () => {
  it('are "starting", never "stale", and unconfigured ones stay "not configured"', () => {
    const defs = connectorDefinitions({ nebiusProjects: ['project-a'], syncIntervalMinutes: 15, kubernetes: [], monitoring: true, pricing: true, billingExport: false });
    const st = Object.fromEntries(defs.map(d => [d.id, d.state]));
    expect(st).toMatchObject({ 'nebius-inventory': 'starting', 'nebius-monitoring': 'starting', 'nebius-pricing': 'starting', 'billing-object-storage': 'not-configured' });
    expect(Object.values(st)).not.toContain('stale');
  });

  it('an unset external Prometheus is "not needed" (complete), not a gap', () => {
    const p = connectorDefinitions({ nebiusProjects: ['project-a'], syncIntervalMinutes: 15, kubernetes: [], monitoring: true }).find(d => d.id === 'prometheus')!;
    expect(p).toMatchObject({ title: 'External Prometheus', state: 'not-needed', missingCoverage: ['GPU telemetry already comes from Nebius Monitoring (official endpoint, all listed projects). Set this only for a Prometheus you run outside Nebius.'] });
    const set = connectorDefinitions({ nebiusProjects: ['project-a'], syncIntervalMinutes: 15, kubernetes: [], prometheus: 'prom.example' }).find(d => d.id === 'prometheus')!;
    expect(set.state).toBe('starting');
  });
});

describe('capability health', () => {
  it('a capability not set up now (e.g. node groups once the last cluster is gone) shows no health from its earlier runs', async () => {
    const svc = new InventoryService(readEstateConfig(new ConfigReader(testConfig() as any)), mockServices.logger.mock());
    const at = '2026-10-11T15:30:00.000Z';
    const runs = { runs24h: 3, successRate24h: 1, consecutiveFailures: 0, failures24h: 0, recentRuns: [{ at, ok: true, durationMs: 5 }] };
    (svc as any).snap.capabilities = [
      { id: 'mk8s.node-groups', title: 'Node groups', service: 'mk8s', connector: 'nebius-inventory', scope: 'cluster', path: '/mk8s/v1/node-groups', method: 'GET', state: 'not-configured' },
      { id: 'mk8s.clusters', title: 'Clusters', service: 'mk8s', connector: 'nebius-inventory', scope: 'project', path: '/mk8s/v1/clusters', method: 'GET', state: 'ok', lastSuccess: at },
    ];
    (svc as any).health.capabilities = new Map([['mk8s.node-groups', runs], ['mk8s.clusters', runs]]);
    const caps = new Map(svc.snapshot().capabilities.map(c => [c.id, c]));
    expect(caps.get('mk8s.node-groups')?.health).toBeUndefined();
    expect(caps.get('mk8s.clusters')?.health).toMatchObject({ runs24h: 3 });
  });
});
