import knexFactory, { Knex } from 'knex';
import { resolve } from 'path';
import { normalizeFocusCsv } from '@internal/nebius-domain';
import { migrate } from '../database';
import { readTestData } from '../__testUtils__/testing';
import { CommercialStore } from './store';

// The migration is plain JS (knex runs it); its data step is exported for this test.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { reslotAndPrune } = require(resolve(__dirname, '../../migrations/20261011030000_billing_slot_by_project.js'));

const ALL = { all: true, projects: new Set<string>() };
const meta = (filename: string, importedAt: string) => ({ importedBy: 'user:default/finance', filename, importedAt });

describe('billing rows: bounded storage', () => {
  let db: Knex;
  beforeEach(async () => {
    db = knexFactory({ client: 'better-sqlite3', connection: ':memory:', useNullAsDefault: true });
    await migrate(db);
  });
  afterEach(() => db.destroy());

  it('lists when the newest export files arrived in the bucket, newest first, for the next-file estimate (#12)', async () => {
    const store = new CommercialStore(db);
    const row = (key: string, lastModified: string | null) => ({ object_key: key, etag: key, size: 1, last_modified: lastModified, status: 'imported', processed_at: '2026-10-12T22:00:00Z' });
    await db('nebius_billing_export_objects').insert([row('a.csv', '2026-10-12T19:16:00Z'), row('b.csv', '2026-10-12T21:16:00Z'), row('c.csv', null), row('d.csv', '2026-10-12T20:15:00Z')]);
    expect(await store.exportArrivals()).toEqual(['2026-10-12T21:16:00Z', '2026-10-12T20:15:00Z', '2026-10-12T19:16:00Z']);
  });

  it('deletes superseded rows in the import transaction and keeps every import with its summary', async () => {
    const store = new CommercialStore(db);
    const focus = normalizeFocusCsv(readTestData('focus.csv'));
    const first = await store.importRecords(meta('a.csv', '2026-10-10T10:00:00Z'), focus);
    const second = await store.importRecords(meta('b.csv', '2026-10-10T11:00:00Z'), focus);
    expect(second.summary).toMatchObject({ supersededRows: first.summary.accepted, supersededImports: [first.id] });
    // Only the active rows are stored: re-imports no longer grow the table.
    const [{ n }] = await db('nebius_billing_records').count({ n: '*' });
    expect(Number(n)).toBe(second.summary.accepted);
    expect(await db('nebius_billing_records').whereNotNull('superseded_by').first()).toBeUndefined();
    expect(await store.storedCounts({ scope: ALL })).toEqual({ rows: second.summary.accepted, imports: 1 });
    // The import list (summary, who and when) keeps both, also for a project-scoped reader of a fully superseded import.
    expect((await store.imports(ALL)).map(i => i.filename)).toEqual(['b.csv', 'a.csv']);
    const sandbox = { all: false, projects: new Set(['project-e00mocksandbox']) };
    expect((await store.imports(sandbox)).map(i => i.filename)).toEqual(['b.csv', 'a.csv']);
    expect(await store.imports({ all: false, projects: new Set(['project-e00mocknone']) })).toEqual([]);
  });

  it('migrates stored rows: drops superseded rows, re-derives slots from the attributed project, and settles slots that now collide', async () => {
    const store = new CommercialStore(db);
    const csv = (projectCol: string, container: string, cost: string) =>
      [
        'BillingAccountId,BillingCurrency,ChargePeriodStart,ChargePeriodEnd,ChargeCategory,BilledCost,x_ContainerId,x_ProjectId',
        `acct-e00mock,XTS,2026-10-09T10:00:00Z,2026-10-09T11:00:00Z,Usage,${cost},${container},${projectCol}`,
      ].join('\n');
    // An older import stored under the old slot rule (container ''), a newer one under the project: both active.
    const old = await store.importRecords(meta('old.csv', '2026-10-09T12:00:00Z'), normalizeFocusCsv(csv('project-e00mocksandbox', '', '1')));
    await db('nebius_billing_records').where({ import_id: old.id }).update({ slot: 'acct-e00mock\u001f\u001f2026-10-09T10:00:00.000Z' });
    await store.importRecords(meta('new.csv', '2026-10-09T13:00:00Z'), normalizeFocusCsv(csv('project-e00mocksandbox', 'project-e00mocksandbox', '2')));
    // A superseded row left by the old code.
    await db('nebius_billing_records').insert({ import_id: old.id, slot: 'x', container_id: 'project-e00mocksandbox', charge_period_start: '2026-10-01T00:00:00.000Z', region_id: '', service_name: '', superseded_by: 'gone', payload: '{}' });
    expect((await store.activeRecords({ scope: ALL })).map(r => r.costs.BilledCost).sort()).toEqual(['1', '2']); // double counted

    expect(await reslotAndPrune(db)).toEqual({ deleted: 1, reslotted: 1, collided: 1, imports: 0 });
    expect((await store.activeRecords({ scope: ALL })).map(r => r.costs.BilledCost)).toEqual(['2']);
    expect((await db('nebius_billing_records').select('slot')).map(r => r.slot)).toEqual(['acct-e00mock\u001fproject-e00mocksandbox\u001f2026-10-09T10:00:00.000Z']);
    // Idempotent.
    expect(await reslotAndPrune(db)).toEqual({ deleted: 0, reslotted: 0, collided: 0, imports: 0 });
  });

  it('fills the project list of imports stored before it was kept', async () => {
    const store = new CommercialStore(db);
    const imp = await store.importRecords(meta('a.csv', '2026-10-10T10:00:00Z'), normalizeFocusCsv(readTestData('focus.csv')));
    await db('nebius_billing_imports').where({ id: imp.id }).update({ projects: null });
    expect(await reslotAndPrune(db)).toMatchObject({ imports: 1 });
    expect((await store.imports({ all: false, projects: new Set(['project-e00mocklab']) })).map(i => i.id)).toEqual([imp.id]);
  });
});
