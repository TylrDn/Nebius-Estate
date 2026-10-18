import { mockServices, startTestBackend } from '@backstage/backend-test-utils';
import { ConfigReader } from '@backstage/config';
import { readEstateConfig } from '../lib/config';
import { HealthStore, RunRow } from '../health/HealthStore';
import { permissionsByUser, testConfig, testDatabase, TEST_PROJECTS } from '../__testUtils__/testing';
import { nebiusEstatePlugin } from '../plugin';
import { HttpClient, inBackgroundSync } from '../lib/http';
import { InventoryService } from './InventoryService';

/**
 * Caveat 1 (intermittent unit failures): a test backend stopped while its first sync was still retrying connect-class
 * errors (its stub servers gone) kept syncing after the plugin shut down. The sync then wrote to the database the
 * test had destroyed ("Unable to acquire a connection"), and the rejection failed whichever test the Jest worker
 * ran next, with an empty message (database.test, RepoReader, alert rules, FOCUS migration: about 1 run in 3 with
 * two workers). Stopping the plugin now ends its sync: retries and back-off waits stop, nothing is recorded after.
 */

const refused = () => new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:7199'), { code: 'ECONNREFUSED' }) });

const inventoryOnly = () => {
  const base = (testConfig() as any).nebiusEstate.nebius;
  return readEstateConfig(new ConfigReader(testConfig({ nebius: { ...base, monitoring: { enabled: false }, pricing: { enabled: false }, mk8s: { discover: false } } }) as any));
};

describe('stopping the plugin ends its sync (caveat 1)', () => {
  let spy: jest.SpyInstance;
  beforeEach(() => {
    process.env.NEBIUS_TEST_TOKEN = 'test-token';
    spy = jest.spyOn(global, 'fetch').mockImplementation((async () => {
      throw refused();
    }) as any);
  });
  afterEach(() => spy.mockRestore());

  it('a sync retrying connect errors stops with the plugin: no more calls, nothing recorded after', async () => {
    const rows: RunRow[] = [];
    const store = { record: async (r: RunRow[]) => void rows.push(...r), stats: async () => new Map() } as unknown as HealthStore;
    const svc = new InventoryService(inventoryOnly(), mockServices.logger.mock());
    svc.useHealthStore(store);
    await svc.start();
    // The first sync is retrying (30 s connect budget in a sync).
    while (spy.mock.calls.length < 2) await new Promise(r => setTimeout(r, 10));
    expect(svc.isRunning()).toBeDefined();
    const t0 = performance.now();
    await svc.stop();
    expect(performance.now() - t0).toBeLessThan(5_000);
    expect(svc.isRunning()).toBeUndefined();
    const calls = spy.mock.calls.length;
    await new Promise(r => setTimeout(r, 600));
    expect(spy.mock.calls.length).toBe(calls);
    // A run cut short by shutdown is not a failure of the connectors: nothing is written to the (closing) store.
    expect(rows).toEqual([]);
    // And no new sync starts once stopped.
    await svc.syncAll();
    expect(spy.mock.calls.length).toBe(calls);
  }, 15_000);
});

describe('a test backend stopped during its first sync (caveat 1, the reproduced condition)', () => {
  let spy: jest.SpyInstance;
  beforeEach(() => {
    process.env.NEBIUS_TEST_TOKEN = 'test-token';
    spy = jest.spyOn(global, 'fetch').mockImplementation((async () => {
      throw refused();
    }) as any);
  });
  afterEach(() => spy.mockRestore());

  it('makes no call once stopped, so it never syncs on into the database its test closes', async () => {
    const backend = await startTestBackend({
      features: [
        testDatabase(),
        nebiusEstatePlugin,
        mockServices.rootConfig.factory({ data: testConfig({ waitForFirstSync: false, nebius: { tenantId: 'tenant-e00mocktest', projects: TEST_PROJECTS, auth: { tokenEnv: 'NEBIUS_TEST_TOKEN' }, monitoring: { enabled: false }, pricing: { enabled: false }, mk8s: { discover: false }, minRequestIntervalMs: 0 } }) }),
        permissionsByUser({}),
      ],
    });
    while (spy.mock.calls.length < 2) await new Promise(r => setTimeout(r, 10));
    await backend.stop();
    const calls = spy.mock.calls.length;
    await new Promise(r => setTimeout(r, 1_000));
    expect(spy.mock.calls.length).toBe(calls);
  }, 15_000);
});

describe('a sync stopped while it waits (caveat 1)', () => {
  it('ends a connect-retry back-off at once and makes no further attempt', async () => {
    const fetch = jest.fn(async () => {
      throw refused();
    });
    const c = new HttpClient({ allowedOrigins: ['https://api.nebius.cloud'], timeoutMs: 1000, fetch: fetch as any });
    const stop = new AbortController();
    const t0 = performance.now();
    const result = inBackgroundSync(() => c.request('https://api.nebius.cloud/x'), stop.signal).then(() => undefined, (e: Error) => e);
    while (fetch.mock.calls.length < 1) await new Promise(r => setTimeout(r, 5));
    stop.abort();
    const err = await result;
    expect(err?.message).toMatch(/stopped: the portal backend is shutting down/);
    expect(performance.now() - t0).toBeLessThan(2_000);
    const n = fetch.mock.calls.length;
    await new Promise(r => setTimeout(r, 300));
    expect(fetch.mock.calls.length).toBe(n);
  });
});
