import { randomUUID } from 'crypto';
import { Knex } from 'knex';
import { ConflictError, NotFoundError } from '@backstage/errors';
import {
  BudgetInput,
  budgetInputSchema,
  BudgetRecord,
  CreditInput,
  creditInputSchema,
  CreditRecord,
  SpendEntryInput,
  spendEntryInputSchema,
  SpendEntryRecord,
} from '@internal/nebius-domain';

/**
 * Budgets, credits and Token Factory spend entries: local data the owner types in, labelled "entered
 * by you", stored in the portal database only (like rate books). Every row carries who saved it and
 * the tenant. Payloads are validated with the domain schemas on write and on read.
 */
const KINDS = {
  budget: { table: 'nebius_budgets', schema: budgetInputSchema },
  credit: { table: 'nebius_credits', schema: creditInputSchema },
  spend: { table: 'nebius_spend_entries', schema: spendEntryInputSchema },
} as const;

export type BudgetKind = keyof typeof KINDS;
type InputOf<K extends BudgetKind> = K extends 'budget' ? BudgetInput : K extends 'credit' ? CreditInput : SpendEntryInput;
type RecordOf<K extends BudgetKind> = K extends 'budget' ? BudgetRecord : K extends 'credit' ? CreditRecord : SpendEntryRecord;

/** A spend entry's day, unique per tenant in the database (W1-P22, migration 20261013010000). */
const dayKey = (kind: BudgetKind, parsed: unknown) => (kind === 'spend' ? `${(parsed as SpendEntryInput).provider}|${(parsed as SpendEntryInput).date}` : undefined);

/** better-sqlite3 (SQLITE_CONSTRAINT_UNIQUE) or PostgreSQL (23505). */
const isUniqueViolation = (e: unknown) => {
  const code = (e as { code?: string } | undefined)?.code;
  return code === 'SQLITE_CONSTRAINT_UNIQUE' || code === '23505' || /UNIQUE constraint failed|duplicate key value violates unique constraint/i.test(String((e as Error | undefined)?.message));
};

const parseAs = <K extends BudgetKind>(schema: (typeof KINDS)[BudgetKind]['schema'], v: unknown) => schema.parse(v) as unknown as InputOf<K>;

export class BudgetStore {
  constructor(private readonly db: Knex, private readonly tenantId = '') {}

  /**
   * This tenant's rows, and rows saved while no tenant was configured (empty tenant_id): the migration
   * 20261012000000 gives those to the tenant at start-up, this keeps any saved after it visible too.
   */
  private mine(table: string) {
    return this.db(table).whereIn('tenant_id', this.tenantId ? [this.tenantId, ''] : ['']);
  }

  async list<K extends BudgetKind>(kind: K): Promise<RecordOf<K>[]> {
    const { table, schema } = KINDS[kind];
    const rows = await this.mine(table).select().orderBy('updated_at', 'desc');
    return rows.map(r => ({ ...parseAs<K>(schema, JSON.parse(r.payload)), id: r.id, createdBy: r.created_by, updatedAt: r.updated_at }) as RecordOf<K>);
  }

  /** One record; undefined when there is none with this id. */
  async get<K extends BudgetKind>(kind: K, id: string): Promise<RecordOf<K> | undefined> {
    const { table, schema } = KINDS[kind];
    const r = await this.mine(table).where({ id }).first();
    return r ? ({ ...parseAs<K>(schema, JSON.parse(r.payload)), id: r.id, createdBy: r.created_by, updatedAt: r.updated_at } as RecordOf<K>) : undefined;
  }

  async create<K extends BudgetKind>(kind: K, input: unknown, by: string): Promise<RecordOf<K>> {
    const { table, schema } = KINDS[kind];
    const parsed = parseAs<K>(schema, input);
    const id = randomUUID();
    const updatedAt = new Date().toISOString();
    await this.unique(kind, parsed, () =>
      this.db(table).insert({ id, tenant_id: this.tenantId, created_by: by, updated_by: by, updated_at: updatedAt, payload: JSON.stringify(parsed), ...this.keyColumn(kind, parsed) }),
    );
    return { ...parsed, id, createdBy: by, updatedAt } as RecordOf<K>;
  }

  async update<K extends BudgetKind>(kind: K, id: string, input: unknown, by: string): Promise<RecordOf<K>> {
    const { table, schema } = KINDS[kind];
    const parsed = parseAs<K>(schema, input);
    const updatedAt = new Date().toISOString();
    const n = await this.unique(kind, parsed, () =>
      this.mine(table).where({ id }).update({ tenant_id: this.tenantId, updated_by: by, updated_at: updatedAt, payload: JSON.stringify(parsed), ...this.keyColumn(kind, parsed) }),
    );
    if (!n) throw new NotFoundError(`${kind} ${id} not found`);
    const row = await this.db(table).where({ id }).first('created_by');
    return { ...parsed, id, createdBy: row.created_by, updatedAt } as RecordOf<K>;
  }

  private keyColumn(kind: BudgetKind, parsed: unknown): { day_key?: string } {
    const key = dayKey(kind, parsed);
    return key ? { day_key: key } : {};
  }

  /** Runs a write; a second spend entry for a day is refused with the one to replace, as the route's own check says. */
  private async unique<T>(kind: BudgetKind, parsed: unknown, write: () => Promise<T>): Promise<T> {
    try {
      return await write();
    } catch (e) {
      const key = dayKey(kind, parsed);
      if (!key || !isUniqueViolation(e)) throw e;
      const same = await this.mine(KINDS.spend.table).where({ day_key: key }).first();
      const p = same ? (spendEntryInputSchema.parse(JSON.parse(same.payload)) as SpendEntryInput) : (parsed as SpendEntryInput);
      throw new ConflictError(`A spend entry for ${p.date} exists${same ? ` (${p.amount} ${p.currency}, id ${same.id})` : ''}: replace it instead of adding a second one.`);
    }
  }

  async remove(kind: BudgetKind, id: string): Promise<void> {
    const n = await this.mine(KINDS[kind].table).where({ id }).delete();
    if (!n) throw new NotFoundError(`${kind} ${id} not found`);
  }
}
