import knexFactory from 'knex';
import { resolve } from 'path';
import { migrate } from '../database';
import { CommercialStore } from '../commercial/store';
import { TEST_DATA } from '../__testUtils__/testing';
import { BillingExportPuller, BillingExportSettings } from './exportPull';
import { parseListPage } from './objectStorage';
import { EMPTY_SHA256, signV4 } from './sigv4';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const stub = require(resolve(TEST_DATA, 'stubApi.js'));

/** fetch backed by the e2e stub's S3 fake, with a hook to override responses. */
function s3Fetch(override?: (url: URL) => Response | undefined) {
  const calls: { method: string; url: string; auth: string }[] = [];
  const fetch = jest.fn(async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    calls.push({ method: init.method ?? 'GET', url: url.pathname + url.search, auth: headers.authorization ?? '' });
    const o = override?.(url);
    if (o) return o;
    const r = stub.handle(init.method ?? 'GET', url.pathname + url.search, headers);
    return new Response(r.raw ?? JSON.stringify(r.body), { status: r.status, headers: { 'content-type': r.contentType ?? 'application/json' } });
  });
  return { fetch, calls };
}

const settings: BillingExportSettings = {
  bucket: stub.EXPORT_BUCKET, region: 'eu-west2', prefix: 'focus/', endpoint: 'https://storage.eu-west2.nebius.cloud',
  accessKeyId: 'e00mock-access-key', secretAccessKey: 'e00mock-secret', maxBytes: 25 * 1024 * 1024,
};

async function setup() {
  const db = knexFactory({ client: 'better-sqlite3', connection: ':memory:', useNullAsDefault: true });
  await migrate(db);
  const commercial = new CommercialStore(db);
  return { db, commercial, puller: new BillingExportPuller(db, commercial) };
}

describe('SigV4', () => {
  it('matches the AWS test-suite vector get-vanilla', () => {
    const h = signV4({
      method: 'GET', url: 'https://example.amazonaws.com/', payloadHash: EMPTY_SHA256, region: 'us-east-1', service: 'service', now: new Date('2015-08-30T12:36:00Z'),
      credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' },
    });
    expect(h['x-amz-date']).toBe('20150830T123600Z');
    expect(h.Authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
    );
  });
});

describe('ListObjectsV2 parsing', () => {
  it('reads keys, ETags (unquoted), sizes and the continuation token', () => {
    const p = parseListPage('<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>t&amp;2</NextContinuationToken><Contents><Key>a &amp; b.csv.gz</Key><ETag>&quot;abc&quot;</ETag><Size>10</Size></Contents></ListBucketResult>');
    expect(p).toEqual({ objects: [{ key: 'a & b.csv.gz', etag: 'abc', size: 10, lastModified: undefined }], next: 't&2' });
  });
});

describe('billing export pull', () => {
  it('lists with SigV4 (GET only), gunzips and imports each file once, then again only when its ETag changes', async () => {
    const { db, commercial, puller } = await setup();
    const { fetch, calls } = s3Fetch();
    const r1 = await puller.sync(settings, { fetch, timeoutMs: 1000 });
    expect(r1).toMatchObject({ listed: 1, unchanged: 0, failed: [] });
    expect(r1.imported).toEqual([{ key: 'focus/focus-export-2026-10-06.csv.gz', rows: 300 }]);
    expect(calls.every(c => c.method === 'GET' && c.auth.startsWith('AWS4-HMAC-SHA256 Credential=e00mock-access-key/'))).toBe(true);
    expect(calls[0].url).toBe(`/${stub.EXPORT_BUCKET}?list-type=2&max-keys=1000&prefix=focus%2F`);
    expect((await commercial.imports({ all: true, projects: new Set() }))[0]).toMatchObject({ importedBy: 'system:billing-export' });
    const r2 = await puller.sync(settings, { fetch, timeoutMs: 1000 });
    expect(r2).toMatchObject({ listed: 1, unchanged: 1, imported: [] });
    // The last import is kept in the database: a sync with nothing new (or a restart) still names it (#5).
    expect(r1.lastImport).toMatchObject({ key: 'focus/focus-export-2026-10-06.csv.gz', rows: 300 });
    expect(r2.lastImport).toEqual(r1.lastImport);
    // The import deleted since (on Costs): the file is named as removed, not as an import of 0 rows.
    const [{ import_id: kept }] = await db('nebius_billing_export_objects').select('import_id');
    await db('nebius_billing_export_objects').update({ import_id: 'deleted-import' });
    const gone = await puller.lastImport();
    expect(gone).toMatchObject({ key: 'focus/focus-export-2026-10-06.csv.gz', removed: true });
    expect(gone).not.toHaveProperty('rows');
    await db('nebius_billing_export_objects').update({ import_id: kept });
    await db('nebius_billing_export_objects').update({ etag: 'older' });
    const r3 = await puller.sync(settings, { fetch, timeoutMs: 1000 });
    expect(r3.imported).toHaveLength(1);
    // The re-import superseded the first import's rows, and they were deleted: the table does not grow.
    expect(Number((await db('nebius_billing_records').count({ n: '*' }))[0].n)).toBe(300);
    expect(JSON.stringify([r1, r2, r3])).not.toContain('e00mock-secret');
    await db.destroy();
  });

  it('follows continuation tokens and isolates a broken file', async () => {
    const { db, puller } = await setup();
    const page1 = `<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>p2</NextContinuationToken><Contents><Key>focus/broken.csv.gz</Key><ETag>"x"</ETag><Size>4</Size></Contents></ListBucketResult>`;
    const { fetch, calls } = s3Fetch(url => {
      if (url.pathname === `/${stub.EXPORT_BUCKET}` && !url.searchParams.has('continuation-token')) return new Response(page1, { status: 200 });
      if (url.pathname.endsWith('/broken.csv.gz')) return new Response('nope', { status: 200 });
      return undefined;
    });
    const r = await puller.sync(settings, { fetch, timeoutMs: 1000 });
    expect(calls.filter(c => c.url.includes('list-type')).map(c => c.url.includes('continuation-token=p2'))).toEqual([false, true]);
    expect(r.listed).toBe(2);
    expect(r.imported.map(i => i.key)).toEqual(['focus/focus-export-2026-10-06.csv.gz']);
    expect(r.failed).toEqual([expect.objectContaining({ key: 'focus/broken.csv.gz' })]);
    await db.destroy();
  });

  it('reports a refused or missing bucket as a listing state, never a crash', async () => {
    const { db, puller } = await setup();
    const denied = await puller.sync(settings, { fetch: s3Fetch(() => new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 })).fetch, timeoutMs: 1000 });
    expect(denied.listError?.state).toBe('permission-denied');
    const missing = await puller.sync({ ...settings, bucket: 'e00mock-no-such-bucket' }, { fetch: s3Fetch().fetch, timeoutMs: 1000 });
    expect(missing.listError?.state).toBe('not-found');
    const empty = await puller.sync({ ...settings, prefix: 'nothing/' }, { fetch: s3Fetch().fetch, timeoutMs: 1000 });
    expect(empty).toMatchObject({ listed: 0, imported: [], failed: [] });
    await db.destroy();
  });
});
