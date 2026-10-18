import { gunzipSync } from 'zlib';
import { Knex } from 'knex';
import { normalizeFocusCsv } from '@internal/nebius-domain';
import { FetchFn, HostLimiter, HttpClient, redact } from '../lib/http';
import { CommercialStore } from '../commercial/store';
import { classify } from '../inventory/contract';
import { ObjectStorageReader, StoredObject } from './objectStorage';

/**
 * Billing export pull: lists the FOCUS export bucket, imports each new or
 * changed file (key + ETag + size) through the same FOCUS import as a manual
 * upload (hour-slot supersession, so overlaps never double count), gunzips
 * `.gz`, bounds every size, and isolates failures per object. Read-only: GET
 * only, one origin (storage.<region>.nebius.cloud or a loopback test endpoint).
 */
const TABLE = 'nebius_billing_export_objects';
const MAX_OBJECTS_PER_SYNC = 50;

export interface BillingExportSettings {
  bucket: string;
  region: string;
  prefix: string;
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  maxBytes: number;
}

export interface BillingExportResult {
  listed: number;
  imported: { key: string; rows: number }[];
  unchanged: number;
  failed: { key: string; error: string }[];
  truncated: boolean;
  /** The newest file imported, this sync or before (from the database, so a restart keeps it): the connector's note (#5). */
  lastImport?: { key: string; rows: number; at: string } | { key: string; removed: true; at: string };
  /** Set when the listing itself failed. */
  listError?: { state: ReturnType<typeof classify>['state']; message: string };
  latencyMs: number;
}

const isExportFile = (key: string) => /\.csv(\.gz)?$/i.test(key) || /\.gz$/i.test(key);

export class BillingExportPuller {
  constructor(private readonly db: Knex, private readonly commercial: CommercialStore) {}

  async sync(s: BillingExportSettings, opts: { fetch?: FetchFn; limiter?: HostLimiter; timeoutMs: number }): Promise<BillingExportResult> {
    const started = Date.now();
    const http = new HttpClient({ allowedOrigins: [s.endpoint], timeoutMs: opts.timeoutMs, fetch: opts.fetch, limiter: opts.limiter });
    const reader = new ObjectStorageReader(http, { endpoint: s.endpoint, region: s.region, bucket: s.bucket, credentials: { accessKeyId: s.accessKeyId, secretAccessKey: s.secretAccessKey } });
    const result: BillingExportResult = { listed: 0, imported: [], unchanged: 0, failed: [], truncated: false, latencyMs: 0 };
    let objects: StoredObject[];
    try {
      const l = await reader.list(s.prefix);
      objects = l.objects.filter(o => isExportFile(o.key));
      result.truncated = l.truncated;
    } catch (e) {
      result.listError = { state: classify(e).state, message: redact((e as Error).message) };
      result.latencyMs = Date.now() - started;
      return result;
    }
    result.listed = objects.length;
    const known = new Map<string, { etag: string; size: number; status: string }>(
      (await this.db(TABLE).select('object_key', 'etag', 'size', 'status')).map(r => [r.object_key, { etag: r.etag, size: Number(r.size), status: r.status }]),
    );
    const todo = objects
      .filter(o => {
        const k = known.get(o.key);
        return !k || k.etag !== o.etag || k.size !== o.size;
      })
      .sort((a, b) => (a.lastModified ?? a.key).localeCompare(b.lastModified ?? b.key));
    result.unchanged = objects.length - todo.length;
    for (const o of todo.slice(0, MAX_OBJECTS_PER_SYNC)) {
      const processedAt = new Date().toISOString();
      try {
        if (o.size > s.maxBytes) throw new Error(`${o.size} bytes exceeds the ${s.maxBytes}-byte import limit`);
        const raw = await reader.get(o.key, s.maxBytes);
        const text = (/\.gz$/i.test(o.key) ? gunzipSync(raw, { maxOutputLength: s.maxBytes }) : raw).toString('utf8');
        const normalized = normalizeFocusCsv(text);
        if (normalized.missingColumns.length) throw new Error(`not a FOCUS export: missing ${normalized.missingColumns.join(', ')}`);
        const imp = await this.commercial.importRecords({ importedBy: 'system:billing-export', filename: o.key.slice(-120), importedAt: processedAt }, normalized);
        await this.upsert(o, { status: 'imported', import_id: imp.id, processed_at: processedAt, error: null });
        result.imported.push({ key: o.key, rows: imp.summary.accepted });
      } catch (e) {
        const error = redact((e as Error).message).slice(0, 500);
        await this.upsert(o, { status: 'failed', import_id: null, processed_at: processedAt, error });
        result.failed.push({ key: o.key, error });
      }
    }
    result.lastImport = await this.lastImport();
    result.latencyMs = Date.now() - started;
    return result;
  }

  /** The newest imported export file and its accepted rows; an import deleted since is said as removed, not as 0 rows. */
  async lastImport(): Promise<BillingExportResult['lastImport']> {
    const row = await this.db(TABLE).where({ status: 'imported' }).whereNotNull('import_id').orderBy('processed_at', 'desc').first('object_key', 'import_id', 'processed_at');
    if (!row) return undefined;
    const summary = await this.commercial.importSummary(row.import_id);
    return summary ? { key: row.object_key, rows: summary.accepted, at: row.processed_at } : { key: row.object_key, removed: true, at: row.processed_at };
  }

  private async upsert(o: StoredObject, fields: { status: string; import_id: string | null; processed_at: string; error: string | null }) {
    await this.db(TABLE)
      .insert({ object_key: o.key, etag: o.etag, size: o.size, last_modified: o.lastModified ?? null, ...fields })
      .onConflict('object_key')
      .merge();
  }
}
