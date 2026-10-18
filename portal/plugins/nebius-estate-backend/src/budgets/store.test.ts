import knex, { Knex } from 'knex';
import { resolvePackagePath } from '@backstage/backend-plugin-api';
import { migrate } from '../database';
import { BudgetStore } from './store';

const TABLES = ['nebius_budgets', 'nebius_credits', 'nebius_spend_entries'];
const CLAIM = '20261012000000_budgets_claim_empty_tenant.js';
const TENANT = 'tenant-e00mocktest';
const credit = { name: 'Token Factory promo', provider: 'token-factory', amount: '25', currency: 'usd', appliedOn: '2026-10-01' };
const payload: Record<string, object> = {
  nebius_budgets: { name: 'Sandbox month', period: 'monthly', amount: '100', currency: 'xts', thresholds: [80, 100], scope: {} },
  nebius_credits: credit,
  nebius_spend_entries: { provider: 'token-factory', date: '2026-10-02', amount: '1', currency: 'usd' },
};

const sqlite = () => knex({ client: 'better-sqlite3', connection: ':memory:', useNullAsDefault: true });

/** Every migration before the claim: the database as a portal built before it left it. */
async function migrateBeforeClaim(db: Knex) {
  const directory = resolvePackagePath('@internal/backstage-plugin-nebius-estate-backend', 'migrations');
  for (;;) {
    const [, pending] = await db.migrate.list({ directory });
    const next = pending[0]?.file;
    if (!next || next >= CLAIM) return;
    await db.migrate.up({ directory });
  }
}

async function seed(db: Knex, tenant: string, id: string) {
  for (const table of TABLES) {
    await db(table).insert({ id: `${id}-${table}`, tenant_id: tenant, created_by: 'user:default/owner', updated_by: 'user:default/owner', updated_at: '2026-10-11T10:00:00.000Z', payload: JSON.stringify(payload[table]) });
  }
}

const tenants = async (db: Knex, table: string) => Object.fromEntries((await db(table).select('id', 'tenant_id')).map(r => [r.id, r.tenant_id]));

describe('budgets saved before a tenant was configured (N1)', () => {
  it('the migration gives rows with an empty tenant to the configured tenant, in every table, and deletes nothing', async () => {
    const db = sqlite();
    try {
      await migrateBeforeClaim(db);
      await seed(db, '', 'old');
      await seed(db, 'tenant-e00mockother', 'other');
      await migrate(db, { tenantId: TENANT });
      for (const table of TABLES) {
        expect(await tenants(db, table)).toEqual({ [`old-${table}`]: TENANT, [`other-${table}`]: 'tenant-e00mockother' });
      }
      await migrate(db, { tenantId: TENANT });
      expect(await db('nebius_credits').count({ n: '*' }).first()).toEqual({ n: 2 });
      const list = await new BudgetStore(db, TENANT).list('credit');
      expect(list.map(c => c.name)).toEqual(['Token Factory promo']);
    } finally {
      await db.destroy();
    }
  });

  it('leaves the rows alone when no tenant is configured', async () => {
    const db = sqlite();
    try {
      await migrateBeforeClaim(db);
      await seed(db, '', 'old');
      await migrate(db);
      for (const table of TABLES) expect(await tenants(db, table)).toEqual({ [`old-${table}`]: '' });
    } finally {
      await db.destroy();
    }
  });

  it('reads, edits and deletes a row saved without a tenant after the migration ran (read tolerance); another tenant stays hidden', async () => {
    const db = sqlite();
    try {
      await migrate(db, { tenantId: TENANT });
      await seed(db, '', 'late');
      await seed(db, 'tenant-e00mockother', 'other');
      const store = new BudgetStore(db, TENANT);
      expect((await store.list('credit')).map(c => c.id)).toEqual(['late-nebius_credits']);
      expect(await store.get('credit', 'other-nebius_credits')).toBeUndefined();
      expect((await store.get('credit', 'late-nebius_credits'))?.name).toBe('Token Factory promo');
      await store.update('credit', 'late-nebius_credits', { ...credit, amount: '30' }, 'user:default/owner');
      expect((await db('nebius_credits').where({ id: 'late-nebius_credits' }).first()).tenant_id).toBe(TENANT);
      await store.remove('budget', 'late-nebius_budgets');
      await expect(store.remove('budget', 'other-nebius_budgets')).rejects.toThrow(/not found/);
    } finally {
      await db.destroy();
    }
  });
});

describe('one spend entry per provider and day (W1-P22)', () => {
  const entry = (amount: string) => ({ provider: 'token-factory', date: '2026-10-08', amount, currency: 'usd' });

  it('is a database constraint: a second entry for the day is refused even when no read came first', async () => {
    const db = sqlite();
    try {
      await migrate(db, { tenantId: TENANT });
      const store = new BudgetStore(db, TENANT);
      const results = await Promise.allSettled([store.create('spend', entry('1'), 'user:default/owner'), store.create('spend', entry('2'), 'user:default/owner')]);
      expect(results.map(r => r.status).sort()).toEqual(['fulfilled', 'rejected']);
      const refused = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')!;
      expect(refused.reason.name).toBe('ConflictError');
      expect(refused.reason.message).toMatch(/^A spend entry for 2026-10-08 exists/);
      const first = (await store.list('spend'))[0];
      // Moving another entry onto that day is refused; replacing the entry itself is fine.
      const other = await store.create('spend', { ...entry('1'), date: '2026-10-09' }, 'user:default/owner');
      await expect(store.update('spend', other.id, entry('1'), 'user:default/owner')).rejects.toThrow(/^A spend entry for 2026-10-08 exists/);
      await store.update('spend', first.id, entry('5'), 'user:default/owner');
      expect((await store.list('spend')).map(e => [e.date, e.amount]).sort()).toEqual([['2026-10-08', '5'], ['2026-10-09', '1']]);
    } finally {
      await db.destroy();
    }
  });

  it('the migration keeps duplicate days saved before it: nothing is deleted, the newest holds the day', async () => {
    const db = sqlite();
    try {
      await migrateBeforeClaim(db);
      const row = (id: string, updatedAt: string) => ({ id, tenant_id: '', created_by: 'user:default/owner', updated_by: 'user:default/owner', updated_at: updatedAt, payload: JSON.stringify(entry('1')) });
      await db('nebius_spend_entries').insert([row('older', '2026-10-08T10:00:00.000Z'), row('newer', '2026-10-09T10:00:00.000Z')]);
      await migrate(db);
      expect(await db('nebius_spend_entries').orderBy('id').select('id', 'day_key')).toEqual([
        { id: 'newer', day_key: 'token-factory|2026-10-08' },
        { id: 'older', day_key: null },
      ]);
      await expect(new BudgetStore(db).create('spend', entry('3'), 'user:default/owner')).rejects.toThrow(/^A spend entry for 2026-10-08 exists/);
    } finally {
      await db.destroy();
    }
  });
});
