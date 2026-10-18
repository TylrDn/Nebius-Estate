import { readFileSync } from 'fs';
import { resolve } from 'path';
import { coreServices, createServiceFactory } from '@backstage/backend-plugin-api';
import { mockServices } from '@backstage/backend-test-utils';
import knex, { Knex } from 'knex';
import { AuthorizeResult } from '@backstage/plugin-permission-common';
import { NEBIUS_API, NEBIUS_AUDIT, NEBIUS_LOGGING, NEBIUS_MONITORING } from '../inventory/endpoints';

/** Test helpers shared by the backend plugin tests (not exported from the package). */

/** Stands in for every discovered MK8s endpoint (served by the stub under /k8s/<cluster>). */
export const KUBE_TEST_ENDPOINT = 'http://127.0.0.1:7199';

// Test-only paths: tests always run from the source tree, never from a production build.
// eslint-disable-next-line no-restricted-syntax
export const REPO_ROOT = resolve(__dirname, '../../../../..');
/** Test data shared with the Playwright suite: REST-shaped inventory, a FOCUS CSV, a rate book, scenarios. */
// eslint-disable-next-line no-restricted-syntax
export const TEST_DATA = resolve(__dirname, '../../../../e2e-stub');

export const readTestData = (name: string) => readFileSync(resolve(TEST_DATA, name), 'utf8');

/** The clock the tests run on (inside the test data's billing period and budgets). */
export const TEST_NOW = new Date('2026-10-10T12:00:00Z');

/** Fakes only Date, so timers, sockets and the test backend run normally. */
export function useTestClock() {
  beforeAll(() => {
    jest.useFakeTimers({
      now: TEST_NOW,
      doNotFake: ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'],
    });
  });
  afterAll(() => jest.useRealTimers());
}

/**
 * Serves the e2e stub (e2e-stub/stubApi.js: Nebius REST lists, projects by id,
 * Monitoring PromQL and the billing calculator) through a mocked global fetch.
 * Calls to any other origin fail the test.
 */
export function stubNebiusApi() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { handle } = require(resolve(TEST_DATA, 'stubApi.js'));
  let spy: jest.SpyInstance;
  beforeAll(() => {
    spy = jest.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.origin !== NEBIUS_API && url.origin !== NEBIUS_MONITORING && url.origin !== NEBIUS_LOGGING && url.origin !== NEBIUS_AUDIT && url.origin !== KUBE_TEST_ENDPOINT) throw new Error(`unexpected outbound call to ${url.origin}`);
      const headers = Object.fromEntries(new Headers(init?.headers).entries());
      const r = handle(init?.method ?? 'GET', url.pathname + url.search, headers, init?.body ? JSON.parse(String(init.body)) : undefined);
      if (r.raw) return new Response(r.raw, { status: r.status, headers: { 'content-type': r.contentType } });
      return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
    });
  });
  afterAll(() => spy.mockRestore());
}

const testDatabases: Knex[] = [];

/**
 * The database for one startTestBackend: in-memory SQLite owned by the test file and destroyed after
 * its tests. Backstage's DatabaseManager never destroys SQLite clients on shutdown (it keeps in-memory
 * dev data), so with the default database factory every test backend left a pool reaper running and
 * Jest force-exited the worker. Same foreign-key pragma as Backstage's SQLite connector.
 */
export function testDatabase() {
  const db = knex({ client: 'better-sqlite3', connection: ':memory:', useNullAsDefault: true });
  db.client.pool.on('createSuccess', (_id: unknown, conn: { pragma: (s: string) => unknown }) => conn.pragma('foreign_keys = ON'));
  testDatabases.push(db);
  return mockServices.database.factory({ knex: db });
}

// Declared after @backstage/backend-test-utils registers its own afterAll (which stops every test
// backend), so the databases close only once their plugins have shut down.
afterAll(async () => {
  await Promise.all(testDatabases.splice(0).map(db => db.destroy()));
});

/** Permission names granted per user ref; everything else is denied. */
export function permissionsByUser(grants: Record<string, string[]>) {
  return createServiceFactory({
    service: coreServices.permissions,
    deps: {},
    factory: () => ({
      async authorize(requests: any[], options: any) {
        const ref = options?.credentials?.principal?.userEntityRef as string | undefined;
        const allowed = new Set(ref ? grants[ref] ?? [] : []);
        return requests.map(r => ({ result: allowed.has(r.permission.name) || allowed.has('*') ? AuthorizeResult.ALLOW : AuthorizeResult.DENY }));
      },
      async authorizeConditional(requests: any[]) {
        return requests.map(() => ({ result: AuthorizeResult.DENY }));
      },
    }),
  });
}

/** Ids only: names and regions come from the (mocked) GET /iam/v2/projects/{id}. */
export const TEST_PROJECTS = [{ id: 'project-e00mocksandbox' }, { id: 'project-e00mockstaging' }, { id: 'project-e00mocklab' }, { id: 'project-e00mocklegacy' }];

/** A loopback-only backend with the test projects; the token is a placeholder for the mocked API. */
export function testConfig(extra: Record<string, unknown> = {}) {
  process.env.NEBIUS_TEST_TOKEN = 'test-token';
  return {
    backend: { baseUrl: 'http://localhost:7007', listen: { host: '127.0.0.1' }, database: { client: 'better-sqlite3', connection: ':memory:' } },
    nebiusEstate: {
      repoRoot: REPO_ROOT,
      waitForFirstSync: true,
      access: {
        roles: [
          { name: 'all', principals: ['user:default/admin', 'user:default/viewer', 'user:default/nobody', 'user:default/pricer', 'user:default/estimator', 'user:default/writer'], projects: ['*'], permissions: ['*'] },
          { name: 'sandbox-only', principals: ['user:default/alice'], projects: ['project-e00mocksandbox'], permissions: ['*'] },
        ],
      },
      nebius: { tenantId: 'tenant-e00mocktest', projects: TEST_PROJECTS, auth: { tokenEnv: 'NEBIUS_TEST_TOKEN' }, pricing: { currency: 'xts' }, maxConcurrency: 8, minRequestIntervalMs: 0, discoverProjects: true, mk8s: { testEndpoint: KUBE_TEST_ENDPOINT } },
      budgets: [
        { id: 'sandbox-run-481', project: 'project-e00mocksandbox', amount: '1500', currency: 'XTS', period: '2026-10', source: 'test' },
        { id: 'staging-monthly', project: 'project-e00mockstaging', amount: '2000', currency: 'XTS', period: '2026-10', source: 'test' },
      ],
      ...extra,
    },
  };
}
