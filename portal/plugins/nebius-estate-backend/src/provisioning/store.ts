import { randomUUID } from 'crypto';
import { Knex } from 'knex';
import { ConflictError, NotFoundError } from '@backstage/errors';
import { ProvisioningRequestRecord, ProvisioningState } from '@internal/nebius-domain';

/**
 * Provisioning requests are stored locally (portal database). Creating one
 * writes nothing to the repository or to any external system.
 *
 * Concurrency: a request records the sha256 of every sizing file it was
 * previewed against; it is refused when the file has changed since, and
 * when another open request already changes the same file. Only files its
 * patch changes are locked (`lockFiles`): a request with an empty patch
 * locks nothing (G5.4). State changes are compare-and-set on the previous
 * state; a lock ends when the request is deployed or withdrawn.
 */

const TABLE = 'nebius_provisioning_requests';
const OPEN_STATES: ProvisioningState[] = ['prepared', 'approved'];

const TRANSITIONS: Record<ProvisioningState, ProvisioningState[]> = {
  prepared: ['approved', 'withdrawn'],
  approved: ['deployed', 'withdrawn'],
  deployed: [],
  withdrawn: [],
};

export class ProvisioningStore {
  constructor(private readonly db: Knex) {}

  async list(): Promise<ProvisioningRequestRecord[]> {
    const rows = await this.db(TABLE).select('payload').orderBy('created_at', 'desc').limit(500);
    return rows.map(r => JSON.parse(r.payload));
  }

  async get(id: string): Promise<ProvisioningRequestRecord> {
    const row = await this.db(TABLE).where({ id }).first('payload');
    if (!row) throw new NotFoundError(`provisioning request ${id} not found`);
    return JSON.parse(row.payload);
  }

  async countOpen(): Promise<number> {
    const [{ n }] = await this.db(TABLE).whereIn('state', OPEN_STATES).count({ n: '*' });
    return Number(n);
  }

  async insert(
    rec: Omit<ProvisioningRequestRecord, 'id' | 'createdAt' | 'updatedAt' | 'state'>,
    currentHashes: Record<string, string>,
    lockFiles: string[] = Object.keys(rec.baseHashes),
  ): Promise<ProvisioningRequestRecord> {
    for (const [path, hash] of Object.entries(rec.baseHashes)) {
      if (currentHashes[path] !== hash) {
        throw new ConflictError(`${path} changed since the preview; preview again before preparing the change`);
      }
    }
    const files = lockFiles;
    return this.db.transaction(async trx => {
      if (files.length) {
        const open = await trx(TABLE).whereIn('state', OPEN_STATES).select('id', 'files');
        const clash = open.find(o => (JSON.parse(o.files) as string[]).some(f => files.includes(f)));
        if (clash) throw new ConflictError(`request ${clash.id} already has an open change to the same file; withdraw it, or mark it deployed once its PR is merged`);
      }
      const now = new Date().toISOString();
      const full: ProvisioningRequestRecord = { ...rec, id: randomUUID(), state: 'prepared', createdAt: now, updatedAt: now };
      await trx(TABLE).insert({
        id: full.id, state: full.state, recipe: full.input.recipe, stage: full.input.stage, files: JSON.stringify(files),
        created_by: full.createdBy, created_at: now, updated_at: now, payload: JSON.stringify(full),
      });
      return full;
    });
  }

  async transition(id: string, to: ProvisioningState, patch: Pick<ProvisioningRequestRecord, 'evidence'> = {}): Promise<ProvisioningRequestRecord> {
    const rec = await this.get(id);
    if (!TRANSITIONS[rec.state].includes(to)) throw new ConflictError(`cannot move request from ${rec.state} to ${to}`);
    const next = { ...rec, ...patch, state: to, updatedAt: new Date().toISOString() };
    const updated = await this.db(TABLE)
      .where({ id, state: rec.state })
      .update({ state: to, updated_at: next.updatedAt, payload: JSON.stringify(next) });
    if (!updated) throw new ConflictError(`request ${id} changed concurrently; reload and try again`);
    return next;
  }
}
