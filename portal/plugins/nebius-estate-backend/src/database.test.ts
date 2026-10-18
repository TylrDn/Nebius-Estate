import knex from 'knex';
import { migrate } from './database';

describe('migrations', () => {
  it('create every table on an empty SQLite database and are idempotent', async () => {
    const db = knex({ client: 'better-sqlite3', connection: ':memory:', useNullAsDefault: true });
    try {
      await migrate(db);
      await migrate(db);
      for (const table of ['nebius_estate_history', 'nebius_provisioning_requests', 'nebius_billing_imports', 'nebius_rate_books', 'nebius_scenarios']) {
        expect(await db.schema.hasTable(table)).toBe(true);
      }
      for (const column of ['slot', 'container_id', 'charge_period_start', 'region_id', 'service_name', 'superseded_by', 'payload']) {
        expect(await db.schema.hasColumn('nebius_billing_records', column)).toBe(true);
      }
    } finally {
      await db.destroy();
    }
  });
});
