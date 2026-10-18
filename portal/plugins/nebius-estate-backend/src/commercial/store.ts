import { randomUUID } from 'crypto';
import { Knex } from 'knex';
import { NotFoundError } from '@backstage/errors';
import {
  attributedProject,
  billingSlot,
  dedupeFile,
  ImportRecord,
  ingestSummary,
  NormalizeResult,
  RateBook,
  rateBookSchema,
  Scenario,
  ScenarioRecord,
  scenarioSchema,
  exportedThrough,
  StoredBillingRecord,
  withFocusExtensions,
} from '@internal/nebius-domain';
import { ProjectScope } from '../lib/access';

/**
 * Commercial persistence. Rate books (possibly confidential), scenarios and
 * billing imports live in the portal database only — never in the
 * repository, never in the browser beyond what a permitted caller requests.
 *
 * Billing rows keep their filter columns (project, charge-period start,
 * region, service) outside the JSON payload, so every report selects its rows
 * in SQL, and supersession is a single DELETE per slot batch: only active rows
 * are stored (superseded_by stays null; it is kept for older rows' schema).
 */
const T = {
  imports: 'nebius_billing_imports',
  records: 'nebius_billing_records',
  books: 'nebius_rate_books',
  scenarios: 'nebius_scenarios',
};

/** Which billing rows a report reads. `from` is inclusive, `to` exclusive (ISO timestamps). */
export interface BillingQuery {
  scope: ProjectScope;
  project?: string;
  region?: string;
  service?: string;
  from?: string;
  to?: string;
}

export class CommercialStore {
  constructor(private readonly db: Knex) {}

  /* ----------------------------------------------------------- billing */

  private rows(q: BillingQuery) {
    const query = this.db(T.records);
    if (!q.scope.all) query.whereIn(`${T.records}.container_id`, [...q.scope.projects]);
    if (q.project) query.where(`${T.records}.container_id`, q.project);
    if (q.region) query.where(`${T.records}.region_id`, q.region);
    if (q.service) query.where(`${T.records}.service_name`, q.service);
    if (q.from) query.where(`${T.records}.charge_period_start`, '>=', q.from);
    if (q.to) query.where(`${T.records}.charge_period_start`, '<', q.to);
    return query;
  }

  /** Active (not superseded) rows matching the query. */
  async activeRecords(q: BillingQuery): Promise<StoredBillingRecord[]> {
    const rows = await this.rows(q)
      .whereNull(`${T.records}.superseded_by`)
      .join(T.imports, `${T.records}.import_id`, `${T.imports}.id`)
      .select(`${T.records}.payload`, `${T.records}.import_id`, `${T.imports}.imported_at`)
      .orderBy(`${T.records}.seq`);
    return rows.map(r => ({ ...withFocusExtensions(JSON.parse(r.payload)), importId: r.import_id, importedAt: r.imported_at }));
  }

  /** The first exported hour and the last exported hour among the active rows in scope (export freshness). */
  async chargeSpan(scope: ProjectScope): Promise<{ earliestStart?: string; latestEnd?: string }> {
    const active = () => this.rows({ scope }).whereNull(`${T.records}.superseded_by`);
    const [first] = await active().orderBy(`${T.records}.charge_period_start`, 'asc').limit(1).select(`${T.records}.charge_period_start`);
    if (!first) return {};
    // Rows of the newest hour can end at different times; read a few of the newest and keep the latest end.
    const newest = await active().orderBy(`${T.records}.charge_period_start`, 'desc').limit(50).select(`${T.records}.payload`);
    // The same rule as Costs and Overview (exportHealth): month-long rows (tax) end next month and are not freshness.
    return { earliestStart: first.charge_period_start, latestEnd: exportedThrough(newest.map(r => JSON.parse(r.payload))) };
  }

  /** Stored rows (only active ones are kept: superseded rows are deleted on import) and the imports they came from. */
  async storedCounts(q: BillingQuery): Promise<{ rows: number; imports: number }> {
    const [c] = await this.rows(q).count({ rows: '*' }).countDistinct({ imports: `${T.records}.import_id` });
    return { rows: Number(c.rows), imports: Number(c.imports) };
  }

  /**
   * Stores one FOCUS file: exact duplicates in the file are dropped, and the
   * rows already stored for the same billing account × attributed project ×
   * hour are superseded by this import and deleted in the same transaction.
   */
  async importRecords(meta: { importedBy: string; filename: string; importedAt: string }, normalized: NormalizeResult): Promise<ImportRecord> {
    const id = randomUUID();
    const { fresh, duplicatesInFile } = dedupeFile(normalized.records);
    // The slot is re-derived here (not trusted from the caller): billing account × attributed project × hour.
    const slots = [...new Set(fresh.map(r => billingSlot(r)))];
    return this.db.transaction(async trx => {
      let supersededRows = 0;
      const supersededImports = new Set<string>();
      for (let i = 0; i < slots.length; i += 500) {
        const batch = () => trx(T.records).whereIn('slot', slots.slice(i, i + 500)).whereNull('superseded_by');
        const prior: { import_id: string; n: string | number }[] = await batch().select('import_id').count({ n: '*' }).groupBy('import_id');
        for (const p of prior) {
          supersededRows += Number(p.n);
          supersededImports.add(p.import_id);
        }
        // Superseded rows are deleted at once (bounded storage): no report reads them, and the import's
        // summary keeps how many rows it replaced and from which imports.
        await batch().delete();
      }
      const summary = {
        ...ingestSummary(id, fresh, { duplicatesInFile, supersededRows, supersededImports: [...supersededImports], rejected: normalized.errors.length }),
        errors: normalized.errors.slice(0, 50),
        unknownColumns: normalized.unknownColumns,
      };
      const projects = [...new Set(fresh.map(r => attributedProject(r).id).filter(Boolean))].sort();
      await trx(T.imports).insert({ id, imported_at: meta.importedAt, imported_by: meta.importedBy, filename: meta.filename, summary: JSON.stringify(summary), projects: JSON.stringify(projects) });
      for (let i = 0; i < fresh.length; i += 200) {
        await trx(T.records).insert(
          fresh.slice(i, i + 200).map(r => ({
            import_id: id,
            slot: billingSlot(r),
            // Attribution: x_ProjectId first, then x_ContainerId (scope and project filters use this column).
            container_id: attributedProject(r).id,
            charge_period_start: r.chargePeriodStart,
            region_id: r.regionId,
            service_name: r.serviceName,
            superseded_by: null,
            payload: JSON.stringify(r),
          })),
        );
      }
      return { id, ...meta, summary };
    });
  }

  /**
   * Imports that carried at least one row of the caller's projects (all imports for an unrestricted
   * caller), from the project list stored with each import: still listed after its rows were superseded.
   */
  async imports(scope: ProjectScope): Promise<ImportRecord[]> {
    const rows = await this.db(T.imports).select().orderBy('imported_at', 'desc');
    const visible = (projects: string | null) => scope.all || (JSON.parse(projects ?? '[]') as string[]).some(p => scope.projects.has(p));
    return rows.filter(r => visible(r.projects)).map(r => ({ id: r.id, importedAt: r.imported_at, importedBy: r.imported_by, filename: r.filename, summary: JSON.parse(r.summary) }));
  }

  /**
   * When the newest export files arrived in the bucket (their LastModified), newest first: the next-file estimate
   * reads the cadence from them (#12). Files without a LastModified are left out.
   */
  async exportArrivals(limit = 12): Promise<string[]> {
    const rows = await this.db('nebius_billing_export_objects').whereNotNull('last_modified').orderBy('last_modified', 'desc').limit(limit).select('last_modified');
    return rows.map(r => r.last_modified as string);
  }

  /** One import's summary by id (the billing export's last import), or undefined when it was deleted. */
  async importSummary(id: string): Promise<ImportRecord['summary'] | undefined> {
    const row = await this.db(T.imports).where({ id }).first('summary');
    return row ? JSON.parse(row.summary) : undefined;
  }

  async hasImports(): Promise<boolean> {
    return Boolean(await this.db(T.imports).first('id'));
  }

  /* --------------------------------------------------------- rate books */

  async books(): Promise<RateBook[]> {
    return (await this.db(T.books).select('payload').orderBy('id')).map(r => rateBookSchema.parse(JSON.parse(r.payload)));
  }

  /** Each book's lifecycle state (W1-P8): archived, and whether it is the portal default. */
  async bookStates(): Promise<Map<string, { archived: boolean; isDefault: boolean }>> {
    const rows = await this.db(T.books).select('id', 'archived_at', 'is_default');
    return new Map(rows.map(r => [r.id as string, { archived: Boolean(r.archived_at), isDefault: Boolean(r.is_default) }]));
  }

  /** Archives or restores a book; archiving the portal default is refused by the route, not here. */
  async setArchived(id: string, archived: boolean): Promise<void> {
    const n = await this.db(T.books).where({ id }).update({ archived_at: archived ? new Date().toISOString() : null });
    if (!n) throw new NotFoundError(`rate book ${id} not found`);
  }

  /** Makes `id` the one portal default, or clears the default (`id` undefined). */
  async setDefault(id: string | undefined): Promise<void> {
    await this.db.transaction(async trx => {
      await trx(T.books).update({ is_default: false });
      if (id) {
        const n = await trx(T.books).where({ id }).update({ is_default: true });
        if (!n) throw new NotFoundError(`rate book ${id} not found`);
      }
    });
  }

  async book(id: string): Promise<RateBook> {
    const row = await this.db(T.books).where({ id }).first('payload');
    if (!row) throw new NotFoundError(`rate book ${id} not found`);
    return rateBookSchema.parse(JSON.parse(row.payload));
  }

  /** The configured default rate book, else the first by id; undefined when there is none. */
  async defaultBook(configured?: string): Promise<RateBook | undefined> {
    return (await this.defaultBookChoice(configured)).book;
  }

  /**
   * The default rate book and how it was chosen (G4.5, W1-P8): the configured one, the portal default stored here, the
   * only active one, or the first of several active ones by id, which an import or a delete can change, so it is said
   * wherever the book is used. Archived books are never chosen.
   */
  async defaultBookChoice(configured?: string): Promise<{ book?: RateBook; how: 'configured' | 'portal-default' | 'only' | 'first-by-id'; count: number }> {
    const active = () => this.db(T.books).whereNull('archived_at');
    const [{ n }] = await active().count({ n: '*' });
    const count = Number(n);
    const parse = (row?: { payload: string }) => (row ? rateBookSchema.parse(JSON.parse(row.payload)) : undefined);
    if (configured) return { book: parse(await this.db(T.books).where({ id: configured }).first('payload')), how: 'configured', count };
    const stored = await active().where({ is_default: true }).first('payload');
    if (stored) return { book: parse(stored), how: 'portal-default', count };
    return { book: parse(await active().orderBy('id').first('payload')), how: count === 1 ? 'only' : 'first-by-id', count };
  }

  async deleteBook(id: string): Promise<void> {
    const n = await this.db(T.books).where({ id }).delete();
    if (!n) throw new NotFoundError(`rate book ${id} not found`);
  }

  async putBook(book: RateBook, by: string): Promise<RateBook> {
    const parsed = rateBookSchema.parse(book);
    const row = { id: parsed.id, classification: parsed.classification, updated_at: new Date().toISOString(), updated_by: by, payload: JSON.stringify(parsed) };
    await this.db(T.books).insert(row).onConflict('id').merge();
    return parsed;
  }

  /* ---------------------------------------------------------- scenarios */

  async scenarios(): Promise<ScenarioRecord[]> {
    const rows = await this.db(T.scenarios).select().orderBy('updated_at', 'desc');
    return rows.map(r => ({ ...scenarioSchema.parse(JSON.parse(r.payload)), id: r.id, createdBy: r.created_by, updatedAt: r.updated_at }));
  }

  async scenario(id: string): Promise<Scenario> {
    const row = await this.db(T.scenarios).where({ id }).first('payload');
    if (!row) throw new NotFoundError(`scenario ${id} not found`);
    return { ...scenarioSchema.parse(JSON.parse(row.payload)), id };
  }

  async putScenario(s: Scenario, by: string): Promise<Scenario> {
    const id = s.id ?? randomUUID();
    const parsed = { ...scenarioSchema.parse(s), id };
    await this.db(T.scenarios)
      .insert({ id, created_by: by, updated_at: new Date().toISOString(), payload: JSON.stringify(parsed) })
      .onConflict('id')
      .merge(['updated_at', 'payload']);
    return parsed;
  }

  async deleteScenario(id: string): Promise<void> {
    const n = await this.db(T.scenarios).where({ id }).delete();
    if (!n) throw new NotFoundError(`scenario ${id} not found`);
  }
}
