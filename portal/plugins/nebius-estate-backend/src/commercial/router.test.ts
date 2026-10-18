import { mockCredentials, mockServices, startTestBackend } from '@backstage/backend-test-utils';
import request from 'supertest';
import { nebiusEstatePlugin } from '../plugin';
import { testDatabase, permissionsByUser, readTestData, stubNebiusApi, testConfig, useTestClock } from '../__testUtils__/testing';

const FINANCE = ['nebius.billing.read', 'nebius.billing.import', 'nebius.commercial.rate.read', 'nebius.commercial.scenario.read'];
const API = '/api/nebius-estate';

async function backend(extra: Record<string, unknown> = {}) {
  const { server } = await startTestBackend({
    features: [
      testDatabase(),
      nebiusEstatePlugin,
      mockServices.rootConfig.factory({
        data: testConfig({
          access: {
            roles: [
              { name: 'all', principals: ['user:default/finance', 'user:default/engineer', 'user:default/writer'], projects: ['*'], permissions: ['*'] },
              { name: 'sandbox', principals: ['user:default/alice'], projects: ['project-e00mocksandbox'], permissions: ['*'] },
            ],
          },
          ...extra,
        }),
      }),
      permissionsByUser({
        'user:default/finance': FINANCE,
        'user:default/alice': FINANCE,
        'user:default/engineer': ['nebius.commercial.scenario.read'],
        'user:default/writer': [...FINANCE, 'nebius.commercial.rate.write', 'nebius.commercial.scenario.write'],
      }),
    ],
  });
  const as = (u: string) => (r: request.Test) => r.set('Authorization', mockCredentials.user.header(u));
  // Nothing is shipped pre-loaded: seed what an operator would add (rate book, scenarios, one FOCUS import).
  const book = JSON.parse(readTestData('ratebook.json'));
  expect((await as('user:default/writer')(request(server).put(`${API}/ratebooks/${book.id}`).send(book))).status).toBe(200);
  for (const sc of JSON.parse(readTestData('scenarios.json')).scenarios) {
    expect((await as('user:default/writer')(request(server).post(`${API}/scenarios`).send(sc))).status).toBe(201);
  }
  const imp = await as('user:default/finance')(request(server).post(`${API}/billing/imports?filename=focus.csv`).set('Content-Type', 'text/csv').send(readTestData('focus.csv')));
  expect(imp.status).toBe(201);
  return { server, as };
}

/** Seeded scenarios get server-side ids; tests find them by name. */
const scenarioNamed = (items: any[], name: RegExp) => items.find((s: any) => name.test(s.name));

const focusCsv = () => readTestData('focus.csv');
const totalsByProject = (body: any) => Object.fromEntries(body.report.groups.map((g: any) => [g.key, g.totals[0].amount]));

describe('commercial routes', () => {
  stubNebiusApi();
  useTestClock();

  it('uses an authorized project for contract footprint pricing and refuses other regions without calculator calls', async () => {
    const { server, as } = await backend({ access: { roles: [
      { name: 'operators', principals: ['user:default/finance', 'user:default/writer'], projects: ['*'], permissions: ['*'] },
      { name: 'lab', principals: ['user:default/alice'], projects: ['project-e00mocklab'], permissions: ['nebius.commercial.scenario.read', 'nebius.commercial.rate.read'] },
    ] } });
    const footprint = JSON.parse(readTestData('scenarios.json')).scenarios[0].footprints.expected;
    const allowed = await as('user:default/alice')(request(server).post(`${API}/pricing/footprint`).send({ footprint, region: 'uk-south1' }));
    expect(allowed.status).toBe(200);
    expect(allowed.body.value).toMatchObject({ projectId: 'project-e00mocklab', offer: 'contract' });
    const fetch = global.fetch as jest.Mock;
    fetch.mockClear();
    const denied = await as('user:default/alice')(request(server).post(`${API}/pricing/footprint`).send({ footprint, region: 'eu-west1' }));
    expect(denied.status).toBe(200);
    expect(denied.body).toMatchObject({ value: null, unavailableReason: expect.stringMatching(/scope|authorized/i) });
    expect(fetch.mock.calls.filter(([url]) => String(url).includes('/billing/v1/calculator/'))).toEqual([]);
  });

  it.each(['project-e00mocklab', '*'])('live scenarios and quotes select the rate-authorized project with primary scope %s', async primaryProject => {
    const { server, as } = await backend({ access: { roles: [
      { name: 'finance', principals: ['user:default/finance'], projects: ['*'], permissions: ['*'] },
      { name: 'writer', principals: ['user:default/writer'], projects: ['project-e00mocklab'], permissions: ['*'] },
      { name: 'scenarios', principals: ['user:default/alice'], projects: [primaryProject], permissions: ['nebius.commercial.scenario.read'] },
      { name: 'prices', principals: ['user:default/alice'], projects: ['project-e00mocklab'], permissions: ['nebius.commercial.rate.read'] },
    ] } });
    const original = JSON.parse(readTestData('scenarios.json')).scenarios[0];
    const live = { ...original, id: undefined, region: 'uk-south1', rateBookId: 'nebius-list-price' };
    const price = await as('user:default/alice')(request(server).post(`${API}/pricing/footprint`).send({ footprint: live.footprints.expected, region: live.region }));
    expect(price.status).toBe(200);
    expect(price.body.value.projectId).toBe('project-e00mocklab');
    const estimate = await as('user:default/alice')(request(server).post(`${API}/estimate`).send(live));
    expect(estimate.status).toBe(200);
    expect(JSON.stringify(estimate.body)).toContain('nip-lab');
    expect(JSON.stringify(estimate.body)).not.toContain('nip-sandbox');
    const saved = await as('user:default/writer')(request(server).post(`${API}/scenarios`).send(live));
    expect(saved.status).toBe(201);
    const quote = await as('user:default/alice')(request(server).get(`${API}/scenarios/${saved.body.id}/quote.json`));
    expect(quote.status).toBe(200);
    expect(JSON.stringify(quote.body)).toContain('nip-lab');
    expect(JSON.stringify(quote.body)).not.toContain('nip-sandbox');
    // Stored rate books keep the same permission checks without invoking the calculator.
    expect((await as('user:default/alice')(request(server).post(`${API}/estimate`).send(original))).status).toBe(200);
    const fetch = global.fetch as jest.Mock;
    fetch.mockClear();
    const denied = await as('user:default/alice')(request(server).post(`${API}/estimate`).send({ ...live, region: 'eu-west1' }));
    expect(denied.status).toBe(409);
    expect(JSON.stringify(denied.body)).not.toContain('legacy-research');
    expect(fetch.mock.calls.filter(([url]) => String(url).includes('/billing/v1/calculator/'))).toEqual([]);
  });

  it('list-price book previews keep project names and calculator calls inside the writer scope', async () => {
    const { server, as } = await backend({ access: { roles: [
      { name: 'finance', principals: ['user:default/finance'], projects: ['*'], permissions: ['*'] },
      { name: 'writer', principals: ['user:default/writer'], projects: ['project-e00mocklab'], permissions: ['*'] },
    ] } });
    const preview = (region: string) => as('user:default/writer')(request(server).post(`${API}/ratebooks/from-list-prices`).send({ id: 'scoped-list', name: 'Scoped list', regions: [region], platforms: ['gpu-b300-sxm'] }));
    const allowed = await preview('uk-south1');
    expect(allowed.status).toBe(200);
    expect(JSON.stringify(allowed.body)).toContain('nip-lab');
    const fetch = global.fetch as jest.Mock;
    fetch.mockClear();
    const denied = await preview('eu-west1');
    expect(denied.status).toBe(200);
    expect(denied.body.book.entries).toEqual([]);
    expect(denied.body.skipped).toEqual([expect.stringMatching(/scope|authorized/i)]);
    expect(JSON.stringify(denied.body)).not.toContain('legacy-research');
    expect(fetch.mock.calls.filter(([url]) => String(url).includes('/billing/v1/calculator/'))).toEqual([]);
  });

  it('shares the calculator burst limit with live scenario estimates and quotes while stored prices remain available', async () => {
    const { server, as } = await backend();
    const scenarios = (await as('user:default/finance')(request(server).get(`${API}/scenarios`))).body.items;
    const stored = scenarioNamed(scenarios, /^Training capacity/);
    const live = { ...stored, id: undefined, name: 'Live price limit regression', rateBookId: 'nebius-list-price' };
    const saved = await as('user:default/writer')(request(server).post(`${API}/scenarios`).send(live));
    expect(saved.status).toBe(201);
    for (let i = 0; i < 30; i++) {
      expect((await as('user:default/finance')(request(server).get(`${API}/runrate/live`))).status).toBe(200);
    }
    const fetch = global.fetch as jest.Mock;
    fetch.mockClear();
    const estimate = await as('user:default/finance')(request(server).post(`${API}/estimate`).send(live));
    expect(estimate.status).toBe(429);
    expect(Number(estimate.headers['retry-after'])).toBeGreaterThan(0);
    for (const format of ['json', 'csv']) {
      const quote = await as('user:default/finance')(request(server).get(`${API}/scenarios/${saved.body.id}/quote.${format}`));
      expect(quote.status).toBe(429);
      expect(Number(quote.headers['retry-after'])).toBeGreaterThan(0);
    }
    expect(fetch.mock.calls.filter(([url]) => String(url).includes('/billing/v1/calculator/'))).toEqual([]);
    expect((await as('user:default/finance')(request(server).post(`${API}/estimate`).send(stored))).status).toBe(200);
    expect((await as('user:default/finance')(request(server).get(`${API}/scenarios/${stored.id}/quote.json`))).status).toBe(200);
  });

  it('reports billed cost per currency with an import and health; budgets live on Budgets & credits only', async () => {
    const { server, as } = await backend();
    const r = await as('user:default/finance')(request(server).get(`${API}/billing/summary?metric=BilledCost&dimension=project`));
    expect(r.status).toBe(200);
    expect(r.body.report.totals).toEqual([{ amount: '571.3244', currency: 'XTS' }]);
    expect(r.body.health.lagHours).toBe(30);
    expect(r.body.budgets).toBeUndefined();
  });

  it('dates the export by its last exported hour, the same on Costs, Overview and Budgets, also for a narrowed range', async () => {
    const { server, as } = await backend();
    const all = await as('user:default/finance')(request(server).get(`${API}/billing/summary`));
    const through = all.body.health.exportedThrough;
    expect(Date.parse(through)).toBeLessThanOrEqual(Date.parse('2026-10-10T12:00:00Z')); // never in the future
    expect(all.body.health.lagHours).toBe(Math.floor((Date.parse('2026-10-10T12:00:00Z') - Date.parse(through)) / 3_600_000));
    const day = await as('user:default/finance')(request(server).get(`${API}/billing/summary?from=2026-10-01&to=2026-10-02`));
    expect(day.body.health.exportedThrough).toBe(through); // freshness describes the export as a whole
    const budgets = await as('user:default/finance')(request(server).get(`${API}/budgets`));
    expect(budgets.body.summary.exportThrough).toBe(through);
  });

  it('scopes billing rows by project server-side', async () => {
    const { server, as } = await backend();
    const r = await as('user:default/alice')(request(server).get(`${API}/billing/summary?dimension=project`));
    expect(r.body.report.groups.map((g: any) => g.key)).toEqual(['project-e00mocksandbox']);
    // Tax rows carry no project: invisible to a project-scoped caller.
    expect(r.body.report.rowsByCategory.Tax).toBeUndefined();
  });

  it('filters the period, region and service in the query', async () => {
    const { server, as } = await backend();
    const all = await as('user:default/finance')(request(server).get(`${API}/billing/summary?dimension=day`));
    const firstDay = all.body.report.groups[0].key;
    const one = await as('user:default/finance')(request(server).get(`${API}/billing/summary?dimension=day&from=${firstDay}&to=${firstDay}T23:59:59Z`));
    expect(one.body.report.groups.map((g: any) => g.key)).toEqual([firstDay]);
    // The daily chart and the reporting period follow the selected range too.
    expect(one.body.daily.groups.map((g: any) => g.key)).toEqual([firstDay]);
    expect(one.body.health.earliestChargePeriodStart.slice(0, 10)).toBe(firstDay);
    expect(Date.parse(one.body.health.latestChargePeriodEnd)).toBeLessThanOrEqual(Date.parse(`${firstDay}T00:00:00Z`) + 86_400_000);
    expect(Date.parse(one.body.health.latestChargePeriodEnd)).toBeLessThan(Date.parse(all.body.health.latestChargePeriodEnd));
    // Lag still describes the export as a whole.
    expect(one.body.health.lagHours).toBe(all.body.health.lagHours);
    const none = await as('user:default/finance')(request(server).get(`${API}/billing/summary?service=no-such-service`));
    expect(none.body.report.groups).toEqual([]);
  });

  it('a valid range without rows still describes the export: lag, coverage, and how many rows exist outside the range (walkthrough 3)', async () => {
    const { server, as } = await backend();
    const all = await as('user:default/finance')(request(server).get(`${API}/billing/summary`));
    const empty = await as('user:default/finance')(request(server).get(`${API}/billing/summary?from=2025-01-01&to=2025-01-02`));
    expect(empty.status).toBe(200);
    expect(empty.body.health.rows).toBe(0);
    expect(empty.body.rowsAnyRange).toBe(all.body.health.rows);
    expect(empty.body.rowsAnyRange).toBeGreaterThan(0);
    expect(empty.body.health.exportedThrough).toBe(all.body.health.exportedThrough);
    expect(empty.body.health.coverage).toEqual(all.body.health.coverage);
    expect(all.body.health.coverage.hoursWithUsage).toBeGreaterThan(0);
    expect(all.body.health.missingHours).toBeUndefined();
  });

  it('a project or region filter never turns that selection\'s last usage into the export lag (G1.3)', async () => {
    const { server, as } = await backend();
    // The export moved on (a later hour of another project); the sandbox project has been idle since 2026-10-09 06:00.
    const [header, ...rows] = focusCsv().trimEnd().split('\n');
    const lab = rows.find(l => l.includes(',project-e00mocklab,'))!.replace(/2026-10-06T12:00:00Z,2026-10-06T13:00:00Z/, '2026-10-10T09:00:00Z,2026-10-10T10:00:00Z');
    expect((await as('user:default/finance')(request(server).post(`${API}/billing/imports?filename=later.csv`).set('Content-Type', 'text/csv').send([header, lab].join('\n')))).status).toBe(201);
    const all = await as('user:default/finance')(request(server).get(`${API}/billing/summary`));
    expect(all.body.health.exportedThrough).toBe('2026-10-10T10:00:00.000Z');
    expect(all.body.health.lagHours).toBe(2);
    expect(all.body.selectionLastUsage).toBeUndefined();
    for (const q of ['project=project-e00mocksandbox', 'region=eu-west1', 'project=project-e00mocksandbox&from=2026-10-07&to=2026-10-08']) {
      const one = await as('user:default/finance')(request(server).get(`${API}/billing/summary?${q}`));
      expect([q, one.body.health.exportedThrough, one.body.health.lagHours]).toEqual([q, all.body.health.exportedThrough, 2]);
      expect(one.body.health.coverage).toEqual(all.body.health.coverage);
    }
    const sandbox = await as('user:default/finance')(request(server).get(`${API}/billing/summary?project=project-e00mocksandbox`));
    expect(sandbox.body.selectionLastUsage).toBe('2026-10-09T06:00:00.000Z');
  });

  it('a project without billing rows is not an empty export: the rows imported for the others are counted (G4.1)', async () => {
    const { server, as } = await backend();
    const all = await as('user:default/finance')(request(server).get(`${API}/billing/summary`));
    const none = await as('user:default/finance')(request(server).get(`${API}/billing/summary?project=project-e00mocknorows`));
    expect(none.body.health.rows).toBe(0);
    expect(none.body.rowsAnyRange).toBe(0);
    expect(none.body.importedRows).toBe(all.body.health.rows);
    expect(none.body.importedRows).toBeGreaterThan(0);
    // A caller restricted to one project counts its own rows only.
    const alice = await as('user:default/alice')(request(server).get(`${API}/billing/summary`));
    const aliceNone = await as('user:default/alice')(request(server).get(`${API}/billing/summary?region=no-region1`));
    expect(aliceNone.body.importedRows).toBe(alice.body.health.rows);
    expect(aliceNone.body.importedRows).toBeLessThan(all.body.health.rows);
  });

  it('the reporting period ends with the selection\'s and range\'s last hour; freshness stays the whole export\'s (G4.2)', async () => {
    const { server, as } = await backend();
    const all = await as('user:default/finance')(request(server).get(`${API}/billing/summary`));
    expect(all.body.periodThrough).toBe(all.body.health.exportedThrough);
    const ranged = await as('user:default/finance')(request(server).get(`${API}/billing/summary?from=2026-10-07&to=2026-10-08`));
    expect(ranged.body.health.exportedThrough).toBe(all.body.health.exportedThrough); // G1.3: lag describes the export
    expect(Date.parse(ranged.body.periodThrough)).toBeLessThanOrEqual(Date.parse('2026-10-08T00:00:00Z'));
    expect(Date.parse(ranged.body.periodThrough)).toBeGreaterThan(Date.parse('2026-10-07T00:00:00Z'));
    const empty = await as('user:default/finance')(request(server).get(`${API}/billing/summary?from=2025-01-01&to=2025-01-02`));
    expect(empty.body.periodThrough).toBeUndefined();
  });

  it('a month-long row (tax) is not drawn on the first day of the month: the daily axis holds per-hour rows only (G4.10)', async () => {
    const { server, as } = await backend();
    const [header] = focusCsv().trimEnd().split('\n');
    const monthTax = 'contract-e00mocktest,Test contract (invented),XTS,2026-10-01T00:00:00Z,2026-11-01T00:00:00Z,2026-10-01T00:00:00Z,2026-11-01T00:00:00Z,Tax,,VAT,,,,,,,,,,,,,,,,,,,0.00,0.00,Nebius,,,,,';
    expect((await as('user:default/finance')(request(server).post(`${API}/billing/imports?filename=tax.csv`).set('Content-Type', 'text/csv').send([header, monthTax].join('\n')))).status).toBe(201);
    const r = await as('user:default/finance')(request(server).get(`${API}/billing/summary`));
    expect(r.body.daily.groups.map((g: any) => g.key)).not.toContain('2026-10-01');
    expect(r.body.daily.groups[0].key).toBe('2026-10-06');
    expect(r.body.dailyExcluded).toEqual({ rows: 1, totals: [{ amount: '0', currency: 'XTS' }], categories: ['Tax'] });
    // The totals still hold it.
    expect(r.body.report.rowsByCategory.Tax).toBe(2);
  });

  it('refuses an inverted date range with a reason', async () => {
    const { server, as } = await backend();
    const r = await as('user:default/finance')(request(server).get(`${API}/billing/summary?from=2026-10-20&to=2026-10-01`));
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/"to" must be after "from"/);
  });

  it('reports the state of the export pull, so an empty page can say what it waits for', async () => {
    const { server, as } = await backend();
    const r = await as('user:default/finance')(request(server).get(`${API}/billing/summary`));
    expect(r.body.exportPull).toMatchObject({ state: expect.any(String) });
    // #12: no export file has arrived through the pull here, so no next-file estimate is made up.
    expect(r.body.exportPull.nextFile).toBeUndefined();
  });

  it('gates commercial data by dedicated permissions', async () => {
    const { server, as } = await backend();
    expect((await as('user:default/engineer')(request(server).get(`${API}/billing/summary`))).status).toBe(403);
    expect((await as('user:default/engineer')(request(server).get(`${API}/ratebooks`))).status).toBe(403);
    const scenarios = await as('user:default/engineer')(request(server).get(`${API}/scenarios`));
    expect(scenarios.status).toBe(200);
    const est = await as('user:default/engineer')(request(server).post(`${API}/estimate`).send(scenarios.body.items[0]));
    expect(est.status).toBe(403); // estimating reads rates
    const put = await as('user:default/finance')(request(server).put(`${API}/ratebooks/test-xts`).send({}));
    expect(put.status).toBe(403);
  });

  it('re-importing the same export does not double count', async () => {
    const { server, as } = await backend();
    const imp = await as('user:default/finance')(request(server).post(`${API}/billing/imports?filename=again.csv`).set('Content-Type', 'text/csv').send(focusCsv()));
    expect(imp.status).toBe(201);
    expect(imp.body.summary.supersededRows).toBe(imp.body.summary.accepted);
    const r = await as('user:default/finance')(request(server).get(`${API}/billing/summary`));
    expect(r.body.report.totals).toEqual([{ amount: '571.3244', currency: 'XTS' }]);
    // Superseded rows are deleted: only the active rows stay, from the newest import; both imports stay listed.
    expect(r.body.health.imports).toBe(1);
    expect(r.body.health.rows).toBe(r.body.health.activeRows);
    expect((await as('user:default/finance')(request(server).get(`${API}/billing/imports`))).body.items.map((i: any) => i.filename).sort()).toEqual(['again.csv', 'focus.csv']);
  });

  it('a project-scoped import supersedes only that project', async () => {
    const { server, as } = await backend();
    const before = await as('user:default/finance')(request(server).get(`${API}/billing/summary?dimension=project`));
    const [header, ...rows] = focusCsv().trimEnd().split('\n');
    const sandboxOnly = [header, ...rows.filter(l => l.includes(',project-e00mocksandbox,'))].join('\n');
    const imp = await as('user:default/alice')(request(server).post(`${API}/billing/imports?filename=sandbox.csv`).set('Content-Type', 'text/csv').send(sandboxOnly));
    expect(imp.status).toBe(201);
    expect(imp.body.summary.supersededRows).toBe(imp.body.summary.accepted);
    const after = await as('user:default/finance')(request(server).get(`${API}/billing/summary?dimension=project`));
    expect(totalsByProject(after.body)).toEqual(totalsByProject(before.body));
    expect(after.body.health.rows).toBe(after.body.health.activeRows);
    expect(after.body.health.rows).toBe(before.body.health.rows);
  });

  it('a project-scoped importer cannot supersede another project through x_ContainerId (x_ProjectId and x_ContainerId must agree)', async () => {
    const { server, as } = await backend();
    const before = await as('user:default/finance')(request(server).get(`${API}/billing/summary?dimension=project`));
    const [header, ...rows] = focusCsv().trimEnd().split('\n');
    const staging = rows.find(l => l.includes(',project-e00mockstaging,'))!;
    // The proof of concept: x_ProjectId names alice's project (the scope check passes), x_ContainerId names staging.
    const csv = [`${header},x_ProjectId`, `${staging},project-e00mocksandbox`].join('\n');
    const imp = await as('user:default/alice')(request(server).post(`${API}/billing/imports?filename=poc.csv`).set('Content-Type', 'text/csv').send(csv));
    expect(imp.status).toBe(201);
    expect(imp.body.summary).toMatchObject({ accepted: 0, rejected: 1, supersededRows: 0 });
    expect(imp.body.summary.errors[0].message).toMatch(/x_ProjectId project-e00mocksandbox and x_ContainerId project-e00mockstaging disagree/);
    const after = await as('user:default/finance')(request(server).get(`${API}/billing/summary?dimension=project`));
    expect(totalsByProject(after.body)).toEqual(totalsByProject(before.body));
    // With x_ProjectId alone the row is attributed to (and supersedes the hour of) staging: refused for alice.
    const projectOnly = [`${header},x_ProjectId`, `${staging.replace(',project-e00mockstaging,', ',,')},project-e00mockstaging`].join('\n');
    expect((await as('user:default/alice')(request(server).post(`${API}/billing/imports`).set('Content-Type', 'text/csv').send(projectOnly))).status).toBe(403);
  });

  it('refuses imports with rows outside the caller scope and non-FOCUS files', async () => {
    const { server, as } = await backend();
    const out = await as('user:default/alice')(request(server).post(`${API}/billing/imports`).set('Content-Type', 'text/csv').send(focusCsv()));
    expect(out.status).toBe(403);
    const bad = await as('user:default/finance')(request(server).post(`${API}/billing/imports`).set('Content-Type', 'text/csv').send('a,b\n1,2\n'));
    expect(bad.status).toBe(400);
    const name = await as('user:default/finance')(request(server).post(`${API}/billing/imports?filename=../../x.csv`).set('Content-Type', 'text/csv').send(focusCsv()));
    expect(name.status).toBe(400);
  });

  it('bounds imports: authorization before the body, column cap, and the import list follows the scope', async () => {
    const { server, as } = await backend();
    const denied = await as('user:default/engineer')(request(server).post(`${API}/billing/imports`).set('Content-Type', 'text/csv').send(focusCsv()));
    expect(denied.status).toBe(403);
    const wide = `${Array.from({ length: 600 }, (_, i) => `c${i}`).join(',')}\n`;
    const tooWide = await as('user:default/finance')(request(server).post(`${API}/billing/imports`).set('Content-Type', 'text/csv').send(wide));
    expect(tooWide.status).toBe(400);
    expect(tooWide.body.error.message).toMatch(/columns/);
    const [header, ...rows] = focusCsv().trimEnd().split('\n');
    const stagingOnly = [header, ...rows.filter(r => r.includes('project-e00mockstaging'))].join('\n');
    const staging = await as('user:default/finance')(request(server).post(`${API}/billing/imports?filename=staging.csv`).set('Content-Type', 'text/csv').send(stagingOnly));
    expect(staging.status).toBe(201);
    const all = await as('user:default/finance')(request(server).get(`${API}/billing/imports`));
    const scoped = await as('user:default/alice')(request(server).get(`${API}/billing/imports`));
    expect(all.body.items.map((i: any) => i.filename)).toContain('staging.csv');
    expect(scoped.body.items.map((i: any) => i.filename)).not.toContain('staging.csv');
    expect(scoped.body.items.length).toBeGreaterThan(0);
  });

  it('validates ids in URLs', async () => {
    const { server, as } = await backend();
    const bad = await as('user:default/finance')(request(server).get(`${API}/scenarios/${encodeURIComponent('x".csv')}/quote.csv`));
    expect(bad.status).toBe(400);
    const book = await as('user:default/finance')(request(server).get(`${API}/ratebooks/${encodeURIComponent('../x')}`));
    expect(book.status).toBe(400);
  });

  it('estimates scenarios with the draft label on the portal clock and exports a quote CSV', async () => {
    const { server, as } = await backend();
    const list = await as('user:default/finance')(request(server).get(`${API}/scenarios`));
    const training = scenarioNamed(list.body.items, /^Training capacity/);
    const est = await as('user:default/finance')(request(server).post(`${API}/estimate`).send(training));
    expect(est.status).toBe(200);
    expect(est.body.label).toBe('Draft estimate — not a provider offer or capacity guarantee.');
    expect(est.body.sellingPrice.marginPercent).toBe('18');
    expect(est.body.generatedAt).toBe('2026-10-10T12:00:00.000Z');
    expect(est.body.validUntil).toBe('2026-10-24');
    const missing = await as('user:default/finance')(request(server).post(`${API}/estimate`).send(scenarioNamed(list.body.items, /^B300 reserved/)));
    expect(missing.body.coverage.issues.some((i: any) => i.component === 'gpu' && i.status === 'missing-rate')).toBe(true);
    const csv = await as('user:default/finance')(request(server).get(`${API}/scenarios/${training.id}/quote.csv`));
    expect(csv.text.startsWith('# Draft estimate')).toBe(true);
  });

  it('quote.json carries no total for a footprint with an unpriced compute line, only its headline (W1-P9, #50)', async () => {
    const { server, as } = await backend();
    const list = await as('user:default/finance')(request(server).get(`${API}/scenarios`));
    const b300 = scenarioNamed(list.body.items, /^B300 reserved/);
    const q = await as('user:default/finance')(request(server).get(`${API}/scenarios/${b300.id}/quote.json`));
    expect(q.status).toBe(200);
    const expected = q.body.footprints.find((f: any) => f.footprint === 'expected');
    expect(expected.headline.state).toBe('incomplete');
    expect(expected.headline.text).toMatch(/^Incomplete: \d+ lines? unpriced$/);
    expect(expected.totalsWithheld).toBe(expected.headline.text);
    expect(expected.hourly).toBeNull();
    expect(expected.runPeriod).toBeNull();
    expect(expected.monthly).toBeNull();
    expect(q.body.sensitivity.every((s: any) => s.runPeriod.expected === null)).toBe(true);
    expect(expected.lines.some((l: any) => l.component === 'gpu' && l.status === 'missing-rate')).toBe(true);
    // A scenario with every compute line priced keeps its totals.
    const training = scenarioNamed(list.body.items, /^Training capacity/);
    const t = await as('user:default/finance')(request(server).get(`${API}/scenarios/${training.id}/quote.json`));
    const te = t.body.footprints.find((f: any) => f.footprint === 'expected');
    expect(te.headline.state).not.toBe('incomplete');
    expect(te.runPeriod.amount).toEqual(expect.any(String));
    expect(t.body.sellingPrice).toBeDefined();
  });

  it('validates rate books before storing them', async () => {
    const { server, as } = await backend();
    const book = (await as('user:default/writer')(request(server).get(`${API}/ratebooks/test-xts`))).body;
    const bad = { ...book, entries: [{ ...book.entries[0], price: '1e9' }] };
    expect((await as('user:default/writer')(request(server).put(`${API}/ratebooks/test-xts`).send(bad))).status).toBe(400);
    const ok = await as('user:default/writer')(request(server).put(`${API}/ratebooks/test-xts`).send(book));
    expect(ok.status).toBe(200);
  });

  it('keeps the documented 2 MB JSON limit on commercial routes (operate and budgets keep 64 KB on their own)', async () => {
    const { server, as } = await backend();
    const book = (await as('user:default/writer')(request(server).get(`${API}/ratebooks/test-xts`))).body;
    const big = { ...book, padding: 'x'.repeat(100 * 1024) };
    expect(JSON.stringify(big).length).toBeGreaterThan(100 * 1024);
    const put = await as('user:default/writer')(request(server).put(`${API}/ratebooks/test-xts`).send(big));
    expect(put.status).toBe(200);
    const tooBig = await as('user:default/writer')(request(server).put(`${API}/ratebooks/test-xts`).send({ ...book, padding: 'x'.repeat(2 * 1024 * 1024 + 1) }));
    expect(tooBig.status).toBe(413);
  });

  it('deletes a rate book (rate.write, audited), but not one a scenario prices with or the configured default (G4.5)', async () => {
    const { server, as } = await backend();
    const book = (await as('user:default/writer')(request(server).get(`${API}/ratebooks/test-xts`))).body;
    expect((await as('user:default/writer')(request(server).put(`${API}/ratebooks/aaa-whatif`).send({ ...book, id: 'aaa-whatif', name: 'What-if' }))).status).toBe(200);
    expect((await as('user:default/finance')(request(server).delete(`${API}/ratebooks/aaa-whatif`))).status).toBe(403);
    const used = await as('user:default/writer')(request(server).delete(`${API}/ratebooks/test-xts`));
    expect(used.status).toBe(409);
    expect(used.body.error.message).toMatch(/scenario.*Training capacity/);
    expect((await as('user:default/writer')(request(server).delete(`${API}/ratebooks/aaa-whatif`))).status).toBe(204);
    expect((await as('user:default/writer')(request(server).get(`${API}/ratebooks/aaa-whatif`))).status).toBe(404);
    expect((await as('user:default/writer')(request(server).delete(`${API}/ratebooks/aaa-whatif`))).status).toBe(404);
    const configured = await backend({ commercial: { defaultRateBook: 'test-xts' } });
    for (const sc of (await configured.as('user:default/writer')(request(configured.server).get(`${API}/scenarios`))).body.items) {
      await configured.as('user:default/writer')(request(configured.server).delete(`${API}/scenarios/${sc.id}`));
    }
    const dflt = await configured.as('user:default/writer')(request(configured.server).delete(`${API}/ratebooks/test-xts`));
    expect(dflt.status).toBe(409);
    expect(dflt.body.error.message).toMatch(/commercial\.defaultRateBook/);
  });

  it('says which rate book drives the run-rate and why: an imported what-if book never takes over silently (G4.5)', async () => {
    const { server, as } = await backend();
    const only = await as('user:default/finance')(request(server).get(`${API}/runrate`));
    expect(only.body.rateBookChoice).toMatchObject({ id: 'test-xts', how: 'only' });
    const book = (await as('user:default/writer')(request(server).get(`${API}/ratebooks/test-xts`))).body;
    await as('user:default/writer')(request(server).put(`${API}/ratebooks/aaa-whatif`).send({ ...book, id: 'aaa-whatif', name: 'What-if' }));
    const r = await as('user:default/finance')(request(server).get(`${API}/runrate`));
    expect(r.body.rateBookChoice).toMatchObject({ id: 'aaa-whatif', name: 'What-if', how: 'first-by-id' });
    expect(r.body.rateBookChoice.text).toMatch(/commercial\.defaultRateBook/);
    const list = await as('user:default/finance')(request(server).get(`${API}/ratebooks`));
    expect(list.body.runRateBook).toMatchObject({ id: 'aaa-whatif', how: 'first-by-id' });
    const asked = await as('user:default/finance')(request(server).get(`${API}/runrate?rateBookId=test-xts`));
    expect(asked.body.rateBookChoice).toMatchObject({ id: 'test-xts', how: 'requested' });
  });

  it('sets a portal default rate book stored in the database, archives and restores books, all audited (W1-P8)', async () => {
    const { server, as } = await backend();
    const w = as('user:default/writer');
    const book = (await w(request(server).get(`${API}/ratebooks/test-xts`))).body;
    await w(request(server).put(`${API}/ratebooks/aaa-whatif`).send({ ...book, id: 'aaa-whatif', name: 'What-if' }));
    // Two books, no default: the first by id, said so. A portal default replaces that guess.
    expect((await as('user:default/finance')(request(server).post(`${API}/ratebooks/test-xts/default`))).status).toBe(403);
    expect((await w(request(server).post(`${API}/ratebooks/test-xts/default`))).status).toBe(200);
    const run = await as('user:default/finance')(request(server).get(`${API}/runrate`));
    expect(run.body.rateBookChoice).toMatchObject({ id: 'test-xts', how: 'portal-default' });
    expect(run.body.rateBookChoice.text).toMatch(/Set as the portal default/);
    let list = (await w(request(server).get(`${API}/ratebooks`))).body;
    expect(list.items.map((b: any) => [b.id, b.isDefault, b.archived])).toEqual([['aaa-whatif', false, false], ['test-xts', true, false]]);
    // The portal default is not deleted or archived until it is unset.
    expect((await w(request(server).post(`${API}/ratebooks/test-xts/archive`).send({ archived: true }))).status).toBe(409);
    // A book is archived (kept, not offered as a default), and restored.
    expect((await w(request(server).post(`${API}/ratebooks/aaa-whatif/archive`).send({ archived: true }))).status).toBe(200);
    expect((await w(request(server).post(`${API}/ratebooks/aaa-whatif/default`))).status).toBe(409);
    list = (await w(request(server).get(`${API}/ratebooks`))).body;
    expect(list.items.find((b: any) => b.id === 'aaa-whatif')).toMatchObject({ archived: true });
    expect((await w(request(server).get(`${API}/ratebooks/aaa-whatif`))).status).toBe(200);
    // A re-import keeps the book's state.
    await w(request(server).put(`${API}/ratebooks/test-xts`).send(book));
    expect((await w(request(server).get(`${API}/ratebooks`))).body.items.find((b: any) => b.id === 'test-xts')).toMatchObject({ isDefault: true });
    // Unset the default: with the other book archived, test-xts is the only active one.
    expect((await w(request(server).delete(`${API}/ratebooks/test-xts/default`))).status).toBe(200);
    expect((await as('user:default/finance')(request(server).get(`${API}/runrate`))).body.rateBookChoice).toMatchObject({ id: 'test-xts', how: 'only' });
    expect((await w(request(server).post(`${API}/ratebooks/aaa-whatif/archive`).send({ archived: false }))).status).toBe(200);
    expect((await as('user:default/finance')(request(server).get(`${API}/runrate`))).body.rateBookChoice).toMatchObject({ id: 'aaa-whatif', how: 'first-by-id' });
  });

  it('with every rate book archived, the run-rate says so instead of "none imported"', async () => {
    const { server, as } = await backend();
    const w = as('user:default/writer');
    expect((await w(request(server).post(`${API}/ratebooks/test-xts/archive`).send({ archived: true }))).status).toBe(200);
    const r = await as('user:default/finance')(request(server).get(`${API}/runrate`));
    expect(r.body.value).toBeNull();
    expect(r.body.unavailableReason).toBe('Every rate book is archived: restore one on Commercial → Rate books (an archived book cannot be the portal default).');
    // The live list price prices the run-rate without a book: the user rate book is optional, not a gap to set up.
    expect(r.body.rateBookOptional).toBe(true);
  });

  it('builds a rate book from current list prices for a preview, offers a CSV template, and reserves the built-in id (W1-P7)', async () => {
    const { server, as } = await backend();
    const w = as('user:default/writer');
    const r = await w(request(server).post(`${API}/ratebooks/from-list-prices`).send({ id: 'list-today', name: 'List today', regions: ['eu-north1'], platforms: ['gpu-h100-sxm'] }));
    expect(r.status).toBe(200);
    // Previewed, not stored.
    expect((await w(request(server).get(`${API}/ratebooks/list-today`))).status).toBe(404);
    const gpu = r.body.book.entries.find((e: any) => e.preset === '1gpu-16vcpu-200gb' && e.capacityType === 'on-demand');
    // The stub prices 1gpu-16vcpu-200gb at 2.5 + 16 × 0.01 + 200 × 0.002 = 3.06 XTS / h.
    expect(gpu).toMatchObject({ component: 'gpu', price: '3.06', bundles: ['vcpu', 'ram'], source: expect.stringMatching(/^Nebius billing calculator \(list price\)/) });
    expect(r.body.book.entries.some((e: any) => e.component === 'disk-ssd')).toBe(true);
    expect(r.body.book).toMatchObject({ kind: 'public-list', classification: 'public' });
    // A region without a listed project is named, not priced elsewhere.
    const far = await w(request(server).post(`${API}/ratebooks/from-list-prices`).send({ id: 'list-far', name: 'Far', regions: ['eu-west2'] }));
    expect(far.body.skipped).toEqual([expect.stringMatching(/^eu-west2: no listed project in this region/)]);
    expect((await as('user:default/finance')(request(server).post(`${API}/ratebooks/from-list-prices`).send({ id: 'x-list', name: 'x', regions: ['eu-north1'] }))).status).toBe(403);
    const tpl = await as('user:default/finance')(request(server).get(`${API}/ratebooks/template.csv`));
    expect(tpl.status).toBe(200);
    expect(tpl.text.split('\n')[0]).toBe('id,region,service,platform,preset,component,quantity,per,capacity_type,price,effective_from,effective_to,source,bundles,note');
    expect((await w(request(server).put(`${API}/ratebooks/nebius-list-price`).send({ ...r.body.book, id: 'nebius-list-price' }))).status).toBe(400);
    expect((await w(request(server).get(`${API}/ratebooks`))).body.builtIn).toEqual({ id: 'nebius-list-price', name: 'Nebius list price (live calculator)', currency: 'XTS', available: true });
  });

  it('prices a scenario with no rate book at the live list price (the built-in source; W1-P6)', async () => {
    const { server, as } = await backend();
    const sc = JSON.parse(readTestData('scenarios.json')).scenarios[0];
    const e = await as('user:default/finance')(request(server).post(`${API}/estimate`).send({ ...sc, id: undefined, rateBookId: 'nebius-list-price', capacityType: 'on-demand' }));
    expect(e.status).toBe(200);
    expect(e.body.rateBook).toMatchObject({ id: 'nebius-list-price', name: 'Nebius list price (live calculator)', kind: 'public-list' });
    const gpuLine = e.body.footprints[1].lines.find((l: any) => l.component === 'gpu');
    expect(gpuLine).toMatchObject({ status: 'priced', hourlyUnitRate: '3.06' });
  });

  it('prices the run-rate with the configured default rate book, else the first by id', async () => {
    const addBook = async (as: Awaited<ReturnType<typeof backend>>['as'], server: any) => {
      const book = (await as('user:default/writer')(request(server).get(`${API}/ratebooks/test-xts`))).body;
      await as('user:default/writer')(request(server).put(`${API}/ratebooks/aaa-copy`).send({ ...book, id: 'aaa-copy', name: 'Copy' }));
    };
    const first = await backend();
    await addBook(first.as, first.server);
    const byId = await first.as('user:default/finance')(request(first.server).get(`${API}/runrate`));
    expect(byId.body.value.rateBook.id).toBe('aaa-copy');

    const configured = await backend({ commercial: { defaultRateBook: 'test-xts' } });
    await addBook(configured.as, configured.server);
    const r = await configured.as('user:default/finance')(request(configured.server).get(`${API}/runrate`));
    expect(r.body.value.rateBook.id).toBe('test-xts');
    expect(r.body.value.hourly.length).toBeGreaterThan(0);

    const missing = await backend({ commercial: { defaultRateBook: 'not-imported' } });
    const m = await missing.as('user:default/finance')(request(missing.server).get(`${API}/runrate`));
    expect(m.body).toMatchObject({ value: null, unavailableReason: expect.stringMatching(/not-imported/) });
    expect(m.body.rateBookOptional).toBeUndefined(); // a configured book that is missing is a configuration fault
  });
});
