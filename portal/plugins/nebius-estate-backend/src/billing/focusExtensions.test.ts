import knexFactory, { Knex } from 'knex';
import { resolve } from 'path';
import { gzipSync } from 'zlib';
import { normalizeFocusCsv } from '@internal/nebius-domain';
import { migrate } from '../database';
import { CommercialStore } from '../commercial/store';
import { BillingExportPuller, BillingExportSettings } from './exportPull';

// The migration is plain JS (knex runs it); its backfill is exported for this test.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { backfill } = require(resolve(__dirname, '../../migrations/20261011021100_focus_extension_columns.js'));

const HEADER = 'BillingAccountId,BillingCurrency,BillingPeriodStart,ChargePeriodStart,ChargePeriodEnd,ChargeCategory,ChargeClass,ServiceName,RegionId,ResourceId,ResourceName,BilledCost,x_ContainerId,x_ContainerName';
const EXT = ',x_TenantId,x_TenantName,x_ProjectId,x_ProjectName,x_TrialId';
const line = (h: string, cost: string) => `customer-e00mock,USD,2026-10-01T00:00:00Z,2026-10-07T${h}:00:00Z,2026-10-07T${h}:59:00Z,Usage,NULL,Compute,eu-north1,computeinstance-e00mock,NULL,${cost},project-e00mockp,nbis-mock`;
const OLD_FILE = [HEADER + EXT, `${line('10', '1.5')},tenant-e00mock,mock,project-e00mockp,nbis-mock,trial-e00mock`, `${line('11', '2.5')},tenant-e00mock,mock,project-e00mockp,nbis-mock,trial-e00mock`].join('\n');

/** Rows as an importer before 2026-10-11 stored them: no extension fields, NULL text kept, the columns reported unknown. */
async function importLikeBefore(db: Knex, commercial: CommercialStore) {
  const n = normalizeFocusCsv(OLD_FILE);
  const old = n.records.map(r => {
    const { tenantId, tenantName, projectId, projectName, trialId, contractPriceId, usageBasedDiscountIds, ...rest } = r;
    return { ...rest, chargeClass: 'NULL', resourceName: 'NULL' } as any;
  });
  const imp = await commercial.importRecords({ importedBy: 'system:billing-export', filename: 'focus/oct.csv.gz', importedAt: '2026-10-11T07:00:00Z' }, { ...n, records: old, unknownColumns: ['x_TenantId', 'x_TenantName', 'x_ProjectId', 'x_ProjectName'] });
  await db('nebius_billing_export_objects').insert({ object_key: 'focus/oct.csv.gz', etag: 'abc', size: 1, status: 'imported', import_id: imp.id, processed_at: '2026-10-11T07:00:00Z' });
  return imp;
}

const settings: BillingExportSettings = { bucket: 'b', region: 'eu-north1', prefix: 'focus/', endpoint: 'https://storage.eu-north1.nebius.cloud', accessKeyId: 'k', secretAccessKey: 's', maxBytes: 1_000_000 };
const listing = `<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>focus/oct.csv.gz</Key><ETag>&quot;abc&quot;</ETag><Size>1</Size></Contents></ListBucketResult>`;
const bucket = jest.fn(async (input: string) => (new URL(input).search.includes('list-type') ? new Response(listing, { status: 200 }) : new Response(gzipSync(OLD_FILE), { status: 200 })));

describe('FOCUS extension columns migration', () => {
  it('re-derives stored rows, clears NULL text, re-imports export files once, and is idempotent', async () => {
    const db = knexFactory({ client: 'better-sqlite3', connection: ':memory:', useNullAsDefault: true });
    try {
      await migrate(db);
      const commercial = new CommercialStore(db);
      await importLikeBefore(db, commercial);
      const raw = async () => (await db('nebius_billing_records').whereNull('superseded_by').select('payload')).map(r => JSON.parse(r.payload));
      expect((await raw())[0].projectId).toBeUndefined();

      expect(await backfill(db)).toEqual({ rows: 2, files: 1 });
      const derived = await raw();
      expect(derived[0]).toMatchObject({ projectId: 'project-e00mockp', projectName: 'nbis-mock', trialId: '', chargeClass: '', resourceName: '' });
      expect(await db('nebius_billing_export_objects').first('status', 'etag')).toEqual({ status: 'reimport', etag: '' });
      // Running it again changes nothing.
      expect(await backfill(db)).toEqual({ rows: 0, files: 0 });

      // The next sync re-imports the file: the hours are superseded, the totals do not change, and x_TrialId arrives.
      const puller = new BillingExportPuller(db, commercial);
      const before = (await commercial.activeRecords({ scope: { all: true, projects: new Set() } })).reduce((a, r) => a + Number(r.costs.BilledCost), 0);
      const first = await puller.sync(settings, { fetch: bucket as any, timeoutMs: 1000 });
      expect(first.imported).toEqual([{ key: 'focus/oct.csv.gz', rows: 2 }]);
      const after = await commercial.activeRecords({ scope: { all: true, projects: new Set() } });
      expect(after.reduce((a, r) => a + Number(r.costs.BilledCost), 0)).toBe(before);
      expect(after.every(r => r.trialId === 'trial-e00mock' && r.tenantId === 'tenant-e00mock')).toBe(true);
      // Idempotent end to end: nothing left to backfill, and the next sync imports nothing.
      expect(await backfill(db)).toEqual({ rows: 0, files: 0 });
      expect((await puller.sync(settings, { fetch: bucket as any, timeoutMs: 1000 })).imported).toEqual([]);
    } finally {
      await db.destroy();
    }
  });

  it('is part of the migrations that run at start-up', async () => {
    const db = knexFactory({ client: 'better-sqlite3', connection: ':memory:', useNullAsDefault: true });
    try {
      await migrate(db);
      expect((await db('knex_migrations').select('name')).map(r => r.name)).toEqual(expect.arrayContaining(['20261011021000_budgets_and_credits.js', '20261011021100_focus_extension_columns.js']));
      for (const t of ['nebius_budgets', 'nebius_credits', 'nebius_spend_entries']) expect(await db.schema.hasTable(t)).toBe(true);
    } finally {
      await db.destroy();
    }
  });
});
