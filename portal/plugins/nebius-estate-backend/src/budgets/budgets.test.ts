import { mockCredentials, mockServices, startTestBackend } from '@backstage/backend-test-utils';
import request from 'supertest';
import { BudgetsResponse } from '@internal/nebius-domain';
import { nebiusEstatePlugin } from '../plugin';
import { testDatabase, permissionsByUser, readTestData, stubNebiusApi, testConfig, useTestClock } from '../__testUtils__/testing';

const API = '/api/nebius-estate';
const READ = ['nebius.billing.read'];

async function backend(observerProjects?: string[]) {
  const { server } = await startTestBackend({
    features: [
      testDatabase(),
      nebiusEstatePlugin,
      mockServices.rootConfig.factory({
        data: testConfig({
          access: {
            roles: [
              { name: 'all', principals: ['user:default/owner', 'user:default/reader', 'user:default/nobody'], projects: ['*'], permissions: ['*'] },
              { name: 'sandbox', principals: ['user:default/alice', 'user:default/sandboxowner'], projects: ['project-e00mocksandbox'], permissions: ['*'] },
              { name: 'finance-sandbox', principals: ['user:default/mixed'], projects: ['project-e00mocksandbox'], permissions: [...READ, 'nebius.billing.budget.write'] },
              { name: 'observer', principals: ['user:default/mixed'], projects: observerProjects ?? ['project-e00mockstaging'], permissions: ['nebius.estate.read'] },
            ],
          },
        }),
      }),
      permissionsByUser({
        'user:default/owner': [...READ, 'nebius.billing.import', 'nebius.billing.budget.write', 'nebius.commercial.rate.read', 'nebius.estate.read'],
        'user:default/reader': READ,
        'user:default/alice': READ,
        'user:default/sandboxowner': [...READ, 'nebius.billing.budget.write'],
        'user:default/mixed': [...READ, 'nebius.billing.budget.write', 'nebius.estate.read'],
      }),
    ],
  });
  const as = (u: string) => (r: request.Test) => r.set('Authorization', mockCredentials.user.header(u));
  return { server, as };
}

const get = async (server: any, as: any, user = 'user:default/owner'): Promise<BudgetsResponse> => {
  const r = await as(user)(request(server).get(`${API}/budgets`));
  expect(r.status).toBe(200);
  return r.body;
};

describe('budgets & credits routes', () => {
  stubNebiusApi();
  useTestClock();

  it.each([['project-e00mockstaging'], ['*']])('binds mixed-role budget reads and writes to finance projects (%s)', async observerProject => {
    const { server, as } = await backend([observerProject]);
    const owner = as('user:default/owner');
    const mixed = as('user:default/mixed');
    const input = { name: 'Mixed role boundary', period: 'monthly', amount: '100', currency: 'XTS', scope: { projects: ['project-e00mockstaging'] } };
    const hidden = await owner(request(server).post(`${API}/budgets/budget`).send(input));
    expect(hidden.status).toBe(201);
    const allowed = await mixed(request(server).post(`${API}/budgets/budget`).send({ ...input, scope: { projects: ['project-e00mocksandbox'] } }));
    expect(allowed.status).toBe(201);
    const read = await mixed(request(server).get(`${API}/budgets`));
    expect(read.status).toBe(200);
    expect(read.body.budgets.map((b: { id: string }) => b.id)).toEqual([allowed.body.id]);
    expect(read.body.configBudgets.map((b: { id: string }) => b.id)).toEqual(['sandbox-run-481']);
    expect((await mixed(request(server).post(`${API}/budgets/preview`).send(input))).status).toBe(403);
    expect((await mixed(request(server).post(`${API}/budgets/budget`).send(input))).status).toBe(403);
    expect((await mixed(request(server).put(`${API}/budgets/budget/${hidden.body.id}`).send(input))).status).toBe(404);
    expect((await mixed(request(server).delete(`${API}/budgets/budget/${hidden.body.id}`))).status).toBe(404);
    expect((await mixed(request(server).post(`${API}/budgets/credit`).send({ name: 'account credit', provider: 'ai-cloud', amount: '1', appliedOn: '2026-10-01' }))).status).toBe(403);
  });

  it('starts empty: nothing is seeded', async () => {
    const { server, as } = await backend();
    const b = await get(server, as);
    expect(b).toMatchObject({ budgets: [], credits: [], entries: [], signals: [], canEdit: true, links: { billing: 'https://console.nebius.com/billing', tokenFactory: 'https://tokenfactory.nebius.com' } });
    expect((await get(server, as, 'user:default/reader')).canEdit).toBe(false);
  });

  it('shows the deprecated config budgets read-only on this page, scoped, and never stores them', async () => {
    const { server, as } = await backend();
    const b = await get(server, as);
    expect(b.budgets).toEqual([]); // not imported into the database
    expect(b.configBudgets.map(x => x.id)).toEqual(['sandbox-run-481', 'staging-monthly']);
    expect(b.configBudgets[0]).toMatchObject({ basis: 'BilledCost', amount: '1500', currency: 'XTS', period: '2026-10', state: 'no-data' });
    expect(b.configBudgetsNote).toMatch(/nebiusEstate\.budgets is deprecated/);
    // F1.8: the summary counts them, apart from the budgets entered here.
    expect(b.summary.budgets).toMatchObject({ total: 2, entered: 0, fromConfig: 2 });
    // A project-scoped reader sees only the config budgets of their projects.
    expect((await get(server, as, 'user:default/alice')).configBudgets.map(x => x.id)).toEqual(['sandbox-run-481']);
    // Measured against reported BilledCost once rows are imported.
    const csv = readTestData('focus.csv');
    expect((await as('user:default/owner')(request(server).post(`${API}/billing/imports?filename=focus.csv`).set('Content-Type', 'text/csv').send(csv))).status).toBe(201);
    expect((await get(server, as)).configBudgets[0]).toMatchObject({ state: 'under' });
    // One definition of spend (F1.2): a config budget and an entered one on the same project and month measure the
    // same figure, tax and credit rows left out (the fixture's sandbox credit of −5 XTS is not spend).
    const entered = await as('user:default/owner')(request(server).post(`${API}/budgets/budget`).send({ name: 'Sandbox', period: 'monthly', amount: '1500', currency: 'XTS', scope: { projects: ['project-e00mocksandbox'] } }));
    expect(entered.status).toBe(201);
    const after = await get(server, as);
    expect(after.configBudgets[0].reported).toBe('127.4796');
    expect(after.budgets.find(x => x.id === entered.body.id)!.spend.actual).toEqual({ amount: after.configBudgets[0].reported, currency: 'XTS' });
    // F1.7: a new budget defaults to the currency the spend is in.
    expect(after.summary.spendCurrency['ai-cloud']).toBe('XTS');
  });

  it('creates, edits and deletes budgets, credits and spend entries, stored with the user', async () => {
    const { server, as } = await backend();
    const owner = as('user:default/owner');
    const created = await owner(request(server).post(`${API}/budgets/budget`).send({ name: 'Sandbox monthly', period: 'monthly', amount: '1500', currency: 'XTS', scope: { projects: ['project-e00mocksandbox'] } }));
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ createdBy: 'user:default/owner', provider: 'ai-cloud', thresholds: { unit: 'percent', values: ['50', '80', '100'] } });
    const upd = await owner(request(server).put(`${API}/budgets/budget/${created.body.id}`).send({ ...created.body, amount: '2000' }));
    expect(upd.status).toBe(200);
    expect(upd.body.amount).toBe('2000');
    expect((await owner(request(server).post(`${API}/budgets/credit`).send({ name: 'Token Factory promo', provider: 'token-factory', amount: '25', appliedOn: '2026-10-09', expiresOn: '2026-10-20' }))).status).toBe(201);
    expect((await owner(request(server).post(`${API}/budgets/spend`).send({ provider: 'token-factory', date: '2026-10-09', amount: '1.5' }))).status).toBe(201);
    const b = await get(server, as);
    expect(b.budgets.map(x => x.amount)).toEqual(['2000']);
    expect(b.credits[0]).toMatchObject({ used: { total: { amount: '1.5' } }, remaining: { amount: '23.5' }, status: 'expiring', daysToExpiry: 10 });
    expect(b.signals.map(s => s.id)).toEqual([`credit:${b.credits[0].id}:expiry`]);
    expect((await owner(request(server).delete(`${API}/budgets/budget/${created.body.id}`))).status).toBe(204);
    expect((await owner(request(server).delete(`${API}/budgets/budget/${created.body.id}`))).status).toBe(404);
    expect((await get(server, as)).budgets).toEqual([]);
  });

  it('keeps one Token Factory spend entry per day: a second one for the same day is refused with the entry to replace (W1-P22)', async () => {
    const { server, as } = await backend();
    const owner = as('user:default/owner');
    const first = await owner(request(server).post(`${API}/budgets/spend`).send({ provider: 'token-factory', date: '2026-10-09', amount: '1.5' }));
    expect(first.status).toBe(201);
    const second = await owner(request(server).post(`${API}/budgets/spend`).send({ provider: 'token-factory', date: '2026-10-09', amount: '2' }));
    expect(second.status).toBe(409);
    expect(second.body.error.message).toBe(`A spend entry for 2026-10-09 exists (1.5 USD, id ${first.body.id}): replace it instead of adding a second one.`);
    // Moving another entry onto that day is refused the same way; replacing the entry itself is fine.
    const other = await owner(request(server).post(`${API}/budgets/spend`).send({ provider: 'token-factory', date: '2026-10-10', amount: '1' }));
    expect((await owner(request(server).put(`${API}/budgets/spend/${other.body.id}`).send({ provider: 'token-factory', date: '2026-10-09', amount: '1' }))).status).toBe(409);
    expect((await owner(request(server).put(`${API}/budgets/spend/${first.body.id}`).send({ provider: 'token-factory', date: '2026-10-09', amount: '2' }))).status).toBe(200);
    expect((await get(server, as)).entries.map(e => [e.date, e.amount])).toEqual([['2026-10-10', '1'], ['2026-10-09', '2']]);
  });

  it('two concurrent spend entries for the same day: one is stored, the other refused (W1-P22, a database constraint)', async () => {
    const { server, as } = await backend();
    const owner = as('user:default/owner');
    const post = (amount: string) => owner(request(server).post(`${API}/budgets/spend`).send({ provider: 'token-factory', date: '2026-10-08', amount }));
    const results = await Promise.all([post('1'), post('2'), post('3')]);
    expect(results.map(r => r.status).sort()).toEqual([201, 409, 409]);
    for (const r of results.filter(x => x.status === 409)) expect(r.body.error.message).toMatch(/^A spend entry for 2026-10-08 exists/);
    expect((await get(server, as)).entries.filter(e => e.date === '2026-10-08')).toHaveLength(1);
  });

  it('previews an unsaved budget against its scope while it is typed, without storing it (W1-P23)', async () => {
    const { server, as } = await backend();
    const owner = as('user:default/owner');
    expect((await owner(request(server).post(`${API}/billing/imports?filename=focus.csv`).set('Content-Type', 'text/csv').send(readTestData('focus.csv')))).status).toBe(201);
    const input = { name: 'Sandbox', period: 'monthly', amount: '1500', currency: 'XTS', scope: { projects: ['project-e00mocksandbox'] } };
    const p = await owner(request(server).post(`${API}/budgets/preview`).send(input));
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ spend: { actual: { amount: '127.4796', currency: 'XTS' } }, percent: 8.5, status: 'ok' });
    expect((await get(server, as)).budgets).toEqual([]);
    // Reading is enough (nothing is written); invalid input is a 400 with the reason; a scoped reader previews only their projects.
    expect((await as('user:default/reader')(request(server).post(`${API}/budgets/preview`).send(input))).status).toBe(200);
    expect((await owner(request(server).post(`${API}/budgets/preview`).send({ ...input, amount: '-1' }))).status).toBe(400);
    expect((await as('user:default/alice')(request(server).post(`${API}/budgets/preview`).send({ ...input, scope: { projects: ['project-e00mockstaging'] } }))).status).toBe(403);
  });

  it('validates input with the reason, and needs the write permission', async () => {
    const { server, as } = await backend();
    const bad = await as('user:default/owner')(request(server).post(`${API}/budgets/budget`).send({ name: 'x', period: 'weekly', amount: '-1' }));
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toMatch(/period/);
    expect(bad.body.error.message).toMatch(/amount/);
    expect((await as('user:default/owner')(request(server).post(`${API}/budgets/other`).send({}))).status).toBe(400);
    expect((await as('user:default/reader')(request(server).post(`${API}/budgets/credit`).send({ name: 'x', provider: 'ai-cloud', amount: '1', appliedOn: '2026-10-01' }))).status).toBe(403);
    expect((await as('user:default/nobody')(request(server).get(`${API}/budgets`))).status).toBe(403);
    expect((await as('user:default/owner')(request(server).put(`${API}/budgets/budget/not-a-uuid`).send({}))).status).toBe(400);
  });

  it('measures a budget against the imported FOCUS rows (actual, with freshness) and raises its threshold signals', async () => {
    const { server, as } = await backend();
    const owner = as('user:default/owner');
    expect((await owner(request(server).post(`${API}/billing/imports?filename=focus.csv`).set('Content-Type', 'text/csv').send(readTestData('focus.csv')))).status).toBe(201);
    const created = await owner(request(server).post(`${API}/budgets/budget`).send({ name: 'Account', period: 'monthly', amount: '100', currency: 'XTS' }));
    const b = await get(server, as);
    const v = b.budgets.find(x => x.id === created.body.id)!;
    const actual = v.spend.parts.find(p => p.kind === 'actual')!;
    expect(actual.source).toBe('focus-export');
    expect(actual.asOf).toBeTruthy();
    expect(Number(actual.amount.amount)).toBeGreaterThan(100);
    expect(v.status).toBe('over');
    expect(b.signals.map(s => s.kind)).toEqual(expect.arrayContaining(['budget-threshold', 'budget-over']));
    const signals = await owner(request(server).get(`${API}/budgets/signals`));
    expect(signals.body.items.map((s: any) => s.id)).toEqual(b.signals.map(s => s.id));
    expect(b.summary.monthToDate.find(p => p.source === 'focus-export')).toBeTruthy();
  });

  it('a budget write fires its alerts at once, and a delete resolves them with "budget deleted" without waiting for a sync (W1-P19)', async () => {
    const { server, as } = await backend();
    const owner = as('user:default/owner');
    expect((await owner(request(server).post(`${API}/billing/imports?filename=focus.csv`).set('Content-Type', 'text/csv').send(readTestData('focus.csv')))).status).toBe(201);
    const created = await owner(request(server).post(`${API}/budgets/budget`).send({ name: 'Tiny', period: 'monthly', amount: '1', currency: 'XTS' }));
    expect(created.status).toBe(201);
    const open = async () => ((await owner(request(server).get(`${API}/alerts?state=all`))).body.alerts as any[]).filter(a => a.labels?.signal?.startsWith(`budget:${created.body.id}:`));
    const fired = await open();
    expect(fired.length).toBeGreaterThan(0);
    expect(fired.every(a => a.state === 'firing')).toBe(true);
    expect((await owner(request(server).delete(`${API}/budgets/budget/${created.body.id}`))).status).toBe(204);
    const after = await open();
    expect(after.map(a => a.state)).toEqual(fired.map(() => 'resolved'));
    for (const a of after) expect((await owner(request(server).get(`${API}/alerts/${a.id}`))).body.alert.evidence).toMatch(/Resolved: budget deleted\.$/);
  });

  it('a Compute budget leaves managed PostgreSQL out of its live estimate; a budget without a service condition includes it', async () => {
    const { server, as } = await backend();
    const owner = as('user:default/owner');
    expect((await owner(request(server).post(`${API}/billing/imports?filename=focus.csv`).set('Content-Type', 'text/csv').send(readTestData('focus.csv')))).status).toBe(201);
    const scope = (services: string[]) => ({ projects: ['project-e00mockstaging'], regions: [], services, products: [] });
    const all = await owner(request(server).post(`${API}/budgets/budget`).send({ name: 'Staging', period: 'monthly', amount: '1000', currency: 'XTS', scope: scope([]) }));
    const compute = await owner(request(server).post(`${API}/budgets/budget`).send({ name: 'Staging compute', period: 'monthly', amount: '1000', currency: 'XTS', scope: scope(['Compute']) }));
    const b = await get(server, as);
    const hourly = (id: string) => {
      const e = b.budgets.find(x => x.id === id)!.spend.parts.find(p => p.kind === 'estimate');
      return Number(/^([\d.]+) XTS \/ h/.exec(e?.note ?? '')?.[1]);
    };
    // The stub's staging PostgreSQL cluster prices at 0.0912 XTS/h (2 hosts).
    expect(hourly(all.body.id) - hourly(compute.body.id)).toBeCloseTo(0.0912, 6);
  });

  it('a project-scoped reader sees only budgets inside their scope; credits, spend entries and account-wide budgets need every project', async () => {
    const { server, as } = await backend();
    const owner = as('user:default/owner');
    expect((await owner(request(server).post(`${API}/billing/imports?filename=focus.csv`).set('Content-Type', 'text/csv').send(readTestData('focus.csv')))).status).toBe(201);
    const mk = async (name: string, projects: string[]) =>
      (await owner(request(server).post(`${API}/budgets/budget`).send({ name, period: 'monthly', amount: '0.01', currency: 'XTS', scope: { projects } }))).body.id as string;
    const sandbox = await mk('Sandbox', ['project-e00mocksandbox']);
    const staging = await mk('Staging', ['project-e00mockstaging']);
    await mk('Both', ['project-e00mocksandbox', 'project-e00mockstaging']);
    await mk('Account', []);
    expect((await owner(request(server).post(`${API}/budgets/credit`).send({ name: 'Promo', provider: 'ai-cloud', amount: '25', appliedOn: '2026-10-01', expiresOn: '2026-10-12' }))).status).toBe(201);
    expect((await owner(request(server).post(`${API}/budgets/spend`).send({ provider: 'token-factory', date: '2026-10-09', amount: '1.5' }))).status).toBe(201);

    const all = await get(server, as);
    expect(all.budgets.map(b => b.name).sort()).toEqual(['Account', 'Both', 'Sandbox', 'Staging']);
    expect(all.credits).toHaveLength(1);
    expect(all.entries).toHaveLength(1);
    expect(all.signals.some(x => x.id.startsWith(`budget:${staging}:`))).toBe(true);

    const alice = await get(server, as, 'user:default/alice');
    expect(alice.budgets.map(b => b.id)).toEqual([sandbox]);
    expect(alice.credits).toEqual([]);
    expect(alice.entries).toEqual([]);
    expect(alice.signals.every(x => x.id.startsWith(`budget:${sandbox}:`))).toBe(true);
    expect(alice.signals.length).toBeGreaterThan(0);
    expect(JSON.stringify(alice)).not.toContain('project-e00mockstaging');
    // /budgets/signals follows the caller's scope too.
    const signals = await as('user:default/alice')(request(server).get(`${API}/budgets/signals`));
    expect(signals.body.items.map((x: any) => x.id)).toEqual(alice.signals.map(x => x.id));
    const ownerSignals = await owner(request(server).get(`${API}/budgets/signals`));
    expect(ownerSignals.body.items.map((x: any) => x.id)).toEqual(all.signals.map(x => x.id));
  });

  it('a project-scoped writer names only projects in scope; account-wide items need every project', async () => {
    const { server, as } = await backend();
    const owner = as('user:default/owner');
    const w = as('user:default/sandboxowner');
    const body = (projects: string[]) => ({ name: 'B', period: 'monthly', amount: '10', currency: 'XTS', scope: { projects } });
    const mine = await w(request(server).post(`${API}/budgets/budget`).send(body(['project-e00mocksandbox'])));
    expect(mine.status).toBe(201);
    const other = await w(request(server).post(`${API}/budgets/budget`).send(body(['project-e00mocksandbox', 'project-e00mockstaging'])));
    expect(other.status).toBe(403);
    expect(other.body.error.message).toMatch(/outside your scope/);
    const account = await w(request(server).post(`${API}/budgets/budget`).send(body([])));
    expect(account.status).toBe(403);
    expect(account.body.error.message).toMatch(/account-wide/);
    expect((await w(request(server).post(`${API}/budgets/credit`).send({ name: 'x', provider: 'ai-cloud', amount: '1', appliedOn: '2026-10-01' }))).status).toBe(403);
    expect((await w(request(server).post(`${API}/budgets/spend`).send({ provider: 'token-factory', date: '2026-10-09', amount: '1' }))).status).toBe(403);
    // Moving an own budget out of scope is refused; another project's budget is not found for them.
    expect((await w(request(server).put(`${API}/budgets/budget/${mine.body.id}`).send(body(['project-e00mockstaging'])))).status).toBe(403);
    const staging = await owner(request(server).post(`${API}/budgets/budget`).send(body(['project-e00mockstaging'])));
    expect((await w(request(server).put(`${API}/budgets/budget/${staging.body.id}`).send(body(['project-e00mocksandbox'])))).status).toBe(404);
    expect((await w(request(server).delete(`${API}/budgets/budget/${staging.body.id}`))).status).toBe(404);
    expect((await w(request(server).delete(`${API}/budgets/budget/${mine.body.id}`))).status).toBe(204);
    expect((await get(server, as)).budgets.map(b => b.id)).toEqual([staging.body.id]);
  });

  it('a project-scoped reader sees spend of their projects only, and is told so', async () => {
    const { server, as } = await backend();
    const b = await get(server, as, 'user:default/alice');
    expect(b.scopeNote).toMatch(/1 project/);
  });
});
