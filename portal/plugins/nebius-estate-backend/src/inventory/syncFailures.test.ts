import { mockServices } from '@backstage/backend-test-utils';
import { ConfigReader } from '@backstage/config';
import { resolve } from 'path';
import { readEstateConfig } from '../lib/config';
import { HealthStore, RunRow } from '../health/HealthStore';
import { TEST_DATA, testConfig } from '../__testUtils__/testing';
import { InventoryService } from './InventoryService';
import { NebiusInventoryConnector } from './nebius';
import { HttpClient } from '../lib/http';
import { NEBIUS_API } from './endpoints';
import { connectorState, errorSummary, plainError } from '@internal/nebius-domain';

/**
 * W1e live findings, reproduced against the stub with a mocked fetch: calls that do not answer (F1.30/F1.31) and a
 * project read that fails (F1.32). A failed call here is one that fails fast (a TLS error: not connect-class), so
 * the tests do not wait out the connect retry budget.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const stub: { handle: (m: string, u: string, h: Record<string, string>, b?: unknown) => { status: number; body?: unknown; raw?: Buffer; contentType?: string } } = require(resolve(TEST_DATA, 'stubApi.js'));

const noAnswer = () => new TypeError('fetch failed', { cause: Object.assign(new Error('certificate has expired'), { code: 'CERT_HAS_EXPIRED' }) });

/** fetch backed by the shared stub; `fail(url)` true makes that call fail without an answer, a number answers with that status. */
function stubFetch(fail: (url: URL) => boolean | number = () => false) {
  return jest.fn(async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    const f = fail(url);
    if (f === true) throw noAnswer();
    if (typeof f === 'number') return new Response('{"code":7,"message":"PermissionDenied"}', { status: f, headers: { 'content-type': 'application/json' } });
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const r = stub.handle(init.method ?? 'GET', url.pathname + url.search, headers, init.body ? JSON.parse(String(init.body)) : undefined);
    if (r.raw) return new Response(r.raw, { status: r.status, headers: { 'content-type': r.contentType ?? 'application/octet-stream' } });
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
  });
}

/** A health store that keeps the rows it is given (recordRuns), and has no history. */
function recordingStore() {
  const rows: RunRow[] = [];
  const store = { record: async (r: RunRow[]) => void rows.push(...r), stats: async () => new Map() } as unknown as HealthStore;
  return { rows, store };
}

const inventoryOnly = (nebius: Record<string, unknown> = {}) => {
  const base = (testConfig() as any).nebiusEstate.nebius;
  return readEstateConfig(new ConfigReader(testConfig({ nebius: { ...base, monitoring: { enabled: false }, pricing: { enabled: false }, mk8s: { discover: false }, ...nebius } }) as any));
};

describe('a sync whose calls do not all answer (F1.31)', () => {
  let fail: (url: URL) => boolean | number = () => false;
  let spy: jest.SpyInstance;
  beforeEach(() => {
    fail = () => false;
    spy = jest.spyOn(global, 'fetch').mockImplementation(stubFetch(url => fail(url)) as any);
  });
  afterEach(() => spy.mockRestore());

  it('marks the inventory connector degraded with the count of calls that failed, and records the run as failed', async () => {
    const { rows, store } = recordingStore();
    const svc = new InventoryService(inventoryOnly(), mockServices.logger.mock());
    svc.useHealthStore(store);
    await svc.start();
    await svc.ready();
    const inv = () => svc.snapshot().statuses.find(s => s.id === 'nebius-inventory')!;
    // The stub refuses one project's VPC and storage lists: answered, so "partial", and the run counts as answered.
    expect(inv().state).toBe('permission-denied');
    expect(inv().calls).toMatchObject({ failed: 0 });
    expect(rows.find(r => r.subject === 'nebius-inventory')).toMatchObject({ ok: true });

    // The live failure: some calls get no answer at all ("fetch failed").
    rows.length = 0;
    fail = url => url.pathname.startsWith('/compute/');
    await svc.syncAll();
    const s = inv();
    expect(s.state).toBe('degraded');
    expect(s.calls!.failed).toBeGreaterThan(0);
    expect(s.calls!.failed).toBeLessThan(s.calls!.total);
    // The error names the cause, in full.
    expect(s.error).toContain('fetch failed (CERT_HAS_EXPIRED: certificate has expired)');
    expect(rows.find(r => r.subject === 'nebius-inventory')).toMatchObject({ ok: false, errorClass: 'degraded' });
  }, 30_000);

  it('counts "calls" per list, as the card’s per-state counts do, keeps the last success, and counts every error (F1.31 review)', async () => {
    const svc = new InventoryService(inventoryOnly(), mockServices.logger.mock());
    await svc.start();
    await svc.ready();
    const inv = () => svc.snapshot().statuses.find(s => s.id === 'nebius-inventory')!;
    const lastSuccess = inv().lastSuccess;
    expect(lastSuccess).toBeDefined();
    // Compute lists get no answer, project reads answer 503: many failed reads (per project), fewer failed lists.
    fail = url => (url.pathname.startsWith('/compute/') ? true : url.pathname.startsWith('/iam/v2/projects/') ? 503 : false);
    await svc.syncAll();
    const s = inv();
    expect(s.state).toBe('degraded');
    // The same capabilities the Integrations card counts under "Calls at the last sync".
    const lists = svc.snapshot().capabilities.filter(c => c.connector === 'nebius-inventory' && c.state !== 'not-configured');
    expect(s.calls).toEqual({ failed: lists.filter(c => c.state === 'unreachable').length, total: lists.length });
    expect(connectorState(s).label).toBe(`degraded (${s.calls!.failed} of ${s.calls!.total} calls failed)`);
    // A degraded run is a failed run: the last success stays the last sync where every call answered.
    expect(s.lastSuccess).toBe(lastSuccess);
    // "+N more" counts every error, not the five the message keeps.
    expect(s.errorCount).toBeGreaterThan(5);
    expect(errorSummary(s.error!, s.errorCount)).toMatch(new RegExp(`\\(\\+${s.errorCount! - 1} more\\)$`));
  }, 30_000);

  it('no call answering at all is an error and keeps the last success', async () => {
    const { rows, store } = recordingStore();
    const svc = new InventoryService(inventoryOnly(), mockServices.logger.mock());
    svc.useHealthStore(store);
    await svc.start();
    await svc.ready();
    const lastSuccess = svc.snapshot().statuses.find(s => s.id === 'nebius-inventory')!.lastSuccess;
    expect(lastSuccess).toBeDefined();
    rows.length = 0;
    fail = url => url.origin === NEBIUS_API;
    await svc.syncAll();
    const s = svc.snapshot().statuses.find(x => x.id === 'nebius-inventory')!;
    expect(s).toMatchObject({ state: 'error', lastSuccess });
    // Every list this sync called failed; the slow-tier lists it did not call keep their last state (as on the card).
    const lists = svc.snapshot().capabilities.filter(c => c.connector === 'nebius-inventory' && c.state !== 'not-configured');
    expect(lists.filter(c => c.lastAttempt === lists.reduce((a, c2) => ((c2.lastAttempt ?? '') > a ? c2.lastAttempt! : a), '')).every(c => c.state === 'unreachable')).toBe(true);
    expect(s.calls).toEqual({ failed: lists.filter(c => c.state === 'unreachable').length, total: lists.length });
    expect(rows.find(r => r.subject === 'nebius-inventory')).toMatchObject({ ok: false, errorClass: 'error' });
  }, 30_000);

  it('a failed slow-tier call carried over by a core sync keeps the connector degraded and the last success where it was (W1F.N2)', async () => {
    const svc = new InventoryService(inventoryOnly(), mockServices.logger.mock());
    // The start-up (full) sync cannot read one slow-tier list.
    // (Registries were the example until they joined the core tier, 2026-10-12; KMS keys are still slow.)
    fail = url => url.pathname.startsWith('/kms/');
    await svc.start();
    await svc.ready();
    const inv = () => svc.snapshot().statuses.find(s => s.id === 'nebius-inventory')!;
    expect(inv().state).toBe('degraded');
    const lastSuccess = inv().lastSuccess;
    // The next sync is a core one: it does not read that list, every call it makes answers, its error stands.
    fail = () => false;
    await svc.syncAll();
    const s = inv();
    // In words (W1F.N3): the call's title; the page names the project from the connector's projects.
    expect(s.error).toMatch(/^KMS keys in project-e00mock/);
    expect(plainError(s.error!, s.projects)).toMatch(/^KMS keys in [a-z-]+: \/kms\/v1\/symmetric-keys/);
    expect(plainError(s.error!, s.projects)).not.toMatch(/kms\.symmetric-keys|project-e00|https?:/);
    expect(s.calls!.failed).toBeGreaterThan(0);
    expect(s.state).toBe('degraded');
    expect(s.lastSuccess).toBe(lastSuccess);
  }, 30_000);

  it('a core sync keeps the coverage gaps of the slow-tier lists it did not read (W1F.S7)', async () => {
    const svc = new InventoryService(inventoryOnly(), mockServices.logger.mock());
    await svc.start();
    await svc.ready();
    const legacy = () => svc.snapshot().coverage.find(c => c.project?.id === 'project-e00mocklegacy')!;
    expect(legacy()).toMatchObject({ partial: true });
    expect(legacy().note).toMatch(/vpc\.networks \(403\)/);
    const before = legacy().note;
    // A core sync reads storage.buckets (refused again) but not the slow VPC lists: their refusals still stand.
    await svc.syncAll();
    expect(legacy()).toMatchObject({ partial: true, note: before });
  }, 30_000);

  it('refused calls alone stay "permission denied" (shown as partial) and the run counts as answered', async () => {
    const { rows, store } = recordingStore();
    const svc = new InventoryService(inventoryOnly(), mockServices.logger.mock());
    svc.useHealthStore(store);
    fail = url => (url.pathname.startsWith('/compute/') ? 403 : false);
    await svc.start();
    await svc.ready();
    const s = svc.snapshot().statuses.find(x => x.id === 'nebius-inventory')!;
    expect(s.state).toBe('permission-denied');
    expect(s.calls!.failed).toBe(0);
    expect(rows.find(r => r.subject === 'nebius-inventory')).toMatchObject({ ok: true, errorClass: 'partial' });
  }, 30_000);
});

describe('a failed project read keeps the tenant (F1.32)', () => {
  const projects = [{ id: 'project-e00mocksandbox' }, { id: 'project-e00mockstaging' }];
  const client = (fetch: any) => new HttpClient({ allowedOrigins: [NEBIUS_API], timeoutMs: 1000, fetch, authorization: async () => 'Bearer test', sleep: async () => undefined });

  it('the connector derives the tenant from any project read, else uses the last known one', async () => {
    let failProjects = false;
    const fetch = stubFetch(url => failProjects && url.pathname.startsWith('/iam/v2/projects/'));
    const first = await new NebiusInventoryConnector(client(fetch), { projects, maxConcurrency: 4 }).sync();
    expect(first.tenantId).toBeDefined();
    failProjects = true;
    const unknown = await new NebiusInventoryConnector(client(fetch), { projects, maxConcurrency: 4 }).sync();
    expect(unknown.tenantId).toBeUndefined();
    const kept = await new NebiusInventoryConnector(client(fetch), { projects, maxConcurrency: 4, lastKnownTenantId: first.tenantId }).sync();
    expect(kept.tenantId).toBe(first.tenantId);
    // Tenant lists still run, and the project resources keep their tenant.
    expect(kept.capabilities.find(c => c.id === 'quotas.allowances.tenant')!.state).not.toBe('not-configured');
    expect(kept.resources.filter(r => r.type === 'project').every(r => r.tenantId === first.tenantId)).toBe(true);
  });

  it('the service keeps the tenant and the tenant-level data across a sync whose project reads all fail', async () => {
    let failProjects = false;
    const spy = jest.spyOn(global, 'fetch').mockImplementation(stubFetch(url => failProjects && url.pathname.startsWith('/iam/v2/projects/')) as any);
    try {
      // No tenant id in config (the local config before F1.32): derived from the project reads.
      const svc = new InventoryService(inventoryOnly({ tenantId: undefined }), mockServices.logger.mock());
      await svc.start();
      await svc.ready();
      const tenantQuotas = () => svc.snapshot().capacity.quotas.filter(q => q.scope === 'tenant').length;
      const before = tenantQuotas();
      expect(before).toBeGreaterThan(0);
      expect(svc.tenantId()).toBe('tenant-e00mocktest');
      failProjects = true;
      await svc.syncAll();
      expect(svc.tenantId()).toBe('tenant-e00mocktest');
      expect(tenantQuotas()).toBe(before);
      const cap = svc.snapshot().capabilities.find(c => c.id === 'quotas.allowances.tenant')!;
      expect(cap.state).not.toBe('not-configured');
      expect(svc.snapshot().resources.filter(r => r.type === 'project').every(r => r.tenantId === 'tenant-e00mocktest')).toBe(true);
    } finally {
      spy.mockRestore();
    }
  }, 30_000);
});

describe('a failed project read keeps the last names and regions (F1.37)', () => {
  it('the service keeps each project\'s last name and region, and resources in it keep their region', async () => {
    let failProjects = false;
    const spy = jest.spyOn(global, 'fetch').mockImplementation(stubFetch(url => failProjects && url.pathname.startsWith('/iam/v2/projects/')) as any);
    try {
      const svc = new InventoryService(inventoryOnly(), mockServices.logger.mock());
      await svc.start();
      await svc.ready();
      const projects = () => svc.snapshot().resources.filter(r => r.type === 'project').map(r => ({ id: r.providerId, name: r.name, region: r.region }));
      const regionsOfOthers = () => new Set(svc.snapshot().resources.filter(r => r.type !== 'project').map(r => r.region).filter(Boolean)).size;
      const before = projects();
      expect(before.every(p => p.name !== p.id)).toBe(true);
      const regions = regionsOfOthers();
      failProjects = true;
      await svc.syncAll();
      expect(projects()).toEqual(before);
      expect(regionsOfOthers()).toBe(regions);
      // Said, not hidden: the project carries why its name and region are the last known ones.
      expect(svc.snapshot().resources.find(r => r.type === 'project')!.coverageNotes.join(' ')).toMatch(/last successful read/);
    } finally {
      spy.mockRestore();
    }
  }, 30_000);

  it('a first sync after a restart whose project reads fail says the last read is not kept across a restart (review)', async () => {
    const spy = jest.spyOn(global, 'fetch').mockImplementation(stubFetch(url => url.pathname.startsWith('/iam/v2/projects/')) as any);
    try {
      const svc = new InventoryService(inventoryOnly(), mockServices.logger.mock());
      await svc.start();
      await svc.ready();
      const note = svc.snapshot().resources.find(r => r.type === 'project')!.coverageNotes.join(' ');
      expect(note).toMatch(/reading it by id failed/);
      expect(note).toMatch(/kept in memory only: after a backend restart the name and region return with the first successful read/);
    } finally {
      spy.mockRestore();
    }
  }, 30_000);
});

describe('a scheduled run that starts long after it was due (F1.45)', () => {
  it('waits for the API and, still unreachable, defers: no call, no failed run, and the connector says why', async () => {
    const { rows, store } = recordingStore();
    const fetch = stubFetch();
    const spy = jest.spyOn(global, 'fetch').mockImplementation(fetch as any);
    try {
      const svc = new InventoryService(inventoryOnly(), mockServices.logger.mock());
      svc.useHealthStore(store);
      let clock = Date.parse('2026-10-12T01:00:00Z');
      let reachable = false;
      const probe = jest.fn(async () => reachable);
      svc.setSchedule(15 * 60_000, 60_000, { probe, now: () => clock, sleep: async ms => void (clock += ms) });
      await svc.start();
      await svc.ready();
      svc.stopFastResync();
      // On time: syncs, no probe.
      clock += 15 * 60_000;
      expect(await svc.runScheduled()).toBe(true);
      expect(probe).not.toHaveBeenCalled();
      // Nine hours asleep, network not back: deferred.
      clock += 9 * 3_600_000;
      fetch.mockClear();
      rows.length = 0;
      expect(await svc.runScheduled()).toBe(false);
      expect(probe).toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      expect(rows).toEqual([]);
      const inv = svc.snapshot().statuses.find(s => s.id === 'nebius-inventory')!;
      expect(inv.notes).toEqual(expect.arrayContaining([expect.stringMatching(/^Scheduled sync started \d+ min after it was due .*deferred to the next run/)]));
      expect(inv.notes!.join(' ')).not.toContain('?');
      expect(inv.state).not.toBe('error');
      // Any completed sync (here "Sync now") clears the note.
      reachable = true;
      await svc.syncAll();
      expect(svc.snapshot().statuses.find(s => s.id === 'nebius-inventory')!.notes ?? []).not.toEqual(expect.arrayContaining([expect.stringMatching(/deferred/)]));
      reachable = false;
      // Late again, network back: runs, and the note goes.
      clock += 9 * 3_600_000;
      reachable = true;
      expect(await svc.runScheduled()).toBe(true);
      expect(fetch).toHaveBeenCalled();
      expect(svc.snapshot().statuses.find(s => s.id === 'nebius-inventory')!.notes ?? []).not.toEqual(expect.arrayContaining([expect.stringMatching(/deferred/)]));
    } finally {
      spy.mockRestore();
    }
  }, 30_000);
});
